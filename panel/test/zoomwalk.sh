#!/bin/bash
# Runs test/zoomwalk.js with a throwaway HOME, starting maximized at 150%, the hardest zoom.
cd "$(dirname "$0")/.."
FAKE=/tmp/house-walk
rm -rf "$FAKE"
mkdir -p "$FAKE/out" "$FAKE/.config/house" "$FAKE/projects/sample-project" "$FAKE/projects/another-project/deep/folder/inside" "$FAKE/projects/small" "$FAKE/projects/big"
echo notes > "$FAKE/projects/readme.md"
echo keep > "$FAKE/projects/small/note.txt"
( cd "$FAKE/projects/big" && for i in $(seq 1 10000); do : > "file-$i.txt"; done )
echo '{"zoomLevel":1.5,"window":{"rect":{"x":303,"y":41,"w":1390,"h":918},"maximized":true}}' > "$FAKE/.config/house/panel.json"
HOME="$FAKE" NO_AT_BRIDGE=1 HOUSE_ZOOMWALK="$FAKE/out" timeout 240 node_modules/electron/dist/electron . 2>/dev/null | grep -E "^(PASS|FAIL)"
echo "app exit: ${PIPESTATUS[0]}"

# A damaged settings file must never stop the app opening.
for bad in 'null' '[]' 'not json at all' '{"window":{"rect":{"x":"a","y":99999}},"zoomLevel":"huge"}' '{"window":{"rect":{"x":99999,"y":99999,"w":5,"h":5}}}'; do
  printf '%s' "$bad" > "$FAKE/.config/house/panel.json"
  result="$(HOME="$FAKE" NO_AT_BRIDGE=1 HOUSE_FITTEST="$FAKE/out" timeout 60 node_modules/electron/dist/electron . 2>/dev/null | grep -E '^(PASS|FAIL) every width fits, system panel closed')"
  case "$result" in
    PASS*) echo "PASS opens with settings file: $bad" ;;
    *) echo "FAIL didn't open with settings file: $bad" ;;
  esac
done
