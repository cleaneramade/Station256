// Release audit: demo files made in the throwaway HOME, the real UI driven, the RESULT checked on disk.
// Scenes for shots.js (run by name): auditDocs, auditSong, auditPicture, auditLocalAi, auditBrowser,
// auditActions, auditEditorBrand. Needs the throwaway HOME (/tmp/...), never a real one.
const { fs, path, execFileSync, ff, probe, sleep, report, demoHome, until } = require('./audit-lib');

const MARKDOWN = `# Shopping and plans

A paragraph with **bold**, *italic*, \`inline code\` and a [link](https://example.com).

## Things to do

- [ ] write the report
- [x] buy bread
- plain bullet

1. first
2. second

> a quote

\`\`\`js
const a = 1 | 2;
\`\`\`

| Name | Qty | Price |
|:-----|:---:|------:|
| Apple | 3 | 1.50 |
| Pear | 12 | 20.00 |

| Cmd | Meaning |
|-----|---------|
| \`a \\| b\` | a pipe inside code |
| plain | text |

| c1 | c2 | c3 | c4 | c5 | c6 | c7 | c8 | c9 | c10 | c11 | c12 |
|----|----|----|----|----|----|----|----|----|-----|-----|-----|
| a long cell with lots of words in it so it is wide | b | c | d | e | f | g | h | i | j | k | l |

The end.
`;

