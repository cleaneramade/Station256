'use strict';
// The self-recovery scene: a mistake in the main process is logged and the app keeps running, a
// rejected promise is only logged, and a damaged panel.json is set aside when read.
// Run: see the shotrun.sh line in the notes, scene name "selfheal".
const fs = require('fs');
const path = require('path');

module.exports = {
  async selfheal({ page, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} selfheal: ${text}`);
    // What goes to stderr (panel.log) is caught here for a moment.
    const written = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return real(chunk, ...rest); };
    try {
      setTimeout(() => { throw new Error('selfheal test error'); }, 0);
      Promise.reject(new Error('selfheal test rejection'));
      await sleep(500);
    } finally {
      process.stderr.write = real;
    }
    const text = written.join('');
    report(text.includes('[station] error: Error: selfheal test error'), 'an uncaught error is logged with the [station] error: prefix and a stack');
    report(text.includes('[station] unhandled rejection: Error: selfheal test rejection'), 'an unhandled rejection is logged');
    report(await page(`Boolean(window.houseTest) && document.body.children.length > 0`).catch(() => false) === true, 'the app is still alive after the error');

    // A file that is damaged after start-up is set aside by readSettings, once.
    const file = path.join(process.env.HOME, '.config', 'house', 'panel.json');
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{"zoomLevel": 1, "wind');
    await page(`window.house.call('prefs').then(() => true)`);
    const dir = path.dirname(file);
    const copies = fs.readdirSync(dir).filter((n) => n.startsWith('panel.json.broken-'));
    report(copies.length === 1 && !fs.existsSync(file), 'a damaged panel.json is set aside when read, not left to be written over');
    fs.writeFileSync(file, good); // the scenes after this one expect the usual settings
    await sleep(200);

    // A page that freezes is noticed when it doesn't answer a key, then started again by itself.
    process.env.HOUSE_HANG_WAIT_MS = '2000'; // read each time; 20 s normally
    const contents = win.webContents;
    let frozenAt = 0;
    let goneReason = '';
    const onFrozen = () => { frozenAt = frozenAt || Date.now(); };
    const onGone = (_event, details) => { goneReason = details.reason; };
    win.on('unresponsive', onFrozen);
    contents.on('render-process-gone', onGone);
    const logged = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { logged.push(String(chunk)); return realWrite(chunk, ...rest); };
    try {
      await page(`(setTimeout(() => { const t = Date.now(); while (Date.now() - t < 120000) {} }, 50), true)`);
      await sleep(300);
      // Keys it can't answer: Chromium's hang check only starts once input is waiting.
      for (let i = 0; i < 60 && !goneReason; i += 1) {
        if (!contents.isDestroyed() && !frozenAt) {
          contents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' });
          contents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
        }
        await sleep(1000);
      }
      for (let i = 0; i < 40; i += 1) {
        if (await Promise.race([page('Boolean(window.houseTest) && 2'), sleep(1000).then(() => 0)]).catch(() => 0) === 2) break;
        await sleep(500);
      }
    } finally {
      process.stderr.write = realWrite;
      win.removeListener('unresponsive', onFrozen);
      contents.removeListener('render-process-gone', onGone);
      delete process.env.HOUSE_HANG_WAIT_MS;
    }
    report(frozenAt > 0, 'a frozen page is noticed');
    report(goneReason === 'killed' || goneReason === 'crashed', `the frozen page is ended (${goneReason || 'it was not'})`);
    report(logged.join('').includes('[station] a page stayed frozen'), 'and that goes in the log');
    report(await Promise.race([page('Boolean(window.houseTest) && 2'), sleep(3000).then(() => 0)]).catch(() => 0) === 2, 'the page is back and answering');
    await sleep(2000); // let it settle before the next scene
  },
};
