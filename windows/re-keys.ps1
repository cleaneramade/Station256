# Measures what Windows' snap keys do to a real window, from every position. Keys are only ever
# pressed when the test window has the focus. No photos.
Add-Type @'
using System; using System.Text; using System.Text.RegularExpressions; using System.Runtime.InteropServices;
public static class K {
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
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint c, uint t);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
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
  // Real arrow keys and the Windows key send an "extended" flag and a scan code. This includes both.
  static void Key(byte k, bool up) { keybd_event(k, (byte)MapVirtualKey(k, 0), (uint)(1 | (up ? 2 : 0)), UIntPtr.Zero); }
  public static void WinKey(byte arrow) {
    Key(0x5B, false); System.Threading.Thread.Sleep(40);
    Key(arrow, false); System.Threading.Thread.Sleep(40);
    Key(arrow, true); System.Threading.Thread.Sleep(40);
    Key(0x5B, true);
  }
  public static void Esc() { keybd_event(0x1B,0,0,UIntPtr.Zero); keybd_event(0x1B,0,2,UIntPtr.Zero); }
}
'@
[void][K]::SetProcessDPIAware()
Start-Process 'C:\Windows\System32\conhost.exe' -ArgumentList "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\snap-form.ps1`""
$test = [IntPtr]::Zero
for ($i = 0; $i -lt 30 -and $test -eq [IntPtr]::Zero; $i += 1) { Start-Sleep -Milliseconds 300; $test = [K]::Find('^Snap test window$', 'powershell') }
"test window: $($test -ne [IntPtr]::Zero)"
$keys = @{ L = 0x25; R = 0x27; U = 0x26; D = 0x28 }
function Reset { [void][K]::ShowWindow($test, 9); [void][K]::SetWindowPos($test, [IntPtr]::Zero, 400, 200, 700, 500, 0x4); Start-Sleep -Milliseconds 250 }
function Press($k) {
  if (-not [K]::Focus($test)) { throw 'lost focus' }
  [K]::WinKey($keys[$k])
  Start-Sleep -Milliseconds 700
  [K]::Esc()
  Start-Sleep -Milliseconds 400
}
$sequences = 'L', 'R', 'U', 'D', 'U,D', 'U,L', 'U,R', 'U,U',
  'L,U', 'L,D', 'L,R', 'L,L', 'R,U', 'R,D', 'R,L', 'R,R',
  'L,U,U', 'L,U,D', 'L,U,R', 'L,U,L', 'L,D,U', 'L,D,D', 'L,D,R', 'L,D,L',
  'R,U,U', 'R,U,D', 'R,U,L', 'R,U,R', 'R,D,U', 'R,D,D', 'R,D,L', 'R,D,R'
$normal = ''
try {
  foreach ($seq in $sequences) {
    Reset
    if (-not $normal) { $normal = [K]::Seen($test); "normal position is $normal" }
    foreach ($k in $seq -split ',') { Press $k }
    $state = if ([K]::IsIconic($test)) { 'MINIMIZED' } elseif ([K]::IsZoomed($test)) { 'MAXIMIZED' } else { [K]::Seen($test) }
    if ($state -eq $normal) { $state = 'NORMAL' }
    "$($seq.PadRight(8)) -> $state"
    if ($seq -eq 'L' -and $state -eq 'NORMAL') { 'the keys are not working; stopping'; break }
  }
} catch { "stopped: $_" } finally {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*snap-form.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

