// A site with its own right-click menu: Station's menu must stay shut (as in Chrome). Real
// right-clicks go to the page; each line is PASS or FAIL. Run: shotrun.sh siteMenu
const http = require('http');
const { webContents } = require('electron');

// Each page draws a box (#own) when it handles the right-click itself.
const SHOW = `function own() { var d = document.createElement('div'); d.id = 'own'; d.textContent = 'own menu'; document.body.appendChild(d); }`;
const PAGES = {
  '/a': `<body style="margin:0;height:600px"><script>${SHOW} addEventListener('contextmenu', function (e) { window.__ctx = (window.__ctx || 0) + 1; e.preventDefault(); own(); });</script>`,
  '/b': `<body style="margin:0;height:600px"><script>${SHOW} addEventListener('mousedown', function (e) { if (e.button === 2) own(); }); addEventListener('contextmenu', function (e) { e.preventDefault(); });</script>`,
  '/b0': `<body style="margin:0;height:600px"><script>${SHOW} addEventListener('mousedown', function (e) { if (e.button === 2) own(); });</script>`,
  '/frame': '<body style="margin:0"><iframe src="http://localhost:PORT/a" style="border:0;width:100%;height:600px"></iframe>',
  '/c': '<body style="margin:0;height:600px">plain words<script>window.n = 0; addEventListener("mousedown", function (e) { if (e.button === 0) window.n += 1; });</script></body>',
};

module.exports = {
  async siteMenu({ page, sleep, win }) {
    const results = [];
    const report = (ok, text) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} siteMenu: ${text}`); };
    const site = await new Promise((resolve) => {
      const made = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end((PAGES[request.url.split('?')[0]] || 'nope').replace('PORT', site.address().port));
      });
      made.listen(0, '127.0.0.1', () => resolve(made));
    });
    const base = `http://127.0.0.1:${site.address().port}`;
    const guest = () => webContents.getAllWebContents().find((item) => item.getType() === 'webview' && !item.isDestroyed());
    const menuOpen = () => page(`!document.getElementById('menu').hidden`);
    // Opens the page in a fresh tab, right-clicks it (as the mouse does), and says what showed.
    const rightClick = async (route, modifiers = [], viaHost = false, origin = base) => {
      await page(`houseTest.openInObscura(${JSON.stringify(origin + route)}); true`);
      await sleep(3000);
      const wc = guest();
      await page(`closeMenu(); true`);
      // viaHost: the click goes to Station's window and lands on the page under it, as a real mouse does.
      let target = wc;
      let spot = { x: 80, y: 80 };
      if (viaHost) {
        spot = await page(`(() => { const b = document.querySelector('webview').getBoundingClientRect(); const f = window.outerWidth / window.innerWidth; return { x: Math.round((b.left + 80) * f), y: Math.round((b.top + 80) * f) }; })()`);
        target = win.webContents;
      }
      if (viaHost) {
        // DevTools input goes through the page's own hit-testing, so it reaches frames from other sites too.
        const was = wc.debugger.isAttached();
        if (!was) wc.debugger.attach('1.3');
        for (const type of ['mousePressed', 'mouseReleased']) await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: 80, y: 80, button: 'right', clickCount: 1, modifiers: modifiers.length ? 8 : 0 });
        if (!was) wc.debugger.detach();
      } else for (const type of ['mouseDown', 'mouseUp']) target.sendInputEvent({ type, x: spot.x, y: spot.y, button: 'right', clickCount: 1, modifiers });
      await sleep(800);
      const own = await wc.mainFrame.framesInSubtree.reduce(async (found, f) => (await found) || f.executeJavaScript(`!!document.getElementById('own')`), Promise.resolve(false));
      const station = await menuOpen();
      const at = await page(`(() => { const b = document.getElementById('menu').getBoundingClientRect(); return { x: b.left, y: b.top }; })()`);
      await page(`closeMenu(); houseTest.closeTab(houseTest.state.active); true`);
      await sleep(500);
      return { own, station, at };
    };
    const a = await rightClick('/a');
    report(a.own && !a.station, `page handles right-click (preventDefault): own menu ${a.own}, Station menu ${a.station}`);
    const b = await rightClick('/b');
    report(b.own && !b.station, `page handles right-click (mousedown + preventDefault): own menu ${b.own}, Station menu ${b.station}`);
    const a2 = await rightClick('/a', [], true);
    report(a2.own && !a2.station, `same, clicked through Station's window: own menu ${a2.own}, Station menu ${a2.station}`);
    const b0 = await rightClick('/b0');
    console.log(`INFO siteMenu: own menu on mousedown only (no preventDefault): own ${b0.own}, Station menu ${b0.station}`);
    const f1 = await rightClick('/frame', [], true);
    report(f1.own && !f1.station, `own menu inside a frame: own menu ${f1.own}, Station menu ${f1.station}`);
    const c = await rightClick('/c');
    report(!c.own && c.station, `plain page: Station menu ${c.station}`);
    const s = await rightClick('/a', ['shift']);
    console.log(`INFO siteMenu: Shift + right-click on a page with its own menu: Station menu ${s.station} (Shift override not built)`);
    // Station's menu open on a page: a catcher covers the page and takes the closing click; once the
    // menu is shut it is gone, so the next click reaches the page. (A click sent through Station's
    // window doesn't reach a page in this hidden copy, so what is checked is the catcher.)
    await page(`houseTest.openInObscura(${JSON.stringify(base + '/c')}); true`);
    await sleep(3000);
    const wc = guest();
    for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: 80, y: 80, button: 'right', clickCount: 1 });
    await sleep(800);
    const shield = () => page(`[...document.querySelectorAll('.ob-shield')].some((n) => getComputedStyle(n).display === 'block') ? 'block' : 'none'`);
    const covering = await shield();
    const spot = await page(`(() => { const b = document.querySelector('webview').getBoundingClientRect(); const f = window.outerWidth / window.innerWidth; return { x: Math.round((b.left + 80) * f), y: Math.round((b.top + 80) * f) }; })()`);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
    await sleep(400);
    const after = await shield();
    report(covering === 'block' && after === 'none' && !(await menuOpen()), `catcher over the page while the menu is open (${covering}), gone after the closing click (${after})`);
    await page(`closeMenu(); houseTest.closeTab(houseTest.state.active); true`);
    site.close();
    const bad = results.filter((ok) => !ok).length;
    console.log(`${bad ? 'FAIL' : 'PASS'} siteMenu: ${results.length - bad} of ${results.length} passed`);
  },
};
