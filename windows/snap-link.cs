// Windows' side of snapping for Station 256.
//
// Station 256's window is really one fixed see-through layer covering the screen, with the app drawn
// inside it. Windows can move that layer, but the Linux app never hears where it went, and Windows
// can't see the app inside. So this sits between them, on a live link to the app (127.0.0.1:47256,
// opened with a secret from the house):
//   - When Windows snaps the layer, it tells the app where to go, and puts the layer back.
//   - When you press Win + an arrow key on the app, it passes the key on.
//   - It lists and moves Windows apps for the app's own snap offers.
//   - It keeps side-by-side windows together, so the seam between them resizes both.
//   - It catches files dragged onto the app's file list from Windows, since a Linux window can't,
//     and tells the app when files are copied in Windows, so they can be pasted there.
//   - It keeps one clipboard for both: text copied in Windows goes to the house, and what you copy
//     in the house (text, or files) is put on Windows' clipboard.
//   - It opens web links clicked in the app in your browser.
//   - It makes Win + H (voice typing) work on the app, which Windows turns away from Linux windows.
//   - It shows Windows notifications when a room's AI finishes or needs you, and passes clicks back.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace LinuxHouse {
  public static class Snap {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    delegate void WinEventProc(IntPtr hook, uint type, IntPtr h, int idObject, int idChild, uint thread, uint time);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int how);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(int a, int b, ref RECT r, int c);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int k);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetDpiForSystem();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT v, int s);
    [DllImport("dwmapi.dll")] static extern int DwmGetColorizationColor(out uint color, out bool opaque);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr OpenProcess(uint a, bool i, uint p);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr p, int f, StringBuilder s, ref int n);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool AddClipboardFormatListener(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
    [DllImport("mpr.dll", CharSet = CharSet.Unicode)] static extern int WNetGetConnection(string local, StringBuilder remote, ref int length);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
    delegate IntPtr MouseProc(int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, MouseProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    // Windows' typing in progress, so voice typing's words can be read while it's still working
    // them out (see QuietTextBox).
    [DllImport("imm32.dll")] static extern IntPtr ImmGetContext(IntPtr h);
    [DllImport("imm32.dll")] static extern bool ImmReleaseContext(IntPtr h, IntPtr imc);
    [DllImport("imm32.dll")] static extern int ImmGetCompositionStringW(IntPtr imc, int index, byte[] buffer, int length);

    static int Port = 47256; // a test can point its own copy at a test copy of the panel
    static string tokenFile;
    static string logFile;
    static IntPtr station = IntPtr.Zero;
    static readonly Dictionary<string, string> icons = new Dictionary<string, string>();

    /* ---------- Starting up ---------- */

    public static void Start(string token, string log) {
      tokenFile = token;
      logFile = log;
      SetUpNotifications();
      var thread = new Thread(() => {
        int tick = 0;
        while (true) {
          try { Tick(tick); } catch { }
          tick += 1;
          Thread.Sleep(20);
        }
      });
      thread.IsBackground = true;
      thread.Start();
      // Connecting can take a moment, which mustn't hold up everything else.
      var linker = new Thread(() => {
        while (true) {
          try { if (station != IntPtr.Zero) OpenLink(); } catch { }
          Thread.Sleep(500);
        }
      });
      linker.IsBackground = true;
      linker.Start();
      StartCatcher();
      StartGuard();
    }

    static void Log(string text) {
      try { File.AppendAllText(logFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + text + "\n"); } catch { }
    }

    static void Tick(int tick) {
      if (tick % 50 == 0 || (station != IntPtr.Zero && !IsWindow(station))) {
        station = FindStation();
        if (station == IntPtr.Zero) {
          HideCatcher();
          Watch(IntPtr.Zero);
          lock (trackLock) { tracked.Clear(); watching = false; }
          lastNeighbors = "";
          CloseLink();
        } else if (IsFull(Bounds(station))) {
          Watch(station); // only once it has settled, so its first moments opening don't count
        }
      }
      if (station == IntPtr.Zero) return;

      try { Catch(); } catch { }
      CheckKeys();
      string key = TakeKey();
      if (key != null) {
        Send(new Dictionary<string, object> { { "type", "key" }, { "key", key } });
        // Lets Windows finish its own move first. Win + Down can mean minimize, and resetting the
        // layer at that same moment would cancel it, so that one waits for the app.
        resetAt = Environment.TickCount + (key == "D" ? 700 : 150);
        hasReset = true;
      }
      if (hasReset && Environment.TickCount - resetAt >= 0) {
        hasReset = false;
        BackToFull(station);
      } else if (!hasReset) {
        RECT box;
        if (TakePlaced(out box)) {
          Send(new Dictionary<string, object> { { "type", "place" }, { "x", box.L }, { "y", box.T }, { "w", box.R - box.L }, { "h", box.B - box.T } });
          Log("Windows placed the app: " + box.L + "," + box.T + " " + (box.R - box.L) + "x" + (box.B - box.T));
          BackToFull(station);
        } else {
          string corrected = Settle(station);
          if (corrected != null) Log("layer corrected, it was: " + corrected);
        }
      }
      if (tick % 5 == 0) StayBehind(station);
      if (watching) {
        FollowNeighbors();
        if (tick % 50 == 0) FindNeighbors();
      }
    }

    /* ---------- Finding windows ---------- */

    static string ProgramPath(uint pid) {
      IntPtr p = OpenProcess(0x1000, false, pid);
      if (p == IntPtr.Zero) return "";
      try { var s = new StringBuilder(1024); int n = 1024; return QueryFullProcessImageName(p, 0, s, ref n) ? s.ToString() : ""; }
      finally { CloseHandle(p); }
    }

    static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }

    // Linux windows are hosted by msrdc, so a terminal called "Station 256" can't be mistaken for it.
    static IntPtr FindStation() {
      IntPtr found = IntPtr.Zero;
      EnumWindows((h, l) => {
        if (!IsWindowVisible(h) || !Regex.IsMatch(Title(h), @"^Station 256( \(|$)")) return true;
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (Path.GetFileNameWithoutExtension(ProgramPath(pid)).ToLower() != "msrdc") return true;
        found = h;
        return false;
      }, IntPtr.Zero);
      return found;
    }

    static RECT WorkArea() { var r = new RECT(); SystemParametersInfo(48, 0, ref r, 0); return r; }
    static RECT Bounds(IntPtr h) { RECT r; GetWindowRect(h, out r); return r; }

    // What you actually see. Windows have an invisible edge around them.
    static RECT Seen(IntPtr h) {
      RECT seen;
      if (DwmGetWindowAttribute(h, 9, out seen, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out seen);
      return seen;
    }

    static bool IsFull(RECT r) {
      RECT a = WorkArea();
      return r.L <= a.L + 2 && r.T <= a.T + 2 && r.R >= a.R - 2 && r.B >= a.B - 2;
    }

    // Real app windows only, most recently used first: the same kind of list Windows offers.
    static List<IntPtr> AppWindows() {
      var list = new List<IntPtr>();
      var skipClasses = new HashSet<string> { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow" };
      EnumWindows((h, l) => {
        if (!IsWindowVisible(h) || Title(h) == "" || GetWindow(h, 4) != IntPtr.Zero) return true;
        if ((GetWindowLong(h, -20) & 0x80) != 0) return true; // tool windows
        int cloaked = 0;
        DwmGetWindowAttribute(h, 14, out cloaked, 4);
        if (cloaked != 0) return true;                        // on another desktop, or hidden by Windows
        var c = new StringBuilder(256); GetClassName(h, c, 256);
        if (skipClasses.Contains(c.ToString())) return true;
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (Path.GetFileNameWithoutExtension(ProgramPath(pid)).ToLower() == "msrdc") return true;
        list.Add(h);
        return true;
      }, IntPtr.Zero);
      return list;
    }

    static string IconFor(string path) {
      string known;
      if (icons.TryGetValue(path, out known)) return known;
      string result = "";
      try {
        using (Icon icon = Icon.ExtractAssociatedIcon(path))
        using (Bitmap bitmap = icon.ToBitmap())
        using (var stream = new MemoryStream()) {
          bitmap.Save(stream, ImageFormat.Png);
          result = Convert.ToBase64String(stream.ToArray());
        }
      } catch { }
      icons[path] = result;
      return result;
    }

    // A small picture of a window, for the tray. A frozen app can't hold this up.
    static string Thumbnail(IntPtr h) {
      if (IsIconic(h)) return "";
      try {
        var work = Task.Run(() => {
          RECT r; GetWindowRect(h, out r);
          int w = r.R - r.L, ht = r.B - r.T;
          if (w < 10 || ht < 10) return "";
          using (var full = new Bitmap(w, ht))
          using (var g = Graphics.FromImage(full)) {
            IntPtr dc = g.GetHdc();
            bool ok = PrintWindow(h, dc, 2);
            g.ReleaseHdc(dc);
            if (!ok) return "";
            // Older apps that don't know about display scaling draw smaller than their window.
            // Only the part you'd actually see is kept.
            RECT seen = Seen(h);
            uint windowDpi = GetDpiForWindow(h), systemDpi = GetDpiForSystem();
            double scale = windowDpi > 0 && systemDpi > 0 ? (double)windowDpi / systemDpi : 1;
            var keep = new Rectangle((int)((seen.L - r.L) * scale), (int)((seen.T - r.T) * scale),
              Math.Max(1, (int)((seen.R - seen.L) * scale)), Math.Max(1, (int)((seen.B - seen.T) * scale)));
            int smallW = 400, smallH = Math.Max(1, keep.Height * smallW / keep.Width);
            using (var small = new Bitmap(smallW, smallH))
            using (var s = Graphics.FromImage(small))
            using (var stream = new MemoryStream()) {
              s.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
              s.DrawImage(full, new Rectangle(0, 0, smallW, smallH), keep, GraphicsUnit.Pixel);
              small.Save(stream, ImageFormat.Jpeg);
              return Convert.ToBase64String(stream.ToArray());
            }
          }
        });
        return work.Wait(500) ? work.Result : "";
      } catch { return ""; }
    }

    static string Accent() {
      uint c; bool o;
      return DwmGetColorizationColor(out c, out o) == 0 ? "#" + (c & 0xFFFFFF).ToString("X6") : "";
    }

    /* ---------- Keeping the layer right ---------- */

    static int resetAt = 0;
    static bool hasReset = false;
    static int quietUntil = 0;
    static int notFullSince = 0;

    // Back to covering the whole screen, which is what the Linux side believes it's doing.
    static void BackToFull(IntPtr h) {
      if (IsIconic(h)) return; // resetting a minimized window would bring it back
      quietUntil = Environment.TickCount + 1200; // sizes passing by while it resets don't count
      RECT a = WorkArea();
      SetWindowPos(h, IntPtr.Zero, a.L, a.T, a.R - a.L, a.B - a.T, 0x0014);
      // Maximizing also brings a window to the front and makes it the active one. So it only
      // happens while the app is the active window: it must never jump in front of a window you've
      // moved on to. Settle maximizes it once you come back to it.
      if (!IsZoomed(h) && GetForegroundWindow() == h) ShowWindow(h, 3);
    }

    // A safety check that runs all the time. Maximizing can leave the layer as big as the whole
    // monitor, which would cover the taskbar. And after coming back from minimized, it needs
    // maximizing again.
    static string Settle(IntPtr h) {
      if (IsIconic(h) || Environment.TickCount - quietUntil < 0) { notFullSince = 0; return null; }
      RECT r = Bounds(h);
      RECT a = WorkArea();
      bool covers = r.L == a.L && r.T == a.T && r.R == a.R && r.B == a.B;
      bool right = IsZoomed(h) && covers;
      // Behind a window you've moved on to, covering the screen is enough for now (see BackToFull).
      if (!right && covers && GetForegroundWindow() != h) right = true;
      if (right) { notFullSince = 0; return null; }
      if (notFullSince == 0) notFullSince = Environment.TickCount;
      if (Environment.TickCount - notFullSince < 400) return null; // anything in progress gets time to finish
      notFullSince = 0;
      string was = r.L + "," + r.T + " " + (r.R - r.L) + "x" + (r.B - r.T) + " maximized=" + IsZoomed(h);
      BackToFull(h);
      return was;
    }

    /* Windows only holds the layer where it snapped it for a few milliseconds before the Linux side
       moves it back, which is too quick to catch by checking now and then. So Windows tells this
       the moment it moves, on its own thread. */
    static readonly object placedLock = new object();
    static WinEventProc keepAlive;
    static IntPtr watchedWindow = IntPtr.Zero;
    static uint hookThread = 0;
    static bool hasPlaced = false;
    static RECT placed;

    static void OnMoved(IntPtr hook, uint type, IntPtr h, int idObject, int idChild, uint thread, uint time) {
      if (h != watchedWindow || idObject != 0) return;
      CheckKeys();
      if (Environment.TickCount - quietUntil < 0) return;
      RECT r = Bounds(h);
      RECT a = WorkArea();
      // A snap is always smaller than the screen. Nearly full size just means it's coming back from
      // being minimized, or resetting.
      bool nearlyFull = r.R - r.L >= a.R - a.L - 4 && r.B - r.T >= a.B - a.T - 4;
      if (nearlyFull || r.L <= -1000 || r.R - r.L < 50 || IsIconic(h)) return;
      lock (placedLock) { placed = r; hasPlaced = true; }
    }

    static void Watch(IntPtr h) {
      if (h == watchedWindow) return;
      if (hookThread != 0) PostThreadMessage(hookThread, 0x0012, IntPtr.Zero, IntPtr.Zero);
      watchedWindow = h;
      hookThread = 0;
      lock (placedLock) { hasPlaced = false; }
      if (h == IntPtr.Zero) return;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var thread = new Thread(() => {
        hookThread = GetCurrentThreadId();
        keepAlive = OnMoved;
        IntPtr hook = SetWinEventHook(0x800B, 0x800B, IntPtr.Zero, keepAlive, pid, 0, 0x0000);
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
        UnhookWinEvent(hook);
      });
      thread.IsBackground = true;
      thread.Start();
    }

    static bool TakePlaced(out RECT r) {
      lock (placedLock) { r = placed; bool had = hasPlaced; hasPlaced = false; return had; }
    }

    /* Win + an arrow key on the app. Windows can't move it the way a normal window moves, since it
       isn't really where it looks. So the key itself is what gets passed on. */
    static readonly object keyLock = new object();
    static readonly int[] arrows = { 0x25, 0x26, 0x27, 0x28 };
    static readonly string[] arrowNames = { "L", "U", "R", "D" };
    static string pendingKey = null;
    static string heldKey = null;

    static void CheckKeys() {
      lock (keyLock) {
        bool win = (GetAsyncKeyState(0x5B) & 0x8000) != 0 || (GetAsyncKeyState(0x5C) & 0x8000) != 0;
        string down = null;
        for (int i = 0; i < arrows.Length; i++) {
          if ((GetAsyncKeyState(arrows[i]) & 0x8000) != 0) down = arrowNames[i];
        }
        if (down == null) { heldKey = null; return; }
        if (!win || watchedWindow == IntPtr.Zero || GetForegroundWindow() != watchedWindow || down == heldKey) return;
        heldKey = down; // holding the key down only counts once
        pendingKey = down;
        quietUntil = Environment.TickCount + 1200; // the move Windows makes for this key doesn't count too
      }
    }

    static string TakeKey() {
      lock (keyLock) { string key = pendingKey; pendingKey = null; return key; }
    }

    /* ---------- Side-by-side windows ---------- */

    // One edge of a Windows app that lies on one of the app's edges.
    class Partner {
      public IntPtr H;
      public string Edge; // which edge of Station 256: left, right, top or bottom
      public char Own;    // which of this window's edges is on it: L, T, R or B
      public bool Facing; // true if it sits right beside the app, rather than just lined up with it
      public RECT Last;
    }

    const int Touching = 10; // how close two edges can be and still count as side by side
    static readonly object trackLock = new object();
    static readonly List<Partner> tracked = new List<Partner>();
    static bool watching = false;
    static RECT app;
    static string lastNeighbors = "";
    static int ownMoveUntil = 0;

    static int Coord(RECT r, char side) { return side == 'L' ? r.L : side == 'R' ? r.R : side == 'T' ? r.T : r.B; }
    static bool Horizontal(string edge) { return edge == "left" || edge == "right"; }

    static int Along(RECT a, RECT b, bool leftRight) {
      return leftRight ? Math.Min(a.B, b.B) - Math.Max(a.T, b.T) : Math.Min(a.R, b.R) - Math.Max(a.L, b.L);
    }

    static void FindNeighbors() {
      RECT area = WorkArea();
      var found = new List<Partner>();
      var windows = AppWindows().Where((h) => !IsIconic(h) && !IsZoomed(h)).Select((h) => new { H = h, R = Seen(h) }).ToList();
      Action<string, int, char, char> scan = (edge, line, facing, lined) => {
        // A screen edge has nothing on the other side of it.
        bool leftRight = Horizontal(edge);
        if (line <= (leftRight ? area.L : area.T) + 2 || line >= (leftRight ? area.R : area.B) - 2) return;
        var beside = windows.Where((w) => Math.Abs(Coord(w.R, facing) - line) <= Touching && Along(w.R, app, leftRight) > 80).ToList();
        if (beside.Count == 0) return;
        foreach (var w in beside) found.Add(new Partner { H = w.H, Edge = edge, Own = facing, Facing = true, Last = w.R });
        // Others lined up on the same line move with it, such as the window under this one.
        foreach (var w in windows) {
          int along = Along(w.R, app, leftRight);
          if (beside.Any((b) => b.H == w.H) || along > 8 || along < -Touching) continue;
          if (Math.Abs(Coord(w.R, lined) - line) <= Touching) found.Add(new Partner { H = w.H, Edge = edge, Own = lined, Facing = false, Last = w.R });
          else if (Math.Abs(Coord(w.R, facing) - line) <= Touching) found.Add(new Partner { H = w.H, Edge = edge, Own = facing, Facing = false, Last = w.R });
        }
      };
      scan("right", app.R, 'L', 'R');
      scan("left", app.L, 'R', 'L');
      scan("bottom", app.B, 'T', 'B');
      scan("top", app.T, 'B', 'T');
      lock (trackLock) { tracked.Clear(); tracked.AddRange(found); }
      ReportNeighbors();
    }

    static void ReportNeighbors() {
      Func<string, bool> has;
      lock (trackLock) {
        var edges = tracked.Where((p) => p.Facing).Select((p) => p.Edge).Distinct().ToList();
        has = (e) => edges.Contains(e);
      }
      string now = (has("left") ? "L" : "") + (has("right") ? "R" : "") + (has("top") ? "T" : "") + (has("bottom") ? "B" : "");
      if (now == lastNeighbors) return;
      lastNeighbors = now;
      Send(new Dictionary<string, object> {
        { "type", "neighbors" }, { "left", has("left") }, { "right", has("right") }, { "top", has("top") }, { "bottom", has("bottom") },
      });
    }

    // Moves one edge of a window, leaving the others alone. Returns where that edge really ended up,
    // since an app can refuse to get smaller than its own minimum size.
    static int MoveEdge(Partner p, int at) {
      RECT r = Bounds(p.H);
      RECT seen = Seen(p.H);
      if (IsHungAppWindow(p.H)) return Coord(seen, p.Own); // a frozen app would hold everything up
      RECT want = seen;
      if (p.Own == 'L') want.L = at; else if (p.Own == 'R') want.R = at; else if (p.Own == 'T') want.T = at; else want.B = at;
      SetWindowPos(p.H, IntPtr.Zero, want.L - (seen.L - r.L), want.T - (seen.T - r.T),
        (want.R - want.L) + (r.R - r.L) - (seen.R - seen.L), (want.B - want.T) + (r.B - r.T) - (seen.B - seen.T), 0x0214);
      // An app at its minimum size stays that size. If its far edge got pushed out, it comes back.
      RECT now = Seen(p.H);
      int pushX = p.Own == 'L' ? want.R - now.R : 0;
      int pushY = p.Own == 'T' ? want.B - now.B : 0;
      if (pushX != 0 || pushY != 0) {
        RECT frame = Bounds(p.H);
        SetWindowPos(p.H, IntPtr.Zero, frame.L + pushX, frame.T + pushY, 0, 0, 0x0215);
        now = Seen(p.H);
      }
      // A window can be on two lines at once, such as the bottom corner of a grid.
      lock (trackLock) { foreach (var same in tracked.Where((q) => q.H == p.H)) same.Last = now; }
      return Coord(now, p.Own);
    }

    // The app's edge is being dragged, so everything on that line goes with it.
    static void MoveSeam(string edge, int at, Partner except) {
      List<Partner> line;
      lock (trackLock) { line = tracked.Where((p) => p.Edge == edge && p != except).ToList(); }
      if (except == null) ownMoveUntil = Environment.TickCount + 400;
      int limit = at;
      foreach (var p in line) {
        int actual = MoveEdge(p, at);
        if (Math.Abs(actual - at) > 2) limit = actual;
      }
      if (limit != at && except == null) {
        Send(new Dictionary<string, object> { { "type", "seam-limit" }, { "edge", edge }, { "at", limit } });
      }
      if (edge == "right") app.R = limit; else if (edge == "left") app.L = limit; else if (edge == "bottom") app.B = limit; else app.T = limit;
    }

    // A neighbor's own edge being dragged in Windows: the app follows it, live.
    static void FollowNeighbors() {
      if (Environment.TickCount - ownMoveUntil < 0) return; // a seam dragged from the app's side is moving them
      List<Partner> copy;
      lock (trackLock) { copy = tracked.ToList(); }
      bool changed = false;
      foreach (var p in copy) {
        if (!IsWindow(p.H) || IsIconic(p.H) || IsZoomed(p.H)) { lock (trackLock) { tracked.Remove(p); } changed = true; continue; }
        RECT now = Seen(p.H);
        RECT was = p.Last;
        if (now.L == was.L && now.T == was.T && now.R == was.R && now.B == was.B) continue;
        // Only this one edge moved: it's being resized. Anything else means it was moved away.
        bool onlyOwn = (p.Own == 'L' || now.L == was.L) && (p.Own == 'R' || now.R == was.R) && (p.Own == 'T' || now.T == was.T) && (p.Own == 'B' || now.B == was.B);
        if (!onlyOwn) { lock (trackLock) { tracked.Remove(p); } changed = true; continue; }
        p.Last = now;
        if (!p.Facing) continue;
        int at = Coord(now, p.Own);
        Send(new Dictionary<string, object> { { "type", "neighbor-moved" }, { "edge", p.Edge }, { "at", at } });
        MoveSeam(p.Edge, at, p);
      }
      if (changed) ReportNeighbors();
    }

    /* ---------- The live link to the app ---------- */

    static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    static readonly object linkLock = new object();
    static TcpClient link = null;
    static NetworkStream linkStream = null;

    static void OpenLink() {
      lock (linkLock) { if (link != null) return; }
      string token;
      try { token = File.ReadAllText(tokenFile).Trim(); } catch { return; }
      var client = new TcpClient();
      try {
        client.NoDelay = true;
        client.Connect("127.0.0.1", Port);
      } catch {
        client.Close();
        return;
      }
      lock (linkLock) { link = client; linkStream = client.GetStream(); }
      Send(new Dictionary<string, object> { { "token", token } });
      // The app needs to know if files are already copied in Windows, from before it was open, and
      // gets the text copied in Windows, unless the house has it already: Station 256 has just
      // opened, so Windows has the newer copy. (Windows itself sends nothing when the listener
      // starts; this is the only news at the start.)
      var form = catcherForm;
      if (form != null) { try { form.BeginInvoke(new Action(SendClipboard)); } catch { } }
      var reader = new Thread(() => ReadLink(client));
      reader.IsBackground = true;
      reader.Start();
    }

    static void CloseLink() {
      lock (linkLock) {
        if (link != null) { try { link.Close(); } catch { } }
        link = null;
        linkStream = null;
      }
    }

    static void Send(Dictionary<string, object> message) {
      byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(message) + "\n");
      lock (linkLock) {
        if (linkStream == null) return;
        try { linkStream.Write(bytes, 0, bytes.Length); }
        catch { try { link.Close(); } catch { } link = null; linkStream = null; }
      }
    }

    static void ReadLink(TcpClient client) {
      try {
        using (var reader = new StreamReader(client.GetStream(), Encoding.UTF8)) {
          string line;
          while ((line = reader.ReadLine()) != null) {
            try { Handle(json.Deserialize<Dictionary<string, object>>(line)); } catch { }
          }
        }
      } catch { }
      lock (linkLock) { if (link == client) { link = null; linkStream = null; } }
      lastNeighbors = "";
    }

    static int Num(Dictionary<string, object> m, string key) { return Convert.ToInt32(m[key]); }

    static void Handle(Dictionary<string, object> m) {
      string op = (string)m["op"];
      if (op == "list") {
        bool pictures = Convert.ToBoolean(m["pictures"]);
        var windows = AppWindows().Select((h) => {
          uint pid; GetWindowThreadProcessId(h, out pid);
          string path = ProgramPath(pid);
          RECT seen = Seen(h);
          return new Dictionary<string, object> {
            { "Id", h.ToInt64() }, { "Title", Title(h) }, { "Icon", path == "" ? "" : IconFor(path) },
            { "Thumb", pictures ? Thumbnail(h) : "" }, { "X", seen.L }, { "Y", seen.T }, { "W", seen.R - seen.L }, { "H", seen.B - seen.T },
          };
        }).ToList();
        Send(new Dictionary<string, object> { { "type", "reply" }, { "id", m["id"] }, { "Accent", Accent() }, { "Windows", windows } });
      } else if (op == "move") {
        // Only a window that's really on the list can be moved.
        IntPtr h = new IntPtr(Convert.ToInt64(m["id"]));
        if (AppWindows().Contains(h)) {
          Place(h, Num(m, "x"), Num(m, "y"), Num(m, "w"), Num(m, "h"), Convert.ToBoolean(m["focus"]));
          if (watching) FindNeighbors();
        }
      } else if (op == "watch") {
        watching = true;
        app = new RECT { L = Num(m, "x"), T = Num(m, "y"), R = Num(m, "x") + Num(m, "w"), B = Num(m, "y") + Num(m, "h") };
        FindNeighbors();
      } else if (op == "unwatch") {
        watching = false;
        lock (trackLock) { tracked.Clear(); }
        lastNeighbors = "";
      } else if (op == "seam") {
        MoveSeam((string)m["edge"], Num(m, "at"), null);
      } else if (op == "drop-area") {
        lock (dropLock) {
          dropBox = new RECT { L = Num(m, "x"), T = Num(m, "y"), R = Num(m, "x") + Num(m, "w"), B = Num(m, "y") + Num(m, "h") };
          dropOpen = Convert.ToBoolean(m["open"]);
          dropOn = true;
        }
      } else if (op == "drop-off") {
        lock (dropLock) { dropOn = false; }
      } else if (op == "clipboard-files") {
        // Asked for only when you paste, and the house checks the lock before it asks.
        string[] files = new string[0];
        var form = catcherForm;
        if (form != null) { try { files = (string[])form.Invoke(new Func<string[]>(ClipboardFiles)); } catch { } }
        Send(new Dictionary<string, object> { { "type", "reply" }, { "id", m["id"] }, { "files", files } });
      } else if (op == "clipboard-image") {
        // Asked for only when you paste, and only once the house heard a picture was copied.
        byte[] png = null;
        var form = catcherForm;
        if (form != null) { try { png = (byte[])form.Invoke(new Func<byte[]>(ClipboardPicture)); } catch { } }
        var reply = new Dictionary<string, object> { { "type", "reply" }, { "id", m["id"] } };
        if (png != null) reply["png"] = Convert.ToBase64String(png);
        Send(reply);
      } else if (op == "clipboard-clear") {
        // Lock is closed: Windows gives back text that came across from the house, but only while
        // it still holds exactly that text (a newer copy in Windows stays).
        var reply = new Dictionary<string, object> { { "type", "reply" }, { "id", m["id"] } };
        var form = catcherForm;
        if (form != null) {
          try {
            form.Invoke(new Action(() => {
              string gone = m.ContainsKey("text") ? m["text"] as string : null;
              if (!string.IsNullOrEmpty(gone) && ClipboardText() == gone) {
                System.Windows.Forms.Clipboard.Clear();
                ourChange = GetClipboardSequenceNumber();
                houseHas = null;
              }
            }));
            reply["ok"] = true;
          } catch (Exception e) { reply["error"] = e.Message; }
        }
        Send(reply);
      } else if (op == "clipboard-set") {
        // Copied in the house, so it can be pasted in Windows too. The house sends this only when
        // you copy something there.
        var reply = new Dictionary<string, object> { { "type", "reply" }, { "id", m["id"] } };
        string problem = "The clipboard isn't ready yet.";
        var form = catcherForm;
        if (form != null) {
          try { problem = (string)form.Invoke(new Func<string>(() => SetClipboard(m))); }
          catch (Exception e) { problem = e.Message; }
        }
        if (problem == null) reply["ok"] = true;
        else reply["error"] = problem;
        Send(reply);
      } else if (op == "open-file") {
        // A house file the house itself can't show, opened in a Windows app. "pick" shows Windows'
        // own "Open with" list. Only files inside the house, never a program, never a folder climb.
        string target = (string)m["target"];
        bool pick = m.ContainsKey("pick") && Convert.ToBoolean(m["pick"]);
        var reply = new Dictionary<string, object> { { "type", "reply" }, { "id", m["id"] } };
        try {
          bool climbs = target.Split('\\').Any((part) => part == ".." || part == ".");
          if (!target.StartsWith(@"\\wsl.localhost\", StringComparison.OrdinalIgnoreCase) || climbs) throw new Exception("Only files in the house can be opened this way.");
          string ext = Path.GetExtension(target).ToLowerInvariant();
          string[] runnable = { ".exe", ".com", ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".msi", ".msp", ".scr", ".pif", ".lnk", ".url", ".hta", ".cpl", ".reg", ".jar", ".appref-ms" };
          if (!pick && runnable.Contains(ext)) throw new Exception("Programs and scripts aren't started from here, to keep the house safe.");
          if (!File.Exists(target)) throw new Exception("That file isn't there anymore.");
          if (pick) System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("rundll32.exe", "shell32.dll,OpenAs_RunDLL " + target) { UseShellExecute = false });
          else System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(target) { UseShellExecute = true });
          reply["ok"] = true;
          Log((pick ? "open with: " : "opened in Windows: ") + target);
        } catch (Exception e) { reply["error"] = e.Message; }
        Send(reply);
      } else if (op == "display-scale") {
        // Windows' display scale (125% is 1.25), read from the setting, so a page at 100% in
        // Station's Web Browser is as big as in a normal browser.
        var reply = new Dictionary<string, object> { { "type", "reply" }, { "id", m["id"] } };
        double dpi = 96;
        try { dpi = Convert.ToDouble(Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Control Panel\Desktop\WindowMetrics", "AppliedDPI", 96)); } catch { }
        reply["scale"] = dpi >= 96 && dpi <= 480 ? dpi / 96.0 : 1.0;
        Send(reply);
      } else if (op == "open-url") {
        // A web link clicked in the app, opened in your browser. Only http and https: never a file,
        // a program or another kind of link.
        var reply = new Dictionary<string, object> { { "type", "reply" }, { "id", m["id"] } };
        try {
          Uri uri;
          if (!Uri.TryCreate(Convert.ToString(m["url"]), UriKind.Absolute, out uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)) {
            throw new Exception("Only web links (http and https) open from here.");
          }
          OpenInBrowser(uri);
          reply["ok"] = true;
          Log("opened in the browser: " + uri.Scheme + "://" + uri.Authority);
        } catch (Exception e) { reply["error"] = e.Message; }
        Send(reply);
      } else if (op == "notify") {
        try { Notify(m); } catch (Exception e) { Log("notification: couldn't show: " + (e.InnerException ?? e).Message); }
      } else if (op == "unnotify") {
        try { Unnotify(Convert.ToString(m["tag"])); } catch { }
      } else if (op == "front") {
        // Whether one of the app's windows is the one in front, so it doesn't notify about what
        // you're already looking at.
        Send(new Dictionary<string, object> { { "type", "reply" }, { "id", m["id"] }, { "front", IsAppWindow(GetForegroundWindow()) } });
      } else if (op == "raise") {
        var raiser = new Thread(RaiseStation);
        raiser.IsBackground = true;
        raiser.Start();
      } else if (op == "copy-in") {
        // Only asked for while the Windows door is unlocked. Runs on its own, since a big folder
        // from a network drive can take a while and everything else has to keep working meanwhile.
        object id = m["id"];
        string source = (string)m["source"], target = (string)m["target"];
        var worker = new Thread(() => {
          var reply = new Dictionary<string, object> { { "type", "reply" }, { "id", id } };
          // How far along, a few times a second, so the app can show it.
          long done = 0;
          int lastTold = Environment.TickCount;
          Action<long> counted = (bytes) => {
            done += bytes;
            if (Environment.TickCount - lastTold < 150) return;
            lastTold = Environment.TickCount;
            Send(new Dictionary<string, object> { { "type", "copy-progress" }, { "id", id }, { "done", done } });
          };
          try {
            reply["failed"] = 0;
            reply["first"] = "";
            var problems = CopyIntoHouse(source, target, counted);
            reply["failed"] = problems.Count;
            if (problems.Count > 0) reply["first"] = problems[0];
            Log("copied into the house from " + source + (problems.Count > 0 ? ", " + problems.Count + " problem(s)" : ""));
          } catch (Exception e) { reply["error"] = e.Message; }
          Send(reply);
        });
        worker.IsBackground = true;
        worker.Start();
      } else if (op == "measure") {
        object id = m["id"];
        string source = (string)m["source"];
        var worker = new Thread(() => {
          long bytes = 0;
          try { bytes = SizeOf(source, true); } catch { }
          Send(new Dictionary<string, object> { { "type", "reply" }, { "id", id }, { "bytes", bytes } });
        });
        worker.IsBackground = true;
        worker.Start();
      }
    }

    // How much copying something will bring, following the same rules as the copy itself.
    static long SizeOf(string source, bool picked) {
      try {
        var attributes = File.GetAttributes(Long(source));
        if ((attributes & FileAttributes.Directory) == 0) return new FileInfo(Long(source)).Length;
        if ((attributes & FileAttributes.ReparsePoint) != 0 && !picked) return 0;
        long total = 0;
        foreach (string entry in Directory.GetFileSystemEntries(Long(source))) total += SizeOf(Short(entry), false);
        return total;
      } catch { return 0; }
    }

    static string Short(string path) {
      return path.StartsWith(@"\\?\UNC\") ? @"\\" + path.Substring(8) : path.StartsWith(@"\\?\") ? path.Substring(4) : path;
    }

    /* ---------- Copying into the house from anywhere in Windows ---------- */

    /* For places the house can't read itself, such as a network drive. The house picks the target:
       always in the house, never one that already exists. Folder links are left out, so nothing can
       loop. Long paths work through the \\?\ form. One file failing doesn't stop the rest; the house
       is told how many failed and the first reason. */
    static List<string> CopyIntoHouse(string source, string target, Action<long> counted) {
      bool parentStep = source.Split('\\').Any((part) => part == ".." || part == ".") || target.Split('\\').Any((part) => part == ".." || part == ".");
      if (!target.StartsWith(@"\\wsl.localhost\", StringComparison.OrdinalIgnoreCase) || parentStep) throw new Exception("That can't be copied there.");
      if (File.Exists(Long(target)) || Directory.Exists(Long(target))) throw new Exception("Something with that name is already there.");
      var problems = new List<string>();
      CopyOne(source, target, problems, true, counted);
      return problems;
    }

    // A piece at a time, so progress can be counted. Keeps the date modified, as Explorer does.
    // A file that fails partway is removed, so nothing half-copied is left behind.
    static void CopyFile(string source, string target, Action<long> counted) {
      using (var input = new FileStream(Long(source), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16)) {
        var output = new FileStream(Long(target), FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16); // only ever a new file
        try {
          var buffer = new byte[1 << 20];
          int read;
          while ((read = input.Read(buffer, 0, buffer.Length)) > 0) {
            output.Write(buffer, 0, read);
            counted(read);
          }
          output.Dispose();
        } catch {
          output.Dispose();
          try { File.Delete(Long(target)); } catch { }
          throw;
        }
      }
      try { File.SetLastWriteTimeUtc(Long(target), File.GetLastWriteTimeUtc(Long(source))); } catch { }
    }

    static string Long(string path) {
      if (path.StartsWith(@"\\?\")) return path;
      return path.StartsWith(@"\\") ? @"\\?\UNC\" + path.Substring(2) : @"\\?\" + path;
    }

    static void CopyOne(string source, string target, List<string> problems, bool picked, Action<long> counted) {
      string name = Path.GetFileName(source.TrimEnd('\\'));
      try {
        var attributes = File.GetAttributes(Long(source));
        if ((attributes & FileAttributes.Directory) != 0) {
          if ((attributes & FileAttributes.ReparsePoint) != 0 && !picked) return; // a folder link inside
          Directory.CreateDirectory(Long(target));
          foreach (string entry in Directory.GetFileSystemEntries(Long(source))) {
            string inner = Short(entry);
            CopyOne(inner, target + "\\" + Path.GetFileName(inner), problems, false, counted);
          }
          try { Directory.SetLastWriteTimeUtc(Long(target), Directory.GetLastWriteTimeUtc(Long(source))); } catch { }
        } else {
          CopyFile(source, target, counted);
        }
      } catch (Exception e) {
        problems.Add(name + ": " + e.Message.Replace(@"\\?\UNC\", @"\\").Replace(@"\\?\", "").Trim());
      }
    }

    // A mapped network drive, such as Z:, as the network path it stands for. Others stay as they are.
    static string Unmapped(string path) {
      if (path.Length < 3 || path[1] != ':' || path[2] != '\\') return path;
      var remote = new StringBuilder(1024);
      int length = remote.Capacity;
      if (WNetGetConnection(path.Substring(0, 2), remote, ref length) != 0) return path;
      return remote.ToString().TrimEnd('\\') + path.Substring(2);
    }

    /* ---------- One clipboard with the house ---------- */

    /* Windows says whenever the clipboard changes. For files, the app only hears how many are
       copied, so it can turn Paste on. Which files, it only learns when you paste, and only through
       the house, which won't ask while the Windows door is locked. Text copied in Windows is passed
       to the house right away, so it pastes there like in any Windows app, unless the app that
       copied it asked for it to be left alone (password managers do).

       A picture copied in Windows (a screen snip, say) works like files: the app only hears that
       there is one, so pasting can use it. The picture itself, as a PNG, is only passed when you
       paste (clipboard-image). A picture that comes with text, as from Word or Excel, counts as
       text, since that's what it pastes as in a terminal.

       The other way, what you copy in the house is put here (clipboard-set): text, or house files,
       which File Explorer can then paste. Nothing bounces back: a change the house made is marked
       "ours" so the app ignores it, and text the house already has isn't sent to it again.

       WSLg, which shows Linux apps on Windows, carries text both ways by itself too, through its
       own program, msrdc. It can crash, taking every Linux window with it, when both sides change
       the clipboard in the same moment. So news of a change waits a moment for WSLg to finish,
       a change WSLg made counts as the house's own, and text is only put here if Windows doesn't
       have it yet.

       The clipboard can only be used on the catcher's thread, so all of this runs there. */
    static Catcher catcherForm = null;
    const int MaxClipboardText = 1 << 20;  // about a million characters, each way
    static uint ourChange = 0;              // Windows' number for the last change the house made
    static string houseHas = null;          // the text the house has, as far as Windows knows

    static string[] ClipboardFiles() {
      try {
        if (!System.Windows.Forms.Clipboard.ContainsFileDropList()) return new string[0];
        return System.Windows.Forms.Clipboard.GetFileDropList().Cast<string>().Select(Unmapped).ToArray();
      } catch { return new string[0]; } // another app can be holding the clipboard for a moment
    }

    // The text copied in Windows, with Windows' line ends made into the house's. Null when there's
    // none, it's too long, or the app that copied it asked for it not to be passed on.
    static string ClipboardText() {
      try {
        var data = System.Windows.Forms.Clipboard.GetDataObject();
        if (data == null || data.GetDataPresent("ExcludeClipboardContentFromMonitorProcessing") || data.GetDataPresent("Clipboard Viewer Ignore")) return null;
        if (!data.GetDataPresent(System.Windows.Forms.DataFormats.UnicodeText)) return null;
        string text = data.GetData(System.Windows.Forms.DataFormats.UnicodeText) as string;
        if (string.IsNullOrEmpty(text) || text.Length > MaxClipboardText) return null;
        return text.Replace("\r\n", "\n");
      } catch { return null; } // another app can be holding the clipboard for a moment
    }

    // WSLg's msrdc put it there, so it came from a Linux app.
    static bool FromLinux() {
      IntPtr owner = GetClipboardOwner();
      if (owner == IntPtr.Zero) return false;
      uint pid; GetWindowThreadProcessId(owner, out pid);
      return Path.GetFileNameWithoutExtension(ProgramPath(pid)).ToLower() == "msrdc";
    }

    // The clipboard changed. Several changes close together make one, told once things are still.
    static System.Windows.Forms.Timer settle = null;
    static void ClipboardChanged() {
      if (settle == null) {
        settle = new System.Windows.Forms.Timer { Interval = 400 };
        settle.Tick += (s, e) => { settle.Stop(); SendClipboard(); };
      }
      settle.Stop();
      settle.Start();
    }

    static bool HouseCopied() { return (ourChange != 0 && GetClipboardSequenceNumber() == ourChange) || FromLinux(); }

    static void SendClipboard() {
      int files = ClipboardFiles().Length;
      var message = new Dictionary<string, object> { { "type", "clipboard" }, { "files", files } };
      if (HouseCopied()) {
        message["ours"] = true; // what the house copied, put here by this helper or by WSLg
      } else {
        string text = ClipboardText();
        if (text != null && text != houseHas) {
          message["text"] = text;
          houseHas = text;
        }
        if (files == 0 && text == null && ClipboardHasPicture()) message["image"] = true;
      }
      Send(message);
    }

    const int MaxPicture = 64 << 20; // a PNG bigger than this isn't passed on

    static bool Passable(System.Windows.Forms.IDataObject data) {
      return data != null && !data.GetDataPresent("ExcludeClipboardContentFromMonitorProcessing") && !data.GetDataPresent("Clipboard Viewer Ignore");
    }

    static bool ClipboardHasPicture() {
      try {
        var data = System.Windows.Forms.Clipboard.GetDataObject();
        return Passable(data) && (data.GetDataPresent("PNG") || data.GetDataPresent(System.Windows.Forms.DataFormats.Bitmap) || data.GetDataPresent(System.Windows.Forms.DataFormats.Dib));
      } catch { return false; }
    }

    // The picture copied in Windows, as a PNG: as the app gave it when it gave a PNG (screen snips
    // do, keeping see-through parts), otherwise turned into one. Null when the newest copy isn't
    // a picture alone, the house copied it, or the app asked for it not to be passed on.
    static byte[] ClipboardPicture() {
      if (HouseCopied() || ClipboardFiles().Length > 0 || ClipboardText() != null) return null;
      try {
        var data = System.Windows.Forms.Clipboard.GetDataObject();
        if (!Passable(data)) return null;
        if (data.GetDataPresent("PNG")) {
          var stream = data.GetData("PNG") as Stream;
          if (stream != null && stream.Length > 8 && stream.Length <= MaxPicture) {
            var bytes = new byte[stream.Length];
            stream.Position = 0;
            int read = 0;
            while (read < bytes.Length) { int got = stream.Read(bytes, read, bytes.Length - read); if (got <= 0) break; read += got; }
            if (read == bytes.Length && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) return bytes;
          }
        }
        using (var picture = System.Windows.Forms.Clipboard.GetImage()) {
          if (picture == null) return null;
          using (var png = new MemoryStream()) {
            picture.Save(png, System.Drawing.Imaging.ImageFormat.Png);
            return png.Length <= MaxPicture ? png.ToArray() : null;
          }
        }
      } catch { return null; } // another app can be holding the clipboard for a moment
    }

    // Puts what was copied in the house on Windows' clipboard: text, or files inside the house,
    // marked cut or copied the way File Explorer marks them. Says what went wrong, or null.
    static string SetClipboard(Dictionary<string, object> m) {
      var data = new System.Windows.Forms.DataObject();
      string text = null;
      if (m.ContainsKey("files")) {
        var files = new System.Collections.Specialized.StringCollection();
        var list = m["files"] as System.Collections.IEnumerable;
        if (list == null) return "Nothing was copied.";
        foreach (object item in list) {
          string file = item as string;
          if (file == null || file.Contains("/") || file.Split('\\').Any((part) => part == ".." || part == ".")
            || !file.StartsWith(@"\\wsl.localhost\", StringComparison.OrdinalIgnoreCase)) return "Only files in the house can be copied for Windows.";
          files.Add(file);
        }
        if (files.Count == 0) return "Nothing was copied.";
        data.SetFileDropList(files);
        bool move = m.ContainsKey("move") && Convert.ToBoolean(m["move"]);
        data.SetData("Preferred DropEffect", new MemoryStream(BitConverter.GetBytes(move ? 2 : 5))); // 2 cut, 5 copy
      } else {
        text = m.ContainsKey("text") ? m["text"] as string : null;
        if (string.IsNullOrEmpty(text) || text.Length > MaxClipboardText) return "Nothing was copied.";
        text = text.Replace("\r\n", "\n");
        if (ClipboardText() == text) { // WSLg brought it already
          houseHas = text;
          return null;
        }
        data.SetData(System.Windows.Forms.DataFormats.UnicodeText, text.Replace("\n", "\r\n"));
      }
      System.Windows.Forms.Clipboard.SetDataObject(data, true, 10, 50); // tries again while another app holds it
      ourChange = GetClipboardSequenceNumber();
      houseHas = text;
      return null;
    }

    /* ---------- Files dragged in from Windows ---------- */

    /* A Linux window can't take a drop from Windows. So when something is dragged from a Windows app
       onto the app's file list, an invisible catcher appears right there for the drop. It only passes
       on where the files are. The house copies them through the Windows door, so with the lock
       closed nothing comes in, and the catcher says "no" (the pointer shows it). The catcher only
       appears for a drag that started outside the app, over the part of the list you can see. */
    static readonly object dropLock = new object();
    static bool dropOn = false;
    static bool dropOpen = false;
    static RECT dropBox;                      // on the app's layer
    static IntPtr catcher = IntPtr.Zero;
    static bool catcherShown = false;
    static bool buttonWasDown = false;
    static bool pressOutside = false;
    static int hideCatcherAt = 0;
    static string lastOver = "";

    class Catcher : System.Windows.Forms.Form {
      public Catcher() {
        FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = System.Windows.Forms.FormStartPosition.Manual;
        BackColor = Color.White;
        Opacity = 0.01; // can't be seen, but it's still there to drop on
        AllowDrop = true;
      }
      protected override bool ShowWithoutActivation { get { return true; } }
      protected override System.Windows.Forms.CreateParams CreateParams {
        get { var p = base.CreateParams; p.ExStyle |= 0x80 | 0x08000000; return p; } // no taskbar button, never takes focus
      }
      protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        AddClipboardFormatListener(Handle);
      }
      protected override void WndProc(ref System.Windows.Forms.Message m) {
        if (m.Msg == 0x031D) ClipboardChanged();
        base.WndProc(ref m);
      }
    }

    static bool HasFiles(System.Windows.Forms.DragEventArgs e) {
      return e.Data != null && e.Data.GetDataPresent(System.Windows.Forms.DataFormats.FileDrop);
    }

    static bool DoorOpen() { lock (dropLock) { return dropOpen; } }

    static System.Windows.Forms.DragDropEffects Answer(System.Windows.Forms.DragEventArgs e) {
      bool copy = (e.AllowedEffect & System.Windows.Forms.DragDropEffects.Copy) != 0;
      return HasFiles(e) && copy && DoorOpen() ? System.Windows.Forms.DragDropEffects.Copy : System.Windows.Forms.DragDropEffects.None;
    }

    static Dictionary<string, object> OnLayer(string type, int x, int y) {
      RECT layer = Bounds(station);
      return new Dictionary<string, object> { { "type", type }, { "x", x - layer.L }, { "y", y - layer.T } };
    }

    static void StartCatcher() {
      var thread = new Thread(() => {
        var form = new Catcher();
        form.DragEnter += (s, e) => {
          e.Effect = Answer(e);
          lastOver = "";
          if (HasFiles(e)) Send(new Dictionary<string, object> { { "type", "drop-hover" }, { "allowed", DoorOpen() } });
        };
        form.DragOver += (s, e) => {
          e.Effect = Answer(e);
          string at = e.X + "," + e.Y;
          if (e.Effect == System.Windows.Forms.DragDropEffects.None || at == lastOver) return;
          lastOver = at;
          Send(OnLayer("drop-over", e.X, e.Y));
        };
        form.DragLeave += (s, e) => Send(new Dictionary<string, object> { { "type", "drop-leave" } });
        form.DragDrop += (s, e) => {
          if (Answer(e) == System.Windows.Forms.DragDropEffects.None) {
            Send(new Dictionary<string, object> { { "type", "drop-leave" } });
            return;
          }
          var message = OnLayer("drop", e.X, e.Y);
          message["files"] = ((string[])e.Data.GetData(System.Windows.Forms.DataFormats.FileDrop)).Select(Unmapped).ToArray();
          Send(message);
          Log("files dropped from Windows: " + ((string[])message["files"]).Length);
        };
        catcher = form.Handle; // makes the window, still hidden
        catcherForm = form;
        System.Windows.Forms.Application.Run();
      });
      thread.SetApartmentState(ApartmentState.STA); // Windows only hands drops to a thread like this
      thread.IsBackground = true;
      thread.Start();
    }

    // What's really under the pointer: see-through parts of a window don't count.
    static IntPtr TopAt(POINT p) { return GetAncestor(WindowFromPoint(p), 2); }

    static void ShowCatcher(RECT r) {
      SetWindowPos(catcher, new IntPtr(-1), r.L, r.T, r.R - r.L, r.B - r.T, 0x0010 | 0x0040); // on top, no focus
      catcherShown = true;
      hideCatcherAt = 0;
    }

    static void HideCatcher() {
      if (!catcherShown || catcher == IntPtr.Zero) return;
      ShowWindow(catcher, 0);
      catcherShown = false;
    }

    static void Catch() {
      if (catcher == IntPtr.Zero) return;
      int button = GetSystemMetrics(23) != 0 ? 0x02 : 0x01; // the main mouse button, even if swapped
      bool down = (GetAsyncKeyState(button) & 0x8000) != 0;
      POINT p;
      GetCursorPos(out p);
      if (down && !buttonWasDown) pressOutside = !catcherShown && TopAt(p) != station;
      buttonWasDown = down;
      bool on;
      RECT box;
      lock (dropLock) { on = dropOn; box = dropBox; }
      RECT layer = Bounds(station);
      var area = new RECT { L = layer.L + box.L, T = layer.T + box.T, R = layer.L + box.R, B = layer.T + box.B };
      bool inside = p.X >= area.L && p.X < area.R && p.Y >= area.T && p.Y < area.B;
      if (catcherShown) {
        if (down && on && inside) return;
        // When the button comes up, the drop still has to arrive, so the catcher waits a moment.
        if (!down) {
          if (hideCatcherAt == 0) hideCatcherAt = Environment.TickCount + 500;
          if (Environment.TickCount - hideCatcherAt < 0) return;
        }
        HideCatcher();
        return;
      }
      if (down && pressOutside && on && inside && !IsIconic(station) && TopAt(p) == station) ShowCatcher(area);
    }

    /* ---------- Letting another window come to the front ---------- */

    /* Click a Windows app while a Linux window is in front, and the app comes forward as it should.
       But the Linux side can grab the front back a moment later (measured: 15 ms), so the click
       seems not to work and has to be done again. This watches for exactly that: the front going
       from a Linux window to a Windows app, then straight back with nothing you did in between.
       Then the app you picked is put back in front. A click, Alt or the Windows key since means
       the switch back was yours, so it's left alone. */
    const int GrabWindow = 1500;             // ms after the switch that a switch back counts as a grab
    static MouseProc mouseKeep;
    static WinEventProc frontKeep;
    static IntPtr lastFront = IntPtr.Zero;
    static IntPtr picked = IntPtr.Zero;      // the Windows app that just came forward from a Linux window
    static int pickedAt = 0;
    static int pressCount = 0;               // every mouse press anywhere, so a later one can be told apart
    static readonly Dictionary<uint, bool> linuxPids = new Dictionary<uint, bool>();
    static int linuxPidsAt = 0;
    static readonly HashSet<string> shellClasses = new HashSet<string> {
      "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW", "Windows.UI.Core.CoreWindow",
      "ForegroundStaging", "MultitaskingViewFrame", "XamlExplorerHostIslandWindow", "TaskSwitcherWnd",
      "TopLevelWindowForOverflowXamlIsland", "NotifyIconOverflowWindow",
    };

    // Any window from the Linux side: the app itself, a terminal in its own window, anything else.
    static bool IsLinux(IntPtr h) {
      if (h == IntPtr.Zero) return false;
      uint pid; GetWindowThreadProcessId(h, out pid);
      lock (linuxPids) {
        if (Environment.TickCount - linuxPidsAt > 60000) { linuxPids.Clear(); linuxPidsAt = Environment.TickCount; }
        bool known;
        if (!linuxPids.TryGetValue(pid, out known)) {
          known = Path.GetFileNameWithoutExtension(ProgramPath(pid)).ToLower() == "msrdc";
          linuxPids[pid] = known;
        }
        return known;
      }
    }

    // A real Windows app window, not the taskbar, Start, the desktop or the app switcher.
    static bool IsWindowsApp(IntPtr h) {
      if (h == IntPtr.Zero || h == catcher || !IsWindowVisible(h) || Title(h) == "") return false;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return false;
      int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4);
      if (cloaked != 0) return false;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      return !shellClasses.Contains(c.ToString()) && !IsLinux(h);
    }

    static bool KeyDown(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }

    static bool IsShell(IntPtr h) {
      if (h == IntPtr.Zero) return false;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      return shellClasses.Contains(c.ToString());
    }

    // This helper's own windows, such as the voice typing box.
    static readonly uint ownPid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
    static bool IsOurs(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid == ownPid; }
    static bool IsTopmost(IntPtr h) { return (GetWindowLong(h, -20) & 0x8) != 0; }

    /* ---------- Staying behind the window you're using ---------- */

    /* The app sits in the pile like any other window: whatever you're using is on top. The Linux
       side can bring it forward without making it the active window, and then it covers the app
       you're actually using. This checks for exactly that and puts it straight back behind that
       app. It never takes focus, never moves or resizes anything, and leaves it alone while a mouse
       button is down. If the Linux side keeps fighting it, it stops after 5 tries in 10 seconds
       rather than flicker. */
    static int aboveSince = 0;
    static readonly Queue<int> putBack = new Queue<int>();

    // Whether a sits anywhere above b in the pile.
    static bool IsAbove(IntPtr a, IntPtr b) {
      IntPtr w = GetWindow(b, 3); // the window just above
      for (int i = 0; i < 1000 && w != IntPtr.Zero; i++) {
        if (w == a) return true;
        w = GetWindow(w, 3);
      }
      return false;
    }

    static void StayBehind(IntPtr h) {
      IntPtr front = GetForegroundWindow();
      // A window kept on top (like Task Manager's "always on top") is left out: going just behind
      // one of those would make the app stay on top too.
      bool wrong = front != IntPtr.Zero && front != h && !IsIconic(h) && !KeyDown(0x01) && !KeyDown(0x02)
        && IsWindowsApp(front) && !IsOurs(front) && !IsTopmost(front) && !IsTopmost(h) && IsAbove(h, front);
      if (!wrong) { aboveSince = 0; return; }
      if (aboveSince == 0) { aboveSince = Environment.TickCount; return; }
      if (Environment.TickCount - aboveSince < 150) return; // anything in progress gets a moment
      aboveSince = 0;
      int now = Environment.TickCount;
      while (putBack.Count > 0 && now - putBack.Peek() > 10000) putBack.Dequeue();
      if (putBack.Count >= 5) return;
      putBack.Enqueue(now);
      SetWindowPos(h, front, 0, 0, 0, 0, 0x0013); // just behind it: no move, no resize, no focus
      var c = new StringBuilder(256); GetClassName(front, c, 256);
      Log("went back behind " + c + ": it had come in front of the window you're using");
    }

    static void StartGuard() {
      var thread = new Thread(() => {
        mouseKeep = OnMouse;
        frontKeep = OnFront;
        // Only notes that a button went down. Nothing is changed or held up.
        SetWindowsHookEx(14, mouseKeep, GetModuleHandle(null), 0);
        // Only Win + H on the app is caught. Every other key goes straight on.
        keyKeep = OnKey;
        SetWindowsHookEx(13, keyKeep, GetModuleHandle(null), 0);
        SetWinEventHook(0x0003, 0x0003, IntPtr.Zero, frontKeep, 0, 0, 0x0000);
        lastFront = GetForegroundWindow();
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
      });
      thread.IsBackground = true;
      thread.Start();
    }

    static IntPtr OnMouse(int code, IntPtr w, IntPtr l) {
      int message = w.ToInt32();
      if (code >= 0 && (message == 0x0201 || message == 0x0204 || message == 0x0207 || message == 0x020B)) {
        Interlocked.Increment(ref pressCount);
        picked = IntPtr.Zero; // whatever comes forward next is down to this press
      }
      return CallNextHookEx(IntPtr.Zero, code, w, l);
    }

    static void OnFront(IntPtr hook, uint type, IntPtr h, int idObject, int idChild, uint thread, uint time) {
      try {
        // Switching with the taskbar, Start or Alt+Tab puts one of those in front for a moment on
        // the way, so they don't count as where the front came from.
        if (IsShell(h)) return;
        IntPtr was = lastFront;
        lastFront = h;
        if (IsLinux(h)) {
          IntPtr app = picked;
          if (app == IntPtr.Zero || Environment.TickCount - pickedAt > GrabWindow) return;
          picked = IntPtr.Zero;
          if (KeyDown(0x12) || KeyDown(0x5B) || KeyDown(0x5C) || !IsWindow(app)) return; // Alt+Tab or the Windows key: you chose it
          GiveBack(app, pressCount);
        } else if (IsLinux(was) && IsWindowsApp(h) && !IsOurs(h)) {
          picked = h;
          pickedAt = Environment.TickCount;
        }
      } catch { }
    }

    // Puts the app back in front, and makes sure it stays: the Linux side can try more than once.
    static int givingBack = 0;
    static void GiveBack(IntPtr app, int presses) {
      if (Interlocked.Exchange(ref givingBack, 1) == 1) return;
      var worker = new Thread(() => {
        try {
          int held = 0, tries = 0;
          for (int i = 0; i < 20 && held < 4 && IsWindow(app); i++) {
            if (pressCount != presses) return; // you've clicked something since, so that's yours
            IntPtr front = GetForegroundWindow();
            if (front == app) { held += 1; Thread.Sleep(50); continue; }
            held = 0;
            if (!IsLinux(front)) return;        // something else has come forward: leave it be
            tries += 1;
            // Windows only lets a window be brought forward right after a key press, hence the Alt.
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            SetForegroundWindow(app);
            Thread.Sleep(30);
          }
          var c = new StringBuilder(256); GetClassName(app, c, 256);
          Log("kept " + c + " in front: the Linux side took it back (" + tries + " time(s))");
        } finally { givingBack = 0; }
      });
      worker.IsBackground = true;
      worker.Start();
    }

    static void Place(IntPtr h, int x, int y, int w, int ht, bool focus) {
      if (IsIconic(h) || IsZoomed(h)) ShowWindow(h, 9);
      RECT r = Bounds(h);
      RECT seen = Seen(h);
      SetWindowPos(h, IntPtr.Zero, x - (seen.L - r.L), y - (seen.T - r.T),
        w + (r.R - r.L) - (seen.R - seen.L), ht + (r.B - r.T) - (seen.B - seen.T), 0x0040);
      if (focus) TakeFocus(h);
    }

    // Hands focus from the app to the window just picked. The Linux side takes focus back a moment
    // after a click, so this keeps at it until focus holds. It only ever takes it from the app, so
    // anything else you've clicked on since is left alone. Windows only hands focus to something
    // not in front right after a key press, hence the Alt.
    static void TakeFocus(IntPtr h) {
      var thread = new Thread(() => {
        int held = 0;
        for (int i = 0; i < 15 && held < 3 && IsWindow(h); i++) {
          Thread.Sleep(150);
          IntPtr front = GetForegroundWindow();
          if (front == h) { held += 1; continue; }
          held = 0;
          if (front != station) break;
          keybd_event(0x12, 0, 0, UIntPtr.Zero);
          keybd_event(0x12, 0, 2, UIntPtr.Zero);
          SetForegroundWindow(h);
        }
      });
      thread.IsBackground = true;
      thread.Start();
    }

    /* ---------- Web links ---------- */

    // Opens a web page in your usual browser, in front. The browser may only come forward if this
    // helper is allowed to bring things forward, which Windows only allows right after a key press,
    // hence the Alt. It runs on the window thread, the kind Windows' "open" wants.
    static void OpenInBrowser(Uri uri) {
      Action open = () => {
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        AllowSetForegroundWindow(-1);
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
      };
      var form = catcherForm;
      if (form != null) form.Invoke(open);
      else open();
    }

    /* ---------- Notifications about the AIs in rooms ---------- */

    // Windows' own notifications, sent by the app when a room's AI finishes or needs you
    // (panel/lib/agent-alerts.js). They come from "Station 256", with its icon. A click, or one of
    // the buttons (Approve, Deny, Open), goes back to the app as { type: "notification", id, action,
    // room, tab }, and the app decides what it does. Open brings Station 256 forward first, which
    // only works from here, right after the click.
    // Windows' notification parts are reached by name (they're Windows' newer kind of library),
    // and a click is heard through WindowsRuntimeMarshal, the only way Windows allows for those.

    const string NotifyApp = "Station256.App";
    const string NotifyGroup = "agents";
    static readonly object notesLock = new object();
    static readonly Dictionary<string, object> shownNotes = new Dictionary<string, object>();    // tag -> notification
    static readonly Dictionary<string, string[]> noteTargets = new Dictionary<string, string[]>(); // tag -> room, tab

    static Type WinRT(string name, string library) {
      return Type.GetType(name + ", " + library + ", ContentType=WindowsRuntime", true);
    }

    // Windows names notifications after the app that sends them: this tells it "Station 256" and
    // which logo to show at their top left. Once at start; harmless to do again.
    static void SetUpNotifications() {
      try {
        string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LinuxHouse");
        string png = Path.Combine(folder, "station-256-logo.png");
        string ico = Path.Combine(folder, "station-256-app.ico");
        byte[] logo = File.Exists(ico) ? BiggestPicture(ico) : null;
        if (logo != null && (!File.Exists(png) || !File.ReadAllBytes(png).SequenceEqual(logo))) File.WriteAllBytes(png, logo);
        // Made by an earlier version from the icon the wrong way (it came out as noise).
        string old = Path.Combine(folder, "station-256-notify.png");
        if (File.Exists(old)) File.Delete(old);
        using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Classes\AppUserModelId\" + NotifyApp)) {
          key.SetValue("DisplayName", "Station 256");
          if (File.Exists(png)) key.SetValue("IconUri", png);
        }
      } catch (Exception e) { Log("notifications: couldn't set up: " + e.Message); }
    }

    // The app's .ico keeps each size as a finished PNG picture. The biggest one is taken out as it
    // is: Windows' older drawing code can't read those and turns them into noise. Null if none.
    static byte[] BiggestPicture(string ico) {
      byte[] b = File.ReadAllBytes(ico);
      if (b.Length < 6) return null;
      int count = BitConverter.ToUInt16(b, 4), biggest = 0;
      byte[] best = null;
      for (int i = 0; i < count && 6 + 16 * i + 16 <= b.Length; i++) {
        int at = 6 + 16 * i;
        int width = b[at] == 0 ? 256 : b[at];
        long length = BitConverter.ToUInt32(b, at + 8), offset = BitConverter.ToUInt32(b, at + 12);
        if (length < 8 || offset + length > b.Length) continue;
        bool isPng = b[offset] == 0x89 && b[offset + 1] == 0x50 && b[offset + 2] == 0x4E && b[offset + 3] == 0x47;
        if (!isPng || width <= biggest) continue;
        biggest = width;
        best = new byte[length];
        Array.Copy(b, offset, best, 0, length);
      }
      return best;
    }

    static string NoteText(object value, int max) {
      string text = Regex.Replace(Convert.ToString(value) ?? "", @"[\u0000-\u0009\u000b-\u001f\u007f]", " ");
      return text.Length > max ? text.Substring(0, max) : text;
    }

    static void Notify(Dictionary<string, object> m) {
      string tag = Convert.ToString(m["tag"]), id = Convert.ToString(m["id"]);
      if (!Regex.IsMatch(tag, "^[0-9a-f]{1,32}$") || !Regex.IsMatch(id, "^[0-9a-f]{1,64}$")) return;
      string room = NoteText(m["room"], 80), tab = NoteText(m["tab"], 12);
      string title = NoteText(m["title"], 120);
      string[] body = NoteText(m["body"], 400).Split('\n').Where((line) => line.Trim().Length > 0).Take(2).ToArray();
      var buttons = ((System.Collections.IEnumerable)m["buttons"]).Cast<object>().Select(Convert.ToString).ToList();
      var names = new Dictionary<string, string> { { "approve", "Approve" }, { "deny", "Deny" }, { "open", "Open" } };
      Func<string, string> args = (action) => SecurityElement.Escape("act=" + action + ";id=" + id + ";tag=" + tag);
      var xml = new StringBuilder();
      xml.Append("<toast launch=\"" + args("open") + "\" activationType=\"foreground\"><visual><binding template=\"ToastGeneric\">");
      xml.Append("<text hint-maxLines=\"1\">" + SecurityElement.Escape(title) + "</text>");
      foreach (string line in body) xml.Append("<text>" + SecurityElement.Escape(line) + "</text>");
      xml.Append("</binding></visual><actions>");
      foreach (string button in buttons) {
        if (names.ContainsKey(button)) xml.Append("<action content=\"" + names[button] + "\" arguments=\"" + args(button) + "\" activationType=\"foreground\"/>");
      }
      xml.Append("</actions></toast>");

      var xmlType = WinRT("Windows.Data.Xml.Dom.XmlDocument", "Windows.Data.Xml.Dom");
      var noteType = WinRT("Windows.UI.Notifications.ToastNotification", "Windows.UI.Notifications");
      var managerType = WinRT("Windows.UI.Notifications.ToastNotificationManager", "Windows.UI.Notifications");
      var notifierType = WinRT("Windows.UI.Notifications.ToastNotifier", "Windows.UI.Notifications");
      var doc = Activator.CreateInstance(xmlType);
      xmlType.GetMethod("LoadXml", new[] { typeof(string) }).Invoke(doc, new object[] { xml.ToString() });
      var note = Activator.CreateInstance(noteType, new[] { doc });
      noteType.GetProperty("Tag").SetValue(note, tag);
      noteType.GetProperty("Group").SetValue(note, NotifyGroup);
      var clicked = noteType.GetEvent("Activated");
      var handler = Delegate.CreateDelegate(clicked.EventHandlerType, typeof(Snap).GetMethod("NoteClicked", BindingFlags.NonPublic | BindingFlags.Static));
      typeof(Snap).GetMethod("Listen", BindingFlags.NonPublic | BindingFlags.Static).MakeGenericMethod(clicked.EventHandlerType)
        .Invoke(null, new object[] { note, clicked.GetAddMethod(), clicked.GetRemoveMethod(), handler });
      var notifier = managerType.GetMethod("CreateToastNotifier", new[] { typeof(string) }).Invoke(null, new object[] { NotifyApp });
      notifierType.GetMethod("Show").Invoke(notifier, new[] { note });
      lock (notesLock) {
        // Kept, so a click is still heard. Old ones go once there are plenty.
        if (shownNotes.Count > 60) { shownNotes.Clear(); noteTargets.Clear(); }
        shownNotes[tag] = note;
        noteTargets[tag] = new[] { room, tab };
      }
      Log("notification: " + title);
    }

    static void Listen<THandler>(object target, MethodInfo add, MethodInfo remove, THandler handler) {
      System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal.AddEventHandler<THandler>(
        (h) => (System.Runtime.InteropServices.WindowsRuntime.EventRegistrationToken)add.Invoke(target, new object[] { h }),
        (token) => remove.Invoke(target, new object[] { token }),
        handler);
    }

    static void NoteClicked(object sender, object e) {
      try {
        var argsType = WinRT("Windows.UI.Notifications.ToastActivatedEventArgs", "Windows.UI.Notifications");
        var parts = new Dictionary<string, string>();
        foreach (string part in Convert.ToString(argsType.GetProperty("Arguments").GetValue(e)).Split(';')) {
          int cut = part.IndexOf('=');
          if (cut > 0) parts[part.Substring(0, cut)] = part.Substring(cut + 1);
        }
        string action = parts.ContainsKey("act") ? parts["act"] : "open";
        string tag = parts.ContainsKey("tag") ? parts["tag"] : "";
        string[] target;
        lock (notesLock) { if (!noteTargets.TryGetValue(tag, out target)) target = new[] { "", "" }; }
        if (action == "open") RaiseStation();
        Send(new Dictionary<string, object> {
          { "type", "notification" }, { "id", parts.ContainsKey("id") ? parts["id"] : "" }, { "action", action },
          { "room", target[0] }, { "tab", target[1] },
        });
        Log("notification clicked: " + action);
      } catch (Exception ex) { Log("notification click: " + ex.Message); }
    }

    static void Unnotify(string tag) {
      if (!Regex.IsMatch(tag ?? "", "^[0-9a-f]{1,32}$")) return;
      lock (notesLock) { shownNotes.Remove(tag); noteTargets.Remove(tag); }
      var managerType = WinRT("Windows.UI.Notifications.ToastNotificationManager", "Windows.UI.Notifications");
      var historyType = WinRT("Windows.UI.Notifications.ToastNotificationHistory", "Windows.UI.Notifications");
      var history = managerType.GetProperty("History").GetValue(null);
      historyType.GetMethod("Remove", new[] { typeof(string), typeof(string), typeof(string) }).Invoke(history, new object[] { tag, NotifyGroup, NotifyApp });
    }

    // Brings Station 256 to the front, even from minimized. Windows only allows that right after a
    // key press, hence the Alt, and the Linux side can take it back a moment later, so it keeps at it.
    static void RaiseStation() {
      IntPtr h = station;
      if (h == IntPtr.Zero || !IsWindow(h)) h = FindStation();
      if (h == IntPtr.Zero) return;
      if (IsIconic(h)) ShowWindow(h, 9);
      for (int i = 0; i < 10 && GetForegroundWindow() != h; i++) {
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(h);
        Thread.Sleep(50);
      }
    }

    /* ---------- Voice typing ---------- */

    // Windows' voice typing (Win + H) turns the app away: Windows counts a Linux window as a remote
    // app. So Win + H on the app is caught here before Windows sees it. An invisible Windows text box
    // takes the keyboard instead, and Windows' own voice typing is started in it. Every change that
    // lands in that box goes straight into the app as it happens, where you were typing, Windows'
    // own corrections included. All you see is Windows' voice typing bar and your words appearing
    // in Station 256. Enter goes on to the app after the words. Esc, or clicking anywhere, gives the
    // keyboard back; the words are already in.

    [StructLayout(LayoutKind.Sequential)] struct KeyInfo { public uint Vk, Scan, Flags, Time; public IntPtr Extra; }
    static MouseProc keyKeep;
    static volatile bool voiceKeyHeld = false;
    static VoiceBox voiceBox = null;

    static bool Held(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    // The app's own windows: the main one and terminals popped out of it.
    static bool IsAppWindow(IntPtr h) {
      return h != IntPtr.Zero && IsLinux(h) && Regex.IsMatch(Title(h), @"^Station 256( Terminal)?( \(|$)");
    }

    static IntPtr OnKey(int code, IntPtr w, IntPtr l) {
      try {
        // Only H pressed on the keyboard counts, not one a program sent (like the one sent below).
        if (code >= 0 && Marshal.ReadInt32(l) == 0x48) {
          var key = (KeyInfo)Marshal.PtrToStructure(l, typeof(KeyInfo));
          if ((key.Flags & 0x10) == 0) {
            int message = w.ToInt32();
            bool down = message == 0x0100 || message == 0x0104;
            if (!down) {
              if (voiceKeyHeld) { voiceKeyHeld = false; return new IntPtr(1); }
            } else if (voiceKeyHeld) {
              return new IntPtr(1); // still held down, so it repeats
            } else if ((Held(0x5B) || Held(0x5C)) && !Held(0x10) && !Held(0x11) && !Held(0x12) && IsAppWindow(GetForegroundWindow())) {
              voiceKeyHeld = true;
              // Windows opens Start when Win comes up with no other key pressed in between. This is
              // a key no keyboard has, so it stops that and does nothing else.
              keybd_event(0xE8, 0, 0, UIntPtr.Zero);
              keybd_event(0xE8, 0, 2, UIntPtr.Zero);
              IntPtr from = GetForegroundWindow();
              var form = catcherForm;
              if (form != null) form.BeginInvoke(new Action(() => OpenVoice(from)));
              return new IntPtr(1);
            }
          }
        }
      } catch { }
      return CallNextHookEx(IntPtr.Zero, code, w, l);
    }

    static void OpenVoice(IntPtr from) {
      try {
        if (voiceBox != null && !voiceBox.IsDisposed) {
          voiceBox.Listen();
          return;
        }
        voiceBox = new VoiceBox(from);
        voiceBox.FormClosed += (s, e) => { voiceBox = null; };
        voiceBox.Show();
        Log("voice typing: started (invisible box, words go in as you speak)");
      } catch (Exception e) { Log("voice typing: the box couldn't open: " + e.Message); }
    }

    // The invisible box's text box. As you speak, Windows' voice typing puts in the words it's still
    // working out, then swaps them for the words it settles on. A text box that doesn't draw those
    // first words itself, like a plain one, gets them drawn by Windows in a little box of its own,
    // on screen even though this one can't be seen. So this one takes them from Windows itself:
    // nothing extra shows, and the words still being worked out go into the app at once, the way
    // they appear in the text box you're in on Windows.
    class QuietTextBox : System.Windows.Forms.TextBox {
      public string Composing = "";   // words Windows is still working out, not in Text yet
      public event Action Changed;
      bool inserting = false;

      // The words as they stand: the box's text, with the words still being worked out at the cursor.
      public string Shown {
        get {
          string text = Text;
          if (Composing.Length == 0) return text;
          int at = Math.Max(0, Math.Min(SelectionStart, text.Length));
          int cut = Math.Max(0, Math.Min(SelectionLength, text.Length - at));
          return text.Substring(0, at) + Composing + text.Substring(at + cut);
        }
      }

      protected override void OnTextChanged(EventArgs e) {
        base.OnTextChanged(e);
        if (!inserting && Changed != null) Changed();
      }

      // settled: words Windows is now sure of, which go into the box (null for none). working: the
      // words it's still working out.
      public void Apply(string settled, string working) {
        working = working ?? "";
        bool changed = !string.IsNullOrEmpty(settled) || working != Composing;
        if (!string.IsNullOrEmpty(settled)) {
          inserting = true;
          try { SelectedText = settled; } finally { inserting = false; }
        }
        Composing = working;
        if (changed && Changed != null) Changed();
      }

      protected override void WndProc(ref System.Windows.Forms.Message m) {
        switch (m.Msg) {
          case 0x0281: // WM_IME_SETCONTEXT: tells Windows this box shows the words itself
            m.LParam = new IntPtr(unchecked((int)m.LParam.ToInt64()) & 0x7FFFFFFF);
            break;
          case 0x010D: // WM_IME_STARTCOMPOSITION: not passed on, so Windows' little box never opens
            return;
          case 0x010F: { // WM_IME_COMPOSITION: the words changed
            IntPtr imc = ImmGetContext(Handle);
            if (imc == IntPtr.Zero) break; // can't read them, so Windows handles it the usual way
            long flags = m.LParam.ToInt64();
            string settled = null, working = Composing;
            try {
              if ((flags & 0x800) != 0) settled = Read(imc, 0x800);         // GCS_RESULTSTR
              if ((flags & 0x8) != 0) working = Read(imc, 0x8);             // GCS_COMPSTR
              else if ((flags & 0x800) != 0 || flags == 0) working = "";
            } finally { ImmReleaseContext(Handle, imc); }
            Apply(settled, working);
            return;
          }
          case 0x010E: // WM_IME_ENDCOMPOSITION
            Apply(null, "");
            return;
        }
        base.WndProc(ref m);
      }

      static string Read(IntPtr imc, int which) {
        int bytes = ImmGetCompositionStringW(imc, which, null, 0);
        if (bytes <= 0) return "";
        var buffer = new byte[bytes];
        bytes = ImmGetCompositionStringW(imc, which, buffer, bytes);
        return bytes > 0 ? Encoding.Unicode.GetString(buffer, 0, bytes) : "";
      }
    }

    class VoiceBox : System.Windows.Forms.Form {
      readonly IntPtr from;
      readonly QuietTextBox words;
      readonly bool linked;
      volatile bool listening = false;
      bool done = false;
      string sent = "";   // what has already gone into the app from here

      public VoiceBox(IntPtr from) {
        this.from = from;
        lock (linkLock) { linked = linkStream != null; }
        float scale = GetDpiForSystem() / 96f;
        Func<int, int> px = (n) => (int)Math.Round(n * scale);
        AutoScaleMode = System.Windows.Forms.AutoScaleMode.None;
        FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
        StartPosition = System.Windows.Forms.FormStartPosition.Manual;
        ShowInTaskbar = false;
        BackColor = Color.White;
        Text = "Voice typing for Station 256";
        // Can't be seen, and clicks go straight through it (see CreateParams), but it's still a real
        // window with a real text box, which Windows' voice typing will type into.
        Opacity = 0.01;
        ClientSize = new Size(px(400), px(40));
        // Near the bottom of the screen the app is on, where Windows shows its voice typing bar.
        var area = System.Windows.Forms.Screen.FromHandle(from).WorkingArea;
        Location = new Point(area.Left + (area.Width - Width) / 2, area.Bottom - Height - px(120));
        words = new QuietTextBox {
          Multiline = true, WordWrap = true, BorderStyle = System.Windows.Forms.BorderStyle.None,
          Dock = System.Windows.Forms.DockStyle.Fill,
        };
        Controls.Add(words);
        words.Changed += Pass;
        words.KeyDown += (s, e) => {
          var k = e.KeyCode;
          if (k == System.Windows.Forms.Keys.Enter && !e.Shift && !e.Control && !e.Alt) {
            e.SuppressKeyPress = true;
            Finish(true, true);
          } else if (k == System.Windows.Forms.Keys.Escape) {
            e.SuppressKeyPress = true;
            Finish(false, true);
          } else if (k == System.Windows.Forms.Keys.Back && words.TextLength == 0 && words.Composing.Length == 0 && !e.Control && !e.Alt) {
            // Nothing said yet: Backspace works on what was already there, as it would in the app.
            e.SuppressKeyPress = true;
            if (linked) Send(Edit(1, "", false));
          }
        };
        Shown += (s, e) => Listen();
        // Clicking anywhere else means you're done here. The words are already in.
        Deactivate += (s, e) => {
          if (!listening || done) return;
          var timer = new System.Windows.Forms.Timer { Interval = 400 };
          timer.Tick += (s2, e2) => {
            timer.Stop();
            timer.Dispose();
            if (done || IsDisposed) return;
            IntPtr front = GetForegroundWindow();
            if (front != IntPtr.Zero && front != Handle && !IsVoiceBar(front)) Finish(false, false);
          };
          timer.Start();
        };
      }

      // No button on the taskbar or in Alt+Tab, and clicks go through to whatever is underneath.
      protected override System.Windows.Forms.CreateParams CreateParams {
        get {
          var p = base.CreateParams;
          p.ExStyle |= 0x80 | 0x20;
          return p;
        }
      }

      // Windows' voice typing bar itself, which can come in front for a moment.
      static bool IsVoiceBar(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        return Path.GetFileNameWithoutExtension(ProgramPath(pid)).ToLower() == "textinputhost";
      }

      static string Flat(string s) { return s.Replace("\r\n", " ").Replace('\r', ' ').Replace('\n', ' '); }
      static int Letters(string s) { int n = 0; foreach (char c in s) if (!char.IsLowSurrogate(c)) n++; return n; }
      static Dictionary<string, object> Edit(int remove, string add, bool enter) {
        return new Dictionary<string, object> { { "type", "voice-edit" }, { "remove", remove }, { "add", add }, { "enter", enter } };
      }

      // Sends the app whatever changed since last time: letters to take back from the end, then
      // letters to add. Windows' voice typing rewrites words as it hears more, and this keeps up.
      void Pass() {
        if (done) return;
        string now = Flat(words.Shown);
        int same = 0, most = Math.Min(now.Length, sent.Length);
        while (same < most && now[same] == sent[same]) same++;
        if (same > 0 && char.IsHighSurrogate(sent[same - 1])) same--; // never split an emoji in two
        int remove = Letters(sent.Substring(same));
        string add = now.Substring(same);
        sent = now;
        if ((remove > 0 || add.Length > 0) && linked) Send(Edit(remove, add, false));
      }

      // Takes focus, then starts Windows' voice typing in the box.
      public void Listen() {
        IntPtr me = Handle;
        listening = false;
        var thread = new Thread(() => {
          try {
            // Win + H is sent from here only once you've let go of Win, or Windows would see Win
            // come up twice.
            for (int i = 0; i < 150 && (Held(0x5B) || Held(0x5C)); i++) Thread.Sleep(20);
            // Windows only hands focus to a window not in front right after a key press, hence the
            // Alt. The Linux side can take focus back a moment later, so this keeps at it.
            int held = 0;
            for (int i = 0; i < 40 && held < 3; i++) {
              if (GetForegroundWindow() == me) { held += 1; Thread.Sleep(40); continue; }
              held = 0;
              keybd_event(0x12, 0, 0, UIntPtr.Zero);
              keybd_event(0x12, 0, 2, UIntPtr.Zero);
              SetForegroundWindow(me);
              Thread.Sleep(60);
            }
            if (done) return;
            Invoke(new Action(() => words.Focus()));
            Thread.Sleep(120);
            if (GetForegroundWindow() != me) {
              Log("voice typing: the box couldn't take focus");
              return;
            }
            keybd_event(0x5B, 0, 1, UIntPtr.Zero);
            keybd_event(0x48, 0, 0, UIntPtr.Zero);
            keybd_event(0x48, 0, 2, UIntPtr.Zero);
            keybd_event(0x5B, 0, 3, UIntPtr.Zero);
            Thread.Sleep(400);
            listening = true;
          } catch { }
        });
        thread.IsBackground = true;
        thread.Start();
      }

      // enter: you pressed Enter, so the app gets it too, after the words. back: return the
      // keyboard to the window you came from (not when you've already clicked somewhere yourself).
      void Finish(bool enter, bool back) {
        if (done) return;
        Pass();
        done = true;
        string text = Flat(words.Shown).Trim();
        if (!linked && text.Length > 0) {
          // The app wasn't linked, so nothing went in. The words are kept on the clipboard instead.
          try { System.Windows.Forms.Clipboard.SetText(text); } catch { }
          Log("voice typing: the app wasn't linked, so the words went on the clipboard");
        }
        IntPtr target = from;
        int letters = Letters(sent);
        Hide();
        var thread = new Thread(() => {
          if (enter && linked) Send(Edit(0, "", true));
          if (back) {
            for (int i = 0; i < 10 && IsWindow(target) && GetForegroundWindow() != target; i++) {
              keybd_event(0x12, 0, 0, UIntPtr.Zero);
              keybd_event(0x12, 0, 2, UIntPtr.Zero);
              SetForegroundWindow(target);
              Thread.Sleep(50);
            }
          }
          Log("voice typing: done, " + letters + " letters in" + (enter ? ", then Enter" : ""));
        });
        thread.IsBackground = true;
        thread.Start();
        Close();
      }
    }
  }
}
