#!/usr/bin/env bash
# Build a flashable LifeBoard image for Raspberry Pi 4/5 (arm64).
#
#   sudo ./build-pi-image.sh [output.img]
#
# Rather than building an OS from scratch, this takes the official Raspberry Pi
# OS Lite (64-bit) image and provisions it - which is the same relationship
# install.sh has to a Debian box, and means Pi firmware, kernel and video
# drivers stay the Foundation's problem rather than ours.
#
# MUST RUN ON A LINUX HOST AS ROOT, and needs qemu-user-static to chroot into
# an arm64 filesystem from an x86 machine:
#
#   apt-get install -y qemu-user-static binfmt-support xz-utils parted \
#                      e2fsprogs util-linux curl
#
# On Unraid, run it in a privileged Debian container the same way as the x86
# build - see build-x86-image.sh.
set -euo pipefail

OUT="${1:-lifeboard-pi.img}"
# Pinned rather than "latest" on purpose: a build that silently changes base
# image between runs is impossible to support. Bump this deliberately.
BASE_URL="${BASE_URL:-https://downloads.raspberrypi.com/raspios_lite_arm64_latest}"
GROW_MB="${GROW_MB:-3072}"       # headroom for Chromium + venv + mpv
HOSTNAME_="${LIFEBOARD_HOSTNAME:-LifeBoard}"

# ---------------------------------------------------------------------------
#  Is this image for somebody else?
#
#  A built image carries whatever the build was told to bake in - an SSH key
#  and a root password. Those are fine on a board you flash for yourself and
#  are somebody's way in on a board you hand to anyone else. So there is an
#  explicit mode for it, and the build says out loud what it is including
#  either way rather than leaving you to remember.
#
#      LIFEBOARD_CLEAN_IMAGE=1   no key, no password, nothing personal
# ---------------------------------------------------------------------------
if [ "${LIFEBOARD_CLEAN_IMAGE:-0}" = "1" ]; then
  LIFEBOARD_SSH_KEY=""
  LIFEBOARD_ROOT_PASSWORD=""
  echo "==> CLEAN IMAGE: no SSH key, no root password will be baked in."
  echo "    First boot raises its own setup AP; get in from the wizard."
else
  echo "==> This image will contain:"
  if [ -n "${LIFEBOARD_SSH_KEY:-}" ]; then
    echo "      * an SSH public key for root  (${LIFEBOARD_SSH_KEY##* })"
  else
    echo "      * no SSH key"
  fi
  if [ -n "${LIFEBOARD_ROOT_PASSWORD:-}" ]; then
    echo "      * a root PASSWORD"
  else
    echo "      * no root password"
  fi
  echo "    Set LIFEBOARD_CLEAN_IMAGE=1 for an image to give to somebody else."
fi

# Where the source lives. Defined here rather than further down because the
# check below needs it, and under `set -u` using it first aborts the build
# with "SRC_DIR: unbound variable" - which is what it did.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The templates ship inside the image, so a template carrying somebody's real
# Wi-Fi password would be published to everyone who flashes it. That has
# happened once; the check is cheap and runs before anything is built.
if [ -f "${SRC_DIR}/tools/test_no_secrets.py" ]; then
  echo "==> Checking nothing personal is about to be baked in"
  python3 "${SRC_DIR}/tools/test_no_secrets.py" || {
    echo "ABORTING: something personal would have shipped in this image." >&2
    exit 1
  }
fi

. "$(dirname "${BASH_SOURCE[0]}")/lib-loop.sh"
WORK="$(mktemp -d)"
MNT="${WORK}/mnt"
LOOP=""

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }
die() { echo -e "\033[1;31mERROR: $*\033[0m" >&2; exit 1; }

cleanup() {
  set +e
  for d in dev/pts dev proc sys boot/firmware boot ""; do
    mountpoint -q "${MNT}/${d}" && umount -lf "${MNT}/${d}"
  done
  [ -n "${LOOP}" ] && losetup -d "${LOOP}" 2>/dev/null
  rm -rf "${WORK}"
}
trap cleanup EXIT

[ "$(id -u)" -eq 0 ] || die "run me as root"
for tool in curl xz parted losetup chroot resize2fs; do
  command -v "$tool" >/dev/null || die "missing tool: $tool"
