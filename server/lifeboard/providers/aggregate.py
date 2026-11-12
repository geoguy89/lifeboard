"""Merge every enabled calendar source into one stream of events.

This is the function the calendar widget actually calls. Whether you added a
Google account, an Outlook account or six random .ics URLs, you get one sorted
list back, each event carrying the colour of the source it came from.

Design notes worth keeping:

* **One source failing must never empty the board.** Each source is fetched
  independently and its error recorded against that source; the events from
  every other source still come back. A dashboard that goes blank because one
  feed 404'd is worse than one showing slightly stale data.
* **De-duplication is on content, not uid.** Subscribing to a shared calendar
  from two accounts is common and produces genuinely different uids for the
  same meeting. Matching on (title, start, end) collapses those.
"""

from __future__ import annotations

import json
import re
import logging
import threading
from datetime import datetime

from .. import db, secrets_store
from .base import Event, FetchResult, default_window
from . import ical, oauth_calendars

LOG = logging.getLogger(__name__)


def _sources(kinds: tuple[str, ...]) -> list[dict]:
    marks = ",".join("?" for _ in kinds)
    return db.query(
        f"SELECT * FROM sources WHERE enabled = 1 AND kind IN ({marks}) ORDER BY id",
        kinds,
    )


_REFRESHING: set[Any] = set()
_REFRESH_LOCK = threading.Lock()


def _refresh_in_background(key: Any, work) -> None:
    """Run `work` on a thread, at most one per key.

    The guard matters more than it looks: without it, a board with a month
    view, a week view and an agenda would start three identical twenty-second
    parses at once on a machine that has no spare core for even one.
    """
    with _REFRESH_LOCK:
        if key in _REFRESHING:
            return
        _REFRESHING.add(key)

    def run() -> None:
        try:
            work()
        except Exception:  # noqa: BLE001 - a refresh must never take the board down
            LOG.exception("background calendar refresh failed")
        finally:
            with _REFRESH_LOCK:
                _REFRESHING.discard(key)

    threading.Thread(target=run, daemon=True, name="calendar-refresh").start()


def calendar_events(
    window_start: datetime | None = None,
    window_end: datetime | None = None,
    source_ids: list[int] | None = None,
) -> tuple[list[Event], dict[int, str]]:
    """Returns (merged events, {source_id: error}).

    `source_ids` lets one widget show only a subset of calendars while another
    on the same board shows all of them.
    """
    if window_start is None or window_end is None:
        window_start, window_end = default_window()

    errors: dict[int, str] = {}
    collected: list[Event] = []

    for src in _sources(("ical", "google", "graph")):
        if source_ids and src["id"] not in source_ids:
            continue

        config = json.loads(src["config"] or "{}")
        ttl = float(src.get("refresh_seconds") or 900)

        if src["kind"] == "ical":
            url = config.get("url", "")
            if not url:
                errors[src["id"]] = "no url configured"
                continue
            result = ical.fetch(
                url,
                window_start,
                window_end,
                source_id=src["id"],
                source_name=src["name"],
                colour=src["colour"],
                ttl=ttl,
                # Serve the previous answer and reparse behind it. On a Pi 3
                # this parse is ~20s for a megabyte of iCal, and doing it in
                # the request blanked the calendars every cache expiry.
                refresh_in_background=_refresh_in_background,
            )
        else:
            # OAuth-backed: Google Calendar / Microsoft Graph. Tokens live in
            # the encrypted `secret` column, never in `config`.
            tokens = secrets_store.open_(src.get("secret")) or {}
            result, updated = oauth_calendars.fetch(
                src["kind"], config, tokens, window_start, window_end,
                source_id=src["id"], source_name=src["name"], colour=src["colour"],
                ttl=ttl,
            )
            # A refresh mints a new access token; persist it or every single
            # fetch pays for a refresh round trip.
            if updated:
                db.execute(
                    "UPDATE sources SET secret = ? WHERE id = ?",
                    (secrets_store.seal(updated), src["id"]),
                )

        if result.error:
            errors[src["id"]] = result.error
            _record(src["id"], ok=False, error=result.error)
        else:
            _record(src["id"], ok=True, error="")

        collected.extend(_apply_hides(result.events, config.get("hide_titles", "")))

    return _dedupe(collected), errors


def _apply_hides(events: list[Event], patterns: str) -> list[Event]:
    """Drop events whose title matches one of the source's hide patterns.

    Comma separated, case-insensitive, and matched as a SUBSTRING - so "sprint"
    hides "Morning Productivity Sprint" and "IDE Sprint" without anyone having
    to write either out in full, which is the shape these lists actually take.

    A pattern wrapped in slashes is a regular expression, for the cases
    substrings cannot express - /^Lunch$/ hides the standing lunch block
    without touching "Lunch with Sam". A bad expression is ignored rather
    than raised: a typo in a filter must not empty the calendar.
    """
    terms = [t.strip() for t in (patterns or "").split(",") if t.strip()]
    if not terms:
        return events

    plain: list[str] = []
    regexes: list[re.Pattern] = []
    for term in terms:
        if len(term) > 2 and term.startswith("/") and term.endswith("/"):
            try:
                regexes.append(re.compile(term[1:-1], re.IGNORECASE))
            except re.error as exc:
                LOG.warning("ignoring bad hide pattern %r: %s", term, exc)
        else:
            plain.append(term.lower())

    kept = []
    for event in events:
        title = (event.title or "")
        lowered = title.lower()
        if any(term in lowered for term in plain):
            continue
        if any(rx.search(title) for rx in regexes):
            continue
        kept.append(event)

    dropped = len(events) - len(kept)
    if dropped:
        LOG.debug("hid %d event(s) matching %s", dropped, terms)
    return kept


def _dedupe(events: list[Event]) -> list[Event]:
    """Collapse the same meeting arriving from two subscriptions.

    Keys on normalised title plus exact start/end. Deliberately conservative:
    two genuinely different events at the same minute with the same title are
    vanishingly rare, whereas the duplicate-subscription case is common enough
    that anyone will hit it the first time they add both their own and a partner's copy
    of a shared calendar.
    """
    seen: dict[tuple[str, str, str], Event] = {}
    for ev in events:
        key = (ev.title.strip().lower(), ev.start.isoformat(), ev.end.isoformat())
        if key not in seen:
            seen[key] = ev
    merged = list(seen.values())
    merged.sort(key=lambda e: (e.start, e.title.lower()))
    return merged


def _record(source_id: int, *, ok: bool, error: str) -> None:
    if ok:
        db.execute(
            "UPDATE sources SET last_ok = datetime('now'), last_error = '' WHERE id = ?",
            (source_id,),
        )
    else:
        db.execute(
            "UPDATE sources SET last_error = ? WHERE id = ?", (error[:500], source_id)
        )
