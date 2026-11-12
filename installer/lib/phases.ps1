# phases.ps1 - the install itself, one function per step.
#
# Every phase is safe to run twice. Each one checks whether its work is already
# done and skips if so. Every phase honours -DryRun by printing what it would
# do and changing nothing.
# PowerShell 5.1 safe.

# These names are prefixed on purpose.
#
# An earlier version used $script:DryRun here. install.ps1 has a -DryRun
# PARAMETER, and dot-sourcing this file ran `$script:DryRun = $false` inside
# install.ps1's own scope, which wiped that parameter. The result was a dry run
# that silently did real work.
#
# Rule: no module-level variable in lib/ may share a name with a script
# parameter in install.ps1. lib/selftest.ps1 checks this.
$script:PhaseDryRun      = $false
$script:PhaseHouseSource   = ''
$script:PhaseWindowsSource = ''
$script:PhaseInstallerDir  = ''

# HouseSource is the folder holding panel/, bin/, system/ and the rest of the app.
# WindowsSource holds the Windows helper scripts. InstallerDir is installer/ itself.
function Set-PhaseContext {
    param([bool]$DryRun, [string]$HouseSource, [string]$WindowsSource, [string]$InstallerDir = '')
    $script:PhaseDryRun        = $DryRun
    $script:PhaseHouseSource   = $HouseSource
    $script:PhaseWindowsSource = $WindowsSource
    $script:PhaseInstallerDir  = $InstallerDir
}

function Test-DryRun { return $script:PhaseDryRun }

function Get-HouseSource   { return $script:PhaseHouseSource }
function Get-WindowsSource { return $script:PhaseWindowsSource }
function Get-InstallerDir  { return $script:PhaseInstallerDir }

# ===========================================================================
# PHASE 2 - WSL and the house's own Linux
# ===========================================================================

# Marker file the installer leaves inside its own distro. It is how we tell
# "a Linux we made" from "someone else's Linux that has the same name".
$script:HouseMarker = '/etc/station256-distro'

function Invoke-PhaseWsl {
    param([hashtable]$A)
    Write-Step "Step 1 of 9: Windows Subsystem for Linux"

    $name = Get-HouseDistro

    if (Test-DryRun) {
        Write-Would "run: wsl --install --no-distribution   (only if WSL is not on yet)"
        Write-Would "run: wsl --update   (skipped if another Linux is running, because it would stop it)"
        Write-Would ("run: wsl --install Ubuntu --name " + $name + " --no-launch   (its own Linux; no other Linux is touched)")
        Write-Would ("stop with a plain message if a Linux called '" + $name + "' already exists and was not made by this installer")
        Write-Would "ask you to restart Windows if Windows says it needs one"
        return @{ ok = $true; rebootNeeded = $false }
    }

    if ((Test-WslPresent) -and (Test-DistroExists)) {
        if (-not (Test-HousePath -Path $script:HouseMarker)) {
            throw ("A Linux called '" + $name + "' is already on this PC, and this installer did not make it. Nothing was changed. Run the installer again with -DistroName and a different name, for example: -DistroName " + $name + "2")
        }
        Write-Skip ("WSL and '" + $name + "' are already here.")
        return @{ ok = $true; rebootNeeded = $false }
    }

    if (-not (Test-WslPresent)) {
        Write-Info "Turning on the Windows feature. This can take a few minutes."
        $r = Invoke-Wsl -Arguments @('--install', '--no-distribution')
        foreach ($l in $r.output) { if ($l.Trim().Length -gt 0) { Write-Info $l.TrimEnd() } }

        if ((Test-PendingReboot) -or (-not (Test-WslPresent))) {
            Write-Line ''
            Write-Warn "Windows needs a restart before it can carry on."
            return @{ ok = $true; rebootNeeded = $true }
        }
    }

    # wsl --update restarts WSL, which would stop any other Linux that is running right now.
    if ((Get-OtherRunningCount) -gt 0) {
        Write-Warn "Another Linux is running, so 'wsl --update' is skipped (it would stop that Linux). Run it yourself when nothing is running if the next step fails."
    }
    else {
        Write-Info "Updating WSL..."
        $null = Invoke-Wsl -Arguments @('--update')
    }

    # Its own copy of Ubuntu under its own name, so an Ubuntu you already have is never touched.
    # --no-launch stops Ubuntu asking for a user name here. We already have it.
    Write-Info ("Downloading Ubuntu as '" + $name + "'. This is the big one.")
    $r = Invoke-Wsl -Arguments @('--install', 'Ubuntu', '--name', $name, '--no-launch')
    foreach ($l in $r.output) { if ($l.Trim().Length -gt 0) { Write-Info $l.TrimEnd() } }

    if (-not (Test-DistroExists)) {
        throw ("Windows could not set up a Linux called '" + $name + "'. Naming a Linux needs a recent WSL (2.4 or newer). Run 'wsl --update', then run this installer again. If it still fails, run this by hand to see the real error: wsl --install Ubuntu --name " + $name + " --no-launch")
    }

    # Mark it as ours. Without this the next run would think it is someone else's.
    Invoke-HouseScriptOrFail -Script ("echo made-by-station-256 > " + $script:HouseMarker) -AsUser 'root' -What "Marking the new Linux" -Quiet | Out-Null

    Write-Ok ("WSL and '" + $name + "' are installed.")
    return @{ ok = $true; rebootNeeded = $false }
}

