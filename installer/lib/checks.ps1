# checks.ps1 - phase 0. Looks at the machine before anything is changed.
# Read-only. Safe to run any time.
# PowerShell 5.1 safe.

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Builds the argument text for the elevated copy of install.ps1. Bound is a hashtable
# of the parameters to carry over: $true switches become -Name, strings become
# -Name "value". The script path is quoted so folders with spaces work.
function Get-ElevatedArguments {
    param([string]$ScriptPath, [hashtable]$Bound)
    $parts = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', ('"' + $ScriptPath + '"'))
    foreach ($k in ($Bound.Keys | Sort-Object)) {
        $v = $Bound[$k]
        if ($v -is [bool]) {
            if ($v) { $parts += ('-' + $k) }
        }
        elseif ($v) {
            $parts += ('-' + $k)
            $parts += ('"' + $v + '"')
        }
    }
    return ($parts -join ' ')
}

# Opens a new administrator PowerShell running the same install.ps1. Returns $true if
# Windows started it, $false if the user said No.
function Invoke-ElevatedRelaunch {
    param([string]$ScriptPath, [hashtable]$Bound)
    Write-Line ''
    Write-Line "   Windows will ask for permission to turn on Linux. Click Yes." 'White'
    Write-Line ''
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList (Get-ElevatedArguments -ScriptPath $ScriptPath -Bound $Bound) | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Test-PendingReboot {
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
    )
    foreach ($k in $keys) {
        if (Test-Path $k) { return $true }
    }
    $pfro = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
    if ($pfro -and $pfro.PendingFileRenameOperations) { return $true }
    return $false
}

