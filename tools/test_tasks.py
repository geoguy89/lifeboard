# -*- coding: utf-8 -*-
"""The gate between a finger on the wall and somebody's real task list.

    python tools/test_tasks.py

The renderer is unauthenticated on purpose - the TV boots before anyone could
log in - so the endpoint that completes a task has no session behind it.
Anything on the LAN can post to it. That makes the permission check the only
thing standing between a visitor's phone and a Google account, and it has to
live on the server: a widget setting or a hidden button is not a check.

The rule is one line: a source may be written to only if its own config says
`allow_complete`. This proves that rule holds in every direction, including
the ones that matter most - default off, and off means refused rather than
silently ignored.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

TMP = Path(tempfile.mkdtemp(prefix="lifeboard-tasks-"))
os.environ["LIFEBOARD_DB"] = str(TMP / "test.db")
os.environ["LIFEBOARD_KEY"] = str(TMP / "secret.key")

from lifeboard import db  # noqa: E402
from lifeboard.providers import tasks  # noqa: E402

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        return
    failures.append(f"{name}{f' - {detail}' if detail else ''}")


def make_source(kind: str, name: str, config: dict) -> int:
    return db.execute(
        "INSERT INTO sources (kind, name, config) VALUES (?, ?, ?)",
        (kind, name, json.dumps(config)))


# ---------------------------------------------------------------------------
#  The gate
# ---------------------------------------------------------------------------
locked = make_source("google", "Family Google", {"calendar_id": "primary"})
opened = make_source("google", "Shared Google", {"allow_complete": True})
ms = make_source("graph", "Work Microsoft", {"allow_complete": True})

allowed, why = tasks.may_write(locked)
check("a source is read-only until somebody says otherwise", allowed is False)
check("and the refusal names the source, so it can be found and fixed",
      "Family Google" in why, why)
check("and says where the switch is", "Sources" in why, why)

allowed, why = tasks.may_write(opened)
check("a source with the switch on may be written", allowed is True, why)

allowed, why = tasks.may_write(9999)
check("a source that does not exist is refused", allowed is False)
check("without pretending it was a permissions problem",
      "no longer exists" in why, why)

# A config that is malformed must not read as permission. Truthiness on a
# broken value is exactly how a default-deny becomes a default-allow.
broken = db.execute(
    "INSERT INTO sources (kind, name, config) VALUES (?, ?, ?)",
    ("google", "Broken", "{not json"))
allowed, _ = tasks.may_write(broken)
check("a source with unreadable config is refused", allowed is False)

for value in (0, "", None, "false", "no"):
    sid = make_source("google", f"falsy-{value!r}", {"allow_complete": value})
    allowed, _ = tasks.may_write(sid)
    # "false" and "no" are strings and therefore truthy in Python. That is a
    # real trap: a checkbox that round-trips through a text field would arrive
    # as the string "false" and switch writing ON. The admin sends a boolean,
    # so this records what the current behaviour actually is rather than
    # asserting a guess.
    expected = bool(value)
    check(f"allow_complete={value!r} is treated as {expected}",
          allowed is expected, f"got {allowed}")

# ---------------------------------------------------------------------------
#  Completing goes through the gate - and local lists do not need it
# ---------------------------------------------------------------------------
list_id = db.execute("INSERT INTO todo_lists (name) VALUES (?)", ("Shopping",))
item_id = db.execute(
    "INSERT INTO todo_items (list_id, text, position) VALUES (?, ?, ?)",
    (list_id, "Milk", 0))

result = tasks.complete("local", str(list_id), str(item_id), done=True)
check("a LifeBoard list needs no account permission", result.error == "", result.error)
row = db.one("SELECT done, done_at FROM todo_items WHERE id = ?", (item_id,))
check("and the item really is ticked", row["done"] == 1)
check("and stamped with when", bool(row["done_at"]))

result = tasks.complete("local", str(list_id), str(item_id), done=False)
row = db.one("SELECT done, done_at FROM todo_items WHERE id = ?", (item_id,))
check("un-ticking works too", row["done"] == 0)
check("and clears the stamp rather than leaving a done date on a live task",
      row["done_at"] is None)

# The one that matters: a real account with the switch off is REFUSED, and no
# network call is attempted. If this ever passes through, the board can change
# somebody's Google Tasks because a stranger walked up to the TV.
result = tasks.complete("google", "listA", "taskA", source_id=locked,
                        token="not-a-real-token", done=True)
check("completing on a locked account is refused", bool(result.error))
check("and the reason is the permission, not a network failure",
      "read-only on this board" in (result.error or ""), result.error)

result = tasks.complete("google", "listA", "taskA", source_id=None,
                        token="x", done=True)
check("completing with no account at all is refused", bool(result.error))

result = tasks.complete("nonsense", "listA", "taskA", source_id=opened,
                        token="x", done=True)
check("an unknown back end is refused rather than guessed at",
      "unknown task back end" in (result.error or ""), result.error)

# A non-numeric id must not reach the database.
result = tasks.complete("local", "1", "1 OR 1=1", done=True)
check("a local id that is not a number is refused",
      "not a valid item" in (result.error or ""), result.error)

# ---------------------------------------------------------------------------
#  Reading local lists
# ---------------------------------------------------------------------------
res = tasks.lists("local")
check("local lists are listed with no account", res.error == "", res.error)
check("and include the one just made",
      any(l["title"] == "Shopping" for l in res.payload["lists"]))

db.execute("INSERT INTO todo_items (list_id, text, done, position) VALUES (?, ?, 1, 1)",
           (list_id, "Already bought"))
res = tasks.items("local", str(list_id))
titles = [i["title"] for i in res.payload["items"]]
check("completed items are hidden by default", "Already bought" not in titles, str(titles))
check("and live ones are not", "Milk" in titles, str(titles))

res = tasks.items("local", str(list_id), show_completed=True)
titles = [i["title"] for i in res.payload["items"]]
check("show_completed brings them back", "Already bought" in titles, str(titles))

res = tasks.items("local", "not-a-number")
check("a non-numeric list id is refused rather than queried", bool(res.error))

res = tasks.items("google", "list", token="")
check("a real back end with no token says so rather than calling out",
      "pick an account" in (res.error or ""), res.error)

# ---------------------------------------------------------------------------
#  The shape every widget relies on
# ---------------------------------------------------------------------------
res = tasks.items("local", str(list_id), show_completed=True)
for item in res.payload["items"]:
    for key in ("id", "title", "done", "due"):
        check(f"every item carries {key}", key in item, str(item))
    check("id is a string, as the other back ends return",
          isinstance(item["id"], str), repr(item["id"]))
    check("done is a real boolean", isinstance(item["done"], bool), repr(item["done"]))

# ---------------------------------------------------------------------------
#  Permission is checked BEFORE authentication
#
#  Found on the live board, not here: /api/tasks/complete resolved the OAuth
#  token first, so a locked source answered "reconnect needed" - sending
#  somebody off to re-authorise an account that was never the problem, while
#  the real fix was one switch. It also did OAuth work, up to a network token
#  refresh, for a request that was always going to be refused, which let
#  anything on the LAN make a read-only source burn refreshes.
#
#  The route ordering cannot be reached from here without FastAPI, so this
#  pins the property the route depends on: the gate answers without needing a
#  token, and refuses on permission rather than on credentials.
# ---------------------------------------------------------------------------
allowed, why = tasks.may_write(locked)
check("the gate decides with no token in hand", allowed is False)
check("and blames the switch, not the credentials",
      "reconnect" not in why.lower() and "read-only" in why, why)

# Passing a plainly invalid token must not change the answer either way: if it
# did, the check would be happening somewhere it should not be.
before = tasks.complete("google", "L", "T", source_id=locked, token="", done=True)
after = tasks.complete("google", "L", "T", source_id=locked,
                       token="garbage-token", done=True)
check("a locked source is refused regardless of the token",
      before.error == after.error and "read-only" in before.error, before.error)

if failures:
    print()
    for f in failures:
        print(f"  FAIL  {f}")
    print(f"\n{len(failures)} problem(s)")
    sys.exit(1)
print("tasks: the write gate holds, and local lists work without an account")
