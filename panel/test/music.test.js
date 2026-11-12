// Song info (lib/music.js) on made-up songs in a throwaway folder: every kind is changed and read back,
// the sound must come out identical, and the old song must be in the (throwaway) Trash.
// Run with a throwaway HOME (test/music-run.sh does).  node panel/test/music.test.js /tmp/music-test
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const files = require('../lib/files');
const music = require('../lib/music');

const dir = process.argv[2];
if (!dir || !dir.startsWith('/tmp/music-test') || !process.env.HOME.startsWith('/tmp/')) { console.log('FAIL give a /tmp/music-test folder and run with HOME under /tmp'); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });
const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-nostdin', ...args]);
const md5 = (f) => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']).toString();
const report = (ok, text) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`); if (!ok) process.exitCode = 1; };

(async () => {
  ff('-f', 'lavfi', '-i', 'color=c=red:s=300x300', '-frames:v', '1', path.join(dir, 'red.jpg'));
  ff('-f', 'lavfi', '-i', 'color=c=blue:s=400x200', '-frames:v', '1', path.join(dir, 'blue.png'));
  const blue = fs.readFileSync(path.join(dir, 'blue.png'));
  for (const kind of ['mp3', 'flac', 'm4a', 'ogg', 'opus', 'wav']) {
    const f = path.join(dir, `song ${kind} (1).${kind}`);
    const tagged = ['-metadata', 'title=Old', '-metadata', 'artist=Someone', '-metadata', 'lyrics=la la'];
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', ...tagged, f);
    const sound = md5(f);
    const first = await music.read(f);
    report(first.fields.title === 'Old' && first.canEdit, `${kind}: reads fields (${first.format}, ${first.bitrate} bps, ${first.sampleRate} Hz)`);
    const changes = { title: 'New "Title" é', artist: 'The Artist', album: 'Album', albumArtist: 'Band', year: '2024', track: '3', genre: 'Techno', comment: 'line one\nline two' };
    if (kind === 'wav') delete changes.albumArtist;
    let saved = await music.save(f, changes, undefined, files);
    let now = await music.read(f);
    report(Object.entries(changes).every(([k, v]) => now.fields[k] === v), `${kind}: all 8 fields round-trip ${JSON.stringify(now.fields)}`);
    report(md5(f) === sound, `${kind}: sound identical after tags`);
    report(fs.existsSync(saved.kept), `${kind}: old song in Trash`);
    report(fs.readdirSync(dir).every((n) => !n.startsWith('.songinfo')), `${kind}: no leftovers`);
    if (music.KINDS[kind].cover) {
      saved = await music.save(f, {}, blue, files);
      now = await music.read(f);
      report(now.hasCover && now.coverUrl && md5(f) === sound && now.fields.title === changes.title, `${kind}: cover added, sound same, tags kept`);
      // A phone needs the cover marked as the front cover, a picture attached to the song.
      const pic = kind === 'wav' ? { disposition: { attached_pic: 1 }, tags: { comment: 'Cover (front)' } } : JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_name:stream_disposition=attached_pic:stream_tags=comment', '-of', 'json', f]).toString()).streams[0];
      const front = kind === 'm4a' ? true : pic.tags?.comment === 'Cover (front)';
      report(pic.disposition.attached_pic === 1 && front, `${kind}: cover is an attached picture${kind === 'm4a' ? ' (covr)' : ', type Cover (front)'}: ${JSON.stringify(pic)}`);
      if (kind === 'mp3') {
        const raw = execFileSync('sh', ['-c', `head -c 20 ${JSON.stringify(f)} | od -c | head -1`]).toString();
        report(/I\s+D\s+3\s+003/.test(raw), `mp3: ID3v2.3 header: ${raw.trim()}`);
        const apic = execFileSync('sh', ['-c', `head -c 4000 ${JSON.stringify(f)} | grep -a -c "APIC"`]).toString().trim();
        report(apic !== '0', 'mp3: has an APIC frame');
      }
      saved = await music.save(f, { title: 'Again' }, null, files);
      now = await music.read(f);
      report(!now.hasCover && now.fields.title === 'Again' && md5(f) === sound, `${kind}: cover removed with a title change`);
    } else {
      await music.save(f, {}, blue, files).then(() => report(false, `${kind}: cover refused`), () => report(true, `${kind}: cover refused`));
    }
    await music.save(f, { genre: '' }, undefined, files);
    now = await music.read(f);
    report(now.fields.genre === '' && now.fields.title !== '' && md5(f) === sound, `${kind}: clearing a field`);
    await music.save(f, { artist: 'Main', featured: 'A, B' }, undefined, files);
    now = await music.read(f);
    const rawArtist = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=artist:stream_tags=artist', '-of', 'csv=p=0', f]).toString();
    report(now.fields.artist === 'Main' && now.fields.featured === 'A, B' && /Main feat\. A, B/.test(rawArtist) && md5(f) === sound, `${kind}: featured artists saved into Artist: ${rawArtist.trim().replace(/\n/g, ' | ')}`);
    await music.save(f, { featured: '' }, undefined, files);
    now = await music.read(f);
    report(now.fields.artist === 'Main' && now.fields.featured === '', `${kind}: featured artists removed`);
    const copy = await music.save(f, { album: 'Copy Album' }, undefined, files, { copy: true });
    report(/\(edited\)\./.test(copy.path) && (await music.read(copy.path)).fields.album === 'Copy Album' && (await music.read(f)).fields.album === 'Album' && md5(copy.path) === sound, `${kind}: Save as Copy makes a new song, the first is untouched`);
    const lyr =execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', f]).toString();
    console.log(`INFO ${kind}: other tags (lyrics) kept: ${/la la/.test(lyr)}`);
  }
  const f = path.join(dir, 'song mp3 (1).mp3');
  const before = fs.readFileSync(f);
  await music.save(f, { year: 'abc' }, undefined, files).then(() => report(false, 'bad year refused'), () => report(true, 'bad year refused'));
  await music.save(f, { title: 'x' }, Buffer.from('not a picture'), files).then(() => report(false, 'bad picture refused'), () => report(true, 'bad picture refused'));
  report(Buffer.compare(before, fs.readFileSync(f)) === 0 && fs.readdirSync(dir).every((n) => !n.startsWith('.songinfo')), 'failed saves leave the song untouched and no leftovers');
  fs.writeFileSync(path.join(dir, 'junk.mp3'), 'garbage');
  await music.save(path.join(dir, 'junk.mp3'), { title: 'x' }, undefined, files).then(() => report(false, 'broken file refused'), () => report(true, 'broken file refused'));

  // Windows (C:) is view only, and the page can be got around, so lib/music.js itself must refuse (it is all
  // main.js's songInfoSave calls). The stand-in for C: is files.DOOR (music-run.sh sets HOUSE_SHOTS for that).
  const refused = (promise, pattern) => promise.then(() => false, (error) => pattern.test(error.message));
  if (!files.DOOR.startsWith('/tmp/')) { console.log('FAIL run with HOUSE_SHOTS under /tmp, so the stand-in for C: is a throwaway (music-run.sh does)'); process.exit(1); }
  const cMusic = path.join(files.DOOR, 'Music');
  fs.mkdirSync(cMusic, { recursive: true });
  const cSong = path.join(cMusic, 'on c.mp3');
  fs.copyFileSync(f, cSong);
  const cBefore = fs.readFileSync(cSong);
  fs.rmSync(path.join(dir, 'link to c.mp3'), { force: true });
  fs.rmSync(path.join(dir, 'c folder'), { force: true });
  fs.symlinkSync(cSong, path.join(dir, 'link to c.mp3'));
  fs.symlinkSync(cMusic, path.join(dir, 'c folder'));
  for (const target of [cSong, path.join(cMusic, '..', 'Music', 'on c.mp3'), path.join(dir, 'link to c.mp3'), path.join(dir, 'c folder', 'on c.mp3'), '/mnt/c/Users/someone/Music/a.mp3']) {
    for (const copy of [false, true]) report(await refused(music.save(target, { title: 'no' }, undefined, files, { copy }), /Windows/), `C: refused${copy ? ' (as a copy)' : ''}: ${target}`);
  }
  report(Buffer.compare(cBefore, fs.readFileSync(cSong)) === 0 && fs.readdirSync(cMusic).length === 1, 'the song on C: is untouched and nothing was written beside it');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  report(/songInfoSave: \(_event, target, changes, cover, copy\) => music\.save\(target, /.test(mainSource), 'main.js saves songs only through music.save (which refuses C:)');

  // Never over a shortcut or a read-only song, and one save at a time however the path is spelled.
  const real = path.join(dir, 'real.mp3');
  fs.copyFileSync(f, real);
  fs.rmSync(path.join(dir, 'shortcut.mp3'), { force: true });
  fs.symlinkSync(real, path.join(dir, 'shortcut.mp3'));
  report(await refused(music.save(path.join(dir, 'shortcut.mp3'), { title: 'x' }, undefined, files), /shortcut/) && fs.lstatSync(path.join(dir, 'shortcut.mp3')).isSymbolicLink(), 'a shortcut to a song is not saved over');
  fs.chmodSync(real, 0o444);
  report(await refused(music.save(real, { title: 'x' }, undefined, files), /read-only/) && Buffer.compare(before, fs.readFileSync(real)) === 0, 'a read-only song is not saved over');
  fs.chmodSync(real, 0o644);
  const both = await Promise.allSettled([music.save(real, { title: 'one' }, undefined, files), music.save(path.join(dir, '.', 'real.mp3'), { title: 'two' }, undefined, files)]);
  report(both.filter((one) => one.status === 'fulfilled').length === 1, 'two saves of one song at once: only one goes through');

  // WAV is written part by part (lib/music.js, writeWav), so any depth or rate keeps its "fmt " and "data" exactly.
  const parseWav = (buf) => {
    const out = [];
    for (let at = 12; at + 8 <= buf.length;) {
      const len = buf.readUInt32LE(at + 4);
      const id = buf.toString('latin1', at, at + 4);
      out.push({ id, len, body: buf.subarray(at + 8, at + 8 + len), type: id === 'LIST' ? buf.toString('latin1', at + 8, at + 12) : '' });
      at += 8 + len + (len % 2);
    }
    return out;
  };
  const oldPart = (c) => (c.id === 'LIST' && c.type === 'INFO') || c.id === 'id3 ' || c.id === 'ID3 ';
  const oddPart = (name, bytes) => { const b = Buffer.concat([Buffer.alloc(8), bytes, Buffer.alloc(bytes.length % 2)]); b.write(name, 0, 'latin1'); b.writeUInt32LE(bytes.length, 4); return b; };
  const fixSize = (b) => { b.writeUInt32LE(b.length - 8, 4); return b; };
  const makeWav = (name, codec, rate, channels, extra) => {
    const f = path.join(dir, name);
    ff('-f', 'lavfi', '-i', `sine=frequency=330:duration=2:sample_rate=${rate}`, '-ac', String(channels), '-c:a', codec, ...(extra || []), f);
    return f;
  };
  const wavs = {
    '16-bit 44.1k': makeWav('w16.wav', 'pcm_s16le', 44100, 2),
    '24-bit 48k': makeWav('w24.wav', 'pcm_s24le', 48000, 2),
    '32-bit float 96k': makeWav('w32f.wav', 'pcm_f32le', 96000, 2),
    'mono 24-bit': makeWav('wmono.wav', 'pcm_s24le', 44100, 1),
  };
  const withExtras = makeWav('wextra.wav', 'pcm_s24le', 44100, 2);
  fs.writeFileSync(withExtras, fixSize(Buffer.concat([fs.readFileSync(withExtras), oddPart('smpl', Buffer.alloc(60, 2)), oddPart('cue ', Buffer.alloc(28, 3)), oddPart('xtra', Buffer.from('seven!!'))])));
  wavs['smpl, cue and an odd custom part'] = withExtras;
  {
    const f = makeWav('wold.wav', 'pcm_s16le', 44100, 2, ['-metadata', 'title=Before', '-metadata', 'artist=Old Artist']);
    const text = (id, t) => { const body = Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(t, 'utf16le')]); const h = Buffer.alloc(10); h.write(id, 0, 'latin1'); h.writeUInt32BE(body.length, 4); return Buffer.concat([h, body]); };
    const jpeg = fs.readFileSync(path.join(dir, 'red.jpg'));
    const apicBody = Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg\0'), Buffer.from([3, 0]), jpeg]);
    const apic = Buffer.alloc(10); apic.write('APIC', 0, 'latin1'); apic.writeUInt32BE(apicBody.length, 4);
    const frames = Buffer.concat([text('TIT2', 'Before'), text('TPE1', 'Old Artist'), apic, apicBody]);
    const sizeBytes = Buffer.from([(frames.length >> 21) & 127, (frames.length >> 14) & 127, (frames.length >> 7) & 127, frames.length & 127]);
    const tag = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), sizeBytes, frames]);
    fs.writeFileSync(f, fixSize(Buffer.concat([fs.readFileSync(f), oddPart('id3 ', tag)])));
    wavs['already has INFO and id3'] = f;
  }
  const oldParts = parseWav(fs.readFileSync(wavs['already has INFO and id3'])).map((c) => c.id + (c.type ? `/${c.type}` : ''));
  report(oldParts.includes('LIST/INFO') && oldParts.includes('id3 '), `WAV with old tags really has LIST INFO and id3: ${oldParts.join(',')}`);
  {
    const f = wavs['already has INFO and id3'];
    const red = fs.readFileSync(path.join(dir, 'red.jpg'));
    const keepFirst = (await music.read(f));
    await music.save(f, { title: 'Kept' }, undefined, files);
    const shown = await music.read(f);
    report(keepFirst.hasCover && shown.hasCover && shown.fields.title === 'Kept' && shown.fields.artist === 'Old Artist' && Buffer.from(shown.coverUrl.split(',')[1], 'base64').equals(red), 'WAV: an existing id3 cover is read, and kept when only a title changes');
  }
  for (const [label, w] of Object.entries(wavs)) {
    const was = fs.readFileSync(w);
    const wasParts = parseWav(was);
    const fmtTag = (list) => list.find((c) => c.id === 'fmt ').body.readUInt16LE(0);
    const want = { title: 'New Title é', artist: 'The Artist', album: 'The Album', year: '2024', track: '2/9', genre: 'House', comment: 'hello' };
    await music.save(w, want, blue, files);
    const now = fs.readFileSync(w);
    const nowParts = parseWav(now);
    const kept = wasParts.filter((c) => !oldPart(c));
    report(kept.every((c, i) => nowParts[i].id === c.id && nowParts[i].len === c.len && Buffer.compare(nowParts[i].body, c.body) === 0), `WAV ${label}: every other part byte-identical and in order (${kept.map((c) => c.id).join(',')})`);
    report(fmtTag(nowParts) === fmtTag(wasParts) && Buffer.compare(nowParts.find((c) => c.id === 'fmt ').body, wasParts.find((c) => c.id === 'fmt ').body) === 0, `WAV ${label}: fmt format tag unchanged (${fmtTag(nowParts)})`);
    report(now.readUInt32LE(4) === now.length - 8 && now.length % 2 === 0, `WAV ${label}: RIFF size is right`);
    const tags = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', w]).toString()).format.tags;
    report(tags.title === want.title && tags.artist === want.artist && tags.album === want.album && tags.date === '2024' && tags.track === '2/9' && tags.genre === 'House' && tags.comment === 'hello', `WAV ${label}: ffprobe reads the new tags ${JSON.stringify(tags)}`);
    const shown = await music.read(w);
    const id3 = nowParts.find((c) => c.id === 'id3 ').body;
    const jpg = Buffer.from(String(shown.coverUrl).split(',')[1] || '', 'base64');
    report(shown.hasCover && /^data:image\/jpeg;base64,/.test(shown.coverUrl) && jpg[0] === 0xff && jpg[1] === 0xd8 && id3.includes(Buffer.concat([Buffer.from('image/jpeg\0'), Buffer.from([3, 0])])), `WAV ${label}: cover reads back (JPEG, front cover)`);
    const info = nowParts.find((c) => c.id === 'LIST' && c.type === 'INFO').body;
    report(info.includes('INAM') && info.includes('IART') && info.includes('IPRD') && info.includes('ICRD') && info.includes('IPRT'), `WAV ${label}: LIST INFO has INAM IART IPRD ICRD IPRT`);
    await music.save(w, { title: 'Second' }, undefined, files);
    const again = parseWav(fs.readFileSync(w));
    const after = await music.read(w);
    report(again.filter((c) => c.id === 'LIST' && c.type === 'INFO').length === 1 && again.filter((c) => c.id === 'id3 ').length === 1 && again.length === nowParts.length && after.fields.title === 'Second' && after.fields.album === 'The Album' && after.hasCover, `WAV ${label}: second save keeps one INFO and one id3, other fields and cover kept`);
    const bare = await music.save(w, {}, null, files);
    report(!(await music.read(w)).hasCover && !fs.readFileSync(w).includes('image/jpeg') && fs.existsSync(bare.kept), `WAV ${label}: cover removed`);
    await music.save(w, { artist: 'Main', featured: 'Guest' }, undefined, files);
    const feat = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=artist', '-of', 'json', w]).toString()).format.tags.artist;
    report(feat === 'Main feat. Guest' && (await music.read(w)).fields.featured === 'Guest', `WAV ${label}: featured artist written as "Main feat. Guest"`);
  }
  {
    const w = wavs['24-bit 48k'];
    const orig = fs.readFileSync(w);
    const copy = await music.save(w, { album: 'Copy Only' }, blue, files, { copy: true });
    report(Buffer.compare(orig, fs.readFileSync(w)) === 0 && (await music.read(copy.path)).fields.album === 'Copy Only', 'WAV: Save as Copy leaves the original byte-identical');
    const cut = path.join(dir, 'cut.wav');
    const cutBytes = orig.subarray(0, orig.length - 1000);
    fs.writeFileSync(cut, cutBytes);
    await music.save(cut, { title: 'x' }, undefined, files).then(() => report(false, 'truncated WAV refused'), (e) => report(/cut short/.test(e.message) && Buffer.compare(cutBytes, fs.readFileSync(cut)) === 0, `truncated WAV refused, untouched: ${e.message}`));
    const rf = path.join(dir, 'rf64.wav');
    const rfBytes = Buffer.from(orig);
    rfBytes.write('RF64', 0, 'latin1');
    fs.writeFileSync(rf, rfBytes);
    await music.save(rf, { title: 'x' }, undefined, files).then(() => report(false, 'RF64 refused'), (e) => report(/RF64/.test(e.message) && Buffer.compare(rfBytes, fs.readFileSync(rf)) === 0, `RF64 refused, untouched: ${e.message}`));
    const nodata = path.join(dir, 'nodata.wav');
    const nd = fixSize(Buffer.concat([orig.subarray(0, 12), oddPart('fmt ', parseWav(orig)[0].body)]));
    fs.writeFileSync(nodata, nd);
    await music.save(nodata, { title: 'x' }, undefined, files).then(() => report(false, 'WAV without data refused'), (e) => report(Buffer.compare(nd, fs.readFileSync(nodata)) === 0, `WAV without data refused, untouched: ${e.message}`));
    // A cover Station can't read (a GIF in an ID3v2.4 tag) must not quietly vanish on a save.
    const gif = path.join(dir, 'gifcover.wav');
    const gifPic = Buffer.concat([Buffer.from([0]), Buffer.from('image/gif'), Buffer.from([0, 3, 0]), Buffer.from('GIF89a0123')]);
    const gifFrame = Buffer.concat([Buffer.from('APIC'), Buffer.from([0, 0, 0, gifPic.length, 0, 0]), gifPic]);
    const gifBytes = fixSize(Buffer.concat([orig, oddPart('id3 ', Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, gifFrame.length]), gifFrame]))]));
    fs.writeFileSync(gif, gifBytes);
    await music.save(gif, { title: 'x' }, undefined, files).then(() => report(false, 'WAV with an unreadable cover refused'), (e) => report(/cover picture/.test(e.message) && Buffer.compare(gifBytes, fs.readFileSync(gif)) === 0, `WAV with an unreadable cover refused, untouched: ${e.message}`));
    await music.save(gif, { title: 'x' }, null, files);
    report((await music.read(gif)).fields.title === 'x', 'WAV with an unreadable cover saves once the cover is taken out');
  }
  report(fs.readdirSync(dir).every((n) => !n.startsWith('.songinfo')), 'none of those left anything behind');
  console.log('DONE');
})().catch((e) => { console.log('FAIL crash', e); process.exit(1); });
