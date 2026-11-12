# Drives the real mouse over Station 256 and two test windows. Every press is checked first: it only
# happens on Station 256 or a test window. Send the results to a file, since stopping this script
# partway could leave the mouse button held down.
param([switch]$Repeat) # just drags Station over and over, counting any it misses
Add-Type @'
using System; using System.Text; using System.Text.RegularExpressions; using System.Runtime.InteropServices;
public static class S {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int how);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
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
  public static RECT Seen(IntPtr h) { RECT r; DwmGetWindowAttribute(h, 9, out r, 16); return r; }
  public static string Show(IntPtr h) { var r = Seen(h); return String.Format("{0},{1} {2}x{3}", r.L, r.T, r.R-r.L, r.B-r.T); }
  public static void Put(IntPtr h, int x, int y, int w, int ht) {
    ShowWindow(h, 9);
    RECT frame; GetWindowRect(h, out frame);
    RECT seen = Seen(h);
    SetWindowPos(h, IntPtr.Zero, x - (seen.L - frame.L), y - (seen.T - frame.T), w + (frame.R - frame.L) - (seen.R - seen.L), ht + (frame.B - frame.T) - (seen.B - seen.T), 0x14);
  }
  public static IntPtr Under(int x, int y) { var p = new POINT(); p.X = x; p.Y = y; return GetAncestor(WindowFromPoint(p), 2); }
  public static bool Focus(IntPtr h) {
    if (GetForegroundWindow() == h) return true;
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
  public static void Down() { mouse_event(2,0,0,0,UIntPtr.Zero); }
  public static void Up() { mouse_event(4,0,0,0,UIntPtr.Zero); }
  public static void Move(int x, int y) { SetCursorPos(x, y); mouse_event(1,0,0,0,UIntPtr.Zero); }
}
'@
[void][S]::SetProcessDPIAware()
$dir = "$env:LOCALAPPDATA\LinuxHouse"
$unc = '\\wsl.localhost\Ubuntu\tmp\snaptest'
$script:passed = 0; $script:failed = 0
function Check($name, $ok, $detail) { if ($ok) { $script:passed += 1; "PASS $name  ($detail)" } else { $script:failed += 1; "FAIL $name  ($detail)" } }
function Ask($name, $seconds = 20) {
  [IO.File]::WriteAllText("$unc\do-$name", '')
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { if (Test-Path "$unc\done-$name") { Remove-Item "$unc\done-$name"; return (Get-Content "$unc\answer-$name" -Raw) }; Start-Sleep -Milliseconds 40 }
  throw "no answer to $name"
}
function Look { Ask 'where' | ConvertFrom-Json }
function Allowed($x, $y) { $u = [S]::Under($x, $y); return ($u -eq $script:station -or $u -eq $script:a -or $u -eq $script:b) }
# Holds the button down only if the spot is on Station or a test window.
function Press($x, $y) { [S]::Move($x, $y); Start-Sleep -Milliseconds 120; if (-not (Allowed $x $y)) { throw "the spot $x,$y isn't on a test window, so nothing was pressed" }; [S]::Down(); Start-Sleep -Milliseconds 100 }
function Glide($fromX, $fromY, $toX, $toY, $steps = 10, $wait = 30) {
  for ($i = 1; $i -le $steps; $i += 1) { [S]::Move([int]($fromX + ($toX - $fromX) * $i / $steps), [int]($fromY + ($toY - $fromY) * $i / $steps)); Start-Sleep -Milliseconds $wait }
}
function Tap($x, $y) { Press $x $y; [S]::Up(); Start-Sleep -Milliseconds 200 }
function Wait-Seams($count, $seconds = 3) { $end = (Get-Date).AddSeconds($seconds); do { $w = Look; if (@($w.seams).Count -eq $count) { return $w }; Start-Sleep -Milliseconds 150 } while ((Get-Date) -lt $end); return $w }
function Near($p, $q, $by = 3) { return [math]::Abs($p - $q) -le $by }

