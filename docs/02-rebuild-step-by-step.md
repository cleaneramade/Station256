# Rebuild, start to finish

Every step as it was actually done. Commands marked **(Windows)** run in
PowerShell on Windows. Commands marked **(house)** run in the Ubuntu terminal.

Replace `your-user` with the real username and `L:` with the chosen drive letter.

---

## Step 1 — Install WSL and Ubuntu  (Windows, admin)

```powershell
wsl --install --no-distribution
wsl --update
wsl --install -d Ubuntu
```

Reboot if asked. Ubuntu's first run asks for a username and password — this
becomes the house user. Then:

```powershell
wsl --version          # expect WSL 3.0.3+ and a WSLg line
wsl --list --verbose   # expect Ubuntu, Running, 2
```

If `wsl --version` shows no WSLg line, the panel cannot draw and the rest is
pointless. Fix that first.

---

## Step 2 — Cap the house  (Windows)

Create `C:\Users\your-user\.wslconfig`:

```ini
[general]
# Windows must not put the house to sleep. The house keeper inside Ubuntu decides.
instanceIdleTimeout=-1
```

Copy in this repo: `windows/wslconfig.txt`.

`instanceIdleTimeout=-1` is deliberate. Windows' own idle timer would stop the
house under the keeper's feet. Sleep is handled inside the house instead
(step 7) so it can tell the difference between "idle" and "a job is running".

The disk size you choose is not a partition — it is the size of the virtual disk
(a limit it can grow to, not space reserved up front). `df -h /` reports a little
less than the size you chose. It is resized by the Windows helper (`house-helper.ps1`), never by hand.

---

## Step 3 — Lock the Windows door  (house)

Write `/etc/wsl.conf`:

```ini
[boot]
systemd=true

[user]
default=your-user

[automount]
enabled=false
mountFsTab=false

[interop]
enabled=false
appendWindowsPath=false
```

Copy in this repo: `house/system/wsl.conf`.

Then run `wsl --shutdown` from Windows and reopen Ubuntu.

What each part does:

- `systemd=true` — needed for the firewall and keeper services.
- `automount` off — `/mnt/c` no longer exists.
- `interop` off — Linux cannot launch Windows programs, and the Windows PATH
  does not leak in.

**Check it worked (house):**

```bash
ls /mnt/c            # should not exist
sudo -n true         # should refuse: password required
```

---

## Step 4 — Docker Engine inside Ubuntu  (house)

Docker **Engine** from apt, not Docker Desktop. This was the user's decision —
Desktop would put the daemon back on the Windows side.

```bash
sudo apt update && sudo apt install -y ca-certificates curl gnupg iptables
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker your-user
sudo systemctl enable --now docker
```

Log out and back in for the group to apply, then `docker run --rm hello-world`.

> **Note:** being in the `docker` group is root-equivalent with no password.
> That is why AI is only ever run inside a room, never in the house directly.

---

## Step 5 — Other packages  (house)

```bash
sudo apt install -y git nodejs npm python3 python3-pip fontconfig
sudo apt install -y --no-install-recommends ffmpeg poppler-utils   # file pictures, video and PDF tools in Station 256
curl -fsSL https://claude.ai/install.sh | bash     # lands in ~/.local/bin
mkdir -p ~/projects ~/.config/house ~/.local/state/house ~/.local/bin
```

---

## Step 6 — Restore the code  (house)

From the `restore/` folder in this backup. Because the Windows door is closed,
copy the file in through the UNC path from Windows first, or open the door
temporarily.

```bash
cd ~
git clone -b main /path/to/restore/house-git.bundle house
```

**Pass `-b main`.** Several branches can point at the same commit, so a plain
`git clone` may land on a session branch instead of `main`.

Or, for the working tree with Linux file permissions already correct:

```bash
mkdir ~/house && tar xzf /path/to/restore/house-files.tar.gz -C ~/house
```

Then:

