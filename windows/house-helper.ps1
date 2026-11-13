# Foundation part: has Windows access whether the Windows door is locked or unlocked,
# because the door only controls the AI in rooms.
# Handles what the house can't do itself: keeping the PC awake while rooms are open,
# and changing the house's storage size.
# Starts when you click Station 256, and ends by itself once the house has gone to sleep.
# It only checks inside the house when the house is already running, so it never wakes it.

# Which Linux is the house? The installer writes house.json beside these scripts. Without it
# the script stops.
if (-not (Test-Path "$PSScriptRoot\house.json")) { Write-Host "Station 256 isn't installed. Run the installer."; exit 1 }
if (Test-Path "$PSScriptRoot\house.json") {
    $houseCfg = Get-Content "$PSScriptRoot\house.json" -Raw | ConvertFrom-Json
    $houseDistro = $houseCfg.distro; $houseUser = $houseCfg.user; $houseDrive = $houseCfg.drive
}

$mutex = New-Object System.Threading.Mutex($false, 'LinuxHouseHelper')
if (-not $mutex.WaitOne(0)) { exit 0 }

Add-Type -Namespace LinuxHouse -Name Power -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint flags);
'@


# Windows' side of snapping, on a live link to the app. See snap-link.cs. It only reaches into the
# house while the app's window is open, which means the house is already awake.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -ReferencedAssemblies System.Drawing, System.Web.Extensions, System.Core, System.Windows.Forms -Path "$here\snap-link.cs"
[void][LinuxHouse.Snap]::SetProcessDPIAware()

$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1

$wsl = 'C:\Program Files\WSL\wsl.exe'
$house = "\\wsl.localhost\$houseDistro"
$state = "$house\home\$houseUser\.local\state\house"
$config = "$house\home\$houseUser\.config\house\windows-helper.json"
$request = "$state\requests\resize"
$utf8 = New-Object System.Text.UTF8Encoding($false)

# Runs WSL with a time limit, so a stuck WSL can't freeze this helper and silently stop everything
# it does. Returns the exit code, or -1 if it had to be stopped, plus what it printed.
function Invoke-Wsl([string]$arguments, [int]$seconds = 60) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $wsl
    $info.Arguments = $arguments
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [System.Text.Encoding]::Unicode
    $info.StandardErrorEncoding = [System.Text.Encoding]::Unicode
    $process = [System.Diagnostics.Process]::Start($info)
    $out = $process.StandardOutput.ReadToEndAsync()
    $err = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($seconds * 1000)) {
        try { $process.Kill() } catch { }
        return @{ Code = -1; Output = "WSL didn't answer within $seconds seconds." }
    }
    return @{ Code = $process.ExitCode; Output = (($out.Result + $err.Result) -replace "`0", '') }
}

function Test-HouseRunning {
    (Invoke-Wsl '--list --running' 30).Output -match ('(?m)^\s*' + [regex]::Escape($houseDistro) + '\b')
}

# The owner's Claude skills and helper agents on Windows go into the house's ~/.claude, where every
# room picks them up (bin/room, room/room-start). Newer files only, nothing is ever deleted
# (no /MIR or /PURGE). synced is Anthropic's built-ins and graphify is installed by the rooms.
# Robocopy's exit codes 0 to 7 mean it worked. A failure here must never stop the helper.
function Sync-ClaudeSkills([string]$from, [string]$to) {
    try {
        $junk = @('/XO', '/XF', '*.bak', '/XD', 'node_modules', '.git', '/R:1', '/W:1', '/NJH', '/NJS', '/NP', '/NFL', '/NDL')
        if (Test-Path "$from\skills") {
            foreach ($skill in Get-ChildItem "$from\skills" -Directory | Where-Object { $_.Name -notin 'synced', 'graphify' }) {
                [void](robocopy $skill.FullName "$to\skills\$($skill.Name)" /E @junk)
            }
        }
        if (Test-Path "$from\agents") { [void](robocopy "$from\agents" "$to\agents" '*.md' @junk) }
    } catch { }
}

# The cursor files Windows is using now go into the house, where panel/make-cursor-theme.py turns
# them into the pointer Station shows, so it matches the rest of Windows. They are Microsoft's
# files: copied on this PC, never shipped. Newer files only, nothing is deleted. A role with no
# file in the registry uses Windows' own built-in shape, so the plain Windows file stands in.
# A failure here must never stop the helper.
function Sync-WindowsCursors([string]$to) {
    try {
        $default = [ordered]@{
            Arrow = 'aero_arrow.cur'; Hand = 'aero_link.cur'; IBeam = 'beam_r.cur'; SizeWE = 'aero_ew.cur'
            SizeNS = 'aero_ns.cur'; SizeNWSE = 'aero_nwse.cur'; SizeNESW = 'aero_nesw.cur'; SizeAll = 'aero_move.cur'
            Crosshair = 'cross_r.cur'; Wait = 'aero_busy.ani'; AppStarting = 'aero_working.ani'; No = 'aero_unavail.cur'
            Help = 'aero_helpsel.cur'
        }
        $key = Get-ItemProperty 'HKCU:\Control Panel\Cursors'
        $roles = [ordered]@{}
        [System.IO.Directory]::CreateDirectory($to) | Out-Null
        foreach ($role in $default.Keys) {
            $file = [Environment]::ExpandEnvironmentVariables([string]$key.$role)
            if (-not ($file -match '\.(cur|ani)$' -and (Test-Path $file))) { $file = "$env:SystemRoot\Cursors\$($default[$role])" }
            $name = Split-Path $file -Leaf  # shortcut: two custom cursors with the same file name in different folders would clash
            $copy = "$to\$name"
            if (-not (Test-Path $copy) -or (Get-Item $file).LastWriteTimeUtc -gt (Get-Item $copy).LastWriteTimeUtc) { Copy-Item $file $copy -Force }
            $roles[$role] = $name
        }
        $size = 32
        if ($key.CursorBaseSize -is [int]) { $size = $key.CursorBaseSize }
        $json = [ordered]@{ baseSize = $size; roles = $roles } | ConvertTo-Json -Compress
        if (-not (Test-Path "$to\cursors.json") -or [System.IO.File]::ReadAllText("$to\cursors.json") -ne $json) {
            [System.IO.File]::WriteAllText("$to\cursors.json", $json, $utf8)
        }
    } catch { }
}

