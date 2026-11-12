#!/bin/bash
# Keeps the house awake while any light is on. Only when everything has been off
# for HOUSE_IDLE_SECONDS does it shut the house down. If unsure, it stays awake.
IDLE_LIMIT="${HOUSE_IDLE_SECONDS:-600}"
CHECK_EVERY="${HOUSE_CHECK_SECONDS:-15}"
# Reading or writing this much between checks means something is working, such as a big copy
# from Windows through L:, which has no process in the house to see.
BUSY_SECTORS="${HOUSE_BUSY_SECTORS:-16384}" # 8 MB
HOUSE_USER="${HOUSE_USER:-$(getent passwd 1000 | cut -d: -f1)}" # the first user of the house (uid 1000), unless set in /etc/default/house-keeper
STATUS=/run/house/status
mkdir -p /run/house

disk_sectors() {
  awk '$3 ~ /^sd[a-z]+$/ { total += $6 + $10 } END { printf "%d", total }' /proc/diskstats
}

# The house user's programs that count as jobs: their names, once each, comma separated.
# A Herdr left running with nothing in it is not a job (2026-11-08: one left over from a test kept
# the house awake all night). Herdr itself is left out, and so is any shell under it that has
# nothing running in it. Anything running in one of those shells still counts, whoever runs it.
house_jobs() {
  local logins uid
  # WSL keeps a hidden shell under a "login" process for each user. That isn't a job.
  logins=" $(pgrep -x login | paste -sd' ' -) "
  uid="$(id -u "$HOUSE_USER")" || return 0
  ps -e -o pid=,ppid=,euid=,comm= 2>/dev/null | awk -v logins="$logins" -v uid="$uid" '
    { pid[NR] = $1; parent[$1] = $2; user[$1] = $3; name[$1] = $4; kids[$2]++ }
    function under_herdr(p,  n) {
      for (n = 0; n < 64 && (p in parent); n++) { p = parent[p]; if (name[p] == "herdr") return 1 }
      return 0
    }
    END {
      for (i = 1; i <= NR; i++) {
        p = pid[i]; c = name[p]
        if (user[p] != uid || index(logins, " " parent[p] " ")) continue
        # house-schedules is the scheduled-task runner (panel/lib/schedules-runner.js): waiting for a task is not a job.
        if (c ~ /^(systemd|\(sd-pam\)|dbus-daemon|dbus-launch|at-spi.*|dconf-service|gvfs.*|xdg-.*|pipewire.*|wireplumber|pulseaudio|gnome-keyring.*|house-schedules)$/) continue
        if (c == "herdr" || (c ~ /^(bash|sh|dash)$/ && !(p in kids) && under_herdr(p))) continue
        print c
      }
    }' | sort -u | paste -sd, -
}

# Prints why the house must stay awake. Prints nothing if every light is off.
lights_on() {
  local rooms
  if ! rooms="$(timeout 10 docker ps --format '{{.Names}}' 2>/dev/null)"; then
    # Docker that has failed outright holds no rooms, so it mustn't keep the house up forever.
    if ! systemctl is-failed -q docker; then
      echo "docker not answering"; return
    fi
    rooms=""
  fi
  if [ -n "$rooms" ]; then
    echo "rooms up: $(echo "$rooms" | sed 's/^room-//' | paste -sd, -)"; return
  fi
  local jobs working
  jobs="$(house_jobs)"
  # Something actually running, not just an open shell or the panel. The Windows helper keeps the
  # PC awake for these, the same as it does for rooms.
  working="$(echo "$jobs" | tr ',' '\n' | grep -vE '^(|electron|bash|sh|dash|herdr)$' | paste -sd, -)"
  if [ -n "$working" ]; then
    echo "jobs running: $working"; return
  fi
  # Every real terminal (and anything run from Windows) has a SessionLeader.
  if ps -eo comm= | grep -q '^SessionLeader'; then
    echo "terminal session open"; return
  fi
  if [ -n "$jobs" ]; then
    echo "background jobs: $jobs"; return
  fi
  if pgrep -x 'apt|apt-get|dpkg' >/dev/null; then
    echo "system update running"; return
  fi
  local sectors
  sectors="$(disk_sectors)"
  if [ "$((sectors - LAST_SECTORS))" -ge "$BUSY_SECTORS" ]; then
    echo "files being moved"
  fi
}

last=""
# Counted, not read from the clock: PC sleep or a clock change can't make the house sleep early.
dark_for=0
LAST_SECTORS="$(disk_sectors)"
while true; do
  reason="$(lights_on)"
  LAST_SECTORS="$(disk_sectors)"
  if [ -n "$reason" ]; then
    dark_for=0
    state="awake: $reason"
  else
    state="idle for ${dark_for}s of ${IDLE_LIMIT}s"
    if [ "$dark_for" -ge "$IDLE_LIMIT" ]; then
      echo "all lights off for ${IDLE_LIMIT}s, going to sleep"
      echo "going to sleep" > "$STATUS"
      systemctl poweroff
      exit 0
    fi
    dark_for=$((dark_for + CHECK_EVERY))
  fi
  echo "$state" > "$STATUS"
  case "$state" in idle*) label=idle ;; *) label="$state" ;; esac
  if [ "$label" != "$last" ]; then echo "$label"; last="$label"; fi
  sleep "$CHECK_EVERY"
done
