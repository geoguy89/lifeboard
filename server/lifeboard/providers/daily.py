"""Daily content: a quote, a verse, a word, a joke, a compliment, a date fact.

The point of these on a wall display is that they change on their own and need
no configuration - the family DAKboard calls "Good to Know". Every source here
is a free public API with **no key and no account**, which is the whole reason
this set was picked over the dozens of others that need an OAuth app.

Three rules the whole module follows:

* **A cache miss must never blank the board.** These are decorations. If a
  source is down, the widget keeps yesterday's line rather than showing an
  error where a quote used to be, so the TTLs are long and failures fall back
  to the last good answer (see base.TTLCache).

* **One fetch per kind per day.** They are "of the day" - polling them every
  fifteen minutes is pure waste and, for the smaller endpoints, rude.

* **Everything is normalised to {text, attribution, extra}.** The widget draws
  one shape regardless of which source produced it, so adding a source later
  is a dict entry rather than a new widget.
"""

from __future__ import annotations

import html
import random
import re
from datetime import date, datetime, timezone

import httpx

from .base import CACHE, FetchResult

USER_AGENT = "LifeBoard/0.1 (+local dashboard)"

# A day. These change once a day; anything shorter is just noise on the
# upstream service.
TTL = 6 * 3600.0
TIMEOUT = 12.0

_TAGS = re.compile(r"<[^>]+>")


def _clean(text: str, limit: int = 600) -> str:
    text = _TAGS.sub(" ", str(text or ""))
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()[:limit]


def _get(url: str, *, headers: dict | None = None, params: dict | None = None):
    head = {"User-Agent": USER_AGENT}
    if headers:
        head.update(headers)
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as client:
        resp = client.get(url, headers=head, params=params)
        resp.raise_for_status()
        return resp


# --------------------------------------------------------------------------
#  Sources. Each returns {text, attribution, extra} or raises.
# --------------------------------------------------------------------------

def _quote() -> dict:
    data = _get("https://zenquotes.io/api/today").json()
    first = (data or [{}])[0]
    return {
        "text": _clean(first.get("q", "")),
        "attribution": _clean(first.get("a", ""), 80),
        "extra": "",
    }


def _bible_verse(translation: str = "") -> dict:
    """ourmanna's verse of the day. `translation` is accepted but the free
    endpoint ignores it - kept so the setting means something if they add it,
    rather than silently dropping what the user chose."""
    data = _get(
        "https://beta.ourmanna.com/api/v1/get",
        params={"format": "json", "order": "daily"},
    ).json()
    details = ((data or {}).get("verse") or {}).get("details") or {}
    return {
        "text": _clean(details.get("text", "")),
        "attribution": _clean(details.get("reference", ""), 80),
        "extra": _clean(details.get("version", ""), 40) or translation,
    }


def _dad_joke() -> dict:
    # This one REQUIRES an Accept header; without it you get an HTML page and
    # a very confusing parse error.
    data = _get("https://icanhazdadjoke.com/",
                headers={"Accept": "application/json"}).json()
    return {"text": _clean(data.get("joke", "")), "attribution": "", "extra": ""}


def _advice() -> dict:
    """Advice Slip. Replaces the compliments source: complimentr.com stopped
    resolving entirely (ConnectError, not a 5xx), so it was shipping a widget
    that could never work."""
    data = _get("https://api.adviceslip.com/advice").json()
    return {
        "text": _clean((data.get("slip") or {}).get("advice", "")),
        "attribution": "",
        "extra": "",
    }


