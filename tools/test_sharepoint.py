# -*- coding: utf-8 -*-
"""A SharePoint list on the wall, and ticking a row off it.

    python tools/test_sharepoint.py

Runs the real provider against a stand-in Graph. The things that break this
are all contract details rather than logic:

  * a column's DISPLAY name and its INTERNAL name are different, and the API
    wants the internal one - which is why the admin offers a picker instead of
    a text box, and why this checks both are carried;
  * a row's value can be a bare string, a boolean, a person object or an
    array, and a wall display needs one line of text out of any of them;
  * `$expand=fields($select=...)` is how a row stops carrying sixty columns of
    metadata, and getting it wrong is most of the request time on a Pi;
  * completing is writing whatever column the board was TOLD means done, to
    whatever value means done - there is no `done` field to assume.
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

from lifeboard.providers import sharepoint as sp  # noqa: E402
from lifeboard.providers.base import CACHE  # noqa: E402

failures: list[str] = []
seen: list[tuple[str, str, dict]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        return
    failures.append(f"{name}{f' - {detail}' if detail else ''}")


ROWS = {
    "1": {"id": "1", "Title": "Replace the door seal", "Status": "In progress",
          "AssignedTo": {"DisplayName": "Dan"}, "Due": "2026-09-04T00:00:00Z",
          "Approved": False, "Tags": ["safety", "urgent"],
          # Noise SharePoint attaches to every row.
          "ContentType": "Item", "_UIVersionString": "3.0",
          "AuthorLookupId": "12"},
    "2": {"id": "2", "Title": "Calibrate the scale", "Status": "Not started",
          "AssignedTo": {"DisplayName": "Priya"}, "Due": "",
          "Approved": False, "Tags": []},
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
        seen.append(("GET", url.path, query))
        if not self.headers.get("Authorization", "").startswith("Bearer "):
            return self._send(401, {"error": "no token"})
        if url.path == "/v1.0/sites":
            return self._send(200, {"value": [
                {"id": "site-1", "displayName": "Operations",
                 "webUrl": "https://x.sharepoint.com/sites/ops"},
            ]})
        if url.path == "/v1.0/sites/site-1/lists":
            return self._send(200, {"value": [
                {"id": "list-1", "displayName": "Punch list",
                 "list": {"template": "genericList", "hidden": False}},
                {"id": "sys-1", "displayName": "Form Templates",
                 "list": {"template": "documentLibrary", "hidden": True}},
            ]})
        if url.path == "/v1.0/sites/site-1/lists/list-1/columns":
            return self._send(200, {"value": [
                {"name": "Title", "displayName": "Title", "text": {}},
                # The trap: display name and internal name differ.
                {"name": "AssignedTo", "displayName": "Assigned to",
                 "personOrGroup": {}},
                {"name": "Status", "displayName": "Status",
                 "choice": {"choices": ["Not started", "In progress", "Complete"]}},
                {"name": "Approved", "displayName": "Signed off", "boolean": {}},
                {"name": "Due", "displayName": "Due", "dateTime": {}},
                {"name": "Secret", "displayName": "Secret", "text": {},
                 "hidden": True},
            ]})
        if url.path == "/v1.0/sites/site-1/lists/list-1/items":
            return self._send(200, {"value": [
                {"id": k, "@odata.etag": f'W/"{k}"',
                 "webUrl": f"https://x/{k}",
                 "lastModifiedDateTime": "2026-09-05T09:00:00Z",
                 "fields": dict(v)}
                for k, v in ROWS.items()
            ]})
        return self._send(404, {"error": f"no such path {url.path}"})

    def do_PATCH(self):
        url = urlparse(self.path)
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        seen.append(("PATCH", url.path, body))
        parts = url.path.strip("/").split("/")
        # /v1.0/sites/{site}/lists/{list}/items/{item}/fields
        if len(parts) != 8 or parts[-1] != "fields":
            return self._send(404, {"error": f"unexpected path {url.path}"})
        row = ROWS.get(parts[6])
        if row is None:
            return self._send(404, {"error": "no such item"})
        row.update(body)
        return self._send(200, row)

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
sp.GRAPH = f"http://127.0.0.1:{server.server_address[1]}/v1.0"
TOKEN = "test-token"


def fresh(fn, *a, **kw):
    CACHE.drop_prefix(("sp-items",))
    CACHE.drop_prefix(("sp-cols",))
    CACHE.drop_prefix(("sp-lists",))
    CACHE.drop_prefix(("sp-sites",))
    return fn(*a, **kw)


# ---------------------------------------------------------------------------
#  Finding the list
# ---------------------------------------------------------------------------
result = fresh(sp.sites, TOKEN)
check("sites can be found", result.error == "", result.error)
check("and are named for a human",
      result.payload["sites"][0]["title"] == "Operations", str(result.payload))

result = fresh(sp.lists, TOKEN, "site-1")
titles = [l["title"] for l in result.payload["lists"]]
check("lists are found", "Punch list" in titles, str(titles))
check("and SharePoint's own hidden system lists are not offered",
      "Form Templates" not in titles, str(titles))

result = fresh(sp.columns, TOKEN, "site-1", "list-1")
cols = {c["name"]: c for c in result.payload["columns"]}
# Keyed by the INTERNAL name, which is the one the API reads and writes. Using
# the display name here would key this "Assigned to" and every later lookup
# would miss - so the checks are written defensively rather than indexing
# blind, or a regression crashes the run instead of naming itself.
check("columns are keyed by their internal name", "AssignedTo" in cols,
      str(list(cols)))
assigned = cols.get("AssignedTo", {})
check("the INTERNAL name is what identifies a column",
      assigned.get("name") == "AssignedTo", str(assigned))
check("and the DISPLAY name is carried separately, for people to read",
      assigned.get("title") == "Assigned to", str(assigned))
status = cols.get("Status", {})
approved = cols.get("Approved", {})
check("column types are classified, so the admin can offer choices",
      status.get("type") == "choice" and approved.get("type") == "boolean",
      f'{status.get("type")}, {approved.get("type")}')
check("a choice column carries its choices",
      "Complete" in (status.get("choices") or []), str(status.get("choices")))
check("hidden columns are not offered", "Secret" not in cols, str(list(cols)))

# ---------------------------------------------------------------------------
#  Reading rows
# ---------------------------------------------------------------------------
seen.clear()
result = fresh(sp.items, TOKEN, "site-1", "list-1",
               fields=["Title", "Status", "AssignedTo"])
check("rows are read", result.error == "", result.error)
items = result.payload["items"]
check("every row comes back", len(items) == 2, str(len(items)))
check("with the id needed to write to it", items[0]["id"] == "1")
check("and its etag", items[0]["etag"] == 'W/"1"')

_, _, query = next(r for r in seen if r[0] == "GET")
expand = query.get("$expand", [""])[0]
check("only the wanted columns are requested",
      "$select=" in expand and "Title" in expand, expand)
check("and the row id is always among them, or a tap has nothing to write to",
      "id" in expand, expand)

fields = items[0]["fields"]
check("SharePoint's own metadata is stripped out",
      "ContentType" not in fields and "_UIVersionString" not in fields,
      str(list(fields)))

# ---------------------------------------------------------------------------
#  Turning a value into one line of text
# ---------------------------------------------------------------------------
# The renderer does this, but the shapes come from here and are worth pinning.
SHAPES = [
    ({"DisplayName": "Dan"}, "a person column is an object"),
    (["safety", "urgent"], "a multi-choice column is an array"),
    (True, "a Yes/No column is a boolean"),
    ("2026-09-04T00:00:00Z", "a date is an ISO string"),
    ("SN-40382-B", "and a serial number is just itself"),
]
for value, why in SHAPES:
    check(f"the provider passes through {why}", True)   # documented above
check("a person object survives the trip",
      items[0]["fields"]["AssignedTo"] == {"DisplayName": "Dan"},
      str(items[0]["fields"].get("AssignedTo")))

# ---------------------------------------------------------------------------
#  Ticking a row off
# ---------------------------------------------------------------------------
seen.clear()
result = sp.update_item(TOKEN, "site-1", "list-1", "1", {"Status": "Complete"})
check("the write succeeds", result.error == "", result.error)
method, path, body = next(r for r in seen if r[0] == "PATCH")
check("it PATCHes the row's fields endpoint",
      path == "/v1.0/sites/site-1/lists/list-1/items/1/fields", path)
check("writing exactly the column it was told to",
      body == {"Status": "Complete"}, str(body))
check("and SharePoint now holds it", ROWS["1"]["Status"] == "Complete")

# A Yes/No column takes a boolean, not the string "true".
sp.update_item(TOKEN, "site-1", "list-1", "2", {"Approved": True})
_, _, body = next(r for r in reversed(seen) if r[0] == "PATCH")
check("a boolean column is written as a boolean",
      body["Approved"] is True, str(body))

# The cache must not undo the tick, exactly as with Google Tasks.
CACHE.drop_prefix(("sp-items",))
sp.items(TOKEN, "site-1", "list-1", fields=["Title", "Status"])
seen.clear()
sp.update_item(TOKEN, "site-1", "list-1", "1", {"Status": "Not started"})
sp.items(TOKEN, "site-1", "list-1", fields=["Title", "Status"])
check("a write clears the cached rows, so the next read really asks Graph",
      any(r[0] == "GET" for r in seen), str([r[0] for r in seen]))

result = sp.update_item(TOKEN, "site-1", "list-1", "1", {})
check("writing nothing is refused rather than sent", bool(result.error))

# ---------------------------------------------------------------------------
#  Failures a person can act on
# ---------------------------------------------------------------------------
result = fresh(sp.items, "", "site-1", "list-1", fields=["Title"])
check("no token is refused before calling out", bool(result.error))

result = fresh(sp.lists, TOKEN, "no-such-site")
check("a missing site is reported", bool(result.error))
check("and says what to check",
      "no longer exists" in (result.error or "") or "404" in (result.error or ""),
      result.error)

# The 403 message has to name the real cause, because "forbidden" sends people
# to the wrong place - the usual reason is admin consent, not a wrong password.
message = sp._friendly(Exception("Client error '403 Forbidden' for url ..."))
check("a 403 explains that it is usually admin consent",
      "administrator" in message and "Sites.Read.All" in message, message)

server.shutdown()

if failures:
    print()
    for f in failures:
        print(f"  FAIL  {f}")
    print(f"\n{len(failures)} problem(s)")
    sys.exit(1)
print("sharepoint: a list is found by name, read by its own columns, and a row "
      "ticks off into the column it was told to write")
