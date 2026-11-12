const {
  app, BrowserWindow, Menu, clipboard, ipcMain, net, protocol, screen, webContents,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const files = require('./lib/files');
const edits = require('./lib/edits');
const ownerSaves = require('./lib/owner-saves');
const archive = require('./lib/archive');
const docx = require('./lib/docx');
const thumbs = require('./lib/thumbs');
const pictureDetails = require('./lib/picture-details');
const video = require('./lib/video');
const music = require('./lib/music');
const editorApp = require('./lib/editor-app');
const obscuraApp = require('./lib/obscura');
const aiBrowser = require('./lib/ai-browser');
const rulesLib = require('./lib/rules');
const house = require('./lib/house');
const terminals = require('./lib/terminals');
const windowsLink = require('./lib/windows-link');
const herdr = require('./lib/herdr');
const houseTerms = require('./lib/house-terms');
const agentAlertsLib = require('./lib/agent-alerts');
const sharedClipboard = require('./lib/clipboard');
const pastedImage = require('./lib/pasted-image');
const ports = require('./lib/ports');
const preview = require('./lib/preview');
const htmlPreview = require('./lib/html-preview');
const stats = require('./lib/stats');
const chatSave = require('./lib/chat-save');
const liveUpdate = require('./lib/live-update');
const llama = require('./lib/llama');
const github = require('./lib/github');
const schedules = require('./lib/schedules');
const search = require('./lib/search');
const searchWords = require('./lib/search-words');
const jev = require('./lib/jev');
const housekeeping = require('./lib/housekeeping');
const selfcheck = require('./lib/selfcheck');

// Self-recovery (docs/03-how-it-works.md). start.sh starts Station again after a crash. Saved files
// that are damaged are set aside before anything reads them.
selfcheck.run();
// A mistake in one handler is logged, not shown in a pop-up, and Station keeps running. One before
// the first window shows may have stopped the start: if no window has shown 30 s later, it exits
// with 1 so start.sh starts it again. A flood of them does the same.
let shownOnce = false;
let crashLoop = false;
let startCheck = null;
const recentErrors = [];
function logError(what, error) {
  try {
    process.stderr.write(`[station] ${what}: ${error && error.stack ? error.stack : String(error)}\n`);
  } catch {}
}
process.on('uncaughtException', (error) => {
  logError('error', error);
  if (crashLoop) return;
  const now = Date.now();
  recentErrors.push(now);
  while (recentErrors.length && now - recentErrors[0] > 60000) recentErrors.shift();
  if (!shownOnce) {
    startCheck = startCheck || setTimeout(() => {
      if (shownOnce) return;
      process.stderr.write('[station] no window 30 s after an error while starting; starting again\n');
      app.exit(1);
    }, Number(process.env.HOUSE_START_CHECK_MS) || 30000);
  } else if (recentErrors.length > 20) {
    process.stderr.write('[station] more than 20 errors in a minute; restarting\n');
    crashLoop = true;
    app.quit(); // the usual clean-up runs in before-quit; will-quit below gives the exit code 1
    setTimeout(() => app.exit(1), 5000);
  }
});
app.on('will-quit', () => { if (crashLoop) app.exit(1); });
process.on('unhandledRejection', (reason) => logError('unhandled rejection', reason));
app.on('child-process-gone', (_event, details) => {
  process.stderr.write(`[station] ${details.type} process gone: ${details.reason} (exit code ${details.exitCode})\n`);
});

Menu.setApplicationMenu(null);
// Color-edge text can't be used during motion, so text would visibly change weight whenever a glide
// ended. Plain smoothing keeps text the same all the time.
app.commandLine.appendSwitch('disable-lcd-text');
// Station's own pages are drawn on the processor: measured on this PC, through the Linux display
// link that puts more frames on screen than the graphics card does. Only canvases use the graphics
// card, through Mesa's d3d12 driver, which start.sh picks (Mesa's default here is llvmpipe, on the processor). That's for
// the video editor: a 1080p preview went from 6 to about 22 pictures a second and exports about 3
// times faster (2026-11-10). A discrete graphics card was far slower than the built-in one here, and d3d12
// picks the built-in one by itself. If the graphics process can't start, canvases are drawn in software
// (SwiftShader), and the editor still works, slowly.
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

// Lets image and video previews load local files, and nothing else.
protocol.registerSchemesAsPrivileged([{
  scheme: 'house-file',
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
}, {
  // The video editor's pages (lib/editor-app.js).
  scheme: editorApp.SCHEME,
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
}]);

const APP_ICON = path.join(__dirname, 'assets', 'station-256.png');
// Linux windows ignore Windows' display scaling, so the panel scales itself.
// The footer's 100% is this scale. Ctrl +, Ctrl - and Ctrl 0 change it, and the choice is remembered.
const BASE_ZOOM = 1.35;
const SETTINGS_FILE = path.join(app.getPath('home'), '.config', 'house', 'panel.json');
const WEB_PREFERENCES = {
  preload: path.join(__dirname, 'preload.js'),
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  plugins: true, // Chromium's own PDF viewer, for the file preview
  webviewTag: true, // only ever the video editor and Obscura, the browser (guardWebviews below lets in just those two)
};

// Every Station 256 window, oldest first. Any tab can move to a window of its own, and tabs can move
// between windows, as in Chrome. The main window is the first one: its place on screen is remembered,
// room terminals come back to it when Station 256 opens, and it's where a notification goes when no
// other window has that terminal. If it closes while others are open, the oldest of them takes over.
// Closing the last window closes Station 256.
let mainWindow = null;
const stations = [];
// Most recently used first, so a tab carried over two windows lands on the one in front.
let focusOrder = [];
// The tabs a new window starts with, kept until its page asks for them.
const handoffs = new Map();
// Pages that crashed and started again, by page id: they get their room terminals back.
const recovering = new Set();
// Pages reloading for a new version of themselves, by page id: which of their tabs was in front.
const liveFront = new Map();
// Which terminal each window is showing, by page id (null for none).
const shownTerms = new Map();
// The pages showing the Agents page, by page id. Herdr is only asked while one is.
const agentsWatchers = new Set();
let quitting = false;
// Windows whose closing was already agreed to, or that are only giving their tab to another window.
const closeOk = new WeakSet();
// Linux windows here don't report being minimized, so the app remembers when it did that itself.
const appMinimized = new WeakSet();
// Each page's window position inside its fixed surface, by page id.
const frames = new Map();
// The last files dropped from Windows, waiting for the page to say where they go.
let lastDrop = null;
let dropCount = 0;
// How many files are copied in Windows right now, as the helper last said.
let windowsClipboardCount = 0;
// Whether the newest thing copied in Windows is a picture (a screen snip, say), as the helper last
// said. Windows is only asked for the picture itself when you paste (lib/pasted-image.js).
let windowsPicture = false;
// In checks, a stand-in for a picture copied in Windows.
const picturesInChecks = { png: null };
// Test copies (checks) never put a window on the real screen, unless SHOT_SHOW=1 asks to watch them.
const testCopy = () => Boolean(process.env.HOUSE_SHOTS || process.env.HOUSE_FITTEST || process.env.HOUSE_ZOOMWALK);
const offScreen = () => Boolean((process.env.HOUSE_SHOTS || process.env.HOUSE_FITTEST) && !process.env.SHOT_SHOW);
const copiedPicture = () => (process.env.HOUSE_SHOTS ? Promise.resolve(picturesInChecks.png) : windowsLink.clipboardImage());
// For places only Windows can read, such as a network drive.
const windowsCopier = { measure: windowsLink.measure, copy: windowsLink.copyIn };
// The app's window you were last in, so words from voice typing go back there.
let lastFocused = null;
// Checks never open anything on the screen; they read what would have opened here instead.
const openedInChecks = [];

// A link clicked in a terminal, opened in your browser on Windows. A link to localhost from a room
// terminal means a site running in that room, so it's opened through a path into the room
// (lib/ports.js). That's usually the same port; if the house already has it, another one.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']);
async function openLink(raw, termId) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('That isn\'t a web link.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only web links (http and https) open from here.');
  const local = LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');
  const room = Number.isInteger(termId) ? terminals.roomOf(termId) : null;
  if (local) {
    if (room) {
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
      url.port = String(await ports.reach(room, port));
    }
    // 0.0.0.0 means "every address" to the program that printed it. A browser needs a real one.
    if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = 'localhost';
  }
  if (process.env.HOUSE_SHOTS || process.env.HOUSE_FITTEST) {
    openedInChecks.push(url.href);
    return url.href;
  }
  await windowsLink.openUrl(url.href);
  return url.href;
}

// Opens a Preview page in an Obscura tab of the window that asked (renderer/obscura-tab.js), tied to
// the project; in Windows' own browser if that window has closed meanwhile.
async function openPreview(room, url, asker) {
  const target = new URL(url);
  target.port = String(await ports.reach(room, Number(target.port)));
  if (asker && !asker.isDestroyed()) {
    asker.send('preview:open', { url: target.href, project: room });
    return target.href;
  }
  return openLink(target.href);
}

// Words from voice typing (Win + H, caught by the Windows helper) go to the window you were in.
function voiceTyped(text) {
  const words = typeof text === 'string' ? text.slice(0, 20000) : '';
  if (!words.trim()) return;
  const target = lastFocused && !lastFocused.isDestroyed() ? lastFocused : mainWindow;
  if (target && !target.isDestroyed()) target.webContents.send('voice:text', { text: words });
}

