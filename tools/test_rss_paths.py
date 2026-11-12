"""The Test button must exercise the same code the board does.

This exists because of a bug that cost a user an evening. The board read its
feeds through `rss.fetch_many(config)`, which understands the current `urls`
field. The Sources page's Test button called `rss.fetch(config.get("url", ""))`
- the LEGACY single-feed key. A source created by today's editor has no `url`,
so Test fetched the empty string, and httpx reported:

    UnsupportedProtocol: Request URL is missing an 'http://' or 'https://'
    protocol.

Which is a true statement about a URL the user never typed. It reads as "your
address is malformed", so they add https://, then http://, then try a different
feed, and none of it can possibly help - their URL was never the thing being
fetched. Meanwhile the board rendered that same feed perfectly.

Two things are pinned here:

  1. Both paths read the same config. Not "both work" - the same URLs, so a
     source that tests clean is a source that will render, and one that fails
     fails for a reason that is about the feed.
  2. A URL problem is described as a URL problem, by us, naming the field.

    python tools/test_rss_paths.py
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

_tmp = tempfile.mkdtemp()
os.environ.setdefault("LIFEBOARD_DB", os.path.join(_tmp, "t.db"))
os.environ.setdefault("LIFEBOARD_KEY", os.path.join(_tmp, "key"))
os.environ.setdefault("LIFEBOARD_MEDIA", os.path.join(_tmp, "media"))
os.environ.setdefault("LIFEBOARD_NETWORK", "managed")

from lifeboard.providers import rss  # noqa: E402

problems = []

# What the editor writes today, and what it used to write.
MODERN = {"urls": "https://example.com/feed.xml https://example.org/rss"}
LEGACY = {"url": "https://example.com/feed.xml"}
BOTH = {"url": "https://example.com/feed.xml", "urls": "https://example.org/rss"}

# --- 1. the config keys both paths agree on ------------------------------
for label, config, expected in [
    ("a source from today's editor", MODERN, 2),
    ("a source from the old editor", LEGACY, 1),
    ("a source carrying both fields", BOTH, 2),
]:
    urls = rss.feed_urls(config)
    if len(urls) != expected:
        problems.append(f"{label}: feed_urls found {len(urls)}, expected {expected}")
    elif not all(u.startswith("http") for u in urls):
        problems.append(f"{label}: a URL came back without a scheme: {urls}")
    else:
        print(f"  ok   {label}: {len(urls)} feed(s) found")

# The regression itself, stated plainly: the key the test path used to read is
# simply absent from a modern source, and reading it yields nothing to fetch.
if MODERN.get("url", "") != "":
    problems.append("a modern source unexpectedly has a `url` key")
else:
    print("  ok   a modern source has no `url` key — which is what broke Test")

# --- 2. an empty URL is OUR error, not httpx's ---------------------------
blank = rss.fetch("", ttl=0)
if not blank.error:
    problems.append("fetching an empty URL reported no error at all")
elif "protocol" in blank.error.lower():
    problems.append(f"an empty URL still blames the protocol: {blank.error}")
elif "no feed url" not in blank.error.lower():
    problems.append(f"an empty URL gave an unhelpful error: {blank.error}")
else:
    print("  ok   an empty URL says the field is empty, and names the page")

whitespace = rss.fetch("   ", ttl=0)
if not whitespace.error or "no feed url" not in whitespace.error.lower():
    problems.append(f"a whitespace URL gave: {whitespace.error}")
else:
    print("  ok   a whitespace-only URL is treated as empty")

# --- 3. a bare host is completed rather than refused ----------------------
# Offline, so this must not reach the network: check the cache key it built.
bare = rss.fetch("example.com/feed.xml", ttl=0, timeout=0.001)
if bare.error and "protocol" in bare.error.lower():
    problems.append(f"a bare host was still refused over its prefix: {bare.error}")
else:
    print("  ok   a bare host gets https:// rather than a lecture")

# --- 4. a source with no feeds at all ------------------------------------
empty = rss.fetch_many({}, ttl=0)
if not empty.error or "no feed url" not in empty.error.lower():
    problems.append(f"an empty source gave: {empty.error}")
else:
    print("  ok   a source with no feeds says so")

# --- 5. failures name the whole URL --------------------------------------
long_url = "https://example.com/feeds/syndication/rss/news/local"
result = rss.fetch_many({"urls": long_url}, ttl=0, )
if result.error and long_url not in result.error:
    problems.append(
        f"the failure message truncated the URL: {result.error[:120]}")
else:
    print("  ok   a failure names the whole URL, not a fragment of it")

# --- 6. the endpoint itself ----------------------------------------------
#
# The bug did not live in this module at all: both functions here were correct.
# It lived in ONE LINE of main.py that called the wrong one. Testing the
# provider in isolation would have stayed green throughout, so the branch is
# read directly. FastAPI is not installed on every machine that runs these
# checks - the appliance's pinned stack does not build on a current Python - so
# this reads the source rather than importing the app.
_main = os.path.join(os.path.dirname(__file__), "..", "server", "lifeboard", "main.py")
with open(_main, encoding="utf8") as fh:
    _src = fh.read()

_start = _src.find('if kind == "rss":')
_branch = _src[_start:_start + 1400] if _start != -1 else ""
# Comments out: the fix is documented by quoting the call it replaced, and a
# scan that cannot tell code from prose fails on its own explanation.
_branch = "\n".join(
    line.split("#", 1)[0] for line in _branch.splitlines())
if not _branch.strip():
    problems.append("could not find the rss branch of the source test in main.py")
elif "rss.fetch_many(config" not in _branch:
    problems.append("the Test button no longer calls fetch_many — the board and "
                    "the test have diverged again")
elif 'rss.fetch(config.get("url"' in _branch:
    problems.append("the Test button is back to reading the legacy `url` key")
else:
    print("  ok   the Test endpoint calls fetch_many, like the board does")


# --- 7. duplicates -------------------------------------------------------
#
# A pasted list repeats a URL easily. The repeat is not cosmetic: the feed is
# fetched twice, its headlines appear twice in the merged stream, and if it is
# DOWN its twenty-second timeout is paid twice and its error printed twice.
_dupes = {"urls": "https://a.example/feed https://b.example/feed https://a.example/feed"}
_got = rss.feed_urls(_dupes)
if len(_got) != 2:
    problems.append(f"a repeated feed was not dropped: {_got}")
elif _got != ["https://a.example/feed", "https://b.example/feed"]:
    problems.append(f"dedupe changed the configured order: {_got}")
else:
    print("  ok   a repeated feed is fetched once, in the order it was typed")

# The legacy key repeated in the new field is the same mistake by another route.
_both = {"url": "https://a.example/feed", "urls": "https://a.example/feed"}
if rss.feed_urls(_both) != ["https://a.example/feed"]:
    problems.append(f"url duplicated into urls was not deduped: {rss.feed_urls(_both)}")
else:
    print("  ok   the same feed in both fields counts once")

# --- 8. a dead feed must not cost the live ones their time ---------------
#
# The reported symptom was a board with four feeds, three of them timing out.
# Serially that is a minute of dead air per refresh before anything is drawn.
# Patching `fetch` keeps this offline and makes the timing unambiguous.
import time as _time  # noqa: E402

_real_fetch = rss.fetch
_SLOW = 0.4


def _fake_fetch(url, *, limit=10, ttl=900.0, timeout=20.0, agent=''):
    from lifeboard.providers.base import FetchResult as _FR
    if "dead" in url:
        _time.sleep(_SLOW)
        return _FR(error="ReadTimeout: The read operation timed out")
    return _FR(payload={"feed_title": url, "items": [
        {"title": f"headline from {url}", "link": "", "summary": "",
         "published": None, "author": ""}]})


rss.fetch = _fake_fetch
try:
    _urls = " ".join(f"https://dead{i}.example/feed" for i in range(3))
    _config = {"urls": _urls + " https://live.example/feed"}
    _began = _time.monotonic()
    _result = rss.fetch_many(_config, ttl=0)
    _took = _time.monotonic() - _began
finally:
    rss.fetch = _real_fetch

_items = (_result.payload or {}).get("items", [])
if not _items:
    problems.append("the one live feed was lost when the others timed out")
elif _took > _SLOW * 2:
    problems.append(
        f"three dead feeds took {_took:.1f}s - about {_took / _SLOW:.0f} timeouts' "
        f"worth, so they are still being fetched one after another")
else:
    print(f"  ok   three dead feeds cost {_took:.1f}s, not {_SLOW * 3:.1f}s "
          f"- fetched in parallel")

if not _result.error or "dead0" not in _result.error:
    problems.append("a degraded result stopped naming which feeds failed")
else:
    print("  ok   the live headlines still arrive, and the dead feeds are named")


# --- 9. a timeout must say WHERE it failed --------------------------------
#
# "ReadTimeout: The read operation timed out" covers four unrelated problems -
# a name that will not resolve, a port nothing listens on, a stalled TLS
# handshake, and a server that accepts everything and then never replies - with
# four different owners. Reported as one sentence it sent us round the houses,
# blaming the URL, then the client library, then a corporate filter, on no
# evidence at all. The fetch now walks the steps by hand after a failure and
# says which one broke.
#
# Offline-safe: nothing below touches the network.
if rss.diagnose("") != "":
    problems.append("diagnose() invented a report for an empty URL")
elif rss.diagnose("not a url at all") != "":
    problems.append("diagnose() invented a report for a string with no host")
else:
    print("  ok   the probe stays quiet when there is no host to probe")

_rss_src = open(
    os.path.join(os.path.dirname(__file__), "..", "server", "lifeboard",
                 "providers", "rss.py"), encoding="utf8").read()
_handler = _rss_src[_rss_src.find("    except Exception as exc:"):]
_handler = chr(10).join(line.split("#", 1)[0] for line in _handler.splitlines())
if "diagnose(url)" not in _handler:
    problems.append("a timeout no longer reports which step failed")
elif "TimeoutException" not in _handler:
    problems.append("the probe is no longer wired to timeouts specifically")
else:
    print("  ok   a timeout is diagnosed rather than merely reported")

# The agent belongs in the cache key. Without it, flipping the switch would be
# answered from the cache with the result the OTHER agent already got - so the
# setting would appear to do nothing for as long as the entry lives, which is
# the most confusing possible outcome for a switch you flip to test something.
if '("rss", url, limit, agent)' not in _rss_src:
    problems.append("the user agent is not part of the cache key, so changing "
                    "it would return the previous agent's cached result")
else:
    print("  ok   the chosen user agent is part of the cache key")

if problems:
    print("\nFAILED:")
    for p in problems:
        print("  - " + p)
    sys.exit(1)
print("\nTest and the board read the same feeds, and URL errors name the field.")
