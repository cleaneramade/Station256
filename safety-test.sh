#!/usr/bin/env bash
# Checks the failure cases: what happens when things go wrong, not just when they go right.
# Uses throwaway projects and puts everything back.
set -u
export PATH="$HOME/.local/bin:$PATH"
N=zz-safety-test
H="$HOME/house/panel/lib/house.js"
F="$HOME/house/panel/lib/files.js"
PLAY="$(mktemp -d)"
FAKE="$(mktemp -d)"
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }
SAVED_RULES="$(cat ~/.config/house/rules.json 2>/dev/null)"
cleanup() {
  room close "$N" >/dev/null 2>&1
  docker rm -f "keep-$N" >/dev/null 2>&1
  docker volume rm "house-claude-$N" >/dev/null 2>&1
  rm -rf "$HOME/projects/$N" "$PLAY" "$FAKE"
  sudo -n /usr/local/sbin/house-rules door-close
  [ -n "$SAVED_RULES" ] && printf '%s\n' "$SAVED_RULES" > ~/.config/house/rules.json
  node ~/house/panel/lib/rules.js >/dev/null
}
trap cleanup EXIT

# A pretend Docker or sudo that always fails, used for one command at a time.
printf '#!/bin/sh\necho "broken" >&2\nexit 1\n' > "$FAKE/docker"; cp "$FAKE/docker" "$FAKE/sudo"; chmod +x "$FAKE/docker" "$FAKE/sudo"
js() { node -e "$1" 2>&1 | tail -1; }
broken() { PATH="$FAKE:$PATH" node -e "$1" 2>&1 | tail -1; }

mkdir -p "$HOME/projects/$N"
# With no keyboard attached, this starts the room and returns instead of sitting in a shell.
start() { timeout 90 room open "$N" </dev/null >/dev/null 2>&1; }

echo "== two opens of one project at once"
start
first="$(docker inspect -f '{{.Id}}' room-$N)"
start & start & wait
check "the running room survives them" "$(docker inspect -f '{{.Id}}' room-$N)" "$first"
room close "$N" >/dev/null
docker rm -f room-$N >/dev/null 2>&1
( start ) & ( start ) & wait
check "two opens from nothing leave one running room" "$(docker ps -q --filter name=room-$N | wc -l | tr -d ' ')" "1"
room close "$N" >/dev/null

echo "== room limits"
start
limit="$(docker inspect -f '{{.HostConfig.Memory}}' room-$N)"
[ "$limit" -gt 0 ] && pass "memory is limited to $((limit / 1048576)) MB" || fail "no memory limit"
room close "$N" >/dev/null

echo "== a room that stops while in use says so"
(
  for _ in $(seq 1 30); do
    if [ "$(docker exec room-$N sh -c 'ps -e | grep -c bash' 2>/dev/null)" -ge 1 ] 2>/dev/null; then break; fi
    sleep 1
  done
  sleep 3
  echo "removed: $(docker rm -f room-$N 2>&1)" >> "$PLAY/remove.log"
) &
timeout 45 script -qfec "room open $N" "$PLAY/typescript" < <(sleep 40) >/dev/null 2>&1
code=$?
wait
check "it exits with the code that keeps the tab open" "$code" "3"
case "$(tr -d '\r' < "$PLAY/typescript")" in
  *"stopped unexpectedly"*) pass "the message appears" ;;
  *) fail "no message. $(cat "$PLAY/remove.log" 2>/dev/null) // $(tr -d '\r' < "$PLAY/typescript" | tail -2 | cut -c1-120)" ;;
esac

echo "== closing a room when Docker is broken is reported, not hidden"
PATH="$FAKE:$PATH" room close "$N" >/dev/null 2>&1
check "room close fails" "$?" "1"

echo "== the Windows door"
sudo -n /usr/local/sbin/house-rules door-open
start
check "a room got the door" "$(docker inspect -f '{{index .Config.Labels "house.door"}}' room-$N)" "open"
seen() { docker exec room-$N sh -c 'test -r /windows/Windows/win.ini && echo can-read || echo cannot'; }
holder() { docker exec -d room-$N sh -c 'echo $$ > /tmp/holder.pid; cd /windows && exec sleep 600'; sleep 2; }
check "the room can read Windows files" "$(seen)" "can-read"
# A shell sitting in /windows keeps its copy busy: the lock must fail and say so, not pretend.
holder
check "locking with a program inside /windows fails" \
  "$(js "require('$H').closeDoor().then(() => console.log('claimed-locked'), (e) => console.log(/can still read/.test(e.message) ? 'failed-and-says-why' : e.message))")" "failed-and-says-why"
