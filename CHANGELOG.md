# Changelog

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

