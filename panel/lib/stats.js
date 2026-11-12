// The Home page: a few fun numbers, the projects, and recent files. Everything comes from records
// the house already keeps:
//   - day streak and files AI changed: the notes each room's AI tools write (lib/edits.js), plus
//     the days AI used tokens
//   - AI tokens: AI conversation files, in the house and in each room's records (token-count.js)
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const edits = require('./edits');
const owner = require('./owner');
const ownerSaves = require('./owner-saves');
const touches = require('./touches');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, 'projects');
const STATE = path.join(HOME, '.local', 'state', 'house');
const TOKEN_CACHE = path.join(STATE, 'token-counts.json');
const PERSONAL = ['Documents', 'Downloads', 'Pictures', 'Music', 'Videos'];
const IMAGE = 'house-room:latest';
const ROOM_RECORDS = '/home/dev/.claude';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RECENT_DAYS = 30;
const RECENT_COUNT = 20;
// What builds and installs make, not what anyone works on: left out of recent files and the count.
// So is anything hidden (a name starting with a dot, like .rust/ or .git/), at any depth.
const BUILD_FOLDERS = /\/(node_modules|target|dist|build|out|__pycache__|venv|coverage)\//;
const madeByTools = (target) => BUILD_FOLDERS.test(target) || /\/\./.test(target.slice(PROJECTS.length));
const COUNTER = `${require('fs').readFileSync(path.join(__dirname, 'token-count.js'), 'utf8')}\n;runFromStdin();`;

const pad = (value) => String(value).padStart(2, '0');
// A day in the house's own time, as YYYY-MM-DD.
function dayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
// The day `count` days before today, on the calendar (a day the clocks change on is still one day).
function daysAgo(count) {
  const now = new Date();
  return dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - count).getTime());
}
// "This week" is a calendar week, like "today" is a calendar day: Sunday (where Windows starts the
// week here) up to today. It starts again at Sunday midnight.
const WEEK_STARTS = 0; // Sunday
const thisWeek = () => Array.from({ length: ((new Date().getDay() - WEEK_STARTS + 7) % 7) + 1 }, (_, i) => daysAgo(i));

function run(command, args, { input, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    if (input !== undefined) child.stdin.end(input);
  });
}

/* ---------- AI tokens ---------- */

// { sources: { "house" | "room:<id>": { files: { [file]: { offset, ids, days } }, dirty } } }
async function loadCounts() {
  try {
    const saved = JSON.parse(await fs.readFile(TOKEN_CACHE, 'utf8'));
    if (saved && typeof saved.sources === 'object') return saved;
  } catch { /* none yet */ }
  return { sources: {} };
}

async function saveCounts(counts) {
  const temp = `${TOKEN_CACHE}.${process.pid}.new`;
  await fs.mkdir(STATE, { recursive: true });
  await fs.writeFile(temp, JSON.stringify(counts));
  await fs.rename(temp, TOKEN_CACHE);
}

const MAX_TOUCHED = 4000; // files remembered per conversation file
const number = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);

// Runs the counter for one place and adds what it found. What comes back from a room is only
// ever read as numbers.
async function countSource(source, command, args, root) {
  const files = {};
  // A file counted before "touch" existed is read again from the start, once (its old totals stay until the new ones arrive).
  Object.entries(source.files).forEach(([file, record]) => { files[file] = record.touch ? { offset: record.offset, ids: record.ids, open: record.open } : { offset: 0, ids: [] }; });
  const input = JSON.stringify({ root, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, files });
  const answer = JSON.parse(await run(command, args, { input, timeout: 180000 }));
  const found = answer && typeof answer.files === 'object' ? Object.entries(answer.files).slice(0, 5000) : [];
  for (const [file, update] of found) {
    if (file.length > 4096 || !update || typeof update !== 'object') continue;
    const record = update.reset || !source.files[file] || !source.files[file].touch ? { offset: 0, ids: [], days: {}, touch: {} } : source.files[file];
    Object.entries(update.days || {}).forEach(([day, pair]) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(pair)) return;
      const have = record.days[day] || (record.days[day] = [0, 0]);
      have[0] += number(pair[0]);
      have[1] += number(pair[1]);
    });
    Object.entries(update.touch && typeof update.touch === 'object' ? update.touch : {}).forEach(([target, got]) => {
      if (!target.startsWith('/') || target.length > 1024 || !Array.isArray(got)) return; // a path, never a name like "__proto__"
      const have = record.touch[target] || (Object.keys(record.touch).length < MAX_TOUCHED ? (record.touch[target] = [0, '', 0, 0]) : null);
      if (!have) return;
      if (number(got[0]) >= have[0]) { have[0] = number(got[0]); have[1] = typeof got[1] === 'string' ? got[1].slice(0, 80) : ''; }
      // A share can come back smaller (a minus number) when a reply went on to read more files.
      have[2] = Math.max(0, have[2] + (Number.isFinite(got[2]) ? got[2] : 0));
      have[3] = Math.max(0, have[3] + (Number.isFinite(got[3]) ? got[3] : 0));
    });
    if (Number.isFinite(update.offset) && update.offset >= 0) record.offset = update.offset;
    record.ids = Array.isArray(update.ids) ? update.ids.filter((id) => typeof id === 'string' && id.length < 200).slice(-40) : [];
    const open = update.open;
    record.open = Array.isArray(open) && typeof open[0] === 'string' && open[0].length < 200
      ? [open[0], number(open[1]), number(open[2]), (Array.isArray(open[3]) ? open[3] : []).filter((target) => typeof target === 'string' && target.length <= 1024).slice(0, 50)]
      : undefined;
    source.files[file] = record;
  }
  // A record whose conversation file is gone or empty got no answer: it has had its one fresh read, so
  // it isn't asked for again on every count (for a closed room that would start a container each time).
  Object.values(source.files).forEach((record) => { if (!record.touch) record.touch = {}; });
}

