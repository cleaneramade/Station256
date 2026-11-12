// Song info (renderer/music-info.js): the title, artist, album... and cover picture of a song, read and
// changed with the house's ffmpeg. Saving never re-makes the sound: ffmpeg copies it as it is into a new
// file beside the song, the new file is read back and checked (same tags, same cover, and the sound
// identical to the byte), and only then does it replace the song, with the old one kept in the Trash
// (files.replaceWith). If anything is off, the song is left exactly as it was.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

// Kinds that can be changed, and whether a cover picture can go in them.
// A bare .aac has nowhere to keep tags, so it isn't here.
const KINDS = {
  mp3: { cover: true }, flac: { cover: true }, m4a: { cover: true },
  ogg: { cover: false }, oga: { cover: false }, opus: { cover: false },
  wav: { cover: true, without: ['albumArtist'] }, // a WAV has nowhere to keep an album artist
};
const OGGISH = new Set(['ogg', 'oga', 'opus']);
const kindOf = (target) => path.extname(target).slice(1).toLowerCase();
const editable = (target) => Object.prototype.hasOwnProperty.call(KINDS, kindOf(target));

// Each field, and the names its tag goes by (the first is the one written when it has none yet).
const FIELDS = {
  title: ['title'], artist: ['artist'], album: ['album'], albumArtist: ['album_artist', 'albumartist'],
  year: ['date', 'year'], track: ['track', 'tracknumber'], genre: ['genre'], comment: ['comment', 'description'],
};
const MAX_COVER = 20 * 1024 * 1024;
const MAX_SHOWN_COVER = 8 * 1024 * 1024;

// Every ffmpeg and ffprobe at work on a song is remembered, so quitting stops them (main.js, before-quit)
// instead of leaving them writing with nobody to check or tidy up after them.
const running = new Set();
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = execFile(command, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000, killSignal: 'SIGKILL', windowsHide: true, ...options }, (error, stdout, stderr) => {
    running.delete(child);
    if (error) reject(Object.assign(error, { stderr: String(stderr || '') }));
    else resolve(stdout);
  });
  running.add(child);
});
// A save that is stopped this way fails, so the song stays as it was.
const cancelAll = () => { for (const child of running) child.kill('SIGKILL'); };
const quiet = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];

// Tags are looked up whatever their capitals, in the file's own tags and in its sound's.
function tagsOf(data) {
  const all = {};
  const sound = (data.streams || []).find((stream) => stream.codec_type === 'audio');
  for (const group of [sound?.tags, data.format?.tags]) {
    for (const [key, value] of Object.entries(group || {})) if (!(key.toLowerCase() in all)) all[key.toLowerCase()] = String(value);
  }
  return all;
}

function fieldValues(all) {
  const out = {};
  for (const [field, names] of Object.entries(FIELDS)) out[field] = names.map((name) => all[name]).find((value) => value !== undefined) ?? '';
  return out;
}

// Featured artists live inside Artist ("Main feat. A, B") so phone players show them. The page
// gets them apart: the main artist, and who is featured.
const FEATURING = /^(.*?)\s*[([]?\s*\b(?:feat\.?|ft\.?|featuring)\s+(.+?)\s*[)\]]?\s*$/i;
function splitArtist(text) {
  const found = FEATURING.exec(text || '');
  return found && found[1].trim() && found[2].trim() ? { main: found[1].trim(), featured: found[2].trim() } : { main: (text || '').trim(), featured: '' };
}
function shownFields(all) {
  const fields = fieldValues(all);
  const { main, featured } = splitArtist(fields.artist);
  return { ...fields, artist: main, featured };
}

const coverStreamOf = (data) => (data.streams || []).find((stream) => stream.codec_type === 'video' && (stream.disposition?.attached_pic || ['mjpeg', 'png', 'bmp'].includes(stream.codec_name)));

function probe(target) {
  return run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', target], { timeout: 30000 }).then((out) => {
    try { return JSON.parse(out); } catch { throw new Error('This song couldn\'t be read.'); }
  }, () => { throw new Error('This song couldn\'t be read.'); });
}

