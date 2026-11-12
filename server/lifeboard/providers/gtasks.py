"""Google Tasks, read-only.

Rides the Google OAuth the calendar sources already use - same app, same
consent screen, one extra scope. That matters because Google will not accept a
LAN address as a redirect URI, so getting through its consent flow on an
appliance takes one of the workarounds in docs/oauth.md. Making Tasks reuse
that connection means doing it once rather than twice.

READ-ONLY by scope: `tasks.readonly` cannot tick anything off, which is the
right shape for a wall display. A board that could silently complete somebody's
tasks is a board nobody should hang in a kitchen.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx

from .base import CACHE, FetchResult

API = "https://tasks.googleapis.com/tasks/v1"
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
        raise ValueError("Google Tasks needs an authorised account")
    return httpx.Client(
        base_url=API,
        timeout=TIMEOUT,
        headers={"Authorization": f"Bearer {access_token}",
                 "User-Agent": USER_AGENT},
    )


def list_task_lists(access_token: str, *, ttl: float = 600.0) -> FetchResult:
    """The user's task lists, for the admin's picker."""
    cache_key = ("gtasks-lists", _who(access_token))
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached
    try:
        with _client(access_token) as client:
            resp = client.get("/users/@me/lists", params={"maxResults": 100})
            resp.raise_for_status()
            items = resp.json().get("items", [])
        result = FetchResult(payload={
            "lists": [{"id": i.get("id"), "title": i.get("title", "")} for i in items],
        })
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def tasks(access_token: str, list_id: str, *, show_completed: bool = False,
          limit: int = 20, ttl: float = 120.0) -> FetchResult:
    """One list's items.

    Sorted by Google's own `position`, which is the order they appear in the
    Tasks app. Sorting by anything else would put the board's idea of the list
    out of step with the phone's, and the phone is where they were written.
    """
    cache_key = ("gtasks", _who(access_token), list_id, show_completed)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached
    try:
        with _client(access_token) as client:
            resp = client.get(f"/lists/{list_id}/tasks", params={
                "maxResults": max(1, min(int(limit), 100)),
                "showCompleted": "true" if show_completed else "false",
                "showHidden": "false",
            })
            resp.raise_for_status()
            raw = resp.json().get("items", [])

        items = []
        for t in raw:
            due = t.get("due")
            when = ""
            if due:
                try:
                    when = datetime.fromisoformat(due.replace("Z", "+00:00")) \
                        .astimezone(timezone.utc).date().isoformat()
                except ValueError:
                    when = ""
            items.append({
                "id": t.get("id"),
                "title": (t.get("title") or "").strip(),
                "notes": (t.get("notes") or "").strip(),
                "done": t.get("status") == "completed",
                "due": when,
                "position": t.get("position", ""),
                # A subtask hangs off a parent; the widget indents rather than
                # showing it as a peer of the thing it belongs to.
                "parent": t.get("parent", ""),
            })
        items = [i for i in items if i["title"]]
        items.sort(key=lambda i: i["position"])
        result = FetchResult(payload={"list_id": list_id, "items": items})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def complete(access_token: str, list_id: str, task_id: str,
             done: bool = True) -> FetchResult:
    """Tick or un-tick one task.

    `status`, never a delete. The task stays in the user's own Tasks app with a
    tick on it, which is what somebody crossing something off a wall board
    expects to find on their phone later - and a delete from a display with no
    undo is unrecoverable.

    Google also wants `completed` cleared when un-ticking; leaving the old
    timestamp on a needsAction task makes it show as done again in some
    clients.
    """
    body: dict = {"status": "completed" if done else "needsAction"}
    if not done:
        body["completed"] = None
    try:
        with _client(access_token) as client:
            resp = client.patch(f"/lists/{list_id}/tasks/{task_id}", json=body)
            resp.raise_for_status()
        # The list the user is looking at is now wrong; do not make them wait
        # out the TTL to see their own tap.
        CACHE.drop_prefix(("gtasks", _who(access_token), list_id))
        return FetchResult(payload={"ok": True, "id": task_id, "done": done})
    except Exception as exc:  # noqa: BLE001
        return FetchResult(error=_friendly(exc))


def _friendly(exc: Exception) -> str:
    text = str(exc)
    if "401" in text:
        return ("Google rejected the token. Reconnect the account on the "
                "Sources tab - a Google app still in Testing expires its "
                "refresh tokens after seven days.")
    if "403" in text:
        return ("Google refused the request. The account was probably "
                "authorised before Tasks was added, so it has calendar "
                "permission but not tasks - reconnect it to grant the new "
                "scope.")
    return f"{type(exc).__name__}: {text}"[:300]
