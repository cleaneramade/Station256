# What Station 256 is

## The short version

**The House** is a separate Ubuntu computer running inside Windows (WSL2). All
development work and project files live in there, not on the Windows side.

**Rooms** are one-per-project Docker containers. You start a room when you work
on that project, and it folds away when you're done. An AI agent only ever runs
inside a room, never in the house itself.

**Station 256** is the app that controls all of it. It's a Linux desktop app
(Electron) drawn on the Windows desktop through WSLg, built to look and move
exactly like Windows 11 File Explorer.

## Why it exists

To keep the PC clean and to give AI agents a place to work where they cannot
reach the user's Windows files, personal data, or the rest of the network.

## The three walls

1. **The Windows door** — Ubuntu is configured so a normal user cannot see or
   mount the Windows drives. Blocked by default.
2. **The project door** — a room only ever has its own project folder mounted.
   It cannot see other projects.
3. **The network** — rooms sit on their own Docker network (`house-rooms`,
   `172.30.0.0/24`). Internet works. Windows, the LAN, the house itself and
   other rooms are all firewalled off.

The honest limit: inside the house, `root` can still mount `C:`, and anyone in
the `docker` group is effectively root without a password. So the walls are real
for **anything running in a room**, which is where AI runs. They are not a hard
wall against something running directly in the house with docker access. This was
a known, accepted decision.

## Named parts

| Name | What it is | Where |
|---|---|---|
| The house | WSL2 Ubuntu 26.04 | distro `Ubuntu`, home `/home/your-user` |
| Drive L: | Explorer shortcut to the house | `\wsl.localhost\Ubuntu` |
| Station 256 | the control panel app | `~/house/panel` |
| `room` | command to create/open/close rooms | `~/house/bin/room` |
| The keeper | puts the house to sleep when idle | `house-keeper.service` |
| The firewall | room network rules | `house-firewall.service` |
| House rules | Allow / Ask / Block switches | `~/.config/house/rules.json` |
| The helper | Windows-side partner process | `%LOCALAPPDATA%\LinuxHouse\house-helper.ps1` |
| The link | how the two halves talk | TCP `127.0.0.1:47256` |

## Where the project stands

The **foundation is closed** (user's decision, 2026-11-05). The project is now in
a micro-fixing phase. What works: house, rooms, firewall, rules, sleep, the panel
shell, window motion, and snapping with Windows in both directions.

Not built yet: the full Allow/Ask/Block rules screen in the app, GitHub
connection, and the Windows-native version of the explorer (a months-out goal).
