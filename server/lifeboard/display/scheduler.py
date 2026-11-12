"""The on/off timer.

A background thread ticks once a minute, works out whether the screen *should*
be on right now, and only acts when that differs from what it last set. Two
reasons it is edge-triggered rather than level-triggered:

* CEC is slow and chatty. Sending "standby" every 60 seconds all night would
  flood the bus and, on some TVs, override the remote if someone deliberately
  turned it on.
* A manual override from the admin UI has to survive. If you turn the screen
  on at 2am to look at something, the scheduler must not stomp it back off
  sixty seconds later - it should leave it alone until the next scheduled
  *transition*.

Overnight windows are the case people get wrong: on 18:00 / off 02:00 is a
perfectly normal request and means "on across midnight", not "off all day".
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, time as dtime, timezone
from zoneinfo import ZoneInfo

from .. import db
from . import control

log = logging.getLogger("lifeboard.scheduler")

TICK_SECONDS = 60


def _parse_hhmm(text: str) -> dtime:
    hh, _, mm = text.partition(":")
    return dtime(int(hh or 0), int(mm or 0))


def _in_window(now: datetime, on_at: dtime, off_at: dtime) -> bool:
    """Is `now` inside the on-window?

    on < off  -> a normal daytime window (07:00 to 23:00)
    on > off  -> the window crosses midnight (18:00 to 02:00)
    on == off -> always on; treating it as a zero-length window would mean a
                 user who sets both to the same value gets a screen that never
                 comes on, which reads as broken.
    """
    current = now.time()
    if on_at == off_at:
        return True
    if on_at < off_at:
        return on_at <= current < off_at
    return current >= on_at or current < off_at


# How long an 'off_at' rule asserts itself. Long enough that a tick cannot
# miss it, short enough that it is an instruction at a moment rather than a
# standing order that argues with anyone turning the TV on later.
OFF_AT_WINDOW_MIN = 5


def _within_minutes(now: datetime, target: dtime, minutes: int) -> bool:
    """Is `now` within `minutes` after `target`, on the same day?"""
    at = now.replace(hour=target.hour, minute=target.minute,
                     second=0, microsecond=0)
    delta = (now - at).total_seconds()
    return 0 <= delta < minutes * 60


def desired_state(screen_id: int, now: datetime) -> bool | None:
    """True = should be on, False = should be off, None = no rule applies.

    With several rules on one screen, ANY matching on-window wins. Union rather
    than intersection: rules are how you say "on in the mornings, and also for
    Sunday evenings", and intersecting those would give you nothing.
    """
    rules = db.query(
        "SELECT * FROM power_rules WHERE screen_id = ? AND enabled = 1", (screen_id,)
    )
    if not rules:
        return None

    weekday = now.weekday()  # Monday == 0, matching the stored convention
    applied = False
    off_now = False

    for rule in rules:
        days = {int(d) for d in str(rule["days"]).split(",") if d.strip().isdigit()}
        if weekday not in days:
            continue

        mode = rule["mode"] if "mode" in rule.keys() else "window"

        if mode == "shutdown_at":
            # Handled separately: halting the board is not a statement about
            # what the screen should be doing, and falling through to the
            # window branch would read it as "on 07:00 to 23:00".
            continue

        if mode == "off_at":
            # Turn off at the time, and hold no opinion for the rest of the
            # day. For a device powered BY the display there is nothing left
            # running to turn it back on, so an on-window is unreachable - and
            # a standing "should be off" would fight the person who walks in
            # and switches the TV on in the morning.
            if _within_minutes(now, _parse_hhmm(rule["off_time"]), OFF_AT_WINDOW_MIN):
                off_now = True
            continue

        applied = True
        if _in_window(now, _parse_hhmm(rule["on_time"]), _parse_hhmm(rule["off_time"])):
            return True

    if off_now:
        return False
    # Rules existed for today but none put us inside an on-window.
    return False if applied else None


def shutdown_due(screen_id: int, now: datetime) -> bool:
    """Is a 'shutdown_at' rule asking the board to halt right now?"""
    rules = db.query(
        "SELECT * FROM power_rules WHERE screen_id = ? AND enabled = 1", (screen_id,)
    )
    weekday = now.weekday()
    for rule in rules:
        if (rule["mode"] if "mode" in rule.keys() else "window") != "shutdown_at":
            continue
        days = {int(d) for d in str(rule["days"]).split(",") if d.strip().isdigit()}
        if weekday not in days:
            continue
        if _within_minutes(now, _parse_hhmm(rule["off_time"]), OFF_AT_WINDOW_MIN):
            return True
    return False


class PowerScheduler:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        # What the scheduler last *set*, per screen. None means "never acted",
        # so the first tick after boot always asserts a state.
        self._last_set: dict[int, bool] = {}
        # Set by the admin UI. Suppresses the scheduler until the next
        # transition so a manual override is not immediately undone.
        self._override: dict[int, bool] = {}
        # The date a shutdown was last requested. Normally the board is gone
        # a few seconds later and this never matters, but if the halt is
        # refused - a missing polkit rule - this stops it being retried, and
        # logged, every sixty seconds until morning.
        self._halted_on: str | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="power-scheduler", daemon=True)
        self._thread.start()
        log.info("power scheduler started")

    def stop(self) -> None:
        self._stop.set()

    def note_manual(self, screen_id: int, on: bool) -> None:
        """Record that a human just set the power state by hand."""
        self._override[screen_id] = on
        self._last_set[screen_id] = on

    def _tz(self):
        """Same reasoning as main._tz: the last resort must need no database.

        This one runs on a timer thread, so a raise here does not return a 500
        - it kills the power scheduler silently and the board simply never
        turns its screen off again, which is a far harder failure to notice.
        """
        try:
            return ZoneInfo(db.get_setting("timezone", "UTC"))
        except Exception:  # noqa: BLE001
            try:
                return ZoneInfo("UTC")
            except Exception:  # noqa: BLE001
                return timezone.utc

    def _loop(self) -> None:
        while not self._stop.wait(TICK_SECONDS):
            try:
                self.tick()
            except Exception:  # noqa: BLE001
                log.exception("power scheduler tick failed")

    def tick(self, now: datetime | None = None) -> None:
        now = now or datetime.now(self._tz())
        preference = db.get_setting("display_backend", "auto")
        cec_device = db.get_setting("cec_device", "0")

        for screen in db.query("SELECT id FROM screens"):
            sid = screen["id"]

            # Checked before the power logic: if the board is about to halt,
            # what the screen should be showing is moot.
            today = now.date().isoformat()
            if self._halted_on != today and shutdown_due(sid, now):
                self._halted_on = today
                log.warning("screen %s: scheduled shutdown, halting the board", sid)
                control.halt_board()
                return

            want = desired_state(sid, now)
            if want is None:
                continue

            last = self._last_set.get(sid)
            if last is not None and want == last:
                continue  # already in the right state, say nothing

            # A manual override is cleared by the next genuine transition,
            # which is exactly when the user would expect the schedule to
            # resume control.
            self._override.pop(sid, None)

            result = control.set_power(want, preference=preference, cec_device=cec_device)
            self._last_set[sid] = want
            log.info(
                "screen %s -> %s via %s (ok=%s)",
                sid, "ON" if want else "OFF", result.get("backend"), result.get("ok"),
            )
            # A display that ignored us is the thing worth finding in the
            # journal later, so say so rather than leaving an ok=False to be
            # inferred from a line that otherwise reads like success.
            if result.get("error"):
                log.warning("screen %s: %s", sid, result["error"])


SCHEDULER = PowerScheduler()
