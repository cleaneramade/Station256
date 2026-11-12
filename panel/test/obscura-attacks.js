// Obscura under attack, in the hidden copy (shotrun.sh obscuraAttacks). A made-up hostile site tries
// to reach the house, open windows, get permissions, flood Downloads and drive Station; each line
// is PASS or FAIL. The everyday checks are in obscura-scene.js.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { BrowserWindow, webContents, session } = require('electron');

const DOWNLOAD_NAMES = {
  trav1: 'filename="../../.bashrc"',
  trav2: "filename*=UTF-8''..%2F..%2F..%2Fevil.sh",
  long: `filename="${'A'.repeat(400)}.txt"`,
  longuni: `filename*=UTF-8''${'%E6%97%A5'.repeat(300)}.txt`,
  ctrl: "filename*=UTF-8''bad%0Aname%09%1B%5B31m.txt",
  zero: 'filename="zero.bin"',
  xframe: 'filename="framed.txt"',
  storm: 'filename="storm.txt"',
};

function server(seen) {
  return new Promise((resolve) => {
    const made = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://x');
      const html = (body) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(body); };
      if (url.pathname === '/ok') return html('<title>ok</title><a id="mid" href="/popup" style="position:fixed;left:0;top:0;width:300px;height:150px;display:block">link</a>');
      if (url.pathname === '/popup') return html('<title>popup</title>popup');
      if (url.pathname === '/xss') return html('<title>&lt;img src=x onerror="window.__pwn=1"&gt;</title>x');
      if (url.pathname === '/popframe') return html(`<script>window.open('/popup?fromframe')</script>`);
      if (url.pathname === '/fav1') return html('<title>f1</title><link rel="icon" href="/endless.png">');
      if (url.pathname === '/fav2') return html('<title>f2</title><link rel="icon" href="/inject.png">');
      if (url.pathname === '/redir-file') { response.writeHead(302, { Location: 'file:///etc/passwd' }); return response.end(); }
      if (url.pathname === '/inject.png') { response.writeHead(200, { 'Content-Type': 'image/png"), url("http://127.0.0.1:1/x' }); return response.end('x'); }
      if (url.pathname === '/endless.png') {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        const timer = setInterval(() => { seen.endless += 65536; response.write(Buffer.alloc(65536)); }, 5);
        response.on('close', () => { clearInterval(timer); seen.endlessClosed = true; });
        return undefined;
      }
      if (url.pathname === '/dl') {
        const kind = url.searchParams.get('kind');
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; ${DOWNLOAD_NAMES[kind]}` });
        return response.end(kind === 'zero' ? '' : 'downloaded');
      }
      response.writeHead(404);
      return response.end('nope');
    });
    made.listen(0, '127.0.0.1', () => resolve(made));
  });
}

module.exports = async function obscuraAttacks({ page, shot, sleep, win }) {
  const results = [];
  const report = (ok, text) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} obscuraAttacks: ${String(text).replace(/\s+/g, ' ').slice(0, 330)}`); };
  const seen = { endless: 0, endlessClosed: false };
  const srv = await server(seen);
  const port = srv.address().port;
  const base = `http://localhost:${port}`;
  const other = `http://127.0.0.1:${port}`; // the same pages from another origin
  const home = os.homedir();
  const downloads = path.join(home, 'Downloads');
  const obscuraTabs = () => page(`houseTest.state.tabs.filter((t) => t.kind === 'obscura').length`);
  const windows = () => `${BrowserWindow.getAllWindows().length}/${webContents.getAllWebContents().filter((c) => c.getType() === 'window').length}`;
  const guests = () => webContents.getAllWebContents().filter((c) => c.getType() === 'webview').length;
  const until = async (test, ms = 6000) => {
    for (let waited = 0; waited < ms; waited += 150) {
      if (await test()) return true;
      await sleep(150);
    }
    return false;
  };
  const closeExtras = async () => {
    await page(`(() => { for (const t of [...houseTest.state.tabs]) if (t.kind === 'obscura' && t !== window.__t0) houseTest.closeTab(t); houseTest.activateTab(window.__t0); return true; })()`);
    await sleep(400);
  };
  const SNAP = `JSON.stringify(['.navpane', '.nav-grip', '.addressbar', '.commandbar', '.main > .statusbar', '.systempane', '.tabstrip'].map((q) => { const n = document.querySelector(q); if (!n) return null; const r = n.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), n.className, n.hidden]; }))`;
  try {
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    await page(`(() => { window.__hostMark = 1; return true; })()`);
    const windowsBefore = windows();
    const homeBefore = fs.readdirSync(home).filter((name) => name !== 'Downloads').sort().join('|');

    // ---- Layout: a collapsed sidebar and every bar come back exactly; a narrow window still fits.
    await page(`(() => { document.getElementById('nav-toggle').click(); return true; })()`);
    await sleep(500);
    const snapBefore = await page(SNAP);
    await page(`(() => { window.__files = houseTest.state.active; window.__t0 = houseTest.openInObscura('${base}/ok'); return true; })()`);
    report(await until(() => page(`!!window.__t0.wcId && !window.__t0.loading`)), 'an Obscura tab opens');
    const wc = webContents.fromId(await page(`window.__t0.wcId`));
    const g = (code, gesture = true) => wc.executeJavaScript(code, gesture);
    await page(`(() => { houseTest.activateTab(window.__files); return true; })()`);
    await sleep(600);
    const snapAfter = await page(SNAP);
    report(snapAfter === snapBefore, `Files tab after Obscura: collapsed sidebar, header, command bar, status bar exactly as before ${snapAfter === snapBefore ? '' : `${snapBefore} -> ${snapAfter}`}`);
    await page(`(() => { document.getElementById('nav-toggle').click(); houseTest.activateTab(window.__t0); return true; })()`);
    await sleep(400);
    const narrow = await page(`(async () => { const app = document.querySelector('.app'); const old = app.style.width; app.style.width = '560px'; await new Promise((r) => setTimeout(r, 400)); const bar = document.querySelector('.ob-bar'); const out = { chip: getComputedStyle(document.querySelector('.ob-chip')).display, label: getComputedStyle(document.querySelector('.ob-outside span')).display, fits: bar.scrollWidth <= bar.clientWidth + 1, field: Math.round(document.querySelector('.ob-field').getBoundingClientRect().width) }; window.__undoNarrow = () => { app.style.width = old; }; return out; })()`);
    await shot('obscura-narrow');
    await page(`(() => { window.__undoNarrow(); return true; })()`);
    report(narrow.chip === 'none' && narrow.label === 'none' && narrow.fits && narrow.field > 200, `a narrow window drops the chips and keeps a usable address bar ${JSON.stringify(narrow)}`);

    // ---- 1. Ways out to the house.
    const globals = await g(`[typeof require, typeof process, typeof house, typeof ipcRenderer, typeof module, typeof Buffer, typeof global, typeof electron].join()`);
    report(/^(undefined,?)+$/.test(globals), `page has no require/process/house/ipcRenderer (${globals})`);
    const prefs = wc.getLastWebPreferences();
    const guestsBefore = guests();
    await g(`(() => { const v = document.createElement('webview'); v.setAttribute('src', '${base}/popup'); v.setAttribute('nodeintegration', ''); document.body.append(v); return true; })()`);
    await sleep(1200);
    report(guests() === guestsBefore && prefs.webviewTag === false, `a <webview> inside the page attaches nothing (webviewTag ${prefs.webviewTag})`);
    const handled = ['house-file', 'station-editor'].map((scheme) => wc.session.protocol.isProtocolHandled(scheme));
    report(wc.session === session.fromPartition('persist:obscura') && handled.every((yes) => yes === false), `house-file: and station-editor: do not exist in Obscura's session (${handled})`);
    const leaks = async () => {
      const found = [];
      for (const frame of wc.mainFrame.framesInSubtree) {
        const text = await frame.executeJavaScript('document.documentElement ? document.documentElement.innerText : ""').catch(() => '');
        if (/^(file|house-file|station-editor):/.test(frame.url) || /root:/.test(text)) found.push(frame.url);
      }
      return found;
    };
    await g(`(() => {
      for (const src of ['file:///etc/passwd', 'house-file:///etc/passwd', 'station-editor://app/house/etc/passwd', '/redir-file']) { const f = document.createElement('iframe'); f.src = src; document.body.append(f); }
      const later = document.createElement('iframe'); later.src = '/popup';
      later.onload = () => { later.onload = null; try { later.contentWindow.location = 'house-file:///etc/passwd'; } catch {} };
      document.body.append(later);
      const second = document.createElement('iframe'); second.src = '/popup';
      second.onload = () => { second.onload = null; try { second.contentWindow.location = 'file:///etc/passwd'; } catch {} };
      document.body.append(second);
      return true; })()`);
    await sleep(1800);
    let found = await leaks();
    report(found.length === 0, `iframes and frame navigations to file:, house-file:, station-editor: (and a redirect to file:) show nothing ${JSON.stringify(found)}`);
    const reads = await g(`(async () => {
      const out = {};
      for (const url of ['file:///etc/passwd', 'house-file:///etc/passwd', 'station-editor://app/house/etc/passwd']) {
        const scheme = url.split(':')[0];
        out[scheme + ' fetch'] = await fetch(url).then((r) => 'GOT ' + r.status, () => 'blocked');
        out[scheme + ' xhr'] = await new Promise((done) => { const x = new XMLHttpRequest(); x.onload = () => done('GOT ' + x.status); x.onerror = () => done('blocked'); try { x.open('GET', url); x.send(); } catch { done('blocked'); } });
        out[scheme + ' img'] = await new Promise((done) => { const i = new Image(); i.onload = () => done('GOT'); i.onerror = () => done('blocked'); i.src = url; });
        out[scheme + ' link'] = await new Promise((done) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.onload = () => done('GOT'); l.onerror = () => done('blocked'); l.href = url; document.head.append(l); });
      }
      return out; })()`);
    report(Object.values(reads).every((answer) => answer === 'blocked'), `fetch, XMLHttpRequest, <img>, <link> to file: and Station's schemes ${JSON.stringify(reads)}`);
    const tried = [];
    for (const target of [`'house-file:///etc/passwd'`, `'file:///etc/passwd'`, `'station-editor://app/'`, `'view-source:${base}/ok'`, `'data:text/html,<h1>root:data</h1>'`, `URL.createObjectURL(new Blob(['<h1>root:blob</h1>'], { type: 'text/html' }))`, `'chrome://gpu'`]) {
      await g(`(() => { try { location = ${target}; } catch {} return true; })()`).catch(() => {});
      await sleep(500);
      if (wc.getURL() !== `${base}/ok` || (await leaks()).length) tried.push(`${target} -> ${wc.getURL()}`);
    }
    report(tried.length === 0, `script sending the page to house-file:, file:, view-source:, data:, blob:, chrome: goes nowhere ${JSON.stringify(tried)}`);
    // A file dropped on the page is a navigation the browser itself starts; so is this.
    for (const dropped of ['file:///etc/passwd', 'house-file:///etc/passwd']) await wc.loadURL(dropped).catch(() => {});
    await sleep(500);
    found = await leaks();
    const droppedText = await g('document.documentElement.innerText').catch(() => '');
    report(!/root:/.test(droppedText), `a navigation started outside the page (as a dropped file is) to file:/house-file: shows no file ("${droppedText.slice(0, 40)}")`);
    await wc.loadURL(`${base}/ok`);

    // ---- 4a. Downloads with hostile names (before the windows checks, so the storm below is on its own).
    const listeners = [session.defaultSession, win.webContents.session, session.fromPartition('persist:station-editor'), wc.session].map((ses) => ses.listenerCount('will-download'));
    report(listeners.join() === '0,0,0,1', `only Obscura's session handles downloads (default, panel, editor, Obscura: ${listeners})`);
    const list = () => (fs.existsSync(downloads) ? fs.readdirSync(downloads) : []);
    const had = list(); // the everyday scene's downloads, when it ran first
    await g(`(() => { for (const kind of ['trav1', 'trav2', 'long', 'longuni', 'ctrl', 'zero']) { const f = document.createElement('iframe'); f.src = '/dl?kind=' + kind; document.body.append(f); } const x = document.createElement('iframe'); x.src = '${other}/dl?kind=xframe'; document.body.append(x); return true; })()`);
    await until(() => list().length >= had.length + 7, 8000);
    await sleep(800);
    const saved = list().filter((name) => !had.includes(name));
    const badName = saved.filter((name) => /[\x00-\x1f\x7f/\\]/.test(name) || name.startsWith('.') || Buffer.byteLength(name) > 255);
    const outside = ['/.bashrc', '/tmp/.bashrc', '/tmp/evil.sh', '/evil.sh', path.join(home, 'evil.sh'), path.join(home, '.bashrc')].filter((file) => fs.existsSync(file) && fs.statSync(file).mtimeMs > Date.now() - 60000);
    report(saved.length === 7 && badName.length === 0 && outside.length === 0 && fs.readdirSync(home).filter((name) => name !== 'Downloads').sort().join('|') === homeBefore, `7 hostile downloads all land inside Downloads under safe names: ${JSON.stringify(saved.map((name) => (name.length > 28 ? `${name.slice(0, 12)}…(${Buffer.byteLength(name)} bytes)…${name.slice(-6)}` : name)))} bad ${JSON.stringify(badName)} outside ${JSON.stringify(outside)}`);
    report(saved.includes('zero.bin') && fs.statSync(path.join(downloads, 'zero.bin')).size === 0 && saved.includes('framed.txt'), 'an empty file and one from a cross-origin iframe are saved');
    report(saved.some((name) => name.length > 150 && name.endsWith('.txt')), 'very long names are cut short and keep their ending');

    // ---- 2. Windows.
    let tabs = await obscuraTabs();
    await g(`window.open('/popup?noopener', '_blank', 'noopener'); 0`);
    const a = await until(async () => (await obscuraTabs()) === tabs + 1);
    await g(`(() => { const f = document.createElement('form'); f.target = '_blank'; f.action = '/popup'; document.body.append(f); f.submit(); return 0; })()`);
    const b = await until(async () => (await obscuraTabs()) === tabs + 2);
    report(a && b && windows() === windowsBefore, `window.open with noopener and a form with target=_blank each become one Obscura tab, no window (${windows()})`);
    await closeExtras();
    wc.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'middle', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'middle', clickCount: 1 });
    await until(async () => (await obscuraTabs()) === tabs + 1, 2500);
    report(windows() === windowsBefore && (await obscuraTabs()) <= tabs + 1, `middle-click on a link: ${(await obscuraTabs()) - tabs} new tab, no window`);
    await closeExtras();
    await sleep(5200); // the limit is 3 new tabs in 5 seconds
    await g(`(() => { const f = document.createElement('iframe'); f.src = '${other}/popframe'; document.body.append(f); return 0; })()`);
    report(await until(async () => (await obscuraTabs()) === tabs + 1) && windows() === windowsBefore, 'a popup from a cross-origin iframe becomes one Obscura tab, no window');
    await page(`(() => { houseTest.activateTab(window.__t0); return true; })()`);
    await g(`(() => { for (let i = 0; i < 100; i += 1) window.open('/popup?' + i); return 0; })()`);
    await sleep(3000);
    const flood = (await obscuraTabs()) - tabs;
    report(flood <= 3 && windows() === windowsBefore && (await page(`window.__hostMark === 1`)), `window.open 100 times in a loop: ${flood} tabs in all (with the one before), no window`);
    await closeExtras();
    await sleep(5200);
    // A tab a page opened is shut in the same way as the first.
    await g(`window.open('/ok?second'); 0`);
    await until(async () => (await obscuraTabs()) === tabs + 1);
    await until(() => page(`houseTest.state.active !== window.__t0 && !!houseTest.state.active.wcId && !houseTest.state.active.loading`));
    const second = webContents.fromId(await page(`houseTest.state.active.wcId`));
    const p2 = second.getLastWebPreferences();
    const g2 = await second.executeJavaScript(`[typeof require, typeof process, typeof house].join()`, true);
    await second.executeJavaScript(`window.open('/popup?third'); 0`, true);
    const third = await until(async () => (await obscuraTabs()) === tabs + 2);
    report(second !== wc && second.session === wc.session && p2.sandbox === true && p2.nodeIntegration === false && p2.contextIsolation === true && p2.webviewTag === false && !p2.preload && g2 === 'undefined,undefined,undefined' && third && windows() === windowsBefore, `a tab opened by a page is shut in like the first, and its own window.open is a tab too (${windows()})`);
    await closeExtras();

    // ---- 3. Permissions. (Nothing here writes the clipboard or opens a file chooser.)
    const asked = await g(`(async () => {
      const wait = (p) => Promise.race([p, new Promise((done) => setTimeout(() => done('timeout'), 3000))]);
      const out = {};
      out.clipboardRead = await wait(navigator.clipboard.readText().then(() => 'GRANTED', (e) => e.name));
      out.screen = await wait(navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => 'GRANTED', (e) => e.name));
      out.midiSysex = await wait(navigator.requestMIDIAccess({ sysex: true }).then(() => 'GRANTED', (e) => e.name));
      out.notification = await wait(Notification.requestPermission());
      out.geolocation = await wait(new Promise((done) => navigator.geolocation.getCurrentPosition(() => done('GRANTED'), (e) => done('code ' + e.code), { timeout: 2500 })));
      out.microphone = await wait(navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'GRANTED', (e) => e.name));
      out.bluetooth = navigator.bluetooth ? await wait(navigator.bluetooth.requestDevice({ acceptAllDevices: true }).then(() => 'GRANTED', (e) => e.name)) : 'none';
      out.usb = navigator.usb ? await wait(navigator.usb.requestDevice({ filters: [] }).then(() => 'GRANTED', (e) => e.name)) : 'none';
      out.hid = navigator.hid ? await wait(navigator.hid.requestDevice({ filters: [] }).then((d) => (d.length ? 'GRANTED' : 'empty'), (e) => e.name)) : 'none';
      out.serial = navigator.serial ? await wait(navigator.serial.requestPort().then(() => 'GRANTED', (e) => e.name)) : 'none';
      out.pickers = [typeof showOpenFilePicker, typeof showDirectoryPicker, typeof showSaveFilePicker].join();
      out.query = [];
      for (const name of ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read', 'clipboard-write', 'midi', 'persistent-storage']) out.query.push(await navigator.permissions.query({ name }).then((s) => s.state, () => 'n/a'));
      out.query = out.query.join();
      return out; })()`);
    report(!/GRANTED|granted/.test(JSON.stringify(asked)) && asked.notification === 'denied', `every permission and device request is refused ${JSON.stringify(asked)}`);
    report(asked.pickers === 'undefined,undefined,undefined', `pages cannot ask for a file or folder handle (File System Access: ${asked.pickers})`);

    // ---- 4b. A download storm.
    await g(`(() => { for (let i = 0; i < 50; i += 1) { const f = document.createElement('iframe'); f.src = '/dl?kind=storm'; document.body.append(f); } return 0; })()`);
    await sleep(3000);
    const started = Date.now();
    await g('1 + 1');
    await page('1 + 1');
    const storm = list().filter((name) => /^storm/.test(name));
    const stormNote = await page(`window.__t0.note.textContent`);
    report(Date.now() - started < 2000 && storm.length >= 1 && storm.length <= 10 && /many files/.test(stormNote) && windows() === windowsBefore, `50 downloads at once: ${storm.length} saved under ${new Set(storm).size} names, the rest stopped, nothing freezes; the tab says "${stormNote}"`);
    report(!/shell\b|openPath|openExternal|showItemInFolder/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'obscura.js'), 'utf8')), 'nothing in lib/obscura.js can open a downloaded file');

    // ---- The tab's picture: a "picture" without end, and one whose type line carries CSS.
    await wc.loadURL(`${base}/fav1`);
    const stopped = await until(() => seen.endlessClosed, 8000);
    report(stopped, 'an endless favicon is let go of, not read to the end');
    await wc.loadURL(`${base}/fav2`);
    await sleep(1200);
    report(await page(`!window.__t0.favicon`), 'a favicon whose content type carries extra text is not used');

    // ---- 5. Station's own window.
    await wc.loadURL(`${base}/xss`);
    await sleep(800);
    const title = await page(`({ text: window.__t0.el.querySelector('.tab-title').textContent, nodes: document.querySelectorAll('img[src="x"], .tab-title *').length, pwn: typeof window.__pwn })`);
    report(/^<img src=x/.test(title.text) && title.nodes === 0 && title.pwn === 'undefined' && !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'obscura-tab.js'), 'utf8')), `a page title full of HTML stays text ${JSON.stringify(title)}`);
    const id = wc.id;
    tabs = await obscuraTabs();
    for (const forged of [{ kind: 'open', url: 'file:///etc/passwd' }, { kind: 'open', url: 'javascript:window.__pwn=1' }, { kind: 'open', url: 'house-file:///etc/passwd' }, { kind: 'open', url: { toString: 1 } }, { kind: 'note', note: '<img src=x onerror="window.__pwn=1">' }, { kind: 'favicon', src: 'javascript:window.__pwn=1' }, { kind: 'key', key: '__proto__', ctrl: true }, { kind: 'constructor' }]) win.webContents.send('obscura:event', { id, ...forged });
    await sleep(600);
    const forgedSeen = await page(`({ tabs: houseTest.state.tabs.filter((t) => t.kind === 'obscura').length, noteNodes: window.__t0.note.children.length, pwn: typeof window.__pwn, favicon: !!window.__t0.favicon, mark: window.__hostMark })`);
    report(forgedSeen.tabs === tabs && forgedSeen.noteNodes === 0 && forgedSeen.pwn === 'undefined' && !forgedSeen.favicon && forgedSeen.mark === 1, `even forged obscura:event messages only open web pages and show text ${JSON.stringify(forgedSeen)}`);
    await wc.loadURL(`${base}/ok`);
    const allTabs = () => page(`houseTest.state.tabs.map((t) => t.kind).join()`);
    const tabsBefore = await allTabs();
    for (const key of [{ keyCode: 'L', modifiers: ['alt'] }, { keyCode: 'F11' }, { keyCode: 'F12' }, { keyCode: 'I', modifiers: ['control', 'shift'] }, { keyCode: 'J', modifiers: ['control', 'shift'] }, { keyCode: 'N', modifiers: ['control'] }]) {
      wc.sendInputEvent({ type: 'keyDown', ...key });
      wc.sendInputEvent({ type: 'keyUp', ...key });
    }
    await sleep(800);
    report(!wc.isDevToolsOpened() && !win.webContents.isDevToolsOpened() && !win.isFullScreen() && windows() === windowsBefore && (await allTabs()) === tabsBefore && (await page(`window.__hostMark === 1`)), 'Alt+L, F11, F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+N in the page do nothing to Station; no devtools');
    // Ctrl + in the address bar zooms the page, and Station's zoom keys work again on a Files tab.
    const stationZoom = () => page(`window.devicePixelRatio`);
    const zoomBefore = await stationZoom();
    await page(`(() => { window.__t0.input.focus(); return true; })()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '=', modifiers: ['control'] });
    await sleep(600);
    const pageZoom = await page(`window.__t0.zoom`);
    report((await stationZoom()) === zoomBefore && pageZoom > 1, `Ctrl+plus in the address bar zooms the page (${pageZoom}), not Station (${zoomBefore} -> ${await stationZoom()})`);
    await page(`(() => { houseTest.activateTab(window.__files); return true; })()`);
    await sleep(500);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['control'] });
    await sleep(600);
    const filesZoom = await stationZoom();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['control'] });
    await sleep(400);
    report(filesZoom > zoomBefore, `on a Files tab Ctrl+plus still zooms Station (${zoomBefore} -> ${filesZoom})`);
    await page(`(() => { houseTest.activateTab(window.__t0); return true; })()`);
    await sleep(400);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] });
    await sleep(900);
    const afterT = await allTabs();
    report(afterT === `${tabsBefore},files`, `Ctrl+T in the page opens one Files tab, as it does everywhere in Station (${afterT})`);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control'] });
    await sleep(1200);
    const afterW = await allTabs();
    report(afterW === afterT.replace('obscura,', '') && guests() === guestsBefore - 1, `Ctrl+W in the page closes just that Obscura tab (${afterW})`);
    report(windows() === windowsBefore, `no window was ever made (${windowsBefore} -> ${windows()})`);
  } catch (error) {
    report(false, `scene stopped: ${error.stack || error.message}`);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
  console.log(`${results.every(Boolean) ? 'PASS' : 'FAIL'} obscuraAttacks: ${results.filter(Boolean).length} of ${results.length} checks passed`);
};