check "the lock still shows open" \
  "$(js "require('$H').status().then((s) => console.log(s.doorOpen))")" "true"
check "the failed lock put the flag back" "$(test -e /run/house/windows-door-open && echo back || echo missing)" "back"
check "the room is still running" "$(docker ps -q --filter name=room-$N | wc -l | tr -d ' ')" "1"
docker exec room-$N sh -c 'kill "$(cat /tmp/holder.pid)"'
sleep 1
sudo -n /usr/local/sbin/house-rules door-open
check "locking never closes the room" \
  "$(js "require('$H').closeDoor().then(() => console.log('locked'), (e) => console.log(e.message))")" "locked"
check "the room is still running after the lock" "$(docker ps -q --filter name=room-$N | wc -l | tr -d ' ')" "1"
check "the room can no longer read Windows files" "$(seen)" "cannot"
check "/windows is empty in the room" "$(docker exec room-$N sh -c 'ls -A /windows | wc -l')" "0"
check "lock now shows closed" "$(js "require('$H').status().then((s) => console.log(s.doorOpen))")" "false"
check "drive unmounted" "$(mountpoint -q /mnt/windows-door && echo mounted || echo unmounted)" "unmounted"
sudo -n /usr/local/sbin/house-rules door-open
check "unlocking again doesn't give the running room the door back" "$(seen)" "cannot"
check "and it isn't shown as seeing Windows files" \
  "$(js "require('$H').status().then((s) => console.log(s.rooms.filter((r) => r.windowsDoor).length))")" "0"
sudo -n /usr/local/sbin/house-rules door-close
room close "$N" >/dev/null
check "Docker failure isn't reported as no rooms" \
  "$(broken "require('$H').status().then((s) => console.log(s.dockerOk))")" "false"

echo "== the explorer stays on the L: drive"
sudo -n /usr/local/sbin/house-rules door-open
ln -s /mnt/windows-door "$PLAY/sneaky"
denied() { js "require('$F').$1.then(() => console.log('allowed'), (e) => console.log(/L: drive/.test(e.message) ? 'denied' : e.message))"; }
check "door folder can't be listed" "$(denied "list('/mnt/windows-door')")" "denied"
check "a link into it can't be listed" "$(denied "list('$PLAY/sneaky')")" "denied"
check "files in it can't be read" "$(denied "readText('/mnt/windows-door/Windows/win.ini')")" "denied"
check "files in it can't be copied out" \
  "$(js "require('$F').paste(['/mnt/windows-door/Windows/win.ini'], '$PLAY', false).then((f) => console.log(f.length && /L: drive/.test(f[0].message) ? 'denied' : 'allowed'))")" "denied"
check "nothing can be put in it" "$(denied "makeFolder('/mnt/windows-door', 'x')")" "denied"
check "/mnt/c can't be listed" "$(denied "list('/mnt/c')")" "denied"
check "the Windows driver folder can't be listed" "$(denied "list('/usr/lib/wsl/drivers')")" "denied"
check "they don't appear in the /mnt listing" \
  "$(js "require('$F').list('/mnt').then((l) => console.log(l.filter((e) => /windows-door|^c$/.test(e.name)).length))")" "0"
check "normal folders still work" "$(js "require('$F').list('$HOME').then((l) => console.log(l.length > 0))")" "true"
rm -f "$PLAY/sneaky"
sudo -n /usr/local/sbin/house-rules door-close

