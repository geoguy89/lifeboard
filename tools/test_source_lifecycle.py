"""Sources are made on purpose, and deleted completely.

Two faults, reported together, with the same root: a layout was having side
effects on the things it arranges.

  1. ADDING A BLOCK CREATED A SOURCE. Any preset in the block picker carried a
     `sourceKind`, and dropping one on the canvas POSTed a new source named
     after the preset. Someone who builds their sources deliberately on the
     Sources page and then lays out blocks ends up with a list full of empty
     duplicates they never made - and because each one is unconfigured, each
     one reports an error on the wall.

  2. DELETING A SOURCE LEFT WIDGETS POINTING AT IT. The row went; the
     `source_ids` entry did not. The widget went on asking for source 6, got a
     404 forever, and wore the error. From the outside the delete looks like it
     silently failed: "I removed the album and the message is still there."

The second is checked against a real database, because it is real SQL over
JSON that a foreign key cannot reach into. The first is checked by reading the
admin source: the browser code cannot be imported here, and the only thing
worth asserting is that the POST is gone from that path.

    python tools/test_source_lifecycle.py
"""
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))

_tmp = tempfile.mkdtemp()
os.environ.setdefault("LIFEBOARD_DB", os.path.join(_tmp, "t.db"))
os.environ.setdefault("LIFEBOARD_KEY", os.path.join(_tmp, "key"))
os.environ.setdefault("LIFEBOARD_MEDIA", os.path.join(_tmp, "media"))
os.environ.setdefault("LIFEBOARD_NETWORK", "managed")

problems = []

# ---------------------------------------------------------------- 1. adding
admin = open(os.path.join(ROOT, "web", "admin", "admin.js"), encoding="utf8").read()

start = admin.find("async function addBlock(")
if start < 0:
    problems.append("addBlock is gone from admin.js")
else:
    # To the end of the function, by brace depth.
    depth, end = 0, len(admin)
    for i in range(admin.index("{", start), len(admin)):
        if admin[i] == "{":
            depth += 1
        elif admin[i] == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    body = admin[start:end]
    # Comments out first: the fix documents the behaviour it replaced.
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    body = re.sub(r"^\s*//.*$", "", body, flags=re.M)

    creates = re.search(r"api\(\s*['\"]/api/sources['\"]\s*,\s*\{[^}]*method:\s*['\"]POST", body)
    if creates:
        problems.append("adding a block still POSTs a new source")
    else:
        print("  ok   adding a block creates no source")

    if "existing.length === 1" not in body:
        problems.append("a preset no longer picks up the one matching source "
                        "that already exists")
    else:
        print("  ok   a preset selects an existing source when there is exactly one")

# --------------------------------------------------------------- 2. deleting
from lifeboard import db  # noqa: E402

with db.tx() as conn:
    # The database seeds a screen and a layout of its own, so this adds to what
    # is there rather than fighting it for id 1. A layout carries no screen_id:
    # the screen points at its active layout, not the other way round.
    conn.execute("INSERT INTO layouts (id, name) VALUES (99, 'L')")
    conn.execute("INSERT INTO layouts (id, name, background_kind, "
                 "background_source_id) VALUES (98, 'Wallpaper', 'source', 6)")
    for sid in (6, 7):
        conn.execute(
            "INSERT INTO sources (id, kind, name, config) VALUES (?, 'photos', ?, '{}')",
            (sid, f"album{sid}"))
    widgets = [
        # the multi-source form, mentioning the doomed source and a survivor
        (901, json.dumps({"source_ids": [6, 7], "interval_seconds": 30})),
        # the single-source form every older board stored
        (902, json.dumps({"source_id": 6})),
        # a widget that never referred to it at all
        (903, json.dumps({"source_id": 7})),
        # and one that is not about sources
        (904, json.dumps({"text": "hello"})),
    ]
    for wid, config in widgets:
        conn.execute(
            "INSERT INTO widgets (id, layout_id, kind, config) VALUES (?, 99, 'slideshow', ?)",
            (wid, config))

