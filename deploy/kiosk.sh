#!/usr/bin/env bash
# Launch the display session: X, then Chromium locked to the renderer.
#
# Runs as the unprivileged `lifeboard` user. Everything about this script exists
# to make a browser behave like an appliance for months at a time.
set -euo pipefail

SCREEN_ID="${LIFEBOARD_SCREEN_ID:-1}"
URL="http://127.0.0.1:8080/render/?screen=${SCREEN_ID}"
PROFILE="/var/lib/lifeboard/chrome-profile"

export DISPLAY=:0

# Wait for the server before launching, or Chromium caches a connection-refused
# error page and sits on it forever - the single most common way one of these
# boards comes up blank after a power cut.
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1; then break; fi
  sleep 2
done

# --- screen hygiene -------------------------------------------------------
# Blanking and DPMS are turned OFF here on purpose. Power management is our
# job, driven by the schedule in the admin UI (see display/scheduler.py). If X
# also blanks on its own timer the two fight, and the screen wakes or sleeps at
# times nobody configured.
xset s off
xset s noblank
xset -dpms

# Apply the saved orientation before the browser starts, so the page never
# renders once at the wrong aspect and reflows.
ORIENTATION="$(sqlite3 /var/lib/lifeboard/lifeboard.db \
  "SELECT orientation FROM screens WHERE id=${SCREEN_ID}" 2>/dev/null || echo normal)"
OUTPUT="$(xrandr --query | awk '/ connected/{print $1; exit}')"

if [ -n "${OUTPUT}" ]; then
  # Choose the highest-resolution mode the display offers rather than whatever
  # it calls "preferred". TVs frequently prefer 1366x768 while supporting
  # 1920x1080, and taking the preference at face value costs nearly half the
  # pixels - which, once rotated, shows as a board occupying part of the panel.
  BEST="$(xrandr --query | awk -v out="${OUTPUT}" '
    $1 == out { inblock = 1; next }
    inblock && /^[A-Za-z]/ { inblock = 0 }
    inblock && $1 ~ /^[0-9]+x[0-9]+$/ {
      split($1, wh, "x")
      area = wh[1] * wh[2]
      if (area > best) { best = area; mode = $1 }
    }
    END { print mode }
  ')"

  if [ -n "${BEST}" ]; then
    xrandr --output "${OUTPUT}" --mode "${BEST}" --rotate "${ORIENTATION}" || \
      xrandr --output "${OUTPUT}" --rotate "${ORIENTATION}" || true
  elif [ "${ORIENTATION}" != "normal" ]; then
    xrandr --output "${OUTPUT}" --rotate "${ORIENTATION}" || true
  fi
fi

# Read back what X actually ended up with, rather than assuming the request was
# honoured. The Screen line reads:
#   Screen 0: minimum 320 x 200, current 1080 x 1920, maximum 2048 x 2048
SCREEN_W="$(xrandr --query | awk '/^Screen 0:/ {print $8}')"
SCREEN_H="$(xrandr --query | awk '/^Screen 0:/ {gsub(",", "", $10); print $10}')"
case "${SCREEN_W}${SCREEN_H}" in
  *[!0-9]*|'') SCREEN_W=""; SCREEN_H="" ;;
esac
[ -n "${SCREEN_W}" ] && echo "[kiosk] screen is ${SCREEN_W}x${SCREEN_H} (${ORIENTATION})" 

# Publish the X cookie where the server can read it.
#
# The server runs with ProtectHome=yes and PrivateTmp=yes, which hides both
# places X authorisation normally lives - startx's /tmp/serverauth.XXXXXX and
# ~/.Xauthority. Without a cookie it cannot rotate the screen or place the
# video window, and the failure is silent: connections are simply refused.
#
# /var/lib/lifeboard is already ReadWritePaths for the service, so the cookie
# goes there. Mode 600 and owned by this user - it is a credential for the
# display, and anything holding it can draw on the screen.
XAUTH_PUBLISHED=/var/lib/lifeboard/xauth
SOURCE_AUTH="${XAUTHORITY:-${HOME}/.Xauthority}"
if [ -r "${SOURCE_AUTH}" ]; then
  install -m 600 "${SOURCE_AUTH}" "${XAUTH_PUBLISHED}" 2>/dev/null \
    && echo "[kiosk] published X cookie to ${XAUTH_PUBLISHED}" \
    || echo "[kiosk] WARNING: could not publish the X cookie; the server will not be able to rotate the screen or show video"
else
  echo "[kiosk] WARNING: no readable X cookie at ${SOURCE_AUTH}"
fi

