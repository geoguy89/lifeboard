#!/usr/bin/env bash
# Bring up the setup hotspot when the appliance has no network.
#
# Runs on every boot, not just the first: a device that is moved to a new house,
# or whose Wi-Fi password changes, has exactly the same problem as one out of
# the box, and would otherwise be permanently unreachable with no way to fix it.
set -uo pipefail

GRACE=${LIFEBOARD_NET_GRACE:-45}     # seconds to wait for a normal connection
HOTSPOT=lifeboard-setup
SSID=LifeBoard-Setup

# --------------------------------------------------------------------------
# Log somewhere a person can actually reach.
#
# This appliance has no keyboard login (every account is locked by design) and
# may have no network - which is precisely the situation in which someone needs
# to know what went wrong. The journal is invisible in that state.
#
# The FAT boot partition is the one surface readable from any other computer:
# power off, pull the card, open it in Windows. So everything is mirrored to a
# file there, and the file is truncated at each boot so it reflects THIS boot
# rather than growing forever on a device nobody prunes.
# --------------------------------------------------------------------------
BOOTLOG=""
for d in /boot/firmware /boot; do
  if [ -d "$d" ] && [ -w "$d" ]; then BOOTLOG="$d/lifeboard-log.txt"; break; fi
done
if [ -n "$BOOTLOG" ]; then
  {
    echo "LifeBoard first-boot log"
    echo "Booted: $(date 2>/dev/null)"
    echo "This file is rewritten on every boot. Safe to delete."
    echo "---"
  } > "$BOOTLOG" 2>/dev/null || BOOTLOG=""
fi

log() {
  echo "[firstboot] $*"
  [ -n "$BOOTLOG" ] && echo "$(date '+%H:%M:%S' 2>/dev/null) $*" >> "$BOOTLOG" 2>/dev/null
  return 0
}

# --------------------------------------------------------------------------
# Give this board its own SSH identity.
#
# Host keys generated during the image build are baked into the .img, so every
# board ever flashed from it answers with the SAME identity - two boards on one
# network are indistinguishable to SSH, and anyone holding a copy of the image
# holds their private host keys. First boot is the moment to fix it, because it
# is the last moment before anyone has recorded a fingerprint.
#
# The marker lives beside the keys rather than on the boot partition, so a card
# imaged FROM a running board does not inherit that board's identity either.
# --------------------------------------------------------------------------
regenerate_host_keys() {
  [ -e /etc/ssh/lifeboard-keys-generated ] && return 0
  command -v ssh-keygen >/dev/null 2>&1 || return 0

  log "generating this board's own SSH host keys"
  rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub
  # -A makes exactly the key types this build of sshd supports, and only the
  # ones that are missing.
  if ssh-keygen -A >/dev/null 2>&1; then
    touch /etc/ssh/lifeboard-keys-generated
    # Restarting is not optional: sshd read the OLD keys at startup and will
    # keep presenting them until it is told otherwise. A fix that only takes
    # effect on the NEXT boot is the same silent no-op this project keeps
    # producing.
    systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
    log "host keys regenerated: $(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{print $2}')"
  else
    log "ERROR: ssh-keygen -A failed; this board still has the image's host keys"
  fi
}

regenerate_host_keys

# NetworkManager's unit being "started" does not mean the wifi radio has been
# detected and taken under management; nmcli issued in that window fails
# because the device is not there yet. Wait for the hardware, not the service.
wait_for_wifi_device() {
  local i
  for i in $(seq 1 30); do
    if nmcli -t -f TYPE device status 2>/dev/null | grep -q '^wifi$'; then
      log "wifi device present after ${i}s"
      return 0
    fi
    sleep 1
  done
  log "no wifi device appeared after 30s"
  return 1
}

