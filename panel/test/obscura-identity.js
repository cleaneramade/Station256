// Obscura's identity, in the hidden copy (shotrun.sh obscuraIdentity). A local https page (self-signed)
// is opened in a browser tab; the headers the server got and what the page sees must all say Chrome on
// Linux, with dark sites on and off, and again after a reload. Each line is PASS or FAIL.
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, webContents } = require('electron');

module.exports = async function obscuraIdentity({ page, sleep }) {
  const results = [];
  const report = (ok, text) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} obscuraIdentity: ${text}`); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obscura-id-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const seen = [];
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (request, response) => {
    if (request.url.startsWith('/page')) seen.push(request.headers);
    response.writeHead(200, { 'Content-Type': 'text/html', 'Accept-CH': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform', 'Critical-CH': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform' });
    // /popup stands for a sign-in popup: it tells the page that opened it what it saw, as Google's does.
    if (request.url.startsWith('/popup')) response.end('<title>Sign in</title><script>opener.postMessage({ cookie: document.cookie, node: typeof require + typeof process, ua: navigator.userAgent }, "*");</script>');
    else response.end('<title>Identity</title><p>hi</p>');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = `https://127.0.0.1:${srv.address().port}/page`;
  const trust = (event, _wc, _url, _error, _cert, callback) => { event.preventDefault(); callback(true); };
  app.on('certificate-error', trust);
  const major = process.versions.chrome.split('.')[0];
  const guestOf = async () => webContents.fromId(await page(`(() => { const t = houseTest.state.active; return t.wcId || t.view.getWebContentsId(); })()`));
  const waitFor = async (code, ms = 10000) => {
    for (let waited = 0; waited < ms; waited += 150) { if (await page(code).catch(() => false)) return true; await sleep(150); }
    return false;
  };
  const look = async (label) => {
    const guest = await guestOf();
    await waitFor(`!houseTest.state.active.loading`);
    const js = await guest.executeJavaScript(`(async () => {
      const high = await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platform']);
      return { ua: navigator.userAgent, brands: navigator.userAgentData.brands.map((b) => b.brand + ' ' + b.version), full: high.fullVersionList.map((b) => b.brand + ' ' + b.version), uaPlatform: high.platform,
        platform: navigator.platform, loadTimes: typeof chrome.loadTimes, csi: typeof chrome.csi, app: typeof chrome.app, runtime: typeof chrome.runtime, webdriver: navigator.webdriver, mobile: navigator.userAgentData.mobile };
    })()`, true);
    const h = seen[seen.length - 1] || {};
    const all = JSON.stringify([js, h]);
    console.log(`INFO ${label} ${JSON.stringify({ header: { ua: h['user-agent'], ch: h['sec-ch-ua'], platform: h['sec-ch-ua-platform'], full: h['sec-ch-ua-full-version-list'] }, js })}`);
    report(h['user-agent'] === js.ua && js.ua.includes(`Chrome/${major}.0.0.0`) && js.ua.includes('X11; Linux x86_64'), `${label}: User-Agent header = navigator.userAgent = Chrome ${major} on Linux`);
    // Honest: Chromium on Linux, the same in the headers and in the page, and nothing posing as Google Chrome.
    const headerBrands = [...(h['sec-ch-ua'] || '').matchAll(/"([^"]+)";v="(\d+)"/g)].map((m) => `${m[1]} ${m[2]}`).sort();
    report((h['sec-ch-ua'] || '').includes(`"Chromium";v="${major}"`) && h['sec-ch-ua-platform'] === '"Linux"', `${label}: sec-ch-ua and platform headers say Chromium ${major}, Linux`);
    report(JSON.stringify(headerBrands) === JSON.stringify([...js.brands].sort()), `${label}: header brands = page brands (${headerBrands.join(', ')})`);
    report((h['sec-ch-ua-full-version-list'] || '').includes(`"Chromium";v="${process.versions.chrome}"`), `${label}: full-version-list header has Chromium ${process.versions.chrome}`);
    report(js.brands.includes(`Chromium ${major}`) && js.full.includes(`Chromium ${process.versions.chrome}`) && js.uaPlatform === 'Linux' && js.platform === 'Linux x86_64' && js.mobile === false, `${label}: JS brands, full list, platform agree`);
    report(!/google chrome/i.test(all), `${label}: nothing claims to be Google Chrome`);
    report(js.loadTimes === 'undefined' && js.csi === 'undefined' && js.webdriver !== true, `${label}: no faked window.chrome extras, webdriver not true`);
    report(!/electron/i.test(all), `${label}: no "Electron" anywhere`);
  };
  try {
    await page(`(() => { houseTest.openInObscura('${url}'); return true; })()`);
    await waitFor(`houseTest.state.active.kind === 'obscura' && houseTest.state.active.el.querySelector('.tab-title').textContent === 'Identity'`);
    for (const on of [false, true, false]) {
      await page(`window.house.call('obscuraDark', ${on}).then(() => true)`);
      await sleep(500);
      await page(`(() => { const t = houseTest.state.active; t.input.value = '${url}?n=${Date.now()}'; t.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; })()`);
      await sleep(800);
      await look(`dark ${on ? 'on' : 'off'} (navigated)`);
      const scheme = await (await guestOf()).executeJavaScript(`matchMedia('(prefers-color-scheme: dark)').matches`);
      report(scheme === on, `dark sites ${on ? 'on' : 'off'}: prefers-color-scheme dark is ${scheme}`);
      await (await guestOf()).reload();
      await sleep(800);
      await look(`dark ${on ? 'on' : 'off'} (reloaded)`);
    }
    // Someone lets go of the debugger: it is taken back, and the identity holds.
    const guest = await guestOf();
    guest.debugger.detach();
    await sleep(800);
    report(guest.debugger.isAttached(), 'the debugger is taken back after it is let go');
    guest.reload();
    await sleep(800);
    await look('after detach (reloaded)');

    // A sign-in popup (window.open with a size) is a real popup that can answer the page that opened it,
    // shares its sign-ins (cookies), and is walled in like a tab. A plain window.open is still a tab.
    const opener = await guestOf();
    const windowsBefore = BrowserWindow.getAllWindows().length;
    const tabsBefore = await page(`houseTest.state.tabs.length`);
    const answer = await opener.executeJavaScript(`new Promise((resolve) => {
      document.cookie = 'signedin=yes; Secure; SameSite=None';
      addEventListener('message', (event) => resolve(event.data), { once: true });
      window.open('${url.replace('/page', '/popup')}', 'signin', 'width=500,height=600');
      setTimeout(() => resolve(null), 8000);
    })`, true);
    const popups = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && win.webContents.getURL().includes('/popup'));
    console.log(`INFO popup ${JSON.stringify(answer)} windows ${windowsBefore} -> ${BrowserWindow.getAllWindows().length}`);
    report(answer && popups.length === 1, 'a sign-in popup opens as a real window and answers the page that opened it');
    report(answer && /signedin=yes/.test(answer.cookie), 'the popup shares the browser tab\'s sign-ins (cookies)');
    report(answer && answer.node === 'undefinedundefined' && popups[0]?.webContents.getLastWebPreferences().sandbox === true && popups[0]?.webContents.session === opener.session, 'the popup is walled in like a tab (no Node, sandboxed, same browser session)');
    report(answer && answer.ua === (await opener.executeJavaScript('navigator.userAgent')), 'the popup has the same identity');
    popups.forEach((win) => win.close());
    await opener.executeJavaScript(`window.open('${url}?tab=1'); true`, true);
    await sleep(1200);
    report((await page(`houseTest.state.tabs.length`)) === tabsBefore + 1, 'a plain window.open still opens a browser tab');
    await page(`(() => { for (const t of [...houseTest.state.tabs]) if (t.kind === 'obscura') houseTest.closeTab(t); return true; })()`);
  } catch (error) {
    report(false, `scene stopped: ${error.stack || error.message}`);
  } finally {
    app.removeListener('certificate-error', trust);
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`${results.every(Boolean) ? 'PASS' : 'FAIL'} obscuraIdentity: ${results.filter(Boolean).length} of ${results.length} checks passed`);
};
