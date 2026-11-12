// Obscura's checks, in the hidden copy (shotrun.sh obscura). A small web server of made-up pages
// tries every way out of the browser tab; each line is PASS or FAIL. Nothing is shown on screen.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { BrowserWindow, webContents } = require('electron');

const PAGES = {
  '/ok': '<title>Hello Obscura</title><h1>ok</h1>',
  '/popup': '<title>Popup page</title><p>popup</p>',
  '/links': '<title>Links</title><a id="f" href="file:///etc/passwd">f</a><a id="h" href="house-file:///etc/passwd">h</a><a id="c" href="myapp://x">c</a><a id="blank" target="_blank" href="/popup">b</a>',
};

function server() {
  return new Promise((resolve) => {
    const made = http.createServer((request, response) => {
      if (request.url === '/redir') { response.writeHead(302, { Location: 'myapp://steal' }); response.end(); return; }
      if (request.url === '/redir-file') { response.writeHead(302, { Location: 'file:///etc/passwd' }); response.end(); return; }
      if (request.url === '/dl') {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="../evil file.txt"' });
        response.end('downloaded');
        return;
      }
      const page = PAGES[request.url];
      response.writeHead(page ? 200 : 404, { 'Content-Type': 'text/html' });
      response.end(page || 'nope');
    });
    made.listen(0, '127.0.0.1', () => resolve(made));
  });
}

