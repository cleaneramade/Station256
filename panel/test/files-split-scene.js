// Two Files tabs side by side, with real mouse and keys, in the hidden copy:
//   SHOT_PATH=$PWD/panel/test/stub SHOT_HOME=/tmp/house-shots-files2 panel/test/shotrun.sh filesSplit
// The toolbar, address bar, search box and keys act on the half last clicked, and files dragged
// from one half onto the other move there.
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

module.exports = {
  async filesSplit({ page, shot, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} filesSplit: ${String(text).replace(/\s+/g, ' ').slice(0, 360)}`);
    const zoom = await page('window.house.getZoomFactor()');
    const send = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(x * zoom), y: Math.round(y * zoom), button: 'left', clickCount: 1, ...extra });
    const press = (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    const rectOf = (expr) => page(`(() => { const n = ${expr}; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width }; })()`);
    const rowRect = (tab, name) => rectOf(`[...window.__t.${tab}.view.rows.querySelectorAll('.row .name-text')].find((n) => n.textContent === ${JSON.stringify(name)})`);
    const emptyRect = async (tab) => { const r = await rectOf(`window.__t.${tab}.view.rows`); return { x: (r.l + r.r) / 2, y: r.t + (r.b - r.t) * 0.55 }; }; // y clear of the toast along the bottom
    const click = async (point, modifiers = []) => {
      send('mouseMove', point.x, point.y);
      await sleep(120);
      send('mouseDown', point.x, point.y, { modifiers });
      send('mouseUp', point.x, point.y, { modifiers });
      await sleep(350);
    };
    const drag = async (from, to) => {
      send('mouseMove', from.x, from.y);
      await sleep(150);
      send('mouseDown', from.x, from.y);
      for (let i = 1; i <= 14; i += 1) {
        send('mouseMove', from.x + (to.x - from.x) * (i / 14), from.y + (to.y - from.y) * (i / 14), { modifiers: ['leftButtonDown'] });
        await sleep(50);
      }
      await sleep(250);
      send('mouseUp', to.x, to.y);
      await sleep(900);
    };
    const names = (tab) => page(`[...window.__t.${tab}.view.rows.querySelectorAll('.row .name-text')].map((n) => n.textContent)`);
    const picked = (tab) => page(`[...window.__t.${tab}.view.rows.querySelectorAll('.row.selected .name-text')].map((n) => n.textContent)`);
    const front = () => page(`window.__t.L === houseTest.state.active ? 'L' : window.__t.R === houseTest.state.active ? 'R' : 'other'`);
    const waitFor = async (code, ms = 8000) => {
      for (let waited = 0; waited < ms; waited += 200) {
        if (await page(code).catch(() => false)) return true;
        await sleep(200);
      }
      return false;
    };

    // The clipboard stays inside this check: Cut must not reach the owner's Windows clipboard.
    const sharedClipboard = require('../lib/clipboard');
    const realCopyFiles = sharedClipboard.copyFiles;
    sharedClipboard.copyFiles = async () => ({ ok: true });
    const home = await page('houseTest.state.home');
    const left = path.join(home, 'splitL');
    const right = path.join(home, 'splitR');
    try {
      fs.rmSync(left, { recursive: true, force: true });
      fs.rmSync(right, { recursive: true, force: true });
      for (const [dir, files] of [[left, ['a.txt', 'b.txt', 'c.txt', 'd.txt']], [right, ['x.txt', 'y.txt']]]) {
        fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
        for (const name of files) fs.writeFileSync(path.join(dir, name), name);
      }
      win.webContents.focus();
      await page('(async () => { document.getElementById("new-tab").click(); await new Promise((r) => setTimeout(r, 300)); const keep = houseTest.state.active; for (const t of [...houseTest.state.tabs]) if (t !== keep) await houseTest.closeTab(t); window.__t = { L: keep }; return true; })()');
      await page(`(() => { houseTest.navigate(${JSON.stringify(left)}); return true; })()`);
      await sleep(600);
      await page('document.getElementById("new-tab").click(); true');
      await sleep(500);
      await page(`(() => { window.__t.R = houseTest.state.active; houseTest.navigate(${JSON.stringify(right)}); return true; })()`);
      await sleep(600);
      // A little history in each, so Back has somewhere to go.
      for (const [name, dir] of [['R', right], ['L', left]]) {
        await page(`(() => { houseTest.activateTab(window.__t.${name}); houseTest.navigate(${JSON.stringify(path.join(dir, 'sub'))}); return true; })()`);
        await sleep(500);
        await page(`(() => { houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
        await sleep(500);
      }

      // (a) Files onto Files, by dragging the tab onto the right half.
      const from = await rectOf('window.__t.R.el');
      const cell = await page('(() => { const r = document.querySelector(".snap-zones").getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()');
      send('mouseMove', from.x, from.y);
      await sleep(300);
      send('mouseDown', from.x, from.y);
      const to = { x: cell.l + cell.w * 0.75, y: cell.t + cell.h * 0.5 };
      for (let i = 1; i <= 12; i += 1) {
        send('mouseMove', from.x + (to.x - from.x) * (i / 12), from.y + (to.y - from.y) * (i / 12), { modifiers: ['leftButtonDown'] });
        await sleep(60);
      }
      await sleep(300);
      const zone = await page('document.querySelector(".snap-zone.on") === document.querySelector(".snap-zone.right")');
      send('mouseUp', to.x, to.y);
      await sleep(900);
      report(zone, 'held over the right half, a Files tab lights it up');
      const paired = await page('(() => { const { L, R } = window.__t; return L.splitWith === R && R.splitWith === L ? L.side + "/" + R.side : "no"; })()');
      report(paired === 'left/right', `Files + Files formed by dragging: ${paired}`);
      await sleep(600);
      const boxes = await page('(() => { const { L, R } = window.__t; const a = L.view.root.getBoundingClientRect(); const b = R.view.root.getBoundingClientRect(); return { same: L.view === R.view, aHidden: L.view.root.hidden, bHidden: R.view.root.hidden, a: [Math.round(a.left), Math.round(a.right)], b: [Math.round(b.left), Math.round(b.right)], x: document.querySelector(".main").classList.contains("pair-x") }; })()');
      report(!boxes.same && !boxes.aHidden && !boxes.bHidden && boxes.x && boxes.a[1] <= boxes.b[0] + 2 && boxes.b[0] - boxes.a[0] > 100 && boxes.a[1] - boxes.a[0] > 100, `both halves show side by side, each with its own section: ${JSON.stringify(boxes)}`);
      // The tab dragged on sits on the right: R is that one.
      const [nl, nr] = [await names('L'), await names('R')];
      report(nl.join() === 'sub,a.txt,b.txt,c.txt,d.txt' && nr.join() === 'sub,x.txt,y.txt', `each half lists its own folder: ${nl} | ${nr}`);
      await shot('filessplit-pair');

      // (b) A selection in each half. The last click decides which half the controls act on.
      await click(await rowRect('L', 'a.txt'));
      await click(await rowRect('L', 'b.txt'), ['control']);
      await click(await rowRect('R', 'y.txt'));
      report(await front() === 'R', `clicking in the right half makes it the front tab: ${await front()}`);
      const [pl, pr] = [await picked('L'), await picked('R')];
      report(pl.join() === 'a.txt,b.txt' && pr.join() === 'y.txt', `both halves keep their own picks: ${pl} | ${pr}`);
      const look = await page(`(() => { const { L, R } = window.__t; const bg = (tab) => getComputedStyle(tab.view.rows.querySelector('.row.selected'), '::before').backgroundColor; return { on: R.view.root.classList.contains('half-on'), off: L.view.root.classList.contains('half-off'), front: bg(R), back: bg(L), count: document.getElementById('item-count').textContent.trim() }; })()`);
      report(look.on && look.off && look.front !== look.back && /^3 items\s+1 item selected/.test(look.count), `the front half is marked, the other half's picks are dimmed, the count is the front half's: ${JSON.stringify(look)}`);
      // Back, Up and the address bar are the front half's.
      const paths0 = await page('[window.__t.L.path, window.__t.R.path, window.__t.R.back.length]');
      await click(await rectOf('document.getElementById("back")'));
      await sleep(500);
      const paths1 = await page('[window.__t.L.path, window.__t.R.path]');
      report(paths1[0] === paths0[0] && paths1[1] !== paths0[1], `Back moved only the right half: ${JSON.stringify([paths0, paths1])}`);
      await click(await rectOf('document.getElementById("forward")'));
      await sleep(500);
      report((await page('window.__t.R.path')) === right && (await page('window.__t.L.path')) === left, 'Forward put it back; the left half never moved');
      await click(await rectOf('document.getElementById("up")'));
      await sleep(500);
      report((await page('window.__t.R.path')) === home && (await page('window.__t.L.path')) === left, 'Up moved only the right half');
      await click(await rectOf('document.getElementById("back")'));
      await sleep(500);
      // The address bar: a folder in it opens in the front half only.
      await click(await rectOf('[...document.querySelectorAll("#address .crumb[data-path]")].slice(-2)[0]'));
      await sleep(500);
      report((await page('window.__t.R.path')) === home && (await page('window.__t.L.path')) === left, 'a folder in the address bar opened in the right half only');
      await page(`(() => { houseTest.activateTab(window.__t.R); houseTest.navigate(${JSON.stringify(right)}); return true; })()`);
      await sleep(600);
      await click(await rowRect('R', 'y.txt'));
      // The search box.
      await click(await rectOf('document.getElementById("search")'));
      await win.webContents.insertText('x.');
      await sleep(400);
      const filtered = [(await names('R')).join(), (await names('L')).join()];
      report(filtered[0] === 'x.txt' && filtered[1] === 'sub,a.txt,b.txt,c.txt,d.txt', `the search box filtered only the front half: ${filtered}`);
      await page('(() => { const box = document.getElementById("search"); box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
      await sleep(300);
      // Keys: F2 renames in the right half only; Delete takes y.txt, not the left half's picks.
      await click(await rowRect('R', 'y.txt'));
      press('F2');
      await sleep(400);
      const renaming = await page('[window.__t.R.view.root.querySelectorAll(".rename-input").length, window.__t.L.view.root.querySelectorAll(".rename-input").length]');
      report(renaming[0] === 1 && renaming[1] === 0, `F2 renamed in the front half only: ${renaming}`);
      press('Escape');
      await sleep(300);
      await click(await rowRect('R', 'y.txt'));
      press('Delete');
      await sleep(1000);
      report(!fs.existsSync(path.join(right, 'y.txt')) && fs.existsSync(path.join(left, 'a.txt')) && fs.existsSync(path.join(left, 'b.txt')), 'Delete took the right half\'s pick; a.txt and b.txt are still there');
      // Cut in the left half (its own pick), then Paste into the right: the clipboard follows the front half.
      await click(await rowRect('L', 'c.txt'));
      press('X', ['control']);
      await sleep(300);
      await click(await emptyRect('R'));
      report(await front() === 'R', 'clicking the right half\'s empty space made it the front tab');
      press('V', ['control']);
      await sleep(1000);
      report(fs.existsSync(path.join(right, 'c.txt')) && !fs.existsSync(path.join(left, 'c.txt')), 'Cut in the left half and Paste in the right moved c.txt there');
      report((await names('L')).join() === 'sub,a.txt,b.txt,d.txt' && (await names('R')).includes('c.txt'), `both halves redrew: ${await names('L')} | ${await names('R')}`);

      // (c) Dragging from one half to the other.
      await click(await rowRect('L', 'a.txt'));
      await drag(await rowRect('L', 'a.txt'), await emptyRect('R'));
      report(!fs.existsSync(path.join(left, 'a.txt')) && fs.readFileSync(path.join(right, 'a.txt'), 'utf8') === 'a.txt', 'dragging a.txt from the left half onto the right half\'s empty space moved it into the right folder');
      report(!(await names('L')).includes('a.txt') && (await names('R')).includes('a.txt'), `and both lists show it: ${await names('L')} | ${await names('R')}`);
      await click(await rowRect('L', 'b.txt'));
      await drag(await rowRect('L', 'b.txt'), await rowRect('R', 'sub'));
      report(!fs.existsSync(path.join(left, 'b.txt')) && fs.existsSync(path.join(right, 'sub', 'b.txt')), 'dragging b.txt onto the right half\'s folder moved it inside that folder');
      await click(await rowRect('R', 'x.txt'));
      await drag(await rowRect('R', 'x.txt'), await emptyRect('L'));
      report(!fs.existsSync(path.join(right, 'x.txt')) && fs.existsSync(path.join(left, 'x.txt')), 'and the other way, right to left, works too');
      await click(await rowRect('L', 'd.txt'));
      send('mouseMove', (await rowRect('L', 'd.txt')).x, (await rowRect('L', 'd.txt')).y);
      await sleep(100);
      const dEnd = await emptyRect('R');
      const dFrom = await rowRect('L', 'd.txt');
      send('mouseDown', dFrom.x, dFrom.y);
      for (let i = 1; i <= 14; i += 1) {
        send('mouseMove', dFrom.x + (dEnd.x - dFrom.x) * (i / 14), dFrom.y + (dEnd.y - dFrom.y) * (i / 14), { modifiers: ['leftButtonDown', 'control'] });
        await sleep(50);
      }
      await sleep(250);
      send('mouseUp', dEnd.x, dEnd.y, { modifiers: ['control'] });
      await sleep(1200);
      report(fs.existsSync(path.join(left, 'd.txt')) && fs.existsSync(path.join(right, 'd.txt')), 'with Ctrl held it copies instead');
      await shot('filessplit-after-moves');

      // (d) Home and Projects at half width.
      await page(`(() => { houseTest.activateTab(window.__t.R); houseTest.navigate('home:'); return true; })()`);
      await sleep(900);
      const homeBox = await page('(() => { const v = window.__t.R.view; const r = v.home.getBoundingClientRect(); const wide = [...v.home.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().right > r.right + 1).length; return { shown: !v.home.hidden, rowsHidden: v.rows.hidden, tiles: v.home.querySelectorAll(".home-tile").length, w: Math.round(r.width), overflow: wide, scroll: v.home.scrollWidth <= v.home.clientWidth + 1 }; })()');
      report(homeBox.shown && homeBox.rowsHidden && homeBox.tiles === 4 && homeBox.scroll && homeBox.overflow === 0, `Home draws at half width without spilling out: ${JSON.stringify(homeBox)}`);
      await shot('filessplit-home-half');
      await page('(() => { houseTest.navigate(houseTest.state.projects); return true; })()');
      await sleep(900);
      const proj = await page('(() => { const v = window.__t.R.view; return { rows: v.rows.querySelectorAll(".row").length, home: v.home.hidden, left: window.__t.L.view.rows.querySelectorAll(".row").length }; })()');
      report(proj.home && proj.rows > 0 && proj.left > 0, `Projects in a half lists its folders, the other half untouched: ${JSON.stringify(proj)}`);
      await shot('filessplit-projects-half');
      await page(`(() => { houseTest.navigate(${JSON.stringify(right)}); return true; })()`);
      await sleep(700);

      // (e) Divider and Separate.
      const grip = await rectOf('document.querySelector(".pair-grip")');
      send('mouseMove', grip.x, grip.y);
      await sleep(150);
      send('mouseDown', grip.x, grip.y);
      for (let i = 1; i <= 8; i += 1) { send('mouseMove', grip.x + i * 30, grip.y, { modifiers: ['leftButtonDown'] }); await sleep(40); }
      send('mouseUp', grip.x + 240, grip.y);
      await sleep(400);
      const wider = await page('Math.round(window.__t.L.view.root.getBoundingClientRect().width)');
      await page('document.querySelector(".pair-grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); true');
      await sleep(400);
      const evenA = await page('[Math.round(window.__t.L.view.root.getBoundingClientRect().width), Math.round(window.__t.R.view.root.getBoundingClientRect().width)]');
      report(wider > evenA[0] + 100 && Math.abs(evenA[0] - evenA[1]) <= 4, `the divider drags, and a double-click makes them half and half: ${wider} then ${evenA}`);

      // Ctrl+R: the same pair comes back, each half in its own folder.
      await page('window.__before = 1; true');
      win.webContents.focus();
      press('R', ['control']);
      let back = false;
      for (let i = 0; i < 100 && !back; i += 1) {
        await sleep(300);
        back = await page('window.__before === undefined && Boolean(window.houseTest) && houseTest.state.tabs.length === 2 && houseTest.state.tabs.every((t) => t.listed)').catch(() => false);
      }
      await sleep(1500);
      const restored = await page(`(() => { const [a, b] = houseTest.state.tabs; return { pair: a.splitWith === b && b.splitWith === a, sides: a.side + '/' + b.side, paths: [a.path, b.path], boxes: [a.view.root.hidden, b.view.root.hidden], rows: [a.view.rows.children.length > 0, b.view.rows.children.length > 0], at: a.pairAt, same: a.view === b.view }; })()`);
      report(back && restored.pair && !restored.same && restored.paths[0] === left && restored.paths[1] === right && !restored.boxes[0] && !restored.boxes[1] && restored.rows[0] && restored.rows[1], `Ctrl+R brought the pair back: ${JSON.stringify(restored)}`);
      await page('(() => { const [a, b] = houseTest.state.tabs; window.__t = { L: a, R: b }; return true; })()');
      await shot('filessplit-after-reload');

      // A click still works after the reload.
      await click(await rowRect('R', 'c.txt'));
      report(await front() === 'R' && (await picked('R')).join() === 'c.txt', 'after the reload a click in the right half picks and makes it the front tab');

      // Separate: two ordinary tabs again, each showing its own folder.
      await page('(() => { houseTest.separateTabs(window.__t.R); return true; })()');
      await sleep(600);
      const alone = await page('(() => { const { L, R } = window.__t; return { pair: Boolean(L.splitWith || R.splitWith), main: document.querySelector(".main").classList.contains("pair"), rShown: !R.view.root.hidden, lShown: !L.view.root.hidden, rows: R.view.rows.querySelectorAll(".row").length }; })()');
      report(!alone.pair && !alone.main && alone.rShown && !alone.lShown && alone.rows > 0, `Separate: two ordinary tabs, the front one shows its folder: ${JSON.stringify(alone)}`);
      await page('(() => { houseTest.activateTab(window.__t.L); return true; })()');
      await sleep(700);
      report((await names('L')).join() === 'sub,d.txt,x.txt' || (await names('L')).includes('x.txt'), `the other tab shows its own folder: ${await names('L')}`);

      // Pair again as "Show on the Right" does, then close one half.
      await page('(() => { houseTest.pairTabs(window.__t.R, window.__t.L, "right", 35); return true; })()');
      await sleep(700);
      const again = await page('(() => { const { L, R } = window.__t; return { pair: L.splitWith === R, at: L.pairAt, aw: Math.round(L.view.root.getBoundingClientRect().width), bw: Math.round(R.view.root.getBoundingClientRect().width), lrows: L.view.rows.children.length > 0, rrows: R.view.rows.children.length > 0 }; })()');
      report(again.pair && again.at === 35 && again.aw < again.bw && again.lrows && again.rrows, `pairing again from the menu path works: ${JSON.stringify(again)}`);
      await page('(async () => { await houseTest.closeTab(window.__t.R); return true; })()');
      await sleep(700);
      const closed = await page('(() => { const { L } = window.__t; return { tabs: houseTest.state.tabs.length, pair: Boolean(L.splitWith), main: document.querySelector(".main").classList.contains("pair"), shown: !L.view.root.hidden, w: Math.round(L.view.root.getBoundingClientRect().width), rows: L.view.rows.children.length > 0 }; })()');
      report(closed.tabs === 1 && !closed.pair && !closed.main && closed.shown && closed.w > 500 && closed.rows, `closing one half leaves the other full width: ${JSON.stringify(closed)}`);

      // A half of a pair goes to a window of its own.
      await page('document.getElementById("new-tab").click(); true');
      await sleep(500);
      await page(`(() => { window.__t.R = houseTest.state.active; houseTest.navigate(${JSON.stringify(right)}); houseTest.pairTabs(window.__t.R, window.__t.L, "right"); return true; })()`);
      await sleep(900);
      await page('houseTest.popOutTab(window.__t.R).then(() => true)');
      let second = null;
      for (let waited = 0; waited < 10000 && !second; waited += 250) {
        second = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.houseSpare && w !== win) || null;
        await sleep(250);
      }
      const there = second && await (async () => { for (let i = 0; i < 40; i += 1) { if (await second.webContents.executeJavaScript('Boolean(window.houseTest) && houseTest.state.tabs.length > 0 && houseTest.state.tabs[0].listed').catch(() => false)) return true; await sleep(250); } return false; })();
      const stay = await page('(() => { const { L } = window.__t; return { pair: Boolean(L.splitWith), shown: !L.view.root.hidden, w: Math.round(L.view.root.getBoundingClientRect().width) }; })()');
      const arrived = there ? await second.webContents.executeJavaScript('houseTest.state.tabs.map((t) => t.path)') : null;
      report(Boolean(there) && !stay.pair && stay.shown && stay.w > 500 && arrived && arrived[0] === right, `a half moved to a window of its own: it opens there, the other half stays full width: ${JSON.stringify([stay, arrived])}`);
      for (const w of BrowserWindow.getAllWindows()) if (w !== win && !w.isDestroyed() && !w.houseSpare) await w.webContents.executeJavaScript('window.close()').catch(() => {});
      await sleep(800);
    } catch (error) {
      report(false, `the scene stopped: ${error.stack}`);
    } finally {
      sharedClipboard.copyFiles = realCopyFiles;
      fs.rmSync(left, { recursive: true, force: true });
      fs.rmSync(right, { recursive: true, force: true });
    }
  },
};