$saved = New-Object S+POINT; [void][S]::GetCursorPos([ref]$saved)
wsl -d Ubuntu -- bash -c "rm -rf /tmp/snaptest; mkdir -p /tmp/snaptest"
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*house-helper.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList '--headless C:\Windows\System32\wsl.exe -d Ubuntu -- bash ~/house/panel/test/snaprun.sh' -WorkingDirectory $env:USERPROFILE
Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$dir\house-helper.ps1`"" -WorkingDirectory $env:USERPROFILE
for ($i = 0; $i -lt 60 -and -not (Test-Path "$unc\ready"); $i += 1) { Start-Sleep -Milliseconds 500; if ((Test-Path "$unc\result.txt") -and (Get-Content "$unc\result.txt" -Raw) -match 'BUSY') { 'Station is in use, so the test did not run'; exit 9 } }
if (-not (Test-Path "$unc\ready")) { 'app never became ready'; exit 1 }
Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\seam-form.ps1`"" -WorkingDirectory $env:USERPROFILE
Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\seam-form.ps1`" -Second" -WorkingDirectory $env:USERPROFILE
$script:a = [IntPtr]::Zero; $script:b = [IntPtr]::Zero; $script:station = [IntPtr]::Zero
for ($i = 0; $i -lt 40 -and ($a -eq [IntPtr]::Zero -or $b -eq [IntPtr]::Zero -or $station -eq [IntPtr]::Zero); $i += 1) { Start-Sleep -Milliseconds 300; $script:a = [S]::Find('^Snap test window$', 'powershell'); $script:b = [S]::Find('^Snap test window 2$', 'powershell'); $script:station = [S]::Find('^Station 256( \(|$)', 'msrdc') }
"found: station $($station -ne [IntPtr]::Zero), windows $($a -ne [IntPtr]::Zero) $($b -ne [IntPtr]::Zero)"
try {
  if ($a -eq [IntPtr]::Zero -or $b -eq [IntPtr]::Zero -or $station -eq [IntPtr]::Zero) { throw 'a window is missing' }
  Start-Sleep -Seconds 2 # the link joins up
  [S]::Put($a, 200, 200, 700, 500); [S]::Put($b, 300, 250, 700, 500)
  if (-not [S]::Focus($station)) { throw 'could not focus Station' }
  $w = Look
  "start: $($w.box | ConvertTo-Json -Compress)"

  if ($Repeat) {
    [S]::Put($a, 1290, 0, 620, 1000)
    Start-Sleep -Milliseconds 500
    foreach ($how in 'after clicking another app', 'with Station already in focus') {
      $missed = 0; $sign = 1
      for ($round = 1; $round -le 10; $round += 1) {
        if ($how -like 'after*') {
          Tap 1800 500
          Start-Sleep -Milliseconds 300
          if ([S]::GetForegroundWindow() -ne $a) { "round ${round}: the click did not focus the other app" }
        } elseif (-not [S]::Focus($station)) { throw 'could not focus Station' }
        $w = Look
        $wasX = $w.box.x
        Press $w.bar.x $w.bar.y
        Glide $w.bar.x $w.bar.y ($w.bar.x + 30 * $sign) ($w.bar.y + 30 * $sign) 6 25
        [S]::Up()
        Start-Sleep -Milliseconds 350
        $w = Look
        if (Near $w.box.x $wasX 5) { $missed += 1; "round ${round}: the drag did not move Station" }
        $sign = -$sign
      }
      "$how : $missed of 10 missed"
    }
    return
  }

  '--- 1. Real mouse: drag Station to the left edge, then pick a test window'
  Press $w.bar.x $w.bar.y
  Glide $w.bar.x $w.bar.y 400 500; Glide 400 500 0 500 8 30
  Start-Sleep -Milliseconds 350
  $mid = Look
  Check 'outline shows while at the edge' ($mid.preview -and (Near $mid.preview.w 960 8)) ($mid.preview | ConvertTo-Json -Compress)
  [S]::Up()
  Start-Sleep -Milliseconds 900
  $w = Look
  Check 'lands on the left half' ((Near $w.box.x 0) -and (Near $w.box.w 960) -and (Near $w.box.h 1020)) ($w.box | ConvertTo-Json -Compress)
  for ($i = 0; $i -lt 30 -and -not $w.tile; $i += 1) { Start-Sleep -Milliseconds 150; $w = Look }
  Check 'offers apps for the other half' ([bool]$w.tile) 'tile looked for'
  if (-not $w.tile) { throw 'no tile to pick' }
  Tap ($w.tile.x + [int]($w.tile.w / 2)) ($w.tile.y + [int]($w.tile.h / 2))
  Start-Sleep -Milliseconds 800
  $r = [S]::Seen($a)
  Check 'the picked window goes to the right half' ((Near $r.L 960 4) -and (Near $r.R 1920 4)) ([S]::Show($a))

  '--- 2. The seam appears'
  $w = Wait-Seams 1
  Check 'a seam is found' (@($w.seams).Count -eq 1) ($w.seams | ConvertTo-Json -Compress)

  '--- 3. Drag from the Windows app side: its own edge, Station follows'
  Check 'the picked window has focus' ([S]::GetForegroundWindow() -eq $a) "foreground is the app: $([S]::GetForegroundWindow() -eq $a)"
  if (-not [S]::Focus($a)) { throw 'could not focus the test window' }
  Press 956 500
  [void](Ask 'track-start')
  Glide 956 500 1056 500 12 40
  $during = Look
  [S]::Up()
  $track = Ask 'track-stop'
  Start-Sleep -Milliseconds 500
  $w = Look; $r = [S]::Seen($a)
  Check 'Station followed while dragging' (($during.box.w -gt 980) -and ($track -notmatch '^[0-2] ')) "during $($during.box.w), $track"
  Check 'both end on the same line' ((Near ($w.box.x + $w.box.w) $r.L 3) -and (Near $r.R 1920 4) -and (Near $r.L 1056 12)) "Station right $($w.box.x + $w.box.w), app $([S]::Show($a))"

  '--- 4. Drag from the Station side: the Windows app follows'
  if (-not [S]::Focus($station)) { throw 'could not focus Station' }
  $w = Wait-Seams 1
  $line = $w.box.x + $w.box.w
  [S]::Move($line, 500); Start-Sleep -Milliseconds 250
  $hover = Look
  Check 'pointer lands on the seam, with left-right arrows' (@($hover.seams)[0].hover -and @($hover.seams)[0].cursor -eq 'ew-resize') (@($hover.seams)[0] | ConvertTo-Json -Compress)
  Press $line 500
  $steps = @()
  foreach ($x in ($line - 50), ($line - 100), ($line - 150), ($line - 200)) { Glide ($x + 50) 500 $x 500 4 25; Start-Sleep -Milliseconds 60; $steps += [S]::Seen($a).L }
  [S]::Up()
  Start-Sleep -Milliseconds 500
  $w = Look; $r = [S]::Seen($a)
  Check 'the app followed live' (($steps | Select-Object -Unique).Count -ge 3) "its edge went $($steps -join ', ')"
  Check 'both end on the same line' ((Near ($w.box.x + $w.box.w) $r.L 3) -and (Near $r.R 1920 4) -and (Near $r.L ($line - 200) 12)) "Station right $($w.box.x + $w.box.w), app $([S]::Show($a))"

  '--- 5. The app has a minimum width of 500: the seam stops there'
  $w = Wait-Seams 1
  $line = $w.box.x + $w.box.w
  Press $line 500
  Glide $line 500 1800 500 16 25
  Start-Sleep -Milliseconds 300
  [S]::Up()
  Start-Sleep -Milliseconds 500
  $w = Wait-Seams 1; $r = [S]::Seen($a)
  # 500 wide becomes about 607 on this screen: the test window is scaled up 125%, without its invisible edges.
  Check 'app stays at its minimum, on screen' ((Near ($r.R - $r.L) 607 12) -and (Near $r.R 1920 4)) ([S]::Show($a))
  Check 'Station stops there too' (Near ($w.box.x + $w.box.w) $r.L 4) "Station right $($w.box.x + $w.box.w), app left $($r.L)"

  '--- 6. Station has its own minimum: the seam stops there'
  $line = $w.box.x + $w.box.w
  Press $line 500
  Glide $line 500 100 500 18 25
  Start-Sleep -Milliseconds 300
  [S]::Up()
  Start-Sleep -Milliseconds 500
  $w = Wait-Seams 1; $r = [S]::Seen($a)
  # 560 at the 135% zoom: 756.
  Check 'Station stops at its minimum' (Near $w.box.w 756 6) "Station $($w.box.w) wide"
  Check 'the app stops with it' (Near $r.L ($w.box.x + $w.box.w) 4) ([S]::Show($a))

  '--- 7. Clicking the app beside Station reaches the app'
  if (-not [S]::Focus($station)) { throw 'could not focus Station' }
  Tap 1400 500
  Start-Sleep -Milliseconds 300
  Check 'click goes through to the app' ([S]::GetForegroundWindow() -eq $a) "foreground is the app: $([S]::GetForegroundWindow() -eq $a)"

  '--- 8. Pull Station away: back to its normal size, app stays put'
  $before = [S]::Show($a)
  if (-not [S]::Focus($station)) { throw 'could not focus Station' }
  $w = Look
  Press $w.bar.x $w.bar.y
  Glide $w.bar.x $w.bar.y 800 300 12 30
  Start-Sleep -Milliseconds 400
  [S]::Up()
  Start-Sleep -Milliseconds 700
  $w = Wait-Seams 0
  Check 'back to its normal size' ((Near $w.box.w 1100 4) -and (Near $w.box.h 760 4)) ($w.box | ConvertTo-Json -Compress)
  Check 'the app did not change' ([S]::Show($a) -eq $before) ([S]::Show($a))
  Check 'no seam left behind' (@($w.seams).Count -eq 0) "$(@($w.seams).Count) seams"

  '--- 9. Win+Left beside the app, then pull the app away'
  [S]::Put($a, 960, 0, 960, 1020)
  if (-not [S]::Focus($station)) { throw 'could not focus Station' }
  [S]::WinKey(0x25)
  Start-Sleep -Milliseconds 900
  $w = Wait-Seams 1
  Check 'seam after Win+Left' (@($w.seams).Count -eq 1) ($w.box | ConvertTo-Json -Compress)
  $w0 = $w.box
  Press 1300 12
  Glide 1300 12 1500 300 10 30
  Start-Sleep -Milliseconds 300
  [S]::Up()
  $w = Wait-Seams 0 4
  Check 'seam goes when the app leaves' (@($w.seams).Count -eq 0) "$(@($w.seams).Count) seams"
  Check 'Station did not change' ((Near $w.box.w $w0.w) -and (Near $w.box.h $w0.h)) ($w.box | ConvertTo-Json -Compress)

  '--- 10. Three windows in a grid: every line stays closed'
  if (-not [S]::Focus($station)) { throw 'could not focus Station' }
  [S]::Put($a, 0, 510, 960, 510)
  [S]::Put($b, 960, 0, 960, 1020)
  if (-not [S]::Focus($station)) { throw 'could not focus Station' }
  [S]::WinKey(0x26)
  Start-Sleep -Milliseconds 900
  $w = Wait-Seams 2 4
  Check 'no offer when the other spots are filled' (-not $w.assist) "offer open: $($w.assist)"
  Check 'two seams on a corner window' (@($w.seams).Count -eq 2) ($w.box | ConvertTo-Json -Compress)
  if (-not [S]::Focus($station)) { throw 'could not focus Station' }
  Press 960 200
  Glide 960 200 1100 200 10 30
  Start-Sleep -Milliseconds 200
  [S]::Up()
  Start-Sleep -Milliseconds 500
  $w = Look; $ra = [S]::Seen($a); $rb = [S]::Seen($b)
  Check 'upright line moved all three' ((Near ($w.box.x + $w.box.w) 1100 4) -and (Near $rb.L 1100 4) -and (Near $ra.R 1100 4)) "Station right $($w.box.x + $w.box.w), right app left $($rb.L), lower app right $($ra.R)"
  if (-not [S]::Focus($station)) { throw 'could not focus Station' }
  $w = Wait-Seams 2
  $line = $w.box.y + $w.box.h
  Press 400 $line
  Glide 400 $line 400 ($line + 100) 10 30
  Start-Sleep -Milliseconds 200
  [S]::Up()
  Start-Sleep -Milliseconds 500
  $w = Look; $ra = [S]::Seen($a); $rb = [S]::Seen($b)
  Check 'level line moved Station and the lower app' ((Near ($w.box.y + $w.box.h) ($line + 100) 4) -and (Near $ra.T ($line + 100) 4) -and (Near $ra.B 1020 4)) "Station bottom $($w.box.y + $w.box.h), lower app $([S]::Show($a))"
  Check 'the right app did not change height' ((Near $rb.T 0 4) -and (Near $rb.B 1020 4)) ([S]::Show($b))

  '--- 11. Motion: frames during maximize and restore'
  Ask 'glide' 30
} catch { "FAIL stopped: $_" } finally {
  [S]::Up()
  [S]::Move($saved.X, $saved.Y)
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*seam-form*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  [IO.File]::WriteAllText("$unc\do-finish", '')
}
Start-Sleep -Seconds 4
"RESULT: $script:passed passed, $script:failed failed"
Get-Content "$unc\result.txt" -ErrorAction SilentlyContinue | Where-Object { $_ -like 'FAIL*' -or $_ -like 'BUSY*' }
Get-Content "\\wsl.localhost\Ubuntu\home\$((Get-ChildItem '\\wsl.localhost\Ubuntu\home' -Directory | Select-Object -First 1).Name)\.local\state\house\helper.log" -Tail 6 -ErrorAction SilentlyContinue
