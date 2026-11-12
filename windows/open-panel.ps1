# What the Station 256 shortcut runs: starts the helper, then the app. If the app doesn't come up
# (such as when clicked just as the house is going to sleep), it tries once more, then says so.
# Which Linux is the house? The installer writes house.json beside these scripts. Without it
# the script stops.
if (-not (Test-Path "$PSScriptRoot\house.json")) { Write-Host "Station 256 isn't installed. Run the installer."; exit 1 }
if (Test-Path "$PSScriptRoot\house.json") {
    $houseCfg = Get-Content "$PSScriptRoot\house.json" -Raw | ConvertFrom-Json
    $houseDistro = $houseCfg.distro; $houseUser = $houseCfg.user; $houseDrive = $houseCfg.drive
}
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$wsl = 'C:\Windows\System32\wsl.exe'
Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$dir\house-helper.ps1`"" -WorkingDirectory $env:USERPROFILE

# If it's already open, this brings it forward, even from minimized. Only Windows can do that:
# a Linux window can't un-minimize itself through the display link.
Add-Type @'
using System; using System.Text; using System.Text.RegularExpressions; using System.Runtime.InteropServices;
public static class Station256Window {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int how);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  // Linux windows are hosted by this Windows program. Checking it means a terminal or browser tab
  // that happens to be called "Station 256" can never be mistaken for the app.
  static bool IsLinuxWindow(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.Equals("msrdc", StringComparison.OrdinalIgnoreCase); }
    catch { return false; }
  }
  public static bool BringForward() {
    bool found = false;
    EnumWindows((h, l) => {
      var title = new StringBuilder(256);
      GetWindowText(h, title, 256);
      if (IsWindowVisible(h) && Regex.IsMatch(title.ToString(), @"^Station 256( \(|$)") && IsLinuxWindow(h)) {
        if (IsIconic(h)) ShowWindow(h, 9);
        SetForegroundWindow(h);
        found = true;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
if ([Station256Window]::BringForward()) { exit 0 }

function Start-App {
    Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList "--headless $wsl -d $houseDistro --cd /home/$houseUser/house/panel -e /home/$houseUser/house/panel/start.sh" -WorkingDirectory $env:USERPROFILE
}

function Test-AppRunning {
    & $wsl -d $houseDistro -e pgrep -x electron *> $null
    $LASTEXITCODE -eq 0
}

function Wait-App {
    for ($i = 0; $i -lt 15; $i += 1) {
        Start-Sleep 2
        if (Test-AppRunning) { return $true }
    }
    $false
}

Start-App
if (Wait-App) { exit 0 }
Start-App
if (Wait-App) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
[void][System.Windows.Forms.MessageBox]::Show(
    "Station 256 didn't start. Try again in a moment. If it keeps happening, restart your PC.`n`nDetails are on ${houseDrive}: at \home\$houseUser\.local\state\house\panel.log",
    'Station 256',
    'OK',
    'Warning')
