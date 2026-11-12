"""Microsoft Planner, as a Kanban board.

Planner's own model is already Kanban - a plan holds buckets, buckets hold
tasks - so this reads it as it is rather than inventing columns. The board is a
mirror of what people see in Teams, which is the whole point: if the wall shows
a different arrangement to the app, nobody trusts either.

THREE THINGS ABOUT THE GRAPH API THAT SHAPE THIS FILE
------------------------------------------------------
1. **Every write needs an ETag.** Planner uses optimistic concurrency: you PATCH
   with `If-Match: <@odata.etag>` and Graph refuses if anyone changed the task
   since you read it. That is not an annoyance to work around, it is exactly
   right for a wall display - two people can be looking at the same board, and
   the second tap should fail loudly rather than silently overwrite the first.

2. **Completion is a percentage, not a boolean.** `percentComplete: 100` is
   done, 0 is not started, 50 is in progress. Planner shows a half-filled
   circle for the middle value, so setting 100 is what actually ticks it.

3. **Listing is two calls, not one.** Buckets and tasks come from different
   endpoints, and a task carries its `bucketId` rather than a bucket carrying
   its tasks. So the grouping happens here.

Read needs `Tasks.Read`; moving or completing needs `Tasks.ReadWrite`, and the
board refuses to write at all unless the source has `allow_complete` on - see
`tasks.py`.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx

from .base import CACHE, FetchResult

GRAPH = "https://graph.microsoft.com/v1.0"
USER_AGENT = "LifeBoard/0.1 (+local dashboard)"
TIMEOUT = 25.0


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
        raise ValueError("Planner needs an authorised Microsoft account")
    return httpx.Client(
        base_url=GRAPH,
        timeout=TIMEOUT,
        headers={"Authorization": f"Bearer {access_token}",
                 "User-Agent": USER_AGENT,
                 "Content-Type": "application/json"},
    )


def list_plans(access_token: str, *, ttl: float = 600.0) -> FetchResult:
    """Every plan the signed-in user can see, for the admin's picker."""
    cache_key = ("planner-plans", _who(access_token))
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached
    try:
        with _client(access_token) as client:
            resp = client.get("/me/planner/plans")
            resp.raise_for_status()
            plans = resp.json().get("value", [])
        result = FetchResult(payload={
            "plans": [{"id": p.get("id"), "title": p.get("title", "")}
                      for p in plans],
        })
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def board(access_token: str, plan_id: str, *, show_completed: bool = False,
          ttl: float = 120.0) -> FetchResult:
    """One plan as columns of cards, in the plan's own bucket order."""
    cache_key = ("planner", _who(access_token), plan_id, show_completed)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached
    try:
        with _client(access_token) as client:
            buckets = client.get(f"/planner/plans/{plan_id}/buckets")
            buckets.raise_for_status()
            raw_buckets = buckets.json().get("value", [])

            tasks = client.get(f"/planner/plans/{plan_id}/tasks")
            tasks.raise_for_status()
            raw_tasks = tasks.json().get("value", [])

        by_bucket: dict[str, list] = {}
        for t in raw_tasks:
            done = int(t.get("percentComplete") or 0) >= 100
            if done and not show_completed:
                continue
            by_bucket.setdefault(t.get("bucketId") or "", []).append({
                "id": t.get("id"),
                "title": (t.get("title") or "").strip(),
                "done": done,
                "percent": int(t.get("percentComplete") or 0),
                "due": _date(t.get("dueDateTime")),
                "priority": int(t.get("priority") or 5),
                "checklist_done": (t.get("checklistItemCount") or 0)
                and (t.get("activeChecklistItemCount") or 0) == 0,
                "checklist_total": int(t.get("checklistItemCount") or 0),
                "checklist_left": int(t.get("activeChecklistItemCount") or 0),
                "assigned": len(t.get("assignments") or {}),
                # Needed to write back. Graph rejects a PATCH without it, so a
                # card that arrives without one is displayable but not tappable.
                "etag": (t.get("@odata.etag") or ""),
                "order": t.get("orderHint", ""),
            })

        columns = []
        for b in sorted(raw_buckets, key=lambda b: b.get("orderHint", "")):
            cards = by_bucket.get(b.get("id"), [])
            cards.sort(key=lambda c: c["order"])
            columns.append({
                "id": b.get("id"),
                "title": b.get("name", ""),
                "cards": cards,
            })

        # Tasks whose bucket was deleted still exist in Planner and would
        # otherwise vanish from the wall while staying in the app.
        known = {b.get("id") for b in raw_buckets}
        orphans = [c for bid, cards in by_bucket.items() if bid not in known
                   for c in cards]
        if orphans:
            columns.append({"id": "", "title": "Unsorted", "cards": orphans})

        result = FetchResult(payload={"plan_id": plan_id, "columns": columns})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def update_task(access_token: str, task_id: str, etag: str, *,
                bucket_id: str = "", percent: int | None = None) -> FetchResult:
    """Move a card, complete it, or both, in one PATCH.

    Both at once matters: "tick it and send it to Done" is one gesture on the
    wall and should be one write, or a failure halfway leaves a card ticked in
    the wrong column.
    """
    if not etag:
        return FetchResult(error=(
            "That card arrived without a version tag, so it cannot be changed "
            "safely. Refresh the board and try again."))
    body: dict = {}
    if bucket_id:
        body["bucketId"] = bucket_id
    if percent is not None:
        body["percentComplete"] = max(0, min(100, int(percent)))
    if not body:
        return FetchResult(error="nothing to change")

    try:
        with _client(access_token) as client:
            resp = client.patch(
                f"/planner/tasks/{task_id}",
                json=body,
                # Graph wants the etag quoted exactly as it was handed out.
                headers={"If-Match": etag, "Prefer": "return=representation"},
            )
            if resp.status_code == 412:
                return FetchResult(error=(
                    "Somebody else changed that card first. The board will "
                    "catch up on its next refresh."))
            resp.raise_for_status()
        CACHE.drop_prefix(("planner",))
        return FetchResult(payload={"ok": True, "id": task_id, **body})
    except Exception as exc:  # noqa: BLE001
        return FetchResult(error=_friendly(exc))


def _date(value: dict | str | None) -> str:
    if not value:
        return ""
    text = value.get("dateTime") if isinstance(value, dict) else value
    if not text:
        return ""
    try:
        parsed = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
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
        return ("Microsoft refused the request. Planner needs Tasks.ReadWrite - "
                "reconnect the account to grant it.")
    if "404" in text:
        return "That plan no longer exists, or this account cannot see it."
    return f"{type(exc).__name__}: {text}"[:300]