```bash
cd ~/house/panel && npm install          # pulls Electron 45.2.2, xterm, node-pty
chmod +x ~/house/*.sh ~/house/bin/room ~/house/panel/*.sh ~/house/panel/test/*.sh
ln -sf ~/house/bin/room ~/.local/bin/room
```

The video editor (`~/house/editor`, made from OpenCut) is a built web app in
`editor/out`, which isn't in git. Build it with Bun (about 1.6 GB of packages,
a few minutes):

```bash
npm install --prefix ~/.local/share/bun-npm bun@1.2.18
BUN=~/.local/share/bun-npm/node_modules/.bin/bun
cd ~/house/editor && $BUN install --frozen-lockfile && $BUN run build
```

Until it's built, the Editor button says the editor isn't set up yet.

> **Trap:** copying these files over `\\wsl.localhost` **drops the execute bit**.
> Always `chmod +x` after any edit made from the Windows side.

---

## Step 7 — Install the system files  (house)

The repo holds the sources. These commands put them where the system reads them.

```bash
cd ~/house

# Admin helper the panel is allowed to call, plus the two service scripts
sudo install -m 755 house-rules.sh      /usr/local/sbin/house-rules
sudo install -m 755 house-firewall.sh   /usr/local/sbin/house-firewall
sudo install -m 755 house-keeper.sh     /usr/local/sbin/house-keeper

# Let the panel call that one helper without a password, and nothing else
sudo install -m 440 system/sudoers-house-rules /etc/sudoers.d/house-rules
sudo visudo -c                      # must say "parsed OK"

# Services
sudo install -m 644 house-firewall.service /etc/systemd/system/
sudo install -m 644 house-keeper.service   /etc/systemd/system/
sudo install -m 644 system/house-keeper.default /etc/default/house-keeper
sudo systemctl daemon-reload
sudo systemctl enable --now house-firewall house-keeper

# House rules apply to Claude inside the house too, not just in rooms
sudo mkdir -p /etc/claude-code
sudo ln -sf /home/your-user/.config/house/claude-managed.json /etc/claude-code/managed-settings.json
```

