// Checks that the window's contents fit at every width and zoom. Never shows a window.
// Run with a throwaway HOME so it can't touch real settings. See fitrun.sh.
const fs = require('fs');
const path = require('path');

const OUT = process.env.HOUSE_FITTEST;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SURFACE = { w: 1920, h: 1020 };
const results = [];

function report(label, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
}

// Lists anything that spills past its bar or past the window's edge.
const FIT_CHECK = `(() => {
  fitAddress(); fitCommandbar(); // on screen a size change runs this, but a window that was never shown doesn't get that step
  const edge = document.querySelector('.app').getBoundingClientRect().right;
  const bad = [];
  for (const selector of ['.tabstrip', '.addressbar', '.address', '.commandbar', '.statusbar', '.main']) {
    const el = document.querySelector(selector);
    const spill = el.scrollWidth - el.clientWidth;
    if (spill > 1) bad.push(selector + ' +' + spill);
  }
  for (const selector of ['#win-close', '#toggle-system', '#view-icons']) {
    const over = document.querySelector(selector).getBoundingClientRect().right - edge;
    if (over > 1) bad.push(selector + ' +' + Math.round(over));
  }
  return bad;
})()`;

async function run(win) {
  const page = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await sleep(300);
    await win.webContents.capturePage(); // a window that was never shown hands back its last frame first
    await sleep(300);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
  };
  const physical = () => page(`(() => {
    const b = document.querySelector('.app').getBoundingClientRect();
    const f = window.outerWidth / window.innerWidth;
    return { x: b.left * f, y: b.top * f, w: b.width * f, h: b.height * f };
  })()`);

  try {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await sleep(2500);

    // The worst case: every optional toolbar button showing, with its longest label.
    await page(`document.getElementById('room-btn').hidden = false;
      document.getElementById('room-new-btn').hidden = false;
      document.getElementById('room-close-btn').hidden = false;
      document.getElementById('room-preview-btn').hidden = false;
      document.getElementById('room-preview-label').textContent = 'Open Preview';
      document.getElementById('copy-mini').hidden = false;
      document.getElementById('room-btn-label').textContent = 'Enter Room';
      document.getElementById('view-btn-label').textContent = 'Extra large';
      document.getElementById('lock-label').textContent = 'Unlocked';
      document.getElementById('lock-btn').classList.add('unlocked');
      document.getElementById('item-count').textContent = '1,024 items     12 items selected     4.5 MB';
      document.getElementById('house-note').textContent = '1 room open. Close it when you are done so the house can sleep.';
      true`);

    report('fits at 115% in a small window', (await page(FIT_CHECK)).length === 0, (await page(FIT_CHECK)).join(', '));
    await shot('1-as-reported');

    // Zooming a small window all the way up grows it to fit, and keeps it on screen.
    for (let step = 0; step < 7; step += 1) await page(`document.getElementById('zoom-in').click(); true`);
    await sleep(300);
    // A window that was never shown doesn't play animations, so jump each one to its end.
    await page(`document.querySelector('.app').getAnimations().forEach((a) => a.finish()); true`);
    const label = await page(`document.getElementById('zoom-level').textContent`);
    const grown = await physical();
    report('zoomed to 150%', label === '150%', label);
    report('window grew to its minimum for that zoom', grown.w >= 1133 && grown.h >= 728, JSON.stringify(grown));
    report('window stayed on screen', grown.x >= -1 && grown.y >= -1
      && grown.x + grown.w <= SURFACE.w + 1 && grown.y + grown.h <= SURFACE.h + 1);
    report('fits at 150%', (await page(FIT_CHECK)).length === 0, (await page(FIT_CHECK)).join(', '));
    await shot('2-max-zoom');

    // Every width from the minimum up, with the system panel closed and open.
    for (const system of [false, true]) {
      await page(`document.getElementById('system-pane').hidden = ${!system}; true`);
      const failures = [];
      for (let width = 560; width <= 1300; width += 10) {
        await page(`document.querySelector('.app').style.width = '${width}px'; true`);
        const bad = await page(FIT_CHECK);
        if (bad.length) failures.push(`${width}: ${bad.join(', ')}`);
      }
      report(`every width fits, system panel ${system ? 'open' : 'closed'}`, failures.length === 0, failures.slice(0, 12).join(' | '));
    }

    // Pictures at 100% zoom, placed so the whole window is on screen.
    await page(`document.getElementById('zoom-level').click();
      document.getElementById('system-pane').hidden = true; true`);
    await sleep(500);
    for (const [name, width] of [['3-narrowest', 560], ['4-medium', 800], ['5-wide', 1100]]) {
      await page(`(() => {
        const app = document.querySelector('.app');
        app.getAnimations().forEach((a) => a.finish());
        app.style.left = '40px';
        app.style.top = '40px';
        app.style.width = '${width}px';
        app.style.height = '560px';
        fitAddress();
        return app.getBoundingClientRect().width;
      })()`);
      await sleep(600);
      await shot(name);
    }
  } catch (error) {
    report('test ran to the end', false, error.message);
  }

  console.log(`RESULT ${results.filter(Boolean).length}/${results.length}`);
  require('electron').app.quit();
}

module.exports = { run };
