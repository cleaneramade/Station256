# Alt+L opens Station 256 from anywhere, the way Win+E opens File Explorer. If it's already open,
# another window opens on the Home page (start.sh --new-window asks the running app), sharing the
# same rooms and terminals. If not, it starts the way the shortcut does (open-panel.ps1).
# Starts when you sign in (HKCU Run "Station 256 keys") and then only waits, so it never wakes the
# house by itself: only a press does. The C# is compiled in memory, never saved as an .exe (see the
# antivirus note in 01-requirements.md).
#   -Check   says whether a Station 256 window is open, and ends
#   -Test    listens for Ctrl+Alt+Shift+F12 instead, and only notes each press in the log
param([switch]$Check, [switch]$Test)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here 'station-keys.log'
function Note([string]$text) {
    try { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $text" -Encoding utf8 } catch {}
}

# Finding the window is the same as in open-panel.ps1; keep the two in step.
Add-Type @'
using System; using System.Text; using System.Text.RegularExpressions; using System.Runtime.InteropServices;
public static class Station256Keys {
  [StructLayout(LayoutKind.Sequential)]
  public struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [DllImport("user32.dll", SetLastError=true)] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint key);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int how);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  // Linux windows are hosted by this Windows program, so a browser tab called "Station 256" never counts.
  static bool IsLinuxWindow(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.Equals("msrdc", StringComparison.OrdinalIgnoreCase); }
    catch { return false; }
  }
  // Whether a Station 256 window is open. With bring, it also comes to the front.
  public static bool Find(bool bring) {
    bool found = false;
    EnumWindows((h, l) => {
      var title = new StringBuilder(256);
      GetWindowText(h, title, 256);
      if (IsWindowVisible(h) && Regex.IsMatch(title.ToString(), @"^Station 256( \(|$)") && IsLinuxWindow(h)) {
        if (bring) {
          if (IsIconic(h)) ShowWindow(h, 9);
          SetForegroundWindow(h);
        }
        found = true;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // Every Station 256 window on screen.
  public static IntPtr[] All() {
    var found = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h, l) => {
      var title = new StringBuilder(256);
      GetWindowText(h, title, 256);
      if (IsWindowVisible(h) && Regex.IsMatch(title.ToString(), @"^Station 256( \(|$)") && IsLinuxWindow(h)) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // To the front. If Windows says no, a tap of Alt (as snap-link.cs does) lets it through.
  public static bool Bring(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    SetForegroundWindow(h);
    if (GetForegroundWindow() == h) return true;
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    return GetForegroundWindow() == h;
  }
  // 0 when the keys are ours, or Windows' reason they aren't. Held keys don't repeat.
  public static int Listen(uint mods, uint key) {
    return RegisterHotKey(IntPtr.Zero, 1, mods | 0x4000, key) ? 0 : Marshal.GetLastWin32Error();
  }
  // Waits for the next press. False only if Windows ends the wait.
  public static bool WaitForPress() {
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) if (m.message == 0x0312) return true;
    return false;
  }
  // A press lets this helper bring a window forward. This passes that on to the app as it starts.
  public static void PassFront() { AllowSetForegroundWindow(-1); }
}
'@

if ($Check) {
    if ([Station256Keys]::Find($false)) { 'open' } else { 'not open' }
    exit 0
}

$mutex = New-Object System.Threading.Mutex($false, $(if ($Test) { 'Station256KeysTest' } else { 'Station256Keys' }))
if (-not $mutex.WaitOne(0)) { exit 0 }

try { if ((Get-Item $log -ErrorAction Stop).Length -gt 256KB) { Remove-Item $log } } catch {}

$MOD_ALT = 1; $MOD_CONTROL = 2; $MOD_SHIFT = 4
if ($Test) { $mods = $MOD_ALT -bor $MOD_CONTROL -bor $MOD_SHIFT; $key = 0x7B; $name = 'Ctrl+Alt+Shift+F12 (test)' }
else { $mods = $MOD_ALT; $key = 0x4C; $name = 'Alt+L' }

# Another app may have the keys already. Try again now and then, in case it lets go.
$said = $false
while (($why = [Station256Keys]::Listen($mods, $key)) -ne 0) {
    if (-not $said) { Note "$name is taken by another app (Windows error $why). Trying again every minute."; $said = $true }
    Start-Sleep 60
}
Note "listening for $name"

# Which Linux is the house? The installer writes house.json beside these scripts. Without it
# the script stops.
if (-not (Test-Path "$PSScriptRoot\house.json")) { Write-Host "Station 256 isn't installed. Run the installer."; exit 1 }
if (Test-Path "$PSScriptRoot\house.json") {
    $houseCfg = Get-Content "$PSScriptRoot\house.json" -Raw | ConvertFrom-Json
    $houseDistro = $houseCfg.distro; $houseUser = $houseCfg.user
}

$wsl = 'C:\Windows\System32\wsl.exe'
$lastStart = [datetime]::MinValue
while ([Station256Keys]::WaitForPress()) {
    if ($Test) { Note 'pressed'; continue }
    $before = [Station256Keys]::All()
    if ($before.Count -gt 0) {
        # Open: the running app makes another window. It comes to the front as soon as it shows.
        [Station256Keys]::PassFront()
        Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList "--headless $wsl -d $houseDistro --cd /home/$houseUser/house/panel -e /home/$houseUser/house/panel/start.sh --new-window" -WorkingDirectory $env:USERPROFILE
        $shown = $null
        $started = Get-Date
        while (-not $shown -and ((Get-Date) - $started).TotalSeconds -lt 8) {
            Start-Sleep -Milliseconds 100
            $shown = [Station256Keys]::All() | Where-Object { $before -notcontains $_ } | Select-Object -First 1
        }
        if (-not $shown) { Note 'pressed: asked for another window, none showed in 8 s'; continue }
        $front = [Station256Keys]::Bring($shown)
        Note "pressed: another window, after $([int]((Get-Date) - $started).TotalMilliseconds) ms$(if (-not $front) { ' (Windows kept it behind)' })"
        continue
    }
    # Not open. One start at a time: presses while it is starting are let go.
    if (((Get-Date) - $lastStart).TotalSeconds -lt 20) { continue }
    $lastStart = Get-Date
    Note 'pressed: starting it'
    [Station256Keys]::PassFront()
    Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$here\open-panel.ps1`"" -WorkingDirectory $env:USERPROFILE
}
Note 'stopped listening'
