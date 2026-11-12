<#
    uninstall.ps1 - removes what install.ps1 made, and nothing else.

        powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1

    Safe way to see what it would do:
        uninstall.ps1 -DryRun

    Switches:
        -DistroName <name>   which Linux to remove (default Station256)
        -Yes                 answer yes to every question, including deleting the Linux
        -AppDir <folder>     where the Windows helper files live (for testing)

    It never touches any other Linux. It only removes the Windows parts (drive,
    shortcuts, login step, right-click menu) when they belong to this Linux.

    Built for Windows PowerShell 5.1. No &&, no ||, no ternary, no ?? and no ?.
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Yes,
    [string]$DistroName = 'Station256',
    [string]$AppDir = ''
)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Definition }
foreach ($f in @('ui.ps1','wsl.ps1')) {
    $p = Join-Path $here ('lib\' + $f)
    if (-not (Test-Path $p)) { Write-Host ("Missing part of the installer: " + $p) -ForegroundColor Red; exit 1 }
    . $p
}
Set-HouseDistro -Name $DistroName -AppDir $AppDir
$names   = Get-HouseNames
$AppDir  = $names.appDir

Write-Banner "Station 256 - remove"
if ($DryRun) { Write-Warn "DRY RUN. Nothing will be removed. You will just see what would happen." }

$runKey   = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$menuKeys = $names.menuKeys
# A shortcut or key is ours only if it points INTO this folder (trailing slash, so
# LinuxHouse does not match LinuxHouse-Test).
$inApp    = '*' + $AppDir.TrimEnd('\') + '\*'

# ---------------------------------------------------------------------------
# 1. The Linux itself - the only step that destroys data, so it asks first
# ---------------------------------------------------------------------------
Write-Step ("The Linux called '" + $DistroName + "'")

if (-not (Test-WslPresent) -or -not (Test-DistroExists)) {
    Write-Skip "There is no Linux with that name. Nothing to delete."
}
elseif ($DryRun) {
    Write-Would ("check that '" + $DistroName + "' was made by this installer (it is left alone if not)")
    Write-Would ("ask before deleting it, then run: wsl --unregister " + $DistroName)
}
elseif (-not (Test-HousePath -Path '/etc/station256-distro')) {
    Write-Warn ("'" + $DistroName + "' was not made by this installer, so it is left alone.")
}
else {
    Write-Wrapped ("This deletes the Linux '" + $DistroName + "' and its drive. Everything inside it will be gone for good: your projects, your files, your Docker rooms and all settings. This cannot be undone.") 'Yellow' 3
    Write-Line ''
    $go = $true
    if (-not $Yes) { $go = Confirm-YesNo ("Delete '" + $DistroName + "' and everything in it?") $false }
    if ($go) {
        $r = Invoke-Wsl -Arguments @('--unregister', $DistroName)
        if (Test-DistroExists) {
            foreach ($l in $r.output) { if ($l.Trim().Length -gt 0) { Write-Info $l.TrimEnd() } }
            Write-Fail "Windows could not delete it."
        }
        else { Write-Ok ("Deleted '" + $DistroName + "'.") }
    }
    else { Write-Skip "Kept the Linux. Only the Windows parts will be removed." }
}

# ---------------------------------------------------------------------------
# 2. The Windows parts - only if house.json says they belong to this Linux
# ---------------------------------------------------------------------------
Write-Step "The Windows parts"

$cfgFile = Join-Path $AppDir 'house.json'
$cfg = $null
if (Test-Path $cfgFile) { $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json }

if ((-not $cfg) -or ($cfg.distro -ne $DistroName)) {
    # Refuses to touch the folder (or its shortcut, login step or menu) unless house.json names this Linux.
    Write-Skip ("REFUSED: " + $AppDir + " does not have a house.json naming '" + $DistroName + "'. The folder, shortcuts, login step and menus are left alone.")
}
else {
    $letter = $cfg.drive

    # --- the drive ---
    $remote = ''
    if (Test-Path ("HKCU:\Network\" + $letter)) {
        $remote = (Get-ItemProperty ("HKCU:\Network\" + $letter) -ErrorAction SilentlyContinue).RemotePath
    }
    if ($remote -like ('*wsl.localhost\' + $DistroName + '*')) {
        if ($DryRun) { Write-Would ("remove the drive " + $letter + ": (" + $remote + ")") }
        else {
            $null = Invoke-Native -Exe 'cmd.exe' -Arguments @('/c', ('net use ' + $letter + ': /delete /y'))
            Write-Ok ("Drive " + $letter + ": removed.")
        }
    }
    else { Write-Skip ("Drive " + $letter + ": is not mapped to this Linux. Left alone.") }

    # --- shortcuts: only ones that run OUR helper files ---
    $lnks = @((Join-Path ([Environment]::GetFolderPath('Desktop')) $names.lnkName),
              (Join-Path $env:APPDATA ('Microsoft\Windows\Start Menu\Programs\' + $names.lnkName)))
    foreach ($lnk in $lnks) {
        if (-not (Test-Path $lnk)) { continue }
        $shell = New-Object -ComObject WScript.Shell
        $ours = $shell.CreateShortcut($lnk).Arguments -like $inApp
        if (-not $ours) { Write-Skip ($lnk + " is not ours. Left alone."); continue }
        if ($DryRun) { Write-Would ("delete " + $lnk) }
        else { Remove-Item $lnk -Force; Write-Ok ("Deleted " + $lnk) }
    }

    # --- login sleep step ---
    $run = (Get-ItemProperty $runKey -Name $names.runName -ErrorAction SilentlyContinue).($names.runName)
    if ($run -and ($run -like $inApp)) {
        if ($DryRun) { Write-Would ("remove the login sleep step (HKCU Run: " + $names.runName + ")") }
        else { Remove-ItemProperty -Path $runKey -Name $names.runName; Write-Ok "Login sleep step removed." }
    }
    else { Write-Skip "No login sleep step of ours." }

    # --- right-click menu ---
    foreach ($k in $menuKeys) {
        if (-not (Test-Path ($k + '\command'))) { continue }
        $cmd = (Get-Item ($k + '\command')).GetValue('')
        if ($cmd -notlike $inApp) { Write-Skip ($k + " is not ours. Left alone."); continue }
        if ($DryRun) { Write-Would ("remove " + $k) }
        else { Remove-Item $k -Recurse -Force; Write-Ok ("Removed " + $k) }
    }

    # --- the helper files (last: this script may be running from in there) ---
    if (Test-Path $AppDir) {
        if ($DryRun) { Write-Would ("delete the folder " + $AppDir) }
        else {
            Remove-Item $AppDir -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path $AppDir) { Write-Warn ("Some files in " + $AppDir + " are still in use. Delete the folder yourself after a restart.") }
            else { Write-Ok ("Deleted " + $AppDir) }
        }
    }
}

# ---------------------------------------------------------------------------
# 3. .wslconfig - put the old one back if the installer saved it
# ---------------------------------------------------------------------------
Write-Step "Your .wslconfig"
$wslconfig = Join-Path $env:USERPROFILE '.wslconfig'
$backup    = $wslconfig + '.before-station256'
if ($names.isTest) {
    Write-Skip "A try-out install never changed .wslconfig, so it is left as it is."
}
elseif (Test-Path $backup) {
    if ($DryRun) { Write-Would ("put " + $backup + " back as " + $wslconfig) }
    else { Move-Item $backup $wslconfig -Force; Write-Ok "Your old .wslconfig is back." }
}
else {
    Write-Skip "No saved copy, so .wslconfig is left as it is."
}

Write-Line ''
if ($DryRun) { Write-Ok "Dry run finished. Nothing was removed." }
else { Write-Ok "Done." }
Write-Line ''
