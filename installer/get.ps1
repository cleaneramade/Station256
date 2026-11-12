<#
    get.ps1 - the one-line entry point.

    This is what the published command runs:

        irm https://raw.githubusercontent.com/<owner>/<repo>/main/installer/get.ps1 | iex

    It downloads the newest release (the plain source zip GitHub makes for the tag),
    unpacks it somewhere temporary, and hands over to install.ps1. Nothing is
    installed by this file itself.

    Switches are passed on, so this works too:

        & ([scriptblock]::Create((irm <url>))) -DryRun

    For testing, -Source <folder> installs from a folder on this PC instead of
    downloading anything. The folder is the source tree (it holds installer\).

    Built for Windows PowerShell 5.1.
#>

[CmdletBinding()]
param(
    [switch]$AskOnly,
    [switch]$DryRun,
    [switch]$CheckOnly,
    [switch]$Fresh,
    [switch]$Yes,
    [string]$DistroName = '',
    [string]$Source  = '',
    # The ONE place the GitHub repo is named (owner/name). The public export rewrites this line.
    [string]$Repo    = 'YOUR_GITHUB_USER/Station256',
    [string]$Version = 'latest'
)

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '  Station 256 - fetching the installer' -ForegroundColor Cyan
Write-Host ''

$work = ''
if ($Source) {
    # Local test: no download, no unpacking.
    if (-not (Test-Path $Source)) {
        Write-Host ('  That folder does not exist: ' + $Source) -ForegroundColor Red
        exit 1
    }
    $work = (Resolve-Path $Source).Path
}
else {
    # GitHub needs TLS 1.2, and PowerShell 5.1 does not always pick it by default.
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    }
    catch {
        # Older .NET - carry on and hope the default works.
    }

    # -----------------------------------------------------------------------
    # Work out what to download
    # -----------------------------------------------------------------------
    $headers = @{ 'User-Agent' = 'station-256-installer' }

    if ($Version -eq 'latest') {
        $api = 'https://api.github.com/repos/' + $Repo + '/releases/latest'
        try {
            $release = Invoke-RestMethod -Uri $api -Headers $headers
            $tag = $release.tag_name
        }
        catch {
            Write-Host '  Could not reach GitHub to find the newest version.' -ForegroundColor Red
            Write-Host ('  Tried: ' + $api) -ForegroundColor DarkGray
            Write-Host '  Check your internet, or download the zip by hand from:' -ForegroundColor Yellow
            Write-Host ('  https://github.com/' + $Repo + '/releases') -ForegroundColor Yellow
            exit 1
        }
    }
    else {
        $tag = $Version
    }

    Write-Host ('  Version: ' + $tag) -ForegroundColor Gray

    $zipUrl = 'https://github.com/' + $Repo + '/archive/refs/tags/' + $tag + '.zip'

    # -----------------------------------------------------------------------
    # Download and unpack
    # -----------------------------------------------------------------------
    $work = Join-Path $env:TEMP ('station256-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $zip = Join-Path $work 'station-256.zip'

    Write-Host '  Downloading...' -ForegroundColor Gray
    try {
        Invoke-WebRequest -Uri $zipUrl -OutFile $zip -Headers $headers -UseBasicParsing
    }
    catch {
        Write-Host '  Download failed.' -ForegroundColor Red
        Write-Host ('  ' + $zipUrl) -ForegroundColor DarkGray
        exit 1
    }

    Write-Host '  Unpacking...' -ForegroundColor Gray
    try {
        Expand-Archive -Path $zip -DestinationPath $work -Force
    }
    catch {
        Write-Host '  Could not unpack the download. The file may be incomplete.' -ForegroundColor Red
        exit 1
    }
}

# Find installer\install.ps1. A local folder holds it directly; a source zip adds a
# folder level on top.
$installer = $null
$direct = Join-Path $work 'installer\install.ps1'
if (Test-Path $direct) {
    $installer = Get-Item $direct
}
else {
    $installer = Get-ChildItem -Path $work -Filter 'install.ps1' -Recurse -File |
                 Where-Object { $_.Directory.Name -eq 'installer' } |
                 Select-Object -First 1
}

if (-not $installer) {
    Write-Host '  Could not find installer\install.ps1 in it.' -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# Hand over
# ---------------------------------------------------------------------------
Write-Host ('  Ready: ' + $installer.FullName) -ForegroundColor DarkGray

$pass = @{}
if ($AskOnly)    { $pass['AskOnly']    = $true }
if ($DryRun)     { $pass['DryRun']     = $true }
if ($CheckOnly)  { $pass['CheckOnly']  = $true }
if ($Fresh)      { $pass['Fresh']      = $true }
if ($Yes)        { $pass['Yes']        = $true }
if ($DistroName) { $pass['DistroName'] = $DistroName }

& $installer.FullName @pass

if (-not $Source) {
    Write-Host ''
    Write-Host ('  Installer files are in ' + $work) -ForegroundColor DarkGray
    Write-Host '  You can delete that folder whenever you like.' -ForegroundColor DarkGray
}
