// Scene for shots.js: tablesAudit. Checks every list that has columns: the folder Details view (sorting,
// resizing, header against cells, sideways scroll, long names, empty folder, the elastic edge), search
// results, the Trash, and Home's Recent files. Run with a throwaway HOME:
//   SHOT_PATH=$PWD/test/stub SHOT_HOME=/tmp/house-shots-cols test/shotrun.sh tablesAudit
const fs = require('fs');
const os = require('os');
const path = require('path');

const KB = 1024;
const LONG = `${'long-name-'.repeat(15)}end.txt`; // 150 letters
// name, size in bytes, modified date (the dates are picked so month names sort differently from real dates)
const FILES = [
  ['a.txt', 9, '2025-12-01'], ['b.md', 10 * KB, '2025-01-02'], ['c.png', 2 * KB * KB, '2024-06-15'],
  ['d.txt', 100, '2026-03-03'], ['E.txt', 1.5 * KB, '2025-11-30'], ['f10.txt', 50, '2025-05-05'], ['f9.txt', 50, '2025-05-05'], [LONG, 700, '2025-08-08'],
];
const DIRS = [['zeta', '2025-02-02'], ['Alpha', '2025-09-09'], ['beta10', '2024-12-12'], ['beta2', '2026-01-01']];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const stamp = (file, date) => { const when = new Date(`${date}T12:00:00`); fs.utimesSync(file, when, when); };

