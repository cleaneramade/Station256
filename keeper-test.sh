#!/bin/bash
# Checks which programs the house keeper counts as jobs (house_jobs in house-keeper.sh), using
# made-up process lists, so nothing real is started or stopped. Run: bash ~/house/keeper-test.sh
exec </dev/null
cd "$(dirname "$0")" || exit 1
FAKE="$(mktemp -d)"
trap 'rm -rf "$FAKE"' EXIT
failed=0

# Only the house_jobs function, taken out of the keeper (the keeper itself loops forever).
eval "$(sed -n '/^house_jobs() {/,/^}/p' house-keeper.sh)"
type house_jobs >/dev/null 2>&1 || { echo "FAIL house_jobs not found in house-keeper.sh"; exit 1; }
HOUSE_USER="$(id -un)"
U="$(id -u)"

# Stand-ins: ps prints the table in $FAKE/table, pgrep -x login prints pid 300.
printf '#!/bin/sh\ncat "%s/table"\n' "$FAKE" > "$FAKE/ps"
printf '#!/bin/sh\n[ "$2" = login ] && echo 300\n' > "$FAKE/pgrep"
chmod +x "$FAKE/ps" "$FAKE/pgrep"

# case NAME EXPECTED, then the table (pid ppid euid name) on stdin. Every table gets init,
# WSL's hidden login shell and a desktop helper, none of which may ever count.
case_() {
  { echo "1 0 0 systemd"; echo "300 1 0 login"; echo "301 300 $U bash"; echo "50 1 $U dbus-daemon"; cat; } > "$FAKE/table"
  local got; got="$(PATH="$FAKE:$PATH" house_jobs)"
  if [ "$got" = "$2" ]; then echo "PASS $1"; else echo "FAIL $1: got '$got', wanted '$2'"; failed=$((failed + 1)); fi
}

case_ "nothing running" "" </dev/null
case_ "a Herdr left with an empty shell does not count" "" <<EOF
100 1 $U herdr
101 100 $U bash
102 100 $U bash
EOF
case_ "a program in a Herdr shell still counts, and its shell too" "bash,node" <<EOF
100 1 $U herdr
101 100 $U bash
103 101 $U node
EOF
case_ "something run as another user (sudo) in a Herdr shell still counts" "bash" <<EOF
100 1 $U herdr
101 100 $U bash
104 101 0 sudo
EOF
case_ "a shell inside a Herdr shell still counts the outer one" "bash" <<EOF
100 1 $U herdr
101 100 $U bash
105 101 $U bash
EOF
case_ "a background shell outside Herdr still counts" "bash" <<EOF
200 1 $U bash
EOF
case_ "the panel still counts" "electron" <<EOF
400 1 $U electron
EOF
case_ "another user's programs never count" "" <<EOF
500 1 0 cron
EOF
case_ "the schedules runner waiting for a task does not count" "" <<EOF
500 1 $U house-schedules
EOF
case_ "a task the schedules runner is running does count" "docker" <<EOF
500 1 $U house-schedules
501 500 $U docker
EOF
case_ "a mix" "electron,node" <<EOF
100 1 $U herdr
101 100 $U bash
400 1 $U electron
600 1 $U node
EOF

echo "== real house, right now: $(house_jobs)"
[ "$failed" -eq 0 ] && echo "ALL PASSED" || echo "$failed FAILED"
exit "$failed"
