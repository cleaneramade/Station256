#!/bin/bash
# Takes pictures of the panel with test/shots.js, in a window that is never shown, with a throwaway
# HOME so real settings and the open app are untouched. Pictures go to /tmp/house-shots/out.
#   shotrun.sh [scene,scene...]
# A fake "herdr" or "docker" can go first on PATH by setting SHOT_PATH. Canvases draw through Mesa's
# d3d12 driver, as with start.sh.
# While real rooms are open, always name the scenes, or set SHOT_PATH=panel/test/stub (from ~/house): with no list,
# the agents scenes ask the real Docker and look inside every open room, including the user's.
set -e
# SHOT_PATH is a list of folders like PATH. Made absolute before the cd below: a relative one
# (panel/test/stub) would point nowhere after it, and the real docker would answer instead of the fake.
if [ -n "${SHOT_PATH:-}" ]; then
  whole=""
  IFS=: read -ra parts <<< "$SHOT_PATH"
  for part in "${parts[@]}"; do
    case "$part" in /*) ;; *) part="$(cd "$part" 2>/dev/null && pwd)" || { echo "FAIL SHOT_PATH folder not found: $part"; exit 1; } ;; esac
    whole="${whole:+$whole:}$part"
  done
  SHOT_PATH="$whole"
fi
cd "$(dirname "$0")/.."
FAKE="${SHOT_HOME:-/tmp/house-shots}"
# This folder is wiped next, so it may only ever be a house-shots folder straight inside /tmp.
[[ "$FAKE" =~ ^/tmp/house-shots(-[A-Za-z0-9_]+)*$ ]] || { echo "FAIL SHOT_HOME must be /tmp/house-shots or /tmp/house-shots-NAME, not: $FAKE"; exit 1; }
rm -rf "$FAKE"
mkdir -p "$FAKE/out" "$FAKE/.config/house" "$FAKE/.local/state/house" "$FAKE/.local/bin"
# SHOT_EMPTY=1: no projects at all.
mkdir -p "$FAKE/projects"
[ -n "${SHOT_EMPTY:-}" ] || IFS=, read -ra names <<< "${SHOT_PROJECTS:-Notes App,Docs Site,SampleApp}"
for name in "${names[@]}"; do mkdir -p "$FAKE/projects/$name"; done
for name in Documents Pictures Music Videos Downloads; do mkdir -p "$FAKE/$name"; done
[ -n "${SHOT_EMPTY:-}" ] || echo notes > "$FAKE/projects/readme.md"
# A made-up room log in the same shape as the real one, so the Activity list has both kinds of line:
# a line with no time belongs to the one above it.
today="$(date +%F)"; before="$(date -d yesterday +%F)"
cat > "$FAKE/.local/state/house/room.log" <<LOG
$before 18:02:11 Notes App: room came up on attempt 2
$before 21:40:57 agents: the list couldn't be fully updated
$today 09:14:03 SampleApp: ssh didn't connect for tab-2, used docker exec
$today 11:30:45 Docs Site: room stopped while a terminal was open:
error: no such object: room-Docs.Site
$today 12:05:19 SampleApp: room is from an older blueprint, so tab-3 is a plain terminal
$today 13:47:32 Notes App: docker run failed on attempt 1
docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error mounting "/home/alex/Documents" to rootfs at "/home/dev/Documents": not a directory
LOG
echo '{"zoomLevel":1,"window":{"rect":{"x":60,"y":40,"w":1240,"h":800},"maximized":false},"navPane":{"width":172,"collapsed":false},"viewMode":"details"}' > "$FAKE/.config/house/panel.json"
# HOUSE_CLEANUP=0: a test copy never starts the daily clean-up by itself (the cleanup scene presses the button).
GALLIUM_DRIVER="${GALLIUM_DRIVER:-d3d12}" HOME="$FAKE" PATH="${SHOT_PATH:+$SHOT_PATH:}$PATH" NO_AT_BRIDGE=1 HOUSE_SHOTS="$FAKE/out" HOUSE_SHOTS_SCENES="${1:-}" HOUSE_CLEANUP="${HOUSE_CLEANUP:-0}" \
  timeout "${SHOT_TIMEOUT:-180}" node_modules/electron/dist/electron . ${SHOT_ARGS:-} 2>/dev/null | grep -E '^(SHOT|FAIL|PASS|INFO|DONE|COPIED)'