**Whenever `house-keeper.sh` changes** (it did on 2026-11-10, so the Schedules
runner waiting doesn't keep the house awake), install it again and restart it.
Merging the code doesn't do this:

```bash
sudo install -m 755 ~/house/house-keeper.sh /usr/local/sbin/house-keeper && sudo systemctl restart house-keeper
```

The sudoers file is a single line, and nothing more:

```
your-user ALL=(root) NOPASSWD: /usr/local/sbin/house-rules
```

`house-rules` only accepts three fixed words — `door-open`, `door-close`,
`firewall-check` — so the panel can never pass a free-form command through it.

Starting rules — copy from `restore/config-samples/`:

`~/.config/house/rules.json`

```json
{
  "projectDoor": "block",
  "web": "ask",
  "github": "ask",
  "installs": "allow",
  "deletes": "ask",
  "secrets": "ask"
}
```

`~/.config/house/claude-managed.json` is the generated Claude permission file.
Do not hand-edit it; `panel/lib/rules.js` writes it from `rules.json`.

**Check (house):**

```bash
systemctl is-active docker house-firewall house-keeper   # three x active
sudo /usr/local/sbin/house-rules firewall-check && echo WALLS_OK
```

---

## Step 8 — Build the room blueprint  (house)

```bash
room build
room new testbed
room list
room ai set claude  # choose your AI tools (any of claude, codex, gemini), then: room build
room login          # only if you chose Claude: one-time login shared by all rooms
room close testbed
```

The blueprint is `~/house/room/Dockerfile` — Ubuntu 26.04, a `dev` user at
uid 1000 (so files stay owned by you), **no sudo installed**, no docker socket,
and only the one project folder mounted.

Commands: `room new|open|close|list|status|login|build`.

---

## Step 9 — The L: drive  (Windows)

```powershell
net use L: \\wsl.localhost\Ubuntu /persistent:yes
```

This is what keeps L: visible in Explorer even while the house sleeps. Clicking
it wakes the house in about 1.5 seconds.

- Do **not** set the machine-wide `RestoreConnection` value. It would change
  every other mapped drive.
- `DeferFlags=1` on `HKCU\Network\L` was tried and **did not work** — the WSL
  engine still came up 17 seconds after boot. It was removed again.

---

## Step 10 — The Windows half  (Windows)

Copy `windows/LinuxHouse/*` from this backup into `%LOCALAPPDATA%\LinuxHouse\`.

| File | Job |
|---|---|
| `open-panel.ps1` | the shortcut target: starts the helper, then the panel; restores the window if it is already running |
| `house-helper.ps1` | keeps the PC awake while rooms are up, resizes storage, compiles and hosts `snap-link.cs`, drives snapping |
| `snap-link.cs` | C# window-tracking code, compiled **in memory** by the helper (never shipped as an .exe — see the antivirus note in `01-requirements.md`) |
| `open-here.ps1` | right-click "Open Linux terminal here" |
| `sleep-at-login.ps1` | one run at logon: sleeps the house unless it is in use |
| `station-keys.ps1` | runs from logon: Alt+L opens Station 256, or another window of it |
| `station-256-app.ico` | app icon |

Then import the registry file:

```powershell
reg import "<backup>\windows\registry\station-256-hkcu.reg"
```

Edit the paths and drive letter in that file first if the username or letter
differs. It sets up the logon sleep entry, the Alt+L listener, the right-click menu (limited to L:
by `AppliesTo`), and a record of the L: mapping.

Finally the shortcuts, on both Desktop and Start menu:

- **Target:** `C:\Windows\System32\conhost.exe`
- **Arguments:** `--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\your-user\AppData\Local\LinuxHouse\open-panel.ps1"`
- **Icon:** `...\LinuxHouse\station-256-app.ico,0`
- **Working folder:** `C:\Users\your-user`

`conhost.exe --headless` is there to stop a black console window flashing on
launch.

---

## Step 11 — Prove it  (house)

```bash
cd ~/house
./safety-test.sh        # break-out and failure cases
./room-test.sh          # rooms
./rules-test.sh         # Allow / Ask / Block
./web-rule-test.sh      # the internet rule
panel/test/zoomwalk.sh  # real windows, every size and zoom
```

See `05-tests.md` for the rules these tests must follow — several of them exist
because a test once damaged something.

---

## Step 12 — First launch

Click **Station 256**. Expect:

- a frameless window matching Windows 11 File Explorer (light theme)
- footer zoom reading 100%, which is `BASE_ZOOM` 1.35 internally (the Windows
  display here is 125% and WSLg draws 1:1)
- the lock icon top-right showing the Windows door closed
- tabs that open inside the app; with two or more open, any tab can move to a
  window of its own (a full Station 256 window), and tabs drag between windows

Window size and zoom are remembered in `~/.config/house/panel.json`.

---

## Rebuild order summary

| # | Step | Side | Can it be scripted? |
|---|---|---|---|
| 1 | WSL + Ubuntu | Windows | yes, but needs a reboot and a first-run prompt |
| 2 | `.wslconfig` | Windows | yes |
| 3 | `/etc/wsl.conf` | house | yes, needs `wsl --shutdown` after |
| 4 | Docker Engine | house | yes, needs re-login for the group |
| 5 | packages | house | yes |
| 6 | restore code | house | yes |
| 7 | system files | house | yes, needs the sudo password once |
| 8 | room blueprint | house | yes, slow (apt inside the image) |
| 9 | drive mapping | Windows | yes — this is where the installer asks for a letter |
| 10 | Windows half | Windows | yes |
| 11 | tests | house | yes |
| 12 | first launch | Windows | user clicks |

Steps 2-11 are all scriptable. That is the basis of the installer plan in
`06-installer-plan.md`.
