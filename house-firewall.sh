#!/bin/sh
# Rooms may reach the internet, but not Windows, the home network, the house, or each other.
# The rules load as a single step, so a failure can never leave a room behind a half-built wall.
set -e
NET=house-rooms
SUBNET=172.30.0.0/24
BRIDGE=br-rooms

docker network inspect "$NET" >/dev/null 2>&1 || docker network create \
  --subnet "$SUBNET" \
  -o com.docker.network.bridge.name="$BRIDGE" \
  -o com.docker.network.bridge.enable_icc=false \
  "$NET" >/dev/null

{
  echo '*filter'
  echo ':HOUSE-ROOMS - [0:0]'
  echo ':HOUSE-ROOMS-IN - [0:0]'
  echo "-A HOUSE-ROOMS -s $SUBNET -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
  for private in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
    echo "-A HOUSE-ROOMS -s $SUBNET -d $private -j DROP"
  done
  echo "-A HOUSE-ROOMS-IN -i $BRIDGE -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
  echo "-A HOUSE-ROOMS-IN -i $BRIDGE -j DROP"
  echo 'COMMIT'
} | iptables-restore --noflush

iptables -C DOCKER-USER -j HOUSE-ROOMS 2>/dev/null || iptables -I DOCKER-USER -j HOUSE-ROOMS
iptables -C INPUT -j HOUSE-ROOMS-IN 2>/dev/null || iptables -I INPUT -j HOUSE-ROOMS-IN

# WSL leaves its "run Windows programs" hook switched on even with that feature turned off, and
# it reaches into rooms too. Nothing here uses it, so it goes off.
for hook in /proc/sys/fs/binfmt_misc/WSLInterop*; do
  if [ -e "$hook" ]; then echo 0 > "$hook"; fi
done
