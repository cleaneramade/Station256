// The owner's own saves through Station 256 (a text file, a picture, a video, a song's info).
// Linux can't say who changed a file, but these saves are known for certain, so "Last edited by"
// can show the owner's name for them. One line per save in ~/.local/state/house/owner-saves.jsonl:
//   {"time": ms, "path": "/home/.../projects/..."}
// Only files inside ~/projects are noted. Nothing here may ever make a save fail.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 1024 * 1024;
const KEEP_LINES = 5000;

const projects = () => path.join(os.homedir(), 'projects');
const logFile = () => path.join(os.homedir(), '.local', 'state', 'house', 'owner-saves.jsonl');

let cached = null; // { file, mtimeMs, size, map }

// Notes one save, right after it worked. `target` is the file really written.
function note(target) {
  try {
    if (typeof target !== 'string' || !target) return;
    const full = path.resolve(target);
    if (!full.startsWith(`${projects()}/`)) return;
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ time: Date.now(), path: full })}\n`);
    // Past 1 MB, only the last 5,000 lines stay. The new file takes the old one's place in one step.
    if (fs.statSync(file).size > MAX_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP_LINES);
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${lines.join('\n')}\n`);
      fs.renameSync(temp, file);
    }
  } catch { /* a note that can't be kept never stops a save */ }
}

// Each file's newest save time, as a Map. Read again only when the file has changed.
async function latest() {
  const file = logFile();
  try {
    const stat = await fs.promises.stat(file);
    if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.map;
    const map = new Map();
    for (const line of (await fs.promises.readFile(file, 'utf8')).split('\n')) {
      if (!line) continue;
      let saved;
      try { saved = JSON.parse(line); } catch { continue; }
      if (typeof saved.path !== 'string' || !Number.isFinite(saved.time)) continue;
      if (!(map.get(saved.path) >= saved.time)) map.set(saved.path, saved.time);
    }
    cached = { file, mtimeMs: stat.mtimeMs, size: stat.size, map };
    return map;
  } catch {
    return new Map();
  }
}

module.exports = { note, latest };
