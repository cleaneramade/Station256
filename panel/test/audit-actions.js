// Audit: everyday file actions on demo files, each checked on disk: New folder / Text Document,
// Rename (and Undo), Delete (and Undo), Trash restore, Properties, Zip and Extract, search.
const { fs, path, sleep, report, demoHome, until } = require('./audit-lib');

module.exports = {
  async auditActions({ page, shot }) {
    const { dir, at } = demoHome('AuditFiles');
    fs.writeFileSync(at('hello.txt'), 'hello world\n');
    fs.mkdirSync(at('pack/inner'), { recursive: true });
    fs.writeFileSync(at('pack/a.txt'), 'AAA');
    fs.writeFileSync(at('pack/inner/b.txt'), 'BBB');
    fs.mkdirSync(at('deep/er/est'), { recursive: true });
    fs.writeFileSync(at('deep/er/est/needle-file.txt'), 'x');
    const select = (file) => page(`(() => { setSelection([${JSON.stringify(file)}], ${JSON.stringify(file)}); return true; })()`);
    const listed = () => page(`[...document.getElementById('rows').children].map((n) => n.dataset.path).filter(Boolean).map((p) => p.split('/').pop())`);
    const home = process.env.HOME;
    const trashDir = await page(`houseTest.state.trash`);
    const load = async (folder) => { await page(`houseTest.navigate(${JSON.stringify(folder)}); true`); await sleep(700); };
    // Types a name into the open rename box and presses Enter, as a person would.
    const typeName = async (name) => {
      await until(page, `Boolean(document.querySelector('.rename-input'))`, 3000);
      await page(`(() => { const box = document.querySelector('.rename-input'); box.value = ${JSON.stringify(name)}; box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
      await sleep(700);
    };
    await load(dir);

    // New Folder and New Text Document (from the New menu's own functions).
    await page(`newFolder().then(() => true)`);
    await typeName('Photos 2026');
    report(fs.existsSync(at('Photos 2026')) && fs.statSync(at('Photos 2026')).isDirectory(), 'New > Folder, named "Photos 2026" on disk');
    await page(`newTextFile().then(() => true)`);
    await typeName('todo.txt');
    report(fs.existsSync(at('todo.txt')) && fs.readFileSync(at('todo.txt'), 'utf8') === '', 'New > Text Document, named todo.txt, empty, on disk');
    // Undo of a "new item" puts it in the Trash.
    await page(`undoLast(); true`);
    await sleep(900);
    report(!fs.existsSync(at('todo.txt')), 'Undo after New Text Document takes it away again (to the Trash)');

    // Rename, then Undo.
    await select(at('hello.txt'));
    await page(`renameSelected(); true`);
    await typeName('greeting.txt');
    report(!fs.existsSync(at('hello.txt')) && fs.readFileSync(at('greeting.txt'), 'utf8') === 'hello world\n', 'Rename hello.txt -> greeting.txt on disk, content kept');
    await page(`undoLast(); true`);
    await sleep(900);
    report(fs.existsSync(at('hello.txt')) && !fs.existsSync(at('greeting.txt')), 'Undo puts the old name back');
    // A name that is already taken, and one with a slash, must be refused without losing the file.
    await select(at('hello.txt'));
    await page(`renameSelected(); true`);
    await typeName('pack');
    await sleep(500);
    const dialogText = await page(`document.getElementById('dialog').open ? document.getElementById('dialog').textContent : ''`);
    await page(`document.querySelector('#dialog .btn')?.click(); true`);
    report(fs.existsSync(at('hello.txt')) && fs.statSync(at('pack')).isDirectory() && fs.existsSync(at('pack/a.txt')), `renaming onto an existing name is refused and nothing is lost: ${JSON.stringify(dialogText.slice(0, 90))}`);
    await select(at('hello.txt'));
    await page(`renameSelected(); true`);
    await typeName('../escape.txt');
    await sleep(500);
    const dialog2 = await page(`document.getElementById('dialog').open ? document.getElementById('dialog').textContent : ''`);
    await page(`document.querySelector('#dialog .btn')?.click(); true`);
    report(!fs.existsSync(path.join(path.dirname(dir), 'escape.txt')) && fs.existsSync(at('hello.txt')), `a name with a slash can't move the file out of its folder: ${JSON.stringify(dialog2.slice(0, 90))}`);

    // Properties.
    await select(at('hello.txt'));
    await page(`showProperties([${JSON.stringify(at('hello.txt'))}]); true`);
    await sleep(900);
    const props = await page(`document.getElementById('dialog').textContent`);
    await shot('audit-properties');
    report(/hello\.txt/.test(props) && /12 bytes/.test(props) && /Type/.test(props) && /Location/.test(props), `Properties shows name, type, location and size: ${JSON.stringify(props.slice(0, 160))}`);
    await page(`document.getElementById('dialog').close?.(); document.getElementById('dialog').dispatchEvent(new Event('cancel')); true`);
    await sleep(300);
    await select(at('pack'));
    await page(`showProperties([${JSON.stringify(at('pack'))}]); true`);
    await sleep(1200);
    const folderProps = await page(`document.getElementById('dialog').textContent`);
    report(/2 files/.test(folderProps) && /1 folder/.test(folderProps), `Properties of a folder counts what is inside: ${JSON.stringify(folderProps.slice(0, 160))}`);
    await page(`document.getElementById('dialog').close?.(); true`);
    await sleep(300);

    // Delete (to the Trash) and Undo; then delete again and Restore from the Trash.
    await select(at('hello.txt'));
    await page(`deleteSelected().then(() => true)`);
    await sleep(900);
    const toast = await page(`document.querySelector('.toast-text')?.textContent || ''`);
    report(!fs.existsSync(at('hello.txt')) && /Moved "hello\.txt" to the Trash/.test(toast), `Delete moves it to the Trash: "${toast}"`);
    await page(`undoLast(); true`);
    await sleep(900);
    report(fs.existsSync(at('hello.txt')) && fs.readFileSync(at('hello.txt'), 'utf8') === 'hello world\n', 'Undo brings it back with its content');
    await select(at('hello.txt'));
    await page(`deleteSelected().then(() => true)`);
    await sleep(900);
    await load(trashDir);
    const shownNames = await page(`[...document.querySelectorAll('#rows .name-text')].map((n) => n.textContent)`);
    report(shownNames.includes('hello.txt'), `the Trash lists it under its own name (not a number-prefixed one): ${JSON.stringify(shownNames)}`);
    await shot('audit-trash');
    const trashed = await page(`[...document.getElementById('rows').children].map((n) => n.dataset.path).find((p) => p && /[0-9]+-hello[.]txt$/.test(p))`);
    await select(trashed);
    await page(`restoreSelected().then(() => true)`);
    await sleep(900);
    report(fs.existsSync(at('hello.txt')) && fs.readFileSync(at('hello.txt'), 'utf8') === 'hello world\n', 'Restore from the Trash puts it back where it was');
    await load(dir);

    // Zip and Extract.
    await select(at('pack'));
    await page(`compressSelected().then(() => true)`);
    await until(page, `Boolean(document.querySelector('.rename-input'))`, 8000);
    await page(`(() => { document.querySelector('.rename-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    await sleep(800);
    const zips = fs.readdirSync(dir).filter((n) => /\.zip$/i.test(n));
    const magic = zips.length ? fs.readFileSync(at(zips[0])).subarray(0, 2).toString() : '';
    report(zips.length === 1 && magic === 'PK', `Compress to ZIP makes ${JSON.stringify(zips)} (a real zip)`);
    fs.rmSync(at('pack'), { recursive: true });
    await load(dir);
    await page(`extractArchive({ path: ${JSON.stringify(at(zips[0] || 'x.zip'))}, name: ${JSON.stringify(zips[0] || 'x.zip')}, isDir: false }, 'all').then(() => true)`);
    await sleep(1500);
    const found = (function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])); })(dir).filter((f) => /\/(a|b)\.txt$/.test(f) && !f.includes('/deep/'));
    const bodies = found.map((f) => fs.readFileSync(f, 'utf8')).sort().join();
    report(bodies === 'AAA,BBB', `Extract All gives back a.txt and b.txt with the same content: ${JSON.stringify(found.map((f) => f.replace(dir, '')))}`);
    await shot('audit-after-extract');

    // Search: "This folder" filters what is shown; "All folders inside" finds a file three folders down.
    await load(dir);
    const type = (text) => page(`(() => { const box = document.getElementById('search'); box.focus(); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const paths = () => page(`[...document.getElementById('rows').children].map((n) => n.dataset.path || '')`);
    await page(`document.getElementById('search-scope').click(); true`);
    await sleep(300);
    await page(`[...document.querySelectorAll('#menu .menu-item')].find((row) => row.textContent === 'This folder').click(); true`);
    await sleep(300);
    const placeholder = await page(`document.getElementById('search').placeholder`);
    await type('needle');
    await sleep(800);
    report(!(await paths()).some((p) => p.endsWith('needle-file.txt')), `"This folder" (box says "${placeholder}") only filters this folder's own list`);
    await type('');
    await page(`document.getElementById('search-scope').click(); true`);
    await sleep(300);
    await page(`[...document.querySelectorAll('#menu .menu-item')].find((row) => row.textContent === 'All folders inside').click(); true`);
    await sleep(300);
    await type('needle');
    const hit = await until(page, `[...document.getElementById('rows').children].some((n) => (n.dataset.path || '').endsWith('needle-file.txt'))`, 10000);
    await shot('audit-search');
    report(Boolean(hit), '"All folders inside": search for "needle" finds deep/er/est/needle-file.txt');
    const status = await page(`document.getElementById('item-count').textContent`);
    report(/1 item/.test(status), `the status line says: "${status}"`);
    await type('');
    await page(`document.getElementById('search-scope').click(); true`);
    await sleep(300);
    await page(`[...document.querySelectorAll('#menu .menu-item')].find((row) => row.textContent === 'This folder').click(); true`);
    await sleep(300);
    void home;
  },
};
