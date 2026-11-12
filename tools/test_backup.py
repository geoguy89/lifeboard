# -*- coding: utf-8 -*-
"""Export a board, wipe it, import it back, and check it is the same board.

    python tools/test_backup.py

The point of a bundle is the day the hardware dies, which is the worst
possible day to discover that the restore drops the screen orientation, or
re-points a widget at the wrong calendar, or doubles every source because it
was imported twice. So this does the whole cycle against real SQLite rather
than asserting on the shape of a dict.

The reference rewriting is the part with teeth. Ids inside a bundle are just
labels; on the way back in every one of them has to be translated - widget
`source_id` and `source_ids`, the layout's background album, the screen's
active layout and the layouts inside its loop. A test that only checks counts
would pass while every widget pointed at the wrong feed.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

TMP = Path(tempfile.mkdtemp(prefix="lifeboard-backup-"))
os.environ["LIFEBOARD_DB"] = str(TMP / "test.db")
os.environ["LIFEBOARD_KEY"] = str(TMP / "secret.key")
os.environ["LIFEBOARD_MEDIA"] = str(TMP / "media")

from lifeboard import backup, db  # noqa: E402

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        return
    failures.append(f"{name}{f' - {detail}' if detail else ''}")


def reset() -> None:
    """An empty board, as a fresh appliance would be."""
    with db.tx() as conn:
        for table in ("widgets", "layouts", "power_rules", "sources",
                      "todo_items", "todo_lists", "media"):
            conn.execute(f"DELETE FROM {table}")
        conn.execute("UPDATE screens SET active_layout_id = NULL, loop_items = '[]'")


def build_board() -> dict:
    """A board with every kind of cross-reference a restore has to survive.

    Its rows are given deliberately HIGH ids, and that is load-bearing.
    SQLite without AUTOINCREMENT hands out max(id)+1, so a table emptied by
    DELETE starts again at 1 - and a restore into it would land on exactly the
    ids the bundle came from. Every reference check below would then pass
    whether the importer rewrote the ids or ignored them entirely, which is
    the one thing they exist to tell apart. Starting at 500 means the restored
    ids cannot possibly coincide.
    """
    reset()
    with db.tx() as conn:
        google = conn.execute(
            "INSERT INTO sources (id, kind, name, config, secret) VALUES (?, ?, ?, ?, ?)",
            (501, "google", "Family Calendar",
             json.dumps({"calendar_id": "primary"}), None)).lastrowid
        feed = conn.execute(
            "INSERT INTO sources (id, kind, name, config) VALUES (?, ?, ?, ?)",
            (502, "rss", "Headlines",
             json.dumps({"urls": ["https://example.invalid/feed"]}))).lastrowid
        album = conn.execute(
            "INSERT INTO sources (id, kind, name, config) VALUES (?, ?, ?, ?)",
            (503, "google_photos", "Holiday",
             json.dumps({"share_urls": ["https://photos.app.goo.gl/aB3xQ9"]}))).lastrowid
        # The ones that matter for redaction. On a real board the `secret`
        # column is empty and every credential is an ordinary config value
        # sitting beside the units and the item count - which is exactly how
        # a "safe to share" bundle ends up carrying a Home Assistant token.
        conn.execute(
            "INSERT INTO sources (id, kind, name, config) VALUES (?, ?, ?, ?)",
            (504, "homeassistant", "Home Assistant", json.dumps({
                "base_url": "http://192.168.1.40:8123",
                "token": "eyJhbGciOiJIUzI1NiJ9.SUPER-SECRET-HA-TOKEN",
            })))
        conn.execute(
            "INSERT INTO sources (id, kind, name, config) VALUES (?, ?, ?, ?)",
            (505, "obsidian", "Sunday Sermons", json.dumps({
                "base_url": "https://172.16.0.25:27124",
                "api_key": "abcdef0123456789abcdef0123456789",
                "folder": "Areas/Faith/Sermons",
            })))
        # A private calendar address is a credential wearing a URL: anyone
        # holding it can read the calendar.
        conn.execute(
            "INSERT INTO sources (id, kind, name, config) VALUES (?, ?, ?, ?)",
            (506, "ical", "Secret Calendar", json.dumps({
                "url": "https://calendar.google.com/calendar/ical/"
                       "private-9f2c4a17b8e35d60f1a2/basic.ics",
            })))
        # And a plainly public one, which must survive: redacting every URL
        # would make a shareable bundle useless.
        conn.execute(
            "INSERT INTO sources (id, kind, name, config) VALUES (?, ?, ?, ?)",
            (507, "rss", "Public News", json.dumps({
                "url": "https://feeds.example.com/news/rss.xml", "limit": 8,
            })))

        main = conn.execute(
            "INSERT INTO layouts (id, name, background, background_kind, "
            "background_source_id, background_dim) VALUES (?, ?, ?, ?, ?, ?)",
            (601, "Kitchen", "#101014", "source", album, 40)).lastrowid
        second = conn.execute(
            "INSERT INTO layouts (id, name) VALUES (?, ?)", (602, "Overnight")).lastrowid

        db.insert_widget(conn, main, {
            "kind": "calendar", "x": 2, "y": 2, "w": 40, "h": 60,
            "config": {"source_id": google, "style": "agenda",
                       "scroll_mode": "continuous"},
            "name": "Family", "locked": True,
        }, 0)
        db.insert_widget(conn, main, {
            "kind": "rss", "x": 44, "y": 2, "w": 50, "h": 60,
            "config": {"source_ids": [feed, google], "max_items": 6},
            "style": {"colour": "#ffcc00"}, "visible": False,
        }, 1)
        db.insert_widget(conn, second, {
            "kind": "clock", "x": 10, "y": 10, "w": 80, "h": 30, "config": {},
        }, 0)

        screen = conn.execute("SELECT id FROM screens ORDER BY id LIMIT 1").fetchone()["id"]
        conn.execute(
            "UPDATE screens SET name = ?, orientation = ?, width = ?, height = ?, "
            "active_layout_id = ?, loop_enabled = 1, loop_items = ? WHERE id = ?",
            ("Wall", "right", 1080, 1920, main,
             json.dumps([{"layout_id": main, "seconds": 45},
                         {"layout_id": second, "seconds": 15}]), screen))
        conn.execute(
            "INSERT INTO power_rules (screen_id, days, on_time, off_time, mode) "
            "VALUES (?, ?, ?, ?, ?)", (screen, "0,1,2,3,4", "06:30", "22:45", "off_at"))

        lst = conn.execute("INSERT INTO todo_lists (name) VALUES (?)",
                           ("Grocery List",)).lastrowid
        conn.execute("INSERT INTO todo_items (list_id, text, position) VALUES (?, ?, ?)",
                     (lst, "Milk", 0))

    # A credential, sealed the way the sources API seals one.
    from lifeboard import secrets_store
    db.execute("UPDATE sources SET secret = ? WHERE id = ?",
               (secrets_store.seal({"refresh_token": "tok-abc-123"}), google))
    return {"google": google, "feed": feed, "album": album,
            "main": main, "second": second}


def widget_by_kind(kind: str) -> dict:
    row = db.one("SELECT * FROM widgets WHERE kind = ? ORDER BY id LIMIT 1", (kind,))
    return db.hydrate_widget(row) if row else {}


# ---------------------------------------------------------------------------
#  1. A full round trip onto empty hardware
# ---------------------------------------------------------------------------
ids = build_board()
bundle = backup.build(include_credentials=True)

check("the bundle admits it carries credentials", bundle["contains_credentials"])
check("every layout is in the bundle", len(bundle["layouts"]) == 2,
      str(len(bundle["layouts"])))
check("every source is in the bundle", len(bundle["sources"]) == 7,
      str(len(bundle["sources"])))
check("the to-do list came too", len(bundle.get("todo_lists") or []) == 1)

reset()
check("the board really is empty first", not db.query("SELECT id FROM widgets"))

report = backup.restore(bundle)

check("both layouts restored", report["layouts"] == 2, str(report["layouts"]))
check("every widget restored", report["widgets"] == 3, str(report["widgets"]))
check("every source restored", report["sources"] == 7, str(report["sources"]))

cal = widget_by_kind("calendar")
new_google = db.one("SELECT id FROM sources WHERE name = 'Family Calendar'")["id"]
new_feed = db.one("SELECT id FROM sources WHERE name = 'Headlines'")["id"]
new_album = db.one("SELECT id FROM sources WHERE name = 'Holiday'")["id"]

# The ids are new. What matters is that they point at the same THINGS.
check("the restore really did land on different ids",
      new_google != ids["google"], f'{new_google} == {ids["google"]}')
check("a widget's source was re-pointed, not copied",
      cal["config"]["source_id"] == new_google,
      f'{cal["config"].get("source_id")} vs {new_google}')
check("the widget's own settings survived",
      cal["config"].get("scroll_mode") == "continuous")
check("a locked widget is still locked", cal["locked"] is True)

rss = widget_by_kind("rss")
check("a multi-source widget re-points every one of them",
      rss["config"]["source_ids"] == [new_feed, new_google],
      str(rss["config"].get("source_ids")))
check("a hidden widget is still hidden", rss["visible"] is False)
check("per-widget styling survived", rss["style"].get("colour") == "#ffcc00")

layout = db.one("SELECT * FROM layouts WHERE name = 'Kitchen'")
check("the background album was re-pointed",
      layout["background_source_id"] == new_album,
      f'{layout["background_source_id"]} vs {new_album}')
check("background settings survived", layout["background_dim"] == 40)

screen = db.one("SELECT * FROM screens ORDER BY id LIMIT 1")
check("the screen kept its orientation", screen["orientation"] == "right",
      screen["orientation"])
check("the screen kept its resolution",
      (screen["width"], screen["height"]) == (1080, 1920))
check("the screen points at the restored layout",
      screen["active_layout_id"] == layout["id"])
loop = json.loads(screen["loop_items"])
check("the screen loop was re-pointed", len(loop) == 2 and loop[0]["seconds"] == 45,
      str(loop))
check("every layout in the loop exists",
      all(db.one("SELECT id FROM layouts WHERE id = ?", (i["layout_id"],)) for i in loop))

rule = db.one("SELECT * FROM power_rules LIMIT 1")
check("the power schedule came back", rule and rule["on_time"] == "06:30")
check("the power rule kept its mode", rule and rule["mode"] == "off_at",
      rule["mode"] if rule else "missing")

from lifeboard import secrets_store  # noqa: E402
sealed = db.one("SELECT secret FROM sources WHERE id = ?", (new_google,))["secret"]
check("the credential came across and is readable",
      secrets_store.open_(sealed) == {"refresh_token": "tok-abc-123"},
      repr(secrets_store.open_(sealed)))
check("and it was re-encrypted, not stored bare",
      b"tok-abc-123" not in bytes(sealed or b""))

items = db.query("SELECT text FROM todo_items")
check("to-do items came back", [i["text"] for i in items] == ["Milk"], str(items))

# ---------------------------------------------------------------------------
#  2. Importing the same bundle twice must not duplicate anything
# ---------------------------------------------------------------------------
before = len(db.query("SELECT id FROM sources"))
again = backup.restore(bundle)
after = len(db.query("SELECT id FROM sources"))
check("a second import reuses the sources it already made", after == before,
      f"{before} -> {after}")
check("and says so", again["sources_reused"] == 7, str(again["sources_reused"]))
check("a to-do list that is already here is left alone",
      len(db.query("SELECT id FROM todo_lists")) == 1)

# ---------------------------------------------------------------------------
#  3. Without credentials: everything else still lands, and it says what is
#     missing rather than leaving the user to find out from a broken widget
# ---------------------------------------------------------------------------
build_board()
plain = backup.build(include_credentials=False)
blob = json.dumps(plain)

check("a plain bundle does not claim to carry credentials",
      plain["contains_credentials"] is False)

# The four things that must not be in a file you could send somebody.
for leak, what in (
    ("SUPER-SECRET-HA-TOKEN", "a Home Assistant token"),
    ("abcdef0123456789abcdef0123456789", "an Obsidian API key"),
    ("private-9f2c4a17b8e35d60f1a2", "a secret calendar address"),
    ("photos.app.goo.gl/aB3xQ9", "a private album link"),
    ("tok-abc-123", "an OAuth refresh token"),
):
    check(f"{what} is not in a redacted bundle", leak not in blob)

by_name = {s_["name"]: s_ for s_ in plain["sources"]}

# Blanked, not dropped: the admin should show an empty field to fill in
# rather than a setting that has silently vanished.
check("the token key is still there, empty",
      by_name["Home Assistant"]["config"].get("token") == "",
      repr(by_name["Home Assistant"]["config"]))
# base_url goes too: a 192.168 address is no use on another network, and it
# describes the sender's network to whoever opens the file.
check("the LAN address is blanked as well",
      by_name["Home Assistant"]["config"].get("base_url") == "")
check("and both are named as needing re-entry",
      by_name["Home Assistant"].get("redacted_keys") == ["base_url", "token"],
      str(by_name["Home Assistant"].get("redacted_keys")))
check("non-secret settings beside it survive",
      by_name["Obsidian" if "Obsidian" in by_name else "Sunday Sermons"]
      ["config"].get("folder") == "Areas/Faith/Sermons")

# A public feed URL is not a credential and must come through, or a shareable
# bundle is not worth sharing.
check("a public feed URL survives",
      by_name["Public News"]["config"].get("url")
      == "https://feeds.example.com/news/rss.xml",
      str(by_name["Public News"]["config"]))
check("and its other settings too", by_name["Public News"]["config"].get("limit") == 8)
check("a public feed is not flagged as needing anything",
      not by_name["Public News"].get("secret_redacted"))

check("but the source itself is still described",
      any(s_["name"] == "Family Calendar" for s_ in plain["sources"]))
check("its non-secret config survived",
      any(s_["config"].get("calendar_id") == "primary" for s_ in plain["sources"]))
check("and it is flagged as needing re-authorising",
      any(s_.get("secret_redacted") for s_ in plain["sources"]))
check("with a human-readable note",
      any("Family Calendar" in n for n in plain["notes"]), str(plain["notes"]))

reset()
report = backup.restore(plain)
check("the restore names everything that has to be re-entered",
      report["needs_credentials"] == ["Family Calendar", "Holiday",
                                      "Home Assistant", "Secret Calendar",
                                      "Sunday Sermons"],
      str(report["needs_credentials"]))
check("and does not name the source that needs nothing",
      "Public News" not in report["needs_credentials"])
check("everything else came back anyway", report["widgets"] == 3)

# A redacted bundle landing on a board that ALREADY has the credential must
# not wipe it. This is the "re-import my layout" case, and blanking a working
# Google connection to import a layout would be a genuinely bad surprise.
build_board()
plain = backup.build(include_credentials=False)
report = backup.restore(plain)
kept = db.one("SELECT secret FROM sources WHERE name = 'Family Calendar'")["secret"]
check("a redacted bundle does not blank a sealed credential already here",
      secrets_store.open_(kept) == {"refresh_token": "tok-abc-123"})

# The same rule for the ones that live in config, which is nearly all of them.
ha = json.loads(db.one("SELECT config FROM sources WHERE name = 'Home Assistant'")["config"])
check("nor a config credential already here",
      ha.get("token") == "eyJhbGciOiJIUzI1NiJ9.SUPER-SECRET-HA-TOKEN",
      repr(ha.get("token")))
check("and keeps the address it blanked, rather than emptying the field",
      ha.get("base_url") == "http://192.168.1.40:8123")
check("and it does not ask for what it did not have to blank",
      "Public News" not in report["needs_credentials"])

# ---------------------------------------------------------------------------
#  4. Narrowing to one screen narrows the credentials too
# ---------------------------------------------------------------------------
ids = build_board()
screen_id = db.one("SELECT id FROM screens ORDER BY id LIMIT 1")["id"]
one_screen = backup.build(screen_ids=[screen_id], include_credentials=True)
check("a screen export brings every layout the screen can show",
      len(one_screen["layouts"]) == 2, str(len(one_screen["layouts"])))

# Now a source that nothing on that screen uses.
db.execute("INSERT INTO sources (kind, name, config) VALUES (?, ?, ?)",
           ("ha", "Home Assistant Extra", json.dumps({"base_url": "http://ha.invalid"})))
db.execute("UPDATE sources SET secret = ? WHERE name = 'Home Assistant Extra'",
           (secrets_store.seal({"token": "ha-secret-xyz"}),))
narrow = backup.build(screen_ids=[screen_id], include_credentials=True)
check("an unused source is not dragged in",
      not any(s_["name"] == "Home Assistant Extra" for s_ in narrow["sources"]),
      str([s_["name"] for s_ in narrow["sources"]]))
check("nor is its token", "ha-secret-xyz" not in json.dumps(narrow))
check("a whole-board bundle does include it",
      any(s_["name"] == "Home Assistant Extra"
          for s_ in backup.build(include_credentials=True)["sources"]))

# ---------------------------------------------------------------------------
#  5. Bad input is refused with something a person can act on
# ---------------------------------------------------------------------------
for bad, why in (({}, "an empty object"),
                 ({"widgets": []}, "a plain layout export"),
                 ({"lifeboard_bundle": 99}, "a bundle from the future")):
    try:
        backup.restore(bad)
        check(f"{why} is refused", False)
    except ValueError as exc:
        check(f"{why} is refused with a readable reason", len(str(exc)) > 20, str(exc))

# ---------------------------------------------------------------------------
#  6. replace=True is for fresh hardware and really does clear the board
# ---------------------------------------------------------------------------
build_board()
full = backup.build(include_credentials=True)
db.execute("INSERT INTO layouts (name) VALUES (?)", ("Something else",))
report = backup.restore(full, replace=True)
check("replace wipes what was here",
      not db.one("SELECT id FROM layouts WHERE name = 'Something else'"))
check("and leaves exactly the bundle's layouts",
      len(db.query("SELECT id FROM layouts")) == 2,
      str(len(db.query("SELECT id FROM layouts"))))
check("with one screen, not two",
      len(db.query("SELECT id FROM screens")) == 1,
      str(len(db.query("SELECT id FROM screens"))))

# ---------------------------------------------------------------------------
#  7. Telling a capability URL from a public one
#
#  This is the judgement call in the whole module. Redact every URL and a
#  shareable bundle loses the feeds that made it worth sharing; redact none
#  and it publishes somebody's calendar. So the table is explicit, and both
#  columns matter equally.
# ---------------------------------------------------------------------------
from lifeboard.backup import _looks_private  # noqa: E402

URLS = [
    # Private: a capability - holding the link is the whole authorisation.
    ("https://calendar.google.com/calendar/ical/me%40gmail.com/private-3f9a1c/basic.ics", True),
    ("https://outlook.office365.com/owa/calendar/9f2c4a17b8e35d60/reachcalendar.ics", True),
    ("https://p12-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEyMzQ1Ng", True),
    ("https://api.weather.example/v1?key=abc123def456", True),
    # Private: a LAN address, which is also simply no use anywhere else.
    ("http://172.16.0.90:8123", True),
    ("http://homeassistant.local:8123", True),
    # A bare single-label host is a LAN name too, and it was the gap that
    # let one board leak its Home Assistant hostname while blanking another.
    ("http://homeassistant:8123", True),
    ("http://tower:8096", True),
    ("http://127.0.0.1:8080", True),
    # Public: must survive, or the bundle is not worth sharing.
    ("https://www.ncm.org/feed/", False),
    ("https://feeds.example.com/news/rss.xml", False),
    ("https://www.reddit.com/r/homeassistant/.rss", False),
    # The two that make a naive length rule wrong: a slug with dates in it,
    # and a date-stamped path. Both are long and both are public.
    ("https://example.com/blog/podcast-episode-2024-05-12/rss", False),
    ("https://example.com/api/v1/20240515123456/feed", False),
    ("https://anchor.fm/s/1a2b3c4d/podcast/rss", False),
]
for url, private in URLS:
    check(f"{'private' if private else 'public'}: {url[:52]}",
          _looks_private(url) is private)

print(f"bundle round trip checked against {os.environ['LIFEBOARD_DB']}")
if failures:
    print()
    for f in failures:
        print(f"  FAIL  {f}")
    print(f"\n{len(failures)} problem(s)")
    sys.exit(1)
print("backup: a board exports, restores, and comes back pointing at the same things")
