// Tabs side by side, and windows side by side, in the hidden copy:
//   SHOT_PATH=$PWD/panel/test/stub SHOT_HOME=/tmp/house-shots-snap panel/test/shotrun.sh snapLayouts
// A hidden window gets no ResizeObserver, so this checks where things are drawn (boxes), not that a
// terminal refits; and the windows are placed by the page itself, not by Windows.
const http = require('http');
const { BrowserWindow, webContents } = require('electron');

module.exports = {
  async snapLayouts({ page, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} snapLayouts: ${String(text).replace(/\s+/g, ' ').slice(0, 320)}`);
    const site = http.createServer((request, response) => { if (request.url.startsWith('/scheme')) { response.setHeader('Content-Type', 'text/html'); response.end('<title>Scheme</title><p>scheme page</p>'); return; } response.setHeader('Content-Type', 'text/html'); response.end(`<title>Page ${request.url}</title><input id="q" style="width:200px;margin:0;display:block"><p>hello ${request.url}</p>`); });
    await new Promise((resolve) => { site.listen(0, '127.0.0.1', resolve); });
    const base = `http://localhost:${site.address().port}`;
    const waitFor = async (code, ms = 8000) => {
      for (let waited = 0; waited < ms; waited += 200) {
        if (await page(code).catch(() => false)) return true;
        await sleep(200);
      }
      return false;
    };
    // Where a tab's page is drawn, by the name it was kept under in window.__t.
    const box = (name) => page(`(() => { const t = window.__t.${name}; const r = t.host.getBoundingClientRect(); return { hidden: t.host.hidden, l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width) }; })()`);
    const settle = () => sleep(500);
    const sideBySide = (a, b) => !a.hidden && !b.hidden && a.w > 100 && b.w > 100 && Math.abs(a.t - b.t) <= 2 && Math.abs(a.b - b.b) <= 2 && a.r <= b.l + 2;
    const openPage = async (name, path, background = false) => {
      await page(`(() => { window.__t = window.__t || {}; window.__t.${name} = houseTest.openObscura(${JSON.stringify(base + path)}, ${background}); return true; })()`);
      return waitFor(`window.__t.${name}.view.getURL().includes(${JSON.stringify(path)}) && !window.__t.${name}.loading`);
    };
    const popOnly = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !w.houseSpare && w !== win);
    try {
      await page('(async () => { document.getElementById("new-tab").click(); await new Promise((r) => setTimeout(r, 300)); const keep = houseTest.state.active; for (const t of [...houseTest.state.tabs]) if (t !== keep) await houseTest.closeTab(t); return true; })()');
      await page(`houseTest.openTerminal({ cwd: houseTest.state.home }).then((t) => { window.__t = { term: t }; return true; })`);
      await openPage('a', '/a');

      // A terminal next to a browser page: both shown at once, in one row.
      await page('(() => { houseTest.pairTabs(window.__t.term, window.__t.a, "left"); return true; })()');
      await settle();
      let [t, a] = [await box('term'), await box('a')];
      const row = await page(`(() => { const m = document.querySelector('.main'); return { pair: m.classList.contains('pair'), cross: m.classList.contains('pair-x'), strip: houseTest.state.tabs.filter((x) => x.el.style.display !== 'none').length === houseTest.state.tabs.length, active: houseTest.state.active === window.__t.term, side: !document.querySelector('.pair-grip').offsetWidth ? 'no grip' : 'grip', sidebar: document.getElementById('nav').offsetWidth > 0 }; })()`);
      report(sideBySide(t, a) && row.pair && row.cross && row.strip && row.side === 'grip', `terminal on the left, browser on the right, both drawn at once: ${JSON.stringify({ t, a, row })}`);
      report(a.l - t.r <= 3 && t.l <= (await page('document.getElementById("term-area").getBoundingClientRect().left')) + 2 && Math.abs((a.w - t.w)) <= 4, 'they fill the page area between them, half each');

      // The divider: a real drag with the mouse changes both widths; the least a half can be is kept; double-click resets.
      const grip = await page('(() => { const r = document.querySelector(".pair-grip").getBoundingClientRect(); const c = document.getElementById("term-area").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, z: window.house.getZoomFactor(), cell: c.left + c.width + document.getElementById("doc-area").getBoundingClientRect().width }; })()');
      const send = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(x * grip.z), y: Math.round(y * grip.z), button: 'left', clickCount: 1, ...extra });
      send('mouseMove', grip.x, grip.y);
      send('mouseDown', grip.x, grip.y);
      for (let i = 1; i <= 8; i += 1) { send('mouseMove', grip.x - i * 20, grip.y, { modifiers: ['leftButtonDown'] }); await sleep(40); }
      send('mouseUp', grip.x - 160, grip.y);
      await settle();
      const [t2, a2] = [await box('term'), await box('a')];
      report(t2.w < t.w - 100 && a2.w > a.w + 100 && sideBySide(t2, a2), `dragging the divider left makes the terminal narrower (${t.w} to ${t2.w}) and the page wider (${a.w} to ${a2.w})`);
      await page('(() => { window.__t.term.pairAt = window.__t.a.pairAt = 2; document.querySelector(".pair-grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return true; })()');
      await settle();
      const [t3, a3] = [await box('term'), await box('a')];
      report(Math.abs(t3.w - a3.w) <= 4 && sideBySide(t3, a3), `double-clicking the divider puts it back to half and half (${t3.w} and ${a3.w})`);

      // Clicking in a half brings that tab to the front.
      await page('(() => { window.__t.term.host.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return true; })()');
      const firstActive = await page('houseTest.state.active === window.__t.term');
      await page('(() => { window.__t.a.host.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return true; })()');
      const strip = await page('(() => ({ active: houseTest.state.active === window.__t.a, lit: window.__t.a.el.classList.contains("active"), other: window.__t.term.el.classList.contains("paired"), both: !window.__t.term.host.hidden && !window.__t.a.host.hidden }))()');
      report(firstActive && strip.active && strip.lit && strip.other && strip.both, `clicking a half makes it the active tab, and both stay shown: ${JSON.stringify(strip)}`);
      const noRise = await page('(() => { const n = document.getElementById("nav"); return n.offsetWidth > 0; })()');
      report(noRise, 'a terminal beside a page keeps the sidebar (the page does not take the whole window)');

      // Separate: two normal tabs again.
      await page('(() => { houseTest.separateTabs(window.__t.term); return true; })()');
      await settle();
      const sep = await page('(() => { const m = document.querySelector(".main"); return { pair: m.classList.contains("pair"), links: [window.__t.term.splitWith, window.__t.a.splitWith, window.__t.term.side, window.__t.a.side], shown: houseTest.state.tabs.filter((x) => x.host && !x.host.hidden).length, strip: houseTest.state.tabs.length }; })()');
      const tFull = await box('a');
      report(!sep.pair && sep.links.every((x) => !x) && sep.shown === 1 && tFull.w > a3.w * 1.6, `Separate gives two normal tabs again, the front one full width: ${JSON.stringify({ sep, tFull })}`);

      // Closing one half leaves the other as a normal tab.
      await page('(() => { houseTest.pairTabs(window.__t.term, window.__t.a, "right"); return true; })()');
      await settle();
      const flipped = [await box('term'), await box('a')];
      report(sideBySide(flipped[1], flipped[0]), `paired the other way round, the browser is on the left (${JSON.stringify(flipped)})`);
      await page('houseTest.closeTab(window.__t.term).then(() => true)');
      await settle();
      const left = await page('(() => { const m = document.querySelector(".main"); return { pair: m.classList.contains("pair"), link: window.__t.a.splitWith, active: houseTest.state.active === window.__t.a, hidden: window.__t.a.host.hidden, unsplit: window.__t.a.unsplit.hidden }; })()');
      report(!left.pair && !left.link && left.active && !left.hidden && left.unsplit && (await box('a')).w > a3.w * 1.6, `closing the terminal half leaves the browser as a normal full tab: ${JSON.stringify(left)}`);

      // Browser beside browser still works (the old split).
      await openPage('b', '/b');
      await page('(() => { houseTest.pairTabs(window.__t.b, window.__t.a, "left"); return true; })()');
      await settle();
      const [ba, bb] = [await box('b'), await box('a')];
      const bars = await page('(() => !window.__t.a.unsplit.hidden && !window.__t.b.unsplit.hidden)()');
      report(sideBySide(ba, bb) && bars, `two browser pages side by side with their Separate buttons: ${JSON.stringify({ ba, bb })}`);
      await page('(() => { window.__t.a.unsplit.click(); return true; })()');
      report(await page('!window.__t.a.splitWith && !window.__t.b.splitWith'), 'the Separate button in the bar gives two tabs again');

      // An AI's page behind the owner's: it can sit beside a terminal, and its page still answers.
      await page(`houseTest.openTerminal({ cwd: houseTest.state.home }).then((t) => { window.__t.term2 = t; return true; })`);
      await page(`(() => { const t = houseTest.openObscura(${JSON.stringify(`${base}/ai`)}, true); t.aiOf = 'Demo'; t.aiSession = ''; t.host.classList.add('ai-live'); t.host.inert = true; renderTabButtons(); window.__t.ai = t; return true; })()`);
      await waitFor(`window.__t.ai.view.getURL().includes('/ai') && !window.__t.ai.loading`);
      const drawn = await page('(() => { const r = window.__t.ai.host.getBoundingClientRect(); return { hidden: window.__t.ai.host.hidden, w: Math.round(r.width), opacity: getComputedStyle(window.__t.ai.host).opacity }; })()');
      await page('(() => { houseTest.pairTabs(window.__t.ai, window.__t.term2, "right"); return true; })()');
      await settle();
      const [tt, ai] = [await box('term2'), await box('ai')];
      const answers = await page('window.__t.ai.view.executeJavaScript("document.title")');
      report(drawn.hidden && drawn.w > 100 && drawn.opacity === '0' && sideBySide(tt, ai) && !(await page('window.__t.ai.host.inert')) && answers === 'Page /ai', `an AI's background tab pairs with a terminal and its page still answers (was ${JSON.stringify(drawn)}, now ${JSON.stringify({ tt, ai })}, title ${answers})`);
      // The AI clicks and types in its page beside the terminal in front: the terminal stays in front and keeps the keyboard.
      await page('(() => { houseTest.activateTab(window.__t.term2); houseTest.aiAtWork(window.__t.ai, "Claude is using this page", "clicking"); return true; })()');
      await sleep(400);
      const keyIn = () => page('(() => ({ front: houseTest.state.active === window.__t.term2, inTerm: window.__t.term2.host.contains(document.activeElement) }))()');
      const wasKeys = await keyIn();
      const guest = webContents.fromId(await page('window.__t.ai.view.getWebContentsId()'));
      guest.sendInputEvent({ type: 'mouseMove', x: 40, y: 15 });
      guest.sendInputEvent({ type: 'mouseDown', x: 40, y: 15, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', x: 40, y: 15, button: 'left', clickCount: 1 });
      await sleep(300);
      guest.insertText('shoes');
      await sleep(500);
      const typed = await page(`window.__t.ai.view.executeJavaScript("document.activeElement.id + ':' + document.getElementById('q').value")`);
      const keysNow = await keyIn();
      report(wasKeys.front && wasKeys.inTerm && keysNow.front && keysNow.inTerm, `the AI clicking and typing in its half leaves the terminal in front with the keyboard (before ${JSON.stringify(wasKeys)}, after ${JSON.stringify(keysNow)}, the AI's page: ${typed})`);
      await page('(() => { houseTest.separateTabs(window.__t.ai); houseTest.activateTab(window.__t.a); return true; })()');
      await settle();
      const back = await page('(() => { const r = window.__t.ai.host.getBoundingClientRect(); return { hidden: window.__t.ai.host.hidden, w: Math.round(r.width), opacity: getComputedStyle(window.__t.ai.host).opacity, classes: window.__t.ai.host.className }; })()');
      report(back.hidden && back.w > 100 && back.opacity === '0' && !/pair-/.test(back.classes) && await page('window.__t.ai.view.executeJavaScript("1+1")') === 2, `separated and behind the owner's tab again, it is drawn out of sight and still answers: ${JSON.stringify(back)}`);
      await page('houseTest.closeTab(window.__t.ai).then(() => true)');

      // Websites see dark in browser tabs only: off by default, then on for open, new, reloaded and AI pages.
      const seesDark = (name) => page(`window.__t.${name}.view.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches")`);
      const panelDark = () => page(`matchMedia('(prefers-color-scheme: dark)').matches`);
      const dark = (on) => page(`window.house.call('obscuraDark', ${on}).then(() => true)`);
      await openPage('d', '/scheme1');
      const startDark = await panelDark();
      report(await seesDark('d') === false && await page('houseTest.state.tabs.filter((x) => x.kind === "obscura").every((x) => (x.dark.dataset.tip || x.dark.title) === "Websites: Light")'), 'off by default: a page sees light, the button says Websites: Light');
      await dark(true);
      await sleep(500);
      await openPage('e', '/scheme2');
      await page(`houseTest.openObscura(${JSON.stringify(`${base}/ai`)}, true)`).catch(() => {});
      await page(`(() => { const t = houseTest.state.tabs.filter((x) => x.kind === 'obscura').pop(); t.aiOf = 'Demo'; t.aiSession = ''; t.host.classList.add('ai-live'); window.__t.ai2 = t; return true; })()`);
      await waitFor(`window.__t.ai2.view.getURL().includes('/ai') && !window.__t.ai2.loading`);
      page('window.__t.d.view.reload()');
      await waitFor('!window.__t.d.loading');
      await sleep(600);
      const on = [await seesDark('d'), await seesDark('e'), await seesDark('ai2')];
      report(on.every((x) => x === true) && await panelDark() === startDark, `on: an open page, a new tab, a reloaded page and an AI's tab all see dark, Station's own page is unchanged (${JSON.stringify(on)}, panel ${startDark} to ${await panelDark()})`);
      report(await page('houseTest.state.tabs.filter((x) => x.kind === "obscura").every((x) => (x.dark.dataset.tip || x.dark.title) === "Websites: Dark" && x.dark.classList.contains("on"))') && (await page(`window.house.call('prefs')`)).darkSites === true, 'every browser tab button says Websites: Dark, and the setting is saved in the prefs');
      await page(`window.__t.d.view.loadURL(${JSON.stringify(`${base}/scheme3`)})`);
      await waitFor('window.__t.d.view.getURL().includes("/scheme3") && !window.__t.d.loading');
      report(await seesDark('d') === true, 'a page loaded after the flip still sees dark');
      await dark(false);
      await sleep(500);
      const off = [await seesDark('d'), await seesDark('e'), await seesDark('ai2')];
      report(off.every((x) => x === false) && await panelDark() === startDark, `off again: they all see light (${JSON.stringify(off)})`);
      await page('houseTest.closeTab(window.__t.ai2).then(() => true)');
      await page('houseTest.closeTab(window.__t.e).then(() => true)');
      await page('houseTest.closeTab(window.__t.d).then(() => true)');
      await dark(true);

      // The pair survives the page starting again (Ctrl+R, a new version), with its divider place.
      await page('(() => { houseTest.pairTabs(window.__t.term2, window.__t.a, "left", 35); return true; })()');
      await settle();
      await page('(() => { window.__before = true; window.house.call("liveReload", describeAll(), houseTest.state.tabs.indexOf(houseTest.state.active)); return true; })()');
      const again = await waitFor('window.__before === undefined && window.houseTest && houseTest.state.tabs.some((x) => x.splitWith)', 20000);
      await sleep(1500);
      const kept = await page('(() => { const l = houseTest.state.tabs.find((x) => x.kind === "term" && x.splitWith); const r = l ? l.splitWith : null; return { term: Boolean(l), mate: r && r.kind, side: l && l.side, mateSide: r && r.side, at: l && l.pairAt, url: r && r.view && r.view.getURL(), shown: [l, r].every((x) => x && !x.host.hidden) }; })()');
      report(again && kept.term && kept.mate === 'obscura' && kept.side === 'left' && kept.mateSide === 'right' && kept.at === 35 && /\/a$/.test(kept.url) && kept.shown, `the pair, its sides and its divider place come back after the page starts again: ${JSON.stringify(kept)}`);

      report(await page('prefs.darkSites') === true && await page(`houseTest.state.tabs.find((x) => x.kind === 'obscura').view.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches")`) === true, 'the dark setting is kept through the page starting again, and the page there sees it');
      await dark(false);

      // Two windows: Arrange puts them in the left and right halves.
      await page('(() => { const l = houseTest.state.tabs.find((x) => x.splitWith); if (l) houseTest.separateTabs(l); return true; })()');
      await page('document.getElementById("new-tab").click()');
      await sleep(400);
      const watched = new Set();
      const extras = () => popOnly().map((w) => { if (!watched.has(w)) { watched.add(w); w.webContents.beginFrameSubscription(false, () => {}); } return w; });
      const filesTab = await page('houseTest.state.tabs.findIndex((x) => x.kind === "files")');
      await page(`houseTest.popOutTab(houseTest.state.tabs[${filesTab}]).then(() => true)`);
      let second = null;
      for (let waited = 0; waited < 10000 && !second; waited += 250) { second = extras()[0] || null; await sleep(250); }
      const ready = second && await (async () => { for (let i = 0; i < 40; i += 1) { if (await second.webContents.executeJavaScript('Boolean(window.houseTest) && houseTest.state.tabs.length > 0').catch(() => false)) return true; await sleep(250); } return false; })();
      report(Boolean(ready), 'a second window is open');
      if (ready) {
        await sleep(800);
        // The menu offers it only when there is more than one window.
        const menu = await page('(() => { const tab = houseTest.state.tabs[0]; tab.el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 20 })); const labels = [...document.querySelectorAll(".menu-item")].map((b) => b.textContent.trim()); closeMenu(); return labels; })()');
        report(menu.includes('Arrange Windows Side by Side'), `the tab's menu offers Arrange Windows Side by Side with two windows open: ${JSON.stringify(menu)}`);
        const app = (w) => w.webContents.executeJavaScript('(() => { const r = document.querySelector(".app").getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), t: Math.round(r.top), b: Math.round(r.bottom), screen: window.innerWidth }; })()');
        await page('window.house.call("arrangeWindows")');
        let mine; let theirs;
        for (let i = 0; i < 20; i += 1) { await sleep(300); [mine, theirs] = [await app(win), await app(second)]; if (mine.r <= theirs.l + 2 && theirs.w > 100) break; }
        report(mine.l < theirs.l && mine.r <= theirs.l + 2 && Math.abs(mine.w - theirs.w) <= 4 && Math.abs(mine.t - theirs.t) <= 2 && Math.abs(mine.b - theirs.b) <= 2 && Math.abs(mine.w * 2 - mine.screen) <= 8, `the window asked from takes the left half and the other the right half: ${JSON.stringify({ mine, theirs })}`);
        await second.webContents.executeJavaScript('document.querySelector(".tabs .tab .bring-back").click(); true').catch(() => {});
        for (let i = 0; i < 20 && extras().length; i += 1) await sleep(300);
      }
    } catch (error) {
      report(false, `the scene stopped: ${error.stack}`);
    } finally {
      site.close();
    }
  },
};
