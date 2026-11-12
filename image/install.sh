#!/usr/bin/env bash
# Turn a minimal Debian (or Raspberry Pi OS Lite) install into a LifeBoard
# appliance. Idempotent - safe to re-run to upgrade.
#
#   sudo ./install.sh
#
# Works on x86-64 Debian 12/13 and arm64 Raspberry Pi OS Bookworm. The only
# architecture-dependent part is which video acceleration packages get pulled
# in; everything else is identical, which is why this is a provisioning script
# rather than a from-scratch OS build.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX=/opt/lifeboard
STATE=/var/lib/lifeboard
USER_NAME=lifeboard

if [ "$(id -u)" -ne 0 ]; then
  echo "Run me with sudo." >&2
  exit 1
fi

ARCH="$(dpkg --print-architecture)"
echo "==> Installing LifeBoard for ${ARCH}"

# --------------------------------------------------------------------------
# Packages
# --------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update

PACKAGES=(
  python3 python3-venv python3-pip
  xserver-xorg xinit x11-xserver-utils   # x11-xserver-utils provides xset/xrandr
  # REQUIRED, and not a recommendation apt will pull in for us. This ships
  # the setuid /usr/lib/xorg/Xorg.wrap, which is the ONLY thing that reads
  # /etc/X11/Xwrapper.config. Without it that config file is inert, Xorg
  # runs unprivileged, and every start dies with
  #   xf86OpenConsole: Cannot open virtual console 7 (Permission denied)
  # which looks like a permissions problem with the user, and is not.
  xserver-xorg-legacy
  chromium
  sqlite3 curl ca-certificates
  fonts-inter fonts-noto-color-emoji     # emoji font, or widget icons render as boxes
  unclutter                              # hides the pointer if one is ever plugged in
  network-manager                        # wifi setup from the web UI + setup hotspot
  dnsmasq-base nftables                  # hotspot DHCP/DNS, and its captive-portal redirect
  # Native video. This is what makes a live stream viable on a Pi: Chromium has
  # no hardware decode for YouTube's VP9/AV1 there, but mpv fed an H.264 stream
  # by yt-dlp does. On x86 it is simply more efficient than the browser.
  mpv
  # Fonts the text widget offers. Without them 'script' and 'serif' silently
  # fall back to the default sans, which looks like the setting did nothing.
  fonts-dejavu fonts-liberation2
  # Build deps for cryptography, used to encrypt OAuth tokens at rest.
  build-essential libssl-dev libffi-dev python3-dev
  # Needed to unblock and configure the radio. On a Raspberry Pi the
  # WLAN is rfkill-blocked until a regulatory domain is set, and without
  # these the setup hotspot reports success while broadcasting nothing.
  rfkill iw wireless-regdb
  # Hides the X pointer, which otherwise sits in the middle of the
  # signage forever - there is no mouse to move it out of the way.
  unclutter
)

apt-get install -y --no-install-recommends "${PACKAGES[@]}"

# --------------------------------------------------------------------------
# Optional extras
#
# Everything here improves the appliance without being required to run it, so
# each is attempted on its own and a missing one is a warning rather than the
# end of the build.
#
# This exists because `libraspberrypi-bin` - which provides vcgencmd, a
# diagnostic convenience - was renamed when Raspberry Pi OS moved to Trixie,
# and it killed a twenty-minute build after the base image had already been
# downloaded, resized and chrooted into. Distributions rename things. An
# appliance that cannot be built when a diagnostic tool changes name is too
# brittle to maintain.
#
# Alternatives are listed newest-first; the first that installs wins.
# --------------------------------------------------------------------------
OPTIONAL=(
  # Restacks the mpv video window above the browser. There is no window
  # manager here by design, so X stacks by map order and mpv's --ontop - a
  # hint to a WM - does nothing. Without this the video plays behind the page
  # after any kiosk restart.
  "xdotool"
  # HDMI-CEC, for actually powering a TV off rather than just blanking it.
  # Without it the display scheduler falls back to DPMS, which most TVs
  # answer with "No Signal" instead of switching off.
  "cec-utils"
)

case "${ARCH}" in
  amd64)
    # Without VA-API a 1080p YouTube live feed burns a whole core in software
    # decode; with it, single digits.
    OPTIONAL+=("intel-media-va-driver-non-free" "mesa-va-drivers" "vainfo")
    ;;
  arm64)
    # vcgencmd and friends. Split into raspi-utils-* on Trixie, one package on
    # Bookworm and earlier.
    OPTIONAL+=("raspi-utils-core raspi-utils-dt|libraspberrypi-bin")
    ;;
