# -*- coding: utf-8 -*-
"""The provider cache's failure semantics.

    python tools/test_cache.py

Stdlib only, and it loads base.py directly rather than importing the package,
so it runs on a machine with no FastAPI/httpx - unlike smoke_test.py.

What it guards: a failed fetch must never evict a good answer. Before this,
every provider ended with `CACHE.put(key, result)` whether the fetch worked or
not, so one refused connection replaced a good forecast with an exception
string that then sat on the wall for the whole refresh interval - which is how
a one-second network blip became a fifteen-minute "timed out" on the board.
"""
from __future__ import annotations

import importlib.util
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "base", ROOT / "server" / "lifeboard" / "providers" / "base.py"
)
base = importlib.util.module_from_spec(SPEC)
# dataclasses resolves annotations through sys.modules, so register it first.
sys.modules["base"] = base
SPEC.loader.exec_module(base)

FetchResult = base.FetchResult
TTL = 900.0
checks = 0


def check(condition: bool, what: str) -> None:
    global checks
    if not condition:
        raise AssertionError(what)
    checks += 1


def main() -> int:
    cache = base.TTLCache()
    key = ("weather", 1)

    good = FetchResult(payload={"temp": 68})
    check(cache.put(key, good) is good, "a good result is returned as-is")
    check(cache.get(key, TTL).payload == {"temp": 68}, "a good result is cached")

    # A failure serves the good answer instead of replacing it.
    bad = FetchResult(error="ConnectTimeout: boom")
    check(cache.put(key, bad).payload == {"temp": 68}, "a failure evicted the good answer")
    check(cache.get(key, TTL).payload == {"temp": 68}, "the good answer survives a failure")

    # Inside the retry window a second widget asking for the same source must
    # not re-dial the host that just failed - it gets the good answer too.
    served = cache.get(key, TTL)
    check(served.payload == {"temp": 68}, "a recent failure re-dialled the dead host")

    # ...but it must be MARKED, or an outage is invisible: the board looks
    # fine, so the admin Status column is the only place it can show.
    check(served.degraded != "", "a served-through-outage answer was not marked degraded")
    check(served.ok, "degraded data is still usable data, not an error")
    check(cache._data[key][1].degraded == "", "the stored good answer was mutated")

    # Once the retry window passes, an entry past its TTL must miss so the
    # provider actually refetches.
    cache._failed[key] = (time.time() - (base.FAILURE_RETRY_SECONDS + 1), bad)
    cache._data[key] = (time.time() - (TTL + 1), good)
    check(cache.get(key, TTL) is None, "an expired entry must miss so the provider refetches")

    # ...and when that refetch fails, the board still gets weather. This is the
    # case that put "timed out" on the wall for a quarter of an hour.
    served = cache.put(key, bad)
    check(served.payload == {"temp": 68}, "expired-then-failed served the error")
    check(served.degraded == bad.error, "the failure reason was not passed through")
    check(cache.get(key, TTL).payload == {"temp": 68},
          "the re-stamp did not carry the good answer forward")

    # Grace is measured from the good answer's real age, not from the retry,
    # so repeated failures cannot walk stale data forward forever.
    good.fetched_at = time.time() - (base.FAILURE_GRACE_SECONDS + 1)
    check(cache.put(key, bad) is bad, "stale data walked past the grace window")
    check(cache.get(key, TTL).error != "", "the error is cached once grace expires")

    # Recovery replaces the cached error.
    fresh = FetchResult(payload={"temp": 70})
    check(cache.put(key, fresh) is fresh, "a recovery is returned as-is")
    check(cache.get(key, TTL).payload == {"temp": 70}, "a recovery replaces the error")

    # With no good answer to hide behind, a failure must still be visible.
    first = ("weather", 2)
    err = FetchResult(error="ConnectError: name resolution")
    check(cache.put(first, err) is err, "a first-ever failure must surface")
    check(cache.get(first, TTL).error != "", "a first-ever failure is briefly cached")

    # ...but only briefly. This is the cold-start case - a reboot leaves an
    # empty cache, and if that first fetch failed the old code held the error
    # for the source's whole refresh interval, so rebooting the appliance
    # "fixed" nothing. The retry window must be far shorter than the TTL.
    check(base.FAILURE_RETRY_SECONDS < TTL, "the retry window must be shorter than a TTL")
    cache._failed[first] = (time.time() - (base.FAILURE_RETRY_SECONDS + 1), err)
    check(cache.get(first, TTL) is None, "a stale failure must not block a retry")

    # A failure never becomes the cached answer, so it cannot be served as
    # though it were data once the retry window passes.
    check(first not in cache._data, "a failure leaked into the success cache")

    # get_stale reports the data's real age, not the last re-stamp - otherwise
    # a failing feed could be served past ical's STALE_LIMIT forever.
    aged = ("ical", 1)
    old_events = FetchResult(payload={"n": 1})
    old_events.fetched_at = time.time() - 4000
    cache.put(aged, old_events)
    cache.put(aged, FetchResult(error="ReadTimeout"))
    _served, age = cache.get_stale(aged)
    check(age > 3900, f"get_stale reported {age:.0f}s for 4000s-old data")

    print(f"cache: {checks} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
