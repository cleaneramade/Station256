#!/bin/bash
# The only admin actions the control panel may run. Takes fixed commands, nothing free-form.
set -eu
FLAG=/run/house/windows-door-open
MOUNT=/mnt/windows-door
CUT=/run/house/windows-door-cut # ids of rooms whose /windows was taken away (the app reads it)

has_windows() { awk '$5 == "/windows" { found = 1 } END { exit !found }' "/proc/$1/mountinfo" 2>/dev/null; }

# Takes a mount away inside a room's mount namespace, as the house (nothing from the room runs).
# umount -N can't do this: it only enters the mount namespace, where /proc is the room's own and
# /proc/self is gone, so it failed even when nothing was using the folder. Plain umount2, never
# lazy or forced: a busy mount must stay, and the caller reports it.
umount_in() { # pid, folder
  python3 -I -c '
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
fd = os.open("/proc/%s/ns/mnt" % sys.argv[1], os.O_RDONLY)
if libc.setns(fd, 0x00020000) or libc.umount2(sys.argv[2].encode(), 0):  # CLONE_NEWNS
    sys.exit(os.strerror(ctypes.get_errno()))
' "$1" "$2"
}

# A running room keeps its own copy of the drive, so unmounting it here doesn't reach the room.
# This unmounts /windows inside each room that has it, so nothing from inside the room runs as
# root. Plain unmount only: a lazy one would hide the folder while an open file or a shell sitting
# in it kept reading, and the lock would lie.
# A room that is busy that way is left running, named, and this fails (the lock stays open).
cut_rooms() {
  local ids id info pid name why='' bad=0
  ids=$(docker ps -q --no-trunc --filter label=house.door=open)
  for id in $ids; do
    info=$(docker inspect -f '{{.State.Pid}} {{index .Config.Labels "house.room"}}' "$id") || { bad=1; continue; }
    pid=${info%% *} name=${info#* }
    while [ "$pid" -gt 0 ] && has_windows "$pid"; do
      why=$(umount_in "$pid" /windows 2>&1) || break
    done
    if [ "$pid" -gt 0 ] && has_windows "$pid"; then
      case "$why" in
        *busy*) echo "$name can still read Windows files: a program in it has something open in /windows" >&2 ;;
        *) echo "$name can still read Windows files: $why" >&2 ;;
      esac
      bad=1
    else
      echo "$id" >> "$CUT"
    fi
  done
  return $bad
}

# Rooms are cut before the host drive is let go, so a failed cut leaves the drive mounted.
# Rooms are never closed here.
close_door() {
  cut_rooms || return 1
  if mountpoint -q "$MOUNT" && ! umount "$MOUNT" 2>/dev/null; then
    echo "Windows files are still in use by a program in Linux, such as a terminal sitting in a Windows folder. Close it and lock again." >&2
    return 1
  fi
  cut_rooms # a room that opened while this ran
}

case "${1:-}" in
  door-open)
    mkdir -p "$MOUNT" /run/house
    mountpoint -q "$MOUNT" || mount -t drvfs C: "$MOUNT" -o ro
    touch "$FLAG"
    ;;
  door-close)
    mkdir -p /run/house
    # The flag goes first, so no new room can pick up the door while it's closing.
    rm -f "$FLAG"
    # If closing fails the drive is still there, so the flag goes back: the lock must say open.
    close_door || { touch "$FLAG"; exit 1; }
    ;;
  firewall-check)
    # Passes only if the walls are really in place, not just if the service says so.
    iptables -C DOCKER-USER -j HOUSE-ROOMS 2>/dev/null
    iptables -C INPUT -j HOUSE-ROOMS-IN 2>/dev/null
    iptables -S HOUSE-ROOMS | grep -q -- '-d 192.168.0.0/16'
    iptables -S HOUSE-ROOMS-IN | grep -q -- '-j DROP'
    ;;
  *)
    echo "usage: house-rules door-open | door-close | firewall-check" >&2
    exit 2
    ;;
esac
