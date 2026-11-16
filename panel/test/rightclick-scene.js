// Right-click everywhere: real right-clicks (sent to the window as a mouse would) on each part of
// Station, checking a menu opens and starts with the same four. Then Cut, Copy, Paste and Select
// All are used from the menu in a text box, and the top bar's Preview is checked.
const SHARED = ['Cut', 'Copy', 'Paste', 'Select All'];

module.exports = {
  async rightClick({ page, shot, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const labels = () => page(`document.getElementById('menu').hidden ? null : [...document.querySelectorAll('#menu .menu-item')].map((row) => (row.disabled ? '-' : '') + row.textContent)`);
    const bare = (list) => (list || []).map((label) => label.replace(/^-/, ''));
    // Right-clicks the middle (or a spot) of the first thing the selector finds, as the mouse does.
    const rightClick = async (selector, spot = null) => {
      const at = await page(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return null;
        const box = node.getBoundingClientRect();
        const f = window.outerWidth / window.innerWidth;
        const spot = ${JSON.stringify(spot)};
        return { x: Math.round((box.left + (spot ? spot.x : box.width / 2)) * f), y: Math.round((box.top + (spot ? (spot.y < 0 ? box.height + spot.y : spot.y) : box.height / 2)) * f) };
      })()`);
      if (!at) return null;
      await page(`closeMenu(); true`);
      // A web page is its own window inside Station: the click goes to it, at the spot on the page.
      const { webContents } = require('electron');
      const guest = selector === 'webview' ? webContents.getAllWebContents().find((item) => item.getType() === 'webview' && !item.isDestroyed()) : null;
      const target = guest || win.webContents;
      // The click is in the page's device pixels (zoomed), the spot in its CSS pixels.
      const scale = guest ? await guest.executeJavaScript('devicePixelRatio') : 1;
      const where = guest ? { x: Math.round(spot.x * scale), y: Math.round(spot.y * scale) } : at;
      target.sendInputEvent({ type: 'mouseDown', x: where.x, y: where.y, button: 'right', clickCount: 1 });
      target.sendInputEvent({ type: 'mouseUp', x: where.x, y: where.y, button: 'right', clickCount: 1 });
      await sleep(400);
      return labels();
    };
    const check = async (name, selector, wanted = [], spot = null) => {
      const shown = await rightClick(selector, spot);
      const words = bare(shown);
      const first = JSON.stringify(words.slice(0, 4)) === JSON.stringify(SHARED);
      const has = wanted.every((label) => words.includes(label));
      report(shown && first && has, `right-click on ${name}: ${JSON.stringify(shown)}`);
      return shown;
    };
    // A real left click on the item, so a menu that can be seen but not reached fails here.
    const press = async (label) => {
      const at = await page(`(() => {
        const row = [...document.querySelectorAll('#menu .menu-item')].find((item) => item.textContent === ${JSON.stringify(label)});
        if (!row) return null;
        const box = row.getBoundingClientRect();
        const f = window.outerWidth / window.innerWidth;
        return { x: Math.round((box.left + box.width / 2) * f), y: Math.round((box.top + box.height / 2) * f) };
      })()`);
      if (!at) return report(false, `menu item ${label} is there`);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await sleep(300);
    };

    // Home, in a window with just one tab (other scenes may have left more).
    await page(ONE_TAB_LEFT_CODE);
    win.setBounds({ x: 60, y: 40, width: 1240, height: 800 }); // other scenes may have left it narrow
    await sleep(500);
    await page(`houseTest.navigate('home:'); true`);
    await sleep(1500);
    await check('a project card', '.home-card', ['Open', 'Open Room', 'Preview', 'Copy as Path']);
    await check('a home tile', '.home-tile');
    await check('a sidebar place', '.nav-item[data-nav="projects"]', ['Open', 'Open in New Tab', 'Copy as Path', 'Properties']);
    await check('a tab', '.tabs .tab', ['New Tab', 'Close Tab']);
    await check('the command bar', '.commandbar .grow');
    await shot('rightclick-card');

    // A folder: an item, empty space, a column's head.
    await page(`houseTest.navigate(houseTest.state.projects); true`);
    await sleep(1200);
    const project = await check('a project in the list', '#rows [data-path$="/SampleApp"]', ['Open', 'Open Room', 'Preview', 'Rename', 'Properties']);
    report(!project.slice(4).some((label) => SHARED.includes(label.replace(/^-/, ''))), 'the four aren\'t listed twice');
    report(!project.slice(0, 2).some((label) => label.startsWith('-')), 'Cut and Copy work on the picked project');
    await shot('rightclick-project');
    await check('empty space in a folder', '#rows', ['Folder', 'Text Document', 'Refresh', 'Properties'], { x: 300, y: -20 });
    await check('a column\'s head', '#columns [data-sort="name"]', ['Reset columns']);

    // Preview in the top bar: a picked project shows it, and so does being inside one.
    await page(`(() => { const entry = visibleEntries().find((item) => item.name === 'SampleApp'); setSelection([entry.path], entry.path); return true; })()`);
    await sleep(300);
    const picked = await page(`[!document.getElementById('room-preview-btn').hidden, document.getElementById('room-preview-label').textContent]`);
    report(picked[0] && picked[1] === 'Preview', `picking a project shows Preview in the top bar: ${JSON.stringify(picked)}`);
    await shot('preview-topbar');
    await page(`houseTest.navigate(houseTest.state.projects + '/SampleApp'); true`);
    await sleep(1000);
    const inside = await page(`!document.getElementById('room-preview-btn').hidden`);
    report(inside, 'inside a project, Preview is in the top bar');
    await check('empty space inside a project', '#rows', ['Preview'], { x: 300, y: -20 });
    await page(`houseTest.navigate(houseTest.state.home + '/Documents'); true`);
    await sleep(1000);
    report(await page(`document.getElementById('room-preview-btn').hidden`), 'outside projects, there is no Preview button');
    await page(`houseTest.navigate(houseTest.state.projects); true`);
    await sleep(1000);

    // A text box: the menu's own Select All, Copy, Cut and Paste.
    await page(`(() => { const box = document.getElementById('search'); box.focus(); box.value = 'station right-click test'; return true; })()`);
    const box = await check('the search box', '#search', ['Undo', 'Redo']);
    report(box && !box[2].startsWith('-') && box[0].startsWith('-'), 'in a text box with nothing picked: Paste on, Cut off');
    await press('Select All');
    await rightClick('#search');
    await press('Copy');
    await rightClick('#search');
    await press('Cut');
    const cut = await page(`document.getElementById('search').value`);
    report(cut === '', `Cut empties the box: ${JSON.stringify(cut)}`);
    await rightClick('#search');
    await press('Paste');
    await rightClick('#search');
    await press('Paste');
    const pasted = await page(`document.getElementById('search').value`);
    // The second goes where the right-click put the typing spot, as in any app.
    report(pasted.length === 48 && pasted.includes('station right-click test'), `Paste puts it back, twice: ${JSON.stringify(pasted)}`);
    await page(`(() => { const box = document.getElementById('search'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); box.blur(); return true; })()`);

    // A box in a dialog (Rename): the menu opens over the dialog and Paste lands in the box.
    await page(`call('clipboardWrite', 'pasted into a dialog'); promptBox('Rename', '', 'old name', 'Rename'); true`);
    await sleep(800);
    const inDialog = await check('a box in a dialog', '#dialog .dialog-input', ['Undo', 'Redo']);
    await press('Select All');
    await rightClick('#dialog .dialog-input');
    await press('Paste');
    const dialogValue = await page(`document.querySelector('#dialog .dialog-input')?.value`);
    report(inDialog && dialogValue === 'pasted into a dialog', `Paste from the menu works inside a dialog: ${JSON.stringify(dialogValue)}`);
    report(await page(`document.getElementById('dialog').open`), 'using the menu didn\'t close the dialog');
    await page(`document.getElementById('dialog').close(); true`);
    await sleep(300);

    // A terminal: the four, working on the terminal's own text.
    await page(`houseTest.openTerminal({ cwd: houseTest.state.home }).then(() => true)`);
    await sleep(2500);
    const term = await check('a terminal', '.term-host:not([hidden]) .xterm-screen, .xterm-screen');
    report(term && term[1].startsWith('-') && !term[2].startsWith('-'), 'nothing picked: Copy off, Paste on');
    await press('Select All');
    const all = await rightClick('.xterm-screen');
    report(all && !all[1].startsWith('-'), `after Select All, Copy is on: ${JSON.stringify(all)}`);
    await page(`closeMenu(); houseTest.closeTab(houseTest.state.active); true`);
    await sleep(800);

    // The Web Browser: a page from a made-up server, right-clicked on its link and on plain space.
    const http = require('http');
    const site = await new Promise((resolve) => {
      const made = http.createServer((_request, response) => {
        // A tiny PNG, for the page's pictures.
        if (_request.url === '/pic.png') {
          response.writeHead(200, { 'content-type': 'image/png' });
          return response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
        }
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<body style="margin:0"><a href="http://127.0.0.1:9/next" style="display:block;height:100px;font-size:40px">a link</a><p style="height:400px">plain words</p>'
          + '<img src="/pic.png" style="position:absolute;left:10px;top:120px;width:80px;height:80px">'
          + '<a href="http://127.0.0.1:9/img" style="position:absolute;left:110px;top:120px"><img src="/pic.png" style="width:80px;height:80px;display:block"></a>'
          + '<video src="/none.mp4" controls style="position:absolute;left:210px;top:120px;width:200px;height:80px"></video>'
          + '<p id="sel" style="position:absolute;left:430px;top:120px;margin:0;font-size:20px;white-space:nowrap">some picked words here</p>'
          + '<textarea style="position:absolute;left:10px;top:230px;width:190px;height:60px"></textarea>'
          + '<textarea id="typo" style="position:absolute;left:220px;top:230px;width:190px;height:60px" spellcheck="true">teh qick brwn</textarea></body>');
      });
      made.listen(0, '127.0.0.1', () => resolve(made));
    });
    await page(`(() => { houseTest.openInObscura('http://127.0.0.1:${site.address().port}/'); return true; })()`);
    await sleep(3000);
    // The page's menu changes with what was clicked: the exact items for each kind of spot.
    const pageGuest = require("electron").webContents.getAllWebContents().find((item) => item.getType() === 'webview' && !item.isDestroyed());
    const webMenu = async (name, spot, want) => {
      const shown = bare(await rightClick('webview', spot));
      report(JSON.stringify(shown) === JSON.stringify(want), `page menu on ${name}: ${JSON.stringify(shown)}${JSON.stringify(shown) === JSON.stringify(want) ? '' : ` wanted ${JSON.stringify(want)}`}`);
      return shown;
    };
    const link = ['Open Link in New Tab', 'Open Link in Split View', 'Copy Link Address', 'Copy Link Text', 'Save Link As'];
    const picture = ['Open Image in New Tab', 'Save Image As', 'Copy Image', 'Copy Image Address'];
    await webMenu('a link', { x: 60, y: 60 }, [...link, 'Inspect']);
    await webMenu('a picture', { x: 50, y: 160 }, [...picture, 'Inspect']);
    const linked = bare(await rightClick('webview', { x: 150, y: 160 }));
    report(linked.slice(0, 3).join() === link.slice(0, 3).join() && picture.every((label) => linked.includes(label)) && linked.at(-1) === 'Inspect', `page menu on a linked picture has link and picture groups: ${JSON.stringify(linked)}`);
    const video = await webMenu('a video', { x: 300, y: 140 }, ['Play', 'Mute', 'Loop', 'Open Video in New Tab', 'Save Video As', 'Copy Video Address', 'Inspect']);
    await pageGuest.executeJavaScript(`getSelection().selectAllChildren(document.getElementById('sel')); true`);
    await webMenu('picked words', { x: 480, y: 130 }, ['Copy', 'Search Google for "some picked words here"', 'Inspect']);
    await pageGuest.executeJavaScript(`getSelection().removeAllRanges(); true`);
    await webMenu('an empty text box', { x: 100, y: 260 }, ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Paste as Plain Text', 'Select All', 'Inspect']);
    const typo = bare(await rightClick('webview', { x: 240, y: 245 }));
    console.log(`INFO misspelled word menu (needs a spell-check dictionary): ${JSON.stringify(typo)}`);
    report(typo.includes('Add to Dictionary') ? typo.at(-1) === 'Inspect' && typo.indexOf('Add to Dictionary') < typo.indexOf('Undo') : typo.includes('Undo'), 'a misspelled word puts spelling first (or, with no dictionary, the plain text-box menu shows)');
    const state = await rightClick('webview', { x: 100, y: 260 });
    report(state && state.filter((label) => label.startsWith('-')).length >= 3, `greyed items follow the box (empty: Undo, Redo, Cut, Copy off): ${JSON.stringify(state)}`);
    const onPage = await webMenu('a blank page', { x: 60, y: 400 }, ['Back', 'Forward', 'Reload', 'Print…', 'Copy Page Address', 'Inspect']);
    report(onPage.length > 0 && !onPage.includes('Cut'), 'plain space has no Cut, Copy, Paste or Select All');
    // The menu opens and stays inside the window, at each Station zoom. (Where the mouse really is
    // can't be faked: a sent click doesn't move the cursor, so that part is checked by hand.)
    const was0 = win.webContents.getZoomFactor();
    for (const stationZoom of [1, 1.2]) {
      win.webContents.setZoomFactor(was0 * stationZoom);
      await sleep(600);
      const shown = await rightClick('webview', { x: 60, y: 60 });
      const inside = await page(`(() => { const b = document.getElementById('menu').getBoundingClientRect(); const a = document.querySelector('.app').getBoundingClientRect(); return !document.getElementById('menu').hidden && b.left >= a.left && b.top >= a.top && b.right <= a.right && b.bottom <= a.bottom; })()`);
      report(shown && inside, `the page's menu opens inside the drawn window (Station ${stationZoom * 100}%)`);
    }
    win.webContents.setZoomFactor(was0);
    await page(`closeMenu(); true`);
    site.close();
    await page(ONE_TAB_LEFT_CODE);
    await sleep(500);

    // The Local AI page and a chat message.
    await page(`openLlama(); true`).catch(() => {});
    await sleep(1200);
    await check('the Local AI page', '#llama-view');
    await page(`closeMenu(); true`);
    await page(ONE_TAB_LEFT_CODE);
    await sleep(500);

    await page(`houseTest.navigate(houseTest.state.projects); true`);
    await sleep(1000);
    // A file's menu starts its own section with Open, which does what a double-click does.
    const fileMenu = await check('a file', '#rows [data-path$="/readme.md"]', ['Open', 'Copy as Path']);
    report(fileMenu && fileMenu[4] === 'Open', `Open comes right after the shared four: ${JSON.stringify((fileMenu || []).slice(4, 6))}`);
    await press('Open');
    await sleep(1500);
    const opened = await page(`houseTest.state.active.kind + ':' + houseTest.state.active.path`);
    report(/^doc:.*\/readme\.md$/.test(opened), `Open opens the file: ${opened}`);
    await page(ONE_TAB_LEFT_CODE);
    await sleep(500);

    // An html file: "Open in Web Browser" right after Open, showing the page in a Web Browser tab,
    // with its CSS applied, and not counted among the home page's most visited sites.
    const fs = require('fs');
    const pages = (await page(`houseTest.state.projects`)) + '/Web Page Test';
    fs.mkdirSync(pages, { recursive: true });
    fs.writeFileSync(pages + '/page.html', '<!doctype html><link rel="stylesheet" href="style.css"><h1 id="t">Hello page</h1>');
    fs.writeFileSync(pages + '/style.css', '#t { color: rgb(12, 34, 56); }');
    await page(`houseTest.navigate(${JSON.stringify(pages)}); true`);
    await sleep(1200);
    const htmlMenu = await check('an html file', '#rows [data-path$="/page.html"]', ['Open', 'Open in Web Browser']);
    report(htmlMenu && htmlMenu[4] === 'Open' && htmlMenu[5] === 'Open in Web Browser', `Open in Web Browser comes right after Open: ${JSON.stringify((htmlMenu || []).slice(4, 7))}`);
    report(htmlMenu && !htmlMenu.includes('Open in Windows App'), 'an html file offers no Windows app');
    await press('Open in Web Browser');
    await sleep(3000);
    const tab = await page(`houseTest.state.active.kind + '|' + houseTest.state.active.url + '|' + houseTest.state.active.previewOf`);
    report(/^obscura\|http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/page\.html\|file:/.test(tab), `a Web Browser tab opens on the local page: ${tab}`);
    const { webContents } = require('electron');
    const guest = webContents.getAllWebContents().find((item) => item.getType() === 'webview' && !item.isDestroyed());
    const colour = guest ? await guest.executeJavaScript(`getComputedStyle(document.getElementById('t')).color`).catch(() => null) : null;
    report(colour === 'rgb(12, 34, 56)', `the page's CSS is applied: ${colour}`);
    const counted = await page(`(async () => { await call('prefs'); return JSON.stringify(typeof obscuraSites === 'undefined' ? null : obscuraSites); })()`);
    report(!/127\.0\.0\.1|localhost|Web Page Test/.test(counted || ''), `the page is not among the most visited sites: ${counted}`);
    await page(ONE_TAB_LEFT_CODE);
    await sleep(500);
    fs.rmSync(pages, { recursive: true, force: true });

    // Up on a file's own tab: shows its folder with the file picked.
    await page(`houseTest.navigate(houseTest.state.projects); true`);
    await sleep(800);
    await page(`openDoc(houseTest.state.projects + '/readme.md').then(() => true)`);
    await sleep(1500);
    report(await page(`!document.getElementById('up').disabled`), 'on a file tab, Up is pressable');
    await page(`document.getElementById('up').click(); true`);
    await sleep(1500);
    const upTo = await page(`houseTest.state.active.kind + ':' + houseTest.state.active.path + ':' + [...houseTest.state.selected]`);
    report(upTo === 'files:' + (await page(`houseTest.state.projects`)) + ':' + (await page(`houseTest.state.projects`)) + '/readme.md', `Up from a file shows its folder with it picked: ${upTo}`);
    await page(ONE_TAB_LEFT_CODE);
    await sleep(500);

    // A disabled blue button must not look like an enabled one.
    const looks = await page(`(() => {
      const make = (off) => { const b = document.createElement('button'); b.className = 'btn primary'; b.disabled = off; document.body.append(b); const bg = getComputedStyle(b).backgroundColor; b.remove(); return bg; };
      return [make(false), make(true)];
    })()`);
    report(looks[0] !== looks[1], `a disabled primary button has its own background: ${JSON.stringify(looks)}`);

    // Where a menu opens and how it closes: a real right-click on a Files row, the tab strip, a terminal
    // and a Web Browser page. The menu's top left must land on the click (12 px slack), and Esc and a
    // real left click in the page under it must each close it. Run with the window as it is, and again
    // with the drawn window moved away from the corner (offset bugs only show then).
    {
      const { webContents: contents } = require('electron');
      const site = await new Promise((resolve) => {
        const made = http.createServer((_request, response) => {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<body style="margin:0"><p style="height:600px">plain words</p></body>');
        });
        made.listen(0, '127.0.0.1', () => resolve(made));
      });
      const where = (selector, spot) => page(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return null;
        const box = node.getBoundingClientRect();
        const spot = ${JSON.stringify(spot)};
        return { x: box.left + (spot.x < 0 ? box.width + spot.x : spot.x), y: box.top + (spot.y < 0 ? box.height + spot.y : spot.y), f: window.outerWidth / window.innerWidth };
      })()`);
      const menuAt = () => page(`(() => {
        const m = document.getElementById('menu');
        if (m.hidden) return null;
        const b = m.getBoundingClientRect();
        const a = document.querySelector('.app').getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height, app: { l: a.left, t: a.top, r: a.right, b: a.bottom } };
      })()`);
      // A menu that doesn't fit is pushed back inside the window (4 px from its edge), so that's where it should be.
      const clamp = (want, got) => ({
        x: Math.max(got.app.l + 4, Math.min(want.x, got.app.r - got.w - 4)),
        y: Math.max(got.app.t + 4, Math.min(want.y, got.app.b - got.h - 4)),
      });
      // The Web Browser's mouse spot is read from the screen by main (lib/obscura.js), which a test
      // can't move, so the cursor is faked: on the click ('cursor'), or far away so the page's own spot is used ('away').
      const screen = require('electron').screen;
      const realCursor = screen.getCursorScreenPoint;
      const cursorAt = (css) => {
        const bounds = win.getContentBounds();
        const zoom = win.webContents.getZoomFactor();
        screen.getCursorScreenPoint = () => (css ? { x: Math.round(bounds.x + css.x * zoom), y: Math.round(bounds.y + css.y * zoom) } : { x: -9000, y: -9000 });
      };
      // The click goes to Station's window, as the mouse does: it lands on the page under it.
      const realRight = async (p) => {
        const send = (event) => win.webContents.sendInputEvent({ ...event, x: Math.round(p.x * p.f) + (event.dx || 0), y: Math.round(p.y * p.f) });
        for (let attempt = 1; attempt <= 6; attempt += 1) { // headless drawing sometimes misses the first presses (main too)
          await page(`closeMenu(); true`);
          // A real mouse moves over the page first, so a page that has been clicked sees it arrive.
          send({ type: 'mouseMove', dx: 6 });
          await sleep(100);
          send({ type: 'mouseMove' });
          await sleep(150);
          for (const type of ['mouseDown', 'mouseUp']) send({ type, button: 'right', clickCount: 1 });
          for (let wait = 0; wait < 15 && !(await menuAt()); wait += 1) await sleep(100); // the page answers over IPC
          if (await menuAt()) {
            if (attempt > 1) console.log(`INFO right-click needed ${attempt} tries`);
            return;
          }
        }
      };
      const click = async (p) => {
        for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(p.x * p.f), y: Math.round(p.y * p.f), button: 'left', clickCount: 1 });
        await sleep(300);
      };
      const esc = async () => {
        for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
        await sleep(300);
      };
      const runCases = async (layout) => {
        const cases = [];
        const tryCase = async (name, selector, spot, closeSelector, closeSpot, cursor = undefined) => {
          const label = cursor === undefined ? name : `${name} (mouse ${cursor ? 'read' : 'unreadable'})`;
          const open = async () => {
            if (cursor === undefined) return rightClick(selector, spot);
            const at = await where(selector, spot);
            cursorAt(cursor ? at : null);
            await realRight(at);
            return true;
          };
          const want = await where(selector, spot);
          const shown = await open();
          const got = await menuAt();
          if (!want || !shown || !got) return report(false, `${layout}: ${label}: no menu opened`);
          const goal = clamp(want, got);
          const dx = Math.round(got.x - goal.x);
          const dy = Math.round(got.y - goal.y);
          cases.push(`${label} ${dx},${dy}`);
          report(Math.abs(dx) <= 12 && Math.abs(dy) <= 12, `${layout}: menu on ${label} opens at the click (off by ${dx}, ${dy} px; click at ${Math.round(want.x)}, ${Math.round(want.y)}; menu ${Math.round(got.x)}, ${Math.round(got.y)})`);
          await shot(`menu-${name.replace(/ /g, '-')}${cursor === undefined ? '' : cursor ? '-cursor' : '-away'}-${layout}`);
          await esc();
          report((await menuAt()) === null, `${layout}: Esc closes the menu on ${label}`);
          await open();
          await click(await where(closeSelector, closeSpot));
          report((await menuAt()) === null, `${layout}: a left click in the page (${closeSelector}) closes the menu on ${label}`);
        };
        await page(ONE_TAB_LEFT_CODE);
        await page(`houseTest.navigate(houseTest.state.projects); true`);
        await sleep(1200);
        await tryCase('a Files row', '#rows [data-path$="/readme.md"]', { x: 40, y: 8 }, '#rows', { x: -40, y: -20 });
        const strip = await page(`(() => { const b = document.querySelector('.tabs').getBoundingClientRect(); return b.width; })()`);
        await tryCase('the tab strip', '.tabs', { x: strip - 30, y: 12 }, '#rows', { x: 300, y: -20 });
        await page(`houseTest.openTerminal({ cwd: houseTest.state.home }).then(() => true)`);
        await sleep(2500);
        await tryCase('a terminal tab', '.term-host:not([hidden]) .xterm-screen', { x: 120, y: 90 }, '.term-host:not([hidden]) .xterm-screen', { x: -40, y: 40 });
        await page(`houseTest.closeTab(houseTest.state.active); true`);
        await sleep(600);
        await page(`houseTest.openInObscura('http://127.0.0.1:${site.address().port}/'); true`);
        // Software drawing (headless) can take longer than 3 s: wait for the page itself.
        for (let wait = 0; wait < 50 && !(await page(`houseTest.state.active.kind === 'obscura' && houseTest.state.active.loading === false && !!houseTest.state.active.url`)); wait += 1) await sleep(200);
        await sleep(1000);
        await tryCase('a browser tab', 'webview', { x: 120, y: 90 }, 'webview', { x: -40, y: 40 }, true);
        await tryCase('a browser tab', 'webview', { x: 120, y: 90 }, 'webview', { x: -40, y: 40 }, false);
        await page(ONE_TAB_LEFT_CODE);
        await sleep(500);
        console.log(`INFO ${layout} menu offsets: ${cases.join('; ')}`);
      };
      await runCases('default');
      // Move the drawn window: not maximized, away from the top left corner.
      const kept = await page(`(() => { const a = document.querySelector('.app'); const s = a.style; const old = [s.left, s.top, s.width, s.height]; s.left = '14%'; s.top = '17%'; s.width = '66%'; s.height = '70%'; return old; })()`);
      await sleep(800);
      const moved = await page(`(() => { const b = document.querySelector('.app').getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height), window.innerWidth, window.innerHeight, window.outerWidth / window.innerWidth]; })()`);
      console.log(`INFO moved window box: ${JSON.stringify(moved)}`);
      report(moved[0] > 50 && moved[1] > 50, 'the drawn window is away from the corner');
      await runCases('moved');
      await page(`(() => { const s = document.querySelector('.app').style; [s.left, s.top, s.width, s.height] = ${JSON.stringify(kept)}; return true; })()`);
      screen.getCursorScreenPoint = realCursor;
      site.close();
    }

    // Every width, with a project picked: the top bar's buttons never spill over its edge.
    await page(`houseTest.navigate(houseTest.state.projects); true`);
    await sleep(1000);
    await page(`(() => { const entry = visibleEntries().find((item) => item.name === 'SampleApp'); setSelection([entry.path], entry.path); return true; })()`);
    const was = win.getBounds();
    const spill = [];
    const widths = [];
    for (const up of [false, true]) {
      await page(`state.status = { ...state.status, rooms: ${up ? `[{ name: 'SampleApp' }]` : '[]'} }; renderChrome(); true`);
      for (let width = 1800; width >= 560; width -= 20) {
        win.setBounds({ ...was, width });
        await sleep(120);
        const seen = await page(`(() => { const bar = document.querySelector('.commandbar'); const last = [...bar.children].filter((node) => node.offsetParent).pop(); return [window.innerWidth, Math.round(last.getBoundingClientRect().right - bar.getBoundingClientRect().right)]; })()`);
        widths.push(seen[0]);
        if (seen[1] > 0) spill.push(`${up ? 'room open' : 'room closed'} ${seen[0]}px: ${seen[1]}px`);
      }
    }
    win.setBounds(was);
    await page(`state.status = { ...state.status, rooms: [] }; renderChrome(); true`);
    report(Math.max(...widths) - Math.min(...widths) > 800, `the window really changed width: ${Math.min(...widths)} to ${Math.max(...widths)}`);
    report(!spill.length, `the top bar fits at every width: ${JSON.stringify(spill.slice(0, 6))}`);
  },
};

const ONE_TAB_LEFT_CODE = `(async () => {
  document.getElementById('new-tab').click();
  await new Promise((done) => setTimeout(done, 300));
  const keep = houseTest.state.active;
  for (const tab of [...houseTest.state.tabs]) if (tab !== keep) await houseTest.closeTab(tab);
  return true;
})()`;
