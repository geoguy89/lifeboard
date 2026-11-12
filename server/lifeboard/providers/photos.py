"""Photo albums for the slideshow widget.

READ THIS BEFORE ASKING WHY GOOGLE PHOTOS IS AWKWARD
----------------------------------------------------
Google shut the door on this in **March 2025**. The Photos Library API used to
let an app you authorised read your albums; the broad read scopes
(``photoslibrary.readonly`` and friends) were withdrawn for third-party apps.
What replaced them is the **Picker API**, where the *user* hand-picks specific
photos in a Google-hosted dialog and the app receives only those, with
short-lived URLs.

That is fundamentally incompatible with "point at an album and let it run for
a year unattended", which is what a wall dashboard needs. DAKboard and every
other dashboard product hit exactly the same wall at the same time.

So this module offers four backends, in the order I would actually recommend
them:

1. ``local``   - a folder (or an SMB/NFS mount) of images. Zero dependencies,
                 zero API, works offline, never breaks. If you already have a
                 NAS, this is strictly the best option.
2. ``immich``  - a self-hosted photo library with a real API and album support.
                 Runs happily on Unraid. This is the closest thing to the old
                 Google Photos experience that nobody can take away.
3. ``google_shared`` - a Google Photos album published via "share link".
                 Works today and needs no OAuth app at all, but it scrapes a
                 public page, so Google can change the markup and break it.
                 Treat it as convenient, not durable.
4. ``google_picker`` - the official current path. Honest about its limitation:
                 it needs periodic human re-picking, so it is not suitable for
                 unattended operation. Documented, not implemented.

Every backend returns the same thing: a plain list of image URLs.
"""

from __future__ import annotations

import json
import mimetypes
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

from .base import CACHE, FetchResult

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic", ".avif"}
# What a browser will actually play. .mkv and .avi are deliberately absent:
# a file listed and then silently skipped by the renderer is worse than one
# that was never offered, because the slideshow simply stalls on it.
VIDEO_SUFFIXES = {".mp4", ".m4v", ".webm", ".mov", ".ogv"}
MEDIA_SUFFIXES = IMAGE_SUFFIXES | VIDEO_SUFFIXES
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0 Safari/537.36"
)


def _payload(items: list[dict]) -> dict:
    """The shape every backend returns.

    ``items`` carries the kind, which is what lets the slideshow mix video in
    with the stills. ``photos`` is the old flat list of image URLs and is kept
    for two reasons: a renderer deployed before this change still works, and
    the layout BACKGROUND picks from it - a background must never land on a
    video, so images-only is the right list for it by construction rather than
    by remembering to filter.
    """
    return {
        "items": items,
        "photos": [i["url"] for i in items if i.get("kind") != "video"],
        "video_count": sum(1 for i in items if i.get("kind") == "video"),
    }


def fetch(source: dict, ttl: float = 3600.0) -> FetchResult:
    """Dispatch on the album's configured backend."""
    config = json.loads(source.get("config") or "{}")
    backend = config.get("backend", "local")
    cache_key = ("photos", source["id"], backend)

    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        if backend == "local":
            result = FetchResult(payload=_payload(_local(config)))
        elif backend == "immich":
            result = FetchResult(payload=_payload(_immich(config)))
        elif backend == "bing":
            result = FetchResult(payload=_payload(_bing(config)))
        elif backend == "unsplash":
            result = FetchResult(payload=_payload(_unsplash(config)))
        elif backend == "google_shared":
            result = FetchResult(payload=_payload(_google_shared_many(config)))
        elif backend == "google_picker":
            result = FetchResult(
                error="The Google Photos Picker API requires a person to re-pick "
                      "photos periodically and cannot run unattended. Use a local "
                      "folder, Immich, or a Google Photos share link instead - see "
                      "docs/google-photos.md."
            )
        else:
            result = FetchResult(error=f"unknown photo backend {backend!r}")
    except UnconfiguredSource as exc:
        # No type name, no traceback vocabulary: this one is addressed to
        # whoever set the board up, and it tells them where to go.
        result = FetchResult(error=str(exc))
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")

    return CACHE.put(cache_key, result)


# --------------------------------------------------------------------- local

