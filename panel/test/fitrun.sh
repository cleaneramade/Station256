#!/bin/bash
# Runs test/fittest.js with a throwaway HOME, so real settings and the open app are untouched.
# Starts as a small 115% window near the bottom right, the hardest place to grow from.
# Pictures go to /tmp/house-fit/out.
set -e
cd "$(dirname "$0")/.."
FAKE=/tmp/house-fit
rm -rf "$FAKE"
mkdir -p "$FAKE/out" "$FAKE/.config/house" "$FAKE/projects/sample-project" "$FAKE/projects/another-project"
echo notes > "$FAKE/projects/readme.md"
echo '{"zoomLevel":1.15,"window":{"rect":{"x":1000,"y":300,"w":900,"h":600},"maximized":false}}' > "$FAKE/.config/house/panel.json"
HOME="$FAKE" NO_AT_BRIDGE=1 HOUSE_FITTEST="$FAKE/out" timeout 120 node_modules/electron/dist/electron . 2>/dev/null | grep -E '^(PASS|FAIL|RESULT)'
