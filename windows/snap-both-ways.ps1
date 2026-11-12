# Tests snapping both ways against Windows' real tray and real panel. It only ever presses keys or
# drags when its own test window has the focus, and its results go to a file.
param([int]$Rounds = 4)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System; using System.Text; using System.Text.RegularExpressions; using System.Runtime.InteropServices;
public static class P {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int how);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT v, int s);
  public static IntPtr Find(string pattern, string program) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var s = new StringBuilder(256); GetWindowText(h, s, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      string name = ""; try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
      if (Regex.IsMatch(s.ToString(), pattern) && name.ToLower() == program && IsWindowVisible(h)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Info(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    return String.Format("{0},{1} {2}x{3} zoomed={4} iconic={5}", r.L, r.T, r.R-r.L, r.B-r.T, IsZoomed(h), IsIconic(h));
  }
  public static string Seen(IntPtr h) {
    RECT r; DwmGetWindowAttribute(h, 9, out r, 16);
    return String.Format("{0},{1} {2}x{3}", r.L, r.T, r.R-r.L, r.B-r.T);
  }
  public static bool Focus(IntPtr h) {
    if (GetForegroundWindow() == h) return true; // tapping Alt now would put it in menu mode and swallow the keys
    keybd_event(0x12,0,0,UIntPtr.Zero); keybd_event(0x12,0,2,UIntPtr.Zero);
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(350);
    return GetForegroundWindow() == h;
  }
  public static void WinKey(byte arrow) {
    keybd_event(0x5B,0,1,UIntPtr.Zero); System.Threading.Thread.Sleep(60);
    keybd_event(arrow,0,1,UIntPtr.Zero); System.Threading.Thread.Sleep(130);
    keybd_event(arrow,0,3,UIntPtr.Zero); System.Threading.Thread.Sleep(40);
    keybd_event(0x5B,0,3,UIntPtr.Zero);
  }
  public static void Esc() { keybd_event(0x1B,0,0,UIntPtr.Zero); keybd_event(0x1B,0,2,UIntPtr.Zero); }
  public static void Down() { mouse_event(2,0,0,0,UIntPtr.Zero); }
  public static void Up() { mouse_event(4,0,0,0,UIntPtr.Zero); }
  public static void Move(int x, int y) { SetCursorPos(x, y); mouse_event(1,0,0,0,UIntPtr.Zero); }
}
'@
[void][P]::SetProcessDPIAware()
$unc = '\\wsl.localhost\Ubuntu\tmp\snaptest'
$dir = "$env:LOCALAPPDATA\LinuxHouse"
$errs = $null; [void][System.Management.Automation.Language.Parser]::ParseFile("$dir\house-helper.ps1", [ref]$null, [ref]$errs); "helper parse errors: $($errs.Count)"
if ($errs.Count) { $errs | ForEach-Object { $_.Message } ; exit 1 }
wsl -d Ubuntu -- bash -c "rm -rf /tmp/snaptest; mkdir -p /tmp/snaptest"
function Ask($name, $seconds = 25) {
  [IO.File]::WriteAllText("$unc\do-$name", '')
  $t = [Diagnostics.Stopwatch]::StartNew()
  while ($t.Elapsed.TotalSeconds -lt $seconds) { if (Test-Path "$unc\done-$name") { Remove-Item "$unc\done-$name" -Force; return (Get-Content "$unc\answer-$name" -ErrorAction SilentlyContinue | Select-Object -Last 1) }; Start-Sleep -Milliseconds 100 }
  "(no answer for $name)"
}
function Find-Tile {
  foreach ($top in [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)) {
    if ($top.Current.ClassName -notmatch 'Xaml|Snap') { continue }
    foreach ($item in $top.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
      if ($item.Current.ControlType -eq [Windows.Automation.ControlType]::ListItem -and $item.Current.Name -match 'Station 256 \(Ubuntu\)|^Station 256') { return $item }
    }
  }
  $null
}
$saved = New-Object P+POINT; [void][P]::GetCursorPos([ref]$saved)
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*house-helper.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList '--headless C:\Windows\System32\wsl.exe -d Ubuntu -- bash ~/house/panel/test/snaprun.sh' -WorkingDirectory $env:USERPROFILE
Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$dir\house-helper.ps1`"" -WorkingDirectory $env:USERPROFILE
$t = [Diagnostics.Stopwatch]::StartNew()
while (-not (Test-Path "$unc\ready") -and $t.Elapsed.TotalSeconds -lt 30) { Start-Sleep -Milliseconds 200 }
if (-not (Test-Path "$unc\ready")) { 'app never became ready'; if (Test-Path "$unc\result.txt") { Get-Content "$unc\result.txt" }; exit 1 }
Remove-Item "$unc\ready" -Force
Start-Sleep 3
$h = [P]::Find('^Station 256', 'msrdc')
"surface at start: $([P]::Info($h))"
Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\snap-form.ps1`""
$test = [IntPtr]::Zero
for ($i = 0; $i -lt 30 -and $test -eq [IntPtr]::Zero; $i += 1) { Start-Sleep -Milliseconds 300; $test = [P]::Find('^Snap test window$', 'powershell') }
"test window opened: $($test -ne [IntPtr]::Zero)"
function Reset-Test { [void][P]::ShowWindow($test, 9); [void][P]::SetWindowPos($test, [IntPtr]::Zero, 200, 200, 700, 500, 0x4); Start-Sleep -Milliseconds 300 }

try {
  "--- 1. Windows' tray, $Rounds times: snap a Windows app to one side, pick Station 256"
  $worked = 0; $skipped = 0
  for ($round = 1; $round -le [math]::Max(0, $Rounds); $round += 1) {
    $appSide = if ($round % 2) { 'window 960,0,960,1020' } else { 'window 0,0,960,1020' }
    $key = if ($round % 2) { 0x25 } else { 0x27 }
    Reset-Test
    if (-not [P]::Focus($test)) { "round $round : no focus, so no keys pressed"; $skipped += 1; continue }
    [P]::WinKey($key)
    $tile = $null
    for ($try = 0; $try -lt 10 -and -not $tile; $try += 1) { Start-Sleep -Milliseconds 300; $tile = Find-Tile }
    if (-not $tile) { "round $round : Station 256 wasn't in the tray"; [P]::Esc(); Start-Sleep -Milliseconds 400; continue }
    $tile.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 800
    $line = Ask "round-$round"
    $ok = $line -like "*$appSide *"
    if ($ok) { $worked += 1 }
    "round $round : $line  surface: $([P]::Info($h))  $(if ($ok) { 'OK' } else { 'MISSED' })"
  }
  "tray worked $worked of $($Rounds - $skipped)"

  if ($Rounds -ge 0) {
  "--- 2. Windows' panel: drag the test window onto the 3-window layout, pick Station 256 for a quarter"
  Reset-Test
  [void][P]::Focus($test)
  Start-Sleep -Milliseconds 500
  if ([P]::Focus($test)) {
    [P]::Move(500, 215)
    Start-Sleep -Milliseconds 300
    [P]::Down()
    Start-Sleep -Milliseconds 300
    for ($y = 215; $y -ge 0; $y -= 15) { [P]::Move(500 + (215 - $y) * 2, $y); Start-Sleep -Milliseconds 30 }
    [P]::Move(960, 2)
    Start-Sleep -Milliseconds 1200
    # Asks Windows where the "3 window" layout's left tile really is.
    $dropX = 1065; $dropY = 85
    foreach ($top in [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)) {
      if ($top.Current.ClassName -notlike 'XamlExplorerHost*') { continue }
      $group = $top.FindFirst([Windows.Automation.TreeScope]::Descendants, (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, '3 window focus on left layout')))
      if ($group) {
        $b = $group.Current.BoundingRectangle
        if ($b.Width -gt 0) { $dropX = [int]($b.X + 30); $dropY = [int]($b.Y + 40); "found the layout at $([int]$b.X),$([int]$b.Y)" }
      }
    }
    [P]::Move($dropX, $dropY)
    Start-Sleep -Milliseconds 600
    [P]::Up()
    $tile = $null
    for ($try = 0; $try -lt 10 -and -not $tile; $try += 1) { Start-Sleep -Milliseconds 300; $tile = Find-Tile }
    "test window: $([P]::Seen($test))"
    "tray offers Station 256: $($null -ne $tile)"
    if ($tile) {
      $tile.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
      Start-Sleep -Milliseconds 1000
      "app (should be top right quarter, 960,0,960,510): $(Ask 'quarter')"
      "carrying on for the last spot (should be 960,510,960,510, not offering the test window): $(Ask 'carryon')"
      [P]::Esc()
      Start-Sleep -Milliseconds 500
    } else { [P]::Esc() }
  } else { 'no focus, so no drag' }
  }

  if ($Rounds -eq 0) { throw 'only part 2 was asked for' }
  if ($Rounds -eq -1) {
    [void][P]::Focus($h)
    "normal: $(Ask 'normalize')"
    Ask 'log-events' | Out-Null
    [void][P]::Focus($h)
    Start-Sleep -Milliseconds 500
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $stamp0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    "clock at key press: $stamp0"
    [P]::WinKey(0x28)
    $last = ''
    while ($watch.Elapsed.TotalSeconds -lt 3) {
      $now = [P]::Info($h)
      if ($now -ne $last) { "$($watch.ElapsedMilliseconds) ms: $now"; $last = $now }
      Start-Sleep -Milliseconds 5
    }
    '--- the app side'
    Ask 'dump-events' | Out-Null
    Get-Content "$unc\events.txt" | ForEach-Object { $p = $_ -split ' ', 2; "$([long]$p[0] - $stamp0) ms: $($p[1])" }
    throw 'only the timeline was asked for'
  }
  "--- 3. Station 256 with Windows' snap keys"
  [void][P]::Focus($h)
  $normal = Ask 'normalize'
  "normal size is: $normal"
  $normalBox = ($normal -replace '^window ', '')
  $codes = @{ L = 0x25; R = 0x27; U = 0x26; D = 0x28 }
  $half = @{ R = '960,0,960,1020'; L = '0,0,960,1020'; TR = '960,0,960,510'; TL = '0,0,960,510'; BR = '960,510,960,510'; BL = '0,510,960,510'; M = '0,0,1920,1020'; N = $normalBox }
  $right = 0; $total = 0
  # Each step: the key, then where a real Windows window ends up, from the measured rulebook.
  foreach ($step in 'R>R', 'U>TR', 'D>R', 'D>BR', 'U>R', 'L>N', 'L>L', 'U>TL', 'U>M', 'U>N', 'L>L', 'D>BL', 'R>BR', 'L>BL', 'U>L', 'R>N') {
    $key, $spot = $step -split '>'
    $name = "key-$($total + 1)"
    if (-not [P]::Focus($h)) { "$step : no focus, no keys pressed"; continue }
    [P]::WinKey($codes[$key])
    Start-Sleep -Milliseconds 900
    $line = Ask $name
    $ok = $line -like "*window $($half[$spot]) *"
    $total += 1; if ($ok) { $right += 1 }
    "Win+$key should go to $spot : $line surface $([P]::Info($h))  $(if ($ok) { 'OK' } else { 'WRONG' })"
    [P]::Esc()
    Start-Sleep -Milliseconds 250
  }
  "snap keys matched Windows $right of $total"
  # From normal size, Win+Down minimizes.
  $mins = 0
  for ($i = 1; $i -le 5; $i += 1) {
    if (-not [P]::Focus($h)) { "minimize $i : no focus, no keys pressed"; continue }
    Start-Sleep -Milliseconds 400
    [P]::WinKey(0x28)
    Start-Sleep -Milliseconds 1800
    $wasMin = [P]::IsIconic($h)
    if ($wasMin) { $mins += 1 }
    if ($wasMin) { [void][P]::ShowWindow($h, 9) }
    Start-Sleep -Milliseconds 1000
    $back = Ask "back-$i"
    "minimize $i : minimized=$wasMin, brought back: $([P]::Info($h)) $back"
  }
  "Win+Down from normal minimized $mins of 5"

  "--- 4. Station 256's own panel: the suggested pair with the test window"
  Reset-Test
  [void][P]::Focus($test)
  if ([P]::Focus($h)) {
    "$(Ask 'suggest' 20)"
    Start-Sleep -Milliseconds 500
    "test window (should be the right half, 960,0 960x1020): $([P]::Seen($test))"
  }

  "--- 5. Station 256's own panel: half and half, then the tray of your apps"
  Reset-Test
  [void][P]::Focus($test)
  if ([P]::Focus($h)) {
    "$(Ask 'assist' 25)"
    Start-Sleep -Milliseconds 500
    "test window (should be the right half, 960,0 960x1020): $([P]::Seen($test))"
  }
} finally {
  [P]::Up()
  [P]::Move($saved.X, $saved.Y)
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*snap-form.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  [IO.File]::WriteAllText("$unc\do-finish", '')
}
Start-Sleep 2
"--- end"
Get-Content "$unc\result.txt" | Where-Object { $_ -like 'FAIL*' -or $_ -like 'BUSY*' }