# Returns a hashtable of what we found, plus a list of blocking problems.
function Invoke-PreflightChecks {

    Write-Banner "Checking your PC"

    $found    = @{}
    $blockers = @()

    # --- PowerShell -------------------------------------------------------
    $psv = $PSVersionTable.PSVersion
    $found['psVersion'] = $psv.ToString()
    if ($psv.Major -lt 5) {
        Write-Fail ("PowerShell " + $psv.ToString() + " is too old. Version 5.1 or newer is needed.")
        $blockers += 'PowerShell is older than 5.1.'
    }
    else {
        Write-Ok ("PowerShell " + $psv.ToString())
    }

    # --- 64-bit -----------------------------------------------------------
    if (-not [Environment]::Is64BitOperatingSystem) {
        Write-Fail "This is a 32-bit Windows. WSL2 needs 64-bit."
        $blockers += 'Windows is 32-bit.'
    }
    else {
        Write-Ok "64-bit Windows"
    }

    # --- Windows build ----------------------------------------------------
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $build = 0
    if ($os) { $build = [int]($os.BuildNumber) }
    $found['windowsBuild'] = $build
    $found['windowsName']  = ''
    if ($os) { $found['windowsName'] = $os.Caption }

    if ($build -eq 0) {
        Write-Warn "Could not read your Windows version. Carrying on anyway."
    }
    elseif ($build -lt 19045) {
        Write-Fail ("Windows build " + $build + " is too old. Build 19045 or newer is needed.")
        $blockers += 'Windows is too old for the WSL app store version.'
    }
    else {
        Write-Ok ($found['windowsName'] + " (build " + $build + ")")
    }

    # --- Virtualisation ---------------------------------------------------
    # Two things matter: the CPU feature is on in the BIOS, and Windows can see it.
    $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    $cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1

    $hyperVisorPresent = $false
    if ($cs) { $hyperVisorPresent = [bool]$cs.HypervisorPresent }

    $firmwareOn = $true
    if ($cpu -and ($null -ne $cpu.VirtualizationFirmwareEnabled)) {
        $firmwareOn = [bool]$cpu.VirtualizationFirmwareEnabled
    }

    $found['hypervisorPresent'] = $hyperVisorPresent
    if ($hyperVisorPresent) {
        Write-Ok "Virtualisation is on"
    }
    elseif (-not $firmwareOn) {
        Write-Fail "Virtualisation is turned off in your BIOS."
        Write-Info "Restart, open BIOS setup, and turn on Intel VT-x or AMD-V."
        $blockers += 'Virtualisation is off in the BIOS.'
    }
    else {
        Write-Warn "Could not confirm virtualisation is on."
        Write-Info "If WSL fails to install, this is the first thing to check in your BIOS."
    }

    # --- Memory -----------------------------------------------------------
    $ramGb = 0
    if ($cs) { $ramGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1) }
    $found['ramGb'] = $ramGb
    if ($ramGb -gt 0 -and $ramGb -lt 7.5) {
        Write-Warn ([string]$ramGb + " GB of memory. This will work but feel slow. 8 GB is the sensible floor.")
    }
    elseif ($ramGb -gt 0) {
        Write-Ok ([string]$ramGb + " GB of memory")
    }

    # --- Disk -------------------------------------------------------------
    $c = Get-PSDrive -Name C -ErrorAction SilentlyContinue
    $freeGb = 0
    if ($c) { $freeGb = [int][math]::Floor($c.Free / 1GB) }
    $found['freeGb'] = $freeGb
    if ($freeGb -lt 30) {
        Write-Fail ("Only " + $freeGb + " GB free on C:. At least 30 GB is needed.")
        $blockers += 'Not enough free disk space.'
    }
    elseif ($freeGb -lt 80) {
        Write-Warn ([string]$freeGb + " GB free on C:. Enough to install, but tight for real projects.")
    }
    else {
        Write-Ok ([string]$freeGb + " GB free on C:")
    }

    # --- What is already installed ---------------------------------------
    # Checked before the admin test, because admin rights are only needed to
    # turn the WSL feature on. If WSL is already here, they are not needed.
    $found['wslPresent']   = Test-WslPresent
    $found['distroExists'] = $false
    if ($found['wslPresent']) {
        $found['distroExists'] = Test-DistroExists
    }
    # Only turning on the WSL feature needs admin. Adding a named Linux to WSL that is
    # already on does not, so a missing distro is not a reason to ask.
    $needsWslInstall = (-not $found['wslPresent'])

    # --- Admin ------------------------------------------------------------
    $admin = Test-IsAdmin
    $found['isAdmin'] = $admin
    if ($admin) {
        Write-Ok "Running as administrator"
    }
    elseif ($needsWslInstall) {
        # install.ps1 answers this blocker by relaunching itself as administrator.
        Write-Warn "Not running as administrator, and turning on WSL (Windows' Linux feature) needs it."
        $blockers += 'Not running as administrator.'
    }
    else {
        Write-Skip "Not an administrator, but WSL is already on, so that is fine."
    }

    # --- Internet ---------------------------------------------------------
    $online = $false
    try {
        $online = Test-Connection -ComputerName '8.8.8.8' -Count 1 -Quiet -ErrorAction Stop
    }
    catch {
        $online = $false
    }
    $found['online'] = $online
    if ($online) {
        Write-Ok "Internet is reachable"
    }
    else {
        Write-Warn "Could not reach the internet. The install needs it to download Linux and Docker."
    }

    # --- Pending reboot ---------------------------------------------------
    if (Test-PendingReboot) {
        Write-Warn "Windows is waiting for a restart from something else."
        Write-Info "Restart first, or the WSL install may fail part way through."
    }

    # --- Report what is already here --------------------------------------
    if ($found['distroExists']) {
        Write-Skip ("WSL and the '" + (Get-HouseDistro) + "' Linux are already installed. Those steps will be skipped.")
    }
    elseif ($found['wslPresent']) {
        Write-Skip ("WSL is already installed. The '" + (Get-HouseDistro) + "' Linux is not.")
    }

    return @{ found = $found; blockers = $blockers }
}
