// Takes pictures of parts of the panel in a window that is never shown. Run with a throwaway HOME,
// so real settings can't be touched. See shotrun.sh. HOUSE_SHOTS is where the pictures go, and
// HOUSE_SHOTS_SCENES picks which scenes to take (all of them if empty).
const fs = require('fs');
const path = require('path');

const OUT = process.env.HOUSE_SHOTS;
const ONLY = (process.env.HOUSE_SHOTS_SCENES || '').split(',').filter(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each scene gets { page, shot, sleep } and saves one or more pictures.
// Back to the way the window opens: one new Home tab, every other tab closed. For scenes that open
// tabs (after them) or need a lone tab with no history (before them, like windows).
const ONE_TAB_LEFT = `(async () => {
  document.getElementById('new-tab').click();
  await new Promise((done) => setTimeout(done, 300));
  const keep = houseTest.state.active;
  for (const tab of [...houseTest.state.tabs]) if (tab !== keep) await houseTest.closeTab(tab);
  return true;
})()`;

const SCENES = {
  // Obscura, the browser tab: every way out of it, tried against a made-up web server (test/obscura-scene.js).
  obscura: require('./obscura-scene'),
  // The same tab against a hostile site: escapes, windows, permissions, downloads, keys (test/obscura-attacks.js).
  obscuraAttacks: require('./obscura-attacks'),
  // The browser tab looks like one real Chrome on Linux everywhere: headers, JS, window.chrome (test/obscura-identity.js).
  obscuraIdentity: require('./obscura-identity'),
  // The README's pictures, with made-up projects only (test/gallery-scene.js).
  ...require('./gallery-scene'),
  // Word documents in the preview (test/docx-scene.js).
  ...require('./docx-scene'),
  // In the icon views, the space under a tile's name matches the space over its picture, measured
  // in a picture of the window: from the tile's edge to the first and last drawn pixel down its
  // middle (a folder on top, its name below). Each tile is only as tall as its own name.
  async tileBalance({ page, shot, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const VIEW = (mode) => `(() => { houseTest.state.viewMode = '${mode}'; houseTest.state.selected = new Set(); houseTest.loadFolder(); return true; })()`;
    const gaps = async (name) => {
      const box = await page(`(() => { const tile = [...document.querySelectorAll('#rows .tile')].find((t) => t.dataset.path.endsWith('/${name}')); const r = tile.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, inner: window.innerWidth }; })()`);
      const image = await win.webContents.capturePage();
      const size = image.getSize();
      const bits = image.toBitmap();
      const scale = size.width / box.inner;
      const at = (x, y) => { const i = (y * size.width + x) * 4; return [bits[i], bits[i + 1], bits[i + 2]]; };
      const top = Math.ceil(box.top * scale);
      const bottom = Math.floor((box.top + box.height) * scale) - 1;
      const middle = Math.round((box.left + box.width / 2) * scale);
      const back = at(Math.round((box.left + 3) * scale), top + 2);
      const inked = (y) => { for (let x = middle - Math.round(22 * scale); x <= middle + Math.round(22 * scale); x += 1) { const p = at(x, y); if (Math.abs(p[0] - back[0]) + Math.abs(p[1] - back[1]) + Math.abs(p[2] - back[2]) > 40) return true; } return false; };
      let first = top;
      while (first < bottom && !inked(first)) first += 1;
      let last = bottom;
      while (last > first && !inked(last)) last -= 1;
      const css = (px) => Math.round((px / scale) * 10) / 10;
      return { over: css(first - top), under: css(bottom - last), height: Math.round(box.height * 10) / 10 };
    };
    await page(ONE_TAB_LEFT);
    await sleep(300);
    await page(`(() => { houseTest.navigate(houseTest.state.projects); return true; })()`);
    await sleep(800);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
    const seen = {};
    for (const mode of ['medium', 'large', 'xl']) {
      await page(VIEW(mode));
      await sleep(700);
      seen[mode] = await gaps('Notes App');
    }
    console.log(`TILE ${JSON.stringify(seen)}`);
    const off = Object.entries(seen).filter(([, g]) => Math.abs(g.over - g.under) > 1.5);
    report(off.length === 0, `icon views: as much space under the name as over the picture (CSS px): ${JSON.stringify(seen)}`);
    await page(VIEW('large'));
    await sleep(600);
    await page(`(() => { const p = [...document.querySelectorAll('#rows .tile')].find((t) => t.dataset.path.endsWith('/Notes App')).dataset.path; houseTest.state.selected = new Set([p]); houseTest.loadFolder(); return true; })()`);
    await sleep(600);
    await shot('tile-balance');
    await page(VIEW('details'));
    await sleep(400);
  },
  // Last edited by (the owner's own name), Last read by and Tokens: made-up room notes and token counts.
  async tokenColumns({ page, shot, sleep }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const home = process.env.HOME;
    const state = path.join(home, '.local', 'state', 'house');
    const project = path.join(home, 'projects', 'Notes App');
    const now = Date.now();
    fs.mkdirSync(path.join(state, 'edits', 'Notes.App'), { recursive: true });
    ['ai.txt', 'mine.txt', 'read.txt', 'plain.txt', 'station.txt', 'cmd.txt'].forEach((name) => fs.writeFileSync(path.join(project, name), 'x'));
    fs.mkdirSync(path.join(project, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(project, 'sub', 'deep.txt'), 'x');
    // mine.txt was changed by the AI an hour ago, then by someone 20 minutes ago, with no AI note near that.
    // cmd.txt (noted an hour ago too) changed just now, a minute from the note for ai.txt: likely a command the AI ran.
    // station.txt (noted an hour ago) is saved below through the app, so it is known to be the owner's.
    fs.utimesSync(path.join(project, 'ai.txt'), new Date(now - 60000), new Date(now - 60000));
    fs.utimesSync(path.join(project, 'mine.txt'), new Date(now - 1200000), new Date(now - 1200000));
    fs.utimesSync(path.join(project, 'cmd.txt'), new Date(now), new Date(now));
    fs.utimesSync(path.join(project, 'station.txt'), new Date(now - 7200000), new Date(now - 7200000));
    const note = (name, ago) => JSON.stringify({ time: now - ago, path: `/workspace/${name}`, tool: 'claude', model: 'claude-opus-5-5', action: 'edit' });
    fs.writeFileSync(path.join(state, 'edits', 'Notes.App', 'edits.jsonl'), `${note('ai.txt', 60000)}\n${note('mine.txt', 3600000)}\n${note('cmd.txt', 3600000)}\n${note('station.txt', 3600000)}\n`);
    const touch = {
      '/workspace/ai.txt': [now - 7200000, 'claude-opus-5-5', 182000, 3000],
      '/workspace/read.txt': [now - 120000, 'claude-sonnet-5-5', 12400000, 100000],
      '/workspace/sub/deep.txt': [now - 300000, 'claude-opus-5-5', 5000, 500],
    };
    fs.writeFileSync(path.join(state, 'token-counts.json'), JSON.stringify({ sources: { 'room:Notes.App': { files: { a: { offset: 1, ids: [], days: { '2026-11-01': [12000000, 400000] }, touch } } }, 'room:Docs.Site': { files: { b: { offset: 1, ids: [], days: { '2026-11-01': [1000, 500] } } } } } }));
    // Saved through the app: the owner's own save, recorded as it happens.
    await page(`(async () => { await call('docWrite', ${JSON.stringify(path.join(project, 'station.txt'))}, 'saved by the owner', null); return true; })()`);
    await page(`(() => { houseTest.navigate(${JSON.stringify(project)}); return true; })()`);
    await sleep(1500);
    const cells = await page(`(() => Object.fromEntries([...document.querySelectorAll('#rows .row-grid')].map((r) => [r.querySelector('.name-text').textContent, ['editor', 'reader', 'tokens'].map((k) => (r.querySelector('.cell-' + k) || {}).textContent)])))()`);
    console.log('CELLS', JSON.stringify(cells));
    report(/Opus/.test(cells['ai.txt']?.[0]) && /^Alex$|^[A-Z]/.test(cells['mine.txt']?.[0]) && !/Opus/.test(cells['mine.txt']?.[0]), `Last edited by: AI name while the AI is latest, the owner's name after they saved: ${JSON.stringify(cells['ai.txt'])} ${JSON.stringify(cells['mine.txt'])}`);
    const editorTips = await page(`(() => Object.fromEntries([...document.querySelectorAll('#rows .row-grid')].map((r) => [r.querySelector('.name-text').textContent, ((c) => (c && (c.dataset.tip || c.title)) || '')(r.querySelector('.cell-editor'))])))()`);
    console.log('EDITOR TIPS', JSON.stringify(editorTips));
    report(!/Opus/.test(cells['station.txt']?.[0]) && /^[A-Z]/.test(cells['station.txt']?.[0]) && /\nSaved in Station 256$/.test(editorTips['station.txt']), `a file saved through the app shows the owner's name, "Saved in Station 256": ${JSON.stringify([cells['station.txt']?.[0], editorTips['station.txt']])}`);
    report(!/Opus/.test(cells['mine.txt']?.[0]) && /\nChanged after the AI's last edit$/.test(editorTips['mine.txt']), `a change with no AI note near it shows the owner's name: ${JSON.stringify([cells['mine.txt']?.[0], editorTips['mine.txt']])}`);
    report(/Opus/.test(cells['cmd.txt']?.[0]) && /^Claude Opus 5\.5 · .*\nLikely a command it ran while working here$/.test(editorTips['cmd.txt']), `a change within 5 minutes of the AI's other notes shows the model as likely: ${JSON.stringify([cells['cmd.txt']?.[0], editorTips['cmd.txt']])}`);
    report(Object.values(editorTips).every((tip) => tip.split('\n').length <= 2 && tip.split('\n').every((line) => line.length <= 44)), 'the Last edited by hover texts are two lines of 44 characters at most');
    report(/Opus 5.5/.test(cells['ai.txt']?.[1]) && /Sonnet/.test(cells['read.txt']?.[1]) && cells['plain.txt']?.[1] === '', 'Last read by shows the model, and nothing for a file no AI read');
    report(cells['ai.txt']?.[2] === '185K' && cells['read.txt']?.[2] === '12.5M', `Tokens per file: ${cells['ai.txt']?.[2]} and ${cells['read.txt']?.[2]}`);
    await shot('token-columns');
    const stats = await page(`(async () => { const d = await call('homeStats'); return { card: (d.projects.find((p) => p.name === 'Notes App') || {}).tokensAllTime, all: d.tokens.allIn }; })()`);
    report(stats.card === 12400000, `Home card's all-time tokens: ${JSON.stringify(stats)}`);
    // Folders: inside the project, a subfolder rolls up what its files got...
    const folderCells = await page(`(() => Object.fromEntries([...document.querySelectorAll('#rows .row-grid')].map((r) => [r.querySelector('.name-text').textContent, ['reader', 'tokens'].map((k) => (r.querySelector('.cell-' + k) || {}).textContent)])))()`);
    report(/Opus/.test(folderCells.sub?.[0]) && folderCells.sub?.[1] === '5.5K', `a subfolder shows the read inside it and its rolled-up tokens: ${JSON.stringify(folderCells.sub)}`);
    // Sorting a mix of files and a folder by either column: the folder stays first, then the biggest or newest.
    const sortedBy = (key) => page(`(() => { const was = [state.sortBy, state.sortAsc]; state.sortBy = ${JSON.stringify(key)}; state.sortAsc = false; const names = [...state.entries].sort(compareEntries).map((entry) => entry.name); [state.sortBy, state.sortAsc] = was; return names.slice(0, 3).join(','); })()`);
    const orders = [await sortedBy('tokens'), await sortedBy('reader')];
    report(orders.every((order) => order === 'sub,read.txt,ai.txt'), `sorting by Tokens and by Last read by, files and a folder mixed: ${JSON.stringify(orders)}`);
    // Every hover text on these two columns is two lines at most.
    const tipsOf = () => page(`(() => Object.fromEntries([...document.querySelectorAll('#rows .row-grid')].map((r) => [r.querySelector('.name-text').textContent, ['reader', 'tokens'].map((k) => { const c = r.querySelector('.cell-' + k); return c ? c.dataset.tip || c.title || '' : ''; })])))()`);
    // None is cut short either: the app's own fitting (tooltip.js) leaves each as written.
    const twoLines = async (tips) => Object.values(tips).flat().every((tip) => tip.split('\n').length <= 2)
      && await page(`(() => ${JSON.stringify(Object.values(tips).flat())}.every((tip) => fitLines(tip, FIT.tip) === tip))()`);
    const inProject = await tipsOf();
    report(await twoLines(inProject) && /^Last AI read inside: deep\.txt\n/.test(inProject.sub?.[0]) && /files in this folder$/.test(inProject.sub?.[1]) && /^Claude Opus 5\.5 · .*\nClaude only\./.test(inProject['ai.txt']?.[0]) && /^182,000 read \+ 3,000 written\nShared by/.test(inProject['ai.txt']?.[1]), `a file's hover text: ${JSON.stringify(inProject['ai.txt'])}; `
      + `a folder's hover text, two lines at most: ${JSON.stringify(inProject.sub)}`);
    // ...and on the Projects page the project row shows its all-time number, the one on Home's card.
    await page(`(() => { houseTest.navigate(houseTest.state.home); return true; })()`);
    await sleep(1500);
    const inHome = await tipsOf();
    // The Projects folder adds the projects up. It doesn't say "as Home counts", since Home's All time tile also counts work outside projects.
    report(await twoLines(inHome) && /all time, all projects\n/.test(inHome.Projects?.[1]) && !/Home/.test(inHome.Projects?.[1]), `the Projects folder's hover text: ${JSON.stringify(inHome.Projects)}`);
    await page(`(() => { houseTest.navigate(houseTest.state.projects); return true; })()`);
    await sleep(1500);
    const inProjects = await tipsOf();
    report(await twoLines(inProjects) && /all time, as on Home\n/.test(inProjects['Notes App']?.[1]) && /^Last AI read inside: read\.txt\n/.test(inProjects['Notes App']?.[0]) && inProjects.SampleApp?.join('') === '', `a project's hover text: ${JSON.stringify(inProjects['Notes App'])}`);
    // A project the AI worked in without reading or changing a file: its total still shows, and nobody "read" it.
    report(inProjects['Docs Site']?.[0] === '' && inProjects['Docs Site']?.[1] === '1,500 tokens all time, as on Home\nNo file in it read or changed by AI yet', `a project with tokens but no file touched: ${JSON.stringify(inProjects['Docs Site'])}`);
    const rowCells = await page(`(() => Object.fromEntries([...document.querySelectorAll('#rows .row-grid')].map((r) => [r.querySelector('.name-text').textContent, ['reader', 'tokens'].map((k) => (r.querySelector('.cell-' + k) || {}).textContent)])))()`);
    report(rowCells['Notes App']?.[1] === '12.4M' && /Sonnet/.test(rowCells['Notes App']?.[0]), `project row: Tokens equal the Home card's all-time number, and Last read by shows a model: ${JSON.stringify(rowCells['Notes App'])}`);
    await shot('token-projects');
    // A narrowing list (its width is stood in for here): Type steps aside first, then Tokens, then Last
    // read by, then the date; Last edited by stays longest.
    const outAt = (width) => page(`(() => { Object.defineProperty(filesView, 'clientWidth', { get: () => ${width}, configurable: true }); applyColumns(); const out = [...columnsSqueezedOut]; delete filesView.clientWidth; applyColumns(); return out; })()`);
    const out = [];
    for (const width of [1400, 1000, 900, 800, 700, 600, 400]) out.push([width, await outAt(width)]);
    const left = [];
    out.forEach(([, gone]) => ['type', 'tokens', 'reader', 'mtime', 'editor'].forEach((key) => { if (gone.includes(key) && !left.includes(key)) left.push(key); }));
    const nested = out.every(([, gone], i) => i === 0 || out[i - 1][1].every((key) => gone.includes(key)));
    report(nested && left.slice(0, 3).join(',') === 'type,tokens,reader' && !out[0][1].length && !out[out.length - 1][1].includes('editor'), `columns step aside in order: ${JSON.stringify(out)}`);
    await page(`(() => { houseTest.navigate('home:'); return true; })()`);
    await sleep(1200);
    const card = await page(`(() => [...document.querySelectorAll('.home-card-tokens')].map((line) => line.textContent))()`);
    report(card.length === 2 && card.includes('12.4M tokens all time'), `Home card lines: ${JSON.stringify(card)}`);
    await shot('token-home');
    // Put back, so the scenes after this one (Home counts files and notes) start from what they expect.
    ['ai.txt', 'mine.txt', 'read.txt', 'plain.txt', 'station.txt', 'cmd.txt'].forEach((name) => fs.rmSync(path.join(project, name), { force: true }));
    fs.rmSync(path.join(project, 'sub'), { recursive: true, force: true });
    fs.rmSync(path.join(state, 'edits', 'Notes.App'), { recursive: true, force: true });
    fs.rmSync(path.join(state, 'token-counts.json'), { force: true });
  },
  // The sidebar runs down to the bottom of the window, and the status bar starts where it ends:
  // open, folded to icons, and with the System panel open (the bar then runs under it too).
  async footerBeside({ page, shot, sleep }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const measure = () => page(`(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const app = box('.app'); const nav = box('.navpane'); const bar = box('.statusbar'); const trash = box('.nav-item[data-nav="trash"]');
      const page = [...document.querySelectorAll('.main > section')].find((s) => !s.hidden).getBoundingClientRect();
      const system = document.getElementById('system-pane');
      const r = (n) => Math.round(n * 10) / 10;
      return { navRight: r(nav.right), navBottom: r(nav.bottom), barLeft: r(bar.left), barRight: r(bar.right), barTop: r(bar.top), barBottom: r(bar.bottom), barHeight: r(bar.height), pageBottom: r(page.bottom), pageLeft: r(page.left), appRight: r(app.right), appBottom: r(app.bottom), trashBottom: r(trash.bottom), systemBottom: system.hidden ? null : r(system.getBoundingClientRect().bottom) };
    })()`);
    const fits = (m) => Math.abs(m.barLeft - m.navRight) <= 1 && Math.abs(m.navBottom - m.appBottom) <= 1 && Math.abs(m.barBottom - m.appBottom) <= 1 && Math.abs(m.barRight - m.appRight) <= 1 && Math.abs(m.pageBottom - m.barTop) <= 1 && m.barHeight === 24;
    await page(ONE_TAB_LEFT);
    await sleep(300);
    await page(`(() => { houseTest.navigate(houseTest.state.projects); return true; })()`);
    await sleep(800);
    const open = await measure();
    report(fits(open) && open.appBottom - open.trashBottom < 16, `sidebar open: it runs to the bottom, Trash at the bottom, the bar starts where it ends: ${JSON.stringify(open)}`);
    await shot('footer-beside');
    await page(`document.getElementById('nav-toggle').click(); true`);
    await sleep(500);
    const folded = await measure();
    report(fits(folded), `sidebar folded to icons: the bar starts where it ends: ${JSON.stringify(folded)}`);
    await page(`document.getElementById('nav-toggle').click(); true`);
    await sleep(400);
    await page(`houseTest.toggleSystem(); true`);
    await sleep(800);
    const system = await measure();
    report(fits(system) && Math.abs(system.systemBottom - system.barTop) <= 1, `System panel open: the bar runs under it, from the sidebar to the edge: ${JSON.stringify(system)}`);
    await page(`houseTest.toggleSystem(); true`);
    await sleep(400);
  },
  // Right-click a terminal tab: Export Chat saves its AI chat as a page in Downloads, as the
  // terminal shows it; Export Chat with Details adds every command, change and result. A made-up
  // Claude chat (one of every kind of line) stands in, run by a stand-in program in a house
  // terminal, and the room way is checked through the stand-in docker.
  async chatExport({ page, sleep }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const { spawn } = require('child_process');
    const FAKE = path.dirname(OUT);
    const DOWN = path.join(FAKE, 'Downloads');
    const SESSIONS = path.join(FAKE, '.claude', 'sessions');
    const sid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const chatDir = path.join(FAKE, '.claude', 'projects', FAKE.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(SESSIONS, { recursive: true });
    fs.mkdirSync(chatDir, { recursive: true });
    fs.mkdirSync(DOWN, { recursive: true });
    for (const name of fs.readdirSync(DOWN)) if (name.endsWith('.md')) fs.rmSync(path.join(DOWN, name));

    // The made-up chat, one line per message or step, linked like Claude Code's.
    const lines = [];
    let n = 0;
    let last = null;
    const at = () => new Date(Date.UTC(2026, 10, 9, 15, n)).toISOString();
    const put = (entry, keep = true) => {
      n += 1;
      const uuid = `u${n}`;
      lines.push({ parentUuid: last, isSidechain: false, uuid, timestamp: at(), sessionId: sid, ...entry });
      if (keep) last = uuid;
      return uuid;
    };
    const user = (content, extra = {}) => put({ type: 'user', message: { role: 'user', content }, ...extra });
    const ai = (block, extra = {}) => put({ type: 'assistant', message: { role: 'assistant', id: `m${n}`, content: [block] }, ...extra });
    const result = (id, text, extra = {}) => user([{ type: 'tool_result', tool_use_id: id, content: text, ...extra }]);
    user('Caveat: The messages below were made by the user running local commands.', { isMeta: true });
    put({ type: 'system', subtype: 'local_command', content: '<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args>Demo</command-args>' });
    put({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Session renamed to Demo</local-command-stdout>' });
    user('Please fix the login test<system-reminder>SECRET REMINDER</system-reminder>');
    ai({ type: 'thinking', thinking: 'THINKING ABOUT LOGIN', signature: 'x' });
    ai({ type: 'text', text: 'I\'ll look at the test first.' });
    ai({ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } });
    result('tu1', '1 failing');
    ai({ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/workspace/src/app.js' } });
    result('tu2', '1\tconst x = 1;');
    ai({ type: 'tool_use', id: 'tu3', name: 'Edit', input: { file_path: '/workspace/src/app.js', old_string: 'old line', new_string: 'new line' } });
    result('tu3', 'The file has been updated.');
    ai({ type: 'text', text: 'Fixed: the test passes now.' });
    ai({ type: 'tool_use', id: 'tu4', name: 'AskUserQuestion', input: { questions: [{ question: 'Ship it?', header: 'Ship', multiSelect: false, options: [{ label: 'Yes', description: 'Merge now' }, { label: 'No', description: 'Wait' }] }] } });
    const answered = result('tu4', 'User has answered your questions: "Ship it?"="Yes". You can now continue with the user\'s answers in mind.');
    // A message you went back and changed: the old one is left on a side branch.
    user('SIDE BRANCH MESSAGE');
    ai({ type: 'text', text: 'SIDE BRANCH REPLY' });
    last = answered;
    user([{ type: 'text', text: 'Here is a picture' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]);
    ai({ type: 'text', text: 'Nice picture.' });
    put({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'SIDECHAIN TEXT' }] } }, false);
    user([{ type: 'text', text: '[Request interrupted by user]' }]);
    const before = last;
    last = null;
    put({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', logicalParentUuid: before });
    user('This session is being continued from a previous conversation. SUMMARY TEXT', { isCompactSummary: true });
    user('Thanks, one more thing');
    ai({ type: 'text', text: 'Sure, done.' });
    const blob = JSON.stringify({ type: 'api-request-blob', message: { content: [{ type: 'text', text: 'BLOB TEXT' }] } });
    fs.writeFileSync(path.join(chatDir, `${sid}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n${blob}\n`);
    const note = (pid) => {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      fs.writeFileSync(path.join(SESSIONS, `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: FAKE, procStart, updatedAt: Date.now(), kind: 'interactive' }));
    };

    // A house terminal with the stand-in AI running in it.
    await page(ONE_TAB_LEFT);
    await sleep(300);
    const termId = await page(`houseTest.openTerminal({ cwd: houseTest.state.home }).then((tab) => tab.termId)`);
    await sleep(1200);
    const pidFile = path.join(FAKE, 'ai.pid');
    fs.rmSync(pidFile, { force: true });
    await page(`window.house.call('termWrite', ${termId}, "sh -c 'echo $$ > \\"$HOME/ai.pid\\"; exec sleep 600'\\r").then(() => true)`);
    for (let i = 0; i < 30 && !fs.existsSync(pidFile); i += 1) await sleep(100);
    const aiPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    note(aiPid);

    const rightClick = `(() => { const node = houseTest.state.active.el; const r = node.getBoundingClientRect(); node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 12 })); return [...document.querySelectorAll('#menu:not([hidden]) .menu-item')].map((b) => b.textContent.trim()); })()`;
    const pick = (label) => page(`(() => { const item = [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}); if (item) item.click(); return Boolean(item); })()`);
    const saved = async (pattern) => {
      for (let i = 0; i < 50; i += 1) {
        const found = fs.readdirSync(DOWN).find((name) => pattern.test(name));
        if (found) return path.join(DOWN, found);
        await sleep(100);
      }
      return null;
    };
    const menu = await page(rightClick);
    report(JSON.stringify(menu) === JSON.stringify(['Cut', 'Copy', 'Paste', 'Select All', 'Export Chat', 'Export Chat with Details', 'New Tab', 'Move to New Window', 'Close Tab']), `a terminal tab's right-click menu: ${JSON.stringify(menu)}`);
    await pick('Export Chat');
    const plainFile = await saved(/^Linux House chat \d{4}-\d\d-\d\d \d{1,2}-\d\d [AP]M\.md$/);
    const plain = plainFile ? fs.readFileSync(plainFile, 'utf8') : '';
    await sleep(300);
    const said = await page(`[document.querySelector('.toast-text')?.textContent || '', document.querySelector('.toast-button')?.textContent || '']`);
    report(Boolean(plainFile) && /^Chat saved to Downloads/.test(said[0]) && said[1] === 'Show', `Export Chat saves a page in Downloads and says so: ${JSON.stringify([plainFile && path.basename(plainFile), said])}`);
    const has = (text, parts) => parts.filter((part) => !text.includes(part));
    const missing = has(plain, ['# Chat in the Linux House', '### You', '### Claude', 'Please fix the login test', 'I\'ll look at the test first.', '*Ran 1 command, changed 1 file (app.js) and read 1 file.*', 'Fixed: the test passes now.', '`/rename Demo`', 'Session renamed to Demo', '**Asked you:** Ship it?', '- Yes (Merge now)', '**You picked:** Yes', 'Here is a picture', '*(picture)*', '*(You stopped the AI here.)*', 'summarized here', 'Thanks, one more thing', 'Sure, done.']);
    const extra = ['SECRET REMINDER', 'THINKING ABOUT LOGIN', 'npm test', 'old line', 'SIDE BRANCH', 'SIDECHAIN', 'BLOB TEXT', 'SUMMARY TEXT', 'Caveat'].filter((part) => plain.includes(part));
    const order = ['Please fix', 'I\'ll look', '*Ran 1 command', 'Fixed:', 'Ship it?', 'Here is a picture', 'stopped the AI', 'summarized here', 'Sure, done.'].map((part) => plain.indexOf(part));
    report(!missing.length && !extra.length && order.every((place, i) => place > (i ? order[i - 1] : -1)), `the plain page reads like the terminal, in order, steps as one line: ${JSON.stringify({ missing, extra, order })}`);

    await page(rightClick);
    await pick('Export Chat with Details');
    const detailFile = await saved(/^Linux House chat with details .*\.md$/);
    const detail = detailFile ? fs.readFileSync(detailFile, 'utf8') : '';
    const missingDetail = has(detail, ['**Ran a command**: Run the tests', '```bash\nnpm test\n```', 'Result:', '1 failing', '**Read** `/workspace/src/app.js`', '**Changed** `/workspace/src/app.js`', '```diff\n- old line\n+ new line\n```', '**Thinking:** THINKING ABOUT LOGIN', 'SUMMARY TEXT', '**You picked:** Yes', 'With details']);
    const extraDetail = ['SECRET REMINDER', 'SIDE BRANCH', 'SIDECHAIN', 'BLOB TEXT'].filter((part) => detail.includes(part));
    report(Boolean(detailFile) && !missingDetail.length && !extraDetail.length, `with details: every command, change, result and the AI's thinking: ${JSON.stringify({ file: detailFile && path.basename(detailFile), missing: missingDetail, extra: extraDetail })}`);
    fs.writeFileSync(path.join(OUT, 'chat-plain.md'), plain);
    fs.writeFileSync(path.join(OUT, 'chat-detail.md'), detail);

    // Show opens Downloads with the page picked.
    await page(`(() => { document.querySelector('.toast-button').click(); return true; })()`);
    await sleep(900);
    const shown = await page(`({ path: houseTest.state.active.path, picked: [...houseTest.state.selected] })`);
    report(shown.path === DOWN && shown.picked.length === 1 && shown.picked[0] === detailFile, `Show opens Downloads with the page picked: ${JSON.stringify(shown)}`);

    // No AI running in it anymore: it says so, and nothing is saved.
    process.kill(aiPid);
    await sleep(300);
    await page(`(() => { houseTest.activateTab(houseTest.state.tabs.find((t) => t.termId === ${termId})); return true; })()`);
    await sleep(300);
    const count = fs.readdirSync(DOWN).length;
    await page(rightClick);
    await pick('Export Chat');
    await sleep(1500);
    const told = await page(`[document.getElementById('dialog').open, document.getElementById('dialog').textContent]`);
    await page(`(() => { const b = [...document.querySelectorAll('#dialog button')].pop(); if (b) b.click(); return true; })()`);
    report(told[0] && /No AI chat is running in this terminal/.test(told[1]) && fs.readdirSync(DOWN).length === count, `with no AI running it says so and saves nothing: ${JSON.stringify(told[1]).slice(0, 160)}`);
    // Other tabs have no such menu.
    await page(`(() => { houseTest.activateTab(houseTest.state.tabs.find((t) => t.kind === 'files')); return true; })()`);
    await sleep(300);
    const filesMenu = await page(`(() => { closeMenu(); return true; })()`).then(() => page(rightClick));
    report(filesMenu.length > 0 && !filesMenu.some((label) => label.startsWith('Export Chat')), `a Files tab has no chat menu: ${JSON.stringify(filesMenu)}`);

    // A room terminal: the page is made inside the room (here, the stand-in docker runs it in place).
    const chatSave = require(path.join(__dirname, '..', 'lib', 'chat-save'));
    const inTab = (tab, args = ['600'], command = 'sleep') => spawn(command, args, { env: { ...process.env, HERDR_SOCKET_PATH: `${FAKE}/x/sessions/${tab}/herdr.sock` }, stdio: 'ignore' }).pid;
    const roomPid = inTab('tab-7');
    const codexPid = inTab('tab-9', ['-c', 'exec -a codex sleep 600'], 'bash');
    await sleep(300);
    note(roomPid);
    const tryIt = (place) => chatSave.save(place, false).then((file) => ({ ok: true, file }), (error) => ({ ok: false, error: error.message }));
    const room = await tryIt({ room: 'SampleApp', tab: 'tab-7' });
    const roomPage = room.ok ? fs.readFileSync(room.file, 'utf8') : '';
    report(room.ok && /^SampleApp chat /.test(path.basename(room.file)) && roomPage.startsWith('# Chat in the SampleApp room') && roomPage.includes('Sure, done.'), `a room terminal's chat is saved the same way: ${JSON.stringify(room)}`);
    const none = await tryIt({ room: 'SampleApp', tab: 'tab-8' });
    const codex = await tryIt({ room: 'SampleApp', tab: 'tab-9' });
    const bad = await tryIt({ room: 'SampleApp; rm -rf x', tab: 'tab-7' });
    report(!none.ok && /No AI chat/.test(none.error) && !codex.ok && /Codex/.test(codex.error) && !bad.ok && /isn't a room terminal/.test(bad.error), `no chat, another AI, and a bad name are each refused plainly: ${JSON.stringify([none, codex, bad])}`);
    for (const pid of [roomPid, codexPid]) { try { process.kill(pid); } catch { /* gone */ } }
    await page(`(() => { const t = houseTest.state.tabs.find((tab) => tab.termId === ${termId}); if (t) houseTest.closeTab(t); return true; })()`);
    await sleep(500);
    await page(ONE_TAB_LEFT);
    await sleep(300);
  },
  // While the Windows lock is open, Windows (C:) shows under Linux House (L:) in the sidebar. It can
  // be browsed, previewed and copied from, never changed: nothing on it can be renamed, deleted,
  // moved, cut or pasted onto, in the page or in the house code behind it. Locking takes it away and
  // sends any tab on it back to Home. A stand-in C: (a folder beside the throwaway home) is used.
  async windowsDrive({ page, shot, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const FAKE = path.dirname(OUT);
    const DOOR = path.join(FAKE, 'windows-door');
    const FLAG = path.join(FAKE, 'windows-door-open');
    const desk = path.join(DOOR, 'Users', 'Alex', 'Desktop');
    fs.mkdirSync(desk, { recursive: true });
    fs.mkdirSync(path.join(DOOR, 'Program Files'), { recursive: true });
    fs.writeFileSync(path.join(desk, 'note.txt'), 'from windows\n');
    fs.writeFileSync(path.join(desk, 'keep.txt'), 'stays\n');
    try { fs.symlinkSync('/nowhere/at/all', path.join(DOOR, 'Documents and Settings')); } catch { /* there already */ }
    // Windows' shared folders, and another person who signed in more lately: C: still opens in yours.
    for (const name of ['Public', 'Default', 'Guest']) fs.mkdirSync(path.join(DOOR, 'Users', name), { recursive: true });
    try { fs.symlinkSync('/nowhere', path.join(DOOR, 'Users', 'All Users')); } catch { /* there already */ }
    fs.writeFileSync(path.join(DOOR, 'Users', 'Alex', 'NTUSER.DAT'), '');
    fs.utimesSync(path.join(DOOR, 'Users', 'Alex', 'NTUSER.DAT'), new Date(Date.now() - 86400000), new Date(Date.now() - 86400000));
    fs.writeFileSync(path.join(DOOR, 'Users', 'Guest', 'NTUSER.DAT'), '');
    fs.writeFileSync(path.join(FAKE, 'Documents', 'mine.txt'), 'house file\n');
    fs.rmSync(FLAG, { force: true });
    const navShown = () => page(`(() => { const n = document.getElementById('nav-windows'); return !n.hidden && n.getBoundingClientRect().height > 0; })()`);
    const status = () => page(`houseTest.refreshStatus().then(() => true)`);
    // Only the items that can be pressed: Cut and Paste stay in every menu, greyed out where nothing can change.
    const menuLabels = () => page(`[...document.querySelectorAll(".menu-item:not(:disabled)")].map((b) => b.textContent.trim())`);
    const closeMenu = async () => { await page(`(() => { closeMenu(); return true; })()`); await sleep(250); };
    const tryCall = (name, ...args) => page(`window.house.call(${JSON.stringify(name)}, ...${JSON.stringify(args)}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e.message || e) }))`);

    await page(ONE_TAB_LEFT);
    await sleep(400);
    await status();
    await sleep(300);
    report(!(await navShown()), 'locked: no Windows (C:) in the sidebar');
    const lockedList = await tryCall('list', DOOR, false);
    report(!lockedList.ok && /locked/i.test(lockedList.e), `locked: C: can't be listed: ${JSON.stringify(lockedList)}`);

    fs.writeFileSync(FLAG, '');
    await status();
    await sleep(300);
    const order = await page(`[...document.querySelectorAll('#nav .nav-item')].filter((n) => !n.hidden).map((n) => n.textContent.trim())`);
    const at = order.indexOf('Windows (C:)');
    report(await navShown() && at > 0 && order[at - 1] === 'Linux House (L:)', `unlocked: Windows (C:) shows right under Linux House (L:): ${JSON.stringify(order)}`);

    const where = () => page(`({ path: houseTest.state.active.path, title: houseTest.state.active.el.querySelector('.tab-title').textContent, crumbs: [...document.querySelectorAll('#address .crumb')].map((c) => c.textContent), names: houseTest.state.entries.map((e) => e.name).sort(), up: document.getElementById('up').disabled, selected: document.getElementById('nav-windows').classList.contains('selected') })`);
    await page(`(() => { document.getElementById('nav-windows').click(); return true; })()`);
    await sleep(900);
    const mine = await where();
    report(mine.path === path.join(DOOR, 'Users', 'Alex') && mine.crumbs.join('>') === 'Windows (C:)>Users>Alex' && mine.selected && !mine.up && JSON.stringify(mine.names) === '["Desktop"]', `clicking it opens your Windows folder, C:\\Users\\Alex, its hidden NTUSER.DAT left out: ${JSON.stringify(mine)}`);
    await shot('windows-drive');
    const icons = await page(`[...document.querySelectorAll('#nav .nav-item')].filter((n) => /\\((L|C):\\)/.test(n.textContent)).map((n) => n.querySelector(':scope > i:not(.expander)').dataset.i)`);
    report(JSON.stringify(icons) === JSON.stringify(['hard_drive', 'hard_drive']), `Linux House (L:) and Windows (C:) both show the drive icon: ${JSON.stringify(icons)}`);
    await page(`(() => { houseTest.navigate(${JSON.stringify(DOOR)}); return true; })()`);
    await sleep(800);
    const root = await where();
    report(root.path === DOOR && root.title === 'Windows (C:)' && root.crumbs.join('>') === 'Windows (C:)' && root.selected, `C:\\ itself is named Windows (C:): ${JSON.stringify(root)}`);
    report(JSON.stringify(root.names) === JSON.stringify(['Program Files', 'Users']), `C:'s folders are listed, its dead shortcut folders hidden: ${JSON.stringify(root.names)}`);
    report(root.up, 'Up is off at the top of C: (it never climbs into the house)');

    await page(`(() => { houseTest.navigate(${JSON.stringify(desk)}); return true; })()`);
    await sleep(800);
    const deskView = await page(`({ crumbs: [...document.querySelectorAll('#address .crumb')].filter((c) => !c.hidden).map((c) => c.textContent), count: document.getElementById('item-count').textContent })`);
    report(deskView.crumbs.join('>') === 'Windows (C:)>Users>Alex>Desktop' && /View and copy only/.test(deskView.count), `inside C:, the address and the count say where you are: ${JSON.stringify(deskView)}`);
    await page(`(() => { document.getElementById('address').click(); return true; })()`);
    await sleep(200);
    const typed = await page(`document.querySelector('.address-input')?.value`);
    report(typed === 'C:\\Users\\Alex\\Desktop', `the address bar writes it as a C: path: ${JSON.stringify(typed)}`);
    await page(`(() => { const i = document.querySelector('.address-input'); i.value = 'C:\\\\Users'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    await sleep(700);
    const went = await page(`houseTest.state.active.path`);
    report(went === path.join(DOOR, 'Users'), `typing C:\\Users goes there: ${went}`);
    await page(`(() => { houseTest.navigate(${JSON.stringify(desk)}); return true; })()`);
    await sleep(800);

    // A file's right-click menu: open and copy, nothing that changes it.
    await page(`(() => { const row = [...document.querySelectorAll('#rows [data-path]')].find((r) => r.dataset.path.endsWith('/note.txt')); const b = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 8 })); return true; })()`);
    await sleep(400);
    const fileMenu = await menuLabels();
    await closeMenu();
    const changers = ['Cut', 'Rename', 'Delete', 'Compress to ZIP File', 'Paste', 'Folder', 'Text Document'];
    report(fileMenu.includes('Copy') && fileMenu.includes('Copy as Path') && fileMenu.includes('Properties') && !fileMenu.some((label) => changers.includes(label)), `a file on C: offers only looking and copying: ${JSON.stringify(fileMenu)}`);
    const buttons = await page(`['cut', 'copy', 'paste', 'rename', 'delete'].map((id) => id + ':' + (document.getElementById(id).disabled ? 'off' : 'on'))`);
    report(buttons.join(' ') === 'cut:off copy:on paste:off rename:off delete:off', `with it picked, only Copy is pressable: ${buttons.join(' ')}`);
    // The empty part of the list: no New, no Paste.
    await page(`(() => { const rows = document.getElementById('rows'); const r = rows.getBoundingClientRect(); rows.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 300, clientY: r.bottom - 30 })); return true; })()`);
    await sleep(400);
    const listMenu = await menuLabels();
    await closeMenu();
    report(!listMenu.some((label) => changers.includes(label) || label === 'Project') && listMenu.includes('Refresh'), `the list's own menu has nothing that adds to C:: ${JSON.stringify(listMenu)}`);
    // Keys too: Delete, F2, Ctrl+X, Ctrl+V do nothing to it.
    await page(`(() => { document.getElementById('rows').focus(); return houseTest.state.selected.size; })()`);
    win.webContents.focus();
    for (const [keyCode, modifiers] of [['Delete', []], ['F2', []], ['X', ['control']], ['V', ['control']], ['Delete', ['shift']]]) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await sleep(350);
      await closeMenu();
    }
    await page(`(() => { const d = document.getElementById('dialog'); if (d.open) d.close(); return true; })()`);
    const renameBox = await page(`Boolean(document.querySelector('#rows input'))`);
    report(!renameBox && fs.existsSync(path.join(desk, 'note.txt')), `Delete, F2, Ctrl+X, Ctrl+V and Shift+Delete leave it alone: ${JSON.stringify({ renameBox, there: fs.existsSync(path.join(desk, 'note.txt')) })}`);

    // The house code behind the page refuses too, whatever asks.
    const note = path.join(desk, 'note.txt');
    const asks = {
      rename: await tryCall('rename', note, 'renamed.txt'),
      trash: await tryCall('trashItems', [note]),
      forever: await tryCall('removeForever', [note]),
      newFolder: await tryCall('makeFolder', desk, 'New folder', true),
      newFile: await tryCall('makeFile', desk, 'New Text Document.txt'),
      moveOut: await tryCall('transfer', [note], path.join(FAKE, 'Documents'), true),
      copyOnto: await tryCall('transfer', [path.join(FAKE, 'Documents', 'mine.txt')], desk, false),
    };
    const refused = (answer) => !answer.ok || (answer.r && Array.isArray(answer.r.failures) && answer.r.failures.length > 0) || (Array.isArray(answer.r) && answer.r.length > 0);
    const left = fs.readdirSync(desk).sort();
    report(Object.values(asks).every(refused) && JSON.stringify(left) === JSON.stringify(['keep.txt', 'note.txt']), `rename, trash, delete, new, move off and copy onto C: are all refused, and C: is untouched: ${JSON.stringify({ asks, left })}`);

    // Copying from C: into the house works, and C: keeps its file.
    const copied = await tryCall('transfer', [note], path.join(FAKE, 'Documents'), false);
    const landed = path.join(FAKE, 'Documents', 'note.txt');
    report(copied.ok && fs.existsSync(landed) && fs.readFileSync(landed, 'utf8') === 'from windows\n' && fs.existsSync(note), `copying from C: into L: works and C: keeps it: ${JSON.stringify(copied)}`);
    const shown = await tryCall('readText', note);
    report(shown.ok, `a file on C: can be previewed: ${JSON.stringify(shown).slice(0, 120)}`);

    // Locking: the drive goes, and every tab on it goes back to Home.
    await page(`(() => { document.getElementById('new-tab').click(); return true; })()`);
    await sleep(500);
    await page(`(() => { houseTest.navigate(${JSON.stringify(DOOR)}); return true; })()`);
    await sleep(700);
    await page(`(() => { houseTest.activateTab(houseTest.state.tabs[0]); return true; })()`);
    await sleep(500);
    fs.rmSync(FLAG, { force: true });
    await status();
    await sleep(900);
    const after = await page(`houseTest.state.tabs.map((t) => t.path + '|' + t.el.querySelector('.tab-title').textContent)`);
    report(!(await navShown()) && after.every((line) => line === 'home:|Home'), `locking takes Windows (C:) away and every tab on it goes Home: ${JSON.stringify(after)}`);
    const relocked = await tryCall('list', desk, false);
    report(!relocked.ok, `locked again: C: can't be listed: ${JSON.stringify(relocked)}`);
    await page(ONE_TAB_LEFT);
    await sleep(300);
  },
  // Every separator line is the same thickness on screen: one screen pixel, like the edges drawn as
  // borders. At 135% zoom a 1px box can land on one screen pixel or two depending on where it falls,
  // so each line is measured in a picture of the window, not read from the style sheet.
  async separators({ page, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    // [label, vertical, x, y] in CSS pixels, for every separator showing now.
    const LINES = `(() => {
      const out = [];
      const mid = (r) => [r.left + r.width / 2, r.top + r.height / 2];
      document.querySelectorAll('.nav-rule').forEach((e, i) => { const r = e.getBoundingClientRect(); if (r.width) out.push(['sidebar line ' + (i + 1), false, ...mid(r)]); });
      document.querySelectorAll('.commandbar .divider').forEach((e, i) => { const r = e.getBoundingClientRect(); if (r.height) out.push(['toolbar divider ' + (i + 1), true, ...mid(r)]); });
      document.querySelectorAll('.tab').forEach((e, i) => { if (getComputedStyle(e, '::before').display === 'none') return; const r = e.getBoundingClientRect(); out.push(['between tabs ' + i + '-' + (i + 1), true, r.left + 0.5, r.top + r.height / 2]); });
      document.querySelectorAll('.menu-rule').forEach((e, i) => { const r = e.getBoundingClientRect(); if (r.width) out.push(['menu line ' + (i + 1), false, ...mid(r)]); });
      const bar = document.querySelector('.commandbar').getBoundingClientRect();
      out.push(['toolbar bottom edge (border)', false, bar.left + bar.width * 0.7, bar.bottom - 0.5]);
      const nav = document.querySelector('.navpane').getBoundingClientRect();
      out.push(['sidebar edge (border)', true, nav.right - 0.5, nav.top + nav.height * 0.6]);
      return { lines: out, width: window.innerWidth };
    })()`;
    const measure = async () => {
      const { lines, width } = await page(LINES);
      const image = await win.webContents.capturePage();
      const size = image.getSize();
      const bits = image.toBitmap();
      const scale = size.width / width;
      const at = (x, y) => { const i = (y * size.width + x) * 4; return [bits[i], bits[i + 1], bits[i + 2]]; };
      const differs = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 6;
      return lines.map(([label, vertical, x, y]) => {
        const cx = Math.round(x * scale);
        const cy = Math.round(y * scale);
        const pick = (d) => (vertical ? at(cx + d, cy) : at(cx, cy + d));
        const back = pick(-6);
        let thick = 0;
        for (let d = -5; d <= 5; d += 1) if (differs(pick(d), back)) thick += 1;
        return [label, thick];
      });
    };

    await page(ONE_TAB_LEFT);
    await sleep(400);
    // Four tabs with the first in front, so lines show between the ones that aren't.
    await page(`(async () => { for (let i = 0; i < 3; i += 1) { document.getElementById('new-tab').click(); await new Promise((d) => setTimeout(d, 250)); } houseTest.activateTab(houseTest.state.tabs[0]); return true; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 600 });
    await sleep(700);
    const open = await measure();
    // The sidebar folded to its icons.
    await page(`document.getElementById('nav-toggle').click(); true`);
    await sleep(500);
    const folded = (await measure()).filter(([label]) => label.startsWith('sidebar'));
    await page(`document.getElementById('nav-toggle').click(); true`);
    await sleep(400);
    // A right-click menu's lines, in a folder.
    await page(`(() => { houseTest.navigate(houseTest.state.projects); return true; })()`);
    await sleep(800);
    await page(`(() => { const rows = document.getElementById('rows'); const r = rows.getBoundingClientRect(); rows.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 300, clientY: r.bottom - 40 })); return true; })()`);
    await sleep(500);
    const menu = (await measure()).filter(([label]) => label.startsWith('menu'));
    await page(`(() => { closeMenu(); return true; })()`);
    await sleep(300);

    const all = [...open, ...folded.map(([label, thick]) => [`${label} (folded)`, thick]), ...menu];
    const counts = { sidebar: all.filter(([l]) => l.startsWith('sidebar line')).length, toolbar: all.filter(([l]) => l.startsWith('toolbar divider')).length, tabs: all.filter(([l]) => l.startsWith('between tabs')).length, menu: menu.length };
    report(counts.sidebar >= 4 && counts.toolbar >= 2 && counts.tabs >= 1 && counts.menu >= 1, `every kind of separator was found: ${JSON.stringify(counts)}`);
    const off = all.filter(([, thick]) => thick !== 1);
    report(off.length === 0, `every separator is one screen pixel thick, like the borders: ${off.length ? 'NOT ' + JSON.stringify(off) : JSON.stringify(all)}`);
    await page(ONE_TAB_LEFT);
    await sleep(300);
  },
  // Ctrl+R hands over from the old page to the new one with no seam. Every frame the hidden window
  // draws is watched: the window never vanishes, shrinks or moves, and once the loading screen is
  // in, its logo never blinks out. The ring carries on at the same turn. The trace letters, one per
  // frame at the window's middle: L logo, W white, T see-through, C anything else.
  async reloadSmooth({ page, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} reloadSmooth: ${text}`);
    await page(`(() => { houseTest.navigate(houseTest.state.projects); document.activeElement?.blur(); return true; })()`);
    await sleep(1500);
    const box = await page(`(() => { const r = document.querySelector('.app').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, iw: window.innerWidth }; })()`);
    const frames = [];
    let watching = true;
    win.webContents.beginFrameSubscription(false, (image) => {
      if (!watching) return;
      const size = image.getSize();
      const scale = size.width / box.iw;
      const bitmap = image.toBitmap(); // BGRA
      const at = (x, y) => {
        const i = (Math.round(y * scale) * size.width + Math.round(x * scale)) * 4;
        return [bitmap[i + 2], bitmap[i + 1], bitmap[i], bitmap[i + 3]];
      };
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const middle = [at(cx, cy), at(cx - 20, cy), at(cx + 20, cy), at(cx, cy - 20), at(cx, cy + 20)];
      const kind = middle.some(([, , , a]) => a < 250) ? 'T'
        : middle.some(([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > 40 || Math.max(r, g, b) < 200) ? 'L'
          : middle.every(([r, g, b]) => r > 245 && g > 245 && b > 245) ? 'W' : 'C';
      frames.push({ kind, corner: at(box.x + 24, box.y + 70)[3], edge: at(box.x + box.w - 24, box.y + box.h - 24)[3] });
    });
    await sleep(500);
    frames.length = 0;
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control'] });
    // The ring, as soon as the new page shows it: where it is in its turn, against the clock.
    let ring = null;
    for (let i = 0; i < 40 && !ring; i += 1) {
      await sleep(50);
      ring = await page(`(() => {
        if (!window.houseTest) return null;
        const arc = document.querySelector('.splash:not([hidden]) .splash-arc');
        const spin = arc && arc.getAnimations().find((a) => a.animationName === 'house-spin');
        if (!spin) return null;
        const at = spin.effect.getComputedTiming().progress * 1200;
        return Math.round(((at - (Date.now() % 1200)) % 1200 + 1800) % 1200 - 600);
      })()`).catch(() => null);
    }
    for (let i = 0; i < 60; i += 1) {
      await sleep(100);
      if (await page(`Boolean(window.houseTest) && document.getElementById('splash').hidden`).catch(() => false)) break;
    }
    await sleep(300);
    watching = false;
    win.webContents.endFrameSubscription();
    const trace = frames.map((f) => f.kind).join('');
    console.log(`reloadSmooth trace (${frames.length} frames): ${trace}`);
    const gone = frames.filter((f) => f.corner < 250 || f.edge < 250).length;
    report(frames.length > 10, `frames were watched (${frames.length})`);
    report(gone === 0 && !trace.includes('T'), `the window never vanishes, shrinks or moves (${gone} frame(s) with a see-through corner or edge)`);
    const logo = trace.replace(/^[^L]*/, '').replace(/[^L]*$/, '');
    report(logo.length > 0 && !/[WTC]/.test(logo), `once the logo is in, it never blinks out until the end (${logo.length} frame(s): ${logo.replace(/L+/g, (run) => `L${run.length}`)})`);
    report(ring !== null && Math.abs(ring) <= 80, `the ring carries on at the same turn across the reload (${ring} ms off the clock)`);
  },
  // The refresh button and F5 only read the list again, with a blink and no loading screen, as in
  // File Explorer. Ctrl+R starts the window again with its loading screen, keeping every tab, and a
  // room terminal keeps running through it. Inside a terminal, Ctrl+R is the terminal's own key.
  async reloadKeys({ page, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const press = async (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    const describe = `houseTest.state.tabs.map((t) => t.kind === 'files' ? 'files:' + t.path : t.kind === 'term' ? 'term:' + t.termId : t.kind)`;
    await page(`(() => { houseTest.navigate(houseTest.state.projects); return true; })()`);
    await sleep(800);
    await page(`houseTest.openTerminal({ cwd: houseTest.state.home }).then(() => true)`);
    await sleep(1500);
    const termId = await page(`houseTest.state.active.termId`);
    const termText = () => page(`(() => { const t = houseTest.state.tabs.find((tab) => tab.termId === ${termId}); const b = t.live.term.buffer.active; let s = ''; for (let i = 0; i < b.length; i += 1) s += b.getLine(i).translateToString(true) + '\\n'; return s; })()`);
    await page(`window.house.call('termWrite', ${termId}, 'echo before-$((40+2))\\r').then(() => true)`);
    await sleep(800);

    // Ctrl+R typed into the terminal: the terminal searches what was typed before, nothing reloads.
    await page(`(() => { window.reloadMark = 1; houseTest.state.tabs.find((tab) => tab.termId === ${termId}).live.term.focus(); return true; })()`);
    win.webContents.focus();
    await press('R', ['control']);
    await sleep(900);
    const searching = await termText();
    const stayed = await page(`window.reloadMark === 1`).catch(() => false);
    report(stayed && /reverse-i-search/.test(searching), `Ctrl+R in a terminal is the terminal's own (history search): ${JSON.stringify([stayed, searching.split('\n').filter((line) => /search/.test(line))])}`);
    await press('G', ['control']); // ends the search
    await sleep(400);

    // The refresh button: the list blinks and comes back, with no loading screen.
    await page(`(() => { houseTest.activateTab(houseTest.state.tabs.find((t) => t.kind === 'files' && t.path === houseTest.state.projects)); document.activeElement?.blur(); return true; })()`);
    await sleep(600);
    const clicked = await page(`(() => { document.getElementById('refresh').click(); return [document.getElementById('rows').classList.contains('blink'), document.getElementById('splash').hidden]; })()`);
    await sleep(800);
    const settled = await page(`[document.getElementById('rows').classList.contains('blink'), document.getElementById('splash').hidden, window.reloadMark, document.getElementById('rows').children.length]`);
    report(clicked[0] && clicked[1] && !settled[0] && settled[1] && settled[2] === 1 && settled[3] > 0,
      `the refresh button blinks the list, no loading screen, nothing else reloads: ${JSON.stringify([clicked, settled])}`);

    // F5 does the same.
    await press('F5');
    await sleep(30);
    const f5 = await page(`[document.getElementById('rows').classList.contains('blink'), document.getElementById('splash').hidden, window.reloadMark]`);
    await sleep(800);
    report(f5[0] && f5[1] && f5[2] === 1, `F5 refreshes the same way: ${JSON.stringify(f5)}`);

    // Home too: it blinks and comes back, no loading screen.
    await page(`(() => { houseTest.navigate('home:'); return true; })()`);
    await sleep(800);
    const homeBlink = await page(`(() => { document.getElementById('refresh').click(); return [document.getElementById('home-view').classList.contains('blink'), document.getElementById('splash').hidden]; })()`);
    await sleep(800);
    const homeBack = await page(`[document.getElementById('home-view').classList.contains('blink'), document.querySelectorAll('.home-tile').length]`);
    report(homeBlink[0] && homeBlink[1] && !homeBack[0] && homeBack[1] === 4, `refresh on Home blinks it and comes back: ${JSON.stringify([homeBlink, homeBack])}`);
    await page(`(() => { houseTest.navigate(houseTest.state.projects); return true; })()`);
    await sleep(800);

    // Ctrl+R outside a terminal: the loading screen, then the same tabs with the same one in front.
    const before = await page(`({ tabs: ${describe}, front: houseTest.state.tabs.indexOf(houseTest.state.active) })`);
    await page(`(() => { document.activeElement?.blur(); return true; })()`);
    await press('R', ['control']);
    let sawLoading = false;
    let after = null;
    for (let i = 0; i < 60 && !after; i += 1) {
      await sleep(150);
      const now = await page(`window.reloadMark === undefined && window.houseTest ? { splash: !document.getElementById('splash').hidden, tabs: houseTest.state.tabs.length } : null`).catch(() => null);
      if (now && now.splash) sawLoading = true;
      if (now && !now.splash && now.tabs >= before.tabs.length) after = await page(`({ tabs: ${describe}, front: houseTest.state.tabs.indexOf(houseTest.state.active) })`);
    }
    report(sawLoading, 'Ctrl+R shows the loading screen while the window starts again');
    report(Boolean(after) && JSON.stringify(after.tabs) === JSON.stringify(before.tabs) && after.front === before.front,
      `after Ctrl+R: the same tabs, the same one in front: ${JSON.stringify([before, after])}`);

    // The terminal kept running: what it printed is there, and it still answers.
    await page(`window.house.call('termWrite', ${termId}, 'echo after-$((50+5))\\r').then(() => true)`).catch(() => {});
    await sleep(1200);
    const text = await termText().catch(() => '');
    report(text.includes('before-42') && text.includes('after-55'), `the terminal kept running through Ctrl+R: ${JSON.stringify(text.split('\n').filter((line) => /before-|after-/.test(line)))}`);

    await page(`houseTest.closeTab(houseTest.state.tabs.find((tab) => tab.termId === ${termId})).then(() => true)`).catch(() => {});
    await sleep(600);
    await page(ONE_TAB_LEFT);
    await sleep(300);
  },
  // The tabs and the sidebar are neutral, never blue: a soft gray under the mouse and when
  // selected. Hovered for real with the mouse, not just read from the style sheet.
  async neutralHighlights({ page, shot, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    await page(`document.getElementById('new-tab').click(); true`);
    await sleep(500);
    const zoom = win.webContents.getZoomFactor();
    const hoverOn = async (selector) => {
      const [x, y] = await page(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x * zoom), y: Math.round(y * zoom) });
      await sleep(300);
      return page(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return [e.matches(':hover'), getComputedStyle(e).backgroundColor]; })()`);
    };
    const tab = await hoverOn('.tab:not(.active)');
    await shot('neutral-tab-hover');
    report(tab[0] && tab[1] === 'rgb(230, 230, 230)', `a tab under the mouse is soft gray, not blue: ${JSON.stringify(tab)}`);
    const close = await hoverOn('.tab.active .close-tab');
    report(close[0] && close[1] === 'rgba(0, 0, 0, 0.07)', `a tab's close button under the mouse is a see-through gray: ${JSON.stringify(close)}`);
    const plus = await hoverOn('#new-tab');
    report(plus[0] && plus[1] === 'rgb(230, 230, 230)', `the + button under the mouse is soft gray: ${JSON.stringify(plus)}`);
    const nav = await hoverOn('.nav-item[data-nav="Documents"]');
    await shot('neutral-nav-hover');
    report(nav[0] && nav[1] === 'rgb(243, 243, 243)', `a sidebar place under the mouse is soft gray, not blue: ${JSON.stringify(nav)}`);
    const toggle = await hoverOn('#nav-toggle');
    report(toggle[0] && toggle[1] === 'rgb(243, 243, 243)', `the sidebar's own button under the mouse is soft gray: ${JSON.stringify(toggle)}`);
    const selected = await page(`(() => { const e = document.querySelector('.nav-item.selected'); return e ? [e.dataset.nav, getComputedStyle(e).backgroundColor] : null; })()`);
    report(selected && selected[1] === 'rgb(235, 235, 235)', `the selected sidebar place is soft gray, not blue: ${JSON.stringify(selected)}`);
    // The file list keeps its blue.
    const rowHover = await page(`getComputedStyle(document.documentElement).getPropertyValue('--row-hover').trim()`);
    report(rowHover === '#e5f3ff', `the file list's hover is still light blue: ${rowHover}`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
    await page(ONE_TAB_LEFT);
    await sleep(300);
  },
  async sidebar({ page, shot }) {
    await page(`houseTest.navigate(houseTest.state.projects); true`);
    await sleep(600);
    await shot('sidebar');
    await page(`document.getElementById('nav-toggle').click(); true`);
    await sleep(400);
    await shot('sidebar-collapsed');
    await page(`document.getElementById('nav-toggle').click(); true`);
    await sleep(300);
  },
  async sidebarShort({ page, shot }) {
    await page(`(() => { const app = document.querySelector('.app'); app.dataset.was = app.style.height; app.style.height = '430px'; return true; })()`);
    await sleep(500);
    await shot('sidebar-short');
    await page(`(() => { const app = document.querySelector('.app'); app.style.height = app.dataset.was; return true; })()`);
    await sleep(300);
  },
  async system({ page, shot }) {
    await page(`houseTest.toggleSystem(true); true`);
    await sleep(1500);
    await shot('system');
    await page(`(() => { const pane = document.getElementById('system-pane'); pane.scrollTop = pane.scrollHeight; return true; })()`);
    await sleep(400);
    await shot('system-bottom');
    // The Activity log, opened, if there is one.
    const opened = await page(`(() => { const head = document.querySelector('.sys-activity-head'); if (!head) return false; if (!head.classList.contains('open')) head.click(); return true; })()`);
    if (opened) {
      await sleep(1500);
      await page(`(() => { const pane = document.getElementById('system-pane'); pane.scrollTop = pane.scrollHeight; return true; })()`);
      await sleep(400);
      await shot('system-activity-open');
      await page(`document.querySelector('.sys-activity-head').click(); true`);
      await sleep(600);
    }
    await page(`houseTest.toggleSystem(false); true`);
  },
  // Long notes and every warning at once: each stops at two lines.
  async systemLong({ page, shot }) {
    await page(`houseTest.toggleSystem(true); true`);
    await sleep(1200);
    const lines = await page(`(async () => {
      const names = Array.from({ length: 14 }, (_, i) => 'long-program-name-' + i).join(',');
      window.longStatus = () => { state.status = { ...state.status, keeper: 'awake: jobs running: ' + names, rooms: [], dockerOk: false, lowDisk: true, freeGb: 3, doorOpen: true }; };
      longStatus();
      await renderSystem(true);
      return [...document.querySelectorAll('.sys-card-note, .sys-warn > span')].map((node) => [node.textContent.slice(0, 40), Math.round(node.clientHeight / parseFloat(getComputedStyle(node).lineHeight))]);
    })()`);
    lines.forEach(([text, count]) => console.log(`${count <= 2 ? 'PASS' : 'FAIL'} system note ${count} lines: ${JSON.stringify(text)}`));
    await shot('system-long');
    // A click shows the whole note, and the panel redrawing keeps it shown.
    const opened = await page(`(async () => {
      document.querySelector('.sys-card').click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      longStatus(); // a real status check may have come in meanwhile
      await renderSystem(true);
      const note = document.querySelector('.sys-card-note');
      return Math.round(note.clientHeight / parseFloat(getComputedStyle(note).lineHeight));
    })()`);
    console.log(`${opened > 2 ? 'PASS' : 'FAIL'} system note opened by a click: ${opened} lines`);
    await shot('system-long-opened');
    await page(`document.querySelector('.sys-card').click(); true`);
    await page(`houseTest.refreshStatus().then(() => { houseTest.toggleSystem(false); return true; })`);
    await sleep(300);
  },
  async systemNarrow({ page, shot }) {
    await page(`(() => { const app = document.querySelector('.app'); app.dataset.was = app.style.width; app.style.width = '560px'; houseTest.toggleSystem(true); return true; })()`);
    await sleep(1500);
    await shot('system-narrow');
    await page(`(() => { const pane = document.getElementById('system-pane'); pane.scrollTop = pane.scrollHeight; return true; })()`);
    await sleep(400);
    await shot('system-narrow-bottom');
    await page(`(() => { houseTest.toggleSystem(false); const app = document.querySelector('.app'); app.style.width = app.dataset.was; return true; })()`);
    await sleep(400);
  },
  // House Rules is a page in a tab. Done closes it and goes back to the page it was opened from.
  async rules({ page, shot }) {
    const before = await page(`houseTest.state.active.kind + ':' + (houseTest.state.active.path || '')`);
    page(`houseTest.showRules(); true`);
    await sleep(1200);
    await shot('rules-top');
    await page(`(() => { const view = document.getElementById('rules-view'); view.scrollTop = view.scrollHeight; return true; })()`);
    await sleep(400);
    await shot('rules-scrolled');
    await page(`document.querySelector('.rules-done').click(); true`);
    await sleep(400);
    const after = await page(`houseTest.state.active.kind + ':' + (houseTest.state.active.path || '')`);
    const tabs = await page(`[...document.querySelectorAll('.tab .tab-title')].map((t) => t.textContent).join('|')`);
    console.log(`${after === before && !tabs.includes('House Rules') ? 'PASS' : 'FAIL'} Done goes back: before ${before}, after ${after}, tabs ${tabs}`);
  },
  // The Windows lock is the real one, whatever HOME is. So this only ever runs while it's locked,
  // where pressing it just asks, and the question is always cancelled, never answered.
  async unlock({ page, shot }) {
    await page(`houseTest.refreshStatus().then(() => true)`);
    if (await page(`houseTest.state.status.doorOpen`)) {
      console.log('FAIL unlock: Windows files are unlocked right now, so this picture was skipped');
      return;
    }
    page(`houseTest.toggleDoor(); true`);
    await sleep(800);
    const width = await page(`[document.getElementById('dialog').className, Math.round(document.getElementById('dialog').getBoundingClientRect().width)]`);
    console.log(`${width[0] === 'dialog' ? 'PASS' : 'FAIL'} unlock pop-up after House Rules: class "${width[0]}", ${width[1]}px wide`);
    await shot('unlock-dialog');
    await page(`document.getElementById('dialog').close(); true`);
    await sleep(300);
  },
  // Tabs that aren't selected sit flat on the strip, the same height as the selected one, with a
  // line between them (none beside the selected one or a tinted AI tab).
  async tabsLook({ page, shot }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    await page(`(async () => {
      for (const place of [houseTest.state.projects, houseTest.state.projects + '/SampleApp', houseTest.state.home + '/Documents']) {
        document.getElementById('new-tab').click();
        houseTest.navigate(place);
        await new Promise((done) => setTimeout(done, 300));
      }
      return true;
    })()`);
    await sleep(800);
    const tabs = await page(`(() => {
      const all = [...document.querySelectorAll('.tabs .tab')];
      all[1].classList.add('agent-working');
      activateTab(houseTest.state.tabs.find((tab) => tab.el === all[2]));
      return all.map((tab) => [tab.querySelector('.tab-title').textContent, tab.classList.contains('active'), Math.round(tab.getBoundingClientRect().height), getComputedStyle(tab, '::before').display]);
    })()`);
    await sleep(500);
    const after = await page(`[...document.querySelectorAll('.tabs .tab')].map((tab) => [tab.querySelector('.tab-title').textContent, tab.classList.contains('active'), Math.round(tab.getBoundingClientRect().height), getComputedStyle(tab, '::before').display, getComputedStyle(tab).backgroundColor])`);
    const heights = new Set(after.map((tab) => tab[2]));
    report(heights.size === 1, `every tab the same height: ${JSON.stringify(after)}`);
    const active = after.findIndex((tab) => tab[1]);
    report(after.every((tab, i) => tab[3] === 'none' || (!tab[1] && i > 0 && !after[i - 1][1])), 'no line beside the selected tab');
    report(after.filter((tab, i) => !tab[1] && i !== 1).every((tab) => tab[4] === 'rgba(0, 0, 0, 0)'), 'tabs not selected have no background of their own');
    console.log(`INFO tabs before the click: ${JSON.stringify(tabs)}, selected: ${active}`);
    await shot('tabs-look');
    await page(`document.querySelector('.tabs .tab.agent-working')?.classList.remove('agent-working'); true`);
  },
  // The Home page: four numbers, project cards and recent files, from made-up AI notes and token
  // counts in the throwaway HOME. New tabs open on it; it isn't a folder, so nothing drops on it.
  async home({ page, shot }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const home = require('os').homedir();
    if (!home.startsWith('/tmp/')) { report(false, 'home: needs the throwaway HOME'); return; }
    const projects = path.join(home, 'projects');
    const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    write(path.join(projects, 'SampleApp', 'src', 'app.js'), 'console.log(1);\n');
    write(path.join(projects, 'SampleApp', 'README.md'), '# SampleApp\n');
    write(path.join(projects, 'SampleApp', 'target', 'debug', 'build.bin'), 'x');
    write(path.join(projects, 'SampleApp', '.rust', 'cargo', '.global-cache'), 'x');
    write(path.join(home, 'Downloads', 'notes.md'), 'notes\n');
    const now = Date.now();
    const note = (file, ago, model = 'claude-opus-5-5') => JSON.stringify({ time: now - ago, path: `/workspace/${file}`, tool: 'claude', model, action: 'edit' });
    write(path.join(home, '.local', 'state', 'house', 'edits', 'SampleApp', 'edits.jsonl'),
      [note('README.md', 60000), note('src/app.js', 30000), note('target/debug/build.bin', 20000), note('.rust/cargo/.global-cache', 10000), note('src/app.js', 2 * 86400000)].join('\n') + '\n');
    const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    // Tokens today and yesterday, and a lot on the Saturday before this week (Sunday on): that one is
    // last week and must not count. (Run on a Sunday, yesterday is that Saturday.)
    const tokenDays = {};
    const addTokens = (key, read, wrote) => { const have = tokenDays[key] || (tokenDays[key] = [0, 0]); have[0] += read; have[1] += wrote; };
    const calendarDay = (back) => { const d = new Date(now); return day(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime()); };
    addTokens(calendarDay(0), 166356193, 285310);
    addTokens(calendarDay(1), 90000000, 120000);
    addTokens(calendarDay(new Date(now).getDay() + 1), 500000000, 0);
    write(path.join(home, '.local', 'state', 'house', 'token-counts.json'), JSON.stringify({ sources: { house: { dirty: false, files: { '/stand-in.jsonl': { offset: 1, ids: [], days: tokenDays } } } } }));
    // Utimes: the files were saved just before the AI's notes, so the AI is their last editor.
    for (const [file, ago] of [['README.md', 61000], ['src/app.js', 31000]]) {
      const when = new Date(now - ago);
      fs.utimesSync(path.join(projects, 'SampleApp', file), when, when);
    }
    // More projects than fit in one row, all older than SampleApp.
    ['Atlas', 'Beacon', 'Cobalt', 'Delta', 'Ember', 'Fjord'].forEach((name, i) => {
      const folder = path.join(projects, name);
      fs.mkdirSync(folder, { recursive: true });
      const when = new Date(now - (i + 1) * 3600000);
      fs.utimesSync(folder, when, when);
    });


    // The project cards that show, the cards' tops (one row has one top), and how many should show
    // at the page's width (each card keeps at least 220px).
    await page(`window.projectRow = () => {
      const view = document.getElementById('home-view');
      const style = getComputedStyle(view);
      const width = view.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const shown = [...document.querySelectorAll('.home-card[data-project]')].filter((card) => card.offsetParent !== null);
      return { width, shown: shown.length, tops: [...new Set(shown.map((card) => card.offsetTop))].length, fits: Math.max(1, Math.min(6, Math.floor((width + 12) / 232))) };
    }; true`);
    await page(`(() => { houseTest.navigate('home:'); return true; })()`);
    await sleep(5000);
    const seen = await page(`(() => ({
      path: houseTest.state.active.path,
      title: houseTest.state.active.el.querySelector('.tab-title').textContent,
      address: document.getElementById('address').textContent,
      tiles: [...document.querySelectorAll('.home-tile')].map((tile) => tile.querySelector('.home-tile-label').textContent + ': ' + tile.querySelector('.home-tile-value').textContent + ' / ' + tile.querySelector('.home-tile-note').textContent),
      cards: [...document.querySelectorAll('.home-card[data-project]')].map((card) => card.dataset.project),
      newCard: Boolean(document.querySelector('.home-card-new')),
      roomRow: document.querySelectorAll('.home-card-state').length,
      // Each card: [name, top right (time, or "light" for an open room), the AI line, width].
      cardLook: [...document.querySelectorAll('.home-card[data-project]')].filter((card) => card.offsetParent !== null).map((card) => [card.dataset.project,
        card.querySelector('.home-card-time')?.textContent || (card.querySelector('.light') ? 'light' : ''), card.querySelector('.home-card-note').textContent, Math.round(card.getBoundingClientRect().width)]),
      // Days and hours: one size and color, no small grey words.
      // Every number one size and color, no small grey words.
      fullSize: [...document.querySelectorAll('.home-tile-value')].map((value) => value.children.length === 0),
      tileIcons: [...document.querySelectorAll('.home-tile-head i[data-i]')].map((i) => i.dataset.i + ' ' + (i.classList.contains('tint-orange') ? 'orange' : i.classList.contains('tint-blue') ? 'blue' : i.className)),
      sections: [...document.querySelectorAll('.home-section-title')].map((title) => title.textContent),
      row: projectRow(),
      recent: [...document.querySelectorAll('.home-recent-row:not(.home-recent-head) .name-text')].map((name) => name.textContent),
      editors: [...document.querySelectorAll('.home-recent-row:not(.home-recent-head) .cell-editor')].map((cell) => cell.textContent),
      listHidden: document.getElementById('rows').hidden && document.getElementById('columns').hidden,
      navHome: document.querySelector('.nav-item[data-nav="home"]').classList.contains('selected'),
      upOff: document.getElementById('up').disabled,
      pasteOff: document.getElementById('paste').disabled,
      searchOff: document.getElementById('search').disabled,
      drop: dropArea(),
    }))()`);
    report(seen.path === 'home:' && seen.title === 'Home' && seen.address.includes('Home'), `Home tab: ${JSON.stringify([seen.path, seen.title, seen.address])}`);
    report(seen.tiles.length === 4, `four tiles: ${JSON.stringify(seen.tiles)}`);
    // AI notes today and two days ago, tokens yesterday: three days in a row.
    report(/Day Streak: 3 Days \/ AI worked today/.test(seen.tiles[0] || ''), 'the streak counts AI notes and token days, with a capital D');
    report(seen.fullSize.length === 4 && seen.fullSize.every(Boolean), `"Days" and the numbers are full size and black: ${JSON.stringify(seen.fullSize)}`);
    report(!seen.tiles.some((tile) => /awake/i.test(tile)), 'no awake time tile');
    // This week = Sunday to today, so yesterday counts unless today is Sunday; last Saturday never does.
    const sunday = new Date().getDay() === 0;
    report(seen.tiles[1] === `Today's Input Tokens: 166M / This week: ${sunday ? '166M' : '256M'}`, `input tokens, this week from Sunday: ${JSON.stringify(seen.tiles[1])}`);
    report(seen.tiles[2] === `Today's Output Tokens: 285K / This week: ${sunday ? '285K' : '405K'}`, `output tokens, this week from Sunday: ${JSON.stringify(seen.tiles[2])}`);
    report(seen.tiles[3] === 'Files AI Created/Modified: 2 / Most in SampleApp (2)', `files AI created or modified today, without build files: ${JSON.stringify(seen.tiles[3])}`);
    report(JSON.stringify(seen.tileIcons) === JSON.stringify(['fire-filled orange', 'arrow_trending_down-filled blue', 'arrow_trending-filled blue', 'document_edit-filled blue']),
      `two colors: an orange fire, the rest blue; chart arrows for tokens: ${JSON.stringify(seen.tileIcons)}`);
    report(seen.sections[0] === 'Most Recent' && seen.cards.length === 6 && seen.cards[0] === 'SampleApp' && !seen.newCard && seen.roomRow === 0, `Most Recent: the 6 latest projects, no New Project card, no Room open/asleep row: ${JSON.stringify([seen.sections, seen.cards, seen.roomRow])}`);
    // The row hides projects that don't fit; See all projects opens the folder where every one is.
    const seeAll = await page(`(() => { const link = document.querySelector('#home-view .home-see-all'); if (!link) return null; const words = link.textContent; link.click(); return [words, houseTest.state.active.path === houseTest.state.projects]; })()`);
    report(seeAll && /^See all projects \(\d+\)$/.test(seeAll[0]) && seeAll[1], `See all projects is next to Most Recent and opens the Projects folder: ${JSON.stringify(seeAll)}`);
    await page(`(() => { houseTest.navigate(HOME_PAGE); return true; })()`);
    await sleep(600);
    // A project made outside Station (like `room new` in a terminal) shows when the window gets focus.
    const countNow = (words) => Number((/\((\d+)\)/.exec(words) || [])[1]);
    const before = countNow(await page(`document.querySelector('#home-view .home-see-all').textContent`));
    fs.mkdirSync(path.join(require('os').homedir(), 'projects', 'Made Outside'), { recursive: true });
    await page(`(() => { window.dispatchEvent(new Event('focus')); return true; })()`);
    await sleep(800);
    const after = countNow(await page(`document.querySelector('#home-view .home-see-all').textContent`));
    report(after === before + 1, `a project made outside Station shows on Home after the window gets focus: ${before} -> ${after}`);
    // Rooms asleep here: the time is top right. The AI line names the AI, or says there's none.
    const look = Object.fromEntries(seen.cardLook.map(([name, ...rest]) => [name, rest]));
    report(/^(just now|\d+ min ago)$/.test(look.SampleApp?.[0]) && look.SampleApp?.[1] === 'Claude Opus 5.5'
      && seen.cardLook.filter(([name]) => name !== 'SampleApp').every(([, corner, note]) => /^(just now|\d+ (min|h|d) ago)$/.test(corner) && note === 'No recent AI changes')
      && seen.cardLook.every(([, , , width]) => width <= 236), `cards: time top right, the AI on its own line, 236px at most: ${JSON.stringify(seen.cardLook)}`);
    // As if SampleApp's room were open (only the page is told): its Enter Room is filled in green,
    // with a filled play icon; Open Room stays plain.
    const buttons = await page(`(() => {
      const was = state.status;
      state.status = { ...was, rooms: [{ name: 'SampleApp' }] };
      drawHome();
      const look = (name) => {
        const button = document.querySelector('.home-card[data-project="' + name + '"] .home-card-btn');
        const style = getComputedStyle(button);
        return [button.textContent, button.classList.contains('live'), button.querySelector('i[data-i]').dataset.i, style.backgroundColor, style.fontWeight + ' ' + style.webkitTextStrokeWidth];
      };
      const seenNow = { open: look('SampleApp'), asleep: look('Notes App') };
      state.status = was;
      drawHome();
      return seenNow;
    })()`);
    report(buttons.open[0] === 'Enter Room' && buttons.open[1] && buttons.open[2] === 'play-filled' && buttons.open[3] === 'rgb(230, 244, 236)' && buttons.open[4] === '400 0px'
      && buttons.asleep[0] === 'Open Room' && !buttons.asleep[1] && buttons.asleep[2] === 'play' && buttons.asleep[3] !== buttons.open[3] && buttons.asleep[4] === buttons.open[4], `an open room's Enter Room is filled in green, its words regular like Open Room: ${JSON.stringify(buttons)}`);
    // The card's corner time stays short: just under a day is "1 d ago", never a full date.
    const corner = await page(`[0.2, 5, 120, 23 * 60 + 50, 3 * 1440, 45 * 1440].map((minutes) => cardAgo(Date.now() - minutes * 60000))`);
    report(JSON.stringify(corner.slice(0, 5)) === JSON.stringify(['just now', '5 min ago', '2 h ago', '1 d ago', '3 d ago']) && /^[A-Z][a-z]{2} \d{1,2}$/.test(corner[5]), `card times stay short: ${JSON.stringify(corner)}`);
    report(seen.row.tops === 1 && seen.row.shown === seen.row.fits, `the projects are one row, as many as fit: ${JSON.stringify(seen.row)}`);
    report(seen.recent.includes('app.js') && seen.recent.includes('README.md') && seen.recent.includes('notes.md') && !seen.recent.includes('build.bin') && !seen.recent.includes('.global-cache'), `recent files, without build or hidden files: ${JSON.stringify(seen.recent)}`);
    report(seen.editors.some((text) => /Claude Opus 5\.5/.test(text)), `recent files say which AI: ${JSON.stringify(seen.editors)}`);
    report(seen.listHidden && seen.navHome && seen.upOff && seen.pasteOff && seen.searchOff && seen.drop === null, `no list, paste, search or drop on Home; Home picked in the sidebar: ${JSON.stringify([seen.listHidden, seen.navHome, seen.upOff, seen.pasteOff, seen.searchOff, seen.drop])}`);
    await shot('home');

    // Recent files work like a folder's: click, Ctrl+click, Shift+click, the right-click menu and keys.
    const recentNow = () => page(`(() => ({
      picked: [...houseTest.state.selected].map((item) => item.split('/').pop()).sort(),
      marked: [...document.querySelectorAll('.home-recent-row.selected .name-text')].map((name) => name.textContent).sort(),
      names: [...document.querySelectorAll('.home-recent-row[data-path] .name-text')].map((name) => name.textContent),
    }))()`);
    const clickRecent = (name, keys = {}, type = 'click') => page(`(() => { const row = [...document.querySelectorAll('.home-recent-row[data-path]')].find((node) => node.querySelector('.name-text').textContent === ${JSON.stringify(name)}); const box = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, clientX: box.left + 40, clientY: box.top + 10, ...${JSON.stringify(keys)} })); return true; })()`);
    const homeKey = (key, keys = {}) => page(`(() => { document.getElementById('home-view').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(keys)} })); return true; })()`);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const toolbar = () => page(`['cut', 'copy', 'paste', 'rename', 'delete'].map((id) => (document.getElementById(id).disabled ? '-' : '') + id)`);
    const none = await toolbar();
    await clickRecent('README.md');
    const one = await recentNow();
    const oneTools = await toolbar();
    await clickRecent('app.js', { ctrlKey: true });
    const two = await recentNow();
    const twoTools = await toolbar();
    report(same(one.picked, ['README.md']) && same(one.marked, one.picked) && same(two.picked, ['README.md', 'app.js']) && same(two.marked, two.picked), `recent files: a click picks one, Ctrl+click adds: ${JSON.stringify([one, two].map((seen) => seen.marked))}`);
    report(same(none, ['-cut', '-copy', '-paste', '-rename', '-delete']) && same(oneTools, ['cut', 'copy', '-paste', 'rename', 'delete']) && same(twoTools, ['cut', 'copy', '-paste', '-rename', 'delete']),
      `recent files: the toolbar's Cut, Copy, Rename and Delete work on them (never Paste): ${JSON.stringify([none, oneTools, twoTools])}`);
    const names = two.names;
    await clickRecent(names[0]);
    await clickRecent(names[names.length - 1], { shiftKey: true });
    const range = await recentNow();
    report(range.picked.length === names.length && range.marked.length === names.length, `recent files: Shift+click picks everything between: ${JSON.stringify(range.marked)}`);
    await clickRecent('README.md', { ctrlKey: true });
    await clickRecent('app.js', {}, 'contextmenu');
    const menu = await page(`[...document.querySelectorAll('#menu .menu-item')].map((row) => (row.disabled ? '-' : '') + row.textContent)`);
    report(['Open', 'Open File Location', 'Cut', 'Copy', 'Copy as Path', 'Compress to ZIP File', '-Rename', 'Delete', 'Properties'].every((label) => menu.includes(label)), `recent files: right-click has a folder's menu (Rename off for two): ${JSON.stringify(menu)}`);
    await page(`closeMenu(); true`);
    await page(`(() => {
      window.recentCalls = [];
      window.recentWas = { toClipboard, deleteSelected, copyAsPath, showProperties };
      window.toClipboard = (move) => recentCalls.push(move ? 'cut' : 'copy');
      window.deleteSelected = (forever) => recentCalls.push(forever ? 'delete forever' : 'delete');
      window.copyAsPath = (paths) => recentCalls.push('path ' + paths.length);
      window.showProperties = (paths) => recentCalls.push('properties ' + paths.length);
      return true;
    })()`);
    await homeKey('c', { ctrlKey: true });
    await homeKey('x', { ctrlKey: true });
    await homeKey('C', { ctrlKey: true, shiftKey: true });
    await homeKey('Delete');
    await homeKey('Delete', { shiftKey: true });
    await homeKey('Enter', { altKey: true });
    const calls = await page(`(() => { Object.assign(window, recentWas); return recentCalls; })()`);
    report(same(calls, ['copy', 'cut', 'path 2', 'delete', 'delete forever', 'properties 2']), `recent files: Ctrl+C, Ctrl+X, Ctrl+Shift+C, Delete, Shift+Delete, Alt+Enter: ${JSON.stringify(calls)}`);
    await homeKey('Escape');
    const let1 = await recentNow();
    await homeKey('a', { ctrlKey: true });
    const all = await recentNow();
    await page(`(() => { document.querySelector('#home-view .home-section-title').click(); return true; })()`);
    const off = await recentNow();
    report(!let1.picked.length && all.picked.length === names.length && !off.picked.length && !off.marked.length, `recent files: Escape and a click away let go; Ctrl+A picks all: ${JSON.stringify([let1.picked.length, all.picked.length, off.picked.length])}`);
    await clickRecent('notes.md');
    await homeKey('F2');
    await sleep(300);
    const asked = await page(`(() => { const input = document.querySelector('#dialog .dialog-input'); if (!input) return null; const was = input.value; input.value = 'notes-renamed.md'; document.querySelector('#dialog .btn.primary').click(); return was; })()`);
    await sleep(1500);
    const renamed = await recentNow();
    report(asked === 'notes.md' && fs.existsSync(path.join(home, 'Downloads', 'notes-renamed.md')) && renamed.names.includes('notes-renamed.md') && same(renamed.marked, ['notes-renamed.md']), `recent files: F2 renames: ${JSON.stringify([asked, renamed.names, renamed.marked])}`);
    await clickRecent('app.js', { ctrlKey: true });
    await page(`(() => { const view = document.getElementById('home-view'); view.scrollTop = view.scrollHeight; return true; })()`);
    await sleep(300);
    await shot('home-recent-picked');
    await page(`(() => { document.getElementById('home-view').scrollTop = 0; return true; })()`);
    await page(`(() => { houseTest.state.selected = new Set(); markRecent(); return true; })()`);

    // A card opens its project; Back comes home.
    await page(`(() => { document.querySelector('.home-card[data-project="SampleApp"]').click(); return true; })()`);
    await sleep(800);
    const into = await page(`houseTest.state.active.path`);
    await page(`(() => { document.getElementById('back').click(); return true; })()`);
    await sleep(800);
    const back = await page(`houseTest.state.active.path`);
    report(into.endsWith('/projects/SampleApp') && back === 'home:', `a card opens the project, Back comes home: ${into} -> ${back}`);

    // Open file location: the folder, with the file picked.
    await page(`(() => { [...document.querySelectorAll('.home-recent-place')].find((node) => node.closest('.home-recent-row').textContent.includes('app.js')).click(); return true; })()`);
    await sleep(900);
    const located = await page(`[houseTest.state.active.path, [...houseTest.state.selected]]`);
    report(located[0].endsWith('/SampleApp/src') && located[1].some((item) => item.endsWith('/src/app.js')), `Open file location: ${JSON.stringify(located)}`);

    // New tabs open on Home: the + button and Ctrl+T, from a folder.
    const tabsBefore = await page(`houseTest.state.tabs.length`);
    await page(`(() => { document.getElementById('new-tab').click(); return true; })()`);
    await sleep(800);
    const plus = await page(`[houseTest.state.tabs.length, houseTest.state.active.path]`);
    await page(`(() => { houseTest.navigate(houseTest.state.projects); return true; })()`);
    await sleep(600);
    await page(`(() => { document.getElementById('rows').dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
    await sleep(800);
    const ctrlT = await page(`[houseTest.state.tabs.length, houseTest.state.active.path]`);
    report(plus[0] === tabsBefore + 1 && plus[1] === 'home:' && ctrlT[0] === tabsBefore + 2 && ctrlT[1] === 'home:', `+ and Ctrl+T open Home: ${JSON.stringify([tabsBefore, plus, ctrlT])}`);

    // Narrow: two tiles a row, and recent files keep name and date.
    // Narrow: fewer project cards, still one row. (The new tabs above are Home too.)
    const rowAt = async (width) => {
      await page(`(() => { const app = document.querySelector('.app'); app.style.width = '${width}px'; return true; })()`);
      await sleep(500);
      return page(`projectRow()`);
    };
    await page(`(() => { const app = document.querySelector('.app'); app.dataset.was = app.style.width; return true; })()`);
    const rows = [];
    for (const width of [1750, 1450, 1200, 950, 700, 480]) rows.push(await rowAt(width));
    report(rows.every((row) => row.tops === 1 && row.shown === row.fits) && rows[0].shown === 6 && rows[rows.length - 1].shown < rows[0].shown,
      `one row at every width, fewer as it narrows: ${JSON.stringify(rows.map((row) => [Math.round(row.width), row.shown]))}`);
    await page(`(() => { const app = document.querySelector('.app'); app.style.width = '640px'; return true; })()`);
    await sleep(600);
    await shot('home-narrow');
    await page(`(() => { const app = document.querySelector('.app'); app.style.width = app.dataset.was; return true; })()`);
    await sleep(300);

    // A house terminal's tab says Linux House.
    await page(`houseTest.openTerminal({ cwd: houseTest.state.home }).then(() => true)`);
    await sleep(1500);
    const termTitle = await page(`houseTest.state.active.el.querySelector('.tab-title').textContent`);
    report(termTitle === 'Linux House', `a house terminal's tab says ${JSON.stringify(termTitle)}`);
    await page(`houseTest.closeTab(houseTest.state.active).then(() => true)`);
    await sleep(600);
    await page(ONE_TAB_LEFT);
    await sleep(600);
  },
  // Videos the editor can't read as they are (an AVI, an HDR HEVC video like an iPhone's) go in
  // through a copy Station makes first, and their exports still save beside the original.
  async editorCopies({ page }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} editorCopies: ${text}`);
    const home = require('os').homedir();
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    const { execFileSync } = require('child_process');
    const dir = path.join(home, 'Videos', 'Copies');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const avi = path.join(dir, 'old camera.avi');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=720x480:d=3:r=30', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:v', 'mpeg4', '-q:v', '4', '-vf', 'setsar=8/9', '-c:a', 'mp3', '-shortest', avi]);
    const hevc = path.join(dir, 'phone.mov');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=3:r=30', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest', hevc]);
    const guest = (code) => page(`(async () => { const tab = state.tabs.find((t) => t.kind === 'editor'); if (!tab) return 'no tab'; try { return await tab.view.executeJavaScript(${JSON.stringify(code)}); } catch (error) { return 'error: ' + error.message; } })()`);
    for (const [file, name] of [[avi, 'old camera.avi'], [hevc, 'phone.mov']]) {
      await page(`(() => { openEditor(${JSON.stringify(file)}); return true; })()`);
      let text = '';
      let sawProgress = false;
      for (let at = 0; at < 300; at += 1) {
        text = String(await guest('document.body.innerText').catch(() => ''));
        if (/ready to edit… \d+%/.test(text)) sawProgress = true;
        if (new RegExp(`${name.replace('.', '\\.')} is ready to edit|couldn.t be added`).test(text)) break;
        await sleep(200);
      }
      const ready = new RegExp(`${name.replace('.', '\\.')} is ready to edit`).test(text);
      const preview = await guest(`(() => { const c = document.querySelector('canvas'); return c ? c.width + 'x' + c.height : 'none'; })()`);
      await sleep(1000);
      await guest(`(() => { const b = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Export'); b.click(); return true; })()`);
      await sleep(800);
      await guest(`(() => { const all = [...document.querySelectorAll('[data-radix-popper-content-wrapper] button, [role=dialog] button')]; const b = all.reverse().find((n) => /^Export/.test(n.textContent.trim())); b.click(); return true; })()`);
      const made = path.join(dir, `${name.replace(/\.[^.]+$/, '')} (edited).mp4`);
      for (let at = 0; at < 300 && !fs.existsSync(made); at += 1) await sleep(200);
      await sleep(500);
      const probe = fs.existsSync(made) ? execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', made]).toString().trim().split('\n') : null;
      report(ready && probe && /h264,(\d+),(\d+)/.test(probe[0]), `${name} goes in through a copy (progress shown: ${sawProgress}) and exports beside it: ${JSON.stringify([ready, preview, probe, text.match(/couldn.t be added[^\n]*\n?[^\n]*/)?.[0]])}`);
    }
    await page(`(() => { [...state.tabs].filter((tab) => tab.kind === 'editor').forEach((tab) => removeTab(tab)); return true; })()`);
  },

  // Pictures of the editor in Station's look: its projects page, and a video open in it.
  async editorLook({ page, shot }) {
    if (!ONLY.includes('editorLook')) return;
    const home = require('os').homedir();
    const { execFileSync } = require('child_process');
    const dir = path.join(home, 'Videos', 'Look');
    fs.mkdirSync(dir, { recursive: true });
    const clip = path.join(dir, 'Beach day.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=6:r=30', '-f', 'lavfi', '-i', 'sine=f=330:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
    const guest = (code) => page(`(async () => { const tab = state.tabs.find((t) => t.kind === 'editor'); if (!tab) return 'no tab'; try { return await tab.view.executeJavaScript(${JSON.stringify(code)}); } catch (error) { return 'error: ' + error.message; } })()`);
    await page(`(() => { openEditor(${JSON.stringify(clip)}); return true; })()`);
    for (let at = 0; at < 100; at += 1) {
      if (await guest(`/ready to edit/.test(document.body.innerText)`).catch(() => false) === true) break;
      await sleep(200);
    }
    await sleep(4500);
    await shot('editor-look');
    await guest(`(() => { const b = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Export'); b.click(); return true; })()`);
    await sleep(900);
    await shot('editor-look-export');
    await guest(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await page(`(() => { openEditor(); return true; })()`);
    await sleep(3000);
    await shot('editor-look-projects');
    const fonts = await guest(`getComputedStyle(document.body).fontFamily`);
    console.log(`PASS editorLook: font ${fonts}`);
    await page(`(() => { [...state.tabs].filter((tab) => tab.kind === 'editor').forEach((tab) => removeTab(tab)); return true; })()`);
  },

  // How fast the editor runs on a full-size video (a measure, not a pass/fail; only when named).
  async editorSpeed({ page, shot }) {
    if (!ONLY.includes('editorSpeed')) return;
    const report = (text) => console.log(`PASS editorSpeed: ${text}`);
    const home = require('os').homedir();
    if (!home.startsWith('/tmp/')) return;
    const { execFileSync } = require('child_process');
    const dir = path.join(home, 'Videos', 'Speed');
    fs.mkdirSync(dir, { recursive: true });
    const clip = path.join(dir, 'big.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:d=20:r=30', '-f', 'lavfi', '-i', 'sine=f=440:d=20', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
    const guest = (code) => page(`(async () => { const tab = state.tabs.find((t) => t.kind === 'editor'); if (!tab) return 'no tab'; try { return await tab.view.executeJavaScript(${JSON.stringify(code)}); } catch (error) { return 'error: ' + error.message; } })()`);
    const started = Date.now();
    await page(`(() => { openEditor(${JSON.stringify(clip)}); return true; })()`);
    let ready = false;
    for (let at = 0; at < 300 && !ready; at += 1) {
      await sleep(200);
      ready = await guest(`/ready to edit/.test(document.body.innerText)`).catch(() => false) === true;
    }
    report(`ready to edit after ${((Date.now() - started) / 1000).toFixed(1)} s (${ready})`);
    if (!ready) {
      report(JSON.stringify(String(await guest('document.body.innerText')).slice(0, 400)));
      await shot('editor-speed');
      return;
    }
    await sleep(1500);
    // Count the screen frames that drew a new picture while playing for 5 seconds.
    await guest(`(() => { window.__drawn = 0; window.__frames = 0; let drew = false; const proto = WebGL2RenderingContext.prototype; for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) { const old = proto[name]; proto[name] = function (...args) { drew = true; return old.apply(this, args); }; } const tick = () => { window.__frames += 1; if (drew) window.__drawn += 1; drew = false; if (window.__frames < 100000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
    const playButton = `(() => { const b = document.querySelector('.grid > button'); if (!b) return 'missing'; b.click(); return 'ok'; })()`;
    await guest(`(() => { window.__drawn = 0; window.__frames = 0; return true; })()`);
    const clicked = await guest(playButton);
    const t0 = Date.now();
    await sleep(5000);
    const counts = await guest(`({ drawn: window.__drawn, frames: window.__frames, time: document.querySelector('.grid')?.innerText.split('\\n')[0] })`);
    await guest(playButton);
    const seconds = (Date.now() - t0) / 1000;
    report(`playing 1080p: ${clicked}, ${(counts.drawn / seconds).toFixed(1)} new pictures a second (of ${(counts.frames / seconds).toFixed(1)} screen frames), clock ${counts.time}`);
    // Export the whole 20 s video.
    await guest(`(() => { const b = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Export'); b.click(); return true; })()`);
    await sleep(800);
    await guest(`(() => { const all = [...document.querySelectorAll('[data-radix-popper-content-wrapper] button, [role=dialog] button')]; const b = all.reverse().find((n) => /^Export/.test(n.textContent.trim())); b.click(); return true; })()`);
    const t1 = Date.now();
    const made = path.join(dir, 'big (edited).mp4');
    for (let at = 0; at < 1500 && !fs.existsSync(made); at += 1) await sleep(200);
    report(`export of 20 s at 1080p took ${((Date.now() - t1) / 1000).toFixed(1)} s (${fs.existsSync(made)})`);
    await page(`(() => { [...state.tabs].filter((tab) => tab.kind === 'editor').forEach((tab) => removeTab(tab)); return true; })()`);
  },

  // The video editor (OpenCut, made Station's own) opens from a video's page with that video on its
  // timeline, and what it exports is saved beside the video (editor-tab.js, lib/editor-app.js).
  async editorOpen({ page, shot }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} editorOpen: ${text}`);
    const home = require('os').homedir();
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    const { execFileSync } = require('child_process');
    const dir = path.join(home, 'Videos', 'Editor Test');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const clip = path.join(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=4:r=30', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
    const waitFor = async (test, tries = 50, gap = 200) => {
      let value = null;
      for (let at = 0; at < tries; at += 1) {
        value = await page(test).catch(() => null);
        if (value && value !== 'no') return value;
        await sleep(gap);
      }
      return value;
    };
    // Code run inside the editor's own page.
    const guest = (code) => page(`(async () => { const tab = state.tabs.find((t) => t.kind === 'editor'); if (!tab) return 'no tab'; try { return await tab.view.executeJavaScript(${JSON.stringify(code)}); } catch (error) { return 'error: ' + error.message; } })()`);
    const entry = JSON.stringify({ path: clip, name: 'clip.mp4', isDir: false, size: fs.statSync(clip).size, mtime: fs.statSync(clip).mtimeMs });

    await page(`(() => { houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
    await sleep(700);
    await page(`(() => { openFile(${entry}); return true; })()`);
    await waitFor(`(() => state.active?.kind === 'video' && state.active.video.readyState >= 1 ? 'yes' : 'no')()`);
    const button = await page(`(() => { const b = state.active.host.querySelector('.vt-editor'); if (!b) return 'missing'; b.click(); return 'ok'; })()`);
    const opened = await waitFor(`(() => state.active?.kind === 'editor' ? 'yes' : 'no')()`, 30);
    await page(`(() => { const tab = state.tabs.find((t) => t.kind === 'editor'); if (tab && !tab.logged) { tab.logged = []; tab.view.addEventListener('console-message', (e) => { if (e.level >= 2) tab.logged.push(e.message.slice(0, 300)); }); } return true; })()`);
    const loaded = await waitFor(`(async () => { const tab = state.tabs.find((t) => t.kind === 'editor'); if (!tab) return 'no'; const url = tab.view.getURL(); if (!url.includes('/editor/?project=') || url.includes('import=')) return 'no'; const text = await tab.view.executeJavaScript('document.body.innerText'); return /ready to edit/.test(text) ? 'yes' : (/couldn.t be added/.test(text) ? 'failed: ' + text.slice(0, 300) : 'no'); })()`, 150);
    const where = await page(`(() => { const tab = state.tabs.find((t) => t.kind === 'editor'); return { url: tab?.view.getURL(), title: tab?.el.querySelector('.tab-title').textContent, logged: tab?.logged?.slice(0, 5) }; })()`);
    report(button === 'ok' && opened === 'yes' && loaded === 'yes' && where.title === 'Editor: clip', `Editor on the video's page opens the editor with the video added, its tab named for it: ${JSON.stringify([button, opened, loaded, where])}`);
    await sleep(1500);
    await shot('editor-open');
    if (loaded !== 'yes') return;

    const timeline = await guest(`[...document.querySelectorAll('div, span')].filter((n) => n.childElementCount === 0 && n.textContent.trim() === 'clip.mp4').length`);
    const canvas = await guest(`(() => { const c = document.querySelector('canvas'); return c ? c.width + 'x' + c.height : 'none'; })()`);
    report(Number(timeline) >= 2, `the video is in the media list and on the timeline: ${JSON.stringify([timeline, canvas])}`);
    const drawer = await guest(`(() => { const g = document.createElement('canvas').getContext('webgl2'); if (!g) return 'none'; const x = g.getExtension('WEBGL_debug_renderer_info'); return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : '?'; })()`);
    report(/D3D12/.test(String(drawer)), `the editor draws on the graphics card: ${drawer}`);

    // Export: saved into the house beside the video, as "clip (edited).mp4".
    const exportOpen = await guest(`(() => { const b = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Export'); if (!b) return 'missing'; b.click(); return 'ok'; })()`);
    await sleep(800);
    const exportGo = await guest(`(() => { const all = [...document.querySelectorAll('[data-radix-popper-content-wrapper] button, [role=dialog] button')]; const b = all.reverse().find((n) => /^Export/.test(n.textContent.trim())); if (!b) return 'missing: ' + all.map((n) => n.textContent.trim()).join('|'); b.click(); return 'ok'; })()`);
    const made = path.join(dir, 'clip (edited).mp4');
    for (let at = 0; at < 300 && !fs.existsSync(made); at += 1) await sleep(200);
    await sleep(500);
    let probe = null;
    if (fs.existsSync(made)) {
      probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'csv=p=0', made]).toString().trim().split('\n');
    }
    const after = await guest(`document.body.innerText.match(/Saved "[^"]+"|wasn't saved[^\\n]*/)?.[0] || ''`);
    const logged = await page(`state.tabs.find((t) => t.kind === 'editor')?.logged?.slice(-5)`);
    report(exportOpen === 'ok' && exportGo === 'ok' && probe && /Saved "clip \(edited\)\.mp4"/.test(after), `Export saves "clip (edited).mp4" beside the video: ${JSON.stringify([exportOpen, exportGo, probe, after, logged])}`);
    await shot('editor-export');

    // Another video opens in the same tab, after the open project is saved. The first video's
    // project comes back as it was, and closing the tab works.
    const firstProject = /project=([^&]+)/.exec(where.url)?.[1];
    const second = path.join(dir, 'second.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=2:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', second]);
    await guest(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await page(`(() => { openEditor(${JSON.stringify(second)}); return true; })()`);
    const switched = await waitFor(`(async () => { const tab = state.tabs.find((t) => t.kind === 'editor'); const url = tab.view.getURL(); if (url.includes(${JSON.stringify(firstProject)}) || url.includes('import=') || !url.includes('/editor/')) return 'no'; return /second\.mp4 is ready to edit/.test(await tab.view.executeJavaScript('document.body.innerText')) ? 'yes' : 'no'; })()`, 100);
    await page(`(() => { openEditor(${JSON.stringify(clip)}); return true; })()`);
    const back = await waitFor(`(async () => { const tab = state.tabs.find((t) => t.kind === 'editor'); if (!tab.view.getURL().includes(${JSON.stringify(firstProject)})) return 'no'; const n = await tab.view.executeJavaScript("[...document.querySelectorAll('div, span')].filter((n) => n.childElementCount === 0 && n.textContent.trim() === 'clip.mp4').length"); return n >= 2 ? 'yes' : 'no'; })()`, 100);
    const editors = await page(`state.tabs.filter((t) => t.kind === 'editor').length`);
    await page(`(() => { closeTab(state.tabs.find((t) => t.kind === 'editor')); return true; })()`);
    const closed = await waitFor(`(() => state.tabs.some((t) => t.kind === 'editor') ? 'no' : 'yes')()`, 40);
    report(switched === 'yes' && back === 'yes' && editors === 1 && closed === 'yes', `another video opens in the same tab, the first comes back as it was, the tab closes: ${JSON.stringify([switched, back, editors, closed])}`);
    await page(`(() => { [...state.tabs].filter((tab) => tab.kind === 'editor' || tab.kind === 'video').forEach((tab) => removeTab(tab)); return true; })()`);
  },

  // Whether big videos freeze Station (a measure; only when named). SHOT_VIDEOS is a folder with
  // hd.mp4 (1080p, 60 s), uhd.mp4 (4K), hevc.mp4 and old.avi, made beforehand with ffmpeg. For each
  // step: the longest the main process was held up, and the longest the page was (long tasks).
  async videoFreeze({ page }) {
    if (!ONLY.includes('videoFreeze')) return;
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} videoFreeze: ${text}`);
    const home = require('os').homedir();
    const from = process.env.SHOT_VIDEOS;
    if (!home.startsWith('/tmp/') || !from) { report(false, 'needs the throwaway HOME and SHOT_VIDEOS'); return; }
    const { execFile } = require('child_process');
    const { app, webContents } = require('electron');
    const dir = path.join(home, 'Videos', 'Freeze');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['hd.mp4', 'uhd.mp4', 'hevc.mp4', 'old.avi']) fs.copyFileSync(path.join(from, name), path.join(dir, name));
    const file = (name) => path.join(dir, name);
    // The main process: a timer every 5 ms, and how late it ever ran.
    let held = 0;
    let tick = Date.now();
    const meter = setInterval(() => { const now = Date.now(); held = Math.max(held, now - tick - 5); tick = now; }, 5);
    await page(`(() => { window.longTasks = []; new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(Math.round(e.duration)))).observe({ entryTypes: ['longtask'] }); window.progressSeen = 0; window.house.on('video:progress', () => { progressSeen += 1; }); return true; })()`);
    const lap = async () => {
      const long = await page(`(() => { const all = longTasks.splice(0); return { count: all.length, longest: Math.max(0, ...all) }; })()`);
      const main = held;
      held = 0;
      return `main held ${main} ms, page ${long.count} long tasks, longest ${long.longest} ms`;
    };
    const waitFor = async (test, tries = 50, gap = 100) => {
      let value = null;
      for (let at = 0; at < tries; at += 1) {
        value = await page(test);
        if (value && value !== 'no') return value;
        await sleep(gap);
      }
      return value;
    };
    // ffmpeg making a video (a save or a copy), not the quick single frames of a timeline strip.
    const ffmpegs = () => new Promise((resolve) => execFile('pgrep', ['-P', String(process.pid), '-f', '^ffmpeg .*libx264'], (_error, out) => resolve(String(out || '').trim().split('\n').filter(Boolean).length)));
    const open = async (name, tries = 100) => {
      const began = Date.now();
      await page(`(() => { openVideo(${JSON.stringify(file(name))}); return true; })()`);
      const ready = await waitFor(`(() => state.active?.kind === 'video' && state.active.path.endsWith(${JSON.stringify(name)}) && state.active.video.readyState >= 2 ? 'yes' : 'no')()`, tries);
      return { ready, ms: Date.now() - began };
    };
    const seeks = async (count) => page(`(async () => {
      const { video, info } = state.active;
      let longest = 0;
      for (let i = 0; i < ${count}; i += 1) {
        const began = performance.now();
        const done = new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
        video.currentTime = (info.duration * ((i * 7) % ${count} + 0.5)) / ${count};
        await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000))]);
        longest = Math.max(longest, performance.now() - began);
      }
      return Math.round(longest);
    })()`);
    const closeVideos = () => page(`(() => { [...state.tabs].filter((tab) => tab.kind === 'video' || tab.kind === 'editor').forEach((tab) => removeTab(tab)); return true; })()`);
    await lap();

    // 1080p: open, jump about, drag a handle, save a 30 s trim, stop a save.
    let opened = await open('hd.mp4');
    report(opened.ready === 'yes', `1080p opens in ${opened.ms} ms: ${await lap()}`);
    report(true, `30 jumps in 1080p, slowest ${await seeks(30)} ms: ${await lap()}`);
    await page(`(() => {
      const tab = state.active;
      const grip = tab.timeline.querySelector('.vt-grip-end');
      const box = grip.getBoundingClientRect();
      const track = tab.track.getBoundingClientRect();
      const at = (x) => ({ clientX: x, clientY: box.top + box.height / 2, bubbles: true, pointerId: 9, button: 0 });
      grip.dispatchEvent(new PointerEvent('pointerdown', at(box.left + box.width / 2)));
      for (let i = 0; i <= 60; i += 1) tab.timeline.dispatchEvent(new PointerEvent('pointermove', at(track.left + track.width * (1 - i / 120))));
      tab.timeline.dispatchEvent(new PointerEvent('pointerup', at(track.left + track.width * 0.5)));
      return true;
    })()`);
    await sleep(1500);
    report(true, `a handle dragged through 60 places: ${await lap()}`);
    let began = Date.now();
    await page(`(() => { saveVideo(state.active, false); return true; })()`);
    await waitFor(`(() => !state.active.job ? 'yes' : 'no')()`, 900);
    const copy = file('hd (edited).mp4');
    report(fs.existsSync(copy), `a 30 s 1080p trim saved as a copy in ${Date.now() - began} ms, ${await page('progressSeen')} progress notes: ${await lap()}`);
    await page(`(() => { saveVideo(state.active, false); return true; })()`);
    await sleep(1500);
    began = Date.now();
    await page(`(() => { state.active.stopButton.click(); return true; })()`);
    const stopped = await waitFor(`(() => !state.active.job ? 'yes' : 'no')()`, 100, 20);
    await sleep(300);
    const left = fs.readdirSync(dir).filter((name) => name.startsWith('.saving-') || / \(edited 2\)/.test(name));
    report(stopped === 'yes' && !left.length && await ffmpegs() === 0, `Stop ends a save in ${Date.now() - began} ms, nothing left behind ${JSON.stringify(left)}, ffmpeg running: ${await ffmpegs()}: ${await lap()}`);

    // 4K.
    opened = await open('uhd.mp4');
    report(opened.ready === 'yes', `4K opens in ${opened.ms} ms: ${await lap()}`);
    report(true, `10 jumps in 4K, slowest ${await seeks(10)} ms: ${await lap()}`);

    // HEVC: a playable copy is made. Closing the tab partway stops ffmpeg; opened again, it's made.
    await page(`(() => { openVideo(${JSON.stringify(file('hevc.mp4'))}); return true; })()`);
    await waitFor(`(() => state.active?.kind === 'video' && state.active.playJob ? 'yes' : 'no')()`);
    await sleep(600);
    const making = await ffmpegs();
    await page(`(() => { removeTab(state.active); return true; })()`);
    await sleep(700);
    report(making >= 1 && await ffmpegs() === 0, `closing an HEVC video while it's made ready stops ffmpeg (running before ${making}, after ${await ffmpegs()}): ${await lap()}`);
    opened = await open('hevc.mp4', 900);
    report(opened.ready === 'yes', `HEVC made ready and playing in ${opened.ms} ms: ${await lap()}`);
    opened = await open('old.avi', 900);
    report(opened.ready === 'yes', `AVI made ready and playing in ${opened.ms} ms: ${await lap()}`);
    await closeVideos();
    await sleep(500);

    // The editor: a 1080p video opened in it, then its tab opened and closed five times.
    const count = () => ({ pages: webContents.getAllWebContents().length, processes: app.getAppMetrics().length, memoryMB: Math.round(app.getAppMetrics().reduce((sum, one) => sum + one.memory.workingSetSize, 0) / 1024) });
    const before = count();
    began = Date.now();
    await page(`(() => { openEditor(${JSON.stringify(file('hd.mp4'))}); return true; })()`);
    const loaded = await waitFor(`(async () => { const tab = state.tabs.find((t) => t.kind === 'editor'); if (!tab) return 'no'; try { const url = tab.view.getURL(); if (!url.includes('/editor/?project=') || url.includes('import=')) return 'no'; return /ready to edit/.test(await tab.view.executeJavaScript('document.body.innerText')) ? 'yes' : 'no'; } catch { return 'no'; } })()`, 600);
    const withEditor = count();
    report(loaded === 'yes', `the 1080p video is in the editor in ${Date.now() - began} ms (${JSON.stringify(withEditor)}): ${await lap()}`);
    for (let round = 0; round < 5; round += 1) {
      await closeVideos();
      await sleep(400);
      await page(`(() => { openEditor(); return true; })()`);
      await waitFor(`(async () => { const tab = state.tabs.find((t) => t.kind === 'editor'); try { return tab && /projects/.test(tab.view.getURL()) && !tab.view.isLoading() ? 'yes' : 'no'; } catch { return 'no'; } })()`, 100);
    }
    await closeVideos();
    await sleep(1500);
    const after = count();
    report(after.pages === before.pages && after.processes <= before.processes, `the editor opened and closed six times leaves nothing running: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}: ${await lap()}`);

    // An HEVC video into the editor: a full-quality copy is made. Closing the editor stops ffmpeg.
    await page(`(() => { openEditor(${JSON.stringify(file('hevc.mp4'))}); return true; })()`);
    let copying = 0;
    for (let at = 0; at < 100 && !copying; at += 1) { await sleep(100); copying = await ffmpegs(); }
    await sleep(500);
    await closeVideos();
    await sleep(1000);
    report(copying >= 1 && await ffmpegs() === 0, `closing the editor while a copy is made for it stops ffmpeg (running before ${copying}, after ${await ffmpegs()}): ${await lap()}`);
    clearInterval(meter);
    // Left saving on purpose: quitting stops it (the run that named this scene looks for ffmpeg after).
    await open('hd.mp4');
    await page(`(() => { state.active.trim.end = 55; saveVideo(state.active, false); return true; })()`);
    await sleep(1000);
    report(await ffmpegs() === 1, 'a save is running as Station quits');
  },

  // How much memory the main process takes while the editor hands over an export (a measure; only
  // when named). SHOT_VIDEOS holds export.mp4 (1080p, 60 s, Opus sound, as the editor makes them).
  // SHOT_QUIT_SAVING=1: a quick-trim save is left running at the end, for the run to look after.
  async exportMemory({ page }) {
    if (!ONLY.includes('exportMemory')) return;
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} exportMemory: ${text}`);
    const home = require('os').homedir();
    const from = process.env.SHOT_VIDEOS;
    if (!home.startsWith('/tmp/') || !from) { report(false, 'needs the throwaway HOME and SHOT_VIDEOS'); return; }
    const { execFileSync } = require('child_process');
    const dir = path.join(home, 'Videos', 'Export');
    fs.mkdirSync(dir, { recursive: true });
    const sent = path.join(dir, 'sent.mp4');
    fs.copyFileSync(path.join(from, 'export.mp4'), sent);
    const guest = (code) => page(`(async () => { const tab = state.tabs.find((t) => t.kind === 'editor'); if (!tab) return 'no tab'; try { return await tab.view.executeJavaScript(${JSON.stringify(code)}); } catch (error) { return 'error: ' + error.message; } })()`);
    await page(`(() => { openEditor(); return true; })()`);
    for (let at = 0; at < 100 && await guest('Boolean(window.station) && document.readyState === "complete"') !== true; at += 1) await sleep(200);
    await sleep(1000);
    const MB = (bytes) => Math.round(bytes / 1024 / 1024);
    const base = process.memoryUsage().rss;
    let peak = base;
    let held = 0;
    let tick = Date.now();
    const meter = setInterval(() => { const now = Date.now(); held = Math.max(held, now - tick - 5); tick = now; peak = Math.max(peak, process.memoryUsage().rss); }, 5);
    const began = Date.now();
    // SHOT_EXPORT_TIMES=3: three in a row, to see whether the memory taken grows with what's sent.
    const times = Number(process.env.SHOT_EXPORT_TIMES) || 1;
    let saved = null;
    for (let round = 0; round < times; round += 1) {
      saved = await guest(`fetch(window.station.houseUrl(${JSON.stringify(sent)})).then((answer) => answer.arrayBuffer()).then((bytes) => window.station.saveExport(bytes, 'Big export.mp4', null)).then((done) => done.path, (error) => 'error: ' + error.message)`);
    }
    clearInterval(meter);
    let sound = null;
    try { sound = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', saved]).toString().trim(); } catch { /* not saved */ }
    const left = fs.readdirSync(path.join(home, '.cache', 'house', 'videos')).filter((name) => name.startsWith('.export-'));
    report(sound === 'aac' && !left.length, `a ${MB(fs.statSync(sent).size)} MB export saved as ${JSON.stringify(saved)} with ${sound} sound in ${Date.now() - began} ms: main process ${MB(base)} MB before, ${MB(peak)} MB at most (${MB(peak - base)} MB more), held ${held} ms, pieces left ${JSON.stringify(left)}`);
    // One too big for the disk gets a plain answer, and nothing is sent.
    const tooBig = await guest(`window.station.saveExport({ byteLength: 9e15, slice: () => new ArrayBuffer(0) }, 'Huge.mp4', null).then(() => 'saved', (error) => error.message)`);
    report(/enough room/.test(String(tooBig)), `an export bigger than the disk is turned down in plain words: ${JSON.stringify(tooBig)}`);
    await page(`(() => { [...state.tabs].filter((tab) => tab.kind === 'editor').forEach((tab) => removeTab(tab)); return true; })()`);
    if (!process.env.SHOT_QUIT_SAVING) return;
    await page(`(() => { openVideo(${JSON.stringify(sent)}); return true; })()`);
    for (let at = 0; at < 50 && await page(`state.active?.kind === 'video' && state.active.video.readyState >= 2`) !== true; at += 1) await sleep(200);
    await page(`(() => { state.active.trim.end = 55; saveVideo(state.active, false); return true; })()`);
    await sleep(1500);
    report(fs.readdirSync(dir).some((name) => name.startsWith('.saving-')), 'a save is half made as Station quits');
  },

  // Videos open in a page of their own: watch it, a quick trim, saved as a copy or over it with the
  // old one in the Trash (video-tab.js).
  async videoEdit({ page, shot }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} videoEdit: ${text}`);
    const home = require('os').homedir();
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    const { execFileSync } = require('child_process');
    const dir = path.join(home, 'Videos', 'Edit Me');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
    const clip = path.join(dir, 'clip.mp4');
    const old = path.join(dir, 'old.avi');
    ff('-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=6:r=30', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip);
    ff('-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=4:r=25', '-f', 'lavfi', '-i', 'sine=f=330:d=4', '-c:v', 'mpeg4', '-c:a', 'libmp3lame', '-shortest', old);
    const probe = (file) => {
      const data = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file]).toString());
      const picture = data.streams.find((stream) => stream.codec_type === 'video');
      return { size: picture ? `${picture.width}x${picture.height}` : null, sound: data.streams.some((stream) => stream.codec_type === 'audio'), duration: Math.round(Number(data.format.duration) * 100) / 100 };
    };
    const waitFor = async (test, tries = 50) => {
      let value = null;
      for (let at = 0; at < tries; at += 1) {
        value = await page(test);
        if (value && value !== 'no') return value;
        await sleep(200);
      }
      return value;
    };
    const entry = (file) => JSON.stringify({ path: file, name: path.basename(file), isDir: false, size: fs.statSync(file).size, mtime: fs.statSync(file).mtimeMs });
    const click = (selector, text) => page(`(() => { const found = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => !node.closest('[hidden]') && ${text ? `node.textContent.trim() === ${JSON.stringify(text)}` : 'true'}); if (!found) return 'missing'; found.click(); return 'ok'; })()`);
    const key = (name, extra = {}) => page(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} })); return true; })()`);
    const seek = async (time) => {
      await page(`(() => { state.active.video.currentTime = ${time}; return true; })()`);
      return waitFor(`(() => Math.abs(state.active.video.currentTime - ${time}) < 0.02 && !state.active.video.seeking ? 'yes' : 'no')()`);
    };
    const trim = () => page(`[state.active.trim.start, state.active.trim.end]`);
    const drag = (selector, time) => page(`(() => {
      const tab = state.active;
      const grip = tab.timeline.querySelector(${JSON.stringify(selector)});
      if (!grip) return 'missing';
      const box = grip.getBoundingClientRect();
      const track = tab.track.getBoundingClientRect();
      const at = (x) => ({ clientX: x, clientY: box.top + box.height / 2, bubbles: true, pointerId: 9, button: 0 });
      grip.dispatchEvent(new PointerEvent('pointerdown', at(box.left + box.width / 2)));
      const x = track.left + track.width * (${time} / tab.info.duration);
      tab.timeline.dispatchEvent(new PointerEvent('pointermove', at(x)));
      tab.timeline.dispatchEvent(new PointerEvent('pointerup', at(x)));
      return 'ok';
    })()`);

    await page(`(() => { houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
    await sleep(700);
    await page(`(() => { openFile(${entry(clip)}); return true; })()`);
    const ready = await waitFor(`(() => state.active?.kind === 'video' && state.active.video.readyState >= 2 ? 'yes' : 'no')()`);
    const strip = await page(`(async () => { const img = new Image(); img.src = ${JSON.stringify(`house-file://f${clip.split('/').map(encodeURIComponent).join('/')}?strip&v=1`)}; try { await img.decode(); return img.naturalWidth + 'x' + img.naturalHeight; } catch { return 'none'; } })()`);
    const shown = await page(`(() => ({ tab: document.querySelector('.tab.active .tab-title')?.textContent, address: document.getElementById('address').textContent.includes('clip.mp4'), save: !state.active.saveButton.hidden, light: getComputedStyle(state.active.stage).backgroundColor }))()`);
    report(ready === 'yes' && strip === '1200x90' && shown.tab === 'clip.mp4' && shown.address && shown.save && shown.light === 'rgb(244, 244, 244)',
      `double-clicking a video opens its page, light, playing, with its timeline frames: ${JSON.stringify([ready, strip, shown])}`);
    if (ready !== 'yes') return;

    // A quick trim: I and O where you are, then the end handle dragged.
    await seek(0.5);
    await key('i');
    await seek(5.5);
    await key('o');
    const keyed = await trim();
    const dragged = await drag('.vt-grip-end', 4);
    const after = await trim();
    report(JSON.stringify(keyed) === '[0.5,5.5]' && dragged === 'ok' && after[0] === 0.5 && Math.abs(after[1] - 4) < 0.03,
      `I and O trim where you are, and the end handle drags: ${JSON.stringify([keyed, dragged, after])}`);
    await shot('video-trim');

    await key('z', { ctrlKey: true });
    const undone = await trim();
    await key('y', { ctrlKey: true });
    const redone = await trim();
    report(undone[1] === 5.5 && redone[1] === after[1], `Ctrl+Z takes the drag back, Ctrl+Y brings it again: ${JSON.stringify([undone, redone])}`);

    // Save as Copy: "clip (edited).mp4", the original kept.
    await click('.vt-host:not([hidden]) .vt-save', 'Save as Copy');
    const copy = path.join(dir, 'clip (edited).mp4');
    for (let at = 0; at < 100 && !fs.existsSync(copy); at += 1) await sleep(200);
    await waitFor(`(() => !state.active.job ? 'yes' : 'no')()`, 100);
    const made = fs.existsSync(copy) ? probe(copy) : null;
    const toastText = await page(`document.querySelector('.toast')?.textContent || ''`);
    report(made && made.size === '320x240' && made.sound && Math.abs(made.duration - (after[1] - 0.5)) < 0.15 && probe(clip).duration === 6 && /Saved as/.test(toastText),
      `Save as Copy makes "clip (edited).mp4", trimmed, the original kept: ${JSON.stringify([made, toastText])}`);

    // Save over it: back to the whole video, then trimmed to 3 seconds; the old one in the Trash, and Undo.
    await click('.vt-host:not([hidden]) .vt-tool[data-tip^="The whole video"]');
    await seek(3);
    await key('o');
    await click('.vt-host:not([hidden]) .vt-save', 'Save');
    await waitFor(`(() => !state.active.job && Math.abs(state.active.info.duration - 3) < 0.15 ? 'yes' : 'no')()`, 150);
    const trash = path.join(home, '.local', 'share', 'house-trash');
    const kept = fs.existsSync(trash) ? fs.readdirSync(trash).filter((name) => name.endsWith('-clip.mp4')) : [];
    const replaced = probe(clip);
    const saveToast = await page(`document.querySelector('.toast')?.textContent || ''`);
    report(Math.abs(replaced.duration - 3) < 0.15 && replaced.sound && kept.length === 1 && /old video is in the Trash/.test(saveToast) && !await page(`trimmed(state.active)`),
      `Save puts the trimmed video in its place, the old one in the Trash: ${JSON.stringify([replaced, kept, saveToast])}`);
    await page(`(() => { const button = [...document.querySelectorAll('.toast button')].find((node) => node.textContent === 'Undo'); button?.click(); return Boolean(button); })()`);
    await waitFor(`(() => Math.abs(state.active.info.duration - 6) < 0.15 ? 'yes' : 'no')()`, 50);
    const back = probe(clip);
    report(back.duration === 6 && !fs.readdirSync(trash).some((name) => name.endsWith('-clip.mp4')), `Undo puts the old video back: ${JSON.stringify(back)}`);

    // Closing with a trim not saved asks first.
    await seek(1);
    await key('i');
    await page(`(() => { houseTest.closeTab(state.active); return true; })()`);
    await sleep(300);
    const asked = await page(`(() => { const d = document.getElementById('dialog'); const open = d.open && d.textContent.includes('Close without saving'); if (open) d.querySelector('.btn:not(.danger)').click(); return open; })()`);
    await sleep(300);
    report(asked && await page(`state.active?.kind === 'video'`), 'closing with a trim not saved asks first; Cancel keeps it open');

    // An AVI: the page can't play it, so a copy is made that it can. Its preview offers Play Here.
    await page(`(() => { showPreview(${entry(old)}); return true; })()`);
    await sleep(500);
    const offered = await page(`[...document.querySelectorAll('#preview .preview-actions .btn')].map((button) => button.textContent)`);
    await click('#preview .btn', 'Play Here');
    const played = await waitFor(`(() => state.active?.kind === 'video' && state.active.path.endsWith('old.avi') && state.active.playable && state.active.video.readyState >= 2 ? 'yes' : 'no')()`, 100);
    const avi = await page(`state.active.saveButton.hidden`);
    report(JSON.stringify(offered) === '["Play Here","Open in Windows App","Open With…"]' && played === 'yes' && avi,
      `an AVI is made ready to play here; it saves as an MP4 copy only: ${JSON.stringify([offered, played, avi])}`);
    await page(`(() => { [...state.tabs].filter((tab) => tab.kind === 'video').forEach((tab) => removeTab(tab)); return true; })()`);

    // Sound off, snapping handles, a steady play head, and phone (portrait) videos.
    const closeVideos = () => page(`(() => { [...state.tabs].filter((tab) => tab.kind === 'video').forEach((tab) => removeTab(tab)); return true; })()`);
    const openClip = async (file) => {
      await page(`(() => { openVideo(${JSON.stringify(file)}); return true; })()`);
      return waitFor(`(() => state.active?.kind === 'video' && state.active.path === ${JSON.stringify(file)} && state.active.video.readyState >= 2 ? 'yes' : 'no')()`);
    };
    const saveCopy = async (file) => {
      const made = file.replace(/\.mp4$/, ' (edited).mp4');
      await click('.vt-host:not([hidden]) .vt-save', 'Save as Copy');
      for (let at = 0; at < 100 && !fs.existsSync(made); at += 1) await sleep(200);
      await waitFor(`(() => !state.active.job ? 'yes' : 'no')()`, 100);
      return fs.existsSync(made) ? made : null;
    };
    const wholeVideo = () => click('.vt-host:not([hidden]) .vt-tool[title^="The whole video"], .vt-host:not([hidden]) .vt-tool[data-tip^="The whole video"]');
    const soundClip = path.join(dir, 'snd.mp4');
    const portrait = path.join(dir, 'portrait.mp4');
    const landscape = path.join(dir, 'turned-src.mp4');
    const turned = path.join(dir, 'turned.mp4');
    ff('-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=6:r=30', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', soundClip);
    ff('-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:d=2:r=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', portrait);
    ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=2:r=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', landscape);
    ff('-display_rotation', '90', '-i', landscape, '-c', 'copy', turned); // a landscape picture with a turn flag, as phones make

    // Sound off: the button, Undo/Redo, reset, the muted player, and a saved copy with no sound track.
    const soundReady = await openClip(soundClip);
    const soundState = () => page(`(() => { const t = state.active; return { label: t.soundButton.textContent, shown: !t.soundButton.hidden, muted: t.video.muted, copy: !t.copyButton.disabled, save: !t.saveButton.disabled, undo: !t.undoButton.disabled, status: t.statusEl.textContent }; })()`);
    const soundOn = await soundState();
    await click('.vt-host:not([hidden]) .vt-tool', 'Sound on');
    const soundOff = await soundState();
    await key('z', { ctrlKey: true });
    const soundUndone = await soundState();
    await key('y', { ctrlKey: true });
    const soundRedone = await soundState();
    await wholeVideo();
    const soundReset = await soundState();
    await click('.vt-host:not([hidden]) .vt-tool', 'Sound on');
    const soundCopy = soundReady === 'yes' ? await saveCopy(soundClip) : null;
    const soundMade = soundCopy ? probe(soundCopy) : null;
    report(soundReady === 'yes' && soundOn.shown && soundOn.label === 'Sound on' && !soundOn.copy && !soundOn.muted
      && soundOff.label === 'Sound off' && soundOff.muted && soundOff.copy && soundOff.save && soundOff.undo && soundOff.status.includes('Not saved yet')
      && soundUndone.label === 'Sound on' && !soundUndone.muted && soundRedone.label === 'Sound off' && soundReset.label === 'Sound on' && !soundReset.copy,
      `Sound off: counts as a change, mutes the player, Undo/Redo and reset work: ${JSON.stringify([soundOn, soundOff, soundUndone, soundRedone, soundReset])}`);
    report(soundMade && !soundMade.sound && soundMade.size === '320x240' && Math.abs(soundMade.duration - 6) < 0.2 && probe(soundClip).sound,
      `Sound off saves a copy with no audio stream, the original kept: ${JSON.stringify(soundMade)}`);
    const noSound = await openClip(portrait);
    report(noSound === 'yes' && await page(`state.active.soundButton.hidden`), 'a video with no sound track hides the Sound button');
    await closeVideos();

    // Snapping and a steady play head.
    const snapReady = await openClip(soundClip);
    await seek(3);
    await drag('.vt-grip-end', 3.04); // about 6 px from the play head
    const snapped = await page(`[state.active.trim.end, Math.round(state.active.video.currentTime * 1000) / 1000]`);
    await wholeVideo();
    await seek(3);
    await drag('.vt-grip-start', 1);
    await sleep(300);
    const stayed = await page(`[state.active.trim.start, state.active.video.currentTime]`);
    await drag('.vt-grip-start', 4.5);
    await sleep(300);
    const moved = await page(`[state.active.trim.start, state.active.video.currentTime]`);
    await wholeVideo();
    await drag('.vt-grip-end', 5.98);
    const edge = await page(`[state.active.trim.end, roundTime(state.active.info.duration)]`);
    report(snapReady === 'yes' && snapped[0] === 3 && snapped[1] === 3, `a handle dragged within 8 px of the play head lands exactly on it: ${JSON.stringify(snapped)}`);
    report(Math.abs(stayed[0] - 1) < 0.05 && Math.abs(stayed[1] - 3) < 0.05, `the play head stays put when a handle is dragged: ${JSON.stringify(stayed)}`);
    report(Math.abs(moved[0] - 4.5) < 0.05 && Math.abs(moved[1] - moved[0]) < 0.05, `a play head left outside the kept range goes to the nearest kept edge: ${JSON.stringify(moved)}`);
    report(edge[0] === edge[1], `a handle snaps to the end of the strip: ${JSON.stringify(edge)}`);
    await closeVideos();

    // Phone videos: upright, the right shape, upright frames, orientation stayed when saved.
    for (const [name, file] of [['portrait 1080x1920', portrait], ['landscape with a turn flag', turned]]) {
      const ok = await openClip(file);
      const look = await page(`(() => { const t = state.active; const box = t.video.getBoundingClientRect(); return { w: t.video.videoWidth, h: t.video.videoHeight, info: [t.info.width, t.info.height], box: [Math.round(box.width), Math.round(box.height)] }; })()`);
      const frames = await page(`(async () => { const img = new Image(); img.src = state.active.strip.style.backgroundImage.slice(5, -2); try { await img.decode(); return [img.naturalWidth / 10, img.naturalHeight]; } catch { return null; } })()`);
      await seek(0.5);
      await key('o');
      const copyFile = ok === 'yes' ? await saveCopy(file) : null;
      const made = copyFile ? probe(copyFile) : null;
      const [madeW, madeH] = made ? made.size.split('x').map(Number) : [0, 0];
      report(ok === 'yes' && look.w < look.h && Math.abs(look.w / look.h - 9 / 16) < 0.01 && look.info[0] < look.info[1] && frames && frames[0] < frames[1] && madeW < madeH && Math.abs(madeW / madeH - 9 / 16) < 0.01,
        `${name}: player upright, strip frames upright, saved copy upright (${made?.size}): ${JSON.stringify([look, frames])}`);
      await shot(`video-${name.split(' ')[0]}`);
      await closeVideos();
    }
  },

  // Pictures are edited in the preview: turn, crop, light and color, drawing, size; saved as a copy
  // or over the picture with the old one in the Trash (picture-editor.js).
  // The song page (renderer/music-info.js): double-click, the right-click item, the preview button, replacing the
  // cover end to end (picker and drop), a real save, Save as Copy, and the view-only lines, on made-up songs.
  async songInfo({ page, shot, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} songInfo: ${text}`);
    const home = require('os').homedir();
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    const { execFileSync } = require('child_process');
    const dir = path.join(home, 'Music', 'Song Test');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
    const cover = path.join(dir, 'red.jpg');
    const blue = path.join(dir, 'blue.png');
    const green = path.join(dir, 'green.png');
    ff('-f', 'lavfi', '-i', 'color=c=red:s=300x300', '-frames:v', '1', cover);
    ff('-f', 'lavfi', '-i', 'color=c=blue:s=400x200', '-frames:v', '1', blue);
    ff('-f', 'lavfi', '-i', 'color=c=green:s=200x200', '-frames:v', '1', green);
    const song = path.join(dir, 'Sample Song.mp3');
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-i', cover, '-map', '0', '-map', '1', '-c:a', 'libmp3lame', '-c:v', 'copy', '-id3v2_version', '3', '-disposition:v', 'attached_pic', '-metadata', 'title=Sample Song', '-metadata', 'artist=Alex feat. Sam, Lee', '-metadata', 'album=Demos', '-metadata', 'date=2023', '-metadata', 'genre=House', song);
    const wav = path.join(dir, 'Loop.wav');
    ff('-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', wav);
    const md5 = (file) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']).toString();
    const before = md5(song);
    const MENU = "document.querySelectorAll('.menu .menu-item, .menu button')";
    const rowOf = (name) => `[...document.querySelectorAll('#rows [data-path]')].find((n) => n.dataset.path.endsWith('${name}'))`;
    const songTab = (file) => `houseTest.state.tabs.find((t) => t.kind === 'song' && t.path === ${JSON.stringify(file)})`;
    const waitTab = async (file) => { for (let i = 0; i < 30; i += 1) { if (await page(`Boolean(${songTab(file)})`)) return true; await sleep(200); } return false; };
    const picture = (file) => JSON.stringify(fs.readFileSync(file).toString('base64'));
    const choose = (file, mime, how) => page(`(() => {
      const bytes = Uint8Array.from(atob(${picture(file)}), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'new-cover', { type: '${mime}' }));
      const tab = ${songTab(song)};
      if ('${how}' === 'drop') { tab.coverBox.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })); return true; }
      tab.picker.files = data.files;
      tab.picker.dispatchEvent(new Event('change'));
      return true;
    })()`);
    const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream=codec_type,width,height:stream_disposition=attached_pic:stream_tags=comment', '-of', 'json', file]).toString());
    const click = (text) => page(`(() => { const b = [...document.querySelectorAll('.sg-foot .btn')].find((n) => n.textContent === ${JSON.stringify(text)}); b.click(); return !b.hidden; })()`);

    await page(`(() => { houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
    await sleep(900);
    // The right-click menu.
    const labels = await page(`(() => { const row = ${rowOf('Sample Song.mp3')}; row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 })); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 200 })); return [...${MENU}].map((n) => n.textContent.trim()); })()`);
    report(labels.includes('Edit song info'), `the right-click menu has Edit song info: ${JSON.stringify(labels)}`);
    // Double-clicking opens the song's page.
    await page(`(() => { closeMenu(); return true; })()`);
    await page(`(() => { ${rowOf('Sample Song.mp3')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    report(await waitTab(song), 'double-clicking a song opens its page');
    await sleep(600);
    const shown = await page(`(() => { const t = ${songTab(song)}; return { active: houseTest.state.active === t, artist: t.inputs.artist.value, featured: t.inputs.featured.value, title: t.inputs.title.value, img: Boolean(t.coverBox.querySelector('img')), saveDisabled: t.saveButton.disabled, facts: document.querySelector('.sg-facts').textContent }; })()`);
    report(shown.active && shown.artist === 'Alex' && shown.featured === 'Sam, Lee' && shown.img && shown.saveDisabled, `the page shows the fields, featured artists split out, the cover: ${JSON.stringify(shown)}`);
    await shot('song-page');
    await win.setSize(760, 560);
    await sleep(700);
    await shot('song-page-small');
    await win.setSize(1240, 800);
    await sleep(500);
    // The player.
    const played = await page(`(async () => { const t = ${songTab(song)}; t.audio.muted = true; t.playToggle(); await new Promise((r) => setTimeout(r, 1500)); const at = t.audio.currentTime; t.playToggle(); return { at, time: document.querySelector('.sg-time').textContent }; })()`);
    report(played.at > 0.3, `the player plays: ${JSON.stringify(played)}`);

    // Replace the cover from a picked file, then from a dropped one; edit the featured artists and the title.
    await choose(blue, 'image/png', 'pick');
    await sleep(500);
    report(await page(`${songTab(song)}.cover instanceof Uint8Array && ${songTab(song)}.coverBox.querySelector('img').src.startsWith('data:image/png')`), 'a picked picture shows as the new cover');
    await choose(green, 'image/png', 'drop');
    await sleep(500);
    report(await page(`${songTab(song)}.cover instanceof Uint8Array && ${songTab(song)}.coverBox.querySelector('img').src.startsWith('data:image/png')`), 'a dropped picture shows as the new cover');
    await page(`(() => { const t = ${songTab(song)}; t.inputs.title.value = 'Sample Song (Remix)'; t.inputs.title.dispatchEvent(new Event('input')); t.inputs.featured.value = 'Sam, Lee, Max'; t.inputs.featured.dispatchEvent(new Event('input')); return true; })()`);
    await shot('song-page-edited');
    const pressed = await click('Save');
    await sleep(3000);
    const tags = probe(song);
    const pic = tags.streams.find((s) => s.codec_type === 'video');
    report(tags.format.tags.title === 'Sample Song (Remix)' && tags.format.tags.artist === 'Alex feat. Sam, Lee, Max' && pressed, `saved from the page: ${JSON.stringify(tags.format.tags)}`);
    report(pic && pic.width === 200 && pic.height === 200 && pic.disposition.attached_pic === 1 && pic.tags.comment === 'Cover (front)', `the dropped (green 200x200) cover is in, as the front cover: ${JSON.stringify(pic)}`);
    report(md5(song) === before, 'the sound is identical after saving');
    report(fs.readdirSync(dir).every((n) => !n.startsWith('.songinfo')), 'no half-made file left');
    const after = await page(`(() => { const t = ${songTab(song)}; return { artist: t.inputs.artist.value, featured: t.inputs.featured.value, title: t.inputs.title.value, saveDisabled: t.saveButton.disabled, status: t.statusEl.textContent }; })()`);
    report(after.featured === 'Sam, Lee, Max' && after.title === 'Sample Song (Remix)' && after.saveDisabled, `the page shows the saved song: ${JSON.stringify(after)}`);
    await shot('song-page-saved');

    // Save as Copy leaves this one alone.
    await page(`(() => { const t = ${songTab(song)}; t.inputs.album.value = 'Copy Album'; t.inputs.album.dispatchEvent(new Event('input')); return true; })()`);
    await click('Save as Copy');
    await sleep(3000);
    const copy = path.join(dir, 'Sample Song (edited).mp3');
    report(fs.existsSync(copy) && probe(copy).format.tags.album === 'Copy Album' && probe(song).format.tags.album === 'Demos' && md5(copy) === before, 'Save as Copy makes "Sample Song (edited).mp3" and leaves the song alone');

    // The preview button and a WAV (no cover, no album artist).
    await page(`(() => { houseTest.showPreview({ path: ${JSON.stringify(wav)}, name: 'Loop.wav', isDir: false, size: 100, mtime: 0 }); return true; })()`);
    await sleep(500);
    const button = await page(`(() => { const b = document.querySelector('#preview .pe-edit-btn'); const text = b && b.textContent; if (b) b.click(); return text; })()`);
    report(button === 'Song info' && await waitTab(wav), `the preview has a Song info button that opens the page: ${button}`);
    await sleep(600);
    await shot('song-page-wav');

    // View only: the old song in the Trash, and what Windows (C:) shows (a stand-in: this test has no C: drive).
    const trash = path.join(home, '.local', 'share', 'house-trash');
    const kept = fs.readdirSync(trash).find((n) => n.endsWith('Sample Song.mp3'));
    await page(`openSong(${JSON.stringify(path.join(trash, kept || 'x'))}); true`);
    await sleep(1200);
    const locked = await page(`(() => ({ saves: [...document.querySelectorAll('.sg-host:not([hidden]) .sg-foot .btn')].filter((b) => !b.hidden).length, note: document.querySelector('.sg-host:not([hidden]) .sg-note')?.textContent }))()`);
    report(locked.saves === 0 && /Trash/.test(locked.note || ''), `a song in the Trash is view only: ${JSON.stringify(locked)}`);
    await page(`(() => { houseTest.state.windows = ${JSON.stringify(dir)}; const t = ${songTab(wav)}; houseTest.activateTab(t); t.windowsFile = true; fillSong(t, { ...t.info, beside: false }); return true; })()`);
    await sleep(500);
    const cNote = await page(`document.querySelector('.sg-host:not([hidden]) .sg-note')?.textContent`);
    report(cNote === 'Songs on Windows (C:) can be viewed here but not changed. Copy it into the house to edit it.', `Windows (C:) view-only line: ${cNote}`);
    await shot('song-page-windows');
    // Back to a folder tab, as the next scenes expect (navigate only works there).
    await page(`(() => { houseTest.state.windows = ''; houseTest.activateTab(houseTest.state.tabs.find((t) => t.kind === 'files')); return true; })()`);
  },

  async pictureEdit({ page, shot }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} pictureEdit: ${text}`);
    const home = require('os').homedir();
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    const { execFileSync } = require('child_process');
    const dir = path.join(home, 'Pictures', 'Edit Me');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
    const photo = path.join(dir, 'photo.jpg');
    const scan = path.join(dir, 'scan.tiff');
    ff('-f', 'lavfi', '-i', 'testsrc2=s=400x200:d=1', '-frames:v', '1', '-q:v', '2', photo);
    ff('-f', 'lavfi', '-i', 'testsrc2=s=120x90:d=1', '-frames:v', '1', scan);
    const sizeOf = (file) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
    const waitFor = async (test, tries = 30) => {
      let value = null;
      for (let at = 0; at < tries; at += 1) {
        value = await page(test);
        if (value && value !== 'no') return value;
        await sleep(200);
      }
      return value;
    };
    const entry = (file) => JSON.stringify({ path: file, name: path.basename(file), isDir: false, size: fs.statSync(file).size, mtime: fs.statSync(file).mtimeMs });
    const click = (selector, text) => page(`(() => { const found = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => ${text ? `node.textContent.trim() === ${JSON.stringify(text)}` : 'true'}); if (!found) return 'missing'; found.click(); return 'ok'; })()`);
    const startEdit = async (file) => {
      await page(`(() => { houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
      await sleep(700);
      await page(`(() => { houseTest.showPreview(${entry(file)}); return true; })()`);
      await sleep(400);
      const button = await click('#preview .pe-edit-btn');
      const ready = await waitFor(`(() => pe && document.querySelector('#preview .pe-canvas') ? 'yes' : 'no')()`);
      return [button, ready];
    };

    const begun = await startEdit(photo);
    report(JSON.stringify(begun) === '["ok","yes"]', `a picture's preview has Edit, and it opens the editor: ${JSON.stringify(begun)}`);
    if (begun[1] !== 'yes') return;
    await click('#preview .pe-action', 'Turn right');
    await click('#preview .pe-choice', 'Square');
    const shaped = await page(`(() => ({ rotate: pe.rotate, crop: pe.crop && [Math.round(pe.crop.w), Math.round(pe.crop.h)], box: !document.querySelector('#preview .pe-crop').hidden }))()`);
    report(shaped.rotate === 90 && JSON.stringify(shaped.crop) === '[200,200]' && shaped.box, `Turn right and a square crop: ${JSON.stringify(shaped)}`);
    await shot('picture-crop');

    await click('#preview .pe-tabs .segment', 'Adjust');
    await page(`(() => { const slider = [...document.querySelectorAll('#preview .pe-slider')].find((row) => row.textContent.startsWith('Brightness')).querySelector('input'); slider.value = '40'; slider.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await click('#preview .pe-tabs .segment', 'Draw');
    await click('#preview .pe-choice', 'Arrow');
    const drew = await page(`(() => {
      const canvas = document.querySelector('#preview .pe-canvas');
      const box = canvas.getBoundingClientRect();
      const at = (fx, fy) => ({ clientX: box.left + box.width * fx, clientY: box.top + box.height * fy, bubbles: true, pointerId: 7, button: 0 });
      canvas.dispatchEvent(new PointerEvent('pointerdown', at(0.2, 0.2)));
      canvas.dispatchEvent(new PointerEvent('pointermove', at(0.5, 0.5)));
      canvas.dispatchEvent(new PointerEvent('pointermove', at(0.8, 0.7)));
      canvas.dispatchEvent(new PointerEvent('pointerup', at(0.8, 0.7)));
      return { marks: pe.marks.map((mark) => mark.type), bright: pe.adjust.brightness, undo: !document.querySelector('#preview .tool[data-tip^="Undo"]').disabled };
    })()`);
    report(JSON.stringify(drew.marks) === '["arrow"]' && drew.bright === 40 && drew.undo, `light turned up and an arrow drawn: ${JSON.stringify(drew)}`);
    await shot('picture-draw');
    await page(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
    const undone = await page(`pe.marks.length`);
    await page(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
    const redone = await page(`pe.marks.length`);
    report(undone === 0 && redone === 1, `Ctrl+Z takes it back, Ctrl+Y brings it again: ${JSON.stringify([undone, redone])}`);
    await click('#preview .pe-tabs .segment', 'Resize');
    await click('#preview .pe-choice', '50%');
    const sized = await page(`document.querySelector('#preview .pe-note').textContent`);
    report(/100 × 100/.test(sized), `Resize to half: ${JSON.stringify(sized)}`);

    // Esc with changes asks first.
    await page(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; })()`);
    await sleep(300);
    const asked = await page(`(() => { const d = document.getElementById('dialog'); const open = d.open && d.textContent.includes('Leave without saving'); if (open) d.querySelector('.btn:not(.danger)').click(); return open; })()`);
    await sleep(300);
    report(asked && await page(`Boolean(pe)`), 'Esc with changes asks before leaving; Cancel stays');

    await click('#preview .pe-bar-btn', 'Save as Copy');
    const copy = path.join(dir, 'photo (edited).jpg');
    await waitFor(`(() => !pe ? 'yes' : 'no')()`);
    await sleep(500);
    const copySize = fs.existsSync(copy) ? sizeOf(copy) : 'none';
    report(copySize === '100,100' && sizeOf(photo) === '400,200', `Save as Copy makes "photo (edited).jpg", the original kept: ${JSON.stringify([copySize, sizeOf(photo)])}`);

    // Save over it: the old one goes to the Trash, and Undo brings it back.
    const before = fs.readFileSync(photo);
    await startEdit(photo);
    await click('#preview .pe-action', 'Flip across');
    await click('#preview .pe-bar-btn', 'Save');
    await waitFor(`(() => !pe ? 'yes' : 'no')()`);
    await sleep(600);
    const after = fs.readFileSync(photo);
    const trash = path.join(home, '.local', 'share', 'house-trash');
    const kept = fs.existsSync(trash) ? fs.readdirSync(trash).filter((name) => name.endsWith('-photo.jpg')) : [];
    const toastText = await page(`document.querySelector('.toast')?.textContent || ''`);
    report(!after.equals(before) && kept.length === 1 && /old picture is in the Trash/.test(toastText), `Save replaces it, the old one in the Trash: ${JSON.stringify([after.equals(before), kept, toastText])}`);
    await page(`(() => { const button = [...document.querySelectorAll('.toast button')].find((node) => node.textContent === 'Undo'); button?.click(); return Boolean(button); })()`);
    await sleep(800);
    const back = fs.readFileSync(photo);
    report(back.equals(before) && !fs.readdirSync(trash).some((name) => name.endsWith('-photo.jpg')), 'Undo puts the old picture back and takes it out of the Trash');

    // A TIFF: no Save over it, the copy is a PNG.
    await page(`(() => { closePreview(true); return true; })()`);
    const tiff = await startEdit(scan);
    const buttons = await page(`[...document.querySelectorAll('#preview .pe-bar-btn')].filter((button) => !button.hidden).map((button) => button.textContent)`);
    await click('#preview .pe-action', 'Turn left');
    await click('#preview .pe-bar-btn', 'Save as Copy');
    await waitFor(`(() => !pe ? 'yes' : 'no')()`);
    await sleep(500);
    const png = path.join(dir, 'scan (edited).png');
    report(tiff[1] === 'yes' && JSON.stringify(buttons) === '["Cancel","Save as Copy"]' && fs.existsSync(png) && sizeOf(png) === '90,120', `a TIFF saves as a PNG copy only: ${JSON.stringify([buttons, fs.existsSync(png) && sizeOf(png)])}`);
    await page(`(() => { closePreview(true); return true; })()`);
  },
  // Markdown, text and code files open in a page of their own to change (doc-tab.js, vendor/editor.js).
  async docs({ page, shot }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} docs: ${text}`);
    const home = require('os').homedir();
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    const { execFileSync } = require('child_process');
    const dir = path.join(home, 'Documents', 'Notes');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const note = path.join(dir, 'note.md');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=200x80:d=1', '-frames:v', '1', path.join(dir, 'chart.png')]);
    fs.writeFileSync(note, [
      '---', 'title: Plans', 'tags: [house]', '---',
      '# Big Plans',
      '',
      'Some **bold words**, some *slanted ones*, ~~old~~ and <u>underlined</u> and `code`.',
      'A plain line to change.',
      'A [link to Station](https://example.com/station) here.',
      '',
      '## Tasks',
      '- [ ] first thing',
      '- [x] done thing',
      '- a bullet',
      '1. one',
      '',
      '> A quote to remember.',
      '',
      '| Name | Size |',
      '| --- | ---: |',
      '| **apple** | 3 |',
      '| pear | 12 |',
      '',
      '```js',
      'const answer = 42;',
      '```',
      '',
      '![chart](chart.png)',
      '',
      '---',
      'The end.',
      '',
    ].join('\n'));
    const editor = `houseTest.state.active.editor`;
    const waitFor = async (test, tries = 30) => {
      let value = null;
      for (let at = 0; at < tries; at += 1) {
        value = await page(test);
        if (value && value !== 'no') return value;
        await sleep(200);
      }
      return value;
    };

    await page(`(() => { openFile({ path: ${JSON.stringify(note)}, name: 'note.md', isDir: false }); return true; })()`);
    const opened = await waitFor(`(() => houseTest.state.active?.kind === 'doc' && document.querySelector('#doc-area .cm-editor') ? 'yes' : 'no')()`);
    report(opened === 'yes', `a Markdown file opens in a page of its own: ${opened}`);
    if (opened !== 'yes') return;
    const top = await page(`(() => ({
      tab: houseTest.state.active.el.querySelector('.tab-title').textContent,
      address: [...document.querySelectorAll('#address .crumb')].map((crumb) => crumb.textContent).slice(-2),
      areaShown: !document.getElementById('doc-area').hidden,
      filesHidden: document.getElementById('files-view').hidden,
      status: document.querySelector('.doc-host:not([hidden]) .doc-status').textContent,
      count: document.getElementById('item-count').textContent,
    }))()`);
    report(top.tab === 'note.md' && JSON.stringify(top.address) === JSON.stringify(['Notes', 'note.md']) && top.areaShown && top.filesHidden && top.status === 'Saved' && /^Line 1, Column 1/.test(top.count) && /words/.test(top.count),
      `tab, address bar, Saved, line and words: ${JSON.stringify(top)}`);

    // As it reads, while the cursor is away: marks gone, a drawn table, ticks, a picture.
    await page(`(() => { ${editor}.view.contentDOM.blur(); return true; })()`);
    await sleep(300);
    const drawn = await waitFor(`(() => {
      const content = document.querySelector('.doc-host:not([hidden]) .cm-content');
      const image = content.querySelector('img.cm-image');
      if (!image || !image.complete) return 'no';
      return {
        h1: content.querySelector('.cm-h1')?.textContent,
        h2: [...content.querySelectorAll('.cm-h2')].map((line) => line.textContent),
        stars: content.textContent.includes('**'),
        underline: content.querySelector('.cm-underline')?.textContent,
        tagsShown: content.textContent.includes('<u>'),
        link: content.querySelector('.cm-link-live')?.textContent,
        linkHidden: !content.textContent.includes('](https'),
        checks: [...content.querySelectorAll('.cm-check')].map((box) => box.checked),
        bullets: content.querySelectorAll('.cm-bullet').length,
        table: [...content.querySelectorAll('.cm-table th, .cm-table td')].map((cell) => cell.textContent),
        tableBold: Boolean(content.querySelector('.cm-table strong')),
        code: content.querySelectorAll('.cm-codeblock').length,
        quote: content.querySelector('.cm-quote')?.textContent,
        front: content.querySelectorAll('.cm-frontmatter').length,
        rule: content.querySelectorAll('.cm-hr').length,
        image: image.naturalWidth,
      };
    })()`);
    report(drawn.h1 === 'Big Plans' && JSON.stringify(drawn.h2) === JSON.stringify(['Tasks']) && !drawn.stars && drawn.underline === 'underlined' && !drawn.tagsShown,
      `headings, bold, underline show as they read, without marks: ${JSON.stringify([drawn.h1, drawn.h2, drawn.stars, drawn.underline, drawn.tagsShown])}`);
    report(drawn.link === 'link to Station' && drawn.linkHidden && JSON.stringify(drawn.checks) === '[false,true]' && drawn.bullets === 1 && drawn.quote === 'A quote to remember.',
      `links, checkboxes, bullets and quotes are drawn: ${JSON.stringify([drawn.link, drawn.checks, drawn.bullets, drawn.quote])}`);
    report(JSON.stringify(drawn.table) === JSON.stringify(['Name', 'Size', 'apple', '3', 'pear', '12']) && drawn.tableBold && drawn.code === 3 && drawn.front === 4 && drawn.rule === 1 && drawn.image === 200,
      `a table, code block, note header, divider and picture: ${JSON.stringify([drawn.table, drawn.code, drawn.front, drawn.rule, drawn.image])}`);
    await shot('docs-markdown');

    // Formatting from the toolbar, saved by itself.
    const line = (text) => `(() => { const doc = ${editor}.view.state.doc; for (let n = 1; n <= doc.lines; n += 1) { const l = doc.line(n); if (l.text === ${JSON.stringify(text)}) return l.from; } return -1; })()`;
    const boldDone = await page(`(() => { try { const at = ${line('A plain line to change.')}; ${editor}.view.focus(); ${editor}.view.dispatch({ selection: { anchor: at + 2, head: at + 7 } }); document.querySelector('.doc-host:not([hidden]) .doc-tool[data-tip^="Bold"]').click(); return 'ok'; } catch (error) { return String(error && error.stack || error); } })()`);
    if (boldDone !== 'ok') console.log(`NOTE docs bold: ${boldDone}`);
    await sleep(100);
    const boldOn = await page(`(() => { try { return document.querySelector('.doc-host:not([hidden]) .doc-tool[data-tip^="Bold"]').classList.contains('on'); } catch (error) { return 'ERR ' + (error && error.stack || error) + ' active=' + houseTest.state.active?.kind + ' hosts=' + document.querySelectorAll('.doc-host').length; } })()`);
    if (boldOn !== true) console.log(`NOTE docs boldOn: ${boldOn}`);
    const headed = await page(`(() => { try { const at = ${line('The end.')}; ${editor}.view.dispatch({ selection: { anchor: at } }); ${editor}.run('heading2'); return 'ok'; } catch (error) { return 'ERR ' + (error && error.stack || error); } })()`);
    if (headed !== 'ok') console.log(`NOTE docs heading: ${headed}`);
    const saving = await page(`document.querySelector('.doc-host:not([hidden]) .doc-status').textContent`);
    await sleep(1200);
    const onDisk = fs.readFileSync(note, 'utf8');
    const savedNow = await page(`document.querySelector('.doc-host:not([hidden]) .doc-status').textContent`);
    report(boldOn && onDisk.includes('A **plain** line to change.') && onDisk.includes('## The end.') && saving === 'Saving…' && savedNow === 'Saved',
      `Bold and Heading 2 from the toolbar, saved by themselves: ${JSON.stringify([boldOn, saving, savedNow, onDisk.includes('A **plain** line'), onDisk.includes('## The end.')])}`);

    // A checkbox ticks with a click (and saves).
    await page(`(() => { ${editor}.view.contentDOM.blur(); return true; })()`);
    await sleep(200);
    await page(`(() => { document.querySelector('.doc-host:not([hidden]) .cm-check').click(); return true; })()`);
    await sleep(1000);
    report(fs.readFileSync(note, 'utf8').includes('- [x] first thing'), 'a checkbox ticks with a click and saves');

    // AI changes the file while it's open: the page takes the new text.
    await sleep(100);
    fs.writeFileSync(note, `${fs.readFileSync(note, 'utf8')}Added by AI.\n`);
    const updated = await waitFor(`(() => ${editor}.getText().includes('Added by AI.') ? document.querySelector('.doc-host:not([hidden]) .doc-status').textContent : 'no')()`, 25);
    report(/Updated/.test(updated), `a change from outside shows up by itself: ${JSON.stringify(updated)}`);

    // Both changed: it asks; Keep Mine saves what you typed.
    await sleep(2600);
    fs.writeFileSync(note, `${fs.readFileSync(note, 'utf8')}Second AI line.\n`);
    await page(`(() => { const doc = ${editor}.view.state.doc; ${editor}.view.dispatch({ changes: { from: doc.length, insert: 'Mine too.\\n' } }); return true; })()`);
    const asked = await waitFor(`(() => { const banner = document.querySelector('.doc-host:not([hidden]) .doc-banner'); return banner && !banner.hidden ? [...banner.querySelectorAll('button')].map((button) => button.textContent) : 'no'; })()`, 25);
    await page(`(() => { [...document.querySelectorAll('.doc-host:not([hidden]) .doc-banner button')].find((button) => button.textContent === 'Keep Mine')?.click(); return true; })()`);
    await sleep(1000);
    const kept = fs.readFileSync(note, 'utf8');
    report(JSON.stringify(asked) === JSON.stringify(['Use Theirs', 'Keep Mine']) && kept.includes('Mine too.') && !kept.includes('Second AI line.'),
      `when both changed it asks, and Keep Mine saves yours: ${JSON.stringify([asked, kept.includes('Mine too.')])}`);

    // Source shows every mark; text size grows.
    await page(`(() => { [...document.querySelectorAll('.doc-host:not([hidden]) .doc-modes .segment')].find((button) => button.textContent === 'Source').click(); document.querySelector('.doc-host:not([hidden]) .doc-tool[data-tip="Larger text"]').click(); ${editor}.view.contentDOM.blur(); return true; })()`);
    await sleep(300);
    const source = await page(`(() => ({ stars: document.querySelector('.doc-host:not([hidden]) .cm-content').textContent.includes('**bold words**'), size: getComputedStyle(document.querySelector('.doc-host:not([hidden])')).getPropertyValue('--editor-size').trim(), label: document.querySelector('.doc-host:not([hidden]) .doc-size').textContent }))()`);
    report(source.stars && source.size === '16px' && source.label === '107%', `Source shows the marks; text size grows: ${JSON.stringify(source)}`);
    await page(`(() => { document.querySelector('.doc-host:not([hidden]) .doc-size').click(); return true; })()`);

    // Code: colors, line numbers, Find. Read only when it can't be written.
    const code = path.join(dir, 'tool.js');
    fs.writeFileSync(code, 'function add(a, b) {\n  return a + b; // sum\n}\n');
    const locked = path.join(dir, 'locked.txt');
    fs.writeFileSync(locked, 'Hands off.\n');
    fs.chmodSync(locked, 0o444);
    await page(`(() => { openFile({ path: ${JSON.stringify(code)}, name: 'tool.js', isDir: false }); return true; })()`);
    const coded = await waitFor(`(() => { const host = document.querySelector('.doc-host:not([hidden])'); if (houseTest.state.active?.path !== ${JSON.stringify(code)} || !host?.querySelector('.cm-lineNumbers')) return 'no'; return { numbers: host.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length, colored: host.querySelectorAll('.cm-content span[class]').length, tools: host.querySelectorAll('.doc-tools .doc-tool').length }; })()`);
    await page(`(() => { document.querySelector('.doc-host:not([hidden]) .doc-tool[data-tip^="Find"]').click(); return true; })()`);
    await sleep(300);
    const find = await page(`Boolean(document.querySelector('.doc-host:not([hidden]) .cm-search'))`);
    report(coded !== 'no' && coded.numbers >= 3 && coded.colored >= 4 && find, `a code file: line numbers, colors, Find: ${JSON.stringify([coded, find])}`);
    await shot('docs-code');
    await page(`(() => { openFile({ path: ${JSON.stringify(locked)}, name: 'locked.txt', isDir: false }); return true; })()`);
    const lockedSeen = await waitFor(`(() => houseTest.state.active?.path === ${JSON.stringify(locked)} && document.querySelector('.doc-host:not([hidden]) .cm-editor') ? { status: document.querySelector('.doc-host:not([hidden]) .doc-status').textContent, editable: document.querySelector('.doc-host:not([hidden]) .cm-content').getAttribute('contenteditable') } : 'no')()`);
    report(lockedSeen.status === 'Read only' && lockedSeen.editable === 'false', `a file that can't be written is read only: ${JSON.stringify(lockedSeen)}`);

    // Ctrl+W closes it; Ctrl+R keeps the pages.
    const before = await page(`houseTest.state.tabs.length`);
    await page(`(() => { document.querySelector('.doc-host:not([hidden]) .cm-content').dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
    await sleep(500);
    const after = await page(`[houseTest.state.tabs.length, houseTest.state.tabs.filter((tab) => tab.kind === 'doc').map((tab) => tab.path.split('/').pop())]`);
    report(after[0] === before - 1 && JSON.stringify(after[1]) === JSON.stringify(['note.md', 'tool.js']), `Ctrl+W closes the page: ${JSON.stringify([before, after])}`);
    fs.chmodSync(locked, 0o644);
    for (const tab of ['tool.js', 'note.md']) {
      await page(`(() => { const tab = houseTest.state.tabs.find((one) => one.kind === 'doc' && one.path.endsWith('/${tab}')); if (tab) houseTest.closeTab(tab); return true; })()`);
      await sleep(400);
    }
  },
  // Every picture type, videos, song covers and PDFs show a small picture in the icon views (lib/thumbs.js).
  async thumbs({ page, shot }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} thumbs: ${text}`);
    const home = require('os').homedir();
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    const { execFileSync } = require('child_process');
    const dir = path.join(home, 'Pictures', 'Every Kind');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(home, '.cache', 'house', 'thumbs'), { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const at = (name) => path.join(dir, name);
    const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
    const pattern = ['-f', 'lavfi', '-i', 'testsrc2=s=320x200:d=1', '-frames:v', '1'];
    ff(...pattern, at('photo.tiff'));
    ff(...pattern, at('art.tga'));
    ff(...pattern, at('frame.qoi'));
    ff(...pattern, at('scan.bmp'));
    ff(...pattern, at('small.png'));
    // A big photo (over 1.5 MB: made small first), taken with the camera on its side: the picture
    // must stand up, as the camera said.
    ff('-f', 'lavfi', '-i', 'nullsrc=s=2400x1200,geq=random(1)*255:128:128', '-frames:v', '1', '-q:v', '1', at('flat.jpg'));
    const jpeg = fs.readFileSync(at('flat.jpg'));
    const tiff = Buffer.from('4d4d002a00000008' + '0001' + '011200030000000100060000' + '00000000', 'hex');
    const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255]), exif]);
    fs.writeFileSync(at('sideways.jpg'), Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
    fs.rmSync(at('flat.jpg'));
    fs.writeFileSync(at('drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect width="100" height="60" rx="8" fill="#2b7de9"/><circle cx="30" cy="30" r="18" fill="#fff"/></svg>');
    ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=2', '-pix_fmt', 'yuv420p', at('clip.mp4'));
    ff('-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=2', at('old.avi'));
    // A video that fades in from black: its picture is a frame from further in, not the black start.
    ff('-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=2', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=28', '-filter_complex', '[0][1]concat=n=2:v=1:a=0', '-pix_fmt', 'yuv420p', at('fade.mp4'));
    ff('-f', 'lavfi', '-i', 'sine=d=1', '-f', 'lavfi', '-i', 'color=c=orange:s=300x300:d=1', '-map', '0:a', '-map', '1:v', '-frames:v', '1', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', '-id3v2_version', '3', at('song.mp3'));
    ff('-f', 'lavfi', '-i', 'sine=d=1', at('plain.wav'));
    fs.writeFileSync(at('paper.pdf'), [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 260]/Contents 4 0 R>>endobj',
      '4 0 obj<</Length 36>>stream', '0 0.4 0.9 rg 20 120 160 110 re f', 'endstream endobj',
      'trailer<</Root 1 0 R>>', '%%EOF', ''].join('\n'));
    fs.writeFileSync(at('notes.txt'), 'just words\n');
    const pictured = ['photo.tiff', 'art.tga', 'frame.qoi', 'scan.bmp', 'small.png', 'sideways.jpg', 'drawing.svg', 'clip.mp4', 'old.avi', 'song.mp3', 'paper.pdf'];

    await page(`(() => { houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
    await sleep(1200);
    await page(`(() => { setViewMode('xl'); return true; })()`);
    const look = () => page(`(() => Object.fromEntries([...document.querySelectorAll('#rows .tile')].map((tile) => {
      const name = tile.querySelector('.tile-name').textContent;
      const image = tile.querySelector('img.thumb');
      if (!image) return [name, tile.querySelector('.tile-art i[data-i]') ? 'icon' : 'none'];
      return [name, image.complete ? (image.naturalWidth ? [image.naturalWidth, image.naturalHeight, image.src.includes('?thumb') ? 'thumb' : 'file'] : 'broken') : 'loading'];
    })))()`);
    // Pictures load as they scroll into view, so the list is walked down.
    let seen = {};
    for (let tries = 0; tries < 60; tries += 1) {
      seen = await look();
      const waiting = Object.keys(seen).filter((name) => seen[name] === 'loading');
      if (!waiting.length && Object.keys(seen).length >= 13) break;
      if (waiting.length) await page(`(() => { [...document.querySelectorAll('#rows .tile')].find((tile) => tile.querySelector('.tile-name').textContent === ${JSON.stringify(waiting[0])})?.scrollIntoView({ block: 'nearest' }); return true; })()`);
      await sleep(400);
    }
    await page(`(() => { document.getElementById('rows').scrollTop = 0; return true; })()`);
    await sleep(300);
    const missing = pictured.filter((name) => !Array.isArray(seen[name]));
    report(!missing.length, `every picture, video, song cover and PDF shows a picture${missing.length ? `; missing ${JSON.stringify(missing.map((name) => [name, seen[name]]))}` : ''}`);
    report(seen['plain.wav'] === 'icon' && seen['notes.txt'] === 'icon', `a song with no cover and a text file show their icons: ${JSON.stringify([seen['plain.wav'], seen['notes.txt']])}`);
    const side = seen['sideways.jpg'];
    report(Array.isArray(side) && side[1] > side[0] && Math.max(side[0], side[1]) <= 256, `a big photo is made small and stands up as the camera said: ${JSON.stringify(side)}`);
    const made = fs.readdirSync(path.join(home, '.cache', 'house', 'thumbs'));
    report(made.some((name) => name.endsWith('.png')) && made.filter((name) => name.endsWith('.webp')).length >= 7 && made.some((name) => name.endsWith('.none')), `small pictures are kept for next time: ${made.map((name) => name.split('.').pop()).sort().join(' ')}`);
    const fade = await require('../lib/thumbs').thumbFor(at('fade.mp4'));
    const stats = fade ? execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', fade, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }) : '';
    const bright = Number(/YAVG=([\d.]+)/.exec(String(stats))?.[1] ?? 0);
    report(bright > 40, `a video that fades in from black shows a lit frame, not black: brightness ${bright}`);
    await shot('thumbs-xl');
    // Opened, a picture the page can't show by itself is made into one it can, at its own size.
    await page(`(() => { showPreview(visibleEntries().find((entry) => entry.name === 'photo.tiff')); return true; })()`);
    let opened = 'loading';
    for (let tries = 0; tries < 30 && opened === 'loading'; tries += 1) {
      await sleep(300);
      opened = await page(`(() => { const image = document.querySelector('#preview img.preview-media'); if (!image) return document.querySelector('#preview .preview-message')?.textContent || 'none'; return image.complete ? [image.naturalWidth, image.naturalHeight] : 'loading'; })()`);
    }
    report(Array.isArray(opened) && opened[0] === 320 && opened[1] === 200, `a TIFF opens full size to look at: ${JSON.stringify(opened)}`);
    await shot('thumbs-open-tiff');
    await page(`(() => { closePreview(); return true; })()`);
    await page(`(() => { setViewMode('details'); return true; })()`);
    await sleep(300);
  },
  // A PDF opens inside the preview with Chromium's own viewer (a frame on the file), and Esc and the X close it.
  async pdfPreview({ page, shot, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} pdfPreview: ${text}`);
    const home = require('os').homedir();
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    const file = path.join(home, 'Documents', 'paper.pdf');
    fs.writeFileSync(file, [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 260]/Contents 4 0 R>>endobj',
      '4 0 obj<</Length 33>>stream', '0 0.4 0.9 rg 20 120 160 110 re f', 'endstream endobj',
      'trailer<</Root 1 0 R>>', '%%EOF', ''].join('\n'));
    const entry = JSON.stringify({ path: file, name: 'paper.pdf', isDir: false, size: 300, mtime: 0 });
    await page(`(() => { closePreview(true); houseTest.showPreview(${entry}); return true; })()`);
    await sleep(2500);
    const state = await page(`(() => { const f = document.querySelector('#preview iframe.preview-pdf'); const r = f && f.getBoundingClientRect(); return JSON.stringify({ frame: Boolean(f), w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0, text: document.querySelector('#preview').textContent, win: innerWidth + 'x' + innerHeight }); })()`);
    console.log(`INFO pdfPreview ${state}`);
    const seen = JSON.parse(state);
    report(seen.frame && seen.w > 200 && seen.h > 200, `the PDF is in a frame that fills the preview: ${state}`);
    report(!seen.text.includes('can\'t show') && seen.text.includes('Open in Windows App'), 'no "can\'t show" text, and Open in Windows App is still offered');
    await shot('pdf-preview');
    await page(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
    await sleep(300);
    report(await page(`document.getElementById('preview').hidden`), 'Esc closes it');
    await page(`(() => { houseTest.showPreview(${entry}); return true; })()`);
    await sleep(800);
    await page(`document.querySelector('#preview .preview-close').click(); true`);
    report(await page(`document.getElementById('preview').hidden`), 'the X closes it');
    // A real click inside the PDF, then a real Esc key: the viewer has the keyboard now.
    await page(`(() => { houseTest.showPreview(${entry}); return true; })()`);
    await sleep(2000);
    const box = JSON.parse(await page(`(() => { const r = document.querySelector('#preview iframe').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()`));
    win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(400);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(500);
    report(await page(`document.getElementById('preview').hidden`), 'after clicking inside the PDF, a real Esc still closes it');
  },
  // Changes to the pages show without a restart (lib/live-update.js). A style change swaps in
  // place; a page change reloads the window once nobody's using it, with every tab kept and the
  // terminals still running.
  async liveUpdate({ page, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const liveUpdate = require('../lib/live-update');

    // The watcher: changes settle into one call; editor scraps and main.js don't count.
    const folder = fs.mkdtempSync(path.join(require('os').tmpdir(), 'live-'));
    fs.mkdirSync(path.join(folder, 'renderer'));
    const calls = [];
    const stop = liveUpdate.watchPanel(folder, (names) => calls.push(names.sort()));
    fs.writeFileSync(path.join(folder, 'renderer', 'style.css'), 'a {}');
    fs.writeFileSync(path.join(folder, 'renderer', 'app.js'), '1;');
    fs.writeFileSync(path.join(folder, 'renderer', '.app.js.swp'), 'x');
    fs.writeFileSync(path.join(folder, 'main.js'), 'x');
    await sleep(liveUpdate.SETTLE_MS + 1000);
    stop();
    report(calls.length === 1 && JSON.stringify(calls[0]) === '["app.js","style.css"]', `changes settle into one update: ${JSON.stringify(calls)}`);
    report(liveUpdate.styleOnly(['style.css']) && !liveUpdate.styleOnly(['style.css', 'app.js']), 'a style-only change is told apart');

    // Three tabs: a folder, a house terminal that printed something, Home. The folder in front.
    await page(`(() => { houseTest.navigate(houseTest.state.projects); return true; })()`);
    await sleep(800);
    await page(`houseTest.openTerminal({ cwd: houseTest.state.home }).then(() => true)`);
    await sleep(1500);
    const termId = await page(`houseTest.state.active.termId`);
    await page(`window.house.call('termWrite', ${termId}, 'echo before-$((40+2))\\r').then(() => true)`);
    await sleep(800);
    await page(`(() => { document.getElementById('new-tab').click(); return true; })()`);
    await sleep(800);
    const describe = `houseTest.state.tabs.map((t) => t.kind === 'files' ? 'files:' + t.path : t.kind === 'term' ? 'term:' + t.termId : t.kind)`;
    await page(`(() => { houseTest.activateTab(houseTest.state.tabs.find((t) => t.kind === 'files' && t.path === houseTest.state.projects)); window.liveMark = 1; return true; })()`);
    await sleep(500);
    const before = await page(`({ tabs: ${describe}, front: houseTest.state.tabs.indexOf(houseTest.state.active) })`);

    // A style change: swapped in place, the page isn't loaded again.
    win.webContents.send('live:style', { names: ['style.css'] });
    await sleep(1200);
    const styled = await page(`({ mark: window.liveMark, links: [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.getAttribute('href')).filter((href) => href.includes('style.css')) })`);
    report(styled.mark === 1 && styled.links.length === 1 && /style\.css\?v=\d+/.test(styled.links[0]), `a style change shows in place: ${JSON.stringify(styled)}`);

    // A page change waits while a field is being typed in.
    await page(`(() => { document.getElementById('search').disabled = false; document.getElementById('search').focus(); return true; })()`);
    win.webContents.send('live:reload', { names: ['app.js'] });
    await sleep(6500);
    const waited = await page(`window.liveMark === 1`).catch(() => false);
    report(waited, 'it waits while a field is being typed in');

    // Then it loads again, with the same tabs, the same one in front, and no loading screen.
    await page(`(() => { document.activeElement.blur(); return true; })()`);
    let after = null;
    for (let i = 0; i < 30 && !after; i += 1) {
      await sleep(500);
      after = await page(`window.liveMark === undefined && window.houseTest && houseTest.state.tabs.length >= ${before.tabs.length} ? { tabs: ${describe}, front: houseTest.state.tabs.indexOf(houseTest.state.active), splash: document.getElementById('splash').hidden } : null`).catch(() => null);
    }
    report(Boolean(after), 'the page loaded its new version');
    if (!after) return;
    await sleep(1500);
    report(JSON.stringify(after.tabs) === JSON.stringify(before.tabs) && after.front === before.front && after.splash, `same tabs, same one in front, no loading screen: ${JSON.stringify([before, after])}`);

    // The terminal kept running: what it printed is there, and it still answers.
    const termText = () => page(`(() => { const t = houseTest.state.tabs.find((tab) => tab.termId === ${termId}); const b = t.live.term.buffer.active; let s = ''; for (let i = 0; i < b.length; i += 1) s += b.getLine(i).translateToString(true) + '\\n'; return s; })()`);
    await page(`window.house.call('termWrite', ${termId}, 'echo after-$((50+5))\\r').then(() => true)`);
    await sleep(1200);
    const text = await termText();
    report(text.includes('before-42') && text.includes('after-55'), `the terminal kept running through it: ${JSON.stringify(text.split('\n').filter((line) => /before-|after-/.test(line)))}`);

    await page(`houseTest.closeTab(houseTest.state.tabs.find((tab) => tab.termId === ${termId})).then(() => true)`);
    await sleep(600);
    await page(ONE_TAB_LEFT);
    await sleep(600);
  },
  // The right-click menus, the lock's look, and Alt+V in a terminal. The page is only told a room
  // is open and the lock is open; the real ones are never touched. Paste goes to a stand-in, so
  // nothing on the real clipboard is read.
  async menuLockPaste({ page, shot }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    await page(`houseTest.navigate(houseTest.state.projects); true`);
    await sleep(1000);
    const rows = () => page(`[...document.querySelectorAll('#menu .menu-item')].map((row) => row.textContent)`);
    await page(`(() => {
      window.wasStatus = state.status;
      state.status = { ...state.status, rooms: [{ name: 'SampleApp' }] };
      const entry = visibleEntries().find((item) => item.name === 'SampleApp');
      state.selected = new Set([entry.path]);
      entryMenu(entry, 200, 160);
      return true;
    })()`);
    const project = await rows();
    report(project.includes('New Room') && !project.includes('New Terminal'), `a project's menu says New Room: ${JSON.stringify(project)}`);
    report(!project.some((label) => /House Terminal/.test(label)), 'a project\'s menu has no Open House Terminal Here');
    const topBar = await page(`document.querySelector('#room-new-btn span').textContent`);
    report(topBar === 'New Room', `the top bar's button says ${JSON.stringify(topBar)}`);
    await shot('menu-project');
    await page(`(() => { closeMenu(); state.selected = new Set(); const box = rowsEl.getBoundingClientRect(); rowsEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 300, clientY: box.bottom - 30 })); return true; })()`);
    const blank = await rows();
    report(blank.includes('Properties') && !blank.some((label) => /House Terminal Here/.test(label)), `the empty-space menu has no Open House Terminal Here: ${JSON.stringify(blank)}`);
    await shot('menu-blank');
    await page(`closeMenu(); true`);

    // The lock both ways: a blue icon like Rules and System when locked; red, with no fill, unlocked.
    for (const doorOpen of [false, true]) {
      const look = await page(`(() => {
        state.status = { ...wasStatus, rooms: [], doorOpen: ${doorOpen} };
        renderHouseNote();
        const button = getComputedStyle(document.getElementById('lock-btn'));
        const paint = (node) => getComputedStyle(node).backgroundColor;
        return {
          label: document.getElementById('lock-label').textContent,
          word: getComputedStyle(document.getElementById('lock-label')).color,
          icon: paint(document.getElementById('lock-icon')),
          rules: paint(document.querySelector('#rules-btn i')),
          system: paint(document.querySelector('#toggle-system i')),
          fill: button.backgroundColor,
          edge: button.boxShadow,
        };
      })()`);
      const red = 'rgb(196, 43, 28)';
      const clear = look.fill === 'rgba(0, 0, 0, 0)' && look.edge === 'none';
      if (doorOpen) report(look.label === 'Unlocked' && look.icon === red && look.word === red && clear, `unlocked: icon and word red, no fill: ${JSON.stringify(look)}`);
      else report(look.label === 'Locked' && look.icon === look.rules && look.icon === look.system && clear, `locked: icon blue like Rules and System, no fill: ${JSON.stringify(look)}`);
      await shot(doorOpen ? 'lock-unlocked' : 'lock-locked');
    }
    await page(`state.status = wasStatus; renderHouseNote(); true`);

    // A picture copied in Windows still pastes while locked: the clipboard belongs to Windows.
    {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      const home = await page(`houseTest.state.home`);
      global.stationChecks.copyPicture(png);
      const made = await page(`window.house.call('pastePicture', ${JSON.stringify(home)}).then((made) => made, (error) => 'ERR ' + error.message)`);
      global.stationChecks.copyPicture(null);
      report(typeof made === 'string' && !/^ERR/.test(made), `a screen snip pastes while locked: ${made}`);
      if (typeof made === 'string' && !/^ERR/.test(made)) require('fs').rmSync(made, { force: true });
    }

    // Alt+V in a terminal pastes, as Ctrl+V does. Alt+Shift+V is still the program's.
    const { ipcMain } = require('electron');
    const real = ipcMain._invokeHandlers?.get('call');
    if (!real) { report(false, 'Alt+V: couldn\'t put a stand-in in front of paste'); return; }
    let asked = 0;
    ipcMain.removeHandler('call');
    ipcMain.handle('call', (event, name, args) => {
      if (name !== 'termPaste') return real(event, name, args);
      asked += 1;
      return 'altv-word ';
    });
    try {
      await page(`houseTest.openTerminal({ cwd: houseTest.state.home }).then(() => true)`);
      await sleep(2500);
      const press = (keys) => page(`(() => {
        const t = houseTest.state.active.live.term;
        t.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', bubbles: true, cancelable: true, ...${JSON.stringify(keys)} }));
        return true;
      })()`);
      const words = () => page(`(() => {
        const lines = houseTest.state.active.live.term.buffer.active;
        let text = '';
        for (let i = 0; i < lines.length; i += 1) text += lines.getLine(i).translateToString(true);
        return (text.match(/altv-word/g) || []).length;
      })()`);
      await press({ altKey: true });
      await sleep(1200);
      report(asked === 1 && (await words()) === 1, `Alt+V pastes: asked ${asked} time(s), the terminal shows it ${await words()} time(s)`);
      await shot('terminal-alt-v');
      await press({ ctrlKey: true });
      await sleep(800);
      report(asked === 2 && (await words()) === 2, `Ctrl+V still pastes: asked ${asked} time(s)`);
      await press({ altKey: true, shiftKey: true });
      await sleep(800);
      report(asked === 2, `Alt+Shift+V is left to the program: asked ${asked} time(s)`);
    } finally {
      ipcMain.removeHandler('call');
      ipcMain.handle('call', real);
    }
  },
  // Locking asks nothing and closes nothing. The page is told it's unlocked, with a room holding it,
  // to see what a person would. The real lock is never touched: locking goes to a stand-in that
  // only counts. Nothing may close a room, so the note must say they stay open.
  async lock({ page, shot }) {
    const house = require('../lib/house');
    const realCloseDoor = house.closeDoor;
    let locks = 0;
    let closed = 0;
    const realCloseRoom = house.closeRoom;
    house.closeDoor = async () => { locks += 1; };
    house.closeRoom = async () => { closed += 1; }; // the old lock closed rooms through this
    try {
      page(`(() => { state.status = { ...state.status, doorOpen: true, rooms: [{ name: 'SampleApp', windowsDoor: true }] }; toggleDoor(); return true; })()`);
      await sleep(1500);
      const [asked, said] = await page(`[document.getElementById('dialog').open, document.querySelector('.toast-text')?.textContent || '']`);
      console.log(`${asked ? 'FAIL' : 'PASS'} lock: ${asked ? 'a pop-up opened' : 'no pop-up'}; said: ${JSON.stringify(said)}`);
      console.log(`${locks === 1 ? 'PASS' : 'FAIL'} lock: locked ${locks} time(s), through the stand-in`);
      console.log(`${closed === 0 && /stay open/.test(said) ? 'PASS' : 'FAIL'} lock: no room closed (${closed}) and the note says they stay open`);
      await shot('lock-toast');
      if (asked) await page(`document.getElementById('dialog').close(); true`);
    } finally {
      house.closeDoor = realCloseDoor;
      house.closeRoom = realCloseRoom;
    }
    await page(`houseTest.refreshStatus().then(() => true)`);
  },
  // Copying puts text on the real clipboard, whatever HOME is. So the copy itself only happens when
  // HOUSE_SHOTS_CLIPBOARD is set, and the Linux clipboard's text is put back after.
  async terminal({ page, shot }) {
    await page(`houseTest.openTerminal({ cwd: houseTest.state.home }).then(() => true)`);
    await sleep(2500);
    await page(`window.house.call('termWrite', houseTest.state.active.termId, 'clear; echo station-copy-test\\r').then(() => true)`);
    await sleep(1200);
    await page(`(() => { const t = houseTest.state.active.live.term; t.select(0, 1, 17); return true; })()`);
    await sleep(300);
    await shot('terminal-selected');
    if (!process.env.HOUSE_SHOTS_CLIPBOARD) return;
    const { clipboard } = require('electron');
    const saved = await clipboard.readText();
    // Ctrl+C with text selected copies it, the same as pressing the keys.
    await page(`(() => {
      const t = houseTest.state.active.live.term;
      t.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(800);
    console.log(`COPIED ${JSON.stringify(await clipboard.readText())}`);
    await shot('terminal-after-copy');
    if (!process.env.HOUSE_SHOTS_KEEP_CLIPBOARD) await clipboard.writeText(saved);
  },
  // One clipboard with Windows (lib/clipboard.js, windows/snap-link.cs). Only taken when named, as
  // panel/test/clipboard-windows.ps1 does: that script runs the helper's clipboard part for this
  // copy of the panel and does Windows' half of each step, asked through files in HOUSE_SHOTS_TALK.
  async clipboard({ page, shot }) {
    if (!ONLY.includes('clipboard')) return;
    const { clipboard } = require('electron');
    const link = require('../lib/windows-link');
    const { heard } = require('../lib/clipboard');
    const TALK = process.env.HOUSE_SHOTS_TALK;
    const check = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} clipboard: ${text}`);
    let step = 0;
    const windows = async (request, ms = 20000) => {
      step += 1;
      const ask = path.join(TALK, `${step}-ask.json`);
      fs.writeFileSync(`${ask}.new`, JSON.stringify(request));
      fs.renameSync(`${ask}.new`, ask);
      const done = path.join(TALK, `${step}-done.json`);
      for (const end = Date.now() + ms; Date.now() < end; await sleep(40)) {
        try {
          return JSON.parse(fs.readFileSync(done, 'utf8').replace(/^\uFEFF/, ''));
        } catch { /* not answered yet */ }
      }
      throw new Error(`Windows didn't answer step ${step} (${request.do})`);
    };
    // Nothing should move for a few seconds once a copy has settled: no clipboard changes in
    // Windows, and nothing heard from the helper.
    const stillness = async (after) => {
      await sleep(2500);
      const before = { ...heard };
      const seen = await windows({ do: 'quiet', ms: 3000 });
      const moved = heard.changes - before.changes;
      check(seen.before === seen.after && moved === 0, `quiet after ${after}: Windows clipboard changes ${seen.after - seen.before}, messages from the helper ${moved}`);
    };
    for (const end = Date.now() + 20000; !link.connected() && Date.now() < end;) await sleep(100);
    check(link.connected(), 'the helper is linked');
    if (!link.connected()) return;
    await sleep(800);

    // (a) Files copied in the panel can be pasted in File Explorer: copy, then cut.
    const files = await page(`[state.projects + '/readme.md', state.projects + '/SampleApp']`);
    const unc = files.map((file) => `\\\\wsl.localhost\\${process.env.WSL_DISTRO_NAME || 'Ubuntu'}${file.replaceAll('/', '\\')}`);
    for (const move of [false, true]) {
      await page(`(() => { state.selected = new Set(${JSON.stringify(files)}); toClipboard(${move}); return true; })()`);
      await sleep(700);
      const seen = await windows({ do: 'files' });
      const same = JSON.stringify(seen.files) === JSON.stringify(unc);
      check(same && seen.effect === (move ? 2 : 5), `${move ? 'cut' : 'copied'} files, Windows has ${JSON.stringify(seen.files)} marked ${seen.effect} (wanted ${move ? 2 : 5})`);
      const kept = await page(`[Boolean(state.clipboard), state.clipboard?.move, state.windowsFiles]`);
      check(kept[0] && kept[1] === move && kept[2] === 0, `the panel still pastes its own ${move ? 'cut' : 'copy'} (not "files from Windows"): ${JSON.stringify(kept)}`);
    }
    await stillness('copying files');

    // (b) Text copied in a terminal: the selection with Ctrl+C, then a program's copy (OSC 52)
    // with two lines, then Copy as path.
    await page(`houseTest.openTerminal({ cwd: houseTest.state.home }).then(() => true)`);
    await sleep(2500);
    const word = `station-copy-${Date.now() % 100000}`;
    await page(`window.house.call('termWrite', houseTest.state.active.termId, 'clear; echo ${word}\\r').then(() => true)`);
    await sleep(1200);
    const row = await page(`(() => {
      const t = houseTest.state.active.live.term;
      const lines = t.buffer.active;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines.getLine(i)?.translateToString(true).trim() === '${word}') {
          t.select(0, i, ${word.length});
          return i;
        }
      }
      return -1;
    })()`);
    check(row >= 0, `the terminal shows ${word} (line ${row})`);
    await sleep(300);
    await page(`(() => {
      const t = houseTest.state.active.live.term;
      t.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(1500);
    let seen = await windows({ do: 'text' });
    check(seen.text === word && (await clipboard.readText()) === word, `terminal Ctrl+C: Windows has ${JSON.stringify(seen.text)}, the house has the same`);
    await shot('terminal-copy');
    await stillness('a terminal copy');
    const twoLines = 'line one\nline two';
    const encoded = Buffer.from(twoLines).toString('base64');
    await page(`window.house.call('termWrite', houseTest.state.active.termId, "printf '\\\\033]52;c;${encoded}\\\\a'\\r").then(() => true)`);
    await sleep(2000);
    seen = await windows({ do: 'text' });
    // WSLg passes it on with Linux line ends, which Windows apps read too, so it's left that way.
    check(seen.text?.replace(/\r\n/g, '\n') === twoLines, `a program's copy (OSC 52), two lines: Windows has ${JSON.stringify(seen.text)}`);
    await page(`(() => { copyAsPath(${JSON.stringify(files)}); return true; })()`);
    await sleep(1500);
    seen = await windows({ do: 'text' });
    const asPath = files.map((file) => `"L:${file.replaceAll('/', '\\')}"`).join('\r\n');
    check(seen.text === asPath, `Copy as path: Windows has ${JSON.stringify(seen.text)}`);
    await stillness('Copy as path');
    // When WSLg hasn't passed it on, the helper does: asked here directly, so only the helper can
    // bring it, with Windows' line ends.
    const only = `helper-only-${Date.now() % 100000}\nsecond line`;
    const reply = await link.setClipboard({ text: only });
    await sleep(300);
    seen = await windows({ do: 'text' });
    check(reply?.ok === true && seen.text === only.replace(/\n/g, '\r\n'), `the helper puts text on Windows by itself: ${JSON.stringify(seen.text)}`);
    await stillness('the helper putting text');

    // (c) Text copied in Windows is in the house within a second, through the helper.
    for (const sent of [`from-windows-${Date.now() % 100000}`, 'first line\r\nsecond line']) {
      const want = sent.replace(/\r\n/g, '\n');
      const was = heard.fromWindows;
      const asked = Date.now();
      const answer = windows({ do: 'set', text: sent });
      let arrived = 0;
      let sentAt = 0;
      for (const end = asked + 5000; Date.now() < end && !(arrived && sentAt); await sleep(20)) {
        if (!arrived && (await clipboard.readText()).replace(/\r\n/g, '\n') === want) arrived = Date.now();
        if (!sentAt && heard.fromWindows > was) sentAt = Date.now();
      }
      await answer;
      const took = arrived ? arrived - asked : -1;
      const helperTook = sentAt ? sentAt - asked : -1;
      check(arrived && took < 1000 && sentAt && helperTook < 1000, `Windows Set-Clipboard ${JSON.stringify(sent)} -> the house has it after at most ${took} ms; the helper's message came after at most ${helperTook} ms`);
      await stillness('a copy in Windows');
    }
    check(true, `heard from the helper: ${JSON.stringify(heard)}`);
  },
  // Every pop-up and hover text should be two lines at most, at its real width. Each pop-up is
  // opened through the real code, measured, then cancelled, never answered.
  async audit({ page, shot }) {
    const lines = () => page(`(() => {
      const text = document.querySelector('#dialog .dialog-text');
      if (!text) return [document.querySelector('#dialog .dialog-title')?.textContent || '(no dialog)', 0];
      const style = getComputedStyle(text);
      return [document.querySelector('#dialog .dialog-title').textContent, Math.round(text.getBoundingClientRect().height / parseFloat(style.lineHeight))];
    })()`);
    const cancel = () => page(`document.getElementById('dialog').close(); true`);
    const popups = [
      ['close room', `closeRoom('A Rather Long Project Name For Testing Here'); true`],
      ['close one room', `closeOneRoom({ kind: 'term', room: 'A Rather Long Project Name For Testing Here', tab: 'tab-2' }); true`],
      ['new project', `newProject(); true`],
      ['storage', `changeStorage({ diskTotal: 245 }); true`],
      ['delete forever', `(() => { state.selected = new Set([state.projects + '/A Rather Long File Name That Goes On And On For A While.txt']); deleteSelected(true); return true; })()`],
      ['empty trash', `(() => { state.entries = Array.from({ length: 12 }, (_, i) => ({ path: '/x' + i, name: 'x' + i })); emptyTrash(); return true; })()`],
      ['failures', `(() => { reportFailures([1, 2, 3, 4].map((i) => ({ path: state.projects + '/Some Long Folder Name ' + i, message: 'It\\'s being used by something else right now.' })), 9); return true; })()`],
      ['close app', `(async () => { state.status.rooms = [{ name: 'Notes App' }, { name: 'SampleApp' }]; window.houseFrame.beforeClose(); return true; })()`],
    ];
    if (!await page(`state.status.doorOpen`)) popups.push(['unlock', `toggleDoor(); true`]);
    for (const [name, code] of popups) {
      await page(code);
      await sleep(500);
      const [title, count] = await lines();
      console.log(`${count <= 2 ? 'PASS' : 'FAIL'} pop-up ${name} "${title}": ${count} lines`);
      if (name === 'close app') await shot('close-dialog');
      await cancel();
      await sleep(250);
    }
    await page(`state.status.rooms = []; true`);
    // Hover text: everything that has one now, plus the ones that change with what's going on.
    const tips = await page(`(() => {
      const probe = document.createElement('div');
      probe.className = 'tooltip';
      probe.style.cssText = 'position: fixed; left: 0; top: 0; visibility: hidden; display: block;';
      document.body.append(probe);
      const measure = (text) => {
        probe.textContent = text;
        const style = getComputedStyle(probe);
        const inner = probe.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 2;
        return Math.round(inner / parseFloat(style.lineHeight));
      };
      const texts = new Set([...document.querySelectorAll('[data-tip]')].map((node) => node.dataset.tip));
      // The lock both ways, and a room's button, as renderHouseNote and renderChrome write them.
      const was = { ...state.status };
      for (const doorOpen of [false, true]) { state.status = { ...was, doorOpen }; renderHouseNote(); texts.add(document.getElementById('lock-btn').dataset.tip); }
      state.status = was; renderHouseNote();
      ['Go to the A Rather Long Project Name room\\'s terminal.', 'Start the A Rather Long Project Name room, so AI can work there.'].forEach((text) => texts.add(text));
      const out = [...texts].filter(Boolean).map((text) => [text, measure(text)]);
      probe.remove();
      return out;
    })()`);
    tips.forEach(([text, count]) => { if (count > 2) console.log(`FAIL hover text ${count} lines: ${JSON.stringify(text)}`); });
    console.log(`PASS hover texts checked: ${tips.length}, over two lines: ${tips.filter(([, count]) => count > 2).length}`);
    // How many characters really fit a line in each, with the real fonts, next to what fitLines
    // assumes (FIT in tooltip.js). FIT has to be the smaller number.
    page(`confirmBox('Test', 'x', 'OK'); true`);
    await sleep(400);
    page(`toast('x', 'Undo', () => {}); true`);
    await sleep(300);
    const fit = await page(`(() => {
      const sample = 'Rooms you open next can read your Windows files, but Claude can not change them. ';
      const perChar = (host) => {
        const span = document.createElement('span');
        span.style.whiteSpace = 'nowrap';
        span.textContent = sample;
        host.append(span);
        const width = span.getBoundingClientRect().width / sample.length;
        span.remove();
        return width;
      };
      const text = document.querySelector('#dialog .dialog-text');
      const dialog = Math.floor(text.clientWidth / perChar(text));
      const probe = document.createElement('div');
      probe.className = 'tooltip';
      probe.style.cssText = 'position: fixed; left: 0; top: 0; visibility: hidden; display: block;';
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const tipWidth = parseFloat(style.maxWidth) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2;
      const tip = Math.floor(tipWidth / perChar(probe));
      probe.remove();
      const box = document.querySelector('.toast');
      const boxStyle = getComputedStyle(box);
      const button = document.querySelector('.toast-button').getBoundingClientRect().width;
      const toastWidth = Math.min(460, document.querySelector('.app').clientWidth - 32) - parseFloat(boxStyle.paddingLeft) - parseFloat(boxStyle.paddingRight) - 2 - parseFloat(boxStyle.columnGap) - button;
      const toast = Math.floor(toastWidth / perChar(document.querySelector('.toast-text')));
      return { dialog, tip, toast, FIT };
    })()`);
    await cancel();
    for (const where of ['dialog', 'tip', 'toast']) {
      console.log(`${fit.FIT[where] < fit[where] ? 'PASS' : 'FAIL'} line room, ${where}: about ${fit[where]} characters fit, fitLines uses ${fit.FIT[where]}`);
    }
  },
  // The Agents page. A window that is never shown counts as hidden, and the page only asks Herdr
  // while it shows, so the asking is switched on here by hand.
  async agents({ page, shot }) {
    await page(`houseTest.openAgents(); window.house.call('agentsWatch', true).then(() => true)`);
    await sleep(Number(process.env.HOUSE_SHOTS_AGENTS_WAIT || 4000));
    const seen = await page(`[document.querySelector('.agents-summary')?.textContent, [...document.querySelectorAll('.agents-tab')].map((row) => row.textContent), document.querySelector('.agents-page')?.innerHTML.includes('<b>')]`);
    console.log(`PASS agents: ${JSON.stringify(seen[0])}`);
    seen[1].forEach((row) => console.log(`PASS agents row: ${JSON.stringify(row)}`));
    if (seen[2]) console.log('FAIL agents: text from a room was read as markup');
    await shot(process.env.HOUSE_SHOTS_AGENTS_NAME || 'agents');
    await page(`window.house.call('agentsWatch', false).then(() => true)`);
  },
  // Room terminal tabs turn green while the AI works and yellow when it needs you, and a Windows
  // notification goes out when one finishes or needs you (here only noted, never shown). Its
  // buttons are pressed by hand. Needs STUB_AGENTS=live and the stand-in docker (test/stub).
  async agentTabs({ page, shot }) {
    const report = (ok, label, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'} agent tabs: ${label}${extra ? ` ${extra}` : ''}`);
    if (process.env.STUB_AGENTS !== 'live') {
      console.log('FAIL agent tabs: run with STUB_AGENTS=live and SHOT_PATH set to the stand-in docker');
      return;
    }
    const checks = global.stationChecks;
    const live = path.join(require('os').homedir(), 'stub-live');
    fs.mkdirSync(live, { recursive: true });
    const set = (status, tab = 'tab-1') => fs.writeFileSync(path.join(live, tab), status);
    const screen = (text) => fs.writeFileSync(path.join(live, 'screen.txt'), text);
    const keys = () => (fs.existsSync(path.join(live, 'keys.txt')) ? fs.readFileSync(path.join(live, 'keys.txt'), 'utf8').trim().split('\n') : []);
    const latest = () => checks.notes.filter((note) => note.id).at(-1);
    const ask = (command) => ['─'.repeat(50), ' Bash command', '', `   ${command}`, '', ' Do you want to proceed?', ' ❯ 1. Yes',
      '   2. Yes, and don\'t ask again for this command', '   3. No, and tell Claude what to do differently (esc)', ''].join('\n');
    const classes = () => page(`houseTest.state.tabs.map((tab) => (tab.tab || tab.kind) + ':' + [...tab.el.classList].filter((name) => name.startsWith('agent-')).join(','))`);
    const looks = 7500; // two looks at Herdr, so a change counts
    set('working');
    set('idle', 'tab-2');
    screen('');
    // Two terminal tabs standing in for SampleApp's room terminals.
    for (const [tabName, title] of [['tab-1', 'SampleApp'], ['tab-2', 'SampleApp (2)']]) {
      await page(`houseTest.openTerminal({}).then((tab) => { tab.room = 'SampleApp'; tab.tab = '${tabName}'; tab.el.querySelector('.tab-title').textContent = '${title}'; return true; })`);
      await sleep(800);
    }
    await page(`houseTest.state.tabs[0].el.click(); true`);
    await sleep(4000);
    let seen = await classes();
    report(seen.includes('tab-1:agent-working') && seen.includes('tab-2:'), 'working is green, idle is plain', JSON.stringify(seen));
    report(!latest(), 'nothing to say when Station opens');
    await shot('agent-tabs-working');
    await page(`houseTest.state.tabs.find((tab) => tab.tab === 'tab-1').el.click(); true`);
    await shot('agent-tabs-working-open');
    await page(`houseTest.state.tabs[0].el.click(); true`);

    screen(ask('npm install left-pad'));
    set('blocked');
    await sleep(looks);
    seen = await classes();
    let note = latest();
    report(seen.includes('tab-1:agent-blocked'), 'needs you is yellow', JSON.stringify(seen));
    report(note?.title === 'SampleApp needs you' && note?.buttons.join() === 'approve,deny,open', 'a needs-you notification with Approve, Deny and Open', JSON.stringify(note));
    await shot('agent-tabs');
    let answer = await checks.notificationClicked({ id: note?.id, action: 'approve' });
    report(answer === 'approved' && keys().at(-1) === 'tab-1 w1:p1 enter', 'Approve pressed Enter in that terminal', `${answer} ${JSON.stringify(keys())}`);

    set('working');
    await sleep(looks);
    screen(ask('rm -rf build'));
    set('blocked');
    await sleep(looks);
    note = latest();
    screen(ask('git push --force'));
    const before = keys().length;
    answer = await checks.notificationClicked({ id: note?.id, action: 'approve' });
    report(answer === 'changed' && keys().length === before, 'a different question by then: nothing pressed', answer);

    set('working');
    await sleep(looks);
    set('done');
    await sleep(looks);
    note = latest();
    seen = await classes();
    report(note?.title === 'SampleApp is done' && note?.buttons.join() === 'open', 'a done notification with Open', JSON.stringify(note));
    report(seen.includes('tab-1:'), 'done is plain', JSON.stringify(seen));
    await page(`houseTest.state.tabs[0].el.click(); true`);
    answer = await checks.notificationClicked({ id: note?.id, action: 'open' });
    await sleep(500);
    const active = await page(`houseTest.state.active.tab || houseTest.state.active.kind`);
    report(answer === 'opened' && active === 'tab-1', 'Open goes to that terminal', `${answer} ${active}`);
    answer = await checks.notificationClicked({ id: 'not-one-of-ours', action: 'approve' });
    report(answer === 'unknown' && keys().length === before, 'an unknown notification presses nothing', answer);
  },
  // A Files tab on Documents, Videos and the like shows that place's icon, as File Explorer does.
  async placeIcons({ page, shot }) {
    const report = (ok, label, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'} place icons: ${label}${extra ? ` ${extra}` : ''}`);
    const iconNow = () => page(`(() => {
      const tab = houseTest.state.active;
      const slot = tab.el.querySelector('.tab-term-icon');
      return { title: tab.el.querySelector('.tab-title').textContent, icon: slot.hidden ? null : slot.dataset.i, tint: slot.className, folder: !tab.el.querySelector('.tab-folder').hidden };
    })()`);
    const places = [['Documents', 'document-filled', 'tint-blue'], ['Pictures', 'image-filled', 'tint-blue'], ['Music', 'music_note_2-filled', 'tint-orange'],
      ['Videos', 'video-filled', 'tint-purple'], ['Downloads', 'arrow_download-filled', 'tint-green'], ['home', 'home-filled', 'tint-orange'],
      ['root', 'hard_drive', 'tint-gray'], ['trash', 'delete', 'tint-gray']];
    await page(`houseTest.state.tabs[0].el.click(); true`);
    for (const [place, icon, tint] of places) {
      await page(`document.querySelector('.nav-item[data-nav="${place}"]').click(); true`);
      await sleep(800);
      const now = await iconNow();
      report(now.icon === icon && now.tint.includes(tint) && !now.folder, `${place} shows its icon`, JSON.stringify(now));
      if (place === 'Documents') await shot('place-icon-documents');
    }
    await page(`document.querySelector('.nav-item[data-nav="projects"]').click(); true`);
    await sleep(800);
    let now = await iconNow();
    report(now.folder && now.icon === null, 'Projects is a folder', JSON.stringify(now));
    await page(`houseTest.navigate(houseTest.state.projects + '/SampleApp'); true`);
    await sleep(800);
    now = await iconNow();
    report(now.folder && now.icon === null, 'any other folder is a folder', JSON.stringify(now));
    await page(`document.querySelector('.nav-item[data-nav="Videos"]').click(); true`);
    await sleep(800);
    await page(`houseTest.state.tabs.find((tab) => tab.kind === 'term')?.el.click(); true`);
    await sleep(400);
    now = await page(`houseTest.state.tabs[0].el.querySelector('.tab-term-icon').dataset.i`);
    report(now === 'video-filled', 'it keeps its icon while another tab is open', now);
  },
  // Links in a terminal open in the browser on Windows (here they're only noted, never opened),
  // with a click: a full address, a bare localhost:PORT, 0.0.0.0, one in brackets, one the terminal
  // wrapped, one drawn in two pieces, and one while a program has the mouse (as Herdr and Claude
  // do). Words from voice typing are typed into the terminal or text box you were in, never sent.
  async links({ page, shot }) {
    const report = (ok, label) => console.log(`${ok ? 'PASS' : 'FAIL'} links: ${label}`);
    const checks = global.stationChecks;
    const home = require('os').homedir();
    await page(`houseTest.openTerminal({}).then(() => true)`);
    await sleep(2500);
    const id = await page(`houseTest.state.active.termId`);
    const cols = await page(`houseTest.state.active.live.term.cols`);
    const write = (text) => page(`window.house.call('termWrite', ${id}, ${JSON.stringify(text)}).then(() => true)`);
    // What the script prints is never on the line that runs it, so a click can only find the output.
    const run = async (name, body) => {
      fs.writeFileSync(path.join(home, `${name}.sh`), body);
      await write(`clear; bash ~/${name}.sh\r`);
      await sleep(1300);
    };
    // Moves over the screen cell `offset` after where `needle` starts (its last showing), then clicks.
    const clickOn = (needle, offset = 3) => page(`(() => {
      const live = houseTest.state.active.live;
      const term = live.term;
      const b = term.buffer.active;
      let row = -1;
      let col = -1;
      for (let y = 0; y < term.rows; y += 1) {
        const at = (b.getLine(b.viewportY + y)?.translateToString(false) || '').indexOf(${JSON.stringify(needle)});
        if (at >= 0) { row = y; col = at; }
      }
      if (row < 0) return Promise.resolve('not on screen');
      const screen = live.host.querySelector('.xterm-screen');
      const box = screen.getBoundingClientRect();
      const w = box.width / term.cols;
      const h = box.height / term.rows;
      const at = { bubbles: true, cancelable: true, clientX: box.left + (col + ${offset} + 0.5) * w, clientY: box.top + (row + 0.5) * h, button: 0 };
      // The mouse stays on the same line from one check to the next, while the text under it
      // changes: the hard case (see keepLinksFresh in term.js).
      screen.dispatchEvent(new MouseEvent('mousemove', { ...at, buttons: 0 }));
      return new Promise((done) => setTimeout(() => {
        screen.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
        screen.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
        screen.dispatchEvent(new MouseEvent('click', { ...at, buttons: 0 }));
        done('clicked');
      }, 400));
    })()`);
    const opened = async (needle, offset) => {
      const before = checks.opened.length;
      const how = await clickOn(needle, offset);
      await sleep(600);
      return checks.opened.length > before ? checks.opened[checks.opened.length - 1] : `nothing opened (${how})`;
    };

    await run('a', "printf 'A1 see %s://localhost:%s/app here\\n' http 5173\n");
    let got = await opened('http://localhost:5173');
    report(got === 'http://localhost:5173/app', `a full address opens (${got})`);
    await shot('links-hover');
    await run('b', "printf 'B1 open %s:%s now\\n' localhost 3000\n");
    got = await opened('localhost:3000', 2);
    report(got === 'http://localhost:3000/', `a bare localhost:PORT opens (${got})`);
    await run('c', "printf 'C1 %s://0.0.0.0:%s/\\n' http 8000\n");
    got = await opened('0.0.0.0:8000');
    report(got === 'http://localhost:8000/', `0.0.0.0 opens as localhost (${got})`);
    await run('d', "printf 'D1 (see %s://example.com/docs).\\n' https\n");
    got = await opened('example.com/docs');
    report(got === 'https://example.com/docs', `brackets and the full stop are left out (${got})`);
    const long = 'x'.repeat(cols + 20);
    await run('e', `printf 'E1 %s://example.com/%s\\n' https ${long}\n`);
    got = await opened('xxxxxxxxxx', 2);
    report(got === `https://example.com/${long}`, `a wrapped link opens whole from its second line (${got.length} characters)`);
    const head = `https://example.com/${'y'.repeat(cols - 3 - 'https://example.com/'.length)}`;
    await run('f', `printf 'F1 %s\\r\\n%s more\\n' ${head} zzzz/end\n`);
    got = await opened('zzzz/end', 1);
    report(got === `${head}zzzz/end`, `a link drawn in two pieces opens whole (${got.slice(-24)})`);
    if (got !== `${head}zzzz/end`) {
      console.log(`FAIL links: debug ${JSON.stringify(await page(`(() => {
        const term = houseTest.state.active.live.term;
        const b = term.buffer.active;
        const out = { cols: term.cols, headLength: ${head.length} };
        for (let y = 0; y < b.length; y += 1) {
          const line = b.getLine(y);
          const text = line.translateToString(false);
          if (text.includes('zzzz') || text.includes('F1')) {
            out['row' + (y + 1)] = { wrapped: line.isWrapped, length: line.translateToString(true).length, last: line.getCell(term.cols - 1)?.getChars(), start: text.slice(0, 12) };
            linkFinder(term, 0).provideLinks(y + 1, (links) => { out['links' + (y + 1)] = (links || []).map((l) => [l.range.start.x, l.range.start.y, l.range.end.x, l.range.end.y, l.text.length]); });
          }
        }
        return out;
      })()`))}`);
    }
    await run('g', "printf '\\033[?1000h\\033[?1006h'; printf 'G1 %s\\n' http://localhost:4000/m; exec cat -v\n");
    got = await opened('localhost:4000/m', 2);
    report(got === 'http://localhost:4000/m', `a link opens while a program has the mouse (${got})`);
    await write('\x03');
    await sleep(400);
    await write("printf '\\033[?1000l\\033[?1006l'; clear\r");
    await sleep(600);

    // A link that can't open says why, in a note.
    await page(`openLink('http://[not an address', ${id}); true`);
    await sleep(800);
    const note = await page(`document.querySelector('.toast').hidden ? '' : document.querySelector('.toast').textContent`);
    report(note.includes('isn\'t a web link'), `a link that can't open says why (${JSON.stringify(note)})`);

    // Voice typing into the terminal: typed on its line, not run.
    await page(`houseTest.state.active.live.term.focus(); true`);
    await sleep(300);
    checks.voiceTyped('echo spoken words\nand more');
    await sleep(800);
    const screen = await page(`(() => { const b = houseTest.state.active.live.term.buffer.active; const out = []; for (let i = 0; i < b.length; i += 1) out.push(b.getLine(i).translateToString(true)); return out.filter(Boolean); })()`);
    report(screen.some((line) => line.endsWith('echo spoken words and more')), `voice typing types into the terminal (${JSON.stringify(screen.slice(-1))})`);
    report(!screen.some((line) => line.trim() === 'spoken words and more'), 'and doesn\'t press Enter');
    await shot('links-voice');
    await write('\x15');
    // Voice typing as you speak: words come in pieces, Windows rewrites some, and Enter comes last.
    await sleep(300);
    checks.voiceEdited({ remove: 0, add: 'echo live wor' });
    checks.voiceEdited({ remove: 3, add: 'words\ntoo' });
    await sleep(600);
    const live = await page(`(() => { const b = houseTest.state.active.live.term.buffer.active; const out = []; for (let i = 0; i < b.length; i += 1) out.push(b.getLine(i).translateToString(true)); return out.filter(Boolean); })()`);
    report(live.some((line) => line.endsWith('echo live words too')), `live voice typing takes back and adds letters (${JSON.stringify(live.slice(-1))})`);
    report(!live.some((line) => line.trim() === 'live words too'), 'and nothing runs before Enter');
    checks.voiceEdited({ remove: 0, add: '', enter: true });
    await sleep(800);
    const ran = await page(`(() => { const b = houseTest.state.active.live.term.buffer.active; const out = []; for (let i = 0; i < b.length; i += 1) out.push(b.getLine(i).translateToString(true)); return out.filter(Boolean); })()`);
    report(ran.some((line) => line.trim() === 'live words too'), `Enter from voice typing runs it, after the words (${JSON.stringify(ran.slice(-2))})`);
    // Into a text box you were in. Search is only on in the file view.
    await page(`(() => { houseTest.activateTab(houseTest.state.tabs.find((t) => t.kind === 'files')); houseTest.navigate(houseTest.state.projects); return true; })()`);
    await sleep(800);
    await page(`document.getElementById('search').focus(); true`);
    await sleep(200);
    checks.voiceTyped('find this');
    await sleep(500);
    const box = await page(`document.getElementById('search').value`);
    report(box === 'find this', `voice typing types into a text box (${JSON.stringify(box)})`);
    if (box !== 'find this') {
      console.log(`FAIL links: debug ${JSON.stringify(await page(`(() => {
        const s = document.getElementById('search');
        s.focus();
        const out = { active: document.activeElement?.id || document.activeElement?.tagName, hasFocus: document.hasFocus(), disabled: s.disabled, readOnly: s.readOnly, visible: s.offsetParent !== null };
        out.exec = document.execCommand('insertText', false, 'abc');
        out.after = s.value;
        try { s.setRangeText('xyz', 0, 0, 'end'); out.range = s.value; } catch (e) { out.rangeError = e.message; }
        return out;
      })()`))}`);
    }
    await page(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); return true; })()`);
    checks.voiceEdited({ remove: 0, add: 'find thsi' });
    checks.voiceEdited({ remove: 4, add: 'this 😀' });
    checks.voiceEdited({ remove: 2, add: '' });
    await sleep(500);
    const liveBox = await page(`document.getElementById('search').value`);
    report(liveBox === 'find this', `live voice typing in a text box, an emoji taken back whole (${JSON.stringify(liveBox)})`);
    await page(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); s.blur(); return true; })()`);
    await write('\x15exit\r');
    await sleep(800);
  },
  // Closing a room terminal's tab leaves it running, and Enter Room goes back into it. Needs
  // SHOT_PATH=panel/test/stub STUB_AGENTS=working, so SampleApp looks open. The room script here is a
  // stand-in written into the throwaway HOME: it keeps a list of "running" terminals the way Herdr
  // does, and notes each open and attach, so nothing real is ever reached.
  async resume({ page, shot }) {
    const home = require('os').homedir();
    if (!home.startsWith('/tmp/') || process.env.STUB_AGENTS !== 'working') {
      console.log('FAIL resume: only runs with a throwaway HOME and the stand-in docker');
      return;
    }
    const state = path.join(home, '.fake-room');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'running'), '');
    fs.writeFileSync(path.join(state, 'log'), '');
    fs.writeFileSync(path.join(home, '.local', 'bin', 'room'), `#!/bin/bash
S="${state}"
add() { grep -qxF "$1"$'\\t'"$2" "$S/running" || printf '%s\\t%s\\n' "$1" "$2" >> "$S/running"; }
drop() { (flock 9; grep -vxF "$1"$'\\t'"$2" "$S/running" > "$S/running.new"; mv "$S/running.new" "$S/running") 9>"$S/lock"; }
connect() { # like Herdr: closing the line leaves it running; typing exit ends it
  PS1="fake $2$ " bash --noprofile --norc -i
  [ -f "$S/lost" ] && exit 4 # with "lost": only the line dropped, as when the network goes
  drop "$1" "$2"
  exit 0
}
case "$1" in
  tabs) if [ -n "$2" ]; then grep -F "$2"$'\\t' "$S/running" || true; else cat "$S/running"; fi ;;
  open) echo "open $4" >> "$S/log"; add "$2" "$4"; connect "$2" "$4" ;;
  attach) echo "attach $3" >> "$S/log"; [ -f "$S/lost" ] && [ -f "$S/unreachable" ] && exit 4; grep -qxF "$2"$'\\t'"$3" "$S/running" || exit 3; connect "$2" "$3" ;;
  tab-stop) echo "stop $3" >> "$S/log"; drop "$2" "$3" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const log = () => fs.readFileSync(path.join(state, 'log'), 'utf8').trim().split('\n').filter(Boolean).join();
    const running = () => fs.readFileSync(path.join(state, 'running'), 'utf8').trim();
    const report = (ok, label) => console.log(`${ok ? 'PASS' : 'FAIL'} resume: ${label}`);
    const termTabs = () => page(`houseTest.state.tabs.filter((t) => t.kind === 'term').map((t) => [t.room, t.tab, t.termId])`);
    const roomTabs = async () => JSON.stringify((await termTabs()).filter(([room]) => room).map(([room, tab]) => [room, tab]));
    const closeActive = () => page(`document.querySelector('.tab.active .close-tab').click(); true`);

    await page('houseTest.refreshStatus().then(() => true)');
    await sleep(500);
    await page(`houseTest.enterRoom('SampleApp').then(() => true)`);
    await sleep(1500);
    report(await roomTabs() === '[["SampleApp","tab-1"]]', `Enter Room opens tab-1 (${await roomTabs()})`);
    report(log() === 'open tab-1', `it started a new one (${log()})`);

    // Close the tab: no question, a note, and still running.
    await closeActive();
    await sleep(800);
    report(!(await page(`document.getElementById('dialog').open`)), 'closing a room tab asks nothing');
    report(await roomTabs() === '[]', 'the tab is gone');
    const note = await page(`document.querySelector('.toast').hidden ? '' : document.querySelector('.toast').textContent`);
    report(note.includes('Still running in the room'), `a note says it's still running (${JSON.stringify(note)})`);
    await shot('resume-closed');
    report(running() === 'SampleApp\ttab-1', 'still running in the room');

    // Enter Room goes back into it instead of starting another.
    await page(`houseTest.enterRoom('SampleApp').then(() => true)`);
    await sleep(1500);
    report(await roomTabs() === '[["SampleApp","tab-1"]]', 'Enter Room shows tab-1 again');
    report(log() === 'open tab-1,attach tab-1', `it went back in, not a new one (${log()})`);

    // Undo on the note brings it straight back.
    await closeActive();
    await sleep(800);
    await page(`document.querySelector('.toast-button').click(); true`);
    await sleep(1500);
    report(await roomTabs() === '[["SampleApp","tab-1"]]', 'Undo brings the tab back');
    report(log() === 'open tab-1,attach tab-1,attach tab-1', `Undo went back into the same one (${log()})`);
    await shot('resume-back');

    // Two clicks on Enter Room at once still make one tab.
    await closeActive();
    await sleep(800);
    await page(`Promise.all([houseTest.enterRoom('SampleApp'), houseTest.enterRoom('SampleApp')]).then(() => true)`);
    await sleep(1500);
    report(await roomTabs() === '[["SampleApp","tab-1"]]', `a double click on Enter Room opens one tab (${await roomTabs()})`);
    // The same for a terminal's row on the Agents page.
    await closeActive();
    await sleep(800);
    await page(`Promise.all([houseTest.openTerminal({ room: 'SampleApp', tab: 'tab-1' }), houseTest.openTerminal({ room: 'SampleApp', tab: 'tab-1' })]).then(() => true)`);
    await sleep(1500);
    report(await roomTabs() === '[["SampleApp","tab-1"]]', `a double click on an Agents row opens one tab (${await roomTabs()})`);

    // In its own window: Enter Room brings that window forward instead of opening a tab.
    const before = log();
    await page(`houseTest.popOutTab(houseTest.state.tabs.find((t) => t.kind === 'term')).then(() => true)`);
    await sleep(2500);
    const { BrowserWindow } = require('electron');
    // A window made from a tab opens index.html?tab=1.
    const popped = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html?tab'));
    report(Boolean(popped()) && await roomTabs() === '[]', 'popped out into its own window');
    await page(`houseTest.enterRoom('SampleApp').then(() => true)`);
    await sleep(1000);
    report(await roomTabs() === '[]' && log() === before, 'Enter Room goes to that window, nothing new');
    // Closing that window leaves it running too, and Enter Room brings it back as a tab.
    await popped().webContents.executeJavaScript(`document.getElementById('win-close').click(); true`);
    await sleep(2000);
    report(!popped() && running() === 'SampleApp\ttab-1', 'closing its window leaves it running');
    await page(`houseTest.enterRoom('SampleApp').then(() => true)`);
    await sleep(1500);
    report(await roomTabs() === '[["SampleApp","tab-1"]]' && log().endsWith('attach tab-1'), 'Enter Room brings it back from there too');

    // The line drops (network): it joins again by itself.
    fs.writeFileSync(path.join(state, 'lost'), '');
    let [[, , lineId]] = await termTabs();
    await page(`window.house.call('termWrite', ${lineId}, 'exit\\r').then(() => true)`);
    await sleep(2500);
    report(await page(`houseTest.state.tabs.filter((t) => t.kind === 'term').every((t) => !t.ended)`) && log().endsWith('attach tab-1,attach tab-1'), 'a dropped line joins again by itself');
    // It can't get back in: the tab says so, and Enter Room later puts a working one in its place.
    fs.writeFileSync(path.join(state, 'unreachable'), '');
    [[, , lineId]] = await termTabs();
    await page(`window.house.call('termWrite', ${lineId}, 'exit\\r').then(() => true)`);
    await sleep(6000);
    const lostText = await page(`(() => {
      const term = houseTest.state.tabs.find((t) => t.kind === 'term').live.term.buffer.active;
      let text = '';
      for (let i = 0; i < term.length; i += 1) text += (term.getLine(i)?.translateToString(true) || '') + ' ';
      return text.replace(/\\s+/g, ' ');
    })()`);
    report(await page(`houseTest.state.tabs.filter((t) => t.kind === 'term').length === 1 && houseTest.state.tabs.find((t) => t.kind === 'term').ended === true`), 'when it can\'t get back in, the tab says so');
    report(lostText.includes('Lost the connection'), `its message: ${JSON.stringify(lostText.trim().slice(-140))}`);
    await shot('resume-lost');
    fs.rmSync(path.join(state, 'unreachable'));
    fs.rmSync(path.join(state, 'lost'));
    await page(`houseTest.enterRoom('SampleApp').then(() => true)`);
    await sleep(1500);
    report(await roomTabs() === '[["SampleApp","tab-1"]]' && await page(`houseTest.state.tabs.filter((t) => t.kind === 'term').every((t) => !t.ended)`), `Enter Room replaces the dead tab with a working one (${await roomTabs()})`);

    // Right and middle clicks never reach what runs in a room terminal (Herdr opens menus on them);
    // left clicks still do. The stand-in asks for mouse clicks and prints what it gets.
    fs.writeFileSync(path.join(state, 'mouse.sh'), "printf '\\033[?1000h\\033[?1006h'; exec cat -v\n");
    let [[, , clickId]] = await termTabs();
    await page(`window.house.call('termWrite', ${clickId}, 'bash ${path.join(state, 'mouse.sh')}\\r').then(() => true)`);
    await sleep(1200);
    const click = (buttons) => page(`(() => {
      const screen = houseTest.state.active.host.querySelector('.xterm-screen');
      const box = screen.getBoundingClientRect();
      for (const button of ${JSON.stringify(buttons)}) {
        const at = { bubbles: true, cancelable: true, clientX: box.left + 40, clientY: box.top + 40, button };
        screen.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: [1, 4, 2][button] }));
        screen.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
        screen.dispatchEvent(new MouseEvent('contextmenu', at));
      }
      return true;
    })()`);
    const seen = () => page(`(() => { const b = houseTest.state.active.live.term.buffer.active; let s = ''; for (let i = 0; i < b.length; i += 1) s += b.getLine(i).translateToString(true); return s; })()`);
    await click([2, 1]);
    await sleep(800);
    const afterRight = await seen();
    report(!/\^\[\[<[12];/.test(afterRight), `right and middle clicks don't reach it (${JSON.stringify((afterRight.match(/\^\[\[<[0-9;]+[Mm]/g) || []).join(' '))})`);
    await click([0]);
    await sleep(800);
    report(/\^\[\[<0;/.test(await seen()), 'a left click still does');
    await page(`window.house.call('termWrite', ${clickId}, '\\x03').then(() => true)`);
    await sleep(500);
    await page(`window.house.call('termWrite', ${clickId}, "printf '\\\\033[?1000l\\\\033[?1006l'\\r").then(() => true)`);
    await sleep(500);

    // Two clicks on New Room at once get two different terminals.
    await page(`Promise.all([houseTest.openTerminal({ room: 'SampleApp' }), houseTest.openTerminal({ room: 'SampleApp' })]).then(() => true)`);
    await sleep(1500);
    report(await roomTabs() === '[["SampleApp","tab-1"],["SampleApp","tab-2"],["SampleApp","tab-3"]]', `two New Room clicks at once make tab-2 and tab-3 (${await roomTabs()})`);
    for (const extra of ['tab-2', 'tab-3']) {
      const found = (await termTabs()).find(([, tab]) => tab === extra);
      if (found) await page(`window.house.call('termWrite', ${found[2]}, 'exit\\r').then(() => true)`);
    }
    await sleep(1500);
    report(running() === 'SampleApp\ttab-1' && await roomTabs() === '[["SampleApp","tab-1"]]', `typing exit in those ends them and their tabs (${await roomTabs()})`);

    // Typing exit really ends it, so the next Enter Room starts a fresh one.
    const [[, , id]] = await termTabs();
    await page(`window.house.call('termWrite', ${id}, 'exit\\r').then(() => true)`);
    await sleep(1500);
    report(await roomTabs() === '[]' && running() === '', 'typing exit ends it and closes its tab');
    await page(`houseTest.enterRoom('SampleApp').then(() => true)`);
    await sleep(1500);
    report(log().endsWith('open tab-3,open tab-1'), `then Enter Room starts a new one (${log().split(',').slice(-2).join()})`);

    // A plain house terminal still asks first when something is running in it.
    const [[, , roomId]] = await termTabs();
    await page(`houseTest.openTerminal({}).then(() => true)`);
    await sleep(1500);
    const house = (await termTabs()).find(([room]) => !room);
    await page(`window.house.call('termWrite', ${house[2]}, 'sleep 30\\r').then(() => true)`);
    await sleep(1200);
    await closeActive();
    await sleep(800);
    report(await page(`document.getElementById('dialog').open && document.getElementById('dialog').textContent.includes('Close this terminal?')`), 'a busy house terminal asks first');
    await shot('resume-house-asks');
    await page(`document.querySelector('#dialog .btn.danger').click(); true`);
    await sleep(800);
    report(!(await termTabs()).some(([room]) => !room), `and closes when told to (${JSON.stringify(await termTabs())}, dialog open ${await page(`document.getElementById('dialog').open`)})`);

    // A busy house terminal in its own window, closed from the taskbar: it asks first too.
    await page(`houseTest.openTerminal({}).then(() => true)`);
    await sleep(1500);
    const busyOne = (await termTabs()).find(([room]) => !room);
    await page(`window.house.call('termWrite', ${busyOne[2]}, 'sleep 30\\r').then(() => true)`);
    await sleep(1200);
    await page(`houseTest.popOutTab(houseTest.state.tabs.find((t) => t.termId === ${busyOne[2]})).then(() => true)`);
    await sleep(2500);
    popped().close(); // what the taskbar's Close does
    await sleep(1200);
    report(Boolean(popped()) && await popped().webContents.executeJavaScript(`document.getElementById('dialog').open`), 'closing a busy terminal window from the taskbar asks first');
    let hiddenFirst = false;
    const closing = popped();
    closing.once('hide', () => { hiddenFirst = !closing.isVisible() && !closing.isDestroyed(); });
    await popped().webContents.executeJavaScript(`document.querySelector('#dialog .btn.danger').click(); true`);
    await sleep(1500);
    report(!popped(), 'and closes when told to');
    report(hiddenFirst, 'a closing window is hidden before it is destroyed');
    // Bringing a room terminal's window back to the tabs asks nothing.
    await page(`houseTest.popOutTab(houseTest.state.tabs.find((t) => t.kind === 'term' && t.room === 'SampleApp')).then(() => true)`);
    await sleep(2500);
    await popped().webContents.executeJavaScript(`document.querySelector('.tab .bring-back').click(); true`);
    await sleep(1500);
    report(!popped() && await roomTabs() === '[["SampleApp","tab-1"]]' && running() === 'SampleApp\ttab-1', `bringing it back to the tabs just works (${await roomTabs()})`);

    // The page crashes: it starts again by itself and the room terminal comes back as a tab.
    const { BrowserWindow: Windows } = require('electron');
    const main = Windows.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('/index.html'));
    const attachesBefore = log().split(',').length;
    main.webContents.forcefullyCrashRenderer();
    await sleep(6000);
    let back = false;
    const end = Date.now() + 20000;
    while (!back && Date.now() < end) {
      back = await page(`Boolean(window.houseTest) && houseTest.state.tabs.some((t) => t.kind === 'term' && t.room === 'SampleApp' && t.tab === 'tab-1')`).catch(() => false);
      if (!back) await sleep(500);
    }
    report(back, 'after a page crash, the room terminal comes back as a tab');
    report(running() === 'SampleApp\ttab-1' && log().split(',').length === attachesBefore + 1 && log().endsWith('attach tab-1'), `the same one, joined again once (${log().split(',').slice(-2).join()})`);
    await shot('resume-after-crash');
    const [[, , afterCrash]] = await termTabs();
    await page(`window.house.call('termKill', ${afterCrash}).then(() => true)`);
    await sleep(800);
  },
  // Each terminal in a project is one of its rooms. Close Room on one ends only that one, the others
  // keep going, and only the last one closes the whole room. From the project's files the button
  // says Close All Rooms. Needs SHOT_PATH=panel/test/stub STUB_AGENTS=working, like resume, with
  // the same kind of stand-in room script, so nothing real is reached.
  async closeOne({ page, shot }) {
    const home = require('os').homedir();
    if (!home.startsWith('/tmp/') || process.env.STUB_AGENTS !== 'working') {
      console.log('FAIL closeOne: only runs with a throwaway HOME and the stand-in docker');
      return;
    }
    const state = path.join(home, '.fake-room');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'running'), '');
    fs.writeFileSync(path.join(state, 'log'), '');
    fs.writeFileSync(path.join(home, '.local', 'bin', 'room'), `#!/bin/bash
S="${state}"
add() { grep -qxF "$1"$'\\t'"$2" "$S/running" || printf '%s\\t%s\\n' "$1" "$2" >> "$S/running"; }
keep() { (flock 9; grep -v "$1" "$S/running" > "$S/running.new"; mv "$S/running.new" "$S/running") 9>"$S/lock"; }
drop() { keep "^$1"$'\\t'"$2\\$"; }
connect() { PS1="fake $2$ " bash --noprofile --norc -i; drop "$1" "$2"; exit 0; }
case "$1" in
  tabs) if [ -n "$2" ]; then grep -F "$2"$'\\t' "$S/running" || true; else cat "$S/running"; fi ;;
  open) echo "open $4" >> "$S/log"; add "$2" "$4"; connect "$2" "$4" ;;
  attach) echo "attach $3" >> "$S/log"; grep -qxF "$2"$'\\t'"$3" "$S/running" || exit 3; connect "$2" "$3" ;;
  tab-stop) echo "stop $3" >> "$S/log"; drop "$2" "$3" ;;
  close) echo "close $2" >> "$S/log"; keep "^$2"$'\\t' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const log = () => fs.readFileSync(path.join(state, 'log'), 'utf8').trim().split('\n').filter(Boolean).join();
    const running = () => fs.readFileSync(path.join(state, 'running'), 'utf8').trim().split('\n').filter(Boolean).join();
    const report = (ok, label) => console.log(`${ok ? 'PASS' : 'FAIL'} closeOne: ${label}`);
    const roomTabs = async () => JSON.stringify(await page(`houseTest.state.tabs.filter((t) => t.kind === 'term' && t.room).map((t) => t.tab)`));
    const button = () => page(`(() => { const b = document.getElementById('room-close-btn'); return b.hidden ? '(hidden)' : b.textContent.trim(); })()`);
    const pressButton = () => page(`document.getElementById('room-close-btn').click(); true`);
    const asked = () => page(`(() => { const d = document.getElementById('dialog'); return d.open ? d.querySelector('.dialog-title').textContent + ' | ' + d.querySelector('.dialog-text').textContent : ''; })()`);
    const answer = async (yes) => { const done = await page(`(() => { try { const d = document.getElementById('dialog'); if (${Boolean(yes)}) d.querySelector('.btn.danger').click(); else d.close(); return 'ok'; } catch (e) { return String(e); } })()`); if (done !== 'ok') console.log('NOTE closeOne answer: ' + done); };

    await page('houseTest.refreshStatus().then(() => true)');
    await sleep(500);
    await page(`houseTest.enterRoom('SampleApp').then(() => true)`);
    await sleep(1500);
    await page(`houseTest.openTerminal({ room: 'SampleApp' }).then(() => true)`);
    await sleep(1500);
    report(await roomTabs() === '["tab-1","tab-2"]' && running() === 'SampleApp\ttab-1,SampleApp\ttab-2', `two rooms open in SampleApp (${await roomTabs()}; ${running()})`);
    report(await button() === 'Close Room', `on a terminal the button says Close Room (${await button()})`);

    // It asks about this one only. Cancel changes nothing.
    await pressButton();
    await sleep(800);
    const first = await asked();
    report(first.startsWith('Close Room? |') && first.includes('Your other room keeps going'), `it asks about this one only (${JSON.stringify(first)})`);
    await shot('close-one-ask');
    await answer(false);
    await sleep(500);
    report(await roomTabs() === '["tab-1","tab-2"]' && !log().includes('stop'), 'Cancel leaves both');

    // Yes: only that one ends. The room and the other terminal keep going.
    await pressButton();
    await sleep(800);
    await answer(true);
    await sleep(1500);
    report(await roomTabs() === '["tab-1"]', `only that terminal's tab went (${await roomTabs()})`);
    report(log().endsWith('stop tab-2') && !log().includes('close'), `it ended just tab-2, the room stays (${log()})`);
    report(running() === 'SampleApp\ttab-1', `tab-1 is still running (${running()})`);

    // One still running with no tab showing it counts as another room too. This time from the
    // tab's own right-click menu.
    await page(`document.querySelector('.tab.active .close-tab').click(); true`);
    await sleep(800);
    await page(`houseTest.openTerminal({ room: 'SampleApp' }).then(() => true)`);
    await sleep(1500);
    report(await roomTabs() === '["tab-2"]' && running() === 'SampleApp\ttab-1,SampleApp\ttab-2', `tab-1 hidden, tab-2 showing (${await roomTabs()}; ${running()})`);
    await page(`(() => { const t = document.querySelector('.tab.active'); const box = t.getBoundingClientRect(); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 10 })); return true; })()`);
    await sleep(400);
    const items = await page(`[...document.querySelectorAll('#menu:not([hidden]) .menu-item')].map((m) => m.textContent.trim())`);
    report(items.join() === 'Cut,Copy,Paste,Select All,Export Chat,Export Chat with Details,New Tab,Move to New Window,Close Tab,Close Room', `the tab's menu has the shared four first and Close Room last (${items.join()})`);
    await page(`[...document.querySelectorAll('#menu:not([hidden]) .menu-item')].find((m) => m.textContent.trim() === 'Close Room').click(); true`);
    await sleep(800);
    const second = await asked();
    report(second.includes('Your other room keeps going'), `the hidden one counts (${JSON.stringify(second)})`);
    await answer(true);
    await sleep(1500);
    report(await roomTabs() === '[]' && running() === 'SampleApp\ttab-1' && !log().includes('close'), `tab-2 ended, tab-1 still running (${running()}; ${log()})`);

    // The last one says so, and then the whole room closes.
    await page(`houseTest.enterRoom('SampleApp').then(() => true)`);
    await sleep(1500);
    report(await roomTabs() === '["tab-1"]' && log().endsWith('attach tab-1'), `Enter Room went back into tab-1 (${log()})`);
    await pressButton();
    await sleep(800);
    const last = await asked();
    report(last.startsWith('Close Room? |') && last.includes('It\'s the last one, so the whole room closes'), `the last one says the whole room closes (${JSON.stringify(last)})`);
    await shot('close-one-last');
    await answer(true);
    await sleep(2000);
    report(log().includes('attach tab-1,close SampleApp') && await roomTabs() === '[]' && running() === '', `then the whole room closed (${log()})`);

    // From the project's files the button closes them all, and says so.
    await page(`(async () => { await houseTest.navigate(houseTest.state.projects + '/SampleApp'); return true; })()`);
    await sleep(800);
    report(await button() === 'Close All Rooms', `in the project's files it says Close All Rooms (${await button()})`);
    await pressButton();
    await sleep(800);
    const all = await asked();
    report(all.startsWith('Close All Rooms? |') && all.includes('Every room in "SampleApp" stops'), `and asks about all of them (${JSON.stringify(all)})`);
    await shot('close-all-ask');
    await answer(false);
    await sleep(500);
  },
  // Closing one room (one terminal) from the Agents page and from a Home card, and the Linux House
  // section on the Agents page: each house terminal, the AI in it and what it's doing. Needs
  // SHOT_PATH=panel/test/stub STUB_AGENTS=working, with a stand-in room script, like closeOne.
  async roomsAndHouse({ page, shot }) {
    const home = require('os').homedir();
    if (!home.startsWith('/tmp/') || process.env.STUB_AGENTS !== 'working') {
      console.log('FAIL roomsAndHouse: only runs with a throwaway HOME and the stand-in docker');
      return;
    }
    const report = (ok, label) => console.log(`${ok ? 'PASS' : 'FAIL'} roomsAndHouse: ${label}`);
    const state = path.join(home, '.fake-room');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'running'), 'SampleApp\ttab-1\nSampleApp\ttab-2\nSampleApp\ttab-3\n');
    fs.writeFileSync(path.join(state, 'log'), '');
    fs.writeFileSync(path.join(home, '.local', 'bin', 'room'), `#!/bin/bash
S="${state}"
keep() { (flock 9; grep -v "$1" "$S/running" > "$S/running.new"; mv "$S/running.new" "$S/running") 9>"$S/lock"; }
case "$1" in
  tabs) if [ -n "$2" ]; then grep -F "$2"$'\\t' "$S/running" || true; else cat "$S/running"; fi ;;
  tab-stop) echo "stop $3" >> "$S/log"; keep "^$2"$'\\t'"$3\\$" ;;
  close) echo "close $2" >> "$S/log"; keep "^$2"$'\\t' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const log = () => fs.readFileSync(path.join(state, 'log'), 'utf8').trim().split('\n').filter(Boolean).join();
    const asked = () => page(`(() => { const d = document.getElementById('dialog'); return d.open ? d.querySelector('.dialog-title').textContent + ' | ' + d.querySelector('.dialog-text').textContent : ''; })()`);
    const answer = (yes) => page(`(() => { const d = document.getElementById('dialog'); if (${Boolean(yes)}) d.querySelector('.btn.danger').click(); else d.close(); return true; })()`);
    const menuItems = () => page(`[...document.querySelectorAll('#menu:not([hidden]) .menu-item')].map((m) => m.textContent.trim())`);

    // A stand-in AI for a house terminal: it names its terminal, works for a while, then asks.
    const bin = path.join(home, 'fakebin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash
printf '\\033]0;\\342\\234\\263 Fix the project dot\\007'
printf '\\033[2J\\033[H Welcome back\\n\\n \\342\\234\\273 Thinking\\342\\200\\246 (12s \\302\\267 esc to interrupt)\\n'
while [ ! -e "$HOME/ask-now" ]; do sleep 0.2; done
printf '\\033[2J\\033[H Bash command\\n   rm -rf build\\n Do you want to proceed?\\n \\342\\235\\257 1. Yes\\n   2. No\\n'
exec -a claude sleep 600
`, { mode: 0o755 });

    await page('houseTest.refreshStatus().then(() => true)');
    await sleep(500);

    // The House section is there even with no house terminal open.
    await page(`houseTest.openAgents(); window.house.call('agentsWatch', true).then(() => true)`);
    await sleep(4000);
    const empty = await page(`(() => { const h = document.querySelector('.agents-house'); return h ? h.querySelector('.agents-room-head').textContent : ''; })()`);
    report(empty.includes('Linux House') && empty.includes('No terminals open') && empty.includes('New Terminal'), `House is always shown (${JSON.stringify(empty)})`);

    // Each room line has Close. It asks about that one only, and ends just that one.
    const rows = await page(`[...document.querySelectorAll('.agents-room:not(.agents-house) .agents-tab')].map((r) => r.textContent)`);
    report(rows.length === 5 && rows.every((r) => r.endsWith('Close')), `every room line has Close (${JSON.stringify(rows)})`);
    await page(`[...document.querySelectorAll('.agents-room')].find((b) => b.querySelector('.agents-room-name').textContent === 'SampleApp').querySelectorAll('.agents-tab')[1].querySelector('.agents-close').click(); true`);
    await sleep(1000);
    const one = await asked();
    report(one.startsWith('Close Room? |') && one.includes('Your other 2 rooms keep going'), `Agents Close asks about that one (${JSON.stringify(one)})`);
    await shot('rooms-agents-ask');
    await answer(true);
    await sleep(1500);
    report(log() === 'stop tab-2', `only SampleApp's Terminal 2 ended (${log()})`);

    // A house terminal with an AI working in it, then needing you.
    await page(`houseTest.openTerminal({ cwd: ${JSON.stringify(home)} }).then(() => true)`);
    await sleep(1500);
    const termId = await page(`houseTest.state.tabs.find((t) => t.kind === 'term' && !t.room).termId`);
    await page(`window.house.call('termWrite', ${termId}, ${JSON.stringify(`${bin}/claude\r`)}).then(() => true)`);
    await sleep(1500);
    await page(`houseTest.openAgents(); true`);
    await sleep(4500);
    const houseRow = () => page(`(() => { const r = document.querySelector('.agents-house .agents-tab'); return r ? r.className + ' | ' + r.textContent : ''; })()`);
    const working = await houseRow();
    report(working.includes('working') && working.includes('Claude') && working.includes('Fix the project dot') && working.includes('Terminal 1'), `the house terminal shows its AI working (${JSON.stringify(working)})`);
    const head = await page(`document.querySelector('.agents-house .agents-room-head').textContent`);
    report(head.includes('1 terminal open'), `House says 1 terminal open (${JSON.stringify(head)})`);
    const summary = await page(`document.querySelector('.agents-summary').textContent`);
    report(summary.includes('2 agents working'), `the summary counts the house's AI (${JSON.stringify(summary)})`);
    await shot('rooms-agents-house');
    fs.writeFileSync(path.join(home, 'ask-now'), '');
    await sleep(4500);
    const blocked = await houseRow();
    report(blocked.includes('blocked') && blocked.includes('Needs you'), `then that it needs you (${JSON.stringify(blocked)})`);

    // Clicking its line goes to it.
    await page(`houseTest.openAgents(); true`);
    await sleep(300);
    await page(`document.querySelector('.agents-house .agents-tab').click(); true`);
    await sleep(500);
    report(await page(`houseTest.state.active.kind === 'term' && houseTest.state.active.termId === ${termId}`), 'clicking the line goes to the terminal');

    // Close on its line asks first, since the AI is still running, then the terminal ends.
    await page(`houseTest.openAgents(); true`);
    await sleep(4000);
    await page(`document.querySelector('.agents-house .agents-tab .agents-close').click(); true`);
    await sleep(1000);
    const busy = await asked();
    report(busy.startsWith('Close this terminal? |'), `closing a busy house terminal asks (${JSON.stringify(busy)})`);
    await answer(true);
    await sleep(1500);
    report(await page(`!houseTest.state.tabs.some((t) => t.termId === ${termId})`), 'and then it is gone');
    await sleep(3500);
    const after = await page(`document.querySelector('.agents-house .agents-room-head').textContent`);
    report(after.includes('No terminals open'), `House says none again (${JSON.stringify(after)})`);
    await page(`window.house.call('agentsWatch', false).then(() => true)`);

    // Home: an open room's card has an arrow beside Enter Room, listing its rooms to close.
    await page(`(async () => { houseTest.activateTab(houseTest.state.tabs.find((t) => t.kind === 'files')); await houseTest.navigate('home:'); return true; })()`);
    await sleep(2500);
    const extra = await page(`(() => { const c = document.querySelector('.home-card[data-project="SampleApp"]'); return c.querySelectorAll('.home-card-btn').length; })()`);
    report(extra === 1, `SampleApp's card has only its Enter Room button, no arrow or Preview button (${extra})`);
    await page(`(() => { const c = document.querySelector('.home-card[data-project="SampleApp"]'); const b = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 30, clientY: b.top + 20 })); return true; })()`);
    await sleep(1500);
    const items = await menuItems();
    report(['Enter Room', 'Preview', 'New Room'].every((name) => items.some((item) => item.startsWith(name))) && items.filter((item) => item.startsWith('Close')).join('|') === 'Close Room 1 · Claude, Working|Close Room 2 · Codex, Needs you|Close Room 3 · Gemini, Done|Close All Rooms', `the card's right-click menu has Enter Room, Preview, New Room and each room to close (${items.join('|')})`);
    await shot('rooms-home-menu');
    await page(`[...document.querySelectorAll('#menu:not([hidden]) .menu-item')].find((m) => m.textContent.startsWith('Close Room 3')).click(); true`);
    await sleep(1000);
    const three = await asked();
    report(three.startsWith('Close Room? |') && three.includes('Your other room keeps going'), `Home asks about that one (${JSON.stringify(three)})`);
    await answer(true);
    await sleep(1500);
    report(log() === 'stop tab-2,stop tab-3', `only Terminal 3 ended (${log()})`);

    // The card's right-click menu lists them too.
    await page(`(() => { const c = document.querySelector('.home-card[data-project="SampleApp"]'); const b = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 30, clientY: b.top + 20 })); return true; })()`);
    await sleep(1500);
    const right = await menuItems();
    report(right.includes('Close Room 1 · Claude, Working') && right.includes('Close All Rooms'), `the card's right-click menu lists them too (${right.join('|')})`);
    await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  },
  // Alt+L while Station 256 is open asks the running app for a new window (start.sh --new-window,
  // from windows/station-keys.ps1), the way Win+E does. It starts like a cold start (loading screen,
  // then the Home page) and joins the others. A plain second launch (the shortcut) still opens nothing new. Nothing goes on screen.
  async altL({ page }) {
    const { app, BrowserWindow } = require('electron');
    const report = (ok, label) => console.log(`${ok ? 'PASS' : 'FAIL'} altL: ${label}`);
    const stations = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !w.houseSpare && w.webContents.getURL().includes('index.html'));
    const inWin = (w, code) => w.webContents.executeJavaScript(code);
    const before = stations();

    app.emit('second-instance', {}, [], '', {});
    await sleep(1500);
    report(stations().length === before.length, `the shortcut again opens nothing new (${stations().length} window(s))`);

    app.emit('second-instance', {}, [], '', { newWindow: true });
    let added = [];
    for (let i = 0; i < 40 && added.length === 0; i += 1) {
      await sleep(200);
      added = stations().filter((w) => !before.includes(w));
    }
    report(added.length === 1, `Alt+L opens one new window (${added.length})`);
    if (added.length !== 1) return;
    const win = added[0];
    win.webContents.beginFrameSubscription(false, () => {}); // keeps its timers going while unseen
    // Like a cold start: the loading screen first, then the Home page.
    let sawLoading = false;
    let tabs = '';
    for (let i = 0; i < 80 && !tabs; i += 1) {
      await sleep(100);
      const now = await inWin(win, `window.houseTest ? { loading: !document.getElementById('splash').hidden, tabs: houseTest.state.tabs.map((t) => t.kind + ' ' + (t.path || '')).join() } : null`).catch(() => null);
      if (now && now.loading) sawLoading = true;
      if (now && !now.loading) tabs = now.tabs;
    }
    report(sawLoading, 'it shows the loading screen first, like a cold start');
    report(tabs === 'files home:', `then the Home page (${JSON.stringify(tabs)})`);
    await sleep(800);
    const count = await inWin(win, 'houseTest.windowInfo.count');
    const mainCount = await page('houseTest.windowInfo.count');
    report(count === before.length + 1 && mainCount === before.length + 1, `both windows count each other (${count}, ${mainCount})`);
    const sameAgents = await inWin(win, 'JSON.stringify((houseTest.state.status.rooms || []).map((r) => r.name))') === await page('JSON.stringify((houseTest.state.status.rooms || []).map((r) => r.name))');
    report(sameAgents, 'it sees the same rooms as the first window');

    // A second press makes a third window, as Win+E does.
    app.emit('second-instance', {}, [], '', { newWindow: true });
    let third = [];
    for (let i = 0; i < 40 && third.length === 0; i += 1) {
      await sleep(200);
      third = stations().filter((w) => !before.includes(w) && w !== win);
    }
    report(third.length === 1, `pressing again opens another (${stations().length} window(s))`);

    for (const w of [win, ...third]) {
      if (w !== win) w.webContents.beginFrameSubscription(false, () => {}); // so its closing motion runs
      for (let i = 0; i < 40; i += 1) {
        if (await inWin(w, `Boolean(window.houseTest) && houseTest.state.tabs.length > 0`).catch(() => false)) break;
        await sleep(200);
      }
      await inWin(w, `document.getElementById('win-close').click(); true`).catch(() => {});
    }
    await sleep(1500);
    report(stations().length === before.length, `closing them leaves the first one (${stations().length})`);
  },
  // Any tab can have a window of its own, but only when another tab is left behind, and tabs move
  // between windows, as in Chrome. The pointer is a stand-in, so the real mouse is never touched.
  // Closes the main window at the end, so run it on its own: shotrun.sh windows
  // Local AI (renderer/llama-tab.js, lib/llama.js) against the stand-in llama-server in test/stub.
  // llamaMissing: run with a PATH that has no llama-server. llama: run with SHOT_PATH=panel/test/stub.
  async llamaMissing({ page, shot, sleep }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    await page(ONE_TAB_LEFT);
    await page('(() => { openLlama(); return true; })()');
    await sleep(800);
    const text = await page('document.querySelector(".llama-box:not([hidden]) .llama-note")?.textContent || ""');
    report(/llama\.cpp, which isn't installed yet.*press Check again/.test(text), `not installed says: ${text.slice(0, 60)}...`);
    report(await page('!document.querySelector(".llama-chat").offsetParent && !document.querySelector(".llama-select").offsetParent'), 'no chat or model picker while not installed');
    await shot('llama-missing');
  },

  async llama({ page, shot, sleep, win }) {
    const fs = require('fs');
    const os = require('os');
    const { execFile } = require('child_process');
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const running = () => new Promise((done) => execFile('pgrep', ['-f', 'stub/llama-server'], (error, out) => done(String(out || '').trim().split('\n').filter(Boolean).length)));
    const until = async (code, ms = 8000) => {
      for (let waited = 0; waited < ms; waited += 100) {
        if (await page(code)) return true;
        await sleep(100);
      }
      return false;
    };
    const status = () => page('document.querySelector(".llama-status").textContent');
    const click = (label) => page(`(() => { const b = [...document.querySelectorAll('.llama-view .btn')].find((x) => x.textContent === ${JSON.stringify(label)} && !x.hidden); if (!b || b.disabled) return false; b.click(); return true; })()`);
    const say = (message) => page(`(() => { const box = document.querySelector('.llama-message'); box.value = ${JSON.stringify(message)}; box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    const lastReply = () => page('(() => { const b = [...document.querySelectorAll(".llama-bubble.assistant")].pop(); return b ? { text: b.querySelector(".llama-words").textContent, line: b.querySelector(".llama-line").textContent } : null; })()');
    fs.mkdirSync(`${os.homedir()}/models/sub`, { recursive: true });
    fs.writeFileSync(`${os.homedir()}/models/sub/tiny-test.gguf`, Buffer.alloc(3 * 1024 * 1024));
    fs.mkdirSync(`${os.homedir()}/projects/x/node_modules`, { recursive: true });
    fs.writeFileSync(`${os.homedir()}/projects/x/node_modules/skipped.gguf`, 'x');
    await page(ONE_TAB_LEFT);
    await page('(() => { openLlama(); return true; })()');
    report(await until('document.querySelector(".llama-select option")?.textContent.includes("tiny-test.gguf")'), 'model found by the scan');
    const options = await page('[...document.querySelectorAll(".llama-select option")].map((o) => o.textContent)');
    report(options.length === 1 && /3\.0 MB/.test(options[0]), `only the real model, with its size: ${options.join('|')}`);
    await shot('llama-ready-to-start');

    // Start -> Loading -> Ready.
    report(await click('Load model'), 'Load model pressed');
    await sleep(250);
    report(await status() === 'Loading the model…', `status while loading: ${await status()}`);
    report(await until('document.querySelector(".llama-status").textContent === "Ready"'), 'status becomes Ready');
    report(await running() === 1, `one server process: ${await running()}`);
    const saved = JSON.parse(fs.readFileSync(`${os.homedir()}/.config/house/llama.json`, 'utf8'));
    report(saved.model.endsWith('tiny-test.gguf') && saved.context === 4096 && saved.layers === 99, `settings remembered: ${JSON.stringify(saved)}`);

    // Chat, and stop generating halfway.
    await say('Hello <img src=x onerror="document.title=1"> there');
    await until('document.querySelector(".llama-bubble.assistant .llama-words")?.textContent.length > 25');
    await shot('llama-streaming');
    report(await click('Stop generating'), 'Stop generating pressed');
    await sleep(400);
    const halted = await lastReply();
    const lengthThen = halted.text.length;
    await sleep(800);
    const still = await lastReply();
    report(halted.line === 'Stopped' && still.text.length === lengthThen && lengthThen > 10, `stopped mid-reply and kept the text (${lengthThen} letters, "${halted.line}")`);
    report(await page('!document.querySelector(".llama-list img") && document.title !== "1"'), 'model/user text is not run as page code');
    report(await page('![...document.querySelectorAll(".llama-buttons .btn")].find((b) => b.textContent === "Stop generating").offsetParent'), 'Stop generating hides again');

    // A whole reply, with speed.
    await say('Tell me more');
    report(await until('/tokens per second/.test([...document.querySelectorAll(".llama-bubble.assistant")].pop()?.querySelector(".llama-line").textContent || "")', 12000), 'reply finished with a tokens per second line');
    const full = await lastReply();
    report(full.text.endsWith('to press stop.'), 'whole reply arrived in order');
    await shot('llama-reply');

    // A long chat stays quick: 500 questions and replies, then text arriving in the newest one, with
    // the page made to lay itself out after every piece. Then a small window, and zoomed in.
    const cost = await page(`(() => {
      const t0 = performance.now();
      for (let i = 0; i < 500; i += 1) { addLlamaBubble('user', 'Question ' + i); addLlamaBubble('assistant', 'A reply of a few lines. '.repeat(20)); }
      const last = addLlamaBubble('assistant', '');
      const list = document.querySelector('.llama-list');
      void list.scrollHeight;
      const t1 = performance.now();
      for (let i = 0; i < 200; i += 1) { last.words.appendData(' word'); void list.scrollHeight; }
      return { build: Math.round(t1 - t0), each: (performance.now() - t1) / 200 };
    })()`);
    report(cost.each < 4, `long chat: 1000 bubbles built in ${cost.build} ms, each new piece costs ${cost.each.toFixed(2)} ms`);
    const size = win.getSize();
    win.setSize(900, 600);
    await sleep(500);
    await shot('llama-small');
    // The page may scroll when it's this short, but nothing may be cut off at the side or out of reach.
    const fit = await page(`(() => {
      const view = document.querySelector('.llama-view');
      const box = document.querySelector('.llama-message').getBoundingClientRect();
      const right = view.getBoundingClientRect().right;
      const over = [...view.querySelectorAll('.llama-row, .llama-composer, .llama-list')].filter((part) => part.getBoundingClientRect().right > right + 1)
        .map((part) => part.className.split(' ')[0] + ' ' + Math.round(part.getBoundingClientRect().right - right) + 'px');
      return { side: !over.length, over, reach: box.bottom <= view.getBoundingClientRect().bottom + 1 || view.scrollHeight > view.clientHeight, w: innerWidth, h: innerHeight, list: Math.round(document.querySelector('.llama-list').clientHeight) };
    })()`);
    report(fit.side && fit.reach && fit.list >= 100, `small window (${fit.w} x ${fit.h}): nothing off the side, message box in reach, chat ${fit.list} tall${fit.side ? '' : `; off the side: ${fit.over.join(', ')}`}${fit.reach ? '' : '; message box out of reach'}`);
    // While a reply comes in, Stop generating joins the buttons: still nothing off the side.
    await say('Tell me more');
    await until('[...document.querySelectorAll(".llama-buttons .btn")].some((b) => b.textContent === "Stop generating" && b.offsetParent)');
    const busy = await page(`(() => {
      const right = document.querySelector('.llama-view').getBoundingClientRect().right;
      const buttons = [...document.querySelectorAll('.llama-buttons .btn')].filter((b) => b.offsetParent);
      return { names: buttons.map((b) => b.textContent), inside: buttons.every((b) => b.getBoundingClientRect().right <= right + 1), box: Math.round(document.querySelector('.llama-message').getBoundingClientRect().width) };
    })()`);
    await shot('llama-small-streaming');
    await click('Stop generating');
    report(busy.names.includes('Stop generating') && busy.inside && busy.box >= 150, `small window while a reply comes in: ${busy.names.join(', ')} all inside, typing box ${busy.box} wide`);
    const zoom = win.webContents.getZoomFactor();
    win.webContents.setZoomFactor(zoom * 1.3);
    await sleep(500);
    await shot('llama-small-zoomed');
    win.webContents.setZoomFactor(zoom);
    win.setSize(size[0], size[1]);
    await sleep(300);
    await click('New chat');
    report(await page('document.querySelectorAll(".llama-bubble").length === 0'), 'New chat empties the list');

    // Stop the server.
    report(await click('Unload model'), 'Unload model pressed');
    report(await until('document.querySelector(".llama-status").textContent === "Not loaded"'), 'status Not loaded');
    await sleep(300);
    report(await running() === 0, `no process after Stop: ${await running()}`);

    // A crash.
    await click('Load model');
    await until('document.querySelector(".llama-status").textContent === "Ready"');
    await say('CRASH now');
    report(await until('document.querySelector(".llama-status").textContent === "The model stopped by itself"'), 'status The model stopped by itself');
    const log = await page('document.querySelector(".llama-log:not([hidden]) .llama-log-text")?.textContent || ""');
    report(/out of memory/.test(log), `log shown: ${log.slice(0, 60)}`);
    report(await page('document.querySelector(".llama-message").value === "CRASH now" && document.querySelector(".llama-message").disabled'), 'message put back in the box');
    await page('document.querySelector(".llama-log").open = true');
    await shot('llama-crashed');
    report(await running() === 0, 'no process after the crash');

    // Starting again works, and is left running so the run's end must close it.
    await click('Load model');
    report(await until('document.querySelector(".llama-status").textContent === "Ready"'), 'starts again after a crash');
    report(await running() === 1, 'one process left running for the close test');
  },

  async windows({ page }) {
    const { BrowserWindow, screen } = require('electron');
    const report = (ok, label) => console.log(`${ok ? 'PASS' : 'FAIL'} windows: ${label}`);
    const all = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    const main = all().find((w) => /index\.html$/.test(w.webContents.getURL()));
    // A window that is never shown only keeps time (animations, timers) while its frames are watched.
    const watched = new Set();
    // A window kept ready out of sight isn't one of them until it's given a tab.
    const spareNow = () => all().find((w) => w.houseSpare) || null;
    const extras = () => all().filter((w) => w !== main && !w.houseSpare).map((w) => {
      if (!watched.has(w)) {
        watched.add(w);
        w.webContents.beginFrameSubscription(false, () => {});
      }
      return w;
    });
    const inWin = (w, code) => w.webContents.executeJavaScript(code);
    const kinds = (w) => inWin(w, `houseTest.state.tabs.map((t) => t.kind).join()`);
    const buttons = (w, name) => inWin(w, `[...document.querySelectorAll('.tabs .tab')].map((t) => !t.querySelector('.${name}').hidden).join()`);
    const waitFor = async (check, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await check().catch(() => false)) return true;
        await sleep(200);
      }
      return false;
    };
    const ready = (w) => waitFor(() => inWin(w, `Boolean(window.houseTest) && houseTest.state.tabs.length > 0`));
    // A point in a window's row of tabs, near its top and right of its tabs, in screen pixels.
    const onTabs = async (w) => {
      const at = await inWin(w, `(() => { const r = document.querySelector('.tabstrip').getBoundingClientRect(); const f = window.outerWidth / window.innerWidth; return { x: Math.round((r.left + 520) * f), y: Math.round((r.top + 6) * f) }; })()`);
      const bounds = w.getBounds();
      return { x: bounds.x + at.x, y: bounds.y + at.y };
    };
    const realPoint = screen.getCursorScreenPoint;
    let pointer = { x: 1800, y: 950 };
    screen.getCursorScreenPoint = () => pointer;
    try {
      // Scenes before this one may have left tabs open.
      await page(ONE_TAB_LEFT);
      await sleep(600);
      const { projects } = await page(`window.house.call('paths')`);
      await page(`houseTest.navigate(${JSON.stringify(projects)}); true`);
      await sleep(500);

      // One tab: no "own window" button, and the button does nothing.
      report(await page(`houseTest.state.tabs.length`) === 1 && await buttons(main, 'popout') === 'false', 'a lone tab has no "own window" button');
      await page(`houseTest.popOutTab(houseTest.state.tabs[0])`);
      await sleep(1200);
      report(extras().length === 0, 'a lone tab can\'t be moved to a window of its own');

      // Two tabs: both have it. The first, with its Back list, goes to a window of its own.
      await page(`houseTest.navigate(${JSON.stringify(`${projects}/SampleApp`)}); true`);
      await sleep(400);
      await page(`document.getElementById('new-tab').click(); true`);
      await sleep(600);
      report(await buttons(main, 'popout') === 'true,true', 'with two tabs, both have it');

      // Pointing at the button gets a window ready out of sight. It isn't counted, opens no tab of
      // its own, and is the one the tab then goes to.
      await page(`document.querySelector('.tabs .tab .popout').dispatchEvent(new PointerEvent('pointerenter')); true`);
      const warmed = await waitFor(async () => Boolean(spareNow()) && inWin(spareNow(), `Boolean(window.houseTest)`));
      const spareWin = spareNow();
      report(warmed && !spareWin.isVisible(), 'pointing at the button gets a window ready, out of sight');
      await sleep(800);
      report(spareWin && await inWin(spareWin, `houseTest.state.tabs.length`) === 0 && await page(`houseTest.windowInfo.count`) === 1, 'it has no tabs yet, and isn\'t counted as a window');
      const clickedAt = Date.now();
      await page(`document.querySelector('.tabs .tab .popout').click(); true`);
      const ghost = (w) => inWin(w, `(() => { const g = document.querySelector('.tab-ghost'); return g.hidden ? 'hidden' : [...g.classList].filter((c) => c !== 'tab-ghost').join(' ') + ' ' + g.style.width; })()`);
      const growing = await ghost(main);
      const popped = await waitFor(async () => extras().length === 1 && ready(extras()[0]));
      const files = extras()[0];
      report(popped, 'the button opens a new window');
      if (!popped) return;
      console.log(`INFO windows: from the click to its tab showing in the ready window: ${Date.now() - clickedAt} ms (checked every 200 ms)`);
      report(files === spareWin && !files.houseSpare, 'it\'s the window that was ready');
      report(/landing/.test(growing) && /\d+px$/.test(growing), `the tab's picture grows into the new window's shape (${growing})`);
      report(await waitFor(async () => await ghost(main) === 'hidden'), 'and goes once the window is on screen');
      const moved = await inWin(files, `(() => { const t = houseTest.state.tabs[0]; return [houseTest.state.tabs.length, t.kind, t.path, t.back.join('|')]; })()`);
      // The window starts on Home, so Back goes through Projects to Home.
      report(JSON.stringify(moved) === JSON.stringify([1, 'files', `${projects}/SampleApp`, `home:|${projects}`]), `it's a Files tab in the same folder, Back still works (${JSON.stringify(moved)})`);
      report(await inWin(files, `document.getElementById('splash').hidden`), 'it opens with no loading screen');
      report(await page(`houseTest.state.tabs.length`) === 1 && await buttons(main, 'popout') === 'false', 'the main window is left with one tab, and no "own window" button');
      report(await page(`houseTest.windowInfo.count`) === 2 && await inWin(files, `houseTest.windowInfo.count === 2 && !houseTest.windowInfo.main`), 'both windows know there are two');
      report(await buttons(files, 'popout') === 'false' && await buttons(files, 'bring-back') === 'true' && await buttons(files, 'close-tab') === 'true', 'its lone tab: no "own window", but "move back" and close');
      const picture = await files.webContents.capturePage(undefined, { stayHidden: true });
      fs.writeFileSync(path.join(OUT, 'windows-popped.png'), picture.toPNG());
      console.log('SHOT windows-popped');

      // Move back: the tab joins the main window, its window closes.
      await inWin(files, `document.querySelector('.tabs .tab .bring-back').click(); true`);
      report(await waitFor(async () => extras().length === 0 && await page(`houseTest.state.tabs.length`) === 2), '"move back" puts it in the main window and closes its own');
      report(await page(`houseTest.state.tabs[1].path === ${JSON.stringify(`${projects}/SampleApp`)} && houseTest.state.tabs[1].back.includes(${JSON.stringify(projects)})`), 'with its folder and Back list');
      report(await page(`houseTest.windowInfo.count`) === 1, 'the main window knows it\'s alone again');

      // Agents and House Rules pop out too.
      await page(`houseTest.openAgents(); true`);
      await sleep(400);
      await page(`houseTest.popOutTab(houseTest.state.tabs.find((t) => t.kind === 'agents'))`);
      const agents = await waitFor(async () => extras().length === 1 && ready(extras()[0])) ? extras()[0] : null;
      report(agents && await kinds(agents) === 'agents', 'the Agents page pops out');
      await page(`houseTest.showRules().then(() => true)`);
      await sleep(600);
      await page(`houseTest.popOutTab(houseTest.state.tabs.find((t) => t.kind === 'rules'))`);
      const rules = await waitFor(async () => extras().length === 2 && ready(extras().find((w) => w !== agents))) ? extras().find((w) => w !== agents) : null;
      report(rules && await kinds(rules) === 'rules', 'House Rules pops out');
      report(await page(`houseTest.state.tabs.map((t) => t.kind).join()`) === 'files,files', 'the main window keeps its Files tabs');
      if (!agents || !rules) return;

      // A terminal, history and all, through a window and back.
      await page(`houseTest.openTerminal({}).then(() => true)`);
      await sleep(1200);
      const termId = await page(`houseTest.state.active.termId`);
      await page(`window.house.call('termWrite', ${termId}, 'echo BEFORE-$((40+2))\\r').then(() => true)`);
      await sleep(600);
      await page(`houseTest.popOutTab(houseTest.state.active)`);
      const term = await waitFor(async () => extras().length === 3) ? extras().find((w) => w !== agents && w !== rules) : null;
      const screenText = (w) => inWin(w, `(() => { const t = houseTest.state.tabs.find((x) => x.kind === 'term'); if (!t) return ''; const b = t.live.term.buffer.active; let s = ''; for (let i = 0; i < b.length; i += 1) s += b.getLine(i).translateToString(true) + ' '; return s; })()`);
      report(term && await waitFor(async () => (await screenText(term)).includes('BEFORE-42')), 'a terminal pops out with what was on its screen');
      if (term) {
        await inWin(term, `window.house.call('termWrite', ${termId}, 'echo AFTER-$((40+2))\\r').then(() => true)`);
        report(await waitFor(async () => (await screenText(term)).includes('AFTER-42')), 'and keeps running there');
      }

      // Carried off the strip and let go over another window's tabs: it joins them, in the gap.
      await inWin(agents, `document.getElementById('new-tab').click(); true`);
      await sleep(600);
      pointer = await onTabs(main);
      await inWin(agents, `window.house.call('tabHover', true)`);
      await sleep(200);
      report(await page(`Boolean(document.querySelector('.tabs .tab-slot.open'))`), 'carried over the main window\'s tabs, a gap opens there');
      await inWin(agents, `houseTest.dropTab(houseTest.state.tabs.find((t) => t.kind === 'files'))`);
      report(await waitFor(async () => await kinds(agents) === 'agents' && await page(`houseTest.state.tabs.map((t) => t.kind).join()`) === 'files,files,files'), 'let go there, it joins the main window');
      report(await waitFor(() => page(`!document.querySelector('.tabs .tab-slot')`)), 'and the gap closes');

      // Let go anywhere else: a window of its own, right where its picture was held. No window was
      // got ready this time, so a new one opens.
      pointer = { x: 900, y: 500 };
      const before = extras().length;
      await page(`houseTest.dropTab(houseTest.state.tabs[2])`);
      const dropped = await waitFor(async () => extras().length === before + 1) ? extras().find((w) => ![agents, rules, term].includes(w)) : null;
      report(Boolean(dropped) && await ready(dropped), 'let go away from any tabs, it becomes a window of its own');
      if (dropped) {
        const inside = await inWin(dropped, `(() => { const r = document.querySelector('.app').getBoundingClientRect(); const f = window.outerWidth / window.innerWidth; return [Math.round(r.left * f), Math.round(r.top * f)]; })()`);
        const at = [dropped.getBounds().x + inside[0], dropped.getBounds().y + inside[1]];
        const zoom = main.webContents.getZoomFactor();
        const want = [Math.round(900 - 60 * zoom), Math.round(500 - 16 * zoom)];
        report(Math.abs(at[0] - want[0]) < 4 && Math.abs(at[1] - want[1]) < 4, `right where its picture was held (${at}, wanted ${want})`);
      }

      // A window with one tab, carried by it onto the main window's tabs: it shows just its tab
      // there, then they join and it closes.
      pointer = await onTabs(main);
      await inWin(agents, `window.houseFrame.barDrag.move({ clientX: 300, clientY: 20 }); true`);
      await sleep(300);
      await inWin(agents, `window.houseFrame.barDrag.move({ clientX: 302, clientY: 20 }); true`);
      await sleep(100);
      const docking = await ghost(agents);
      report(/chip/.test(docking) && /docking/.test(docking), `over the other tabs, just its tab shows under the pointer (${docking})`);
      await inWin(agents, `window.houseFrame.barDrag.end(); true`);
      report(await waitFor(async () => agents.isDestroyed() && (await page(`houseTest.state.tabs.map((t) => t.kind).join()`)).includes('agents')), 'a lone tab\'s window joins the tabs it\'s dropped on, and closes');

      // With other windows open, closing a window's last tab closes the window.
      await inWin(rules, `document.querySelector('.tabs .tab .close-tab').click(); true`);
      report(await waitFor(async () => rules.isDestroyed()), 'closing a window\'s last tab closes the window');
      if (dropped && !dropped.isDestroyed()) {
        await inWin(dropped, `document.querySelector('.tabs .tab .close-tab').click(); true`);
        await waitFor(async () => dropped.isDestroyed());
      }

      // Closing the main window leaves the other: it takes over, and Station 256 stays open.
      if (term && !term.isDestroyed()) {
        await page(`document.getElementById('win-close').click(); true`);
        report(await waitFor(async () => main.isDestroyed() && !term.isDestroyed()), 'closing the main window leaves the other open');
        report(await waitFor(() => inWin(term, `houseTest.windowInfo.main && houseTest.windowInfo.count === 1`)), 'which becomes the main window');
        report(await buttons(term, 'popout') === 'false' && await buttons(term, 'bring-back') === 'false', 'its lone tab: no "own window", no "move back"');
        report((await screenText(term)).includes('AFTER-42'), 'its terminal is still there');
        await inWin(term, `window.house.call('termKill', ${termId}).then(() => true)`);
      }
    } finally {
      screen.getCursorScreenPoint = realPoint;
    }
  },
  // The carried tab's picture in each of its shapes: carried, over another window's tabs, and
  // grown into the new window's shape where it was let go.
  async tabGhost({ page, shot }) {
    const report = (ok, label) => console.log(`${ok ? 'PASS' : 'FAIL'} tabGhost: ${label}`);
    await page(`houseTest.openTerminal({}).then(() => true)`);
    await sleep(1200);
    const termId = await page(`houseTest.state.active.termId`);
    await page(`window.house.call('termWrite', ${termId}, 'ls -la /\\r').then(() => true)`);
    await sleep(800);
    const box = (sel) => page(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(); })()`);
    await page(`houseTest.ghost.show(houseTest.state.active); houseTest.ghost.move(520, 330); true`);
    await sleep(400);
    report(await box('.tab-ghost') === '460,314,340,224', `carried, it's a small window held at the pointer (${await box('.tab-ghost')})`);
    await shot('ghost-carried');
    await page(`houseTest.ghost.el.classList.add('chip'); houseTest.ghost.move(560, 60); true`);
    await sleep(400);
    report(await box('.tab-ghost') === '500,44,200,34', `over other tabs, just a tab (${await box('.tab-ghost')})`);
    await shot('ghost-chip');
    await page(`houseTest.ghost.el.classList.remove('chip'); houseTest.ghost.move(520, 330); true`);
    await sleep(300);
    await page(`houseTest.ghost.land({ x: 460, y: 314, w: 700, h: 420 }); true`);
    await sleep(500);
    report(await box('.tab-ghost') === '460,314,700,420', `let go, it grows into the new window's shape (${await box('.tab-ghost')})`);
    await shot('ghost-landed');
    await page(`houseTest.ghost.hide(); true`);
    await sleep(400);
    report(await page(`houseTest.ghost.el.hidden`), 'then goes');
    await page(`window.house.call('termKill', ${termId}).then(() => true)`);
    await sleep(500);
  },
  // How soon a tab shows in a window of its own: one got ready while it was being carried, against
  // a new one. Never on screen here, so the time Windows takes to show a window isn't in either.
  async windowSpeed({ page }) {
    const { BrowserWindow } = require('electron');
    const report = (ok, label) => console.log(`${ok ? 'PASS' : 'FAIL'} windowSpeed: ${label}`);
    const others = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !/index\.html$/.test(w.webContents.getURL()) && !w.houseSpare);
    const shown = (w) => w.webContents.executeJavaScript(`Boolean(window.houseTest) && houseTest.state.tabs.length > 0`).catch(() => false);
    const timeIt = async () => {
      const start = Date.now();
      await page(`houseTest.popOutTab(houseTest.state.tabs[1]).then(() => true)`);
      while (Date.now() - start < 10000) {
        const [w] = others();
        if (w && await shown(w)) return { ms: Date.now() - start, w };
        await sleep(15);
      }
      return { ms: Infinity, w: others()[0] };
    };
    const twoTabs = async () => {
      await page(`document.getElementById('new-tab').click(); true`);
      await sleep(600);
    };
    await twoTabs();
    const cold = await timeIt();
    if (cold.w) await cold.w.webContents.executeJavaScript(`document.querySelector('.tabs .tab .bring-back').click(); true`);
    await sleep(1500);
    await page(`window.house.call('tabWarm').then(() => true)`);
    await sleep(2500); // as long as a tab is carried, or more
    const warm = await timeIt();
    report(warm.ms < cold.ms, `a window got ready shows its tab sooner: ${warm.ms} ms, against ${cold.ms} ms for a new one`);
  },
  // "All folders inside" search: the option is remembered, results stream into the normal list with
  // their folder shown, Open File Location works, and Esc, clearing the box or leaving ends it.
  async searchInside({ page, shot, sleep }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const home = process.env.HOME;
    const make = (file) => { fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true }); fs.writeFileSync(path.join(home, file), 'x'); };
    ['projects/Notes App/docs/Invoice 2025.pdf', 'projects/SampleApp/src/deep/invoice-notes.txt', 'Documents/invoice.txt', 'projects/SampleApp/node_modules/invoice.js', 'projects/.hidden/invoice.txt', 'Pictures/holiday.png'].forEach(make);
    await page(ONE_TAB_LEFT);
    await sleep(300);
    await page(`(() => { houseTest.navigate(houseTest.state.home); return true; })()`);
    await sleep(800);
    const rows = () => page(`[...document.querySelectorAll('#rows .row')].map((r) => r.querySelector('.name-text').textContent + ' | ' + (r.querySelector('.search-where')?.textContent || ''))`);
    const status = () => page(`[...document.querySelectorAll('#rows .search-status, #rows .empty')].map((r) => r.textContent)`);
    const type = (text) => page(`(() => { const box = document.getElementById('search'); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const pickScope = async (label) => {
      await page(`document.getElementById('search-scope').click()`);
      await sleep(150);
      return page(`(() => { const items = [...document.querySelectorAll('#menu:not([hidden]) .menu-item')]; const item = items.find((b) => b.textContent.trim() === ${JSON.stringify(label)}); if (item) item.click(); return items.map((b) => b.textContent.trim()); })()`);
    };
    // It starts with every folder inside, as Windows' File Explorer does. This folder's own filter sees
    // only what is directly in the folder.
    report((await page(`document.getElementById('search').placeholder`)).includes('folders inside'), 'search starts with every folder inside');
    await pickScope('This folder');
    await type('invoice');
    await sleep(500);
    report((await rows()).length === 0, 'This folder: only the folder\'s own items are filtered');
    await type('');
    const labels = await pickScope('All folders inside');
    report(labels.join() === 'This folder,All folders inside,Words inside files,By meaning (Jev),API Keys', `the search options menu: ${labels}`);
    report(await page(`window.house.call('searchScope')`) === 'deep', 'the choice is saved');
    report((await page(`document.getElementById('search').placeholder`)).includes('folders inside'), 'the box says what it searches');
    await type('invoice');
    await sleep(1000);
    const found = (await rows()).sort();
    console.log(`ROWS ${JSON.stringify(found)}`);
    report(found.length === 3 && found.some((r) => r === 'invoice.txt | Documents') && found.some((r) => r === 'Invoice 2025.pdf | projects/Notes App/docs') && found.some((r) => r === 'invoice-notes.txt | projects/SampleApp/src/deep'),
      'finds them in folders inside, not in node_modules or hidden folders, with their folder');
    await shot('search-inside');
    await type('invoice zzzq');
    await sleep(800);
    const none = await status();
    report(none.join().startsWith('No results in') && none.join().endsWith('or the folders inside it.'), `nothing found: ${none}`);
    await shot('search-inside-empty');
    await type('invoice');
    await sleep(800);
    // Open File Location: goes to the folder with the file picked, and the search ends.
    const menuLabels = await page(`(() => { const row = [...document.querySelectorAll('#rows .row')].find((r) => r.dataset.path.endsWith('invoice-notes.txt')); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })); return [...document.querySelectorAll('#menu:not([hidden]) .menu-item')].map((b) => b.textContent.trim()); })()`);
    report(menuLabels.includes('Open File Location'), `right-click on a result: ${menuLabels}`);
    await page(`[...document.querySelectorAll('#menu .menu-item')].find((b) => b.textContent.trim() === 'Open File Location').click()`);
    await sleep(800);
    const where = await page(`({ path: houseTest.state.active.path, search: document.getElementById('search').value, selected: [...houseTest.state.selected] })`);
    report(where.path.endsWith('projects/SampleApp/src/deep') && where.search === '' && where.selected.length === 1 && where.selected[0].endsWith('invoice-notes.txt'), `Open File Location: ${JSON.stringify(where)}`);
    // Esc leaves the search.
    await page(`(() => { houseTest.navigate(houseTest.state.home); return true; })()`);
    await sleep(600);
    await type('invoice');
    await sleep(800);
    await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    const after = await page(`({ search: document.getElementById('search').value, rows: document.querySelectorAll('#rows .row').length, status: document.querySelectorAll('#rows .search-status').length })`);
    report(after.search === '' && after.rows > 0 && after.status === 0, `Esc: back to the folder's list ${JSON.stringify(after)}`);
    // Navigating away leaves it too.
    await type('invoice');
    await sleep(800);
    await page(`(() => { houseTest.navigate(houseTest.state.projects); return true; })()`);
    await sleep(500);
    report((await page(`document.getElementById('search').value`)) === '' && (await page(`document.querySelectorAll('#rows .row .search-where').length`)) === 0, 'navigating clears the search');
    await pickScope('This folder');
    report(await page(`window.house.call('searchScope')`) === 'here', 'switching back is saved too');
    // "Words inside files": starts on Enter, finds text by its contents, leaves out binary, hidden,
    // node_modules and key-like files, and treats shell characters as plain text.
    const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true }); fs.writeFileSync(path.join(home, file), text); };
    write('Documents/book.txt', 'It is a truth universally acknowledged... Netherfield Park is let at last.');
    write('projects/SampleApp/src/notes.md', 'Mr Bingley of NETHERFIELD');
    write('Documents/blob.dat', Buffer.from('Netherfield\x00\x00binary'));
    write('projects/SampleApp/node_modules/dep.txt', 'Netherfield');
    write('projects/.hidden/h.txt', 'Netherfield');
    write('Documents/.dotfile.txt', 'Netherfield');
    write('Documents/passwords.txt', 'Netherfield');
    await page(`(() => { houseTest.navigate(houseTest.state.home); return true; })()`);
    await sleep(800);
    await pickScope('Words inside files');
    report(await page(`window.house.call('searchScope')`) === 'words', 'Words inside files: the choice is saved');
    report((await page(`document.getElementById('search').placeholder`)).includes('inside files'), 'Words inside files: the box says what it does');
    const enter = () => page(`document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
    await type('netherfield');
    await sleep(600);
    report((await page(`document.querySelectorAll('#rows .row .search-where').length`)) === 0, 'Words inside files: nothing searches until Enter');
    await enter();
    await sleep(1500);
    const inside = (await rows()).sort();
    console.log(`ROWS ${JSON.stringify(inside)}`);
    report(inside.length === 2 && inside[0] === 'book.txt | Documents' && inside[1] === 'notes.md | projects/SampleApp/src', 'Words inside files: finds the text files holding the word (any capitals), and not binary, hidden, node_modules or password files');
    await shot('search-words');
    await type('"; rm -rf ~ #');
    await enter();
    await sleep(1200);
    const odd = await status();
    report(odd.join().startsWith('No text file in') && fs.existsSync(path.join(home, 'Documents/book.txt')), `Words inside files: shell characters are plain text: ${odd}`);
    await type('-r -e netherfield');
    await enter();
    await sleep(1200);
    report((await rows()).length === 0, 'Words inside files: a query that looks like grep options is plain text too');
    await pickScope('This folder');
  },
  // "By meaning (Jev)": the key box, saving the key, Enter running it against a stand-in Jev server
  // (made here, at the address in HOUSE_JEV_URL; the real TypeSafe is never called), the progress
  // line, results with a closeness bar, and removing the key. Run with HOUSE_JEV_URL set.
  async searchMeaning({ page, shot, sleep }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const address = new URL(process.env.HOUSE_JEV_URL);
    const sent = [];
    let throttled = false;
    let broke = false; // answers as an account with no balance left
    const stand = require('http').createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        sent.push({ auth: request.headers.authorization, raw });
        setTimeout(() => {
          if (broke) { response.writeHead(402); response.end('Insufficient balance'); return; }
          if (!throttled) { throttled = true; response.writeHead(429, { 'retry-after': '1' }); response.end(); return; }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ answers: { fit: { noul: JSON.stringify(JSON.parse(raw).state).toLowerCase().includes('invoice') ? 0.85 : 0.03 } } }));
        }, 400);
      });
    });
    await new Promise((resolve) => stand.listen(Number(address.port), address.hostname, resolve));
    try {
      const home = process.env.HOME;
      const make = (file, text) => { fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true }); fs.writeFileSync(path.join(home, file), text); };
      make('Documents/March bill.txt', 'Invoice 114 for March work, total due 30 days');
      make('Documents/shopping.txt', 'milk and eggs');
      make('Documents/.env', 'TOKEN=hunter2');
      make('projects/SampleApp/notes.md', 'meeting notes about the invoice dispute');
      await page(ONE_TAB_LEFT);
      await sleep(300);
      await page(`(() => { houseTest.navigate(houseTest.state.home); return true; })()`);
      await sleep(800);
      const type = (text) => page(`(() => { const box = document.getElementById('search'); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      const enter = () => page(`document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
      const pickScope = async (label) => {
        await page(`document.getElementById('search-scope').click()`);
        await sleep(150);
        return page(`(() => { const items = [...document.querySelectorAll('#menu:not([hidden]) .menu-item')]; const item = items.find((b) => b.textContent.trim() === ${JSON.stringify(label)}); if (item) item.click(); return items.map((b) => b.textContent.trim()); })()`);
      };
      const labels = await pickScope('By meaning (Jev)');
      report(labels.join() === 'This folder,All folders inside,Words inside files,By meaning (Jev),API Keys', `the options menu without a key: ${labels}`);
      await sleep(300);
      const panel = await page(`(() => { const p = document.querySelector('.jev-panel'); return { shown: Boolean(p) && !p.hidden, text: p?.querySelector('p')?.textContent, field: p?.querySelector('input')?.type, buttons: [...(p?.querySelectorAll('button') || [])].map((b) => b.textContent) }; })()`);
      report(panel.shown && panel.field === 'password' && panel.text.startsWith('Search by meaning uses TypeSafe') && panel.buttons.includes('Save'), `the key box: ${JSON.stringify(panel)}`);
      await shot('search-meaning-key');
      await type('invoice');
      await enter();
      await sleep(300);
      report(sent.length === 0, 'Enter without a key sends nothing');
      await page(`(() => { const f = document.querySelector('.jev-field'); f.value = 'sk-standin-key'; document.querySelector('.jev-panel .btn.primary').click(); return true; })()`);
      await sleep(600);
      const keyState = await page(`window.house.call('jevKey')`);
      report(keyState === true, `the page only learns yes or no: ${JSON.stringify(keyState)}`);
      report(await page(`document.querySelector('.jev-field').value === '' && document.querySelector('.jev-panel').hidden`), 'the key box empties and closes');
      report(!fs.readFileSync(path.join(home, '.config', 'house', 'panel.json'), 'utf8').includes('sk-standin'), 'the key is not in panel.json');
      report((fs.statSync(path.join(home, '.config', 'house', 'jev-key')).mode & 0o777) === 0o600, 'the key file is private (600)');
      // Saving with a search typed runs it. Look at the progress line partway.
      await sleep(500);
      await shot('search-meaning-progress');
      const mid = await page(`document.querySelector('#rows .search-status')?.textContent`);
      report(/^(Searching by meaning… \d+ of \d+|TypeSafe asked for a short wait|Looking through)/.test(mid || ''), `progress line: ${mid}`);
      report(await page(`Boolean(document.querySelector('#rows .search-status .search-stop'))`), 'the progress line has Stop');
      await sleep(3500);
      const rows = await page(`[...document.querySelectorAll('#rows .row')].map((r) => r.querySelector('.name-text').textContent + ' | ' + (r.querySelector('.search-where')?.textContent || '') + ' | ' + Boolean(r.querySelector('.search-score i')))`);
      console.log(`ROWS ${JSON.stringify(rows)}`);
      report(rows.length === 2 && rows.every((r) => r.endsWith('true')) && rows.some((r) => r.startsWith('March bill.txt')) && rows.some((r) => r.startsWith('notes.md')), `close files shown with their folder and a closeness bar: ${JSON.stringify(rows)}`);
      report(await page(`document.querySelector('#rows .search-status') === null`), 'the progress line is gone when done');
      await shot('search-meaning');
      const all = sent.map((s) => s.raw).join('\n');
      report(sent.length > 0 && sent.every((s) => s.auth === 'Bearer sk-standin-key') && !all.includes('hunter2') && !all.includes('.env'), `${sent.length} requests, all with the key, none with the .env file`);
      // Typing more does not run another search by itself.
      const before = sent.length;
      await type('invoice march');
      await sleep(700);
      report(sent.length === before, 'typing does not send anything; only Enter does');
      // Stop ends it: the files not yet asked about never are.
      for (let i = 0; i < 30; i += 1) make(`Documents/letters/letter ${i}.txt`, `letter ${i}`);
      await type('invoice');
      await enter();
      await sleep(250);
      await page(`document.querySelector('#rows .search-stop').click()`);
      await sleep(1500);
      report(sent.length > before && sent.length <= before + 8, `Stop: ${sent.length - before} requests had gone out, and no more followed`);
      report(await page(`document.querySelector('#rows .search-stop') === null`), 'Stop: the progress line is gone');
      // So does the page loading again (as a live update does), and it doesn't start over after.
      await enter();
      await sleep(250);
      const atReload = sent.length;
      await page(`(() => { window.beforeReload = true; window.house.call('liveReload', houseTest.state.tabs.map(describeTab), 0); return true; })()`);
      await sleep(3000);
      report(await page(`window.beforeReload === undefined`) && sent.length === atReload, `loading the page again: ${sent.length - atReload} more requests`);
      // An empty balance: it says so once and goes back to the usual search by itself.
      broke = true;
      await type('invoice');
      await enter();
      await sleep(2000);
      const fell = await page(`[document.querySelector('.toast-text')?.textContent || '', document.getElementById('search').placeholder]`);
      report(/balance has run out/.test(fell[0]) && !/^Describe what/.test(fell[1]), `an empty balance says so and goes back to the usual search: ${JSON.stringify(fell)}`);
      broke = false;
      // Remove the key from the menu.
      await page(`document.getElementById('search').value = ''; document.getElementById('search').dispatchEvent(new Event('input', { bubbles: true }))`);
      await page(`document.getElementById('search-scope').click()`);
      await sleep(150);
      const removed = await page(`(() => { const item = [...document.querySelectorAll('#menu:not([hidden]) .menu-item')].find((b) => b.textContent.trim() === 'Remove Jev Key'); if (item) item.click(); return Boolean(item); })()`);
      await sleep(300);
      report(removed && await page(`window.house.call('jevKey')`) === false && !fs.existsSync(path.join(home, '.config', 'house', 'jev-key')), 'Remove Jev Key deletes the key');
      await pickScope('This folder');
    } finally {
      stand.close();
    }
  },
  // Big and awkward documents and pictures, and a folder of 2,000 pictures (shots-editors.js).
  ...require('./shots-editors'),
  // How soon and how smoothly a mouse wheel notch scrolls each page (shots-scroll.js).
  ...require('./shots-scroll'),
  // Every list with columns: sorting, resizing, alignment, long names, empty states (shots-tables.js).
  ...require('./shots-tables'),
};
Object.assign(SCENES, require("./github-scene")); // the GitHub scene, in its own file

Object.assign(SCENES, require('./preview-shots')); // One-click Preview
Object.assign(SCENES, require('./keys-scene')); // API Keys
Object.assign(SCENES, require('./cleanup-scene')); // Clean-up
Object.assign(SCENES, require('./selfheal-scene')); // self-recovery
Object.assign(SCENES, require('./rightclick-scene')); // Right-click everywhere
Object.assign(SCENES, require('./audit-scene')); // Release audit: demo files, real clicks, results on disk
Object.assign(SCENES, require('./ai-browser-scene')); // An AI in a room using the Web Browser
Object.assign(SCENES, require('./snap-layouts-scene')); // Tabs and windows side by side
Object.assign(SCENES, require('./tab-split-scene')); // Dragging a tab onto the page to split
Object.assign(SCENES, require('./tab-sleep-scene')); // Browser tabs out of sight sleep and wake at the same page
Object.assign(SCENES, require('./term-select-scene')); // Drag to highlight in a terminal
Object.assign(SCENES, require('./term-select-herdr')); // The same inside the real Herdr (run by hand)
Object.assign(SCENES, require('./files-split-scene')); // Two Files tabs side by side
Object.assign(SCENES, require('./folder-views-scene')); // Each folder keeps its own view and sort
Object.assign(SCENES, require('./ux-scene')); // The audit's smaller changes
Object.assign(SCENES, require('./llama-real-scene')); // Local AI with real models (run alone, see the file)

// The Schedules page and the runner, against a fake docker and a fake room (see
// stub-schedules/docker). Run: SHOT_HOME=/tmp/house-shots-cron SHOT_PATH=panel/test/stub-schedules
// HOUSE_SCHEDULE_TEST=1 HOUSE_SCHEDULE_UNIT=1500 HOUSE_SCHEDULE_LIMIT=2000 test/shotrun.sh schedules  (the runner program it starts is ended by the scene)
// Here "a minute" is 1.5 seconds and the time limit is 2 seconds. No real room is touched.
SCENES.schedules = async ({ page, shot, sleep }) => {
  const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
  const home = process.env.HOME;
  const fake = path.join(home, 'sched-fake');
  fs.mkdirSync(fake, { recursive: true });
  const room = path.join(home, '.local', 'bin', 'room');
  fs.writeFileSync(room, `#!/bin/bash\necho "$*" >> "${fake}/room.log"\n[ "$1" = open ] && touch "${fake}/up"\n[ "$1" = close ] && rm -f "${fake}/up"\necho "ok"\n`, { mode: 0o755 });
  const mode = (value) => fs.writeFileSync(path.join(fake, 'mode'), value);
  const call = (name, ...args) => page(`window.house.call(${JSON.stringify(name)}, ...${JSON.stringify(args)}).then((v) => v, (e) => ({ error: String(e.message || e) }))`);
  const waitFor = async (test, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(100); } return false; };
  const tasks = async () => (await call('schedulesList')).tasks;
  const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const logCount = (id) => { try { return fs.readdirSync(path.join(home, '.local', 'state', 'house', 'schedules', id)).filter((n) => n.endsWith('.log')).length; } catch { return 0; } };

  await page(`document.getElementById('schedules-btn').click(); true`);
  await sleep(500);
  report(await page(`document.querySelector('.sch-note')?.textContent`) === 'Tasks run whenever the Linux house is awake. A run missed while it was asleep is skipped.', 'the page says when tasks run');
  report(await page(`document.querySelector('.sch-empty') !== null`), 'an empty list says so');
  await shot('schedules-empty');

  // An every-minute task (only allowed in checks) fires by itself and logs.
  mode('quick');
  const list = await call('schedulesSave', { name: 'Nightly tests', project: 'SampleApp', kind: 'command', run: 'npm test', when: { mode: 'minutes', n: 1 } });
  const id = list.tasks[0].id;
  await call('schedulesSave', { name: 'Summary', projects: ['Notes App', 'SampleApp'], kind: 'ai', run: 'Write a short summary of what changed today.', when: { mode: 'weekdays', time: '17:30' } });
  report(await waitFor(async () => logCount(id) >= 2), `an every-minute task fired by itself (${logCount(id)} logs)`);
  report((await tasks())[0].last?.ok === true, 'its last result is a success');
  report(fs.readFileSync(path.join(fake, 'room.log'), 'utf8').includes('open SampleApp'), 'the room was started with "room open"');
  await sleep(300);
  await shot('schedules-list');

  // Overlap: a run slower than the schedule is never doubled.
  mode('slow');
  fs.rmSync(path.join(fake, 'exec.log'), { force: true });
  report(await waitFor(async () => (await tasks())[0].lastSkip, 8000), 'a slow run makes the next one skip ("still going")');
  await waitFor(async () => !(await tasks())[0].running, 8000);
  const slowLines = fs.readFileSync(path.join(fake, 'exec.log'), 'utf8').split('\n').filter(Boolean).length;
  report(slowLines >= 1 && slowLines <= 3, `only a few slow runs started, none doubled (${slowLines})`);

  // Pause and edit: nothing runs while paused, and editing plans the timer again.
  await call('schedulesEnable', id, false);
  await waitFor(async () => !(await tasks())[0].running, 8000);
  const before = logCount(id);
  await sleep(3500);
  report(logCount(id) === before, 'a paused task does not run');
  const edited = (await call('schedulesSave', { id, name: 'Nightly tests', project: 'SampleApp', kind: 'command', run: 'npm test', when: { mode: 'daily', time: '03:00' }, enabled: true })).tasks[0];
  report(/^(Today|Tomorrow) 3:00 AM$/.test(edited.nextLabel), `editing planned the next run: ${edited.nextLabel}`);

  // Time limit and Run now: a hung run is stopped, and its process is gone.
  mode('hang');
  fs.rmSync(path.join(fake, 'last.pid'), { force: true });
  await call('schedulesRun', id);
  await waitFor(async () => fs.existsSync(path.join(fake, 'last.pid')), 5000);
  const hungPid = Number(fs.readFileSync(path.join(fake, 'last.pid'), 'utf8'));
  report(pidAlive(hungPid), 'Run now started the run');
  report(await waitFor(async () => !(await tasks())[0].running, 10000), 'the time limit ended the hung run');
  const stopped = (await tasks())[0];
  report(stopped.last && !stopped.last.ok && stopped.last.note.includes('time limit'), `its result says why: ${stopped.last && stopped.last.note}`);
  report(!pidAlive(hungPid), 'no process was left behind');
  const output = await call('schedulesOutput', id);
  report(output.text.includes('Nightly tests') && output.text.includes('time limit'), 'View output has the run\'s log');

  await page(`[...document.querySelectorAll('.sch-btn')].find((b) => b.textContent === 'View output').click(); true`);
  await sleep(500);
  await shot('schedules-output');
  await page(`document.getElementById('dialog').close(); true`);

  // The form, with live "Next run".
  await page(`[...document.querySelectorAll('.btn')].find((b) => b.textContent === 'Add task').click(); true`);
  await sleep(500);
  await page(`(() => { const sel = [...document.querySelectorAll('.sch-dialog select')].find((s) => [...s.options].some((o) => o.value === 'cron')); sel.value = 'cron'; sel.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(500);
  const next = await page(`document.querySelector('.sch-next').textContent`);
  report(/^Next run: /.test(next), `the form shows the next run live: ${next}`);
  await sleep(500);
  await sleep(400);
  await shot('schedules-form');
  await page(`document.getElementById('dialog').close(); true`);

  // Delete asks first.
  await page(`[...document.querySelectorAll('.sch-btn')].filter((b) => b.textContent === 'Delete')[1].click(); true`);
  await sleep(400);
  report(await page(`document.querySelector('#dialog .dialog-title')?.textContent`) === 'Delete this task?', 'Delete asks first');
  await page(`document.getElementById('dialog').close(); true`);
  report((await tasks()).length === 2, 'cancelling the delete keeps the task');

  // Closing Station does not stop tasks: a runner of its own keeps firing, then ends when nothing is left.
  mode('quick');
  await call('schedulesSave', { id, name: 'Nightly tests', projects: ['SampleApp'], kind: 'command', run: 'npm test', when: { mode: 'minutes', n: 1 }, enabled: true });
  const runnerFile = path.join(home, '.local', 'state', 'house', 'schedules', 'runner.pid');
  await waitFor(async () => fs.existsSync(runnerFile), 5000);
  const runnerPid = Number(fs.readFileSync(runnerFile, 'utf8'));
  report(pidAlive(runnerPid) && fs.readFileSync(`/proc/${runnerPid}/comm`, 'utf8').trim() === 'house-schedules', 'the runner is a program of its own, with a name the keeper ignores');
  require('../lib/schedules').shutdown(); // Station closes
  const seen = logCount(id);
  report(await waitFor(async () => logCount(id) > seen + 1, 8000), 'the runner keeps firing after Station is closed');
  report(pidAlive(runnerPid), 'and it is still the same runner');
  for (const one of await tasks()) {
    await waitFor(async () => (await call('schedulesDelete', one.id)).error === undefined, 8000);
  }
  report(await waitFor(async () => !pidAlive(runnerPid), 8000), 'deleting every task lets the runner end by itself');
  if (pidAlive(runnerPid)) process.kill(runnerPid, 'SIGTERM'); // never leave one behind
};

async function run(win) {
  const page = (code) => win.webContents.executeJavaScript(code);
  // A window that is never shown only draws again while something is watching its frames.
  win.webContents.beginFrameSubscription(false, () => {});
  const shot = async (name) => {
    await sleep(300);
    // The window, and an open dialog too: a tall one can reach past the window's edge.
    const box = await page(`(() => {
      const boxes = [document.querySelector('.app').getBoundingClientRect()];
      const dialog = document.getElementById('dialog');
      if (dialog.open) boxes.push(dialog.getBoundingClientRect());
      const left = Math.max(0, Math.min(...boxes.map((b) => b.left)));
      const top = Math.max(0, Math.min(...boxes.map((b) => b.top)));
      const right = Math.min(window.innerWidth, Math.max(...boxes.map((b) => b.right)));
      const bottom = Math.min(window.innerHeight, Math.max(...boxes.map((b) => b.bottom)));
      const f = window.outerWidth / window.innerWidth;
      return { x: Math.round(left * f), y: Math.round(top * f), width: Math.round((right - left) * f), height: Math.round((bottom - top) * f) };
    })()`);
    const image = await win.webContents.capturePage(box, { stayHidden: true });
    fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
    console.log(`SHOT ${name}`);
  };
  try {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await sleep(3000);
    // HOUSE_SHOTS_SCENES=list: only says which scenes there are (test/allscenes.sh runs each alone).
    if (ONLY[0] === 'list') console.log(`INFO scenes ${Object.keys(SCENES).join(',')}`);
    for (const [name, scene] of Object.entries(SCENES)) {
      if (ONLY.length && !ONLY.includes(name)) continue;
      try {
        await scene({ page, shot, sleep, win });
      } catch (error) {
        console.log(`FAIL ${name}: ${error.message}`);
      }
    }
  } catch (error) {
    console.log(`FAIL shots: ${error.message}`);
  }
  console.log('DONE');
  require('electron').app.quit();
}

module.exports = { run };
