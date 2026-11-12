# Tests

All test scripts live in the repo and are mirrored in `house/`.

## Inside the house

| Script | Covers |
|---|---|
| `safety-test.sh` | break-out attempts and failure cases |
| `room-test.sh` | create, open, close, list rooms |
| `rules-test.sh` | Allow / Ask / Block enforcement |
| `web-rule-test.sh` | the internet (`web`) rule |
| `keeper-test.sh` | which programs keep the house awake (made-up process lists, nothing real is touched) |
| `panel/test/selftest.js` | panel logic, run with `HOUSE_SELFTEST=<dir>` |
| `panel/test/fitrun.sh` + `fittest.js` | layout at every size, hidden windows |
| `panel/test/zoomwalk.sh` + `zoomwalk.js` | real visible windows, every size and zoom |
| `panel/test/snaprun.sh` + `snaptest.js` | snapping |

Run them from `~/house`:

```bash
cd ~/house
./keeper-test.sh && ./safety-test.sh && ./room-test.sh && ./rules-test.sh && ./web-rule-test.sh
```

Panel unit checks (plain node, nothing real touched), from `~/house/panel`:

```bash
for t in agent-alerts ai-rules pasted-image preview docx protect-home github schedule schedule-runner search jev tokens; do node test/$t.test.js | tail -1; done
test/music-run.sh   # the Song page's checks; it makes its own throwaway home under /tmp
```

Pictures and checks of the real panel in a hidden window run through
`panel/test/shotrun.sh scene,scene` with a throwaway home. Name the scenes,
use an absolute `SHOT_PATH` (`$PWD/panel/test/stub`, or `stub-preview` for
`preview`, `stub-schedules` for `schedules`), and give each run its own
`SHOT_HOME=/tmp/house-shots-NAME`. The house has limited memory, so run one copy at a
time (`flock /tmp/station-shot-slot-1.lock ...`).

**Release audit scenes (2026-11-11)**, `panel/test/audit-*.js`, run by name with
`SHOT_PATH=$PWD/panel/test/stub`:

- `auditDocs` — Markdown tables, edit, save, reopen; `.txt`; `.json`
- `auditSong` — MP3, FLAC and M4A read back with ffprobe; odd Track and Year input
- `auditPicture` — turn, crop, Undo, save; video trim
- `auditBrowser` — start page, search, Back/Forward, Find, failed pages, no "Obscura" wording
- `searchInside` also covers "Words inside files": finds words in text files, skips binary, hidden, node_modules and key files, treats shell characters as plain text
- `auditActions` — New, Rename, Delete, Undo, Trash restore, Properties, Zip/Extract, search
- `auditEditorBrand` — no "OpenCut" in the video editor tab

Also (2026-11-11, later):

- `aiBrowser` — an AI using the Web Browser through the real `room/station-browser`
  tool: open, read, type, choose, click, back, scroll, shot, close; the walls
  (other sites on this PC, the home network, file:, a page redirecting there,
  the owner's own tab, a planted link and an old request in the request folder,
  5 a second, Internet Allow/Block/Ask, Stop and asking again). Needs
  `SHOT_PATH=$PWD/panel/test/stub-preview`.
- `uxIdeas` — Insert table, a `.gguf` opened from Files picks it in Local AI,
  closing Local AI unloads the model, search starts with every folder inside.

**Every scene, one at a time:** `panel/test/allscenes.sh [results-file]` runs
each scene alone with the stand-ins it needs (the list below), writing its
PASS/FAIL count and FAIL lines to the file (default
`~/.cache/station-allscenes.txt`). Run again, it carries on where it stopped.
`shotrun.sh list` prints the scene names.
`pdfPreview` opens a small PDF in the file preview and checks it is shown in the
built-in viewer, and that Esc and the X close it (also after clicking inside it).

Run them one or two at a time; a long run can hit the timeout (`SHOT_TIMEOUT=400`
or more). Also:

