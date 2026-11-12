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
      const where = guest ? spot : at;
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
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<body style="margin:0"><a href="http://127.0.0.1:9/next" style="display:block;height:200px;font-size:40px">a link</a><p style="height:400px">plain words</p></body>');
      });
      made.listen(0, '127.0.0.1', () => resolve(made));
    });
    await page(`(() => { houseTest.openInObscura('http://127.0.0.1:${site.address().port}/'); return true; })()`);
    await sleep(3000);
    const onLink = await check('a link in the Web Browser', 'webview', ['Open Link in New Tab', 'Copy Link', 'Back', 'Reload'], { x: 60, y: 60 });
    report(onLink && onLink[3] === 'Select All', 'Select All works in a page');
    const onPage = await check('a page in the Web Browser', 'webview', ['Back', 'Forward', 'Reload'], { x: 60, y: 400 });
    report(onPage && !onPage.includes('Copy Link'), 'plain space has no link items');
    // The menu opens and stays inside the window, at each Station zoom. (Where the mouse really is
    // can't be faked: a sent click doesn't move the cursor, so that part is checked by hand.)
    const was0 = win.webContents.getZoomFactor();
    for (const stationZoom of [1, 1.2]) {
      win.webContents.setZoomFactor(was0 * stationZoom);
      await sleep(600);
      const shown = await rightClick('webview', { x: 60, y: 60 });
      const inside = await page(`(() => { const b = document.getElementById('menu').getBoundingClientRect(); return !document.getElementById('menu').hidden && b.left >= 0 && b.top >= 0 && b.right <= window.innerWidth && b.bottom <= window.innerHeight; })()`);
      report(shown && inside, `the page's menu opens inside the window (Station ${stationZoom * 100}%)`);
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
