// Audit: the picture editor and the video page, on small demo files made with ffmpeg. The real
// editor's own turn, crop, undo and save are used; ffprobe measures what ended up on disk.
const { fs, ff, probe, sleep, report, demoHome, until, closeFront } = require('./audit-lib');

const size = (file) => { const s = probe(file).streams.find((x) => x.codec_type === 'video'); return `${s.width}x${s.height}`; };

module.exports = {
  async auditPicture({ page, shot }) {
    const { dir, at } = demoHome('AuditPics');
    ff('-f', 'lavfi', '-i', 'testsrc2=s=400x300:d=1', '-frames:v', '1', at('photo.png'));
    ff('-f', 'lavfi', '-i', 'testsrc2=s=300x200:d=1', '-frames:v', '1', at('shot.jpg'));
    ff('-f', 'lavfi', '-i', 'testsrc=s=320x240:d=4:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-pix_fmt', 'yuv420p', '-shortest', at('clip.mp4'));
    const entry = (file) => { const st = fs.statSync(file); return JSON.stringify({ path: file, name: file.split('/').pop(), isDir: false, size: st.size, mtime: st.mtimeMs }); };
    await page(`houseTest.navigate(${JSON.stringify(dir)}); true`);
    await sleep(700);

    // A PNG: turn right (400x300 -> 300x400), crop to 100x100, Save as Copy.
    await page(`(() => { closePreview(true); houseTest.showPreview(${entry(at('photo.png'))}); return true; })()`);
    await sleep(500);
    await page(`document.querySelector('#preview .pe-edit-btn').click(); true`);
    await until(page, `Boolean(pe && document.querySelector('#preview .pe-canvas'))`);
    await page(`peTurn(1); true`);
    await page(`(() => { peRemember(); pe.crop = { x: 0, y: 0, w: 100, h: 100 }; peDrawNow(); return true; })()`);
    await shot('audit-picture-edit');
    await page(`peUndo(); true`);
    const undone = await page(`[pe.rotate, JSON.stringify(pe.crop)]`);
    report(undone[0] === 90 && undone[1] === 'null', `Undo takes back the crop but keeps the turn: ${JSON.stringify(undone)}`);
    await page(`peRedo(); true`);
    await page(`savePictureEdit(false).then(() => true)`);
    await until(page, `!pe`);
    await sleep(500);
    report(fs.existsSync(at('photo (edited).png')) && size(at('photo (edited).png')) === '100x100' && size(at('photo.png')) === '400x300', `PNG turned and cropped: copy is ${fs.existsSync(at('photo (edited).png')) ? size(at('photo (edited).png')) : 'missing'}, original still 400x300`);

    // A JPG: turn left, then Save over it (old goes to the Trash).
    await page(`(() => { closePreview(true); houseTest.showPreview(${entry(at('shot.jpg'))}); return true; })()`);
    await sleep(500);
    await page(`document.querySelector('#preview .pe-edit-btn').click(); true`);
    await until(page, `Boolean(pe && document.querySelector('#preview .pe-canvas'))`);
    await page(`peTurn(-1); true`);
    await page(`savePictureEdit(true).then(() => true)`);
    await until(page, `!pe`);
    await sleep(600);
    const fmt = probe(at('shot.jpg')).format.format_name;
    report(size(at('shot.jpg')) === '200x300' && /image2|jpeg|mjpeg/.test(fmt), `JPG turned left and saved over itself: ${size(at('shot.jpg'))}, still ${fmt}`);
    await page(`closePreview(true); true`);

    // A short MP4: trim 1s..3s, Save as Copy; the copy is about 2 seconds, the original is untouched.
    await page(`openVideo(${JSON.stringify(at('clip.mp4'))}).then(() => true)`);
    await until(page, `state.active?.kind === 'video' && state.active.video.readyState >= 1`, 15000);
    const before = Number(probe(at('clip.mp4')).format.duration);
    await page(`(() => { const tab = state.active; changeTrim(tab, (trim) => { trim.start = 1; trim.end = 3; }); return true; })()`);
    await shot('audit-video-trim');
    await page(`saveVideo(state.active, false).then(() => true)`);
    const made = await until(page, `!state.active.job`, 60000);
    await sleep(800);
    const copy = fs.readdirSync(dir).find((n) => /^clip \(edited\)\.mp4$/.test(n));
    const length = copy ? Number(probe(at(copy)).format.duration) : 0;
    report(Boolean(made) && copy && Math.abs(length - 2) < 0.4 && Math.abs(Number(probe(at('clip.mp4')).format.duration) - before) < 0.01, `video trim 1s to 3s: copy is ${length.toFixed(2)} s, original still ${before.toFixed(2)} s`);
    // Trim then Undo: nothing to save, and it says how to trim.
    await page(`(() => { const tab = state.active; undoVideo(tab); return true; })()`);
    await page(`saveVideo(state.active, false).then(() => true)`);
    await sleep(300);
    const said = await page(`document.querySelector('.toast-text')?.textContent || ''`);
    report(/Trim it first/.test(said), `Save with no trim says what to do: "${said}"`);
    // Trim then Undo left nothing to save, so closing shouldn't ask.
    const asked = await closeFront(page);
    report(!asked && !(await page(`houseTest.state.tabs.some((t) => t.kind === 'video')`)), `after Undo, the video page closes without asking: ${JSON.stringify(asked.slice(0, 60))}`);
  },
};
