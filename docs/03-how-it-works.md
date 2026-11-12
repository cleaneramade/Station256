# How it works

## The shape of it

```
WINDOWS SIDE                          THE HOUSE (WSL2 Ubuntu)
──────────────────────────────────    ────────────────────────────────────
Station 256.lnk                       systemd
  └─ conhost --headless                 ├─ docker.service
       └─ open-panel.ps1                ├─ house-firewall.service
            ├─ house-helper.ps1         │    └─ /usr/local/sbin/house-firewall
            │    └─ snap-link.cs        └─ house-keeper.service
            │       (in memory)              └─ /usr/local/sbin/house-keeper
            └─ wsl ... panel/start.sh
                                       ~/house/panel  (Electron 45.2.2)
         TCP 127.0.0.1:47256             ├─ main.js
    ◄──────── the link ────────►         ├─ lib/{files,house,rules,terminals,windows-link}.js
      secret in link-token               └─ renderer/{app,term,window-motion}.js

L: ──► \\wsl.localhost\Ubuntu          ~/projects/<name>  ──►  room-<name> container
                                                                (house-rooms network)
```

## The panel

Electron 45.2.2 with sandbox on. `main.js` is the Electron main process;
`preload.js` exposes a narrow bridge; the renderer is plain JS, no framework.

The library split:

| File | Does |
|---|---|
| `lib/files.js` | the file browser, including Trash with Restore/Empty and protected house folders |
| `lib/house.js` | house state, sleep status, storage |
| `lib/rules.js` | reads `rules.json`, writes `claude-managed.json` |
| `lib/terminals.js` | terminal tabs over `node-pty` + xterm; room terminals keep running when closed |
| `lib/windows-link.js` | the TCP server the Windows helper talks to |

### Window motion — the current design

This went through several rewrites. The design that stands (2026-11-04):

The Electron window is a **fixed, transparent, always-maximized surface that
never resizes**. The visible window is an `.app` div positioned in percentages
of that surface by `renderer/window-motion.js`.

Why: WSLg shows junk frames for about 125 ms on any real resize, and freezes
**all** Linux windows for about 200 ms while it happens. Never resizing the real
window avoids both.

- Maximize / restore: commit the layout once, then a WAAPI FLIP transform,
  GNOME curve, 250 ms. Corner radius and shadow are turned off during the glide.
- Drag: left/top updated per animation frame.
- Edge resize: reflows live.
- Zoom: footer 100% = factor 1.35 (`BASE_ZOOM`). The page calls
  `webFrame.setZoomFactor`, then eases CSS zoom on `.app` over 140 ms.

Measured: FLIP costs about 1 ms of page work versus about 24 ms for live layout
at 200 rows.

Two things are **deliberately off**:
- Graphics card drawing of Station's own pages — Mesa 26 defaults to llvmpipe;
  the d3d12 driver did enable the GPU but dropped frames through WSLg. (Until
  2026-11-10 this was `app.disableHardwareAcceleration()`. Now only canvases use
  the graphics card, for the video editor; see "Video editor".)
- LCD subpixel text during motion — otherwise text changes weight when the
  animation ends.

The older "stage window + JPEG snapshot" approach and `lib/motion.js` are
**deleted**. Do not resurrect them.

### Look

Measured against the real Windows 11 File Explorer: strip `#dadada`,
tab and address bar `#f4f4f4`, fields `#fcfcfc`.

The sidebar runs down to the bottom of the window, with Trash at the bottom; the
status bar ("4 items", zoom, views) starts where the sidebar ends, under the page
and the System panel (2026-11-09, `.main` is a grid; `footerBeside` scene).
In the icon views each tile is as tall as its own name, with as much space under
the name as over the picture (`tileBalance` scene measures it in pixels).

Fonts and icons are chosen so a public release stays legal: bundled **Selawik**
(open Segoe lookalike) and **Fluent** icons (MIT), copied by
`panel/setup-icons.sh`. Real Segoe UI files were copied to
`~/.local/share/fonts/windows-local` **for this PC only** and must never be
committed or shared.

### Terminal look (matches Windows Terminal)