const mimeOf = (bytes) => (bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes[0] === 0x42 && bytes[1] === 0x4d ? 'image/bmp' : null);

// The cover as the file has it, as bytes (null if none).
async function coverBytes(target) {
  const out = await run('ffmpeg', [...quiet, '-i', target, '-map', '0:v:0', '-frames:v', '1', '-c', 'copy', '-f', 'image2pipe', '-'], { encoding: 'buffer', timeout: 30000 }).catch(() => null);
  return out && out.length ? out : null;
}

// What the page shows: the fields, the cover (as a picture the page can draw), and the facts.
async function read(target) {
  const data = await probe(target);
  const sound = (data.streams || []).find((stream) => stream.codec_type === 'audio');
  if (!sound) throw new Error('There\'s no sound in this file.');
  const all = tagsOf(data);
  const isWav = kindOf(target) === 'wav';
  const wavPicture = isWav ? await wavCover(target) : null; // ffmpeg doesn't see a picture inside a WAV's id3 part
  const cover = isWav ? wavPicture || coverStreamOf(data) : coverStreamOf(data);
  let coverUrl = null;
  let coverNote = '';
  if (cover) {
    const bytes = wavPicture ? wavPicture.bytes : await coverBytes(target);
    const mime = bytes && mimeOf(bytes);
    if (bytes && mime && bytes.length <= MAX_SHOWN_COVER) coverUrl = `data:${mime};base64,${bytes.toString('base64')}`;
    else coverNote = 'This song has a cover picture that can\'t be shown here.';
  }
  const kind = kindOf(target);
  return {
    fields: shownFields(all),
    hasCover: Boolean(cover), coverUrl, coverNote,
    kind, canEdit: editable(target), canCover: Boolean(KINDS[kind]?.cover), without: KINDS[kind]?.without || [],
    length: Number(data.format?.duration) || Number(sound.duration) || 0,
    format: (data.format?.format_long_name || kind).replace(/\s*\(.*\)$/, ''),
    codec: sound.codec_name || '',
    bitrate: Number(sound.bit_rate) || Number(data.format?.bit_rate) || 0,
    sampleRate: Number(sound.sample_rate) || 0,
    channels: Number(sound.channels) || 0,
  };
}

// The new fields as the page sent them: only the ones that changed, made plain and safe.
function cleanChanges(raw) {
  const out = {};
  for (const [field, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if ((!Object.prototype.hasOwnProperty.call(FIELDS, field) && field !== 'featured') || typeof value !== 'string') continue;
    // eslint-disable-next-line no-control-regex
    const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
    if (text.length > 2000) throw new Error(`The ${field === 'albumArtist' ? 'album artist' : field} is too long.`);
    if (field === 'year' && text && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(text)) throw new Error('The year should be four digits, like 2024.');
    if (field === 'track' && text && !/^\d{1,4}(\/\d{1,4})?$/.test(text)) throw new Error('The track number should be a number, like 3 or 3/12.');
    out[field] = text;
  }
  return out;
}

const same = (a, b) => (a || '').replace(/\r/g, '').trim() === (b || '').replace(/\r/g, '').trim();
const soundHash = (file) => run('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-'], { timeout: 600000 })
  .then((out) => out.trim(), () => { throw new Error('The new song couldn\'t be checked, so nothing was changed.'); });

// Why ffmpeg couldn't write the new file, in plain words (its own words mean nothing to most people).
function whyNotSaved(stderr) {
  if (/No space left/i.test(stderr)) return 'The song couldn\'t be saved: the drive is full.';
  if (/Permission denied|Read-only file system/i.test(stderr)) return 'The song couldn\'t be saved: this folder can\'t be changed.';
  if (/Could not write header|incorrect codec parameters|not currently supported in container/i.test(stderr)) return 'The song couldn\'t be saved. It may not really be the kind of file its name says.';
  return 'The song couldn\'t be saved, so nothing was changed.';
}

