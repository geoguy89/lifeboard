"""One task interface over three back ends, and the gate on writing.

The widgets do not know or care whether a list lives in Google Tasks,
Microsoft To Do, or LifeBoard's own table. They ask for lists, they ask for
items, and they ask for an item to be completed. This is where that resolves.

WHY THE WRITE GATE LIVES HERE AND NOT IN THE WIDGET
-----------------------------------------------------
The renderer is deliberately unauthenticated. The TV boots before anyone could
log in, so `/api/board` and the tap endpoints have no session behind them -
which means the check on "may this board change somebody's real task list?"
cannot be a client-side flag or a widget setting. Anything on the LAN can POST
to the endpoint regardless of what the widget was configured to show.

So the answer is a property of the SOURCE, checked server-side on every write:

    allow_complete = 0   (default)  read-only, taps are refused
    allow_complete = 1              taps may complete tasks in this account

The OAuth scope now permits writing - it has to, or crossing something off is
impossible - but the scope is not the permission. Two switches, and the one
that matters is the one an attacker on the network cannot reach.

Completing is never a delete, in any back end. The item stays in the user's own
app with a tick on it. A wall display has no undo, so anything it does must be
something the user can reverse from their phone.
"""

from __future__ import annotations

import json

from .. import db
from .base import FetchResult

# Which source kinds can back a task widget, and what to call them.
BACKENDS = {
    "google": "Google Tasks",
    "graph": "Microsoft To Do",
    "local": "LifeBoard list",
}


def _source(source_id: int) -> dict | None:
    return db.one("SELECT * FROM sources WHERE id = ?", (source_id,))


def _config(source: dict) -> dict:
    try:
        return json.loads(source["config"] or "{}")
    except (TypeError, ValueError):
        return {}


def may_write(source_id: int) -> tuple[bool, str]:
    """Is this source allowed to be changed from the wall?

    Returns (allowed, why-not). The reason is shown to the person who tapped,
    because a checkbox that silently does nothing is worse than one that says
    it is switched off.
    """
    source = _source(source_id)
    if not source:
        return False, "That account no longer exists on this board."
    if not _config(source).get("allow_complete"):
        return False, (
            f"“{source['name']}” is read-only on this board. Turn on "
            "“Let the board complete tasks” for it on the Sources tab.")
    return True, ""


# --------------------------------------------------------------------------
#  Reading
# --------------------------------------------------------------------------

def lists(backend: str, token: str = "") -> FetchResult:
    """The task lists available from one back end, for the admin's pickers."""
    if backend == "local":
        return FetchResult(payload={"lists": [
            {"id": str(row["id"]), "title": row["name"]}
            for row in db.query("SELECT id, name FROM todo_lists ORDER BY name")
        ]})
    if not token:
        return FetchResult(error="pick an account first")
    if backend == "google":
        from . import gtasks
        return gtasks.list_task_lists(token)
    if backend == "graph":
        from . import mstodo
        return mstodo.list_task_lists(token)
    return FetchResult(error=f"unknown task back end: {backend}")


def items(backend: str, list_id: str, token: str = "", *,
          show_completed: bool = False, limit: int = 50) -> FetchResult:
    """One list's items, in a shape every task widget understands.

    The common shape is deliberately small - id, title, done, due, note - so a
    widget written against one back end works against all three. Anything
    back-end specific (Planner percentages, To Do importance) rides alongside
    and is ignored by widgets that do not know about it.
    """
    if backend == "local":
        if not str(list_id).isdigit():
            return FetchResult(error="pick a list")
        rows = db.query(
            "SELECT * FROM todo_items WHERE list_id = ? ORDER BY position, id",
            (int(list_id),))
        out = [
            {"id": str(r["id"]), "title": r["text"], "done": bool(r["done"]),
             "due": r["due"] or "", "notes": "", "assignee": r["assignee"] or ""}
            for r in rows
            if show_completed or not r["done"]
        ]
        return FetchResult(payload={"list_id": str(list_id), "items": out[:limit]})

    if not token:
        return FetchResult(error="pick an account first")
    if backend == "google":
        from . import gtasks
        return gtasks.tasks(token, list_id,
                            show_completed=show_completed, limit=limit)
    if backend == "graph":
        from . import mstodo
        return mstodo.tasks(token, list_id,
                            show_completed=show_completed, limit=limit)
    return FetchResult(error=f"unknown task back end: {backend}")


# --------------------------------------------------------------------------
#  Writing - everything below goes through may_write() first
# --------------------------------------------------------------------------

def complete(backend: str, list_id: str, task_id: str, *,
             source_id: int | None = None, token: str = "",
             done: bool = True) -> FetchResult:
    """Tick one item off, whichever back end it came from."""
    if backend == "local":
        # LifeBoard's own lists are the board's data, not somebody's account,
        # so they need no account-level permission. This is the same write the
        # existing to-do widget has always made.
        if not str(task_id).isdigit():
            return FetchResult(error="not a valid item")
        db.execute(
            "UPDATE todo_items SET done = ?, done_at = CASE WHEN ? = 1 "
            "THEN datetime('now') ELSE NULL END WHERE id = ?",
            (1 if done else 0, 1 if done else 0, int(task_id)))
        if done:
            # Tell whoever sent it, if they came in through an inbox that has
            # somewhere to tell. Fire and forget on a thread - see
            # devices.notify_completed: a slow Teams endpoint must never make
            # the tick on the wall feel slow, or fail.
            from .. import devices
            devices.notify_completed(int(task_id))
        return FetchResult(payload={"ok": True, "id": task_id, "done": done})

    if not source_id:
        return FetchResult(error="no account for that list")
    allowed, why = may_write(int(source_id))
    if not allowed:
        return FetchResult(error=why)

    if backend == "google":
        from . import gtasks
        return gtasks.complete(token, list_id, task_id, done)
    if backend == "graph":
        from . import mstodo
        return mstodo.complete(token, list_id, task_id, done)
    return FetchResult(error=f"unknown task back end: {backend}")