# ===========================================================================
# PHASE 2b - the Linux user
# ===========================================================================
function Invoke-PhaseUser {
    param([hashtable]$A, [string]$Password)
    Write-Step "Step 2 of 9: your Linux user"

    $name = $A['linuxUser']

    if (Test-DryRun) {
        Write-Would ("create Linux user '" + $name + "' with a home folder and sudo rights")
        return
    }

    if (Test-HouseUserExists -Name $name) {
        Write-Skip ("User '" + $name + "' already exists.")
        return
    }

    # The password goes in through an environment variable, so it is never
    # written to a file on disk.
    $env:WSLENV  = 'HOUSE_PW'
    $env:HOUSE_PW = $Password
    try {
        $sh = @"
set -e
if ! id -u '$name' >/dev/null 2>&1; then
  useradd -m -s /bin/bash '$name'
fi
usermod -aG sudo '$name'
if [ -z "`$HOUSE_PW" ]; then echo "no password supplied" >&2; exit 1; fi
echo "${name}:`$HOUSE_PW" | chpasswd
echo CREATED
"@
        Invoke-HouseScriptOrFail -Script $sh -AsUser 'root' -What "Creating the Linux user" -Quiet | Out-Null
    }
    finally {
        Remove-Item Env:HOUSE_PW -ErrorAction SilentlyContinue
        Remove-Item Env:WSLENV  -ErrorAction SilentlyContinue
    }

    Write-Ok ("User '" + $name + "' is ready.")
}

# ===========================================================================
# PHASE 3 - settings on both sides
# ===========================================================================
function Invoke-PhaseConfig {
    param([hashtable]$A)
    Write-Step "Step 3 of 9: settings"

    $user = $A['linuxUser']
    $size = $A['houseSizeGb']

    # --- Windows side: .wslconfig ---
    $wslconfig = Join-Path $env:USERPROFILE '.wslconfig'
    $body = @"
[general]
# Windows must not put the house to sleep. The house keeper inside the house decides.
instanceIdleTimeout=-1
"@
    $isTest = (Get-HouseNames).isTest
    if (Test-DryRun) {
        if ($isTest) { Write-Would ("NOT change " + $wslconfig + " (try-out Linux). A real install would set: instanceIdleTimeout=-1") }
        else { Write-Would ("write " + $wslconfig) }
        Write-Would ("write /etc/wsl.conf with default user '" + $user + "', automount off, interop off")
        Write-Would ("cap the house disk at " + $size + " GB")
        Write-Would "stop the house (the whole WSL engine only if no other Linux is running)"
        return
    }

    if ($isTest) {
        Write-Skip (".wslconfig left alone (try-out Linux). A real install would set: instanceIdleTimeout=-1")
    }
    elseif (Test-Path $wslconfig) {
        $existing = Get-Content $wslconfig -Raw
        if ($existing -match 'instanceIdleTimeout\s*=\s*-1') {
            Write-Skip ".wslconfig already set."
        }
        else {
            Copy-Item $wslconfig ($wslconfig + '.before-station256') -Force
            Write-Warn "You already had a .wslconfig. Saved a copy as .wslconfig.before-station256."
            Set-Content -Path $wslconfig -Value $body -Encoding ascii
            Write-Ok "Updated .wslconfig"
        }
    }
    else {
        Set-Content -Path $wslconfig -Value $body -Encoding ascii
        Write-Ok "Wrote .wslconfig"
    }

    # --- House side: /etc/wsl.conf ---
    # This is the Windows door. automount off means /mnt/c stops existing.
    $sh = @"
set -e
cat > /etc/wsl.conf <<'WSLCONF'
[boot]
systemd=true

[user]
default=$user

[automount]
enabled=false
mountFsTab=false

[interop]
enabled=false
appendWindowsPath=false
WSLCONF
echo WROTE
"@
    Invoke-HouseScriptOrFail -Script $sh -AsUser 'root' -What "Writing /etc/wsl.conf" -Quiet | Out-Null
    Write-Ok "Wrote /etc/wsl.conf (Windows door shut, systemd on)"

    # --- Disk cap ---
    # Needs a newer WSL. If it is not there, say so and carry on - the cap is a
    # limit, not something the install depends on.
    #
    # The resize runs e2fsck, which talks on stderr even when it succeeds. That
    # is why this goes through Invoke-Native and the exit code is what counts.
    $null = Stop-House
    $resize = Invoke-Wsl -Arguments @('--manage', (Get-HouseDistro), '--resize', ([string]$size + 'GB'))
    if ($resize.code -eq 0) {
        Write-Ok ("House disk capped at " + $size + " GB")
    }
    else {
        Write-Warn ("Could not set the disk cap to " + $size + " GB. The house will use the WSL default instead.")
        foreach ($l in $resize.output) { if ($l.Trim().Length -gt 0) { Write-Info $l.TrimEnd() } }
        Write-Info "This does not break anything. Station 256 can change it later."
    }

    Write-Info "Restarting the house so the new settings load..."
    $engineOff = Stop-House
    if (-not $engineOff) { Write-Info "Another Linux is running, so WSL itself was not restarted. The sleep setting in .wslconfig applies the next time WSL restarts." }
    Start-Sleep -Seconds 3
}