// A WAV is written here, part by part (RIFF), not by ffmpeg: ffmpeg rewrites the "fmt " part of anything
// over 16-bit or 48 kHz and drops parts like smpl and cue. Every part is copied as it is, in its order,
// except the old song info (LIST INFO) and ID3 parts, which are replaced by new ones at the end.
const WAV_BUF = 1024 * 1024;
const WAV_MAX_TAG = 40 * 1024 * 1024;
const wavBad = (why) => new Error(`This WAV can't be saved: ${why} Nothing was changed.`);
const isOldInfo = (part) => (part.id === 'LIST' && part.type === 'INFO') || part.id === 'id3 ' || part.id === 'ID3 ';
const INFO_IDS = { title: 'INAM', artist: 'IART', album: 'IPRD', year: 'ICRD', track: 'IPRT', genre: 'IGNR', comment: 'ICMT' };

// The parts of a WAV: [{ id, at, len, type }], refusing anything that isn't a plain, whole, under-4-GB WAV.
async function wavScan(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size >= 2 ** 32) throw wavBad('it is bigger than 4 GB.');
    const head = Buffer.alloc(12);
    if ((await handle.read(head, 0, 12, 0)).bytesRead < 12) throw wavBad('it is not a WAV file.');
    const tag = head.toString('latin1', 0, 4);
    if (tag === 'RF64' || tag === 'BW64') throw wavBad('it is an RF64 (very large) WAV, which can\'t be handled here.');
    if (tag !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') throw wavBad('it is not a WAV file.');
    const parts = [];
    const h = Buffer.alloc(12);
    for (let at = 12; at < size;) {
      if (at + 8 > size) throw wavBad('it ends in the middle of a part.');
      const { bytesRead } = await handle.read(h, 0, 12, at);
      const len = h.readUInt32LE(4);
      if (at + 8 + len > size) throw wavBad('it is cut short (a part runs past the end of the file).');
      const id = h.toString('latin1', 0, 4);
      parts.push({ id, at, len, type: id === 'LIST' && len >= 4 && bytesRead >= 12 ? h.toString('latin1', 8, 12) : '' });
      at += 8 + len + (len % 2);
      if (parts.length > 100000) throw wavBad('it has too many parts.');
    }
    if (!parts.some((part) => part.id === 'fmt ')) throw wavBad('it has no "fmt " part.');
    if (!parts.some((part) => part.id === 'data')) throw wavBad('it has no sound ("data") part.');
    return { size, parts };
  } finally {
    await handle.close();
  }
}

const readRange = async (handle, at, len) => {
  const out = Buffer.alloc(len);
  const { bytesRead } = await handle.read(out, 0, len, at);
  if (bytesRead < len) throw wavBad('it could not be read to the end.');
  return out;
};

// A part's name, size and bytes, fingerprinted without holding it in memory.
async function hashPart(handle, part) {
  const hash = crypto.createHash('sha256');
  hash.update(`${part.id}:${part.len}:`);
  const buf = Buffer.alloc(Math.min(WAV_BUF, Math.max(part.len, 1)));
  for (let done = 0; done < part.len;) {
    const want = Math.min(buf.length, part.len - done);
    const { bytesRead } = await handle.read(buf, 0, want, part.at + 8 + done);
    if (bytesRead <= 0) throw wavBad('it could not be read to the end.');
    hash.update(buf.subarray(0, bytesRead));
    done += bytesRead;
  }
  return hash.digest('hex');
}

// ID3v2 text (UTF-16 with a byte order mark), frames, and the picture inside a tag.
const syncsafe = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const id3Frame = (id, body) => { const head = Buffer.alloc(10); head.write(id, 0, 'latin1'); head.writeUInt32BE(body.length, 4); return Buffer.concat([head, body]); };
const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const id3Text = (id, text) => id3Frame(id, Buffer.concat([Buffer.from([1]), utf16(text)]));

