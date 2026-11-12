"""Native video playback, so live streams work on every target including a Pi.

WHY THIS EXISTS
---------------
Playing YouTube inside the kiosk browser is fine on x86 and bad on a Pi.
YouTube serves VP9/AV1 to modern Chromium, and neither Pi has a hardware
decoder for those - so a 1080p live stream falls back to software decode and
eats the whole SoC. That is what made the first draft of this project say
"avoid live video on a Pi", which is not an acceptable answer for a board whose
whole point is a permanently-running live stream.

The fix is to stop asking the browser to do it.

  * ``yt-dlp`` resolves the page URL to a direct media stream, and can be told
    to *prefer H.264* - which both Pi 4 and Pi 5 handle far better than VP9.
  * ``mpv`` plays that stream with real hardware decode (``v4l2m2m`` on Pi 4,
    ``drm``/``vaapi`` on Pi 5 and x86) in a borderless always-on-top window,
    positioned exactly over the hole the renderer leaves for it.

The result is the same picture, at a fraction of the CPU, on every target. It
is also *better* on x86: mpv with VA-API beats Chromium's own pipeline.

HOW THE WINDOW LINES UP
-----------------------
The server already knows the layout and the screen resolution, so it can work
out the video widget's pixel rectangle itself. The renderer is not consulted -
asking the page to report its own geometry would race with layout changes and
produce a window that lags a second behind every edit.

Geometry is computed against the *rotated* screen, because mpv positions in
the same coordinate space xrandr produces.

LIVE URLS EXPIRE
----------------
A resolved googlevideo URL is signed and dies after a few hours; a live stream
also gets a new id whenever the broadcaster restarts. So the URL is re-resolved
on a timer and mpv is restarted with the fresh one. Without that, a board looks
perfect for an afternoon and is dead by morning - the single most common way
these setups fail.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field

from .. import db

XDISPLAY = os.environ.get("LIFEBOARD_DISPLAY", ":0")

log = logging.getLogger("lifeboard.video")

# How often to re-resolve a stream URL. Google's signed URLs typically last ~6h;
# re-resolving every 2h is comfortably inside that with room for a retry.
RESOLVE_EVERY = 2 * 3600

# A live stream that drops should come back quickly, but not spin.
RESTART_BACKOFF = (5, 10, 30, 60, 120)


@dataclass
class Slot:
    """One native video widget currently on screen."""

    widget_id: int
    url: str
    muted: bool = True
    volume: int = 100
    rect: tuple[int, int, int, int] = (0, 0, 0, 0)   # x, y, w, h in pixels
    proc: subprocess.Popen | None = None
    resolved_url: str = ""
    resolved_at: float = 0.0
    failures: int = 0
    last_error: str = ""
    config: dict = field(default_factory=dict)


def available() -> dict:
    """What the box can actually do. Surfaced in the admin UI."""
    return {
        "mpv": bool(shutil.which("mpv")),
        "yt_dlp": bool(shutil.which("yt-dlp")),
        "hwdec": _detect_hwdec(),
    }


def _x_env() -> dict:
    """The environment mpv needs to find the display.

    Without DISPLAY, mpv runs perfectly and draws nowhere - it decodes the
    stream, reports hardware decoding, and never opens a window. That failure
    is invisible from every angle except listing X's windows or reading the
    process environment, and it looks exactly like a playback fault.

    XAUTHORITY is set when it can be worked out. It is usually redundant -
    HOME is correct and X looks under it - but startx keeps its cookie in a
    /tmp file, and being explicit costs nothing next to another silent
    failure.
    """
    env = dict(os.environ)
    env["DISPLAY"] = os.environ.get("LIFEBOARD_DISPLAY") or XDISPLAY

    if not env.get("XAUTHORITY"):
        home = env.get("HOME") or "/home/lifeboard"
        candidate = os.path.join(home, ".Xauthority")
        if os.path.exists(candidate):
            env["XAUTHORITY"] = candidate
        else:
            # startx generates /tmp/serverauth.XXXXXX and points the server at
            # it; if there is no cookie in HOME, that is where it lives.
            try:
                auths = sorted(
                    (f for f in os.listdir("/tmp") if f.startswith("serverauth.")),
                    key=lambda f: os.path.getmtime(os.path.join("/tmp", f)),
                    reverse=True,
                )
                if auths:
                    env["XAUTHORITY"] = os.path.join("/tmp", auths[0])
            except OSError:
                pass
    return env


def _x_is_up() -> bool:
    """Is an X server actually accepting connections on our display?

    This gates every mpv launch. Without it the boot order deadlocks: the
    kiosk unit Wants= the server and starts it FIRST, the server sees a video
    widget and launches mpv, and mpv - finding no X - takes the console
    instead. Xorg then cannot become DRM master, `startx` dies with
    "Couldn't get a file descriptor referring to the console", systemd
    restarts it, and it fails the same way forever. The board shows the video
    full-screen at the panel's native orientation with nothing behind it,
    because the rotation and the whole dashboard belong to the X session that
    can never start.

    xdpyinfo is the cheapest honest check: it opens a real connection, so it
    fails while X is mid-startup rather than reporting a socket that is not
    serving yet.
    """
    if not shutil.which("xdpyinfo"):
        # Don't block playback on a missing debug tool: the --gpu-context
        # pin below is what actually makes seizing the console impossible.
        return True
    try:
        return subprocess.run(
            ["xdpyinfo"], env=_x_env(),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
        ).returncode == 0
    except Exception:  # noqa: BLE001
        return False


def _raise_window(name: str = "lifeboard-video") -> bool:
    """Put mpv's window above the browser.

    --ontop is a hint to a window manager and there is none here, so it has no
    effect at all: mpv plays correctly into a window Chromium is covering.
    xdotool talks to X directly, which is what actually restacks it.

    Best effort throughout. A board with no video is degraded; a board whose
    server crashed because a helper was missing is dead.
    """
    if not shutil.which("xdotool"):
        return False
    try:
        found = subprocess.run(
            ["xdotool", "search", "--name", name],
            capture_output=True, text=True, timeout=5, env=_x_env(),
        )
        ids = (found.stdout or "").split()
        for window_id in ids:
            subprocess.run(["xdotool", "windowraise", window_id],
                           capture_output=True, timeout=5, env=_x_env())
        return bool(ids)
    except Exception as exc:  # noqa: BLE001
        log.debug("could not raise the video window: %s", exc)
        return False


def _detect_hwdec() -> str:
    """Pick a hardware decoder for this machine.

    ``auto-safe`` would usually do, but being explicit means the admin UI can
    show what was chosen, and a wrong guess is then visible rather than being
    a mysterious 100% CPU.
    """
    try:
        model = open("/proc/device-tree/model", "rb").read().decode(errors="ignore")
    except OSError:
        model = ""

    if "Raspberry Pi 5" in model:
        # Pi 5 dropped the legacy H.264 block; its HEVC decoder is hardware and
        # H.264 falls to the (fast) CPU. drm-copy keeps output on the GPU.
        return "drm-copy"
    if "Raspberry Pi" in model:
        # Pi 4 and earlier, INCLUDING the Pi 3: the bcm2835 V4L2 stateful
        # decoder does H.264 on all of them. This is exactly why the native
        # engine exists - Chromium has no hardware decode path here at all.
        return "v4l2m2m-copy"
    # x86: Intel/AMD VA-API.
    return "vaapi-copy"


def default_max_height() -> int:
    """The resolution ceiling this machine should ask for.

    A Pi 3 has 1GB of RAM shared with the GPU and is also running Chromium for
    the rest of the board. It can decode 1080p H.264, but doing so while the
    dashboard renders leaves very little headroom, and the failure mode -
    swapping, then stuttering - looks like a broken stream rather than a
    memory limit. 720p halves the pixels and is indistinguishable on a video
    block occupying part of a screen.

    Overridable per widget; this only decides the starting point.
    """
    try:
        model = open("/proc/device-tree/model", "rb").read().decode(errors="ignore")
    except OSError:
        return 1080

    # Pi 4 and 5 have the memory and the decoder for 1080p.
    if "Raspberry Pi 5" in model or "Raspberry Pi 4" in model:
        return 1080
    if "Raspberry Pi" in model:
        # Pi 3 and older, and the Zero.
        return 720
    return 1080


def _prefers_h264() -> bool:
    """Should yt-dlp be told to avoid VP9/AV1?

    On a Pi, yes, always - VP9 has no hardware path there and software decode
    is exactly the problem this module exists to solve. On x86 it does not
    matter much, but H.264 is still the cheaper choice for a stream that will
    run for months.
    """
    return True


class VideoAgent:
    """Owns every native mpv process and keeps them where they belong."""

    def __init__(self) -> None:
        self._slots: dict[int, Slot] = {}
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._held = False

    def hold(self, on: bool) -> None:
        """Keep every player off while the board shows its setup screen.

        mpv paints an always-on-top window, so a board that lost its network
        kept a (frozen) video on top of the instructions for getting it back.
        Releasing the hold re-syncs from the layout.
        """
        if on == self._held:
            return
        self._held = on
        if on:
            with self._lock:
                for slot in list(self._slots.values()):
                    self._kill(slot)
                self._slots.clear()
        else:
            # Off the request thread: resolving a stream can take seconds.
            threading.Thread(target=self.sync, name="video-resume", daemon=True).start()

    # ---------------------------------------------------------------- lifecycle

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="video-agent", daemon=True)
        self._thread.start()
        log.info("video agent started (%s)", available())

    def stop(self) -> None:
        self._stop.set()
        with self._lock:
            for slot in self._slots.values():
                self._kill(slot)
            self._slots.clear()

    # ------------------------------------------------------------------- sync

    def sync(self, screen_id: int = 1) -> dict:
        """Make the running mpv processes match the current layout.

        Called on startup, and whenever a layout is saved. Idempotent: a widget
        whose url and geometry are unchanged is left completely alone, so
        editing an unrelated widget does not interrupt playback.
        """
        if not shutil.which("mpv"):
            return {"ok": False, "error": "mpv is not installed"}
        if self._held:
            return {"ok": True, "playing": 0, "held": True}

        screen = db.one("SELECT * FROM screens WHERE id = ?", (screen_id,))
        if not screen:
            return {"ok": False, "error": "no such screen"}

        width, height = _rotated_size(screen)
        wanted: dict[int, Slot] = {}

        if screen.get("active_layout_id"):
            rows = db.query(
                "SELECT * FROM widgets WHERE layout_id = ? AND kind = 'video'",
                (screen["active_layout_id"],),
            )
            for row in rows:
                config = json.loads(row["config"] or "{}")
                if config.get("engine", "auto") == "browser":
                    continue          # the page is handling this one
                url = (config.get("url") or "").strip()
                if not url:
                    continue
                wanted[row["id"]] = Slot(
                    widget_id=row["id"],
                    url=url,
                    muted=config.get("muted", True) is not False,
                    volume=int(float(config.get("volume", 1)) * 100),
                    rect=(
                        int(row["x"] / 100 * width),
                        int(row["y"] / 100 * height),
                        max(16, int(row["w"] / 100 * width)),
                        max(16, int(row["h"] / 100 * height)),
                    ),
                    config=config,
                )

        with self._lock:
            # Stop anything no longer on the board.
            for widget_id in list(self._slots):
                if widget_id not in wanted:
                    self._kill(self._slots.pop(widget_id))

            for widget_id, want in wanted.items():
                have = self._slots.get(widget_id)
                if have and have.url == want.url and have.rect == want.rect \
                        and have.muted == want.muted and self._alive(have):
                    continue          # unchanged and healthy - leave it playing
                if have:
                    self._kill(have)
                    want.resolved_url = have.resolved_url if have.url == want.url else ""
                    want.resolved_at = have.resolved_at if have.url == want.url else 0.0
                self._slots[widget_id] = want
                self._spawn(want)

        return {"ok": True, "playing": len(self._slots)}

    def status(self) -> list[dict]:
        with self._lock:
            return [
                {
                    "widget_id": s.widget_id,
                    "url": s.url,
                    "rect": s.rect,
                    "muted": s.muted,
                    "alive": self._alive(s),
                    "failures": s.failures,
                    "last_error": s.last_error,
                    "resolved_age": int(time.time() - s.resolved_at) if s.resolved_at else None,
                }
                for s in self._slots.values()
            ]

    # ---------------------------------------------------------------- internals

    def _alive(self, slot: Slot) -> bool:
        return slot.proc is not None and slot.proc.poll() is None

    def _kill(self, slot: Slot) -> None:
        if slot.proc and slot.proc.poll() is None:
            try:
                slot.proc.send_signal(signal.SIGTERM)
                slot.proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                try:
                    slot.proc.kill()
                except Exception:  # noqa: BLE001
                    pass
        slot.proc = None

    def _resolve(self, slot: Slot) -> str:
        """Turn a page URL into a direct stream URL via yt-dlp.

        A direct media file or an HLS playlist is passed straight through -
        yt-dlp would only add latency.
        """
        url = slot.url
        if url.endswith((".mp4", ".mkv", ".webm", ".m3u8")) or url.startswith("rtsp://"):
            return url
        if not shutil.which("yt-dlp"):
            # mpv has its own youtube-dl hook; without yt-dlp it may still work,
            # but it will not honour the H.264 preference that makes a Pi viable.
            return url

        # Per-widget override, else whatever this board can comfortably do.
        try:
            cap = int(slot.config.get("max_height") or 0)
        except (TypeError, ValueError):
            cap = 0
        if cap <= 0:
            cap = default_max_height()

        # YouTube live publishes video and audio as SEPARATE renditions - there
        # is no muxed stream to select - so `best[...]` alone matches nothing
        # and yt-dlp answers "Requested format is not available". Anything
        # asking for a single combined stream has to be a fallback, never the
        # first choice.
        #
        # Muted is the normal case for a wall display, and when muted the audio
        # rendition is pure overhead: bandwidth and decode for something nobody
        # hears. Video-only comes first, which also sidesteps every "no audio
        # stream matched" failure.
        muted = slot.config.get("muted", True) is not False
        h264 = "[vcodec^=avc1]" if _prefers_h264() else ""

        parts = []
        if muted:
            # Video alone, at or under the cap, then at any size.
            parts += [f"bestvideo{h264}[height<={cap}]", f"bestvideo[height<={cap}]"]
        # Explicitly combined, for sound or where video-only will not play.
        parts += [
            f"bestvideo{h264}[height<={cap}]+bestaudio",
            f"bestvideo[height<={cap}]+bestaudio",
            # Muxed, for the sites that do publish one.
            f"best{h264}[height<={cap}]",
            f"best[height<={cap}]",
        ]
        if not muted:
            parts.append(f"bestvideo{h264}[height<={cap}]")
        # Last resorts: ignore the cap rather than show nothing at all.
        parts += [f"bestvideo{h264}", "bestvideo+bestaudio", "best"]

        fmt = "/".join(parts)
        try:
            proc = subprocess.run(
                ["yt-dlp", "--no-warnings", "--quiet", "-f", fmt, "-g", url],
                capture_output=True, text=True, timeout=60,
            )
            if proc.returncode != 0:
                slot.last_error = (proc.stderr or "yt-dlp failed").strip()[:300]
                return ""
            # -g can print video and audio URLs on separate lines; the first is
            # the video stream, which is what mpv is given (audio follows it for
            # a muxed format, and muted playback is the common case anyway).
            lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
            return lines[0] if lines else ""
        except subprocess.TimeoutExpired:
            slot.last_error = "yt-dlp timed out"
            return ""
        except Exception as exc:  # noqa: BLE001
            slot.last_error = f"{type(exc).__name__}: {exc}"
            return ""

    def _spawn(self, slot: Slot) -> None:
        # Never launch into a display that does not exist yet. On a cold boot
        # the server is up well before X; the watchdog retries every 10s, so
        # the video simply appears once the kiosk session is running.
        if not _x_is_up():
            slot.last_error = "waiting for X"
            log.info("video for widget %s deferred: X is not up yet", slot.widget_id)
            return

        now = time.time()
        if not slot.resolved_url or (now - slot.resolved_at) > RESOLVE_EVERY:
            resolved = self._resolve(slot)
            if not resolved:
                slot.failures += 1
                return
            slot.resolved_url = resolved
            slot.resolved_at = now

        x, y, w, h = slot.rect
        hwdec = slot.config.get("hwdec") or _detect_hwdec()

        cmd = [
            "mpv",
            slot.resolved_url,
            f"--geometry={w}x{h}+{x}+{y}",
            f"--autofit={w}x{h}",
            "--no-border",
            "--ontop",
            "--no-osc",              # no on-screen controls
            "--no-osd-bar",
            "--cursor-autohide=always",
            "--no-input-default-bindings",
            "--input-vo-keyboard=no",
            f"--hwdec={hwdec}",
            "--profile=low-latency",
            "--keep-open=no",
            # A live stream must not be paused by mpv's own cache logic.
            "--cache=yes",
            "--demuxer-max-bytes=64MiB",
            "--force-window=yes",
            # THE LOAD-BEARING FLAG. With no --vo, mpv picks its own output,
            # and with no X to be found it falls back to DRM/KMS - taking
            # over the console and locking Xorg out of the display for good.
            # Pinning the context to X11 means that when X is absent mpv
            # exits with an error and gets retried, instead of stealing the
            # screen from the session that was about to start.
            "--vo=gpu",
            "--gpu-context=x11egl",
            # Fill the box the way the widget asked, matching the CSS `fit`.
            "--panscan=1.0" if slot.config.get("fit", "cover") == "cover" else "--panscan=0.0",
            f"--mute={'yes' if slot.muted else 'no'}",
            f"--volume={max(0, min(100, slot.volume))}",
            # Identifiable in `xdotool search` / ps, for debugging.
            "--title=lifeboard-video",
            "--x11-name=lifeboard-video",
        ]

        try:
            slot.proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                start_new_session=True,
                # Without this mpv has no DISPLAY and silently plays into
                # nowhere - see _x_env.
                env=_x_env(),
            )
            slot.last_error = ""
            log.info("mpv started for widget %s at %sx%s+%s+%s", slot.widget_id, w, h, x, y)
            # The window takes a moment to map; raising before it exists does
            # nothing, and the watchdog will catch it regardless.
            threading.Timer(2.0, _raise_window).start()
        except Exception as exc:  # noqa: BLE001
            slot.failures += 1
            slot.last_error = f"{type(exc).__name__}: {exc}"
            log.exception("could not start mpv")

    def _loop(self) -> None:
        """Watchdog: restart anything that died, refresh expiring URLs."""
        while not self._stop.wait(10):
            try:
                # Keep the video above the browser. With no window manager X
                # stacks by map order, so any Chromium restart - which happens
                # on every deploy - buries a perfectly healthy mpv. Raising
                # only at startup would fix it once and lose it again.
                if self._slots:
                    _raise_window()

                with self._lock:
                    for slot in list(self._slots.values()):
                        if self._alive(slot):
                            # A long-running stream needs its signed URL refreshed
                            # before it expires, or it dies mid-evening.
                            if time.time() - slot.resolved_at > RESOLVE_EVERY:
                                log.info("refreshing stream url for widget %s", slot.widget_id)
                                self._kill(slot)
                                slot.resolved_url = ""
                                self._spawn(slot)
                            else:
                                slot.failures = 0
                            continue

                        # Died. Back off, re-resolve, try again.
                        delay = RESTART_BACKOFF[min(slot.failures, len(RESTART_BACKOFF) - 1)]
                        if time.time() - slot.resolved_at < delay:
                            continue
                        if slot.proc and slot.proc.stderr:
                            try:
                                err = slot.proc.stderr.read(500)
                                if err:
                                    slot.last_error = err.decode(errors="replace").strip()
                            except Exception:  # noqa: BLE001
                                pass
                        slot.failures += 1
                        log.warning(
                            "mpv for widget %s exited (attempt %s): %s",
                            slot.widget_id, slot.failures, slot.last_error,
                        )
                        slot.resolved_url = ""      # force a fresh resolve
                        self._spawn(slot)
            except Exception:  # noqa: BLE001
                log.exception("video agent loop error")


def _rotated_size(screen: dict) -> tuple[int, int]:
    """Screen dimensions as the display server sees them after rotation."""
    width = int(screen.get("width") or 1920)
    height = int(screen.get("height") or 1080)
    if screen.get("orientation") in ("left", "right"):
        return height, width
    return width, height


AGENT = VideoAgent()
