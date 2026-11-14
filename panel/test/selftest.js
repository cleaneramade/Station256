// Drives the real panel through its main jobs, saves pictures, and prints results.
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.env.HOUSE_SELFTEST;
const HOME = os.homedir();
const NAME = 'zz-panel-test';
const PROJECT = path.join(HOME, 'projects', NAME);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

function report(label, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
}

async function run(win, terminals) {
  const page = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await sleep(500);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
  };
  const waitFor = async (check, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await sleep(500);
    }
    return false;
  };

  try {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await sleep(1500);

    // Sample files for the explorer and previews.
    fs.mkdirSync(path.join(PROJECT, 'src'), { recursive: true });
    fs.writeFileSync(path.join(PROJECT, 'notes.md'), '# Notes\n\nPreview test.\n');
    fs.writeFileSync(path.join(PROJECT, 'pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#0f6cbd"/></svg>');

    await page('houseTest.loadFolder()');
    await sleep(600);
    report('projects folder lists the project', await page(`document.getElementById('rows').textContent.includes('${NAME}')`));
    await shot('1-projects');

    await page(`houseTest.navigate('${PROJECT}')`);
    await sleep(700);
    const rowCount = await page('document.querySelectorAll(".row").length');
    report('explorer browses into a folder', rowCount === 3, `${rowCount} items`);
    report('room button appears in a project', await page('!document.getElementById("room-btn").hidden'));

    const entry = `houseTest.state.entries.find((e) => e.name === 'notes.md')`;
    await page(`houseTest.showPreview(${entry})`);
    await sleep(500);
    report('text preview', (await page('document.querySelector(".preview-text")?.textContent || ""')).includes('Preview test.'));
    await shot('2-text-preview');
    await page('document.querySelector(".preview-close").click()');

    await page(`houseTest.showPreview(houseTest.state.entries.find((e) => e.name === 'pixel.svg'))`);
    const imageLoaded = await waitFor(() => page('(document.querySelector(".preview-media")?.naturalWidth || 0) > 0'), 8000);
    report('image preview loads a local file', imageLoaded);
    await page('document.querySelector(".preview-close").click()');

    // Room + terminal tab.
    await page(`houseTest.openTerminal({ room: '${NAME}' }).then(() => true)`);
    const tabId = () => page('houseTest.state.active.termId');
    const id = await tabId();
    report('terminal tab opened', Number.isInteger(id));
    const prompted = await waitFor(() => terminals.buffer(id).includes('/workspace'), 90000);
    report('room popped up, terminal is inside it', prompted);

    terminals.write(id, 'echo TERM-$((40+2)); id -un; ls /workspace\n');
    report('typing runs in the room', await waitFor(() => terminals.buffer(id).includes('TERM-42') && terminals.buffer(id).includes('dev')));
    report('project files visible in the room', await waitFor(() => terminals.buffer(id).includes('notes.md')));
    await page('houseTest.refreshStatus()');
    await sleep(800);
    report('panel shows the room light on', await page(`houseTest.state.status.rooms.some((r) => r.name === '${NAME}')`));
    report('close-room reminder shows', (await page('document.getElementById("house-note").textContent')).includes('1 room open'));
    await shot('3-terminal');

    // Pop out to a window of its own (there's a Files tab to leave behind), keep running, bring back.
    await page('houseTest.popOutTab(houseTest.state.active)');
    await sleep(2500);
    const { BrowserWindow } = require('electron');
    const isExtra = (candidate) => candidate !== win && !candidate.isDestroyed() && !candidate.houseSpare;
    const popout = BrowserWindow.getAllWindows().find(isExtra);
    report('terminal popped out to its own window', Boolean(popout));
    terminals.write(id, 'echo STILL-$((6*7))-ALIVE\n');
    report('session keeps running after pop-out', await waitFor(() => terminals.buffer(id).includes('STILL-42-ALIVE'), 10000));
    if (popout) {
      const image = await popout.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '4-popout.png'), image.toPNG());
      await popout.webContents.executeJavaScript('document.querySelector(".tab .bring-back").click()');
    }
    await sleep(2000);
    report('brought back to a tab', await page(`houseTest.state.tabs.some((t) => t.termId === ${id})`) && !BrowserWindow.getAllWindows().some(isExtra));
    report('history survives the trip', await page(`(() => { const t = houseTest.state.tabs.find((x) => x.termId === ${id}); const b = t.live.term.buffer.active; let s = ''; for (let i = 0; i < b.length; i += 1) s += b.getLine(i).translateToString(true); return s.includes('STILL-42-ALIVE'); })()`));

    // System and rules.
    await page('houseTest.toggleSystem(true)');
    await sleep(1500);
    report('system panel fills in', (await page('document.getElementById("system-pane").textContent')).includes('Processes'));
    await shot('5-system');
    await page('houseTest.toggleSystem(false)');
    await page('houseTest.showRules(); true');
    await sleep(800);
    report('rules page lists rules', (await page('document.getElementById("rules-view").textContent')).includes('Passwords and keys'));
    await shot('6-rules');
    await page('document.querySelector(".rules-done").click(); true');
    await sleep(300);
    report('Done goes back to the page before', await page('houseTest.state.active.kind !== "rules" && ![...document.querySelectorAll(".tab .tab-title")].some((title) => title.textContent === "House Rules")'));

    // Close the terminal tab: no question, and the room and the terminal in it stay up.
    await page(`document.querySelector('.tab.active .close-tab').click(); true`);
    await sleep(500);
    report('closing a room tab asks nothing', !(await page(`document.getElementById('dialog').open`)));
    await sleep(1500);
    await page('houseTest.refreshStatus()');
    await sleep(800);
    report('closing the tab leaves the room up', await page(`houseTest.state.status.rooms.some((r) => r.name === '${NAME}')`));
    report('the terminal keeps running in the room', (await terminals.resumable(NAME)) !== null);
    await page(`houseTest.closeRoom('${NAME}')`);
    await page('houseTest.refreshStatus()');
    await sleep(800);
    report('room closes', !(await page(`houseTest.state.status.rooms.some((r) => r.name === '${NAME}')`)));
    report('single files tab hides its close button', await page('document.querySelector(".tab .close-tab").hidden'));

    // Window motion: one maximize, one restore, one zoom step.
    const box = () => page('(() => { const b = document.querySelector(".app").getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round); })()');
    const beforeBox = await box();
    await page('document.getElementById("win-max").click(); true');
    await sleep(70);
    const midGlide = await page('getComputedStyle(document.querySelector(".app")).transform');
    report('maximize runs as a transform glide', midGlide !== 'none', midGlide.slice(0, 40));
    await sleep(500);
    report('glide finished cleanly', await page('!document.documentElement.classList.contains("gliding") && getComputedStyle(document.querySelector(".app")).transform === "none"'));
    report('button shows restore', await page('document.getElementById("win-max").dataset.tip === "Restore"'));
    report('surface itself never resized', win.getBounds().width === 1920 && win.getBounds().height === 1020, JSON.stringify(win.getBounds()));
    await page('document.querySelector(".drag-space").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); true');
    await sleep(500);
    report('double-click restores the same size', JSON.stringify(await box()) === JSON.stringify(beforeBox), JSON.stringify(await box()));
    const physical = () => page('(() => { const b = document.querySelector(".app").getBoundingClientRect(); const f = window.outerWidth / window.innerWidth; return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * f)); })()');
    const beforeZoom = await physical();
    await page('document.getElementById("zoom-in").click(); true');
    await sleep(60);
    const midZoom = await physical();
    await sleep(350);
    const afterZoom = await physical();
    const near = (a, b) => a.every((value, index) => Math.abs(value - b[index]) <= 2);
    report('zoom keeps the window in place during the ease', near(beforeZoom, midZoom), `${beforeZoom} / ${midZoom}`);
    report('zoom keeps the window in place after it', near(beforeZoom, afterZoom), `${afterZoom}`);
    report('footer shows 105%', (await page('document.getElementById("zoom-level").textContent')) === '105%', await page('document.getElementById("zoom-level").textContent'));
    await page('document.getElementById("zoom-level").click(); true');
    await sleep(350);
    report('footer back to 100%', (await page('document.getElementById("zoom-level").textContent')) === '100%');
    report('address bar icon file exists', fs.existsSync(path.join(__dirname, '..', 'renderer', 'icons', 'desktop.svg')));

  } catch (error) {
    report('test ran to the end', false, error.message);
  }

  const { execFileSync } = require('child_process');
  try { execFileSync('docker', ['rm', '-f', `keep-${NAME}`], { stdio: 'ignore' }); } catch { /* none */ }
  try { execFileSync('docker', ['volume', 'rm', `house-claude-${NAME}`], { stdio: 'ignore' }); } catch { /* none */ }
  fs.rmSync(PROJECT, { recursive: true, force: true });
  console.log(`RESULT ${results.filter(Boolean).length}/${results.length}`);
  require('electron').app.quit();
}

module.exports = { run };
