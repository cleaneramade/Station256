// Videos opened in a page of their own (renderer/video-tab.js), done with the house's ffmpeg: what's
// in one, a strip of its frames for the timeline, a copy the page can play when it can't play the
// video itself (AVI, WMV, HEVC...), a quick trim saved as a new video, and the copies the video
// editor reads and saves.
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const { unlinkSync } = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const CACHE = path.join(os.homedir(), '.cache', 'house', 'videos');
const VERSION = 1; // bump to make every strip and playable copy again
const STRIP_FRAMES = 10;
const STRIP_HEIGHT = 90;
const PLAYABLE_HEIGHT = 720;
const KEEP_BYTES = 3 * 1024 * 1024 * 1024; // playable copies and strips: 3 GB at most
const SHORTEST = 0.04; // about a frame
// The hidden files being saved beside videos, written down so one left by a crash or a power cut
// can be cleared away next time (tidy). Only what's listed here is ever removed.
const SAVING_LIST = path.join(os.homedir(), '.local', 'state', 'house', 'video-saving.json');
const SAVING_NAME = /^\.saving-[0-9a-f]{10}\.[a-z0-9]+$/;
const SAVING_OLD = 5 * 60 * 1000;
const EXPORT_SPARE = 200 * 1024 * 1024; // room left on the disk after an export is saved

// Saved over itself only as the same kind; anything else is saved as an MP4 copy.
const REPLACEABLE = /\.(mp4|m4v|mov|mkv|webm)$/i;
// What the page's player can play by itself (Chromium in Electron).
const PLAYS_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
const PLAYS_AUDIO = /^(aac|mp3|opus|vorbis|flac|pcm_.+)$/;
const PLAYS_IN = /\.(mp4|m4v|mov|mkv|webm|ogv)$/i;
// What the video editor (../editor) reads as it is: these pictures and sounds, in these files.
const EDITOR_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const EDITOR_IN = /\.(mp4|m4v|mov|mkv|webm)$/i;
// HDR pictures (iPhone videos, for one) toned to normal range, as the editor shows and saves them.
const TONE_DOWN = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

const quiet = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
const exists = (file) => fs.access(file).then(() => true, () => false);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const number = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

// How long it is, its size as shown (a phone video turned on its side counts as turned), whether it
// has sound, and whether the page can play it as it is.
function probe(target) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', target], { maxBuffer: 16 * 1024 * 1024, timeout: 30000 }, (error, stdout) => {
      let data = null;
      try { data = error ? null : JSON.parse(stdout); } catch { data = null; }
      const streams = data?.streams || [];
      const picture = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
      if (!picture) {
        reject(new Error(data ? 'There\'s no picture in this video.' : 'This video couldn\'t be read.'));
        return;
      }
      const sound = streams.find((stream) => stream.codec_type === 'audio');
      let rotation = 0;
      for (const side of picture.side_data_list || []) if (typeof side.rotation === 'number') rotation = side.rotation;
      if (!rotation && picture.tags?.rotate) rotation = Number(picture.tags.rotate) || 0;
      let width = Number(picture.width) || 0;
      let height = Number(picture.height) || 0;
      const [sarW, sarH] = String(picture.sample_aspect_ratio || '1:1').split(':').map(Number);
      if (sarW > 0 && sarH > 0 && sarW !== sarH) width = Math.round((width * sarW) / sarH);
      if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
      const [rateTop, rateBottom] = String(picture.avg_frame_rate || picture.r_frame_rate || '30/1').split('/').map(Number);
      const fps = rateTop > 0 && rateBottom > 0 ? rateTop / rateBottom : 30;
      const duration = Number(data.format?.duration) || Number(picture.duration) || 0;
      const plays = PLAYS_IN.test(target) && PLAYS_VIDEO.has(picture.codec_name) && (!sound || PLAYS_AUDIO.test(sound.codec_name || ''));
      const edits = EDITOR_IN.test(target) && EDITOR_VIDEO.has(picture.codec_name) && (!sound || PLAYS_AUDIO.test(sound.codec_name || ''));
      const hdr = /smpte2084|arib-std-b67/.test(picture.color_transfer || '');
      resolve({ duration, width, height, fps: Math.round(fps * 1000) / 1000, sound: Boolean(sound), plays, edits, hdr });
    });
  });
}

// The trim as the page sent it, made safe: both times inside the video.
function cleanPlan(raw, duration) {
  const plan = raw && typeof raw === 'object' ? raw : {};
  const start = clamp(number(plan.start, 0), 0, duration);
  const end = clamp(number(plan.end, duration), start, duration);
  return { start, end, mute: plan.mute === true };
}

