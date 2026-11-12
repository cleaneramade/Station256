// Small helpers shared by the audit scenes (audit-scene.js and the audit-*.js files next to it).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
const probe = (file, extra = []) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...extra, file]).toString());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);

// A fresh demo folder inside the throwaway HOME: never a real one.
function demoHome(name = 'Audit') {
  const home = os.homedir();
  if (!home.startsWith('/tmp/house-shots')) throw new Error('needs the throwaway HOME');
  const dir = path.join(home, 'Documents', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return { home, dir, at: (file) => path.join(dir, file) };
}

// Asks the page until the test gives something true (or the time is up).
const until = async (page, test, ms = 8000) => {
  const end = Date.now() + ms;
  let value = null;
  while (Date.now() < end) {
    value = await page(test);
    if (value) return value;
    await sleep(100);
  }
  return value;
};

// Closes the tab in front without waiting on it: a page with changes asks first, and nobody would
// answer. Gives back what it asked ('' when it didn't), after answering Close.
async function closeFront(page) {
  await page(`(() => { houseTest.closeTab(houseTest.state.active); return true; })()`);
  await sleep(600);
  const asked = await page(`document.getElementById('dialog').open ? document.getElementById('dialog').textContent : ''`);
  if (asked) await page(`document.querySelector('#dialog .btn.danger, #dialog .btn.primary').click(); true`);
  await sleep(300);
  return asked;
}

module.exports = { fs, os, path, execFileSync, ff, probe, sleep, report, demoHome, until, closeFront };
