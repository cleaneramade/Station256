# Station 256 installer

Sets up Station 256 on a Windows PC from one command. Run it in PowerShell
(as administrator the first time, because turning on WSL needs it):

```powershell
irm https://raw.githubusercontent.com/<owner>/<repo>/main/installer/get.ps1 | iex
```

## What happens when you install

1. It downloads the newest release and unpacks it in `%LOCALAPPDATA%\Station256-setup` (kept there so a restart cannot lose it).
2. It looks at your PC (Windows version, virtualisation, memory, disk space).
3. It asks **three things, and nothing else**:
   - how much storage to allow (a limit, not a reservation);
   - a drive letter, only if `L:` is already taken (otherwise the house uses `L:`);
   - a password for the Linux side, typed twice and hidden. It is never saved as text. If Windows needs a restart, a copy only your Windows account can open is kept until the Linux user is made, then deleted.
4. It shows a summary and asks `Go ahead? (Y/n)`.
5. It turns on WSL if needed. Windows then needs **one** restart. The installer offers to do it, and when you sign back in, setup carries on by itself and finishes. You do not run anything again and are not asked anything again. (If WSL is already on, there is no restart at all.)
6. It installs its **own Linux, named `Station256`**. A Linux you already have
   (such as `Ubuntu`) is never touched.
7. Inside that Linux it makes your user, installs Docker Engine, Node and git,
   copies in Station 256, installs the walls and the sleep timer, and builds the
   room image. **It installs no AI tool and downloads no model.**
8. On Windows it maps the drive, adds a Desktop and a Start menu shortcut
   called "Station 256", a right-click "Open Linux terminal here" on that drive
   only, and a step that puts the house to sleep when you log in.
9. It checks everything and tells you what is left for you, if anything.

Click **Station 256** in Windows. It opens empty, with no sample data. Open **House Rules** and tick the AI tools you use (Claude Code, Codex, Gemini). Only those are set up in your rooms, and you sign in to each yourself.

The defaults it never asks about: the Linux user name is your Windows name,
lowercased (or `station` if that is not a valid Linux name); the house sleeps
after 10 minutes of no use.

## Remove it

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\LinuxHouse\installer\uninstall.ps1"
```

It removes only what the installer made: the `Station256` Linux, the drive, the
shortcuts, the login step and the right-click menu, and it puts your old
`.wslconfig` back if one was saved. **Deleting the Linux deletes every file
inside it**, so it asks first. It never touches any other Linux. Add `-DryRun`
to see what it would do.

## Try it without changing anything

```powershell
install.ps1 -CheckOnly   # look at the PC, say if it can run it
install.ps1 -AskOnly     # just the questions; saves nothing
install.ps1 -DryRun      # the whole run, printing what it WOULD do
uninstall.ps1 -DryRun    # what removing would do
```

To test the one-line command from a local copy of the source instead of GitHub:

```powershell
get.ps1 -Source C:\path\to\house -DryRun
```

## Switches

| Switch | Does |
|---|---|
| `-DistroName <name>` | name of the Linux to make (default `Station256`) |
| `-Yes` | skip the final "Go ahead?" |
| `-Fresh` | forget saved progress and start over |
| `-CheckOnly`, `-AskOnly`, `-DryRun` | the safe modes above |

`get.ps1` also takes `-Source <folder>`, `-Repo` and `-Version`. The repo is
named in one place, the `$Repo` line at the top of `get.ps1`.

## Running it twice

Every step checks whether its work is done and skips if so. Progress is saved
in `%LOCALAPPDATA%\LinuxHouse\install-state.json` (never the password), so a
stopped install carries on when you run the same command again. A try-out
(`-DryRun`, `-AskOnly`) saves nothing.

## Files

```
installer/
  get.ps1         one-line entry point: downloads the source zip, runs install.ps1
  install.ps1     the engine: asks, runs the nine steps, checks
  uninstall.ps1   removes what the installer made
  make-release.ps1  old: builds a payload zip. Not needed any more
  lib/            ui, prompts, state, wsl, checks, phases, selftest
```

The installer works straight from the unpacked source. It copies the folder
above `installer/` into the new Linux, and `windows/` to the helper folder.

## Before changing anything in here

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File lib\selftest.ps1
```

Two rules the selftest enforces: no `$script:` variable in `lib/` may share a
name with an `install.ps1` parameter (that once made a dry run do real work),
and native programs go through `Invoke-Native` (a program writing to stderr
would otherwise throw). A real install on a clean PC has not been tested.
