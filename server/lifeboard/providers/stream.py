"""Turn a YouTube page URL into something a browser can actually play.

WHY THIS EXISTS SEPARATELY FROM video/agent.py
------------------------------------------------
The Pi solves live video by running mpv over a hole in the page: yt-dlp picks
an H.264 rendition, mpv decodes it in hardware, and Chromium never sees a
frame. That works because there is an mpv.

On Android there is not. The fallback path embeds YouTube's own player in an
iframe, and on a TV box that fails twice over: YouTube refuses old engines
outright, and where it does load it negotiates VP9 or AV1 - which is precisely
the codec problem that made mpv necessary on the Pi. A cheap ARMv7 box is
weaker than the Pi, not stronger.

So this does the same job as agent.py's resolver by a different route: ask
yt-dlp for a DIRECT H.264 stream URL and hand it to a plain <video> element.
YouTube's player is never involved, and the hardware decoder gets the one codec
every device of that era can do.

TWO DIFFERENCES FROM THE mpv PATH, BOTH FORCED
-----------------------------------------------
1. It uses the yt-dlp PYTHON API, not the command line. There is no yt-dlp
   binary on Android; there is an importable module.

2. It can never ask for a merged format. mpv is given `bestvideo+bestaudio`
   and muxes them itself; a <video> element takes ONE url. So every format in
   the ladder below is a single rendition - a `+` here would resolve to two
   URLs and play neither.

Resolved URLs are cached and they EXPIRE. A signed googlevideo link is good for
a few hours and a live stream gets a new one when the broadcaster restarts, so
a board left alone for a day must re-resolve rather than serve a dead link -
which is the failure the Pi hit before its two-hour refresh was added.
"""

from __future__ import annotations

import logging

from .base import CACHE, FetchResult

log = logging.getLogger("lifeboard.stream")

# Shorter than the ~6h a signed URL usually lasts. The cost of re-resolving is
# one background request; the cost of being wrong is a dead player on a wall.
TTL = 90 * 60

# Passed straight through: yt-dlp would only add latency to something already
# playable.
DIRECT_SUFFIXES = (".mp4", ".mkv", ".webm", ".m3u8", ".ts")


def available() -> bool:
    """Is yt-dlp importable? The board tells the renderer, which decides."""
    try:
        import yt_dlp  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def _formats(max_height: int, muted: bool) -> str:
    """A ladder of SINGLE renditions, best first.

    Every entry is one stream. `bestvideo+bestaudio` is deliberately absent:
    it resolves to two URLs, and a <video> element has one src.

    Video-only leads when muted, which is the normal case for a wall. It is
    both cheaper - no audio to fetch or decode for something nobody hears - and
    more reliable, because YouTube live publishes video and audio separately
    and a muxed rendition often does not exist at all.
    """
    h264 = "[vcodec^=avc1]"
    cap = f"[height<={max_height}]"
    ladder = []
    if muted:
        ladder += [
            f"bestvideo{h264}{cap}",     # what we actually want
            f"bestvideo{cap}",           # any codec at the right size
        ]
    ladder += [
        f"best{h264}{cap}",              # muxed H.264, if the site has one
        f"best{cap}",
        f"bestvideo{h264}",              # ignore the cap before giving up
        "best",
    ]
    return "/".join(ladder)


def resolve(url: str, *, max_height: int = 720, muted: bool = True,
            ttl: float = TTL) -> FetchResult:
    """A direct stream URL for `url`, or an error worth showing."""
    url = (url or "").strip()
    if not url:
        return FetchResult(error="no video URL configured")

    low = url.lower().split("?")[0]
    if low.endswith(DIRECT_SUFFIXES) or url.startswith("rtsp://"):
        return FetchResult(payload={"url": url, "kind": _kind(url),
                                    "direct": True})

    cache_key = ("stream", url, int(max_height), bool(muted))
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        import yt_dlp
    except Exception:  # noqa: BLE001
        return CACHE.put(cache_key, FetchResult(error=(
            "This board cannot resolve YouTube links - yt-dlp is not "
            "installed on it.")))

    options = {
        "format": _formats(int(max_height), bool(muted)),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        # A wall display must not stall on a slow extractor; better a widget
        # that says it failed and retries than a board that never paints.
        "socket_timeout": 20,
        "retries": 1,
        # Never touch the disk. There is nowhere sensible to write on Android
        # and nothing here needs to persist between resolutions.
        "cachedir": False,
        "skip_download": True,
    }

    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)

        # A playlist or channel URL resolves to entries; take the first
        # playable one, which for a "channel live" link is the live stream.
        if info.get("_type") == "playlist" and info.get("entries"):
            info = next((e for e in info["entries"] if e), info)

        direct = info.get("url")
        if not direct and info.get("requested_formats"):
            # The ladder should never produce this, but if a future yt-dlp
            # merges anyway, take the video half rather than failing - a muted
            # wall loses nothing.
            direct = info["requested_formats"][0].get("url")
        if not direct:
            return CACHE.put(cache_key, FetchResult(error=(
                "yt-dlp found no playable stream for that link.")))

        result = FetchResult(payload={
            "url": direct,
            "kind": _kind(direct, info.get("protocol", "")),
            "title": info.get("title", ""),
            "is_live": bool(info.get("is_live")),
            "vcodec": info.get("vcodec", ""),
            "height": info.get("height") or 0,
            # So the widget knows when to ask again rather than waiting for a
            # dead link to fail on screen.
            "expires_in": int(ttl),
        })
        log.info("resolved %s -> %s %sp (%s)", url[:60],
                 result.payload["vcodec"], result.payload["height"],
                 result.payload["kind"])
        return CACHE.put(cache_key, result)

    except Exception as exc:  # noqa: BLE001
        return CACHE.put(cache_key, FetchResult(error=_friendly(exc)))


def _kind(url: str, protocol: str = "") -> str:
    if "m3u8" in url.lower() or "m3u8" in (protocol or "").lower():
        return "hls"
    return "file"


def _friendly(exc: Exception) -> str:
    text = str(exc)
    low = text.lower()
    if "requested format is not available" in low:
        return ("No H.264 stream is published for that video, so this device "
                "cannot play it. A different stream, or a lower quality "
                "setting, usually has one.")
    if "private" in low or "members-only" in low:
        return "That video is private or members-only."
    if "unavailable" in low or "removed" in low:
        return "That video is unavailable."
    if "sign in" in low or "age" in low and "confirm" in low:
        return "That video needs a signed-in account, which this board has not."
    if "timed out" in low or "timeout" in low:
        return "Timed out asking YouTube about that link; it will try again."
    return f"Could not resolve that video: {text.splitlines()[0][:180]}"
