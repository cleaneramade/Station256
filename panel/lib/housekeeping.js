// Clean-up: Station and its rooms leave things behind (a closed room that was never removed, crash
// dumps, build cache, old logs, the Trash). Once a day this removes what is safe to remove and
// nothing else. Every rule runs on its own, so one failing never stops the rest, and run() never
// throws. When unsure whether something is safe to remove, it is kept.
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const TRASH_DAYS = 30;
const LOG_LIMIT = 5 * MB;
const LOG_KEEP = 1 * MB;
const LOG_NAMES = ['panel.log', 'helper.log', 'room.log', 'housekeeping.log'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', '.rust', '.cargo', '.venv']);
const ROOM_NAME = /^room-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CORE_NAME = /^core(\.\d+)?$/;
// How Trash names items (lib/files.js): <ms>-<name>, or <ms><n>-<name> when two land in the same ms.
const STAMPED = /^(\d{13})\d*-/;

// Paths are worked out when used, not when loaded, so a check can point HOME somewhere else.
const stateDir = () => path.join(os.homedir(), '.local', 'state', 'house');
const trashDir = () => path.join(os.homedir(), '.local', 'share', 'house-trash');

// Run quietly: lowest priority for the processor and the disk, where those programs exist.
function onPath(name) {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
function run1(file, args, timeout) {
  let command = file;
  let list = args;
  if (onPath('nice')) {
    const quiet = onPath('ionice') ? ['-n', '19', 'ionice', '-c3'] : ['-n', '19'];
    command = 'nice';
    list = [...quiet, file, ...args];
  }
  return new Promise((resolve, reject) => {
    execFile(command, list, { timeout, maxBuffer: 8 * MB }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

// Space a file really takes (these dumps are sparse), counting without following links.
async function sizeOnDisk(target, budget = { left: 200000 }) {
  let info;
  try {
    info = await fsp.lstat(target);
  } catch {
    return 0;
  }
  let total = info.blocks * 512;
  if (!info.isDirectory()) return total;
  let names = [];
  try {
    names = await fsp.readdir(target);
  } catch {
    return total;
  }
  for (const name of names) {
    if ((budget.left -= 1) < 0) break;
    total += await sizeOnDisk(path.join(target, name), budget);
  }
  return total;
}

/* ---------- Rules. Each returns { removed: [names], bytes }. ---------- */

// Closed rooms are meant to be removed. One left behind after a stop can hold tens of GB.
// Only a stopped one, only a room's own name, never forced, and never its volumes or images.
async function roomContainers({ docker }) {
  const out = await run1(docker, ['ps', '-a', '--filter', 'label=house.room', '--format', '{{.Names}}\t{{.State}}'], 30000);
  const removed = [];
  let bytes = 0;
  for (const line of out.split('\n')) {
    const [name, state] = line.trim().split(/\s+/);
    if (!name || !['exited', 'created', 'dead'].includes(state) || !ROOM_NAME.test(name)) continue;
    let size = 0;
    try {
      size = Number((await run1(docker, ['inspect', '--size', '-f', '{{.SizeRw}}', name], 30000)).trim()) || 0;
    } catch {}
    try {
      await run1(docker, ['rm', name], 120000);
    } catch {
      continue; // still running or busy: it stays
    }
    removed.push(name);
    bytes += size;
  }
  return { removed, bytes };
}

// A real Linux core file: starts with the ELF mark and its type (offset 16) is 4, "core".
// A program or a script that happens to be called core is not one.
async function isCoreFile(file) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const head = Buffer.alloc(18);
    const { bytesRead } = await handle.read(head, 0, 18, 0);
    return bytesRead === 18 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46 && head.readUInt16LE(16) === 4;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Crash dumps (core.1234) from programs that crashed in a room, in projects and in the Trash.
async function crashDumps() {
  const removed = [];
  let bytes = 0;
  const deadline = Date.now() + 3000;
  async function drop(file, info, label, infoName) {
    if (!info.isFile() || info.size < MB || !(await isCoreFile(file))) return;
    const size = info.blocks * 512;
    await fsp.unlink(file);
    if (infoName) await fsp.rm(infoName, { force: true }).catch(() => {});
    removed.push(label);
    bytes += size;
  }
  async function walk(dir, depth, inTrash) {
    if (depth > 10 || Date.now() > deadline) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (Date.now() > deadline) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || (inTrash && depth === 0 && entry.name === '.info')) continue;
        await walk(full, depth + 1, inTrash);
      } else if (entry.isFile()) {
        // In the Trash, an item's stored name has a time stamp in front.
        const plain = inTrash && depth === 0 ? entry.name.replace(STAMPED, '') : entry.name;
        if (!CORE_NAME.test(plain)) continue;
        try {
          const info = await fsp.lstat(full);
          const infoFile = inTrash && depth === 0 ? path.join(trashDir(), '.info', `${entry.name}.json`) : null;
          await drop(full, info, full.replace(os.homedir(), '~'), infoFile);
        } catch {}
      }
    }
  }
  await walk(trashDir(), 0, true);
  await walk(path.join(os.homedir(), 'projects'), 0, false);
  return { removed, bytes };
}

// The Trash empties itself after 30 days. Names carry the time they were thrown away.
async function trashOld({ now }) {
  const removed = [];
  let bytes = 0;
  const trash = trashDir();
  const names = await fsp.readdir(trash).catch(() => []);
  for (const name of names) {
    const stamp = STAMPED.exec(name);
    if (name === '.info' || !stamp || now - Number(stamp[1]) <= TRASH_DAYS * DAY) continue;
    const full = path.join(trash, name);
    try {
      const size = await sizeOnDisk(full);
      await fsp.rm(full, { recursive: true, force: true }); // never follows a link
      await fsp.rm(path.join(trash, '.info', `${name}.json`), { force: true });
      removed.push(name.replace(STAMPED, ''));
      bytes += size;
    } catch {}
  }
  return { removed, bytes };
}

// "Total reclaimed space: 6.4GB" (or kB, MB, TB), as Docker writes it.
function reclaimed(text) {
  const match = /Total reclaimed space:\s*([\d.]+)\s*([kKMGT]?B)/.exec(text);
  if (!match) return 0;
  const units = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return Math.round(Number(match[1]) * (units[match[2].toUpperCase()] || 1));
}

// Docker's build cache older than a week, and images with no name that nothing uses. Never -a.
async function buildCache({ docker }) {
  const removed = [];
  let bytes = 0;
  let failed = null;
  for (const [label, args, timeout] of [
    ['build cache', ['builder', 'prune', '-f', '--filter', 'until=168h'], 600000],
    ['unused images', ['image', 'prune', '-f'], 300000],
  ]) {
    try {
      const size = reclaimed(await run1(docker, args, timeout));
      if (size > 0) {
        removed.push(label);
        bytes += size;
      }
    } catch (error) {
      failed = failed || error;
    }
  }
  if (failed && !removed.length) throw failed;
  return { removed, bytes };
}

// Logs are only ever trimmed in place: Station writes to panel.log through a file it already has
// open, so swapping the file would lose its logging until the next start.
async function logs() {
  const removed = [];
  let bytes = 0;
  for (const name of LOG_NAMES) {
    const file = path.join(stateDir(), name);
    try {
      const info = await fsp.lstat(file);
      if (!info.isFile() || info.size <= LOG_LIMIT) continue;
      const tail = Buffer.alloc(LOG_KEEP);
      const handle = await fsp.open(file, 'r');
      try {
        await handle.read(tail, 0, LOG_KEEP, info.size - LOG_KEEP);
      } finally {
        await handle.close();
      }
      await fsp.truncate(file, 0);
      await fsp.appendFile(file, tail);
      removed.push(name);
      bytes += info.size - LOG_KEEP;
    } catch {}
  }
  return { removed, bytes };
}

// Folders the picture checks leave in /tmp, which is in memory here. Never the HOME in use.
async function testLeftovers({ now, tmp }) {
  const removed = [];
  let bytes = 0;
  const current = path.resolve(os.homedir());
  const names = await fsp.readdir(tmp).catch(() => []);
  for (const name of names) {
    if (!/^house-shots-[A-Za-z0-9_-]+$/.test(name)) continue;
    const full = path.join(tmp, name);
    if (current === full || current.startsWith(`${full}/`)) continue;
    try {
      const info = await fsp.lstat(full);
      if (!info.isDirectory() || now - info.mtimeMs < DAY) continue;
      const size = await sizeOnDisk(full);
      await fsp.rm(full, { recursive: true, force: true });
      removed.push(name);
      bytes += size;
    } catch {}
  }
  return { removed, bytes };
}

const RULES = [
  { id: 'roomContainers', label: 'Closed rooms', fn: roomContainers },
  { id: 'crashDumps', label: 'Crash dumps', fn: crashDumps },
  { id: 'trashOld', label: 'Old Trash', fn: trashOld },
  { id: 'buildCache', label: 'Build cache', fn: buildCache },
  { id: 'logs', label: 'Logs', fn: logs },
  { id: 'testLeftovers', label: 'Test leftovers', fn: testLeftovers },
];

/* ---------- Results ---------- */

const resultsFile = () => path.join(stateDir(), 'housekeeping.json');

function readResults() {
  try {
    const saved = JSON.parse(fs.readFileSync(resultsFile(), 'utf8'));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

const total = (rules) => rules.reduce((sum, rule) => sum + (rule.bytes || 0), 0);
const stamp = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// The last run in full, and the totals of the last ten.
function status() {
  const saved = readResults();
  return { lastRun: saved.lastRun || null, runs: Array.isArray(saved.runs) ? saved.runs : [] };
}
const lastRunTime = () => Number(status().lastRun?.time) || 0;

async function save(result) {
  const runs = [...status().runs, { time: result.time, bytes: total(result.rules), removed: result.rules.reduce((n, rule) => n + rule.removed.length, 0) }].slice(-10);
  await fsp.mkdir(stateDir(), { recursive: true });
  const temporary = `${resultsFile()}.new`;
  await fsp.writeFile(temporary, JSON.stringify({ lastRun: result, runs }));
  await fsp.rename(temporary, resultsFile());
  const lines = result.rules
    .filter((rule) => rule.removed.length)
    .map((rule) => `${stamp(result.time)} clean-up: ${rule.label}: removed ${rule.removed.length} (${Math.round(rule.bytes / MB)} MB): ${rule.removed.slice(0, 5).join(', ')}${rule.removed.length > 5 ? ', ...' : ''}\n`);
  if (lines.length) await fsp.appendFile(path.join(stateDir(), 'housekeeping.log'), lines.join(''));
}

let running = null;

// Runs every rule. extra: more rules from the app, [{ id, label, fn }], for what only it can reach.
// Asked again while it's running, it gives back the run already going.
function run({ now = Date.now(), docker = 'docker', tmp = '/tmp', extra = [] } = {}) {
  if (running) return running;
  running = (async () => {
    const rules = [];
    for (const rule of [...RULES, ...extra]) {
      const entry = { id: rule.id, label: rule.label, removed: [], bytes: 0 };
      try {
        const done = await rule.fn({ now, docker, tmp });
        entry.removed = (done?.removed || []).map(String);
        entry.bytes = Number(done?.bytes) || 0;
      } catch (error) {
        entry.error = String(error?.message || error).split('\n')[0].slice(0, 200);
      }
      rules.push(entry);
    }
    const result = { time: now, rules };
    try {
      await save(result);
    } catch {}
    return result;
  })().finally(() => { running = null; });
  return running;
}

/* ---------- The video editor's copies ---------- */

// Run inside an open editor page (its storage can only be reached from there). The same rule as
// editor/src/station/import.ts: copies in "station-import" named <ms>-<id> that are over 12 hours old
// go. No other folder is ever touched: those hold the editor's projects.
const EDITOR_COPIES_SCRIPT = `(async () => {
  const KEEP = 12 * 60 * 60 * 1000;
  const removed = [];
  let bytes = 0;
  try {
    const root = await navigator.storage.getDirectory();
    let folder;
    try { folder = await root.getDirectoryHandle('station-import'); } catch { return { removed, bytes }; }
    const names = [];
    for await (const name of folder.keys()) names.push(name);
    for (const name of names) {
      const made = Number(name.split('-')[0]);
      if (Date.now() - made < KEEP) continue;
      let size = 0;
      try { size = (await (await folder.getFileHandle(name)).getFile()).size; } catch {}
      try { await folder.removeEntry(name); removed.push(name); bytes += size; } catch {}
    }
  } catch {}
  return { removed, bytes };
})()`;

// Sums the answers of the open editor pages (pages: webContents). Never throws or hangs.
async function cleanEditorPages(pages) {
  const removed = [];
  let bytes = 0;
  for (const page of pages) {
    try {
      if (page.isDestroyed()) continue;
      const answer = await Promise.race([page.executeJavaScript(EDITOR_COPIES_SCRIPT), new Promise((resolve) => setTimeout(() => resolve(null), 15000))]);
      if (Array.isArray(answer?.removed)) removed.push(...answer.removed.slice(0, 50).map((name) => String(name).slice(0, 80)));
      bytes += Number(answer?.bytes) || 0;
    } catch {}
  }
  return { removed, bytes };
}

module.exports = { run, status, lastRunTime, cleanEditorPages, EDITOR_COPIES_SCRIPT };
