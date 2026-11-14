// Rooms, the Windows door, house rules, and system information.
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const files = require('./files');
const rules = require('./rules');

const exec = promisify(execFile);
const HOME = os.homedir();
const PROJECTS = path.join(HOME, 'projects');
const ROOM = path.join(HOME, '.local', 'bin', 'room');
const STATE = path.join(HOME, '.local', 'state', 'house');
const HELPER_CONFIG = path.join(HOME, '.config', 'house', 'windows-helper.json');
const { DOOR_FLAG } = files; // a stand-in in checks
const DOOR_CUT = path.join(path.dirname(DOOR_FLAG), 'windows-door-cut');
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9_-])?$/;

async function run(command, args, timeout = 20000) {
  const { stdout } = await exec(command, args, { timeout });
  return stdout;
}

async function readOr(file, fallback) {
  try { return (await fs.readFile(file, 'utf8')).trim(); } catch { return fallback; }
}

// The end of a file that only grows, so a long log is never read whole. A line cut in half at
// the start is dropped.
async function readTail(file, bytes) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    await handle?.close();
  }
}

// What happened in the rooms, newest first. Each entry in room.log starts with its time; a line
// without one (an error a command printed) belongs to the entry above it. An entry that starts
// with a room's name ("SampleApp: ...") names that room. Problems are marked so they stand out.
const PROBLEM = /\b(fail(ed|s)?|couldn't|could not|error|not running|denied|crash(ed)?)\b/i;
function activity(log, count = 50) {
  const entries = [];
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const timed = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (.*)$/);
    if (timed) entries.push({ time: timed[1], text: timed[2] });
    else if (entries.length) entries[entries.length - 1].text += ` ${line}`;
    else entries.push({ time: '', text: line });
  }
  return entries.slice(-count).reverse().map(({ time, text }) => {
    const named = text.match(/^([A-Za-z0-9][A-Za-z0-9 ._-]{0,63}): (.*)$/);
    const room = named && named[1] !== 'agents' ? named[1] : '';
    const message = (room ? named[2] : text).replace(/:\s*:/g, ':').replace(/:\s*$/, '');
    return { time, room, text: message.slice(0, 240), problem: PROBLEM.test(text) };
  });
}

function checkProject(name) {
  if (!NAME.test(name || '')) throw new Error('Project names use letters, numbers, spaces, - and _ only.');
}

// Fails if Docker can't answer. "Couldn't check" must never be mistaken for "no rooms".
// The status bar of every window, the AI alerts and the Agents page all ask every few seconds, so
// one answer is shared for a moment instead of a docker process each. The lock and moving a
// project ask fresh (freshRooms).
let roomsAsked = null;
let roomsAt = 0;
function rooms() {
  if (!roomsAsked || Date.now() - roomsAt > 1500) {
    roomsAt = Date.now();
    roomsAsked = freshRooms();
    roomsAsked.catch(() => { roomsAt = 0; }); // a failure is never kept
  }
  return roomsAsked;
}

async function freshRooms() {
  const out = await run('docker', ['ps', '--no-trunc', '--filter', 'label=house.room', '--format', '{{.ID}}|{{.Label "house.room"}}|{{.Label "house.door"}}'], 8000);
  const cut = (await readOr(DOOR_CUT, '')).split('\n'); // rooms the lock took /windows from
  return out.split('\n').filter(Boolean).map((line) => {
    const [id, name, door] = line.split('|');
    return { name, windowsDoor: door === 'open' && !cut.includes(id) };
  });
}

function paths() {
  // windows: where the C: drive shows while the Windows door is unlocked (Windows (C:) in the explorer).
  return { home: HOME, projects: PROJECTS, trash: files.TRASH, windows: files.DOOR };
}

// Warns while there's still plenty of room to act: under 10 GB, or under 5%, whichever is more.
function isLowOnSpace(freeGb, totalGb) {
  return freeGb < Math.max(10, totalGb * 0.05);
}

async function status() {
  const [open, keeper, doorFlag, mounts, disk] = await Promise.all([
    rooms().catch(() => null),
    readOr('/run/house/status', 'House keeper isn\'t reporting.'),
    fs.access(DOOR_FLAG).then(() => true, () => false),
    readOr('/proc/self/mountinfo', ''),
    fs.statfs('/'),
  ]);
  const freeGb = (disk.bavail * disk.bsize) / 2 ** 30;
  // The lock only shows closed once C: is let go and no room can still read through the door.
  // A failed lock removes the flag first but leaves C: mounted, which still counts as open.
  const driveMounted = mounts.split('\n').some((line) => line.split(' ')[4] === files.DOOR);
  const doorOpen = doorFlag || driveMounted || Boolean(open && open.some((room) => room.windowsDoor));
  // windowsDrive: C: is there for the explorer to show (the house's own door, not a room's).
  return {
    rooms: open, dockerOk: open !== null, keeper, doorOpen, windowsDrive: doorFlag, freeGb, lowDisk: isLowOnSpace(freeGb, (disk.blocks * disk.bsize) / 2 ** 30),
  };
}