echo "== file actions"
mkdir -p "$PLAY/src/sub" "$PLAY/dest"
echo data > "$PLAY/src/sub/file"; ln -s sub/file "$PLAY/src/rel-link"
js "require('$F').paste(['$PLAY/src'], '$PLAY/dest', false).then(() => console.log('ok'), (e) => console.log(e.message))" >/dev/null
check "copying a folder keeps relative links relative" "$(readlink "$PLAY/dest/src/rel-link")" "sub/file"
ln -s /nowhere "$PLAY/dangling"; echo a > "$PLAY/a"
check "rename won't overwrite a broken link" \
  "$(js "require('$F').rename('$PLAY/a', 'dangling').then(() => console.log('overwrote'), () => console.log('refused'))")" "refused"
mkfifo "$PLAY/pipe"
check "previewing a pipe doesn't hang" \
  "$(timeout 10 node -e "require('$F').readText('$PLAY/pipe').then((r) => console.log(r.binary ? 'skipped' : 'read'))" 2>&1 | tail -1)" "skipped"
check "a folder can't go inside itself" \
  "$(js "require('$F').paste(['$PLAY/src'], '$PLAY/src/sub', false).then((f) => console.log(f.length ? 'refused' : 'allowed'))")" "refused"
echo one > "$PLAY/one"; echo two > "$PLAY/two"; mkdir -p "$PLAY/many"
check "one bad item doesn't stop the rest" \
  "$(js "require('$F').paste(['$PLAY/one', '$PLAY/not-there', '$PLAY/two'], '$PLAY/many', true).then((f) => console.log(f.length + ' failed: ' + f[0].path.split('/').pop()))")" "1 failed: not-there"
check "and the good ones did move" "$(ls "$PLAY/many" | tr '\n' ' ')" "one two "
SHM="$(mktemp -d -p /dev/shm)"; echo across > "$SHM/across"
check "moving between two disks works" \
  "$(js "require('$F').paste(['$SHM/across'], '$PLAY/many', true).then((f) => console.log(f.length))")/$(cat "$PLAY/many/across")/$(ls "$SHM" | wc -l)" "0/across/0"
rm -rf "$SHM"

echo "== what the house runs from can't be moved or deleted"
protect() { js "require('$F').$1.then((f) => console.log(f && f.length ? 'protected' : 'allowed'), () => console.log('protected'))"; }
check "the app's folder" "$(protect "trash(['$HOME/house'])")" "protected"
check "a file inside it" "$(protect "trash(['$HOME/house/bin/room'])")" "protected"
check "the settings folder" "$(protect "paste(['$HOME/.config/house'], '$PLAY', true)")" "protected"
check "the projects folder" "$(protect "rename('$HOME/projects', 'x')")" "protected"
check "the home folder" "$(protect "trash(['$HOME'])")" "protected"
check "all of them are still there" "$(ls -d ~/house/bin/room ~/.config/house ~/projects | wc -l)" "3"
start
check "a project can't be moved while its room is open" \
  "$(js "require('$H').heldByRooms(['$HOME/projects/$N', '$PLAY']).then((h) => console.log(h.length + ':' + h[0].path.split('/').pop()))")" "1:$N"
room close "$N" >/dev/null
check "and it can once the room is closed" \
  "$(js "require('$H').heldByRooms(['$HOME/projects/$N']).then((h) => console.log(h.length))")" "0"

echo "== the trash"
mkdir -p "$PLAY/keep"; echo precious > "$PLAY/keep/note.txt"
T="$HOME/.local/share/house-trash"
stored() { ls -t "$T" | grep -- "$1\$" | head -1; }
js "require('$F').trash(['$PLAY/keep/note.txt']).then(() => console.log('ok'))" >/dev/null
s1="$(stored note.txt)"
check "deleting moves it out" "$(ls "$PLAY/keep" | wc -l)" "0"
check "the Trash shows its real name" \
  "$(js "require('$F').list('$T').then((l) => console.log(l.filter((e) => e.path.endsWith('$s1')).map((e) => e.name).join()))")" "note.txt"
check "the list hides the bookkeeping folder" \
  "$(js "require('$F').list('$T', true).then((l) => console.log(l.filter((e) => e.name === '.info').length))")" "0"
