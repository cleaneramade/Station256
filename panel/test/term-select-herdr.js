// Drag to highlight inside the real Herdr (hidden copy only; run by hand, not part of every run):
//   SHOT_PATH=$PWD/panel/test/stub SHOT_HOME=/tmp/house-shots-select HOUSE_SHOTS_SCENES=termSelectHerdr panel/test/shotrun.sh termSelectHerdr
// Herdr gets its own throwaway home (/tmp/herdr-select), so it never meets a real Herdr.
module.exports = {
  async termSelectHerdr({ page, sleep, win }) {
    const results = [];
    const report = (ok, text) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} termSelectHerdr: ${text}`); };
    const host = '.term-host:not([hidden])';
    const wide = () => page(`[...document.querySelectorAll('${host} .xterm-selection div')].reduce((sum, d) => sum + d.getBoundingClientRect().width, 0)`);
    const zoom = () => win.webContents.getZoomFactor();
    const mouse = async (type, x, y, button = 'left') => {
      win.webContents.sendInputEvent({ type, x: Math.round(x * zoom()), y: Math.round(y * zoom()), ...(button ? { button, clickCount: 1 } : {}) });
      await sleep(60);
    };
    const type = async (text) => {
      await page(`document.querySelector('${host} textarea').focus(); true`);
      win.webContents.insertText(text);
      await sleep(100);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await sleep(800);
    };
    try {
      await page(`houseTest.openTerminal({ cwd: houseTest.state.home }).then(() => true)`);
      await sleep(2500);
      const h = '/tmp/herdr-select';
      await type(`mkdir -p ${h}/run && env HOME=${h} XDG_RUNTIME_DIR=${h}/run XDG_CONFIG_HOME=${h}/cfg XDG_DATA_HOME=${h}/data XDG_STATE_HOME=${h}/state XDG_CACHE_HOME=${h}/cache ${process.env.HOME_REAL || '/home/alex'}/.local/bin/herdr`);
      await sleep(4000);
      await type('for n in $(seq 1 40); do echo "line $n of words to pick"; done');
      await sleep(1000);
      const box = await page(`(() => { const r = document.querySelector('${host} .xterm-screen').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
      console.log(`INFO screen ${JSON.stringify((await page(`document.querySelector('${host} .xterm-rows').textContent`)).slice(0, 300))}`);
      const from = { x: box.x + box.w * 0.3, y: box.y + box.h * 0.4 };
      const to = { x: box.x + box.w * 0.6, y: box.y + box.h * 0.55 };
      await mouse('mouseDown', from.x, from.y);
      let lowest = Infinity;
      for (let step = 1; step <= 8; step += 1) {
        await mouse('mouseMove', from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8);
        lowest = Math.min(lowest, await wide());
      }
      report(lowest > 0, `the highlight stays the whole time the mouse is held (smallest ${Math.round(lowest)} px)`);
      await mouse('mouseUp', to.x, to.y);
      for (let step = 0; step < 6; step += 1) await mouse('mouseMove', box.x + 80 + step * 40, box.y + box.h * 0.7, null);
      await sleep(2000); // Herdr redraws in the meantime
      const after = await wide();
      report(after > 100, `after letting go, moving and waiting 2 s it is still there (${Math.round(after)} px)`);
      await page(`houseTest.closeTab(houseTest.state.active); true`);
    } catch (error) {
      report(false, `scene stopped: ${error.stack || error.message}`);
    }
    console.log(`${results.every(Boolean) ? 'PASS' : 'FAIL'} termSelectHerdr: ${results.filter(Boolean).length} of ${results.length} checks passed`);
  },
};
