// Audit: the song page. Demo MP3, FLAC and M4A made with ffmpeg; the real page's fields and Save are
// used, then ffprobe reads the file back.
const { fs, execFileSync, ff, probe, sleep, report, demoHome, closeFront } = require('./audit-lib');

module.exports = {
  async auditSong({ page, shot }) {
    const { dir, at } = demoHome();
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-metadata', 'title=Old Title', '-metadata', 'artist=Old Artist', '-metadata', 'track=1', at('a.mp3'));
    ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', at('b.flac'));
    ff('-f', 'lavfi', '-i', 'sine=frequency=550:duration=2', '-c:a', 'aac', at('c.m4a'));
    ff('-f', 'lavfi', '-i', 'testsrc=size=300x300:duration=1', '-frames:v', '1', at('cover.png'));
    const png = [...fs.readFileSync(at('cover.png'))];
    const lower = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k.toLowerCase(), v]));
    const tags = (file) => { const d = probe(file); return lower({ ...(d.format.tags || {}), ...(d.streams.find((s) => s.codec_type === 'audio')?.tags || {}) }); };
    const set = (field, value) => page(`(() => { const tab = houseTest.state.active; tab.inputs.${field}.value = ${JSON.stringify(value)}; tab.inputs.${field}.dispatchEvent(new Event('input')); return true; })()`);
    const save = async (copy = false) => { await page(`saveSong(houseTest.state.active, ${copy}).then(() => true)`); await sleep(1500); };
    const hash = (file) => execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']).toString();
    await page(`houseTest.navigate(${JSON.stringify(dir)}); true`);
    await sleep(600);
    for (const [name, track] of [['a.mp3', '3'], ['b.flac', '3/12'], ['c.m4a', '3/12']]) {
      await page(`openSong(${JSON.stringify(at(name))}).then(() => true)`);
      await sleep(900);
      const kind = await page(`houseTest.state.active.kind`);
      for (const [f, v] of [['title', 'New Title'], ['artist', 'Some Artist'], ['album', 'The Album'], ['year', '2024'], ['genre', 'Rock'], ['track', track]]) await set(f, v);
      if (name === 'a.mp3') await page(`(() => { houseTest.state.active.cover = new Uint8Array(${JSON.stringify(png)}); return true; })()`);
      const soundBefore = hash(at(name));
      await save();
      const t = tags(at(name));
      report(kind === 'song' && t.title === 'New Title' && t.artist === 'Some Artist' && t.album === 'The Album' && String(t.date || t.year).startsWith('2024') && t.genre === 'Rock' && t.track === track, `${name}: title/artist/album/year/genre/track "${track}" read back with ffprobe: ${JSON.stringify(t)}`);
      report(hash(at(name)) === soundBefore, `${name}: the sound itself is unchanged`);
      if (name === 'a.mp3') {
        const pictures = probe(at(name)).streams.filter((s) => s.codec_type === 'video').length;
        report(pictures === 1, `${name}: the cover picture is in the file (${pictures} picture stream)`);
        await shot('audit-song');
      }
      // Odd input: letters in Track, a bad year, then an emptied Track.
      await set('track', 'abc');
      await save();
      const msg = await page(`houseTest.state.active.problem.textContent`);
      report(/track number should be a number/.test(msg) && tags(at(name)).track === track, `${name}: letters in Track say "${msg}" and the file is untouched`);
      await set('track', '');
      await set('year', 'soon');
      await save();
      const msg2 = await page(`houseTest.state.active.problem.textContent`);
      report(/year should be four digits/.test(msg2), `${name}: a bad year says "${msg2}"`);
      await set('year', '2024');
      await save();
      const t2 = tags(at(name));
      report(!t2.track && t2.title === 'New Title', `${name}: an emptied Track is removed and the rest stays: ${JSON.stringify(t2)}`);
      await page(`houseTest.closeTab(houseTest.state.active).then(() => true)`);
      await sleep(300);
    }
    // Save as Copy leaves the original alone.
    await page(`openSong(${JSON.stringify(at('b.flac'))}).then(() => true)`);
    await sleep(800);
    await set('title', 'Copy Title');
    await save(true);
    const copies = fs.readdirSync(dir).filter((n) => /\(edited\)/.test(n));
    report(copies.length === 1 && tags(at(copies[0])).title === 'Copy Title' && tags(at('b.flac')).title === 'New Title', `Save as Copy makes ${JSON.stringify(copies)} and leaves the original alone`);
    // The page still shows changes the original never got, so closing asks first.
    const asked = await closeFront(page);
    report(/Close without saving/.test(asked) && !(await page(`houseTest.state.tabs.some((t) => t.kind === 'song')`)), `closing with changes the original never got asks first, then closes: ${JSON.stringify(asked.slice(0, 40))}`);
  },
};
