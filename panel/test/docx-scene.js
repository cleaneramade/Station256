// The Word document scene for shots.js: a tiny made-up .docx, and the real demo if it is there
// (SHOT_DOCX=<file>, picture saved as docx-real). Preview must show the page, not "can't show".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = {
  async docx({ page, shot, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const home = os.homedir();
    if (!process.env.SHOT_HOME && home === os.userInfo().homedir) throw new Error('refusing to run outside a throwaway HOME');
    const file = path.join(home, 'Documents', 'tiny.docx');
    execFileSync('python3', [path.join(__dirname, 'docx-fixture.py'), file]);
    const open = async (target) => {
      const entry = JSON.stringify({ path: target, name: path.basename(target), isDir: false, size: fs.statSync(target).size, mtime: fs.statSync(target).mtimeMs });
      await page(`(() => { closePreview(true); houseTest.showPreview(${entry}); return true; })()`);
      await sleep(1200);
    };
    await open(file);
    const seen = await page(`(() => { const v = document.querySelector('#preview .docx-view'); return v && { h: v.querySelector('h2')?.textContent, bold: v.querySelector('strong')?.textContent, cells: [...v.querySelectorAll('td')].map((c) => c.textContent), li: v.querySelector('.docx-li')?.textContent, img: v.querySelector('img')?.src.slice(0, 22), text: document.getElementById('preview').textContent }; })()`);
    report(seen && seen.h === 'Fixture Heading' && seen.bold === 'BoldWord', `heading and bold show: ${JSON.stringify(seen && [seen.h, seen.bold])}`);
    report(seen && seen.cells.join() === 'A1,B1,A2,B2' && /BulletOne/.test(seen.li), `table cells and bullet show: ${JSON.stringify(seen && [seen.cells, seen.li])}`);
    report(seen && seen.img === 'data:image/png;base64,' && !/can't show/.test(seen.text), 'the picture shows and there is no "can\'t show" message');
    await shot('docx-tiny');
    // 120% zoom in a narrow window: nothing may stick out sideways.
    const [wide, tall] = win.getSize();
    win.setSize(600, tall);
    const zoom = win.webContents.getZoomFactor();
    win.webContents.setZoomFactor(zoom * 1.2);
    await sleep(400);
    // The app itself has a minimum width, so measure against the preview, not the window.
    const fits = await page(`(() => { const v = document.querySelector('#preview .docx-view'); const p = document.getElementById('preview').getBoundingClientRect(); const r = v.getBoundingClientRect(); return { sw: v.scrollWidth, cw: v.clientWidth, left: r.left - p.left, right: p.right - r.right }; })()`);
    report(fits.sw <= fits.cw + 1 && fits.left >= 0 && fits.right >= 0, `the page fits a narrow window at 120%: ${JSON.stringify(fits)}`);
    win.setSize(wide, tall);
    win.webContents.setZoomFactor(zoom);
    if (process.env.SHOT_DOCX && fs.existsSync(process.env.SHOT_DOCX)) {
      await open(process.env.SHOT_DOCX);
      await shot('docx-real');
    }
    await page(`(() => { closePreview(true); return true; })()`);
  },
};
