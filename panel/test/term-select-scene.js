// Drag to highlight in a terminal (renderer/term.js dragAlwaysSelects), in the hidden copy:
//   SHOT_PATH=$PWD/panel/test/stub SHOT_HOME=/tmp/house-shots-select panel/test/shotrun.sh termSelect
// A program that wants the mouse (as Herdr and Claude do) is stood in for by printf + cat -v, which
// shows the clicks it gets. Real mouse events are sent to the window.
module.exports = {
  async termSelect({ page, sleep, win }) {
    const results = [];
    const report = (ok, text) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} termSelect: ${text}`); };
    const host = '.term-host:not([hidden])';
    const screenText = () => page(`document.querySelector('${host} .xterm-rows').textContent`);
    const picked = () => page(`document.querySelectorAll('${host} .xterm-selection div').length > 0`);
    const mouse = async (type, x, y, clickCount = 1) => {
      const zoom = win.webContents.getZoomFactor();
      win.webContents.sendInputEvent({ type, x: Math.round(x * zoom), y: Math.round(y * zoom), button: 'left', clickCount });
      await sleep(60);
    };
    const drag = async (from, to) => {
      await mouse('mouseDown', from.x, from.y);
      for (let step = 1; step <= 5; step += 1) await mouse('mouseMove', from.x + ((to.x - from.x) * step) / 5, from.y + ((to.y - from.y) * step) / 5);
      await mouse('mouseUp', to.x, to.y);
      await sleep(200);
    };
    const click = async (at) => { await mouse('mouseDown', at.x, at.y); await mouse('mouseUp', at.x, at.y); await sleep(300); };
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
      const box = await page(`(() => { const r = document.querySelector('${host} .xterm-screen').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
      const row = (n) => box.y + 8 + n * 17;
      await type('echo hello there friend');
      console.log('INFO screen ' + JSON.stringify((await screenText()).slice(0, 200)) + ' zoom ' + win.webContents.getZoomFactor() + ' box ' + JSON.stringify(box));
      await drag({ x: box.x + 4, y: row(0) }, { x: box.x + 200, y: row(1) });
      report(await picked(), 'no program wants the mouse: a drag highlights');
      await click({ x: box.x + 40, y: row(3) });
      report(!(await picked()), 'a click takes the highlight away');

      // Now a program that wants the mouse.
      // 1003 = every mouse move, as Herdr and Claude ask. Each move sent to the program used to wipe the highlight.
      await type(`printf '\\033[?1003h\\033[?1006h'; cat -v`);
      await sleep(500);
      const before = (await screenText()).split('^[[<').length;
      await drag({ x: box.x + 4, y: row(0) }, { x: box.x + 200, y: row(1) });
      const afterDrag = (await screenText()).split('^[[<').length;
      const wide = await page(`[...document.querySelectorAll('${host} .xterm-selection div')].reduce((sum, d) => sum + d.getBoundingClientRect().width, 0)`);
      report(wide > 150, `a program wants the mouse: a plain drag still highlights along the drag (${Math.round(wide)} px wide)`);
      report(afterDrag === before, `the drag isn't sent to the program (${before - 1} -> ${afterDrag - 1} reports)`);
      const zoom = win.webContents.getZoomFactor();
      for (let step = 0; step < 6; step += 1) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round((box.x + 60 + step * 30) * zoom), y: Math.round(row(2 + (step % 3)) * zoom) });
        await sleep(80);
      }
      await sleep(300);
      report(await picked(), 'moving the mouse over the terminal afterwards keeps the highlight');
      const menu = await page(`(() => { const s = document.querySelector('${host} .xterm-screen'); s.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${box.x + 50}, clientY: ${row(2)} })); const items = [...document.querySelectorAll('#menu .menu-item, .context-menu [role=menuitem], .menu button')].map((b) => (b.disabled || b.classList.contains('disabled') ? '-' : '') + b.textContent.trim()); closeMenu?.(); return items; })()`).catch((error) => [String(error)]);
      console.log(`INFO menu ${JSON.stringify(menu)}`);
      report(menu.some((item) => /^Copy/.test(item)), 'right-click Copy is on for the highlight');
      await click({ x: box.x + 40, y: row(3) });
      const afterClick = (await screenText()).split('^[[<').length;
      report(afterClick > afterDrag && !(await picked()), `a plain click still goes to the program (${afterDrag - 1} -> ${afterClick - 1} clicks seen)`);
      await mouse('mouseDown', box.x + 30, row(0), 1); await mouse('mouseUp', box.x + 30, row(0), 1);
      await mouse('mouseDown', box.x + 30, row(0), 2); await mouse('mouseUp', box.x + 30, row(0), 2);
      await sleep(200);
      report(await picked(), 'a double click picks a word');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] });
      await sleep(300);
      report(!(await picked()), 'Ctrl+C copies the highlight (and clears it)');
      await page(`houseTest.closeTab(houseTest.state.active); true`);
    } catch (error) {
      report(false, `scene stopped: ${error.stack || error.message}`);
    }
    console.log(`${results.every(Boolean) ? 'PASS' : 'FAIL'} termSelect: ${results.filter(Boolean).length} of ${results.length} checks passed`);
  },
};