// A project's folder can't be moved or renamed while its room is up: the room is using it.
// Lists any of these paths that are in that state.
async function heldByRooms(targets) {
  const projects = targets.filter((target) => path.dirname(path.resolve(target)) === PROJECTS);
  if (!projects.length) return [];
  const open = await freshRooms();
  return projects
    .filter((target) => open.some((room) => room.name === path.basename(target)))
    .map((target) => ({ path: target, message: `Its room is open. Close the room first.` }));
}

// A project's Claude volume (chat history, sign-in) is never deleted by Station. An automatic
// clean-up used to remove the volume of any project it couldn't see, which can wipe real chat
// histories (a copy run with a different home sees no projects). bin/room also holds each volume.

async function newProject(name) {
  checkProject(name);
  await fs.mkdir(PROJECTS, { recursive: true });
  // Windows treats Foo and foo as the same folder, so two projects can't differ only by capitals.
  const taken = (await fs.readdir(PROJECTS)).find((entry) => entry.toLowerCase() === name.toLowerCase());
  if (taken) throw new Error(`A project called "${taken}" already exists.`);
  try {
    await fs.mkdir(path.join(PROJECTS, name));
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`A project called "${name}" already exists.`);
    throw error;
  }
}

async function closeRoom(name) {
  checkProject(name);
  await run(ROOM, ['close', name], 40000);
}

async function openDoor() {
  await run('sudo', ['-n', '/usr/local/sbin/house-rules', 'door-open']);
}

// Stops new rooms getting the door, takes /windows away from the rooms already holding it, then
// lets go of C:. Never closes a room. If a room can't be cut (something in it has a file open in
// /windows), this fails with that room's name and the lock stays showing open.
async function closeDoor() {
  try {
    await run('sudo', ['-n', '/usr/local/sbin/house-rules', 'door-close']);
  } catch (error) {
    throw new Error(String(error.stderr || '').trim() || error.message);
  }
  // Checked here too, so an older installed house-rules that doesn't cut rooms can't pass as locked.
  const left = (await freshRooms()).filter((room) => room.windowsDoor);
  if (left.length) throw new Error(`These rooms could still read your Windows files: ${left.map((room) => room.name).join(', ')}`);
}

// The house rules. Every one applies to every room.
async function getRules() {
  return rules.allRules();
}

function setRule(id, value) {
  return rules.setRule(id, value);
}

let lastCpu = null;
async function cpuPercent() {
  const line = (await fs.readFile('/proc/stat', 'utf8')).split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = line[3] + (line[4] || 0);
  const total = line.reduce((sum, value) => sum + value, 0);
  const previous = lastCpu;
  lastCpu = { idle, total };
  if (!previous || total === previous.total) return 0;
  return Math.round(100 * (1 - (idle - previous.idle) / (total - previous.total)));
}

// Programs, with every copy of the same one added up (ten "node" processes show as one line),
// busiest first. Copies that belong to someone else can't be ended from here.
async function processes() {
  const out = await run('ps', ['-eo', 'pid=,user:12=,pcpu=,rss=,comm=', '--sort=-pcpu']);
  const groups = new Map();
  out.split('\n').filter(Boolean).forEach((line) => {
    const [pid, user, cpu, rss, ...rest] = line.trim().split(/\s+/);
    const command = rest.join(' ');
    if (command === 'ps') return; // this list's own check
    const group = groups.get(command) || { command, count: 0, cpu: 0, memoryMb: 0, pids: [], mine: true, users: new Set() };
    group.count += 1;
    group.cpu += Number(cpu) || 0;
    group.memoryMb += Number(rss) / 1024;
    group.pids.push(Number(pid));
    group.users.add(user);
    if (user !== os.userInfo().username) group.mine = false;
    groups.set(command, group);
  });
  return [...groups.values()]
    .map((group) => ({ ...group, cpu: Math.round(group.cpu * 10) / 10, memoryMb: Math.round(group.memoryMb), users: [...group.users] }))
    .sort((a, b) => b.cpu - a.cpu || b.memoryMb - a.memoryMb);
}

// How hard each open room is working. Docker takes a second or two to measure, so the last
// answer is kept and refreshed in the background rather than holding up the panel.
let roomUse = { time: 0, rooms: {} };
let measuring = null;
function roomStats() {
  if (!measuring && Date.now() - roomUse.time > 4000) {
    measuring = (async () => {
      const list = await run('docker', ['ps', '--filter', 'label=house.room', '--format', '{{.ID}}|{{.Label "house.room"}}'], 8000);
      const names = new Map(list.split('\n').filter(Boolean).map((line) => line.split('|')));
      const next = {};
      if (names.size) {
        const out = await run('docker', ['stats', '--no-stream', '--format', '{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}', ...names.keys()], 15000);
        out.split('\n').filter(Boolean).forEach((line) => {
          const [id, cpu, memory] = line.split('|');
          const name = [...names.entries()].find(([full]) => full.startsWith(id) || id.startsWith(full))?.[1];
          if (!name) return;
          const used = (memory || '').split('/')[0].trim();
          const amount = parseFloat(used) || 0;
          const unit = used.replace(/[\d.\s]/g, '').toLowerCase();
          const scale = { b: 1 / 2 ** 20, kib: 1 / 1024, kb: 1 / 1024, mib: 1, mb: 1, gib: 1024, gb: 1024 }[unit] || 1;
          next[name] = { cpu: parseFloat(cpu) || 0, memoryMb: Math.round(amount * scale) };
        });
      }
      roomUse = { time: Date.now(), rooms: next };
    })().catch(() => { roomUse.time = Date.now(); }).finally(() => { measuring = null; });
  }
  return roomUse.rooms;
}

