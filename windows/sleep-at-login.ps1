# Runs once at login, then ends. Windows starts the Linux engine while it reconnects the L: drive,
# and it would then sit using memory until something woke the house. This turns it off. L: stays
# listed, and opening it wakes the house again. It never touches other drives, and it reads nothing
# inside the house, since that would wake it.
# The installer writes house.json beside this script; without it the owner's own name applies.
$houseDistro = 'Ubuntu'
if (Test-Path "$PSScriptRoot\house.json") { $houseDistro = (Get-Content "$PSScriptRoot\house.json" -Raw | ConvertFrom-Json).distro }
$wsl = 'C:\Program Files\WSL\wsl.exe'
$log = Join-Path $PSScriptRoot 'sleep-at-login.log'
function Note($text) { Set-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $text" -Encoding utf8 }

# Windows may still be starting it, so this gives it a minute to appear, then a moment to settle.
$end = (Get-Date).AddSeconds(60)
while (-not (Get-Process vmmemWSL -ErrorAction SilentlyContinue) -and (Get-Date) -lt $end) { Start-Sleep -Seconds 2 }
if (-not (Get-Process vmmemWSL -ErrorAction SilentlyContinue)) { Note 'the engine never started, nothing to do'; exit 0 }
Start-Sleep -Seconds 15

# If you've already started using the house, it's left alone.
$station = Get-Process msrdc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match '^Station 256( \(|$)' }
if ($station -or (Get-Process wsl -ErrorAction SilentlyContinue)) { Note 'the house is in use, left it alone'; exit 0 }

# Shutting the engine down would also stop any other Linux on this PC, so leave it alone if one is running.
$running = (& $wsl --list --running --quiet 2>$null) -replace "`0", ''
$others = @($running | Where-Object { $_ -match '^\s*[A-Za-z0-9._-]+\s*$' -and $_.Trim() -ne $houseDistro })
if ($others.Count -gt 0) { Note "another Linux ($($others[0].Trim())) is running, left the engine on"; exit 0 }

& $wsl --shutdown
Note 'turned the engine off'