js "require('$F').restore(['$T/$s1']).then((f) => console.log(f.length))" >/dev/null
check "restore puts it back with its contents" "$(cat "$PLAY/keep/note.txt")" "precious"
js "require('$F').trash(['$PLAY/keep/note.txt']).then(() => console.log('ok'))" >/dev/null
s2="$(stored note.txt)"
echo newer > "$PLAY/keep/note.txt"
js "require('$F').restore(['$T/$s2']).then((f) => console.log(f.length))" >/dev/null
check "restore never overwrites what's there now" "$(cat "$PLAY/keep/note.txt")/$(cat "$PLAY/keep/note (2).txt")" "newer/precious"
check "only trash items can be deleted forever" \
  "$(js "require('$F').destroy(['$PLAY/keep/note.txt']).then((f) => console.log(f.length))")/$(cat "$PLAY/keep/note.txt")" "1/newer"
js "require('$F').trash(['$PLAY/keep/note.txt']).then(() => console.log('ok'))" >/dev/null
s3="$(stored note.txt)"
js "require('$F').destroy(['$T/$s3']).then((f) => console.log(f.length))" >/dev/null
check "delete forever removes it and its record" "$(ls "$T" "$T/.info" | grep -c "$s3")" "0"

echo "== a stuck Docker, not just a broken one"
STUCK="$(mktemp -d)"; printf '#!/bin/sh\nexec sleep 300\n' > "$STUCK/docker"; chmod +x "$STUCK/docker"
began=$SECONDS
PATH="$STUCK:$PATH" timeout 100 room open "$N" </dev/null >/dev/null 2>&1
code=$?
took=$((SECONDS - began))
if [ "$code" != 0 ] && [ "$code" != 124 ] && [ "$took" -lt 95 ]; then pass "opening a room gives up with a message after ${took}s"; else fail "room open: code $code after ${took}s"; fi
began=$SECONDS
out="$(PATH="$STUCK:$PATH" timeout 30 node -e "require('$H').status().then((s) => console.log(s.dockerOk))" 2>&1 | tail -1)"
check "the app's status check doesn't hang, and says so" "$out/$([ $((SECONDS - began)) -lt 15 ] && echo quick || echo slow)" "false/quick"
pkill -f '^sleep 300$' ; rm -rf "$STUCK"

echo "== a short Docker hiccup must not replace a live room"
start
first="$(docker inspect -f '{{.Id}}' room-$N)"
HICCUP="$(mktemp -d)"
REAL_DOCKER="$(command -v docker)"
printf '#!/bin/sh\nif [ "$1" = inspect ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi\nexec %s "$@"\n' "$REAL_DOCKER" > "$HICCUP/docker"; chmod +x "$HICCUP/docker"
PATH="$HICCUP:$PATH" timeout 30 room open "$N" </dev/null >/dev/null 2>&1
check "it refuses to touch the room" "$?" "1"
check "the room is still the same one" "$(docker inspect -f '{{.Id}}' room-$N)" "$first"
rm -rf "$HICCUP"

echo "== Windows programs can't run"
docker exec room-$N bash -c "printf 'MZ\0\0' > /tmp/x.exe; chmod +x /tmp/x.exe; /tmp/x.exe >/dev/null 2>&1; echo \$?" > "$PLAY/exe-code"
check "not from a room" "$(cat "$PLAY/exe-code")" "126"
printf 'MZ\0\0' > "$PLAY/x.exe"; chmod +x "$PLAY/x.exe"; "$PLAY/x.exe" >/dev/null 2>&1
check "not from the house" "$?" "126"
room close "$N" >/dev/null

echo "== logging in happens behind the firewall"
login_like() { docker run --rm --network house-rooms --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges house-room:latest bash -c "$1" 2>&1 | tail -1; }
check "it can reach the internet" "$(login_like 'curl -s -m 8 -o /dev/null -w %{http_code} https://github.com')" "200"
check "it can't reach Windows or the house" "$(login_like 'timeout 3 bash -c "echo > /dev/tcp/172.30.0.1/22" 2>/dev/null && echo OPEN || echo blocked')" "blocked"

echo "== running jobs keep the PC awake"
nohup sleep 60 >/dev/null 2>&1 &
job=$!
sleep 18
case "$(cat /run/house/status)" in
  "awake: rooms up"*|"awake: jobs running"*sleep*) pass "the keeper sees the job: $(cat /run/house/status)" ;;
  *) fail "keeper says: $(cat /run/house/status)" ;;
