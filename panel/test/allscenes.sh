#!/bin/bash
# Runs every scene of shots.js on its own, each with the stand-ins it needs, one after another, and
# writes each one's PASS/FAIL count and its FAIL lines to a results file. One scene at a time keeps
# memory low, and run again it carries on where it stopped (scenes already in the file are skipped).
#   panel/test/allscenes.sh [results-file]      (default ~/.cache/station-allscenes.txt)
# Never touches a real room or real settings: every run has the throwaway home /tmp/house-shots-all.
set -u
cd "$(dirname "$0")/.."
OUT="${1:-$HOME/.cache/station-allscenes.txt}"
SLOT="$HOME/.local/share/lead-tools/testslot.sh"
[ -x "$SLOT" ] || SLOT=""
touch "$OUT"
# llamaMissing needs a PATH with no llama-server on it: only the stand-in docker.
NOLLAMA="$HOME/.cache/stub-nollama"
mkdir -p "$NOLLAMA"
[ -e "$NOLLAMA/docker" ] || ln -s "$PWD/test/stub/docker" "$NOLLAMA/docker"
free_port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
# videoFreeze and exportMemory measure with real videos: made once with ffmpeg, then kept.
VIDEOS="$HOME/.cache/station-test-videos"
make_videos() {
  mkdir -p "$VIDEOS"
  local ff=(ffmpeg -hide_banner -loglevel error -nostdin -y)
  local src=(-f lavfi -i testsrc2=duration=60:rate=30)
  local tone=(-f lavfi -i sine=frequency=440:duration=60)
  [ -s "$VIDEOS/hd.mp4" ] || "${ff[@]}" "${src[@]/testsrc2=/testsrc2=size=1920x1080:}" "${tone[@]}" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$VIDEOS/hd.mp4"
  [ -s "$VIDEOS/uhd.mp4" ] || "${ff[@]}" -f lavfi -i testsrc2=size=3840x2160:rate=30:duration=20 -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$VIDEOS/uhd.mp4"
  [ -s "$VIDEOS/hevc.mp4" ] || "${ff[@]}" -f lavfi -i testsrc2=size=1920x1080:rate=30:duration=20 -c:v libx265 -preset ultrafast -pix_fmt yuv420p -tag:v hvc1 "$VIDEOS/hevc.mp4"
  [ -s "$VIDEOS/old.avi" ] || "${ff[@]}" -f lavfi -i testsrc2=size=640x480:rate=25:duration=20 -c:v mpeg4 "$VIDEOS/old.avi"
  [ -s "$VIDEOS/export.mp4" ] || "${ff[@]}" "${src[@]/testsrc2=/testsrc2=size=1920x1080:}" "${tone[@]}" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a libopus -shortest "$VIDEOS/export.mp4"
}

list="$(SHOT_PATH="$PWD/test/stub" SHOT_HOME=/tmp/house-shots-all SHOT_TIMEOUT=90 $SLOT test/shotrun.sh list | sed -n 's/^INFO scenes //p' | tr ',' ' ')"
[ -n "$list" ] || { echo "FAIL couldn't list the scenes" >> "$OUT"; exit 1; }
for scene in $list; do
  grep -q "^== $scene " "$OUT" && continue
  vars=(SHOT_PATH="$PWD/test/stub")
  case "$scene" in
    preview|aiBrowser) vars=(SHOT_PATH="$PWD/test/stub-preview") ;;
    schedules) vars=(SHOT_PATH="$PWD/test/stub-schedules" HOUSE_SCHEDULE_TEST=1 HOUSE_SCHEDULE_UNIT=1500 HOUSE_SCHEDULE_LIMIT=2000) ;;
    llamaMissing) vars=(SHOT_PATH="$NOLLAMA" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin) ;;
    agentTabs) vars+=(STUB_AGENTS=live) ;;
    resume|closeOne|roomsAndHouse) vars+=(STUB_AGENTS=working) ;;
    searchMeaning) vars+=(HOUSE_JEV_URL="http://127.0.0.1:$(free_port)/v1/systemone") ;;
    videoFreeze|exportMemory) make_videos; vars+=(SHOT_VIDEOS="$VIDEOS") ;;
    # Needs the real Windows helper; panel/test/clipboard-windows.ps1 checks it from Windows instead.
    llamaReal) echo "== llamaReal skipped: real models, run it alone (see test/llama-real-scene.js)" >> "$OUT"; continue ;;
    clipboard) echo "== clipboard skipped: run panel/test/clipboard-windows.ps1 from Windows" >> "$OUT"; continue ;;
  esac
  start=$(date +%s)
  result="$(env "${vars[@]}" SHOT_HOME=/tmp/house-shots-all SHOT_TIMEOUT=600 $SLOT test/shotrun.sh "$scene" 2>&1)"
  {
    echo "== $scene pass=$(grep -c '^PASS' <<<"$result") fail=$(grep -c '^FAIL' <<<"$result") done=$(grep -c '^DONE' <<<"$result") secs=$(( $(date +%s) - start ))"
    grep '^FAIL' <<<"$result"
  } >> "$OUT"
done
echo "ALL DONE $(date '+%F %T')" >> "$OUT"
