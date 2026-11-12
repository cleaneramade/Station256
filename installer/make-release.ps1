<#
    make-release.ps1 - packs the installer, ready to upload.

    Run it from this folder:
        powershell -NoProfile -ExecutionPolicy Bypass -File make-release.ps1

    It does three things:
      1. Copies the house code and the Windows helper scripts into payload/
      2. Checks nothing secret or licensed slipped in
      3. Builds station-256-<version>.zip next to this script

    The source is the repo this script is in (or a copy of the house one level up).

    Built for Windows PowerShell 5.1.
#>

[CmdletBinding()]
param(
    [string]$Version = '',
    [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'

$here   = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$parent = Split-Path $here -Parent

# This folder lives in two places, so work out which one we are in.
#
#   1. Inside the house repo:   ~/house/installer  -> house code is the parent
#   2. In the backup folder:    <backup>/installer -> house code is <backup>\house
#
$layout = ''
if (Test-Path (Join-Path $parent 'panel\main.js')) {
    $layout   = 'repo'
    $houseSrc = $parent
    $winSrc   = Join-Path $parent 'windows'
}
elseif (Test-Path (Join-Path $parent 'house\panel\main.js')) {
    $layout   = 'backup'
    $houseSrc = Join-Path $parent 'house'
    $winSrc   = Join-Path $parent 'windows\LinuxHouse'
}
else {
    Write-Host '  Cannot tell where this installer folder lives.' -ForegroundColor Red
    Write-Host '  Expected either ../panel/main.js (inside the house repo)' -ForegroundColor DarkGray
    Write-Host '  or ../house/panel/main.js (in the backup folder).' -ForegroundColor DarkGray
    exit 1
}

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

Say ''
Say '  Station 256 - building the installer package' 'Cyan'
Say ''

# ---------------------------------------------------------------------------
# Version
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = 'v0.1.0-' + (Get-Date -Format 'yyyyMMdd')
}
Say ('  Version: ' + $Version)

# ---------------------------------------------------------------------------
# 0. Nothing ships unless the selftest passes
# ---------------------------------------------------------------------------
Say ''
Say '  Running the selftest...'
$self = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'lib\selftest.ps1')
if ($LASTEXITCODE -ne 0) {
    $self | Select-Object -Last 25 | ForEach-Object { Say ('  ' + $_) 'DarkGray' }
    Say ''
    Say '  STOPPED. The selftest failed, so nothing was built.' 'Red'
    exit 1
}
$summary = $self | Select-String 'checks passed' | Select-Object -First 1
Say ('  ' + ([string]$summary).Trim()) 'Green'

# ---------------------------------------------------------------------------
# 1. Build the payload
# ---------------------------------------------------------------------------
$payload = Join-Path $here 'payload'
if (Test-Path $payload) { Remove-Item $payload -Recurse -Force }
New-Item -ItemType Directory -Force -Path $payload | Out-Null

Say ('  Layout:  ' + $layout)
Say ('  House:   ' + $houseSrc)
Say ('  Windows: ' + $winSrc)

if (-not (Test-Path $houseSrc)) {
    Say ('  Missing: ' + $houseSrc) 'Red'
    Say '  Run this from inside the Station 256 repo.' 'Yellow'
    exit 1
}
if (-not (Test-Path $winSrc)) {
    Say ('  Missing: ' + $winSrc) 'Red'
    exit 1
}

Say ''
Say '  Copying the house code...'
# Left out on purpose:
#   node_modules - npm install rebuilds it on the target PC for the right arch
#   .git         - keeps the download small
#   installer    - the installer is already at the top level of the zip, and
#                  copying it would nest payload/ inside itself
# editor\.next is the video editor's build cache; its built app (editor\out) goes along.
robocopy $houseSrc (Join-Path $payload 'house') /E /XD node_modules .git installer (Join-Path $houseSrc 'editor\.next') /NFL /NDL /NJH /NJS /R:2 /W:2 | Out-Null
if ($LASTEXITCODE -ge 8) { Say '  Copy failed.' 'Red'; exit 1 }

Say '  Copying the Windows helper scripts...'
robocopy $winSrc (Join-Path $payload 'windows') /E /XF sleep-at-login.log install-state.json /NFL /NDL /NJH /NJS /R:2 /W:2 | Out-Null
if ($LASTEXITCODE -ge 8) { Say '  Copy failed.' 'Red'; exit 1 }

# ---------------------------------------------------------------------------
# 2. Safety sweep
# ---------------------------------------------------------------------------
Say ''
Say '  Checking nothing private got in...'

$problems = @()