# --------------------------------------------------------------------------
# Make the radio legal to use.
#
# Raspberry Pi OS soft-blocks wifi via rfkill until a country is set: the
# permitted channels and transmit power are jurisdictional, so the radio must
# not transmit before it knows where it is. Nothing warns loudly - the
# interface is present, so every "have we got wifi?" check passes, and the
# hotspot silently never appears.
#
# The country comes from whatever is already configured, else the boot file,
# else the build-time default. A wrong-but-set country still gives a working
# radio; an unset one gives none at all.
# --------------------------------------------------------------------------
enable_radio() {
  local country="${1:-}"

  if [ -z "$country" ]; then
    country="$(iw reg get 2>/dev/null | awk '/country/ {print $2; exit}' | tr -d ':')"
  fi
  case "$country" in ''|00) country="${LIFEBOARD_WIFI_COUNTRY:-US}" ;; esac

  if command -v raspi-config >/dev/null 2>&1; then
    raspi-config nonint do_wifi_country "$country" >/dev/null 2>&1 || true
  fi
  iw reg set "$country" >/dev/null 2>&1 || true

  rfkill unblock wifi >/dev/null 2>&1 || true
  rfkill unblock all  >/dev/null 2>&1 || true
  nmcli radio wifi on >/dev/null 2>&1 || true

  # The interface needs a moment after being unblocked before it can be used.
  local i
  for i in 1 2 3 4 5; do
    if rfkill list wifi 2>/dev/null | grep -q 'Soft blocked: no'; then break; fi
    sleep 1
  done

  if rfkill list wifi 2>/dev/null | grep -q 'Soft blocked: yes'; then
    log "WARNING: wifi is still rfkill-blocked; the hotspot cannot be raised"
    return 1
  fi
  log "wifi radio enabled (regulatory domain ${country})"
  return 0
}

have_link() {
  # A real connection means an active wifi/ethernet profile that is not our own
  # hotspot. `nmcli networking connectivity` is not enough - it reports "full"
  # while the hotspot is up, because the device can talk to whatever joined it.
  nmcli -t -f TYPE,STATE,CONNECTION device status 2>/dev/null \
    | awk -F: -v hs="$HOTSPOT" \
      '($1=="wifi"||$1=="ethernet") && $2 ~ /^connected/ && $3!=hs && $3!="--" {found=1}
       END{exit !found}'
}

if ! command -v nmcli >/dev/null 2>&1; then
  log "NetworkManager not installed; nothing to do"
  exit 0
fi

