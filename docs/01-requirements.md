# Requirements

## The machine

What it was built and tested on, and the realistic minimum:

| | Built and tested on | Realistic minimum |
|---|---|---|
| OS | Windows 11 | Windows 11, or Windows 10 build 19045+ |
| RAM | 16 GB | 8 GB (16 GB comfortable — the house idles at ~500-630 MB) |
| Free disk | plenty | ~30 GB free, more for real projects |
| CPU | virtualisation enabled in BIOS | required, WSL2 will not run without it |
| GPU | integrated and discrete | any — Station draws its pages on the processor; only the video editor's canvases use the graphics card (d3d12) |

Admin rights are needed for the first install only (WSL feature + Ubuntu).

## Windows-side software

| Thing | Version here | Notes |
|---|---|---|
| WSL | 3.0.3.0 | `wsl --install` then `wsl --update` |
| WSL kernel | 6.18.54.1-1 | comes with WSL |
| WSLg | 1.0.79 | comes with WSL — needed to draw the Linux app on Windows |
| MSRDC | 1.2.7391 | comes with WSLg; this is the process that hosts the window |
| PowerShell | 5.1 (built in) | the helper and installer scripts are 5.1-safe |
| Windows Terminal | installed | the right-click menu opens `wt.exe -p Ubuntu` |

Optional, used during the build but not required to run:
- GitHub CLI (`C:\Program Files\GitHub CLI\gh.exe`), logged in to your GitHub account.
  Git itself is **not** installed on Windows — repos were read with `gh api`.

## Inside the house

| Thing | Version here | How it got there |
|---|---|---|
| Ubuntu | 26.04.1 LTS | `wsl --install -d Ubuntu` |
| Docker Engine | 29.9.3 | apt, from Docker's own repo — **not** Docker Desktop (user's decision) |
| containerd | 2.4.2 | comes with Docker |
| Node.js | 22.22.1 | apt (`nodejs`) |
| npm | 9.2.0 | apt |
| Electron | 45.2.2 | `npm install` in `~/house/panel` |
| Claude Code | 2.1.318 | installed to `~/.local/bin` |
| git | 2.53.0 | apt |
| iptables | 1.8.11 | apt — the room firewall uses it |
| fontconfig | 2.17.1 | apt — needed for crisp text in the panel |

User `your-user`, uid 1000, in groups: `your-user adm cdrom sudo dip plugdev users docker`.

## Things that are NOT in this backup and must not be

- **Claude login token** (`~/.config/house/claude-token`) — log in again instead.
- **Windows link secret** (`~/.local/state/house/link-token`) — generated on first run.
- **Microsoft font files** (`~/.local/share/fonts/windows-local`: Segoe UI, plus the
  terminal's Segoe UI Symbol and Emoji, YaHei, Yu Gothic, Malgun Gothic) — these
  are licensed with Windows and must never be copied or committed. The app falls
  back to bundled **Selawik** (open Segoe lookalike) and MIT-licensed **Fluent**
  icons, so a public release stays legal.

## Antivirus warning

Antivirus software can delete unsigned programs it has not seen before. An early
attempt at a small unsigned C# launcher `.exe` was **deleted by an antivirus product**
(a behaviour heuristic). It was the only detection in the whole
build.

**Rule that came out of it:** do not ship compiled local launcher executables, and
never add antivirus exclusions without asking the user. Everything uses PowerShell
scripts and `.lnk` shortcuts instead. The one C# file that remains
(`snap-link.cs`) is compiled *in memory* by `house-helper.ps1`, not shipped as an
`.exe`.