// Voice typing as you speak: each change Windows makes to the words comes as letters to take back
// and letters to add, so what's in front of you always matches what Windows heard. Enter, when you
// press it, comes the same way, after the words, so it never arrives before them.
function voiceEdited(message) {
  const remove = Number.isInteger(message.remove) && message.remove >= 0 ? Math.min(message.remove, 20000) : 0;
  const add = typeof message.add === 'string' ? message.add.slice(0, 20000) : '';
  const enter = message.enter === true;
  if (!remove && !add && !enter) return;
  const target = lastFocused && !lastFocused.isDestroyed() ? lastFocused : mainWindow;
  if (target && !target.isDestroyed()) target.webContents.send('voice:edit', { remove, add, enter });
}

// Tells a page how far along a video job is (renderer/video-tab.js), a few times a second at most.
function jobProgress(page, job) {
  let last = 0;
  return (done) => {
    const now = Date.now();
    if (now - last < 150) return;
    last = now;
    if (!page.isDestroyed()) page.send('video:progress', { job, done });
  };
}

// Part of a file, as a video or song asks for when it jumps to another moment. Without this the
// player can't jump (file:// gives only the whole file), so videos only played from the start.
const MEDIA_TYPES = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', flac: 'audio/flac',
};
async function partOfFile(file, asked) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(asked).trim());
  if (!match || (!match[1] && !match[2])) return null;
  const { size } = await fs.promises.stat(file);
  let start;
  let end;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  }
  if (start >= size || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const type = MEDIA_TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
    status: 206,
    headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
  });
}

// What the video editor exports (lib/editor-app.js): beside the video it came from, named
// "name (edited)", or in Videos. sent: the export, already in a file in the cache folder, which
// is moved into place (or its copy with AAC sound is), so the video is never held in memory.
let editorGuest = null;
let obscuraGuest = null;
// An AI in a room using the Web Browser (lib/ai-browser.js).
let aiBrowserApp = null;
async function saveEditorExport(sent, filename, source) {
  try {
    const ext = (/\.(mp4|webm)$/i.exec(filename) || [])[1]?.toLowerCase() || 'mp4';
    let stem = filename.replace(/\.(mp4|webm)$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 120) || 'Video';
    let dir = path.join(app.getPath('home'), 'Videos');
    if (source && await savesBeside(source)) {
      dir = path.dirname(source);
      if (stem === stemOf(source)) stem = `${stem} (edited)`;
    }
    await files.ensureFolder(dir);
    if (ext === 'mp4') {
      const withAac = await video.aacSound(sent).catch(() => null);
      if (withAac) return { path: await files.placeFile(withAac, dir, `${stem}.${ext}`) };
    }
    return { path: await files.placeFile(sent, dir, `${stem}.${ext}`) };
  } finally {
    await fs.promises.rm(sent, { force: true }); // already moved, unless the AAC copy went instead
  }
}

// Whether a changed file can go beside this one: not on C: (view only) and not in the Trash.
const savesBeside = (target) => files.assertAllowed(target).then(() => !files.inTrash(target), () => false);
const stemOf = (target) => path.basename(target, path.extname(target)).replace(/ \(edited(?: \d+)?\)$/, '');

// Tells a page how far along its copy is, a few times a second at most, and always the last step.
function progressTo(page) {
  let last = 0;
  return (step) => {
    const now = Date.now();
    if (!step.final && !step.measuring && now - last < 120) return;
    last = now;
    if (!page.isDestroyed()) page.send('copy:progress', step);
  };
}

function readSettings() {
  let text;
  try {
    text = fs.readFileSync(SETTINGS_FILE, 'utf8');
  } catch {
    return {};
  }
  try {
    const settings = JSON.parse(text);
    return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  } catch {
    // Damaged since start-up: set it aside, so the next save doesn't silently write over it.
    selfcheck.setAside(SETTINGS_FILE);
    return {};
  }
}

// Written to the side and then swapped in, so a crash or full disk can't leave a damaged file.
function saveSettings(change) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const temporary = `${SETTINGS_FILE}.new`;
  fs.writeFileSync(temporary, JSON.stringify({ ...readSettings(), ...change }));
  fs.renameSync(temporary, SETTINGS_FILE);
}

function readZoom() {
  const { zoomLevel } = readSettings();
  return (zoomLevel >= 0.5 && zoomLevel <= 1.5 ? zoomLevel : 1) * BASE_ZOOM;
}

// `level` is what the footer shows: 1 is 100%. Each page applies the new zoom itself,
// so it can start easing to it in the same step.
function applyZoom(level) {
  const zoomLevel = Math.round(Math.min(1.5, Math.max(0.5, level)) * 100) / 100;
  saveSettings({ zoomLevel });
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('zoom:changed', zoomLevel * BASE_ZOOM);
}

function currentLevel() {
  return readZoom() / BASE_ZOOM;
}

function handleZoomKeys(event, input) {
  if (input.type !== 'keyDown' || !input.control || input.alt || input.meta || input.shift) {
    if (!(input.type === 'keyDown' && input.control && input.shift && input.key === '+')) return;
  }
  if (input.key === '=' || input.key === '+') applyZoom(currentLevel() + 0.05);
  else if (input.key === '-') applyZoom(currentLevel() - 0.05);
  else if (input.key === '0') applyZoom(1);
  else return;
  event.preventDefault();
}

function wireWindow(win) {
  // With Obscura in front the zoom keys are the page's (renderer/obscura-tab.js), not Station's.
  win.webContents.on('before-input-event', (event, input) => { if (!obscuraApp.isFront(win.webContents)) handleZoomKeys(event, input); });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('zoom:changed', readZoom());
  });
  // The surface always stays maximized. The app's window moves and resizes inside it.
  // It waits a moment first: this is also how Windows snapping the window starts, and the Windows
  // helper needs time to see where Windows put it.
  win.on('unmaximize', () => {
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isMinimized() && !appMinimized.has(win) && !win.isMaximized() && !offScreen()) win.maximize();
    }, 500);
  });
  // A screen change while minimized is skipped below, so this catches up when it comes back.
  win.on('restore', () => {
    if (!win.isMaximized() && !offScreen()) win.maximize(); // maximize() shows a hidden window
  });
  // Not while it's out of sight (a window kept ready for a tab): maximizing would show it.
  const onDisplayChange = () => {
    if (!win.isDestroyed() && win.isVisible() && !win.isMinimized() && !offScreen()) win.maximize();
  };
  screen.on('display-metrics-changed', onDisplayChange);
  win.on('closed', () => screen.off('display-metrics-changed', onDisplayChange));
  // The panel never navigates away or opens other sites.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Test copies say what they are, whatever the page sets as its title.
  if (testCopy()) {
    win.setTitle('Station 256 TEST COPY');
    win.on('page-title-updated', (event) => { event.preventDefault(); win.setTitle('Station 256 TEST COPY'); });
  }
  // A webview may only be the editor or Obscura, each in its own session; anything else is refused.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (params.partition === obscuraApp.PARTITION) obscuraApp.guardAttach(event, webPreferences, params);
    else if (!params.partition || params.partition === editorApp.PARTITION) editorApp.guardAttach(event, webPreferences, params);
    else event.preventDefault();
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    if (obscuraApp.owns(guest)) return obscuraGuest?.(guest);
    watchEditorPage(guest);
    return editorGuest?.(guest);
  });
}

// The video editor keeps a passing copy of each video it imports (it saves its own copy in the
// project too). A page that's open may still be playing from its copies, so they're tidied only
// when an editor page has just opened and no other editor page is open: then none is in use.
const editorPages = new Set();
const isEditorPage = (page) => !page.isDestroyed() && page.getURL().startsWith(`${editorApp.ORIGIN}/`);
function watchEditorPage(guest) {
  editorPages.add(guest);
  guest.once('destroyed', () => editorPages.delete(guest));
  guest.on('did-finish-load', () => {
    const open = [...editorPages].filter(isEditorPage);
    if (cleanupOn() && open.length === 1 && open[0] === guest) housekeeping.cleanEditorPages([guest]).catch(() => {});
  });
}

// Clean-up (lib/housekeeping.js): once a day, and on the button. On unless HOUSE_CLEANUP=0 (checks
// set it) or the setting is turned off. Never waits for or holds up quitting.
const cleanupOn = () => process.env.HOUSE_CLEANUP !== '0' && readSettings().cleanup !== false;
// In picture checks the test-leftover rule looks in the throwaway home, never the real /tmp.
const runCleanup = () => housekeeping.run({ tmp: process.env.HOUSE_SHOTS ? path.join(app.getPath('home'), 'tmp') : '/tmp' });
function scheduleCleanup() {
  const HOUR = 60 * 60 * 1000;
  const due = (hours) => !quitting && cleanupOn() && Date.now() - housekeeping.lastRunTime() >= hours * HOUR;
  setTimeout(() => {
    if (due(20)) runCleanup().catch(() => {});
    setInterval(() => { if (due(24)) runCleanup().catch(() => {}); }, HOUR).unref();
  }, 2 * 60 * 1000).unref();
}

