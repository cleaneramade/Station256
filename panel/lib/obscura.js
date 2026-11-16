// Obscura, Station 256's web browser tab (renderer/obscura-tab.js shows it as a <webview>).
//
// A web page is the one thing in Station that isn't ours, and the panel can read every file in the
// house. So Obscura is built to be shut in: its pages live in a session of their own
// (persist:obscura) with no preload and no Node, they get no permissions (not notifications, not the
// clipboard, not the screen) except one: the microphone and camera, and only when the owner says yes
// for that site (see askOwner below). They can only go to http(s) addresses, and whatever they
// download lands in a folder for its kind (Downloads if unsure) and is never opened. The page itself sits in a sandbox; this file
// is the wall around it.
const { app, BrowserWindow, screen, session, webContents } = require('electron');
const fs = require('fs');
const path = require('path');

const PARTITION = 'persist:obscura';
// The only thing a page may use without asking. (The editor's own list is in lib/editor-app.js.)
const PERMITTED = new Set(['fullscreen']);
// The one thing the owner may allow, site by site: what a page asks for -> what the owner sees.
const MEDIA = { audio: 'microphone', video: 'camera' };
const ASK_MS = 60000; // a question nobody answers in a minute counts as no (and is not remembered)
// https, or a page on this computer (a room's site). Anything else never gets to ask.
const askable = (origin) => /^https:\/\/[^/]+$/i.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };
// Addresses nothing in Obscura may ever load, even as a picture or a script inside a page.
const NEVER = /^(file|house-file|station-editor|chrome|chrome-extension|chrome-untrusted|devtools|view-source|filesystem):/i;
// Where a page may be taken: the web, and a blank page.
const mayGoTo = (url) => /^https?:\/\//i.test(url) || url === 'about:blank';
// A frame inside a page may also hold what the page made itself (data:, blob:, about:srcdoc), but
// never a file, one of Station's own schemes, or a link that starts another program (mailto:, myapp:).
const frameMayGoTo = (url) => /^(https?|about|data|blob):/i.test(url);

let obscuraSession = null;
let notify = () => {};
// A second wall for requests, set by lib/ai-browser.js: (details) => true or false (may wait).
let guard = () => true;
// Set by start(): { read() -> { origin: { microphone, camera } }, set(origin, kinds, yes) } (main.js keeps it in settings).
let siteAccess = { read: () => ({}), set: () => {} };
const questions = new Map(); // "origin kinds" -> the question now open for it, so a site asking twice is asked once
const answers = new Map(); // question number -> what to do with the owner's answer
let asked = 0;
const setGuard = (fn) => { guard = fn; };
// Also set by lib/ai-browser.js: (webContentsId) => true for a page an AI is using.
let aiPage = () => false;
const setAiPage = (fn) => { aiPage = fn; };

// A page can ask for a hundred tabs or a hundred downloads in a loop. tooMany(times, most, ms) says
// when `most` have already happened within `ms`; otherwise it counts this one.
const opened = [];
const downloaded = [];
function tooMany(times, most, ms) {
  const now = Date.now();
  while (times.length && now - times[0] > ms) times.shift();
  if (times.length >= most) return true;
  times.push(now);
  return false;
}

// A name in Downloads that isn't taken yet: "name.zip", then "name (1).zip", "name (2).zip".
// Names still being saved count as taken (their files may not be there yet), and a very long name
// is cut short but keeps its ending: Linux takes 255 bytes at most.
const saving = new Set();

// Where a download goes, by what it is: [folder, file ending, or a type start]. Anything else: Downloads.
const SORTED = [
  ['Music', /^audio\/|\.(mp3|wav|flac|ogg|m4a|aac|opus)$/i],
  ['Videos', /^video\/|\.(mp4|mkv|webm|mov|avi|m4v)$/i],
  ['Pictures', /^image\/|\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|ico)$/i],
  ['Documents', /\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|odt|rtf|epub)$/i],
];
const folderFor = (name, mime = '') => (SORTED.find(([, rule]) => rule.test(mime) || rule.test(name)) || ['Downloads'])[0];

