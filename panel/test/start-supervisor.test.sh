#!/bin/bash
# Tests the supervisor in start.sh with a fake Electron (HOUSE_ELECTRON). HOME is a temp folder, so
# the log goes there. Run: bash panel/test/start-supervisor.test.sh
START="$(cd "$(dirname "$0")/.." && pwd)/start.sh"
TMP="$(mktemp -d /tmp/house-supervisor-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" HOUSE_RESTART_WAIT=0.1 GALLIUM_DRIVER=none
mkdir -p "$HOME"
LOG="$HOME/.local/state/house/panel.log"
fail=0
report() { if [ "$1" = ok ]; then echo "PASS supervisor: $2"; else echo "FAIL supervisor: $2"; fail=1; fi; }

# The fake: counts its runs in $TMP/count and ends with the next status of $FAKE_STATUSES.
cat > "$TMP/fake" <<'FAKE'
#!/bin/bash
n=$(( $(cat "$FAKE_COUNT" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAKE_COUNT"
echo "fake run $n args: $*"
read -ra list <<< "$FAKE_STATUSES"
exit "${list[$((n - 1))]:-0}"
FAKE
chmod 755 "$TMP/fake"
export HOUSE_ELECTRON="$TMP/fake" FAKE_COUNT="$TMP/count"

# Runs start.sh with these statuses; sets runs and code.
try() {
  rm -f "$FAKE_COUNT" "$LOG"
  export FAKE_STATUSES="$1"
  shift
  timeout 20 bash "$START" "$@"
  code=$?
  runs=$(cat "$FAKE_COUNT" 2>/dev/null || echo 0)
}

try "0"
[ "$runs" = 1 ] && [ "$code" = 0 ] && report ok "exit 0 is not restarted" || report bad "exit 0 is not restarted (runs $runs, code $code)"
try "143"
[ "$runs" = 1 ] && [ "$code" = 143 ] && ! grep -q unexpectedly "$LOG" && report ok "status 143 is not restarted" || report bad "status 143 is not restarted (runs $runs, code $code)"
try "130"
[ "$runs" = 1 ] && report ok "status 130 is not restarted" || report bad "status 130 is not restarted (runs $runs)"
try "129"
[ "$runs" = 1 ] && report ok "status 129 is not restarted" || report bad "status 129 is not restarted (runs $runs)"
try "139 0"
[ "$runs" = 2 ] && [ "$code" = 0 ] && grep -q '^\[station\] stopped unexpectedly (status 139) at .*, starting again$' "$LOG" && report ok "a crash then 0: one restart, then stop, with a log line" || report bad "a crash then 0 (runs $runs, code $code)"
try "1 137 139 134"
[ "$runs" = 4 ] && [ "$code" = 134 ] && grep -q 'stopped unexpectedly 4 times in 10 minutes; not starting again' "$LOG" && [ "$(grep -c ', starting again$' "$LOG")" = 3 ] && report ok "four crashes: three restarts, then gives up with the line in the log" || report bad "four crashes (runs $runs, code $code)"
try "0" --new-window
grep -q 'args: . --new-window' "$LOG" && [ "$runs" = 1 ] && report ok "--new-window runs once, passes the flag" || report bad "--new-window (runs $runs)"
try "5 5 5 5 5" --new-window
[ "$runs" = 1 ] && [ "$code" = 5 ] && ! grep -q unexpectedly "$LOG" && report ok "--new-window doesn't loop" || report bad "--new-window doesn't loop (runs $runs)"


# Wayland: off by default, on by HOUSE_OZONE, by ~/.config/house/ozone, or by the argument. The
# station-256.desktop file is only written when it's on.
DESK="$HOME/.local/share/applications/station-256.desktop"
try "0"
! grep -q 'ozone-platform' "$LOG" && [ ! -f "$DESK" ] && report ok "default: no ozone flag, no .desktop file" || report bad "default ozone"
HOUSE_OZONE=wayland try "0"
grep -q 'args: . --ozone-platform=wayland$' "$LOG" && [ -f "$DESK" ] && report ok "HOUSE_OZONE=wayland: flag and .desktop file" || report bad "HOUSE_OZONE"
rm -f "$DESK"
mkdir -p "$HOME/.config/house"; echo wayland > "$HOME/.config/house/ozone"
try "139 0"
[ "$(grep -c 'args: . --ozone-platform=wayland$' "$LOG")" = 2 ] && [ -f "$DESK" ] && report ok "ozone file: flag on the start and on the restart, .desktop file" || report bad "ozone file"
rm -f "$HOME/.config/house/ozone" "$DESK"
try "0" --ozone-platform=wayland
grep -q 'args: . --ozone-platform=wayland$' "$LOG" && [ -f "$DESK" ] && report ok "--ozone-platform=wayland argument: .desktop file" || report bad "ozone argument"
rm -f "$DESK"
# SIGTERM to start.sh reaches the fake, and it isn't started again.
cat > "$TMP/slow" <<'FAKE'
#!/bin/bash
n=$(( $(cat "$FAKE_COUNT" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAKE_COUNT"
trap 'echo got-term > "$FAKE_COUNT.term"; exit 143' TERM
sleep 30 & wait $!
FAKE
chmod 755 "$TMP/slow"
rm -f "$FAKE_COUNT" "$FAKE_COUNT.term" "$LOG"
HOUSE_ELECTRON="$TMP/slow" bash "$START" &
pid=$!
for _ in $(seq 50); do [ -f "$FAKE_COUNT" ] && break; sleep 0.1; done
sleep 0.3
kill -TERM "$pid"
for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid"; fi
wait "$pid" 2>/dev/null
code=$?
sleep 0.5
[ -f "$FAKE_COUNT.term" ] && [ "$(cat "$FAKE_COUNT")" = 1 ] && [ "$code" = 143 ] && ! grep -q unexpectedly "$LOG" && report ok "SIGTERM to start.sh reaches the app and doesn't restart it" || report bad "SIGTERM (term file: $(ls "$FAKE_COUNT.term" 2>&1), runs $(cat "$FAKE_COUNT"), code $code)"

exit $fail
