"""iCal / .ics subscription source.

This is the workhorse. Google, Outlook/M365, Apple, Nextcloud, Proton and most
booking systems will all hand you a secret .ics URL, and that path needs no
OAuth app, no consent screen and no token refresh - so it is the recommended
way to add a calendar and the only one that works fully offline-configured.

The hard part of ics is recurrence. RRULE with EXDATE, RECURRENCE-ID overrides
and DST-crossing rules are genuinely difficult, so this leans on
`recurring-ical-events` rather than expanding rules by hand.
"""

from __future__ import annotations

import hashlib
import re
import urllib.parse
from datetime import datetime

import httpx

from .base import CACHE, Event, FetchResult, utc

USER_AGENT = "LifeBoard/0.1 (+local dashboard)"


def _uid_for(component, start: datetime, url: str) -> str:
    """Stable id for de-duplication.

    Two sources can legitimately carry the same event (a shared work calendar
    subscribed by two people). The uid alone is not unique across sources, and
    a recurring event repeats its uid for every instance - so the key is
    (source url, uid, instance start).
    """
    raw = f"{url}|{component.get('UID', '')}|{start.isoformat()}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


# --------------------------------------------------------------------------
# URL normalisation
#
# The address a calendar app shows you is rarely the address a feed lives at.
# Every one of these is a link somebody will reasonably paste, and all but the
# last can be turned into the feed without asking them anything.
# --------------------------------------------------------------------------

_GOOGLE_EMBED = re.compile(
    r"^https?://calendar\.google\.com/calendar/(?:embed|u/\d+/embed)\?(?P<query>.*)$",
    re.IGNORECASE,
)
_GOOGLE_HTM = re.compile(
    r"^https?://calendar\.google\.com/calendar/ical/(?P<rest>.+)/basic\.html$",
    re.IGNORECASE,
)


def normalise_url(url: str) -> str:
    """Turn a calendar link into the .ics feed it corresponds to.

    Unrecognised URLs are returned untouched: guessing at an address nobody
    asked for would turn a clear 404 into a confusing one.
    """
    url = (url or "").strip()
    if not url:
        return url

    # webcal:// is http(s) wearing a different sticker, and it is what Apple
    # and most "subscribe" buttons hand out.
    if url.lower().startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]

    # Google's embed page -> the public iCal feed for the same calendar.
    match = _GOOGLE_EMBED.match(url)
    if match:
        params = urllib.parse.parse_qs(match.group("query"))
        src = (params.get("src") or [""])[0].strip()
        if src:
            quoted = urllib.parse.quote(src, safe="")
            return (f"https://calendar.google.com/calendar/ical/{quoted}"
                    "/public/basic.ics")

    # Google sometimes offers the HTML twin of the feed address.
    match = _GOOGLE_HTM.match(url)
    if match:
        return (f"https://calendar.google.com/calendar/ical/"
                f"{match.group('rest')}/basic.ics")

    # Outlook publishes both; the .html one is for reading in a browser.
    if url.lower().endswith("/calendar.html") and "outlook.office" in url.lower():
        return url[: -len("calendar.html")] + "calendar.ics"

    return url


def explain_failure(url: str, exc: Exception) -> str:
    """Say what to do, not just what went wrong.

    A 401 or 404 on a calendar feed is almost never an authorisation problem
    worth debugging - it means the calendar is private and the link is the
    public one, and the fix is a specific button in a specific settings page.
    """
    status = getattr(getattr(exc, "response", None), "status_code", None)
    lowered = (url or "").lower()

    if status in (401, 403, 404):
        if "calendar.google.com" in lowered:
            return (
                f"Google refused that link ({status}). That calendar is not "
                "public, so its public feed does not exist. Use the private "
                "address instead: Google Calendar > Settings > pick the "
                "calendar > 'Integrate calendar' > copy 'Secret address in "
                "iCal format' (it ends in .ics and contains a long random "
                "string). Anyone with that link can read the calendar, so "
                "treat it as a password."
            )
        if "outlook.office" in lowered or "outlook.live" in lowered:
            return (
                f"Outlook refused that link ({status}). In Outlook go to "
                "Settings > Calendar > Shared calendars, publish the calendar, "
                "and copy the ICS link rather than the HTML one."
            )
        return (
            f"The server refused that link ({status}). Most calendar apps "
            "offer both a web page and an .ics feed - this needs the .ics one, "
            "and the calendar has to be published or shared by link."
        )

    return f"{type(exc).__name__}: {exc}"