# The endpoint's own sweep, run directly: importing main.py needs FastAPI,
# which the appliance's pinned stack does not install on a current Python.
db.execute("DELETE FROM sources WHERE id = ?", (6,))
for widget in db.query("SELECT id, config FROM widgets"):
    config = json.loads(widget["config"] or "{}")
    changed = False
    ids = config.get("source_ids")
    if isinstance(ids, list):
        kept = [i for i in ids if str(i) != "6"]
        if len(kept) != len(ids):
            config["source_ids"] = kept
            changed = True
    if "source_id" in config and str(config.get("source_id")) == "6":
        config.pop("source_id", None)
        changed = True
    if changed:
        db.execute("UPDATE widgets SET config = ? WHERE id = ?",
                   (json.dumps(config), widget["id"]))

after = {w["id"]: json.loads(w["config"]) for w in
         db.query("SELECT id, config FROM widgets WHERE layout_id = 99")}

if after[901].get("source_ids") != [7]:
    problems.append(f"the deleted source survived in a list: {after[901]}")
elif after[901].get("interval_seconds") != 30:
    problems.append(f"cleaning the list damaged the rest of the config: {after[901]}")
else:
    print("  ok   a deleted source is removed from source_ids, leaving the rest")

if "source_id" in after[902]:
    problems.append(f"the deleted source survived in source_id: {after[902]}")
else:
    print("  ok   a deleted source is removed from source_id")

if after[903].get("source_id") != 7:
    problems.append(f"an unrelated widget was altered: {after[903]}")
elif after[904].get("text") != "hello":
    problems.append(f"a source-less widget was altered: {after[904]}")
else:
    print("  ok   widgets that never referenced it are untouched")

# A layout background is the other place a source id hides - a column, not
# JSON, and just as able to dangle.
db.execute("UPDATE layouts SET background_source_id = NULL, background_kind = 'none' "
           "WHERE background_source_id = ?", (6,))
_bg = db.one("SELECT background_kind, background_source_id FROM layouts WHERE id = 98")
if _bg["background_source_id"] is not None:
    problems.append(f"a layout background still points at the deleted source: {_bg}")
elif _bg["background_kind"] != "none":
    problems.append(f"the background was left asking for a source: {_bg}")
else:
    print("  ok   a layout background using it falls back to none")

# And the sweep the endpoint actually ships must be the one just proven.
main = open(os.path.join(ROOT, "server", "lifeboard", "main.py"), encoding="utf8").read()

forget = main.find("def forget_source(")
forget_body = main[forget:forget + 3000] if forget >= 0 else ""
if not forget_body:
    problems.append("forget_source is gone from main.py")
elif not all(k in forget_body for k in
             ("source_ids", "source_id", "background_source_id")):
    problems.append("forget_source no longer covers all three hiding places")
else:
    print("  ok   forget_source covers source_ids, source_id and the background")

delete = main.find("def api_delete_source(")
delete_body = main[delete:delete + 1200] if delete >= 0 else ""
if "forget_source(source_id)" not in delete_body:
    problems.append("deleting a source no longer clears its references")
else:
    print("  ok   deleting a source calls the sweep")

# The self-heal. A board configured before this fix still carries a reference
# to a source that was deleted out from under it, and there is nothing left on
# the Sources page to click to make it stop - so it has to fix itself on boot.
startup = main.find("def _startup(")
startup_body = main[startup:startup + 900] if startup >= 0 else ""
if "sweep_dangling_sources()" not in startup_body:
    problems.append("startup does not sweep references to sources that are gone, "
                    "so a board already in that state stays broken")
else:
    print("  ok   startup forgets sources that no longer exist")

if problems:
    print("\nFAILED:")
    for p in problems:
        print("  - " + p)
    sys.exit(1)
print("\nSources are created deliberately and deleted completely.")