- `llamaMissing` needs a PATH with no `llama-server` on it. With the normal stub
  folder it fails, because the stub `llama-server` counts as installed.
- `keepAndClose`'s "40 big photos … fewer than 20 made" check depends on how
  fast the machine is. It failed the same way on the old code (21 made) when
  nothing else was running.
- `resume`, `closeOne`, `roomsAndHouse` and `agentTabs` only run with their own
  environment (see each scene's top comment). In a plain full run they print
  FAIL lines that only mean "skipped".
- `searchMeaning` needs `HOUSE_JEV_URL=http://127.0.0.1:<free port>/v1/systemone`
  (its stand-in TypeSafe listens there). `preview` needs `stub-preview`,
  `schedules` needs `stub-schedules` and its own settings.
- `tokenColumns`, `windows`, `cleanup`, `liveUpdate`, Home's recent-file keys and
  `stressPictures` pass when run alone but fail late in one long run of every
  scene (shots.js doesn't reset Station between scenes). `allscenes.sh` runs
  each alone, so that never comes up; it is the way to run them all.
- `videoFreeze` and `exportMemory` need `SHOT_VIDEOS`: `allscenes.sh` makes the
  videos once with ffmpeg in `~/.cache/station-test-videos`. `clipboard` needs
  the real Windows helper, so `allscenes.sh` skips it: run
  `clipboard-windows.ps1` from Windows (with Station closed) instead.
- `docx` (shots scene): a made-up Word file must show its heading, bold word, table, bullet and picture in the preview, with no "can't show" message, and fit a narrow window at 120%. `node test/docx.test.js` checks the reader alone.
- `stressDocs`: a 5 MB file that is one single line used to hold the page for
  about 1.5 s while it opened, because the editor wrapped that line. Now a file
  with a line over 100,000 characters opens unwrapped, and the pause is gone.
- `stressDocs`: opening and closing a Windows (CRLF) text file used to rewrite
  it with plain line endings; now it is left alone, and an edit keeps CRLF, a
  BOM, or LF, whichever the file had.

**Every-scene result, 2026-11-11 afternoon** (`allscenes.sh`, each alone): all
71 scenes it runs pass. `clipboard` wasn't run that day: it needs Station
closed, and Station was in use. Fixed on the way: the
`stressDocs` pause above; a window closed while
minimized never closed (its fade never played); after Save as Copy and Undo the
video page still said the trim wasn't saved; four tests that still expected the
older menus, buttons and words. `zoomwalk.sh` (real windows, every size and
zoom) passes in full, including the top bar never spilling.

**Watching the checks:** `SHOT_SHOW=1` (with `shotrun.sh` or `allscenes.sh`)
puts the test copies on screen without taking focus. Each carries a red "TEST
COPY with pretend projects" note: the copies use pretend projects, two of which
share names with real ones, and the owner took one for the real Station
(thinking a project was gone) more than once. Seen on screen, `windows` fails
(a popped-out window parks at about -32000 while on screen) and timing checks
are noisier; the hidden run is the verdict.

**Real models** (`llamaReal`, `test/llama-real-scene.js`, run alone; see the file
for the command): 2026-11-11 evening, all pass. Qwen2.5 1.5B (1.0 GB, loads in
2.3 s, 125 tokens/s), Qwen3 4B (2.3 GB, 3.3 s, 61-72/s), Qwen3 8B (4.7 GB,
4.6 s, 45/s), each with over 6 GB of the house's memory still free (the 8B
leaves 1.7 GB of the graphics card's 8 GB). Every one unloads; closing the tab
unloads too. It found Local AI cutting off its typing box and losing the newest
reply at a normal window size; both fixed.

**Also 2026-11-11 evening:** `clipboard-windows.ps1` passes (19 checks, Station
closed for it). The Web Browser was used for real from a real project's room (nothing
in the project touched): open, read, click, picture, home-network addresses
refused, and a real Claude in the room doing open + click by itself.
`keepAndClose` now checks that nothing is made after leaving a folder (beyond
the 3 already running), not how many a fast computer makes in half a second.

`~/.local/share/lead-tools/testslot.sh CMD…` is the one-test-at-a-time wrapper
the agents use: it holds a lock, waits for 2.5 GB of free memory, and runs the
command at low priority.

`safety-test.sh` and `rules-test.sh` open the real Windows lock for a moment and
change the real `rules.json` (both put them back). Every room test adds throwaway
projects that show up in Station 256. Run them only when Station 256 is not
being used.

## On the Windows side

| Script | Covers |
|---|---|
| `windows/snap-both-ways.ps1` | snapping in both directions. `-Rounds 0` runs only the panel part |
| `windows/seam-test.ps1` | the shared seam — real mouse, 27 checks. `-Repeat` counts missed drags |
| `windows/seam-form.ps1` | a test window for the seam checks |
| `windows/re-keys.ps1` | measures Windows 11's own `Win`+arrow behaviour, to regenerate `KEY_MOVES` |
| `panel/test/clipboard-windows.ps1` | the one clipboard: files and text copied in the house reach Windows, text copied in Windows reaches the house within a second, nothing bounces back. Runs a hidden panel copy on its own link port and the helper's clipboard part; refuses to run while Station 256 is open |

**Copy `snap-both-ways.ps1` and `seam-form.ps1` out of the UNC path before
running them.** PowerShell will not execute them from `\\wsl.localhost`.

## Rules every test must follow

Each of these exists because something real was damaged or a result was wrong:

1. **Never write to the clipboard.** A test overwrote the user's clipboard on
   2026-11-05. The one exception is `clipboard-windows.ps1`: it saves the
   Windows clipboard first and puts it back at the end, and only runs while
   Station 256 is closed. On 2026-11-07 an early version changed both sides'
   clipboards in the same moment; WSLg's compositor crashed and closed every
   Linux window, the real Station 256 too.
2. **Back up `~/.config/house/panel.json` first.** The selftest writes the real
   file and once overwrote the user's window size.
3. **Never screen-capture the desktop without asking.** A capture once caught the
   user's browser. Use `HOUSE_SHOT=/path` for a page capture, or ask for a
   screenshot.
4. **Never press keys without confirmed focus.** Tapping `Alt` on an
   already-focused window swallows the keys that follow.
5. **Never pipe a mouse-driving script through `Select-Object -First`.** One died
   mid-drag with the button still held.
6. **Never rebuild a seam element while it is held.**
7. **Write results to a file**, not the console.
8. **Blank real windows before photographing the tray.**
9. **Do not put test helpers in `/tmp`** — a house shutdown wipes it.
10. **Do not start rooms with `echo exit | script`.** Use
    `room open NAME </dev/null`.
11. **Keep window-opening tests to a single run**, and never pin windows on top.
12. **Confirm the running process is newer than the fix** before believing a
    report — clicking the icon only refocuses the old process.
13. **Timing belongs in `zoomwalk.sh`, not `fitrun.sh`.** Hidden-window tests get
    no animations, no ResizeObserver and no fast input.
14. **Measure sleep hands-off** with `wsl --list --running`. Any `wsl` command,
    any `sleep` in a script, and Claude re-reading `\\wsl.localhost` files all
    reset the keeper's 10-minute timer.

## Health check

A quick manual pass, no scripts:

```bash
# house
systemctl is-active docker house-firewall house-keeper    # three x active
systemctl --failed                                        # should be empty
sudo /usr/local/sbin/house-rules firewall-check && echo WALLS_OK
docker network ls | grep house-rooms
ls /mnt/c                                                 # must not exist
room list
room status
```

```powershell
# Windows
wsl --list --running          # empty when asleep, "Ubuntu" when awake
net use L:                    # should show \\wsl.localhost\Ubuntu
Get-Content "$env:LOCALAPPDATA\LinuxHouse\sleep-at-login.log"
```

## Last known result

`panel/test/clipboard-windows.ps1`, 2026-11-07 (Station 256 closed, real helper restarted
on the new code first; Windows clipboard put back to what it held before):

```text
PASS the helper is linked
PASS copied files, Windows has [\\wsl.localhost\Ubuntu\tmp\house-shots\projects\readme.md, …\SampleApp] marked 5
PASS the panel still pastes its own copy (not "files from Windows"): [true,false,0]
PASS cut files, Windows has the same two, marked 2
PASS the panel still pastes its own cut: [true,true,0]
PASS quiet after copying files: Windows clipboard changes 0, messages from the helper 0
PASS terminal Ctrl+C: Windows has "station-copy-78566", the house has the same
PASS quiet after a terminal copy: Windows clipboard changes 0, messages from the helper 0
PASS a program's copy (OSC 52), two lines: Windows has "line one\nline two"
PASS Copy as path: Windows has "\"L:\\tmp\\house-shots\\projects\\readme.md\"\r\n\"L:\\…\\SampleApp\""
PASS quiet after Copy as path: Windows clipboard changes 0, messages from the helper 0
PASS the helper puts text on Windows by itself: "helper-only-96618\r\nsecond line"
PASS quiet after the helper putting text: Windows clipboard changes 0, messages from the helper 0
PASS Windows Set-Clipboard "from-windows-2537" -> the house has it after at most 67 ms; the helper's message came after at most 472 ms
PASS quiet after a copy in Windows: Windows clipboard changes 0, messages from the helper 0
PASS Windows Set-Clipboard "first line\r\nsecond line" -> the house has it after at most 68 ms; the helper's message came after at most 472 ms
PASS quiet after a copy in Windows: Windows clipboard changes 0, messages from the helper 0
PASS heard from the helper: {"changes":9,"ours":6,"fromWindows":2,"written":0}
```

"quiet" is 3 seconds with Windows' clipboard sequence number read before and after. Text
reached the house through WSLg first (67 ms); the helper's own message followed (472 ms) and
found nothing to change ("written":0). An earlier version crashed WSLg (see rule 1).

Everything above passed as of the 2026-11-05 second review pass and the
2026-11-06 restart and sleep checks, with these exceptions, all listed in
`04-decisions-and-gotchas.md`:

- the one unexplained dockerd healthcheck failure, never reproduced
- the ~14-minute sleep instead of 10
- staying asleep with the Claude session closed: untested
- real-mouse drag-out / drag-in of terminal tabs: untested
- the right-click menu click itself: unconfirmed by the user

## The Herdr walls — `herdr-test.sh`

Added 2026-11-06, when rooms gained an SSH door so Herdr could reach them.

```bash
bash ~/house/herdr-test.sh
```

It makes two throwaway rooms, checks 32 things, then removes them. It covers:

- the house key exists, only you can read it, and no key or key text sits
  inside `~/house` (which is what the backup copies)
- the blueprint really has the SSH door, with passwords off, and the only path
  allowed is the house opening one into the room's own localhost (for room
  sites, since 2026-11-08): no path out, no tunnel, no agent or X11
- each room gets its **own** host key, and the two are not the same
- the house can SSH in by name, and Herdr, Claude, Codex and Gemini all run
  inside the room
- a room still cannot reach the house, the house gateway, or another room
- a room holds no key for any other machine, no admin rights, no Docker control
- one project cannot read another project's secrets, and cannot change its own
- the room publishes no port, and nothing listens on 22 in the house
- Herdr lists the room and calls it reachable

**Result, 2026-11-06: 32 passed, 0 failed.** `safety-test.sh` and
`rules-test.sh` were re-run the same day and still pass in full.

One trap worth remembering: the first version of this script searched `~/house`
for private-key text and found **itself**, because the words it searched for
were in the script. It now skips its own file. The installer selftest hit the
same trap earlier, in a different form.
- `videoEdit` also covers Sound off, handle snapping, a steady play head and portrait videos (2026-11-11)
