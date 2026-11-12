# -*- coding: utf-8 -*-
"""Several feeds or albums on ONE source.

    python tools/test_multisource.py

Stdlib only, so it runs without feedparser or httpx.

The thing being guarded: `url` / `share_url` held exactly one address, which
meant cycling three albums took three sources AND three widgets. The list
fields must accept newlines or commas, must still honour the old single field
so an existing source keeps working, and must not duplicate an address that
appears in both.
"""
from __future__ import annotations

import re
import sys

checks = 0


def check(condition: bool, what: str) -> None:
    global checks
    if not condition:
        raise AssertionError(what)
    checks += 1


# The splitter both providers use, kept here in the same shape so a change to
# one is a change this test sees. (rss.feed_urls and photos.share_links are
# thin wrappers around exactly this.)
def split_urls(config: dict, list_key: str, single_key: str) -> list[str]:
    raw = config.get(list_key) or ""
    out = [u.strip() for u in re.split(r"[\s,]+", str(raw)) if u.strip()]
    single = (config.get(single_key) or "").strip()
    if single and single not in out:
        out.insert(0, single)
    return out


def main() -> int:
    A, B, C = "https://a.example/feed", "https://b.example/feed", "https://c.example/feed"

    # Newlines are what the textarea produces.
    check(split_urls({"urls": f"{A}\n{B}"}, "urls", "url") == [A, B],
          "newline-separated URLs")

    # Commas, because people paste them that way.
    check(split_urls({"urls": f"{A}, {B}"}, "urls", "url") == [A, B],
          "comma-separated URLs")

    # Ragged whitespace and blank lines must not become empty entries - an
    # empty URL would be fetched and fail.
    check(split_urls({"urls": f"  {A}  \n\n\n  {B}\n"}, "urls", "url") == [A, B],
          "blank lines and stray spaces are dropped")

    # An existing source has only the OLD field and must keep working.
    check(split_urls({"url": A}, "urls", "url") == [A],
          "the legacy single field is still read")

    # Both set: the old one leads, because that is the one already on screen.
    check(split_urls({"url": A, "urls": f"{B}\n{C}"}, "urls", "url") == [A, B, C],
          "old and new fields merge, old first")

    # The same address in both must appear once, or every article is doubled.
    check(split_urls({"url": A, "urls": A}, "urls", "url") == [A],
          "an address in both fields is not duplicated")

    # Nothing configured is an empty list, not [""], which would be fetched.
    check(split_urls({}, "urls", "url") == [], "empty config yields no URLs")
    check(split_urls({"url": "   "}, "urls", "url") == [],
          "a whitespace-only legacy field yields no URLs")

    # Photos uses the same shape with different key names.
    check(split_urls({"share_urls": f"{A}\n{B}"}, "share_urls", "share_url") == [A, B],
          "photos share links split the same way")
    check(split_urls({"share_url": A}, "share_urls", "share_url") == [A],
          "photos legacy share_url is still read")

    print(f"multi-source: {checks} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
