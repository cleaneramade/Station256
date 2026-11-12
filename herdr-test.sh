#!/usr/bin/env bash
# herdr-test.sh - proves the ssh door into a room did not open a hole.
#
# Makes two throwaway rooms, checks every wall, then removes them.
# Run it after any change to the room blueprint, the room script or the keys.
#
#   bash ~/house/herdr-test.sh
#
set -uo pipefail

ROOM=~/.local/bin/room
HERDR=~/.local/bin/herdr
A=herdrtesta
B=herdrtestb
C=herdrtestc # a project folder only, never given a room
pass=0; fail=0

ok()   { echo "  PASS  $1"; pass=$((pass + 1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail + 1)); }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (wanted '$2', got '$1')"; fi; }

cleanup() {
  "$ROOM" close "$A" >/dev/null 2>&1 || true
  "$ROOM" close "$B" >/dev/null 2>&1 || true
  rm -rf ~/projects/"$A" ~/projects/"$B" ~/projects/"$C"
  rm -rf ~/.config/house/secrets/"$A" ~/.config/house/secrets/"$B"
  rm -f ~/.ssh/room-hosts/"$A" ~/.ssh/room-hosts/"$A".pub
  rm -f ~/.ssh/room-hosts/"$B" ~/.ssh/room-hosts/"$B".pub
  docker volume rm "house-claude-$A" "house-claude-$B" >/dev/null 2>&1 || true
  # With their folders gone, this takes the test rooms out of Herdr's list.
  "$ROOM" agents --ready >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== keys are kept out of the backup =="
check "$([ -f ~/.ssh/house_rooms ] && echo yes || echo no)" yes "the house key exists"
check "$(stat -c %a ~/.ssh/house_rooms 2>/dev/null)" 600 "only you can read the house key"
check "$(find ~/house -name 'id_*' -o -name '*house_rooms*' -o -name 'room_host*' 2>/dev/null | wc -l)" 0 "no key file inside ~/house"
# Skips this file, or the search finds the words it is searching for.
check "$(grep -rl --exclude=herdr-test.sh 'BEGIN OPENSSH PRIVATE'' KEY' ~/house 2>/dev/null | wc -l)" 0 "no private key text inside ~/house"

echo
echo "== the blueprint has the ssh door =="
check "$(grep -c 'openssh-server' ~/house/room/Dockerfile)" 1 "blueprint installs the ssh server"
check "$(grep -c 'PasswordAuthentication no' ~/house/room/sshd_config)" 1 "passwords are off"
# Since 2026-11-08 the house may open a path into the room's own localhost (room sites on Windows,
# panel/lib/ports.js). Nothing else: no path out of the room, no other address, no tunnel.
check "$(grep -cx 'AllowTcpForwarding local' ~/house/room/sshd_config)" 1 "only paths into the room are allowed"
check "$(grep -cx 'PermitOpen localhost:\* 127.0.0.1:\* \[::1\]:\*' ~/house/room/sshd_config)" 1 "a path can only reach the room's own localhost"
check "$(grep -cxE 'PermitListen none|PermitTunnel no|GatewayPorts no|AllowStreamLocalForwarding no|AllowAgentForwarding no|X11Forwarding no' ~/house/room/sshd_config)" 6 "no path out, no tunnel, no agent or X11"

echo
echo "== opening two throwaway rooms =="
rm -rf ~/projects/"$A" ~/projects/"$B"
mkdir -p ~/projects/"$A" ~/projects/"$B"
"$ROOM" open "$A" </dev/null >/dev/null 2>&1 || true
"$ROOM" open "$B" </dev/null >/dev/null 2>&1 || true
check "$(docker inspect -f '{{.State.Running}}' room-$A 2>/dev/null)" true "room A is up"
check "$(docker inspect -f '{{.State.Running}}' room-$B 2>/dev/null)" true "room B is up"
IPA="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' room-$A 2>/dev/null)"
IPB="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' room-$B 2>/dev/null)"
HOUSE_IP="$(ip -4 addr show eth0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1)"
GW="$(docker network inspect house-rooms -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null)"

echo
echo "== each room has its own identity =="
check "$([ -f ~/.ssh/room-hosts/$A ] && [ -f ~/.ssh/room-hosts/$B ] && echo yes || echo no)" yes "each room got its own host key"
check "$(cmp -s ~/.ssh/room-hosts/$A ~/.ssh/room-hosts/$B && echo same || echo different)" different "the two host keys are not the same"
check "$(docker exec room-$A cat /home/dev/.ssh/authorized_keys 2>/dev/null | cut -d' ' -f2)" \
      "$(cut -d' ' -f2 ~/.ssh/house_rooms.pub)" "room A trusts the house key"

echo
echo "== the house can get in, by name =="
check "$([ -f ~/.ssh/config.d/room-$A.conf ] && echo yes || echo no)" yes "room A has an ssh name"
check "$(ssh -o BatchMode=yes -o ConnectTimeout=10 room-$A 'echo in' 2>/dev/null)" in "the house can ssh into room A"
check "$(ssh -o BatchMode=yes -o ConnectTimeout=10 room-$A 'herdr --version >/dev/null && echo yes' 2>/dev/null)" yes "herdr works inside the room"
check "$(ssh -o BatchMode=yes -o ConnectTimeout=10 room-$A 'claude --version >/dev/null && echo yes' 2>/dev/null)" yes "claude works inside the room"
check "$(ssh -o BatchMode=yes -o ConnectTimeout=10 room-$A 'codex --version >/dev/null 2>&1 && echo yes' 2>/dev/null)" yes "codex works inside the room"
check "$(ssh -o BatchMode=yes -o ConnectTimeout=10 room-$A 'gemini --version >/dev/null 2>&1 && echo yes' 2>/dev/null)" yes "gemini works inside the room"

echo
echo "== the room still cannot get out =="
check "$(docker exec room-$A sh -c "timeout 8 bash -c '</dev/tcp/$HOUSE_IP/22' 2>/dev/null && echo reached || echo blocked")" blocked "room A cannot reach the house"
check "$(docker exec room-$A sh -c "timeout 8 bash -c '</dev/tcp/$GW/22' 2>/dev/null && echo reached || echo blocked")" blocked "room A cannot reach the house gateway"
check "$(docker exec room-$A sh -c "timeout 8 bash -c '</dev/tcp/$IPB/22' 2>/dev/null && echo reached || echo blocked")" blocked "room A cannot reach room B"
check "$(docker exec room-$A sh -c 'ls /home/dev/.ssh/*_rooms 2>/dev/null | wc -l')" 0 "room A holds no key for any other machine"
check "$(docker exec room-$A sh -c 'command -v sudo >/dev/null && echo yes || echo no')" no "still no admin rights in a room"
check "$(docker exec room-$A sh -c '[ -e /var/run/docker.sock ] && echo yes || echo no')" no "still no Docker control in a room"

echo
echo "== one project cannot read another project's secrets =="
echo "secret-for-B" > ~/.config/house/secrets/"$B"/token.txt
check "$(docker exec room-$A sh -c 'ls /secrets 2>/dev/null | wc -l')" 0 "room A sees nothing in its own empty secrets folder"
check "$(docker exec room-$A sh -c 'cat /secrets/token.txt 2>/dev/null; echo -n ""' | wc -c)" 0 "room A cannot read room B's secret"
check "$(docker exec room-$B sh -c 'cat /secrets/token.txt 2>/dev/null')" "secret-for-B" "room B can read its own secret"
check "$(docker exec room-$B sh -c 'echo x > /secrets/x 2>/dev/null && echo wrote || echo readonly')" readonly "a room cannot change its own secrets"

echo
echo "== nothing is exposed to Windows or the network =="
check "$(docker port room-$A 2>/dev/null | wc -l)" 0 "the room publishes no port"
check "$(ss -lnt 2>/dev/null | awk '$4 ~ /:22$/' | wc -l)" 0 "nothing is listening on 22 in the house"

if [ -x "$HERDR" ]; then
  echo
  echo "== herdr sees the rooms =="
  check "$("$HERDR" machine list 2>/dev/null | awk -v n=$A '$2 == n { print "yes"; exit }')" yes "room A is a herdr machine"
  check "$("$HERDR" machine status 2>/dev/null | awk -v n=$A '$2 == n { print $3; exit }')" reachable "room A is reachable"

  echo
  echo "== the Agents list shows every project, open or asleep =="
  # Prints enabled or disabled for a room, found by its ssh name.
  herdr_state() { "$HERDR" machine list 2>/dev/null | awk -F'\t' -v t="room-$1" '$3 == t { print $5; exit }'; }
  mkdir -p ~/projects/"$C"
  "$ROOM" agents --ready >/dev/null 2>&1
  check "$(herdr_state "$C")" disabled "a project with no room is listed, asleep"
  check "$("$HERDR" machine list 2>/dev/null | awk -F'\t' '$3 ~ /^room-/' | wc -l)" \
        "$(find ~/projects -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -cE '^[A-Za-z0-9]([A-Za-z0-9 _-]*[A-Za-z0-9_-])?$')" \
        "every project has one row"
  "$ROOM" close "$B" >/dev/null 2>&1
  check "$(herdr_state "$B")" disabled "a closed room stays listed, asleep"
  check "$([ -f ~/.ssh/config.d/room-$B.conf ] && echo yes || echo no)" no "a closed room has no ssh name"
  "$ROOM" open "$B" </dev/null >/dev/null 2>&1 || true
  check "$(herdr_state "$B")" enabled "a reopened room is awake in the list"
  check "$("$HERDR" machine status 2>/dev/null | awk -F'\t' -v n=$B '$2 == n { print $3; exit }')" reachable "a reopened room is reachable"
  check "$("$HERDR" machine list 2>/dev/null | awk -F'\t' -v t="room-$B" '$3 == t' | wc -l)" 1 "a reopened room is listed once"
  rm -rf ~/projects/"$C"
  "$ROOM" agents --ready >/dev/null 2>&1
  check "$(herdr_state "$C")" "" "a deleted project leaves the list"
fi

echo
echo "-------------------------------------------"
echo "  $pass passed, $fail failed"
echo "-------------------------------------------"
[ "$fail" -eq 0 ]