# GPU rasterisation, but only where the GPU can take it.
#
# A Pi 3's VideoCore IV cannot, and it fails by drawing NOTHING - a black page
# with no error anywhere. Chromium's own blocklist already knows this, which
# is why --ignore-gpu-blocklist is applied selectively rather than everywhere:
# overriding that judgement on hardware it correctly excluded is how the board
# went dark.
#
# Nothing is lost by falling back. mpv owns video and decodes in hardware via
# V4L2; the browser draws text and boxes and repaints about once a minute.
MODEL="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unknown)"
case "${MODEL}" in
  *"Raspberry Pi 5"*|*"Raspberry Pi 4"*)
    GPU_FLAGS="--ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy"
    ;;
  *"Raspberry Pi"*)
    # Pi 3, Zero and older: VideoCore IV.
    GPU_FLAGS="--disable-gpu-rasterization --disable-gpu-compositing --num-raster-threads=2"
    echo "[kiosk] ${MODEL}: using software rasterisation (VideoCore IV renders this page black)"
    ;;
  *)
    # x86 and anything unrecognised: Chromium's own defaults plus VA-API.
    GPU_FLAGS="--ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy"
    ;;
esac

# Hide the pointer.
#
# There is no mouse on a wall display, but X still draws a cursor at the centre
# of the screen and it simply sits there on the signage forever. Nothing moves
# it, so nothing ever hides it.
#
# `-idle 0` hides it immediately rather than after the usual few seconds, and
# `-root` makes it apply over the root window too - without that the pointer
# reappears whenever it happens to sit outside a client window. This is classic
# unclutter, which polls; the daemon is trivial and the Pi will not notice it.
if command -v unclutter >/dev/null 2>&1; then
  unclutter -idle 0 -root >/dev/null 2>&1 &
fi

# Chromium leaves these behind after an unclean shutdown (a power cut, which is
# how this device will usually be stopped) and then shows a "restore pages?"
# bubble over the dashboard. Clearing them is the fix.
if [ -f "${PROFILE}/Default/Preferences" ]; then
  sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' \
    "${PROFILE}/Default/Preferences" || true
fi

# The profile singleton lock, for the same reason and then some. Chromium
# records the owner as a `hostname-pid` symlink, and refuses to start when the
# HOSTNAME does not match - reporting the profile is "in use by another
# Chromium process on another computer", which no stale-pid check will clear.
#
# Not hypothetical: renaming this board from `raspberrypi` to `LifeBoard` left
# `SingletonLock -> raspberrypi-892` behind, and on the next boot Chromium
# refused to launch. The session script exited, X tore down with it, and the
# kiosk unit restarted into the same wall ~400 times. The TV showed only the
# video, full-screen and unrotated, because mpv was the one thing left running
# - see video/agent.py for why that half is now impossible too.
#
# Exactly one Chromium ever uses this profile, and it is started from here
# after the pkill in the unit, so any lock present now is by definition stale.
rm -f "${PROFILE}/SingletonLock"       "${PROFILE}/SingletonCookie"       "${PROFILE}/SingletonSocket"

# --kiosk and --start-fullscreen ask a window manager to make the window
# fill the screen, and there is no window manager here on purpose - the display
# is an output, not a computer you can sit at. So the size is stated outright.
# Without this Chromium keeps whatever size it chose at startup and sits in the
# corner of a rotated screen.
GEOMETRY=""
if [ -n "${SCREEN_W}" ] && [ -n "${SCREEN_H}" ]; then
  GEOMETRY="--window-size=${SCREEN_W},${SCREEN_H} --window-position=0,0"
fi

# shellcheck disable=SC2086 - GEOMETRY and GPU_FLAGS are flag lists and must
# word-split rather than being passed as single arguments.
exec chromium \
  --kiosk \
  --app="${URL}" \
  --user-data-dir="${PROFILE}" \
  ${GEOMETRY} \
  --start-fullscreen \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate,TranslateUI,InfiniteSessionRestore \
  --no-first-run \
  --fast-start \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  `# THE audio flag. Without it, a video widget with "Mute audio" turned off` \
  `# silently refuses to start and shows a black box - browsers block unmuted` \
  `# autoplay without a user gesture, and a wall display never has one.` \
  --autoplay-policy=no-user-gesture-required \
  `# Hardware video decode. On an x86 mini PC this is the difference between` \
  `# a YouTube live feed costing 8% CPU and costing a whole core.` \
  --enable-features=VaapiVideoDecoder,VaapiVideoEncoder \
  ${GPU_FLAGS} \
  `# Long-running kiosks accumulate memory in the renderer; this keeps a` \
  `# single-page board from being killed by the OOM reaper after weeks.` \
  --disable-dev-shm-usage \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  --check-for-update-interval=31536000