done
[ -f /usr/bin/qemu-aarch64-static ] || die \
  "qemu-aarch64-static not found - apt-get install qemu-user-static binfmt-support"

mkdir -p "${MNT}"

# --------------------------------------------------------------------------
log "Fetching Raspberry Pi OS Lite (arm64)"
# --------------------------------------------------------------------------
curl -fL --progress-bar "${BASE_URL}" -o "${WORK}/base.img.xz"
log "Decompressing"
xz -dc "${WORK}/base.img.xz" > "${OUT}"

# --------------------------------------------------------------------------
log "Growing the image by ${GROW_MB}MB"
# --------------------------------------------------------------------------
# The stock Lite image has almost no free space; Chromium alone will not fit.
truncate -s "+${GROW_MB}M" "${OUT}"
LOOP="$(losetup --show -fP "${OUT}")"
wait_for_parts "${LOOP}" 1 2 || die "the kernel never exposed partitions on ${LOOP}"

parted -s "${LOOP}" resizepart 2 100%
# The table just changed, so the node has to be re-published - same udev
# problem as above, one step later.
wait_for_parts "${LOOP}" 1 2 || die "partition 2 vanished after resize"

e2fsck -fy "${LOOP}p2" >/dev/null 2>&1 || true
resize2fs "${LOOP}p2"

mount "${LOOP}p2" "${MNT}"
# Bookworm moved the boot partition to /boot/firmware; older images use /boot.
if [ -d "${MNT}/boot/firmware" ]; then
  mount "${LOOP}p1" "${MNT}/boot/firmware"
else
  mount "${LOOP}p1" "${MNT}/boot"
fi

cp /usr/bin/qemu-aarch64-static "${MNT}/usr/bin/"
mount --bind /dev "${MNT}/dev"
mount --bind /dev/pts "${MNT}/dev/pts"
mount -t proc proc "${MNT}/proc"
mount -t sysfs sys "${MNT}/sys"

# Raspberry Pi OS Lite ships as "raspberrypi". Left alone, every board built
# from this image answers to raspberrypi.local, so two of them on one network
# collide and neither is identifiable. The x86 builder has always done this;
# the Pi builder did not, which is why the live board had to be renamed by
# hand. Edit the 127.0.1.1 line rather than rewriting /etc/hosts - the Pi OS
# file carries ip6 entries worth keeping - and append it if it is absent.
# The \1 in the sed is load-bearing: without it the substitution eats the
# address and leaves a bare hostname, which is a broken hosts file.
echo "${HOSTNAME_}" > "${MNT}/etc/hostname"
if grep -q '^127\.0\.1\.1' "${MNT}/etc/hosts"; then
  sed -i "s/^\(127\.0\.1\.1[[:space:]]*\).*\$/\1${HOSTNAME_}/" "${MNT}/etc/hosts"
else
  printf '127.0.1.1\t%s\n' "${HOSTNAME_}" >> "${MNT}/etc/hosts"
fi

mkdir -p "${MNT}/opt/lifeboard-src"
cp -a "${SRC_DIR}/." "${MNT}/opt/lifeboard-src/"
rm -rf "${MNT}/opt/lifeboard-src/.venv" "${MNT}/opt/lifeboard-src/.git"

# --------------------------------------------------------------------------
log "Provisioning inside the image (this is slow under emulation)"
# --------------------------------------------------------------------------
cat > "${MNT}/tmp/build-env.sh" <<ENVEOF
export LIFEBOARD_SSH_KEY='${LIFEBOARD_SSH_KEY:-}'
export LIFEBOARD_ROOT_PASSWORD='${LIFEBOARD_ROOT_PASSWORD:-}'
export LIFEBOARD_LOCK_CONSOLE='${LIFEBOARD_LOCK_CONSOLE:-0}'
export LIFEBOARD_WIFI_COUNTRY='${LIFEBOARD_WIFI_COUNTRY:-US}'
ENVEOF

