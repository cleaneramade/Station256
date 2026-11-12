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
