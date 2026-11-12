"""Restore part of a bundle, and carry a board's own details through a full one.

Two requirements, reported together:

  1. "If I back up EVERYTHING it should capture person.sam_smith so our
     presence chips carry over on restores to a new board - and it should pull
     the Home Assistant connection too."

     Widget config already travels whole, and `include_credentials` already
     brings the connection. This pins both, because both are the kind of thing
     that quietly stops working when redaction rules change - and the redaction
     rules HAVE changed several times.

  2. "I would like to import SPECIFIC items - restore just a single block/source
     combo to a different layout."

     That is new. The selection is applied by rewriting the bundle before the
     importer sees it, so a partial import and a full one go down exactly the
     same insertion path.

    python tools/test_selective_import.py
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

_tmp = tempfile.mkdtemp()
os.environ["LIFEBOARD_DB"] = os.path.join(_tmp, "t.db")
os.environ["LIFEBOARD_KEY"] = os.path.join(_tmp, "key")
os.environ["LIFEBOARD_MEDIA"] = os.path.join(_tmp, "media")
os.environ.setdefault("LIFEBOARD_NETWORK", "managed")

from lifeboard import backup, db, secrets_store  # noqa: E402

problems = []

# ---------------------------------------------------------------- a board --
with db.tx() as conn:
    conn.execute(
        "INSERT INTO sources (id, kind, name, colour, enabled, config, "
        "refresh_seconds, secret) VALUES (?,?,?,?,?,?,?,?)",
        (50, "homeassistant", "Home Assistant", "#5b9dd9", 1,
         json.dumps({"base_url": "http://homeassistant.local:8123"}), 60,
         secrets_store.seal({"token": "a-real-long-lived-token"})))
    conn.execute(
        "INSERT INTO sources (id, kind, name, colour, enabled, config, "
        "refresh_seconds, secret) VALUES (?,?,?,?,?,?,?,?)",
        (51, "rss", "News", "#7fb069", 1,
         json.dumps({"urls": "https://example.com/feed"}), 900, None))

    conn.execute("INSERT INTO layouts (id, name) VALUES (60, 'Kitchen')")
    conn.execute("INSERT INTO layouts (id, name) VALUES (61, 'Hallway')")

    # The presence chips: the thing that has to survive a restore.
    conn.execute(
        "INSERT INTO widgets (id, layout_id, kind, config, name) VALUES (?,?,?,?,?)",
        (70, 60, "tracker",
         json.dumps({"source_id": 50, "entity_ids": ["person.a_household_name"],
                     "layout": "chips"}),
         "Presence"))
    conn.execute(
        "INSERT INTO widgets (id, layout_id, kind, config, name) VALUES (?,?,?,?,?)",
        (71, 60, "feed", json.dumps({"source_id": 51}), "Headlines"))
    conn.execute(
        "INSERT INTO widgets (id, layout_id, kind, config, name) VALUES (?,?,?,?,?)",
        (72, 61, "clock", json.dumps({"hour12": True}), "Clock"))

# ------------------------------------- 1. a full backup carries everything --
bundle = backup.build(include_credentials=True)

tracker = None
for layout in bundle["layouts"]:
    for widget in layout["widgets"]:
        if widget.get("kind") == "tracker":
            tracker = widget
if tracker is None:
    problems.append("the tracker block did not make it into the bundle at all")
elif tracker["config"].get("entity_ids") != ["person.a_household_name"]:
    problems.append(f"the presence entities were lost: {tracker['config']}")
else:
    print("  ok   presence entity ids travel in a full backup")

ha = [s for s in bundle["sources"] if s["kind"] == "homeassistant"]
if not ha:
    problems.append("the Home Assistant source is missing from the bundle")
elif not ha[0].get("secret"):
    problems.append("the Home Assistant token was not included despite "
                    "include_credentials")
elif ha[0]["secret"].get("token") != "a-real-long-lived-token":
    problems.append(f"the token came out wrong: {ha[0]['secret']}")
elif ha[0]["config"].get("base_url") != "http://homeassistant.local:8123":
    problems.append(f"the connection URL was redacted anyway: {ha[0]['config']}")
else:
    print("  ok   the Home Assistant connection and its token travel too")

if not bundle.get("contains_credentials"):
    problems.append("a bundle carrying a token does not say that it does")
else:
    print("  ok   the bundle declares that it holds credentials")

# ...and the redacted form still must not.
plain = backup.build(include_credentials=False)
ha_plain = [s for s in plain["sources"] if s["kind"] == "homeassistant"][0]
if ha_plain.get("secret"):
    problems.append("a bundle exported WITHOUT credentials still carries the token")
elif ha_plain["config"].get("base_url"):
    problems.append("the connection URL leaks from a redacted bundle")
else:
    print("  ok   a shareable bundle still holds neither the token nor the URL")

# --------------------------------------------- 2. what is inside a bundle --
listing = backup.contents(bundle)
kitchen = [l for l in listing["layouts"] if l["name"] == "Kitchen"]
if not kitchen:
    problems.append("contents() does not list the Kitchen layout")
elif len(kitchen[0]["blocks"]) != 2:
    problems.append(f"Kitchen lists {len(kitchen[0]['blocks'])} blocks, expected 2")
elif not any(b["name"] == "Presence" for b in kitchen[0]["blocks"]):
    problems.append("the blocks are not named, so a picker cannot show them")
else:
    named = [b for b in kitchen[0]["blocks"] if b["name"] == "Presence"][0]
    if not named["sources"] or named["sources"][0]["kind"] != "homeassistant":
        problems.append(f"the block does not name the source it needs: {named}")
    else:
        print("  ok   a bundle can be listed: layouts, blocks, and each "
              "block's sources")

# ------------------------------- 3. one block, onto a layout that exists --
kitchen_ref = kitchen[0]["ref"]
presence_index = [b["index"] for b in kitchen[0]["blocks"] if b["name"] == "Presence"][0]

# A fresh board with one layout of its own.
os.environ["LIFEBOARD_DB"] = os.path.join(_tmp, "target.db")
import importlib  # noqa: E402
importlib.reload(db)

with db.tx() as conn:
    conn.execute("INSERT INTO layouts (id, name) VALUES (90, 'Somewhere else')")
    conn.execute(
        "INSERT INTO widgets (id, layout_id, kind, config, name) VALUES (?,?,?,?,?)",
        (95, 90, "clock", json.dumps({}), "Existing clock"))

report = backup.restore(bundle, select={
    "blocks": [{"layout": kitchen_ref, "index": presence_index}],
    "into_layout_id": 90,
})

# Not "how many layouts are there" - a fresh database seeds one of its own,
# and counting it made this fail for a reason that had nothing to do with the
# import. The question is whether the BUNDLE'S layouts were created.
names = {row["name"] for row in db.query("SELECT name FROM layouts")}
strays = names & {"Kitchen", "Hallway"}
if strays:
    problems.append(f"importing one block created layouts from the bundle: {strays}")
else:
    print("  ok   importing a block creates no layout of its own")

widgets = db.query("SELECT kind, config, name FROM widgets WHERE layout_id = 90 ORDER BY id")
if len(widgets) != 2:
    problems.append(f"layout 90 has {len(widgets)} blocks, expected the "
                    "existing one plus the imported one")
elif widgets[0]["name"] != "Existing clock":
    problems.append("the block that was already there was displaced")
elif widgets[1]["kind"] != "tracker":
    problems.append(f"the imported block is a {widgets[1]['kind']}")
else:
    config = json.loads(widgets[1]["config"])
    if config.get("entity_ids") != ["person.a_household_name"]:
        problems.append(f"the imported block lost its entities: {config}")
    else:
        print("  ok   the chosen block lands beside what was already there, "
              "entities intact")

sources = db.query("SELECT kind, name FROM sources")
kinds = sorted(s["kind"] for s in sources)
if "homeassistant" not in kinds:
    problems.append("the block's Home Assistant source did not come with it")
elif "rss" in kinds:
    problems.append("an unrelated source was dragged along with the block")
else:
    print("  ok   only the source that block needed came with it")

row = db.one("SELECT config, secret FROM sources WHERE kind = 'homeassistant'")
config = json.loads(row["config"])
opened = secrets_store.open_(row["secret"]) or {}
if config.get("base_url") != "http://homeassistant.local:8123":
    problems.append(f"the imported connection lost its URL: {config}")
elif opened.get("token") != "a-real-long-lived-token":
    problems.append("the imported connection lost its token")
else:
    print("  ok   the connection arrives complete, so the chips work at once")

widget_config = json.loads(widgets[1]["config"])
if widget_config.get("source_id") != row and widget_config.get("source_id") not in (
        s["id"] for s in db.query("SELECT id FROM sources")):
    problems.append(f"the block points at a source that does not exist: "
                    f"{widget_config.get('source_id')}")
else:
    print("  ok   the block points at the source as it landed here, not as it "
          "was numbered there")

# ------------------------------------------------------- 4. the guardrails --
try:
    backup.restore(bundle, select={"blocks": [{"layout": kitchen_ref, "index": 0}]})
    problems.append("choosing blocks with no destination layout was allowed")
except ValueError:
    print("  ok   choosing blocks without saying where is refused")

try:
    backup.restore(bundle, replace=True, select={
        "blocks": [{"layout": kitchen_ref, "index": 0}], "into_layout_id": 90})
    problems.append("wiping the whole board to import one block was allowed")
except ValueError:
    print("  ok   'replace everything' cannot be combined with picking blocks")

try:
    backup.restore(bundle, select={
        "blocks": [{"layout": kitchen_ref, "index": 99}], "into_layout_id": 90})
    problems.append("a block index that does not exist was accepted")
except ValueError:
    print("  ok   a block that is not in the bundle is refused by name")

if problems:
    print("\nFAILED:")
    for p in problems:
        print("  - " + p)
    sys.exit(1)
print("\nA whole board restores whole, and one block restores alone.")