def _media_files(config: dict) -> list[Path]:
    """The album's files, in ONE canonical order.

    Both the listing and the by-index lookup call this. They used to build the
    same sorted list separately, which was fine right up until the two
    definitions of "a file we serve" diverged - at which point index 12 in the
    listing is a different file from index 12 in the fetch, and the slideshow
    shows the wrong picture with no error anywhere.
    """
    root = Path(config.get("path", ""))
    if not root.is_dir():
        return []
    walker = root.rglob("*") if config.get("recursive", True) else root.glob("*")
    return sorted(
        p for p in walker
        if p.is_file() and p.suffix.lower() in MEDIA_SUFFIXES
    )


def _local(config: dict) -> list[dict]:
    """Images and videos under a directory, served back through /api/photo.

    Files are exposed by index rather than by path so that a mis-typed album
    directory cannot be turned into an arbitrary-file-read: the renderer can
    only ask for "photo 4 of album 2", never for /etc/shadow.
    """
    root = Path(config.get("path", ""))
    if not root.is_dir():
        raise ValueError(f"not a directory: {root}")

    files = _media_files(config)
    if not files:
        # An empty path almost always means the wrong backend rather than an
        # empty folder: a Google Photos share link saved against the "local
        # folder" backend lands here with nothing to look at.
        if not str(root).strip() or str(root) == ".":
            raise ValueError(
                "no folder was given. If you meant a Google Photos album, "
                "change 'Where the photos are' to 'Google Photos - public "
                "share link' and paste the link there"
            )
        raise ValueError(
            f"no media found under {root} - the path must exist ON THE "
            f"APPLIANCE and hold {', '.join(sorted(MEDIA_SUFFIXES))} files"
        )

    source_id = config.get("_source_id", 0)
    return [
        {
            "url": f"/api/photo?source_id={source_id}&index={i}",
            "kind": "video" if path.suffix.lower() in VIDEO_SUFFIXES else "image",
            "name": path.name,
        }
        for i, path in enumerate(files)
    ]


def local_file_at(config: dict, index: int) -> Path | None:
    """Resolve one index back to a real path, for the /api/photo endpoint."""
    root = Path(config.get("path", ""))
    if not root.is_dir():
        return None
    files = _media_files(config)
    if not 0 <= index < len(files):
        return None
    chosen = files[index]
    # Defence in depth: even though the index cannot escape the listing, refuse
    # anything that resolves outside the album root (a symlink could).
    try:
        chosen.resolve().relative_to(root.resolve())
    except ValueError:
        return None
    return chosen


def guess_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


# -------------------------------------------------------------------- immich

def _immich(config: dict) -> list[dict]:
    """Album contents from a self-hosted Immich server.

    Immich proxies the actual bytes through our own /api/photo endpoint so the
    API key never has to be handed to the browser.
    """
    base = (config.get("base_url") or "").rstrip("/")
    album_id = config.get("album_id") or ""
    api_key = config.get("api_key") or ""
    if not base or not album_id or not api_key:
        raise ValueError("immich needs base_url, album_id and api_key")

    with httpx.Client(timeout=30, headers={"x-api-key": api_key}) as client:
        resp = client.get(f"{base}/api/albums/{album_id}")
        resp.raise_for_status()
        album = resp.json()

    source_id = config.get("_source_id", 0)
    items: list[dict] = []
    for asset in album.get("assets", []):
        asset_id = asset.get("id")
        if not asset_id:
            continue
        if asset.get("type") == "VIDEO":
            items.append({
                "url": f"/api/photo?source_id={source_id}&asset_id={asset_id}&kind=video",
                "kind": "video",
                "name": asset.get("originalFileName") or asset_id,
            })
        elif asset.get("type") == "IMAGE":
            items.append({
                "url": f"/api/photo?source_id={source_id}&asset_id={asset_id}",
                "kind": "image",
                "name": asset.get("originalFileName") or asset_id,
            })
    return items


def immich_asset(config: dict, asset_id: str) -> tuple[bytes, str] | None:
    base = (config.get("base_url") or "").rstrip("/")
    api_key = config.get("api_key") or ""
    size = config.get("size", "preview")   # 'preview' is plenty for a TV
    with httpx.Client(timeout=60, headers={"x-api-key": api_key}) as client:
        resp = client.get(f"{base}/api/assets/{asset_id}/thumbnail", params={"size": size})
        if resp.status_code != 200:
            return None
        return resp.content, resp.headers.get("content-type", "image/jpeg")


