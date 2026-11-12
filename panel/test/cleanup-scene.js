// The Clean-up section in the System panel and the Trash note (renderer/app.js), with the real
// routine (lib/housekeeping.js) running in the throwaway home against the stand-in docker.
// Run: SHOT_PATH=<repo>/panel/test/stub SHOT_HOME=/tmp/house-shots-cleanup panel/test/shotrun.sh cleanup
// (shotrun.sh sets HOUSE_CLEANUP=0, so the switch shows off and nothing runs by itself.)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = {
  async cleanup({ page, shot, sleep }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} cleanup: ${text}`);
    const home = os.homedir();
    if (!home.startsWith('/tmp/house-shots')) { report(false, 'needs the throwaway HOME'); return; }
    // Before anything can run: the docker it would call has to be the stand-in, which refuses all but a few asks.
    let docker = '';
    try { docker = execFileSync('sh', ['-c', 'command -v docker']).toString().trim(); } catch {}
    if (!docker.endsWith('/panel/test/stub/docker')) { report(false, `docker is not the stand-in: ${docker || 'none'}`); return; }
    report(true, 'docker is the stand-in');

    // Made-up leftovers in the throwaway home: a crash dump, an old Trash item and a new one.
    const trash = path.join(home, '.local', 'share', 'house-trash');
    const project = path.join(home, 'projects', 'Notes App');
    fs.mkdirSync(path.join(trash, '.info'), { recursive: true });
    const head = Buffer.alloc(1.2 * 1024 * 1024);
    head.set([0x7f, 0x45, 0x4c, 0x46], 0);
    head.writeUInt16LE(4, 16);
    fs.writeFileSync(path.join(project, 'core.4242'), head);
    const old = Date.now() - 40 * 86400000;
    const fresh = Date.now() - 86400000;
    fs.writeFileSync(path.join(trash, `${old}-old-notes.txt`), 'old');
    fs.writeFileSync(path.join(trash, '.info', `${old}-old-notes.txt.json`), JSON.stringify({ from: path.join(project, 'old-notes.txt') }));
    fs.writeFileSync(path.join(trash, `${fresh}-new-notes.txt`), 'new');
    fs.writeFileSync(path.join(trash, '.info', `${fresh}-new-notes.txt.json`), JSON.stringify({ from: path.join(project, 'new-notes.txt') }));

    await page(`houseTest.toggleSystem(true); true`);
    await sleep(1500);
    const look = () => page(`(() => {
      const pane = document.getElementById('system-pane');
      const title = [...pane.querySelectorAll('.sys-title')].find((n) => n.textContent === 'Clean-up');
      const button = [...pane.querySelectorAll('button')].find((n) => n.textContent.includes('Clean up now') || n.textContent.includes('Cleaning up'));
      const label = [...pane.querySelectorAll('.sys-check')].find((n) => n.textContent === 'Clean up automatically');
      const row = [...pane.querySelectorAll('.sys-row-label')].find((n) => /Last clean-up|Not run yet/.test(n.textContent));
      return { title: Boolean(title), button: Boolean(button), box: label ? label.querySelector('input').checked : null, line: row ? row.textContent : null, tip: row ? (row.parentElement.dataset.tip || row.parentElement.title) : null };
    })()`);
    let now = await look();
    report(now.title && now.button && now.box === false && now.line === 'Not run yet', `the section is there, with the switch off (HOUSE_CLEANUP=0 here) and no run yet: ${JSON.stringify(now)}`);
    await page(`(() => { const t = [...document.querySelectorAll('#system-pane .sys-title')].find((n) => n.textContent === 'Clean-up'); t.scrollIntoView(); return true; })()`);
    await sleep(300);
    await shot('cleanup-before');

    await page(`(() => { [...document.querySelectorAll('#system-pane button')].find((n) => n.textContent.includes('Clean up now')).click(); return true; })()`);
    let waited = 0;
    while (waited < 20000) {
      await sleep(400);
      waited += 400;
      now = await look();
      if (/^Last clean-up/.test(now.line || '')) break;
    }
    report(/^Last clean-up: .* · freed \d/.test(now.line || ''), `pressing Clean up now shows a result: ${JSON.stringify(now.line)}`);
    report(/^Removed: .*crash dumps/.test(now.tip || '') && /old Trash/.test(now.tip || ''), `the hover lists what was removed: ${JSON.stringify(now.tip)}`);
    report(!fs.existsSync(path.join(project, 'core.4242')) && !fs.existsSync(path.join(trash, `${old}-old-notes.txt`)) && !fs.existsSync(path.join(trash, '.info', `${old}-old-notes.txt.json`)), 'the crash dump and the 40-day-old Trash item are gone');
    report(fs.existsSync(path.join(trash, `${fresh}-new-notes.txt`)) && fs.existsSync(project), 'the newer Trash item and the project folder stay');
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.local', 'state', 'house', 'housekeeping.json'), 'utf8'));
    report(saved.runs.length === 1 && saved.lastRun.rules.length === 6, `the result is saved (${saved.lastRun?.rules?.length} parts)`);
    await page(`(() => { const t = [...document.querySelectorAll('#system-pane .sys-title')].find((n) => n.textContent === 'Clean-up'); t.scrollIntoView(); return true; })()`);
    await shot('cleanup-after');

    // The switch saves the setting.
    const settings = path.join(home, '.config', 'house', 'panel.json');
    await page(`(() => { const box = [...document.querySelectorAll('#system-pane .sys-check')].find((n) => n.textContent === 'Clean up automatically').querySelector('input'); box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(400);
    report(JSON.parse(fs.readFileSync(settings, 'utf8')).cleanup === false, 'turning the switch off is saved as cleanup: false');
    await page(`(() => { const box = [...document.querySelectorAll('#system-pane .sys-check')].find((n) => n.textContent === 'Clean up automatically').querySelector('input'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(400);
    report(JSON.parse(fs.readFileSync(settings, 'utf8')).cleanup === true, 'and on again');

    // The Trash page says how long things stay.
    await page(`houseTest.toggleSystem(false); true`);
    await page(`(() => { houseTest.navigate(houseTest.state.trash); return true; })()`);
    await sleep(1200);
    const note = await page(`document.querySelector('#rows .trash-note')?.textContent || null`);
    report(note === 'Items in the Trash are deleted for good after 30 days.', `the Trash page has its note: ${JSON.stringify(note)}`);
    await shot('cleanup-trash');
    await page(`(() => { houseTest.navigate(houseTest.state.projects); return true; })()`);
    await sleep(400);
    const elsewhere = await page(`document.querySelector('#rows .trash-note') === null`);
    report(elsewhere, 'no note in other folders');
  },
};