async function tablesAudit({ page, shot, sleep: wait, win }) {
  const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} tablesAudit: ${text}`);
  const home = os.homedir();
  if (!home.startsWith('/tmp/')) return report(false, 'needs the throwaway HOME');
  const factor = await page('window.outerWidth / window.innerWidth');
  const base = win.getSize();
  const px = (n) => Math.round(n * 10) / 10;
  const room0 = await page(`document.getElementById('files-view').clientWidth`);

  // ---- Fixtures
  const dir = path.join(home, 'Documents', 'Cols');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, date] of DIRS) { fs.mkdirSync(path.join(dir, name)); stamp(path.join(dir, name), date); }
  for (const [name, size, date] of FILES) { fs.writeFileSync(path.join(dir, name), Buffer.alloc(Math.round(size), 'x')); stamp(path.join(dir, name), date); }
  const empty = path.join(home, 'Documents', 'EmptyOne');
  fs.mkdirSync(empty, { recursive: true });
  const big = path.join(home, 'Documents', 'Big');
  fs.rmSync(big, { recursive: true, force: true });
  fs.mkdirSync(big, { recursive: true });
  for (let i = 1; i <= 400; i += 1) fs.writeFileSync(path.join(big, `file-${String(i).padStart(3, '0')}.txt`), 'x');
  const go = async (target) => { await page(`(() => { houseTest.navigate(${JSON.stringify(target)}); return true; })()`); await wait(1200); };
  await page(`(() => { setViewMode('details'); return true; })()`);

  // ---- Page helpers
  // Header buttons against the cells of one row: per column, how far the cell's left edge and width are from the header's.
  const ALIGN = (index = 0, selector = '#rows .row[data-path]') => `(() => {
    const row = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
    if (!row) return { error: 'no row' };
    const out = [];
    for (const button of document.querySelectorAll('#columns button')) {
      if (!button.offsetWidth) continue;
      const key = button.dataset.sort;
      const cell = row.querySelector('.cell-' + key);
      if (!cell || !cell.offsetWidth) { out.push({ key, missing: true }); continue; }
      const h = button.getBoundingClientRect();
      const c = cell.getBoundingClientRect();
      out.push({ key, dLeft: c.left - h.left, dWidth: c.width - h.width, w: h.width });
    }
    const rows = document.getElementById('rows');
    return { out, scrollLeft: rows.scrollLeft, over: rows.scrollWidth - rows.clientWidth, squeezed: document.getElementById('files-view').classList.contains('columns-squeezed'), vbar: rows.offsetWidth - rows.clientWidth };
  })()`;
  const worst = (info) => (info.error ? 999 : info.out.reduce((m, c) => (c.missing ? Math.max(m, 999) : Math.max(m, Math.abs(c.dLeft), Math.abs(c.dWidth))), 0));
  const names = () => page(`[...document.querySelectorAll('#rows .row[data-path]')].map((r) => r.querySelector('.name-text').textContent)`);
  const cellsOf = (key) => page(`[...document.querySelectorAll('#rows .row[data-path] .cell-${key}')].map((c) => c.textContent)`);
  const clickHead = async (key) => { await page(`(() => { document.querySelector('#columns [data-sort="${key}"]').click(); return true; })()`); await wait(250); };
  const mark = () => page(`(() => { const m = document.getElementById('sort-mark'); return { on: !m.hidden && m.parentElement.dataset.sort }; })()`);
  const sortState = () => page(`({ by: houseTest.state.sortBy, asc: houseTest.state.sortAsc })`);

  // ================= 1. Folder Details: sorting
  await go(dir);
  const dirNames = DIRS.map(([n]) => n);
  const expectOrder = (key, asc) => {
    const dirsPart = DIRS.map(([name, date]) => ({ name, mtime: +new Date(`${date}T12:00:00`), size: 0 }));
    const filesPart = FILES.map(([name, size, date]) => ({ name, mtime: +new Date(`${date}T12:00:00`), size }));
    const cmp = (a, b) => (key === 'mtime' ? a.mtime - b.mtime : key === 'size' ? a.size - b.size : collator.compare(a.name, b.name));
    const sort = (list) => [...list].sort((a, b) => (asc ? cmp(a, b) : -cmp(a, b)));
    return [...sort(dirsPart), ...sort(filesPart)].map((e) => e.name);
  };
  // Equal keys may fall either way, so a list matches when it is in order by the key (not by an exact list).
  const inOrder = (list, key, asc) => {
    const info = new Map([...DIRS.map(([n, d]) => [n, { mtime: +new Date(`${d}T12:00:00`), size: 0, dir: true }]), ...FILES.map(([n, s, d]) => [n, { mtime: +new Date(`${d}T12:00:00`), size: s, dir: false }])]);
    const value = (n) => (key === 'name' ? n : info.get(n)[key]);
    const cmp = (a, b) => (key === 'name' ? collator.compare(a, b) : a - b);
    const groups = [list.filter((n) => info.get(n).dir), list.filter((n) => !info.get(n).dir)];
    return list.slice(0, 4).every((n) => info.get(n).dir) && groups.every((g) => g.every((n, i) => !i || (asc ? cmp(value(g[i - 1]), value(n)) <= 0 : cmp(value(g[i - 1]), value(n)) >= 0)));
  };
  void expectOrder;
  for (const key of ['name', 'mtime', 'size']) {
    await clickHead(key);
    const first = await sortState();
    const listA = await names();
    await clickHead(key);
    const second = await sortState();
    const listB = await names();
    const m = await mark();
    const okA = inOrder(listA, key, first.asc);
    const okB = inOrder(listB, key, second.asc);
    console.log(`INFO tablesAudit sort ${key}: 1st asc=${first.asc} ${JSON.stringify(listA.map((n) => n.slice(0, 8)))} | 2nd asc=${second.asc} ${JSON.stringify(listB.map((n) => n.slice(0, 8)))}`);
    report(okA && okB && first.asc !== second.asc, `sort by ${key}: first click then reverse both match the real ${key === 'name' ? 'natural name' : key === 'mtime' ? 'date' : 'byte size'} order, folders grouped on top both ways (1st ${okA}, 2nd ${okB})`);
    report(m.on === key, `sort by ${key}: the arrow sits on its heading (on ${m.on})`);
    void dirNames;
  }
  // Type, and the AI columns (no AI notes here, so only the click, the arrow and the reverse can be checked).
  await clickHead('type');
  const typeAsc = (await sortState()).asc;
  const typeCells = await cellsOf('type');
  const typeOk = typeCells.slice(4).every((t, i, all) => !i || (typeAsc ? collator.compare(all[i - 1], t) <= 0 : collator.compare(all[i - 1], t) >= 0));
  report(typeOk && (await mark()).on === 'type', `sort by type: files run in type order and the arrow moves (${JSON.stringify([...new Set(typeCells)])})`);
  await clickHead('type');
  report((await sortState()).asc !== typeAsc, 'sort by type: second click reverses');
  for (const key of ['editor', 'reader', 'tokens']) {
    await clickHead(key);
    const a = (await sortState()).asc;
    const sameHead = (await mark()).on === key;
    await clickHead(key);
    report(sameHead && (await sortState()).asc !== a, `sort by ${key}: click sorts, arrow moves, second click reverses`);
  }
  // Ties: files of the same size fall in name order (f9 before f10), as File Explorer does.
  await clickHead('size');
  if (!(await sortState()).asc) await clickHead('size');
  const tie = await names();
  report(tie.indexOf('f9.txt') < tie.indexOf('f10.txt'), `equal sizes keep name order, natural (${JSON.stringify(tie.filter((n) => /^f\d/.test(n)))})`);
  console.log(`INFO tablesAudit shown dates ${JSON.stringify((await cellsOf('mtime')).slice(0, 3))} sizes ${JSON.stringify((await cellsOf('size')).slice(4, 8))}`);
  await clickHead('name');
  if (!(await sortState()).asc) await clickHead('name');

  // ================= 2. Folder Details: alignment (default size, 900 wide, 120% zoom, 760 wide) and long names
  const longRow = `[...document.querySelectorAll('#rows .row[data-path]')].findIndex((r) => r.querySelector('.name-text').textContent.length > 100)`;
  const checkAlign = async (label) => {
    await wait(900);
    const first = await page(ALIGN(0));
    const idx = await page(longRow);
    const long = await page(ALIGN(idx));
    const last = await page(ALIGN(11));
    const w = Math.max(worst(first), worst(long), worst(last));
    const room = await page(`({ inner: innerWidth, room: document.getElementById('files-view').clientWidth, zoom: devicePixelRatio, win: ${JSON.stringify(win.getSize())}.join('x') })`);
    console.log(`INFO tablesAudit align ${label}: ${JSON.stringify({ cols: first.out && first.out.map((c) => c.key), worst: px(w), squeezed: first.squeezed, vbar: first.vbar, over: first.over, ...room })}`);
    report(w <= 1, `header lines up with the cells, first, long-named and last row, ${label} (worst ${px(w)} px, ${first.out ? first.out.length : 0} columns${first.squeezed ? ', squeezed' : ''})`);
    return first;
  };
  await checkAlign('1240 wide');
  const longInfo = await page(`(() => { const r = [...document.querySelectorAll('#rows .row[data-path]')].find((n) => n.querySelector('.name-text').textContent.length > 100); const t = r.querySelector('.name-text'); const s = getComputedStyle(t); const rr = r.getBoundingClientRect(); return { clipped: t.scrollWidth > t.clientWidth, ellipsis: s.textOverflow, overflow: s.overflow, rowH: rr.height, nameW: r.querySelector('.cell-name').getBoundingClientRect().width }; })()`);
  report(longInfo.clipped && longInfo.ellipsis === 'ellipsis' && longInfo.overflow === 'hidden' && Math.round(longInfo.rowH) === 30, `a 150-letter name is cut with an ellipsis and the row stays 30 px tall (${JSON.stringify(longInfo)})`);
  await shot('tables-details');
  win.setSize(900, 600);
  await checkAlign('900 wide');
  await shot('tables-details-900');
  win.setSize(760, 560);
  await checkAlign('760 wide');
  await shot('tables-details-760');
  win.setSize(base[0], base[1]);
  const zoom0 = win.webContents.getZoomFactor();
  win.webContents.setZoomFactor(1.2);
  await checkAlign('120% zoom');
  await shot('tables-details-zoom');
  win.setSize(900, 600);
  await checkAlign('120% zoom at 900 wide');
  win.webContents.setZoomFactor(zoom0);
  win.setSize(base[0], base[1]);
  // The window takes a moment to settle: wait until the list is as wide as it was at the start.
  for (let tries = 0; tries < 20; tries += 1) {
    await wait(300);
    if (Math.abs((await page(`document.getElementById('files-view').clientWidth`)) - room0) < 2) break;
  }

  // ================= 3. Resizing with real mouse drags on the column edge
  const gripBox = (key) => page(`(() => { const g = document.querySelector('#columns [data-sort="${key}"] .col-grip').getBoundingClientRect(); const b = document.querySelector('#columns [data-sort="${key}"]').getBoundingClientRect(); return { x: g.left + 2, y: g.top + g.height / 2, w: b.width }; })()`);
  const mouse = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(x * factor), y: Math.round(y * factor), button: 'left', clickCount: 1, ...extra });
  const drag = async (key, by) => {
    const g = await gripBox(key);
    mouse('mouseMove', g.x, g.y);
    await wait(80);
    mouse('mouseDown', g.x, g.y);
    for (let s = 1; s <= 10; s += 1) { mouse('mouseMove', g.x + (by * s) / 10, g.y, { modifiers: ['leftButtonDown'] }); await wait(30); }
    mouse('mouseUp', g.x + by, g.y);
    await wait(400);
    return g.w;
  };
  const widthOf = (key) => page(`document.querySelector('#columns [data-sort="${key}"]').getBoundingClientRect().width`);
  const savedWidths = () => page(`(async () => (await call('columns')).widths)()`);
  const w0 = await widthOf('mtime');
  await drag('mtime', 60);
  const w1 = await widthOf('mtime');
  report(Math.abs(w1 - (w0 + 60)) <= 2, `dragging the Date edge 60 px right widens it (${px(w0)} to ${px(w1)})`);
  const alignedAfter = await page(ALIGN(0));
  report(worst(alignedAfter) <= 1, `cells follow the resized header (worst ${px(worst(alignedAfter))} px)`);
  const saved = await savedWidths();
  report(saved && Math.abs(saved.mtime - w1) <= 1, `the new width is remembered (saved ${saved && saved.mtime})`);
  await drag('size', -400);
  const wSize = await widthOf('size');
  report(wSize === 50, `dragging Size's edge far left stops at its minimum 50 px (${px(wSize)})`);
  await drag('mtime', -400);
  const wMin = await widthOf('mtime');
  report(wMin === 50, `dragging Date's edge far left stops at 50 px (${px(wMin)})`);
  const alignedMin = await page(ALIGN(0));
  report(worst(alignedMin) <= 1, `cells still line up at the minimum widths (worst ${px(worst(alignedMin))} px)`);
  const spill = await page(`(() => { const l = document.querySelector('#columns [data-sort="mtime"] .col-label'); return { clipped: l.scrollWidth > l.clientWidth, ellipsis: getComputedStyle(l).textOverflow }; })()`);
  report(spill.clipped && spill.ellipsis === 'ellipsis', `a heading wider than its narrow column gets an ellipsis (${JSON.stringify(spill)})`);
  // Double-click fits it to its contents.
  const dg = await gripBox('mtime');
  mouse('mouseMove', dg.x, dg.y);
  await wait(80);
  for (let c = 1; c <= 2; c += 1) { mouse('mouseDown', dg.x, dg.y, { clickCount: c }); mouse('mouseUp', dg.x, dg.y, { clickCount: c }); }
  await wait(400);
  const wFit = await widthOf('mtime');
  const clippedAfterFit = await page(`[...document.querySelectorAll('#rows .row[data-path] .cell-mtime')].filter((c) => c.scrollWidth > c.clientWidth).length`);
  report(wFit > 50 && clippedAfterFit === 0, `double-clicking an edge fits Date to its text (${px(wFit)} px, ${clippedAfterFit} cells cut)`);
  // Put the columns back, then at 120% zoom the seven columns are wider than the list: it scrolls sideways.
  await page(`(() => { document.querySelector('#columns').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })); return true; })()`);
  await wait(300);
  await page(`(() => { const item = [...document.querySelectorAll('body *')].find((n) => n.children.length === 0 && n.textContent.trim() === 'Reset columns'); if (item) item.click(); return true; })()`);
  await wait(500);
  const reset = await widthOf('mtime');
  report(Math.round(reset) === 144, `right-click, Reset columns puts Date back to 144 px (${px(reset)})`);
  win.webContents.setZoomFactor(1.2);
  await wait(900);
  const sideways = await page(`(() => { const r = document.getElementById('rows'); return { over: r.scrollWidth - r.clientWidth, squeezed: document.getElementById('files-view').classList.contains('columns-squeezed') }; })()`);
  report(sideways.over > 50, `at 120% zoom the list scrolls sideways (${px(sideways.over)} px past the edge, squeezed ${sideways.squeezed})`);
  for (const left of [0, 50, 999999]) {
    await page(`(() => { document.getElementById('rows').scrollLeft = ${left}; return true; })()`);
    await wait(300);
    const a = await page(ALIGN(0));
    const t = await page(`document.getElementById('columns').style.transform`);
    report(worst(a) <= 1, `scrolled sideways to ${px(a.scrollLeft)} px, header and cells still line up (worst ${px(worst(a))} px, header ${t})`);
  }
  await shot('tables-details-sideways');
  const pageScroll = await page(`(() => { const d = document.documentElement; return d.scrollWidth - d.clientWidth; })()`);
  report(pageScroll <= 0, `the wide header does not make the page scroll (${pageScroll})`);
  console.log(`INFO tablesAudit last column's grip sticks out ${await page(`(() => { const f = document.getElementById('files-view'); return f.scrollWidth - f.clientWidth; })()`)} px past the pane (clipped, harmless)`);
  win.webContents.setZoomFactor(zoom0);
  await page(`(() => { document.getElementById('rows').scrollLeft = 0; return true; })()`);
  await wait(500);

  // ================= 4. Empty folder
  await go(empty);
  const emp = await page(`(() => { const e = document.querySelector('#rows .empty'); if (!e) return null; const r = e.getBoundingClientRect(); const c = document.getElementById('columns').getBoundingClientRect(); return { text: e.textContent, below: r.top >= c.bottom, inside: r.right <= window.innerWidth, headShown: c.height > 0 }; })()`);
  report(emp && emp.text === 'This folder is empty.' && emp.below && emp.inside && emp.headShown, `empty folder: message under the column header (${JSON.stringify(emp)})`);
  await shot('tables-empty');

  // ================= 5. Search results: name search and Words inside files
  fs.mkdirSync(path.join(dir, 'zeta', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'zeta', 'deep', 'needle-one.txt'), 'the needlexyz is here');
  fs.writeFileSync(path.join(dir, 'zeta', 'needle-two.md'), 'another needlexyz');
  fs.writeFileSync(path.join(dir, `needle-${LONG}`), 'needlexyz in a long file');
  stamp(path.join(dir, `needle-${LONG}`), '2025-06-06');
  stamp(path.join(dir, 'zeta', 'deep', 'needle-one.txt'), '2024-01-01');
  stamp(path.join(dir, 'zeta', 'needle-two.md'), '2026-02-02');
  await go(dir);
  const type = async (text, enter) => {
    await page(`(() => { const s = document.getElementById('search'); s.focus(); s.value = ${JSON.stringify(text)}; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    if (enter) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); }
    await wait(2500);
  };
  const setScope = async (label) => {
    await page(`(() => { document.getElementById('search-scope').click(); return true; })()`);
    await wait(300);
    await page(`(() => { const item = [...document.querySelectorAll('body *')].find((n) => n.children.length === 0 && n.textContent.trim() === ${JSON.stringify(label)}); if (item) item.click(); return true; })()`);
    await wait(400);
  };
  const foundNames = () => page(`[...document.querySelectorAll('#rows .row.found')].map((r) => r.querySelector('.name-text').textContent)`);
  const searchChecks = async (label) => {
    const rows = await foundNames();
    const a = await page(ALIGN(0, '#rows .row.found'));
    const idx = await page(`[...document.querySelectorAll('#rows .row.found')].findIndex((r) => r.querySelector('.name-text').textContent.length > 100)`);
    const al = await page(ALIGN(Math.max(0, idx), '#rows .row.found'));
    console.log(`INFO tablesAudit ${label} results ${JSON.stringify(rows.map((n) => n.slice(0, 14)))}`);
    report(rows.length >= 3 && worst(a) <= 1 && worst(al) <= 1, `${label}: ${rows.length} results, header lines up with cells (worst ${px(Math.max(worst(a), worst(al)))} px)`);
    const heights = await page(`[...new Set([...document.querySelectorAll('#rows .row.found')].map((r) => Math.round(r.getBoundingClientRect().height)))]`);
    report(heights.length === 1 && heights[0] === 42, `${label}: every result row is 42 px tall, long names do not wrap (${JSON.stringify(heights)})`);
    await shot(`tables-${label.replace(/\W+/g, '-')}`);
    await clickHead('size');
    const asc1 = (await sortState()).asc;
    const sizesA = await foundNames();
    await clickHead('size');
    const sizesB = await foundNames();
    report(sizesA.length > 1 && asc1 !== (await sortState()).asc && sizesA[0] !== sizesB[0] || sizesA.length < 2, `${label}: clicking Size twice reverses the results`);
    await clickHead('mtime');
    const byDate = await foundNames();
    const sort = await sortState();
    const year = (n) => (n === 'needle-one.txt' ? 2024 : n === 'needle-two.md' ? 2026 : 2025.5);
    const dates = byDate.map(year);
    const wantDesc = !sort.asc;
    report(dates.every((d, i) => !i || (wantDesc ? dates[i - 1] >= d : dates[i - 1] <= d)), `${label}: Date sort orders by real date (${wantDesc ? 'newest' : 'oldest'} first: ${JSON.stringify(byDate.map((n) => n.slice(0, 14)))})`);
  };
  await type('needle', false);
  await searchChecks('name search');
  await setScope('Words inside files');
  await type('needlexyz', true);
  await searchChecks('Words inside files');
  await type('zzzqqq', true);
  const none = await page(`(() => { const e = document.querySelector('#rows .empty'); const c = document.getElementById('columns').getBoundingClientRect(); return { empty: e && e.textContent, below: !e || e.getBoundingClientRect().top >= c.bottom }; })()`);
  report(none.empty && /No text file/.test(none.empty) && none.below, `search with no words found: ${JSON.stringify(none)}`);
  await shot('tables-search-none');
  await page(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await setScope('All folders inside');

  // ================= 6. Trash
  const trash = path.join(home, '.local', 'share', 'house-trash');
  fs.mkdirSync(trash, { recursive: true });
  fs.mkdirSync(path.join(trash, 'old folder'), { recursive: true });
  for (const [name, size, date] of FILES.slice(0, 4)) { fs.writeFileSync(path.join(trash, `t-${name}`), Buffer.alloc(size, 'x')); stamp(path.join(trash, `t-${name}`), date); }
  fs.writeFileSync(path.join(trash, `t-${LONG}`), 'x');
  await go(await page('houseTest.state.trash'));
  const tr = await page(ALIGN(0));
  const trLong = await page(ALIGN(Math.max(0, await page(longRow))));
  const note = await page(`(() => { const n = document.querySelector('#rows .trash-note'); const first = document.querySelector('#rows .row[data-path]'); return { note: n && n.textContent, noteBeforeRows: !!n && n.getBoundingClientRect().bottom <= first.getBoundingClientRect().top + 1, rows: document.querySelectorAll('#rows .row[data-path]').length }; })()`);
  report(worst(tr) <= 1 && worst(trLong) <= 1 && note.rows >= 6, `Trash: header lines up with cells (worst ${px(Math.max(worst(tr), worst(trLong)))} px, ${note.rows} rows)`);
  report(note.noteBeforeRows, `Trash: the 30-day note sits above the first row (${JSON.stringify(note)})`);
  await shot('tables-trash');
  fs.rmSync(trash, { recursive: true, force: true });
  fs.mkdirSync(trash, { recursive: true });
  await page(`(() => { document.getElementById('refresh').click(); return true; })()`);
  await wait(1200);
  const trEmpty = await page(`(() => { const e = document.querySelector('#rows .empty'); const n = document.querySelector('#rows .trash-note'); return { empty: e && e.textContent, note: !!n }; })()`);
  report(trEmpty.empty === 'This folder is empty.' && trEmpty.note, `empty Trash: says it is empty, keeps its note (${JSON.stringify(trEmpty)})`);
  await shot('tables-trash-empty');

  // ================= 7. Downloads and Projects (plain folders in Details with the same columns)
  fs.writeFileSync(path.join(home, 'Downloads', `setup-${LONG}.zip`), 'x');
  await go(path.join(home, 'Downloads'));
  const dl = await page(ALIGN(0));
  report(worst(dl) <= 1, `Downloads: header lines up with cells (worst ${px(worst(dl))} px)`);
  await go(await page('houseTest.state.projects'));
  const pr = await page(ALIGN(0));
  const prRows = await page(`document.querySelectorAll('#rows .row[data-path]').length`);
  report(worst(pr) <= 1, `Projects folder: header lines up with cells (worst ${px(worst(pr))} px, ${prRows} rows)`);

  // ================= 8. Elastic edge over the header (fine swipe at the top of a 400-row folder)
  await go(big);
  await page(`(() => { document.getElementById('rows').scrollTop = 0; return true; })()`);
  await wait(500);
  const rect = await page(`(() => { const r = document.getElementById('rows').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page(`(() => { window.fineSeen = []; window.addEventListener('wheel', (e) => window.fineSeen.push(e.deltaY), { capture: true, passive: true }); return true; })()`);
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(rect.x * factor), y: Math.round(rect.y * factor), deltaX: 0, deltaY: -120, canScroll: true });
  await wait(500);
  const perUnit = Math.abs((await page('window.fineSeen[0]')) || 0) / 120 || 1;
  await page(`(() => { document.getElementById('rows').scrollTop = 0; return true; })()`);
  await wait(1500);
  const EDGE_PROBE = `(() => {
    const rows = document.getElementById('rows'); const head = document.getElementById('columns');
    const hr = head.getBoundingClientRect(); const rr = rows.getBoundingClientRect();
    const first = rows.querySelector('.row[data-path]').getBoundingClientRect();
    const mid = document.elementFromPoint(hr.left + 60, hr.top + hr.height / 2);
    return { stretch: parseFloat(rows.style.getPropertyValue('--stretch')) || 0, headTop: hr.top, headBottom: hr.bottom, rowsTop: rr.top, rowsBottom: rr.bottom, firstTop: first.top,
      headHit: !!mid && !!mid.closest('#columns'), headTranslate: getComputedStyle(head).translate, rowsTranslate: getComputedStyle(rows).translate, scrollTop: rows.scrollTop };
  })()`;
  const still = await page(EDGE_PROBE);
  let maxStretch = 0; let minFirst = 1e9; let headMoved = 0; let headLost = false; let overlap = -1e9; let rowsMoved = 0;
  const send = (dy) => win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(rect.x * factor), y: Math.round(rect.y * factor), deltaX: 0, deltaY: -dy / perUnit, canScroll: true });
  for (const dy of [-8.89, -8.89, -17.78, -8.89, -35.56, -8.89, -8.89, -53.33, -8.89, -8.89, -8.89, -8.89, -17.78, -8.89, -8.89, -8.89, -8.89]) {
    send(dy);
    await wait(17);
    const p = await page(EDGE_PROBE);
    maxStretch = Math.max(maxStretch, Math.abs(p.stretch));
    minFirst = Math.min(minFirst, p.firstTop - p.headBottom);
    headMoved = Math.max(headMoved, Math.abs(p.headTop - still.headTop));
    rowsMoved = Math.max(rowsMoved, Math.abs(p.rowsTop - still.rowsTop));
    headLost = headLost || !p.headHit;
    overlap = Math.max(overlap, p.headBottom - p.firstTop);
  }
  console.log(`INFO tablesAudit edge top: stretch peak ${px(maxStretch)} px, first row never closer than ${px(minFirst)} px under the header's bottom (resting ${px(still.firstTop - still.headBottom)}), header moved ${px(headMoved)}, #rows box moved ${px(rowsMoved)}`);
  await shot('tables-edge-stretch');
  report(maxStretch === 0, `the rows do not stretch past the top (peak ${px(maxStretch)} px)`);
  report(headMoved === 0 && !headLost && rowsMoved === 0, `the column header and the list box do not move while pushing past the edge (header ${px(headMoved)} px, box ${px(rowsMoved)} px)`);
  report(overlap <= 0, `rows never slide under the column header at the top (overlap ${px(overlap)} px)`);
  await wait(1200);
  await page(`(() => { document.getElementById('rows').scrollTop = 1e6; return true; })()`);
  await wait(800);
  let headMovedB = 0; let peakB = 0; let worstOver = -1e9;
  for (const dy of [8.89, 8.89, 17.78, 35.56, 8.89, 8.89, 53.33, 8.89]) {
    send(dy);
    await wait(17);
    const p = await page(EDGE_PROBE);
    headMovedB = Math.max(headMovedB, Math.abs(p.headTop - still.headTop));
    peakB = Math.max(peakB, Math.abs(p.stretch));
    worstOver = Math.max(worstOver, p.headBottom - p.firstTop);
  }
  console.log(`INFO tablesAudit edge bottom: stretch peak ${px(peakB)} px`);
  report(headMovedB === 0, `at the bottom edge the header stays put too (moved ${px(headMovedB)} px)`);
  void worstOver;
  await wait(1500);

  // ================= 9. Home: Recent files table and the projects row
  for (const [i, name] of ['recent-a.txt', 'recent-b.md', `recent-${LONG}`].entries()) {
    const f = path.join(home, 'Documents', name);
    fs.writeFileSync(f, 'x');
    const when = new Date(Date.now() - (i + 1) * 86400000);
    fs.utimesSync(f, when, when);
  }
  await page(`(() => { houseTest.navigate('home:'); return true; })()`);
  await wait(4000);
  const HOMEALIGN = `(() => {
    const head = document.querySelector('.home-recent-head');
    const rows = [...document.querySelectorAll('.home-recent-row[data-path]')];
    if (!head || !rows.length) return { error: 'no rows', n: rows.length };
    const hs = [...head.children].filter((c) => c.offsetWidth);
    let worst = 0;
    for (const row of rows) {
      const rs = [...row.children].filter((c) => c.offsetWidth);
      if (rs.length !== hs.length) return { error: 'cell count ' + rs.length + ' vs ' + hs.length };
      rs.forEach((c, i) => { const a = c.getBoundingClientRect(); const b = hs[i].getBoundingClientRect(); worst = Math.max(worst, Math.abs(a.left - b.left), Math.abs(a.width - b.width)); });
    }
    const longRow = rows.find((r) => r.querySelector('.name-text').textContent.length > 100);
    const t = longRow && longRow.querySelector('.name-text');
    return { worst, n: rows.length, cols: hs.length, clipped: t ? t.scrollWidth > t.clientWidth : null, ell: t ? getComputedStyle(t).textOverflow : null,
      heights: [...new Set(rows.map((r) => r.getBoundingClientRect().height))], names: rows.map((r) => r.querySelector('.name-text').textContent.slice(0, 12)).slice(0, 6),
      dates: rows.map((r) => r.querySelector('.home-recent-date').textContent).slice(0, 6), pageOver: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  })()`;
  const homeCheck = async (label) => {
    await wait(900);
    const h = await page(HOMEALIGN);
    console.log(`INFO tablesAudit home ${label}: ${JSON.stringify(h)}`);
    report(!h.error && h.worst <= 1 && h.clipped !== false && h.heights.length === 1 && h.pageOver <= 0, `Home Recent files, ${label}: head and ${h.n} rows line up over ${h.cols} columns (worst ${h.error || px(h.worst)}), long name cut with ellipsis ${h.clipped}/${h.ell}`);
  };
  await homeCheck('1240 wide');
  await shot('tables-home');
  win.setSize(900, 600);
  await homeCheck('900 wide');
  await shot('tables-home-900');
  win.setSize(base[0], base[1]);
  win.webContents.setZoomFactor(1.2);
  await homeCheck('120% zoom');
  win.webContents.setZoomFactor(zoom0);
  await wait(600);
  const order = await page(`(() => ({ clickableHead: document.querySelector('.home-recent-head button, .home-recent-head [data-sort]') !== null }))()`);
  console.log(`INFO tablesAudit home sorting ${JSON.stringify(order)}`);
  const cards = await page(`(() => { const c = document.querySelector('.home-projects').getBoundingClientRect(); const cs = [...document.querySelectorAll('.home-card[data-project]')].filter((n) => n.offsetParent); return { n: cs.length, outside: cs.filter((n) => n.getBoundingClientRect().right > c.right + 1 || n.getBoundingClientRect().right > window.innerWidth).length }; })()`);
  report(cards.n > 0 && cards.outside === 0, `Home project cards stay inside the row (${JSON.stringify(cards)})`);
  console.log(`INFO tablesAudit see all: ${await page(`(() => { const b = document.querySelector('.home-see-all'); return b && b.textContent; })()`)}`);
  await page(`(() => { window.homeWas = homeData; homeData = { ...homeData, recent: [], projects: [] }; drawHome(); return true; })()`);
  await wait(400);
  const homeEmpty = await page(`(() => [...document.querySelectorAll('.home-empty')].map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent, w: Math.round(r.width), h: Math.round(r.height) }; }))()`);
  report(homeEmpty.length === 2 && homeEmpty.every((e) => e.t && e.w > 100 && e.h > 10), `Home empty states say what will show here (${JSON.stringify(homeEmpty)})`);
  await shot('tables-home-empty');
  await page(`(() => { homeData = window.homeWas; drawHome(); return true; })()`);
  report(true, 'replayed');
}

module.exports = { tablesAudit };
