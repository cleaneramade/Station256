// Small pictures of files for the icon views, as File Explorer shows: any picture type, a video's
// frame, a song's cover, a PDF's first page. Made once with the house's ffmpeg (pdftoppm for PDFs)
// and kept in ~/.cache/house/thumbs, named after the file, its size and date, so a changed file
// gets a new one. Pictures the page can show by itself are sent as they are while they're small.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.cache', 'house', 'thumbs');
const VERSION = 1; // bump to make every picture again
const SIDE = 256; // the longest side in pixels: Extra large icons at 135% stay sharp
const VIEW_SIDE = 4096; // pictures opened to look at
const AT_ONCE = 3;
const LONGEST_MS = 20000;
const KEEP_BYTES = 300 * 1024 * 1024;

// The page shows these by itself. SVGs always go as they are (they're drawings, not pixels).
const NATIVE = /\.(png|jpe?g|jfif|pjpeg|pjp|gif|webp|bmp|ico|cur|avif|apng)$/i;
const AS_IS_BYTES = 1.5 * 1024 * 1024;
const SVG = /\.svgz?$/i;
const PICTURE = /\.(tiff?|heic|heif|hif|psd|tga|dds|exr|hdr|jxl|jp2|j2k|jpf|jpx|qoi|pcx|ppm|pgm|pbm|pnm|pam|pfm|sgi|xbm|xpm|xwd|dpx)$/i;
const VIDEO = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpe?g|m2v|mts|m2ts|3gp|3g2|ogv|vob|asf|divx)$/i;
const AUDIO = /\.(mp3|m4a|m4b|aac|flac|ogg|oga|opus|wav|wma|aiff?|ape|wv|dsf)$/i;
const PDF = /\.pdf$/i;

function kindOf(name) {
  if (SVG.test(name)) return 'svg';
  if (NATIVE.test(name) || PICTURE.test(name)) return 'picture';
  if (VIDEO.test(name)) return 'video';
  if (AUDIO.test(name)) return 'audio';
  if (PDF.test(name)) return 'pdf';
  return null;
}

const exists = (file) => fs.access(file).then(() => true, () => false);

// The programs running now, so none is left behind when Station 256 quits (cancelAll).
const children = new Set();
let quitting = false;