# ===========================================================================
# PHASE 4a - Docker Engine
# ===========================================================================
function Invoke-PhaseDocker {
    param([hashtable]$A)
    Write-Step "Step 4 of 9: Docker"

    $user = $A['linuxUser']

    if (Test-DryRun) {
        Write-Would "add Docker's apt repository and install Docker Engine inside the house"
        Write-Would ("add '" + $user + "' to the docker group")
        Write-Would "turn on the docker service"
        return
    }

    $already = Get-HouseValue -Script 'command -v docker >/dev/null 2>&1 && echo YES || echo NO' -AsUser 'root'
    if ($already -eq 'YES') {
        Write-Skip "Docker is already installed."
    }
    else {
        Write-Info "Installing Docker Engine. This takes a few minutes."
        $sh = @'
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg iptables
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable docker
echo DOCKER_INSTALLED
'@
        Invoke-HouseScriptOrFail -Script $sh -AsUser 'root' -What "Installing Docker" -Quiet | Out-Null
        Write-Ok "Docker Engine installed."
    }

    # Group membership. The manual steps say log out and back in; restarting the
    # distro does the same job without touching your Windows session.
    $sh2 = @"
set -e
usermod -aG docker '$user'
systemctl enable docker >/dev/null 2>&1 || true
systemctl start docker  >/dev/null 2>&1 || true
echo GROUPED
"@
    Invoke-HouseScriptOrFail -Script $sh2 -AsUser 'root' -What "Adding you to the docker group" -Quiet | Out-Null

    Restart-House

    $check = Get-HouseValue -Script 'id -nG | tr " " "\n" | grep -qx docker && echo YES || echo NO' -AsUser $user
    if ($check -eq 'YES') {
        Write-Ok ("'" + $user + "' can use Docker without a password prompt.")
    }
    else {
        Write-Warn ("The docker group did not take effect. Run 'wsl --terminate " + (Get-HouseDistro) + "' and try again.")
    }
}

# ===========================================================================
# PHASE 4b - everything else the house needs
# ===========================================================================
function Invoke-PhasePackages {
    param([hashtable]$A)
    Write-Step "Step 5 of 9: Node, git and Claude Code"

    $user = $A['linuxUser']

    if (Test-DryRun) {
        Write-Would "install git, nodejs, npm, python3 and fontconfig inside the house"
        Write-Would "install Claude Code into the user's own folder"
        Write-Would "create ~/projects, ~/.config/house and ~/.local/state/house"
        return
    }

    Write-Info "Installing packages..."
    $sh = @'
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git nodejs npm python3 python3-pip python3-venv fontconfig ripgrep jq unzip
apt-get install -y -qq --no-install-recommends ffmpeg poppler-utils
echo PACKAGES_OK
'@
    Invoke-HouseScriptOrFail -Script $sh -AsUser 'root' -What "Installing packages" -Quiet | Out-Null
    Write-Ok "git, Node.js, npm, python3 and fontconfig installed."

    $sh2 = @'
set -e
mkdir -p "$HOME/projects" "$HOME/.config/house" "$HOME/.local/state/house" "$HOME/.local/bin"
if [ ! -x "$HOME/.local/bin/claude" ]; then
  curl -fsSL https://claude.ai/install.sh | bash
fi
if ! grep -q 'HOME/.local/bin' "$HOME/.bashrc" 2>/dev/null; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
fi
echo USER_SETUP_OK
'@
    Invoke-HouseScriptOrFail -Script $sh2 -AsUser $user -What "Setting up your folders and Claude Code" -Quiet | Out-Null
    Write-Ok "Folders created and Claude Code installed."
}

