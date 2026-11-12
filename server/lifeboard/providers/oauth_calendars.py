"""Google Calendar and Microsoft Graph calendars.

Both APIs expand recurrence **server-side** — Google with `singleEvents=true`,
Graph with `calendarView` — which is a genuine advantage over an `.ics`
subscription, where LifeBoard has to expand RRULE/EXDATE itself. Whatever
Google thinks an event's instances are is by definition what your phone shows,
so agreement is free.

Both are normalised to the same `Event` as every other calendar source, so the
calendar widget cannot tell them apart.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

import httpx

from .base import CACHE, Event, FetchResult, utc
from . import oauth

log = logging.getLogger("lifeboard.oauth_cal")

GOOGLE_API = "https://www.googleapis.com/calendar/v3"
GRAPH_API = "https://graph.microsoft.com/v1.0"


def _uid(source_id: int, raw: str, start: datetime) -> str:
    return hashlib.sha1(f"{source_id}|{raw}|{start.isoformat()}".encode()).hexdigest()[:20]


# --------------------------------------------------------------------------
#  Google
# --------------------------------------------------------------------------

def google_calendars(token: str, timeout: float = 30.0) -> list[dict]:
    """The account's calendars, for the picker in the admin UI."""
    with httpx.Client(timeout=timeout, headers={"Authorization": f"Bearer {token}"}) as client:
        resp = client.get(f"{GOOGLE_API}/users/me/calendarList", params={"maxResults": 250})
        resp.raise_for_status()
        items = resp.json().get("items", [])
    return [
        {
            "id": item["id"],
            "name": item.get("summary", item["id"]),
            "primary": bool(item.get("primary")),
            "colour": item.get("backgroundColor", "#5b9dd9"),
            "access": item.get("accessRole", ""),
        }
        for item in items
        if not item.get("deleted")
    ]


def google_events(
    token: str, calendar_ids: list[str],
    window_start: datetime, window_end: datetime,
    *, source_id: int, source_name: str, colour: str, timeout: float = 30.0,
) -> list[Event]:
    events: list[Event] = []
    headers = {"Authorization": f"Bearer {token}"}

    with httpx.Client(timeout=timeout, headers=headers) as client:
        for calendar_id in calendar_ids or ["primary"]:
            page_token = None
            # Paginate properly: a busy shared calendar can easily exceed one
            # page, and silently showing the first 250 events of a year is the
            # kind of bug nobody notices until something important is missing.
            while True:
                params = {
                    "timeMin": window_start.isoformat().replace("+00:00", "Z"),
                    "timeMax": window_end.isoformat().replace("+00:00", "Z"),
                    "singleEvents": "true",     # expand recurrence server-side
                    "orderBy": "startTime",
                    "maxResults": 250,
                    "showDeleted": "false",
                }
                if page_token:
                    params["pageToken"] = page_token
                resp = client.get(
                    f"{GOOGLE_API}/calendars/{_quote(calendar_id)}/events",
                    params=params,
                )
                resp.raise_for_status()
                body = resp.json()

                for item in body.get("items", []):
                    if item.get("status") == "cancelled":
                        continue
                    start_raw = item.get("start", {})
                    end_raw = item.get("end", {})
                    all_day = "date" in start_raw

                    start = _parse(start_raw.get("dateTime") or start_raw.get("date"))
                    end = _parse(end_raw.get("dateTime") or end_raw.get("date")) or start
                    if start is None:
                        continue

                    events.append(Event(
                        uid=_uid(source_id, item.get("id", ""), start),
                        title=item.get("summary") or "(no title)",
                        start=start,
                        end=end,
                        all_day=all_day,
                        location=item.get("location", "") or "",
                        description=(item.get("description") or "")[:500],
                        source_id=source_id,
                        source_name=source_name,
                        colour=colour,
                        recurring=bool(item.get("recurringEventId")),
                    ))

                page_token = body.get("nextPageToken")
                if not page_token:
                    break
    return events


def _quote(value: str) -> str:
    from urllib.parse import quote
    # Calendar ids are email addresses; the '@' and any '#' must be escaped or
    # the path is truncated at the fragment.
    return quote(value, safe="")


# --------------------------------------------------------------------------
#  Microsoft Graph
# --------------------------------------------------------------------------

def graph_calendars(token: str, timeout: float = 30.0) -> list[dict]:
    with httpx.Client(timeout=timeout, headers={"Authorization": f"Bearer {token}"}) as client:
        resp = client.get(f"{GRAPH_API}/me/calendars", params={"$top": 100})
        resp.raise_for_status()
        items = resp.json().get("value", [])
    return [
        {
            "id": item["id"],
            "name": item.get("name", item["id"]),
            "primary": bool(item.get("isDefaultCalendar")),
            "colour": _graph_colour(item.get("color", "auto")),
            "access": "owner" if item.get("canEdit") else "reader",
        }
        for item in items
    ]