// Tokens by day, all places together: { "YYYY-MM-DD": [in, out] }.
function byDay(counts) {
  const days = {};
  Object.values(counts.sources).forEach((source) => Object.values(source.files || {}).forEach((record) => {
    Object.entries(record.days || {}).forEach(([day, [read, wrote]]) => {
      const have = days[day] || (days[day] = [0, 0]);
      have[0] += number(read);
      have[1] += number(wrote);
    });
  }));
  return days;
}

function tokenSummary(counts) {
  const days = byDay(counts);
  const today = days[dayKey(Date.now())] || [0, 0];
  const week = thisWeek().reduce((sum, day) => [sum[0] + (days[day]?.[0] || 0), sum[1] + (days[day]?.[1] || 0)], [0, 0]);
  const all = Object.values(days).reduce((sum, [read, wrote]) => [sum[0] + number(read), sum[1] + number(wrote)], [0, 0]);
  return { todayIn: today[0], todayOut: today[1], weekIn: week[0], weekOut: week[1], allIn: all[0], allOut: all[1] };
}

// The house's own AI records, then each room's: an open room is asked directly, and a closed one
// is read once from its records after it closes (they can't change while it's closed).
const reread = new Set(); // closed rooms read again since Station started
async function countAll() {
  const counts = await loadCounts();
  const source = (key) => {
    const have = counts.sources[key];
    if (have && typeof have.files === 'object') {
      if (Object.values(have.files).some((record) => !record.touch)) have.dirty = true; // counted again once, for "touch"
      return have;
    }
    counts.sources[key] = { files: {}, dirty: true };
    return counts.sources[key];
  };
  await countSource(source('house'), 'node', ['-e', COUNTER], path.join(HOME, '.claude', 'projects')).catch(() => {});
  const listed = await run('docker', ['volume', 'ls', '--filter', 'name=house-claude-', '--format', '{{.Name}}'], { timeout: 8000 }).catch(() => null);
  const running = await run('docker', ['ps', '--filter', 'label=house.room', '--format', '{{.Names}}'], { timeout: 8000 }).catch(() => null);
  if (listed !== null && running !== null) {
    const up = new Set(running.split('\n').filter(Boolean));
    for (const volume of listed.split('\n').filter(Boolean)) {
      const id = volume.slice('house-claude-'.length);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) continue;
      const room = source(`room:${id}`);
      if (up.has(`room-${id}`)) {
        await countSource(room, 'docker', ['exec', '-i', `room-${id}`, 'node', '-e', COUNTER], `${ROOM_RECORDS}/projects`).catch(() => {});
        room.dirty = true; // read once more after it closes
      } else if (room.dirty || !reread.has(id)) { // a room opened and closed between two counts is never seen running
        const args = ['run', '--rm', '-i', '--network', 'none', '--entrypoint', 'node', '-v', `${volume}:${ROOM_RECORDS}:ro`, IMAGE, '-e', COUNTER];
        await countSource(room, 'docker', args, `${ROOM_RECORDS}/projects`).then(() => { room.dirty = false; reread.add(id); }, () => {});
      }
    }
  }
  await saveCounts(counts).catch(() => {});
  return counts;
}

let counting = null;
let countedAt = 0;
// Counted at most every 30 seconds; asked again sooner, the last count saved is the answer.
async function tokens() {
  if (Date.now() - countedAt < 30000) return tokenSummary(await loadCounts());
  if (!counting) {
    counting = countAll()
      .then((counts) => { countedAt = Date.now(); return tokenSummary(counts); })
      .finally(() => { counting = null; });
  }
  return counting;
}

