"""Turning the screen off and on, and rotating it.

There is no single way to do this, and the difference matters more than it
looks:

* **DPMS** (``xset dpms force off``) stops the video signal. The panel of a
  *monitor* genuinely powers down. Many *TVs*, however, just show "No Signal"
  for a while and then fall back to their own idle behaviour - some sleep,
  some show a blue screen forever, some cycle inputs looking for something
  else. So DPMS alone is not enough for a TV.

* **HDMI-CEC** sends a real "standby" command down the HDMI cable, which is
  what actually turns a TV off and back on, including its backlight. Raspberry
  Pis have CEC on the HDMI port natively. x86 mini PCs almost never do - you
  need a Pulse-Eight USB-CEC adapter (~$50) or a motherboard that exposes it.

Because of that split, the default is ``auto``: use CEC when a CEC adapter is
actually present, and fall back to DPMS when it is not. The admin UI shows
which one was chosen, so a TV that does not fully power off is explainable
rather than mysterious.

Everything here shells out. That is deliberate - these tools are the stable
interface, whereas their libraries are not, and a subprocess that fails is
trivially recoverable where a segfaulting binding is not.
"""

from __future__ import annotations

import functools
import logging
import os
import shutil
import subprocess

log = logging.getLogger("lifeboard.display")

# The kiosk session's X display. The service runs as the same user that owns
# the session, so this is all xset needs.
XDISPLAY = os.environ.get("LIFEBOARD_DISPLAY", ":0")

ORIENTATIONS = {
    "normal": ("normal", "normal"),      # (xrandr rotate, wlr-randr transform)
    "left": ("left", "90"),
    "right": ("right", "270"),
    "inverted": ("inverted", "180"),
}


def _run(cmd: list[str], timeout: float = 15.0) -> tuple[int, str]:
    env = dict(os.environ, DISPLAY=XDISPLAY)
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, env=env
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        return proc.returncode, out.strip()
    except FileNotFoundError:
        return 127, f"{cmd[0]}: not installed"
    except subprocess.TimeoutExpired:
        return 124, f"{cmd[0]}: timed out"
    except Exception as exc:  # noqa: BLE001
        return 1, f"{cmd[0]}: {exc}"


@functools.lru_cache(maxsize=1)
def cec_available() -> bool:
    """Is there a CEC adapter we can actually talk to?

    Cached because it shells out and the answer cannot change without
    replugging hardware, which implies a restart anyway.
    """
    if not shutil.which("cec-client"):
        return False
    code, out = _run(["cec-client", "-l"], timeout=10)
    # `cec-client -l` prints "Found devices: N"; 0 devices means the binary is
    # installed but nothing is plugged in, which is the common x86 case.
    if code != 0:
        return False
    for line in out.splitlines():
        if "found devices:" in line.lower():
            try:
                return int(line.split(":")[-1].strip()) > 0
            except ValueError:
                return False
    return False


def cec_tv_status() -> str:
    """What the TV says about itself: 'on', 'standby' or 'unknown'.

    Deliberately not cached. An adapter cannot appear without a reboot, but a
    TV can: switching Anynet+ on in the menu puts device #0 on the bus while
    the board keeps running, and a cached "unknown" would outlive the fix.

    'unknown' is the interesting answer. It means the command went onto the
    bus and nothing acknowledged it - a TV with CEC turned off, an HDMI
    switch in the way, or a cable that does not carry pin 13.
    """
    if not shutil.which("cec-client"):
        return "unknown"
    code, out = _run(
        ["bash", "-lc", 'echo "pow 0" | cec-client -s -d 1'], timeout=20
    )
    if code != 0:
        return "unknown"
    for line in out.splitlines():
        low = line.lower().strip()
        if low.startswith("power status:"):
            state = low.split(":", 1)[1].strip()
            if state in ("on", "standby"):
                return state
    return "unknown"


CEC_DEAF = (
    "The display did not answer on the CEC bus, so it will not respond to a "
    "scheduled off. Turn HDMI-CEC on in the TV's menu - Samsung calls it "
    "Anynet+, LG SIMPLINK, Sony BRAVIA Sync, Philips EasyLink, Panasonic "
    "VIERA Link, Sharp Aquos Link - and check the board is on an HDMI port "
    "that carries it."
)


def resolve_backend(preference: str = "auto") -> str:
    """Decide what we will actually use. Returns 'cec' | 'dpms' | 'none'."""
    if preference in ("cec", "dpms", "none"):
        return preference
    if cec_available():
        return "cec"
    if shutil.which("xset"):
        return "dpms"
    return "none"