// A program run with a time limit. Resolves true when it finished well (with grab: its output).
function run(program, args, grab = false) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(program, args, { stdio: ['ignore', grab ? 'pipe' : 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    children.add(child);
    const timer = setTimeout(() => child.kill('SIGKILL'), LONGEST_MS);
    let output = '';
    if (grab) child.stdout.on('data', (chunk) => { output += chunk; });
    const done = (ok) => {
      clearTimeout(timer);
      children.delete(child);
      resolve(ok && grab ? output : ok);
    };
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

// A few at a time, so a folder of a thousand photos doesn't start a thousand programs.
let running = 0;
const waiting = [];
function inTurn(job, dir) {
  return new Promise((resolve, reject) => {
    waiting.push({
      dir,
      drop: () => resolve(null),
      start: () => job().then(resolve, reject).finally(() => {
        running -= 1;
        next();
      }),
    });
    next();
  });
}
function next() {
  while (running < AT_ONCE && waiting.length) {
    running += 1;
    waiting.shift().start();
  }
}

// The folder was left: its pictures still waiting their turn aren't made (they would only hold up
// the folder being looked at now). Ones already being made finish, and are kept for next time.
function leftFolder(dir) {
  for (let index = waiting.length - 1; index >= 0; index -= 1) {
    if (waiting[index].dir === dir) waiting.splice(index, 1)[0].drop();
  }
}

// Station 256 is quitting: nothing is left waiting or running. What was half made is a .part file.
function cancelAll() {
  quitting = true;
  waiting.splice(0).forEach((item) => item.drop());
  for (const child of children) child.kill('SIGKILL');
}

// Fits inside a square of this side, never made bigger than it was.
const scaleTo = (side) => `scale=w='min(iw,${side})':h='min(ih,${side})':force_original_aspect_ratio=decrease:flags=lanczos`;
const quiet = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];

async function make(kind, target, out, side) {
  const toWebp = ['-frames:v', '1', '-vf', scaleTo(side), '-c:v', 'libwebp', '-quality', side > SIDE ? '92' : '82'];
  const temp = `${out}.${process.pid}.part`;
  let made = false;
  if (kind === 'pdf') {
    // pdftoppm adds .png to the name it's given.
    made = await run('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-scale-to', String(SIDE), '-png', target, temp]);
    if (made) await fs.rename(`${temp}.png`, out).catch(() => { made = false; });
    return made;
  }
  if (kind === 'video') {
    // A frame a tenth of the way in (1 s to 30 s) (the start is often a black fade-in); when that
    // can't be read, the first frame.
    const length = parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', target], true));
    const at = length > 0 ? Math.max(1, Math.min(length / 10, 30)) : 1;
    // thumbnail=30 takes the most typical of the next 30 frames, so a flat card or fade isn't picked.
    const typical = toWebp.map((arg) => (arg === scaleTo(side) ? `thumbnail=30,${arg}` : arg));
    made = await run('ffmpeg', [...quiet, '-ss', String(at), '-i', target, ...typical, '-f', 'webp', temp]);
    if (!made || !(await fs.stat(temp).then((info) => info.size > 0, () => false))) {
      made = await run('ffmpeg', [...quiet, '-i', target, ...toWebp, '-f', 'webp', temp]);
    }
  } else if (kind === 'audio') {
    // A song's cover is a picture stored inside it. No cover, nothing to show.
    made = await run('ffmpeg', [...quiet, '-i', target, '-map', '0:v:0', '-an', ...toWebp, '-f', 'webp', temp]);
  } else {
    made = await run('ffmpeg', [...quiet, '-i', target, ...toWebp, '-f', 'webp', temp]);
  }
  if (made) made = await fs.stat(temp).then((info) => info.size > 0, () => false);
  if (made) await fs.rename(temp, out);
  else await fs.rm(temp, { force: true });
  return made;
}

const busy = new Map();

// The file to show for this one: itself, a small picture of it, or null when there's none.
// view: the whole picture, for looking at, of a kind the page can't show by itself (TIFF, HEIC, PSD...).
async function thumbFor(target, view = false) {
  const kind = kindOf(path.basename(target));
  if (!kind || (view && kind !== 'picture' && kind !== 'svg')) return null;
  const info = await fs.stat(target);
  if (!info.isFile()) return null;
  if (kind === 'svg' || (NATIVE.test(target) && (view || info.size <= AS_IS_BYTES))) return target;
  const side = view ? VIEW_SIDE : SIDE;
  const key = crypto.createHash('sha1').update(`${VERSION}${kind === 'video' ? 'v2' : ''}\0${target}\0${info.size}\0${info.mtimeMs}\0${side}`).digest('hex');
  const out = path.join(DIR, `${key}.${kind === 'pdf' ? 'png' : 'webp'}`);
  const none = path.join(DIR, `${key}.none`);
  if (await exists(out)) return out;
  if (await exists(none)) return null; // tried before: a song with no cover, a file ffmpeg can't read
  if (!busy.has(key)) {
    busy.set(key, inTurn(async () => {
      await fs.mkdir(DIR, { recursive: true });
      if (await make(kind, target, out, side)) return out;
      if (!quitting) await fs.writeFile(none, '').catch(() => {}); // stopped by quitting isn't "can't be made"
      return null;
    }, path.dirname(target)).finally(() => busy.delete(key)));
  }
  return busy.get(key);
}

// Keeps the folder under 300 MB, letting go of the pictures looked at longest ago.
async function tidy() {
  let names;
  try { names = await fs.readdir(DIR); } catch { return; }
  const kept = [];
  let total = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{40}\.(webp|png|none)$/.test(name)) continue;
    const file = path.join(DIR, name);
    const info = await fs.stat(file).catch(() => null);
    if (!info) continue;
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

module.exports = { thumbFor, kindOf, tidy, leftFolder, cancelAll, DIR };
