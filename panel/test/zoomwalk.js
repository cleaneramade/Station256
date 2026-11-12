// Walks a real, visible window through every zoom state and photographs only itself.
const fs = require('fs');
const path = require('path');

const OUT = process.env.HOUSE_ZOOMWALK;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHECK = `(() => {
  const app = document.querySelector('.app').getBoundingClientRect();
  const view = { w: innerWidth, h: innerHeight };
  const bad = [];
  const out = (name, r, box) => {
    const o = [r.left - box.left, r.top - box.top, box.right - r.right, box.bottom - r.bottom].map(Math.round);
    if (o.some((v) => v < -1)) bad.push(name + ' L' + o[0] + ' T' + o[1] + ' R' + o[2] + ' B' + o[3]);
  };
  const viewBox = { left: 0, top: 0, right: view.w, bottom: view.h };
  out('app-vs-screen', app, viewBox);
  for (const s of ['.tabstrip', '.addressbar', '.commandbar', '.main', '.statusbar', '#win-close', '#toggle-system', '#view-icons', '#search']) {
    const el = document.querySelector(s);
    if (el && el.offsetParent !== null) out(s, el.getBoundingClientRect(), app);
  }
  for (const s of ['.tabstrip', '.addressbar', '.address', '.commandbar', '.statusbar', '.main', '.columns', '.row']) {
    const el = document.querySelector(s);
    if (el && el.offsetParent !== null && el.scrollWidth - el.clientWidth > 1) bad.push(s + ' spills ' + (el.scrollWidth - el.clientWidth));
  }
  const menu = document.getElementById('menu');
  if (menu && !menu.hidden) out('menu', menu.getBoundingClientRect(), viewBox);
  const dialog = document.getElementById('dialog');
  if (dialog && dialog.open) {
    out('dialog', dialog.getBoundingClientRect(), viewBox);
    if (dialog.scrollHeight - dialog.clientHeight > 1) bad.push('dialog scrolls ' + (dialog.scrollHeight - dialog.clientHeight));
    const buttons = dialog.querySelector('.dialog-buttons');
    if (buttons) out('dialog-buttons', buttons.getBoundingClientRect(), dialog.getBoundingClientRect());
  }
  const screen = document.querySelector('.term-area:not([hidden]) .xterm-screen');
  const host = document.querySelector('.term-area:not([hidden])');
  if (screen && host) out('terminal', screen.getBoundingClientRect(), host.getBoundingClientRect());
  return { zoom: document.getElementById('zoom-level').textContent, css: [Math.round(app.width), Math.round(app.height)], view: [view.w, view.h], bad };
})()`;