def immich_video_request(config: dict, asset_id: str, range_header: str | None):
    """Open a STREAMING response for one Immich video.

    Deliberately not the same shape as ``immich_asset``: a thumbnail is a few
    hundred kilobytes and can be read into memory, a video is not. It is also
    why the Range header is forwarded rather than dropped - without it the
    browser cannot seek, and "start thirty seconds in" is exactly what the
    slideshow does to every clip.

    Returns (context_manager, headers_to_copy) or None. The caller is
    responsible for closing the client, which is why both are handed back.
    """
    base = (config.get("base_url") or "").rstrip("/")
    api_key = config.get("api_key") or ""
    if not base or not api_key:
        return None
    headers = {"x-api-key": api_key}
    if range_header:
        headers["Range"] = range_header
    client = httpx.Client(timeout=60, follow_redirects=True)
    request = client.build_request(
        "GET", f"{base}/api/assets/{asset_id}/video/playback", headers=headers
    )
    return client, request


# ------------------------------------------------------- google shared album

# Google's shared-album page embeds the photo list in a JS blob. These are the
# direct lh3.googleusercontent.com URLs; appending a size suffix like =w1920
# asks Google for a scaled copy rather than the full original.
LOG = logging.getLogger(__name__)


class UnconfiguredSource(Exception):
    """A source that was never finished, rather than one that failed.

    Separated from every other failure because the right words differ: a
    network error is news, while a missing share link is a job somebody started
    and did not complete. The board says so plainly instead of quoting Python
    at a room full of people.
    """

_GPHOTO_URL = re.compile(r'"(https://lh3\.googleusercontent\.com/[A-Za-z0-9_\-/]+)"')

# Google's avatar namespace. A shared album page includes the profile picture
# of every contributor, and they are indistinguishable from photographs to the
# scrape - except by this path. /pw/ is album content; /a/ and /a-/ are people.
_AVATAR_PATH = re.compile(r"^https://lh3\.googleusercontent\.com/a-?/")


def _is_avatar(url: str) -> bool:
    return bool(_AVATAR_PATH.match(url))


def _excluded(url: str, patterns: list[str]) -> bool:
    """Match against the user's exclusion list.

    Compared against the URL with any size suffix removed, so a pattern copied
    from one rendition still matches the same photo at another size.
    """
    bare = url.split("=")[0]
    return any(p and p.strip() and p.strip() in bare for p in patterns)


# Whether a given lh3 item is a photograph or a video, memoised by its bare
# URL. The answer never changes for a given item, and a forty-item album is
# re-fetched every hour for months.
_KIND_MEMO: dict[str, str] = {}
_KIND_MEMO_MAX = 4000

# Google serves a video from the same URL with an =m<n> suffix instead of a
# size. m18 is a modest progressive MP4, which is the right default here: a Pi
# 3 decodes 1080p in the browser badly, and this is a slideshow tile rather
# than a cinema.
DEFAULT_VIDEO_SUFFIX = "m18"


def _probe_kind(client: httpx.Client, bare: str, video_suffix: str) -> str:
    """Ask Google what this item actually is.

    THIS IS A MEASUREMENT, NOT A GUESS. A shared-album page gives no honest
    marker distinguishing a video from a still - the markup is undocumented
    and changes - so instead of pattern-matching a blob that Google can
    rearrange whenever it likes, one byte is requested from the video
    rendition and the CONTENT TYPE answers the question. A photo does not come
    back as video/mp4.

    Costs one tiny ranged GET per new item, once, ever. Any failure means
    'image', which is exactly the behaviour this backend had before videos
    existed - an unreachable probe must not turn a working album into an album
    of black rectangles.
    """
    memo = _KIND_MEMO.get(bare)
    if memo:
        return memo
    kind = "image"
    try:
        resp = client.get(
            f"{bare}={video_suffix}",
            headers={"Range": "bytes=0-0"},
            timeout=10,
        )
        if resp.status_code < 400:
            if resp.headers.get("content-type", "").lower().startswith("video/"):
                kind = "video"
    except Exception:  # noqa: BLE001
        LOG.debug("video probe failed for %s", bare, exc_info=True)
    if len(_KIND_MEMO) < _KIND_MEMO_MAX:
        _KIND_MEMO[bare] = kind
    return kind


