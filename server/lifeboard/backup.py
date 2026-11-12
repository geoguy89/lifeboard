"""Move a whole board to another appliance.

WHY THIS EXISTS SEPARATELY FROM THE LAYOUT EXPORT
--------------------------------------------------
The layout export answers "give me this arrangement so I can put it on another
board". It deliberately strips source ids, because a source id from one
appliance points at an arbitrary row on another and a widget silently showing
the wrong calendar is worse than a blank one.

That is the right answer for sharing a design and the wrong answer for
replacing your hardware. When the Pi dies, "here is the arrangement, now
re-enter fourteen feed URLs, re-point every widget and re-authorise Google"
is not a restore. This module answers the other question: give me EVERYTHING
this board needs to come up working.

CREDENTIALS ARE THE WHOLE DESIGN PROBLEM
-----------------------------------------
The two purposes want opposite things from the same file. A bundle you send
somebody must not contain your Home Assistant token; a bundle you keep to
rebuild your own board is useless without it. So the file says which it is:

  * By default credentials are REDACTED. Sources still come across - names,
    kinds, URLs, every setting - so the board rebuilds itself completely and
    then asks you to re-enter the handful of secrets, listing exactly which.
  * `include_credentials` puts them in, decrypted, because the encryption key
    does not travel (see secrets_store: it lives in a 0600 file beside the
    database, and a key that travelled with the data would protect nothing).
    The new appliance re-encrypts under its own key on import.

A bundle carrying credentials sets `contains_credentials`, so the receiving
end and anyone opening the file can see what they are holding. That flag is
the only honest way to make a file that is sometimes shareable and sometimes
not.

REFERENCES
----------
Rows keep their original numeric ids inside the bundle, purely as labels. The
importer builds an old-id -> new-id map and rewrites every reference through
it: widget `source_id` and `source_ids`, layout `background_source_id`, screen
`active_layout_id` and the layout ids inside a screen loop. Nothing is
inserted with a forced id, so importing into a board that already has rows
never collides.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from . import db, secrets_store

log = logging.getLogger("lifeboard.backup")

BUNDLE_VERSION = 1

# Settings that describe THIS box rather than this board, and would be wrong
# on the machine restoring the bundle.
LOCAL_ONLY_SETTINGS = {
    "session_key",          # invalidating every session on restore is correct
    "admin_password_hash",  # unless credentials are included - see below
    "setup_complete",
    "display_backend",      # the new box may have different hardware
    "cec_device",
}

# How much media a bundle will carry. Photos are the one thing here that can
# be enormous, and a 3GB JSON file that the browser cannot even build is not a
# backup - it is a failed download with no error message.
MEDIA_CAP_BYTES = 256 * 1024 * 1024


# WHERE THE CREDENTIALS ACTUALLY ARE
# ----------------------------------
# The `sources.secret` column is for OAuth tokens, and on a real board it is
# usually empty - because most of what needs protecting is an ordinary setting
# that happens to be a credential. A Home Assistant long-lived token, an
# Obsidian API key and a Google "secret address in iCal format" all live in
# `config` beside the units and the item count.
#
# So redaction cannot be "does this row have a secret blob". It has to look at
# the keys.
SECRET_CONFIG_KEYS = {
    "token", "api_key", "apikey", "access_key", "secret", "client_secret",
    "client_id", "password", "refresh_token", "access_token", "app_password",
    "private_key", "webhook_url", "auth",
    # `base_url` is always an internal endpoint in this app - Home Assistant,
    # Obsidian, Immich - so it is judged as private rather than run past the
    # URL heuristic. It was the heuristic that made this necessary: one board
    # had "https://198.51.100.25:27124" (caught, an IP) beside
    # "http://homeassistant:8123" (missed, a bare name), so the same field
    # leaked from one source and not the next.
    "base_url",
    # A share link is a capability: anyone holding it can see the album. It is
    # not a credential in the sense of having a password field, and it is one
    # exactly in the sense that matters.
    "share_url", "share_urls",
}

# Keys that hold a URL, which may or may not be a secret - see _looks_private.
URLISH_CONFIG_KEYS = {
    "url", "urls", "base_url", "ics_url", "feed_url", "calendar_url", "host",
}

REDACTED = ""

# Path segments that only appear in a capability URL: Google's secret iCal
# address, an Outlook published calendar, an iCloud webcal.
_SECRET_URL_MARKERS = ("private-", "/published/", "/calendar/ical/", "webcal://")
_SECRET_QUERY_KEYS = ("key=", "token=", "auth=", "apikey=", "api_key=", "secret=")


def _looks_private(value: str) -> bool:
    """Is this URL one that should not leave the box?

    A public news feed and a private calendar address are both a `url` in a
    source config, and redacting both would make a shareable bundle useless
    while redacting neither publishes somebody's calendar. So the URL itself
    has to be judged.

    Three things make one private: it points somewhere only this network can
    reach (in which case it is no use elsewhere anyway), it carries a
    credential in its query string, or its path contains a long opaque segment
    - which is what every "secret address" scheme in this space looks like.
    """
    text = str(value or "").strip()
    if not text:
        return False
    low = text.lower()

    if any(marker in low for marker in _SECRET_URL_MARKERS):
        return True
    if any(key in low for key in _SECRET_QUERY_KEYS):
        return True

    # A LAN address: private on its own terms, and meaningless on another
    # network even when it is not.
    host = low.split("://", 1)[-1].split("/", 1)[0].split("@")[-1].split(":")[0]
    # A single-label host - "homeassistant", "tower", "nas" - is a LAN name.
    # Anything reachable from outside has a dot in it.
    if host and "." not in host and not host.isdigit():
        return True
    if (host in ("localhost", "127.0.0.1")
            or host.endswith((".local", ".lan", ".home", ".internal"))
            or host.startswith(("192.168.", "10.", "172.16.", "172.17.",
                                "172.18.", "172.19.", "172.2", "172.30.",
                                "172.31."))):
        return True

    # An opaque RUN inside the path is the shape of every capability URL: a
    # hash, a base64 blob, a GUID. The run is measured WITHOUT stripping
    # hyphens, because that is what separates a token from a slug -
    # "podcast-episode-2024-05-12" is words and dates with separators between
    # them, "9f2c4a17b8e35d60" is sixteen characters of nothing. Requiring
    # both letters and digits keeps a plain date-stamped path out of it.
    for run in re.findall(r"[a-z0-9]{16,}", low.split("?")[0]):
        if sum(c.isdigit() for c in run) >= 3 and sum(c.isalpha() for c in run) >= 3:
            return True
    return False


def redact_config(config: dict) -> tuple[dict, list[str]]:
    """A copy of `config` safe to hand to somebody else, and what was removed.

    Values are blanked rather than dropped, so the shape of the config is
    intact and the admin shows an empty field to fill in rather than a setting
    that has silently vanished.
    """
    out: dict = {}
    removed: list[str] = []
    for key, value in (config or {}).items():
        low = key.lower()
        secret = low in SECRET_CONFIG_KEYS
        if not secret and low in URLISH_CONFIG_KEYS:
            if isinstance(value, list):
                secret = any(_looks_private(v) for v in value)
            else:
                secret = _looks_private(value)
        if secret and value not in (None, "", [], {}):
            out[key] = [] if isinstance(value, list) else REDACTED
            removed.append(key)
        else:
            out[key] = value
    return out, removed


def _json(value, fallback):
    try:
        out = json.loads(value or "")
    except (TypeError, ValueError):
        return fallback
    return out if isinstance(out, type(fallback)) else fallback


# --------------------------------------------------------------------------
#  Export
# --------------------------------------------------------------------------

def build(*, layout_ids: list[int] | None = None,
          screen_ids: list[int] | None = None,
          include_sources: bool = True,
          include_credentials: bool = False,
          include_todo: bool = True,
          include_settings: bool = True,
          include_media: bool = False,
          media_dir: Path | None = None) -> dict:
    """A bundle describing the board.

    With no `layout_ids` or `screen_ids` this is the whole appliance. Given
    either, it narrows to those - and to the sources those layouts actually
    reference, so exporting one screen does not hand over the credentials for
    a different screen's feeds.
    """
    layouts = _layouts(layout_ids, screen_ids)
    wanted_layout_ids = {row["id"] for row in layouts}

    bundle: dict = {
        "lifeboard_bundle": BUNDLE_VERSION,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "contains_credentials": False,
        "layouts": [],
        "screens": [],
        "sources": [],
        "notes": [],
    }

    used_sources: set[int] = set()
    for layout in layouts:
        widgets = []
        for row in db.query(
            "SELECT * FROM widgets WHERE layout_id = ? ORDER BY z, id",
            (layout["id"],),
        ):
            config = _json(row["config"], {})
            if config.get("source_id"):
                used_sources.add(int(config["source_id"]))
            for sid in config.get("source_ids") or []:
                try:
                    used_sources.add(int(sid))
                except (TypeError, ValueError):
                    pass
            # Hydrated through the same path the API uses, then stripped of
            # the ids that mean nothing on another appliance. Listing the
            # columns by hand here is how a restore quietly loses whichever
            # one was added last.
            widget = db.hydrate_widget(row)
            for drop in ("id", "layout_id", "created_at"):
                widget.pop(drop, None)
            widget["config"] = config
            widgets.append(widget)
        if layout["background_source_id"]:
            used_sources.add(int(layout["background_source_id"]))
        bundle["layouts"].append({
            "ref": layout["id"],
            "name": layout["name"],
            "background": layout["background"],
            "background_image": layout["background_image"],
            "background_kind": layout["background_kind"],
            "background_source_id": layout["background_source_id"],
            "background_dim": layout["background_dim"],
            "background_blur": layout["background_blur"],
            "widgets": widgets,
        })

    for screen in db.query("SELECT * FROM screens ORDER BY id"):
        if screen_ids and screen["id"] not in screen_ids:
            continue
        loop = [
            item for item in _json(screen["loop_items"], [])
            if isinstance(item, dict) and item.get("layout_id") in wanted_layout_ids
        ]
        bundle["screens"].append({
            "ref": screen["id"],
            "name": screen["name"],
            "orientation": screen["orientation"],
            "width": screen["width"], "height": screen["height"],
            "output": screen["output"],
            "active_layout_id": (screen["active_layout_id"]
                                 if screen["active_layout_id"] in wanted_layout_ids
                                 else None),
            "loop_enabled": screen["loop_enabled"],
            "loop_items": loop,
            "power_rules": [
                {"days": r["days"], "on_time": r["on_time"],
                 "off_time": r["off_time"], "enabled": r["enabled"],
                 # 'off_at' boards power the Pi FROM the display, so losing
                 # the mode turns a board that shuts itself down into one that
                 # never comes back on.
                 "mode": r["mode"] if "mode" in r else "window"}
                for r in db.query(
                    "SELECT * FROM power_rules WHERE screen_id = ?", (screen["id"],))
            ],
        })

    if include_sources:
        redacted: list[str] = []
        for row in db.query("SELECT * FROM sources ORDER BY id"):
            # Narrowing to one screen means narrowing the credentials too.
            if (layout_ids or screen_ids) and row["id"] not in used_sources:
                continue
            config = _json(row["config"], {})
            entry = {
                "ref": row["id"],
                "kind": row["kind"],
                "name": row["name"],
                "colour": row["colour"],
                "enabled": row["enabled"],
                "refresh_seconds": row["refresh_seconds"],
            }
            has_secret = bool(row["secret"])
            if include_credentials:
                entry["config"] = config
                if has_secret:
                    # Decrypted on purpose: the key stays on the old box, so a
                    # sealed blob would arrive as unreadable bytes.
                    entry["secret"] = secrets_store.open_(row["secret"])
                if has_secret or redact_config(config)[1]:
                    bundle["contains_credentials"] = True
            else:
                safe, removed = redact_config(config)
                entry["config"] = safe
                if removed:
                    # Named individually so the admin can say "re-enter the
                    # token for Home Assistant" rather than "something is
                    # missing somewhere".
                    entry["redacted_keys"] = removed
                if removed or has_secret:
                    entry["secret_redacted"] = True
                    redacted.append(row["name"])
            bundle["sources"].append(entry)
        if redacted:
            bundle["notes"].append(
                "These sources need their credentials re-entered after import: "
                + ", ".join(sorted(set(redacted))))

    if include_todo:
        bundle["todo_lists"] = [
            {
                "ref": lst["id"], "name": lst["name"], "colour": lst["colour"],
                "items": [
                    {"text": i["text"], "done": i["done"], "due": i["due"],
                     "priority": i["priority"], "assignee": i["assignee"],
                     "position": i["position"]}
                    for i in db.query(
                        "SELECT * FROM todo_items WHERE list_id = ? ORDER BY position",
                        (lst["id"],))
                ],
            }
            for lst in db.query("SELECT * FROM todo_lists ORDER BY id")
        ]

    if include_settings:
        skip = set(LOCAL_ONLY_SETTINGS)
        if include_credentials:
            # A bundle that already carries Google tokens is not made more
            # dangerous by carrying the board's own password hash, and
            # restoring straight into a working login is the point.
            skip.discard("admin_password_hash")
        bundle["settings"] = {
            row["key"]: row["value"]
            for row in db.query("SELECT key, value FROM settings")
            if row["key"] not in skip
        }

    if include_media:
        bundle["media"], note = _media(media_dir, bundle)
        if note:
            bundle["notes"].append(note)

    return bundle


def _layouts(layout_ids, screen_ids) -> list[dict]:
    if layout_ids:
        marks = ",".join("?" * len(layout_ids))
        return db.query(f"SELECT * FROM layouts WHERE id IN ({marks}) ORDER BY id",
                        tuple(layout_ids))
    if screen_ids:
        # Everything the screen can show, not only what it is showing now: a
        # screen on a loop of four layouts is not restored by one of them.
        wanted: set[int] = set()
        marks = ",".join("?" * len(screen_ids))
        for screen in db.query(
            f"SELECT * FROM screens WHERE id IN ({marks})", tuple(screen_ids)
        ):
            if screen["active_layout_id"]:
                wanted.add(int(screen["active_layout_id"]))
            for item in _json(screen["loop_items"], []):
                if isinstance(item, dict) and item.get("layout_id"):
                    wanted.add(int(item["layout_id"]))
        if not wanted:
            return []
        marks = ",".join("?" * len(wanted))
        return db.query(f"SELECT * FROM layouts WHERE id IN ({marks}) ORDER BY id",
                        tuple(sorted(wanted)))
    return db.query("SELECT * FROM layouts ORDER BY id")


def _media(media_dir: Path | None, bundle: dict) -> tuple[list[dict], str]:
    """Uploaded images and video, inline, capped.

    Only what the bundle actually refers to. A board that has accumulated two
    years of photos should not turn a one-screen export into a gigabyte, and
    the files nobody placed are the ones least worth carrying.
    """
    media_dir = media_dir or Path(
        os.environ.get("LIFEBOARD_MEDIA", "/var/lib/lifeboard/media"))
    blob = json.dumps(bundle)

    out: list[dict] = []
    total = 0
    skipped: list[str] = []
    for row in db.query("SELECT * FROM media ORDER BY id"):
        # Referenced by id or by filename somewhere in the layouts.
        if (f'"{row["filename"]}"' not in blob
                and f'/api/media/{row["id"]}' not in blob
                and f'"{row["id"]}"' not in blob):
            continue
        path = media_dir / row["filename"]
        if not path.is_file():
            skipped.append(row["original"])
            continue
        size = path.stat().st_size
        if total + size > MEDIA_CAP_BYTES:
            skipped.append(row["original"])
            continue
        total += size
        out.append({
            "filename": row["filename"], "original": row["original"],
            "folder": row["folder"], "mime": row["mime"],
            "width": row["width"], "height": row["height"],
            "data": base64.b64encode(path.read_bytes()).decode("ascii"),
        })

    note = ""
    if skipped:
        note = ("These files were too large for the bundle or are missing on "
                "disk, and will need re-uploading: " + ", ".join(sorted(set(skipped))))
    return out, note


# --------------------------------------------------------------------------
#  Import
# --------------------------------------------------------------------------

def _merge_config(conn, source_id: int, incoming: dict) -> dict:
    """The bundle's settings over the ones already here, minus the blanks.

    A redacted bundle carries `token: ""`. Writing that straight over a board
    that already has a working token would turn "import my layout" into
    "disconnect Home Assistant", which is the sort of surprise that makes
    people stop using a restore button.
    """
    row = conn.execute("SELECT config FROM sources WHERE id = ?",
                       (source_id,)).fetchone()
    current = _json(row["config"] if row else "", {})
    blanked = set(incoming.get("redacted_keys") or [])
    merged = dict(current)
    for key, value in (incoming.get("config") or {}).items():
        if key in blanked and not value:
            continue
        merged[key] = value
    return merged



def contents(bundle: dict) -> dict:
    """What is inside a bundle, addressably, so a person can choose from it.

    The importer has always been all-or-nothing, which is the right default and
    the wrong only option: "that one block, from the backup, onto this other
    layout" is a normal thing to want and used to mean restoring the lot and
    deleting the rest.

    Every block gets an address - its layout's ref and its position in that
    layout - because a bundle has no widget ids worth trusting (they were
    stripped on the way out, deliberately, since an id from another appliance
    means nothing here). The pair is stable for a given file, which is all the
    picker needs.
    """
    if not isinstance(bundle, dict) or "lifeboard_bundle" not in bundle:
        raise ValueError("that file is not a LifeBoard bundle")

    by_ref = {}
    for src in bundle.get("sources") or []:
        try:
            by_ref[int(src.get("ref", 0))] = src
        except (TypeError, ValueError):
            continue

    def sources_of(config: dict, column_source_id) -> list[int]:
        out = []
        for value in (config.get("source_id"), column_source_id):
            if value not in (None, ""):
                try:
                    out.append(int(value))
                except (TypeError, ValueError):
                    pass
        for value in config.get("source_ids") or []:
            try:
                out.append(int(value))
            except (TypeError, ValueError):
                pass
        return sorted(set(out))

    layouts = []
    for layout in bundle.get("layouts") or []:
        blocks = []
        for index, widget in enumerate(layout.get("widgets") or []):
            config = widget.get("config") or {}
            refs = sources_of(config, widget.get("source_id"))
            blocks.append({
                "index": index,
                "kind": widget.get("kind", "?"),
                # The name the user gave it, falling back to its title and then
                # to its kind - the same order the layers list uses, so a block
                # is called the same thing here as it is in the editor.
                "name": (widget.get("name") or config.get("title")
                         or widget.get("kind", "block")),
                "sources": [
                    {"ref": r,
                     "name": (by_ref.get(r) or {}).get("name", f"source {r}"),
                     "kind": (by_ref.get(r) or {}).get("kind", "?"),
                     "needs_credentials": bool(
                         (by_ref.get(r) or {}).get("secret_redacted"))}
                    for r in refs
                ],
            })
        layouts.append({
            "ref": layout.get("ref"),
            "name": layout.get("name") or "Imported layout",
            "blocks": blocks,
        })

    return {
        "version": bundle.get("lifeboard_bundle"),
        "created": bundle.get("created", ""),
        "contains_credentials": bool(bundle.get("contains_credentials")),
        "layouts": layouts,
        "sources": [
            {"ref": r, "name": v.get("name", "?"), "kind": v.get("kind", "?"),
             "needs_credentials": bool(v.get("secret_redacted"))}
            for r, v in sorted(by_ref.items())
        ],
        "screens": [
            {"name": sc.get("name", "?"), "ref": sc.get("ref")}
            for sc in bundle.get("screens") or []
        ],
    }


def _selected(bundle: dict, select: dict | None) -> tuple[dict, int | None]:
    """Narrow a bundle to the chosen parts, as a bundle in its own right.

    Rewriting the bundle rather than threading conditions through the importer
    keeps one insertion path. The alternative - `if selected` at every step -
    is how the full restore and the partial restore drift apart until one of
    them quietly stops mapping source ids.

    Returns the narrowed bundle and, when individual blocks were picked, the id
    of the layout on THIS board they should land on.
    """
    if not select:
        return bundle, None

    narrowed = dict(bundle)
    into = select.get("into_layout_id")
    blocks = select.get("blocks") or []
    layout_refs = select.get("layouts")

    if blocks:
        if not into:
            raise ValueError(
                "choosing individual blocks needs a layout to put them on")
        wanted: dict[int, list[int]] = {}
        for item in blocks:
            try:
                wanted.setdefault(int(item["layout"]), []).append(int(item["index"]))
            except (KeyError, TypeError, ValueError):
                raise ValueError("a chosen block is missing its layout or index")

        picked = []
        for layout in bundle.get("layouts") or []:
            ref = int(layout.get("ref", 0))
            if ref not in wanted:
                continue
            widgets = layout.get("widgets") or []
            chosen = []
            for index in sorted(set(wanted[ref])):
                if index < 0 or index >= len(widgets):
                    raise ValueError(
                        f"the bundle's layout {ref} has no block {index}")
                chosen.append(widgets[index])
            picked.append(dict(layout, widgets=chosen))
        narrowed["layouts"] = picked
        # Blocks land on an existing layout, so nothing else comes with them.
        narrowed["screens"] = []
        narrowed["todo_lists"] = []
        narrowed["settings"] = {}
    elif layout_refs is not None:
        keep = {int(r) for r in layout_refs}
        narrowed["layouts"] = [
            l for l in (bundle.get("layouts") or [])
            if int(l.get("ref", 0)) in keep
        ]
        if not select.get("screens", True):
            narrowed["screens"] = []

    # SOURCES FOLLOW THE THINGS THAT USE THEM.
    #
    # Importing every source in the file alongside one chosen block would put
    # fourteen feeds on the board to satisfy a clock. Only what the selection
    # actually references comes across - plus anything explicitly ticked.
    used: set[int] = set()
    for layout in narrowed.get("layouts") or []:
        if layout.get("background_source_id"):
            try:
                used.add(int(layout["background_source_id"]))
            except (TypeError, ValueError):
                pass
        for widget in layout.get("widgets") or []:
            config = widget.get("config") or {}
            for value in (config.get("source_id"), widget.get("source_id")):
                if value not in (None, ""):
                    try:
                        used.add(int(value))
                    except (TypeError, ValueError):
                        pass
            for value in config.get("source_ids") or []:
                try:
                    used.add(int(value))
                except (TypeError, ValueError):
                    pass
    for extra in select.get("sources") or []:
        try:
            used.add(int(extra))
        except (TypeError, ValueError):
            pass

    narrowed["sources"] = [
        src for src in (bundle.get("sources") or [])
        if int(src.get("ref", -1)) in used
    ]
    return narrowed, (int(into) if blocks else None)


def restore(bundle: dict, *, replace: bool = False,
            media_dir: Path | None = None,
            select: dict | None = None) -> dict:
    """Insert a bundle into this appliance.

    `replace` wipes the board's own screens, layouts and sources first, which
    is what you want on fresh hardware and emphatically not what you want when
    pulling one screen onto a working board. It defaults off.

    Sources are matched to existing ones BY NAME AND KIND before being
    created, so importing the same bundle twice does not leave two of every
    feed - and so a bundle exported without credentials lands on top of
    sources that already have them rather than blanking them.
    """
    if not isinstance(bundle, dict) or "lifeboard_bundle" not in bundle:
        raise ValueError("that file is not a LifeBoard bundle")
    version = bundle.get("lifeboard_bundle")
    if not isinstance(version, int) or version > BUNDLE_VERSION:
        raise ValueError(
            f"that bundle was written by a newer LifeBoard (format {version}); "
            f"this one understands up to {BUNDLE_VERSION}")

    bundle, into_layout_id = _selected(bundle, select)
    if into_layout_id is not None and replace:
        # Wiping the board to put one block on it is not a thing anybody means.
        raise ValueError(
            "cannot replace the whole board while importing individual blocks")

    media_dir = media_dir or Path(
        os.environ.get("LIFEBOARD_MEDIA", "/var/lib/lifeboard/media"))

    report = {"screens": 0, "layouts": 0, "widgets": 0, "sources": 0,
              "sources_reused": 0, "todo_lists": 0, "media": 0,
              "needs_credentials": [], "notes": list(bundle.get("notes") or [])}

    source_map: dict[int, int] = {}
    layout_map: dict[int, int] = {}

    with db.tx() as conn:
        if replace:
            # Order matters: widgets and power rules cascade, but screens hold
            # a reference to layouts that must go first.
            conn.execute("UPDATE screens SET active_layout_id = NULL")
            for table in ("widgets", "layouts", "power_rules", "screens",
                          "sources", "todo_items", "todo_lists"):
                conn.execute(f"DELETE FROM {table}")

        # --- sources ------------------------------------------------------
        existing = {
            (row["name"].strip().lower(), row["kind"]): row["id"]
            for row in conn.execute("SELECT id, name, kind FROM sources").fetchall()
        }
        for src in bundle.get("sources") or []:
            key = (str(src.get("name", "")).strip().lower(), src.get("kind"))
            secret = src.get("secret")
            if key in existing:
                found = existing[key]
                source_map[int(src.get("ref", 0))] = found
                report["sources_reused"] += 1
                # A bundle carrying a credential is newer than whatever is
                # here; one that redacted its credentials must not wipe the
                # working credential it is landing on. Same rule for both
                # places a credential can live.
                if secret is not None:
                    conn.execute("UPDATE sources SET secret = ? WHERE id = ?",
                                 (secrets_store.seal(secret), found))
                merged = _merge_config(conn, found, src)
                conn.execute("UPDATE sources SET config = ? WHERE id = ?",
                             (json.dumps(merged), found))
                if src.get("redacted_keys"):
                    still_blank = [k for k in src["redacted_keys"] if not merged.get(k)]
                    if still_blank:
                        report["needs_credentials"].append(src.get("name", "?"))
                continue
            cur = conn.execute(
                "INSERT INTO sources (kind, name, colour, enabled, config, "
                "refresh_seconds, secret) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    src.get("kind", "ical"),
                    src.get("name", "Untitled"),
                    src.get("colour", "#5b9dd9"),
                    int(src.get("enabled", 1)),
                    json.dumps(src.get("config") or {}),
                    int(src.get("refresh_seconds", 900)),
                    secrets_store.seal(secret) if secret is not None else None,
                ),
            )
            source_map[int(src.get("ref", 0))] = cur.lastrowid
            report["sources"] += 1
            if src.get("secret_redacted"):
                report["needs_credentials"].append(src.get("name", "?"))
                report["redacted"] = report.get("redacted", {})
                report["redacted"][src.get("name", "?")] = src.get("redacted_keys") or []

        # --- layouts and widgets -----------------------------------------
        for layout in bundle.get("layouts") or []:
            if into_layout_id is not None:
                # Chosen blocks join a layout that already exists rather than
                # arriving inside a copy of the layout they came from.
                row = conn.execute("SELECT id FROM layouts WHERE id = ?",
                                   (into_layout_id,)).fetchone()
                if not row:
                    raise ValueError(f"no layout {into_layout_id} on this board")
                layout_id = into_layout_id
                # Append: the incoming blocks go after whatever is there, so
                # nothing already on the layout is displaced or overwritten.
                start = conn.execute(
                    "SELECT COUNT(*) FROM widgets WHERE layout_id = ?",
                    (layout_id,)).fetchone()[0]
                for offset, widget in enumerate(layout.get("widgets") or []):
                    config = dict(widget.get("config") or {})
                    if config.get("source_id"):
                        config["source_id"] = source_map.get(int(config["source_id"]))
                    if config.get("source_ids"):
                        mapped = [source_map.get(int(i))
                                  for i in config["source_ids"] if str(i).isdigit()]
                        config["source_ids"] = [i for i in mapped if i]
                    widget = dict(widget)
                    widget["config"] = config
                    if widget.get("source_id"):
                        widget["source_id"] = source_map.get(int(widget["source_id"]))
                    db.insert_widget(conn, layout_id, widget, start + offset)
                    report["widgets"] += 1
                continue

            cur = conn.execute(
                "INSERT INTO layouts (name, background, background_image, "
                "background_kind, background_source_id, background_dim, "
                "background_blur) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    layout.get("name") or "Imported layout",
                    layout.get("background") or "#101014",
                    layout.get("background_image") or "",
                    layout.get("background_kind") or "none",
                    source_map.get(int(layout.get("background_source_id") or 0)),
                    int(layout.get("background_dim", 35)),
                    int(layout.get("background_blur", 0)),
                ),
            )
            layout_id = cur.lastrowid
            layout_map[int(layout.get("ref", 0))] = layout_id
            report["layouts"] += 1

            for index, widget in enumerate(layout.get("widgets") or []):
                config = dict(widget.get("config") or {})
                if config.get("source_id"):
                    config["source_id"] = source_map.get(int(config["source_id"]))
                if config.get("source_ids"):
                    mapped = [source_map.get(int(i)) for i in config["source_ids"]
                              if str(i).isdigit()]
                    config["source_ids"] = [i for i in mapped if i]
                widget = dict(widget)
                widget["config"] = config
                # `widgets.source_id` is a column as well as a config key, and
                # it points at a source id too.
                if widget.get("source_id"):
                    widget["source_id"] = source_map.get(int(widget["source_id"]))
                db.insert_widget(conn, layout_id, widget, index)
                report["widgets"] += 1

        # --- screens ------------------------------------------------------
        for screen in bundle.get("screens") or []:
            loop = []
            for item in screen.get("loop_items") or []:
                mapped = layout_map.get(int(item.get("layout_id") or 0))
                if mapped:
                    loop.append({"layout_id": mapped,
                                 "seconds": int(item.get("seconds", 30))})
            active = layout_map.get(int(screen.get("active_layout_id") or 0))
            # Restoring onto hardware that already has a screen row should
            # configure THAT screen rather than inventing a second one nothing
            # drives.
            row = conn.execute(
                "SELECT id FROM screens WHERE name = ? LIMIT 1",
                (screen.get("name", ""),)).fetchone()
            if row is None:
                row = conn.execute("SELECT id FROM screens ORDER BY id LIMIT 1").fetchone()
            if row is not None and not replace:
                screen_id = row["id"]
                conn.execute(
                    "UPDATE screens SET orientation = ?, width = ?, height = ?, "
                    "active_layout_id = COALESCE(?, active_layout_id), "
                    "loop_enabled = ?, loop_items = ? WHERE id = ?",
                    (screen.get("orientation", "normal"),
                     int(screen.get("width", 1920)), int(screen.get("height", 1080)),
                     active, int(screen.get("loop_enabled", 0)),
                     json.dumps(loop), screen_id),
                )
            else:
                cur = conn.execute(
                    "INSERT INTO screens (name, orientation, width, height, output, "
                    "active_layout_id, loop_enabled, loop_items) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (screen.get("name", "Screen"), screen.get("orientation", "normal"),
                     int(screen.get("width", 1920)), int(screen.get("height", 1080)),
                     screen.get("output"), active,
                     int(screen.get("loop_enabled", 0)), json.dumps(loop)),
                )
                screen_id = cur.lastrowid
            report["screens"] += 1

            conn.execute("DELETE FROM power_rules WHERE screen_id = ?", (screen_id,))
            for rule in screen.get("power_rules") or []:
                conn.execute(
                    "INSERT INTO power_rules (screen_id, days, on_time, off_time, "
                    "enabled, mode) VALUES (?, ?, ?, ?, ?, ?)",
                    (screen_id, rule.get("days", "0,1,2,3,4,5,6"),
                     rule.get("on_time", "07:00"), rule.get("off_time", "23:00"),
                     int(rule.get("enabled", 1)), rule.get("mode", "window")),
                )

        # --- to-do lists --------------------------------------------------
        for lst in bundle.get("todo_lists") or []:
            row = conn.execute("SELECT id FROM todo_lists WHERE name = ?",
                               (lst.get("name", ""),)).fetchone()
            if row:
                continue  # a list that is already here keeps its own items
            cur = conn.execute(
                "INSERT INTO todo_lists (name, colour) VALUES (?, ?)",
                (lst.get("name", "List"), lst.get("colour", "#5b9dd9")))
            list_id = cur.lastrowid
            report["todo_lists"] += 1
            for item in lst.get("items") or []:
                conn.execute(
                    "INSERT INTO todo_items (list_id, text, done, due, priority, "
                    "assignee, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (list_id, item.get("text", ""), int(item.get("done", 0)),
                     item.get("due", ""), int(item.get("priority", 0)),
                     item.get("assignee", ""), int(item.get("position", 0))),
                )

        # --- settings -----------------------------------------------------
        for key, value in (bundle.get("settings") or {}).items():
            if key in LOCAL_ONLY_SETTINGS and key != "admin_password_hash":
                continue
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, str(value)))

    # --- media, outside the transaction: files are not transactional and a
    # --- rollback would leave them behind anyway.
    for item in bundle.get("media") or []:
        try:
            media_dir.mkdir(parents=True, exist_ok=True)
            path = media_dir / item["filename"]
            if not path.exists():
                path.write_bytes(base64.b64decode(item["data"]))
            if not db.one("SELECT id FROM media WHERE filename = ?", (item["filename"],)):
                db.execute(
                    "INSERT INTO media (filename, original, folder, mime, bytes, "
                    "width, height) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (item["filename"], item.get("original", item["filename"]),
                     item.get("folder", ""), item.get("mime", ""),
                     path.stat().st_size, item.get("width"), item.get("height")))
            report["media"] += 1
        except Exception:  # noqa: BLE001 - one bad file must not fail the restore
            log.exception("could not restore media %s", item.get("filename"))
            report["notes"].append(
                f"Could not restore the file {item.get('original', '?')}")

    report["needs_credentials"] = sorted(set(report["needs_credentials"]))
    return report