// A see-through Linux window filling the screen above the taskbar. It never changes size, because
// a real resize through the Linux display link always flickers. See renderer/window-motion.js.
// held: it stays out of sight until what this gives is done (a window made for a tab waits for it).
function createSurface(title, frame, page, query, held = null) {
  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...display.bounds,
    height: display.bounds.height - 60,
    frame: false,
    show: false,
    transparent: true,
    hasShadow: false,
    title,
    icon: APP_ICON,
    webPreferences: { ...WEB_PREFERENCES, zoomFactor: readZoom() },
  });
  const pageId = win.webContents.id;
  frames.set(pageId, { ...frame, box: frame.rect });
  frames.get(pageId).ready = new Promise((resolve) => {
    win.once('ready-to-show', async () => {
      if (held) await held();
      if (win.isDestroyed()) return;
      if (process.env.HOUSE_FITTEST || process.env.HOUSE_SHOTS) { // these checks stay off screen, unless SHOT_SHOW=1 asks to watch them
        if (!offScreen()) win.showInactive();
        resolve();
        return;
      }
      win.show();
      win.maximize();
      const end = Date.now() + 1500;
      while (Date.now() < end && !win.isMaximized()) await new Promise((wait) => setTimeout(wait, 25));
      await new Promise((wait) => setTimeout(wait, 80));
      resolve();
    });
  });
  win.on('closed', () => {
    frames.delete(pageId);
    tabsIn.delete(pageId);
  });
  wireWindow(win);
  // A watched test copy looks just like Station 256, so it says plainly that it isn't the real one.
  if (process.env.SHOT_SHOW) {
    win.webContents.on('did-finish-load', () => win.webContents.executeJavaScript(`(() => {
      const note = document.createElement('div');
      note.textContent = 'TEST COPY with pretend projects. Your real Station 256 and your own projects are separate and untouched.';
      note.style.cssText = 'position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#c42b1c;color:#fff;font:600 15px system-ui;padding:8px 16px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.4);max-width:90%;text-align:center';
      // Put back whenever the page rebuilds itself.
      const keep = () => { const app = document.querySelector('.app'); if (app && note.parentNode !== app) app.append(note); };
      keep();
      setInterval(keep, 1000);
    })()`).catch(() => {}));
  }
  win.loadFile(path.join(__dirname, 'renderer', page), query ? { query } : undefined);
  return win;
}

function createMainWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  const saved = readSettings().window || {};
  const width = Math.min(1500, Math.round(bounds.width * 0.85));
  const height = Math.min(918, Math.round((bounds.height - 60) * 0.9));
  const rect = saved.rect && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(saved.rect[key])) ? saved.rect : {
    x: Math.round((bounds.width - width) / 2),
    y: Math.round((bounds.height - 60 - height) / 2),
    w: width,
    h: height,
  };
  mainWindow = createStation({ rect, maximized: Boolean(saved.maximized) });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// A window made for a tab comes on screen once the page says its tab is in (or after a moment at
// most), so it never shows empty. What each such page calls to say so:
const tabsIn = new Map();
const SHOW_TABS_WITHIN = 1500;
function heldForTabs(win, before = Promise.resolve()) {
  const filled = deferred();
  tabsIn.set(win.webContents.id, filled.resolve);
  return () => before.then(() => Promise.race([filled.promise, wait(SHOW_TABS_WITHIN)]));
}

// Opens a Station 256 window. tabs: what a window made from a tab starts with. Without them it
// opens the way Station 256 does.
function createStation(frame, tabs = null) {
  // ?tab tells the page it was made from a tab, so it opens with no loading screen.
  let held = null;
  const win = createSurface('Station 256', frame, 'index.html', tabs ? { tab: '1' } : undefined, () => (held ? held() : null));
  if (tabs) held = heldForTabs(win);
  registerStation(win, tabs);
  return win;
}

// A window kept ready out of sight, so a tab pulled off its window becomes a window straight away
// rather than after a second or two of loading. Made as a tab starts being carried, or the pointer
// is on its "own window" button, and let go after a few minutes unused.
let spare = null;
const SPARE_KEEP_MS = 3 * 60 * 1000;
function warmSpare() {
  if (quitting || !stations.length) return;
  if (spare && !spare.win.isDestroyed()) {
    clearTimeout(spare.idle);
    spare.idle = setTimeout(dropSpare, SPARE_KEEP_MS);
    return;
  }
  const claimed = deferred();
  let held = null;
  const win = createSurface('Station 256', { rect: { x: 0, y: 0, w: 1000, h: 640 }, maximized: false }, 'index.html', { tab: '1' }, () => held());
  held = heldForTabs(win, claimed.promise);
  win.houseSpare = true; // the checks tell it apart from the windows in use
  win.webContents.on('render-process-gone', () => { if (spare?.win === win) dropSpare(); });
  spare = { win, claim: claimed.resolve, claimed: claimed.promise, idle: setTimeout(dropSpare, SPARE_KEEP_MS) };
}

function dropSpare() {
  const was = spare;
  spare = null;
  if (!was) return;
  clearTimeout(was.idle);
  if (!was.win.isDestroyed()) was.win.destroy();
}

// A window for a tab, at rect: the one kept ready if there is one, or else a new one.
function windowForTab(rect, tab) {
  const frame = { rect, maximized: false };
  const ready = spare && !spare.win.isDestroyed() && !spare.win.webContents.isCrashed() ? spare : null;
  if (!ready) return createStation(frame, [tab]);
  spare = null;
  clearTimeout(ready.idle);
  const { win } = ready;
  win.houseSpare = false;
  Object.assign(frames.get(win.webContents.id), { rect, box: rect, maximized: false });
  win.webContents.setZoomFactor(readZoom()); // the zoom may have changed while it waited
  registerStation(win, [tab]);
  ready.claim();
  return win;
}

// Everything a Station 256 window takes part in: the list of windows, closing, crashes.
function registerStation(win, tabs) {
  const contents = win.webContents;
  const pageId = contents.id;
  stations.push(win);
  focusOrder.unshift(win);
  if (tabs) handoffs.set(pageId, tabs);
  // Closing from the taskbar goes through the same question as the X. A frozen page can't answer,
  // so it can't stop the window closing either.
  // A page still frozen 20 s after it stopped answering is ended, and so starts again through the
  // crash path below (a frozen page can't take a plain reload). Once per 5 minutes at most.
  let hangTimer = null;
  let lastHangRestart = 0;
  win.on('unresponsive', () => {
    closeOk.add(win);
    clearTimeout(hangTimer);
    hangTimer = setTimeout(() => {
      if (quitting || win.isDestroyed() || contents.isDestroyed() || contents.isCrashed()) return;
      if (Date.now() - lastHangRestart < (Number(process.env.HOUSE_HANG_GAP_MS) || 5 * 60 * 1000)) return;
      lastHangRestart = Date.now();
      process.stderr.write('[station] a page stayed frozen for 20 s; starting it again\n');
      lastCrash = 0; // not a second crash: the crash path should reload it
      contents.forcefullyCrashRenderer();
    }, Number(process.env.HOUSE_HANG_WAIT_MS) || 20000);
  });
  win.on('responsive', () => clearTimeout(hangTimer));
  win.on('closed', () => clearTimeout(hangTimer));
  win.on('close', (event) => {
    if (quitting || closeOk.has(win) || contents.isCrashed()) return;
    event.preventDefault();
    contents.send('window:close-request');
  });
  // A page that reloads starts again with the Agents page not showing.
  contents.on('did-navigate', () => watchAgentsFor(pageId, false));
  // A page that crashed starts again by itself. Its room terminals keep running and come back as
  // tabs. Twice within a minute and it's left alone, so it can't go round and round.
  let lastCrash = 0;
  contents.on('render-process-gone', (_event, details) => {
    if (quitting || details.reason === 'clean-exit' || win.isDestroyed()) return;
    terminals.letGo(contents);
    if (Date.now() - lastCrash < 60000) return;
    lastCrash = Date.now();
    recovering.add(pageId);
    contents.reload();
  });
  win.on('closed', () => {
    const wasHelpers = helperWindow() === win;
    stations.splice(stations.indexOf(win), 1);
    focusOrder = focusOrder.filter((other) => other !== win);
    [handoffs, shownTerms, liveFront].forEach((map) => map.delete(pageId));
    recovering.delete(pageId);
    watchAgentsFor(pageId, false);
    if (lastFocused === win) lastFocused = null;
    if (!stations.length) {
      mainWindow = null;
      app.quit();
      return;
    }
    // Its terminals close with it, as its tabs would: a room terminal keeps running in its room.
    if (!quitting) terminals.closeOwnedBy(contents);
    if (mainWindow === win) mainWindow = stations[0];
    if (wasHelpers) helperChanged(null);
    windowsChanged();
  });
  windowsChanged();
  contents.once('did-finish-load', () => { shownOnce = true; });
  return win;
}

// Each window knows how many there are, and whether it's the main one: a lone tab's buttons and
// what closing a window asks depend on that.
function windowsChanged() {
  for (const win of stations) {
    if (!win.isDestroyed()) win.webContents.send('windows:changed', { count: stations.length, main: win === mainWindow });
  }
}

