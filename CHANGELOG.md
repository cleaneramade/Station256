# Changelog

## 1.4.0

### Added

- **Tabs side by side.** Drag a tab onto the left or right half of the page and let go. The two tabs share the page, split by a divider you can drag (double-click it for half and half). You can also right-click a tab and choose Show on the Left or Show on the Right. It works for terminals, web pages, documents, videos and songs, even across windows. Click a half to make it the front tab. Separate gives you two tabs again. Closing one half leaves the other alone. The pair survives Ctrl+R.
- **Two Files tabs can sit side by side.** Each half has its own list, folder and picks. The toolbar, address bar, search box and keys work on the half you clicked last, which has a blue line on top. Drag files from one half onto the other to move them (hold Ctrl to copy).
- **Windows side by side.** With more than one window open, the tab menu has Arrange Windows Side by Side. The windows take halves, a half and two quarters, or quarters.
- **A glowing control overlay in the AI browser.** While an AI works in a browser tab, the page has a soft orange glowing edge and a pill at the top that says the AI is working there, with a Stop button. The tab shows a pulsing orange dot.
- **A better tool for the AI browser.** `station-browser` can now take a compact snapshot of a page with short refs (`@e1`, `@e2`, and so on), and fill, select, tick, hover, double-click, press key combos, scroll to, find, get and wait. The same walls as before apply: no page JavaScript, cookies, uploads or other tabs, and passwords and cards are still refused. Ideas from [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) (Apache-2.0). The code is new.
- **Websites in dark mode.** A moon button in each browser tab's bar switches between Websites: Light and Websites: Dark. It is off by default. It reaches every browser page in every window, including an AI's tab, and nothing else in Station.
- **Rooms can use your graphics card.** If the PC has one, a room now gets the graphics device and the Windows driver libraries (read-only). Local AI models need this. No extra toolkit is needed.
- **Your own skills and helper agents in every room.** Rooms now get the skills and helper agents you keep in your house's `~/.claude` folder, and the ones from your Windows `.claude` folder are copied in too (newer files only, nothing deleted). They are there every time a room starts, and the room's AI is told about them.
- **Each folder remembers its own view and sort,** like File Explorer. Changing the view in Videos no longer changes Documents. Each half of a split keeps its own. Pictures and Videos start as large icons.

### Changed

- **A calmer tab strip.** The open tab keeps its icon and its X. The other tabs shrink to small icons, so 20 tabs fit without scrolling. Past that, the strip scrolls with a soft fade at the cut edge, and the mouse wheel scrolls it sideways. The + button is always in view.
- **Room tabs show just the project name,** and Name (2) for the next one.
- **Closing a room only closes its own terminals and tabs.** No other tab moves.
- **A dragged tab stays a small tab** while it is over a Station window, so the half it will land on stays visible. Outside every window it grows into a window-shaped card with a picture of the page.
- **Hover text only where it helps.** Text that fits never gets a tip. Icon-only controls show their whole tip. Text that is cut off (tab titles, sidebar names) shows its full text. Icon-only tabs show their name. Home cards show nothing.
- **Clipboard no longer cares about the lock.** Copy and paste always cross between Linux and Windows. The lock keeps its real job: the C: drive view, `/windows` in rooms and dragging files in.
- **Locking Windows files no longer closes rooms.** Rooms keep running and their terminals stay open. If a program in a room is using a file in `/windows`, the lock stays open, the room is named, and nothing is killed.
- **One Chrome identity in the Web Browser.** Every browser page now sends the same Chrome-on-Linux identity (user agent, client hints and `window.chrome`), so it looks like one ordinary browser to sites. This is meant to help sign-ins such as Google's that refuse embedded browsers.
- **An AI's browser tab opens in the background,** and each AI session gets its own tab. It no longer switches your tab or takes the keyboard. While an AI works in its half of a pair, it cannot take the front tab or the keyboard from you.
- **An AI's browser tab now survives Ctrl+R** and page updates. A tab you took back with Stop comes back as yours.
- The AI browser no longer lets a scroll box or clickable wrapper hide the links and buttons inside it. Boxes hidden behind a styled label can be ticked through the label. A click with a pop-up on top is refused instead of pressing the pop-up. Stop is final: it also cuts a wait or click that is under way.
- Station's mouse pointer matches your Windows pointer scheme. The pointer files are Microsoft's, so they are copied on your PC and never shipped.

### Fixed

- Files copied in File Explorer on C: now paste while the lock is on. They come in through the Windows helper.
- The L: drive is mapped again when it shows Unavailable after WSL restarts. Starting or raising Station 256 checks it. A letter that points somewhere else is left alone.
- Tabs never show sliced while you drag them.
- The browser's debugger is taken back if it is let go.