def set_power(on: bool, *, preference: str = "auto", cec_device: str = "0") -> dict:
    """Turn the display on or off. Returns a result dict for the admin UI."""
    backend = resolve_backend(preference)
    actions: list[dict] = []
    error: str | None = None

    if backend == "cec":
        verb = "on" if on else "standby"
        code, out = _run(
            ["bash", "-lc", f'echo "{verb} {cec_device}" | cec-client -s -d 1'],
            timeout=20,
        )
        actions.append({"via": "cec", "cmd": f"{verb} {cec_device}", "code": code, "out": out[:300]})

        # Ask the TV what it thinks happened. cec-client exits 0 whether or
        # not anything is listening, so its exit status only tells us the
        # command was *sent*. This is the difference between "we asked" and
        # "it obeyed", and reporting the first as the second is what makes a
        # display that never switches off look like a scheduler bug.
        status = cec_tv_status()
        actions.append({
            "via": "cec-verify",
            "code": 0 if status != "unknown" else 1,
            "out": f"TV power status: {status}",
        })
        if status == "unknown":
            error = CEC_DEAF

        # Belt and braces: a TV told to stand by will ignore the HDMI signal
        # anyway, but killing DPMS too means a *monitor* on a CEC-capable box
        # still powers down properly - and it is the only thing left when the
        # TV is not listening to CEC at all.
        if shutil.which("xset"):
            # `force off` is silently a no-op while DPMS is disabled, which is
            # how the X server ships. Enable it first or this whole branch has
            # been doing nothing.
            _run(["xset", "s", "off"])
            _run(["xset", "+dpms"] if not on else ["xset", "-dpms"])
            code2, out2 = _run(["xset", "dpms", "force", "on" if on else "off"])
            actions.append({"via": "dpms", "code": code2, "out": out2[:200]})

    elif backend == "dpms":
        # DPMS has to be enabled at all, and the screensaver's own blanking
        # must be off or it fights us and the screen wakes on its own timer.
        _run(["xset", "s", "off"])
        _run(["xset", "-dpms"] if on else ["xset", "+dpms"])
        code, out = _run(["xset", "dpms", "force", "on" if on else "off"])
        actions.append({"via": "dpms", "code": code, "out": out[:300]})

    else:
        return {
            "ok": False,
            "backend": "none",
            "error": "No display control available: install cec-utils for TVs "
                     "or x11-xserver-utils for monitors.",
            "actions": [],
        }

    ok = all(a["code"] == 0 for a in actions) if actions else False
    result = {"ok": ok, "backend": backend, "on": on, "actions": actions}
    if error:
        result["error"] = error
    return result


def halt_board(reboot: bool = False) -> dict:
    """Power the board off, or restart it.

    Deliberately routed through systemctl rather than /sbin/poweroff: systemd
    stops the units in order, so the database gets a clean close rather than
    whatever WAL state a hard halt leaves behind.

    The server runs unprivileged, so this needs the polkit rule that grants
    login1 power-off/reboot to the lifeboard user, and nothing else.
    """
    verb = "reboot" if reboot else "poweroff"
    code, out = _run(["systemctl", verb], timeout=20)
    if code != 0:
        log.error("%s failed: %s", verb, out)
        return {
            "ok": False,
            "action": verb,
            "error": out or f"systemctl {verb} failed",
            "hint": "The polkit rule granting login1 power-off/reboot to the "
                    "lifeboard user may be missing.",
        }
    # systemctl returns as the transition starts, so this is the last thing
    # anyone reads from this process.
    log.warning("board %s requested", verb)
    return {"ok": True, "action": verb}


def set_orientation(orientation: str, output: str | None = None) -> dict:
    """Rotate the display.

    Rotation is a *display server* operation, not a browser one. Doing it in
    CSS inside the page looks right until you hit video: a rotated <video> or
    an iframe gets composited on the unrotated surface and either tears, drops
    to software decode, or renders at the wrong aspect. Rotating the output
    keeps hardware decode intact, which is exactly what the YouTube-live use
    case needs.
    """
    if orientation not in ORIENTATIONS:
        return {"ok": False, "error": f"unknown orientation {orientation!r}"}

    x_rotate, wlr_transform = ORIENTATIONS[orientation]

    if shutil.which("xrandr"):
        target = output or _primary_output()
        if not target:
            return {"ok": False, "error": "could not determine an output to rotate"}
        code, out = _run(["xrandr", "--output", target, "--rotate", x_rotate])
        return {"ok": code == 0, "backend": "xrandr", "output": target, "out": out[:300]}

    if shutil.which("wlr-randr"):
        target = output or _primary_output_wayland()
        if not target:
            return {"ok": False, "error": "could not determine a Wayland output"}
        code, out = _run(["wlr-randr", "--output", target, "--transform", wlr_transform])
        return {"ok": code == 0, "backend": "wlr-randr", "output": target, "out": out[:300]}

    return {"ok": False, "error": "neither xrandr nor wlr-randr is installed"}


def _primary_output() -> str | None:
    code, out = _run(["xrandr", "--query"])
    if code != 0:
        return None
    connected = [ln.split()[0] for ln in out.splitlines() if " connected" in ln]
    for line in out.splitlines():
        if " connected primary" in line:
            return line.split()[0]
    return connected[0] if connected else None


def _primary_output_wayland() -> str | None:
    code, out = _run(["wlr-randr"])
    if code != 0:
        return None
    for line in out.splitlines():
        if line and not line.startswith((" ", "\t")):
            return line.split()[0]
    return None


def status(preference: str = "auto") -> dict:
    """What the admin UI shows on the Display page."""
    backend = resolve_backend(preference)
    powered = None
    if shutil.which("xset"):
        code, out = _run(["xset", "-q"])
        if code == 0:
            for line in out.splitlines():
                low = line.strip().lower()
                if low.startswith("monitor is"):
                    powered = "on" in low
                    break
    return {
        "backend": backend,
        "cec_available": cec_available(),
        "xrandr": bool(shutil.which("xrandr")),
        "wlr_randr": bool(shutil.which("wlr-randr")),
        "powered": powered,
        "outputs": _outputs(),
    }


def _outputs() -> list[str]:
    code, out = _run(["xrandr", "--query"])
    if code != 0:
        return []
    return [ln.split()[0] for ln in out.splitlines() if " connected" in ln]
