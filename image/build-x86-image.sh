#!/usr/bin/env bash
# Build a flashable LifeBoard appliance image for x86-64.
#
#   sudo ./build-x86-image.sh [output.img]
#
# Produces a raw disk image you can write to a USB stick, SATA SSD or NVMe with
# dd / Rufus / balenaEtcher / Raspberry Pi Imager. It boots on both UEFI and
# legacy BIOS, grows its root partition to fill the disk on first boot, and
# comes up on the LifeBoard setup screen.
#
# MUST RUN ON A LINUX HOST AS ROOT. It needs loop devices, chroot and
# debootstrap, none of which exist on Windows or macOS. Unraid works:
#
#   ssh root@tower
#   apt/nix are not present on Unraid, so run it inside a Debian container:
#     docker run --rm -it --privileged -v /path/to/build:/out \
#       -v /path/to/lifeboard:/src debian:bookworm bash
#     apt-get update && apt-get install -y debootstrap parted dosfstools \
#       e2fsprogs grub-efi-amd64-bin grub-pc-bin util-linux zstd
#     /src/image/build-x86-image.sh /out/lifeboard.img
#
# --privileged is required for loop device access.
set -euo pipefail

OUT="${1:-lifeboard-x86.img}"
SIZE_MB="${SIZE_MB:-7168}"          # 7 GiB: Debian + Chromium + venv, with room
SUITE="${SUITE:-bookworm}"
MIRROR="${MIRROR:-http://deb.debian.org/debian}"
HOSTNAME_="${LIFEBOARD_HOSTNAME:-LifeBoard}"

# Same rule as the Pi builder: an image for somebody else must not carry a way
# in that belongs to you. See build-pi-image.sh for the reasoning.
if [ "${LIFEBOARD_CLEAN_IMAGE:-0}" = "1" ]; then
  LIFEBOARD_SSH_KEY=""
  LIFEBOARD_ROOT_PASSWORD=""
  echo "==> CLEAN IMAGE: no SSH key, no root password will be baked in."
else
  echo "==> This image will contain:"
  [ -n "${LIFEBOARD_SSH_KEY:-}" ]     && echo "      * an SSH public key for root  (${LIFEBOARD_SSH_KEY##* })"     || echo "      * no SSH key"
  [ -n "${LIFEBOARD_ROOT_PASSWORD:-}" ]     && echo "      * a root PASSWORD" || echo "      * no root password"
  echo "    Set LIFEBOARD_CLEAN_IMAGE=1 for an image to give to somebody else."
fi

# Where the source lives. Defined here rather than further down because the
# check below needs it, and under `set -u` using it first aborts the build
# with "SRC_DIR: unbound variable" - which is what it did.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "${SRC_DIR}/tools/test_no_secrets.py" ]; then
  echo "==> Checking nothing personal is about to be baked in"
  python3 "${SRC_DIR}/tools/test_no_secrets.py" || {
    echo "ABORTING: something personal would have shipped in this image." >&2
    exit 1
  }
fi

. "$(dirname "${BASH_SOURCE[0]}")/lib-loop.sh"
MNT="$(mktemp -d)"
LOOP=""

log()  { echo -e "\n\033[1;36m==> $*\033[0m"; }
die()  { echo -e "\033[1;31mERROR: $*\033[0m" >&2; exit 1; }

cleanup() {
  set +e
  # Order matters: nested mounts first, or umount refuses and the loop device
  # stays attached, which quietly corrupts the next build.
  for d in dev/pts dev proc sys run boot/efi ""; do
    mountpoint -q "${MNT}/${d}" && umount -lf "${MNT}/${d}"
  done
  [ -n "${LOOP}" ] && losetup -d "${LOOP}" 2>/dev/null
  rmdir "${MNT}" 2>/dev/null
}
trap cleanup EXIT

[ "$(id -u)" -eq 0 ] || die "run me as root"
for tool in debootstrap parted mkfs.ext4 mkfs.vfat losetup chroot; do
  command -v "$tool" >/dev/null || die "missing tool: $tool"
done
[ -d "${SRC_DIR}/server" ] || die "cannot find the lifeboard source at ${SRC_DIR}"

# --------------------------------------------------------------------------
log "Creating ${SIZE_MB}MB image at ${OUT}"
# --------------------------------------------------------------------------
rm -f "${OUT}"
truncate -s "${SIZE_MB}M" "${OUT}"

parted -s "${OUT}" mklabel gpt
# 1MiB BIOS boot partition so the same image also boots on legacy BIOS - a lot
# of cheap mini PCs and anything older than ~2014 still needs it, and finding
# out after you have flashed the drive is miserable.
parted -s "${OUT}" mkpart bios_grub 1MiB 2MiB
parted -s "${OUT}" set 1 bios_grub on
parted -s "${OUT}" mkpart ESP fat32 2MiB 514MiB
parted -s "${OUT}" set 2 esp on
parted -s "${OUT}" mkpart root ext4 514MiB 100%

