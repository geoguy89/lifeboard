"""SharePoint / Microsoft Lists, through Graph.

WHY THIS IS NOT JUST ANOTHER TASK BACK END
-------------------------------------------
To Do and Planner have a fixed shape: a thing has a title, a due date, and is
either done or not. A SharePoint list has whatever columns somebody made. One
is a punch list with Status and Assigned To; the next is an asset register with
serial numbers. There is no "title" to assume and no "done" to tick.

So this reads the list's OWN columns and hands them over, and the widget is
told which ones to show. Completing is the same idea: the board is told which
column means done and what value counts as done, rather than guessing.

THE SCOPE IS THE AWKWARD PART, AND IT IS OPT-IN
------------------------------------------------
Reading any site needs `Sites.Read.All`, which in most tenants requires an
ADMIN to consent - unlike `Tasks.ReadWrite`, which a user can usually grant
themselves. Adding it to every Microsoft connection would therefore break the
To Do and Planner setup for anyone who cannot get that consent.

So it is per-source: tick "Also connect SharePoint" and the scope is added to
that account's authorisation. An account connected without it keeps working
for tasks and simply cannot see sites, which is the correct failure.

A dedicated account works well here and is worth recommending: give it read
access to exactly the lists the wall should show, and the board can never
display more than that account can see.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx

from .base import CACHE, FetchResult

GRAPH = "https://graph.microsoft.com/v1.0"
USER_AGENT = "LifeBoard/0.1 (+local dashboard)"
TIMEOUT = 25.0

# Delegated scopes. Read is enough to display; the write one is only requested
# when the board is allowed to tick things off.
SCOPE_READ = "Sites.Read.All"
SCOPE_WRITE = "Sites.ReadWrite.All"

# Columns Graph returns on every list item that are plumbing rather than data.
# Showing these by default would fill a wall display with GUIDs.
_INTERNAL = {
    "@odata.etag", "id", "ContentType", "Modified", "Created", "AuthorLookupId",
    "EditorLookupId", "_UIVersionString", "Attachments", "Edit",
    "LinkTitleNoMenu", "LinkTitle", "ItemChildCount", "FolderChildCount",
    "_ComplianceFlags", "_ComplianceTag", "_ComplianceTagWrittenTime",
    "_ComplianceTagUserId", "AppAuthorLookupId", "AppEditorLookupId",
}


def _who(access_token: str) -> str:
    """Short, non-secret token fingerprint for cache keys - see gtasks._who."""
    return (access_token or "")[-12:]


def _client(access_token: str) -> httpx.Client:
    if not access_token:
        raise ValueError("SharePoint needs an authorised Microsoft account")
    return httpx.Client(
        base_url=GRAPH,
        timeout=TIMEOUT,
        headers={"Authorization": f"Bearer {access_token}",
                 "User-Agent": USER_AGENT,
                 "Content-Type": "application/json"},
    )


# --------------------------------------------------------------------------
#  Finding things, for the admin's pickers
# --------------------------------------------------------------------------

def sites(access_token: str, search: str = "", *, ttl: float = 600.0) -> FetchResult:
    """Sites this account can see.

    Graph has no "list every site I can reach" call - `/sites?search=` is the
    documented way, and an empty search returns the ones the account follows
    plus the root. That is usually what somebody wants and never everything, so
    the admin offers a search box rather than pretending the list is complete.
    """
    cache_key = ("sp-sites", _who(access_token), search)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached
    try:
        with _client(access_token) as client:
            resp = client.get("/sites", params={"search": search or "*"})
            resp.raise_for_status()
            found = resp.json().get("value", [])
        result = FetchResult(payload={"sites": [
            {"id": s.get("id"),
             "title": s.get("displayName") or s.get("name") or "(unnamed)",
             "url": s.get("webUrl", "")}
            for s in found
        ]})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def lists(access_token: str, site_id: str, *, ttl: float = 600.0) -> FetchResult:
    """The lists on one site, hiding the ones SharePoint keeps for itself."""
    cache_key = ("sp-lists", _who(access_token), site_id)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached
    try:
        with _client(access_token) as client:
            resp = client.get(f"/sites/{site_id}/lists", params={"$top": 200})
            resp.raise_for_status()
            found = resp.json().get("value", [])
        out = []
        for entry in found:
            info = entry.get("list") or {}
            # Every site carries dozens of hidden system lists - Form
            # Templates, Style Library, workflow history. Offering them makes
            # the real list impossible to find.
            if info.get("hidden"):
                continue
            out.append({
                "id": entry.get("id"),
                "title": entry.get("displayName") or entry.get("name") or "",
                "template": info.get("template", ""),
                "url": entry.get("webUrl", ""),
            })
        result = FetchResult(payload={"lists": out})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def columns(access_token: str, site_id: str, list_id: str, *,
            ttl: float = 600.0) -> FetchResult:
    """A list's own columns, so the admin can offer them by name.

    This is the call that makes the whole widget possible. Without it, showing
    a SharePoint list means typing internal column names correctly from memory,
    which nobody can do - the display name and the internal name are often
    different, and the internal one is what the API wants.
    """
    cache_key = ("sp-cols", _who(access_token), site_id, list_id)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached
    try:
        with _client(access_token) as client:
            resp = client.get(f"/sites/{site_id}/lists/{list_id}/columns")
            resp.raise_for_status()
            found = resp.json().get("value", [])
        out = []
        for col in found:
            if col.get("hidden") or col.get("readOnly") and col.get("name") in _INTERNAL:
                continue
            kind = ("boolean" if "boolean" in col else
                    "choice" if "choice" in col else
                    "dateTime" if "dateTime" in col else
                    "number" if "number" in col else
                    "person" if "personOrGroup" in col else "text")
            out.append({
                # The internal name is what the API reads and writes; the
                # display name is what a person recognises. Both are needed.
                "name": col.get("name"),
                "title": col.get("displayName") or col.get("name"),
                "type": kind,
                "read_only": bool(col.get("readOnly")),
                "choices": (col.get("choice") or {}).get("choices") or [],
            })
        result = FetchResult(payload={"columns": out})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


# --------------------------------------------------------------------------
#  Reading the list itself
# --------------------------------------------------------------------------

def items(access_token: str, site_id: str, list_id: str, *,
          fields: list[str] | None = None, limit: int = 50,
          order_by: str = "", filter_query: str = "",
          ttl: float = 120.0) -> FetchResult:
    """Rows, with only the columns the board was asked to show.

    `$select` on the expanded fields is not an optimisation detail - a
    SharePoint row can carry sixty columns of metadata, and pulling all of them
    for a wall that shows three is most of the request time on a Pi.
    """
    wanted = [f for f in (fields or []) if f]
    cache_key = ("sp-items", _who(access_token), site_id, list_id,
                 tuple(wanted), limit, order_by, filter_query)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    expand = "fields"
    if wanted:
        # `id` is needed to write back to a row, and asking for it explicitly
        # avoids a second call to find out which row was tapped.
        select = ",".join(sorted(set(wanted + ["id"])))
        expand = f"fields($select={select})"

    params: dict = {"$expand": expand, "$top": max(1, min(int(limit), 200))}
    if order_by:
        params["$orderby"] = f"fields/{order_by}"
    if filter_query:
        params["$filter"] = filter_query

    try:
        with _client(access_token) as client:
            resp = client.get(f"/sites/{site_id}/lists/{list_id}/items",
                              params=params,
                              # Ordering or filtering on a list column needs
                              # this header, and Graph returns a confusing
                              # "field not indexed" error without it.
                              headers={"Prefer": "HonorNonIndexedQueriesWarningMayFailRandomly"})
            resp.raise_for_status()
            rows = resp.json().get("value", [])

        out = []
        for row in rows:
            values = dict(row.get("fields") or {})
            out.append({
                "id": row.get("id"),
                "etag": (row.get("@odata.etag") or ""),
                "url": row.get("webUrl", ""),
                "fields": {k: v for k, v in values.items() if k not in _INTERNAL},
                "modified": _date(row.get("lastModifiedDateTime")),
            })
        result = FetchResult(payload={"list_id": list_id, "items": out})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def update_item(access_token: str, site_id: str, list_id: str, item_id: str,
                values: dict) -> FetchResult:
    """Write one or more columns on a row.

    This is what a tick on the wall becomes. Which column, and what value means
    done, are the widget's settings rather than anything assumed here - a
    punch list ticks a Yes/No column, another marks a Status choice as
    "Complete", and guessing between them would be wrong half the time.
    """
    if not values:
        return FetchResult(error="nothing to change")
    try:
        with _client(access_token) as client:
            resp = client.patch(
                f"/sites/{site_id}/lists/{list_id}/items/{item_id}/fields",
                json=values)
            if resp.status_code == 403:
                return FetchResult(error=(
                    "That account can read this list but not change it. It "
                    "needs Sites.ReadWrite.All, and edit rights on the list."))
            resp.raise_for_status()
        CACHE.drop_prefix(("sp-items", _who(access_token), site_id, list_id))
        return FetchResult(payload={"ok": True, "id": item_id, "set": values})
    except Exception as exc:  # noqa: BLE001
        return FetchResult(error=_friendly(exc))


def _date(value) -> str:
    if not value:
        return ""
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.date().isoformat()
    except ValueError:
        return ""


def _friendly(exc: Exception) -> str:
    text = str(exc)
    if "401" in text:
        return "Microsoft rejected the token. Reconnect the account on the Sources tab."
    if "403" in text:
        return ("Microsoft refused this. SharePoint needs Sites.Read.All, which "
                "usually has to be granted by a tenant administrator - tick "
                "“Also connect SharePoint” on the account and reconnect "
                "it, and if it still fails your admin has not consented to that "
                "permission.")
    if "404" in text:
        return "That site or list no longer exists, or this account cannot see it."
    if "429" in text:
        return "Microsoft is rate-limiting this board. It will catch up shortly."
    return f"{type(exc).__name__}: {text}"[:300]
