# Installer plan

**Status: built as of 2026-11-06.** This file is the design. For what actually
works and what does not, read the notes in `../installer/README.md`.

Short version: the question flow, all nine install steps, resume-after-restart,
the dry run and a 47-check selftest are done and tested on one machine. The two
steps that install WSL and create the Linux user have only ever been dry-run,
because the development PC already has the house, so there was no clean machine to test a
clean install on. GitHub hosting and an uninstall command are not done.

## The goal

A Windows user runs **one command**. A terminal walks them through setup, asking
plain questions, checking each answer, and re-asking if the answer will not work.
At the end they have a working Linux House with Station 256 on their desktop.

## How it gets delivered

Two front doors, one engine.

### Door 1 — PowerShell one-liner (the main one)

```powershell
irm https://station256.dev/get | iex
```

Classic for Windows tools, no prerequisites. This is the primary route, because
the install has to work on a machine with **no Node.js** — Node lives inside the
house, which does not exist yet.

### Door 2 — npm, for people who already have Node

```bash
npx station256
```

A thin wrapper that downloads and runs the same PowerShell engine. It must not
reimplement anything.

> **Decision needed from the user:** whether to do Door 2 at all. It adds a
> second thing to maintain for an audience that could just as easily paste the
> one-liner.

## Rules the installer must follow

1. **PowerShell 5.1 compatible.** No `&&`, no `||`, no ternary, no `??`, no `?.`.
   Windows 11 ships 5.1 as `powershell.exe` and most users will be on it.
2. **Never require a compiled `.exe`.** An antivirus deleted an unsigned C# launcher
   during this build. Scripts and `.lnk` shortcuts only.
3. **Re-runnable.** Running it twice must not break anything. Every step checks
   whether it is already done.
4. **Resumable.** WSL install and the Docker group change both need a
   reboot/re-login. State is saved so the user can run it again and carry on.
5. **Never touch anything it did not create.** Especially: do not set the
   machine-wide `RestoreConnection` value, and do not go near other mapped drives.
6. **Say what it is about to do before each admin action.**
7. **No secrets written to disk.** The one exception is the Linux password during the
   single restart: it is kept only as a Windows-protected copy (DPAPI, this user only)
   and deleted as soon as the Linux user is made.
8. **Installs no AI.** Which AI tools a person uses is their choice, made inside
   Station 256 (House Rules > Your AI tools). Nothing is signed in by the installer.

## The question flow

Questions in order, with how each answer is checked.

| # | Question | Default | Check | If the check fails |
|---|---|---|---|---|
| 1 | Install the Linux House? Shows what it will do. | yes | — | exit cleanly |
| 2 | **Drive letter for the house** | `L` | not in use, not mapped, is A-Z | explain which drive is using it, ask again |
| 3 | Name for the Linux user | Windows username, lowercased | lowercase letters, numbers, `-`, `_`; starts with a letter | ask again |
| 4 | Password for that user (twice, hidden) | — | both match, at least 8 characters | ask again |
| 5 | How much disk for the house, in GB | 250 | 20 to (free space minus 50 GB) | show the real free space, ask again |
| 6 | Idle minutes before the house sleeps | 10 | 1 to 240, or `0` for never | ask again |
| 7 | Desktop shortcut? Start menu shortcut? | both yes | — | — |
| 8 | Right-click "Open Linux terminal here" on the house drive? | yes | — | — |
| 9 | Sleep the house at login? | yes | — | — |
| 10 | Review screen: every answer listed. Proceed? | — | — | back to question 1 |

### The drive-letter prompt — the pattern for all of them

This is the shape the user asked for. Everything else follows it.