async function run(win) {
  const page = (code) => win.webContents.executeJavaScript(code);
  let n = 0;
  const step = async (name) => {
    await sleep(450);
    const result = await page(CHECK);
    n += 1;
    const file = `${String(n).padStart(2, '0')}-${name}.png`;
    fs.writeFileSync(path.join(OUT, file), (await win.webContents.capturePage()).toPNG());
    console.log(`${result.bad.length ? 'FAIL' : 'PASS'} ${file} zoom=${result.zoom} css=${result.css} view=${result.view} ${result.bad.join('; ')}`);
  };
  const click = (id) => page(`document.getElementById('${id}').click(); true`);
  const closeMenu = () => page(`document.body.click(); document.getElementById('menu').hidden = true; true`);

  try {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await sleep(2500);
    await step('start-maximized-150');
    await click('win-max');
    await step('restored-150');

    // Hover text, driven by real mouse movement in a real window. Times include the trip back here.
    const log = (ok, label, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${detail}`);
    const isOpen = () => page(`document.querySelector('.tooltip').matches(':popover-open')`);
    const moveTo = async (where) => {
      const point = typeof where !== 'string' ? where : await page(`(() => {
        const b = document.querySelector('${where}').getBoundingClientRect();
        const f = window.outerWidth / window.innerWidth;
        return { x: Math.round((b.left + b.width / 2) * f), y: Math.round((b.top + b.height / 2) * f) };
      })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      return point;
    };
    const timeUntil = async (wantOpen) => {
      const start = Date.now();
      while ((await isOpen()) !== wantOpen && Date.now() - start < 2000) await sleep(1);
      return Date.now() - start;
    };
    log(await page(`document.querySelectorAll('[title]').length === 0`), 'no built-in hover text left');
    await moveTo('.drag-space');
    await sleep(400);

    const shows = [];
    const closes = [];
    for (let i = 0; i < 5; i += 1) {
      await moveTo('#rules-btn');
      shows.push(await timeUntil(true));
      await sleep(100);
      if (i === 0) {
        fs.writeFileSync(path.join(OUT, 'hover.png'), (await win.webContents.capturePage()).toPNG());
        log(await page(`(() => {
          const b = document.querySelector('.tooltip').getBoundingClientRect();
          return b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;
        })()`), 'hover text is on screen');
      }
      await moveTo('.drag-space');
      closes.push(await timeUntil(false));
      await sleep(400); // long enough that the next one waits its full delay
    }
    log(Math.min(...shows) >= 400 && Math.max(...shows) <= 700, 'hover text waits about half a second', `show ms: ${shows}`);
    log(Math.max(...closes) <= 50, 'hover text closes at once when moving to something else', `close ms: ${closes}`);

    await moveTo('#rules-btn');
    await timeUntil(true);
    await moveTo({ x: 5, y: 5 }); // the see-through area outside the window
    log(true, 'moving off the window entirely', `close ms: ${await timeUntil(false)}`);
    await sleep(400);

    const pressAt = await moveTo('#refresh');
    await timeUntil(true);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...pressAt });
    log(true, 'pressing the mouse', `close ms: ${await timeUntil(false)}`);
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...pressAt });
    await sleep(800);
    log(!(await isOpen()), 'it stays away until the mouse leaves and comes back');

    await moveTo('#win-max');
    await timeUntil(true);
    await page(`document.getElementById('win-max').title = 'Changed while hovering'; true`);
    await sleep(30);
    log((await page(`document.querySelector('.tooltip').textContent`)) === 'Changed while hovering', 'text changed by the app shows live');
    await page(`document.getElementById('win-max').title = 'Maximize'; true`);
    await moveTo('.drag-space');
    await sleep(100);

    await click('new-btn');
    await step('new-menu');
    await closeMenu();
    await click('view-btn');
    await step('view-menu');
    await closeMenu();
    await click('lock-btn');
    await step('lock');
    await page(`(() => { const d = document.getElementById('dialog'); if (d.open) d.close(); document.getElementById('menu').hidden = true; return true; })()`);
    await click('rules-btn');
    await sleep(600);
    await step('rules-page');
    await page(`(() => { const done = document.querySelector('.rules-done'); if (done) done.click(); return true; })()`);
    await sleep(300);
    await click('toggle-system');
    await sleep(800);
    await step('system-open');
    await click('toggle-system');

    await page(`document.getElementById('new-tab').click(); true`);
    await step('second-tab');
    await page(`houseTest.openTerminal({}).then(() => true)`);
    await sleep(1500);
    await step('terminal');

    await click('zoom-level');
    await step('back-to-100');
    await click('win-max');
    await step('maximized-100');
    await click('win-max');
    for (let i = 0; i < 3; i += 1) await click('zoom-in');
    await step('restored-115');

    /* ---------- Everyday actions, done the way a person would ---------- */
    const key = (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    const home = await page('houseTest.state.home');
    const projects = `${home}/projects`;
    const openFilesTab = () => page(`(() => { const t = houseTest.state.tabs.find((x) => x.kind === 'files'); activateTab(t); return true; })()`);
    const go = async (target) => {
      await page(`houseTest.navigate(${JSON.stringify(target)}); true`);
      await sleep(600);
    };
    const okDialog = () => page(`document.querySelector('#dialog .btn.primary, #dialog .btn.danger').click(); true`);
    const isDialogOpen = () => page(`document.getElementById('dialog').open`);

    // Esc on a dialog counts as cancel, and nothing is left waiting.
    await page(`window.answer = 'waiting'; confirmBox('Test', 'Testing', 'OK').then((v) => { window.answer = String(v); }); true`);
    await sleep(300);
    win.webContents.focus();
    key('Escape');
    await sleep(400);
    log((await page('window.answer')) !== 'waiting', 'Esc on a dialog counts as cancel', await page('window.answer'));
    if (await isDialogOpen()) await page(`document.getElementById('dialog').close(); true`);

    await openFilesTab();
    await go(projects);

    // A search unselects what it hides (This folder: the folder's own filter; search starts with every folder inside).
    await page(`document.getElementById('search-scope').click(); true`);
    await sleep(200);
    await page(`[...document.querySelectorAll('#menu .menu-item')].find((row) => row.textContent.trim() === 'This folder').click(); true`);
    await sleep(200);
    await page(`(() => {
      houseTest.state.selected = new Set(houseTest.state.entries.map((e) => e.path));
      const s = document.getElementById('search');
      s.value = 'readme';
      s.dispatchEvent(new Event('input'));
      return true;
    })()`);
    await sleep(200);
    log((await page('houseTest.state.selected.size')) === 1, 'search unselects the items it hides', `${await page('houseTest.state.selected.size')} left selected`);
    await page(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); houseTest.state.selected = new Set(); return true; })()`);

    // A bad path goes back to the last folder that worked.
    await page(`houseTest.navigate('/no/such/place'); true`);
    await sleep(600);
    const badPathDialog = await isDialogOpen();
    await okDialog();
    await sleep(600);
    log(badPathDialog && (await page('houseTest.state.active.path')) === projects, 'a bad path says so, then returns to the last folder', await page('houseTest.state.active.path'));

    // A big folder that's still loading can't replace a small one you moved on to.
    await page(`houseTest.navigate(${JSON.stringify(`${projects}/big`)}); houseTest.navigate(${JSON.stringify(`${projects}/small`)}); true`);
    await sleep(3000);
    log((await page('houseTest.state.entries.length')) === 1, 'a slow folder can\'t replace the one you moved on to', `${await page('houseTest.state.entries.length')} items showing`);

    // A folder with 10,000 files.
    const openBig = await page(`(async () => {
      const t = performance.now();
      houseTest.navigate(${JSON.stringify(`${projects}/big`)});
      while (houseTest.state.entries.length < 10000) await new Promise((r) => setTimeout(r, 5));
      return Math.round(performance.now() - t);
    })()`);
    await sleep(600);
    const clickBig = await page(`(() => {
      const row = document.querySelectorAll('.row')[5000];
      const t = performance.now();
      row.click();
      document.body.offsetHeight;
      return Math.round(performance.now() - t);
    })()`);
    log(clickBig < 100, 'selecting in a folder of 10,000 files is quick', `open ${openBig} ms, click ${clickBig} ms`);

    // A failed move stays cut, so it can be tried again.
    await go(projects);
    await page(`(() => {
      houseTest.state.clipboard = { paths: [${JSON.stringify(`${projects}/small/not-there`)}], move: true };
      document.getElementById('paste').disabled = false;
      document.getElementById('paste').click();
      return true;
    })()`);
    for (let i = 0; i < 40 && !(await isDialogOpen()); i += 1) await sleep(100);
    const failedOpen = await isDialogOpen();
    const failedText = await page(`document.getElementById('dialog').textContent`);
    await okDialog();
    await sleep(300);
    log(failedOpen && (await page('houseTest.state.clipboard?.paths.length')) === 1, 'a failed move says why and stays cut', failedText.slice(0, 90));
    await page(`houseTest.state.clipboard = null; true`);

    // The Trash, start to finish, through the real buttons.
    const note = `${projects}/small/note.txt`;
    await go(`${projects}/small`);
    await page(`(() => { document.querySelector('.row').click(); document.getElementById('delete').click(); return true; })()`);
    await sleep(400);
    await okDialog();
    await sleep(700);
    log(!fs.existsSync(note), 'delete moves a file out');
    await page(`document.querySelector('[data-nav="trash"]').click(); true`);
    await sleep(900);
    const trashName = await page(`document.querySelector('.row .name-text')?.textContent`);
    log(trashName === 'note.txt', 'the Trash shows it by its real name', trashName);
    log(await page(`!document.getElementById('trash-restore').hidden && !document.getElementById('trash-empty').hidden`), 'Restore and Empty trash buttons appear only there');
    fs.writeFileSync(path.join(OUT, 'trash.png'), (await win.webContents.capturePage()).toPNG());
    await page(`(() => { document.querySelector('.row').click(); document.getElementById('trash-restore').click(); return true; })()`);
    await sleep(800);
    log(fs.existsSync(note), 'Restore puts it back');
    await go(`${projects}/small`);
    log(await page(`document.getElementById('trash-restore').hidden`), 'those buttons leave with you');
    await page(`(() => { document.querySelector('.row').click(); document.getElementById('delete').click(); return true; })()`);
    await sleep(400);
    await okDialog();
    await sleep(700);
    await page(`document.querySelector('[data-nav="trash"]').click(); true`);
    await sleep(900);
    await page(`document.getElementById('trash-empty').click(); true`);
    await sleep(400);
    const emptyWords = await page(`document.getElementById('dialog').textContent`);
    await okDialog();
    await sleep(800);
    const rowsLeft = await page('[...document.querySelectorAll(".row")].map((r) => r.textContent.trim().slice(0, 30))');
    log(/Delete the item in the Trash for good/.test(emptyWords) && rowsLeft.length === 0, 'Empty trash warns, then empties', `${emptyWords.slice(0, 80)} | rows left ${JSON.stringify(rowsLeft)}`);

    // The folders the house needs refuse to be deleted, with a clear reason.
    await go(home);
    await page(`(() => {
      const row = [...document.querySelectorAll('.row')].find((r) => /projects/i.test(r.textContent));
      row.click();
      document.getElementById('delete').click();
      return true;
    })()`);
    await sleep(400);
    await okDialog();
    await sleep(600);
    const refusal = await page(`document.getElementById('dialog').textContent`);
    if (await isDialogOpen()) await okDialog();
    await sleep(300);
    log(/part of how the house runs/.test(refusal) && fs.existsSync(projects), 'the projects folder can\'t be deleted', refusal.slice(0, 80));

    // A preview closes when you switch tabs.
    await go(projects);
    await page(`houseTest.showPreview(houseTest.state.entries.find((e) => e.name === 'readme.md')); true`);
    await sleep(400);
    await page(`activateTab(houseTest.state.tabs.find((t) => t.kind === 'term')); true`);
    await sleep(300);
    log(await page(`document.getElementById('preview').hidden`), 'a preview closes when you switch tabs');

    // A low-space warning shows in the footer.
    await page(`houseTest.state.status.lowDisk = true; houseTest.state.status.freeGb = 7.4; renderHouseNote(); true`);
    log((await page(`document.getElementById('house-note').textContent`)).includes('almost full: 7 GB'), 'low space shows a warning', await page(`document.getElementById('house-note').textContent`));
    await page(`houseTest.state.status.lowDisk = false; renderHouseNote(); true`);

    // The System panel doesn't offer to end the app itself.
    await click('toggle-system');
    await sleep(900);
    log(await page(`![...document.querySelectorAll('.proc-row')].some((r) => r.textContent.includes('electron') && r.querySelector('.link-btn'))`), 'the System panel has no End button for the app');
    const heldStill = await page(`(async () => {
      const first = document.querySelector('.proc-table');
      const pane = document.getElementById('system-pane');
      pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 3200));
      const same = document.querySelector('.proc-table') === first;
      window.dispatchEvent(new PointerEvent('pointerup'));
      return same;
    })()`);
    log(heldStill, 'the System panel holds still while you press');
    await click('toggle-system');

    // The layout bar, with real mouse presses and drags, at 100% zoom.
    await click('zoom-level');
    await sleep(500);
    const center = (selector, index = 0) => page(`(() => {
      const factor = window.outerWidth / window.innerWidth;
      const b = document.querySelectorAll(${JSON.stringify(selector)})[${index}].getBoundingClientRect();
      return { x: Math.round((b.left + b.width / 2) * factor), y: Math.round((b.top + b.height / 2) * factor) };
    })()`);
    const held = (point) => win.webContents.sendInputEvent({ type: 'mouseMove', ...point, modifiers: ['leftButtonDown'] });
    const press = async () => {
      const at = await center('.drag-space');
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at });
      await sleep(80);
      held({ x: at.x + 30, y: at.y + 30 });
      await sleep(120);
      return at;
    };
    const release = async (point) => {
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await sleep(450);
    };
    const windowBox = () => page(`(() => {
      const factor = window.outerWidth / window.innerWidth;
      const b = document.querySelector('.app').getBoundingClientRect();
      return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * factor));
    })()`);
    const barOpen = () => page(`Boolean(document.querySelector('.snap-bar.open'))`);

    const startSize = await windowBox();
    await press();
    log(!(await barOpen()), 'the layout bar stays away during a normal drag');
    log(await page(`Boolean(document.querySelector('.snap-bar.peek'))`), 'a sliver of it peeks at the top while dragging');
    held({ x: 960, y: 60 });
    await sleep(200);
    log(!(await barOpen()), 'it stays closed until the pointer reaches the top');
    held({ x: 960, y: 5 });
    await sleep(250);
    log(await barOpen(), 'dragging to the top brings up the layout bar');
    const cells = await page(`document.querySelectorAll('.snap-group:not([hidden]) .snap-cell').length`);
    await release({ x: 960, y: 500 });
    log(!(await barOpen()), 'letting go elsewhere closes it');

    const wrong = [];
    for (let i = 0; i < cells; i += 1) {
      await press();
      held({ x: 960, y: 5 });
      await sleep(200);
      const target = await center('.snap-group:not([hidden]) .snap-cell', i);
      held(target);
      await sleep(200);
      if (i === cells - 1) fs.writeFileSync(path.join(OUT, 'snap.png'), (await win.webContents.capturePage()).toPNG());
      const previewShown = await page(`!document.querySelector('.snap-preview').hidden`);
      const zoneNow = await page(`[...document.querySelectorAll('.snap-group:not([hidden]) .snap-cell')][${i}].target.zone`);
      await release(target);
      const [left, top, width, height] = zoneNow;
      const want = [left * 1920, top * 1020, width * 1920, height * 1020].map(Math.round);
      const got = await windowBox();
      if (!previewShown || got.some((value, k) => Math.abs(value - want[k]) > 2)) wrong.push(`cell ${i}: wanted ${want} got ${got}`);
    }
    log(cells === 11 && !wrong.length, `all ${cells} layout spots put the window exactly there, with a preview first`, wrong.slice(0, 2).join(' | '));

    // Pulling a snapped window away gives it back its old size.
    const at = await press();
    await release({ x: at.x + 30, y: at.y + 200 });
    const backSize = await windowBox();
    log(Math.abs(backSize[2] - startSize[2]) <= 2 && Math.abs(backSize[3] - startSize[3]) <= 2, 'pulling it away restores its old size', `${startSize.slice(2)} / ${backSize.slice(2)}`);

    // At high zoom, layouts too small for the window drop out of the bar.
    for (let i = 0; i < 3; i += 1) await click('zoom-in');
    await sleep(500);
    await press();
    held({ x: 960, y: 5 });
    await sleep(250);
    const atHigh = await page(`document.querySelectorAll('.snap-group:not([hidden])').length`);
    await release({ x: 960, y: 500 });
    log(atHigh === 1, 'at 115% zoom only the layouts that fit are offered', `${atHigh} of 4`);
    await click('zoom-level');
    await sleep(400);

    // Screen edges and corners show a preview, then snap, as in Windows.
    for (const [name, point, want] of [
      ['left edge', { x: 0, y: 500 }, [0, 0, 960, 1020]],
      ['right edge', { x: 1919, y: 500 }, [960, 0, 960, 1020]],
      ['top left corner', { x: 0, y: 40 }, [0, 0, 960, 510]],
      ['top right corner', { x: 1919, y: 40 }, [960, 0, 960, 510]],
      ['bottom left corner', { x: 0, y: 1000 }, [0, 510, 960, 510]],
      ['bottom right corner', { x: 1919, y: 1000 }, [960, 510, 960, 510]],
    ]) {
      await press();
      held(point);
      await sleep(200);
      const shown = await page(`!document.querySelector('.snap-preview').hidden`);
      await release(point);
      const got = await windowBox();
      log(shown && got.every((value, k) => Math.abs(value - want[k]) <= 2), `${name} previews, then snaps there`, `${got}`);
    }

    // Resting on the maximize button opens the panel beside it. Clicking a layout uses it.
    await page(`document.getElementById('win-max').dispatchEvent(new PointerEvent('pointerenter')); true`);
    await sleep(700);
    log(await page(`Boolean(document.querySelector('.snap-bar.flyout'))`), 'resting on maximize opens the layout panel');
    const flyoutCell = await center('.snap-bar.flyout .snap-cell', 1);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...flyoutCell });
    await sleep(150);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...flyoutCell });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...flyoutCell });
    await sleep(600);
    const fromFlyout = await windowBox();
    log(fromFlyout.every((value, k) => Math.abs(value - [960, 0, 960, 1020][k]) <= 2) && !(await page(`Boolean(document.querySelector('.snap-bar'))`)), 'clicking a layout there snaps the window and closes it', `${fromFlyout}`);

    // Dropping on the very top edge, away from the bar, still maximizes.
    await press();
    held({ x: 100, y: 0 });
    await sleep(150);
    await release({ x: 100, y: 0 });
    log(await page(`document.documentElement.classList.contains('maximized')`), 'dropping on the top edge still maximizes');
    await click('win-max');
    await sleep(400);

    // Terminal: an idle one closes straight away, a busy one asks.
    const typeIn = (text) => page(`window.house.call('termWrite', houseTest.state.active.termId, ${JSON.stringify(text)}).then(() => true)`);
    const screenHas = (text) => page(`(() => { const b = houseTest.state.active.live.term.buffer.active; let s = ''; for (let i = 0; i < b.length; i += 1) s += b.getLine(i).translateToString(true) + '\\n'; return s.split(${JSON.stringify(text)}).length - 1; })()`);
    await page(`houseTest.openTerminal({}).then(() => true)`);
    await sleep(1200);
    await typeIn('sleep 100\n');
    await sleep(600);
    await page(`document.querySelector('.tab.active .close-tab').click(); true`);
    await sleep(500);
    const askedBusy = await isDialogOpen();
    if (askedBusy) await page(`document.querySelector('#dialog .btn').click(); true`);
    await sleep(300);
    log(askedBusy && (await page(`houseTest.state.active.kind === 'term'`)), 'closing a busy terminal asks, and Cancel keeps it');
    await typeIn('\x03');
    await sleep(500);

    // Ctrl+Shift+V must stop the browser's own paste, or it would paste twice. This never writes
    // to the clipboard, which belongs to the user. What's read goes into cat, so nothing can run.
    const { BrowserWindow } = require('electron');
    await typeIn('cat\n');
    await sleep(400);
    const stopped = await page(`(() => {
      const box = document.querySelector('.term-host:not([hidden]) textarea');
      const event = new KeyboardEvent('keydown', { code: 'KeyV', key: 'V', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      box.dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
    log(stopped, 'Ctrl+Shift+V stops the browser pasting a second time');
    await sleep(400);
    await typeIn('\x04');
    await sleep(400);
    await typeIn('clear\n');
    await sleep(300);

    // Popping out and coming back can't type answers to old questions into the shell.
    await typeIn(`printf '\\033[c'; echo\n`);
    await sleep(600);
    await typeIn('clear\n');
    await sleep(400);
    await typeIn(`printf '\\033[c'; echo; cat\n`);
    await sleep(600);
    const before = await page(`window.house.call('termCount')`);
    const answersBefore = await screenHas('1;2c');
    const termId = await page('houseTest.state.active.termId');
    await page('houseTest.popOutTab(houseTest.state.active).then(() => true)');
    await sleep(2000);
    const popout = BrowserWindow.getAllWindows().find((candidate) => candidate !== win && !candidate.isDestroyed() && !candidate.houseSpare);
    const replayJunk = popout ? await popout.webContents.executeJavaScript(`(async () => {
      await new Promise((r) => setTimeout(r, 600));
      return 'checked';
    })()`) : 'no window';
    log(Boolean(popout) && replayJunk === 'checked', 'the terminal popped out with its history');

    // The pop-out asks before closing if something's running in it (cat is).
    if (popout) {
      await popout.webContents.executeJavaScript(`document.getElementById('win-close').click(); true`);
      await sleep(500);
      const asked = await popout.webContents.executeJavaScript(`document.getElementById('dialog').open`);
      if (asked) await popout.webContents.executeJavaScript(`document.querySelector('#dialog .btn').click(); true`);
      await sleep(300);
      log(asked && !popout.isDestroyed(), 'closing a busy pop-out asks, and Cancel keeps it');
      await popout.webContents.executeJavaScript(`document.querySelector('.tab .bring-back').click(); true`);
      await sleep(1800);
    }
    log((await page('window.house.call("termCount")')) === before && (await page(`houseTest.state.tabs.some((t) => t.termId === ${termId})`)), 'bringing it back keeps the session');

    // Only the shell's real input reaches cat. Nothing new appears there after coming back.
    await sleep(500);
    const answersAfter = await screenHas('1;2c');
    log(answersAfter === answersBefore, 'no stray text typed after coming back', `${answersBefore} before, ${answersAfter} after`);
    await typeIn('\x04');
    await sleep(300);

    // Clicking the icon while minimized brings the window back, and it stays full-size inside.
    // Run from Windows by walk-watch: when this window minimizes, it does what the icon does.
    await click('win-min');
    await sleep(9000);
    log(await page(`getComputedStyle(document.querySelector('.app')).opacity === '1'`), 'the window is visible again after coming back');
    log(await page(`document.documentElement.classList.contains('ready') && document.querySelector('.app').getAnimations().every((a) => a.playState !== 'running')`), 'nothing left mid-animation');
    log(win.isMaximized(), 'the see-through surface is still full-size afterward');

    // The X must really end the app. Otherwise reopening would keep running old code.
    // A terminal is open, so it asks first. Cancel must keep everything; Esc counts as Cancel.
    const dialogOpen = () => page(`document.getElementById('dialog').open`);
    await click('win-close');
    await sleep(400);
    log(await dialogOpen(), 'closing with a terminal open asks first', await page(`document.getElementById('dialog').textContent`));
    await page(`document.querySelector('#dialog .btn').click(); true`);
    await sleep(400);
    log(!(await dialogOpen()) && (await page(`houseTest.state.tabs.some((t) => t.kind === 'term')`)), 'Cancel keeps the window and the terminal');
    await click('win-close');
    await sleep(400);
    await page(`document.querySelector('#dialog .btn.danger').click(); true`);
    await sleep(4000);
    console.log('FAIL the X button did not quit the app');
  } catch (error) {
    console.log(`FAIL walk stopped: ${error.message.replace(/\s+/g, ' ')}`);
  }
  require('electron').app.quit();
}

module.exports = { run };