const fixed = (value) => Number(value.toFixed(4)).toString();

// How each kind is made. A video saved over itself stays its own kind; a copy of a kind that can't
// be saved again (AVI, WMV...) is an MP4.
function encoderFor(ext) {
  if (ext === 'webm') return ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-c:a', 'libopus', '-b:a', '128k'];
  const mp4ish = ext === 'mkv' ? [] : ['-movflags', '+faststart'];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', ...mp4ish];
}

// ffmpeg jobs that report how far along they are and can be stopped. running: every ffmpeg going,
// named or not, so none is left working after Station 256 quits.
const jobs = new Map();
const running = new Set();

function ffmpegJob(args, length, onProgress, job) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('ffmpeg', [...quiet, '-progress', 'pipe:1', '-nostats', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      reject(new Error('ffmpeg isn\'t in the house. Installing it is in the rebuild steps.'));
      return;
    }
    const entry = { child, stopped: false };
    if (job) jobs.set(job, entry);
    running.add(entry);
    let said = '';
    let errors = '';
    child.stdout.on('data', (chunk) => {
      said = (said + chunk.toString()).slice(-4096);
      const lines = said.split('\n');
      said = lines.pop();
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line) || /^out_time_ms=(\d+)/.exec(line);
        if (match && length > 0) onProgress?.(clamp(Number(match[1]) / 1e6 / length, 0, 0.999));
      }
    });
    child.stderr.on('data', (chunk) => { errors = (errors + chunk.toString()).slice(-2000); });
    child.on('error', () => {
      if (job) jobs.delete(job);
      running.delete(entry);
      reject(new Error('ffmpeg isn\'t in the house. Installing it is in the rebuild steps.'));
    });
    child.on('close', (code) => {
      if (job) jobs.delete(job);
      running.delete(entry);
      if (entry.stopped) reject(Object.assign(new Error('Stopped.'), { stopped: true }));
      else if (code === 0) resolve();
      else {
        if (errors) console.error('ffmpeg:', errors.trim());
        reject(new Error('ffmpeg couldn\'t make the video.'));
      }
    });
  });
}

function cancel(job) {
  const entry = jobs.get(job);
  if (!entry) return false;
  entry.stopped = true;
  entry.child.kill('SIGKILL');
  return true;
}

// Station 256 is quitting: nothing is left running, and no half-saved video is left hidden beside
// the real one. Pieces in the cache folder are cleared away by tidy.
function cancelAll() {
  for (const entry of running) {
    entry.stopped = true;
    entry.child.kill('SIGKILL');
  }
  for (const temp of saving) {
    try { unlinkSync(temp); } catch { /* not there, or already moved into place */ }
  }
}

// The hidden files being written now, and the same list kept on disk, changed one at a time.
const saving = new Set();
let listTurn = Promise.resolve();
const savingList = () => fs.readFile(SAVING_LIST, 'utf8').then((text) => JSON.parse(text), () => [])
  .then((list) => (Array.isArray(list) ? list.filter((item) => typeof item === 'string') : []), () => []);
function noteSaving(change) {
  listTurn = listTurn.then(async () => {
    const list = new Set(await savingList());
    change(list);
    await fs.mkdir(path.dirname(SAVING_LIST), { recursive: true });
    await fs.writeFile(SAVING_LIST, JSON.stringify([...list]));
  }).catch(() => {});
  return listTurn;
}

// The trimmed video, written as a hidden file in dir. The caller gives it its name, or puts it in
// place of the old one. Resolves to that file and how long the new video is.
async function render(target, raw, { dir, ext, job, onProgress }) {
  const info = await probe(target);
  const plan = cleanPlan(raw, info.duration);
  const length = plan.end - plan.start;
  if (length < SHORTEST) throw new Error('Nothing of the video would be left.');
  const temp = path.join(dir, `.saving-${crypto.randomBytes(5).toString('hex')}.${ext}`);
  saving.add(temp);
  await noteSaving((list) => list.add(temp));
  // Read only from the first kept moment to the last.
  const args = [
    '-ss', fixed(plan.start), '-t', fixed(length), '-i', target,
    '-map', '0:V:0', ...(info.sound && !plan.mute ? ['-map', '0:a:0'] : ['-an']), // V: the picture, never a cover image
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    '-map_metadata', '0', ...encoderFor(ext), temp,
  ];
  try {
    await ffmpegJob(args, length, onProgress, job);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  } finally {
    saving.delete(temp);
    noteSaving((list) => list.delete(temp));
  }
  return { temp, length };
}

