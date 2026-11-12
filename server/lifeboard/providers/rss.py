"""RSS / Atom source.

feedparser handles the genuinely alarming variety of malformed feeds in the
wild, including ones that would make a strict XML parser give up. It never
raises on bad input - it sets `bozo` and returns what it could salvage, which
is the right behaviour for a wall display: show the three headlines you got
rather than a stack trace.
"""

from __future__ import annotations

import html
import re
import socket
import ssl
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx

from .base import CACHE, FetchResult

USER_AGENT = "LifeBoard/0.1 (+local dashboard)"

# A browser's, for feeds behind a CDN that treats anything else as a robot.
# Offered as a per-source choice rather than made the default: identifying
# yourself honestly is the right behaviour, and quietly pretending to be
# Chrome everywhere would be a strange default for a thing on a wall.
BROWSER_AGENT = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                 "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

_TAGS = re.compile(r"<[^>]+>")


def diagnose(url: str, timeout: float = 6.0) -> str:
    """Where in the conversation did it fail?

    "The read operation timed out" is the least useful true thing a fetch can
    say. It covers a name that will not resolve, a port nothing is listening
    on, a TLS handshake that stalls, and a server that accepts everything you
    send and then simply never answers - four completely different problems
    with four completely different owners, and no way to tell them apart from
    the message.

    This walks the same steps by hand and times each one, so the error can say
    which of the four it was. It runs ONLY after a failure, so the normal path
    pays nothing for it.

    Getting as far as TLS and then stalling is the interesting answer: it means
    the network reached the far end and something chose not to reply, which is
    what a filter or a bot-defence tarpit looks like from the inside - and it
    is not something the board can fix.
    """
    parts = urlsplit(url)
    host = parts.hostname
    if not host:
        return ""
    secure = parts.scheme != "http"
    port = parts.port or (443 if secure else 80)
    steps = []

    began = time.monotonic()
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        address = infos[0][4][0]
        steps.append(f"name resolved to {address} in {time.monotonic() - began:.1f}s")
    except Exception as exc:  # noqa: BLE001
        return f"name lookup for {host} failed: {exc}"

    began = time.monotonic()
    try:
        sock = socket.create_connection((address, port), timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        steps.append(f"could not open port {port}: {exc}")
        return "; ".join(steps)
    steps.append(f"port {port} accepted in {time.monotonic() - began:.1f}s")

    if not secure:
        sock.close()
        return "; ".join(steps)

    began = time.monotonic()
    try:
        context = ssl.create_default_context()
        with context.wrap_socket(sock, server_hostname=host) as tls:
            steps.append(f"TLS agreed in {time.monotonic() - began:.1f}s "
                         f"({tls.version()})")
    except Exception as exc:  # noqa: BLE001
        steps.append(f"TLS refused after {time.monotonic() - began:.1f}s: {exc}")
        try:
            sock.close()
        except Exception:  # noqa: BLE001
            pass
        return "; ".join(steps)

    # Careful with this sentence: reaching TLS proves the TRANSPORT works, not
    # what the far end intends. Since this only runs after a read timed out,
    # the pair together do narrow it down - the connection was made and the
    # reply never came - and that is worth saying without overclaiming.
    steps.append("name, port and TLS all succeeded, so the network reaches it "
                 "and the stall is in the reply - typically a filter or a bot "
                 "defence in between, which the board cannot do anything about")
    return "; ".join(steps)


def _clean(text: str, limit: int = 400) -> str:
    """Strip markup and entities out of a summary so it can be laid out."""
    text = _TAGS.sub(" ", text or "")
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def fetch(
    url: str,
    *,
    limit: int = 10,
    ttl: float = 900.0,
    timeout: float = 20.0,
    agent: str = "",
) -> FetchResult:
    # ANSWER FOR THE URL BEFORE HANDING IT TO httpx.
    #
    # httpx's complaint about a missing protocol is accurate and useless: it
    # names no source, so an EMPTY field reads as "the address you entered is
    # wrong" even when the field was never filled in - and the reader goes off
    # adding https:// to a perfectly good feed that was never the thing being
    # fetched. Both answers below name what actually happened.
    #
    # Normalising before the cache lookup also keeps one feed from occupying
    # two cache entries depending on how it was typed.
    url = (url or "").strip()
    if not url:
        return FetchResult(
            error="no feed URL on this source - add one on the Sources page.")
    if "://" not in url:
        # Somebody pasted a bare host. Assume the web's default rather than
        # refusing over a prefix this code can supply just as well.
        url = "https://" + url.lstrip("/")

    agent = agent or USER_AGENT
    cache_key = ("rss", url, limit, agent)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        import feedparser

        # Fetching with httpx rather than letting feedparser do it: we get a
        # real timeout, redirect handling and a sane user agent, none of which
        # feedparser's urllib path gives us reliably.
        with httpx.Client(
            timeout=timeout, follow_redirects=True, headers={
                "User-Agent": agent,
                # Sent because a bare request with no Accept is itself a signal
                # to a CDN's bot scoring, and these cost nothing.
                "Accept": "application/rss+xml, application/atom+xml, "
                          "application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
                "Accept-Language": "en-US,en;q=0.9",
            }
        ) as client:
            resp = client.get(url)
            resp.raise_for_status()
            raw = resp.content

        # A real feed is tens of kilobytes; a homepage masquerading as one runs
        # to hundreds. Reading all of that over a TV's wifi is what turns "this
        # is not a feed" into "the read operation timed out", which points at
        # entirely the wrong thing.
        if len(raw) > 4 * 1024 * 1024:
            return CACHE.put(cache_key, FetchResult(error=(
                f"{url} returned {len(raw) // 1024}KB, which is far too big to "
                "be a feed - it is almost certainly a web page.")))

        parsed = feedparser.parse(raw)

        # IS THIS EVEN A FEED?
        #
        # A site's /rss path very often returns the site itself: 200, a normal
        # content type, and a quarter of a megabyte of HTML. feedparser does
        # not object - it finds no entries and returns an empty result - so the
        # block goes blank, or the fetch times out partway through downloading
        # a page nobody wanted, and the reported error is "timed out". That
        # sends somebody off checking their network and their URL prefix when
        # the URL is simply not a feed.
        #
        # feedparser sets `version` to the flavour it recognised - 'rss20',
        # 'atom10' and so on - and leaves it empty when it recognised nothing.
        # That is the honest test, and it is worth spending an error message on.
        # getattr, not attribute access: feedparser hands back an object
        # WITHOUT a `version` at all for an empty body, so reading it directly
        # turns "the server sent nothing" into an AttributeError - a crash
        # where a sentence belonged.
        if not getattr(parsed, "version", ""):
            if not raw.strip():
                return CACHE.put(cache_key, FetchResult(error=(
                    f"{url} answered with an empty body.")))
            looks_like_html = raw[:400].lstrip()[:1] == b"<" and (
                b"<html" in raw[:1000].lower() or b"<!doctype html" in raw[:1000].lower())
            if looks_like_html:
                return CACHE.put(cache_key, FetchResult(error=(
                    f"{url} returns a web page, not a feed. Most sites publish "
                    "theirs somewhere else - look for an RSS link on the page, "
                    "or try /feed, /rss.xml or /feeds/syndication/rss.")))
            return CACHE.put(cache_key, FetchResult(error=(
                f"{url} did not return anything recognisable as RSS or Atom.")))
        items = []
        # 0 (or negative) means the whole feed. some feeds publish 40 and
        # the old default of 10 silently threw three quarters of it away.
        for entry in (parsed.entries if limit <= 0 else parsed.entries[:limit]):
            published = None
            for key in ("published_parsed", "updated_parsed"):
                tm = getattr(entry, key, None)
                if tm:
                    published = datetime(*tm[:6], tzinfo=timezone.utc).isoformat()
                    break
            items.append(
                {
                    "title": _clean(getattr(entry, "title", ""), 200),
                    "link": getattr(entry, "link", ""),
                    "summary": _clean(getattr(entry, "summary", "")),
                    "published": published,
                    "author": getattr(entry, "author", ""),
                }
            )

        payload = {
            "feed_title": _clean(getattr(parsed.feed, "title", ""), 120),
            "items": items,
        }
        # bozo means "this feed is malformed" - worth surfacing in the admin UI
        # as a warning, but not worth refusing to display salvaged entries.
        warning = ""
        if getattr(parsed, "bozo", 0) and not items:
            warning = f"feed did not parse: {getattr(parsed, 'bozo_exception', '')}"
        result = FetchResult(payload=payload, error=warning)
    except Exception as exc:  # noqa: BLE001
        message = f"{type(exc).__name__}: {exc}"
        # A timeout is the case worth investigating, and the only one where the
        # message on its own tells you nothing about whose problem it is.
        if isinstance(exc, (httpx.TimeoutException, httpx.ConnectError)):
            try:
                detail = diagnose(url)
            except Exception:  # noqa: BLE001
                detail = ""
            if detail:
                message = f"{message} - {detail}"
        result = FetchResult(error=message)

    return CACHE.put(cache_key, result)


def feed_urls(config: dict) -> list[str]:
    """Every feed URL on this source, old field and new.

    `url` held exactly one feed, so a mixed news block meant one source and
    one widget per outlet. `urls` is a whitespace- or comma-separated list;
    both are read so an existing feed keeps working and simply gains the
    ability to grow.
    """
    raw = config.get("urls") or ""
    found = [u.strip() for u in re.split(r"[\s,]+", str(raw)) if u.strip()]
    single = (config.get("url") or "").strip()
    if single:
        found.insert(0, single)

    # DEDUPE, keeping the order they were typed in.
    #
    # Pasting a list by hand repeats one easily, and a repeat is not harmless:
    # the same feed is fetched twice, its headlines appear twice in the merged
    # stream, and if it is DOWN its timeout is paid twice and its error is
    # reported twice - which is what turned one broken feed into a wall of
    # identical error text.
    out, seen = [], set()
    for url in found:
        if url in seen:
            continue
        seen.add(url)
        out.append(url)
    return out


def fetch_many(config: dict, *, ttl: float = 900.0) -> FetchResult:
    """Every feed on one source, merged newest-first.

    One dead feed must not blank the others: each is fetched independently and
    only a total wipeout is an error. Articles carry their own feed's title so
    a mixed block can say which outlet each headline came from - captioning a
    specific article with a combined name would be worse than saying nothing.
    """
    urls = feed_urls(config)
    if not urls:
        return FetchResult(error="no feed URL on this source")

    limit = int(config.get("limit", 10) or 0)
    agent = BROWSER_AGENT if config.get("browser_agent") else USER_AGENT

    # FETCHED TOGETHER, NOT ONE AFTER ANOTHER.
    #
    # Each feed waits up to twenty seconds, and a serial loop pays that PER
    # dead feed: four feeds with three unreachable is a minute of a board doing
    # nothing before it draws anything at all, on every refresh. Failure is
    # also the slow case, so the more broken a source is the worse it gets.
    #
    # A small pool bounds the wait at roughly one feed's timeout however many
    # there are. Capped because these are network waits rather than work - six
    # at once is plenty, and a source with thirty feeds should not open thirty
    # sockets at once on a Raspberry Pi.
    if len(urls) == 1:
        # Not worth a thread, and it keeps the common case easy to follow.
        results = [(urls[0], fetch(urls[0], limit=limit, ttl=ttl, agent=agent))]
    else:
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=min(6, len(urls))) as pool:
            futures = {url: pool.submit(fetch, url, limit=limit, ttl=ttl,
                                        agent=agent)
                       for url in urls}
        # Read back in the order they were configured: the merge below sorts by
        # date, but ties and undated entries keep arrival order, and "arrival"
        # should mean the order on the page rather than whichever feed happened
        # to answer first.
        results = [(url, futures[url].result()) for url in urls]

    gathered, titles, failures = [], [], []
    for url, one in results:
        if one.error and not one.payload:
            # The whole URL, not the first sixty characters. A feed path cut
            # mid-word ("/news/l") looks like a typo, and the reader then goes
            # hunting for it - a cruel thing to do inside an error message
            # about that very URL.
            shown = url if len(url) <= 200 else url[:199] + "…"
            failures.append(f"{shown}: {one.error}")
            continue
        payload = one.payload or {}
        title = payload.get("feed_title", "")
        if title:
            titles.append(title)
        for item in payload.get("items", []):
            gathered.append({**item, "feed_title": item.get("feed_title") or title})

    if not gathered and failures:
        return FetchResult(error="; ".join(failures)[:400])

    # Interleave by date so several feeds read as one stream rather than one
    # feed then the next. Undated entries keep their arrival order at the end
    # instead of sorting to 1970.
    def when(item):
        stamp = item.get("published")
        if not stamp:
            return None
        try:
            return datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        except ValueError:
            return None

    dated = [i for i in gathered if when(i) is not None]
    undated = [i for i in gathered if when(i) is None]
    dated.sort(key=when, reverse=True)

    return FetchResult(
        payload={
            "feed_title": titles[0] if len(titles) == 1 else f"{len(urls)} feeds",
            "items": dated + undated,
            "feeds": len(urls),
        },
        error="; ".join(failures)[:300] if failures else "",
    )
