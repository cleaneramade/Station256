// The pictures in the README (docs/screenshots/), taken in the hidden copy with made-up projects and
// made-up files only: nothing here comes from a real project or a real PC. Run:
//   SHOT_PROJECTS="Weather App,Portfolio Site,Budget Tracker,Recipe Box,Garden Planner" \
//   SHOT_PATH=$PWD/panel/test/stub panel/test/shotrun.sh gallery
// The pictures land in $SHOT_HOME/out. Look at every one before it goes in the repo.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY = 86400000;

// A plain PNG from a function of (x, y) -> [r, g, b].
function png(width, height, color) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const [r, g, b] = color(x, y); const at = y * (width * 3 + 1) + 1 + x * 3; rows[at] = r; rows[at + 1] = g; rows[at + 2] = b; }
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const sunrise = (x, y) => (y < 200 ? mix([255, 183, 120], [250, 110, 130], y / 200) : mix([60, 70, 130], [20, 30, 70], (y - 200) / 200));
const ocean = (x, y) => mix([70, 160, 220], [10, 60, 130], y / 400 + Math.sin(x / 40) * 0.06);
const meadow = (x, y) => mix([150, 210, 130], [40, 120, 80], (x / 640 + y / 400) / 2);
const dusk = (x, y) => mix([120, 90, 190], [250, 150, 110], x / 640 + Math.cos(y / 50) * 0.05);

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f8fb;color:#1c2430}
header{display:flex;align-items:center;gap:14px;padding:18px 40px;background:#fff;border-bottom:1px solid #e3e8ef}
header b{font-size:20px}header span{color:#6b7787}
main{max-width:920px;margin:38px auto;padding:0 28px}
h1{font-size:38px;margin:0 0 8px}p.lead{font-size:19px;color:#4a5668;margin:0 0 28px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.card{background:#fff;border:1px solid #e3e8ef;border-radius:14px;padding:20px}
.card h3{margin:0 0 6px}.temp{font-size:44px;font-weight:700}
button{margin-top:26px;padding:12px 22px;border:0;border-radius:10px;background:#2b6cf6;color:#fff;font-size:16px;font-weight:600}
</style>${body}`;
const PAGES = {
  '/forecast': PAGE('Weather App', '<header><b>Weather App</b><span>Seven-day forecast</span></header><main><h1>Sunny with light wind</h1><p class="lead">Your week at a glance, updated every hour.</p><div class="cards"><div class="card"><h3>Today</h3><div class="temp">24°</div><p>Clear skies</p></div><div class="card"><h3>Tomorrow</h3><div class="temp">22°</div><p>Light clouds</p></div><div class="card"><h3>Friday</h3><div class="temp">19°</div><p>Scattered showers</p></div></div><button id="go">Add a city</button></main>'),
  '/portfolio': PAGE('Portfolio Site', '<header><b>Portfolio</b><span>Selected work</span></header><main><h1>Hello, I build things for the web</h1><p class="lead">A few projects I am proud of.</p><div class="cards"><div class="card"><h3>Budget Tracker</h3><p>Spending, simply.</p></div><div class="card"><h3>Recipe Box</h3><p>Cook from what you have.</p></div><div class="card"><h3>Garden Planner</h3><p>Plant at the right time.</p></div></div><button>Get in touch</button></main>'),
};

module.exports = {
  async gallery({ page, shot, win }) {
    const home = os.homedir();
    if (!home.startsWith('/tmp/')) { console.log('FAIL gallery: needs the throwaway HOME'); return; }
    const state = path.join(home, '.local', 'state', 'house');
    const projects = path.join(home, 'projects');
    const now = Date.now();
    const dayKey = (time) => new Date(time).toLocaleDateString('en-CA');

    // ---- made-up project files
    const app = path.join(projects, 'Weather App');
    const put = (file, content, ago = 0) => {
      const target = path.join(app, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      const at = new Date(now - ago);
      fs.utimesSync(target, at, at);
    };
    put('README.md', '# Weather App\n\nA small forecast app.\n\n## Features\n\n| Feature | Status |\n| --- | --- |\n| Seven-day forecast | Done |\n| Saved cities | In progress |\n| Rain alerts | Planned |\n', 60000);
    put('package.json', '{\n  "name": "weather-app",\n  "version": "0.3.0",\n  "scripts": { "dev": "vite", "build": "vite build" }\n}\n', 3600000);
    put('src/index.html', '<!doctype html>\n<title>Weather App</title>\n<div id="app"></div>\n', 900000);
    put('src/app.js', "import { forecast } from './api.js';\n\nexport async function render(city) {\n  const week = await forecast(city);\n  return week.map((day) => `${day.name}: ${day.high}°`).join('\\n');\n}\n", 240000);
    put('src/api.js', "export const forecast = (city) => fetch(`/api/forecast?city=${city}`).then((r) => r.json());\n", 1800000);
    put('src/styles.css', 'body { font-family: system-ui; background: #f6f8fb; }\n.card { border-radius: 14px; padding: 20px; }\n', 420000);
    put('docs/design.md', '# Design notes\n\nKeep it calm. One screen, one forecast.\n', 7200000);
    put('assets/sunrise.png', png(640, 400, sunrise), 5400000);
    put('assets/ocean.png', png(640, 400, ocean), 5400000);
    put('assets/meadow.png', png(640, 400, meadow), 5400000);
    put('assets/dusk.png', png(640, 400, dusk), 5400000);
    // A file's time matches the AI's note about it, so no file looks changed by a person: Home would name
    // the owner (the real Windows account) beside it.
    const OLD = 60 * DAY;
    const others = { 'Portfolio Site': [['index.html', 3 * 3600000], ['about.html', 5 * 3600000], ['styles.css', 4 * 3600000]], 'Budget Tracker': [['app.py', 26 * 3600000], ['README.md', 27 * 3600000]], 'Recipe Box': [['recipes.json', OLD]], 'Garden Planner': [['plan.md', OLD]] };
    for (const [name, files] of Object.entries(others)) {
      for (const [file, ago] of files) { const target = path.join(projects, name, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'x'); fs.utimesSync(target, new Date(now - ago), new Date(now - ago)); }
    }
    [['Portfolio Site', 3 * 3600000], ['Budget Tracker', 26 * 3600000], ['Recipe Box', 4 * DAY], ['Garden Planner', 9 * DAY]].forEach(([name, ago]) => { const at = new Date(now - ago); fs.utimesSync(path.join(projects, name), at, at); });

    // ---- what the AI did: notes per room (Home's streak, recent files, "Last edited by") and token counts
    const note = (file, ago, model = 'claude-opus-5-5', tool = 'claude') => JSON.stringify({ time: now - ago, path: `/workspace/${file}`, tool, model, action: 'edit' });
    const room = (id, lines) => { fs.mkdirSync(path.join(state, 'edits', id), { recursive: true }); fs.writeFileSync(path.join(state, 'edits', id, 'edits.jsonl'), `${lines.join('\n')}\n`); };
    room('Weather.App', [
      note('README.md', 60000), note('src/app.js', 240000), note('src/styles.css', 420000, 'claude-sonnet-5-5'), note('src/index.html', 900000),
      note('src/api.js', 1800000), note('package.json', 3600000, 'claude-sonnet-5-5'), note('docs/design.md', 7200000),
      note('assets/sunrise.png', 5400000), note('assets/ocean.png', 5400000), note('assets/meadow.png', 5400000), note('assets/dusk.png', 5400000),
      ...[1, 2, 3, 4, 5].map((d) => note('README.md', d * DAY + 3600000)),
    ]);
    room('Portfolio.Site', [note('index.html', 3 * 3600000, 'claude-sonnet-5-5'), note('styles.css', 4 * 3600000, 'claude-sonnet-5-5'), note('about.html', 5 * 3600000, 'claude-sonnet-5-5')]);
    room('Budget.Tracker', [note('app.py', 26 * 3600000), note('README.md', 27 * 3600000)]);
    const today = dayKey(now);
    const daysBack = (n) => dayKey(now - n * DAY);
    const record = (days, touch) => ({ offset: 1, ids: [], days, touch });
    fs.writeFileSync(path.join(state, 'token-counts.json'), JSON.stringify({
      sources: {
        'room:Weather.App': { files: { a: record({ [today]: [96000000, 820000], [daysBack(1)]: [210000000, 1900000], [daysBack(2)]: [140000000, 1100000], [daysBack(3)]: [180000000, 1500000], [daysBack(4)]: [120000000, 900000], [daysBack(5)]: [90000000, 700000] }, {
          '/workspace/README.md': [now - 60000, 'claude-opus-5-5', 8200000, 40000], '/workspace/src/app.js': [now - 240000, 'claude-opus-5-5', 15400000, 90000], '/workspace/src/styles.css': [now - 420000, 'claude-sonnet-5-5', 2300000, 30000], '/workspace/src/api.js': [now - 1800000, 'claude-opus-5-5', 4100000, 22000],
        }) } },
        'room:Portfolio.Site': { files: { a: record({ [today]: [38000000, 300000] }, { '/workspace/index.html': [now - 3 * 3600000, 'claude-sonnet-5-5', 6100000, 51000] }) } },
        'room:Budget.Tracker': { files: { a: record({ [daysBack(1)]: [52000000, 410000] }, { '/workspace/app.py': [now - 26 * 3600000, 'claude-opus-5-5', 9800000, 77000] }) } },
      },
    }));

    await page(`(async () => { await houseTest.refreshStatus?.(); return true; })()`).catch(() => {});
    await sleep(500);
    const counts = fs.readFileSync(path.join(state, 'token-counts.json'), 'utf8');
    const seedCounts = () => fs.writeFileSync(path.join(state, 'token-counts.json'), counts);

    // ---- 1. Home
    seedCounts();
    await page(`(async () => { await houseTest.navigate('home:'); return true; })()`);
    await sleep(3000);
    await page(`(() => { houseTest.state.status = { ...houseTest.state.status, rooms: [{ name: 'Weather App' }, { name: 'Portfolio Site' }] }; drawHome(); return true; })()`);
    await sleep(500);
    await shot('01-home');

    // ---- 2. A project's files, with who last edited each and its tokens
    seedCounts();
    await page(`(async () => { houseTest.state.viewMode = 'details'; await houseTest.navigate(${JSON.stringify(projects)}); await houseTest.navigate(${JSON.stringify(app)}); return true; })()`);
    await sleep(1800);
    await page(`(() => { const row = [...document.querySelectorAll('#rows .row-grid')].find((r) => r.querySelector('.name-text')?.textContent === 'README.md'); if (row) row.click(); return true; })()`);
    await sleep(500);
    await page(`(() => { for (const crumb of [...document.querySelectorAll('#address .crumb')]) if (/^house-shots/.test(crumb.textContent)) { crumb.nextElementSibling?.remove(); crumb.remove(); } return true; })()`);
    await shot('02-files');

    // ---- 3. Pictures as thumbnails
    await page(`(() => { houseTest.navigate(${JSON.stringify(path.join(app, 'assets'))}); houseTest.state.viewMode = 'xl'; houseTest.loadFolder(); return true; })()`);
    await sleep(2500);
    await shot('03-thumbnails');
    await page(`(() => { houseTest.state.viewMode = 'details'; return true; })()`);

    // ---- 4. Quick preview of a picture
    await page(`(async () => { await houseTest.navigate(${JSON.stringify(path.join(app, 'assets'))}); houseTest.showPreview({ path: ${JSON.stringify(path.join(app, 'assets', 'sunrise.png'))}, name: 'sunrise.png', isDir: false, size: 20000, mtime: Date.now() }); return true; })()`);
    await sleep(1500);
    await shot('04-quick-preview');
    await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(400);

    // ---- 5. House rules
    page(`houseTest.showRules(); true`);
    await sleep(1500);
    await shot('05-house-rules');
    await page(`document.querySelector('.rules-done')?.click(); true`);
    await sleep(500);

    // ---- 6. A project's right-click menu: everything for a project in one place
    await page(`(async () => { await houseTest.navigate('home:'); return true; })()`);
    await sleep(2500);
    await page(`(() => { houseTest.state.status = { ...houseTest.state.status, rooms: [{ name: 'Weather App' }] }; drawHome(); document.getElementById('home-view').scrollTop = 330; const c = document.querySelector('.home-card[data-project="Weather App"]'); const b = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 60, clientY: b.top + 40 })); return true; })()`);
    await sleep(1200);
    await shot('06-project-menu');
    await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(400);

    // ---- 7. Search in every folder at once
    for (const file of ['Weather App/docs/forecast-notes.md', 'Portfolio Site/forecast-widget.html', 'Budget Tracker/forecast.py', 'Recipe Box/notes/forecast-ideas.txt', 'Garden Planner/forecast.md']) {
      const target = path.join(projects, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'x\n');
    }
    for (const file of ['Weather App/docs/forecast-notes.md', 'Portfolio Site/forecast-widget.html', 'Budget Tracker/forecast.py', 'Recipe Box/notes/forecast-ideas.txt', 'Garden Planner/forecast.md']) fs.utimesSync(path.join(projects, file), new Date(now - OLD), new Date(now - OLD));
    await page(`(async () => { await houseTest.navigate(${JSON.stringify(projects)}); return true; })()`);
    await sleep(900);
    await page(`(() => { const box = document.getElementById('search'); box.value = 'forecast'; box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(2500);
    await page(`(() => { for (const crumb of [...document.querySelectorAll('#address .crumb')]) if (/^(tmp|house-shots)/.test(crumb.textContent)) { crumb.nextElementSibling?.remove(); crumb.remove(); } return true; })()`);
    await shot('07-search');
    await page(`(() => { const box = document.getElementById('search'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(600);

    // ---- 8. A document with a table, in the built-in editor
    const readme = path.join(app, 'README.md');
    const entryOf = (file) => JSON.stringify({ path: file, name: path.basename(file), isDir: false, size: fs.statSync(file).size, mtime: fs.statSync(file).mtimeMs });
    await page(`(async () => { await houseTest.navigate(${JSON.stringify(app)}); openFile(${entryOf(readme)}); return true; })()`);
    await sleep(3000);
    await shot('08-documents');

    // ---- 9. The picture editor
    await page(`(async () => { await houseTest.navigate(${JSON.stringify(path.join(app, 'assets'))}); houseTest.showPreview(${entryOf(path.join(app, 'assets', 'ocean.png'))}); return true; })()`);
    await sleep(600);
    await page(`document.querySelector('#preview .pe-edit-btn')?.click(); true`);
    await sleep(2500);
    await shot('09-picture-editor');
    await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(500);

    // ---- 10. The video editor
    const clips = path.join(home, 'Videos', 'Summer Trip');
    fs.mkdirSync(clips, { recursive: true });
    const clip = path.join(clips, 'beach.mp4');
    require('child_process').execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'gradients=s=1280x720:d=6:r=30:c0=0x1d4ed8:c1=0xf97316:c2=0xfde68a:c3=0x0ea5e9', '-f', 'lavfi', '-i', 'sine=f=330:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
    await page(`(async () => { await houseTest.navigate(${JSON.stringify(clips)}); openFile(${entryOf(clip)}); return true; })()`);
    for (let i = 0; i < 40; i += 1) { if (await page(`state.active?.kind === 'video' && state.active.video.readyState >= 1`)) break; await sleep(250); }
    await page(`state.active?.host?.querySelector('.vt-editor')?.click(); true`);
    for (let i = 0; i < 40; i += 1) { if (await page(`state.active?.kind === 'editor'`)) break; await sleep(250); }
    await sleep(9000);
    await shot('10-video-editor');
    await page(`(() => { for (const t of [...state.tabs]) if (t.kind === 'editor' || t.kind === 'video') houseTest.closeTab(t); return true; })()`);
    await sleep(800);
    await page(`(async () => { await houseTest.navigate('home:'); return true; })()`);
    await sleep(600);

    // ---- 11. The web browser: start page, AI at work, split view
    const server = await new Promise((resolve) => {
      const made = http.createServer((request, response) => { const body = PAGES[request.url]; response.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html' }); response.end(body || 'nope'); });
      made.listen(0, '127.0.0.1', () => resolve(made));
    });
    const base = `http://localhost:${server.address().port}`;
    await page(`(async () => { await houseTest.ready(); houseTest.bookmarks().push(
      { url: 'https://github.com', title: 'GitHub' }, { url: 'https://duckduckgo.com', title: 'DuckDuckGo' }, { url: 'https://en.wikipedia.org', title: 'Wikipedia' }, { url: 'https://developer.mozilla.org', title: 'MDN Web Docs' }, { url: 'https://nodejs.org', title: 'Node.js' }, { url: 'https://www.python.org', title: 'Python' });
      houseTest.history().push({ url: 'https://developer.mozilla.org/docs/Web/CSS', title: 'CSS: Cascading Style Sheets', at: Date.now() - 600000 }, { url: 'https://nodejs.org/api', title: 'Node.js documentation', at: Date.now() - 3600000 }, { url: 'https://github.com/trending', title: 'Trending repositories', at: Date.now() - 7200000 });
      houseTest.openObscura(); return true; })()`);
    await sleep(1200);
    await shot('11-browser-start');
    await page(`(() => { houseTest.showObscuraList(houseTest.state.active, 'bookmarks'); return true; })()`);
    await sleep(600);
    await shot('12-browser-bookmarks');
    await page(`(() => { houseTest.showObscuraList(houseTest.state.active, 'bookmarks'); return true; })()`);

    await page(`(() => { houseTest.openInObscura('${base}/forecast'); return true; })()`);
    await sleep(2500);
    const spot = await page(`(async () => { const t = houseTest.state.active; const r = JSON.parse(await t.view.executeJavaScript('JSON.stringify(document.getElementById("go").getBoundingClientRect())')); const f = (t.zoom * houseTest.pageScale()) / houseTest.hostZoom(); return [Math.round((r.left + r.width / 2) * f), Math.round((r.top + r.height / 2) * f)]; })()`);
    await page(`(() => { const t = houseTest.state.active; t.aiOf = 'Weather App'; houseTest.aiAtWork(t, 'Claude is using this page', 'clicking'); houseTest.aiGlide(t, ${JSON.stringify(spot)}, 'click'); return true; })()`);
    await sleep(900);
    await shot('13-browser-ai-at-work');
    await page(`(() => { const t = houseTest.state.active; houseTest.aiResting(t); t.aiOf = null; return true; })()`);

    await page(`(() => { houseTest.openInObscura('${base}/portfolio'); return true; })()`);
    await sleep(2500);
    await page(`(() => { const tabs = houseTest.state.tabs.filter((x) => x.kind === 'obscura'); const a = tabs.find((x) => x.url.endsWith('/portfolio')); const b = tabs.find((x) => x.url.endsWith('/forecast')); houseTest.mergeObscuraTabs(a, b, 'right'); return true; })()`);
    await sleep(1500);
    await shot('14-browser-split');

    server.close();
  },
};
