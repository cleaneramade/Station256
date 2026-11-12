# wsl.ps1 - safe ways to talk to WSL and to run things inside the house.
# PowerShell 5.1 safe.
#
# Why these helpers exist:
#   * wsl.exe launched from Windows strips quotes and expands $, so inline
#     bash one-liners get mangled. Everything here goes in through stdin
#     instead, as a whole script file, byte for byte.
#   * /mnt/c does not exist once the Windows door is shut, so a script cannot
#     simply be left on C: and run by path.
#   * wsl.exe writes UTF-16 to the console, which turns into spaced-out
#     letters when PowerShell captures it. Output gets cleaned up here.
#   * A native program writing to stderr becomes a terminating error when
#     $ErrorActionPreference is 'Stop'. wsl.exe does that routinely - e2fsck
#     chatter during a resize, for one - so every native call goes through
#     Invoke-Native, which turns that off for the length of the call and
#     reports the real exit code instead.
#
# Names here are prefixed with Wsl/House so they cannot collide with a script
# parameter in install.ps1. See the note at the top of phases.ps1.

$script:WslDistro = 'Station256'

$script:WslAppDir = ''

function Set-HouseDistro {
    param([string]$Name, [string]$AppDir = '')
    $script:WslDistro = $Name
    $script:WslAppDir = $AppDir
}

function Get-HouseDistro {
    return $script:WslDistro
}

# Every Windows-side name the installer sets, in one place. The default Linux
# (Station256) gets the plain names. Any other -DistroName is a try-out and gets
# its own names, so it can never touch a real Station 256 on the same PC.
function Get-HouseNames {
    param([string]$Distro = (Get-HouseDistro))
    $isTest = ($Distro -ne 'Station256')
    $appDir = $script:WslAppDir
    if (-not $appDir) {
        $appDir = Join-Path $env:LOCALAPPDATA 'LinuxHouse'
        if ($isTest) { $appDir = $appDir + '-' + $Distro }
    }
    $sfx  = ''
    $menu = 'LinuxHouse'
    if ($isTest) { $sfx = ' (' + $Distro + ')'; $menu = 'LinuxHouse-' + $Distro }
    return @{
        isTest   = $isTest
        appDir   = $appDir
        lnkName  = ('Station 256' + $sfx + '.lnk')
        runName  = ('Station 256 sleep' + $sfx)
        menuKeys = @(('HKCU:\Software\Classes\Directory\Background\shell\' + $menu),
                     ('HKCU:\Software\Classes\Drive\shell\' + $menu))
    }
}

# wsl.exe output comes back as UTF-16 bytes read as ANSI, which looks like
# "U b u n t u". Strip the stray nulls so it can be matched on.
function Clear-WslText {
    param($Lines)
    $out = @()
    foreach ($l in $Lines) {
        if ($null -eq $l) { continue }
        $out += ([string]$l -replace "`0", '')
    }
    return $out
}

# Runs a native program without letting its stderr become a thrown error.
# Returns: @{ code = <exit code>; output = <string[]> }
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$Arguments = @()
    )
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw  = & $Exe @Arguments 2>&1
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
        return @{ code = $code; output = (Clear-WslText $raw) }
    }
    finally {
        $ErrorActionPreference = $old
    }
}

function Invoke-Wsl {
    param([string[]]$Arguments)
    return Invoke-Native -Exe 'wsl.exe' -Arguments $Arguments
}

function Test-WslPresent {
    $cmd = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { return $false }
    $r = Invoke-Wsl -Arguments @('--status')
    if ($r.code -eq 0) { return $true }
    # Older builds have no --status but still work.
    $r2 = Invoke-Wsl -Arguments @('--list', '--quiet')
    return ($r2.code -eq 0)
}

function Test-DistroExists {
    param([string]$Name = (Get-HouseDistro))
    $r = Invoke-Wsl -Arguments @('--list', '--quiet')
    foreach ($l in $r.output) {
        if ($l.Trim() -eq $Name) { return $true }
    }
    return $false
}

function Test-DistroRunning {
    param([string]$Name = (Get-HouseDistro))
    $r = Invoke-Wsl -Arguments @('--list', '--running', '--quiet')
    foreach ($l in $r.output) {
        if ($l.Trim() -eq $Name) { return $true }
    }
    return $false
}

