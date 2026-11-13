# prompts.ps1 - every question the installer asks, and the check on each answer.
#
# Only three things are ever asked: how much storage, a drive letter (and only
# when L: is not usable), and a password. Everything else has a fixed default.
#
# The pattern throughout: ask, check, explain the real problem, ask again.
# Nothing here changes the machine. Safe to run on its own (install.ps1 -AskOnly).
# PowerShell 5.1 safe.

# ---------------------------------------------------------------------------
# Drive letter
# ---------------------------------------------------------------------------

# Looks at one letter. Returns @{ state = 'free' | 'reuse' | 'taken'; why = '...' }.
# 'reuse' means the letter already points at THIS house, so it can be kept.
function Get-DriveLetterState {
    param([string]$Letter)

    if ($Letter -notmatch '^[A-Z]$') {
        return @{ state = 'taken'; why = 'That is not a drive letter. Use one letter, A to Z.' }
    }
    if ($Letter -eq 'A' -or $Letter -eq 'B') {
        return @{ state = 'taken'; why = ($Letter + ": is reserved by Windows for floppy drives.") }
    }
    if ($Letter -eq 'C') {
        return @{ state = 'taken'; why = 'C: is your Windows drive.' }
    }

    $mine = '*wsl.localhost\' + (Get-HouseDistro) + '*'

    # Check the saved network mappings FIRST. A letter already pointing at
    # the house is the answer we want, not a clash - and that letter also
    # shows up as a real drive while the house is awake, so testing for a
    # real drive first would wrongly reject it.
    if (Test-Path ("HKCU:\Network\" + $Letter)) {
        $remote = (Get-ItemProperty ("HKCU:\Network\" + $Letter) -ErrorAction SilentlyContinue).RemotePath
        if ($remote -like $mine) { return @{ state = 'reuse'; why = ($Letter + ": is already mapped to the house.") } }
        return @{ state = 'taken'; why = ($Letter + ": is already mapped to " + $remote + ".") }
    }

    # A live mapping that was never saved shows here but not in the registry.
    $net = Invoke-Native -Exe 'cmd.exe' -Arguments @('/c', ('net use ' + $Letter + ':'))
    if (($net.output -join ' ') -like $mine) {
        return @{ state = 'reuse'; why = ($Letter + ": is already connected to the house.") }
    }

    # Taken as a real drive?
    if (Test-Path ($Letter + ':\')) {
        $label = ''
        $vol = Get-Volume -DriveLetter $Letter -ErrorAction SilentlyContinue
        if ($vol -and $vol.FileSystemLabel) { $label = ' (' + $vol.FileSystemLabel + ')' }
        return @{ state = 'taken'; why = ($Letter + ": is already in use" + $label + ".") }
    }

    # Taken by a subst mapping?
    $subst = Invoke-Native -Exe 'cmd.exe' -Arguments @('/c', 'subst')
    foreach ($l in $subst.output) {
        if ($l -like ($Letter + ':\*')) {
            return @{ state = 'taken'; why = ($Letter + ": is used by a subst mapping.") }
        }
    }

    return @{ state = 'free'; why = '' }
}

# Uses the default letter without a word when it can. Asks only when it cannot.
function Read-DriveLetter {
    param([string]$Default = 'L')

    $first = Get-DriveLetterState -Letter $Default
    if ($first.state -eq 'free')  { Write-Ok ($Default + ": is free. The house will live there."); return $Default }
    if ($first.state -eq 'reuse') { Write-Ok ($first.why + " Reusing it."); return $Default }

    Write-Line ''
    Write-Wrapped ("The house needs a drive letter so it shows up in File Explorer. " + $first.why + " Pick another letter.") 'Gray' 3

    $tries = 0
    while ($true) {
        $tries++
        Assert-CanAsk -Tries $tries -What 'drive letter'
        $answer = Read-Host "   Drive letter for the house"
        if ([string]::IsNullOrWhiteSpace($answer)) { Write-Warn "Type one letter, like M."; continue }

        $letter = $answer.Trim().TrimEnd(':').ToUpper()
        $s = Get-DriveLetterState -Letter $letter
        if ($s.state -eq 'taken') { Write-Warn ($s.why + " Pick another letter."); continue }
        if ($s.state -eq 'reuse') { Write-Ok ($s.why + " Reusing it."); return $letter }

        Write-Ok ($letter + ": is free. The house will live there.")
        return $letter
    }
}

# ---------------------------------------------------------------------------
# Linux user name - never asked. Taken from the Windows name.
# ---------------------------------------------------------------------------
function Get-LinuxUserName {
    param([string]$WindowsName = $env:USERNAME)

    # Names Linux already uses. Taking one of these breaks the system.
    $reserved = @('root','daemon','bin','sys','sync','games','man','lp','mail','news',
                  'uucp','proxy','backup','list','irc','nobody','systemd','docker',
                  'dev','ubuntu','admin','test')

    $name = ([string]$WindowsName).ToLower() -replace '[^a-z0-9_-]', ''
    if ($name.Length -gt 32) { $name = $name.Substring(0, 32) }

    if (($name -notmatch '^[a-z][a-z0-9_-]*$') -or ($reserved -contains $name)) { return 'station' }
    return $name
}


# ---------------------------------------------------------------------------
# Password - asked twice, never saved to disk
# ---------------------------------------------------------------------------
function Read-LinuxPassword {
    param([string]$UserName)

    Write-Line ''
    Write-Wrapped ("Set a password for '" + $UserName + "'. You will need it when the house asks permission to change system settings. It is never written to a file.") 'Gray' 3

    $tries = 0
    while ($true) {
        $tries++
        Assert-CanAsk -Tries $tries -What 'password'
        if ([Console]::IsInputRedirected) {
            # Answers are piped in (a test). Windows cannot hide input that is not typed.
            $p1 = Read-Host ("   Password for " + $UserName)
            $p2 = Read-Host "   Type it again"
        }
        else {
            $first  = Read-Host ("   Password for " + $UserName) -AsSecureString
            $second = Read-Host "   Type it again" -AsSecureString
            $p1 = ConvertFrom-SecureStringPlain $first
            $p2 = ConvertFrom-SecureStringPlain $second
        }

        if ($p1 -ne $p2) {
            Write-Warn "Those two do not match. Try again."
            continue
        }
        if ($p1.Length -lt 8) {
            Write-Warn "Too short. Use at least 8 characters."
            continue
        }
        if ($p1 -match '[:\n\r]') {
            Write-Warn "A colon or line break will not work here. Try again."
            continue
        }

        Write-Ok "Password set."
        return $p1
    }
}

# Turns a SecureString back into plain text. Needed because we have to hand the
# password to `chpasswd` inside Linux. Freed straight after use.
function ConvertFrom-SecureStringPlain {
    param([System.Security.SecureString]$Secure)
    $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

# ---------------------------------------------------------------------------
# Disk size for the house
# ---------------------------------------------------------------------------
function Read-HouseSizeGb {
    param([int]$Default = 250)

    $drive = Get-PSDrive -Name C -ErrorAction SilentlyContinue
    $freeGb = 0
    if ($drive) { $freeGb = [int][math]::Floor($drive.Free / 1GB) }

    # Leave Windows 50 GB of breathing room.
    $maxGb = $freeGb - 50
    if ($maxGb -lt 20) { $maxGb = 20 }
    if ($Default -gt $maxGb) { $Default = $maxGb }

    Write-Line ''
    Write-Wrapped "Allocation space for the drive. This is the most the house drive is ever allowed to grow to. It is a limit, not a reservation - it only takes up what it actually uses, and you can change it later." 'Gray' 3
    Write-Line ''
    Write-Info ("Space available on C:   " + $freeGb + " GB")
    Write-Info ("Most you can allocate   " + $maxGb + " GB  (50 GB is kept back for Windows)")
    Write-Info  "Smallest that works     20 GB"

    $tries = 0
    while ($true) {
        $tries++
        Assert-CanAsk -Tries $tries -What 'allocation space'
        $answer = Read-Host ("   Allocation space for the drive, in GB [" + $Default + "]")
        if ([string]::IsNullOrWhiteSpace($answer)) { $answer = [string]$Default }

        $size = 0
        if (-not [int]::TryParse($answer.Trim(), [ref]$size)) {
            Write-Warn "Not a number. Type a whole number of GB, like 250."
            continue
        }
        if ($size -le 0) {
            Write-Warn "That has to be more than zero. Type a whole number of GB, like 250."
            continue
        }
        if ($size -lt 20) {
            Write-Warn ([string]$size + " GB is too small. 20 GB is the least that works - Docker alone needs most of that.")
            continue
        }
        if ($size -gt $maxGb) {
            Write-Warn ("Not enough space. You asked for " + [string]$size + " GB, but only " + [string]$maxGb + " GB can be allocated.")
            Write-Info ("C: has " + $freeGb + " GB free, and 50 GB is kept back for Windows.")
            continue
        }

        Write-Ok ([string]$size + " GB allocated to the house drive.")
        return $size
    }
}

# ---------------------------------------------------------------------------
# The whole flow: storage, drive letter (only if L: is taken). The password
# is asked right after this, by install.ps1.
# ---------------------------------------------------------------------------
function Read-AllAnswers {
    param([hashtable]$Existing = $null)

    $a = @{}
    if ($Existing) { foreach ($k in $Existing.Keys) { $a[$k] = $Existing[$k] } }

    Write-Banner "Two quick questions"
    Write-Wrapped "Nothing is installed until you see the summary and say yes." 'DarkGray' 3

    if (-not $a.ContainsKey('houseSizeGb')) { $a['houseSizeGb'] = Read-HouseSizeGb }
    if (-not $a.ContainsKey('driveLetter')) { $a['driveLetter'] = Read-DriveLetter }

    # Never asked: fixed defaults. A saved answer from an older run is replaced too.
    $a['linuxUser']         = Get-LinuxUserName
    $a['idleMinutes']       = 10
    $a['desktopShortcut']   = $true
    $a['startMenuShortcut'] = $true
    $a['rightClickMenu']    = $true
    $a['sleepAtLogin']      = $true

    return $a
}

# ---------------------------------------------------------------------------
# Review screen
# ---------------------------------------------------------------------------
function Show-AnswerSummary {
    param([hashtable]$A)

    Write-Banner "Here is what I will do"

    $rows = @(
        @('Linux name (WSL)',      (Get-HouseDistro)),
        @('House drive letter',    ($A['driveLetter'] + ':')),
        @('Linux user name',       $A['linuxUser']),
        @('Allocation space',      ([string]$A['houseSizeGb'] + ' GB')),
        @('Sleeps after',          ([string]$A['idleMinutes'] + ' minutes')),
        @('Shortcuts',             'Desktop and Start menu'),
        @('Right-click menu',      ('Open Linux terminal here, on ' + $A['driveLetter'] + ': only')),
        @('Sleep when you log in', (Format-YesNo $A['sleepAtLogin']))
    )
    foreach ($r in $rows) {
        Write-Host ("   " + $r[0].PadRight(24) + $r[1]) -ForegroundColor White
    }

    Write-Line ''
    Write-Wrapped "It will also install: Ubuntu Linux (as its own separate Linux, so any Linux you already have is left alone), Docker and Node.js inside the house. It installs no AI: you choose which AI tools you use, later, inside Station 256. None of that touches your Windows programs." 'DarkGray' 3
    Write-Line ''
}

function Format-YesNo {
    param($Value)
    if ($Value) { return 'yes' }
    return 'no'
}
