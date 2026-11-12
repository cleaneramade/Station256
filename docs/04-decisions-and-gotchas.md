# Decisions already made, and every trap we hit

This is the most valuable file in the backup. Everything here cost time to learn.

---

## Settled decisions — do not re-open

| Decision | Date | Why |
|---|---|---|
| Docker **Engine** inside Ubuntu, not Docker Desktop | 2026-11-03 | Desktop puts the daemon back on the Windows side |
| Station 256 stays a **Linux** app | 2026-11-04 | explicit user decision after the window-motion fight; do not propose moving the window to Windows again |
| AI runs **only inside rooms** | 2026-11-04 | the house itself cannot be hard-locked while `docker` group is root-equivalent |
| **House rules only**, no per-project rules | 2026-11-03 | simplicity for now |
| Unlocked Windows door is **read-only for AI** | 2026-11-04 | never change or delete on the Windows side |
| Terminals open as **tabs inside the app**, with a Chrome-style pop-out button | 2026-11-04 | user's design call |
| **Any tab** (Files, terminal, Agents, Rules) can become its own window, a full Station 256 window with its own tabs, as in Chrome; **only when its window has 2+ tabs** (a window's last tab stays) | 2026-11-09 | user's design call: "pointless to have that option if only one tab" |
| Carrying tabs out and in must feel smooth: a window is **got ready out of sight** as a tab starts being carried (kept 3 min, ~150 MB), and the carried picture stands in until the real window is on screen | 2026-11-09 | user: "make sure that it's a lot smoother when dragging out and in"; the slow part on the real screen is Windows showing a new window, which a picture can cover but nothing can skip |
| Panel must match **Windows 11 File Explorer**, light theme | 2026-11-04 | the "new-age File Explorer" idea only lands if it looks native |
| **Asleep when unused** | 2026-11-06 | replaced the earlier "no Windows startup entry" rule after the user measured ~500-630 MB idle |
| Internet is the Claude `web` rule, not a firewall switch | 2026-11-05 | Claude needs internet to function |
| Storage is one **unified pool**, no partition | 2026-11-03 | house capped at 250 GB of the drive |
| **Foundation closed** | 2026-11-05 | now in micro-fixing; real project work starts in parallel |

## Working rules the user set

- During the build, Claude acts as Windows administrator and may move between
  Windows and the house. **Once developing, what happens in the house stays in
  the house.**
- Keep moving with minimal explanation; open windows when the user needs to act.
- When the user states an order of work ("X first"), do X first and do not
  continue other work in the same turn.
- Anything outside a project folder that is lost in a crash is fine. Everything
  should be tied to the project.
- Measure on-screen frames before showing motion work. The user is impatient
  with repeated "try it" rounds.
- "Enough test windows" — keep window-opening tests to a single run, and never
  pin windows on top.
- Common-sense detail checks against the real thing before showing work.

---

## Traps — the Windows side

**`wsl.exe` launched from Windows strips quotes and expands `$`.**
Run any multi-line or quote-heavy check from a script **file** instead of
inlining it.

**`/mnt/c` does not exist in the house.** `automount` is off, so you cannot pass
a script in via `/mnt/c/...`. Copy it in over `\\wsl.localhost\Ubuntu\...` first.

**Editing files over `\\wsl.localhost` drops the execute bit.** Always `chmod +x`
scripts after editing them from Windows.

**Copy test scripts out of the UNC path before running them.** PowerShell will
not run `windows/snap-both-ways.ps1` or `seam-form.ps1` from a UNC path.

**Antivirus software can delete unsigned local launcher executables.** A small C# launcher
`.exe` was removed by an antivirus (a behaviour heuristic). It was the only detection in the
build. Use PowerShell plus `.lnk` shortcuts. **Never add antivirus exclusions
without asking.**

**Do not set the machine-wide `RestoreConnection` value.** It would affect every
other mapped network drive.

**`DeferFlags=1` on `HKCU\Network\L` does not delay the WSL engine.** Tried,
measured (engine still up 17 s after boot), removed.

---

## Traps — WSLg and the window

**WSLg shows junk frames for ~125 ms on any real resize, and freezes all Linux
windows for ~200 ms.** This is the single reason for the
never-resize-the-real-window design.

**A Linux window cannot un-minimize itself over WSLg.** The shortcut's
`open-panel.ps1` restores it from the Windows side instead.

**An open Linux window appears to hold the PC awake by itself.** The sleep report
shows msrdc raising a "RAIL Power Request" on SYSTEM and DISPLAY while the panel
is open.

**WSLg exposes no compression or colour setting.** Checked in its source. The
clarity pass had to be done with LCD text plus fontconfig, darker text, and
filled colour icons.

**Windows display is 125% here and WSLg draws 1:1.** Hence panel zoom defaulting
to 1.25, later `BASE_ZOOM` 1.35 at the user's request, saved in
`~/.config/house/panel.json`.

**Hidden-window tests (`HOUSE_FITTEST`) get no animations, no ResizeObserver and
no fast input.** Anything about timing belongs in the visible
`panel/test/zoomwalk.sh`.

**Clicking the app icon while it is already running only refocuses the old
process.** Before believing a test report, confirm the running process is newer
than the fix.

**Quitting Station 256 kills its terminal tabs** (`terminals.killAll`) while
rooms stay up. Never restart the app while a terminal or room is open without
asking.

**Station takes about a minute to close** after `WM_CLOSE`/`SC_CLOSE` is sent
from Windows. Closing by hand with the X button has not been tried yet.

---

## Traps — testing

These rules exist because a test broke something real:

- **Never write to the clipboard in a test.** One test overwrote the user's
  clipboard on 2026-11-05 (disclosed at the time).
- **Back up `panel.json` before a selftest.** The selftest writes the real file
  and once overwrote the user's window size (restored).
- **Never screen-capture the user's desktop without asking.** A capture once
  grabbed their browser because the panel was behind it. Use the `HOUSE_SHOT`
  page capture, or ask for a screenshot.
- **Never press keys without confirmed focus**, and note that tapping `Alt` on an
  already-focused window swallows the keys.
- **Never pipe a mouse-driving script through `Select-Object -First`.** One died
  mid-drag while holding the button down.
- **Never rebuild a seam element while it is being held.**
- **Results go to a file**, not to the console.
- **Blank real windows before taking any test photo of the tray.**
- **`/tmp` is wiped by a house shutdown** — test helpers must not live there.
- **Room tests must not use `echo exit | script`.** Start rooms with
  `room open NAME </dev/null`.

---

## Open questions and known-unexplained things

| Thing | Status |
|---|---|
| One early run had rooms stopped: "container not running", dockerd "healthcheck failed fatally" around 15:18 on a just-booted house, right after a room rebuild | never reproduced in 3 post-boot attempts; cause unknown |
| Real sleep took ~14 minutes instead of 10 | unexplained |
| House woke 4 s after the Windows Claude session resumed | the session probably woke it, not proven |
| Staying asleep with the Claude session closed | not tested |
| One first-drag miss in about 7 full seam runs, right after the test's Alt focus trick; 0 of 20 in a dedicated repeat | not explained |
| Right-click "Open Linux terminal here" | logic dry-run tested; the actual click never confirmed by the user |
| Black-flash removal via `conhost --headless` | awaiting user confirmation |
| Dragging tabs out, between windows, and a lone-tab window onto another's tabs | the user tried it with a real mouse (2026-11-09): it worked, but needed to be "a lot smoother". The smoother version (window got ready out of sight, picture that grows into the window and stays until it's on screen, lone-tab window fading to its tab) is checked with a stand-in pointer only; whether Windows puts the new window above the old one, which the hand-off assumes, is not yet seen |
| Windows snapping (Win+arrows, seams) and file drops from Windows on a second window | the helper follows the top "Station 256" window and main.js routes to the window used last; not yet seen on the real screen |
| Claude's Station Blue look depends on Claude Code honouring `theme` in managed settings | proven on Claude Code 2.1.318 (2026-11-07): a room whose own config said "light" drew Station blue 11 times, the same room without the managed file 0 times. Re-checked on 2.1.319: all of Claude's own text turns blue; only the big welcome logo stays Claude orange, because Claude Code draws it in a fixed colour no theme can change. Check again after a Claude Code update: start `claude` in a room and look for blue |
| WSLg carries clipboard text both ways by itself while a Linux app owns it | so the helper only puts text on Windows when Windows doesn't have it yet, a moment later; both sides changing the clipboard in the same moment crashed WSLg once (2026-11-07) |
| Opening Station 256 can replace the house's clipboard text once | by design: when the panel links to the helper, the helper sends the text copied in Windows, and the house takes it if it's different, since Windows has the newer copy then |
| Window motion feel after the curve change to `cubic-bezier(0.22, 1, 0.36, 1)`, 280 ms | awaiting the user's verdict |