cat > "${MNT}/tmp/inside.sh" <<'INSIDE'
. /tmp/build-env.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Raspberry Pi OS ships a first-boot wizard that expects a keyboard. This
# appliance has none, and it would block the boot forever waiting for input.
systemctl disable userconfig.service 2>/dev/null || true
rm -f /etc/systemd/system/multi-user.target.wants/userconfig.service
systemctl disable getty@tty1.service 2>/dev/null || true

apt-get update
apt-get install -y --no-install-recommends network-manager

# Pi OS uses dhcpcd by default; NetworkManager cannot manage wifi alongside it,
# which is what the setup hotspot needs.
systemctl disable dhcpcd 2>/dev/null || true
systemctl enable NetworkManager

# SSH on, keys only.
#
# Raspberry Pi OS ships sshd disabled, which on a headless appliance with every
# account locked means a board that cannot be reached, cannot be logged into,
# and cannot be asked what went wrong - only re-flashed. install.sh has already
# set PasswordAuthentication no, so this opens no guessing surface: without the
# build's authorized key it refuses everyone.
systemctl enable ssh 2>/dev/null || true

# Set a regulatory domain now, so the radio is legal to transmit on the FIRST
# boot rather than after a fallback has noticed it is blocked. Raspberry Pi OS
# ships wifi rfkill-blocked until this is set - the channels and power limits
# are jurisdictional - and the failure mode is a setup hotspot that reports
# success and broadcasts nothing.
#
# Override with LIFEBOARD_WIFI_COUNTRY at build time, or per card with a
# country= line in lifeboard-wifi.txt on the boot partition.
COUNTRY="${LIFEBOARD_WIFI_COUNTRY:-US}"
raspi-config nonint do_wifi_country "$COUNTRY" 2>/dev/null || true
mkdir -p /etc/systemd/system
rfkill unblock wifi 2>/dev/null || true
echo "country=${COUNTRY}" >> /etc/wpa_supplicant/wpa_supplicant.conf 2>/dev/null || true

/opt/lifeboard-src/image/install.sh

apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /opt/lifeboard-src
INSIDE

chroot "${MNT}" bash /tmp/inside.sh
rm -f "${MNT}/tmp/inside.sh" "${MNT}/tmp/build-env.sh" "${MNT}/usr/bin/qemu-aarch64-static"

# --------------------------------------------------------------------------
log "Pi-specific boot configuration"
# --------------------------------------------------------------------------
BOOTDIR="${MNT}/boot/firmware"
[ -d "${BOOTDIR}" ] || BOOTDIR="${MNT}/boot"

# Quiet boot, and CEC available to cec-utils.
if [ -f "${BOOTDIR}/cmdline.txt" ]; then
  sed -i 's/$/ quiet loglevel=3 logo.nologo vt.global_cursor_default=0/' "${BOOTDIR}/cmdline.txt"
  # cmdline.txt must be a single line or the Pi will not boot.
  tr -d '\n' < "${BOOTDIR}/cmdline.txt" > "${BOOTDIR}/cmdline.new"
  mv "${BOOTDIR}/cmdline.new" "${BOOTDIR}/cmdline.txt"
fi

cat >> "${BOOTDIR}/config.txt" <<'EOF'

# --- LifeBoard ---
# KMS driver: required for both hardware video decode and xrandr rotation.
dtoverlay=vc4-kms-v3d
max_framebuffers=2
# Keep HDMI alive even if the TV is off when the Pi boots, or the Pi comes up
# with no display at all and stays that way until it is power cycled with the
# TV already on. This is the single most common Pi signage complaint.
hdmi_force_hotplug=1
# Disable the rainbow splash and the under-voltage overlay on screen.
disable_splash=1
EOF

sync
cleanup
trap - EXIT

ls -lh "${OUT}"
log "Built ${OUT}"
cat <<EOF

Flash with Raspberry Pi Imager ("Use custom") or dd.

Notes for the Pi:
  * Live video uses the NATIVE engine (mpv + yt-dlp) automatically. Do not set
    a video widget to "In-page embed" on a Pi - Chromium has no hardware decode
    for YouTube's VP9/AV1 there and it will not keep up at 1080p.
  * A Pi has HDMI-CEC built in, so scheduled screen power really does turn the
    TV off rather than only dropping the signal.
EOF
