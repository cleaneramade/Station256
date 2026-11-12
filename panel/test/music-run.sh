#!/bin/bash
# Runs music.test.js on made-up songs in /tmp/music-test, with a throwaway HOME so the Trash it uses
# is a throwaway too. Never points at real music.
cd "$(dirname "$0")/.."
export HOME=/tmp/music-test-home
# The stand-in for Windows (C:) is in the throwaway home too (lib/files.js, DOOR).
export HOUSE_SHOTS=/tmp/music-test-home/out
rm -rf /tmp/music-test
mkdir -p "$HOME" /tmp/music-test
node test/music.test.js /tmp/music-test
