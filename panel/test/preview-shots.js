// The Preview scene for shots.js (run with SHOT_PATH=<this folder>/stub-preview, see shotrun.sh): a
// fake "room" script stands in for the real one in the throwaway home. Clicking Preview on a project
// with an index.html must open a room terminal, type the command into it, see the fake room start
// a site, and open it in an Obscura tab tied to the project.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = {
  async preview({ page, shot, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const home = os.homedir();
    if (!process.env.SHOT_HOME && home === os.userInfo().homedir) throw new Error('refusing to run outside a throwaway HOME');
    fs.writeFileSync(path.join(home, 'projects', 'SampleApp', 'index.html'), '<h1>hi</h1>');
    fs.writeFileSync(path.join(home, 'fake-pid'), String(process.pid));
    const fakeRoom = path.join(home, '.local', 'bin', 'room');
    fs.writeFileSync(fakeRoom, `#!/bin/bash
case "$1" in
  open) printf 'prompt$ '
    while IFS= read -r line; do
      echo "got: $line" >> "$HOME/typed.txt"
      case "$line" in
        *'(exit 127)'*) echo "PHP isn't installed in this room."; echo "STATION-DONE-$((127))" ;;
        *http.server*) (python3 -m http.server 8137 --bind 127.0.0.1 >/dev/null 2>&1 &) ;;
      esac
    done ;;
  forward) exec python3 -m http.server "$4" --bind 127.0.0.1 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    await page(`(async () => { state.status = { ...state.status, rooms: [{ name: 'SampleApp' }] }; drawHome(); return true; })()`);
    await sleep(400);
    await sleep(1500);
    await shot('preview-home-card');
    const buttonCounts = await page(`[...document.querySelectorAll('.home-card[data-project] .home-card-buttons')].map((row) => row.children.length)`);
    report(buttonCounts.length >= 3 && buttonCounts.every((n) => n === 1), `every project card has just one button: ${JSON.stringify(buttonCounts)}`);
    const menuOf = async (name) => {
      await page(`(() => { const c = document.querySelector('.home-card[data-project="${name}"]'); const b = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 30, clientY: b.top + 20 })); return true; })()`);
      await sleep(900);
      const list = await page(`[...document.querySelectorAll('#menu:not([hidden]) .menu-item')].map((m) => m.textContent.trim())`);
      await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
      return list;
    };
    const first = await menuOf('SampleApp');
    report(first.includes('Preview'), `Preview is in the card's right-click menu: ${JSON.stringify(first.slice(0, 6))}`);
    const oneRow = `[...document.querySelectorAll('.home-card-buttons')].every((row) => new Set([...row.children].map((b) => Math.round(b.getBoundingClientRect().top))).size === 1 && row.scrollWidth <= row.parentElement.clientWidth)`;
    report(await page(oneRow), 'every card keeps one row of buttons');
    const [wide, tall] = win.getSize();
    win.setSize(700, tall);
    await sleep(600);
    await shot('preview-home-card-narrow');
    report(await page(oneRow), `and still one row in a narrow window (${win.getSize()[0]} wide)`);
    win.setSize(1240, 800); // shotrun.sh's size; getSize() of a hidden window can come back scaled
    await sleep(400);
    // A project with nothing to start: a plain message, nothing opens.
    await page(`previewProject('Notes App')`);
    await sleep(800);
    const note = await page(`document.getElementById('toast')?.textContent || document.querySelector('.toast')?.textContent || ''`);
    report(/couldn't find a website to start/.test(note), `nothing to start says so: ${JSON.stringify(note)}`);
    // The real thing, against the fake room.
    page(`previewProject('SampleApp')`);
    await sleep(1500);
    const starting = await page(`previewLabel('SampleApp')`);
    report(starting === 'Starting…', `the button says Starting… while it waits: ${starting}`);
    // The page opens in an Obscura tab tied to the project; nothing goes to Windows' browser.
    const pages = `state.tabs.filter((tab) => tab.kind === 'obscura' && tab.previewOf === 'SampleApp').map((tab) => [tab.url, tab.project.textContent, tab === state.active])`;
    const toWindows = () => global.stationChecks.opened.filter((url) => url.startsWith('http://localhost:')).length;
    let opened = [];
    for (let i = 0; i < 40 && !opened.length; i += 1) {
      await sleep(500);
      opened = await page(pages);
    }
    const typed = fs.existsSync(path.join(home, 'typed.txt')) ? fs.readFileSync(path.join(home, 'typed.txt'), 'utf8') : '';
    report(typed.trim().startsWith('got: python3 -m http.server 8000; printf'), `the command was typed into the room terminal: ${JSON.stringify(typed)}`);
    report(opened.length === 1 && /^http:\/\/localhost:\d+\/$/.test(opened[0][0]) && opened[0][2], `the page opened once, in a Station tab in front: ${JSON.stringify(opened)}`);
    report(opened[0]?.[1] === 'SampleApp', `its bar says which project it is: ${JSON.stringify(opened[0]?.[1])}`);
    report(toWindows() === 0, 'nothing was sent to the Windows browser');
    await sleep(500);
    const after = await page(`previewLabel('SampleApp')`);
    report(after === 'Open Preview', `the button now says Open Preview: ${after}`);
    await sleep(800);
    await shot('preview-page');
    await page(`(async () => { activateTab(state.tabs[0]); return true; })()`);
    await sleep(400);
    await shot('preview-home-card-running');
    const running = await menuOf('SampleApp');
    report(running.includes('Open Preview'), `the card's menu now says Open Preview: ${JSON.stringify(running.slice(0, 6))}`);
    // Clicking again opens the page again, with no second terminal or typed command.
    const tabs = await page(`state.tabs.length`);
    await page(`previewProject('SampleApp')`);
    await sleep(1500);
    const again = await page(pages);
    const typedAgain = fs.readFileSync(path.join(home, 'typed.txt'), 'utf8').trim().split('\n').length;
    report(again.length === 1 && again[0][2] && typedAgain === 1 && (await page(`state.tabs.length`)) === tabs, `clicking again brings the same page tab back, starts nothing: ${JSON.stringify([again.length, again[0]?.[2], typedAgain])}`);
    // End the fake site: the button goes back to Preview by itself.
    require('child_process').spawnSync('pkill', ['-f', 'http.server 8137 --bind']);
    let label = 'Open Preview';
    for (let i = 0; i < 24 && label !== 'Preview'; i += 1) {
      await sleep(500);
      label = await page(`previewLabel('SampleApp')`);
    }
    report(label === 'Preview', `a stopped site gives the button back its Preview label: ${label}`);
    // A project that needs a tool the room lacks: the plain line shows at once, not after 2 minutes.
    fs.writeFileSync(path.join(home, 'projects', 'Docs Site', 'artisan'), '');
    const began = Date.now();
    await page(`previewProject('Docs Site')`);
    const missingNote = await page(`document.querySelector('.toast')?.textContent || ''`);
    report(missingNote === "PHP isn't installed in this room." && Date.now() - began < 30000, `a missing tool is said at once: ${JSON.stringify(missingNote)} after ${Date.now() - began} ms`);
  },
};