function apicOf(tag) {
  if (tag.length < 10 || tag.toString('latin1', 0, 3) !== 'ID3') return null;
  const version = tag[3];
  const end = Math.min(tag.length, 10 + ((tag[6] << 21) | (tag[7] << 14) | (tag[8] << 7) | tag[9]));
  for (let at = 10; at + 10 <= end;) {
    const id = tag.toString('latin1', at, at + 4);
    const size = version === 4 ? ((tag[at + 4] << 21) | (tag[at + 5] << 14) | (tag[at + 6] << 7) | tag[at + 7]) : tag.readUInt32BE(at + 4);
    if (!/^[A-Z0-9]{4}$/.test(id) || at + 10 + size > end) return null;
    if (id === 'APIC') {
      const body = tag.subarray(at + 10, at + 10 + size);
      const encoding = body[0];
      let i = body.indexOf(0, 1) + 1; // after the picture type's name
      if (i <= 0) return null;
      i += 1; // the picture type
      if (encoding === 1 || encoding === 2) { while (i + 1 < body.length && (body[i] !== 0 || body[i + 1] !== 0)) i += 2; i += 2; } else { i = body.indexOf(0, i) + 1; if (i <= 0) return null; }
      return i < body.length ? Buffer.from(body.subarray(i)) : null;
    }
    at += 10 + size;
  }
  return null;
}

// The cover picture inside a WAV's id3 part (null if none): { bytes, mime }.
async function wavCover(file) {
  const { parts } = await wavScan(file).catch(() => ({ parts: [] }));
  const part = parts.find((one) => (one.id === 'id3 ' || one.id === 'ID3 ') && one.len <= WAV_MAX_TAG);
  if (!part) return null;
  const handle = await fs.open(file, 'r');
  try {
    const bytes = apicOf(await readRange(handle, part.at + 8, part.len));
    const mime = bytes && mimeOf(bytes);
    return mime ? { bytes, mime } : null;
  } finally {
    await handle.close();
  }
}

// Whether a WAV's id3 part holds a picture at all, readable here or not (GIF, ID3v2.2, an odd tag...).
async function wavHasPicture(file, scan) {
  const handle = await fs.open(file, 'r');
  try {
    for (const part of scan.parts) {
      if ((part.id !== 'id3 ' && part.id !== 'ID3 ') || part.len > WAV_MAX_TAG) continue;
      const tag = await readRange(handle, part.at + 8, part.len);
      if (tag.includes('APIC', 0, 'latin1') || (tag[3] === 2 && tag.includes('PIC', 10, 'latin1'))) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}

const evenPad = (buf) => (buf.length % 2 ? Buffer.concat([buf, Buffer.alloc(1)]) : buf);
const riffPart = (id, body) => { const head = Buffer.alloc(8); head.write(id, 0, 'latin1'); head.writeUInt32LE(body.length, 4); return evenPad(Buffer.concat([head, body])); };

// Writes temp: every part of target as it is, except the old song info, then the new song info and ID3.
// values: title, artist, album, year, track, genre, comment. picture: { bytes, mime } or null.
async function writeWav(target, temp, scan, values, picture) {
  // The old LIST INFO entries this doesn't write are carried over (copyright, software...).
  const input = await fs.open(target, 'r');
  const output = await fs.open(temp, 'wx', 0o644);
  try {
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1'); head.write('WAVE', 8, 'latin1');
    await output.write(head, 0, 12, 0);
    let pos = 12;
    const extra = [];
    const buf = Buffer.alloc(WAV_BUF);
    for (const part of scan.parts) {
      // Old song info too big to read through is never just dropped.
      if (isOldInfo(part) && part.len > WAV_MAX_TAG) throw wavBad('its song info is too big to carry over.');
      if (part.id === 'LIST' && part.type === 'INFO') {
        const body = await readRange(input, part.at + 12, part.len - 4);
        for (let at = 0; at + 8 <= body.length;) {
          const id = body.toString('latin1', at, at + 4);
          const len = body.readUInt32LE(at + 4);
          if (at + 8 + len > body.length) break;
          if (!Object.values(INFO_IDS).includes(id)) extra.push(riffPart(id, body.subarray(at + 8, at + 8 + len)));
          at += 8 + len + (len % 2);
        }
      }
      if (isOldInfo(part)) continue;
      const total = 8 + part.len + (part.len % 2);
      for (let done = 0; done < total;) {
        const want = Math.min(buf.length, total - done);
        buf.fill(0, 0, want);
        await input.read(buf, 0, Math.min(want, Math.max(0, 8 + part.len - done)), part.at + done);
        await output.write(buf, 0, want, pos + done);
        done += want;
      }
      pos += total;
    }
    const entries = [];
    for (const [field, id] of Object.entries(INFO_IDS)) if (values[field]) entries.push(riffPart(id, Buffer.from(`${values[field]}\0`, 'utf8')));
    const info = riffPart('LIST', Buffer.concat([Buffer.from('INFO', 'latin1'), ...entries, ...extra]));
    const frames = [];
    const year = values.year || '';
    for (const [field, id] of [['title', 'TIT2'], ['artist', 'TPE1'], ['album', 'TALB'], ['track', 'TRCK'], ['genre', 'TCON']]) if (values[field]) frames.push(id3Text(id, values[field]));
    if (year) {
      frames.push(id3Text('TYER', year.slice(0, 4)));
      const day = /^\d{4}-(\d{2})-(\d{2})$/.exec(year);
      if (day) frames.push(id3Text('TDAT', `${day[2]}${day[1]}`));
    }
    if (values.comment) frames.push(id3Frame('COMM', Buffer.concat([Buffer.from([1]), Buffer.from('eng', 'latin1'), Buffer.from([0xff, 0xfe, 0, 0]), utf16(values.comment)])));
    if (picture) frames.push(id3Frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from(`${picture.mime}\0`, 'latin1'), Buffer.from([3, 0]), picture.bytes])));
    const body = Buffer.concat(frames);
    const tag = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(body.length), body]);
    const tail = Buffer.concat([info, riffPart('id3 ', tag)]);
    if (pos + tail.length >= 2 ** 32) throw wavBad('the result would be bigger than 4 GB.');
    await output.write(tail, 0, tail.length, pos);
    pos += tail.length;
    const size = Buffer.alloc(4);
    size.writeUInt32LE(pos - 8, 0);
    await output.write(size, 0, 4, 4);
    await output.sync();
  } finally {
    await input.close();
    await output.close();
  }
}

