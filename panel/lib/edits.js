// "Last edited by": which AI changed a file, from the notes each room keeps.
// Linux only records when a file changed, not who changed it, so every AI tool in a room writes a
// line for each file it edits to ~/.local/state/house/edits/<room id>/edits.jsonl:
//   {"time": ms, "path": "/workspace/...", "tool": "claude"|"codex"|"gemini", "model": "...", "action": "edit"|"write"|"delete"}
// The notes live outside the project, so they're never committed with it.
const fs = require('fs/promises');
const touches = require('./touches');
const owner = require('./owner');
const ownerSaves = require('./owner-saves');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, 'projects');
const EDITS = path.join(HOME, '.local', 'state', 'house', 'edits');
const ROOM_DIR = '/workspace';
// A file saved after the AI's last note was changed by someone else since: a person or a program.
// A little slack, since the note is written just after the save.
const SLACK_MS = 3000;
// A file changed after the AI's last note, while the room's AI wrote notes for any file this close
// in time: most likely a command the AI ran (a build, a screenshot), which leaves no note of its own.
const ACTIVE_MS = 5 * 60 * 1000;

// bin/room's room id: the project name with each space as a dot.
const roomId = (name) => name.replace(/ /g, '.');

// The path in the house for a path in a room, or null if it isn't inside the room's folder.
function mapRoomPath(base, roomPath) {
  if (typeof roomPath !== 'string' || (roomPath !== ROOM_DIR && !roomPath.startsWith(`${ROOM_DIR}/`))) return null;
  const clean = path.posix.normalize(roomPath);
  // A path that climbs out of /workspace ("/workspace/../etc") is nobody's file in the house.
  if (clean !== ROOM_DIR && !clean.startsWith(`${ROOM_DIR}/`)) return null;
  return base + clean.slice(ROOM_DIR.length);
}

const cache = new Map(); // note file -> { mtimeMs, size, byPath }
let projectsByRoom = { time: 0, map: new Map() };

async function projectFor(id) {
  if (Date.now() - projectsByRoom.time > 5000) {
    const names = await fs.readdir(PROJECTS).catch(() => []);
    projectsByRoom = { time: Date.now(), map: new Map(names.map((name) => [roomId(name), name])) };
  }
  return projectsByRoom.map.get(id) || null;
}

// The last `limit` bytes of a file (the room trims its notes at 2 MB, so this is normally all of it).
async function readTail(file, limit) {
  let handle;
  try {
    const { O_RDONLY, O_NOFOLLOW } = require('fs').constants;
    handle = await fs.open(file, O_RDONLY | O_NOFOLLOW);
    const { size } = await handle.stat();
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close();
  }
}

// Every note for one room, by the file's path in the house, newest first.
async function readRoom(id) {
  const file = path.join(EDITS, id, 'edits.jsonl');
  let stat;
  // Anything in the room can write here, so only a real file (never a link) is read, and only its end.
  try { stat = await fs.lstat(file); } catch { return null; }
  if (!stat.isFile()) return null;
  const known = cache.get(file);
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.byPath;
  const project = await projectFor(id);
  const byPath = new Map();
  byPath.timeline = [];
  if (project) {
    const text = await readTail(file, 4 * 1024 * 1024);
    const base = path.join(PROJECTS, project);
    for (const line of text.split('\n')) {
      if (!line) continue;
      let note;
      try { note = JSON.parse(line); } catch { continue; }
      if (typeof note.path !== 'string' || !Number.isFinite(note.time)) continue;
      const target = mapRoomPath(base, note.path);
      if (!target) continue;
      const list = byPath.get(target) || [];
      list.push({ time: note.time, tool: String(note.tool || ''), model: String(note.model || ''), action: String(note.action || 'edit') });
      byPath.set(target, list);
    }
    byPath.forEach((list) => list.sort((a, b) => b.time - a.time));
    // Every note of the room, oldest first, to find the one nearest a time (see nearestNote).
    const all = [];
    byPath.forEach((list) => list.forEach((note) => all.push({ time: note.time, tool: note.tool, model: note.model })));
    byPath.timeline = all.sort((a, b) => a.time - b.time);
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, byPath });
  return byPath;
}

