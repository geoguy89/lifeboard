# -*- coding: utf-8 -*-
"""Sending a task to the board from a phone, a shortcut, or a script.

    python tools/test_inbox.py

This is an unauthenticated write, so it gets the same scrutiny as the task
gate. The token in the URL is the entire authorisation, and the whole design
rests on that token being able to do exactly one thing: add a task to one
named list. It must not read the board, reach another list, or turn into a
variable webhook.

The other half is tolerance. The things that send a task - an iOS Shortcut, a
Home Assistant automation, an n8n flow forwarding an email subject, a curl
one-liner - all send a different shape, and none of them should have to care.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

TMP = Path(tempfile.mkdtemp(prefix="lifeboard-inbox-"))
os.environ["LIFEBOARD_DB"] = str(TMP / "test.db")
os.environ["LIFEBOARD_KEY"] = str(TMP / "secret.key")

from lifeboard import db, devices  # noqa: E402

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        return
    failures.append(f"{name}{f' - {detail}' if detail else ''}")


# ---------------------------------------------------------------------------
#  Migrating a board that predates task inboxes
#
#  ensure_schema uses CREATE TABLE IF NOT EXISTS, which does nothing to a table
#  that already exists. Without an explicit ALTER, a board that has been
#  running since before this feature would fail on every webhook read - the
#  column is in the schema text and not in the database.
# ---------------------------------------------------------------------------
db.connect().execute("""
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
  variable TEXT NOT NULL, last_used TEXT, hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')))