# Runs a whole bash script inside the house.
#
# The script is written to a Windows temp file with Unix line endings and no
# BOM, then fed to `bash -s` through stdin by cmd.exe. Nothing is quoted on a
# command line, so passwords and $ signs survive intact.
#
# Returns a hashtable: ok (bool), code (int), output (string[]).
function Invoke-HouseScript {
    param(
        [Parameter(Mandatory = $true)][string]$Script,
        [string]$AsUser = '',
        [switch]$Quiet
    )

    $tmp = Join-Path $env:TEMP ("house-" + [guid]::NewGuid().ToString('N') + ".sh")
    $lf  = $Script -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($tmp, $lf, (New-Object System.Text.UTF8Encoding $false))

    try {
        $userArg = ''
        if ($AsUser) { $userArg = '-u ' + $AsUser + ' ' }
        $line = 'wsl -d ' + $script:WslDistro + ' ' + $userArg + '-- bash -s < "' + $tmp + '"'

        $r    = Invoke-Native -Exe 'cmd.exe' -Arguments @('/c', $line)
        $code = $r.code
        $out  = $r.output

        if (-not $Quiet) {
            foreach ($l in $out) {
                if ($l.Trim().Length -gt 0) { Write-Info $l.TrimEnd() }
            }
        }

        return @{ ok = ($code -eq 0); code = $code; output = $out }
    }
    finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

# Same, but throws with a clear message when the script fails.
function Invoke-HouseScriptOrFail {
    param(
        [Parameter(Mandatory = $true)][string]$Script,
        [string]$AsUser = '',
        [string]$What = 'a step inside the house',
        [switch]$Quiet
    )
    $r = Invoke-HouseScript -Script $Script -AsUser $AsUser -Quiet:$Quiet
    if (-not $r.ok) {
        if ($Quiet) {
            foreach ($l in $r.output) {
                if ($l.Trim().Length -gt 0) { Write-Info $l.TrimEnd() }
            }
        }
        throw ($What + " failed (exit code " + $r.code + ").")
    }
    return $r
}

# Reads one line of output, trimmed. Handy for version checks and yes/no probes.
function Get-HouseValue {
    param([string]$Script, [string]$AsUser = '')
    $r = Invoke-HouseScript -Script $Script -AsUser $AsUser -Quiet
    foreach ($l in $r.output) {
        if ($l.Trim().Length -gt 0) { return $l.Trim() }
    }
    return ''
}

function Test-HouseUserExists {
    param([string]$Name)
    $v = Get-HouseValue -Script ("id -u " + $Name + " >/dev/null 2>&1 && echo YES || echo NO") -AsUser 'root'
    return ($v -eq 'YES')
}

function Test-HousePath {
    param([string]$Path, [string]$AsUser = 'root')
    $v = Get-HouseValue -Script ("test -e '" + $Path + "' && echo YES || echo NO") -AsUser $AsUser
    return ($v -eq 'YES')
}

# Stops the distro so a changed group membership (docker) is picked up, and so
# /etc/wsl.conf is re-read. Much lighter than asking the user to log out.
function Restart-House {
    Write-Info "Restarting the house so the new settings take effect..."
    $null = Invoke-Wsl -Arguments @('--terminate', $script:WslDistro)
    Start-Sleep -Seconds 2
    $null = Get-HouseValue -Script 'echo up' -AsUser 'root'
}

# Stops the house. The whole WSL engine is shut down only when no other distro
# is running, so someone else's Linux is never switched off by this installer.
# Returns $true when the whole engine was shut down.
function Get-OtherRunningCount {
    $others = 0
    $r = Invoke-Wsl -Arguments @('--list', '--running', '--quiet')
    foreach ($l in $r.output) {
        $n = $l.Trim()
        # "There are no running distributions" has spaces; a distro name has none.
        if (($n -match '^[A-Za-z0-9._-]+$') -and ($n -ne $script:WslDistro)) { $others++ }
    }
    return $others
}

function Stop-House {
    $others = Get-OtherRunningCount
    if ($others -eq 0) {
        $null = Invoke-Wsl -Arguments @('--shutdown')
        return $true
    }
    $null = Invoke-Wsl -Arguments @('--terminate', $script:WslDistro)
    return $false
}