const keyFor = (target, info, what) => crypto.createHash('sha1').update(`${VERSION}\0${what}\0${target}\0${info.size}\0${info.mtimeMs}`).digest('hex');

// A row of frames from across the video, for the timeline behind the trim handles. Made once.
const strips = new Map();
async function stripFor(target) {
  const stat = await fs.stat(target);
  if (!stat.isFile()) return null;
  const out = path.join(CACHE, `${keyFor(target, stat, 'strip')}.webp`);
  if (await exists(out)) return out;
  if (!strips.has(out)) {
    strips.set(out, (async () => {
      const info = await probe(target);
      await fs.mkdir(CACHE, { recursive: true });
      const temp = `${out}.${process.pid}.part`;
      const each = `scale=-2:${STRIP_HEIGHT},setsar=1`;
      // One quick jump to each moment, one frame at a time, each the nearest whole frame before
      // it, on two threads. All ten read at once took 4.7 GB for a 4K video (1.6 GB for 1080p),
      // enough to run the house out of memory, and every core while the video was trying to play.
      // A video that won't jump is read through once instead.
      const times = Array.from({ length: STRIP_FRAMES }, (_, i) => Math.max(0, Math.min(info.duration - 0.2, (info.duration * (i + 0.5)) / STRIP_FRAMES)));
      const pieces = times.map((_, i) => `${out}.${process.pid}.${i}.part`);
      let made = true;
      for (let i = 0; made && i < times.length; i += 1) {
        made = await ffmpegJob(['-threads', '2', '-noaccurate_seek', '-ss', fixed(times[i]), '-i', target, '-frames:v', '1', '-vf', each, '-c:v', 'png', '-f', 'image2', '-update', '1', pieces[i]], 0, null, null).then(() => true, () => false);
      }
      if (made) made = await ffmpegJob([...pieces.flatMap((piece) => ['-f', 'image2', '-i', piece]), '-filter_complex', `hstack=inputs=${STRIP_FRAMES}`, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '70', '-f', 'webp', temp], 0, null, null).then(() => true, () => false);
      await Promise.all(pieces.map((piece) => fs.rm(piece, { force: true })));
      if (!made) {
        const rate = STRIP_FRAMES / Math.max(info.duration, 0.1);
        made = await ffmpegJob(['-threads', '2', '-i', target, '-vf', `fps=${fixed(rate)},${each},tile=${STRIP_FRAMES}x1`, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '70', '-f', 'webp', temp], 0, null, null).then(() => true, () => false);
      }
      if (made) made = await fs.stat(temp).then((info2) => info2.size > 0, () => false);
      if (!made) {
        await fs.rm(temp, { force: true });
        return null;
      }
      await fs.rename(temp, out);
      return out;
    })().finally(() => strips.delete(out)));
  }
  return strips.get(out);
}