## 1.3.1

### Fixed

- A first install that stopped in its last step now carries on when you run the command again. Before, it could be mistaken for a finished install.
- The House Rules page no longer shows an error when the app's pages are newer than the running app.

## 1.3.0

### Added

- **Run the install command again to update.** The installer now looks for a Station 256 that is already on the PC before it does anything else. If it finds one, it skips the questions and the setup steps and only updates the app's own files. Your projects, settings, rooms, drive and shortcuts are left as they are, and the sleep timer keeps its setting.
- If you already have the newest version, it says so and changes nothing.
- A copy that is tracked with git (a developer copy) is never overwritten.
- Rooms from before AI tools could be chosen keep all three tools after an update.

### Changed

- A simpler README, and fewer files in the repository: planning notes and the maker's own test tools are no longer published.

## 1.2.0

### Changed

- **You choose your AI.** The installer no longer installs Claude Code, and the room blueprint no longer bakes in Claude, Codex and Gemini. Open House Rules > Your AI tools, tick the ones you use, and only those are set up (`room ai set claude,codex`, then `room build`). You sign in to each yourself.
- **No model download.** The installer no longer fetches llama.cpp or a model. Local AI is yours to set up: bring your own `.gguf` file. `system/install-llama.sh` now fetches only the program (`LLAMA_MODEL=starter` adds one small example model).
- **One restart, then it finishes by itself.** When Windows needs a restart to turn on WSL, the installer offers to do it, and carries on by itself when you sign back in. No second command, no repeated questions. The Linux password is kept only as a copy Windows protects for your account, and deleted once the Linux user is made.
- **Honest disk wording.** The house disk size is whatever you enter, not a fixed 250 GB cap.
- **A new README** with a tour of every capability in pictures, and a screenshot gallery that can be remade with `panel/test/shotrun.sh gallery`.
- **Lock and screenshots.** With the Windows lock on, nothing crosses between Linux and Windows either way, except a screenshot of Station 256 pasted into Station 256. Station shows a notice when something is stopped.
- **Browser.** Bookmarks, history, a new-tab button and Ctrl+T, a start page with bookmarks and recent pages, and a bigger bar.
- **Project cards** show only Enter / Open Room. Everything else is in the right-click menu.

## 1.1.0

The second public version of Station 256.

### Added

- Right-click menus almost everywhere: files, Home, tabs, the sidebar, text boxes, terminals, Local AI and web pages. Cut, Copy, Paste and Select All always come first. A file's menu starts with Open.
- Preview: one click in the top bar (or a project's menu) opens a project's page. Plain websites in `public/`, `site/`, `dist/`, `build/`, `docs/` or `www/` now start too.
- Local AI: run small AI models on your own PC with llama.cpp (`system/install-llama.sh`). Load and Unload buttons, and closing the tab frees the memory. Tested with real models of 1 to 5 GB.
- The AI browser: a project's AI can use Station's Web Browser through the `station-browser` room tool. Its tab says "Claude is using this page" and has a Stop button. Home-network addresses stay blocked.
- Built-in viewers: PDFs and Word (.docx) files show right in Station's preview, no other app needed. (PDFs inside web pages in the Web Browser do not show yet.)
- The Web Browser's new tab is a real home page: a search box and tiles for the sites you visit most. The list stays on your PC; the AI's pages and project previews are not counted, and each tile has an x to remove it.
- Search: a new "Words inside files" choice finds text files by what they say, not only by their name.
- Videos: a Sound on/off button (save a copy with no sound), trim handles that snap to the play head, and phone (portrait) videos stay upright. Video pictures in folders show a real frame instead of a black square.
- Documents: Insert table. Files with very long lines now open.
- The Up arrow takes you from an open file back to its folder.
- Open in Web Browser for .html files.
- Optional Wayland mode (`HOUSE_OZONE=wayland`, or `wayland` in `~/.config/house/ozone`): smooth touchpad scrolling that follows your fingers, and pages stop cleanly at the top and bottom.

### Changed

- Home refreshes by itself and shows today's tokens. "See all projects" lists every project.
- Home token tiles are simpler.
- The close animation is gone: windows and tabs close instantly.
- Hover text now appears only where it helps.
- The Web Browser searches with DuckDuckGo.
- Buttons that cannot be used yet look greyed out.
- Many layout fixes, so things fit in small windows and at 120% zoom.

### Fixed

- Opening a Windows text file no longer changes its line endings.
- Touchpad pinch now behaves correctly.

### Notes

- There is still no one-click installer. To set it up, follow `docs/02-rebuild-step-by-step.md`.

