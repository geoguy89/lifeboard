# -*- coding: utf-8 -*-
"""Add it in Google Tasks, see it on the wall, tick it, and it is done in Google.

    python tools/test_gtasks_roundtrip.py

There is no sync layer and no copy of anything. The board reads the Google
Tasks API live and writes straight back to it, so "two-way" is not a process
that runs - it is just the absence of a second copy to drift from.

This runs the REAL provider against a stand-in Google that behaves the way the
documented API does, because the things that break this are all details of
that contract: the exact PATCH path, that completing is a status change rather
than a delete, that un-ticking has to clear the completion timestamp, and that
the cached list must be dropped the moment it is written to - otherwise the
board serves the pre-tap answer for another two minutes and the tick appears
to undo itself.
"""
from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from lifeboard.providers import gtasks  # noqa: E402
from lifeboard.providers.base import CACHE  # noqa: E402

failures: list[str] = []
requests: list[tuple[str, str, dict]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        return
    failures.append(f"{name}{f' - {detail}' if detail else ''}")


# ---------------------------------------------------------------------------
#  A stand-in Google, behaving as the documented API does
# ---------------------------------------------------------------------------
TASKS = {
    "1": {"id": "1", "title": "Milk", "status": "needsAction", "position": "01"},
    "2": {"id": "2", "title": "Book the dentist", "status": "needsAction",
          "position": "02", "due": "2026-09-08T00:00:00.000Z"},
    "3": {"id": "3", "title": "Already done", "status": "completed",
          "position": "03", "completed": "2026-09-01T10:00:00.000Z"},
}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        requests.append(("GET", url.path, query))
        if not self.headers.get("Authorization", "").startswith("Bearer "):
            return self._send(401, {"error": "no token"})
        if url.path == "/tasks/v1/users/@me/lists":
            return self._send(200, {"items": [
                {"id": "L1", "title": "My Tasks"},
                {"id": "L2", "title": "Shopping"},
            ]})
        if url.path == "/tasks/v1/lists/L1/tasks":
            show = query.get("showCompleted", ["false"])[0] == "true"
            items = [t for t in TASKS.values()
                     if show or t["status"] != "completed"]
            return self._send(200, {"items": items})
        return self._send(404, {"error": "no such path"})

    def do_PATCH(self):
        url = urlparse(self.path)
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        requests.append(("PATCH", url.path, body))
        parts = url.path.strip("/").split("/")
        # /tasks/v1/lists/{list}/tasks/{task}
        if len(parts) != 6 or parts[2] != "lists" or parts[4] != "tasks":
            return self._send(404, {"error": f"unexpected path {url.path}"})
        task = TASKS.get(parts[5])
        if not task:
            return self._send(404, {"error": "no such task"})
        task.update({k: v for k, v in body.items() if v is not None})
        # Google clears the timestamp when a task goes back to needsAction.
        if body.get("status") == "needsAction":
            task.pop("completed", None)
        elif body.get("status") == "completed":
            task["completed"] = "2026-09-05T12:00:00.000Z"
        return self._send(200, task)

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
gtasks.API = f"http://127.0.0.1:{server.server_address[1]}/tasks/v1"

TOKEN = "test-access-token"


def live(**kw):
    """Always hit the stand-in, so cache behaviour is tested explicitly."""
    CACHE.drop_prefix(("gtasks",))
    return gtasks.tasks(TOKEN, "L1", **kw)


# ---------------------------------------------------------------------------
#  1. A task added in Google shows up on the board
# ---------------------------------------------------------------------------
result = gtasks.list_task_lists(TOKEN)
check("the account's lists can be read", result.error == "", result.error)
check("and are named, so the admin can offer a picker",
      [l["title"] for l in result.payload["lists"]] == ["My Tasks", "Shopping"],
      str(result.payload))

result = live()
titles = [t["title"] for t in result.payload["items"]]
check("live tasks are read from Google", result.error == "", result.error)
check("open tasks appear", titles == ["Milk", "Book the dentist"], str(titles))
check("completed ones are left off the wall", "Already done" not in titles)

# Add one the way a phone would, then re-read.
TASKS["4"] = {"id": "4", "title": "Collect the parcel", "status": "needsAction",
              "position": "04"}
titles = [t["title"] for t in live().payload["items"]]
check("a task added in Google appears on the next refresh",
      "Collect the parcel" in titles, str(titles))

result = live(show_completed=True)
titles = [t["title"] for t in result.payload["items"]]
check("and completed ones can be shown if wanted",
      "Already done" in titles, str(titles))

# Google's own order is kept, because that is the order they are in on the
# phone - which is where they were written.
result = live()
check("Google's own ordering is preserved",
      [t["title"] for t in result.payload["items"]]
      == ["Milk", "Book the dentist", "Collect the parcel"],
      str([t["title"] for t in result.payload["items"]]))

# ---------------------------------------------------------------------------
#  2. Ticking it on the wall completes it in Google
# ---------------------------------------------------------------------------
requests.clear()
result = gtasks.complete(TOKEN, "L1", "1", done=True)
check("the write succeeds", result.error == "", result.error)

method, path, body = next((r for r in requests if r[0] == "PATCH"), (None, None, None))
check("it PATCHes the documented path",
      path == "/tasks/v1/lists/L1/tasks/1", str(path))
check("completing is a status change, not a delete",
      body == {"status": "completed"}, str(body))
check("Google now holds it as completed",
      TASKS["1"]["status"] == "completed", str(TASKS["1"]))
check("with a completion timestamp, as the phone will show",
      bool(TASKS["1"].get("completed")))

# And it leaves the board, because the board asks for open tasks only.
titles = [t["title"] for t in live().payload["items"]]
check("so it drops off the wall", "Milk" not in titles, str(titles))

# ---------------------------------------------------------------------------
#  3. The cache must not undo the tick
#
#  This is the one that would look like a bug rather than a delay. The list is
#  cached for two minutes; without dropping it on write, the next refresh
#  re-serves the pre-tap answer and the task the user just ticked comes back.
# ---------------------------------------------------------------------------
CACHE.drop_prefix(("gtasks",))
gtasks.tasks(TOKEN, "L1")                      # warm the cache
gtasks.tasks(TOKEN, "L1", show_completed=True)  # the other variant too
gtasks.complete(TOKEN, "L1", "2", done=True)

requests.clear()
after = gtasks.tasks(TOKEN, "L1")
check("the write cleared the cache, so the next read really asks Google",
      any(r[0] == "GET" for r in requests), str(requests))
titles = [t["title"] for t in after.payload["items"]]
check("and the ticked task does not come back",
      "Book the dentist" not in titles, str(titles))

# Both cached variants have to go, not just the one the caller knew about.
requests.clear()
gtasks.tasks(TOKEN, "L1", show_completed=True)
check("including the show-completed variant",
      any(r[0] == "GET" for r in requests), str(requests))

# ---------------------------------------------------------------------------
#  4. Un-ticking puts it back, and clears the timestamp
# ---------------------------------------------------------------------------
requests.clear()
result = gtasks.complete(TOKEN, "L1", "1", done=False)
check("un-ticking succeeds", result.error == "", result.error)
_, _, body = next(r for r in requests if r[0] == "PATCH")
check("it asks for needsAction", body.get("status") == "needsAction", str(body))
check("and clears the completion time, or some clients still show it as done",
      "completed" in body and body["completed"] is None, str(body))
check("Google has it open again", TASKS["1"]["status"] == "needsAction")
check("with no stale timestamp", "completed" not in TASKS["1"], str(TASKS["1"]))
titles = [t["title"] for t in live().payload["items"]]
check("and it is back on the wall", "Milk" in titles, str(titles))

# ---------------------------------------------------------------------------
#  5. Failures say something a person can act on
# ---------------------------------------------------------------------------
result = gtasks.complete(TOKEN, "L1", "does-not-exist", done=True)
check("a task that is gone is reported", bool(result.error))

result = gtasks.tasks("", "L1")
check("no token is refused before calling out", bool(result.error))

server.shutdown()

if failures:
    print()
    for f in failures:
        print(f"  FAIL  {f}")
    print(f"\n{len(failures)} problem(s)")
    sys.exit(1)
print("google tasks: added on the phone shows on the wall, ticked on the wall "
      "completes on the phone")