// A copy the page can play, for a video it can't (AVI, WMV, HEVC, AC-3 sound...). Only for watching
// and editing here: saving always reads the video itself. made=false: only if it's already there.
const playables = new Map();
async function playableFor(target, { make = false, job = null, onProgress = null } = {}) {
  const stat = await fs.stat(target);
  if (!stat.isFile()) return null;
  const out = path.join(CACHE, `${keyFor(target, stat, 'play')}.mp4`);
  if (await exists(out)) return out;
  if (!make) return null;
  if (!playables.has(out)) {
    playables.set(out, (async () => {
      const info = await probe(target);
      await fs.mkdir(CACHE, { recursive: true });
      const temp = path.join(CACHE, `.${path.basename(out)}.${process.pid}.part.mp4`);
      const args = [
        '-i', target, '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', `scale=-2:'trunc(min(${PLAYABLE_HEIGHT},ih)/2)*2',format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
        '-movflags', '+faststart', temp,
      ];
      try {
        await ffmpegJob(args, info.duration, onProgress, job);
      } catch (error) {
        await fs.rm(temp, { force: true });
        throw error.stopped ? error : new Error('This video couldn\'t be made ready to play.');
      }
      await fs.rename(temp, out);
      return out;
    })().finally(() => playables.delete(out)));
  }
  return playables.get(out);
}

// The file the video editor should read for this one: itself, or a copy it can read (same size and
// frame rate, high quality, square pixels, turned the right way up). Made once; the editor keeps
// its own copy of what it takes in, so this one may be let go later like the others here. job: a
// name to stop it by (cancel), for when the editor's tab closes before it's made.
const editables = new Map();
async function editableFor(target, { job = null, onProgress = null } = {}) {
  const info = await probe(target);
  if (info.edits) return target;
  const stat = await fs.stat(target);
  const out = path.join(CACHE, `${keyFor(target, stat, 'edit')}.mp4`);
  if (await exists(out)) return out;
  if (!editables.has(out)) {
    editables.set(out, (async () => {
      await fs.mkdir(CACHE, { recursive: true });
      const temp = path.join(CACHE, `.${path.basename(out)}.${process.pid}.part.mp4`);
      const picture = `${info.hdr ? `${TONE_DOWN},` : ''}scale='trunc(iw*sar/2)*2':'trunc(ih/2)*2',setsar=1,format=yuv420p`;
      const args = [
        '-i', target, '-map', '0:v:0', '-map', '0:a:0?', '-vf', picture,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart', temp,
      ];
      try {
        await ffmpegJob(args, info.duration, onProgress, job);
      } catch (error) {
        await fs.rm(temp, { force: true });
        throw error.stopped ? error : new Error('This video couldn\'t be made ready for the Editor.');
      }
      await fs.rename(temp, out);
      return out;
    })().finally(() => editables.delete(out)));
  }
  return editables.get(out);
}

// Where an export from the video editor is written as it comes in, a piece at a time, so the whole
// video is never held in memory here. size: how big it will be. Turned down in plain words when
// the disk hasn't room for it and its copy with AAC sound.
async function exportFile(size) {
  await fs.mkdir(CACHE, { recursive: true });
  const room = await fs.statfs(CACHE).then((disk) => disk.bavail * disk.bsize, () => Infinity);
  if (size * 2 + EXPORT_SPARE > room) {
    throw new Error(`There isn't enough room on the disk to save this video. It needs about ${Math.ceil(((size * 2 + EXPORT_SPARE) / 1024 ** 3) * 10) / 10} GB free.`);
  }
  return path.join(CACHE, `.export-${crypto.randomBytes(6).toString('hex')}.part.mp4`);
}

// The video editor's MP4s carry Opus sound (the browser has no AAC maker on Linux), which some
// players and phones don't play. sent: the exported file (from exportFile). This gives back a copy
// with AAC sound and the same picture, or null when the sound is fine as it is. The copy is in the
// cache folder, for the caller to move.
async function aacSound(sent) {
  const out = sent.replace(/\.part\.mp4$/, '.aac.part.mp4');
  if (out === sent) return null;
  try {
    const sound = await new Promise((resolve) => {
      execFile('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', sent], { timeout: 30000 }, (error, stdout) => resolve(error ? '' : String(stdout).trim()));
    });
    if (sound !== 'opus') return null;
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [...quiet, '-i', sent, '-map', '0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { timeout: 30 * 60 * 1000 }, (error) => (error ? reject(error) : resolve()));
    });
    return out;
  } catch {
    await fs.rm(out, { force: true });
    return null;
  }
}

// Keeps the folder under 3 GB, letting go of what was used longest ago.
async function tidy() {
  // Half-saved videos written down before a crash: gone once they're a few minutes old. One being
  // saved right now is left alone.
  await noteSaving(() => {});
  for (const temp of await savingList()) {
    if (saving.has(temp)) continue;
    // Anything in the list that isn't one of these hidden files is only taken off the list.
    const ours = path.isAbsolute(temp) && SAVING_NAME.test(path.basename(temp));
    const info = ours ? await fs.stat(temp).catch(() => null) : null;
    if (info && (!info.isFile() || Date.now() - info.mtimeMs < SAVING_OLD)) continue;
    if (info) await fs.rm(temp, { force: true });
    await noteSaving((list) => list.delete(temp));
  }
  let names;
  try { names = await fs.readdir(CACHE); } catch { return; }
  const kept = [];
  let total = 0;
  for (const name of names) {
    const file = path.join(CACHE, name);
    const info = await fs.stat(file).catch(() => null);
    if (!info) continue;
    // Pieces left by a job that was cut short.
    if (/\.part(\.mp4)?$/.test(name) && Date.now() - info.mtimeMs > 6 * 3600 * 1000) {
      await fs.rm(file, { force: true });
      continue;
    }
    if (!/^[0-9a-f]{40}\.(webp|mp4)$/.test(name)) continue;
    total += info.size;
    kept.push({ file, size: info.size, when: Math.max(info.atimeMs, info.mtimeMs) });
  }
  if (total <= KEEP_BYTES) return;
  kept.sort((a, b) => a.when - b.when);
  for (const item of kept) {
    if (total <= KEEP_BYTES * 0.7) break;
    await fs.rm(item.file, { force: true });
    total -= item.size;
  }
}

module.exports = { probe, cleanPlan, render, stripFor, playableFor, editableFor, exportFile, aacSound, cancel, cancelAll, tidy, REPLACEABLE, CACHE };