```powershell
function Read-DriveLetter {
    param([string]$Default = 'L')

    while ($true) {
        $answer = Read-Host "Drive letter for the house [$Default]"
        if ([string]::IsNullOrWhiteSpace($answer)) { $answer = $Default }

        $letter = $answer.Trim().TrimEnd(':').ToUpper()

        if ($letter -notmatch '^[A-Z]$') {
            Write-Host "  That is not a drive letter. Use a single letter, A to Z." -ForegroundColor Yellow
            continue
        }

        # Reserved by Windows for floppy drives. Explorer treats them oddly.
        if ($letter -in @('A','B')) {
            Write-Host "  $letter`: is reserved by Windows. Pick another letter." -ForegroundColor Yellow
            continue
        }

        # Already a real drive?
        if (Test-Path "$letter`:\") {
            $vol = Get-Volume -DriveLetter $letter -ErrorAction SilentlyContinue
            $label = if ($vol -and $vol.FileSystemLabel) { " ($($vol.FileSystemLabel))" } else { "" }
            Write-Host "  $letter`: is already in use$label. Pick another letter." -ForegroundColor Yellow
            continue
        }

        # Already a network mapping, even a disconnected one?
        if (Test-Path "HKCU:\Network\$letter") {
            $remote = (Get-ItemProperty "HKCU:\Network\$letter").RemotePath
            Write-Host "  $letter`: is already mapped to $remote. Pick another letter." -ForegroundColor Yellow
            continue
        }

        Write-Host "  $letter`: is free. The house will live there." -ForegroundColor Green
        return $letter
    }
}
```

Three separate checks, because a letter can be taken in three different ways and
only one of them shows up in Explorer.

## What the installer does, step by step

Maps directly onto `02-rebuild-step-by-step.md`.

| Phase | Steps | Needs admin | Needs a restart |
|---|---|---|---|
| **0. Check** | Windows build, virtualisation on, free disk, admin rights, PowerShell version | no | — |
| **1. Ask** | the whole question flow, then the review screen | no | — |
| **2. WSL** | `wsl --install`, `wsl --update`, `wsl --install -d Ubuntu` | yes | often |
| **3. Config** | write `.wslconfig`, `/etc/wsl.conf`, `wsl --shutdown` | yes | no |
| **4. House** | Docker Engine, packages (Node, git), folders | no (sudo inside) | no — see note below |
| **5. Code** | fetch the release, `npm install`, `chmod +x`, symlink `room` | no | no |
| **6. System** | install scripts, sudoers, services, enable them | sudo once | no |
| **7. Rooms** | `room build`, which is slow (apt inside the image) | no | no |
| **8. Windows** | map the drive, copy `LinuxHouse\*`, registry, shortcuts | no (HKCU only) | no |
| **9. Verify** | run the health check from `05-tests.md` | no | no |
| **10. Finish** | print what was installed, offer to launch, say where to choose AI tools | no | no |

### Interruptions, and which ones are real

Only **one** pause is unavoidable, and the installer handles it:

1. **A Windows restart after phase 2.** `wsl --install` enables a virtualisation
   feature and Windows needs the reboot. The installer saves the answers, registers a
   one-time carry-on (HKCU RunOnce), offers to restart, and when you sign back in it
   finishes by itself with no second command and no repeated questions. On a machine
   where WSL is already installed this pause disappears completely.

Two that look like pauses but are not:

- **Ubuntu's first-run "pick a username and password" prompt.** Avoid it with
  `wsl --install -d Ubuntu --no-launch`, then create the user as root with
  `wsl -d Ubuntu -u root`. The installer already asked for the name and
  password in the question flow, so there is nothing left to prompt for.
- **The docker group re-login.** The manual steps in
  `02-rebuild-step-by-step.md` say to log out and back in. The installer does
  not need to: `wsl --terminate Ubuntu` and starting the distro again gives a
  fresh login shell with the new group membership. No Windows logout.

So the target is: **one command, run twice, roughly 20-30 minutes**, most of it
waiting on downloads (WSL image, apt, `npm install`, and the room blueprint
build, which is the slowest single step).

## Handling the reboot

Phase 2 is the only phase that sends the user away and back.

- State goes to `%LOCALAPPDATA%\LinuxHouse\install-state.json` — answers given,
  phases completed.
- On exit it prints exactly what to do: restart, then run the same command again.
- On start it reads the state, skips what is done, and does **not** re-ask
  anything.
- **Do not** add a RunOnce entry to resume automatically. The user would get a
  terminal in their face at logon with no idea why.

## What it must verify at the end

Fail loudly, with the fix, on any of these:

```
[ok] WSL 3.0.3 with WSLg
[ok] Ubuntu 26.04 running
[ok] Docker Engine 29.9.3 active
[ok] house-firewall active, walls verified
[ok] house-keeper active
[ok] /mnt/c absent (Windows door closed)
[ok] house-rooms network present
[ok] room blueprint built
[ok] L: mapped and persistent
[ok] Station 256 shortcut on Desktop and Start menu
```

That last line is a to-do, not a failure. The login is interactive and cannot be
scripted.

## Open questions for the user

1. **Hosting.** The one-liner needs a URL. A GitHub release is the obvious free
   answer and gets the off-machine backup done at the same time.
2. **Public or private?** A public repo means the Segoe UI fonts can never go
   in, which is already handled (Selawik plus Fluent icons). Worth confirming.
3. **Door 2 (npm) — worth it, or just the PowerShell one-liner?**
4. **Updates.** A `station256 update` command that pulls a new release and
   re-runs only phases 5-8? Or leave updates manual for v1?
5. **Name.** Is "Station 256" the public name, or just this user's install?

## Build order, when it starts

1. The question flow on its own, with every check, printing the answers and
   doing nothing. Fast to test, and it is the part the user described.
2. Phase 0 checks.
3. Phases 8 and 9 (Windows side plus verify) — safe to run repeatedly against
   the house that already exists.
4. Phases 5, 6, 7 against a throwaway Ubuntu distro.
5. Phases 2, 3, 4 last. They are the destructive ones and need a clean VM to
   test honestly.
6. The npm wrapper, if it is wanted.

## Choosing your AI tools

The installer does not install or sign in to any AI. When Station 256 first opens, House
Rules > Your AI tools lets each person tick the ones they use (Claude Code, Codex,
Gemini). Only those go into the room blueprint (`room ai set`, `room build`). Signing in is
done by the person, in the tool itself (Claude users run `room login`).