const scenes = {
  async auditDocs({ page, shot }) {
    const { dir, at } = demoHome();
    fs.writeFileSync(at('plan.md'), MARKDOWN);
    fs.writeFileSync(at('notes.txt'), 'line one\nline two\n');
    fs.writeFileSync(at('data.json'), '{"name":"demo","list":[1,2,3]}\n');
    const view = 'houseTest.state.active.editor.view';
    const open = async (name) => {
      await page(`openDoc(${JSON.stringify(at(name))}).then(() => true)`);
      await sleep(700);
    };
    const saved = () => until(page, `houseTest.state.active.statusEl?.textContent === 'Saved'`);
    const close = async () => {
      await page(`houseTest.closeTab(houseTest.state.active).then(() => true)`);
      await sleep(300);
    };
    await page(`houseTest.navigate(${JSON.stringify(dir)}); true`);
    await sleep(600);

    // Markdown: open, look, tables drawn as tables.
    await open('plan.md');
    await page(`${view}.dispatch({ selection: { anchor: ${view}.state.doc.length } }); true`);
    await sleep(500);
    const drawn = await page(`[...document.querySelectorAll('.cm-table')].map((box) => ({ rows: box.querySelectorAll('tr').length, cells: [...box.querySelectorAll('th,td')].map((c) => c.textContent), aligns: [...box.querySelectorAll('tr:nth-child(2) td')].map((c) => c.style.textAlign) }))`);
    report(drawn.length === 3, `plan.md: 3 tables drawn as tables: ${JSON.stringify(drawn.map((d) => d.rows))}`);
    report(drawn[0]?.aligns.join() === 'left,center,right' || drawn[0]?.aligns.join() === ',center,right', `table alignment shown (left, center, right): ${JSON.stringify(drawn[0]?.aligns)}`);
    report(drawn[1]?.cells.includes('a | b'), `a pipe written \\| inside code shows as one cell "a | b": ${JSON.stringify(drawn[1]?.cells)}`);
    const wide = await page(`(() => { const box = document.querySelectorAll('.cm-table')[2]; return { scroll: box.scrollWidth, shown: box.clientWidth, page: document.querySelector('.cm-scroller').clientWidth }; })()`);
    report(wide.shown <= wide.page + 2, `a 12-column table scrolls inside its own box, not the page: ${JSON.stringify(wide)}`);
    const lineBreaks = await page(`[...document.querySelectorAll('.cm-table')[2].querySelectorAll('th')].map((cell) => { const r = document.createRange(); r.selectNodeContents(cell); return r.getClientRects().length; }).join()`);
    report(lineBreaks.split(',').every((n) => n === '1'), `no header word breaks in the middle in the wide table (lines per header: ${lineBreaks})`);
    await page(`document.querySelector('.cm-table').scrollIntoView({ block: 'start' }); true`);
    await sleep(300);
    await shot('audit-doc-tables');

    // Edit: a new row, a new column (typed as text, as a person would), a changed cell, a task ticked.
    await page(`(() => {
      const v = ${view}; const text = v.state.doc.toString();
      const next = text
        .replace('| Pear | 12 | 20.00 |', '| Pear | 12 | 20.00 |\\n| Plum | 7 | 4.25 |')
        .replace('| Name | Qty | Price |\\n|:-----|:---:|------:|\\n| Apple | 3 | 1.50 |', '| Name | Qty | Price | Note |\\n|:-----|:---:|------:|------|\\n| Apple | 99 | 1.50 | red |')
        .replace('- [ ] write the report', '- [x] write the report');
      v.dispatch({ changes: { from: 0, to: text.length, insert: next } }); return true; })()`);
    report(Boolean(await saved()), 'plan.md: edits save by themselves ("Saved")');
    let onDisk = fs.readFileSync(at('plan.md'), 'utf8');
    report(onDisk.includes('| Plum | 7 | 4.25 |') && onDisk.includes('| Apple | 99 | 1.50 | red |') && onDisk.includes('| Name | Qty | Price | Note |') && onDisk.includes('- [x] write the report'), 'plan.md on disk has the new row, new column, changed cell and ticked task');
    const keep = ['# Shopping and plans', '**bold**', '*italic*', '`inline code`', '[link](https://example.com)', '- plain bullet', '1. first', '> a quote', '```js', 'const a = 1 | 2;', '| `a \\| b` | a pipe inside code |', '|:-----|:---:|------:|------|', 'The end.', '| c1 | c2 | c3 | c4 | c5 | c6 | c7 | c8 | c9 | c10 | c11 | c12 |'];
    const lost = keep.filter((piece) => !onDisk.includes(piece));
    report(!lost.length, `nothing else lost from plan.md: missing ${JSON.stringify(lost)}`);
    await close();
    await open('plan.md');
    report((await page(`${view}.state.doc.toString()`)) === onDisk, 'plan.md reopened shows exactly what is on disk');

    // The toolbar: bold on a picked word, a heading, a checklist line, a link.
    await page(`(() => { const v = ${view}; const at = v.state.doc.toString().indexOf('The end.'); v.dispatch({ selection: { anchor: at, head: at + 3 } }); houseTest.state.active.editor.run('bold'); return true; })()`);
    await saved();
    report(fs.readFileSync(at('plan.md'), 'utf8').includes('**The** end.'), 'toolbar Bold wraps the picked word in ** on disk');
    await page(`(() => { const v = ${view}; v.dispatch({ selection: { anchor: 0 } }); houseTest.state.active.editor.run('heading2'); return true; })()`);
    await saved();
    report(fs.readFileSync(at('plan.md'), 'utf8').startsWith('## Shopping and plans'), 'toolbar Heading 2 changes the first line on disk');
    // Empty table cells and a table at the very end of a file.
    await page(`(() => { const v = ${view}; v.dispatch({ changes: { from: v.state.doc.length, insert: '\\n| a | b |\\n|---|---|\\n|   |   |' } }); return true; })()`);
    await saved();
    await sleep(300);
    const emptyCells = await page(`[...document.querySelectorAll('.cm-table')].pop().querySelectorAll('td').length`);
    report(emptyCells === 2, `a table with empty cells, last in the file, still draws: ${emptyCells} cells`);
    await close();

    // A .txt and a .json.
    await open('notes.txt');
    await page(`(() => { const v = ${view}; v.dispatch({ changes: { from: v.state.doc.length, insert: 'line three\\n' } }); return true; })()`);
    await saved();
    report(fs.readFileSync(at('notes.txt'), 'utf8') === 'line one\nline two\nline three\n', 'notes.txt: typed line is on disk, nothing else changed');
    await close();
    await open('data.json');
    await page(`(() => { const v = ${view}; const t = v.state.doc.toString(); v.dispatch({ changes: { from: 0, to: t.length, insert: '{"name":"changed","list":[1,2,3,4]}\\n' } }); return true; })()`);
    await saved();
    const json = fs.readFileSync(at('data.json'), 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(json); } catch (e) { /* reported below */ }
    report(parsed?.name === 'changed' && parsed.list.length === 4, 'data.json: still valid JSON with the change on disk');
    await shot('audit-doc-json');
    await close();

    // Changed outside while open: the page takes the new text; changed on both sides asks.
    await open('notes.txt');
    fs.writeFileSync(at('notes.txt'), 'changed outside\n');
    const took = await until(page, `${view}.state.doc.toString() === 'changed outside\\n'`, 6000);
    report(Boolean(took), 'notes.txt: a change made outside shows up in the open page');
    await close();
    // A file deleted while open says so.
    await open('notes.txt');
    fs.rmSync(at('notes.txt'));
    const gone = await until(page, `houseTest.state.active.banner && !houseTest.state.active.banner.hidden ? houseTest.state.active.banner.textContent : ''`, 6000);
    report(/moved or deleted/.test(gone || ''), `a file deleted while open says so: ${gone}`);
    await shot('audit-doc-gone');
    await page(`houseTest.state.active.tab; true`);
    await close();
  },
};

// The other areas live in files of their own: audit-song.js, audit-picture.js, ...
module.exports = scenes;
for (const part of ['song', 'picture', 'browser', 'actions', 'editor']) {
  if (fs.existsSync(path.join(__dirname, `audit-${part}.js`))) Object.assign(scenes, require(`./audit-${part}`));
}
