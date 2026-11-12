// What the AI's conversation files say about each file: which AI and model last read it, and the
// tokens its steps used (counted by token-count.js, kept in token-counts.json). The file list only
// ever looks a file up in a map kept in memory, so listing a folder stays as fast as before. The map
// is rebuilt in the background when the saved counts change.
//   - a "step" is one AI reply. Read, Edit, Write, MultiEdit and NotebookEdit count as reading
//     (Edit and Write read the file too); Grep and Glob don't.
//   - a step's tokens (read + written, as Home counts them) are shared equally among the files it touched.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, 'projects');
const TOKEN_CACHE = path.join(HOME, '.local', 'state', 'house', 'token-counts.json');

// How Claude Code names a folder for a project's conversations: every character but a letter or digit becomes "-".
const encodeDir = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-');

// { "/home/.../file": { time, model, in, out } }, from the saved counts. `projectOfRoom` maps a room
// id to its project's name; `mapRoomPath(base, path)` is edits.js's way of turning /workspace/... into the house.
function buildIndex(counts, projectOfRoom, mapRoomPath) {
  const index = new Map();
  const add = (target, [time, model, read, wrote]) => {
    const have = index.get(target) || { time: 0, model: '', in: 0, out: 0 };
    if (time >= have.time) { have.time = time; have.model = model || ''; }
    have.in += read || 0;
    have.out += wrote || 0;
    index.set(target, have);
  };
  Object.entries(counts.sources || {}).forEach(([key, source]) => {
    let toHouse;
    if (key === 'house') toHouse = (raw) => (typeof raw === 'string' && raw.startsWith(`${PROJECTS}/`) && !raw.split('/').includes('..') ? path.posix.normalize(raw) : null);
    else if (key.startsWith('room:')) {
      const project = projectOfRoom.get(key.slice(5));
      if (!project) return;
      toHouse = (raw) => mapRoomPath(path.join(PROJECTS, project), raw);
    } else return;
    Object.values(source.files || {}).forEach((record) => {
      Object.entries(record.touch || {}).forEach(([raw, got]) => {
        const target = toHouse(raw);
        if (target && Array.isArray(got)) add(target, got);
      });
    });
  });
  return index;
}

// All-time tokens (read + written) for each project name: { name -> number }, from every day's totals.
function lifetimeByProject(counts, names) {
  const { roomId } = require('./edits'); // here, since edits.js needs this file too
  const byRoom = new Map(names.map((name) => [roomId(name), name]));
  const houseDirs = new Map(names.map((name) => [encodeDir(path.join(PROJECTS, name)), name]));
  const total = new Map();
  const bump = (name, value) => total.set(name, (total.get(name) || 0) + value);
  Object.entries(counts.sources || {}).forEach(([key, source]) => {
    Object.entries(source.files || {}).forEach(([file, record]) => {
      let name = null;
      if (key.startsWith('room:')) name = byRoom.get(key.slice(5));
      else if (key === 'house') name = houseDirs.get(path.basename(path.dirname(file)));
      if (!name) return;
      Object.values(record.days || {}).forEach(([read, wrote]) => bump(name, (Number(read) || 0) + (Number(wrote) || 0)));
    });
  });
  return total;
}

// What each folder holds, rolled up once per rebuild: { "/home/.../folder": { in, out, last: { time, model, file } } }.
// Every file under a project adds to each folder above it, up to ~/projects itself. `file` is the path
// from that folder, the way editsInside names it. A folder's row is then a single map lookup.
function buildFolders(index) {
  const folders = new Map();
  index.forEach((got, target) => {
    // A path ending in "/" is a folder the AI tried to read, not a file. ("~/projects/" itself would
    // also climb above ~/projects, so the walk below stops as soon as it leaves it.)
    if (!target.startsWith(`${PROJECTS}/`) || target.endsWith('/')) return;
    for (let dir = path.posix.dirname(target); dir === PROJECTS || dir.startsWith(`${PROJECTS}/`); dir = path.posix.dirname(dir)) {
      const have = folders.get(dir) || { in: 0, out: 0, last: null };
      have.in += got.in;
      have.out += got.out;
      if (got.time > 0 && (!have.last || got.time > have.last.time)) have.last = { time: got.time, model: got.model, file: target.slice(dir.length + 1) };
      folders.set(dir, have);
    }
  });
  return folders;
}

let index = new Map();
let folders = new Map();
let allTime = new Map(); // project name -> all-time tokens, the number Home's cards show
let allProjects = 0; // the sum of those, for the ~/projects folder itself
let seen = null; // "mtime:size" of the counts file the index was built from
let loading = null;

async function reload(stamp) {
  const edits = require('./edits'); // here, since edits.js needs this file too
  let counts;
  try { counts = JSON.parse(await fs.readFile(TOKEN_CACHE, 'utf8')); } catch { counts = { sources: {} }; }
  const projectOfRoom = new Map();
  await Promise.all(Object.keys(counts.sources || {}).filter((key) => key.startsWith('room:')).map(async (key) => {
    const id = key.slice(5);
    const project = await edits.projectFor(id);
    if (project) projectOfRoom.set(id, project);
  }));
  const next = buildIndex(counts, projectOfRoom, edits.mapRoomPath);
  // Same rule as Home's project list: folders in ~/projects that aren't hidden.
  const names = (await fs.readdir(PROJECTS, { withFileTypes: true }).catch(() => []))
    .filter((item) => item.isDirectory() && !item.name.startsWith('.')).map((item) => item.name);
  const life = lifetimeByProject(counts, names);
  index = next;
  folders = buildFolders(next);
  allTime = life;
  allProjects = [...life.values()].reduce((sum, value) => sum + value, 0);
  seen = stamp;
}

// Adds readBy and tokens to the listed files, and for folders the newest read inside and the rolled-up tokens. Waits only for the very first build; after that the
// answer comes from the map at once, and a changed counts file is picked up in the background.
async function annotate(entries) {
  let stamp = 'none';
  try { const stat = await fs.stat(TOKEN_CACHE); stamp = `${stat.mtimeMs}:${stat.size}`; } catch { /* no counts yet */ }
  if (stamp !== seen && !loading) {
    loading = reload(stamp).catch(() => { seen = stamp; }).finally(() => { loading = null; });
    if (seen === null) await loading;
  }
  for (const entry of entries) {
    if (entry.isDir) {
      const inside = folders.get(entry.path);
      if (inside?.last) entry.readInside = { ...inside.last, tool: 'claude' };
      const isProject = path.dirname(entry.path) === PROJECTS;
      // A project's all-time total (or all of them, for ~/projects). With none, as for a hidden or
      // linked folder that Home doesn't list, the row is a plain folder: what its files got.
      const total = isProject ? allTime.get(path.basename(entry.path)) || 0 : entry.path === PROJECTS ? allProjects : 0;
      if (total > 0) entry.tokens = { in: inside?.in || 0, out: inside?.out || 0, allTime: total };
      else if (inside && inside.in + inside.out > 0) entry.tokens = { in: inside.in, out: inside.out };
      continue;
    }
    const got = index.get(entry.path);
    if (!got) continue;
    if (got.time > 0) entry.readBy = { time: got.time, model: got.model, tool: 'claude' };
    entry.tokens = { in: got.in, out: got.out };
  }
  return entries;
}

module.exports = { annotate, buildIndex, buildFolders, lifetimeByProject };