LOOP="$(losetup --show -fP "${OUT}")"
log "Loop device ${LOOP}"

wait_for_parts "${LOOP}" 1 2 3 || die "the kernel never exposed partitions on ${LOOP}"
# FAT volume labels are hard-capped at 11 characters; anything longer is a
# hard error, not a truncation.
mkfs.vfat -F32 -n LIFEBOARD "${LOOP}p2" >/dev/null
mkfs.ext4 -q -L lifeboard-root "${LOOP}p3"

mount "${LOOP}p3" "${MNT}"
mkdir -p "${MNT}/boot/efi"
mount "${LOOP}p2" "${MNT}/boot/efi"

# --------------------------------------------------------------------------
log "debootstrap ${SUITE}"
# --------------------------------------------------------------------------
debootstrap --arch=amd64 \
  --include=systemd-sysv,locales,ca-certificates,sudo,openssh-server \
  "${SUITE}" "${MNT}" "${MIRROR}"

# --------------------------------------------------------------------------
log "Base configuration"
# --------------------------------------------------------------------------
echo "${HOSTNAME_}" > "${MNT}/etc/hostname"
cat > "${MNT}/etc/hosts" <<EOF
127.0.0.1   localhost
127.0.1.1   ${HOSTNAME_}
::1         localhost ip6-localhost ip6-loopback
EOF

cat > "${MNT}/etc/apt/sources.list" <<EOF
deb ${MIRROR} ${SUITE} main contrib non-free non-free-firmware
deb ${MIRROR} ${SUITE}-updates main contrib non-free non-free-firmware
deb http://security.debian.org/debian-security ${SUITE}-security main contrib non-free non-free-firmware
EOF

ROOT_UUID="$(blkid -s UUID -o value "${LOOP}p3")"
EFI_UUID="$(blkid -s UUID -o value "${LOOP}p2")"
cat > "${MNT}/etc/fstab" <<EOF
UUID=${ROOT_UUID}  /          ext4  defaults,noatime  0 1
UUID=${EFI_UUID}   /boot/efi  vfat  umask=0077        0 1
# /tmp in RAM: an appliance that writes constantly will kill a cheap USB stick.
# /var/log is deliberately NOT tmpfs - logs that vanish on reboot make the
# first real boot impossible to diagnose, which is exactly when you need them.
# The journal is capped instead, which gets the same wear protection without
# throwing the evidence away.
tmpfs              /tmp       tmpfs defaults,noatime,nosuid,size=128m 0 0
EOF

# Copy the application in before chrooting so install.sh is available inside.
mkdir -p "${MNT}/opt/lifeboard-src"
cp -a "${SRC_DIR}/." "${MNT}/opt/lifeboard-src/"
rm -rf "${MNT}/opt/lifeboard-src/.venv" "${MNT}/opt/lifeboard-src/.git"

mount --bind /dev "${MNT}/dev"
mount --bind /dev/pts "${MNT}/dev/pts"
mount -t proc proc "${MNT}/proc"
mount -t sysfs sys "${MNT}/sys"

# --------------------------------------------------------------------------
log "Installing inside the image"
# --------------------------------------------------------------------------
# Build-time settings are handed over in a file rather than by expanding the
# heredoc below. An expanding heredoc would also substitute every $ in the
# guest script - including inside the nested growroot heredoc - which is a
# genuinely nasty way to corrupt a script that then fails at first boot.
cat > "${MNT}/tmp/build-env.sh" <<ENVEOF
export ROOT_UUID='${ROOT_UUID}'
export LIFEBOARD_SSH_KEY='${LIFEBOARD_SSH_KEY:-}'
export LIFEBOARD_ROOT_PASSWORD='${LIFEBOARD_ROOT_PASSWORD:-}'
export LIFEBOARD_LOCK_CONSOLE='${LIFEBOARD_LOCK_CONSOLE:-0}'
ENVEOF

cat > "${MNT}/tmp/inside.sh" <<'INSIDE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
. /tmp/build-env.sh

apt-get update
apt-get install -y --no-install-recommends \
  linux-image-amd64 firmware-linux-free firmware-misc-nonfree \
  grub-efi-amd64 grub-pc-bin grub2-common efibootmgr \
  parted cloud-guest-utils \
  network-manager wireless-tools wpasupplicant

# The appliance itself.
/opt/lifeboard-src/image/install.sh

# GRUB. Installed for BOTH firmware types from one image: --removable puts the
# EFI binary at the fallback path so it boots on machines that will not accept
# a new NVRAM entry (most mini PCs booting from USB), and the i386-pc install
# covers legacy BIOS.
grub-install --target=x86_64-efi --efi-directory=/boot/efi --removable --no-nvram
grub-install --target=i386-pc "$(findmnt -no SOURCE / | sed 's/p\?[0-9]*$//')" || true

sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=1/' /etc/default/grub
# quiet + no console spam: the screen should show the board, not kernel log.
sed -i 's|^GRUB_CMDLINE_LINUX_DEFAULT=.*|GRUB_CMDLINE_LINUX_DEFAULT="quiet loglevel=3 vt.global_cursor_default=0"|' /etc/default/grub