esac

for entry in "${OPTIONAL[@]}"; do
  installed=0
  # `|` separates alternatives; a space-separated group is installed together.
  IFS='|' read -ra choices <<< "${entry}"
  for choice in "${choices[@]}"; do
    # shellcheck disable=SC2086 - word splitting is the point for a group.
    if apt-get install -y --no-install-recommends ${choice} >/dev/null 2>&1; then
      echo "    installed: ${choice}"
      installed=1
      break
    fi
  done
  if [ "${installed}" -eq 0 ]; then
    echo "    NOT AVAILABLE: ${entry} - continuing without it"
  fi
done

# yt-dlp moves fast and the distro package is usually far behind - a stale
# yt-dlp is the single most common reason a YouTube URL stops resolving. Take
# it from pip and let the updater keep it current.
python3 -m pip install --break-system-packages --upgrade yt-dlp 2>/dev/null \
  || pip3 install --upgrade yt-dlp \
  || echo "WARNING: yt-dlp install failed; native YouTube playback will not work"

# --------------------------------------------------------------------------
# User and directories
# --------------------------------------------------------------------------
if ! id -u "${USER_NAME}" >/dev/null 2>&1; then
  # No login shell, no password: this account exists to own a display session,
  # not to be signed into.
  useradd --system --create-home --shell /usr/sbin/nologin "${USER_NAME}"
fi
# Needs to be in video/render to drive the GPU, and tty to own vt7.
usermod -aG video,render,tty,input "${USER_NAME}" 2>/dev/null || true

install -d -o "${USER_NAME}" -g "${USER_NAME}" "${STATE}"
install -d "${PREFIX}"

# --------------------------------------------------------------------------
# Application
# --------------------------------------------------------------------------
echo "==> Copying application to ${PREFIX}"
for dir in server web templates deploy; do
  rm -rf "${PREFIX:?}/${dir}"
  cp -a "${REPO_DIR}/${dir}" "${PREFIX}/${dir}"
done
chmod +x "${PREFIX}/deploy/kiosk.sh"

echo "==> Python environment"
python3 -m venv "${PREFIX}/venv"
"${PREFIX}/venv/bin/pip" install --upgrade pip wheel
"${PREFIX}/venv/bin/pip" install -r "${PREFIX}/server/requirements.txt"

chown -R root:root "${PREFIX}"
chown -R "${USER_NAME}:${USER_NAME}" "${STATE}"

# --------------------------------------------------------------------------
# X permissions
#
# Debian ships Xorg so only a console user may start it. The kiosk unit starts
# X from a systemd service, so that restriction has to be relaxed - to
# "anybody", because the lifeboard user is not a console user in the sense
# Xwrapper means.
# --------------------------------------------------------------------------
install -d /etc/X11
cat > /etc/X11/Xwrapper.config <<'EOF'
allowed_users=anybody
needs_root_rights=yes
EOF

# --------------------------------------------------------------------------
# No local access other than the display
#
# Getty on the physical consoles is masked so a keyboard plugged into the box
# gets a blank tty rather than a login prompt.
# --------------------------------------------------------------------------
# DEFAULT CHANGED to 0, deliberately. Masking every getty and locking root's
# password produced an appliance with literally no way in: no console, no
# password, and no SSH key. Diagnosing the first real boot meant shutting the
# machine down and editing its disk from outside.
#
# tty1 now keeps a login prompt. The kiosk owns tty7, so the board is still
# what you see - you have to actively switch VT to reach a console. Set
# LIFEBOARD_LOCK_CONSOLE=1 to get the fully sealed behaviour, but only do that
# once SSH access is proven to work.
if [ "${LIFEBOARD_LOCK_CONSOLE:-0}" = "1" ]; then
  echo "==> Disabling local console logins"
  systemctl mask getty@tty1.service getty@tty2.service getty@tty3.service \
                 getty@tty4.service getty@tty5.service getty@tty6.service \
                 >/dev/null 2>&1 || true
  echo
  echo "  !! Local console logins are now DISABLED."
  echo "  !! SSH is your only way back in. Confirm it works BEFORE you reboot -"
  echo "  !! recovery otherwise means pulling the disk or reflashing."
  echo
