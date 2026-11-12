#!/bin/bash
# The Linux half of windows/snap-both-ways.ps1. Stops the real app only if idle, then runs a test
# copy until that script says it's finished, and puts your window settings back.
main=$(pgrep -f 'electron/dist/electron \.$' | head -1)
if [ -n "$main" ]; then
  if [ "$(pstree -p "$main" | grep -c -E 'bash|docker')" != 0 ] || [ "$(docker ps -q | wc -l)" != 0 ]; then echo BUSY > /tmp/snaptest/result.txt; exit 9; fi
  kill "$main"; for i in $(seq 1 20); do kill -0 "$main" 2>/dev/null || break; sleep 0.5; done
fi
cd ~/house/panel || exit 1
cp ~/.config/house/panel.json /tmp/snaptest/panel-backup.json
echo '{"zoomLevel":1,"window":{"rect":{"x":300,"y":60,"w":1100,"h":760},"maximized":false}}' > ~/.config/house/panel.json
NO_AT_BRIDGE=1 HOUSE_SNAPTEST=/tmp/snaptest timeout 200 node_modules/electron/dist/electron . 2>/dev/null | grep -vE 'ERROR|WARNING|dbus' >> /tmp/snaptest/result.txt
cp /tmp/snaptest/panel-backup.json ~/.config/house/panel.json
echo DONE >> /tmp/snaptest/result.txt