function Set-StayAwake([bool]$on) {
    if ($on) { [void][LinuxHouse.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) }
    else { [void][LinuxHouse.Power]::SetThreadExecutionState($ES_CONTINUOUS) }
}

function Open-Panel {
    Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList "--headless C:\Windows\System32\wsl.exe -d $houseDistro --cd /home/$houseUser/house/panel -e /home/$houseUser/house/panel/start.sh" -WorkingDirectory $env:USERPROFILE
}

function Invoke-Resize([string]$raw) {
    $size = 0
    $parts = $raw.Trim() -split '\s+'
    if (-not [int]::TryParse($parts[0], [ref]$size) -or $size -lt 50 -or $size -gt 4000) { return "Storage change refused: $raw isn't a valid size." }
    # A request left behind by a restart must never restart the house later, out of nowhere.
    $asked = [long]0
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if (-not [long]::TryParse($parts[1], [ref]$asked) -or $now - $asked -gt 120000) { return "Storage change to $size GB was cancelled because the request was too old. Please ask again." }
    Set-StayAwake $false
    # Anything touching L: wakes the house again, and it must be fully off to change size. So if
    # something got in the way, this shuts it down and goes straight back in, a few times.
    $worked = $false
    for ($attempt = 1; $attempt -le 6 -and -not $worked; $attempt += 1) {
        [void](Invoke-Wsl '--shutdown' 90)
        Start-Sleep 2
        $result = Invoke-Wsl "--manage $houseDistro --resize ${size}GB" 300
        $output = $result.Output
        $worked = $result.Code -eq 0
        if (-not $worked) { Start-Sleep 3 }
    }
    $stamp = Get-Date -Format 'yyyy-MM-dd h:mm tt'
    if ($worked) { return "House storage set to $size GB on $stamp." }
    return "Storage change to $size GB failed on $stamp. $($output.Trim())"
}

[LinuxHouse.Snap]::Start("$state\link-token", "$state\helper.log")

$checksAsleep = 0
$wasKeeping = $null
$skillsSynced = $false
while ($true) {
    try {
        if (Test-HouseRunning) {
            $checksAsleep = 0
            [System.IO.Directory]::CreateDirectory($state) | Out-Null
            $freeGb = [math]::Round((Get-PSDrive C).Free / 1GB, 1)
            $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            # Written over the old copy at a fixed size, so it still works when the house's disk is
            # full. If it fails anyway, everything below still has to run.
            try {
                $bytes = $utf8.GetBytes("{`"cFreeGb`":$freeGb,`"time`":$now}".PadRight(64))
                $file = [System.IO.File]::Open("$state\windows.json", 'OpenOrCreate', 'Write', 'ReadWrite')
                try { $file.Write($bytes, 0, $bytes.Length); $file.SetLength($bytes.Length) } finally { $file.Close() }
            } catch { }

            # Once per helper start, while the house is awake.
            if (-not $skillsSynced) {
                $skillsSynced = $true
                Sync-ClaudeSkills "$env:USERPROFILE\.claude" "$house\home\$houseUser\.claude"
                Sync-WindowsCursors "$house\home\$houseUser\.local\share\station-256\windows-cursors"
            }

            # Open rooms and running jobs keep the PC awake. Just leaving the panel open doesn't.
            $keep = $true
            if (Test-Path $config) { $keep = (Get-Content $config -Raw | ConvertFrom-Json).keepAwake -ne $false }
            $status = ''
            if (Test-Path "$house\run\house\status") { $status = Get-Content "$house\run\house\status" -Raw }
            $keeping = $keep -and ($status -like 'awake: rooms up*' -or $status -like 'awake: jobs running*')
            Set-StayAwake $keeping
            if ($keeping -ne $wasKeeping) {
                [System.IO.File]::AppendAllText("$state\helper.log", "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') keep PC awake: $keeping`n", $utf8)
                $wasKeeping = $keeping
            }

            if (Test-Path $request) {
                $raw = Get-Content $request -Raw
                Remove-Item $request -Force
                $result = Invoke-Resize $raw
                # The house only restarted if the request wasn't refused.
                if ($result -notmatch 'refused|cancelled') {
                    Open-Panel
                    Start-Sleep 12
                }
                [System.IO.File]::WriteAllText("$state\resize-result.txt", $result, $utf8)
            }
        } else {
            Set-StayAwake $false
            $checksAsleep += 1
            if ($checksAsleep -ge 6) { exit 0 }
        }
    } catch {
        Set-StayAwake $false
    }
    Start-Sleep 20
}
