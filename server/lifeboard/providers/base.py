"""The shared event model, and the fetch/cache contract every provider follows.

The whole point of this file is that a Google event, an Outlook event and a
line out of a random .ics URL become *the same shape* before anything else in
the system sees them. The calendar widget then merges and sorts them without
knowing or caring where any of them came from - which is exactly the thing
DAKboard does well and the thing that gets ugly if each source keeps its own
representation.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict, replace
from datetime import date, datetime, timedelta, timezone
from typing import Any, Protocol


@dataclass
class Event:
    """One calendar entry, normalised.

    `start`/`end` are always timezone-aware UTC datetimes. All-day events are
    the awkward case: they arrive as naive dates and must NOT be shifted by a
    timezone conversion, or a birthday on the 3rd starts showing on the 2nd in
    a western timezone. So we keep the flag and let the renderer format from
    `start_local_date` rather than converting.
    """

    uid: str
    title: str
    start: datetime
    end: datetime
    all_day: bool = False
    location: str = ""
    description: str = ""
    source_id: int = 0
    source_name: str = ""
    colour: str = "#5b9dd9"
    # Preserved so a widget can show "3 of 12" style recurrence hints later.
    recurring: bool = False

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d["start"] = self.start.isoformat()
        d["end"] = self.end.isoformat()
        return d


@dataclass
class FetchResult:
    """What every provider returns.

    `events` is for calendar-shaped sources; `payload` is the escape hatch for
    sources that are not events at all (weather, RSS). One result type keeps
    the caching and error handling identical for every provider instead of
    each one inventing its own failure convention.
    """

    events: list[Event] = field(default_factory=list)
    payload: Any = None
    error: str = ""
    fetched_at: float = field(default_factory=time.time)
    # Set when this is a GOOD answer being served while the source is failing:
    # the data is real, the source is not reachable right now. Without it a
    # caller cannot tell "fetched fine" from "serving the last good copy", and
    # an outage would be invisible everywhere - which is the whole risk of
    # falling back to cached data in the first place.
    degraded: str = ""

    @property
    def ok(self) -> bool:
        return not self.error


class CalendarProvider(Protocol):
    """Every calendar source implements exactly this."""

    def fetch(self, window_start: datetime, window_end: datetime) -> FetchResult:
        ...


def utc(dt: datetime | date) -> datetime:
    """Coerce anything ical/Google/Graph hands us into aware UTC.

    A naive datetime is treated as UTC rather than local. That is the correct
    reading for Graph (which returns UTC unless asked otherwise) and harmless
    for ical, where naive datetimes are rare and floating by definition.
    """
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    # A bare date: midnight UTC, flagged all-day by the caller.
    return datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc)


def default_window(days_back: int = 1, days_forward: int = 60) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    return now - timedelta(days=days_back), now + timedelta(days=days_forward)


# How long a good answer keeps being served after its source starts failing.
# Long enough to ride out a DNS blip, a router blocklist reload or an upstream
# hiccup without the board ever showing it; short enough that a source which is
# genuinely dead says so instead of displaying yesterday as though it were now.
FAILURE_GRACE_SECONDS = 3 * 3600.0

# How long a failure suppresses a retry. Short, because its only job is to
# stop every widget on the board dialling the same dead host in one tick -
# NOT to decide how long the board stays broken. Caching a failure for the
# source's full refresh interval is what turned a one-second blip into a
# fifteen-minute error on the wall.
FAILURE_RETRY_SECONDS = 60.0


class TTLCache:
    """Tiny per-source cache.

    Sources are polled on their own `refresh_seconds`, but several widgets may
    ask for the same source within one render tick. Without this, a board with
    a month view, a week view and an agenda would triple every HTTP call.
    """

    def __init__(self) -> None:
        # Successes only. Keeping failures out of here is what lets a source
        # keep serving its last good answer while it is down.
        self._data: dict[Any, tuple[float, FetchResult]] = {}
        self._failed: dict[Any, tuple[float, FetchResult]] = {}

    def get(self, key: Any, ttl: float) -> FetchResult | None:
        """The answer to serve, or None meaning "go fetch"."""
        now = time.time()

        # A very recent failure means the source is down right now. Don't
        # re-dial it for every widget - serve the last good answer if there is
        # one still inside the grace window, otherwise the error itself.
        failed = self._failed.get(key)
        if failed and now - failed[0] <= FAILURE_RETRY_SECONDS:
            good = self._data.get(key)
            if good and now - good[1].fetched_at <= FAILURE_GRACE_SECONDS:
                return replace(good[1], degraded=failed[1].error)
            return failed[1]

        hit = self._data.get(key)
        if not hit:
            return None
        stamped, result = hit
        if now - stamped > ttl:
            return None
        return result

    def get_stale(self, key: Any) -> tuple[FetchResult | None, float]:
        """The cached value regardless of age, with its age in seconds.

        For work too slow to do while something waits. A calendar parse can
        take twenty seconds on a Pi 3 - and doing that inside a request means
        the board blanks every time the cache expires. Serving the old answer
        and refreshing behind it is the difference between a display that
        works and one that flickers empty on a timer.
        """
        hit = self._data.get(key)
        if not hit:
            return None, 0.0
        _stamped, result = hit
        return result, time.time() - result.fetched_at

    def put(self, key: Any, result: FetchResult) -> FetchResult:
        """Store a result and return the one the caller should actually serve.

        A FAILURE MUST NOT EVICT A GOOD ANSWER. Every provider ends with this
        call, and storing the error meant one refused connection replaced a
        perfectly good forecast with an exception string that then sat on the
        wall for the whole refresh interval - long after the network came
        back. A wall display is better off showing weather an hour old than a
        red `ConnectTimeout`, so a failure re-stamps the previous good answer
        instead and hands it back.

        The grace window is measured from the good answer's own `fetched_at`,
        not from the retry, so repeated failures cannot walk stale data
        forward forever. Past the window the error is the honest thing to
        show: yesterday's forecast is not weather, it is a lie in a nice font.
        """
        if result.ok:
            self._data[key] = (time.time(), result)
            self._failed.pop(key, None)
            return result

        self._failed[key] = (time.time(), result)
        good = self._data.get(key)
        if good and time.time() - good[1].fetched_at <= FAILURE_GRACE_SECONDS:
            # Re-stamp so the good answer outlives its own refresh window
            # while the source is down. Its `fetched_at` is untouched, so the
            # grace window measures real data age, not how often we retried.
            self._data[key] = (time.time(), good[1])
            return replace(good[1], degraded=result.error)
        return result

    def drop(self, key: Any) -> None:
        self._data.pop(key, None)
        self._failed.pop(key, None)

    def drop_prefix(self, prefix: tuple) -> int:
        """Forget every entry whose key starts with `prefix`.

        Writing through the board invalidates more than one key: a task list is
        cached separately for `show_completed` true and false, and a Kanban
        board caches per column as well. Dropping only the key the caller
        happens to know leaves the others to serve the pre-tap state for the
        rest of their TTL - and the person who just touched the screen is
        looking straight at it.
        """
        n = 0
        for store in (self._data, self._failed):
            # The key list is taken before anything is removed. This class is
            # lock-free like the rest of it - dict get/pop are atomic under the
            # GIL - but iterating one while deleting from it is not, and a
            # board serves several widgets from several threads.
            for key in [k for k in list(store)
                        if isinstance(k, tuple) and k[:len(prefix)] == prefix]:
                store.pop(key, None)
                n += 1
        return n


CACHE = TTLCache()
