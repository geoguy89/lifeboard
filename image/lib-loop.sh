# Shared loop-device helpers for the image builders.
#
# Everything here exists because a build container has no udev. That single
# fact has broken this project's builds twice in different disguises, so the
# handling lives in one place rather than being re-derived per script.

# Wait for the partition device nodes of a loop device to appear.
#
# `losetup -P` asks the kernel to scan the partition table, but publishing the
# /dev nodes is udev's job. In a container nothing does it, so whether the next
# command works comes down to timing: the first x86 build won that race and the
# second lost it, dying on
#   mkfs.vfat: unable to open /dev/loop4p2: No such file or directory
#
# Poll, nudge with partprobe, and finally create the nodes by hand from the
# major:minor the kernel already publishes under /sys/block.
#
# Usage: wait_for_parts /dev/loopN 1 2 3
wait_for_parts() {
  local loop="$1"; shift
  local parts=("$@")
  local last="${parts[${#parts[@]}-1]}"
  local n base sysfs devno

  for _ in $(seq 1 50); do
    [ -b "${loop}p${last}" ] && break
    partprobe "${loop}" 2>/dev/null || true
    sleep 0.2
  done

  base="$(basename "${loop}")"
  for n in "${parts[@]}"; do
    [ -b "${loop}p${n}" ] && continue
    sysfs="/sys/block/${base}/${base}p${n}/dev"
    [ -r "${sysfs}" ] || continue
    devno="$(cat "${sysfs}")"
    mknod "${loop}p${n}" b "${devno%%:*}" "${devno##*:}"
  done

  for n in "${parts[@]}"; do
    [ -b "${loop}p${n}" ] || return 1
  done
}
