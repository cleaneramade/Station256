# Changelog

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