function bringForward(win) {
  if (offScreen()) return; // never on screen in checks
  if (appMinimized.has(win) || win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Closes a window without asking: it's empty, or its one tab has just gone to another window.
function closeQuietly(win) {
  if (win.isDestroyed()) return;
  closeOk.add(win);
  win.hide(); // gone at once: over WSLg a window still on screen leaves a ghost while it closes
  win.close();
}

// What a page says about a tab moving to another window, checked. A Files tab carries its folder
// and its Back and Forward lists; a terminal is found by its number.
const stringList = (list) => (Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.length < 4096).slice(-100) : []);
function cleanTab(tab) {
  const kind = tab && typeof tab === 'object' ? tab.kind : null;
  // A Files tab's place is a folder, or 'home:', the Home page.
  if (kind === 'files' && typeof tab.path === 'string' && (tab.path.startsWith('/') || tab.path === 'home:') && tab.path.length < 4096) {
    return { kind, path: tab.path, back: stringList(tab.back), forward: stringList(tab.forward) };
  }
  if (kind === 'term' && Number.isInteger(tab.termId)) {
    if (!terminals.has(tab.termId)) throw new Error('This terminal has ended.');
    return { kind, termId: tab.termId };
  }
  if (kind === 'agents' || kind === 'rules' || kind === 'llama' || kind === 'schedules') return { kind };
  // A file open in a page of its own (renderer/doc-tab.js): the new window reads it again.
  if ((kind === 'doc' || kind === 'song') && typeof tab.path === 'string' && tab.path.startsWith('/') && tab.path.length < 4096) return { kind, path: tab.path };
  // The video editor's tab: the page it's on.
  if (kind === 'editor' && typeof tab.url === 'string' && tab.url.startsWith(`${editorApp.ORIGIN}/`) && tab.url.length < 8192) return { kind, url: tab.url };
  // A video open in its page (renderer/video-tab.js), with its edits not saved yet.
  if (kind === 'video' && typeof tab.path === 'string' && tab.path.startsWith('/') && tab.path.length < 4096) {
    const edits = tab.edits && typeof tab.edits === 'object' && JSON.stringify(tab.edits).length < 20000 ? JSON.parse(JSON.stringify(tab.edits)) : null;
    return { kind, path: tab.path, edits };
  }
  throw new Error('That tab can\'t move to another window.');
}

// Hands a tab to another window. A terminal is handed over here first, so nothing it prints is
// lost, and closing the window it came from can't end it. Carried there, the window comes to the
// front only once the tab has faded in, so what was carried fades out over it rather than vanishing.
const LAND_MS = 200;
function sendTab(target, tab, carried = false) {
  if (tab.kind === 'term') terminals.attach(tab.termId, target.webContents);
  target.webContents.send('tab:arrive', { tab });
  if (!carried) bringForward(target);
  else setTimeout(() => { if (!target.isDestroyed()) bringForward(target); }, LAND_MS);
}

// A box on screen in a page's own units, where that page draws it.
function inPage(win, rect) {
  const zoom = win.webContents.getZoomFactor();
  const { x, y } = win.getBounds();
  return { x: (rect.x - x) / zoom, y: (rect.y - y) / zoom, w: rect.w / zoom, h: rect.h / zoom };
}

// A new window for a tab: where the carried tab was let go (the tab's picture grows into it there),
// or else a little down and to the right of the window it came from. The same size as that window.
// Says where it is, in the page's own units, and tells that page once the window is on screen.
const CARRIED_AT = { x: 60, y: 16 }; // where the pointer holds the carried tab's picture (app.js)
function openInNewWindow(source, tab, atPointer) {
  const from = frames.get(source.webContents.id) || {};
  const { bounds } = screen.getPrimaryDisplay();
  const zoom = source.webContents.getZoomFactor();
  const w = Math.min(from.rect?.w || 1100, bounds.width);
  const h = Math.min(from.rect?.h || 720, bounds.height - 60);
  const point = atPointer ? screen.getCursorScreenPoint() : null;
  const x = point ? point.x - CARRIED_AT.x * zoom : (from.box?.x || 60) + 40;
  const y = point ? point.y - CARRIED_AT.y * zoom : (from.box?.y || 40) + 40;
  const rect = {
    x: Math.round(Math.max(0, Math.min(x, bounds.width - 200))),
    y: Math.round(Math.max(0, Math.min(y, bounds.height - 160))),
    w,
    h,
  };
  const win = windowForTab(rect, tab);
  if (tab.kind === 'term') terminals.attach(tab.termId, win.webContents);
  // On screen, and faded in (window-motion.js), before the picture standing in for it goes.
  frames.get(win.webContents.id)?.ready.then(() => wait(LAND_MS)).then(() => {
    if (!source.isDestroyed()) source.webContents.send('tab:landed');
  });
  return inPage(source, rect);
}

// Over a window's row of tabs (its top bar), where a carried tab can join in. Gives where along the
// row, in the page's own units, or null.
const TAB_ROW = 44;
function cursorOnTabs(win) {
  const frame = frames.get(win.webContents.id);
  if (!frame || appMinimized.has(win) || win.isMinimized()) return null;
  const point = screen.getCursorScreenPoint();
  const { box } = frame;
  const zoom = win.webContents.getZoomFactor();
  const inside = point.x >= box.x && point.x < box.x + box.w && point.y >= box.y - 8 && point.y < box.y + TAB_ROW * zoom;
  return inside ? (point.x - win.getBounds().x) / zoom : null;
}

// The other window whose tabs the pointer is over, the one in front if two overlap.
function tabsUnderPointer(source) {
  return focusOrder.find((win) => win !== source && !win.isDestroyed() && cursorOnTabs(win) !== null) || null;
}

// While a tab is carried over a window's tabs, a gap opens there where it would land.
let gapIn = null;
function showGap(target) {
  if (gapIn && gapIn !== target && !gapIn.isDestroyed()) gapIn.webContents.send('tabs:gap', { x: null });
  gapIn = target;
  if (target) target.webContents.send('tabs:gap', { x: cursorOnTabs(target) });
}

// Goes to a room's terminal in another window than the one asking (any of the room's, or only the
// one named): brings that window forward and shows the tab. Says whether there was one.
function showInOtherWindow(name, tab, asker) {
  for (const win of focusOrder) {
    if (win.isDestroyed() || win.webContents === asker) continue;
    const id = terminals.shownBy(win.webContents, name, tab);
    if (id === null) continue;
    bringForward(win);
    win.webContents.send('term:show', { id });
    return true;
  }
  return false;
}

// The window the Windows helper works with: the one you used last. Windows' snapping, the seams
// beside Windows apps and files dragged in from Windows all go to it. The helper itself follows
// the Station 256 window in front, which is the same one.
const helperWindow = () => focusOrder.find((win) => !win.isDestroyed()) || null;
function helperChanged(previous) {
  // Seams beside Windows apps belong to the window the helper follows, so the last one's go.
  if (previous && !previous.isDestroyed()) previous.webContents.send('window:link', { type: 'neighbors' });
  // The new one tells the helper where it is, and where its file list is.
  const next = helperWindow();
  if (next) next.webContents.send('window:link', { type: 'connected' });
}
const fromHelperWindow = (event) => BrowserWindow.fromWebContents(event.sender) === helperWindow();

// Runs an action on everything except projects whose rooms are open, and reports those as failed.
async function withoutHeld(paths, action) {
  const held = await house.heldByRooms(paths);
  const free = paths.filter((target) => !held.some((item) => item.path === target));
  return [...held, ...await action(free)];
}

// The same, for actions that also say what they did: { failures, ...rest }.
async function withoutHeldAnd(paths, action) {
  const held = await house.heldByRooms(paths);
  const free = paths.filter((target) => !held.some((item) => item.path === target));
  const result = await action(free);
  return { ...result, failures: [...held, ...result.failures] };
}

// Everything the page may ask for. Pages can't reach anything outside this list.
// The Agents page: what Herdr sees in every room, sent every few seconds while the page shows.
// Herdr is only asked while at least one window shows it, and each of those hears every look.
// Scheduled tasks: every window's Schedules page redraws when a task starts, ends or changes.
const scheduler = () => schedules.app(() => {
  for (const win of stations) if (!win.isDestroyed()) win.webContents.send('schedules:update');
});

const agentsWatch = herdr.watcher(() => house.rooms(), (look) => {
  for (const win of stations) if (!win.isDestroyed() && agentsWatchers.has(win.webContents.id)) win.webContents.send('agents:update', look);
}, () => houseTerms.look(terminals.houseList(), houseScreen));

// What a house terminal has on screen, from the window showing it (houseTermScreen in app.js), so
// the Agents page can tell whether its AI is working or needs you. Null if that window can't say.
function houseScreen(id) {
  const owner = terminals.ownerOf(id);
  if (!owner || owner.isDestroyed() || !Number.isInteger(id)) return Promise.resolve(null);
  return Promise.race([
    owner.executeJavaScript(`window.houseTermScreen ? window.houseTermScreen(${id}) : null`, false),
    new Promise((resolve) => { setTimeout(() => resolve(null), 1500); }),
  ]).catch(() => null);
}

// A terminal shown in another window: that window comes forward, on its tab.
function showTermInOtherWindow(id, asker) {
  const owner = terminals.ownerOf(id);
  if (!owner || owner.isDestroyed() || owner === asker) return false;
  const win = BrowserWindow.fromWebContents(owner);
  if (!win || win.isDestroyed()) return false;
  bringForward(win);
  owner.send('term:show', { id });
  return true;
}
function watchAgentsFor(pageId, on) {
  const had = agentsWatchers.size > 0;
  if (on) agentsWatchers.add(pageId);
  else agentsWatchers.delete(pageId);
  // A window that has just opened the page gets a look straight away.
  if (on) agentsWatch(true);
  else if (had && !agentsWatchers.size) agentsWatch(false);
}

// Every room terminal's AI, all the time Station 256 is open (lib/agent-alerts.js): the colors on
// terminal tabs, and a Windows notification when one finishes or needs you. Not about the terminal
// you're looking at right now: you can already see it.
let agentStatuses = {};
const notesInChecks = [];
// Linux windows may not always hear that you've gone to a Windows app, so when the app thinks you're
// looking, Windows is asked too. Without the helper, the app's own view stands.
async function lookingAt(room, tab) {
  const isIt = (id) => Number.isInteger(id) && terminals.roomOf(id) === room && terminals.tabOf(id) === tab;
  const here = stations.some((win) => !win.isDestroyed() && win.isFocused() && isIt(shownTerms.get(win.webContents.id)));
  if (!here) return false;
  return await windowsLink.appInFront() !== false;
}
// Goes to a room terminal: the window that has its tab, or else the main window, which opens its
// tab again if it was closed.
async function openAgentTab(room, tab) {
  if (showInOtherWindow(room, tab, null) || !mainWindow || mainWindow.isDestroyed()) return;
  bringForward(mainWindow);
  mainWindow.webContents.send('agents:open', { room, tab });
}
const agentAlerts = agentAlertsLib.create({
  listRooms: () => house.rooms(),
  statuses: (map) => {
    agentStatuses = map;
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('agents:tabs', map);
  },
  notify: (note) => {
    if (process.env.HOUSE_SHOTS) notesInChecks.push(note);
    else windowsLink.notify(note);
  },
  unnotify: (tag) => {
    if (process.env.HOUSE_SHOTS) notesInChecks.push({ gone: tag });
    else windowsLink.unnotify(tag);
  },
  looking: lookingAt,
  openTab: openAgentTab,
});
// A notification clicked in Windows. Open brings Station forward (the helper already did) and goes
// to the terminal. Approve and Deny answer in the terminal itself, unless the question has changed,
// and then it opens instead.
async function notificationClicked(message) {
  const action = ['approve', 'deny', 'open'].includes(message.action) ? message.action : 'open';
  const result = await agentAlerts.answer(String(message.id || ''), action);
  const room = String(message.room || '');
  const tab = String(message.tab || '');
  // From before Station 256 last opened: Open still knows where to go.
  if (result === 'unknown' && action === 'open' && /^[A-Za-z0-9]([A-Za-z0-9 _-]*[A-Za-z0-9_-])?$/.test(room) && /^tab-\d{1,4}$/.test(tab)) await openAgentTab(room, tab);
  if (result === 'changed') windowsLink.raiseStation();
  return result;
}
// You looked at a terminal, so its notification has done its job.
function terminalSeen(id) {
  if (Number.isInteger(id) && terminals.roomOf(id) && terminals.tabOf(id)) agentAlerts.seen(terminals.roomOf(id), terminals.tabOf(id));
}

const api = {
  // Each item comes with which AI last edited it, if one did (see lib/edits.js).
  list: async (_event, dir, showHidden) => edits.attach(await files.list(dir, showHidden)).catch(() => files.list(dir, showHidden)),
  // Where Windows (C:) opens in the sidebar: your Windows user folder.
  windowsHome: () => files.windowsHome(),
  makeFolder: (_event, dir, name, pickFree) => files.makeFolder(dir, name, pickFree),
  makeFile: (_event, dir, name) => files.makeFile(dir, name),
  // Moving and copying, by Paste or by dragging. Copies show how far along they are.
  transfer: (event, paths, dir, move) => (move
    ? withoutHeldAnd(paths, (free) => files.transfer(free, dir, true))
    : files.transfer(paths, dir, false, progressTo(event.sender))),
  trashItems: (_event, paths) => withoutHeldAnd(paths, async (free) => files.trashItems(free)),
  moveBack: (_event, pairs) => withoutHeld(pairs.map((pair) => pair.to), (free) => files.moveBack(pairs.filter((pair) => free.includes(pair.to)))),
  removeForever: async (event, paths) => {
    const failures = await withoutHeld(paths, (free) => files.removeForever(free, progressTo(event.sender)));
    await house.pruneRoomSettings().catch(() => {});
    return failures;
  },
  properties: (_event, paths) => files.properties(paths),
  // Zip files: make one, unpack one (with progress), or look inside one.
  compress: (event, paths) => archive.compress(paths, progressTo(event.sender)),
  extract: (event, target, mode) => archive.extract(target, mode, progressTo(event.sender)),
  archiveList: (_event, target) => archive.list(target),
  docxRead: (_event, target) => docx.read(target),
  // Only for files the panel can't show itself. Windows reading a house file needs the door open.
  openInWindows: async (_event, target, pick) => {
    await files.assertDoorOpen();
    await files.assertReadable(target); // opening only reads, so a file on C: is fine
    return windowsLink.openFile(target, pick);
  },
  // "Open in Web Browser" for an .html file: its address on Station's own local page server (lib/html-preview.js).
  htmlPreviewUrl: (_event, target) => htmlPreview.urlFor(target),
  // Clean-up: what the last run did, whether it runs by itself, run it now, turn it on or off.
  cleanupStatus: () => ({ ...housekeeping.status(), on: cleanupOn() }),
  cleanupNow: () => runCleanup(),
  setCleanup: (_event, on) => saveSettings({ cleanup: on !== false }),
  prefs: () => readSettings().prefs || {},
  setPrefs: (_event, change) => saveSettings({ prefs: { ...(readSettings().prefs || {}), ...change } }),
  rename: async (_event, target, name) => {
    const [held] = await house.heldByRooms([target]);
    if (held) throw new Error(held.message);
    return files.rename(target, name);
  },
  trash: (_event, paths) => withoutHeld(paths, (free) => files.trash(free)),
  paste: (_event, paths, dir, move) => (move ? withoutHeld(paths, (free) => files.paste(free, dir, true)) : files.paste(paths, dir, false)),
  restore: (_event, paths) => files.restore(paths),
  destroy: async (event, paths) => {
    const failures = await files.destroy(paths, progressTo(event.sender));
    await house.pruneRoomSettings().catch(() => {});
    return failures;
  },
  emptyTrash: async (event) => {
    const failures = await files.emptyTrash(progressTo(event.sender));
    await house.pruneRoomSettings().catch(() => {});
    return failures;
  },
  readText: (_event, target) => files.readText(target),
  // A file open in a page of its own (Markdown, text, code): read, checked for outside changes, saved.
  docRead: (_event, target) => files.readDoc(target),
  docStat: (_event, target) => files.docStat(target),
  // The owner's saves through Station are noted (lib/owner-saves.js), so "Last edited by" can say so for certain.
  docWrite: async (_event, target, text, expected, options) => {
    const result = await files.writeDoc(target, text, expected, options || {});
    if (!result.conflict) ownerSaves.note(target);
    return result;
  },
  // An edited picture (renderer/picture-editor.js): a copy beside it (in Pictures for one on C:,
  // which is view only), or saved over it with the old one kept in the Trash.
  savePicture: async (_event, target, bytes, { overwrite = false, ext = 'png' } = {}) => {
    if (!/^(png|jpe?g|webp)$/.test(ext)) throw new Error('Pictures save as PNG, JPEG or WebP.');
    let data = Buffer.from(bytes);
    // A photo keeps when and where it was taken (lib/picture-details.js). Read before it's saved over.
    if (/^jpe?g$/.test(ext)) data = await pictureDetails.keepDetails(target, data);
    if (overwrite) {
      const result = await files.replaceFile(target, data);
      ownerSaves.note(result.path);
      return result;
    }
    const here = await files.assertAllowed(target).then(() => !files.inTrash(target), () => false);
    const dir = here ? path.dirname(target) : path.join(app.getPath('home'), 'Pictures');
    const stem = path.basename(target, path.extname(target)).replace(/ \(edited(?: \d+)?\)$/, '');
    const made = await files.makeFile(dir, `${stem} (edited).${ext}`, data);
    ownerSaves.note(made);
    return { path: made };
  },
  putPictureBack: (_event, target, kept) => files.putBack(target, kept),
  thumbsLeft: (_event, dir) => thumbs.leftFolder(String(dir)),
  putFileBack: (_event, target, kept) => files.putBack(target, kept),
  // A video open in a page of its own (renderer/video-tab.js, lib/video.js). Saved as a copy beside
  // it (in Videos for one on C:, which is view only), or over it with the old one in the Trash.
  videoInfo: async (_event, target) => {
    await files.assertReadable(target);
    const [info, stat, beside] = await Promise.all([video.probe(target), fs.promises.stat(target), savesBeside(target)]);
    return { ...info, size: stat.size, mtime: stat.mtimeMs, beside, replaceable: beside && video.REPLACEABLE.test(target) };
  },
  videoPlayable: async (event, target, job) => {
    await files.assertReadable(target);
    return Boolean(await video.playableFor(target, { make: true, job, onProgress: jobProgress(event.sender, job) }));
  },
  videoSave: async (event, target, plan, { overwrite = false, job = null } = {}) => {
    await files.assertReadable(target);
    const beside = await savesBeside(target);
    const onProgress = jobProgress(event.sender, job);
    if (overwrite) {
      if (!beside || !video.REPLACEABLE.test(target)) throw new Error('This video can only be saved as a copy.');
      const ext = path.extname(target).slice(1).toLowerCase();
      const { temp, length } = await video.render(target, plan, { dir: path.dirname(target), ext, job, onProgress });
      try {
        const result = await files.replaceWith(target, temp);
        ownerSaves.note(result.path);
        return { ...result, length };
      } catch (error) {
        await fs.promises.rm(temp, { force: true });
        throw error;
      }
    }
    const dir = beside ? path.dirname(target) : path.join(app.getPath('home'), 'Videos');
    await files.ensureFolder(dir);
    const ext = video.REPLACEABLE.test(target) ? path.extname(target).slice(1).toLowerCase() : 'mp4';
    const { temp, length } = await video.render(target, plan, { dir, ext, job, onProgress });
    try {
      const made = await files.placeFile(temp, dir, `${stemOf(target)} (edited).${ext}`);
      ownerSaves.note(made);
      return { path: made, length };
    } catch (error) {
      await fs.promises.rm(temp, { force: true });
      throw error;
    }
  },
  videoCancel: (_event, job) => video.cancel(job),
  // Local AI (renderer/llama-tab.js, lib/llama.js): the reply comes back a bit at a time on llama:chat.
  llamaOverview: () => llama.overview(),
  llamaModel: (_event, file) => llama.modelInfo(file),
  llamaStart: (_event, options) => llama.start(options),
  llamaStop: () => llama.stop(),
  llamaStatus: () => llama.status(),
  // If the window that asked has closed, the model stops writing for nobody.
  llamaChat: (event, id, messages) => llama.chat(id, messages, (piece) => {
    if (event.sender.isDestroyed()) llama.stopChat(id);
    else event.sender.send('llama:chat', piece);
  }),
  llamaStopChat: (_event, id) => llama.stopChat(id),
  // A song's info (renderer/music-info.js, lib/music.js). Saved over the song with the old one in the Trash.
  songInfo: async (_event, target) => {
    await files.assertReadable(target);
    return { ...(await music.read(target)), beside: await savesBeside(target) };
  },
  songInfoSave: async (_event, target, changes, cover, copy) => {
    const result = await music.save(target, changes, cover, files, { copy: copy === true });
    ownerSaves.note(result && result.path);
    return result;
  },
  // Whether the video editor is built (../editor/out), so its tab can open.
  editorReady: () => editorApp.ready(),
  // The page only says where a drop goes, never which Windows files to read, so only a real drop
  // from the helper can bring Windows files in, and each drop only once.
  importDrop: (event, id, dir) => {
    if (!lastDrop || lastDrop.id !== id) throw new Error('That drop was already used. Please drag the files in again.');
    const { files: sources } = lastDrop;
    lastDrop = null;
    return files.importFromWindows(sources, dir, windowsCopier, progressTo(event.sender));
  },
  // The helper catches drops for one window: the one you used last.
  dropArea: (event, box, open) => {
    if (fromHelperWindow(event)) windowsLink.dropArea(box, open);
  },
  // Files copied in Windows File Explorer. The lock is checked before Windows is even asked which.
  windowsClipboard: () => windowsClipboardCount,
  pasteFromWindows: async (event, dir) => {
    await files.assertDoorOpen();
    const sources = await windowsLink.clipboardFiles();
    if (!sources.length) throw new Error('No files are copied in Windows anymore. Copy them in File Explorer again.');
    return files.importFromWindows(sources, dir, windowsCopier, progressTo(event.sender));
  },
  // A picture copied in Windows, pasted into a folder as "Pasted image <date> <time>.png". Like
  // copied text, it needs no unlocking: it's only what's on the clipboard, not Windows' files.
  windowsPicture: () => windowsPicture,
  pastePicture: async (_event, dir) => {
    const png = windowsPicture ? await copiedPicture() : null;
    if (!png) throw new Error('No picture is copied in Windows anymore. Copy it again.');
    return files.makeFile(dir, pastedImage.folderName(), png);
  },
  ensureFolder: (_event, dir) => files.ensureFolder(dir),

  paths: () => house.paths(),
  // The Home page: its numbers, projects and recent files. Tokens take longest, so they come apart.
  homeStats: () => stats.home(),
  homeTokens: () => stats.tokens(),
  navPane: () => readSettings().navPane || {},
  setNavPane: (_event, navPane) => saveSettings({ navPane }),
  columns: () => readSettings().columns || {},
  setColumns: (_event, columns) => saveSettings({ columns }),
  // "All folders inside" search (lib/search.js): results come back as 'search:batch' messages.
  searchScope: () => readSettings().searchScope || null,
  setSearchScope: (_event, searchScope) => saveSettings({ searchScope }),
  searchStart: (event, id, root, query, showHidden) => search.start(event.sender, event.sender.id, id, root, query, showHidden === true, files.assertReadable),
  wordsStart: (event, id, root, words) => searchWords.start(event.sender, event.sender.id, id, root, words, files.assertReadable),
  searchStop: (event) => search.cancel(event.sender.id),
  // "By meaning (Jev)" (lib/jev.js). The page only ever learns whether a key is saved, never the key.
  jevKey: () => jev.keyIsSet(),
  setJevKey: (_event, key) => jev.saveKey(key),
  removeJevKey: () => jev.removeKey(),
  meaningStart: (event, id, root, meaning, showHidden) => jev.start(event.sender, event.sender.id, id, root, meaning, showHidden === true, files.assertReadable),
  viewMode: () => readSettings().viewMode || null,
  setViewMode: (_event, viewMode) => saveSettings({ viewMode }),
  status: () => house.status(),
  newProject: (_event, name) => house.newProject(name),
  // GitHub (lib/github.js): get a project, see news, bring it in.
  githubClone: (event, url) => github.clone(url, { onProgress: (step) => { if (!event.sender.isDestroyed()) event.sender.send('github:progress', step); } }),
  githubStop: () => github.stop(),
  githubCheck: (_event, names) => github.checkMany(names),
  githubPull: (_event, name) => github.pullProject(name),
  githubPage: (_event, name) => github.pageOf(name),
  closeRoom: (_event, name) => house.closeRoom(name),
  openDoor: () => house.openDoor(),
  closeDoor: () => house.closeDoor(),
  getRules: () => house.getRules(),
  setRule: (_event, id, value) => house.setRule(id, value),
  system: () => house.system(),
  endProcess: (_event, pid) => house.endProcess(pid),
  setKeepAwake: (_event, value) => house.setKeepAwake(value),
  requestResize: (_event, size) => house.requestResize(size),

  termCount: () => terminals.count(),
  termBusy: (_event, id) => terminals.busy(id),
  termCreate: (event, options) => terminals.create(options, event.sender),
  // Room terminals that kept running while Station 256 was closed, joined again in the main window.
  // A window that crashed and started again gets its own back the same way.
  termRestore: (event) => {
    const asked = BrowserWindow.fromWebContents(event.sender);
    if (asked !== mainWindow && !recovering.has(event.sender.id)) return [];
    recovering.delete(event.sender.id);
    return terminals.restore(event.sender);
  },
  termAttach: (event, id) => terminals.attach(id, event.sender),
  // A terminal tab's AI chat, saved as a page in Downloads (right-click the tab). detail: with
  // every step the AI took. Says where the file went.
  chatExport: (_event, id, detail) => {
    const place = terminals.chatPlace(id);
    if (!place) throw new Error('This terminal has no chat to save.');
    return chatSave.save(place, Boolean(detail));
  },
  agentsWatch: (event, on) => watchAgentsFor(event.sender.id, Boolean(on)),
  // The Schedules page (lib/schedules.js).
  schedulesList: () => scheduler().list(),
  schedulesPreview: (_event, when) => scheduler().preview(when),
  schedulesProjects: () => scheduler().projects(),
  schedulesSave: (_event, task) => scheduler().saveTask(task),
  schedulesEnable: (_event, id, on) => scheduler().setEnabled(String(id), on),
  schedulesDelete: (_event, id) => scheduler().remove(String(id)),
  schedulesRun: (_event, id) => scheduler().runNow(String(id)),
  schedulesOutput: (_event, id) => scheduler().output(String(id)),
  // The tab colors as they are now, for a window that has just opened.
  agentStatuses: () => agentStatuses,
  // Each window's page says which terminal it's showing (null for none).
  termShown: (event, id) => {
    const shown = Number.isInteger(id) ? id : null;
    shownTerms.set(event.sender.id, shown);
    if (BrowserWindow.fromWebContents(event.sender)?.isFocused()) terminalSeen(shown);
  },
  termWrite: (_event, id, data) => terminals.write(id, data),
  termResize: (_event, id, cols, rows) => terminals.resize(id, cols, rows),
  termKill: (_event, id) => terminals.end(id),
  termOthers: (_event, name, tab) => terminals.othersRunning(name, tab),
  termStopTab: (_event, name, tab) => terminals.stopTab(name, tab),
  // Close Room on one of a room's terminals, from the Agents page or a Home card.
  termEndRoomTab: (_event, name, tab) => terminals.endRoomTab(name, tab),
  // A room's terminals and what their AI is doing, for a Home card's menu. Null if it can't say.
  roomTerminals: (_event, name) => herdr.roomTabs(name).catch(() => null),
  termFocusTerm: (event, id) => showTermInOtherWindow(id, event.sender),
  termClose: (_event, id) => terminals.close(id),
  termResumable: (_event, name) => terminals.resumable(name),
  termAgentTabs: (_event, name) => herdr.agentTabs(name),
  // A room's terminal shown in another window: that window comes forward, on that tab.
  termFocusRoom: (event, name) => showInOtherWindow(name, null, event.sender),
  termFocusRoomTab: (event, name, tab) => (typeof tab === 'string' && tab ? showInOtherWindow(name, tab, event.sender) : false),
  // Which of a room's terminals is sitting in a folder of the project, if any.
  termRoomTabAt: (_event, name, folder) => herdr.tabAt(name, folder),

  // Tabs moving between windows. The page only takes its tab away once one of these has worked.
  // A tab is about to be carried, or its "own window" button is about to be used: a window gets
  // ready for it out of sight.
  tabWarm: () => { warmSpare(); },
  // The "own window" button on a tab: the tab opens in a new window of its own. Says where.
  tabPopOut: (event, tab) => ({ box: openInNewWindow(BrowserWindow.fromWebContents(event.sender), cleanTab(tab), false) }),
  // A tab pulled off its window's tabs and let go: over another window's tabs it joins them, and
  // anywhere else it becomes a window of its own, right there.
  tabDrop: (event, tab) => {
    const source = BrowserWindow.fromWebContents(event.sender);
    const clean = cleanTab(tab);
    const target = tabsUnderPointer(source);
    if (gapIn !== target) showGap(null);
    gapIn = null; // the window it lands in closes its own gap
    if (target) {
      sendTab(target, clean, true);
      return { where: 'moved' };
    }
    return { where: 'popped', box: openInNewWindow(source, clean, true) };
  },
  // While a tab is carried: shows the gap in the tabs it's over, and says whether it's over some.
  tabHover: (event, active) => {
    const target = active ? tabsUnderPointer(BrowserWindow.fromWebContents(event.sender)) : null;
    showGap(target);
    return Boolean(target);
  },
  // A window with one tab, carried by that tab onto another window's tabs: the tab joins them and
  // its window closes, once the tab has faded in there.
  tabJoin: (event, tab) => {
    const source = BrowserWindow.fromWebContents(event.sender);
    const clean = cleanTab(tab);
    const target = tabsUnderPointer(source);
    if (gapIn !== target) showGap(null);
    gapIn = null;
    if (!target) return false;
    sendTab(target, clean, true);
    setTimeout(() => closeQuietly(source), LAND_MS);
    return true;
  },
  // A lone tab's "move back" button: it goes to the main window, and its own window closes.
  tabMoveBack: (event, tab) => {
    const source = BrowserWindow.fromWebContents(event.sender);
    if (!mainWindow || source === mainWindow) return false;
    sendTab(mainWindow, cleanTab(tab));
    closeQuietly(source);
    return true;
  },
  // How a page starts: the tabs it was opened with, if it was made from a tab, and how many
  // windows there are. A window kept ready waits here until a tab is given to it.
  windowStart: async (event) => {
    const waiting = spare && spare.win.webContents === event.sender ? spare.claimed : null;
    if (waiting) await waiting;
    const tabs = handoffs.get(event.sender.id) || null;
    handoffs.delete(event.sender.id);
    const front = liveFront.has(event.sender.id) ? liveFront.get(event.sender.id) : null;
    liveFront.delete(event.sender.id);
    return { tabs, count: stations.length, main: BrowserWindow.fromWebContents(event.sender) === mainWindow, front };
  },
  // A page ready for its new version (see pagesChanged): its tabs are kept here, its terminals keep
  // running, and it gets them all back as it starts again (windowStart). A terminal that has ended
  // is left out.
  liveReload: (event, tabs, front) => {
    const kept = [];
    let frontAt = null;
    (Array.isArray(tabs) ? tabs.slice(0, 200) : []).forEach((tab, at) => {
      try {
        kept.push(cleanTab(tab));
        if (at === front) frontAt = kept.length - 1;
      } catch { /* gone */ }
    });
    if (!kept.length) return false;
    handoffs.set(event.sender.id, kept);
    liveFront.set(event.sender.id, frontAt ?? kept.length - 1);
    const contents = event.sender;
    setTimeout(() => { if (!contents.isDestroyed()) contents.reloadIgnoringCache(); }, 0);
    return true;
  },
  // A window made for a tab has it in, so it can come on screen.
  windowFilled: (event) => { tabsIn.get(event.sender.id)?.(); },
  // A window whose last tab has gone closes, unless it's the only one: then it gets a Files tab.
  windowEmpty: (event) => {
    if (stations.length < 2) return false;
    closeQuietly(BrowserWindow.fromWebContents(event.sender));
    return true;
  },

  clipboardRead: () => clipboard.readText(),
  // Ctrl+V in a terminal: the text copied, or, when the newest copy in Windows is a picture, the
  // path of a file holding it, saved where the terminal can reach it (lib/pasted-image.js).
  termPaste: async (_event, id) => {
    const png = windowsPicture ? await copiedPicture() : null;
    if (!png) return clipboard.readText();
    const room = terminals.roomOf(id);
    return room ? pastedImage.saveInRoom(room, png) : pastedImage.saveInHouse(png);
  },
  // Copied in the house: on the house's clipboard and on Windows' too (lib/clipboard.js).
  // Either is newer than a picture copied in Windows, even before Windows says so.
  clipboardWrite: (_event, text) => { windowsPicture = false; return sharedClipboard.copyText(text); },
  clipboardFiles: (_event, paths, move) => { windowsPicture = false; return sharedClipboard.copyFiles(paths, move); },

  openLink: (_event, url, termId) => openLink(url, termId),
  // One-click Preview (lib/preview.js): what to do for a project, then run it in its room terminal.
  previewBegin: async (event, name) => {
    const found = await preview.begin(name, ports.portsOf);
    if (found.running) await openPreview(name, `http://localhost:${found.port}`, event.sender);
    return found;
  },
  // Whether a Preview's site is still up, so its button can go back to Preview when it stops.
  previewUp: (_event, name) => preview.isRunning(name, ports.portsOf),
  previewRun: (event, name, termId, command, missing) => preview.run({ room: name, termId, command, missing }, { terminals, ports, openUrl: (url) => openPreview(name, url, event.sender) }).catch((error) => ({ ok: false, message: error.message })),
  windowsList: (_event, withPictures) => windowsLink.list(withPictures),
  windowsPlace: (_event, id, box, focus) => windowsLink.move(id, box, focus),
  // Windows' snapping and the seams beside Windows apps follow one window: the one you used last.
  snapWatch: (event, box) => {
    if (fromHelperWindow(event)) windowsLink.watch(box);
  },
  snapSeam: (event, edge, at) => {
    if (fromHelperWindow(event)) windowsLink.seam(edge, at);
  },
  windowMinimize: (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    appMinimized.add(win);
    win.once('focus', () => appMinimized.delete(win));
    if (!offScreen()) win.minimize();
  },
  windowInit: async (event) => {
    const frame = frames.get(event.sender.id);
    await frame.ready;
    return { rect: frame.rect, maximized: frame.maximized, zoom: readZoom() };
  },
  windowRect: (event, box, rect, maximized) => {
    const frame = frames.get(event.sender.id);
    if (!frame) return;
    Object.assign(frame, { box, rect, maximized });
    if (mainWindow && event.sender === mainWindow.webContents) saveSettings({ window: { rect, maximized } });
  },
  // The page has asked whatever it needed to. The last window closing closes Station 256.
  windowClose: (event) => closeQuietly(BrowserWindow.fromWebContents(event.sender)),
  zoomStep: (_event, amount) => applyZoom(currentLevel() + (amount > 0 ? 0.05 : -0.05)),
  zoomReset: () => applyZoom(1),
  obscuraFront: (event, on) => obscuraApp.setFront(event.sender, on === true),
  // The window's answer to lib/ai-browser.js (a tab's page id, or the owner's yes or no), and the tab's Stop.
  aiBrowserAnswer: (_event, ask, value) => { aiBrowserApp?.answer(ask, value); },
  aiBrowserStop: (_event, project) => { if (typeof project === 'string') aiBrowserApp?.stop(project); },
};

ipcMain.handle('call', (event, name, args) => {
  if (!Object.prototype.hasOwnProperty.call(api, name)) throw new Error(`Unknown request: ${name}`);
  return api[name](event, ...args);
});

// Launching again (the shortcut) brings the open window forward instead of opening a second one.
// Alt+L asks for a new window instead (start.sh --new-window, from windows/station-keys.ps1), the
// way Win+E does for File Explorer. Every window shares the same rooms, terminals and Agents page.
if (!app.requestSingleInstanceLock({ newWindow: process.argv.includes('--new-window') })) app.quit();
app.on('second-instance', (_event, _argv, _folder, asked) => {
  if (asked && asked.newWindow === true) newStationWindow();
  else if (mainWindow) bringForward(mainWindow);
});

// A new window on the Home page, a little down and right of the window used last. Next to a
// maximized one it takes the usual size, in the middle.
function newStationWindow() {
  const last = focusOrder.find((win) => !win.isDestroyed());
  if (quitting || !last) return;
  const from = frames.get(last.webContents.id) || {};
  const { bounds } = screen.getPrimaryDisplay();
  const area = { w: bounds.width, h: bounds.height - 60 };
  const usual = from.maximized || !from.rect || !from.box;
  const w = usual ? Math.min(1500, Math.round(area.w * 0.85)) : Math.min(from.rect.w, area.w);
  const h = usual ? Math.min(918, Math.round(area.h * 0.9)) : Math.min(from.rect.h, area.h);
  const start = usual ? { x: Math.round((area.w - w) / 2) - 32, y: Math.round((area.h - h) / 2) - 32 } : from.box;
  const rect = {
    x: Math.max(0, Math.min(start.x + 32, area.w - w)),
    y: Math.max(0, Math.min(start.y + 32, area.h - h)),
    w,
    h,
  };
  // A fresh window, the way Station 256 starts: loading screen, then the Home page. It never takes the
  // terminals that come back at start-up: those only ever go to the first window (termRestore).
  const win = createStation({ rect, maximized: false });
  frames.get(win.webContents.id)?.ready.then(() => {
    if (!win.isDestroyed()) bringForward(win);
  });
}

// Sends to every Station 256 window.
function toAll(channel, payload) {
  for (const win of stations) if (!win.isDestroyed()) win.webContents.send(channel, payload);
}
llama.onStatus((state) => toAll('llama:status', state));

// A new version of the pages (lib/live-update.js). Styles change at once in every window; for page
// code, each window reloads itself when nobody's using it, with its tabs. The window kept ready for
// a tab is made again from the new version.
function pagesChanged(names) {
  if (quitting) return;
  dropSpare();
  toAll(liveUpdate.styleOnly(names) ? 'live:style' : 'live:reload', { names });
}

// Only the graphics process needs start.sh's d3d12 choice; terminals and programs Station starts don't.
if (process.env.HOUSE_PICKED_GL) {
  app.whenReady().then(() => app.getGPUInfo('basic')).catch(() => {}).finally(() => {
    delete process.env.GALLIUM_DRIVER;
    delete process.env.HOUSE_PICKED_GL;
  });
}

app.whenReady().then(() => {
  protocol.handle('house-file', async (request) => {
    const url = new URL(request.url);
    const target = decodeURIComponent(url.pathname);
    try {
      await files.assertReadable(target); // pictures and videos only get shown: C: is fine while unlocked
    } catch {
      return new Response('Not available', { status: 403 });
    }
    // ?thumb: the icon views' small picture of it (lib/thumbs.js), or nothing to show. ?view: a
    // picture the page can't show by itself (TIFF, HEIC, PSD...), made into one it can.
    let shown = target;
    if (url.searchParams.has('thumb') || url.searchParams.has('view')) {
      shown = await thumbs.thumbFor(target, url.searchParams.has('view')).catch(() => null);
      if (!shown) return new Response('No picture', { status: 404 });
    } else if (url.searchParams.has('strip') || url.searchParams.has('play')) {
      // ?strip: a row of a video's frames for its timeline. ?play: the copy made so it can play here.
      shown = await (url.searchParams.has('strip') ? video.stripFor(target) : video.playableFor(target)).catch(() => null);
      if (!shown) return new Response('Not made', { status: 404 });
    }
    const asked = request.headers.get('range');
    if (asked && !url.searchParams.has('edit')) {
      const part = await partOfFile(shown, asked).catch(() => null);
      if (part) return part;
    }
    const response = await net.fetch(pathToFileURL(shown).toString(), {
      headers: request.headers,
      bypassCustomProtocolHandlers: true,
    });
    // ?edit: the picture editor draws it and saves what it drew, which the page may only do when
    // the picture says it can be read (renderer/picture-editor.js).
    if (!url.searchParams.has('edit')) return response;
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
  createMainWindow();
  setTimeout(() => thumbs.tidy().catch(() => {}), 60000).unref();
  setTimeout(() => video.tidy().catch(() => {}), 90000).unref();
  scheduleCleanup();
  editorGuest = editorApp.start({ files, partOfFile, editableFor: video.editableFor, stopCopy: video.cancel, exportFile: video.exportFile, saveExport: saveEditorExport, openLink: (url) => openLink(url).catch(() => {}) });
  obscuraGuest = obscuraApp.start({ downloadsDir: () => path.join(app.getPath('home'), 'Downloads') });
  // shortcut: asks go to the main window (or the last one used); a project's AI tab dragged to another window isn't followed there.
  aiBrowserApp = aiBrowser.start({
    hostWindow: () => [mainWindow, lastFocused, ...BrowserWindow.getAllWindows()].find((win) => win && !win.isDestroyed()),
    reach: ports.reach,
    webRule: () => rulesLib.readRules().web,
    obscura: obscuraApp,
    webContents,
  });
  obscuraApp.setGuard(aiBrowserApp.allowed);
  try {
    house.ensureRules();
  } catch (error) {
    console.error('House rules could not be prepared:', error.message);
  }
  app.on('browser-window-focus', (_event, win) => {
    lastFocused = win;
    terminalSeen(shownTerms.get(win.webContents.id));
    const before = helperWindow();
    focusOrder = [win, ...focusOrder.filter((other) => other !== win)];
    if (before !== win) helperChanged(before);
  });
  // Tab colors and notifications. In checks, only with the stand-in Docker (test/stub), so a check
  // never looks inside a real room.
  const checking = ['HOUSE_SHOTS', 'HOUSE_FITTEST', 'HOUSE_SNAPTEST', 'HOUSE_SELFTEST', 'HOUSE_ZOOMWALK'].some((name) => process.env[name]);
  if (!checking || (process.env.HOUSE_SHOTS && process.env.STUB_AGENTS)) agentAlerts.start();
  // Scheduled tasks: the runner program is started if a task is on (it carries on after Station 256
  // closes). Checks start it only when asked to.
  if (!checking || (process.env.HOUSE_SHOTS && process.env.HOUSE_SCHEDULE_TEST)) scheduler().start().catch((error) => console.error('Schedules could not start:', error.message));
  // Sites running in rooms, reachable from Windows. Checks run beside the real app, which has them.
  if (!process.env.HOUSE_SHOTS && !process.env.HOUSE_FITTEST) ports.start();
  // Changes to the pages show without a restart. Not in checks: they run from copies being changed.
  if (!checking) liveUpdate.watchPanel(__dirname, pagesChanged);
  if (process.env.HOUSE_SHOTS) {
    // As if a picture (or, with null, something else) had just been copied in Windows.
    const copyPicture = (png) => {
      picturesInChecks.png = png;
      windowsPicture = Boolean(png);
      toAll('window:link', { type: 'clipboard', files: 0, image: windowsPicture, ours: false });
    };
    global.stationChecks = { opened: openedInChecks, voiceTyped, voiceEdited, notes: notesInChecks, notificationClicked, agentAlerts, copyPicture };
  }
  windowsLink.start((message) => {
    if (message.type === 'notification') {
      notificationClicked(message).catch(() => {});
      return;
    }
    if (message.type === 'voice') {
      voiceTyped(message.text);
      return;
    }
    if (message.type === 'voice-edit') {
      voiceEdited(message);
      return;
    }
    let passed = message;
    if (message.type === 'drop') {
      const sources = Array.isArray(message.files) ? message.files.map(String) : [];
      dropCount += 1;
      lastDrop = { id: dropCount, files: sources };
      passed = { type: 'drop', id: dropCount, x: message.x, y: message.y, names: sources.map((source) => source.split('\\').pop()) };
    } else if (message.type === 'clipboard') {
      // What the house itself just put there isn't something copied in Windows.
      const ours = message.ours === true;
      windowsClipboardCount = ours ? 0 : Number(message.files) || 0;
      windowsPicture = !ours && message.image === true;
      sharedClipboard.windowsChanged(message);
      passed = { type: 'clipboard', files: windowsClipboardCount, image: windowsPicture, ours };
    }
    // What's copied, and the helper (re)joining, matter to every window. Everything else (snapping,
    // seams, files dragged in) is about the window the helper follows: the one used last.
    if (passed.type === 'clipboard' || passed.type === 'connected') toAll('window:link', passed);
    else helperWindow()?.webContents.send('window:link', passed);
  });
  if (process.env.HOUSE_SNAPTEST) require('./test/snaptest').run(mainWindow);
  if (process.env.HOUSE_SELFTEST) require('./test/selftest').run(mainWindow, terminals);
  if (process.env.HOUSE_FITTEST) require('./test/fittest').run(mainWindow);
  if (process.env.HOUSE_ZOOMWALK) require('./test/zoomwalk').run(mainWindow);
  if (process.env.HOUSE_SHOTS) require('./test/shots').run(mainWindow);
});

app.on('before-quit', () => {
  quitting = true;
  BrowserWindow.getAllWindows().forEach((w) => { if (!w.isDestroyed()) w.hide(); }); // out of sight before the slow clean-up
  dropSpare();
  video.cancelAll(); // no ffmpeg left saving or copying with no Station to hear from it
  thumbs.cancelAll();
  agentAlerts.stop();
  schedules.shutdown();
  ports.stop();
  music.cancelAll(); // a song being saved stays as it was
  terminals.killAll();
  llama.stopNow();
});