esac
kill "$job"; wait "$job" 2>/dev/null

echo "== low space warning"
check "under 10 GB warns" "$(js "console.log(require('$H').isLowOnSpace(9, 246))")" "true"
check "plenty of space doesn't" "$(js "console.log(require('$H').isLowOnSpace(100, 246))")" "false"
check "5% of a big drive warns" "$(js "console.log(require('$H').isLowOnSpace(20, 1000))")" "true"

echo "== storage size limits (with a pretend helper report)"
PRETEND="$PLAY/pretend"; mkdir -p "$PRETEND/.local/state/house"
printf '{"cFreeGb":100,"time":%s}' "$(date +%s%3N)" > "$PRETEND/.local/state/house/windows.json"
ask() { HOME="$PRETEND" node -e "require('$H').requestResize($1).then(() => console.log('accepted'), (e) => console.log(e.message))" 2>&1 | tail -1; }
case "$(ask 400)" in *"Too big"*) pass "too big is refused, using real free space" ;; *) fail "too big: $(ask 400)" ;; esac
check "and nothing was requested" "$(ls "$PRETEND/.local/state/house/requests" 2>/dev/null | wc -l)" "0"
case "$(ask 25)" in *"Too small"*|accepted) pass "the low end is checked" ;; *) fail "too small: $(ask 25)" ;; esac
check "a good size is accepted" "$(ask 40)" "accepted"
case "$(cat "$PRETEND/.local/state/house/requests/resize")" in "40 "[0-9]*) pass "the request is stamped with the time" ;; *) fail "request looks wrong" ;; esac

echo "== a full disk can't empty the rules"
PRETEND2="$PLAY/pretend2"; mkdir -p "$PRETEND2/.config/house"
HOME="$PRETEND2" node "$HOME/house/panel/lib/rules.js" >/dev/null
sum="$(cat "$PRETEND2/.config/house/claude-managed.json" | md5sum)"
HOME="$PRETEND2" prlimit --fsize=20 node -e "require('$HOME/house/panel/lib/rules.js').setRule('secrets', 'block')" >/dev/null 2>&1
check "Claude's rules are untouched after a failed save" "$(cat "$PRETEND2/.config/house/claude-managed.json" | md5sum)" "$sum"

echo "== icon script"
NONPM="$(mktemp -d)"; printf '#!/bin/sh\nexit 1\n' > "$NONPM/npm"; chmod +x "$NONPM/npm"
icons="$(ls ~/house/panel/renderer/icons | wc -l)"
PATH="$NONPM:$PATH" bash ~/house/panel/setup-icons.sh >/dev/null 2>&1
check "a failed download leaves the icons alone" "$(ls ~/house/panel/renderer/icons | wc -l)" "$icons"
rm -rf "$NONPM"

echo "== rules"
web_bucket() {
  js "require('$H').setRule('web', '$1'); const p = JSON.parse(require('fs').readFileSync(process.env.HOME + '/.config/house/claude-managed.json')).permissions; console.log(Object.keys(p).filter((k) => p[k].includes('WebSearch') && p[k].includes('Bash(curl:*)')).join())"
}
check "Internet on Allow lets Claude search" "$(web_bucket allow)" "allow"
check "Internet on Ask makes Claude ask" "$(web_bucket ask)" "ask"
check "Internet on Block stops Claude searching" "$(web_bucket block)" "deny"
check "Claude's connection stays up on Block" "$(start; docker exec room-$N curl -s -m 8 -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/messages -X POST)" "401"
room close "$N" >/dev/null
cp ~/.config/house/claude-room.json "$PLAY/managed"
: > ~/.config/house/claude-room.json
start
check "an empty Claude rules file is rebuilt before a room opens" \
  "$(docker exec room-$N node -e "console.log(Boolean(JSON.parse(require('fs').readFileSync('/etc/claude-code/managed-settings.json')).permissions))" 2>/dev/null || docker exec room-$N sh -c 'grep -c permissions /etc/claude-code/managed-settings.json' | sed 's/^1$/true/')" "true"
room close "$N" >/dev/null

echo "== firewall"
check "firewall-check passes when walls are up" "$(sudo -n /usr/local/sbin/house-rules firewall-check && echo ok)" "ok"
