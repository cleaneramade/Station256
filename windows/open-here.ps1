# Opens a terminal for a folder on the house drive. Inside a project, it opens that project's room.
param([string]$Path, [switch]$DryRun)

# Which Linux is the house? The installer writes house.json beside these scripts. Without it
# the script stops.
if (-not (Test-Path "$PSScriptRoot\house.json")) { Write-Host "Station 256 isn't installed. Run the installer."; exit 1 }
if (Test-Path "$PSScriptRoot\house.json") {
    $houseCfg = Get-Content "$PSScriptRoot\house.json" -Raw | ConvertFrom-Json
    $houseDistro = $houseCfg.distro; $houseUser = $houseCfg.user; $houseDrive = $houseCfg.drive
}

$wsl = 'C:\Windows\System32\wsl.exe'
$p = $Path.Trim('"').TrimEnd('\', '/')
if ($p -notmatch ('^' + [regex]::Escape($houseDrive) + ':')) { exit 0 }
$linux = ($p.Substring(2) -replace '\\', '/')
if ($linux -eq '') { $linux = '/' }

if ($linux -match ('^/home/' + [regex]::Escape($houseUser) + '/projects/([a-z0-9](?:[a-z0-9 _-]*[a-z0-9_-])?)(/.*)?$')) {
    $name = $Matches[1]
    $termArgs = "-w new new-tab -p $houseDistro --title `"Room: $name`" $wsl -d $houseDistro --cd /home/$houseUser -e /home/$houseUser/.local/bin/room open `"$name`""
} else {
    $termArgs = "-w new new-tab -p $houseDistro --title `"Linux House`" $wsl -d $houseDistro --cd `"$linux`""
}

if ($DryRun) { $termArgs; exit 0 }
# The helper keeps the PC awake while rooms are open, however they were opened. Only one ever runs.
$helper = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'house-helper.ps1'
Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$helper`"" -WorkingDirectory $env:USERPROFILE
Start-Process -FilePath 'wt.exe' -ArgumentList $termArgs -WorkingDirectory $env:USERPROFILE