# --------------------------------------------------------------------------
# Credentials left on the boot partition
#
# Checked before the grace period, so a card prepared this way joins the
# network immediately instead of waiting out the timeout first.
#
# Format is one key per line, and both spellings of the obvious keys are
# accepted because people will write whichever they think of:
#
#   ssid=MyNetwork
#   password=hunter2
#   country=US            # optional; some radios stay dark without it
#   hidden=yes            # optional
# --------------------------------------------------------------------------
apply_boot_wifi() {
  local file found=0

  # Say what was looked for and what was there. A file saved as
  # "lifeboard-wifi.txt.txt" - which is what Notepad does unless the name is
  # quoted - is otherwise indistinguishable from no file at all.
  for file in /boot/firmware /boot; do
    [ -d "$file" ] || continue
    log "looking for wifi settings in $file:"
    for f in "$file"/*.txt "$file"/*.TXT; do
      [ -e "$f" ] && log "    found: $(basename "$f")"
    done
  done

  for file in /boot/firmware/lifeboard-wifi.txt /boot/lifeboard-wifi.txt; do
    [ -f "$file" ] || continue
    found=1
    log "found Wi-Fi settings at $file"

    local ssid="" psk="" country="" hidden=""
    local key value line
    while IFS= read -r line || [ -n "$line" ]; do
      # Tolerate CRLF: this file is written on Windows more often than not,
      # and a trailing \r silently corrupts every value.
      line="${line%$'\r'}"
      case "$line" in ''|'#'*) continue ;; esac
      key="${line%%=*}"; value="${line#*=}"
      key="$(echo "$key" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
      case "$key" in
        ssid|network|name)      ssid="$value" ;;
        password|psk|pass|key)  psk="$value" ;;
        country|cc)             country="$value" ;;
        hidden)                 hidden="$value" ;;
      esac
    done < "$file"

    if [ -z "$ssid" ]; then
      log "no ssid= line in $file; ignoring it"
      return 1
    fi

    # An unset regulatory domain leaves the radio blocked entirely, which
    # looks exactly like a wrong password.
    enable_radio "$country"

    log "joining '$ssid'"
    nmcli connection delete "$ssid" >/dev/null 2>&1 || true
    if [ -n "$psk" ]; then
      nmcli device wifi connect "$ssid" password "$psk" \
        ${hidden:+hidden yes} >/dev/null 2>&1
    else
      nmcli device wifi connect "$ssid" ${hidden:+hidden yes} >/dev/null 2>&1
    fi

    # Give the association a moment before declaring anything.
    local i
    for i in $(seq 1 20); do
      if have_link; then
        log "joined '$ssid'"
        # The password must not stay in clear text on the one partition every
        # machine can read.
        rm -f "$file"
        log "removed $file"
        return 0
      fi
      sleep 1
    done

    # Left in place deliberately: a typo is fixable by editing the file on
    # another machine, which is impossible if we have deleted it.
    log "could not join '$ssid' - leaving $file in place so it can be corrected"
    log "  device state: $(nmcli -t -f DEVICE,TYPE,STATE device status 2>/dev/null | tr '\n' ' ')"
    log "  visible networks: $(nmcli -t -f SSID device wifi list 2>/dev/null \
          | grep -v '^$' | head -8 | tr '\n' ',')"
    return 1
  done

  [ "$found" -eq 0 ] && log "no lifeboard-wifi.txt found (checked /boot/firmware and /boot)"
  return 1
}

if ! have_link; then
  # The device has to exist before either path can do anything with it.
  wait_for_wifi_device || true
  apply_boot_wifi || true
fi

# Ethernet usually comes up before this runs; Wi-Fi with a saved profile can
# take a while, especially on a cold boot with a weak signal.
for i in $(seq 1 "$GRACE"); do
  if have_link; then
    log "network is up after ${i}s"
    # Tear down a stale hotspot left over from a previous boot.
    nmcli connection down "$HOTSPOT" >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 1
done

# Only makes sense if there is a Wi-Fi radio to raise an AP with.
if ! nmcli -t -f TYPE device status 2>/dev/null | grep -q '^wifi$'; then
  log "no network and no wifi adapter - nothing further to try"
  exit 0
fi

log "no network after ${GRACE}s; starting setup hotspot ${SSID}"

# Without this the hotspot below reports success and broadcasts nothing.
enable_radio || log "continuing anyway - the hotspot may not appear"

# Look around BEFORE the radio becomes an access point: a Pi cannot scan while
# it is one, and the setup page needs this list to offer networks to pick
# from. Same format the server's network.scan() reads.
SCAN_CACHE=/var/lib/lifeboard/wifi-scan.txt
nmcli device wifi rescan >/dev/null 2>&1 || true
sleep 3
if nmcli -t -f SSID,SIGNAL,SECURITY,IN-USE device wifi list > "${SCAN_CACHE}.tmp" 2>/dev/null \
    && [ -s "${SCAN_CACHE}.tmp" ]; then
  mv "${SCAN_CACHE}.tmp" "$SCAN_CACHE"
  chown lifeboard:lifeboard "$SCAN_CACHE" 2>/dev/null || true
  log "saw $(grep -c . "$SCAN_CACHE") networks before starting the hotspot"
else
  rm -f "${SCAN_CACHE}.tmp"
  log "the pre-hotspot scan found nothing"
fi

# Open network on purpose: the point is that somebody with no credentials can
# reach the setup page. It carries only the setup form and disappears as soon
# as the device joins a real network.
#
# NOT `nmcli device wifi hotspot`: that always sets a random WPA password,
# which nobody is shown - the screen says "no password" and the phone cannot
# join. A plain AP-mode profile with no security section is genuinely open.
WIFI_DEV=$(nmcli -t -f DEVICE,TYPE device status 2>/dev/null | awk -F: '$2=="wifi" {print $1; exit}')
nmcli connection delete "$HOTSPOT" >/dev/null 2>&1 || true
nmcli connection add type wifi ifname "$WIFI_DEV" con-name "$HOTSPOT" autoconnect no \
  ssid "$SSID" 802-11-wireless.mode ap 802-11-wireless.band bg \
  ipv4.method shared ipv6.method disabled 2>&1 | sed 's/^/[firstboot] /'
nmcli connection up "$HOTSPOT" 2>&1 | sed 's/^/[firstboot] /'

# Verify rather than assume. An AP that did not come up is the difference
# between "follow the instructions on screen" and instructions that cannot be
# followed, and the logs are the only place that distinction can be recorded.
sleep 3
if nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null | grep -q "^${HOTSPOT}:"; then
  log "hotspot ${SSID} is up on $(nmcli -t -f NAME,DEVICE connection show --active \
        | awk -F: -v h="$HOTSPOT" '$1==h {print $2}')"
else
  log "ERROR: hotspot ${SSID} did not come up"
  log "  rfkill: $(rfkill list wifi 2>/dev/null | tr '\n' ' ')"
  log "  device: $(nmcli -t -f DEVICE,TYPE,STATE device status 2>/dev/null | tr '\n' ' ')"
  log "  Put lifeboard-wifi.txt on the boot partition instead - see the README."
fi

# The renderer polls /api/board and will switch itself to the setup screen once
# it sees the hotspot is up, so there is nothing to signal here.