# grub-mkconfig writes root=UUID=... only if /dev/disk/by-uuid/<uuid> exists.
# That directory is maintained by udev, which does not run in a build
# container, so 10_linux quietly falls back to the DEVICE PATH - baking the
# build host's loop device into the boot config:
#
#   linux /boot/vmlinuz-... root=/dev/loop4p3 ro quiet
#
# The image then boots on real hardware to "ALERT! /dev/loop4p3 does not
# exist. Dropping to a shell!" because of course it does not. Provide the
# symlink so the normal UUID path is taken.
mkdir -p /dev/disk/by-uuid
ln -sf "$(findmnt -no SOURCE /)" "/dev/disk/by-uuid/${ROOT_UUID}"

update-grub

# Then verify it, because this failure is invisible until the image is on
# hardware. Rewrite anything that still names a loop device, and refuse to
# ship an image whose boot config points at a device that will not exist.
sed -i "s|root=/dev/loop[0-9]*p[0-9]*|root=UUID=${ROOT_UUID}|g" /boot/grub/grub.cfg
if grep -q 'root=/dev/loop' /boot/grub/grub.cfg; then
  echo "ERROR: grub.cfg still references a loop device" >&2
  grep -n 'root=' /boot/grub/grub.cfg >&2
  exit 1
fi
grep -q "root=UUID=${ROOT_UUID}" /boot/grub/grub.cfg   || { echo "ERROR: grub.cfg does not boot the root UUID" >&2; exit 1; }
echo "grub.cfg boots UUID=${ROOT_UUID}"

# Lock root ONLY when nothing else provides a way in. This used to run
# unconditionally, several steps after install.sh - silently undoing the
# password install.sh had just set and making LIFEBOARD_ROOT_PASSWORD a no-op.
if [ -n "${LIFEBOARD_ROOT_PASSWORD:-}" ]; then
  echo "Root password set; leaving the account unlocked"
elif [ -n "${LIFEBOARD_SSH_KEY:-}" ]; then
  # A key is enough to get in, and a locked password still permits key login.
  passwd -l root
  echo "Root password locked; SSH key is the way in"
else
  passwd -l root
  echo "Root password locked; the tty1 console is the way in"
fi
mkdir -p /root/.ssh && chmod 700 /root/.ssh
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl enable ssh

# Grow the root filesystem to fill whatever disk this was flashed onto. Without
# this the appliance is stuck at the 7GB the image was built as, however big
# the drive is.
# (Journal persistence moved to image/install.sh, which BOTH builders run -
# it lived here alone, so every Pi image shipped without it.)

cat > /usr/local/sbin/lifeboard-growroot <<'GROW'
#!/bin/sh
set -e
ROOT_DEV="$(findmnt -no SOURCE /)"
DISK="$(lsblk -no PKNAME "$ROOT_DEV")"
PART="$(echo "$ROOT_DEV" | grep -o '[0-9]*$')"
[ -n "$DISK" ] && [ -n "$PART" ] || exit 0
growpart "/dev/$DISK" "$PART" || true
resize2fs "$ROOT_DEV" || true
GROW
chmod +x /usr/local/sbin/lifeboard-growroot

cat > /etc/systemd/system/lifeboard-growroot.service <<'UNIT'
[Unit]
Description=Grow the root filesystem to fill the disk
After=local-fs.target
ConditionPathExists=!/var/lib/lifeboard/.grown

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/lifeboard-growroot
ExecStartPost=/bin/sh -c 'mkdir -p /var/lib/lifeboard && touch /var/lib/lifeboard/.grown'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
systemctl enable lifeboard-growroot.service

apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /opt/lifeboard-src
INSIDE

chroot "${MNT}" bash /tmp/inside.sh
rm -f "${MNT}/tmp/inside.sh" "${MNT}/tmp/build-env.sh"

# --------------------------------------------------------------------------
log "Finishing"
# --------------------------------------------------------------------------
# Zero the free space so the image compresses to something sendable.
dd if=/dev/zero of="${MNT}/ZEROFILL" bs=1M status=none 2>/dev/null || true
rm -f "${MNT}/ZEROFILL"
sync

cleanup
trap - EXIT

ls -lh "${OUT}"
log "Built ${OUT}"
cat <<EOF

Flash it:
  Linux/macOS : sudo dd if=${OUT} of=/dev/sdX bs=4M status=progress conv=fsync
  Windows     : Rufus, balenaEtcher, or Raspberry Pi Imager ("Use custom")

First boot:
  * If there is an Ethernet cable, it comes up on DHCP and the screen shows
    the admin address.
  * If not, it raises an open wifi called "LifeBoard-Setup" and puts the join
    instructions and a QR code on the screen. Connect a phone and browse to
    http://10.42.0.1:8080

Compress for transfer:
  zstd -19 --long=27 ${OUT} -o ${OUT}.zst
EOF