// The note nearest a time in one room's timeline (oldest first), if it's within ACTIVE_MS. A binary search.
function nearestNote(timeline, time) {
  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (timeline[mid].time < time) low = mid + 1; else high = mid;
  }
  let best = null;
  for (const note of [timeline[low - 1], timeline[low]]) {
    if (note && Math.abs(note.time - time) <= ACTIVE_MS && (!best || Math.abs(note.time - time) < Math.abs(best.time - time))) best = note;
  }
  return best;
}

// Who changed a file last. Linux doesn't say, so this goes by what is known:
//   notes: the AI's notes for this file, newest first. activity: the timelines of the rooms that wrote them.
//   saves: the owner's saves through Station (lib/owner-saves.js), path -> time.
// Returns { edits } (the AI), { owner: { name, time, via: 'station' } } (a save in Station, for certain),
// { likely: { tool, model, time } } (changed after the AI's last note while the AI was working: probably
// a command it ran), { owner: { name, time } } (changed after the AI, with no AI working), or null.
function whoChanged({ path: file, mtime, notes, activity, saves, me }) {
  const last = notes && notes[0];
  if (last && last.action !== 'delete' && mtime <= last.time + SLACK_MS) return { edits: notes.slice(0, 2) };
  const saved = saves && saves.get(file);
  if (saved != null && Math.abs(mtime - saved) <= SLACK_MS) return { owner: { name: me, time: mtime, via: 'station' } };
  if (!last) return null;
  let near = null;
  for (const timeline of activity || []) {
    const found = nearestNote(timeline, mtime);
    if (found && (!near || Math.abs(found.time - mtime) < Math.abs(near.time - mtime))) near = found;
  }
  if (near) return { likely: { tool: near.tool, model: near.model, time: mtime } };
  return { owner: { name: me, time: mtime } };
}

// whoChanged for one listed file, with the answer put on it as edits, likely or owner.
// Used by the file list and by Home, so the two always agree.
function judge(entry, rooms, saves, me) {
  const mine = rooms.filter((byPath) => byPath.has(entry.path));
  const notes = mine.flatMap((byPath) => byPath.get(entry.path)).sort((a, b) => b.time - a.time);
  const who = whoChanged({ path: entry.path, mtime: entry.mtime, notes, activity: mine.map((byPath) => byPath.timeline || []), saves, me });
  if (who) Object.assign(entry, who);
  return entry;
}

// Adds to each listed item its last two AI edits (only if nothing changed it since), and for a
// folder, the latest AI edit anywhere inside it.
async function attach(entries) {
  if (!entries.length) return entries;
  const dir = path.dirname(entries[0].path);
  if (dir !== PROJECTS && !dir.startsWith(`${PROJECTS}/`) && dir !== path.dirname(PROJECTS)) return entries;
  await touches.annotate(entries); // last read by, tokens (from a cached map)
  const ids = await fs.readdir(EDITS).catch(() => []);
  const rooms = (await Promise.all(ids.map(readRoom))).filter(Boolean);
  const [me, saves] = await Promise.all([owner.name(), ownerSaves.latest()]);
  for (const entry of entries) {
    if (!entry.isDir) {
      judge(entry, rooms, saves, me);
      continue;
    }
    const prefix = `${entry.path}/`;
    let latest = null;
    let count = 0;
    for (const byPath of rooms) {
      byPath.forEach((notes, target) => {
        if (!target.startsWith(prefix)) return;
        count += 1;
        if (!latest || notes[0].time > latest.time) latest = { ...notes[0], file: target.slice(prefix.length) };
      });
    }
    if (latest) entry.editsInside = { ...latest, files: count };
  }
  return entries;
}

// Every room's notes (the Home page counts them), as readRoom gives them.
async function allRooms() {
  const ids = await fs.readdir(EDITS).catch(() => []);
  return (await Promise.all(ids.map(readRoom))).filter(Boolean);
}

module.exports = { attach, allRooms, whoChanged, judge, projectFor, mapRoomPath, roomId, EDITS, SLACK_MS, ACTIVE_MS };