""")
devices.ensure_schema()
cols = {r["name"] for r in db.connect().execute("PRAGMA table_info(webhooks)")}
check("an old webhooks table gains the new columns",
      {"kind", "target"} <= cols, str(sorted(cols)))

devices.ensure_schema()   # again: migrating twice must not throw
check("migrating is safe to repeat", True)

inbox_list = db.execute("INSERT INTO todo_lists (name) VALUES (?)", ("Inbox",))
other_list = db.execute("INSERT INTO todo_lists (name) VALUES (?)", ("Private",))
db.execute("INSERT INTO todo_items (list_id, text, position) VALUES (?, ?, 0)",
           (other_list, "Do not touch"))

hook = devices.create_webhook("Kitchen", "", kind="task", target=inbox_list)
token = hook["token"]

check("a task link offers a page for phones", hook.get("add_url", "").startswith("/add/"))
check("and an endpoint for scripts", hook.get("url", "").startswith("/api/hook/"))
check("the token is long enough not to be guessed", len(token) >= 30, token)

# ---------------------------------------------------------------------------
#  It takes whatever a sender happens to send
# ---------------------------------------------------------------------------
SHAPES = [
    ("Milk", "Milk", "plain text, the curl case"),
    ({"text": "Book the dentist"}, "Book the dentist", "the phone page"),
    ({"title": "Pay the water bill"}, "Pay the water bill", "a shortcut"),
    ({"value": "Change the filter"}, "Change the filter", "a webhook-shaped sender"),
    ({"subject": "Fwd: renew the insurance"}, "Fwd: renew the insurance",
     "an email subject via n8n"),
    ({"message": "Collect the parcel"}, "Collect the parcel", "a chat bot"),
    (["First", "Second"], "First", "a list - take the first"),
]
for payload, expected, why in SHAPES:
    result = devices.receive(token, payload)
    check(f"accepts {why}", result.get("text") == expected,
          f"{payload!r} -> {result}")

# Addressing words are not part of the task.
for payload, expected in [
    ("Add milk", "milk"), ("add Milk", "Milk"), ("todo call mum", "call mum"),
    ("Remind me to book the car in", "book the car in"),
    ("task Hoover the stairs", "Hoover the stairs"),
]:
    result = devices.receive(token, payload)
    check(f"{payload!r} becomes {expected!r}", result.get("text") == expected,
          str(result))

# Whitespace and newlines collapse: a forwarded email body arrives as a wall of
# them and a task with a line break in it breaks the row layout on the wall.
result = devices.receive(token, {"text": "  Line one\n\n   line two  \t "})
check("newlines and runs of spaces collapse",
      result.get("text") == "Line one line two", str(result))

# Nothing usable is refused rather than creating a blank row nobody can see.
for empty in ("", "   ", {"nothing": "here"}, {}, None, {"text": ""}, []):
    result = devices.receive(token, empty)
    check(f"{empty!r} adds nothing", "error" in result, str(result))

# Absurdly long input is truncated, not rejected - somebody pasting an email
# body should get the first sentence on the board, not an error.
result = devices.receive(token, "x" * 5000)
check("a huge payload is truncated rather than refused",
      result.get("text") and len(result["text"]) <= 300, str(result)[:80])

# ---------------------------------------------------------------------------
#  The token reaches exactly one list, and nothing else
# ---------------------------------------------------------------------------
rows = db.query("SELECT text FROM todo_items WHERE list_id = ?", (other_list,))
check("the other list is untouched",
      [r["text"] for r in rows] == ["Do not touch"], str(rows))

check("everything landed in the list the token names",
      all(r["list_id"] == inbox_list
          for r in db.query("SELECT list_id FROM todo_items WHERE text != 'Do not touch'")))

# Newest first: on a wall, the thing somebody just sent is the thing they are
# standing there waiting to see appear.
devices.receive(token, "The newest thing")
top = db.one("SELECT text FROM todo_items WHERE list_id = ? ORDER BY position LIMIT 1",
             (inbox_list,))
# Defensively: a broken inbox leaves this empty, and a test that CRASHES
# instead of failing hides which check went wrong behind a traceback.
check("the newest task goes to the top",
      bool(top) and top["text"] == "The newest thing", str(top))

# ---------------------------------------------------------------------------
#  A bad or wrong token does nothing
# ---------------------------------------------------------------------------
before = len(db.query("SELECT id FROM todo_items"))
for bad in ("nope", "", token[:-1], token + "x", "../../etc/passwd"):
    result = devices.receive(bad, "Should not appear")
    check(f"token {bad[:14]!r} is refused", "error" in result, str(result))
after = len(db.query("SELECT id FROM todo_items"))
check("and nothing was written", before == after, f"{before} -> {after}")

# A task link must not be usable as a variable webhook, or a token handed to
# the family would be a way to write board state.
vars_before = db.query("SELECT name FROM variables")
devices.receive(token, {"value": "42"})
vars_after = db.query("SELECT name FROM variables")
check("a task link never writes a variable",
      len(vars_before) == len(vars_after), str(vars_after))

# And the reverse: a variable webhook must not add tasks.
var_hook = devices.create_webhook("Sensor", "temp")
tasks_before = len(db.query("SELECT id FROM todo_items"))
devices.receive(var_hook["token"], {"text": "Sneak this in"})
tasks_after = len(db.query("SELECT id FROM todo_items"))
check("a variable webhook never adds a task", tasks_before == tasks_after)
check("it still writes its variable", devices.get_variable("temp") is not None)

# ---------------------------------------------------------------------------
#  A deleted list fails cleanly rather than orphaning rows
# ---------------------------------------------------------------------------
doomed = db.execute("INSERT INTO todo_lists (name) VALUES (?)", ("Temporary",))
temp_hook = devices.create_webhook("Temp", "", kind="task", target=doomed)
check("it works while the list exists",
      devices.receive(temp_hook["token"], "Before").get("ok") is True)
db.execute("DELETE FROM todo_lists WHERE id = ?", (doomed,))
result = devices.receive(temp_hook["token"], "After")
check("and says so once the list is gone",
      "no longer exists" in (result.get("error") or ""), str(result))

# ---------------------------------------------------------------------------
#  Hits are counted, so a link that nobody uses can be spotted and deleted
# ---------------------------------------------------------------------------
row = db.one("SELECT hits FROM webhooks WHERE token = ?", (token,))
check("successful sends are counted", row["hits"] > 0, str(row))
unused = devices.create_webhook("Never used", "", kind="task", target=inbox_list)
row = db.one("SELECT hits FROM webhooks WHERE token = ?", (unused["token"],))
check("an unused link shows zero", row["hits"] == 0, str(row))

# ---------------------------------------------------------------------------
#  Teams, in and out
# ---------------------------------------------------------------------------
TEAMS = {
    "type": "message",
    "text": "<at>LifeBoard</at> Order more label ribbon",
    "from": {"name": "Sam Smith", "id": "29:1abc",
             "user": {"displayName": "Sam Smith",
                      "email": "someone@example.com"}},
}
result = devices.receive(token, TEAMS)
check("a Teams message becomes a task", result.get("ok") is True, str(result))
check("and the bot mention is not part of it",
      result.get("text") == "Order more label ribbon", str(result))
check("and whoever sent it is remembered",
      result.get("created_by") == "Sam Smith", str(result))

row = db.one("SELECT created_by, created_email, source_hook FROM todo_items "
             "WHERE id = ?", (result["id"],))
check("their address is kept too, so a flow can mail them",
      row["created_email"] == "someone@example.com", str(dict(row)))
check("and which link it came through",
      row["source_hook"] is not None, str(dict(row)))

# Mentions must lose their CONTENTS, not just their tags - stripping tags alone
# leaves the bot's own name at the front of every task from Teams.
for raw, expect in [
    ("<at>LifeBoard</at> milk", "milk"),
    ('<at id="0">Board Bot</at>&nbsp;add milk', "milk"),
    ("<div>Fwd: <b>renew</b> the insurance</div>", "Fwd: renew the insurance"),
]:
    check(f"{raw[:34]!r} -> {expect!r}",
          devices.task_text(raw) == expect, repr(devices.task_text(raw)))

# Other senders' shapes for "who".
for payload, who in [
    ({"text": "x", "by": "Alex"}, "Alex"),
    ({"text": "x", "from": "Power Automate"}, "Power Automate"),
    ({"text": "x", "author": "n8n"}, "n8n"),
    ({"text": "x"}, ""),
]:
    name, _ = devices.task_creator(payload)
    check(f"creator from {list(payload)[-1]}", name == who, f"got {name!r}")

# A completion notice must never raise, never block, and never fire when there
# is nowhere to send it. The tick on the wall matters more than the notice.
quiet = devices.create_webhook("No notify", "", kind="task", target=inbox_list)
made = devices.receive(quiet["token"], "Nothing listens for this")
devices.notify_completed(made["id"])
check("a link with no notify URL simply does nothing", True)

loud = devices.create_webhook("Teams", "", kind="task", target=inbox_list,
                              notify_url="http://127.0.0.1:9/definitely-not-listening")
made = devices.receive(loud["token"], "Somebody is waiting on this")
import time
start = time.time()
devices.notify_completed(made["id"])
elapsed = time.time() - start
# The point of the thread: a dead endpoint must not hold up the checkbox.
check("a dead notify URL does not hold up the tap", elapsed < 0.5,
      f"took {elapsed:.2f}s")
time.sleep(0.3)
check("and the failure did not propagate", True)

# A task that never came from an inbox has nobody to tell.
orphan = db.execute("INSERT INTO todo_items (list_id, text, position) VALUES (?, ?, 0)",
                    (inbox_list, "Typed straight into the list"))
devices.notify_completed(orphan)
check("a task nobody sent notifies nobody", True)
devices.notify_completed(999999)
check("and a task that does not exist is survivable", True)

if failures:
    print()
    for f in failures:
        print(f"  FAIL  {f}")
    print(f"\n{len(failures)} problem(s)")
    sys.exit(1)
print("inbox: a token adds to one list, takes any sender's shape, and reaches "
      "nothing else")
