#!/bin/bash
# Starts Station 256.
cd "$(dirname "$0")" || exit 1
mkdir -p "$HOME/.local/state/house"
# HOUSE_OZONE=wayland, or "wayland" in ~/.config/house/ozone, runs Station as a Wayland app; with
# neither, Electron picks X11 (its default). Every start path (shortcut, helper, restart) runs this
# script, so the file covers them all.
OZONE=()
MODE="${HOUSE_OZONE:-$(cat "$HOME/.config/house/ozone" 2>/dev/null)}"
[ -n "$MODE" ] && OZONE=("--ozone-platform=$MODE")
WAYLAND=""
[ "$MODE" = wayland ] && WAYLAND=1
for arg in "$@"; do [ "$arg" = --ozone-platform=wayland ] && WAYLAND=1; done
# Under Wayland the window's app_id is the package name ("station-256"). WSLg looks that name up as
# a .desktop file to pick the taskbar icon, so keep one that points at Station's icon.
DESKTOP="$HOME/.local/share/applications/station-256.desktop"
ENTRY="[Desktop Entry]
Type=Application
Name=Station 256
Exec=$PWD/start.sh
Icon=$PWD/assets/station-256.png
StartupWMClass=station-256"
if [ -n "$WAYLAND" ] && [ "$(cat "$DESKTOP" 2>/dev/null)" != "$ENTRY" ]; then
  mkdir -p "${DESKTOP%/*}" && printf '%s
' "$ENTRY" > "$DESKTOP"
fi
# Logs are trimmed to their last 1 MB once they pass 5 MB, so they can't grow forever.
# Not with --new-window (Alt+L while it's open, see windows/station-keys.ps1): that only asks the
# running app for another window, and the app is writing to the logs.
if [ "${1:-}" != "--new-window" ]; then
  for log in panel room helper; do
    file="$HOME/.local/state/house/$log.log"
    if [ "$(stat -c %s "$file" 2>/dev/null || echo 0)" -gt 5242880 ]; then
      tail -c 1048576 "$file" > "$file.new" && mv "$file.new" "$file"
    fi
  done
fi
# The video editor's canvases draw on the graphics card through Mesa's d3d12 driver (main.js says
# why, and takes it back out for the terminals and programs Station starts).
if [ -z "${GALLIUM_DRIVER:-}" ]; then
  export GALLIUM_DRIVER=d3d12 HOUSE_PICKED_GL=1
fi
# Stops a desktop accessibility helper that would otherwise linger after the panel closes.
export NO_AT_BRIDGE=1
LOG="$HOME/.local/state/house/panel.log"
# HOUSE_ELECTRON and HOUSE_RESTART_WAIT are only for tests (test/start-supervisor.test.sh).
ELECTRON="${HOUSE_ELECTRON:-node_modules/electron/dist/electron}"
WAIT="${HOUSE_RESTART_WAIT:-2}"
# Alt+L only asks the running app for a window: nothing to watch over.
if [ "${1:-}" = "--new-window" ]; then
  exec "$ELECTRON" . "${OZONE[@]}" "$@" >> "$LOG" 2>&1
fi

# Keeps Station running: started again after a crash or the out-of-memory killer, but not after a
# normal quit (exit 0, which is also a second copy handing over to the open one) or when someone
# stopped it on purpose (SIGTERM, SIGINT, SIGHUP: 143, 130, 129). At most 3 restarts in 10 minutes.
child=""
stopping=""
# Stopping this script stops the app, and that doesn't count as a crash.
stop() {
  stopping=1
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null
}
trap stop TERM INT HUP
restarts=()
while :; do
  "$ELECTRON" . "${OZONE[@]}" "$@" >> "$LOG" 2>&1 &
  child=$!
  # A signal to this script interrupts wait: go round again until the app has really ended.
  while :; do
    wait "$child"
    status=$?
    kill -0 "$child" 2>/dev/null || break
  done
  child=""
  if [ -n "$stopping" ] || [ "$status" -eq 0 ] || [ "$status" -eq 143 ] || [ "$status" -eq 130 ] || [ "$status" -eq 129 ]; then
    exit "$status"
  fi
  # Forget restarts older than 10 minutes.
  recent=()
  for when in "${restarts[@]}"; do
    [ $((SECONDS - when)) -lt 600 ] && recent+=("$when")
  done
  restarts=("${recent[@]}")
  if [ "${#restarts[@]}" -ge 3 ]; then
    echo "[station] stopped unexpectedly 4 times in 10 minutes; not starting again ($(date '+%F %T'))" >> "$LOG"
    exit "$status"
  fi
  restarts+=("$SECONDS")
  echo "[station] stopped unexpectedly (status $status) at $(date '+%F %T'), starting again" >> "$LOG"
  sleep "$WAIT" &
  wait $!
  [ -n "$stopping" ] && exit "$status"
done