module.exports = async function obscura({ page, shot, sleep, win }) {
  const results = [];
  const report = (ok, text) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} obscura: ${text}`); };
  const srv = await server();
  const base = `http://localhost:${srv.address().port}`;
  const tabs = () => page(`houseTest.state.tabs.filter((t) => t.kind === 'obscura').length`);
  const guests = () => webContents.getAllWebContents().filter((wc) => wc.getType() === 'webview');
  const guestOf = async () => webContents.fromId(await page(`(() => { const t = houseTest.state.active; return t.wcId || t.view.getWebContentsId(); })()`));
  const inGuest = async (code) => (await guestOf()).executeJavaScript(code, true);
  const waitFor = async (code, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 150) {
      if (await page(code).catch(() => false)) return true;
      await sleep(150);
    }
    return false;
  };
  const load = async (url) => {
    await page(`(() => { const t = houseTest.state.active; t.input.value = ${JSON.stringify(url)}; t.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; })()`);
    await sleep(400);
    await waitFor(`!houseTest.state.active.loading`);
  };
  try {
    await page(`(() => { window.__hostMark = 1; return true; })()`);
    const windowsBefore = BrowserWindow.getAllWindows().length;

    // The address bar's reading of what is typed.
    const read = await page(`(() => { const a = houseTest.obscuraAddress; return ['localhost:3000', 'example.com', 'cats and dogs', 'nodots', 'file:///etc/passwd', 'javascript:alert(1)', 'chrome://gpu', 'devtools://x', 'house-file:///etc/passwd', 'station-editor://app/', 'http://a.b/c', 'data:text/html,hi', '192.168.1.5:8080/x'].map((t) => (a(t).url || 'ERR ' + a(t).error)); })()`);
    const want = ['http://localhost:3000', 'https://example.com', 'duckduckgo.com/?q=cats%20and%20dogs', 'duckduckgo.com/?q=nodots', 'ERR', 'ERR', 'ERR', 'ERR', 'ERR', 'ERR', 'http://a.b/c', 'ERR', 'http://192.168.1.5:8080/x'];
    report(read.every((got, i) => got.includes(want[i])), `address bar: ${JSON.stringify(read)}`);

    // A first tab.
    await page(`(() => { houseTest.openInObscura('${base}/ok'); return true; })()`);
    report(await waitFor(`houseTest.state.active.kind === 'obscura' && houseTest.state.active.el.querySelector('.tab-title').textContent === 'Hello Obscura'`), 'page title becomes the tab name');
    await sleep(500);
    const info = await page(`(() => { const t = houseTest.state.active; const v = t.view; return { partition: v.getAttribute('partition'), preload: v.hasAttribute('preload'), popups: v.hasAttribute('allowpopups'), nodeint: v.hasAttribute('nodeintegration'), lock: t.lock.hidden, insecure: t.lock.classList.contains('insecure'), address: t.input.value }; })()`);
    report(info.partition === 'persist:obscura' && !info.preload && !info.popups && !info.nodeint, `webview attributes ${JSON.stringify(info)}`);
    report(!info.lock && info.insecure && info.address === `${base}/ok`, 'http page shows the address and the not-secure hint');
    const wc = await guestOf();
    const prefs = wc.getLastWebPreferences();
    report(prefs.nodeIntegration === false && prefs.contextIsolation === true && prefs.sandbox === true && prefs.webSecurity !== false && !prefs.preload && !prefs.allowpopups, `guest preferences nodeIntegration=${prefs.nodeIntegration} contextIsolation=${prefs.contextIsolation} sandbox=${prefs.sandbox} webSecurity=${prefs.webSecurity} preload=${prefs.preload}`);
    const globals = await inGuest(`[typeof require, typeof process, typeof window.house, typeof module].join()`);
    report(globals === 'undefined,undefined,undefined,undefined', `no Node or Station bridge in the page (${globals})`);
    report(wc.session.storagePath !== null && wc.session !== win.webContents.session, 'its own session, not the panel\'s');
    await shot('obscura-page');

    // The page takes the whole tab area; the other tabs get everything back exactly.
    const front = await page(`(() => { const shown = (sel) => { const n = document.querySelector(sel); return !!n && n.getBoundingClientRect().width > 0 && getComputedStyle(n).display !== 'none'; }; const bar = document.querySelector('.ob-bar').getBoundingClientRect(); const stage = document.querySelector('.ob-stage').getBoundingClientRect(); const app = document.querySelector('.app').getBoundingClientRect(); return { cls: document.body.classList.contains('obscura-front'), nav: shown('.navpane'), address: shown('.addressbar'), command: shown('.commandbar'), status: shown('.main > .statusbar'), tabs: shown('.tabstrip'), barH: Math.round(bar.height), stageLeft: Math.round(stage.left - app.left), stageRight: Math.round(app.right - stage.right), stageBottom: Math.round(app.bottom - stage.bottom), info: document.querySelector('.ob-chip').textContent, outside: document.querySelector('.ob-outside').textContent, h: ['.doc-area', '.ob-host', '.ob-stage', '.ob-view'].map((q) => Math.round(document.querySelector(q).getBoundingClientRect().height)).join('/'), app: Math.round(app.height) }; })()`);
    report(front.cls && !front.nav && !front.address && !front.command && !front.status && front.tabs && front.barH <= 34 && front.stageLeft <= 2 && front.stageRight <= 2 && front.stageBottom <= 2, `Obscura in front hides sidebar, folder header, command bar, status bar; keeps tab strip; page fills the area ${JSON.stringify(front)}`);
    await page(`(() => { document.querySelector('.ob-address').focus(); return true; })()`);
    await page(`(() => { window.house.setZoomFactor(2.2); return true; })()`);
    await sleep(500);
    await shot('obscura-zoomed');
    await page(`(() => { window.house.setZoomFactor(1.35); return true; })()`);
    await page(`(() => { houseTest.setObscuraInfo({ project: 'SampleApp', agent: 'Claude' }); return true; })()`);
    await sleep(300);
    await shot('obscura-info');
    await page(`(() => { houseTest.setObscuraInfo({}); return true; })()`);
    await page(`(() => { window.__nav = document.querySelector('.navpane').getBoundingClientRect().width; window.__navCls = document.querySelector('.navpane').className; const keep = houseTest.state.tabs.find((t) => t.kind === 'files'); houseTest.activateTab(keep); return true; })()`);
    await sleep(500);
    const back = await page(`(() => { const shown = (sel) => { const n = document.querySelector(sel); return !!n && n.getBoundingClientRect().width > 0; }; return { cls: document.body.classList.contains('obscura-front'), nav: shown('.navpane'), width: Math.round(document.querySelector('.navpane').getBoundingClientRect().width), address: shown('.addressbar'), command: shown('.commandbar'), status: shown('.main > .statusbar') }; })()`);
    report(!back.cls && back.nav && back.address && back.command && back.status && back.width > 100, `switching to a Files tab brings everything back ${JSON.stringify(back)}`);
    await shot('obscura-back-to-files');
    await page(`(() => { houseTest.activateTab(houseTest.state.tabs.find((t) => t.kind === 'obscura')); return true; })()`);
    await sleep(300);

    // window.open and target=_blank: a new Obscura tab, never a new window.
    const before = await tabs();
    await inGuest(`window.open('/popup'); 0`);
    report(await waitFor(`houseTest.state.tabs.filter((t) => t.kind === 'obscura').length === ${before + 1}`), 'window.open opens a new Obscura tab');
    report(BrowserWindow.getAllWindows().length === windowsBefore, 'no new window of Electron\'s own');
    await page(`(() => { const t = houseTest.state.active; houseTest.closeTab(t); return true; })()`);
    await sleep(300);
    // Back on the first tab.
    await page(`(() => { houseTest.activateTab(houseTest.state.tabs.find((t) => t.kind === 'obscura')); return true; })()`);

    // Links and typing to file:, house-file: and a custom scheme.
    await load(`${base}/links`);
    const here = await inGuest('location.href');
    for (const id of ['f', 'h', 'c']) {
      await inGuest(`document.getElementById('${id}').click(); 0`);
      await sleep(600);
      const now = await inGuest('location.href');
      report(now === `${base}/links` && (await page(`!!houseTest.state.active.note.textContent`)) !== undefined, `link #${id} (${{ f: 'file:', h: 'house-file:', c: 'myapp:' }[id]}) goes nowhere`);
    }
    await inGuest(`document.getElementById('blank').click(); 0`);
    report(await waitFor(`houseTest.state.tabs.filter((t) => t.kind === 'obscura').length === 2`), 'target=_blank link opens a new Obscura tab');
    await page(`(() => { houseTest.closeTab(houseTest.state.active); return true; })()`);
    await page(`(() => { houseTest.activateTab(houseTest.state.tabs.find((t) => t.kind === 'obscura')); return true; })()`);
    // Even loaded straight into the page (bypassing the address bar), nothing from a house file shows.
    for (const bad of ['file:///etc/passwd', 'house-file:///etc/passwd', 'station-editor://app/house/etc/passwd', 'chrome://gpu', 'devtools://devtools/bundled/inspector.html']) {
      await page(`(() => { try { houseTest.state.active.view.loadURL(${JSON.stringify(bad)}).catch(() => {}); } catch {} return true; })()`);
      await sleep(900);
      const text = await inGuest('document.body ? document.body.innerText : ""').catch(() => '');
      const url = await inGuest('location.href').catch(() => '');
      report(!/root:/.test(text) && !/^(file|house-file|station-editor|chrome|devtools):/.test(url), `loadURL(${bad}) shows nothing (url ${url.slice(0, 40)})`);
    }
    await load(`${base}/ok`);
    const fetched = await inGuest(`fetch('file:///etc/passwd').then((r) => 'got ' + r.status, () => 'blocked')`);
    report(fetched === 'blocked', `page fetch of file:/// is ${fetched}`);

    // Redirects.
    await load(`${base}/redir`);
    await sleep(500);
    let url = await inGuest('location.href').catch(() => '');
    report(!/^myapp:/.test(url) && url.startsWith('http'), `redirect to a custom scheme is refused (stays on ${url})`);
    await load(`${base}/redir-file`);
    await sleep(500);
    const text = await inGuest('document.body ? document.body.innerText : ""').catch(() => '');
    url = await inGuest('location.href').catch(() => '');
    report(!/root:/.test(text) && !url.startsWith('file:'), `redirect to file: is refused (url ${url.slice(0, 40)})`);
    await load(`${base}/ok`);

    // Permissions.
    const asked = await inGuest(`(async () => {
      const out = {};
      out.camera = await navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'GRANTED', (e) => e.name);
      out.notify = await Notification.requestPermission();
      out.geo = await new Promise((done) => navigator.geolocation.getCurrentPosition(() => done('GRANTED'), (e) => done('code ' + e.code), { timeout: 4000 }));
      out.clip = await navigator.clipboard.readText().then(() => 'GRANTED', (e) => e.name);
      out.midi = await (navigator.requestMIDIAccess ? navigator.requestMIDIAccess().then(() => 'GRANTED', (e) => e.name) : 'none');
      out.usb = await (navigator.usb ? navigator.usb.requestDevice({ filters: [] }).then(() => 'GRANTED', (e) => e.name) : 'none');
      out.hid = await (navigator.hid ? navigator.hid.requestDevice({ filters: [] }).then((d) => (d.length ? 'GRANTED' : 'empty'), (e) => e.name) : 'none');
      out.serial = await (navigator.serial ? navigator.serial.requestPort().then(() => 'GRANTED', (e) => e.name) : 'none');
      out.screen = await navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => 'GRANTED', (e) => e.name);
      return out;
    })()`);
    report(!JSON.stringify(asked).includes('GRANTED') && asked.notify === 'denied' && asked.geo === 'code 1', `permissions all refused ${JSON.stringify(asked)}`);
    const fullscreen = await inGuest(`document.documentElement.requestFullscreen().then(() => 'allowed', (e) => 'refused ' + e.name)`).catch((e) => `error ${e.message}`);
    console.log(`INFO obscura: fullscreen request without a key press: ${fullscreen}`);

    // A download.
    const downloads = path.join(os.homedir(), 'Downloads');
    for (const n of [1, 2]) {
      await inGuest(`location.href = '${base}/dl'; 0`);
      await waitFor(`/Saved to Downloads/.test(houseTest.state.active.note.textContent) && !houseTest.state.active.note.hidden`, 4000);
      await sleep(600);
    }
    const saved = fs.readdirSync(downloads);
    const noteText = await page(`houseTest.state.active.note.textContent`);
    report(saved.includes('_evil file.txt') && saved.includes('_evil file (1).txt') && !fs.existsSync(path.join(os.homedir(), 'evil file.txt')) && !fs.existsSync(path.join(os.homedir(), '..', 'evil file.txt')), `downloads saved with unique names in ~/Downloads: ${JSON.stringify(saved)}`);
    report(/^Saved to Downloads: _evil file( \(1\))?\.txt$/.test(noteText), `notice in the tab: "${noteText}"`);
    report(BrowserWindow.getAllWindows().length === windowsBefore && (await inGuest('location.href')) === `${base}/ok`, 'download does not navigate or open anything');
    await shot('obscura-download');

    // Reload keys reload the page only.
    await inGuest(`window.__mark = 1; 0`);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control'] });
    await sleep(1200);
    let marked = await inGuest(`window.__mark === undefined ? 'reloaded' : 'not reloaded'`);
    report(marked === 'reloaded' && (await page(`window.__hostMark === 1`)), `Ctrl+R in the page reloads the page and not Station (${marked})`);
    await inGuest(`window.__mark = 1; 0`);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'F5' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'F5' });
    await sleep(1200);
    marked = await inGuest(`window.__mark === undefined ? 'reloaded' : 'not reloaded'`);
    report(marked === 'reloaded' && (await page(`window.__hostMark === 1`)), `F5 reloads the page only (${marked})`);
    await inGuest(`window.__mark = 1; 0`);
    await page(`(() => { const t = houseTest.state.active; t.input.focus(); t.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
    await sleep(1200);
    marked = await inGuest(`window.__mark === undefined ? 'reloaded' : 'not reloaded'`);
    report(marked === 'reloaded' && (await page(`window.__hostMark === 1`)), `Ctrl+R in the address bar reloads the page only (${marked})`);

    // Back / forward / find / zoom.
    await load(`${base}/links`);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Left', modifiers: ['alt'] });
    await sleep(1000);
    report((await inGuest('location.href')) === `${base}/ok`, 'Alt+Left goes back');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right', modifiers: ['alt'] });
    await sleep(1000);
    report((await inGuest('location.href')) === `${base}/links`, 'Alt+Right goes forward');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control'] });
    await sleep(400);
    report(await page(`document.activeElement === houseTest.state.active.input`), 'Ctrl+L focuses the address bar');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['control'] });
    await sleep(400);
    report(await page(`!houseTest.state.active.findBar.hidden`), 'Ctrl+F opens find in page');
    await page(`(() => { const t = houseTest.state.active; t.findInput.value = 'b'; t.findInput.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(600);
    console.log(`INFO obscura: find says "${await page('houseTest.state.active.findCount.textContent')}"`);
    await shot('obscura-find');
    await page(`(() => { const t = houseTest.state.active; t.findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; })()`);
    wc.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['control'] });
    await sleep(400);
    report((await page(`houseTest.state.active.zoom`)) > 1, 'Ctrl+plus zooms the page');
    wc.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['control'] });

    // The internet and rooms' sites.
    await page(`(() => { houseTest.state.active.input.value = ''; return true; })()`);
    // A site that isn't there (a room's site that isn't running), and the internet being out.
    await load('http://localhost:39999/');
    await waitFor(`!houseTest.state.active.message.hidden`, 15000);
    const refused = await page(`houseTest.state.active.message.hidden ? '' : houseTest.state.active.message.textContent`);
    report(/didn't answer/.test(refused), `a site that isn't running shows a plain page: "${refused}"`);
    const offline = await page(`(() => { const t = houseTest.state.active; const e = new Event('did-fail-load'); Object.assign(e, { isMainFrame: true, errorCode: -106, validatedURL: 'https://example.org/', errorDescription: 'ERR_INTERNET_DISCONNECTED' }); t.message.hidden = true; t.view.dispatchEvent(e); return t.message.textContent; })()`);
    const msg = offline;
    report(/The browser can't reach the internet from the house right now./.test(msg), `no internet shows the plain page: "${msg}"`);
    await shot('obscura-no-internet');
    await load('https://example.com/');
    await sleep(1500);
    const pub = await page(`({ title: houseTest.state.active.el.querySelector('.tab-title').textContent, lock: houseTest.state.active.lock.classList.contains('insecure') || houseTest.state.active.lock.hidden, address: houseTest.state.active.input.value })`);
    report(/Example Domain/.test(pub.title) && pub.lock === false, `public https page loads with a lock: ${JSON.stringify(pub)}`);
    await shot('obscura-https');
    await load('about:blank');

    // The webview guard.
    const count = () => guests().length;
    const probe = async (attrs) => {
      const n = count();
      await page(`(() => { const v = document.createElement('webview'); v.id = 'probe'; ${attrs} document.body.append(v); return true; })()`);
      await sleep(1200);
      const out = { attached: count() > n };
      if (out.attached) out.prefs = guests().at(-1).getLastWebPreferences();
      await page(`(() => { document.getElementById('probe')?.remove(); return true; })()`);
      await sleep(300);
      return out;
    };
    let probed = await probe(`v.setAttribute('partition', 'persist:evil'); v.setAttribute('src', '${base}/ok');`);
    report(!probed.attached, 'a webview in any other partition is refused');
    probed = await probe(`v.setAttribute('src', '${base}/ok');`);
    report(!probed.attached, 'a webview with no partition and a web address is refused');
    probed = await probe(`v.setAttribute('partition', 'persist:obscura'); v.setAttribute('src', 'file:///etc/passwd');`);
    report(!probed.attached, 'an Obscura webview on a file: address is refused');
    probed = await probe(`v.setAttribute('partition', 'persist:obscura'); v.setAttribute('src', '${base}/ok'); v.setAttribute('preload', 'file:///etc/hostname'); v.setAttribute('nodeintegration', ''); v.setAttribute('allowpopups', ''); v.setAttribute('webpreferences', 'sandbox=no,contextIsolation=no,webSecurity=no');`);
    const p = probed.prefs || {};
    report(probed.attached && p.nodeIntegration === false && p.sandbox === true && p.contextIsolation === true && p.webSecurity !== false && !p.preload && !p.allowpopups, `an Obscura webview asking for preload, Node, popups is stripped (${JSON.stringify({ n: p.nodeIntegration, s: p.sandbox, c: p.contextIsolation, w: p.webSecurity, pre: p.preload })})`);
    probed = await probe(`v.setAttribute('partition', 'persist:station-editor'); v.setAttribute('src', '${base}/ok');`);
    report(!probed.attached, 'the editor\'s partition will not load a web address');
    probed = await probe(`v.setAttribute('partition', 'persist:station-editor'); v.setAttribute('src', 'station-editor://app/projects/');`);
    console.log(`INFO obscura: the editor's own webview ${probed.attached ? `attaches (preload ${path.basename(String(probed.prefs.preload || 'none'))}, sandbox ${probed.prefs.sandbox})` : 'is refused (editor not built here?)'}`);
    report(!probed.attached || (probed.prefs.sandbox === true && probed.prefs.nodeIntegration === false && probed.prefs.contextIsolation === true), "the editor's guard still works as before");

    // Closing the tab frees its page.
    await page(`(() => { houseTest.openInObscura('${base}/ok'); return true; })()`);
    await waitFor(`houseTest.state.active.loading === false && houseTest.state.active.url`);
    const open = count();
    const description = await page(`JSON.stringify(houseTest.state.tabs.find((t) => t.kind === 'obscura' && t === houseTest.state.active) && { url: houseTest.state.active.url })`);
    await page(`(() => { houseTest.closeTab(houseTest.state.active); return true; })()`);
    await sleep(1500);
    report(count() < open, `closing the tab frees the webview (${open} -> ${count()}) ${description}`);
    await page(`(() => { for (const t of [...houseTest.state.tabs]) if (t.kind === 'obscura') houseTest.closeTab(t); return true; })()`);
  } catch (error) {
    report(false, `scene stopped: ${error.stack || error.message}`);
  } finally {
    srv.close();
  }
  console.log(`${results.every(Boolean) ? 'PASS' : 'FAIL'} obscura: ${results.filter(Boolean).length} of ${results.length} checks passed`);
};