def share_links(config: dict) -> list[str]:
    """Every share link on this source, old field and new.

    `share_url` held exactly one album, which meant cycling three albums took
    three sources AND three widgets. `share_urls` is a newline- or
    comma-separated list, and both are read so an existing album keeps working
    and simply gains the ability to grow.
    """
    raw = config.get("share_urls") or ""
    links = [u.strip() for u in re.split(r"[\s,]+", str(raw)) if u.strip()]
    single = (config.get("share_url") or "").strip()
    if single and single not in links:
        links.insert(0, single)
    return links


def _google_shared_many(config: dict) -> list[dict]:
    """All the albums on this source, merged.

    One dead or renamed album must not take the others down with it - a
    slideshow that goes blank because the third of four links expired is a
    worse failure than one that quietly shows the other three.
    """
    links = share_links(config)
    if not links:
        # A source nobody finished filling in is not an error condition, it is
        # an unanswered question - and the two want very different sentences on
        # a wall. "ValueError: no Google Photos share link on this album" tells
        # somebody standing in a kitchen that the software is broken. A named
        # exception carries the difference as far as the formatter below, which
        # is the only place that knows whether to print a Python type.
        raise UnconfiguredSource(
            "this album has no Google Photos share link yet - open the Sources "
            "page and paste the album's share link into it.")

    items, failures = [], []
    for link in links:
        try:
            items.extend(_google_shared({**config, "share_url": link}))
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{link[:60]}: {exc}")

    if not items and failures:
        raise ValueError("; ".join(failures)[:400])
    if failures:
        LOG.warning("photos: %d of %d albums failed: %s",
                    len(failures), len(links), "; ".join(failures)[:300])
    return items


def _google_shared(config: dict) -> list[dict]:
    """Scrape a *public share link* album.

    This is not an API and Google does not promise it will keep working. It is
    included because it is the only way left to point at a Google Photos album
    and have it keep running unattended, and because it touches only an album
    the user has deliberately published.
    """
    url = config.get("share_url") or ""
    if "photos.app.goo.gl" not in url and "photos.google.com/share" not in url:
        raise ValueError("not a Google Photos share link")

    with httpx.Client(
        timeout=30, follow_redirects=True, headers={"User-Agent": USER_AGENT}
    ) as client:
        resp = client.get(url)
        resp.raise_for_status()
        body = resp.text

    width = int(config.get("width", 1920))
    excludes = [p for p in (config.get("exclude") or "").split(",") if p.strip()]

    seen: list[str] = []
    dropped_avatars = 0
    for match in _GPHOTO_URL.findall(body):
        if match in seen:
            continue
        if _is_avatar(match):
            # A contributor's profile picture, not a photograph.
            dropped_avatars += 1
            continue
        if _excluded(match, excludes):
            continue
        seen.append(match)

    if dropped_avatars:
        LOG.info("skipped %d contributor profile picture(s)", dropped_avatars)

    if not seen:
        # This reads a page Google does not document, so when it finds nothing
        # the useful thing is to say what the page LOOKED like. "No photos
        # found" alone cannot distinguish a private album from a layout change
        # at Google's end, and those need opposite responses.
        lowered = body.lower()
        if "accounts.google.com" in lowered or "signin" in lowered[:4000]:
            hint = ("that link asks for a Google sign-in, so it is not public. "
                    "In Google Photos open the album, Share, and create a link "
                    "that anyone can view")
        elif len(body) < 2000:
            hint = (f"the page came back nearly empty ({len(body)} bytes), "
                    "which usually means the link is wrong or has expired")
        elif "photos.google.com" not in lowered:
            hint = ("that URL did not resolve to a Google Photos album - check "
                    "it opens as an album in a private browser window")
        else:
            hint = ("the album loaded but no image URLs were found in it. If "
                    "it opens fine in a private browser window, Google has "
                    "probably changed the page and the scrape needs updating")
        raise ValueError(f"no photos found: {hint}")

    video_suffix = str(config.get("video_suffix") or DEFAULT_VIDEO_SUFFIX)

    # Detection is opt-out rather than opt-in: an album of holiday clips that
    # silently showed forty frozen first frames would be a far more confusing
    # default than a few hundred milliseconds of probing once an hour.
    #
    # The flag is phrased NEGATIVELY on purpose. The admin's checkboxes render
    # an absent key as unchecked, so a `detect_videos` that defaults to true
    # would show an unticked box next to behaviour that is switched on - the
    # form would be lying about what the appliance does.
    if config.get("skip_video_detection"):
        return [{"url": f"{u}=w{width}", "kind": "image"} for u in seen]

    kinds: dict[str, str] = {}
    try:
        with httpx.Client(
            timeout=15, follow_redirects=True, headers={"User-Agent": USER_AGENT}
        ) as client:
            unknown = [u for u in seen if u not in _KIND_MEMO]
            # Six at a time: enough that a forty-item album is probed in about
            # a second, few enough that the appliance is not opening forty
            # sockets to Google at once on a domestic connection.
            if unknown:
                with ThreadPoolExecutor(max_workers=6) as pool:
                    list(pool.map(
                        lambda u: _probe_kind(client, u, video_suffix), unknown
                    ))
            kinds = {u: _KIND_MEMO.get(u, "image") for u in seen}
    except Exception:  # noqa: BLE001
        LOG.warning("video detection failed; treating everything as a photo",
                    exc_info=True)
        kinds = {}

    items: list[dict] = []
    for u in seen:
        if kinds.get(u) == "video":
            items.append({"url": f"{u}={video_suffix}", "kind": "video"})
        else:
            items.append({"url": f"{u}=w{width}", "kind": "image"})
    return items


