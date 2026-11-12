// Release checks for the pages that open files, with big and awkward ones: documents (a 20 MB log,
// 200,000 lines, one 5 MB line, a binary file named .txt, text that isn't UTF-8), pictures (8000 x
// 6000, a 50 MB PNG, GIF, SVG, AVIF, a photo taken sideways) and a folder of 2,000 pictures. Every
// step says how long the main part ("main") and the page ("page") were stuck, in milliseconds.
// Scenes for shots.js, run by name with a throwaway HOME: stressDocs, stressPictures, stressThumbs,
// and pictureMore (the rest of the picture editor, on small files).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
const sizeOf = (file) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();

// The longest the main part's timer was late, and the page's longest "long task", since last asked.
async function meters(page) {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  await page(`(() => { if (!window.stressLong) { window.stressLong = []; new PerformanceObserver((list) => list.getEntries().forEach((entry) => stressLong.push(Math.round(entry.duration)))).observe({ type: 'longtask' }); } return true; })()`);
  return {
    async take() {
      await page(`new Promise((done) => requestAnimationFrame(() => setTimeout(done, 80)))`);
      const long = await page(`stressLong.splice(0)`);
      const main = Math.round(worst);
      worst = 0;
      last = performance.now();
      return { main, page: Math.max(0, ...long) };
    },
    stop: () => clearInterval(timer),
  };
}

async function until(page, test, ms = 20000) {
  const end = Date.now() + ms;
  let value = null;
  while (Date.now() < end) {
    value = await page(test);
    if (value) return value;
    await sleep(100);
  }
  return value;
}

function throwawayHome(report) {
  const home = os.homedir();
  if (home.startsWith('/tmp/')) return home;
  report(false, 'needs the throwaway HOME');
  return null;
}