// The new WAV must be the old one with only the song info and ID3 parts swapped: every other part
// byte-identical and in the same order, the "fmt " and "data" included, and the RIFF size right.
async function checkWav(target, temp, scan) {
  const failed = () => new Error('The new WAV didn\'t come out the same as the song, so nothing was changed.');
  const now = await wavScan(temp).catch(() => { throw failed(); });
  const kept = scan.parts.filter((part) => !isOldInfo(part));
  const [a, b] = await Promise.all([fs.open(target, 'r'), fs.open(temp, 'r')]);
  try {
    const head = await readRange(b, 4, 4);
    if (head.readUInt32LE(0) !== now.size - 8 || now.size % 2) throw failed();
    const rest = now.parts.slice(kept.length);
    if (now.parts.length !== kept.length + 2 || rest[0].id !== 'LIST' || rest[0].type !== 'INFO' || rest[1].id !== 'id3 ') throw failed();
    for (let i = 0; i < kept.length; i += 1) {
      if (kept[i].id !== now.parts[i].id || kept[i].len !== now.parts[i].len) throw failed();
      if ((await hashPart(a, kept[i])) !== (await hashPart(b, now.parts[i]))) throw failed();
    }
  } finally {
    await a.close();
    await b.close();
  }
}

// A picked picture made into a plain JPEG no bigger than 1400 pixels: every player reads that.
async function prepareCover(bytes, dir, stem) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_COVER) throw new Error('That picture is too big to use as a cover.');
  const input = path.join(dir, `${stem}.cover-in`);
  const output = path.join(dir, `${stem}.cover.jpg`);
  await fs.writeFile(input, bytes);
  try {
    await run('ffmpeg', [...quiet, '-i', input, '-frames:v', '1', '-vf', "scale='min(1400,iw)':-2", '-pix_fmt', 'yuvj420p', '-q:v', '2', output], { timeout: 60000 });
  } catch {
    await fs.rm(output, { force: true });
    throw new Error('That picture couldn\'t be read. Try a JPEG or PNG.');
  } finally {
    await fs.rm(input, { force: true });
  }
  return output;
}