# ----------------------------------------------------------------- bing
def _bing(config: dict) -> list[dict]:
    """Bing's photo of the day, and the days before it.

    No key and no account, which is why it is here and Unsplash needs one.
    Bing returns a PATH plus a base host, and the `_1920x1080` suffix on the
    urlbase is what selects the resolution - the `url` field it hands back is
    already sized for whatever it felt like.
    """
    market = config.get("market") or "en-US"
    count = max(1, min(int(config.get("count", 8)), 8))    # 8 is Bing's cap
    quality = config.get("quality") or "1920x1080"

    with httpx.Client(timeout=20.0, follow_redirects=True,
                      headers={"User-Agent": USER_AGENT}) as client:
        resp = client.get("https://www.bing.com/HPImageArchive.aspx",
                          params={"format": "js", "idx": 0, "n": count, "mkt": market})
        resp.raise_for_status()
        images = resp.json().get("images", []) or []

    out = []
    for img in images:
        base = img.get("urlbase") or ""
        if not base:
            continue
        out.append({
            "url": f"https://www.bing.com{base}_{quality}.jpg",
            "kind": "image",
            # Bing's copyright line is the caption everyone actually wants:
            # "Sunrise over the Dolomites, Italy (© Photographer/Getty)".
            "caption": img.get("copyright", ""),
        })
    return out


# -------------------------------------------------------------- unsplash
def _unsplash(config: dict) -> list[dict]:
    """Unsplash, via the official API.

    This one DOES need a key, unlike everything else in this module, and that
    is not an oversight: source.unsplash.com - the keyless endpoint every
    tutorial still recommends - now answers 503 and has been retired. A free
    Unsplash developer account issues an Access Key in about a minute.
    """
    key = config.get("access_key") or ""
    if not key:
        raise ValueError(
            "Unsplash needs a free Access Key. The old keyless "
            "source.unsplash.com endpoint was retired and now returns 503. "
            "Create an app at unsplash.com/developers and paste its Access Key."
        )
    query = config.get("query") or ""
    count = max(1, min(int(config.get("count", 12)), 30))

    params = {"per_page": count, "orientation": config.get("orientation") or "landscape"}
    if query:
        params["query"] = query
        url = "https://api.unsplash.com/search/photos"
    else:
        url = "https://api.unsplash.com/photos/random"
        params = {"count": count, "orientation": params["orientation"]}

    with httpx.Client(timeout=20.0, follow_redirects=True,
                      headers={"User-Agent": USER_AGENT,
                               "Authorization": f"Client-ID {key}",
                               "Accept-Version": "v1"}) as client:
        resp = client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()

    items = data.get("results", data) if isinstance(data, dict) else data
    out = []
    for photo in (items or []):
        urls = photo.get("urls") or {}
        src = urls.get("regular") or urls.get("full") or urls.get("raw")
        if not src:
            continue
        who = ((photo.get("user") or {}).get("name")) or ""
        out.append({
            "url": src,
            "kind": "image",
            # Unsplash's licence asks for attribution, so it is not optional
            # decoration - the widget can hide it, but it is always carried.
            "caption": f"{photo.get('description') or ''} {('© ' + who) if who else ''}".strip(),
        })
    return out
