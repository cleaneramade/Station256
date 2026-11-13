# update.ps1 - what happens when Station 256 is already on this PC.
#
# Running the install command again must never set up a second copy or touch
# your data. So before anything else the installer looks for a Station 256 that
# is already here. If it finds one, it only updates the app's own files:
#
#   - your projects (~/projects), settings (~/.config/house) and rooms are left alone
#   - no questions about storage, drive letter or password
#   - a copy that is tracked with git (a developer copy) is never overwritten
#
# Names here are prefixed so they cannot collide with an install.ps1 parameter.
# Built for Windows PowerShell 5.1.

# Reads what a house says about itself. Runs as root so it works whoever the
# default Linux user is. Returns $null when that Linux has no Station 256.
function Read-HouseProbe {
    param([string]$Distro, [string]$AppDir)

    $keepName = Get-HouseDistro
    $keepDir  = (Get-HouseNames).appDir
    Set-HouseDistro -Name $Distro -AppDir $AppDir
    try {
        $sh = @'
for h in /home/*/house; do
  [ -f "$h/panel/main.js" ] || continue
  echo "USER=$(stat -c %U "$h")"
  echo "VERSION=$(head -1 "$h/VERSION" 2>/dev/null | tr -d '[:space:]')"
  if [ -d "$h/.git" ]; then echo "GIT=1"; else echo "GIT=0"; fi
  if pgrep -f "house/panel/node_modules/electron" >/dev/null 2>&1; then echo "RUNNING=1"; else echo "RUNNING=0"; fi
  echo "IDLE=$(sed -n 's/^HOUSE_IDLE_SECONDS=//p' /etc/default/house-keeper 2>/dev/null | head -1)"
  break
done
'@
        $r = Invoke-HouseScript -Script $sh -AsUser 'root' -Quiet
        return (ConvertFrom-HouseProbe -Lines $r.output -Distro $Distro)
    }
    finally {
        Set-HouseDistro -Name $keepName -AppDir $keepDir
    }
}

# Turns the probe's lines into a table. Kept apart so the selftest can check it.
function ConvertFrom-HouseProbe {
    param([string[]]$Lines, [string]$Distro)

    $found = @{}
    foreach ($l in $Lines) {
        if ($l -match '^\s*([A-Z]+)=(.*)$') { $found[$Matches[1]] = $Matches[2].Trim() }
    }
    if (-not $found.ContainsKey('USER') -or -not $found['USER']) { return $null }

    # -1 means "not known": the sleep timer is then left at its default.
    $idle = -1
    $n = 0
    if ($found['IDLE'] -and [int]::TryParse($found['IDLE'], [ref]$n) -and ($n -ge 0)) { $idle = $n }

    return @{
        distro      = $Distro
        user        = $found['USER']
        version     = [string]$found['VERSION']
        isGit       = ($found['GIT'] -eq '1')
        isRunning   = ($found['RUNNING'] -eq '1')
        idleSeconds = $idle
    }
}

# Looks for a Station 256 that is already set up. Returns $null when there is none.
function Find-ExistingHouse {
    if (-not (Test-WslPresent)) { return $null }

    $appDir = (Get-HouseNames).appDir
    $cfgPath = Join-Path $appDir 'house.json'
    $candidates = @()
    $drive = ''

    if (Test-Path $cfgPath) {
        # The installer's own record: which Linux, which user, which drive.
        try {
            $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
            if ($cfg.distro) { $candidates += [string]$cfg.distro }
            if ($cfg.drive)  { $drive = [string]$cfg.drive }
        }
        catch {
            Write-Warn "The install record (house.json) could not be read."
        }
    }
    elseif (Test-Path (Join-Path $appDir 'open-panel.ps1')) {
        # Set up by hand, with no record: look in each Linux for the house.
        $r = Invoke-Wsl -Arguments @('--list', '--quiet')
        foreach ($l in $r.output) {
            $n = $l.Trim()
            if ($n -and ($n -notmatch '^docker-desktop')) { $candidates += $n }
        }
    }

    foreach ($d in $candidates) {
        if (-not (Test-DistroExists -Name $d)) { continue }
        $probe = Read-HouseProbe -Distro $d -AppDir $appDir
        if ($probe) {
            if (-not $drive) { $drive = Find-HouseDrive -Distro $d }
            $probe['drive']  = $drive
            $probe['appDir'] = $appDir
            return $probe
        }
    }
    return $null
}

# The drive letter that already opens this Linux, or L when none does.
function Find-HouseDrive {
    param([string]$Distro)
    foreach ($k in (Get-ChildItem 'HKCU:\Network' -ErrorAction SilentlyContinue)) {
        $remote = (Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue).RemotePath
        if ($remote -like ('*wsl.localhost\' + $Distro + '*')) { return $k.PSChildName.ToUpper() }
    }
    return 'L'
}

# -1: the installed one is older (or has no version), 0: the same, 1: the installed one is newer.
function Compare-HouseVersion {
    param([string]$Installed, [string]$Offered)
    $a = $null
    $b = $null
    if (-not [version]::TryParse($Installed, [ref]$a)) { return -1 }
    if (-not [version]::TryParse($Offered, [ref]$b))   { return -1 }
    return $a.CompareTo($b)
}

# The version of the files this installer carries.
function Get-OfferedVersion {
    $file = Join-Path (Get-HouseSource) 'VERSION'
    if (Test-Path $file) { return ((Get-Content $file -TotalCount 1) + '').Trim() }
    return ''
}

# Updates the copy that is already here. Returns the process exit code.
function Invoke-HouseUpdate {
    param([hashtable]$Existing, [bool]$AssumeYes)

    $offered   = Get-OfferedVersion
    $installed = $Existing.version
    $shown     = $installed
    if (-not $shown) { $shown = 'older (no version recorded)' }

    Write-Banner "Station 256 is already installed"
    Write-Info ("Found in the Linux named '" + $Existing.distro + "', user '" + $Existing.user + "'.")
    Write-Info ("Installed version   " + $shown)
    Write-Info ("This version        " + $offered)
    Write-Line ''

    if ($Existing.isGit) {
        Write-Ok "This is a developer copy: it keeps its own history with git."
        Write-Wrapped "The installer never overwrites a developer copy, so your work is safe. Update it with git instead. Nothing was changed." 'Gray' 3
        Write-Line ''
        return 0
    }

    $cmp = Compare-HouseVersion -Installed $installed -Offered $offered
    if ($cmp -eq 0) {
        Write-Ok "You already have this version. Nothing to do."
        Write-Line ''
        return 0
    }
    if ($cmp -gt 0) {
        Write-Ok "Your copy is newer than this one. Nothing to do."
        Write-Line ''
        return 0
    }

    Write-Wrapped "This will update the app's own files. Your projects, your settings and your rooms are not touched, and nothing is asked again." 'Gray' 3
    Write-Line ''

    if ($Existing.isRunning -and (-not (Test-DryRun))) {
        Write-Warn "Station 256 is open. Close it, then run the same command again."
        Write-Info "Nothing was changed."
        Write-Line ''
        return 1
    }

    if ((-not $AssumeYes) -and (-not (Test-DryRun))) {
        if (-not (Confirm-YesNo ("Update to " + $offered + "?") $true)) {
            Write-Line ''
            Write-Info "Stopped. Nothing was changed."
            return 0
        }
    }

    # From here on, every step talks to the Linux that was found.
    Set-HouseDistro -Name $Existing.distro -AppDir $Existing.appDir

    $names = Get-HouseNames
    $a = @{
        linuxUser         = $Existing.user
        driveLetter       = $Existing.drive
        idleMinutes       = 10
        desktopShortcut   = (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) $names.lnkName))
        startMenuShortcut = $false
        rightClickMenu    = $false
        sleepAtLogin      = $false
    }
    # Keep the sleep timer exactly as it is set now.
    if ($Existing.idleSeconds -ge 0) { $a['idleSeconds'] = $Existing.idleSeconds }

    Set-StepMap -Map @{
        'Step 6 of 9' = 'Update 1 of 4'
        'Step 7 of 9' = 'Update 2 of 4'
        'Step 8 of 9' = 'Update 3 of 4'
        'Step 9 of 9' = 'Update 4 of 4'
    }

    Write-Banner "Updating"
    try {
        Invoke-PhaseCode -A $a
        Invoke-PhaseSystem -A $a
        Invoke-RoomsUpdate -A $a
        Invoke-PhaseWindows -A $a -FilesOnly
    }
    catch {
        Write-Line ''
        Write-Fail $_.Exception.Message
        Write-Line ''
        Write-Wrapped "The update stopped. Your projects and settings were not touched. Fix the problem above, then run the same command again." 'Yellow' 3
        return 1
    }

    $result = Invoke-PhaseVerify -A $a

    Write-Banner "Done"
    if (Test-DryRun) {
        Write-Ok "Dry run finished. Nothing was changed."
        return 0
    }
    if ($result.bad -gt 0) {
        Write-Warn ([string]$result.bad + " thing(s) did not check out. Look for [FAIL] above.")
    }
    else {
        Write-Ok ("Station 256 is now version " + $offered + ".")
    }
    Write-Info "Your projects, settings and rooms were not touched."
    Write-Line ''
    return 0
}

# The room blueprint, rebuilt from the new files. A house from before AI tools could be
# chosen had all three built in: that choice is written down first, so nothing you had is lost.
function Invoke-RoomsUpdate {
    param([hashtable]$A)
    Write-Step "Step 8 of 9: the room blueprint"

    if (Test-DryRun) {
        Write-Would "keep the AI tools your rooms already have"
        Write-Would "rebuild the room blueprint from the new files (open rooms keep running)"
        return
    }

    Write-Info "Rebuilding it. Only the parts that changed are built again. Open rooms keep running."
    $sh = @'
set -e
export PATH="$HOME/.local/bin:$PATH"
f="$HOME/.config/house/ai-tools"
if [ ! -f "$f" ] && docker image inspect house-room:latest >/dev/null 2>&1 \
   && ! docker image inspect house-room:latest -f '{{json .Config.Labels}}' | grep -q '"house.ai"'; then
  mkdir -p "$(dirname "$f")"
  printf 'claude,codex,gemini\n' > "$f"
  echo KEPT_ALL_THREE
fi
room build
echo ROOM_BUILT
'@
    $r = Invoke-HouseScript -Script $sh -AsUser $A['linuxUser'] -Quiet
    foreach ($l in $r.output) {
        if ($l.Trim() -eq 'KEPT_ALL_THREE') { Write-Info "Your rooms had Claude Code, Codex and Gemini, so all three are kept. Change that in House Rules." }
    }
    if ($r.ok) {
        Write-Ok "Room blueprint rebuilt."
    }
    else {
        Write-Warn "The room blueprint did not rebuild. Your old one still works."
        Write-Info "Open a house terminal and run 'room build' to see why."
    }
}
