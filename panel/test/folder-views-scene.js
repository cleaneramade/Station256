// Each folder keeps its own view and sort, in the hidden copy:
//   SHOT_PATH=$PWD/panel/test/stub SHOT_HOME=/tmp/house-shots-fv panel/test/shotrun.sh folderViews
const fs = require('fs');
const path = require('path');

module.exports = {
  async folderViews({ page, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} folderViews: ${String(text).replace(/\s+/g, ' ').slice(0, 360)}`);
    const home = await page('houseTest.state.home');
    const [vids, docs] = ['FvVideos', 'FvDocuments'].map((name) => path.join(home, name));
    for (const dir of [vids, docs]) {
      fs.mkdirSync(dir, { recursive: true });
      for (const name of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(dir, name), name);
    }
    const go = async (dir) => { await page(`(async () => { houseTest.navigate(${JSON.stringify(dir)}); return true; })()`); await sleep(700); };
    const look = () => page('(() => ({ v: houseTest.state.viewMode, by: houseTest.state.sortBy, asc: houseTest.state.sortAsc, on: document.getElementById("view-details").classList.contains("on"), names: [...document.querySelectorAll("#rows .row .name-text")].map((n) => n.textContent).join() }))()');
    const same = (got, want) => Object.entries(want).every(([key, value]) => got[key] === value);

    await go(vids);
    await page("(() => { setViewMode('large'); setSort('name'); return true; })()"); // name descending
    await sleep(300);
    let got = await look();
    report(same(got, { v: 'large', by: 'name', asc: false, on: false }), `first folder set to large icons, name descending: ${JSON.stringify(got)}`);
    await go(docs);
    got = await look();
    report(same(got, { v: 'details', by: 'name', asc: true, names: 'a.txt,b.txt,c.txt', on: true }), `the other folder stays Details, name ascending: ${JSON.stringify(got)}`);
    await page("(() => { setSort('size'); return true; })()");
    await go(vids);
    got = await look();
    report(same(got, { v: 'large', by: 'name', asc: false }), `back in the first folder, its own choice returns: ${JSON.stringify(got)}`);

    // Ctrl+R: the choices come back from the saved file.
    await page('window.__before = 1; true');
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control'] });
    let back = false;
    for (let i = 0; i < 100 && !back; i += 1) {
      await sleep(300);
      back = await page('window.__before === undefined && Boolean(window.houseTest) && houseTest.state.tabs.length > 0 && houseTest.state.tabs.every((t) => t.listed)').catch(() => false);
    }
    await sleep(1500);
    got = await look();
    report(back && same(got, { v: 'large', by: 'name', asc: false }), `after Ctrl+R the first folder is still large, name descending: ${JSON.stringify(got)}`);
    await go(docs);
    got = await look();
    report(same(got, { v: 'details', by: 'size' }), `after Ctrl+R the other folder still sorts by size: ${JSON.stringify(got)}`);

    // Two Files halves at once: each shows its own folder's look, and the toolbar follows the front one.
    await page('document.getElementById("new-tab").click(); true');
    await sleep(500);
    await go(vids);
    const paired = await page(`(() => { const [a, b] = houseTest.state.tabs.slice(-2); if (a.splitWith) return true; return false; })()`);
    if (!paired) {
      await page(`(() => { const [a, b] = houseTest.state.tabs.slice(-2); pairTabs(a, b, 'right'); return true; })()`);
      await sleep(900);
    }
    const halves = await page(`(() => { const [a, b] = houseTest.state.tabs.slice(-2); return [a, b].map((t) => ({ path: t.path.split('/').pop(), icons: t.view.rows.classList.contains('icon-view'), view: t.view.rows.dataset.view })); })()`);
    report(halves[0].view !== halves[1].view && halves.filter((h) => h.icons).length === 1, `a split shows two views at once: ${JSON.stringify(halves)}`);
    // The toolbar follows whichever half is in front.
    let toolbarOk = true;
    for (const at of [0, 1]) {
      await page(`(() => { const t = houseTest.state.tabs.slice(-2)[${at}]; houseTest.activateTab(t); return true; })()`);
      await sleep(500);
      const l = await look();
      const icons = await page('houseTest.state.active.view.rows.classList.contains("icon-view")');
      if ((l.v !== 'details') !== icons || l.on === icons) toolbarOk = false;
    }
    report(toolbarOk, 'the toolbar matches whichever half is in front');
  },
};