const saving = new Set();

// changes: the fields that changed. cover: undefined keeps it, null takes it out, bytes put a new one in.
// files: lib/files.js, which does the Trash-and-replace. Returns { path, kept } (kept: for Undo).
// copy: true makes "name (edited)" beside it instead, and { path } is the new song.
async function save(target, rawChanges, cover, files, { copy = false } = {}) {
  await files.assertAllowed(target);
  if (files.inTrash(target)) throw new Error('Songs in the Trash can\'t be changed. Restore it first.');
  if (!editable(target)) throw new Error('Song info of this kind of file can\'t be changed here.');
  const changes = cleanChanges(rawChanges);
  const kind = kindOf(target);
  if (Object.keys(changes).some((field) => KINDS[kind].without?.includes(field))) throw new Error('This kind of song cannot keep that info.');
  if (cover !== undefined && !KINDS[kind].cover) throw new Error('This kind of song can\'t hold a cover picture.');
  const dir = path.dirname(target);
  if (!copy) {
    // Saving over a shortcut would swap the shortcut for a file and leave the real song as it was.
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('This is a shortcut to a song. Open the song itself to change it, or use Save as Copy.');
    // A song marked read-only was marked so on purpose.
    await fs.access(target, fs.constants.W_OK).catch(() => { throw new Error('This song is read-only, so it can\'t be saved over. Use Save as Copy.'); });
  }
  await fs.access(dir, fs.constants.W_OK).catch(() => { throw new Error('This folder can\'t be changed, so the song can\'t be saved here.'); });
  // One save at a time per song, however its path was spelled.
  const key = await fs.realpath(target).catch(() => path.resolve(target));
  if (saving.has(key)) throw new Error('This song is already being saved.');
  saving.add(key);
  const stem = `.songinfo-${crypto.randomBytes(5).toString('hex')}`;
  const temp = path.join(dir, `${stem}${path.extname(target)}`);
  let coverFile = null;
  try {
    const asItWas = await fs.stat(target);
    const wavScanned = kind === 'wav' ? await wavScan(target) : null;
    const before = await probe(target);
    const current = tagsOf(before);
    const oldPicture = kind === 'wav' ? await wavCover(target) : null;
    const hadCover = kind === 'wav' ? Boolean(oldPicture) : Boolean(coverStreamOf(before));
    // A cover this can't read (a GIF, an ID3v2.2 tag...) can't be carried into the new file, and is never dropped unasked.
    if (kind === 'wav' && !oldPicture && cover === undefined && (coverStreamOf(before) || await wavHasPicture(target, wavScanned))) {
      throw wavBad('it has a cover picture of a kind that can\'t be carried over. Pick a new cover (or remove it) and save again.');
    }
    // Artist and Featured artists are one tag: "Main feat. A, B".
    if ('artist' in changes || 'featured' in changes) {
      const now = splitArtist(current.artist);
      const main = 'artist' in changes ? changes.artist : now.main;
      const featured = ('featured' in changes ? changes.featured : now.featured).replace(/^(?:feat\.?|ft\.?|featuring)\s+/i, '').trim();
      if (featured && !main) throw new Error('Add the main artist as well as the featured artists.');
      delete changes.featured;
      if ((main + (featured ? ` feat. ${featured}` : '')) === (current.artist || '').trim()) delete changes.artist;
      else changes.artist = main + (featured ? ` feat. ${featured}` : '');
    }
    if (!Object.keys(changes).length && cover === undefined) throw new Error('Nothing was changed.');
    if (cover instanceof Uint8Array) coverFile = await prepareCover(cover, dir, stem);

    const expected = {};
    if (kind === 'wav') {
      for (const field of Object.keys(changes)) expected[field] = changes[field];
      let picture = oldPicture;
      if (coverFile) { const bytes = await fs.readFile(coverFile); picture = { bytes, mime: mimeOf(bytes) }; } else if (cover === null) picture = null;
      await writeWav(target, temp, wavScanned, { ...fieldValues(current), ...changes }, picture);
    } else {
    const args = [...quiet, '-i', target];
    if (coverFile) args.push('-i', coverFile);
    args.push('-map', '0');
    if (cover !== undefined) args.push('-map', '-0:v'); // the old cover out, for a new one or none
    if (coverFile) args.push('-map', '1:v');
    args.push('-c', 'copy', '-map_metadata', '0');
    if (kind === 'mp3') args.push('-id3v2_version', '3');
    for (const [field, value] of Object.entries(changes)) {
      const names = FIELDS[field];
      const present = names.filter((name) => name in current);
      for (const name of present.length ? present : [names[0]]) {
        args.push('-metadata', `${name}=${value}`);
        // Ogg keeps its tags on the sound itself, and those win over the file's, so they're set there too.
        if (OGGISH.has(kind)) args.push('-metadata:s:a:0', `${name}=${value}`);
      }
      expected[field] = value;
    }
    if (coverFile) {
      args.push('-disposition:v:0', 'attached_pic', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
    }
    args.push(temp);
    await run('ffmpeg', args, { timeout: 600000 }).catch((error) => { throw new Error(whyNotSaved(String(error.stderr || ''))); });
    }

    // Read it back: it only replaces the song if it really is the song, with what was asked.
    let after;
    if (kind === 'wav') {
      // A WAV is checked part by part: everything but the song info is byte-identical (checkWav).
      await checkWav(target, temp, wavScanned);
      after = await probe(temp);
    } else {
      const [probed, soundBefore, soundAfter] = await Promise.all([probe(temp), soundHash(target), soundHash(temp)]);
      if (soundBefore !== soundAfter) throw new Error('The song\'s sound didn\'t come out the same, so nothing was changed.');
      after = probed;
    }
    const back = fieldValues(tagsOf(after));
    const wrong = Object.keys(expected).find((field) => !same(back[field], expected[field]));
    if (wrong) throw new Error('The new info didn\'t save properly, so nothing was changed.');
    const others = Object.keys(FIELDS).find((field) => !(field in expected) && !same(back[field], fieldValues(current)[field]));
    if (others) throw new Error('Some of the song\'s other info would have been lost, so nothing was changed.');
    // Nothing else the song carries (lyrics, ratings...) may go missing either; a kind that can't keep it is left alone.
    const kept = tagsOf(after);
    const lost = Object.keys(current).find((key) => key !== 'encoder' && !(key in kept) && !Object.values(FIELDS).flat().includes(key));
    if (lost) throw new Error('Some other info in this song (such as lyrics) cannot be kept in this kind of file, so nothing was changed.');
    const hasCover = kind === 'wav' ? Boolean(await wavCover(temp)) : Boolean(coverStreamOf(after));
    if ((cover === undefined ? hadCover : cover !== null) !== hasCover) throw new Error('The cover picture didn\'t save properly, so nothing was changed.');

    // If another program wrote the song while this was at work, the new file was made from the older one.
    const asItIs = await fs.stat(target);
    if (asItIs.mtimeMs !== asItWas.mtimeMs || asItIs.size !== asItWas.size) throw new Error('This song was changed by another program just now, so nothing was saved. Try again.');
    await fs.chmod(temp, asItIs.mode & 0o777).catch(() => {});
    if (copy) {
      const stem = path.basename(target, path.extname(target)).replace(/ \(edited(?: \d+)?\)$/, '');
      return { path: await files.placeFile(temp, dir, `${stem} (edited)${path.extname(target)}`) };
    }
    return await files.replaceWith(target, temp);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  } finally {
    saving.delete(key);
    if (coverFile) await fs.rm(coverFile, { force: true }).catch(() => {});
  }
}

module.exports = { read, save, cancelAll, editable, cleanChanges, KINDS };
