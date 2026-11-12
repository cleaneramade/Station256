// The GitHub scene for shots.js: the From GitHub bar, a real clone of a tiny public repository into the
// throwaway HOME, the "new on GitHub" badge and getting updates. Needs the internet.
// Run: SHOT_HOME=/tmp/house-shots-github SHOT_PATH=panel/test/stub panel/test/shotrun.sh github
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = {
  async github({ page, shot, sleep }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} github: ${text}`);
    const home = os.homedir();
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    const lib = require('../lib/github');
    await page(`(async () => { document.getElementById('new-tab').click(); await new Promise((r) => setTimeout(r, 300)); await houseTest.navigate('home:'); return true; })()`);
    await sleep(1500);
    const menu = await page(`newItems().map((item) => item.label)`);
    report(menu.includes('From GitHub'), `the New menu has From GitHub: ${JSON.stringify(menu)}`);
    await page(`(() => { ghUi.openForm(); return true; })()`);
    await sleep(300);
    const shown = await page(`(() => { const bar = document.getElementById('gh-bar'); return !bar.hidden && bar.getBoundingClientRect().height > 20; })()`);
    report(shown, 'the bar opens on Home');
    await shot('github-bar');
    const ask = async (text) => {
      await page(`(() => { document.querySelector('.gh-input').value = ${JSON.stringify(text)}; document.querySelector('.gh-btn.primary').click(); return true; })()`);
      await sleep(600);
      return page(`document.querySelector('.gh-note').textContent`);
    };
    for (const bad of ['file:///etc/passwd', '--upload-pack=touch x/y', 'https://evil.com/o/r']) {
      const said = await ask(bad);
      report(/doesn't look like a GitHub repository/.test(said), `refused ${bad}: ${said}`);
    }
    const said = await ask('octocat/this-repository-does-not-exist-256');
    report(said.includes('signing in to GitHub comes in the next version'), `missing repository says it plainly: ${said}`);
    report(!fs.readdirSync(path.join(home, 'projects')).some((name) => /does-not-exist/.test(name)), 'and leaves no folder');

    await page(`(() => { document.querySelector('.gh-input').value = 'github.com/octocat/Hello-World.git'; document.querySelector('.gh-btn.primary').click(); return true; })()`);
    await sleep(150);
    const busy = await page(`document.getElementById('gh-bar').classList.contains('busy')`);
    report(busy, 'progress shows while getting');
    let done = false;
    for (let i = 0; i < 120 && !done; i += 1) {
      await sleep(500);
      done = await page(`!document.getElementById('gh-bar').classList.contains('busy')`);
    }
    report(done, 'finished');
    await sleep(1500);
    const dir = path.join(home, 'projects', 'Hello-World');
    report(fs.existsSync(path.join(dir, '.git')) && fs.existsSync(path.join(dir, 'README')), 'Hello-World is in projects');
    const card = await page(`!!document.querySelector('.home-card[data-project="Hello-World"]')`);
    report(card, 'it shows on Home as a card');
    await shot('github-done');

    // News: put the copy one change behind, ask again.
    execFileSync('git', ['-C', dir, 'reset', '--hard', 'HEAD~1'], { stdio: 'ignore' });
    lib._resetCache();
    await page(`(async () => { await ghUi.afterHome(['Hello-World']); return true; })()`);
    await sleep(1500);
    const badge = await page(`document.querySelector('.home-card[data-project="Hello-World"] .gh-badge')?.textContent || ''`);
    report(/^[1-9]\d* new on GitHub$/.test(badge), `badge: ${badge}`);
    await shot('github-badge');
    const labels = await page(`ghUi.menuItems({ name: 'Hello-World' }).map((item) => item.label || item)`);
    report(labels.includes('Get updates from GitHub') && labels.includes('Open on GitHub'), `project menu: ${JSON.stringify(labels)}`);
    await page(`(() => { ghUi.menuItems({ name: 'Hello-World' }).find((item) => item.label === 'Get updates from GitHub').run(); return true; })()`);
    await sleep(6000);
    const after = await page(`document.querySelector('.home-card[data-project="Hello-World"] .gh-badge')?.textContent || ''`);
    report(after === '', 'badge gone after getting updates');
    const behind = execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD..origin/master'], { encoding: 'utf8' }).trim();
    report(behind === '0', `copy is current (${behind} behind)`);
    await sleep(500);
  },
};