# Anything that looks like a secret
$badNames = @('claude-token','link-token','*.pem','*.key','.env','id_rsa','id_ed25519')
foreach ($pattern in $badNames) {
    $hits = Get-ChildItem $payload -Recurse -File -Filter $pattern -ErrorAction SilentlyContinue
    foreach ($h in $hits) { $problems += ('secret-looking file: ' + $h.FullName.Replace($payload, '')) }
}

# Microsoft fonts must never ship. Selawik is the open stand-in and is fine.
$fontHits = Get-ChildItem $payload -Recurse -File -Include '*.ttf','*.otf','*.ttc' -ErrorAction SilentlyContinue
foreach ($f in $fontHits) {
    if ($f.Name -notlike 'selaw*') {
        $problems += ('font that may be licensed: ' + $f.Name)
    }
}

# A compiled launcher would get eaten by antivirus, and we decided never to ship one.
$exeHits = Get-ChildItem $payload -Recurse -File -Include '*.exe','*.dll' -ErrorAction SilentlyContinue
foreach ($e in $exeHits) { $problems += ('compiled file: ' + $e.Name) }

if ($problems.Count -gt 0) {
    Say ''
    Say '  STOPPED. These must not be published:' 'Red'
    foreach ($p in $problems) { Say ('    - ' + $p) 'Red' }
    Say ''
    Say '  Remove them from the payload and run this again.' 'Yellow'
    exit 1
}
Say '  Clean. No secrets, no licensed fonts, no compiled files.' 'Green'

# ---------------------------------------------------------------------------
# 3. Write the version file
# ---------------------------------------------------------------------------
$meta = @{
    version  = $Version
    built    = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')
    houseRef = 'unknown'
}
# Only the backup folder has this; inside the repo, read the commit from git.
#
# git may not be installed on the Windows side, so asking Windows
# for it throws. Ask the house instead, and settle for "unknown" if even that
# does not answer - the commit id is a label, not something the build needs.
$liveState = Join-Path $parent 'restore\live-state.txt'
if ($layout -eq 'repo') {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $gitRef = & wsl.exe -d Ubuntu -- bash -lc 'git -C ~/house rev-parse --short HEAD' 2>&1
        if ($LASTEXITCODE -eq 0 -and $gitRef) {
            $clean = ([string]$gitRef -replace "`0", '').Trim()
            if ($clean -match '^[0-9a-f]{7,40}$') { $meta['houseRef'] = $clean }
        }
    }
    catch {
        # Leave it as "unknown".
    }
    finally { $ErrorActionPreference = $old }
}
elseif (Test-Path $liveState) {
    $line = Select-String -Path $liveState -Pattern '^\s*([0-9a-f]{7,40})\s+\(HEAD' -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($line) { $meta['houseRef'] = $line.Matches[0].Groups[1].Value }
}
$meta | ConvertTo-Json | Set-Content (Join-Path $here 'version.json') -Encoding utf8
Say ('  House code commit: ' + $meta['houseRef'])

# ---------------------------------------------------------------------------
# 4. Zip it
# ---------------------------------------------------------------------------
if ($SkipZip) {
    Say ''
    Say '  Payload built. Zip skipped.' 'Green'
    exit 0
}

$zipName = 'station-256-' + $Version + '.zip'
$zipPath = Join-Path $here $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Say ''
Say '  Building the zip...'

# Stage only what belongs in the release.
$stage = Join-Path $env:TEMP ('s256-rel-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
    $root = Join-Path $stage 'station-256'
    New-Item -ItemType Directory -Force -Path $root | Out-Null

    Copy-Item (Join-Path $here 'install.ps1')  $root -Force
    Copy-Item (Join-Path $here 'get.ps1')      $root -Force
    Copy-Item (Join-Path $here 'README.md')    $root -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $here 'STATUS.md')    $root -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $here 'version.json') $root -Force
    Copy-Item (Join-Path $here 'lib')          $root -Recurse -Force
    Copy-Item $payload                         $root -Recurse -Force

    # Bring the written-up docs along, so the download explains itself.
    # They live in the backup folder, not in the house repo, so this is
    # skipped when building from inside the repo.
    $docsSrc = Join-Path $parent 'docs'
    if (Test-Path $docsSrc) { Copy-Item $docsSrc $root -Recurse -Force }
    else { Say '  (no docs folder here - building without it)' 'DarkGray' }

    Compress-Archive -Path (Join-Path $stage 'station-256') -DestinationPath $zipPath -Force
}
finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

$sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Say ''
Say ('  Built: ' + $zipPath) 'Green'
Say ('  Size:  ' + $sizeMb + ' MB') 'Green'
Say ''
Say '  Next: upload that zip as a GitHub release asset, tagged:'
Say ('    ' + $Version) 'White'
Say ''
Say '  Then this works for anyone:' 'Gray'
Say '    irm https://raw.githubusercontent.com/<owner>/<repo>/main/installer/get.ps1 | iex' 'White'
Say ''