- **Font: Station Mono** (`panel/renderer/fonts/station-mono-400/700.woff2`). It is
  Cascadia Mono (SIL Open Font License) renamed, with its block and line-drawing
  shapes stretched past the edges of each row by `panel/make-terminal-font.py`.
  xterm cuts each row off at its edges, so the shapes fill the row and join with
  no gaps, the way Windows Terminal draws them (Claude's logo, boxes).
  - Cascadia swaps in a second copy of each block shape (`.stypo`, through its
    `rclt` feature), and that copy is the one drawn, so both are stretched.
  - Renamed because the license reserves the name "Cascadia Code".
- **Why not WebGL** (which draws those shapes itself): tested 2026-11-07. With no
  GPU reaching Linux it runs on SwiftShader in software, 7 to 9 times slower than
  the normal renderer (a full-screen redraw test took 55 s instead of 6 s, at
  12 fps).
- **Rows** use the font's own height (`lineHeight: 1`), like Windows Terminal.
- **Widths**: `@xterm/addon-unicode11`, so emoji and Chinese, Japanese and Korean
  letters take two columns, as Claude, Codex and Herdr expect.
- **Colors**: `minimumContrastRatio: 3`. It only darkens text too pale to read,
  so colors a program picks (Claude's orange) stay as they are.
- **Missing symbols** come from the fonts Windows Terminal itself falls back on:
  Segoe UI Symbol (⏺ ⎿ ✻), Segoe UI Emoji (color), Microsoft YaHei, Yu Gothic,
  Malgun Gothic. They were copied into `windows-local` **for this PC only**. A PC
  without them falls back to DejaVu, with some boxes for missing symbols.

### Home page (2026-11-09)

Home is a page, not a folder, as in File Explorer. A Files tab on it has the
place `home:`, so Back and Forward go to and from it. Station 256 starts on it,
and the + button, Ctrl+T and a window's last closed tab open on it. The tab
says "Home". The Linux home folder itself is still at L: > home > your-user.

- **Four tiles** (`lib/stats.js`): Day Streak ("3 Days": days in a row with AI
  notes or AI tokens), Today's Input Tokens, Today's Output Tokens (each with
  "This week"), and Files AI Created/Modified ("Most in X (n)"; build folders
  like `target`, `dist`, `node_modules` and anything hidden left out). Titles
  have every word capitalized. Numbers and words are one size and color; the D
  in "Days" is a capital. Two colors only: the fire is orange, the other icons
  are blue; the token icons are chart arrows (down for input, up for output).
- **Today and this week are calendar time** (user, 2026-11-09): today is since
  midnight, this week is since Sunday (where Windows starts the week here), not
  the last 24 hours or 7 days. Days go back on the calendar, so a day the clocks
  change on is still one day. A recount straight from every AI record (house and
  all rooms, each reply once) matched the tiles exactly on 2026-11-09.
- **Awake time was removed** (user, 2026-11-09). Its tile was replaced by the
  split token tiles. If it's ever wanted back, commit 7b347b4 has a method that
  matched Windows' own sleep records within a minute: each `journalctl` line's
  time of day against the house's running clock, which stops while Windows
  sleeps but runs about 8% slow in this VM, so it's only used to find sleep.
  Uptime-based counts are wrong: they count a night asleep.
- **Tokens** (`lib/token-count.js`) come from Claude Code's conversation files:
  "in" is everything read, cached included; "out" is what was written. The
  counter runs as `node -e` in the house, by `docker exec` in an open room, and
  by a throwaway `docker run --network none` with the room's records volume
  read-only for a closed one (once after it closes). Each file is read only from
  where it was left; totals by day are kept in
  `~/.local/state/house/token-counts.json`.
- **Most Recent**: the 6 latest projects in one row. Each card: name, and top
  right either an open room's green light or, for a room asleep, when it last
  changed ("2 h ago", "3 d ago", then "Nov 7"; the user chose this spot). Then
  the AI that last changed it (or "No recent AI changes"; the time is in the
  card's tip), then Open Room / Enter Room. No "Room open / Room asleep" line.
  **See all projects (N)** sits at the right of the heading (2026-11-11) and
  opens the Projects folder, so a project the row leaves out (it shows only
  what fits) is still one click away.
  Cards are 236px at most and at least 220px, so a maximized window shows 5;
  narrower windows show fewer, never a second row. No New Project card;
  New > Project still makes one.
- **Recent files**: the newest files AI changed (from the rooms' notes) and new
  files in Documents, Downloads, Pictures, Music and Videos, last 30 days.
  Double-click opens; the location opens the folder with the file picked.
  They work like a folder's files (2026-11-10): click, Ctrl+click, Shift+click,
  Ctrl+A; a folder's right-click menu (Cut, Copy, Copy as Path, Zip, Rename,
  Delete, Properties); Ctrl+C/X, Delete, F2, Alt+Enter, Escape; the toolbar's
  Cut, Copy, Rename and Delete. F2 asks for the new name in a box.
- Nothing can be pasted or dropped on Home; Sort, View and Search are off there.

### Pictures of files (2026-11-10)

The icon views (Medium and up, Tiles, Content) show a small picture of every
picture type, a video's frame (1 second in), a song's cover and a PDF's first
page, as File Explorer does. `lib/thumbs.js` makes them with the house's
**ffmpeg** (PDFs with **pdftoppm** from poppler-utils), 256 px at most, three at a
time, only for what's on screen, and keeps them in `~/.cache/house/thumbs`
(trimmed to 300 MB, oldest first). Small PNG/JPEG/GIF/WebP/BMP/ICO/AVIF files and
every SVG are shown as they are. No picture (a song without a cover) means the
type's icon. The page asks with `house-file://…?thumb`; `?view` makes a picture
the page can't show by itself (TIFF, HEIC, PSD, TGA, QOI, JXL…) into one it can,
so opening it shows it full size. ffmpeg 8 stands up photos taken sideways.

### Files open in a page of their own (2026-11-10)

Double-click (or Enter) on a Markdown, text or code file opens it in a tab,
like House Rules (`renderer/doc-tab.js`). Space still gives the quick preview.
- **Markdown** reads as it would look, Obsidian-style: marks (#, **, [ ](…),
  - [ ]) show only on the line you're typing in. Headings, bold, italic,
  <u>underline</u>, ~~strike~~, code, links (click opens; web links in Windows'
  browser), checkboxes (click ticks), bullets, quotes, tables, code blocks with
  colors, dividers, pictures from the house, and a gray note header (---).
  Toolbar: text style (Normal, Heading 1–4), B I U S, lists, checklist, quote,
  code, link, divider. Keys: Ctrl+B/I/U/E/K, Ctrl+Shift+X, Ctrl+Enter ticks.
  Live/Source switch shows every mark. No font choices.
- **Code** gets colors, line numbers and folding; **text** wraps. Find and
  replace with Ctrl+F. Text size (−/+, "100%") is kept for every file.
- Saves by itself (~0.5 s after typing; Ctrl+S now). The status says Saved,
  Saving… or Read only (C: files, Trash, files it can't write). Line, column
  and word count sit in the status bar.
- Changes from outside (AI in a room): checked every 1.5 s while the page is in
  front. Nothing typed: it takes the new text ("Updated"). Both changed: a bar
  asks Use Theirs / Keep Mine. Deleted: Close / Save It Again.
- Saved before Ctrl+R, live updates and moving the tab to another window; tabs
  come back after Ctrl+R. Main side: `docRead`, `docStat`, `docWrite` in
  `lib/files.js` (writes in place, so a room's view of the file carries on).
- The editor is CodeMirror 6 (MIT), built from `panel/editor` (`npm install`,
  `npm run build`) into `renderer/vendor/editor.js`, loaded the first time a
  file opens.

### Picture editor (2026-11-10)

A picture's preview has **Edit** (`renderer/picture-editor.js`), a small photo
editor like Windows Photos, all drawn on a canvas in the page:
- **Crop**: drag corners/edges/inside; shapes Free, Original, Square, 4:3, 3:2,
  16:9; Turn left/right, Flip across/down; Whole picture.
- **Adjust**: Brightness, Contrast, Color, Warmth (double-click resets one).
- **Draw**: Pen, Highlighter, Arrow, Box, Words; 8 colors; size.
- **Resize**: width/height, keep shape, 25/50/75/100%.
- Undo/Redo (Ctrl+Z/Y) for every step; Esc or Cancel asks if something changed.
- **Save as Copy**: "name (edited).ext" beside it (a C: picture's copy goes to
  Pictures; kinds the page can't write, like TIFF or HEIC, save as PNG).
  **Save** (PNG/JPEG/WebP in the house only) writes over it in place, after
  copying the old one into the Trash; the note's Undo puts it back.
- Main side: `savePicture`, `putPictureBack` (`replaceFile`/`putBack` in
  `lib/files.js`). The picture loads with `house-file://…?edit`, which adds
  `Access-Control-Allow-Origin` (the scheme is `corsEnabled`) so the page may
  read back what it drew.

### Video page (2026-11-10)

Double-clicking a video (or **Trim** in its preview) opens it in a page tab
(`renderer/video-tab.js`, kind `video`, inside `#doc-area` like notes). It is a
plain player in the page's light look (no black), for watching and a quick
trim; real editing is the **Editor** button (next section). The user turned down a
first version with cuts, crop, turn, sound and frame tools on a dark page
(2026-11-10): those belong in the Editor.
- Controls: Play/Pause (Space or K, or click the picture), one frame back/on
  (`,` `.`), ←/→ jump 5 s, Home/End go to the trim ends, F or double-click for
  full screen.
- **Timeline**: a row of 10 frames (`house-file://…?strip`, made by ffmpeg and
  kept in `~/.cache/house/videos`). They're read one at a time, each the whole
  frame just before its moment, on two threads: all ten read at once took
  4.7 GB for a 4K video and ran the house out of memory (2026-11-10). Blue handles trim the ends (or Start Here /
  End Here, keys I and O; the reset button gives the whole video again).
  Playing stops at the end of the trim.
- Undo/Redo (a drag counts once). Closing with a trim not saved asks first;
  closing while saving offers Stop and Close.
- `lib/video.js` only trims now: the cut, sound, turn, crop and frame parts
  the first version used were taken out (2026-11-10).
- **Save as Copy**: "name (edited).ext" beside it (in Videos for a C: video;
  kinds other than MP4/M4V/MOV/MKV/WebM become MP4). **Save** (those five kinds,
  in the house): ffmpeg writes a hidden file beside it, the old video is moved
  into the Trash, the new one takes its name; the note's Undo moves it back.
  Saving shows "Saving… N%" with Stop. x264 veryfast CRF 20 + AAC (WebM: VP9 +
  Opus).
- Videos the page can't play (AVI, WMV, HEVC, AC-3 sound...) get a 720p MP4
  copy first ("Getting this video ready to play…", `?play`), kept in the same
  cache (3 GB at most). Saving always reads the original. Their quick preview
  shows the frame and **Play Here**.
- Unsaved edits go with the tab to another window or through a reload
  (`describeTab` carries them).
- Main side: `lib/video.js` (probe, render, stripFor, playableFor, cancel;
  cancelAll stops every ffmpeg when Station quits), handlers `videoInfo`,
  `videoPlayable`, `videoSave`, `videoCancel`, `putFileBack`; progress on `video:progress`. `files.replaceWith`
  and `files.placeFile` move finished files into place.
- **Jumping in videos and songs**: the file link now answers part-of-file
  (Range) requests itself (`partOfFile` in `main.js`). Before, `net.fetch` of a
  `file://` URL only gave the whole file, so players couldn't jump.

### Video editor (2026-11-10)

**Editor** on a video's page opens a full video editor in a tab: OpenCut
(github.com/OpenCut-app/opencut-classic, MIT, licence in `editor/LICENSE`) made
Station's own, with everything OpenCut does (timeline, text, stickers, effects,
captions, keyframes, export). The user wants to edit YouTube videos in it.
- **Code**: `~/house/editor` (OpenCut's `apps/web`, Next.js 16). It is built as
  plain files into `editor/out` (`bun run build`; Bun 1.2.18 in
  `~/.local/share/bun-npm`). `out/`, `node_modules/` and `.next/` aren't in git;
  the installer builds it when a release doesn't bring it built.
- **Removed from OpenCut**: its website pages, sign-in and database, analytics,
  feedback and Discord, the theme switch (light only), the "desktop only" gate,
  the welcome popup, the "protect your projects" prompt (it now asks quietly),
  and the Sounds, Transitions and Adjustment tabs (online library through
  OpenCut's own server; "coming soon"). Bugs in the archived repo fixed so it
  builds (`isShortcutKey`, `isActionWithOptionalArgs`, sticker `register`,
  storage adapter calls).
- **Look**: Station's colors, font (Selawik), 4 px corners, Station Blue for
  Export, Station's logo (`editor/src/app/globals.css`, `components/ui/button.tsx`).
- **How it's shown**: `lib/editor-app.js` serves `editor/out` as
  `station-editor://app` in a session of its own (`persist:station-editor`,
  where its projects live, in IndexedDB and OPFS). The tab
  (`renderer/editor-tab.js`, kind `editor`, one per window) is a `<webview>`;
  `guardWebviews` only lets that page in, with `editor-preload.js` as its only
  bridge (`window.station`). Links out open in Windows' browser.
- **Opening a video**: `/open/?path=…` goes back to the project that video
  opened into before (kept in the editor's localStorage), or makes one named
  after it. The page then asks Station for a file it can read
  (`video.editableFor`): the video itself if it's H.264, VP8, VP9 or AV1 in
  MP4/MOV/MKV/WebM, or else a full-quality copy (x264 CRF 18, square pixels, HDR
  toned to normal; "Getting … ready to edit N%"), kept in the video cache. The
  file is streamed into the editor's own storage and put on the timeline; the
  project takes the video's size. (In Electron 45, `response.blob()` of a big
  file from a Station link fails, everywhere; streaming works.)
- **Export** saves through the bridge: "name (edited).mp4" beside the video (in
  Videos for a C: video), with the note's Show. The browser makes Opus sound in
  MP4, which some players don't play, so Station switches it to AAC
  (`video.aacSound`, picture copied).
- **Saving**: the editor saves a moment after each change. Station saves it
  first (`window.stationSave`) before closing the tab or opening another video
  in it, and skips its "leave this page?" check.
- **Drawing** (`main.js`, `start.sh`): OpenCut draws every frame with WebGL2,
  which Station had turned off with all graphics. Now Station's own pages are
  still drawn on the processor (no GPU compositing or rasterization), and only
  canvases use the graphics card, through Mesa's d3d12 driver (`start.sh` sets
  `GALLIUM_DRIVER=d3d12`; main.js takes it back out once the graphics process is
  up, so terminals don't get it). If that can't start, SwiftShader draws them.
  Measured with a 20 s 1080p video:

  | Canvases drawn by | Preview while playing | Export |
  |---|---|---|
  | SwiftShader (software) | about 6 a second | 91 s |
  | llvmpipe (Mesa, processor) | about 19 a second | 36 s |
  | d3d12, integrated graphics (chosen) | about 22 a second | 30–37 s |
  | d3d12, discrete graphics card | under 3 a second | 212 s |

  The discrete card is slow here because each picture has to come back from it; d3d12
  picks the integrated one by itself.
- Tests: `editorOpen` (5 checks), `editorCopies` (an AVI and an HDR HEVC .mov).
  `editorLook` (pictures) and `editorSpeed` (the numbers above) run only when
  named.

### Live updates (2026-11-09)

Changes to the pages show without restarting Station 256 (the user asked: no
more restarts for every change). `lib/live-update.js` watches
`panel/renderer/` (and `panel/preload.js`) in the live copy, `~/house/panel`;
a merge into main lands there, so it shows. Changes settle for 1.5 s first, as
a merge writes files one by one. Editors' hidden and temporary files don't
count. Not in checks (`HOUSE_SHOTS` etc.): they run from copies being changed.

- **Style only** (`.css`): every window swaps in the new stylesheet at once.
  The old one goes when the new one has loaded, so nothing shows unstyled.
- **Page code** (`.js`, `.html`): each window reloads itself in place, but only
  when nobody's using it: no key, click, drag or scroll for 4 s, and no menu,
  dialog, preview, rename or text field in use. It hands its tabs to main.js
  (`liveReload`, the same handoff a window made from a tab uses), reloads, and
  `windowStart` gives them back: folders with Back and Forward, terminals by
  number (still running; their history is replayed), Agents, House Rules, and
  the same tab in front. A `sessionStorage` mark skips the loading screen. The
  window kept ready for a tab is dropped, so it's made again from the new code.
- **Still needs a restart**: `main.js` and `lib/` (the part behind the
  windows). Ask the user before restarting while they're using it.
- Checked by the `liveUpdate` scene. The `windows` scene now starts from one
  fresh Home tab, so scenes before it can't break it.

### Refresh and Ctrl+R (2026-11-09)

The user asked for these to differ, as in File Explorer and a browser:

- **Refresh button and F5**: only what's on screen is read again (the folder's
  list, or Home). The list (or Home) blinks out for 120 ms to 600 ms and comes
  back new. No loading screen; nothing else is touched.
- **Ctrl+R**: the window starts again with its loading screen. It uses the
  live-update handoff (`liveReload`), so every tab comes back with the same one
  in front, and room terminals keep running and join up again; rooms are never
  touched. A `sessionStorage` mark (`house-ctrl-r`) makes sure the loading
  screen shows, even in a window made from a tab. Inside a terminal, Ctrl+R is
  left to the terminal (searching what was typed before).
- Checked by the `reloadKeys` scene, which presses the real keys.
- **One smooth hand-over** (user: it felt abrupt). Before, the loading screen
  barely started, the window vanished for a few frames, then grew in like a
  new window, and the ring jumped back. Now:
  - `reloadWindow` lets the loading screen come fully in (260 ms), then saves
    a note in `house-ctrl-r`: when it showed, the window's box and maximized.
  - `renderer/again.js` runs in `<head>`, before anything is drawn. It puts
    the window back in that box (`html.again`) and marks it ready, so the very
    first picture is the same window with its loading screen already in.
    `window-motion.js` skips the opening motion; the loading screen doesn't
    come in again.
  - The ring turns with the clock (`--spin-phase`), so it carries on.
  - The logo is built into `splash-logo.css` (a data URL of
    `station-256.png`); a picture file loaded a frame late and blinked out.
  - One full turn of the ring in all, counted from when it first showed.
  - Scene `reloadSmooth` watches every frame of the hidden window: before the
    fix 4 frames had a see-through corner and the ring was 330 ms off; after,
    none, the logo stays in (L39) and the ring is within about 30 ms.

### Windows (C:) in the sidebar (2026-11-09)

While the Windows lock is open, **Windows (C:)** shows under Linux House (L:).
It is the house's own Windows door (`/mnt/windows-door`, C: mounted read-only by
`house-rules door-open`), shown as C:\ paths. Locked, it's gone, and any tab on
it goes back to Home.

- **View and copy only.** Browse, preview, open in a Windows app, copy, Copy as
  Path, Properties. Copying from C: into L: works (drag, Ctrl+C/Ctrl+V); a drag
  from C: is always a copy. Nothing on C: can be renamed, deleted, moved, cut,
  zipped, extracted or pasted onto. The page hides and turns off those, and
  `lib/files.js` refuses them anyway (`assertAllowed` = change, `assertReadable`
  = look). Cut from C: goes on Windows' clipboard as a copy, so File Explorer
  can't take it off C: either.
- The bottom bar says "View and copy only"; the address bar reads and takes
  `C:\...` paths.
- Clicking it opens your Windows folder, `C:\Users\<you>` (`files.windowsHome`):
  the Users folder named like the house user, else the one whose `NTUSER.DAT`
  changed last (Public, Default and the like are never picked), else `C:\`.
- Files Windows hides (NTUSER.*, AppData, desktop.ini, pagefile.sys, ...) are
  left out by name, since the house can't see Windows' hidden mark; they show
  with hidden items on.
- Linux House (L:) and Windows (C:) both use the drive icon (`hard_drive`).
- Status: `windowsDrive` is the house flag `/run/house/windows-door-open` (a
  room's door alone doesn't show the drive).
- Tests use a stand-in C: beside the throwaway home (`HOUSE_SHOTS` folder's
  parent: `windows-door`, flag `windows-door-open`). Checked by the
  `windowsDrive` scene.

### Export Chat (2026-11-09)

Right-click a terminal tab: **Export Chat** or **Export Chat with Details**
(then Close Tab). The AI chat in that terminal is saved as a Markdown page in
Downloads (`<Room> chat <date> <time>.md`, or `Linux House chat ...`), and a
note says so with a **Show** button.

- **Export Chat**: what you and the AI said, as the terminal shows it: your
  messages and slash commands, the AI's answers, questions it asked and what you
  picked, plans. The steps between two answers are one line, like "Ran 2
  commands and changed 1 file (app.js)."
- **With Details**: also each step in full: the command, the change as a diff,
  what came back (cut at 300 lines), and the AI's thinking where it was kept.
- Which chat: Claude Code keeps `~/.claude/sessions/<pid>.json` (chat id and
  folder) for each running chat. A room tab's one is the Claude whose
  `HERDR_SOCKET_PATH` names that tab; a house terminal's is the Claude started
  from its shell. The chat is `~/.claude/projects/<folder>/<id>.jsonl`; the page
  follows its links from the last message back, so changed (rewound) messages
  and helpers' side chats are left out, and a summarized part is marked.
- The page is made by `lib/chat-export.js` run as a small program inside the
  room (`docker exec -i room-<id> node -e`), or in the house for a house
  terminal (`lib/chat-save.js`), so only the page comes back. Claude only for
  now; Codex and Gemini say so.
- Checked by the `chatExport` scene (a made-up chat with every kind of line; the
  room way through the stand-in docker).

### Local AI with llama.cpp (2026-11-10)

**Local AI** (the menu, or the tab's + menu) runs a `.gguf` model on this
computer with llama.cpp's own `llama-server` and chats with it.

- Station doesn't bundle llama.cpp. It looks for `llama-server` on PATH, in
  `~/.local/bin`, in `~/llama.cpp/build/bin`, or at a path saved in
  `~/.config/house/llama.json` (the page's own settings: model, context,
  GPU layers).
- **Installed (2026-11-11)** by `system/install-llama.sh`, which the installer
  runs too (step 6). It takes a pinned official release (`b12283`): the NVIDIA
  CUDA build when `nvidia-smi` says the driver supports CUDA 13.5, otherwise
  the plain CPU one. No sudo: everything sits in
  `~/.local/share/llama.cpp/b12283-<cuda|cpu>/` (the `.so` files beside the
  program), `current` points at it, and `~/.local/bin/llama-server` links to
  it. It checks the program starts from a bare environment, as Station starts
  it, and falls back to the CPU build if the CUDA one won't. Safe to run again.
- The model: `~/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf` (2.5 GB, Apache-2.0,
  from `unsloth/Qwen3-4B-Instruct-2507-GGUF`). Proven through the real
  `lib/llama.js`: found, started, answered, stopped. CPU: about 10 words a
  second; on the graphics card about 67.
- **GPU layers** default to 99, which means the whole model goes on the graphics
  card. The CPU build ignores it and still starts.
- **Load model / Unload model** (2026-11-11, were Start and Stop). It says *Not
  loaded*, *Loading the model…*, then *Ready*. While a model is loaded a line
  says it keeps using memory until **Unload model** is pressed or the tab is
  closed: closing the Local AI tab unloads the model too (since 2026-11-11;
  moving the tab to another window doesn't). If the server dies on its own it says *The model stopped by
  itself* and why that usually happens (out of memory: a smaller model or a
  smaller Memory size).
- **Picking a model.** The list shows the `.gguf` files found in the usual
  folders. A `.gguf` file anywhere in Files opens Local AI with it picked
  (double-click, or right-click → **Load in Local AI**), ready for Load model.
  **Choose…** still takes a typed path.
- One server at a time, on `127.0.0.1` and a free port. Each start gets a new
  random key (given in `LLAMA_API_KEY`, so it isn't in `ps` or the log), so
  only Station's requests are answered, even though Windows can reach the
  house's 127.0.0.1.
- It stops when Station closes. A small watcher (`/bin/sh` reading a pipe) kills
  it if Station is killed instead.
- `lib/llama.js` and `renderer/llama-tab.js`. Checked by the `llama` and
  `llamaMissing` scenes against `test/stub/llama-server`.
- Not yet: the room terminals' Claude/Codex using a local model as their
  provider. That needs llama-server inside the rooms (next version).

### One-click Preview (2026-11-10)

A project card on Home has an icon-only **Preview** button. Since 2026-11-11
it's also in the top bar (with its word) whenever a project is picked in a
list, you're inside one, or you're on its room terminal, and in the
right-click menu of a project (or a folder in one) and of a project's empty
space. They all call the same `previewProject`. Preview works out
how the project starts its site, types that into a new terminal tab in the
project's room (so you can watch it, and Ctrl+C stops it), and opens the page
when the room starts listening on a new port. `lib/ports.js` carries the port
out of the room.

- The page opens in a Web Browser tab with the project's name in its bar. Asking
  again brings that same tab back. The button shows a turning ring while
  starting and a green dot while the site is up.
- It knows Node (npm, yarn, pnpm, bun; `dev`/`start`/`preview`/`serve`, Expo
  web), Flutter web, Django, FastAPI, Flask, Streamlit, Rust (Trunk, axum and
  others), Go, Deno, PHP and Laravel, Rails, Jekyll, Hugo, .NET, Spring
  (Maven/Gradle), and a plain `index.html`. It looks in the project's top, then
  `web/`, `app/`, `frontend/`, `client/`.
- **`.station-preview`:** when a project's start is unusual (RustApp: Trunk in a
  deep folder, plus a helper server), put the exact start steps in a file named
  `.station-preview` at the top of the project. Preview runs it with `bash`
  before trying anything else. It can be several lines.
- A missing tool ("PHP isn't installed in this room.") or a crash is said at
  once. Preview doesn't wait out its 2 minutes.
- `lib/preview.js`, `renderer/preview.js`. Checked by `test/preview.test.js`
  and the `preview` scene (`SHOT_PATH=<repo>/panel/test/stub-preview`).

### Right-click everywhere (2026-11-11)

Every right-click menu starts with the same four, always in the same places:
**Cut, Copy, Paste, Select All**. One that can't work there is greyed out,
never left out. What belongs to the thing clicked comes after a line.

- `rightClickMenu(x, y, shared, items)` in `app.js` builds them. `openMenu`
  stays as it was, because the drop-down buttons use it too.
- What the four do depends on the place:
  - **Files** (a folder's items and empty space, Home's recent files, column
    heads): exactly the toolbar's Cut, Copy and Paste, greyed when those are.
    Select All picks every item (on Home, every recent file).
  - **Text boxes** (search, address, forms, documents): the words. Copy goes
    on Windows' clipboard too (`clipboardWrite`), Paste reads `clipboardRead`
    and types it in with `insertText`, so Ctrl+Z undoes it. A box also gets
    Undo and Redo. Password boxes never copy.
  - **Terminals** (`term.js`): Copy what's picked, Paste the same way as
    Ctrl+V (a Windows picture pastes as a file path), Select All. In a room
    terminal a plain drag belongs to Herdr, so menu Copy needs a Shift+drag.
  - **Anywhere else**: Copy for words picked on the page, Select All for text
    you can pick (a chat, a preview, an output box).
- The menu keeps the typing spot where it was (its `mousedown` is cancelled),
  so the four act on the box you right-clicked.
- Own items: tabs (New Tab, Move to New Window, Close Tab, plus Export Chat
  and Close Room on terminals), sidebar places (Open, Open in New Tab, Copy
  as Path, Properties), Local AI messages (Copy Message), projects (Preview).
- **Web Browser pages:** the page's right-click (`context-menu` in
  `lib/obscura.js`) is passed to the tab, which draws Station's menu: the four
  (Cut and Paste in a page's boxes, Copy for picked words), then Open Link in
  New Tab and Copy Link on a link, then Back, Forward, Reload.
- **Inside a dialog** the menu opens on its own see-through layer above it (a
  modal dialog makes everything outside it unclickable), so Paste works in a
  dialog's boxes too.
- Not covered: the video editor, which keeps its own menus.
- Checked by the `rightClick` scene: real right-clicks sent to the window on
  each part (a web page's go to the page itself), then Select All, Copy, Cut
  and Paste from the menu in the search box and in a dialog, Preview in the top
  bar, and the top bar fitting at every width.

### The top bar always fits (2026-11-11)

Labels fold away at set widths (`@container win` rules in `style.css`). On top
of that, `fitCommandbar` in `app.js` checks whether the bar still spills (a
room's buttons, Preview and a copy's ring can all show at once) and folds more,
a step at a time (`fold-1` to `fold-5`: right-side labels, room labels, sort and
view labels, New's word and the arrows, then tighter spacing). It runs when the
bar changes size and when a button in it shows, hides or changes its words.
Checked by `fitrun.sh` (its worst case now includes Preview): 7/7.

### Small fixes from the release audit (2026-11-11)

- The Trash tab's address bar says **Trash** (was `.local › share › house-trash`).
- A Web Browser page that fails to load names its tab for the site, not the
  page before.
- Wide Markdown tables keep header words whole and scroll sideways.
- Markdown pages have an **Insert table** button (after Divider line): a
  three-column table with a blank line on each side, the first heading picked
  so typing replaces it. Empty cells keep a normal row height.
- Search starts with **All folders inside**, as File Explorer does (it was This
  folder). A choice you make is still remembered.
- The song page's Track box hints "3 or 3/12".

### Web Browser, the built-in browser (2026-11-10)

Called **Web Browser** everywhere you can see it (renamed from "Obscura" on
2026-11-11; the code, file names and the `persist:obscura` session keep the old
name, so sign-ins made in it are kept). A new tab shows Station's logo, "Station
256 Web Browser" and what to do. A tab that is all web page. One slim bar has Back, Forward, Reload, the
address, and on the right the project the page belongs to, which AI is
using it (when one is), and **Open in browser** (hands the page to Windows'
own browser). Station's sidebar, folder header and status bar are hidden while
it's in front, and come back exactly as they were.

- The page is a `<webview>` in its own session (`persist:obscura`), with no
  Node, no Station files (`house-file:` isn't there), no camera, microphone,
  location, clipboard reading, Bluetooth/USB, or file-system pickers.
- Downloads go only to Downloads with safe names (no overwriting). At most 10
  downloads every 10 s, 3 new tabs every 5 s, and 20 page-opened tabs in all.
- Keys like Ctrl+T/Ctrl+W work as in the rest of Station. Ctrl+plus zooms the
  page, not Station.
- `lib/obscura.js`, `renderer/obscura-tab.js`. Checked by the `obscura` and
  `obscuraAttacks` scenes (every way out of the tab, tried against a hostile
  made-up site).
- Not yet: the browser engine itself inside rooms (next version). Hiding from
  websites' bot detection is deliberately not built.

#### An AI using the Web Browser (built 2026-11-11)

An AI in a project's room (Claude, Codex or Gemini) uses a Web Browser tab of
that project's own, the way a person does, while you watch. The owner chose on
2026-11-11 that it uses the **signed-in** browser (the same `persist:obscura`
session as your own tabs), so it can act as you on sites you're signed in to.

- **How the AI asks.** `station-browser` in the room: `open ADDRESS`, `read`
  (the page's words, plus its links, buttons and boxes, each with a number),
  `click N`, `type N "words"` (`--enter` presses Enter after; on a choice it
  picks that option), `key Enter` and a few other keys, `scroll down|up`,
  `back`, `forward`, `reload`, `shot` (a picture the AI can open), `close`.
  Every answer is the page again, so the AI sees what its action did.
- **The way in.** A room can't reach Station, so `bin/room` mounts a folder of
  the project's own: `~/.local/state/house/browser/ROOM/in` (the room writes a
  small request file there) and `.../out` (Station's answer; read-only in the
  room). The tool is `room/station-browser`, mounted read-only from the house,
  so rooms need no rebuild: a room gets it the next time it opens. The room
  note tells each AI about it. `lib/ai-browser.js` looks for requests 4 times a
  second.
- **What you see.** The project's AI tab comes to the front when the AI opens a
  page. Its bar says the project and "Claude is using this page", with a red
  **Stop**. A blue dot shows where it clicks or types. Stop gives you the page
  back; the AI then has to ask ("Claude wants the Web Browser again", Allow or
  Don't allow) before it can use the browser again.
- **Walls.**
  - Only the tab this project's AI opened. Your own tabs are never touched,
    and which project is asking comes from the folder, not from the request.
  - Nothing on this PC or the home network (localhost, 127.x, 10.x, 192.168.x,
    `.local` …) except **this project's own sites**: `localhost:3000` from the
    AI means the room's port 3000, reached through the same path Preview uses.
    Other projects' sites and Local AI live on the house's localhost too, so
    this is checked for every request the page makes (pictures, scripts,
    redirects), not only the address the AI typed.
  - House Rules' **Internet** setting: Allow, Block (only the project's own
    sites), or Ask (you're asked once per site: "Claude wants to open
    example.com", Allow or Don't allow).
  - Password and card boxes aren't listed and can't be typed in; the AI is told
    one was left out. File pickers aren't listed or clicked.
  - The page's words come after a line saying they're the website's, not the
    user's, and must never be followed as instructions.
  - At most 5 actions a second, one at a time. A request older than a minute
    (asked while Station was closed) is dropped, never done late. Anything in
    the request folder that isn't a plain small request file is deleted unread.
  - Downloads go to Downloads, as for your own tabs.
- **Not covered.** A public web name that points at a private address (DNS
  rebinding) isn't caught; the address is checked before the name is looked
  up. Asks go to the main window.
- Checked by the `aiBrowser` scene (37 checks): the real tool against a made-up
  hostile site served as the project's own, with a second server standing in
  for another project's site that counts every request (it stays at 0).

### GitHub on Home (2026-11-10)

The **From GitHub** bar on Home takes a GitHub link and gets a copy into
`~/projects`. A card shows "2 new on GitHub" when its project is behind, and
**Get updates** brings them in.

- The copy is fetched into a hidden `.getting-XXXXXX` folder in projects and
  renamed into place only when whole, so Stop never removes anything else.
  Clashing names get "name 2".
- Git runs here with https only, no hooks or credential helpers from the
  project, and LFS downloads skipped. Updates use `merge --ff-only`, so they
  never overwrite work. Every git still running is stopped when Station
  closes. Public repositories only for now.
- `lib/github.js`, `renderer/github-ui.js`. Checked by `test/github.test.js`
  and the `github` scene.

### Schedules (2026-11-10)

A **Schedules** page lists repeat tasks: a name, one project or several, a
command or an AI prompt, and when (every N minutes/hours, daily, weekdays, or
a cron line). Each run's output is kept and shown.

- A small runner, `house-schedules` (`lib/schedules-runner.js`), keeps time on
  its own, so tasks run while the house is awake whether or not Station is
  open. Station starts it. It holds a pid lock, writes `status.json`, and takes
  "Run now" requests from a `requests/` folder in
  `~/.local/state/house/schedules/`.
- A room the runner had to start is closed afterwards only if nothing else is
  in it (no terminal, no ssh session, no Station tab). Otherwise the output
  says it was left open.
- A run missed while the house slept is skipped. The house-keeper ignores the
  waiting runner (not its `docker` children), so the house can still sleep.
  After updating, the keeper must be reinstalled; see
  02-rebuild-step-by-step.md, step 7.
- `lib/cron.js`, `lib/schedules.js`, `renderer/schedules-tab.js`. Checked by
  `test/schedule.test.js`, `test/schedule-runner.test.js`, `keeper-test.sh`,
  and the `schedules` scene (see its comment for the environment it needs).

### Search everywhere, and by meaning with Jev (2026-11-10)

The search box's menu picks **This folder** (the old filter), **All folders
inside**, or **By meaning**. It starts on All folders inside (since 2026-11-11),
and remembers what you pick.

- *All folders inside* walks the folder without slowing the window (results
  stream in, up to 1,000, Stop any time). Each result shows its folder under
  its name.
- *By meaning* uses TypeSafe's Jev (System 1) with the owner's own key, kept in
  `~/.config/house/jev-key` (mode 600). The page only learns whether there is
  one. The key is added, replaced or removed in **New > API Keys** (also in the
  search box's menu): one dialog with a row per outside service
  (`renderer/keys.js`, `KEY_SERVICES`; checked by the `apiKeys` scene).
  It sends a file's name and up to 1,500 characters of its start, and
  shows how well each file fits as a bar. Up to 300 files. Only on Enter.
  It stops when the window closes or reloads.
- **Out of balance (2026-11-11):** when TypeSafe says the balance has run out
  (402, or a refusal that mentions credit, billing, balance or payment; not
  "quota", which plain rate limits use too), the
  search says so once and goes back to **This folder** by itself, so searching
  keeps working. Top up, then pick By meaning again.
- Never sent: keys, sign-ins and settings folders (`~/.ssh`, `~/.config`,
  `~/.claude` and the like), hidden files, other drives (`/mnt`), and any text
  that looks like a password, key or token.
- The Jev request shape follows TypeSafe's early-access API
  (`POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`, a `noul`
  question). It has not been tried against the live service yet.
- `lib/search.js`, `lib/jev.js`, `renderer/search.js`. Checked by
  `test/search.test.js`, `test/jev.test.js`, and the `searchInside` and
  `searchMeaning` scenes (run them separately).

### Tokens, Last read by, and the owner's name (2026-11-10)

The details view can show **Tokens** (what AI has spent on that file over its
life) and **Last read by**, next to **Last edited by**. Home's cards and the
All time tile show each project's lifetime tokens.

- A step's tokens are shared between the files it read or changed. Steps that
  touched no file (most of them) count toward the project but no file.
- Folders show the newest AI read inside them, and the tokens of the AI steps
  that touched files inside. A project's row shows its all-time total, the
  same number as its Home card. The Projects folder's row adds every project
  together. Home's All time tile is a little higher, because it also counts
  AI work done outside any project.
- Last edited by tells three cases apart after the AI's last note for a file.
  A save you make through Station 256 (text, picture, video, song info) is
  known for certain, so it shows your name, with "Saved in Station 256" on
  hover. A change made while the room's AI was working (it wrote a note for
  any file within 5 minutes) is shown as the AI's, dimmed and marked
  "Likely a command it ran". Any other change after the AI shows your name.
  A file the AI never touched stays blank, unless you saved it in Station.
  Why: a shell command doesn't say which files it changes, and a big project
  takes too long to scan after every command, so the room often has no note
  for what a command wrote (screenshots, logs, build output). Without this,
  those files would wrongly show your name.
- Counting carries a reply across reads, so a count that lands mid-reply still
  shares it fairly. The first start after updating recounts once.
- `lib/token-count.js`, `lib/stats.js`, `lib/touches.js`, `lib/owner.js`, `lib/owner-saves.js`,
  `lib/edits.js` (`whoChanged`). Checked by `test/tokens.test.js`,
  `test/owner.test.js` and the `tokenColumns` scene.

### Song page (2026-11-10)

Double-clicking a song opens its page, like a video: the cover, a player, and
title, artist, featured artist, album, year, track and genre to edit, plus a
cover picture that phones show. MP3 (ID3v2.3 with a front cover), M4A, FLAC,
OGG/Opus and WAV. Space still opens the quick preview.

- Only the info is rewritten. The sound is checked to be identical before the
  song is replaced, and the old one goes to the Trash. A song that changed
  during the save, is read-only, is a link, or is on C: is left alone with a
  plain reason. **Save as Copy** makes a new file instead.
- WAVs of any kind (16/24-bit, 32-bit float, high sample rates) are not
  remade by ffmpeg, which would change how 24-bit sound is labelled and drop
  loop points. Station rewrites only the info parts itself: the old LIST/INFO
  and `id3 ` parts are replaced by new ones at the end (the cover goes in the
  `id3 ` part), and every other part is copied byte for byte and checked by
  hash. A WAV whose existing cover Station can't carry over is refused rather
  than losing it.
- `lib/music.js`, `renderer/music-info.js`. Checked by `test/music.test.js`
  (run through `test/music-run.sh`) and the `songInfo` scene.

### Smaller fixes in this release (2026-11-10)

- Saved photos keep their camera details (Exif), with the turn reset, since
  the picture is saved upright (`lib/picture-details.js`).
- Text that isn't UTF-8 opens view-only, so saving can't damage it.
- Chat export with details keeps every step's result.

## Rooms

`~/house/bin/room` (symlinked to `~/.local/bin/room`) with commands
`new`, `open`, `close`, `list`, `status`, `login`, `build`.

A room is one container per project:

- image `house-room:latest`, built from `~/house/room/Dockerfile`
- Ubuntu 26.04, user `dev` at uid 1000 so files stay owned by you
- **no sudo installed** — there is no way to become admin inside a room
- no docker socket
- only that one project folder mounted
- on the `house-rooms` network
- a per-project Claude config volume, with the login token shared from
  `~/.config/house/claude-token`
- `claude-managed.json` mounted in as Claude's managed settings, so house rules
  apply inside the room

### Claude sign-in in a room (2026-11-07)

- **Shared key (default).** `room login` makes one long-lived key
  (`claude setup-token`) that every room gets as `CLAUDE_CODE_OAUTH_TOKEN`. It
  can only chat. Claude refuses Remote Control with it ("Remote Control requires
  a full-scope login token").
- **Full sign-in per project.** Type `/login` in Claude inside a room. It is
  saved in that project's own Claude volume (`.credentials.json`, under
  `claudeAiOauth`), so it lasts when the room closes. A full sign-in renews
  itself, so it can't be shared between rooms; each project signs in once.
- The shared key wins over a full sign-in when both are there, so
  `room/station-signin.sh` (read by every room shell from `/etc/bash.bashrc`)
  takes the key away before each prompt when the room has a full sign-in, and
  puts it back if that sign-in is removed (`/logout`). Claude itself is not
  wrapped, so the Herdr AI detection is unchanged.
- Trade-off the user chose: in a project with a full sign-in, the AI in that
  room holds a full Claude login, not just a chat key.
- Checked in a throwaway room with fake sign-in files: the key is used until a
  full sign-in appears, then the same terminal and new ones go without it
  (`claude auth status` says `claude.ai`); a tool's own sign-in in that file
  doesn't count; signing out brings the key back. A real `/login` and Remote
  Control themselves were not tried by the test.

Start-up is hardened: it waits for docker and the firewall, verifies the room is
up, retries three times, and logs to `~/.local/state/house/room.log`. Docker is
never trusted when it fails to answer — `room_state` returns `unknown` rather
than `none`, so a room is never replaced because of a timeout.

### Room terminals keep running (2026-11-07)

Each room terminal tab is its own Herdr session in the room (`tab-1`, `tab-2`…).
The panel only holds a line to it (`room attach NAME TAB`).

- **Closing its tab or its window only closes the line.** Whatever runs in it
  (Claude, Codex, Gemini, a plain shell, a long job) keeps going. No question is
  asked. A note says "Still running in the room", with **Undo**.
- **Enter Room goes back into it, AI first.** If an AI (Claude, Codex, Gemini)
  runs in one of the room's terminals, Enter Room goes to that one: its tab in
  this window or another, or it opens it again (`herdr.agentTabs` reads Herdr's
  `agent` field, which shows about 15 s after the AI starts). With no AI it goes
  to an open tab, then one in another window, then a terminal still running that nothing
  shows (the one closed last), and only then a new one. Same screen, folder and
  settings as before.
- **Clicking a folder** opens a terminal in that folder: one already sitting
  there, or else a new one. It never reuses a terminal that is in another folder.
- The closed ones are listed in `~/.local/state/house/parked-tabs.json` so they
  don't pop back up as tabs when Station 256 opens. Ones that ended are dropped.
- It ends for real only when you type `exit`, use Close Room on it, close all
  of the project's rooms, or the room stops.
- **Each terminal is one of the project's rooms** (New Room opens another).
  So there are two close buttons, and each says what it closes:
  - **Close Room** (top bar while on a room terminal, or right-click its tab)
    ends just that one terminal (`room tab-stop`). The pop-up says how many
    other rooms keep going. Others count even when no tab shows them, or one
    is still opening (`terminals.othersRunning`). If the room can't be asked,
    only that one terminal ends, never more. Only when it's the last one does
    the whole room close, and the pop-up says so first.
  - **Close All Rooms** (top bar on the project's files, the project's
    right-click menu, the Agents page) stops the project's whole room and
    every terminal in it, as Close Room used to do everywhere.
  - Added 2026-11-09 after Close Room on one terminal closed all of them. The
    `closeOne` scene checks it (`STUB_AGENTS=working`, 16 checks).
  - Since 2026-11-10 one room can also be closed from the **Agents page**
    (Close on each terminal's line) and from **Home** (the arrow beside an open
    room's Enter Room, or the card's right-click menu: "Close Room 2 · Codex,
    Needs you"). Same pop-up and rules (`closeRoomTerminal`); a terminal shown
    in another window ends there too (`terminals.endRoomTab` / `end`, whose
    exit code 0 makes its tab go). The menu asks the room for its terminals
    (`roomTerminals` → `herdr.roomTabs`).
- A plain Linux House terminal (not in a room) still ends when closed, and asks
  first if something is running in it.
- **Linux House on the Agents page** (2026-11-10): always the first section,
  listing each house terminal with its AI and state, a New Terminal button, and
  Go to / Close on each line, like a room. House terminals aren't in Herdr, so
  `lib/house-terms.js` reads the same things itself: the AI from the programs
  under the terminal's shell (`/proc`, names claude/codex/gemini/opencode), and
  its state off the bottom of its screen, asked from the window showing it
  (`window.houseTermScreen` via `executeJavaScript`): "esc to interrupt/cancel"
  = Working; "Do you want to proceed?" and the like = Needs you; else Idle. The
  title is the one the AI gives its terminal (Claude's task name), else the
  folder. The `roomsAndHouse` scene checks all of this (`STUB_AGENTS=working`,
  18 checks).
- **"Last edited by" after shell commands**: a room's AI that changes files
  with a shell command (not its edit tool) is credited by `room/house-edit-log`
  scanning the project for files changed while the command ran. Folders tools
  fill (`target`, `.rust`, `.cargo`, `dist`, `build`, `node_modules`, any
  folder with a `CACHEDIR.TAG`...) are skipped. Before 2026-11-10 they weren't,
  so a Rust project (20,000 build files) made every scan give up and the dot
  vanished. A changed hook reaches new rooms after `room build`; an open room
  gets it with `docker cp` into `/usr/local/bin/house-edit-log` (as root, 755).
- A line that drops joins again by itself. If it can't, the tab says "Lost the
  connection"; Enter Room later puts a working tab in its place.
- A double click on Enter Room or on an Agents row opens one tab: asking for a
  terminal that is already shown (`create` with a tab) returns that one
  (`existing`), never a second line to it. Two New Room clicks at once get
  two different numbers. Right after Station 256 opens, Enter Room waits (up to
  8 s) for the terminals coming back, and asks the room even before the list of
  open rooms has filled in.
- When Docker is slow to answer, `tab_state` in `bin/room` says `unknown`, and
  the room script treats that as "only the line ended" (exit 4). It never takes
  a slow answer to mean the terminal ended, so it never deletes it.
- `restore` only drops a waiting one when its room listed its terminals; a room
  that listed nothing may not have answered.
- If the page crashes it reloads by itself (once a minute at most), and its room
  terminals come back as tabs (`terminals.letGo`). Quitting never marks a
  terminal in any window as waiting, so it comes back as a tab next time.
- Closing a window while others are open (X, taskbar or Alt+F4) asks only if one
  of its house terminals is busy; its room terminals keep running and wait for
  Enter Room. Moving a tab to another window asks nothing.
- `lib/terminals.js`: `close()` lets go, `kill()` ends it (`room tab-stop`).
- Checked (2026-11-07, audit): a real Claude session survived a closed tab and
  Enter Room went back into the same process; quit and reopen kept the closed one
  waiting and brought the other back as a tab; Close Room tidied the list. The
  `resume` scene in `test/shots.js` checks the buttons with a stand-in room
  (`SHOT_PATH=~/house/panel/test/stub STUB_AGENTS=working
  test/shotrun.sh resume`, 33 checks including pop-outs, a lost line, a page
  crash, double clicks and blocked right clicks; never on screen). A second,
  independent code review found 11 gaps (races, slow Docker, crash, taskbar
  close); all were fixed.

### Tabs and windows (2026-11-09)

The user asked for Chrome-style windows: any tab can become a window of its own,
but only when its window has more than one tab ("pointless to have that option
if only one tab"), so a window's last tab stays put.

- **Every window is a full Station 256 window** (`index.html`): its own tabs, +
  button, left pane and footer. `main.js` keeps `stations` (oldest first) and
  `focusOrder`. The first is the main window: its place on screen is remembered,
  room terminals come back to it at start, and notifications fall back to it.
  If it closes while others are open, the oldest takes over. Closing the last
  window closes Station 256, with the usual question (Keep rooms up / Close
  rooms too). Every window is titled "Station 256".
- **One-tab rule.** A tab's "own window" button shows only when its window has
  2+ tabs, and only then can it be pulled off the strip. Dragging a window's lone
  tab moves the whole window instead. A lone tab shows "move back" (to the main
  window) when its window isn't the main one, and a close button whenever other
  windows are open: closing it closes that window.
- **Moving tabs.** The button opens a new window a little down and right of the
  old one, the same size. Pulled off the strip and let go: over another window's
  tabs (a gap opens there while it's carried) it joins them; anywhere else it
  becomes a window under the pointer. A window carried by its lone tab onto
  another window's tabs joins them and closes. Files tabs keep their folder and
  Back/Forward; terminals keep running and are handed over in `main.js` first
  (`terminals.attach`), so nothing they print is lost; Agents and House Rules
  move as pages (one of each per window).
- A window made from a tab loads `index.html?tab=1`: no loading screen, and
  `windowStart` hands it its tabs. A crashed window reloads and gets its own room
  terminals back (`recovering`).
- **Smoother carrying (2026-11-09, asked for after trying it: "a lot smoother
  when dragging out and in").**
  - *A window is got ready out of sight* (`warmSpare` in `main.js`) when a tab
    starts being carried, or the pointer is on its "own window" button
    (`tabWarm`). It loads `index.html?tab=1` hidden and waits in `windowStart`
    until `windowForTab` gives it a tab. It isn't in `stations` until then (so it
    isn't counted), it's let go after 3 minutes unused, and the checks know it by
    `win.houseSpare`. Measured hidden: its tab shows in 23 ms, against 117 ms for
    a new window (`windowSpeed` scene).
  - *Nothing shows empty.* A window made for a tab comes on screen only once the
    page says its tab is in (`windowFilled`, or after 1.5 s at most).
  - *The carried picture stays until the window is there.* Let go away from any
    tabs, the picture grows into the new window's shape right where the window
    will be (`landTabGhost`; the pointer holds it at 60, 16 and the window is
    placed to match, `CARRIED_AT`). The new window only fades in, no zoom
    (`window-motion.js`), and `tab:landed` tells the old window to fade the
    picture once it's on screen. The "own window" button does the same from the
    tab's place.
  - *Over another window's tabs* the picture shrinks to a tab (`chip`) so the gap
    shows. A window carried by its lone tab fades away there (`html.docking`) and
    its tab's picture shows instead. Let go, the window that takes the tab comes
    to the front only after the tab has faded in (`LAND_MS`), and the lone tab's
    old window closes then too, so nothing vanishes at once. The tabs beside the
    gap glide to their new places.
  - The picture moves by `translate` once a frame. Questions about which tabs
    are under the pointer go one at a time, asked again after an answer if it
    moved meanwhile (`asksOver`), so the gap can't be left stale.
- **Closing a window** (not the last) closes its tabs the usual way:
  `terminals.closeOwnedBy` ends its house terminals and parks its room ones.
- **Enter Room and notifications** find a room terminal in whichever window has
  it (`terminals.shownBy`, then `term:show` to that window).
- **Windows helper: unchanged.** `FindStation` follows the top "Station 256"
  window, which is the one used last. `main.js` sends snapping keys, seams and
  file drops from Windows to that window (`helperWindow`), and only its
  `snapWatch` and `dropArea` reach the helper. Switching windows makes the new
  one tell the helper where it is (`connected`). Clipboard changes go to every
  window.
- The old terminal-only pop-out (`term.html`, `term-window.js`) is gone.
- Checked (2026-11-09): the `windows` scene in `test/shots.js` (34 checks, never
  on screen, with a stand-in pointer: `test/shotrun.sh windows`; it closes the
  main window at the end, so run it alone), `tabGhost` (pictures of each shape),
  `windowSpeed`, plus the `resume`, `links`, `placeIcons`, `rules` and `terminal`
  scenes. The user has dragged tabs out and in on the real screen (it worked).
  Not yet seen there: Windows snapping on a second window, and drops from
  Windows onto a second window.

### Room terminals are a clean screen (2026-11-07)

A room terminal shows only what runs in it. Herdr is there to keep it running,
never to be seen. `room/herdr-tabs.toml` (merged into the tab settings in the
blueprint) does this:

- `ui.mobile_width_threshold = 0`. Herdr's default (64) switched a narrow tab to
  its phone layout, which has a "switch" menu with spaces, tabs and settings.
  That menu is what showed up.
- Every Herdr key is set to `""` (off). The prefix can't be empty, so it is
  `ctrl+alt+shift+f12`, which nobody presses. Herdr's menus, tabs, splits and
  detach can't be opened from the keyboard.
- `renderer/term.js` `keepClicksFromHerdr` stops right and middle clicks in room
  terminals, so Herdr's right-click menus never open. Left clicks still reach
  the program (Claude's mouse support works).
- A room that was opened from the old blueprint gets the same settings without a
  restart: write the merged file into
  `/home/dev/.config/station-tabs/herdr/config.toml`, then run
  `herdr --session tab-N server reload-config` for each terminal (answer
  `applied`).
- The AI tools are pinned in `room/Dockerfile` (`@openai/codex@0.167.0`,
  `@google/gemini-cli@0.67.0`), so a rebuild changes only what we changed. The
  tab-settings step comes after the AI steps, so editing it doesn't reinstall
  them.
- Checked: a new tab from the blueprint shows no Herdr screen at any width
  (Herdr's own screen is visible for about 1 ms while it starts); Herdr's keys do
  nothing; Enter Room picks the Claude terminal over a plain one closed after it.

## The firewall

`house-firewall.sh` creates the `house-rooms` Docker network
(`172.30.0.0/24`, bridge `br-rooms`, `enable_icc=false` so rooms cannot talk to
each other) and loads one iptables batch through `iptables-restore --noflush`,
so a failure can never leave a room behind a half-built wall.

Two chains:

- `HOUSE-ROOMS` (hooked into `DOCKER-USER`) — drops traffic from the room subnet
  to every private range: `10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
  `100.64/10`. Established and related traffic returns first, so replies work.
- `HOUSE-ROOMS-IN` (hooked into `INPUT`) — drops anything arriving from
  `br-rooms` except established and related.

Result: internet yes; Windows, the LAN, the house, and other rooms no.

The old block-all-internet switch is **gone**. Internet is now governed by the
`web` house rule instead, because Claude needs internet to work at all.

## House rules

`~/.config/house/rules.json` holds Allow / Ask / Block switches. They apply to
**all** projects — there are no per-project rules, by decision. The app's
**House Rules page** (Rules button) opens as a tab, like Agents; Done or Esc
closes it and goes back to the tab you came from. Its words say "AI", because
the rules bind **every AI in a room: Claude, Codex and Gemini** (2026-11-07).

`panel/lib/rules.js` writes one file per AI from the same choices, in
`~/.config/house/`, and `bin/room` mounts each one read-only into every room.
They're rewritten in place, so open rooms see a change at once (Codex and
Gemini the next time they start):

| AI | House file | In the room | How it's enforced |
|---|---|---|---|
| Claude | `claude-room.json` | `/etc/claude-code/managed-settings.json` | managed permissions (allow / ask / deny) |
| Codex | `codex-requirements.toml` (`panel/lib/ai-rules.js`) | `/etc/codex/requirements.toml` | admin requirements: command rules (prompt / forbidden), web search modes, always on-request, patch hooks for `.github` and AI settings files |
| Gemini | `gemini-policy.toml` (`panel/lib/ai-rules.js`) | `/etc/gemini-cli/policies/house.toml` | admin-tier policy: deny 300 > ask 200 > allow 100 |

Block beats Ask beats Allow for all three. Tested 2026-11-07 (Codex 0.167.0,
Gemini 0.67.0); `node panel/test/ai-rules.test.js` checks the files.

Gotchas:
- **Gemini skips a settings file not owned by root**, hooks and all. So its
  system settings (edit-log hooks, YOLO off, your five folders) are in the room
  blueprint, `room/gemini-settings.json`, which must equal `geminiSettings()`
  (the test checks). The policies folder must be root's too; the blueprint makes
  it. The policy file inside may be the house's.
- **Codex's own sandbox can't start in a room** (no namespaces), so
  `room/codex-config.toml` sets `sandbox_mode = "danger-full-access"`; the room
  is the wall, as for Claude.
- **What Codex can't keep** is shown on the page under the rule: it can't ask
  before a web search or before changing `.github` or AI settings files (so Ask
  blocks those), it isn't stopped from reading `.env` or outside files, it can
  delete with its own patch tool, and it doesn't ask before editing.
- Command rules are best effort for every AI: a script the AI writes and then
  runs isn't checked.

| Wall | Default | Enforced by |
|---|---|---|
| Windows door | Block | `house-rules door-open` / `door-close`, read-only drvfs at `/mnt/windows-door`, `/windows` in rooms; relocks on house restart |
| Other projects | Block | read-only `/projects` mount |
| Your folders | Block | Documents, Pictures, Music, Videos, Downloads mounted at `/home/dev/<name>`, read-only on Read only |

When the Windows door is unlocked it is **read-only for AI** — never change or
delete anything on the Windows side. The explorer's Windows (C:) drive is the
same door, view and copy only (see "Windows (C:) in the sidebar").

Walls are set when a room opens. Changing one on the House Rules page while
rooms are open shows a note: those rooms get it the next time they open.

**The room note (2026-11-08).** Every AI in a room gets a short note on where it
is, written by `bin/room` (`write_room_guide`) as the room opens, from what that
room really got: `~/.local/state/house/guides/<id>.md`. Claude reads it as the
admin's `/etc/claude-code/CLAUDE.md` (read-only, can't be turned off); Codex and
Gemini get a copy at `~/.codex/AGENTS.md` and `~/.gemini/GEMINI.md`, made after
the room is up (a mount there would make the folder root's). It says:
- `/workspace` is `L:\home\<you>\projects\<name>` and `~/projects/<name>`, so the
  AI translates paths you give it instead of saying they don't exist.
- Whether your folders, other projects and Windows files are in this room, and
  if not, what to tell you (House Rules, then close and reopen the room). The
  empty `/home/dev/Downloads` stand-ins are named as stand-ins.
- Sites: print `http://localhost:PORT`, which works in the Windows browser.
- Never tell you to use Docker, volume mounts or sudo.

Why: a room opened at 15:41, Your folders went to Read only at 15:45, and the
room's Claude was asked for `L:\home\your-user\Downloads\Notes Design.html`. It saw
only the empty stand-in, didn't know `L:` was the house, and told the user to
"ask someone to add a volume mount". Tested with a throwaway room-blueprint box:
Claude 2.1.319 read the note and mapped both paths.

## Sleep

Three layers, and they had to be untangled in this order:

1. `.wslconfig` `instanceIdleTimeout=-1` stops **Windows** from pulling the rug.
2. `house-keeper` inside Ubuntu powers the house off after 600 seconds with no
   "lights" on. Status is written to `/run/house/status`, readable via
   `room status`.
3. `sleep-at-login.ps1` (HKCU Run) sleeps the house once per logon, so a restart
   does not leave it idling in RAM.

**Lights** = any container up, a `SessionLeader` process (a real terminal), a
`your-user` background process (excluding WSL's hidden login shell), or apt/dpkg.
A house Herdr with nothing running in it is not a light (Herdr itself and its
empty shells are left out; a program running in one of its shells still is).
Tested by `keeper-test.sh`.

Known limits:

- An open room keeps the house awake. That is the user's rule, left on purpose.
- Root jobs with no terminal are not detected, except apt/dpkg.
- A job started in a session that ends in the same instant can die.
- Windows' own PC sleep is untested and would pause everything.
- **Any `wsl` command resets the 10-minute timer** — including this backup
  session reading files over `\\wsl.localhost`. Measure sleep hands-off with
  `wsl --list --running`.

Measured on a real restart (2026-11-06): the WSL engine and Ubuntu's pid 1 start
by themselves 16 seconds after boot, before Explorer; systemd services only come
on at first touch of the house. Likely cause is the saved L: mapping, not proven.
Idle cost measured at about 500-630 MB of the available memory and 0.05% CPU — the user judged
that too much and chose "asleep when unused".

A real sleep test passed: Station closed 04:15, Ubuntu stopped 04:29, engine gone
04:30:22. That took about 14 minutes rather than 10, and the extra time is
**unexplained**.

## Alt+L opens Station 256 (2026-11-09)

Like Win+E for File Explorer. The user chose Alt+L (over Windows' own
Ctrl+Alt+L shortcut key). At first an open Station came to the front; the same
day the user asked for **a new window each press**, as Win+E does. Every
window shares the same rooms, terminals and Agents page.

- Open: the listener runs `start.sh --new-window`. The running app gets it as
  a second launch (`requestSingleInstanceLock({ newWindow })`, `second-instance`
  in `main.js`) and opens a fresh window, 32 px down and right of the window
  used last (the usual size, centred, next to a maximized one). It starts like
  a cold start (user asked): loading screen, opening motion, then Home. Room
  terminals that come back at start-up still only go to the first window. The
  listener brings it to the front as soon as it shows (with the Alt tap trick
  if Windows says no) and logs how long it took. The shortcut still only
  brings the open window forward. `start.sh` skips trimming logs then, since
  the running app is writing to them. Hidden scene `altL` (7 checks).

- `%LOCALAPPDATA%\LinuxHouse\station-keys.ps1`, started at sign-in by HKCU Run
  **"Station 256 keys"** (`conhost --headless powershell -File ...`). One copy
  only (mutex `Station256Keys`). It only waits, so it never wakes the house.
- Station windows are found the same way as in `open-panel.ps1`: title
  "Station 256", hosted by `msrdc`.
- Not open: it runs `open-panel.ps1`, the same as the shortcut. Presses during
  the next 20 s are let go, so it never starts twice.
- Another app holding Alt+L: it notes that and tries again every minute.
- Notes go to `station-keys.log` next to it (cleared past 256 KB; the backup
  skips it). `-Check` says if the window is open; `-Test` listens for
  Ctrl+Alt+Shift+F12 and only notes presses.
- Checked 2026-11-09: `-Check` found the open window; the `-Test` copy caught a
  simulated press and a second copy ended by itself; the real one logged
  "listening for Alt+L". A real Alt+L press is left for the user, because a
  fake one would have pulled Station 256 over the browser they were using.
- Alt+L no longer reaches other apps (Windows gives it to the listener).

## Snapping with Windows

The hard part: Windows snap moves the msrdc window for about 15-30 ms, then the
Linux side moves it back, and Linux never learns the new position.

The fix is the **live link**: Electron listens on `127.0.0.1:47256`
(`lib/windows-link.js`), with a secret in `~/.local/state/house/link-token`. The
Windows helper loads `snap-link.cs`, hooks window-move events via
`SetWinEventHook`, and reports positions over that socket. `main.js` waits 500 ms
before re-maximizing.

Both directions work:

- **Windows snapping Station** — rebuilt against Windows 11's measured behaviour
  on a real PC: panel layouts, suggested pair first, peek sliver,
  triggers within 15 px of the top, edge and corner previews, maximize-button
  flyout, a tray with real window pictures, and it carries on after Windows' own
  tray closes. `Win`+arrow follows the measured rulebook in `KEY_MOVES`
  (`windows/re-keys.ps1` measures it). The helper reads the key itself, because
  the surface is always reported as "maximized".
- **Station snapping Windows apps** — the helper lists and moves Windows windows
  through the link.

The **seam**: the helper finds windows touching Station's edges, and the page
shows nearly invisible `.snap-seam` strips (alpha 1/255, so clicks do not fall
through). Both windows then follow live, dragged from either side.

Measured minimums: Station 756 px wide (560 at 135% zoom); a
500-wide form reports 607 because of DPI virtualisation.

## Staying behind the window you're using (2026-11-08)

Station must sit in the pile like any other app: whatever you're using is on
top. Three parts of `snap-link.cs` make that hold:

- **No jumping forward when the layer is fixed.** `Settle` and `BackToFull` put
  the surface back to full screen when Windows or WSLg change it. Maximizing
  also activates a window, so it now only happens while Station is the active
  window. While you're in another window, covering the screen is enough, and the
  maximize waits until you come back. This was the confirmed cause of Station
  popping in front after clicking another app ("layer corrected" in
  `helper.log`).
- **The grab-back guard** (`OnFront`, `GiveBack`) puts the app you picked back in
  front when the Linux side takes the front back with nothing you did in between.
  It now also covers switches through the taskbar, Start and Alt+Tab (those
  windows are skipped as "where the front came from"), and grab-backs up to
  1.5 s later. Before, it was 0.5 s, and `main.js` re-maximizes 0.5 s after an
  unmaximize. Logged as "kept … in front".
- **`StayBehind`**, every 100 ms: if Station is above the active Windows app
  without being active itself, it goes just behind that app. It takes no focus,
  doesn't move or resize anything, and skips always-on-top windows (going behind
  one would make Station always-on-top too). It does nothing while a mouse button
  is down, and stops after 5 tries in 10 s. Logged as "went back behind …".

Only the helper changed, so it needed a helper restart, not a Station restart.
Not yet proven on the real screen: a test that raised Station from another
process couldn't move it at all, so the user's own clicking is the check.

## Links, room sites and voice typing (2026-11-08)

The house has Windows interop off, so anything that needs Windows goes through
the helper on the live link above.

**Links.** Web links in every terminal are clickable (`renderer/term.js`
`linkFinder`): `http(s)://…`, bare `localhost:PORT`, `127.0.0.1` and `0.0.0.0`,
links a program marks with OSC 8, links the terminal wrapped, and long ones a
program drew in pieces (a line full to its last column runs into the next).
Trailing punctuation and unmatched brackets are left out. A click calls
`openLink` in `main.js`, which asks the helper (`op: open-url`, http/https only)
to open it in the default browser. It works while a program has the mouse (Herdr,
Claude). xterm keeps a line's links while the mouse stays on that line, so
`keepLinksFresh` nudges it to look again after new output.

**Sites in rooms (`lib/ports.js`).** Every 3 s the panel reads each open room's
listening ports from the house side (`/proc/PID/net/tcp` and `tcp6` of the
room's first process, so nothing runs in the room). For each port on the room's
localhost or any address (not 22, not Docker's 127.0.0.11, 1024 or above) it
starts `room forward NAME PORT`: `ssh -N -L 127.0.0.1:PORT:localhost:PORT` over
the room's ssh door. WSL makes the house's localhost Windows' localhost, so
`http://localhost:3000` in any Windows browser reaches the room. A port the house
already has is skipped; clicking a link to it (or to a port under 1024) opens a
path on a free port and opens the link there. A site that stops loses its path
after 20 s; closing the room closes them all. The room's `sshd_config` allows only
this: `AllowTcpForwarding local`, `PermitOpen` to its own localhost,
`PermitListen none`. The room still can't reach the house or Windows. A room from
an older blueprint gets a note to reopen it (or the live fix: new `sshd_config`,
`sshd -t`, then `kill -HUP` the room's sshd).

**Voice typing.** Windows turns Win+H away from Linux windows ("isn't supported
in remote applications"). The helper's keyboard hook (`OnKey` in `snap-link.cs`)
catches Win+H only when a Station 256 window (any of them) is in front,
swallows it, and sends key 0xE8 so Start doesn't open.

Since 2026-11-08 (the user rejected the visible box as "extra overlay"): `VoiceBox`
is **invisible** (opacity 0.01, click-through `WS_EX_TRANSPARENT`, tool window,
so it's not in Alt+Tab). It takes focus (Alt trick, retried because the Linux side
takes focus back), waits until Win is let go, and sends Win+H itself, so Windows'
own voice typing bar is all you see. Every change in the box goes straight into
the app as it happens: `{type: 'voice-edit', remove, add, enter}`, where `remove`
is letters to take back from the end and `add` is letters to add after that.
Windows rewrites words as it hears more, and this keeps up. `main.js` passes it
to the window last in front. `term.js` sends a backspace (0x7f) per letter, then
the words, to the terminal (newlines become spaces), or edits the text box. Enter
(yours) comes the same way after the words, so it can't arrive first. Esc, or
clicking anywhere, gives the keyboard back, and the words are already in.
Backspace with nothing said yet deletes from what was there. If the app isn't
linked, the words go on the Windows clipboard. The old `{type: 'voice', text}`
message still works.

No little word box (2026-11-08, the user saw words in a small box near the
bottom before they reached Station): voice typing first puts in words it's still
working out (an IME "composition"), then swaps in the words it settles on. A plain
WinForms `TextBox` doesn't draw those itself, so Windows drew them in its own
floating composition window, visible even though the box isn't. The box is now a
`QuietTextBox`: it clears `ISC_SHOWUICOMPOSITIONWINDOW` on `WM_IME_SETCONTEXT`,
keeps `WM_IME_STARTCOMPOSITION`/`ENDCOMPOSITION` from Windows, and reads the words
on `WM_IME_COMPOSITION` with `ImmGetCompositionStringW` (`GCS_COMPSTR` = still
working out, `GCS_RESULTSTR` = settled, which goes into the box). What goes to the
app is the box's text with the working words at the cursor, so words appear in
Station as you say them, like they do inline in a Windows app. If Windows gives
no input context, the message goes on as before. Checked with a compiled copy in
its own process (18 checks, never shown); the real check is the user speaking.

Checked (2026-11-08): `links` scene in `test/shots.js` (15 checks with the live
voice ones, hidden window, nothing opened for real); a throwaway room with sites on 127.0.0.1, ::1,
0.0.0.0, port 80 and a port the house had, reached from the house and from
Windows (`Invoke-WebRequest http://localhost:PORT`); paths closed when a site
stopped and when the room closed; the helper compiles. Win+H itself and a real
link click into Edge were left for the user, since they need the real keyboard
and screen.

Not covered: a second Station 256 window, Windows' taskbar snap groups, other monitors.

## AI status on tabs, and Windows notifications (2026-11-08)

The user wanted to see at a glance which room AI is working or needs them, and a
Windows notification when one is done or needs them, ideally one they can answer.

**Watching.** `panel/lib/agent-alerts.js` runs the whole time the panel is open
(not only while the Agents page shows). Every 3 s it lists open rooms
(`house.rooms()`) and asks each room's Herdr tab sessions for a snapshot
(`herdr.roomTabs`, the same as the Agents page). A tab's state is its most urgent
AI pane: blocked, then working, then done, then idle. Tab colors use each look as
it comes; a notification needs the change to show twice in a row (about 3 to 6 s),
so a flicker never notifies. What an AI is doing when the panel opens is not news.
A room that doesn't answer keeps its last state. In checks it only runs with
`STUB_AGENTS` and the stand-in Docker, so a check never looks inside a real room.

**Tab colors.** `agents:tabs` goes to every window as a map
`"room<TAB>tab-N" -> status`; `agentStatuses` gives it to a window that just
opened. Room terminal tabs (in every window) get `agent-working` (green
tint, green text and icon) or `agent-blocked` (yellow). The open tab keeps its
join with the bar and gets a 2 px line along its top instead. Done and idle are
plain. House terminals have no Herdr, so no colors.

**Notifications.** working → done/idle: "{Project} is done" with the Claude
session title, button Open. Anything → blocked: "{Project} needs you". The pane's
screen is read (`herdr pane read --source visible --format text`) and
`readPrompt` looks for Claude's permission question ("Do you want to …?" with
"1. Yes" and a "No" option). If found, the body names it (e.g. "Bash command: npm
install left-pad") and the buttons are Approve, Deny, Open; any other question
(choices, plan approval) gets Open only. A second terminal in a room is named
"Project (terminal 2)". No notification about the terminal you're looking at
(a focused window showing that tab). Since a Linux
window may not hear that you went to a Windows app, the helper is asked too
(`front`: is a Station window in front?); without an answer, the panel's own
view stands. Each terminal
has one notification at a time (tag = hash of room+tab): a newer one replaces it,
and it's taken away once the state moves on, the tab closes, or you look at it.

**Answering.** Approve and Deny press a key only if the screen still shows the
same question (sha256 of the question block, arrow position ignored) and, for
Approve, the arrow is on "1. Yes": then Enter, or Esc for Deny
(`herdr pane send-keys`). Otherwise nothing is pressed, Station comes forward and
the tab opens. Open: the helper brings Station forward, the panel brings forward
the window that has that tab (`term:show`), or sends `agents:open` to the main
window, and the page goes to the tab (reconnecting it if it was closed). A click from before the panel restarted can still Open, never answer.

**Windows side** (`snap-link.cs`): at start it registers the app id
`Station256.App` under `HKCU\Software\Classes\AppUserModelId` (DisplayName
"Station 256", IconUri `%LOCALAPPDATA%\LinuxHouse\station-256-logo.png`), so each
notification shows the Station 256 logo and name at its top left. The logo is the
biggest picture inside `station-256-app.ico`, copied out byte for byte: that .ico
stores every size as PNG, which `System.Drawing.Icon.ToBitmap` turns into noise (a
first version did that, as `station-256-notify.png`, now deleted). Ops `notify` (tag, id, room, tab, title, body, buttons),
`unnotify` (tag), `raise`. Notifications use Windows' toast library through
reflection (`ContentType=WindowsRuntime`); clicks are heard with
`WindowsRuntimeMarshal.AddEventHandler`, since plain `EventInfo.AddEventHandler`
is refused for those. A click sends `{type: 'notification', id, action, room,
tab}`. Clicks only reach a running helper: after a helper restart, older
notifications do nothing.

**Files tabs show their place's icon.** On Home, Documents, Pictures, Music,
Videos, Downloads, the L: drive or Trash, the tab shows that place's icon and
color from the left pane (`showPlaceIcon` in `app.js`, after each folder loads).
Anywhere else, the folder icon.

Checked (2026-11-08): `node panel/test/agent-alerts.test.js` (22 checks: reading
the question, fingerprints, the two-looks rule, Approve/Deny/changed/unknown,
looking, closing, a room not answering); `agentTabs` and `placeIcons` scenes with
`STUB_AGENTS=live` (stand-in Docker in `test/stub`, 10 + 12 checks, pictures of
the tabs); `agents` and `links` scenes still pass; the helper copy compiles, shows
a notification Windows accepts, takes it away, and ignores a bad tag; a real click
on a test notification reached a test program. A real notification click into the
running app, and Approve on a real Claude question, are for the user to try.

## Clean-up (2026-11-10)

Station and its rooms used to leave things behind that piled up unseen: a closed
room still holding 38 GB, crash dumps inside a project, Docker's build cache, the
video editor's copies, logs, the Trash. Now Station tidies up by itself, about
once a day, and only with things that are safe to remove.

**What is removed, and when.** Two minutes after Station starts it checks when it
last cleaned; if that was over 20 hours ago it cleans, then checks every hour and
cleans again once 24 hours have passed. You can also press **Clean up now** in the
System panel, which says when it last ran and how much it freed (hover for what
each part removed).

- Rooms that are closed or stopped but were never removed (the room's own
  container only, never one that is running).
- Crash dumps: files named `core` or `core.1234` that really are crash dumps, at
  least 1 MB, in your projects (and in the Trash). A file that only happens to be
  named `core` is left alone.
- Things in the Trash for more than 30 days. The Trash page says so.
- Docker's build cache older than a week, and old images that have no name and
  that nothing uses.
- Station's log files, when over 5 MB: the newest 1 MB is kept.
- Leftover folders from Station's own picture checks in `/tmp` (more than a day old).
- The video editor's passing copies of imported videos that are over 12 hours old
  (the editor keeps its own copy in the project). This happens only when an editor
  tab has just opened and no other editor tab is open, because an open editor may
  still be playing from them; never in the daily run.

**What is never touched.** Your project files (apart from crash dumps), the AI's
chat history, room images, running rooms, your editor projects, Trash items under
30 days, and Music, Documents, Pictures, Videos and Downloads. When Station isn't
sure, it keeps the thing.

**Turning it off.** Untick **Clean up automatically** in the System panel
(the setting `cleanup: false` in Station's settings). The button still works.

**Crash dumps are now blocked at the source.** Rooms are started with
`--ulimit core=0` (`bin/room`), so a crashing program (headless Chromium was the
one) can't write a dump into your project. This only applies to rooms opened after
this change: close and open a room to get it. Dumps from before are removed by the
clean-up.

What ran is written to `~/.local/state/house/housekeeping.json` (the last run and
the totals of the last ten) and `housekeeping.log`. The code is
`panel/lib/housekeeping.js`; checked by `node panel/test/housekeeping.test.js`
and the `cleanup` scene.

## Self-recovery (2026-11-10)

Station 256 looks after itself, so nobody has to open a terminal to fix it.

- **A crash starts it again.** `panel/start.sh` now watches the app. If it stops in a way nobody asked for (it crashed, or Linux ran out of memory and killed it), it is started again after 2 seconds and a line is written to the log. If you quit it yourself, or Windows or Linux is shutting down, it stays closed. If it crashes 4 times within 10 minutes it gives up, and says so in the log, because something is badly wrong.
- **A frozen page starts again.** If a window's page stops answering and is still frozen 20 seconds later, its page is ended and starts again by itself, the same way as after a page crash (a frozen page can't take an ordinary reload). At most once every 5 minutes per window. Terminals in the rooms keep running and come back as tabs.
- **A damaged file is never silently lost.** When Station starts, it checks its own saved files (settings, token counts, parked tabs, housekeeping). A file that is empty, half-written or garbage is renamed to `<name>.broken-<date-time>` next to the original, Station starts that file fresh, and the log says so. The newest 3 such copies are kept for each file. The schedules file is left to the Schedules page, which already sets a damaged one aside and says so on the page. Leftover temporary files from an interrupted save (`.tmp`, `.new`) older than an hour are cleaned up. Secrets and keys are never read or touched.
- **Errors go to the log, not a pop-up.** A mistake inside Station is written to the log with `[station] error:` in front, and the app carries on. If one happens while Station is starting and no window has appeared 30 seconds later, or if there are more than 20 in a minute, Station exits so it gets a fresh start.
- **The log** is `~/.local/state/house/panel.log` (inside Ubuntu), trimmed to its last 1 MB once it passes 5 MB. Look for lines that start with `[station]`.

The tests are `panel/test/start-supervisor.test.sh`, `panel/test/selfcheck.test.js` and the `selfheal` scene.