## Things the user owns and will raise

- Motion verdict
- GitHub connection (deferred to the UI step; plan is a token connector that
  picks or creates a repo per project from the UI)
- Hand-testing, done together. Claude generates test files such as video or
  audio when asked.

## Not built yet

- The control panel's later phases: 2) explorer plus previews, 3) task manager
  plus storage
- GitHub connection
- A Windows-native version of the explorer, possibly a public repo for Windows
  users (months out)

## Where things live that are NOT in the repo

| Thing | Path | Source in repo |
|---|---|---|
| Windows scripts | `%LOCALAPPDATA%\LinuxHouse` | `house/windows/` |
| WSL config | `C:\Users\your-user\.wslconfig` | `house/windows/wslconfig` |
| WSL boot config | `/etc/wsl.conf` | `house/system/wsl.conf` |
| Keeper idle time | `/etc/default/house-keeper` | `house/system/house-keeper.default` |
| Sudoers line | `/etc/sudoers.d/house-rules` | `house/system/sudoers-house-rules` |
| Service units | `/etc/systemd/system/house-*.service` | `house/house-*.service` |
| Admin scripts | `/usr/local/sbin/house-{rules,firewall,keeper}` | `house/house-*.sh` |
| `room` on PATH | `~/.local/bin/room` (symlink) | `house/bin/room` |
| Claude managed settings | `/etc/claude-code/managed-settings.json` (symlink) | generated from `rules.json` |
| Claude's Station Blue look | `~/.claude/themes/station-blue.json` (rewritten whenever the rules are written; a test with a pretend HOME writes its own copy) | `house/room/station-blue.json` |
| Live rules and window state | `~/.config/house/{rules,panel}.json` | `restore/config-samples/` |
| **Claude token** | `~/.config/house/claude-token` | **not backed up — log in again** |
| **Link secret** | `~/.local/state/house/link-token` | **not backed up — regenerated** |
| **Segoe UI fonts**, plus Segoe UI Symbol and Emoji, Microsoft YaHei, Yu Gothic and Malgun Gothic for the terminal (added 2026-11-07, copied from `C:\Windows\Fonts`) | `~/.local/share/fonts/windows-local` | **never copy — licensed with Windows** |

Registry entries live in `windows/registry/station-256-hkcu.reg`.

## Git state

Local repo at `~/house`.

`main` is the branch that matches what is installed.
works on its own `session/<date>-<topic>` branch and fast-forwards `main` when
it is committed.

```
6725d86  (main)  Say plainly that a dry run cannot preview staged files
7aa7a93  Stage the backup folder files into the repo automatically
9c6c3fc  Keep the project docs and workflow scripts in the repo
6fdf085  Keep the backup and commit workflow in the repo
fbb7c95  Add the Station 256 installer
4431e86  Snap Station 256 with Windows both ways, add the internet rule, sleep when unused
86c7326  Harden the house and finish the foundation review
6a6b28a  Keep the room command in the repo
179dcd5  Fit Station 256 at every size and zoom, and add our own hover text
4808be8  Add Station 256 and the house foundation
```

The old `station-snapping-and-sleep` branch is now fully inside `main` and can
be deleted whenever.
