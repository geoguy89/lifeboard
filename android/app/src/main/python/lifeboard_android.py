"""Start the LifeBoard server inside the Android app.

This is the only Python written for Android. Everything below it is the same
`lifeboard` package the Pi and the x86 image run, unmodified - which is the
whole point: an APK that carried a fork of the server would drift from it
within a week.

WHAT ANDROID CHANGES, AND WHY NONE OF IT NEEDS A FORK
------------------------------------------------------
Every path the server uses is already an environment override, so redirecting
it into the app's private storage is configuration rather than code. The three
things it shells out to - nmcli, mpv, xrandr - are absent here, and each was
already written to degrade:

  * `nmcli`     LIFEBOARD_NETWORK=managed tells the server that something else
                owns the network. Without it `status()` reports offline and the
                board sits on the "join LifeBoard-Setup" screen forever, on a
                device that was on the wifi the entire time.
  * `mpv`       `native_video` is simply false, so video widgets use the
                browser player instead of cutting a hole for an overlay window
                that will never appear.
  * `xrandr`,
    HDMI-CEC    Rotation is an Android setting and a normal app cannot power a
                TV off. The scheduler finds no backend and does nothing.
"""

import os
import threading


def _configure(files_dir, web_dir, templates_dir):
    """Point the server at the app's private storage.

    setdefault throughout: anything already set - by a developer running this
    under adb, say - wins over these.
    """
    os.environ.setdefault("LIFEBOARD_DB", os.path.join(files_dir, "lifeboard.db"))
    os.environ.setdefault("LIFEBOARD_KEY", os.path.join(files_dir, "secret.key"))
    os.environ.setdefault("LIFEBOARD_MEDIA", os.path.join(files_dir, "media"))
    os.environ.setdefault("LIFEBOARD_WEB", web_dir)
    os.environ.setdefault("LIFEBOARD_TEMPLATES", templates_dir)
    os.environ.setdefault("LIFEBOARD_NETWORK", "managed")

    # A writable HOME. Several libraries expect one and Android does not set it;
    # certifi and httpx are fine, but anything that tries to write a cache to
    # "~" fails in a way that reads like a permissions bug.
    os.environ.setdefault("HOME", files_dir)

    for path in (os.environ["LIFEBOARD_MEDIA"],):
        os.makedirs(path, exist_ok=True)


_server = None
_error = None


def start(files_dir, web_dir, templates_dir, port):
    """Run uvicorn until stop() is called. Blocks - call it from a thread."""
    global _server, _error
    try:
        _configure(files_dir, web_dir, templates_dir)

        import uvicorn
        from lifeboard.main import app

        config = uvicorn.Config(
            app,
            # NOT 127.0.0.1. The board itself is local, but the admin is meant
            # to be opened from a laptop - configuring a wall display through a
            # TV's on-screen keyboard is miserable, and this is the same
            # arrangement the Pi has.
            host="0.0.0.0",
            port=int(port),
            log_level="info",
            # The access log is one line per widget poll, forever, into logcat.
            access_log=False,
            # uvloop and httptools are C extensions with no Android wheels; the
            # pure-Python implementations are what Chaquopy can carry, and for
            # one browser on the same device the difference is not measurable.
            loop="asyncio",
            http="h11",
        )
        _server = uvicorn.Server(config)

        # Signal handlers can only be installed on the main thread, and this is
        # not it. Uvicorn would raise ValueError before ever binding the port,
        # which surfaces as "the board never starts" with nothing in the log
        # that points at signals.
        _server.install_signal_handlers = lambda: None

        _server.run()
    except BaseException as failure:      # noqa: BLE001 - reported to Java
        import traceback
        _error = traceback.format_exc()
        raise


def stop():
    if _server is not None:
        _server.should_exit = True


def last_error():
    return _error or ""


def is_serving():
    return bool(_server is not None and getattr(_server, "started", False))