async function system() {
  const [cpu, meminfo, disk, list, log, helperRaw, resizeResult, helperConfig] = await Promise.all([
    cpuPercent(),
    fs.readFile('/proc/meminfo', 'utf8'),
    fs.statfs('/'),
    processes(),
    readTail(path.join(STATE, 'room.log'), 65536),
    readOr(path.join(STATE, 'windows.json'), ''),
    readOr(path.join(STATE, 'resize-result.txt'), ''),
    readOr(HELPER_CONFIG, ''),
  ]);
  const value = (key) => Number((meminfo.match(new RegExp(`${key}:\\s+(\\d+)`)) || [])[1] || 0) / 1048576;
  let windows = null;
  try {
    windows = JSON.parse(helperRaw);
    windows.fresh = Date.now() - windows.time < 120000;
  } catch { /* helper hasn't reported */ }
  let keepAwake = true;
  try { keepAwake = JSON.parse(helperConfig).keepAwake !== false; } catch { /* default on */ }
  return {
    cpu,
    cores: os.cpus().length,
    upSeconds: Math.round(os.uptime()),
    roomUse: roomStats(),
    memoryTotal: value('MemTotal'),
    memoryUsed: value('MemTotal') - value('MemAvailable'),
    diskTotal: (disk.blocks * disk.bsize) / 2 ** 30,
    diskUsed: ((disk.blocks - disk.bfree) * disk.bsize) / 2 ** 30,
    processes: list,
    activity: activity(log),
    windows,
    keepAwake,
    resizeResult,
  };
}

// Takes one process or a list (every copy of one program). Station 256 itself is never ended here.
async function endProcess(pids) {
  const list = Array.isArray(pids) ? pids : [pids];
  if (!list.length || list.some((pid) => !Number.isInteger(pid) || pid < 2)) throw new Error('Not a valid process.');
  const failed = [];
  for (const pid of list) {
    if (pid === process.pid || (await readOr(`/proc/${pid}/comm`, '')) === 'electron') throw new Error('That\'s Station 256 itself. To end it, close the window.');
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') failed.push(pid); }
  }
  if (failed.length) throw new Error(`${failed.length} of them couldn't be ended.`);
}

async function setKeepAwake(keepAwake) {
  await fs.mkdir(path.dirname(HELPER_CONFIG), { recursive: true });
  await fs.writeFile(HELPER_CONFIG, JSON.stringify({ keepAwake: Boolean(keepAwake) }));
}

// Changing the size needs Windows, so this leaves a request for the Windows helper.
async function requestResize(gigabytes) {
  const info = await system();
  const size = Number(gigabytes);
  if (!Number.isInteger(size)) throw new Error('Enter a whole number of GB.');
  if (!info.windows || !info.windows.fresh) throw new Error('The Windows helper isn\'t running, so the size can\'t be changed right now.');
  const minimum = Math.ceil(info.diskUsed) + 20;
  // The house's disk only takes up what it's actually using, so its unused space can't be counted
  // as room to grow: all of it could still end up on the PC's drive.
  const maximum = Math.floor(info.diskUsed + info.windows.cFreeGb - 50);
  if (size < minimum) throw new Error(`Too small. The house is using ${Math.ceil(info.diskUsed)} GB, so the minimum is ${minimum} GB.`);
  if (size > maximum) throw new Error(`Too big. With ${Math.round(info.windows.cFreeGb)} GB free on your PC, and 50 GB kept for Windows, the maximum is ${maximum} GB.`);
  const dir = path.join(STATE, 'requests');
  await fs.mkdir(dir, { recursive: true });
  await fs.rm(path.join(STATE, 'resize-result.txt'), { force: true }); // an old result mustn't look like this one
  // Stamped with the time, so a request left behind can never restart the house later.
  try {
    await fs.writeFile(path.join(dir, 'resize'), `${size} ${Date.now()}`);
  } catch (error) {
    if (error.code === 'ENOSPC') throw new Error('The house is completely full, so this can\'t be saved. Delete some files, empty the trash, then try again.');
    throw error;
  }
}

module.exports = {
  paths, status, rooms, isLowOnSpace, heldByRooms, newProject, closeRoom, openDoor, closeDoor, getRules, setRule, ensureRules: rules.ensureFiles, system, endProcess, setKeepAwake, requestResize,
};