/* ---------- Projects, AI edits and recent files ---------- */

async function projectList() {
  const items = await fs.readdir(PROJECTS, { withFileTypes: true }).catch(() => []);
  const projects = await Promise.all(items.filter((item) => item.isDirectory() && !item.name.startsWith('.')).map(async (item) => {
    const full = path.join(PROJECTS, item.name);
    const stat = await fs.stat(full).catch(() => null);
    return { name: item.name, path: full, mtime: stat ? stat.mtimeMs : 0, lastEdit: null, changedToday: 0 };
  }));
  return projects;
}

const projectOf = (target) => (target.startsWith(`${PROJECTS}/`) ? target.slice(PROJECTS.length + 1).split('/')[0] : null);

function where(target) {
  const folder = path.dirname(target);
  const inHome = folder.startsWith(`${HOME}/`) ? folder.slice(HOME.length + 1) : folder;
  return { folder, location: inHome.startsWith('projects/') ? inHome.slice('projects/'.length) : inHome };
}

async function fileEntry(target, who) {
  const stat = await fs.stat(target).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  const entry = { name: path.basename(target), path: target, isDir: false, size: stat.size, mtime: stat.mtimeMs, ...where(target) };
  // The same decision as the file list (edits.judge): the AI, a likely AI command, or the owner.
  edits.judge(entry, who.rooms, who.saves, who.me);
  return entry;
}

async function personalFiles(since, who) {
  const found = [];
  for (const folder of PERSONAL) {
    const dir = path.join(HOME, folder);
    const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    await Promise.all(items.filter((item) => item.isFile() && !item.name.startsWith('.')).map(async (item) => {
      const entry = await fileEntry(path.join(dir, item.name), who);
      if (entry && entry.mtime >= since) found.push(entry);
    }));
  }
  return found;
}

async function home() {
  const today = dayKey(Date.now());
  const [rooms, projects, counts] = await Promise.all([
    edits.allRooms().catch(() => []),
    projectList(),
    loadCounts(),
  ]);
  const byName = new Map(projects.map((project) => [project.name, project]));
  const lifetime = touches.lifetimeByProject(counts, projects.map((project) => project.name));
  projects.forEach((project) => { project.tokensAllTime = lifetime.get(project.name) || 0; });
  const latest = new Map(); // file -> its newest note
  const activeDays = new Set();
  const changedToday = new Set();
  rooms.forEach((byPath) => byPath.forEach((notes, target) => {
    const project = byName.get(projectOf(target));
    const byTools = madeByTools(target);
    notes.forEach((note) => {
      const day = dayKey(note.time);
      activeDays.add(day);
      if (day === today && note.action !== 'delete' && !byTools && !changedToday.has(target)) {
        changedToday.add(target);
        if (project) project.changedToday += 1;
      }
    });
    const newest = notes[0];
    if (!newest) return;
    if (!byTools && (!latest.has(target) || latest.get(target).time < newest.time)) latest.set(target, newest);
    if (project && (!project.lastEdit || project.lastEdit.time < newest.time)) project.lastEdit = { ...newest, file: target.slice(project.path.length + 1) };
  }));
  Object.entries(byDay(counts)).forEach(([day, [, wrote]]) => { if (wrote > 0) activeDays.add(day); });

  // Days in a row with AI work, back from today. Today doesn't break it until it's over.
  let streak = 0;
  const workedToday = activeDays.has(today);
  for (let i = workedToday ? 0 : 1; activeDays.has(daysAgo(i)); i += 1) streak += 1;

  const busiest = projects.reduce((best, project) => (project.changedToday > (best?.changedToday || 0) ? project : best), null);

  const since = Date.now() - RECENT_DAYS * DAY;
  const who = { rooms, saves: await ownerSaves.latest(), me: await owner.name() };
  const aiFiles = [...latest.entries()].filter(([, note]) => note.time >= since).sort((a, b) => b[1].time - a[1].time).slice(0, 60);
  const recent = (await Promise.all([
    Promise.all(aiFiles.map(([target]) => fileEntry(target, who))),
    personalFiles(since, who),
  ])).flat().filter(Boolean);
  const seen = new Set();
  const unique = recent.sort((a, b) => b.mtime - a.mtime).filter((entry) => !seen.has(entry.path) && seen.add(entry.path));

  projects.sort((a, b) => Math.max(b.mtime, b.lastEdit?.time || 0) - Math.max(a.mtime, a.lastEdit?.time || 0));
  return {
    streak: { days: streak, today: workedToday },
    files: { today: changedToday.size, busiest: busiest ? { name: busiest.name, count: busiest.changedToday } : null },
    tokens: tokenSummary(counts),
    projects,
    recent: unique.slice(0, RECENT_COUNT),
  };
}

module.exports = { home, tokens, dayKey };