else
  echo "==> Leaving a login prompt on tty1 (the board runs on tty7)"
fi

# --------------------------------------------------------------------------
# Recovery access
#
# An appliance you cannot get into is an appliance you cannot fix. Either of
# these can be supplied at build or install time; both are optional, and if
# neither is given the tty1 console above is the way in.
# --------------------------------------------------------------------------
if [ -n "${LIFEBOARD_SSH_KEY:-}" ]; then
  echo "==> Installing the supplied SSH key for root"
  install -d -m 700 /root/.ssh
  echo "${LIFEBOARD_SSH_KEY}" > /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
fi

if [ -n "${LIFEBOARD_ROOT_PASSWORD:-}" ]; then
  echo "==> Setting the root password"
  echo "root:${LIFEBOARD_ROOT_PASSWORD}" | chpasswd
fi

# Keep the journal across reboots.
#
# THIS LIVES HERE, NOT IN A BUILDER, AND THAT IS THE POINT. It was written into
# build-x86-image.sh only, so every Pi ever flashed logged to /run/log/journal -
# tmpfs - and threw its evidence away at each boot. The board halted on
# schedule one night and there was no way to prove it had, because the only
# machine that could say so had wiped the record on the way back up. A fix that
# lives in one of two builders is a fix that is missing from half the fleet;
# install.sh is the one path both of them run.
#
# Storage=persistent rather than the default 'auto': auto only uses
# /var/log/journal if the directory already exists when journald starts, which
# on a fresh image it does not, and journald will not go back and reconsider.
# Capped, because an appliance writing forever will wear out a cheap SD card.
echo "==> Keeping the journal across reboots"
install -d -m 755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/lifeboard.conf <<'JOURNALD'
[Journal]
Storage=persistent
SystemMaxUse=200M
JOURNALD
install -d -m 2755 -o root -g systemd-journal /var/log/journal 2>/dev/null || \
  install -d -m 755 /var/log/journal

# Let the server set the system timezone.
#
# The wizard asks for one and stores it, but the display schedule, the logs and
# every systemd timer run on the OS clock - so without this the board can be
# set to America/New_York while the machine believes it is in London, and
# "screen off at 11pm" happens at six.
#
# A polkit rule rather than a sudo entry: it grants exactly one action to
# exactly one user, and says so in a way that can be read at a glance.
install -d -m 755 /etc/polkit-1/rules.d
cat > /etc/polkit-1/rules.d/50-lifeboard-timedate.rules <<'POLKIT'
// LifeBoard: the dashboard server may set the system timezone, and nothing
// else. The timezone is chosen in the setup wizard and has to reach the OS
// clock, which drives the display schedule and every timer.
polkit.addRule(function (action, subject) {
  if (action.id === "org.freedesktop.timedate1.set-timezone"
      && subject.user === "lifeboard") {
    return polkit.Result.YES;
  }
});
POLKIT

# Halting and restarting the board. Granted separately from the timezone rule
# above so each file says one thing.
#
# 'shutdown_at' in the display schedule needs this: the TV may ignore HDMI-CEC
# entirely, and then the only way to stop being a signal source is for the
# board to stop running. The reboot half is for the admin UI's Restart button.
#
# The *-multiple-sessions variants matter because the kiosk session counts as
# a second session, and without them the grant silently does not apply.
cat > /etc/polkit-1/rules.d/50-lifeboard-power.rules <<'POLKIT'
// LifeBoard: the dashboard server may halt or restart this board, and
// nothing else. It cannot manage other units, users or devices.
polkit.addRule(function (action, subject) {
  if (subject.user !== "lifeboard") { return undefined; }
  switch (action.id) {
    case "org.freedesktop.login1.power-off":
    case "org.freedesktop.login1.power-off-multiple-sessions":
    case "org.freedesktop.login1.reboot":
    case "org.freedesktop.login1.reboot-multiple-sessions":
      return polkit.Result.YES;
  }
});
POLKIT

# Wi-Fi from the setup page. The server runs as a system user with no login
# session, which NetworkManager's default policy refuses outright - so without
# this, scanning, joining a network and raising the setup hotspot all fail
# from the web UI, and the only working way onto Wi-Fi was a file on the boot
# partition.
cat > /etc/polkit-1/rules.d/50-lifeboard-network.rules <<'POLKIT'
// LifeBoard: the dashboard server may scan for Wi-Fi, join a network and run
// its setup hotspot through NetworkManager. Nothing outside NetworkManager.
polkit.addRule(function (action, subject) {
  if (subject.user === "lifeboard"
      && action.id.indexOf("org.freedesktop.NetworkManager.") === 0) {
    return polkit.Result.YES;
  }
});
POLKIT

