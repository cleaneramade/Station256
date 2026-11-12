#!/bin/bash
# The only admin actions the control panel may run. Takes fixed commands, nothing free-form.
set -eu
FLAG=/run/house/windows-door-open
MOUNT=/mnt/windows-door

case "${1:-}" in
  door-open)
    mkdir -p "$MOUNT" /run/house
    mountpoint -q "$MOUNT" || mount -t drvfs C: "$MOUNT" -o ro
    touch "$FLAG"
    ;;
  door-close)
    # The flag goes first, so no new room can pick up the door while it's closing.
    rm -f "$FLAG"
    if mountpoint -q "$MOUNT"; then umount "$MOUNT"; fi
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
