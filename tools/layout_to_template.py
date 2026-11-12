# -*- coding: utf-8 -*-
"""Turn an exported layout into a shippable template.

    python tools/layout_to_template.py exported.json templates/name.json \
        --name "Hearth" --description "..." --orientation left

Templates ship in the repo AND inside every flashed image, so a template made
from somebody's real board is a way to publish their private details to
everyone who ever flashes it. That already happened once: regenerating a
template from a live board carried its guest Wi-Fi SSID and PASSWORD into a
committed file.

So the conversion SCRUBS rather than copies. The rule is deny-by-default: any
config key that is known to carry a value personal to one board is replaced
with a placeholder, and the placeholder is written to be obviously a
placeholder rather than a plausible-looking fake.

Layout is the point of a template; content is not.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import OrderedDict
from pathlib import Path

# Keys replaced with a placeholder, and what to put there. A template is a
# LAYOUT: none of these carry any of its meaning.
SCRUB = {
    "ssid": "Your Wi-Fi name",
    "password": "your-wifi-password",
    "api_key": "",
    "access_key": "",
    "token": "",
    "base_url": "",
    "share_url": "",
    "share_urls": "",
    "url": "",
    "urls": "",
    "path": "",
    "folder": "",
    "entity": "",
    "entities": "",
    "list_id": None,
    "station": "",
    "codes": "",
    "latitude": None,
    "longitude": None,
    "html": "",
}

# Free text that names a household rather than describing a widget. Replaced
# with something generic so the template reads as an example.
TEXT_HINTS = {
    "text": "Your text here",
    "label": "",
    "title": None,          # a title like "Tides" IS the layout; keep it
    "caption": "",
    "idle_text": None,
    "clear_text": "",
    "empty_text": None,
    "source_label": "",
}


def scrub_config(kind: str, config: dict) -> dict:
    out = {}
    for key, value in (config or {}).items():
        if key in ("source_id", "source_ids", "_source_id"):
            continue                      # ids mean nothing on another board
        if key in SCRUB:
            replacement = SCRUB[key]
            if replacement is None or replacement == "":
                continue                  # drop it entirely
            out[key] = replacement
            continue
        if key in TEXT_HINTS:
            replacement = TEXT_HINTS[key]
            if replacement is None:
                out[key] = value          # keep: it labels the widget
            elif replacement == "":
                continue
            else:
                out[key] = replacement
            continue
        out[key] = value
    return out


def convert(export: dict, *, name: str, description: str,
            orientation: str, category: str = "official") -> OrderedDict:
    tpl: OrderedDict = OrderedDict()
    tpl["name"] = name
    tpl["description"] = description
    tpl["aspect"] = export.get("aspect", "portrait")
    tpl["orientation"] = orientation
    tpl["category"] = category
    tpl["background"] = export.get("background", "#101014")
    tpl["background_kind"] = export.get("background_kind", "none")
    for key in ("background_image", "background_dim", "background_blur"):
        value = export.get(key)
        if value not in (None, "", 0):
            tpl[key] = value

    widgets = []
    for w in export.get("widgets", []):
        w = {k: v for k, v in w.items()
             if k not in ("id", "layout_id", "created_at", "source_id")}
        w["config"] = scrub_config(w.get("kind", ""), w.get("config") or {})
        widgets.append(w)
    tpl["widgets"] = widgets
    return tpl


def audit(tpl: dict) -> list[str]:
    """Anything that still looks personal. Run on the RESULT, so the check is
    of what will actually ship rather than of what the scrubber intended."""
    problems = []
    blob = json.dumps(tpl).lower()
    for needle in ("http://", "https://", "@", "bearer ", "sk-", "eyj"):
        if needle in blob:
            # A URL might be a legitimate example, so this is a warning that
            # needs a human to look, not an automatic failure.
            problems.append(f"contains {needle!r} - check it is not personal")
    for w in tpl.get("widgets", []):
        for key in w.get("config", {}):
            if key in SCRUB and key not in ("ssid", "password"):
                problems.append(f"{w['kind']}.{key} survived the scrub")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source"); ap.add_argument("dest")
    ap.add_argument("--name", required=True)
    ap.add_argument("--description", default="")
    ap.add_argument("--orientation", default="left")
    ap.add_argument("--category", default="official")
    args = ap.parse_args()

    export = json.loads(Path(args.source).read_text(encoding="utf8"))
    tpl = convert(export, name=args.name, description=args.description,
                  orientation=args.orientation, category=args.category)

    problems = audit(tpl)
    Path(args.dest).write_text(json.dumps(tpl, indent=2) + "\n", encoding="utf8")

    print(f"{args.dest}: {len(tpl['widgets'])} widgets")
    for p in problems:
        print(f"  CHECK: {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
