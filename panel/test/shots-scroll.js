// Scene for shots.js: scrollLag. Sends one real mouse wheel notch to a page and watches its scroller
// every animation frame, then reports (all in milliseconds, from the moment the wheel event was made):
//   first = until the scroller first moves, settle = until it last moves, fps = frames a second
//   while it moves, wait = how long the wheel event sat before the page's own code saw it.
// Also a burst of 20 notches for the frames a second of steady scrolling.
// Run with a throwaway HOME: SHOT_PATH=$PWD/test/stub test/shotrun.sh scrollLag
// SHOT_ARGS="--disable-smooth-scrolling" tries Chromium without its scroll animation.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);

// Records the scroller's position on every frame, and when the first wheel event reached the page.
const WATCH = (selector) => `(() => {
  const box = document.querySelector(${JSON.stringify(selector)});
  window.scrollWatch = { samples: [], wheelAt: 0, seenAt: 0, on: true };
  const watch = window.scrollWatch;
  window.addEventListener('wheel', (event) => {
    if (!watch.wheelAt) { watch.wheelAt = event.timeStamp; watch.seenAt = performance.now(); }
  }, { capture: true, passive: true });
  const tick = (now) => {
    if (!watch.on) return;
    watch.samples.push([now, box.scrollTop]);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

function numbers(watch) {
  const { samples, wheelAt, seenAt } = watch;
  if (!wheelAt) return { error: 'no wheel event reached the page' };
  const start = samples[0][1];
  const moved = samples.filter(([, top]) => top !== start);
  if (!moved.length) return { error: 'did not move' };
  // Each frame where the position changed from the frame before.
  const changes = samples.filter((item, index) => index && item[1] !== samples[index - 1][1]);
  const first = changes[0][0];
  const last = changes[changes.length - 1][0];
  const frames = samples.filter(([time]) => time >= first && time <= last).length;
  const span = Math.max(1, last - first);
  return {
    wait: Math.round(seenAt - wheelAt),
    first: Math.round(first - wheelAt),
    settle: Math.round(last - wheelAt),
    fps: changes.length > 1 ? Math.round((1000 * (frames - 1)) / span) : null,
    changes: changes.length,
    px: Math.round(Math.abs(samples[samples.length - 1][1] - start)),
  };
}

async function scrollLag({ page, sleep: wait, win }) {
  const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} scrollLag: ${text}`);
  const home = os.homedir();
  if (!home.startsWith('/tmp/')) return report(false, 'needs the throwaway HOME');
  const factor = await page('window.outerWidth / window.innerWidth');

  // One wheel notch (or a burst) over the middle of the scroller. deltaY -120 is down.
  const measure = async (label, selector, { burst = 0, down = -120 } = {}) => {
    const rect = await page(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, room: document.querySelector(${JSON.stringify(selector)}).scrollHeight - document.querySelector(${JSON.stringify(selector)}).clientHeight }; })()`);
    if (!rect || rect.room < 100) return report(false, `${label}: nothing to scroll (room ${rect && rect.room})`);
    const x = Math.round(rect.x * factor);
    const y = Math.round(rect.y * factor);
    await page(`document.querySelector(${JSON.stringify(selector)}).scrollTop = 0`);
    await wait(400);
    await page(WATCH(selector));
    await wait(200);
    const notches = burst || 1;
    for (let index = 0; index < notches; index += 1) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: down, canScroll: true });
      if (burst) await wait(30);
    }
    await wait(burst ? 1500 : 1200);
    const watch = await page(`(() => { window.scrollWatch.on = false; return window.scrollWatch; })()`);
    const got = numbers(watch);
    console.log(`INFO scrollLag ${burst ? 'burst' : 'notch'} ${label}: ${JSON.stringify(got)}`);
    report(!got.error, `${burst ? 'burst' : 'notch'} ${label}`);
  };
  const both = async (label, selector) => {
    await measure(label, selector);
    await measure(label, selector);
    await measure(label, selector, { burst: 20 });
    // The same notch while the page is kept busy: 50 ms of work every 100 ms, as thumbnails or a
    // refresh would. A wheel listener that can stop the scroll makes the scroll wait behind it.
    await page(`window.busyTimer = setInterval(() => { const end = performance.now() + 50; while (performance.now() < end); }, 100)`);
    await measure(`${label}-busy`, selector);
    await measure(`${label}-busy`, selector);
    await page(`clearInterval(window.busyTimer)`);
  };

  // Home
  await page(`(() => { document.getElementById('new-tab').click(); return true; })()`);
  await wait(1500);
  await both('home', '.home-view');

  // The 2,000-picture folder, in details and in extra large icons.
  const dir = path.join(home, 'Pictures', 'Two Thousand');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const small = path.join(dir, '.small.jpg');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=1280x960:d=1', '-frames:v', '1', '-q:v', '4', small);
  for (let index = 1; index <= 2000; index += 1) fs.linkSync(small, path.join(dir, `photo-${String(index).padStart(4, '0')}.jpg`));
  await page(`(() => { setViewMode('details'); houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
  await wait(2500);
  await both('folder2000-details', '#rows');
  await page(`(() => { setViewMode('xl'); return true; })()`);
  await wait(3000);
  await both('folder2000-xl', '#rows');
  await page(`(() => { setViewMode('details'); return true; })()`);

  // Scrolling the 2,000 folder to the bottom in steps must not change the list's total height
  // (rows that draw late would make the scrollbar and the ends jump).
  for (const view of ['details', 'xl', 'large', 'medium', 'small', 'list', 'tiles', 'content']) {
    await page(`(() => { setViewMode('${view}'); const r = document.getElementById('rows'); r.scrollTop = 0; r.scrollLeft = 0; return true; })()`);
    await wait(1500);
    const heights = await page(`(async () => {
      const r = document.getElementById('rows');
      const horizontal = r.scrollWidth - r.clientWidth > r.scrollHeight - r.clientHeight;
      const key = horizontal ? 'scrollWidth' : 'scrollHeight';
      const seen = [r[key]];
      const room = horizontal ? r.scrollWidth - r.clientWidth : r.scrollHeight - r.clientHeight;
      for (let at = 0; at <= room + 600; at += 600) {
        if (horizontal) r.scrollLeft = at; else r.scrollTop = at;
        await new Promise((done) => setTimeout(done, 80));
        seen.push(r[key]);
      }
      return { key, seen: [...new Set(seen)] };
    })()`);
    report(heights.seen.length === 1, `${view} total ${heights.key} stays put while scrolling to the end: ${JSON.stringify(heights.seen)}`);
  }
  await page(`(() => { setViewMode('details'); return true; })()`);

  // Ctrl and the wheel still step through the views (and plain wheel does not).
  {
    const rect = await page(`(() => { const r = document.getElementById('rows').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const at = { x: Math.round(rect.x * factor), y: Math.round(rect.y * factor), deltaX: 0, canScroll: true };
    const mode = () => page('houseTest.state.viewMode');
    const before = await mode();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control', modifiers: ['control'] });
    await wait(200);
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...at, deltaY: -120, modifiers: ['control'] });
    await wait(400);
    const after = await mode();
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
    await wait(200);
    report(before !== after, `Ctrl and the wheel change the view: ${before} to ${after}`);
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...at, deltaY: -120 });
    await wait(500);
    report((await mode()) === after, 'the wheel alone leaves the view as it is');
    // A touchpad pinch: Ctrl+wheel with no Ctrl key press at all. It changes the view too.
    {
      const first = await mode();
      for (let index = 0; index < 4; index += 1) {
        win.webContents.sendInputEvent({ type: 'mouseWheel', ...at, deltaY: 120, modifiers: ['control'] });
        await wait(200);
      }
      report((await mode()) !== first, `a pinch (Ctrl wheel, no key press) changes the view: ${first} to ${await mode()}`);
      await wait(700);
      const settled = await mode();
      win.webContents.sendInputEvent({ type: 'mouseWheel', ...at, deltaY: -120 });
      await wait(500);
      report((await mode()) === settled, 'after the pinch the plain wheel leaves the view alone');
    }
    await page(`(() => { setViewMode('details'); return true; })()`);
  }

  // The touchpad recorder: off without its flag file, and on (after a reload) it logs wheel events.
  {
    const flag = path.join(home, '.config', 'house', 'scroll-log-on');
    const log = path.join(home, '.local', 'state', 'house', 'scroll-log.jsonl');
    fs.rmSync(log, { force: true });
    fs.writeFileSync(flag, '');
    win.webContents.reload();
    await wait(4000);
    const rect = await page(`(() => { const r = document.querySelector('.home-view, #rows').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (let index = 0; index < 3; index += 1) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(rect.x * factor), y: Math.round(rect.y * factor), deltaX: 0, deltaY: -120, canScroll: true });
      await wait(100);
    }
    await wait(2500);
    const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    report(rows.length >= 3 && rows.every((row) => row.height > 0 && 'delay' in row && 'gap' in row), `the recorder logged ${rows.length} wheel events: ${JSON.stringify(rows[0])}`);
    fs.rmSync(flag, { force: true });
  }

  // A long text document.
  const docs = path.join(home, 'Documents', 'Scroll');
  fs.rmSync(docs, { recursive: true, force: true });
  fs.mkdirSync(docs, { recursive: true });
  const file = path.join(docs, 'long.txt');
  fs.writeFileSync(file, Array.from({ length: 20000 }, (_, index) => `line ${index + 1} of many words in this long document\n`).join(''));
  await page(`openDoc(${JSON.stringify(file)}).then(() => true)`);
  await wait(2500);
  await both('document', '.cm-scroller');
  await page(`(() => { if (houseTest.state.active.kind === 'doc') houseTest.closeTab(houseTest.state.active); return true; })()`);
}

// Replays the owner's real touchpad swipe (from scroll-log.jsonl: wheel steps of 1 to 4 notches, a
// frame apart) and reports how soon the list has moved 20 px and 100 px, and the biggest jump in one
// frame. SHOT_ARGS tries Chromium flags; a list scrolls on its own unless the page animates it.
const TRACE = [[1, 0], [1, 16], [2, 18], [1, 16], [2, 17], [2, 17], [4, 17], [2, 17], [1, 16], [2, 17], [2, 16], [1, 17], [1, 17], [1, 17], [1, 50]];

async function scrollTrace({ page, sleep: wait, win }) {
  const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} scrollTrace: ${text}`);
  const home = os.homedir();
  if (!home.startsWith('/tmp/')) return report(false, 'needs the throwaway HOME');
  const factor = await page('window.outerWidth / window.innerWidth');
  const dir = path.join(home, 'Documents', 'Trace');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (let index = 1; index <= 400; index += 1) fs.writeFileSync(path.join(dir, `file-${String(index).padStart(3, '0')}.txt`), 'x');
  await page(`(() => { setViewMode('details'); houseTest.navigate(${JSON.stringify(dir)}); return true; })()`);
  await wait(2000);
  const rect = await page(`(() => { const r = document.getElementById('rows').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  // Down from the top, then up from the bottom (the two edges the owner felt stuck at).
  for (const [name, down] of [['top down', true], ['top down', true], ['bottom up', false], ['bottom up', false]]) {
    await page(`(() => { const box = document.getElementById('rows'); box.scrollTop = ${down ? 0 : 'box.scrollHeight'}; return true; })()`);
    await wait(500);
    await page(WATCH('#rows'));
    await wait(200);
    for (const [notches, gap] of TRACE) {
      await wait(gap);
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(rect.x * factor), y: Math.round(rect.y * factor), deltaX: 0, deltaY: (down ? -120 : 120) * notches, canScroll: true });
    }
    await wait(1500);
    const watch = await page(`(() => { window.scrollWatch.on = false; return window.scrollWatch; })()`);
    const tops = watch.samples.map(([, top]) => (down ? top : -top)); // grows along the swipe
    const first = tops[0];
    const last = tops[tops.length - 1];
    const msWhen = (test) => { const hit = watch.samples.find((item, index) => test(tops[index])); return hit ? Math.round(hit[0] - watch.wheelAt) : null; };
    let back = 0;
    let jump = 0;
    tops.forEach((value, index) => {
      if (!index) return;
      back = Math.max(back, tops[index - 1] - value);
      jump = Math.max(jump, value - tops[index - 1]);
    });
    const info = { ms20: msWhen((value) => value - first >= 20), ms100: msWhen((value) => value - first >= 100), tail50: null, maxJump: Math.round(jump), pullBack: Math.round(back * 10) / 10 };
    const from = msWhen((value) => last - value <= 50);
    const to = msWhen((value) => last - value < 0.5);
    if (from !== null && to !== null) info.tail50 = to - from;
    console.log(`INFO scrollTrace ${name}: ${JSON.stringify(info)}`);
    report(back <= 0.5, `${name} never moves against the swipe (worst pull-back ${Math.round(back * 10) / 10} px)`);
  }

  // The recorded Wayland swipe (touchpad): [wheel step in px, ms since the one before]. Steps are
  // multiples of 8.89 px, one a frame, and some are whole notches (88.89) inside a fine swipe.
  const FINE = [[53.33, 0], [17.78, 16], [8.89, 15], [17.78, 17], [115.56, 17], [80, 10], [88.89, 17], [53.33, 18], [160, 16], [88.89, 17], [44.44, 17], [44.44, 17], [26.67, 17], [35.56, 17], [35.56, 18], [71.11, 16], [71.11, 17], [53.33, 17], [88.89, 17], [26.67, 17], [80, 17], [62.22, 17], [8.89, 17], [8.89, 17], [8.89, 17], [8.89, 17], [8.89, 17], [8.89, 17], [8.89, 17]];
  // One step as the page sees it, to learn how much page distance one unit of sendInputEvent makes.
  await page(`(() => { window.fineSeen = []; window.addEventListener('wheel', (event) => { window.fineSeen.push(event.deltaY);  }, { capture: true, passive: true }); return true; })()`);
  await page(`(() => { const box = document.getElementById('rows'); box.scrollTop = 5000; return true; })()`);
  await wait(300);
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(rect.x * factor), y: Math.round(rect.y * factor), deltaX: 0, deltaY: -120, canScroll: true });
  await wait(600);
  const perUnit = Math.abs((await page('window.fineSeen[0]')) || 0) / 120;
  report(perUnit > 0, `one wheel unit is ${Math.round(perUnit * 1000) / 1000} page px (devicePixelRatio ${await page('window.devicePixelRatio')})`);
  // Plays the swipe (sign: 1 down, -1 up) and checks the position after every step against the running total.
  const follow = async (name, start, sign) => {
    await page(`(() => { const box = document.getElementById('rows'); box.scrollTop = ${start}; window.fineSeen.length = 0; return true; })()`);
    await wait(500);
    const room = await page(`document.getElementById('rows').scrollHeight - document.getElementById('rows').clientHeight`);
    const begin = await page(`document.getElementById('rows').scrollTop`);
    const reads = [];
    for (const [dy, gap] of FINE) {
      await wait(gap);
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(rect.x * factor), y: Math.round(rect.y * factor), deltaX: 0, deltaY: (-sign * dy) / perUnit, canScroll: true });
      await wait(20);
      reads.push(await page(`[document.getElementById('rows').scrollTop, window.fineSeen.length]`));
    }
    const seen = await page('window.fineSeen');
    let total = begin;
    let counted = 0;
    let worst = 0;
    for (const [top, count] of reads) {
      for (; counted < count; counted += 1) total = Math.max(0, Math.min(room, total + seen[counted]));
      worst = Math.max(worst, Math.abs(top - total));
    }
    console.log(`INFO scrollTrace fine ${name}: worst gap ${Math.round(worst * 10) / 10} px over ${reads.length} steps`);
    report(worst <= 1, `fine ${name} follows the running total (worst gap ${Math.round(worst * 10) / 10} px)`);
  };
  await follow('down from the top', 0, 1);
  await follow('up into the top', 400, -1);
  await follow('up from the bottom', 1e6, -1);

  // No bounce: pushing past the top or bottom with the fine swipe stops exactly at the edge.
  {
    const send = (dy) => win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(rect.x * factor), y: Math.round(rect.y * factor), deltaX: 0, deltaY: -dy / perUnit, canScroll: true });
    const probe = `(() => { const box = document.getElementById('rows'); return [box.scrollTop, box.scrollHeight - box.clientHeight, getComputedStyle(box.querySelector(':scope > :not(.marquee)')).translate]; })()`;
    const edgeCheck = async (name, start, sign, edgeAt) => {
      await page(`(() => { document.getElementById('rows').scrollTop = ${start}; return true; })()`);
      await wait(800);
      let holds = true;
      let moved = false;
      for (const [dy, gap] of FINE) {
        await wait(gap);
        send(sign * dy);
        await wait(20);
        const [top, room, shift] = await page(probe);
        const at = edgeAt === 0 ? 0 : room;
        holds = holds && top >= 0 && top <= room + 0.5 && shift === 'none';
        moved = moved || Math.abs(top - at) < 1;
      }
      await wait(600);
      const [top, room, shift] = await page(probe);
      report(holds && moved && Math.abs(top - (edgeAt === 0 ? 0 : room)) < 1 && shift === 'none', `${name}: stops at the edge, no overshoot or spring back (top ${top}, room ${room}, translate ${shift})`);
    };
    await edgeCheck('pushing past the top', 0, -1, 0);
    await edgeCheck('pushing past the bottom', 1e6, 1, 1);
  }

  // A fine swipe right after an earlier fine one whose first step is a whole notch (88.89): the kind
  // carries over, so nothing glides and nothing is lost.
  {
    const START = [[88.89, 0], [26.67, 17], [35.56, 17], [17.78, 17], [8.89, 17], [44.44, 17], [8.89, 17], [8.89, 17]];
    await page(`(() => { document.getElementById('rows').scrollTop = 0; window.fineSeen.length = 0; return true; })()`);
    await wait(500);
    const room = await page(`document.getElementById('rows').scrollHeight - document.getElementById('rows').clientHeight`);
    const send = (dy) => win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(rect.x * factor), y: Math.round(rect.y * factor), deltaX: 0, deltaY: -dy / perUnit, canScroll: true });
    for (const [dy, gap] of FINE.slice(0, 8)) { await wait(gap); send(dy); }
    await wait(400);
    for (const [dy, gap] of START) { await wait(gap); send(dy); }
    await wait(1000);
    const seen = await page('window.fineSeen');
    const total = seen.reduce((sum, step) => Math.max(0, Math.min(room, sum + step)), 0);
    const top = await page(`document.getElementById('rows').scrollTop`);
    console.log(`INFO scrollTrace fine start: top ${Math.round(top * 10) / 10}, running total ${Math.round(total * 10) / 10}`);
    report(Math.abs(top - total) <= 1, `a fine swipe starting with a whole notch after another fine swipe loses nothing (top ${Math.round(top * 10) / 10}, total ${Math.round(total * 10) / 10})`);
  }
  report(true, 'replayed');
}

module.exports = { scrollLag, scrollTrace };