def fetch(
    url: str,
    window_start: datetime,
    window_end: datetime,
    *,
    source_id: int = 0,
    source_name: str = "",
    colour: str = "#5b9dd9",
    ttl: float = 900.0,
    timeout: float = 20.0,
    refresh_in_background=None,
) -> FetchResult:
    cache_key = ("ical", url, window_start.date(), window_end.date())
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    # Fresh cache missed. Before doing the slow thing, see whether there is an
    # older answer worth serving while the new one is computed.
    #
    # On a Pi 3 this parse takes about twenty seconds for a megabyte of iCal -
    # the fetch is a second, the recurring-event expansion is the rest. Doing
    # that inside the request meant the calendars blanked every time the cache
    # expired, because the widget gave up long before the answer arrived.
    #
    # `refresh` is set by the caller when it is willing to take a stale answer.
    stale, age = CACHE.get_stale(cache_key)
    if stale is not None and refresh_in_background is not None and age < STALE_LIMIT:
        refresh_in_background(cache_key, lambda: _fetch_now(
            url, window_start, window_end, cache_key,
            source_id=source_id, source_name=source_name,
            colour=colour, timeout=timeout,
        ))
        return stale

    return _fetch_now(
        url, window_start, window_end, cache_key,
        source_id=source_id, source_name=source_name,
        colour=colour, timeout=timeout,
    )


# How old a cached calendar may be before it is no longer worth showing. A
# board displaying yesterday's events is worse than one that pauses to reload;
# a board showing events from a minute ago is better than one showing none.
STALE_LIMIT = 6 * 60 * 60


def _fetch_now(
    url: str,
    window_start: datetime,
    window_end: datetime,
    cache_key,
    *,
    source_id: int = 0,
    source_name: str = "",
    colour: str = "#5b9dd9",
    timeout: float = 20.0,
) -> FetchResult:
    """Do the actual work. Slow by nature - see fetch()."""

    # Accept the link people actually have - an embed page, a webcal://
    # subscribe link, an .html twin - and fetch the feed it points at.
    # Normalised BEFORE the try, so the error handler can always name the URL
    # that was actually requested rather than the one that was typed.
    fetch_url = normalise_url(url)

    try:
        with httpx.Client(
            timeout=timeout, follow_redirects=True, headers={"User-Agent": USER_AGENT}
        ) as client:
            resp = client.get(fetch_url)
            resp.raise_for_status()
            raw = resp.content

        events = _parse(raw, url, window_start, window_end, source_id, source_name, colour)
        result = FetchResult(events=events)
    except Exception as exc:  # noqa: BLE001 - a bad feed must never take the board down
        result = FetchResult(error=explain_failure(fetch_url, exc))

    result = CACHE.put(cache_key, result)
    return result


def _parse(
    raw: bytes,
    url: str,
    window_start: datetime,
    window_end: datetime,
    source_id: int,
    source_name: str,
    colour: str,
) -> list[Event]:
    # Imported lazily so the module can be imported (and unit-tested) on a box
    # where the optional calendar deps are not installed yet.
    import icalendar
    import recurring_ical_events

    cal = icalendar.Calendar.from_ical(raw)

    # This expands RRULE, honours EXDATE, and applies RECURRENCE-ID overrides.
    # Doing it by hand with dateutil.rrule gets the common cases right and the
    # DST and override cases wrong, which shows up as an event drifting an hour
    # twice a year - the kind of bug nobody reports but everybody notices.
    occurrences = recurring_ical_events.of(cal).between(window_start, window_end)

    events: list[Event] = []
    for comp in occurrences:
        dtstart = comp.get("DTSTART")
        if dtstart is None:
            continue
        raw_start = dtstart.dt
        all_day = not isinstance(raw_start, datetime)

        dtend = comp.get("DTEND")
        raw_end = dtend.dt if dtend is not None else raw_start

        start = utc(raw_start)
        end = utc(raw_end)
        if end < start:
            end = start

        events.append(
            Event(
                uid=_uid_for(comp, start, url),
                title=str(comp.get("SUMMARY", "(no title)")),
                start=start,
                end=end,
                all_day=all_day,
                location=str(comp.get("LOCATION", "") or ""),
                description=str(comp.get("DESCRIPTION", "") or ""),
                source_id=source_id,
                source_name=source_name,
                colour=colour,
                recurring=comp.get("RRULE") is not None,
            )
        )

    events.sort(key=lambda e: (e.start, e.title))
    return events
