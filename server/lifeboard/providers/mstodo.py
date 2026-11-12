"""Microsoft To Do, through Graph.

Rides the same Graph connection the Microsoft calendar sources use. That is
worth more here than it was for Google Tasks, because Microsoft's flow is a
DEVICE flow: the board shows a code, you type it on a phone, and no redirect
URI is involved at all. A LAN appliance has no public redirect URI to register,
so this is the one provider where connecting is genuinely pleasant.

READ AND WRITE, unlike the Google Tasks provider's read-only default - but the
write is gated twice over. `Tasks.ReadWrite` has to be granted at connect time,
AND the source has to have `allow_complete` turned on before the board will act
on a tap. The scope alone is not permission; see `tasks.py`.

Graph's To Do model is lists -> tasks. A task is completed by setting its
`status`, not by deleting it: the item stays in the user's app with a tick,
which is what someone crossing something off a wall board expects to see when
they later open their phone.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx

from .base import CACHE, FetchResult

GRAPH = "https://graph.microsoft.com/v1.0"
USER_AGENT = "LifeBoard/0.1 (+local dashboard)"
TIMEOUT = 20.0


def _who(access_token: str) -> str:
    """A short, non-secret fingerprint of the token, for cache keys.

    The cache is keyed by list id, and list ids are only unique WITHIN an
    account - so without this, two connected accounts can share a cache entry,
    and a source whose token was revoked keeps being served the other one's
    tasks. The tail is enough to tell two tokens apart and is never logged or
    returned.
    """
    return (access_token or "")[-12:]


def _client(access_token: str) -> httpx.Client:
    if not access_token:
        raise ValueError("Microsoft To Do needs an authorised account")
    return httpx.Client(
        base_url=GRAPH,
        timeout=TIMEOUT,
        headers={"Authorization": f"Bearer {access_token}",
                 "User-Agent": USER_AGENT,
                 "Content-Type": "application/json"},
    )


def list_task_lists(access_token: str, *, ttl: float = 600.0) -> FetchResult:
    """The user's To Do lists, for the admin's picker."""
    cache_key = ("mstodo-lists", _who(access_token))
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached
    try:
        with _client(access_token) as client:
            resp = client.get("/me/todo/lists", params={"$top": 100})
            resp.raise_for_status()
            items = resp.json().get("value", [])
        result = FetchResult(payload={
            "lists": [
                {"id": i.get("id"),
                 "title": i.get("displayName", ""),
                 # The default list cannot be renamed or deleted, and saying so
                 # stops "Tasks" looking like a list somebody made by mistake.
                 "default": i.get("wellknownListName") == "defaultList"}
                for i in items
            ],
        })
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def tasks(access_token: str, list_id: str, *, show_completed: bool = False,
          limit: int = 50, ttl: float = 120.0) -> FetchResult:
    """One list's tasks.

    Filtered server-side where possible: a long-lived To Do list accumulates
    hundreds of completed items, and fetching them to throw them away is the
    difference between a board that updates in a second and one that stalls.
    """
    cache_key = ("mstodo", _who(access_token), list_id, show_completed)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached
    try:
        params: dict = {"$top": max(1, min(int(limit), 200))}
        if not show_completed:
            params["$filter"] = "status ne 'completed'"
        with _client(access_token) as client:
            resp = client.get(f"/me/todo/lists/{list_id}/tasks", params=params)
            resp.raise_for_status()
            raw = resp.json().get("value", [])

        items = []
        for t in raw:
            items.append({
                "id": t.get("id"),
                "title": (t.get("title") or "").strip(),
                "notes": ((t.get("body") or {}).get("content") or "").strip(),
                "done": t.get("status") == "completed",
                "due": _date(t.get("dueDateTime")),
                "importance": t.get("importance", "normal"),
                "created": t.get("createdDateTime", ""),
            })
        items = [i for i in items if i["title"]]
        # Flagged items first, then by due date, then whatever order Graph gave
        # - which is roughly creation order and is at least stable.
        items.sort(key=lambda i: (
            0 if i["importance"] == "high" else 1,
            i["due"] or "9999-99-99",
        ))
        result = FetchResult(payload={"list_id": list_id, "items": items})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def complete(access_token: str, list_id: str, task_id: str,
             done: bool = True) -> FetchResult:
    """Tick or un-tick one task.

    `status`, not a delete. The item stays in the user's own app with a tick on
    it, which is what somebody crossing something off a wall board expects to
    find when they open their phone later. Deleting would be unrecoverable from
    a display with no undo.
    """
    try:
        with _client(access_token) as client:
            resp = client.patch(
                f"/me/todo/lists/{list_id}/tasks/{task_id}",
                json={"status": "completed" if done else "notStarted"},
            )
            resp.raise_for_status()
        # The cached list is now wrong in a way the user is looking at, so it
        # goes rather than waiting out its TTL.
        CACHE.drop_prefix(("mstodo", _who(access_token), list_id))
        return FetchResult(payload={"ok": True, "id": task_id, "done": done})
    except Exception as exc:  # noqa: BLE001
        return FetchResult(error=_friendly(exc))


def _date(value: dict | None) -> str:
    """Graph returns dueDateTime as {dateTime, timeZone}; the board wants a day."""
    if not value or not value.get("dateTime"):
        return ""
    try:
        text = str(value["dateTime"]).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.date().isoformat()
    except ValueError:
        return ""


def _friendly(exc: Exception) -> str:
    text = str(exc)
    if "401" in text:
        return ("Microsoft rejected the token. Reconnect the account on the "
                "Sources tab.")
    if "403" in text:
        return ("Microsoft refused the request. The account was probably "
                "authorised before Tasks was added, so it has calendar "
                "permission but not tasks - reconnect it to grant "
                "Tasks.ReadWrite.")
    if "404" in text:
        return "That To Do list no longer exists. Pick it again on the Sources tab."
    return f"{type(exc).__name__}: {text}"[:300]
