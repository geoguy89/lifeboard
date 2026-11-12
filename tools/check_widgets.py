# -*- coding: utf-8 -*-
"""Consistency check across the three places a widget is described.

A widget's contract lives in three files and they drift silently:

  * ``web/render/widgets/<mod>.js``  - what the widget actually READS
  * ``web/render/widgets/registry.js`` - what the admin UI OFFERS
  * ``templates/*.json``            - what the built-in boards USE

A key read by the widget but missing from the catalogue is invisible: the
option works, but nobody can ever set it. A key used by a template but absent
from the widget silently does nothing. Neither shows up as an error at
runtime, which is exactly why this runs in CI.

    python tools/check_widgets.py
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
WIDGET_DIR = ROOT / "web" / "render" / "widgets"
TEMPLATE_DIR = ROOT / "templates"

# Keys the host provides to every widget, not declared per-widget.
UNIVERSAL = {"title"}

# Read by widget code but intentionally not user-facing.
INTERNAL = {"_source_id"}

# Built from a character class rather than a  escape: an earlier version of
# this file had a literal backspace byte baked into the pattern where  was
# meant, so it silently matched nothing and every check below passed
# vacuously. A false green is worse than a noisy red.
WIDGET_CONFIG_RE = re.compile(r"(?<![A-Za-z0-9_])config\.([A-Za-z0-9_]+)")


def catalogue() -> dict[str, set[str]]:
    text = (WIDGET_DIR / "registry.js").read_text(encoding="utf-8")
    start = text.index("export const CATALOGUE")
    body = text[start:]
    out: dict[str, set[str]] = {}
    # Split on top-level "  name: {" entries.
    parts = re.split(r"^  ([A-Za-z0-9_]+): \{", body, flags=re.M)[1:]
    for name, chunk in zip(parts[0::2], parts[1::2]):
        out[name] = set(re.findall(r"\bkey: '([A-Za-z0-9_]+)'", chunk)) | UNIVERSAL
    return out


def registered_kinds() -> set[str]:
    text = (WIDGET_DIR / "registry.js").read_text(encoding="utf-8")
    block = re.search(r"export const WIDGETS = \{(.*?)\};", text, re.S)
    if not block:
        return set()
    return set(re.findall(r"[A-Za-z0-9_]+", block.group(1)))


def config_keys_read() -> dict[str, set[str]]:
    """Which config.<key> each *widget* reads.

    Scoped to the individual ``export const <name> = { ... }`` block by brace
    matching, not to the whole module. Several widgets share a file, and
    attributing per-module made every widget appear to read its neighbours'
    options - which buried the real findings in noise.
    """
    out: dict[str, set[str]] = {}
    for path in sorted(WIDGET_DIR.glob("*.js")):
        if path.name == "registry.js":
            continue
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(r"^export const ([A-Za-z0-9_]+) = \{", text, re.M):
            name = match.group(1)
            # Walk braces from the opening one to find this export's extent.
            i = text.index("{", match.start())
            depth, end = 0, len(text)
            for j in range(i, len(text)):
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                    if depth == 0:
                        end = j
                        break
            block = text[i:end]
            out[name] = set(re.findall(WIDGET_CONFIG_RE, block)) - INTERNAL
    return out


def main() -> int:
    cat = catalogue()
    kinds = registered_kinds()
    reads = config_keys_read()
    problems: list[str] = []

    # 1. Every registered widget needs a catalogue entry, and vice versa.
    for kind in sorted(kinds - set(cat)):
        problems.append(f"widget {kind!r} is registered but has no CATALOGUE entry")
    for kind in sorted(set(cat) - kinds):
        problems.append(f"CATALOGUE lists {kind!r} but it is not in WIDGETS")

    # 2. Options the widget reads that the admin UI never offers.
    for kind, offered in sorted(cat.items()):
        actually_read = reads.get(kind)
        if actually_read is None:
            continue
        unreachable = actually_read - offered - UNIVERSAL
        if unreachable:
            problems.append(
                f"{kind}: reads config {sorted(unreachable)} but the catalogue "
                f"does not expose them - nobody can set these"
            )

    # 3. Templates must only use real widgets, real keys, and stay on screen.
    for path in sorted(TEMPLATE_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for widget in data.get("widgets", []):
            kind = widget.get("kind")
            if kind not in kinds:
                problems.append(f"{path.name}: unknown widget kind {kind!r}")
                continue
            unknown = set(widget.get("config", {})) - cat.get(kind, set())
            if unknown:
                problems.append(f"{path.name}: {kind} sets unknown keys {sorted(unknown)}")
            x, y = widget.get("x", 0), widget.get("y", 0)
            w, h = widget.get("w", 0), widget.get("h", 0)
            if x + w > 100.01 or y + h > 100.01 or x < 0 or y < 0:
                problems.append(
                    f"{path.name}: {kind} falls off the screen "
                    f"(x{x}+w{w}={x + w}, y{y}+h{h}={y + h})"
                )

    for problem in problems:
        print("FAIL", problem)
    print(
        f"\n{len(kinds)} widgets, {len(list(TEMPLATE_DIR.glob('*.json')))} templates, "
        f"{len(problems)} problems"
    )
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