# Word of the day, with its definition SHIPPED rather than fetched.
#
# Merriam-Webster (what DAKboard uses) needs a key. dictionaryapi.dev needs
# none but times out often enough that the block would regularly show a word
# with no definition, which is worse than useless. Since the word list is
# curated anyway, the definitions may as well be too - and then the block
# works with the internet down, which is the right behaviour for an appliance.
WORDS = [
    ("serendipity", "noun", "Finding something good without looking for it."),
    ("ephemeral", "adjective", "Lasting for a very short time."),
    ("luminous", "adjective", "Giving off light; bright enough to shine."),
    ("quixotic", "adjective", "Wildly idealistic, and not at all practical."),
    ("halcyon", "adjective", "Calm and peaceful; a golden, happier past."),
    ("petrichor", "noun", "The smell of the earth after rain."),
    ("alacrity", "noun", "Brisk and cheerful readiness to do something."),
    ("ineffable", "adjective", "Too great or beautiful to be put into words."),
    ("mellifluous", "adjective", "Sweet and smooth to listen to."),
    ("vestige", "noun", "A small trace of something that is now gone."),
    ("eloquent", "adjective", "Fluent and persuasive in speech or writing."),
    ("resilient", "adjective", "Able to recover quickly from difficulty."),
    ("gossamer", "noun", "Something delicate, light and flimsy."),
    ("solitude", "noun", "The state of being alone, often by choice."),
    ("cascade", "noun", "A small waterfall, or anything falling in stages."),
    ("kindle", "verb", "To light a fire, or to stir up a feeling."),
    ("meander", "verb", "To wander slowly without any direct course."),
    ("reverie", "noun", "A pleasant daydream you lose yourself in."),
    ("tranquil", "adjective", "Free from disturbance; calm and quiet."),
    ("verdant", "adjective", "Green with growing plants; lush."),
    ("whimsy", "noun", "Playfully odd or fanciful behaviour."),
    ("zenith", "noun", "The highest point; the peak of something."),
    ("beguile", "verb", "To charm, sometimes in a slightly deceptive way."),
    ("cadence", "noun", "The rhythm and flow of a sequence of sounds."),
    ("dappled", "adjective", "Marked with spots or patches of light."),
    ("elysian", "adjective", "Beautiful or creative; divinely inspired."),
    ("fortitude", "noun", "Courage in the face of pain or adversity."),
    ("nascent", "adjective", "Just coming into being, and not yet developed."),
    ("sonorous", "adjective", "Deep, full and reverberating in sound."),
    ("ubiquitous", "adjective", "Present everywhere at once."),
]


def _word_of_day() -> dict:
    """Picked by the DATE, so it is genuinely word-of-the-day rather than
    word-of-the-refresh."""
    word, part, definition = WORDS[date.today().toordinal() % len(WORDS)]
    return {"text": word, "attribution": definition, "extra": part}


def _on_this_day() -> dict:
    """A historical event for today's date. byabbe.se is a thin, free wrapper
    over Wikipedia's on-this-day data - no key, no rate limit worth worrying
    about at one call a day."""
    today = date.today()
    data = _get(
        f"https://byabbe.se/on-this-day/{today.month}/{today.day}/events.json"
    ).json()
    events = data.get("events") or []
    if not events:
        raise ValueError("no events for today")
    # Seeded by the date so it is stable for the whole day rather than
    # shuffling on every cache expiry.
    pick = random.Random(today.toordinal()).choice(events)
    return {
        "text": _clean(pick.get("description", "")),
        "attribution": str(pick.get("year", "")),
        # %-d is a glibc extension and raises on Windows, where the tests
        # run. Build it by hand instead.
        "extra": f"{today.strftime('%B')} {today.day}",
    }


SOURCES = {
    "quote": _quote,
    "bible_verse": _bible_verse,
    "dad_joke": _dad_joke,
    "advice": _advice,
    "word": _word_of_day,
    "on_this_day": _on_this_day,
}


def fetch(kind: str, *, ttl: float = TTL) -> FetchResult:
    make = SOURCES.get(kind)
    if not make:
        return FetchResult(error=f"unknown daily source: {kind}")

    cache_key = ("daily", kind, date.today().isoformat())
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        payload = make()
        if not payload.get("text"):
            raise ValueError("source returned nothing")
        payload["kind"] = kind
        payload["fetched"] = datetime.now(timezone.utc).isoformat()
        result = FetchResult(payload=payload)
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")

    # put() serves the previous good answer on a failure, which is exactly
    # what a decoration should do - see providers/base.py.
    return CACHE.put(cache_key, result)