# ===========================================================================
# PHASE 5 - the Station 256 code
# ===========================================================================
function Invoke-PhaseCode {
    param([hashtable]$A)
    Write-Step "Step 6 of 9: Station 256 code"

    $user   = $A['linuxUser']
    $source = Get-HouseSource
    $target = "\\wsl.localhost\" + (Get-HouseDistro) + "\home\" + $user + "\house"

    if (Test-DryRun) {
        Write-Would ("copy " + $source + " to ~/house inside the house")
        Write-Would "run npm install in ~/house/panel"
        Write-Would "build the video editor in ~/house/editor if the release didn't bring it built"
        Write-Would "put the execute bit back on the scripts"
        Write-Would "link ~/.local/bin/room to ~/house/bin/room"
        Write-Would "install Local AI: llama.cpp's server and a small model (system/install-llama.sh)"
        return
    }

    if (-not (Test-Path $source)) {
        throw ("The Station 256 files were not found at " + $source)
    }

    Write-Info "Copying files into the house..."
    # Robocopy over the UNC path. This works even with the Windows door shut,
    # because it is Windows reaching in, not Linux reaching out.
    # Robocopy exit codes 0-7 all mean success; 8 and up are real failures.
    # Left out: .git and node_modules (npm install rebuilds those here), and any old payload folder.
    $rc = Invoke-Native -Exe 'robocopy.exe' -Arguments @($source, $target, '/E', '/XD', 'node_modules', '.git', 'payload', '.next', '/NFL', '/NDL', '/NJH', '/NJS', '/R:2', '/W:2')
    if ($rc.code -ge 8) {
        foreach ($l in $rc.output) { if ($l.Trim().Length -gt 0) { Write-Info $l.TrimEnd() } }
        throw "Copying the code into the house failed."
    }
    Write-Ok "Code copied to ~/house"

    # Copying over \\wsl.localhost drops the execute bit. Put it back.
    $sh = @'
set -e
cd "$HOME/house"
chmod +x *.sh bin/room panel/*.sh panel/test/*.sh system/*.sh 2>/dev/null || true
mkdir -p "$HOME/.local/bin"
ln -sf "$HOME/house/bin/room" "$HOME/.local/bin/room"
echo FIXED
'@
    Invoke-HouseScriptOrFail -Script $sh -AsUser $user -What "Fixing file permissions" -Quiet | Out-Null
    Write-Ok "Scripts made runnable, 'room' command linked."

    Write-Info "Installing the app's own packages. This takes a couple of minutes."
    $sh2 = @'
set -e
cd "$HOME/house/panel"
npm install --no-audit --no-fund
echo NPM_OK
'@
    Invoke-HouseScriptOrFail -Script $sh2 -AsUser $user -What "npm install" -Quiet | Out-Null
    Write-Ok "App packages installed."

    # The video editor (~/house/editor, made from OpenCut) is a built web app in editor/out. A
    # release brings it built. If it isn't, build it: Bun, about 1.6 GB of packages, a few minutes.
    $sh3 = @'
set -e
if [ -d "$HOME/house/editor" ] && [ ! -f "$HOME/house/editor/out/index.html" ]; then
  BUN="$HOME/.local/share/bun-npm/node_modules/.bin/bun"
  [ -x "$BUN" ] || npm install --prefix "$HOME/.local/share/bun-npm" --no-audit --no-fund bun@1.2.18 >/dev/null
  cd "$HOME/house/editor"
  "$BUN" install --frozen-lockfile
  "$BUN" run build
fi
echo EDITOR_OK
'@
    Invoke-HouseScriptOrFail -Script $sh3 -AsUser $user -What "building the video editor" -Quiet | Out-Null
    Write-Ok "Video editor ready."

    # Local AI: llama.cpp's server (the NVIDIA build when the card can run it) and one small model.
    Write-Info "Installing Local AI (llama.cpp and a 2.5 GB model). This takes a few minutes."
    $sh4 = @'
set -e
"$HOME/house/system/install-llama.sh"
echo LLAMA_OK
'@
    Invoke-HouseScriptOrFail -Script $sh4 -AsUser $user -What "installing Local AI" -Quiet | Out-Null
    Write-Ok "Local AI ready."
}

# ===========================================================================
# PHASE 6 - system files, services and the rules
# ===========================================================================
function Invoke-PhaseSystem {
    param([hashtable]$A)
    Write-Step "Step 7 of 9: the walls, the rules and the sleep timer"

    $user  = $A['linuxUser']
    $mins  = [int]$A['idleMinutes']
    $secs  = $mins * 60
    if ($secs -le 0) { $secs = 0 }

    if (Test-DryRun) {
        Write-Would "install house-rules, house-firewall and house-keeper into /usr/local/sbin"
        Write-Would "allow the app to run house-rules without a password (that one command only)"
        Write-Would "turn on the house-firewall and house-keeper services"
        if ($secs -eq 0) {
            Write-Would "set the house to never sleep on its own"
        }
        else {
            Write-Would ("set the sleep timer to " + $secs + " seconds")
        }
        Write-Would "write the starting house rules"
        return
    }

    $sh = @"
set -e
H=/home/$user/house
cd "`$H"

install -m 755 house-rules.sh    /usr/local/sbin/house-rules
install -m 755 house-firewall.sh /usr/local/sbin/house-firewall
install -m 755 house-keeper.sh   /usr/local/sbin/house-keeper

# The app may run that one command as admin, and nothing else.
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/house-rules\n' '$user' > /etc/sudoers.d/house-rules
chmod 440 /etc/sudoers.d/house-rules
visudo -c >/dev/null

install -m 644 house-firewall.service /etc/systemd/system/house-firewall.service
install -m 644 house-keeper.service   /etc/systemd/system/house-keeper.service

if [ "$secs" -eq 0 ]; then
  printf 'HOUSE_IDLE_SECONDS=0\n' > /etc/default/house-keeper
else
  printf 'HOUSE_IDLE_SECONDS=%s\n' '$secs' > /etc/default/house-keeper
fi
# The keeper watches this user's programs. Its script falls back to the owner's name without this.
printf 'HOUSE_USER=%s\n' '$user' >> /etc/default/house-keeper

systemctl daemon-reload
systemctl enable house-firewall house-keeper >/dev/null 2>&1
systemctl start  house-firewall             >/dev/null 2>&1 || true
systemctl start  house-keeper               >/dev/null 2>&1 || true

# House rules reach Claude inside the house as well as inside rooms.
mkdir -p /etc/claude-code
ln -sf /home/$user/.config/house/claude-managed.json /etc/claude-code/managed-settings.json
echo SYSTEM_OK
"@
    Invoke-HouseScriptOrFail -Script $sh -AsUser 'root' -What "Installing the system files" -Quiet | Out-Null
    Write-Ok "Walls, rules and sleep timer installed."

    # Starting rules, then let the app turn them into Claude's permission file.
    $sh2 = @'
set -e
mkdir -p "$HOME/.config/house"
if [ ! -f "$HOME/.config/house/rules.json" ]; then
cat > "$HOME/.config/house/rules.json" <<'RULES'
{
  "projectDoor": "block",
  "web": "ask",
  "github": "ask",
  "installs": "allow",
  "deletes": "ask",
  "secrets": "ask"
}
RULES
fi
if [ -f "$HOME/house/panel/lib/rules.js" ]; then
  node -e '
    const p = require(process.env.HOME + "/house/panel/lib/rules.js");
    if (p && typeof p.writeClaudeRules === "function") { p.writeClaudeRules(); }
  ' 2>/dev/null || true
fi
echo RULES_OK
'@
    Invoke-HouseScript -Script $sh2 -AsUser $user -Quiet | Out-Null

    # If the app could not generate it, write a sane default so rooms still work.
    $hasManaged = Get-HouseValue -Script 'test -s "$HOME/.config/house/claude-managed.json" && echo YES || echo NO' -AsUser $user
    if ($hasManaged -ne 'YES') {
        $sh3 = @'
cat > "$HOME/.config/house/claude-managed.json" <<'MANAGED'
{
  "permissions": {
    "allow": ["Bash(npm install:*)","Bash(npm i:*)","Bash(pnpm add:*)","Bash(pnpm install:*)","Bash(yarn add:*)","Bash(pip install:*)","Bash(pip3 install:*)","Bash(uv add:*)","Bash(uv pip install:*)"],
    "ask": ["WebSearch","WebFetch","Bash(curl:*)","Bash(wget:*)","Bash(git push:*)","Bash(git pull:*)","Bash(git clone:*)","Bash(git fetch:*)","Bash(gh:*)","WebFetch(domain:github.com)","Bash(rm:*)","Bash(rmdir:*)","Bash(git clean:*)","Read(**/.env)","Read(**/.env.*)","Read(**/secrets/**)","Read(**/*.pem)","Read(**/*.key)","Bash(printenv:*)","Bash(env:*)"],
    "deny": []
  }
}
MANAGED
echo DEFAULT_RULES
'@
        Invoke-HouseScript -Script $sh3 -AsUser $user -Quiet | Out-Null
        Write-Info "Wrote the default Claude rules."
    }

    $walls = Get-HouseValue -Script 'sudo -n /usr/local/sbin/house-rules firewall-check >/dev/null 2>&1 && echo OK || echo NOT_YET' -AsUser $user
    if ($walls -eq 'OK') {
        Write-Ok "Checked the walls: rooms cannot reach Windows or your network."
    }
    else {
        Write-Warn "The walls are not up yet. They go up when Docker next starts."
    }
}

# ===========================================================================
# PHASE 7 - the room blueprint
# ===========================================================================
function Invoke-PhaseRooms {
    param([hashtable]$A)
    Write-Step "Step 8 of 9: the room blueprint"

    $user = $A['linuxUser']

    if (Test-DryRun) {
        Write-Would "build the Docker image every project room is made from (slowest step)"
        return
    }

    $have = Get-HouseValue -Script 'docker image inspect house-room:latest >/dev/null 2>&1 && echo YES || echo NO' -AsUser $user
    if ($have -eq 'YES') {
        Write-Skip "The room blueprint is already built."
        return
    }

    Write-Info "Building it now. This is the slowest step, around 5 to 10 minutes."
    $sh = @'
set -e
export PATH="$HOME/.local/bin:$PATH"
room build
echo ROOM_BUILT
'@
    $r = Invoke-HouseScript -Script $sh -AsUser $user -Quiet
    if ($r.ok) {
        Write-Ok "Room blueprint built."
    }
    else {
        Write-Warn "The room blueprint did not build. Everything else is fine."
        Write-Info "Open a house terminal and run 'room build' to see why."
    }
}

# ===========================================================================
# PHASE 8 - the Windows half
# ===========================================================================
function Invoke-PhaseWindows {
    param([hashtable]$A)
    Write-Step "Step 9 of 9: the Windows half"

    $letter  = $A['driveLetter']
    $user    = $A['linuxUser']
    $distro  = Get-HouseDistro
    $names   = Get-HouseNames
    $appDir  = $names.appDir
    $source  = Get-WindowsSource

    if (Test-DryRun) {
        Write-Would ("map " + $letter + ": to \\wsl.localhost\" + $distro + ", kept after restart")
        Write-Would ("copy the helper scripts to " + $appDir + ", plus house.json (which Linux, which user, which drive)")
        Write-Would ("copy uninstall.ps1 to " + (Join-Path $appDir 'installer'))
        if ($A['rightClickMenu'])   { Write-Would ("add 'Open Linux terminal here' on " + $letter + ": only (" + ($names.menuKeys -join ' and ') + ")") }
        if ($A['sleepAtLogin'])     { Write-Would ("add the login sleep step (HKCU Run: " + $names.runName + ")") }
        if ($A['desktopShortcut'])  { Write-Would ("put a shortcut on the Desktop: " + $names.lnkName) }
        if ($A['startMenuShortcut']){ Write-Would ("put a shortcut in the Start menu: " + $names.lnkName) }
        return
    }

    # --- the drive ---
    $mapped = $false
    if (Test-Path ("HKCU:\Network\" + $letter)) {
        $remote = (Get-ItemProperty ("HKCU:\Network\" + $letter) -ErrorAction SilentlyContinue).RemotePath
        if ($remote -like ('*wsl.localhost\' + $distro + '*')) { $mapped = $true }
    }
    if ($mapped) {
        Write-Skip ($letter + ": is already mapped to the house.")
    }
    else {
        $netCmd = 'net use ' + $letter + ': \\wsl.localhost\' + $distro + ' /persistent:yes'
        $net = Invoke-Native -Exe 'cmd.exe' -Arguments @('/c', $netCmd)
        if ($net.code -eq 0) {
            Write-Ok ($letter + ": now opens the house in File Explorer.")
        }
        else {
            Write-Warn ("Could not map " + $letter + ":. You can still reach the house at \\wsl.localhost\" + $distro)
        }
    }

    # --- the helper scripts ---
    if (-not (Test-Path $source)) {
        throw ("The Windows helper scripts were not found at " + $source)
    }
    if (-not (Test-Path $appDir)) { New-Item -ItemType Directory -Force -Path $appDir | Out-Null }
    # seam-test and snap-both-ways are the owner's own test tools, not part of an install.
    Copy-Item (Join-Path $source '*') $appDir -Recurse -Force -Exclude 'seam-test.ps1','snap-both-ways.ps1','*.log','install-state.json'
    Write-Ok ("Helper scripts copied to " + $appDir)

    # The scripts read this to learn which Linux, user and drive are the house's.
    # (Without it the scripts stop and say the house is not installed.)
    $cfg = @{ distro = $distro; user = $user; drive = $letter }
    [System.IO.File]::WriteAllText((Join-Path $appDir 'house.json'), ($cfg | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

    # Keep the uninstaller where the user can find it after the download folder is gone.
    $inst = Get-InstallerDir
    if ($inst -and (Test-Path (Join-Path $inst 'uninstall.ps1'))) {
        $dest = Join-Path $appDir 'installer'
        New-Item -ItemType Directory -Force -Path (Join-Path $dest 'lib') | Out-Null
        Copy-Item (Join-Path $inst 'uninstall.ps1') $dest -Force
        Copy-Item (Join-Path $inst 'lib\*.ps1') (Join-Path $dest 'lib') -Force -Exclude 'selftest.ps1'
        Write-Ok ("Uninstaller saved at " + (Join-Path $dest 'uninstall.ps1'))
    }

    # --- registry: built from the real answers, not a fixed file ---
    if ($A['rightClickMenu']) {
        Add-RightClickMenu -Letter $letter -AppDir $appDir -Keys $names.menuKeys
        Write-Ok ("Right-click menu added, on " + $letter + ": only.")
    }
    else {
        Remove-RightClickMenu -Keys $names.menuKeys
        Write-Skip "Right-click menu not added."
    }

    if ($A['sleepAtLogin']) {
        $cmd = 'C:\Windows\System32\conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $appDir 'sleep-at-login.ps1') + '"'
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $names.runName -Value $cmd
        Write-Ok "The house will go to sleep when you log in."
    }
    else {
        Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $names.runName -ErrorAction SilentlyContinue
        Write-Skip "Login sleep not added."
    }

    # --- shortcuts ---
    $icon   = Join-Path $appDir 'station-256-app.ico'
    $target = 'C:\Windows\System32\conhost.exe'
    # Not named $args - that is a reserved PowerShell variable.
    $lnkArgs = '--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $appDir 'open-panel.ps1') + '"'

    if ($A['desktopShortcut']) {
        New-StationShortcut -Path (Join-Path ([Environment]::GetFolderPath('Desktop')) $names.lnkName) -Target $target -Arguments $lnkArgs -Icon $icon
        Write-Ok "Shortcut on your Desktop."
    }
    if ($A['startMenuShortcut']) {
        $sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
        New-StationShortcut -Path (Join-Path $sm $names.lnkName) -Target $target -Arguments $lnkArgs -Icon $icon
        Write-Ok "Shortcut in your Start menu."
    }
}


function Add-RightClickMenu {
    param([string]$Letter, [string]$AppDir, [string[]]$Keys)

    $cmd = 'conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $AppDir 'open-here.ps1') + '" "%V"'
    # AppliesTo keeps the menu off every other drive.
    $applies = 'System.ItemPathDisplay:~< "' + $Letter + ':"'

    foreach ($base in $Keys) {
        New-Item -Path $base -Force | Out-Null
        New-Item -Path ($base + '\command') -Force | Out-Null
        Set-ItemProperty -Path $base -Name '(Default)' -Value 'Open Linux terminal here'
        Set-ItemProperty -Path $base -Name 'AppliesTo' -Value $applies
        Set-ItemProperty -Path ($base + '\command') -Name '(Default)' -Value $cmd
    }
}

function Remove-RightClickMenu {
    param([string[]]$Keys)
    foreach ($base in $Keys) {
        if (Test-Path $base) { Remove-Item $base -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

function New-StationShortcut {
    param([string]$Path, [string]$Target, [string]$Arguments, [string]$Icon)

    $dir = Split-Path $Path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath       = $Target
    $lnk.Arguments        = $Arguments
    $lnk.WorkingDirectory = $env:USERPROFILE
    $lnk.Description      = 'Station 256 - your Linux house'
    if (Test-Path $Icon) { $lnk.IconLocation = $Icon + ',0' }
    $lnk.Save()
}

# ===========================================================================
# PHASE 9 - check the work
# ===========================================================================
function Invoke-PhaseVerify {
    param([hashtable]$A)
    Write-Banner "Checking everything works"

    $user   = $A['linuxUser']
    $letter = $A['driveLetter']
    $good   = 0
    $bad    = 0
    $todo   = @()

    if (Test-DryRun) {
        Write-Would "run the full health check"
        return @{ good = 0; bad = 0; todo = @() }
    }

    function Test-Thing {
        param([string]$Name, [string]$Script, [string]$AsUser, [string]$Expect = 'YES')
        $v = Get-HouseValue -Script $Script -AsUser $AsUser
        if ($v -eq $Expect) { Write-Ok $Name; return $true }
        Write-Fail $Name
        return $false
    }

    $checks = @(
        @{ n = 'The house is running';       s = 'echo YES';                                                               u = $user },
        @{ n = 'Docker is on';               s = 'systemctl is-active docker | grep -qx active && echo YES || echo NO';     u = 'root' },
        @{ n = 'The walls are up';           s = 'systemctl is-active house-firewall | grep -qx active && echo YES || echo NO'; u = 'root' },
        @{ n = 'The sleep timer is on';      s = 'systemctl is-active house-keeper | grep -qx active && echo YES || echo NO';   u = 'root' },
        @{ n = 'Windows door is shut';       s = 'test -d /mnt/c && echo NO || echo YES';                                   u = $user },
        @{ n = 'Room network exists';        s = 'docker network inspect house-rooms >/dev/null 2>&1 && echo YES || echo NO'; u = $user },
        @{ n = 'Station 256 code is there';  s = 'test -f "$HOME/house/panel/main.js" && echo YES || echo NO';              u = $user },
        @{ n = 'App packages installed';     s = 'test -d "$HOME/house/panel/node_modules/electron" && echo YES || echo NO'; u = $user },
        @{ n = 'The Station 256 start script is runnable'; s = 'test -x "$HOME/house/panel/start.sh" && echo YES || echo NO'; u = $user },
        @{ n = 'Video editor built';         s = 'test -f "$HOME/house/editor/out/index.html" && echo YES || echo NO'; u = $user },
        @{ n = 'The room command works';     s = 'test -x "$HOME/.local/bin/room" && echo YES || echo NO';                   u = $user },
        @{ n = 'House rules are set';        s = 'test -s "$HOME/.config/house/rules.json" && echo YES || echo NO';          u = $user }
    )

    foreach ($c in $checks) {
        if (Test-Thing -Name $c.n -Script $c.s -AsUser $c.u) { $good++ } else { $bad++ }
    }

    # Room blueprint is a warning, not a failure.
    $blueprint = Get-HouseValue -Script 'docker image inspect house-room:latest >/dev/null 2>&1 && echo YES || echo NO' -AsUser $user
    if ($blueprint -eq 'YES') { Write-Ok 'Room blueprint is built'; $good++ }
    else { Write-Warn 'Room blueprint is not built. Run: room build'; $todo += 'Run "room build" in a house terminal.' }

    # Windows side
    if (Test-Path ($letter + ':\')) { Write-Ok ($letter + ': opens the house'); $good++ }
    else { Write-Warn ($letter + ': is not reachable right now. It appears once the house is awake.') }

    $names  = Get-HouseNames
    $appDir = $names.appDir
    if (Test-Path (Join-Path $appDir 'open-panel.ps1')) { Write-Ok 'Windows helper scripts are in place'; $good++ }
    else { Write-Fail 'Windows helper scripts are missing'; $bad++ }

    if ($A['desktopShortcut']) {
        if (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) $names.lnkName)) { Write-Ok 'Desktop shortcut'; $good++ }
        else { Write-Fail 'Desktop shortcut is missing'; $bad++ }
    }

    # Claude login cannot be scripted.
    $logged = Get-HouseValue -Script 'test -s "$HOME/.config/house/claude-token" && echo YES || echo NO' -AsUser $user
    if ($logged -eq 'YES') { Write-Ok 'Claude is connected'; $good++ }
    else { Write-Todo 'Claude is not connected yet'; $todo += 'Open a house terminal and run: room login' }

    return @{ good = $good; bad = $bad; todo = $todo }
}
