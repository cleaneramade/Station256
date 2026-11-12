#!/usr/bin/env bash
# Tests the Internet rule with the real Claude, on every setting, in a room and in the house.
# Uses a throwaway project and puts your rules back. Each run uses a little of your Claude usage.
set -u
export PATH="$HOME/.local/bin:$PATH"
N=zz-web-test
R="$HOME/house/panel/lib/rules.js"
SAVED_RULES="$(cat ~/.config/house/rules.json)"
cleanup() {
  room close "$N" >/dev/null 2>&1
  docker volume rm "house-claude-$N" >/dev/null 2>&1
  rm -rf "$HOME/projects/$N"
  printf '%s\n' "$SAVED_RULES" > ~/.config/house/rules.json
  node "$R" >/dev/null
}
trap cleanup EXIT
set_rule() { node -e "require('$R').setRule('web', '$1')"; }
SEARCH='Use the WebSearch tool to search for: population of Iceland. Then answer in one short sentence. If you cannot search, say NO-SEARCH and answer from what you know.'
CURL='Run this exact command with the Bash tool: curl -s -o /dev/null -w "%{http_code}" https://example.com . Then reply with only what it printed, or NO-CURL if you could not run it.'

# Reads Claude's step-by-step output and sums up what it tried and what happened.
SUMMARY='
const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const tools = new Set();
for (const l of lines) for (const c of (l.message && l.message.content) || []) if (c.type === "tool_use") tools.add(c.name);
const end = lines.find((l) => l.type === "result") || {};
const denied = (end.permission_denials || []).map((d) => d.tool_name);
console.log(JSON.stringify({ tried: [...tools], denied, working: end.is_error === false, says: String(end.result || "").replace(/\s+/g, " ").slice(0, 130) }));
'
ask_room() { docker exec -w /workspace "room-$N" timeout 150 claude -p "$1" --model haiku --output-format stream-json --verbose </dev/null 2>/dev/null | node -e "$SUMMARY"; }

mkdir -p "$HOME/projects/$N"
timeout 90 room open "$N" </dev/null >/dev/null 2>&1

if [ -z "${SCREEN_ONLY:-}" ]; then
for mode in block allow ask; do
  set_rule "$mode"
  echo "== room, Internet on ${mode^^}"
  echo "web search: $(ask_room "$SEARCH")"
  echo "opening a site: $(ask_room "$CURL")"
done

echo "== room, a command you run yourself on BLOCK stays online"
set_rule block
echo "by hand: $(docker exec "room-$N" curl -s -m 8 -o /dev/null -w '%{http_code}' https://example.com)"

echo "== the rule also applies to Claude in the house, outside any room"
echo "rules in place for the house: $(readlink -f /etc/claude-code/managed-settings.json)"
PROBE="$(mktemp -d)"
ask_house() {
  ( cd "$PROBE" && CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.config/house/claude-token)" timeout 150 claude -p "$1" --model haiku --output-format stream-json --verbose </dev/null 2>/dev/null ) | node -e "$SUMMARY"
}
echo "house, on BLOCK, web search: $(ask_house "$SEARCH")"
set_rule allow
echo "house, on ALLOW, web search: $(ask_house "$SEARCH")"
rm -rf "$PROBE"
fi

echo "== real screen: on ASK, does Claude actually stop and ask you?"
set_rule ask
cat > "$HOME/.cache/ask-driver.py" <<'PY'
import fcntl, os, pty, re, select, signal, struct, sys, termios, time
room, answer, prompt = sys.argv[1:4]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 130, 0, 0))  # a real window size
    os.execvp("docker", ["docker", "exec", "-it", "-e", "TERM=xterm-256color", "-w", "/workspace", room, "claude", "--model", "haiku", prompt])
text = ""; asked = False; answered_at = None; last_enter = 0; start = time.time()
clean = lambda s: re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-B]|\x1b\][^\x07]*\x07", " ", s)
while time.time() - start < 120:
    ready, _, _ = select.select([fd], [], [], 0.5)
    if ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        text += data.decode("utf8", "replace")
    screen = clean(text[-6000:])
    squashed = re.sub(r"\s+", " ", screen)
    now = time.time()
    if not asked and re.search(r"Do you want to (proceed|allow)|Allow .*(search|WebSearch)", squashed) and re.search(r"WebSearch|[Ww]eb [Ss]earch", squashed):
        asked = True
        print("Claude stopped and asked: YES")
        print("question on screen:", re.sub(r"\s+", " ", screen)[-260:])
        time.sleep(1)
        os.write(fd, b"\x1b" if answer == "no" else b"\r")
        answered_at = now
        text = ""  # only what comes after the answer counts
    elif not asked and now - last_enter > 4 and re.search(r"trust|Press Enter|text style|Choose|Security notes|Yes, proceed", squashed[-700:]):
        print("first-run screen, pressing Enter:", squashed[-110:])
        # On the trust screen the first choice is "No, exit", so it moves down to Yes first.
        os.write(fd, b"\x1b[B\r" if "Yes, I trust" in squashed[-400:] else b"\r")
        text = ""
        last_enter = now
    if answered_at and now - answered_at > 35:
        break
screen = re.sub(r"\s+", " ", clean(text))
if not asked:
    print("Claude stopped and asked: NO")
    print("end of screen:", screen[-400:])
else:
    print("gave a searched answer afterward:", bool(re.search(r"Iceland's population|\d{3},\d{3}", screen)))
    print("said it was stopped:", bool(re.search(r"Interrupted|rejected|declined|didn't want", screen)))
    print("end of screen:", re.sub(r"[─╌]+", " ", screen)[-220:])
try:
    os.kill(pid, signal.SIGKILL)
except OSError:
    pass
PY
PROMPT='Use the WebSearch tool to search for: population of Iceland. Answer in one sentence.'
echo "--- answering NO"
timeout 150 python3 "$HOME/.cache/ask-driver.py" "room-$N" no "$PROMPT" 2>&1 | cut -c1-420
echo "--- answering YES"
timeout 150 python3 "$HOME/.cache/ask-driver.py" "room-$N" yes "$PROMPT" 2>&1 | cut -c1-420
rm -f "$HOME/.cache/ask-driver.py"
