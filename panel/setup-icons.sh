#!/bin/bash
# Copies only the icons the page uses out of the Fluent icon package (MIT license).
# An icon named "home-filled" in the page uses the package's filled version.
set -u
cd "$(dirname "$0")"
# Stops here if the package can't be fetched, so the icons already in place are never wiped.
npm install --no-save --no-audit --no-fund @fluentui/svg-icons >/dev/null 2>&1 || { echo "Couldn't fetch the icon package. Nothing was changed."; exit 1; }
SRC=node_modules/@fluentui/svg-icons/icons
mkdir -p renderer/icons
rm -f renderer/icons/*.svg
for name in $(grep -oh 'data-i="[^"]*"' renderer/index.html | cut -d'"' -f2 | sort -u) square_multiple; do
  case "$name" in
    *-filled) file="${name%-filled}_20_filled.svg" ;;
    *) file="${name}_20_regular.svg" ;;
  esac
  if [ -f "$SRC/$file" ]; then
    cp "$SRC/$file" "renderer/icons/$name.svg"
  else
    echo "MISSING ICON: $name"
  fi
done
cp node_modules/@fluentui/svg-icons/LICENSE renderer/icons/LICENSE 2>/dev/null || true
rm -rf node_modules/@fluentui
ls renderer/icons | wc -l
