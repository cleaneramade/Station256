#!/usr/bin/env bash
# Tries to break out of a room. Removes its own test projects at the end.
set -u
export PATH="$HOME/.local/bin:$PATH"
A=zz-test-a; B=zz-test-b
GW=$(ip route | awk '/default/{print $3; exit}')

# With no keyboard attached, these start the room and return instead of sitting in a shell.
timeout 90 room new "$A" </dev/null >/dev/null 2>&1
timeout 90 room new "$B" </dev/null >/dev/null 2>&1
echo secret > "$HOME/projects/$B/secret.txt"
docker exec "room-$A" sh -c 'echo kept > /workspace/kept.txt'

echo "room list:"; room list
t() { echo "--- $1"; docker exec "room-$A" bash -c "$2" 2>&1 | head -4; }
t "who am I"               'id -un; id -u'
t "tools"                  'claude --version; node --version; python3 --version; git --version'
t "Windows C visible"      'ls /mnt/c 2>&1'
t "sudo present"           'command -v sudo || echo no-sudo'
t "mount C:"               'mkdir -p /tmp/x; mount -t drvfs C: /tmp/x 2>&1'
t "Docker control"         'ls /var/run/docker.sock 2>&1; command -v docker || echo no-docker-cli'
t "write to system"        'touch /etc/x 2>&1'
t "see other project"      "ls /workspace/../$B 2>&1; find / -name secret.txt 2>/dev/null | wc -l"
t "see house home"         "ls /home; ls /home/$(id -un) 2>&1"
t "internet"               'curl -s -o /dev/null -w "%{http_code}\n" https://github.com'
t "Windows host port 445 ($GW)" "timeout 3 bash -c 'echo > /dev/tcp/$GW/445' 2>&1 && echo OPEN || echo closed"
docker exec -d "room-$B" python3 -m http.server 8000 --directory /tmp
sleep 2
BIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "room-$B")
HOUSE=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' "room-$B")
echo "--- control: room B answers itself"; docker exec "room-$B" bash -c "timeout 3 bash -c 'echo > /dev/tcp/$BIP/8000' 2>&1 && echo OPEN || echo closed"
t "room B reachable from A ($BIP)" "timeout 3 bash -c 'echo > /dev/tcp/$BIP/8000' 2>&1 && echo OPEN || echo closed"
t "house reachable ($HOUSE)" "timeout 3 bash -c 'echo > /dev/tcp/$HOUSE/22' 2>&1 && echo OPEN || echo closed"
t "website by name" 'getent hosts github.com | head -1; curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/'

room close "$A"; room close "$B"
echo "--- folded away, file kept?"; cat "$HOME/projects/$A/kept.txt"
docker ps --filter label=house.room --format '{{.Names}}' | wc -l

docker rm -f "keep-$A" "keep-$B" >/dev/null 2>&1 || true
docker volume rm "house-claude-$A" "house-claude-$B" >/dev/null
rm -rf "$HOME/projects/$A" "$HOME/projects/$B"
rm -rf "$HOME/.local/state/house/edits/$A" "$HOME/.local/state/house/edits/$B"
echo "--- cleanup, projects left:"; ls "$HOME/projects" | wc -l