# Captive portal for the setup hotspot: every name resolves to the board, and
# port 80 is forwarded to the server, so a phone that joins opens the setup
# page by itself.
install -d -m 755 /etc/NetworkManager/dnsmasq-shared.d /etc/NetworkManager/dispatcher.d
install -m 644 "${PREFIX}/deploy/nm-dnsmasq-lifeboard-setup.conf" \
  /etc/NetworkManager/dnsmasq-shared.d/lifeboard-setup.conf
install -m 755 "${PREFIX}/deploy/nm-dispatcher-lifeboard-setup" \
  /etc/NetworkManager/dispatcher.d/90-lifeboard-setup

# Network logins are key-only; a password is for the physical console.
#
# The two are deliberately different privileges. Somebody standing at the
# appliance with a keyboard already has the card and could read it anyway, so a
# console password costs nothing and turns an unrecoverable box into a fixable
# one. Somebody on the network has neither, and should not get a password
# prompt to guess at.
install -d -m 755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/10-lifeboard.conf <<'SSHD'
# LifeBoard: keys only over the network.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSHD

# --------------------------------------------------------------------------
# Services
#
# This script runs in two very different places: on a live machine, and inside
# a chroot while an image is being built. In a chroot there is no running
# systemd, so `daemon-reload` and `restart` fail - and with `set -e` that
# aborts the build after all the slow work is already done. `enable` is fine
# either way because it only writes symlinks.
# --------------------------------------------------------------------------
if [ -d /run/systemd/system ]; then
  IN_CHROOT=0
else
  IN_CHROOT=1
  echo "==> No running systemd (building an image?) - services will be enabled, not started"
fi

echo "==> Installing services"
cp "${PREFIX}/deploy/lifeboard-server.service" /etc/systemd/system/
cp "${PREFIX}/deploy/lifeboard-kiosk.service" /etc/systemd/system/
cp "${PREFIX}/deploy/lifeboard-firstboot.service" /etc/systemd/system/
chmod +x "${PREFIX}/deploy/firstboot.sh"

if [ "${IN_CHROOT}" = "0" ]; then
  systemctl daemon-reload
fi

# `enable` writes symlinks and works with or without systemd running, but it
# still warns loudly in a chroot; --no-reload keeps it quiet there.
systemctl enable lifeboard-server.service lifeboard-kiosk.service                  lifeboard-firstboot.service
# NetworkManager must own the interfaces or nmcli cannot configure wifi. On a
# stock Debian with ifupdown managing eth0, NM refuses to touch it.
systemctl enable NetworkManager >/dev/null 2>&1 || true

# The kiosk unit is WantedBy=graphical.target, so the boot target has to reach
# it. Debian's own default happens to be graphical.target today, which is why
# this has always worked without being said - but the Pi builder fetches
# raspios "latest", so that is an unpinned assumption underneath the single
# thing that makes the board display anything. A base image that changed it
# would give a board that boots, runs the server, answers on the network, and
# shows nothing at all, with no error anywhere to explain it.
systemctl set-default graphical.target >/dev/null 2>&1 || true

if [ "${IN_CHROOT}" = "0" ]; then
  systemctl restart lifeboard-server.service
  # Give the server a moment before the browser starts chasing it.
  sleep 3
  systemctl restart lifeboard-kiosk.service
fi

# --------------------------------------------------------------------------
# Done
# --------------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ "${IN_CHROOT}" = "1" ]; then
  echo
  echo "==> LifeBoard staged into the image. It starts on first boot."
  exit 0
fi
cat <<EOF

==> LifeBoard is installed.

    Admin UI:  http://${IP:-<this-device>}:8080/admin/
    Renderer:  http://${IP:-<this-device>}:8080/render/

    First visit will ask you to set an admin password.

    If this device has no network on a later boot, it raises an open wifi
    called "LifeBoard-Setup" and puts the instructions on the screen. Join it
    from a phone and browse to http://10.42.0.1:8080 to reconfigure.

    Logs:      journalctl -u lifeboard-server -f
               journalctl -u lifeboard-kiosk -f
    Database:  ${STATE}/lifeboard.db

EOF