GRAPH_COLOURS = {
    "lightBlue": "#5b9dd9", "lightGreen": "#7fb069", "lightOrange": "#d9a06b",
    "lightGray": "#9aa0a8", "lightYellow": "#d9d06b", "lightTeal": "#6bd9c9",
    "lightPink": "#d98bb0", "lightBrown": "#a5825e", "lightRed": "#d98b8b",
    "auto": "#5b9dd9",
}


def _graph_colour(name: str) -> str:
    return GRAPH_COLOURS.get(name, "#5b9dd9")


def graph_events(
    token: str, calendar_ids: list[str],
    window_start: datetime, window_end: datetime,
    *, source_id: int, source_name: str, colour: str, timeout: float = 30.0,
) -> list[Event]:
    events: list[Event] = []
    headers = {
        "Authorization": f"Bearer {token}",
        # Ask Graph to return times in UTC rather than the mailbox's timezone,
        # so the normalisation below is unambiguous.
        "Prefer": 'outlook.timezone="UTC"',
    }

    with httpx.Client(timeout=timeout, headers=headers) as client:
        for calendar_id in calendar_ids or [""]:
            base = (
                f"{GRAPH_API}/me/calendars/{calendar_id}/calendarView"
                if calendar_id else f"{GRAPH_API}/me/calendarView"
            )
            url = base
            params = {
                "startDateTime": window_start.isoformat().replace("+00:00", "Z"),
                "endDateTime": window_end.isoformat().replace("+00:00", "Z"),
                "$top": 200,
                "$orderby": "start/dateTime",
            }
            while url:
                resp = client.get(url, params=params if url == base else None)
                resp.raise_for_status()
                body = resp.json()

                for item in body.get("value", []):
                    start = _parse(((item.get("start") or {}).get("dateTime")))
                    end = _parse(((item.get("end") or {}).get("dateTime"))) or start
                    if start is None:
                        continue
                    events.append(Event(
                        uid=_uid(source_id, item.get("id", ""), start),
                        title=item.get("subject") or "(no title)",
                        start=start,
                        end=end,
                        all_day=bool(item.get("isAllDay")),
                        location=((item.get("location") or {}).get("displayName") or ""),
                        description=((item.get("bodyPreview") or ""))[:500],
                        source_id=source_id,
                        source_name=source_name,
                        colour=colour,
                        recurring=item.get("type") in ("occurrence", "exception"),
                    ))

                url = body.get("@odata.nextLink")
    return events


# --------------------------------------------------------------------------
#  The common entry point
# --------------------------------------------------------------------------

def fetch(
    kind: str, config: dict, tokens: dict,
    window_start: datetime, window_end: datetime,
    *, source_id: int, source_name: str, colour: str, ttl: float = 600.0,
) -> tuple[FetchResult, dict | None]:
    """Returns (result, tokens_to_persist).

    Tokens come back separately because a refresh produces a new access token
    that the caller must save; doing the write in here would mean this module
    needed the database.
    """
    provider = oauth.PROVIDERS.get(kind)
    if not provider:
        return FetchResult(error=f"unknown provider {kind!r}"), None

    cache_key = ("oauthcal", source_id, window_start.date(), window_end.date())
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached, None

    updated: dict | None = None
    try:
        token, updated = oauth.valid_access_token(provider, config, tokens)
    except oauth.ReauthNeeded as exc:
        # Distinct from a network failure: no amount of retrying fixes it, and
        # the admin UI shows a Reconnect button for exactly this state.
        return FetchResult(error=f"reconnect needed: {exc}"), None

    calendar_ids = config.get("calendar_ids") or []
    try:
        if kind == "google":
            events = google_events(
                token, calendar_ids, window_start, window_end,
                source_id=source_id, source_name=source_name, colour=colour,
            )
        else:
            events = graph_events(
                token, calendar_ids, window_start, window_end,
                source_id=source_id, source_name=source_name, colour=colour,
            )
        events.sort(key=lambda e: (e.start, e.title))
        result = FetchResult(events=events)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in (401, 403):
            result = FetchResult(error="reconnect needed: the account rejected the token")
        else:
            result = FetchResult(error=f"HTTP {exc.response.status_code} from {kind}")
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")

    return CACHE.put(cache_key, result), updated


def _parse(value: str | None) -> datetime | None:
    """Parse Google/Graph timestamps, both of which vary in shape."""
    if not value:
        return None
    text = value.strip()
    try:
        if len(text) == 10:                     # a bare date: an all-day event
            return datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        # Graph returns microseconds with no offset; Google returns an offset.
        text = text.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        return utc(parsed)
    except ValueError:
        log.warning("could not parse timestamp %r", value)
        return None