function freeName(dir, wanted) {
  const clean = String(wanted || '').replace(/[\\/:*?"<>|\x00-\x1f\x7f]+/g, '_').replace(/^\.+/, '') || 'download';
  const ext = path.extname(clean).slice(0, 20);
  let stem = clean.slice(0, clean.length - path.extname(clean).length).slice(0, 150);
  while (Buffer.byteLength(stem) > 180) stem = stem.slice(0, -1);
  let name = stem + ext;
  for (let n = 1; saving.has(name) || fs.existsSync(path.join(dir, name)); n += 1) name = `${stem} (${n})${ext}`;
  return name;
}

// Asks the owner, in the window that holds this tab, whether site may use kinds. Resolves true or false,
// or null when nobody answered (no window, a minute passed, the tab closed): that is a no, not remembered.
function askOwner(contents, site, kinds) {
  return new Promise((resolve) => {
    const host = contents.hostWebContents;
    if (!host || host.isDestroyed()) { resolve(null); return; }
    asked += 1;
    const id = asked;
    const finish = (yes) => {
      clearTimeout(timer);
      contents.removeListener('destroyed', gone);
      answers.delete(id);
      resolve(yes);
    };
    const gone = () => finish(null);
    const timer = setTimeout(() => { notify(contents, { kind: 'access-over', ask: id }); finish(null); }, ASK_MS);
    contents.once('destroyed', gone);
    answers.set(id, finish);
    notify(contents, { kind: 'access', ask: id, site, kinds });
  });
}
const answerOwner = (id, yes) => answers.get(id)?.(typeof yes === 'boolean' ? yes : null); // Esc or a closed dialog: no answer

// May this page use the microphone and/or camera it asked for (details.mediaTypes)? Never for a page an
// AI is driving, a frame inside a page, or a site that isn't https; otherwise the owner's saved answer
// for that site, or one question to the owner (shared by every request from the site meanwhile).
async function mediaAllowed(contents, details) {
  const kinds = [...new Set((details.mediaTypes || []).map((type) => MEDIA[type]))];
  const site = originOf(details.requestingUrl);
  if (!kinds.length || kinds.includes(undefined) || details.isMainFrame !== true || aiPage(contents.id) || !askable(site)) return false;
  const saved = () => siteAccess.read()[site] || {};
  const unknown = kinds.filter((kind) => typeof saved()[kind] !== 'boolean');
  if (unknown.length) {
    const key = `${site} ${unknown.join()}`;
    if (!questions.has(key)) {
      questions.set(key, askOwner(contents, site, unknown).then((yes) => {
        questions.delete(key);
        if (yes !== null) siteAccess.set(site, unknown, yes);
        return yes;
      }));
    }
    if ((await questions.get(key)) === null) return false;
  }
  return kinds.every((kind) => saved()[kind] === true);
}

// deps: homeDir, siteAccess. Sets up the session once; returns what to do with each Obscura page.
function start({ homeDir, siteAccess: access }) {
  if (access) siteAccess = access;
  const ses = session.fromPartition(PARTITION);
  obscuraSession = ses;
  // Looks like one ordinary Chrome on Linux to sites, not "Electron" (see identify below).
  ses.setUserAgent(CHROME_UA, app.getLocale());

  // No permissions, except the microphone and camera when the owner said yes for that site (mediaAllowed).
  // Everything else (notifications, location, clipboard, the screen) is refused, not asked, not "granted" by a check.
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') { callback(PERMITTED.has(permission)); return; }
    mediaAllowed(contents, details).then(callback, () => callback(false));
  });
  // The quiet check never asks: it only repeats a saved yes, with the same limits as above.
  ses.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (permission !== 'media') return PERMITTED.has(permission);
    // origin is Chromium's requestingOrigin string; originOf makes a trailing slash or full URL match the store key.
    const kind = MEDIA[details?.mediaType];
    const site = originOf(origin);
    return !!kind && !!contents && details.isMainFrame === true && !aiPage(contents.id) && askable(site) && siteAccess.read()[site]?.[kind] === true;
  });
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => { try { callback({}); } catch { /* denied */ } });
  for (const kind of ['select-hid-device', 'select-serial-port', 'select-usb-device']) {
    ses.on(kind, (event, _list, callback) => { event.preventDefault(); callback(''); });
  }

  // Nothing here reaches a house file: no file: pages, and none of Station's own schemes.
  ses.protocol.handle('file', () => new Response('The browser does not open files.', { status: 403 }));
  ses.webRequest.onBeforeRequest(async (details, callback) => {
    if (NEVER.test(details.url)) { callback({ cancel: true }); return; }
    let ok = false;
    try { ok = await guard(details); } catch { /* a wall that fails says no */ }
    callback({ cancel: !ok });
  });

  // Electron sends no Sec-CH-UA hints of its own, so they are added here as Chrome would: the short ones
  // on every secure request, the full version list once a site has asked for it (Accept-CH).
  const wantsFull = new Set();
  ses.webRequest.onHeadersReceived((details, callback) => {
    try {
      const asked = Object.entries(details.responseHeaders || {}).some(([k, v]) => /^(accept|critical)-ch$/i.test(k) && /full-version-list/i.test([].concat(v).join()));
      if (asked) wantsFull.add(new URL(details.url).origin);
    } catch { /* not a readable address: nothing to remember */ }
    callback({});
  });
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    if (/^(https:|http:\/\/(127\.0\.0\.1|localhost)[:/])/i.test(details.url)) {
      Object.assign(headers, { 'sec-ch-ua': HINT_BRANDS(MAJOR, '24'), 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Linux"' });
      try { if (wantsFull.has(new URL(details.url).origin)) headers['sec-ch-ua-full-version-list'] = HINT_BRANDS(FULL, '24.0.0.0'); } catch { /* skipped */ }
    }
    callback({ requestHeaders: headers });
  });

  // A download goes to the folder for its kind (folderFor) under a free name, and is never opened.
  ses.on('will-download', (event, item, contents) => {
    const id = contents?.id;
    const host = contents?.hostWebContents;
    const say = (note) => { if (host && !host.isDestroyed()) host.send('obscura:event', { kind: 'note', id, note }); };
    // At most 10 downloads in 10 seconds: a page can start them without being asked.
    if (tooMany(downloaded, 10, 10000)) {
      event.preventDefault(); // this one never starts
      say('This page tried to download many files at once. The browser stopped the rest.');
      return;
    }
    const folder = folderFor(item.getFilename(), item.getMimeType());
    const dir = path.join(homeDir(), folder);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the save fails below, and says so */ }
    const name = freeName(dir, item.getFilename());
    saving.add(name);
    item.setSavePath(path.join(dir, name));
    item.once('done', (_done, state) => {
      saving.delete(name);
      if (state === 'completed') say(`Saved to ${folder}: ${name}`);
      else if (state === 'cancelled') say(`The download of ${name} was cancelled.`);
      else say(`${name} could not be downloaded.`);
    });
  });

  notify = (guest, event) => {
    const host = guest.hostWebContents;
    if (host && !host.isDestroyed()) host.send('obscura:event', { id: guest.id, ...event });
  };
  return guestHook;
}

