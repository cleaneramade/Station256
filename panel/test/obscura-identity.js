// Obscura's identity, in the hidden copy (shotrun.sh obscuraIdentity). A local https page (self-signed)
// is opened in a browser tab; the headers the server got and what the page sees must all say Chrome on
// Linux, with dark sites on and off, and again after a reload. Each line is PASS or FAIL.
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, webContents } = require('electron');

module.exports = async function obscuraIdentity({ page, sleep }) {
  const results = [];
  const report = (ok, text) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} obscuraIdentity: ${text}`); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obscura-id-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const seen = [];
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (request, response) => {
    if (request.url.startsWith('/page')) seen.push(request.headers);
    response.writeHead(200, { 'Content-Type': 'text/html', 'Accept-CH': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform', 'Critical-CH': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform' });
    response.end('<title>Identity</title><p>hi</p>');
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
    report(/"Google Chrome";v="\d+"/.test(h['sec-ch-ua'] || '') && (h['sec-ch-ua'] || '').includes(`v="${major}"`) && h['sec-ch-ua-platform'] === '"Linux"', `${label}: sec-ch-ua and platform headers say Google Chrome ${major}, Linux`);
    report((h['sec-ch-ua-full-version-list'] || '').includes(`"Google Chrome";v="${process.versions.chrome}"`), `${label}: full-version-list header has Google Chrome ${process.versions.chrome}`);
    report(js.brands.includes(`Google Chrome ${major}`) && js.full.includes(`Google Chrome ${process.versions.chrome}`) && js.uaPlatform === 'Linux' && js.platform === 'Linux x86_64' && js.mobile === false, `${label}: JS brands, full list, platform agree`);
    report(js.loadTimes === 'function' && js.csi === 'function' && js.app === 'object' && js.runtime === 'object' && js.webdriver !== true, `${label}: window.chrome filled, webdriver not true`);
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