async function stressDocs({ page }) {
  const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} stressDocs: ${text}`);
  const home = throwawayHome(report);
  if (!home) return;
  const dir = path.join(home, 'Documents', 'Stress');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const at = (name) => path.join(dir, name);
  const line = '2026-11-10 20:00:00 info something happened in the house, and it was written down\n';
  fs.writeFileSync(at('big.log'), line.repeat(Math.ceil((20 * 1024 * 1024) / line.length)));
  fs.writeFileSync(at('lines.txt'), Array.from({ length: 200000 }, (_, index) => `line ${index + 1} of many words\n`).join(''));
  fs.writeFileSync(at('oneline.txt'), 'words and more words '.repeat(Math.ceil((5 * 1024 * 1024) / 21)));
  fs.writeFileSync(at('oneline.json'), `{"numbers":[${'1234567,'.repeat(650000)}0]}`);
  fs.writeFileSync(at('notes.md'), '# A heading\n\nSome **bold** words and a [link](https://example.com).\n\n- a bullet\n'.repeat(24000));
  fs.writeFileSync(at('binary.txt'), crypto.randomBytes(1024 * 1024));
  fs.writeFileSync(at('late-binary.txt'), Buffer.concat([Buffer.from('plain words\n'.repeat(2000)), crypto.randomBytes(64 * 1024)]));
  const latin = Buffer.from('caf\xe9 na\xefve r\xe9sum\xe9\n'.repeat(500), 'latin1');
  fs.writeFileSync(at('latin1.txt'), latin);
  fs.writeFileSync(at('small.txt'), 'first\n');
  fs.writeFileSync(at('gone.txt'), 'here for now\n');

  const meter = await meters(page);
  await page(`(() => { houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
  await sleep(900);
  await meter.take();
  const open = async (name) => {
    const started = Date.now();
    const how = await page(`openDoc(${JSON.stringify(at(name))}).then((tab) => (tab ? 'page' : preview.hidden ? 'nothing' : 'preview'))`);
    const ms = Date.now() - started;
    const stuck = await meter.take();
    const said = await page(`(preview.hidden ? '' : (document.querySelector('#preview .preview-message, #preview .preview-note')?.textContent || 'text')) + ' | ' + (document.querySelector('.toast-text')?.textContent || '')`);
    return { how, ms, ...stuck, said };
  };
  const editor = 'houseTest.state.active.editor';
  const status = () => page(`houseTest.state.active.statusEl?.textContent || ''`);
  const close = async () => {
    await page(`(() => { if (!preview.hidden) closePreview(true); else if (houseTest.state.active.kind === 'doc') houseTest.closeTab(houseTest.state.active); return true; })()`);
    await sleep(300);
  };
  // Typed at the top, then the cursor sent to the very end, then saved by itself.
  const typeAndSave = async (name) => {
    await page(`(() => { const view = ${editor}.view; view.dispatch({ changes: { from: 0, insert: 'typed ' } }); view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true }); return true; })()`);
    const typing = await meter.take();
    const saved = await until(page, `houseTest.state.active.statusEl?.textContent === 'Saved'`, 15000);
    const saving = await meter.take();
    const handle = fs.openSync(at(name), 'r');
    const start = Buffer.alloc(6);
    fs.readSync(handle, start, 0, 6, 0);
    fs.closeSync(handle);
    return { typing, saving, saved: Boolean(saved) && start.toString() === 'typed ' };
  };
  const calm = (stuck) => stuck.main < 200 && stuck.page < 1000;

  const log = await open('big.log');
  report(log.how === 'preview' && /too big/.test(log.said) && calm(log), `a 20 MB log opens to look at, with a plain reason: ${JSON.stringify(log)}`);
  await close();

  for (const name of ['lines.txt', 'oneline.txt', 'oneline.json', 'notes.md']) {
    const opened = await open(name);
    const typed = opened.how === 'page' ? await typeAndSave(name) : null;
    const ok = opened.how === 'page' && calm(opened) && typed.saved && calm(typed.typing) && calm(typed.saving);
    report(ok, `${name} (${(fs.statSync(at(name)).size / 1048576).toFixed(1)} MB) opens, takes typing and saves: ${JSON.stringify({ opened, typed })}`);
    await close();
  }

  const binary = await open('binary.txt');
  report(binary.how === 'preview' && /can't show/.test(binary.said) && calm(binary), `a binary file named .txt isn't opened as text: ${JSON.stringify(binary)}`);
  await close();

  // Text that isn't UTF-8 would be saved back wrong, so it's read only and stays as it was.
  for (const name of ['latin1.txt', 'late-binary.txt']) {
    const before = fs.readFileSync(at(name));
    const opened = await open(name);
    const state = opened.how === 'page' ? await status() : '';
    if (opened.how === 'page') {
      await page(`(() => { const view = ${editor}.view; view.dispatch({ changes: { from: 0, insert: 'typed ' } }); return true; })()`);
      await sleep(1200);
    }
    await close();
    await sleep(400);
    const same = fs.readFileSync(at(name)).equals(before);
    report(same && (opened.how !== 'page' || state === 'Read only'), `${name} (not UTF-8) is never written back changed: ${JSON.stringify({ how: opened.how, state, same })}`);
  }

  // Closing straight after typing still saves it.
  await open('small.txt');
  await page(`(() => { const view = ${editor}.view; view.dispatch({ changes: { from: view.state.doc.length, insert: 'second\\n' } }); houseTest.closeTab(houseTest.state.active); return true; })()`);
  await sleep(700);
  report(fs.readFileSync(at('small.txt'), 'utf8') === 'first\nsecond\n', `closing a page straight after typing saves it: ${JSON.stringify(fs.readFileSync(at('small.txt'), 'utf8'))}`);

  // A Windows (CRLF) file: opening and closing leaves it alone; an edit keeps its line endings and BOM. An LF file stays LF.
  const sample = (ending, bom) => (bom ? '﻿' : '') + ['one', 'two', 'three'].join(ending) + ending;
  const edit = async (name, text) => {
    fs.writeFileSync(at(name), text);
    const before = fs.statSync(at(name));
    await open(name);
    await page(`(() => { const view = ${editor}.view; view.dispatch({ selection: { anchor: view.state.doc.length } }); houseTest.closeTab(houseTest.state.active); return true; })()`);
    await sleep(900);
    const untouched = fs.readFileSync(at(name), 'utf8') === text && fs.statSync(at(name)).mtimeMs === before.mtimeMs;
    await open(name);
    await page(`(() => { const view = ${editor}.view; view.dispatch({ changes: { from: 3, insert: 'X' } }); houseTest.closeTab(houseTest.state.active); return true; })()`);
    await sleep(900);
    return { untouched, after: fs.readFileSync(at(name), 'utf8') };
  };
  for (const [name, ending, bom] of [['win.txt', '\r\n', false], ['winbom.txt', '\r\n', true], ['unix.txt', '\n', false]]) {
    const text = sample(ending, bom);
    const result = await edit(name, text);
    report(result.untouched, `${name}: opening and closing without a change doesn't touch the file`);
    report(result.after === text.replace('one', 'oneX'), `${name}: an edit keeps its line endings${bom ? ' and BOM' : ''}: ${JSON.stringify(result.after)}`);
  }

  // The file deleted while it's open: the page says so.
  await open('gone.txt');
  fs.rmSync(at('gone.txt'));
  const told = await until(page, `(() => { const banner = document.querySelector('.doc-host:not([hidden]) .doc-banner'); return banner && !banner.hidden ? banner.textContent : ''; })()`, 6000);
  report(/moved or deleted/.test(told || ''), `a file deleted while open says so: ${JSON.stringify(told)}`);
  await close();
  meter.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function stressPictures({ page, win }) {
  const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} stressPictures: ${text}`);
  const home = throwawayHome(report);
  if (!home) return;
  const dir = path.join(home, 'Pictures', 'Stress');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const at = (name) => path.join(dir, name);
  ff('-f', 'lavfi', '-i', 'testsrc2=s=8000x6000:d=1', '-frames:v', '1', '-q:v', '3', at('huge.jpg'));
  fs.writeFileSync(at('noise.raw'), crypto.randomBytes(4200 * 4000 * 3));
  ff('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '4200x4000', '-i', at('noise.raw'), '-frames:v', '1', at('big.png'));
  fs.rmSync(at('noise.raw'));
  ff('-f', 'lavfi', '-i', 'testsrc2=s=320x200:d=1:r=5', at('moving.gif'));
  fs.writeFileSync(at('drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect width="100" height="60" fill="#2b7de9"/></svg>');
  let avif = true;
  try { ff('-f', 'lavfi', '-i', 'testsrc2=s=320x200:d=1', '-frames:v', '1', '-c:v', 'libsvtav1', at('photo.avif')); } catch { avif = false; }
  // A photo taken with the camera on its side: 400 x 200 stored, 200 x 400 as it should stand.
  ff('-f', 'lavfi', '-i', 'testsrc2=s=400x200:d=1', '-frames:v', '1', '-q:v', '2', at('flat.jpg'));
  const jpeg = fs.readFileSync(at('flat.jpg'));
  const tiff = Buffer.from('4d4d002a00000008' + '0001' + '011200030000000100060000' + '00000000', 'hex');
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255]), exif]);
  fs.writeFileSync(at('sideways.jpg'), Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
  fs.rmSync(at('flat.jpg'));

  const meter = await meters(page);
  await page(`(() => { houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
  await sleep(900);
  const entry = (file) => JSON.stringify({ path: file, name: path.basename(file), isDir: false, size: fs.statSync(file).size, mtime: fs.statSync(file).mtimeMs });
  const click = (selector, text) => page(`(() => { const found = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => ${text ? `node.textContent.trim() === ${JSON.stringify(text)}` : 'true'}); if (!found) return 'missing'; found.click(); return 'ok'; })()`);
  const startEdit = async (name) => {
    await page(`(() => { closePreview(true); houseTest.showPreview(${entry(at(name))}); return true; })()`);
    await sleep(300);
    await meter.take();
    const started = Date.now();
    if (await click('#preview .pe-edit-btn') !== 'ok') return { ready: false, button: false };
    const ready = Boolean(await until(page, `Boolean(pe && document.querySelector('#preview .pe-canvas'))`, 30000));
    return { ready, ms: Date.now() - started, ...await meter.take(), size: ready ? await page(`[pe.width, pe.height]`) : null };
  };
  const slide = (label, value) => page(`(() => { const slider = [...document.querySelectorAll('#preview .pe-slider')].find((row) => row.textContent.startsWith(${JSON.stringify(label)})).querySelector('input'); slider.value = '${value}'; slider.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const save = async (label) => {
    const started = Date.now();
    await click('#preview .pe-bar-btn', label);
    const done = Boolean(await until(page, `!pe`, 60000));
    return { done, ms: Date.now() - started, ...await meter.take() };
  };
  const calm = (stuck) => stuck.main < 200 && stuck.page < 1500;
  const memory = () => {
    const pid = win.webContents.getOSProcessId();
    const found = require('electron').app.getAppMetrics().find((item) => item.pid === pid);
    return found ? Math.round(found.memory.workingSetSize / 1024) : 0;
  };

  const held = [memory()];
  // 8000 x 6000: opening, sliders, drawing, and a copy at full size.
  const huge = await startEdit('huge.jpg');
  await click('#preview .pe-tabs .segment', 'Adjust');
  const slid = [];
  for (const value of [10, 25, 40]) {
    await slide('Brightness', value);
    await slide('Warmth', value);
    slid.push(await meter.take());
  }
  await click('#preview .pe-tabs .segment', 'Draw');
  await page(`(() => {
    const canvas = document.querySelector('#preview .pe-canvas');
    const box = canvas.getBoundingClientRect();
    const at = (fx, fy) => ({ clientX: box.left + box.width * fx, clientY: box.top + box.height * fy, bubbles: true, pointerId: 7, button: 0 });
    canvas.dispatchEvent(new PointerEvent('pointerdown', at(0.1, 0.1)));
    for (let step = 1; step <= 40; step += 1) canvas.dispatchEvent(new PointerEvent('pointermove', at(0.1 + step * 0.02, 0.1 + (step % 7) * 0.1)));
    canvas.dispatchEvent(new PointerEvent('pointerup', at(0.9, 0.5)));
    return true;
  })()`);
  const drew = await meter.take();
  const copied = await save('Save as Copy');
  const copy = at('huge (edited).jpg');
  const copySize = fs.existsSync(copy) ? sizeOf(copy) : 'none';
  report(huge.ready && calm(huge) && slid.every(calm) && calm(drew) && copied.done && calm(copied) && copySize === '8000,6000',
    `an 8000 x 6000 photo: opens, sliders, a pen line, a full-size copy: ${JSON.stringify({ huge, slid, drew, copied, copySize })}`);
  fs.rmSync(copy, { force: true });

  // A 50 MB PNG: turned, saved over, and put back.
  const bigBytes = fs.statSync(at('big.png')).size;
  const big = await startEdit('big.png');
  await click('#preview .pe-action', 'Turn right');
  const turned = await meter.take();
  const over = await save('Save');
  const after = sizeOf(at('big.png'));
  await meter.take();
  await page(`(() => { const button = [...document.querySelectorAll('.toast button')].find((node) => node.textContent === 'Undo'); button?.click(); return Boolean(button); })()`);
  await sleep(1500);
  const undo = await meter.take();
  report(big.ready && calm(big) && calm(turned) && over.done && calm(over) && after === '4000,4200' && fs.statSync(at('big.png')).size === bigBytes && calm(undo),
    `a ${Math.round(bigBytes / 1048576)} MB PNG: opens, turns, saves over, Undo puts it back: ${JSON.stringify({ big, turned, over, after, undo, back: fs.statSync(at('big.png')).size === bigBytes })}`);

  // A photo taken sideways stands up in the editor and in what's saved.
  const sideways = await startEdit('sideways.jpg');
  await click('#preview .pe-action', 'Flip across');
  const stood = await save('Save');
  const stoodSize = sizeOf(at('sideways.jpg'));
  report(JSON.stringify(sideways.size) === '[200,400]' && stood.done && stoodSize === '200,400', `a sideways photo stands up, edited and saved: ${JSON.stringify({ editor: sideways.size, saved: stoodSize })}`);

  // GIF and AVIF: a PNG copy only. SVG: no Edit.
  for (const name of ['moving.gif', ...(avif ? ['photo.avif'] : [])]) {
    const opened = await startEdit(name);
    const buttons = opened.ready ? await page(`[...document.querySelectorAll('#preview .pe-bar-btn')].filter((button) => !button.hidden).map((button) => button.textContent)`) : [];
    if (opened.ready) await click('#preview .pe-action', 'Turn left');
    const saved = opened.ready ? await save('Save as Copy') : { done: false };
    const png = at(`${path.basename(name, path.extname(name))} (edited).png`);
    report(opened.ready && JSON.stringify(buttons) === '["Cancel","Save as Copy"]' && saved.done && fs.existsSync(png) && sizeOf(png) === '200,320',
      `${name} saves as a PNG copy only: ${JSON.stringify({ ready: opened.ready, buttons, copy: fs.existsSync(png) && sizeOf(png) })}`);
  }
  if (!avif) report(false, 'no AVIF could be made here to try');
  const svg = await startEdit('drawing.svg');
  report(svg.button === false, 'an SVG has no Edit (it is a drawing, not pixels)');

  // Opened and closed many times: what the page holds mustn't keep growing.
  for (let round = 1; round <= 12; round += 1) {
    const opened = await startEdit('huge.jpg');
    if (!opened.ready) break;
    await click('#preview .pe-bar-btn', 'Cancel');
    await sleep(500);
    if (round === 2 || round === 7 || round === 12) held.push(memory());
  }
  await page(`(() => { closePreview(true); return true; })()`);
  await sleep(3000);
  held.push(memory());
  report(held.length === 5 && held[3] - held[1] < 400, `the editor opened and closed 12 times on the 8000 x 6000 photo; the page holds (MB at the start, after 2, 7, 12, and closed): ${JSON.stringify(held)}`);
  meter.stop();
  fs.rmSync(dir, { recursive: true, force: true }); // the big test pictures go as soon as it's done
}

async function stressThumbs({ page }) {
  const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} stressThumbs: ${text}`);
  const home = throwawayHome(report);
  if (!home) return;
  const dir = path.join(home, 'Pictures', 'Two Thousand');
  const cache = path.join(home, '.cache', 'house', 'thumbs');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // 1,900 small photos (shown as they are) and 100 over 1.5 MB (made small first). Hard links, so
  // 2,000 names cost the room of two files.
  const small = path.join(dir, '.small.jpg');
  const large = path.join(dir, '.large.jpg');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=1280x960:d=1', '-frames:v', '1', '-q:v', '4', small);
  ff('-f', 'lavfi', '-i', 'nullsrc=s=2400x1200,geq=random(1)*255:128:128', '-frames:v', '1', '-q:v', '1', large);
  for (let index = 1; index <= 2000; index += 1) fs.linkSync(index % 20 ? small : large, path.join(dir, `photo-${String(index).padStart(4, '0')}.jpg`));
  const made = () => (fs.existsSync(cache) ? fs.readdirSync(cache).filter((name) => name.endsWith('.webp')).length : 0);

  // How many ffmpegs run at once, looked at ten times a second.
  let most = 0;
  let now = 0;
  const watching = setInterval(() => execFile('pgrep', ['-c', '-P', String(process.pid), 'ffmpeg'], (_error, out) => {
    now = Number(String(out).trim()) || 0;
    most = Math.max(most, now);
  }), 100);

  const meter = await meters(page);
  await page(`(() => { setViewMode('xl'); return true; })()`);
  await sleep(500);
  await meter.take();
  const started = Date.now();
  await page(`(() => { houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
  const listed = await until(page, `document.querySelectorAll('#rows .tile').length === 2000`, 30000);
  const opened = { ms: Date.now() - started, ...await meter.take() };
  await sleep(2500);
  const first = await page(`[...document.querySelectorAll('#rows img.thumb')].filter((image) => image.complete && image.naturalWidth).length`);
  report(Boolean(listed) && opened.main < 200 && opened.page < 1500 && first < 400, `a folder of 2,000 pictures opens: ${JSON.stringify(opened)}; pictures loaded before any scrolling: ${first}`);

  // Scrolled down a screen at a time, then straight to the end.
  const scrolls = [];
  for (let step = 0; step < 12; step += 1) {
    await page(`(() => { const rows = document.getElementById('rows'); rows.scrollTop += rows.clientHeight * 3; return true; })()`);
    await sleep(250);
    scrolls.push(await meter.take());
  }
  await page(`(() => { const rows = document.getElementById('rows'); rows.scrollTop = rows.scrollHeight; return true; })()`);
  await sleep(500);
  scrolls.push(await meter.take());
  const worst = { main: Math.max(...scrolls.map((item) => item.main)), page: Math.max(...scrolls.map((item) => item.page)) };
  report(worst.main < 200 && worst.page < 500, `scrolling it: the longest the main part and the page were stuck: ${JSON.stringify(worst)}`);
  // Until the small pictures asked for are all made.
  for (let quiet = 0, tries = 0; quiet < 10 && tries < 900; tries += 1) {
    await sleep(100);
    quiet = now ? 0 : quiet + 1;
  }
  // Sixty big photos asked for in one go, as a fast scroll through a camera's folder would.
  await meter.take();
  const burst = Date.now();
  await page(`Promise.all(houseTest.state.entries.filter((entry, index) => (index + 1) % 20 === 0).slice(0, 60).map((entry) => new Promise((done) => {
    const image = new Image();
    image.onload = image.onerror = () => done(image.naturalWidth);
    image.src = thumbUrl(entry);
  }))).then((sizes) => sizes.filter(Boolean).length)`);
  const asked = { ms: Date.now() - burst, ...await meter.take() };
  for (let quiet = 0, tries = 0; quiet < 10 && tries < 900; tries += 1) {
    await sleep(100);
    quiet = now ? 0 : quiet + 1;
  }
  const after = made();
  report(most > 0 && most <= 3 && after >= 60 && after <= 100 && asked.main < 200 && asked.page < 500, `small pictures are made at most 3 at a time: ${most} at once, ${after} made, 60 asked for at once took ${JSON.stringify(asked)}`);

  // Coming back: nothing is made again.
  await page(`(() => { houseTest.navigate(${JSON.stringify(path.dirname(dir))}); return true; })()`);
  await sleep(600);
  most = 0;
  await meter.take();
  const again = Date.now();
  await page(`(() => { houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
  await until(page, `document.querySelectorAll('#rows .tile').length === 2000`, 30000);
  await page(`(() => { const rows = document.getElementById('rows'); rows.scrollTop = rows.scrollHeight; return true; })()`);
  await sleep(1500);
  const back = { ms: Date.now() - again, ...await meter.take() };
  report(made() === after && most === 0, `coming back makes none again: ${JSON.stringify({ made: made(), ffmpegs: most, ...back })}`);
  await page(`(() => { setViewMode('details'); return true; })()`);
  clearInterval(watching);
  meter.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

// The rest of the picture editor on a small picture: highlighter, box and words; a picture that
// can't be read; a folder that can't be written; and a video's preview.
async function pictureMore({ page }) {
  const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} pictureMore: ${text}`);
  const home = throwawayHome(report);
  if (!home) return;
  const dir = path.join(home, 'Pictures', 'More');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const at = (name) => path.join(dir, name);
  ff('-f', 'lavfi', '-i', 'testsrc2=s=400x300:d=1', '-frames:v', '1', at('photo.png'));
  ff('-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=2', '-pix_fmt', 'yuv420p', at('clip.mp4'));
  fs.writeFileSync(at('broken.jpg'), crypto.randomBytes(20000));
  await page(`(() => { houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
  await sleep(800);
  const entry = (file) => JSON.stringify({ path: file, name: path.basename(file), isDir: false, size: fs.statSync(file).size, mtime: fs.statSync(file).mtimeMs });
  const click = (selector, text) => page(`(() => { const found = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => ${text ? `node.textContent.trim() === ${JSON.stringify(text)}` : 'true'}); if (!found) return 'missing'; found.click(); return 'ok'; })()`);
  const show = async (name) => {
    await page(`(() => { closePreview(true); houseTest.showPreview(${entry(at(name))}); return true; })()`);
    await sleep(400);
  };
  const drag = (downOnly) => page(`(() => {
    const canvas = document.querySelector('#preview .pe-canvas');
    const box = canvas.getBoundingClientRect();
    const at = (fx, fy) => ({ clientX: box.left + box.width * fx, clientY: box.top + box.height * fy, bubbles: true, pointerId: 7, button: 0 });
    canvas.dispatchEvent(new PointerEvent('pointerdown', at(0.2, 0.3)));
    if (${downOnly}) return true;
    canvas.dispatchEvent(new PointerEvent('pointermove', at(0.6, 0.6)));
    canvas.dispatchEvent(new PointerEvent('pointerup', at(0.6, 0.6)));
    return true;
  })()`);

  await show('photo.png');
  await click('#preview .pe-edit-btn');
  await until(page, `Boolean(pe && document.querySelector('#preview .pe-canvas'))`);
  await click('#preview .pe-tabs .segment', 'Draw');
  for (const tool of ['Highlighter', 'Box']) {
    await click('#preview .pe-choice', tool);
    await drag(false);
  }
  await click('#preview .pe-choice', 'Words');
  await drag(true);
  await until(page, `document.getElementById('dialog').open`, 3000);
  await page(`(() => { const dialog = document.getElementById('dialog'); const input = dialog.querySelector('input, textarea'); input.value = 'Hello'; input.dispatchEvent(new Event('input', { bubbles: true })); dialog.querySelector('.btn.primary').click(); return true; })()`);
  await sleep(400);
  const marks = await page(`pe.marks.map((mark) => mark.type + (mark.text ? ':' + mark.text : ''))`);
  report(JSON.stringify(marks) === '["highlight","box","text:Hello"]', `highlighter, a box and words go on the picture: ${JSON.stringify(marks)}`);

  // Saving where nothing can be written says so, and the editor stays with the changes.
  fs.chmodSync(dir, 0o555);
  await click('#preview .pe-bar-btn', 'Save as Copy');
  const refused = await until(page, `(() => { const dialog = document.getElementById('dialog'); return dialog.open ? dialog.textContent : ''; })()`, 8000);
  await page(`(() => { document.querySelector('#dialog .btn.primary')?.click(); return true; })()`);
  await sleep(300);
  fs.chmodSync(dir, 0o755);
  const kept = await page(`Boolean(pe) && pe.marks.length === 3 && !pe.copyButton.disabled`);
  report(/didn't work/.test(refused || '') && kept && !fs.existsSync(at('photo (edited).png')), `a copy that can't be written says so, and the changes stay: ${JSON.stringify(refused)}`);
  await click('#preview .pe-bar-btn', 'Save as Copy');
  await until(page, `!pe`);
  await sleep(400);
  report(fs.existsSync(at('photo (edited).png')) && sizeOf(at('photo (edited).png')) === '400,300', 'then saving again works');

  // A picture that can't be read: the preview and Edit both say so.
  await show('broken.jpg');
  const shown = await until(page, `document.querySelector('#preview .preview-message')?.textContent || ''`, 5000);
  await click('#preview .pe-edit-btn');
  const said = await until(page, `[...document.querySelectorAll('.toast-text')].map((node) => node.textContent).find((text) => /couldn't be opened/.test(text)) || ''`, 5000);
  report(/couldn't be opened/.test(shown || '') && /couldn't be opened to edit/.test(said || '') && await page(`!pe`), `a broken picture says so: ${JSON.stringify([shown, said])}`);

  await show('clip.mp4');
  const video = await until(page, `(() => { const video = document.querySelector('#preview video'); return video && video.readyState >= 1 ? [video.videoWidth, video.videoHeight] : null; })()`, 8000);
  report(JSON.stringify(video) === '[320,240]', `a video's preview loads: ${JSON.stringify(video)}`);
  await page(`(() => { closePreview(true); return true; })()`);
}

// A photo saved from the editor keeps its details; a page that couldn't save asks before closing;
// small pictures for a folder that was left aren't made, and none is left running at quitting.
// Run by itself and last: its final step stops the small-picture maker, as quitting does.
async function keepAndClose({ page }) {
  const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} keepAndClose: ${text}`);
  const home = throwawayHome(report);
  if (!home) return;
  const dir = path.join(home, 'Pictures', 'Keep');
  const cache = path.join(home, '.cache', 'house', 'thumbs');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'Many'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Quit'), { recursive: true });
  const at = (name) => path.join(dir, name);
  // A photo as a camera writes it: taken sideways, with its maker and the time it was taken.
  const tiff = Buffer.alloc(78);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(3, 8);
  [[0x010f, 2, 8, 50], [0x0112, 3, 1, 6 << 16], [0x0132, 2, 20, 58]].forEach(([tag, type, count, value], index) => {
    const entry = 10 + index * 12;
    tiff.writeUInt16BE(tag, entry);
    tiff.writeUInt16BE(type, entry + 2);
    tiff.writeUInt32BE(count, entry + 4);
    tiff.writeUInt32BE(value, entry + 8);
  });
  tiff.write('TestCam\0', 50, 'latin1');
  tiff.write('2024:05:17 10:30:00\0', 58, 'latin1');
  const withExif = (body) => {
    const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), body]);
    return Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255]), exif]);
  };
  ff('-f', 'lavfi', '-i', 'testsrc2=s=400x200:d=1', '-frames:v', '1', '-q:v', '2', at('flat.jpg'));
  const jpeg = fs.readFileSync(at('flat.jpg'));
  fs.rmSync(at('flat.jpg'));
  fs.writeFileSync(at('camera.jpg'), Buffer.concat([jpeg.subarray(0, 2), withExif(tiff), jpeg.subarray(2)]));
  fs.writeFileSync(at('odd.jpg'), Buffer.concat([jpeg.subarray(0, 2), withExif(Buffer.from('MM\0\x2a\0\0\xff\xff 2024:05:17 nonsense', 'latin1')), jpeg.subarray(2)]));
  // What a saved file says: its Exif part read back by hand, and what ffprobe makes of it.
  const details = (file) => {
    const bytes = fs.readFileSync(file);
    const from = bytes.indexOf(Buffer.from('Exif\0\0', 'latin1'));
    let probe = '';
    try { probe = execFileSync('ffprobe', ['-v', 'error', '-show_frames', '-of', 'json', file]).toString(); } catch { /* said below */ }
    const out = { size: sizeOf(file), exif: from > 0, date: bytes.includes('2024:05:17 10:30:00'), maker: bytes.includes('TestCam'), ffprobeDate: probe.includes('2024:05:17 10:30:00') };
    if (from > 0) {
      const body = bytes.subarray(from + 6);
      const list = body.readUInt32BE(4);
      for (let index = 0; index < body.readUInt16BE(list); index += 1) if (body.readUInt16BE(list + 2 + index * 12) === 0x0112) out.turn = body.readUInt16BE(list + 10 + index * 12);
    }
    return out;
  };

  await page(`(() => { houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
  await sleep(800);
  const entry = (file) => JSON.stringify({ path: file, name: path.basename(file), isDir: false, size: fs.statSync(file).size, mtime: fs.statSync(file).mtimeMs });
  const click = (selector, text) => page(`(() => { const found = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => ${text ? `node.textContent.trim() === ${JSON.stringify(text)}` : 'true'}); if (!found) return 'missing'; found.click(); return 'ok'; })()`);
  const edit = async (name, save) => {
    await page(`(() => { closePreview(true); houseTest.showPreview(${entry(at(name))}); return true; })()`);
    await sleep(400);
    await click('#preview .pe-edit-btn');
    await until(page, `Boolean(pe && document.querySelector('#preview .pe-canvas'))`);
    await click('#preview .pe-action', 'Flip across');
    await click('#preview .pe-bar-btn', save);
    await until(page, `!pe`);
    await sleep(500);
  };
  const stands = (file) => page(`new Promise((done) => { const image = new Image(); image.onload = () => done([image.naturalWidth, image.naturalHeight]); image.onerror = () => done(null); image.src = fileUrl(${JSON.stringify(file)}) + '?again=' + Date.now(); })`);

  await edit('camera.jpg', 'Save as Copy');
  const copy = details(at('camera (edited).jpg'));
  await edit('camera.jpg', 'Save');
  const over = details(at('camera.jpg'));
  const shown = await stands(at('camera.jpg'));
  const good = (said) => said.size === '200,400' && said.exif && said.date && said.maker && said.turn === 1;
  report(good(copy) && good(over) && JSON.stringify(shown) === '[200,400]', `a photo saved (copy, and over itself) keeps its date and camera, standing up once: ${JSON.stringify({ copy, over, shown })}`);
  await edit('odd.jpg', 'Save');
  const odd = details(at('odd.jpg'));
  report(odd.size === '400,200' && !odd.exif, `a photo whose details are muddled still saves, without them: ${JSON.stringify(odd)}`);
  await page(`(() => { closePreview(true); return true; })()`);

  // A page that couldn't save asks before it closes.
  const docs = path.join(home, 'Documents', 'Keep');
  fs.rmSync(docs, { recursive: true, force: true });
  fs.mkdirSync(docs, { recursive: true });
  const type = `(() => { const view = houseTest.state.active.editor.view; view.dispatch({ changes: { from: 0, insert: 'mine ' } }); houseTest.closeTab(houseTest.state.active); return true; })()`;
  const asked = () => until(page, `(() => { const dialog = document.getElementById('dialog'); return dialog.open && dialog.textContent.includes('Close without saving?'); })()`, 5000);
  const openTabs = () => page(`houseTest.state.tabs.filter((tab) => tab.kind === 'doc').length`);
  const theirs = path.join(docs, 'theirs.txt');
  fs.writeFileSync(theirs, 'first\n');
  await page(`openDoc(${JSON.stringify(theirs)}).then(() => true)`);
  fs.writeFileSync(theirs, 'changed outside\n');
  fs.utimesSync(theirs, new Date(), new Date(Date.now() + 5000));
  await page(type);
  const askedOnce = await asked();
  await page(`(() => { document.querySelector('#dialog .btn:not(.danger)').click(); return true; })()`);
  await sleep(400);
  const stayed = await openTabs();
  await page(`(() => { houseTest.closeTab(houseTest.state.tabs.find((tab) => tab.kind === 'doc')); return true; })()`);
  const askedTwice = await asked();
  await page(`(() => { document.querySelector('#dialog .btn.danger').click(); return true; })()`);
  await sleep(500);
  report(askedOnce && stayed === 1 && askedTwice && await openTabs() === 0 && fs.readFileSync(theirs, 'utf8') === 'changed outside\n',
    `changed outside and here, then closed: it asks; Cancel keeps the page, Close closes it, their text is kept: ${JSON.stringify([askedOnce, stayed, askedTwice, fs.readFileSync(theirs, 'utf8')])}`);
  const locked = path.join(docs, 'locked.txt');
  fs.writeFileSync(locked, 'first\n');
  await page(`openDoc(${JSON.stringify(locked)}).then(() => true)`);
  fs.chmodSync(locked, 0o444);
  await page(type);
  const askedLocked = await asked();
  await page(`(() => { document.querySelector('#dialog .btn.danger')?.click(); return true; })()`);
  await sleep(400);
  fs.chmodSync(locked, 0o644);
  report(askedLocked && await openTabs() === 0, `a save the disk refuses asks before closing too: ${askedLocked}`);
  const plain = path.join(docs, 'plain.txt');
  fs.writeFileSync(plain, 'first\n');
  await page(`openDoc(${JSON.stringify(plain)}).then(() => true)`);
  await page(type);
  await sleep(800);
  report(await openTabs() === 0 && fs.readFileSync(plain, 'utf8') === 'mine first\n' && !await page(`document.getElementById('dialog').open`), 'a page that saves closes without asking');

  // Forty big photos asked for, then the folder is left: the ones still waiting aren't made.
  const large = at('.large.jpg');
  ff('-f', 'lavfi', '-i', 'nullsrc=s=2400x1200,geq=random(1)*255:128:128', '-frames:v', '1', '-q:v', '1', large);
  for (const folder of ['Many', 'Quit']) for (let index = 1; index <= 40; index += 1) fs.linkSync(large, path.join(dir, folder, `photo-${String(index).padStart(2, '0')}.jpg`));
  const cached = (ending) => (fs.existsSync(cache) ? fs.readdirSync(cache).filter((name) => name.endsWith(ending)).length : 0);
  const ffmpegs = () => new Promise((done) => execFile('pgrep', ['-c', '-P', String(process.pid), 'ffmpeg'], (_error, out) => done(Number(String(out).trim()) || 0)));
  const quiet = async () => { for (let calm = 0, tries = 0; calm < 8 && tries < 600; tries += 1) { await sleep(100); calm = await ffmpegs() ? 0 : calm + 1; } };
  const askAll = `(() => { window.stressAsked = Promise.all(houseTest.state.entries.map((entry) => new Promise((done) => { const image = new Image(); image.onload = image.onerror = () => done(image.naturalWidth > 0); image.src = thumbUrl(entry); }))); return houseTest.state.entries.length; })()`;
  const go = async (folder) => {
    await page(`(() => { houseTest.navigate(${JSON.stringify(folder)}); return true; })()`);
    await until(page, `(() => { const first = houseTest.state.entries[0]; return Boolean(first) && first.path.slice(0, first.path.lastIndexOf('/')) === ${JSON.stringify(folder)}; })()`, 5000);
  };
  await go(path.join(dir, 'Many'));
  const count = await page(askAll);
  await sleep(500);
  const madeBefore = cached('.webp');
  const left = Date.now();
  await go(dir);
  const answered = await page(`stressAsked.then((all) => all.filter(Boolean).length)`);
  const settled = Date.now() - left;
  await quiet();
  const afterLeaving = cached('.webp');
  // How many get made in that half second depends on the computer's speed; what matters is that after
  // leaving, nothing more is made than the 3 already running (lib/thumbs.js AT_ONCE).
  report(count === 40 && afterLeaving < count && afterLeaving <= madeBefore + 3 && cached('.none') === 0 && settled < 3000, `40 big photos asked for, the folder left half a second on: ${madeBefore} made before leaving, ${afterLeaving} in the end (${answered} answered with a picture), the rest let go ${settled} ms after leaving`);
  await go(path.join(dir, 'Many'));
  await page(askAll);
  const again = await page(`stressAsked.then((all) => all.filter(Boolean).length)`);
  report(again === 40 && cached('.webp') === 40 && cached('.none') === 0, `back in the folder, all 40 get their picture: ${again}`);

  // Quitting: none left running, and none marked as "can't be made".
  await go(path.join(dir, 'Quit'));
  await page(askAll);
  await sleep(400);
  const running = await ffmpegs();
  require('../lib/thumbs').cancelAll();
  await sleep(500);
  const still = await ffmpegs();
  report(running > 0 && still === 0 && cached('.none') === 0 && cached('.webp') < 80, `at quitting, the ${running} ffmpeg running are stopped: ${still} left, ${cached('.webp') - 40} of the 40 made, none marked unmakeable`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(docs, { recursive: true, force: true });
}

module.exports = { stressDocs, stressPictures, stressThumbs, pictureMore, keepAndClose };
