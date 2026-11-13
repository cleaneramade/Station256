// Dragging a tab onto the page to put two things side by side, with real mouse input, in the hidden copy:
//   SHOT_PATH=$PWD/panel/test/stub SHOT_HOME=/tmp/house-shots-tabsplit panel/test/shotrun.sh tabSplit
// The pointer is the real one (sendInputEvent into the page), except across windows, where main.js
// reads the screen's cursor, so that is stood in for (as in the windows scene).
const http = require('http');
const { BrowserWindow, screen } = require('electron');

module.exports = {
  async tabSplit({ page, shot, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} tabSplit: ${String(text).replace(/\s+/g, ' ').slice(0, 360)}`);
    const site = http.createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(`<title>Page ${request.url}</title><p>hello ${request.url}</p>`); });
    await new Promise((resolve) => { site.listen(0, '127.0.0.1', resolve); });
    const base = `http://localhost:${site.address().port}`;
    const waitFor = async (code, ms = 8000) => {
      for (let waited = 0; waited < ms; waited += 200) {
        if (await page(code).catch(() => false)) return true;
        await sleep(200);
      }
      return false;
    };
    const zoom = await page('window.house.getZoomFactor()');
    const send = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(x * zoom), y: Math.round(y * zoom), button: 'left', clickCount: 1, ...extra });
    // Presses on a tab, pulls it off the strip, and moves over the page at (fx, fy) (fractions of the
    // page area). Says what showed while it was held. Lets go only if `release` is true.
    const carry = async (name, fx, fy, { release = true, toSidebar = false } = {}) => {
      const from = await page(`(() => { const r = window.__t.${name}.el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      const cell = await page('(() => { const r = document.querySelector(".snap-zones").getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()');
      const to = toSidebar ? { x: 40, y: cell.t + cell.h / 2 } : { x: cell.l + cell.w * fx, y: cell.t + cell.h * fy };
      send('mouseMove', from.x, from.y);
      await sleep(300); // the first input into a page that was never touched is lost without this
      send('mouseDown', from.x, from.y);
      const fronts = [];
      for (let i = 1; i <= 12; i += 1) {
        send('mouseMove', from.x + (to.x - from.x) * (i / 12), from.y + (to.y - from.y) * (i / 12), { modifiers: ['leftButtonDown'] });
        await sleep(60);
        if (i > 6) fronts.push(await page('houseTest.state.tabs.indexOf(houseTest.state.active)'));
      }
      await sleep(300);
      const seen = await page(`(() => { const z = document.querySelector('.snap-zones'); const on = [...z.children].map((c) => c.classList.contains('on')); return { lifted: Boolean(document.querySelector('.tab-lifted')), zones: z.classList.contains('off') ? 'off' : on[0] ? 'left' : on[1] ? 'right' : 'none', fill: getComputedStyle(z.querySelector('.on') || z.firstChild).backgroundColor, dashed: getComputedStyle(z.firstChild).borderStyle, ghost: !document.querySelector('.tab-ghost').hidden, chip: document.querySelector('.tab-ghost').classList.contains('chip') }; })()`);
      fronts.push(await page('houseTest.state.tabs.indexOf(houseTest.state.active)'));
      if (release) {
        send('mouseUp', to.x, to.y);
        await sleep(700);
      }
      return { ...seen, fronts: [...new Set(fronts)] };
    };
    const where = (name) => page(`(() => { const t = window.__t.${name}; const p = t.kind === 'files' ? document.getElementById('files-view') : t.host; const r = p.getBoundingClientRect(); return { hidden: p.hidden, l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; })()`);
    const pairOf = (name, mate) => page(`(() => { const t = window.__t.${name}; return t.splitWith === window.__t.${mate} && window.__t.${mate}.splitWith === t ? t.side + '/' + window.__t.${mate}.side : 'no'; })()`);
    const reset = async (keep) => {
      await page(`(async () => { for (const t of [...houseTest.state.tabs]) if (t !== window.__t.${keep}) await houseTest.closeTab(t); houseTest.activateTab(window.__t.${keep}); return true; })()`);
      await sleep(500);
    };
    const front = (name) => page(`houseTest.state.tabs.indexOf(window.__t.${name})`);
    const watched = new Set();
    const others = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !w.houseSpare && w !== win).map((w) => { if (!watched.has(w)) { watched.add(w); w.webContents.beginFrameSubscription(false, () => {}); } return w; });
    const realPoint = screen.getCursorScreenPoint;
    try {
      await page('(async () => { document.getElementById("new-tab").click(); await new Promise((r) => setTimeout(r, 300)); const keep = houseTest.state.active; for (const t of [...houseTest.state.tabs]) if (t !== keep) await houseTest.closeTab(t); window.__t = { home: keep }; return true; })()');

      // (a) A terminal onto the Home tab in front.
      await page('houseTest.openTerminal({ cwd: houseTest.state.home }).then((t) => { window.__t.term = t; return true; })');
      await sleep(800);
      await page('houseTest.activateTab(window.__t.home); true');
      await sleep(400);
      let drag = await carry('term', 0.75, 0.5, { release: false });
      report(drag.lifted && drag.zones === 'right' && drag.fronts.length === 1 && drag.fronts[0] === await front('home'), `held over the right half: the right half lights up, and Home stays the tab in front the whole way: ${JSON.stringify(drag)}`);
      report(drag.chip && drag.dashed === 'none' && /rgba\(0, 120, 212/.test(drag.fill), `the half is a filled blue shape, no dashed outline, and what is carried is just a tab (chip): ${drag.fill} ${drag.dashed}`);
      await shot('tabsplit-zone-right');
      send('mouseMove', 200, 100, { modifiers: ['leftButtonDown'] });
      await sleep(250);
      const away = await page('document.querySelector(".snap-zones").classList.contains("off")');
      report(away, 'moved off the page (the sidebar), no half is lit');
      const cell = await page('(() => { const r = document.querySelector(".snap-zones").getBoundingClientRect(); return { x: r.left + r.width * 0.25, y: r.top + r.height / 2 }; })()');
      send('mouseMove', cell.x, cell.y, { modifiers: ['leftButtonDown'] });
      await sleep(300);
      report(await page('document.querySelector(".snap-zone.on") === document.querySelector(".snap-zone.left")'), 'over the left half, the left half lights up');
      send('mouseUp', cell.x, cell.y);
      await sleep(800);
      report(await pairOf('term', 'home') === 'left/right', `let go on the left: the terminal is paired with Home, on the left: ${await pairOf('term', 'home')}`);
      const [t1, h1] = [await where('term'), await where('home')];
      report(!t1.hidden && !h1.hidden && t1.r <= h1.l + 2 && t1.w > 100 && h1.w > 100, `the terminal and the Home page are side by side: ${JSON.stringify({ t1, h1 })}`);
      await shot('tabsplit-term-home');
      // Clicking the Home half brings its tab to the front and the page still works.
      await page('(() => { document.getElementById("files-view").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return true; })()');
      report(await page('houseTest.state.active === window.__t.home && !document.getElementById("term-area").hidden && !document.getElementById("files-view").hidden'), 'clicking the Home half makes Home the tab in front, both still shown');
      await page('(() => { houseTest.separateTabs(window.__t.home); return true; })()');
      await sleep(400);
      report(await page('!document.querySelector(".main").classList.contains("pair") && document.getElementById("term-area").hidden'), 'Separate gives two normal tabs again');
      await reset('home');

      // (b) A terminal onto a terminal in front.
      await page('houseTest.openTerminal({ cwd: houseTest.state.home }).then((t) => { window.__t.t1 = t; return true; })');
      await page('houseTest.openTerminal({ cwd: houseTest.state.home }).then((t) => { window.__t.t2 = t; return true; })');
      await sleep(800);
      await page('houseTest.activateTab(window.__t.t2); true');
      await sleep(400);
      drag = await carry('t1', 0.25, 0.5);
      report(drag.zones === 'left' && drag.fronts.length === 1 && await pairOf('t1', 't2') === 'left/right', `terminal onto terminal: paired on the left, the front tab never changed (${JSON.stringify(drag.fronts)}): ${await pairOf('t1', 't2')}`);
      const [a2, b2] = [await where('t1'), await where('t2')];
      report(!a2.hidden && !b2.hidden && a2.r <= b2.l + 2 && Math.abs(a2.w - b2.w) <= 4, `two terminals share the page, half each: ${JSON.stringify({ a2, b2 })}`);
      await shot('tabsplit-term-term');
      await reset('home');

      // (c) A terminal onto a browser in front, dropped on the right.
      await page(`(() => { window.__t.br = houseTest.openObscura(${JSON.stringify(`${base}/a`)}, false); return true; })()`);
      await waitFor('window.__t.br.view.getURL().includes("/a") && !window.__t.br.loading');
      await page('houseTest.openTerminal({ cwd: houseTest.state.home }).then((t) => { window.__t.t3 = t; return true; })');
      await sleep(800);
      await page('houseTest.activateTab(window.__t.br); true');
      await sleep(400);
      drag = await carry('t3', 0.75, 0.5);
      report(drag.zones === 'right' && drag.fronts.length === 1 && await pairOf('t3', 'br') === 'right/left', `terminal onto browser: paired on the right: ${await pairOf('t3', 'br')} ${JSON.stringify(drag.fronts)}`);
      const [a3, b3] = [await where('br'), await where('t3')];
      report(!a3.hidden && !b3.hidden && a3.r <= b3.l + 2 && a3.w > 100 && b3.w > 100, `the browser and the terminal side by side: ${JSON.stringify({ a3, b3 })}`);
      await shot('tabsplit-term-browser');
      await reset('home');

      // Files onto Files: a half lights up too.
      await page('document.getElementById("new-tab").click(); true');
      await sleep(500);
      await page('(() => { window.__t.home2 = houseTest.state.active; houseTest.activateTab(window.__t.home); return true; })()');
      drag = await carry('home2', 0.75, 0.5, { release: false });
      report(drag.lifted && drag.zones === 'right', `Files onto Files lights the half too (two Files tabs can sit side by side): ${JSON.stringify(drag)}`);
      // Out past the window's edge, the carried tab becomes the window-shaped card (with a faint icon or the page's picture).
      send('mouseMove', 1500, 300, { modifiers: ['leftButtonDown'] });
      await sleep(500);
      const card = await page('(() => { const g = document.querySelector(".tab-ghost"); const r = g.getBoundingClientRect(); return { chip: g.classList.contains("chip"), w: Math.round(r.width), h: Math.round(r.height), mark: !g.querySelector(".tab-ghost-mark").hidden, picture: g.querySelector(".tab-ghost-body").style.backgroundImage.length > 20 }; })()');
      report(!card.chip && card.w > 300 && card.h > 200, `outside every window it is the window-shaped card: ${JSON.stringify(card)}`);
      await shot('tabsplit-outside-card');
      send('mouseUp', 1500, 300);
      await sleep(1500);
      // That drop made a window of its own; close it again.
      for (const w of others()) await w.webContents.executeJavaScript('window.close()').catch(() => {});
      await sleep(800);
      await page(`(async () => { for (const t of [...houseTest.state.tabs]) if (t !== window.__t.home) await houseTest.closeTab(t); return true; })()`);

      // Across windows: a terminal dropped on the right half of another window's page.
      await page('document.getElementById("new-tab").click(); true');
      await sleep(500);
      await page('(() => { window.__t.far = houseTest.state.active; return true; })()');
      await page('houseTest.popOutTab(window.__t.far).then(() => true)');
      let second = null;
      for (let waited = 0; waited < 10000 && !second; waited += 250) { second = others()[0] || null; await sleep(250); }
      const ready = second && await (async () => { for (let i = 0; i < 40; i += 1) { if (await second.webContents.executeJavaScript('Boolean(window.houseTest) && houseTest.state.tabs.length > 0').catch(() => false)) return true; await sleep(250); } return false; })();
      report(Boolean(ready), 'a second window is open');
      if (ready) {
        await sleep(800);
        await page('houseTest.openTerminal({ cwd: houseTest.state.home }).then((t) => { window.__t.mover = t; return true; })');
        await sleep(800);
        await page('houseTest.activateTab(window.__t.home); true');
        // The window is drawn inside a screen-sized frame, so find its page on screen from the page itself.
        const bounds = second.getBounds();
        const spot = await second.webContents.executeJavaScript(`(() => { const r = document.querySelector(".snap-zones").getBoundingClientRect(); const z = window.house.getZoomFactor(); return { x: (r.left + r.width * 0.8) * z, y: (r.top + r.height * 0.5) * z }; })()`);
        const pointer = { x: bounds.x + Math.round(spot.x), y: bounds.y + Math.round(spot.y) };
        screen.getCursorScreenPoint = () => pointer;
        // Held in this window over its sidebar (so no half here), with the cursor over the other window's page.
        drag = await carry('mover', 0, 0, { release: false, toSidebar: true });
        await sleep(600);
        const lit = await second.webContents.executeJavaScript('(() => { const z = document.querySelector(".snap-zones"); return z.classList.contains("off") ? "off" : z.lastChild.classList.contains("on") ? "right" : "left"; })()');
        report(lit === 'right', `held over the other window's page, its right half lights up: ${lit}`);
        await shot('tabsplit-cross-window');
        send('mouseUp', 40, 300);
        let paired = false;
        for (let i = 0; i < 20 && !paired; i += 1) {
          await sleep(300);
          paired = await second.webContents.executeJavaScript('(() => { const t = houseTest.state.tabs.find((x) => x.kind === "term"); return Boolean(t && t.splitWith && t.splitWith.kind === "files" && t.side === "right"); })()').catch(() => false);
        }
        report(paired, 'let go there: the terminal arrives in the other window as the right half, beside the tab that was in front');
        report(await second.webContents.executeJavaScript('document.querySelector(".snap-zones").classList.contains("off")'), 'and the half is no longer lit');
        report(await page('!houseTest.state.tabs.some((x) => x === window.__t.mover)'), 'the terminal is gone from the first window');
        for (const w of others()) await w.webContents.executeJavaScript("window.close()").catch(() => {});
      }
      // Twenty tabs at 135%: nothing half-clipped, the open tab keeps its icon and X, + stays in view.
      screen.getCursorScreenPoint = realPoint;
      await sleep(800);
      await page(`(async () => { for (const t of [...houseTest.state.tabs]) if (t !== window.__t.home) await houseTest.closeTab(t); window.house.setZoomFactor(1.35); return true; })()`);
      await page('houseTest.openTerminal({ cwd: houseTest.state.home }).then((t) => { window.__t.term = t; t.el.querySelector(".tab-title").textContent = "SampleApp (2)"; return true; })');
      for (let i = 0; i < 18; i += 1) await page('document.getElementById("new-tab").click(); true');
      await sleep(900);
      const clipped = () => page(`(() => {
        const tabs = document.getElementById('tabs');
        const room = tabs.getBoundingClientRect();
        const inside = (node, box) => { const b = node.getBoundingClientRect(); return b.left >= box.left - 0.5 && b.right <= box.right + 0.5; };
        const bad = [];
        const states = [];
        for (const tab of tabs.querySelectorAll('.tab')) {
          const box = tab.getBoundingClientRect();
          for (const part of tab.querySelectorAll('i, img, .tab-btn, .tab-ai-dot')) {
            if (part.offsetParent === null || getComputedStyle(part).visibility === 'hidden') continue;
            if (!inside(part, box)) bad.push(tab.className + ':' + part.className);
          }
          if (tab.classList.contains('active')) {
            const close = tab.querySelector('.close-tab');
            const icon = tab.querySelector('i[data-i]:not(.tab-btn i), img');
            states.push({ close: close.offsetParent !== null && inside(close, box), icon: [...tab.querySelectorAll('.tab-term-icon, .tab-folder')].some((p) => p.offsetParent !== null && inside(p, box)), width: Math.round(box.width) });
          }
        }
        const plus = document.getElementById('new-tab').getBoundingClientRect();
        const hit = document.elementFromPoint((plus.left + plus.right) / 2, (plus.top + plus.bottom) / 2);
        return { fade: tabs.className.replace('tabs', '').trim(), bad, active: states, plus: plus.right <= room.right + 0.5 && plus.left >= room.left && Boolean(hit?.closest('#new-tab')), tabs: tabs.querySelectorAll('.tab').length, narrowest: Math.round(Math.min(...[...tabs.querySelectorAll('.tab:not(.active)')].map((t) => t.getBoundingClientRect().width))) };
      })()`);
      let strip = await clipped();
      report(strip.tabs === 20 && strip.fade === '' && strip.bad.length === 0 && strip.active.length === 1 && strip.active[0].close && strip.active[0].icon && strip.plus, `20 tabs at 135% fit with no scrolling or fade: nothing is clipped, the open tab has its icon and X, + is in view: ${JSON.stringify(strip)}`);
      await shot('tabsplit-20-tabs-last');
      await page('houseTest.activateTab(houseTest.state.tabs[0]); true');
      await sleep(500);
      strip = await clipped();
      report(strip.bad.length === 0 && strip.active[0]?.close && strip.active[0]?.icon && strip.plus, `the first one open: the same holds: ${JSON.stringify(strip)}`);
      await shot('tabsplit-20-tabs-first');
      await page('houseTest.activateTab(houseTest.state.tabs[10]); window.house.setZoomFactor(1); true');
      await sleep(500);
      strip = await clipped();
      report(strip.bad.length === 0 && strip.active[0]?.close && strip.plus, `a middle one open at 100%: ${JSON.stringify(strip)}`);
      await shot('tabsplit-20-tabs-100');
      // Far too many (40, at 135%): the strip scrolls, the open tab stays in view, + stays pinned.
      await page('window.house.setZoomFactor(1.35); true');
      for (let i = 0; i < 20; i += 1) await page('document.getElementById("new-tab").click(); true');
      await sleep(900);
      strip = await clipped();
      report(strip.tabs === 40 && /fade/.test(strip.fade) && strip.bad.length === 0 && strip.active[0]?.close && strip.active[0]?.icon && strip.plus, `40 tabs at 135%: the open tab keeps its icon and X and + is in view: ${JSON.stringify(strip)}`);
      await shot('tabsplit-40-tabs');
      await page('window.house.setZoomFactor(1); true');
    } catch (error) {
      report(false, `the scene stopped: ${error.stack}`);
    } finally {
      screen.getCursorScreenPoint = realPoint;
      site.close();
    }
  },
};