const owns = (guest) => !!obscuraSession && guest.session === obscuraSession;

// The Station windows whose front tab is Obscura (the tab says so). There Ctrl + and Ctrl - zoom the
// page, even from the address bar, so main.js leaves those keys alone.
const inFront = new WeakSet();
const setFront = (host, on) => { if (on) inFront.add(host); else inFront.delete(host); };
const isFront = (host) => inFront.has(host);

// Keys that belong to the browser. Inside a page they'd never reach Station, so they're sent to
// the tab (which handles them) and kept from the page. F5 and Ctrl+R reload the page only: Station's
// own Ctrl+R (restart the window) never sees them here.
function browserKey(input) {
  if (input.type !== 'keyDown') return false;
  const key = String(input.key);
  const lower = key.toLowerCase();
  if (key === 'F5') return true;
  if (input.alt && !input.control && !input.meta) return key === 'ArrowLeft' || key === 'ArrowRight';
  if (!input.control) return false;
  return ['l', 'r', 'f', 'w', 't', '+', '=', '-', '_', '0', 'Tab'].includes(lower === 'tab' ? 'Tab' : lower);
}

// One honest identity for every page: Chromium <major> on Linux, which is what Obscura is. The
// user-agent text, the Sec-CH-UA headers and navigator.userAgentData all say the same thing.
// It used to claim "Google Chrome" and fake Chrome's window.chrome extras; Google's sign-in refuses
// browsers that pose as Chrome (its 2020 guidance), so nothing is faked any more. Electron has no
// setting for the JS brands, so they are set through the page's own debugger; if that can't attach
// the page still loads with Electron's own brands (the same names, the grease brand may differ).
const FULL = process.versions.chrome;
const MAJOR = FULL.split('.')[0];
const CHROME_UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36`;
const HINT_BRANDS = (version, grease) => `"Chromium";v="${version}", "Not?A_Brand";v="${grease}"`;
const identity = () => ({
  userAgent: CHROME_UA,
  platform: 'Linux x86_64',
  acceptLanguage: app.getLocale(),
  userAgentMetadata: {
    brands: [{ brand: 'Chromium', version: MAJOR }, { brand: 'Not?A_Brand', version: '24' }],
    fullVersionList: [{ brand: 'Chromium', version: FULL }, { brand: 'Not?A_Brand', version: '24.0.0.0' }],
    fullVersion: FULL, platform: 'Linux', platformVersion: '', architecture: 'x86', bitness: '64', model: '', mobile: false, wow64: false,
  },
});
async function identify(guest) {
  try {
    if (!guest.debugger.isAttached()) guest.debugger.attach('1.3');
    await guest.debugger.sendCommand('Emulation.setUserAgentOverride', identity());
  } catch { /* the page is gone, or something else holds its debugger: it keeps Electron's look */ }
}

// The same wall as a tab's page (guardAttach), for a sign-in popup.
const LOCKED = {
  nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, contextIsolation: true,
  sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, disableBlinkFeatures: 'FileSystemAccessLocal',
};
function popupOptions(guest) {
  let parent;
  try { parent = BrowserWindow.fromWebContents(guest.hostWebContents || guest) || undefined; } catch { /* none */ }
  return { width: 520, height: 680, parent, autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { ...LOCKED } };
}

// One Obscura page: where it may go, what it may open, what it tells the tab. popup: a sign-in
// window a page opened (see setWindowOpenHandler below), which has no tab to tell.
function guestHook(guest, popup = false) {
  // If someone else takes the debugger and lets go, take it back (not while the page is closing).
  guest.debugger.on('detach', () => {
    // A moment later, so a page that is closing is gone by then (taking it back at once hung the close).
    setTimeout(() => { if (!guest.isDestroyed() && !guest.debugger.isAttached()) identify(guest); }, 200);
  });
  identify(guest);
  guest.on('will-prevent-unload', (event) => event.preventDefault());
  // A link or window.open without a size gets a new Obscura tab. A small window a page opens with a
  // size ("Sign in with Google", PayPal...) stays a real popup, as in Chrome: the page that opened it
  // waits for it to report back (window.opener), which a separate tab can't do, so sign-in failed.
  // It gets the same wall as a tab's page. At most 3 of either in 5 seconds, however many pages ask.
  guest.setWindowOpenHandler(({ url, disposition }) => {
    if (!mayGoTo(url) || tooMany(opened, 3, 5000)) return { action: 'deny' };
    // shortcut: no check that a click asked for the popup (Electron doesn't say); the 3-in-5-seconds limit applies, as it did to tabs.
    if (disposition === 'new-window' && !aiPage(guest.id)) return { action: 'allow', overrideBrowserWindowOptions: popupOptions(guest) };
    notify(guest, { kind: 'open', url });
    return { action: 'deny' };
  });
  guest.on('did-create-window', (win) => {
    win.removeMenu();
    guestHook(win.webContents, true);
  });
  // Bluetooth asks the page itself, not the session; left alone, Electron picks the first device.
  guest.on('select-bluetooth-device', (event, _list, callback) => { event.preventDefault(); callback(''); });
  const stay = (event, url) => {
    if (mayGoTo(url)) return;
    event.preventDefault();
    notify(guest, { kind: 'blocked', url });
  };
  guest.on('will-navigate', (event, url) => stay(event, url));
  guest.on('will-redirect', (event, url) => stay(event, url));
  guest.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) stay(event, event.url);
    else if (!frameMayGoTo(event.url)) event.preventDefault();
  });
  guest.on('before-input-event', (event, input) => {
    if (!popup && input.type === 'keyDown' && input.key === 'Escape') notify(guest, { kind: 'esc' }); // closes a menu left open
    if (popup || !browserKey(input)) return; // a popup has no tab to take the keys
    event.preventDefault();
    notify(guest, { kind: 'key', key: input.key, ctrl: !!input.control, shift: !!input.shift, alt: !!input.alt });
  });
  // Ctrl and the mouse wheel: the tab zooms this page (obscura-tab.js), the same as Ctrl + and Ctrl -.
  guest.on('zoom-changed', (_event, direction) => notify(guest, { kind: 'zoom', direction: direction === 'in' ? 1 : -1 }));
  // Right-click: the tab draws Station's own menu (obscura-tab.js) from what was under the pointer.
  // Only web links are passed on; the page's own words for them never are.
  guest.on('context-menu', (_event, p) => {
    const flags = p.editFlags || {};
    // Where the mouse is in Station's own page: the page's x and y don't say, since Station's zoom
    // and the page's zoom both stretch them. The mouse is read from the screen instead.
    let at = null;
    try {
      const host = guest.hostWebContents;
      const win = host && BrowserWindow.fromWebContents(host);
      if (win) {
        const cursor = screen.getCursorScreenPoint();
        const bounds = win.getContentBounds();
        const zoom = host.getZoomFactor() || 1;
        at = { x: (cursor.x - bounds.x) / zoom, y: (cursor.y - bounds.y) / zoom };
      }
    } catch { /* the page's own spot is used below */ }
    notify(guest, {
      kind: 'menu', at, x: Number(p.x) || 0, y: Number(p.y) || 0, zoom: guest.hostWebContents?.getZoomFactor?.() || 1,
      media: p.mediaType === 'image' ? 'image' : '', editable: !!p.isEditable,
      src: /^https?:\/\//i.test(p.srcURL || '') ? String(p.srcURL).slice(0, 4096) : '',
      link: /^https?:\/\//i.test(p.linkURL || '') ? String(p.linkURL).slice(0, 4096) : '',
      words: String(p.selectionText || '').slice(0, 1 << 20),
      canCut: !!flags.canCut, canPaste: !!flags.canPaste, canSelectAll: flags.canSelectAll !== false,
    });
  });
  // The tab's picture: fetched here, as the page would, and handed over as a small data: picture
  // (the panel itself may not load pictures from the web).
  guest.on('page-favicon-updated', async (_event, favicons) => {
    const wanted = (favicons || []).find((url) => /^https?:\/\//i.test(url));
    if (!wanted) return;
    const fetching = new AbortController();
    try {
      const response = await obscuraSession.fetch(wanted, { signal: fetching.signal });
      // Only the kind of picture it says it is, word for word: the rest of that line is the site's to write.
      const type = /^image\/(png|x-icon|vnd\.microsoft\.icon|jpeg|gif|webp|svg\+xml)(?=\s*(;|$))/i.exec(response.headers.get('content-type') || '');
      if (!response.ok || !type) return;
      // Read a piece at a time and stop at 200 KB: a "picture" without end must not fill the memory.
      const parts = [];
      let size = 0;
      for await (const part of response.body) {
        size += part.length;
        if (size > 200000) return;
        parts.push(part);
      }
      notify(guest, { kind: 'favicon', src: `data:${type[0].toLowerCase()};base64,${Buffer.concat(parts).toString('base64')}` });
    } catch { /* no picture: the tab keeps its own */ } finally {
      fetching.abort(); // whatever is still coming is let go
    }
  });
}

// A Station window may only attach an Obscura page that is shut in the way above.
function guardAttach(event, webPreferences, params) {
  // Not before start() has set the session's rules: a page attached then would have none of them.
  if (!obscuraSession || !mayGoTo(String(params.src || 'about:blank'))) {
    event.preventDefault();
    return;
  }
  delete webPreferences.preloadURL;
  delete webPreferences.preload;
  Object.assign(webPreferences, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    enableRemoteModule: false,
    // No "let this site see a folder" (showOpenFilePicker, showDirectoryPicker, showSaveFilePicker):
    // a page never gets a handle on house files. An ordinary upload button still works.
    disableBlinkFeatures: 'FileSystemAccessLocal',
  });
  params.allowpopups = false; // no popup windows: a page's request for one is turned into a new tab by guestHook
  // Without this Electron drops the request before guestHook hears of it. The hook always answers
  // deny, so no window of Electron's own is ever made.
  webPreferences.disablePopups = false;
  params.partition = PARTITION;
}

module.exports = { start, answerOwner, owns, guardAttach, setFront, isFront, setGuard, setAiPage, PARTITION, mayGoTo, freeName, folderFor };
