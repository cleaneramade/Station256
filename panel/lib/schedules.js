// Scheduled tasks: a command, or an AI prompt, run in one or more projects' rooms on a repeat.
// The task list is ~/.config/house/schedules.json (written only by the panel). The runs are done by
// a small separate program (schedules-runner.js) that keeps going after Station 256 closes, as long
// as the house is awake: it keeps its own results in ~/.local/state/house/schedules/status.json and
// each run's output in <task id>/<time>.log. The panel starts it when it isn't running (one lock
// file, runner.pid), asks it to "Run now" with a file in requests/, and just watches status.json.
// A run missed while the house was asleep is skipped, and a task never runs twice at once. The
// system crontab and systemd aren't used. Times are in lib/cron.js.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const { createWriteStream, watch } = require('fs');
const os = require('os');
const path = require('path');
const cron = require('./cron');

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9_-])?$/; // a project's name, as in house.js
const LIMIT_MS = 30 * 60000; // a run (in one project) is stopped after this
const GRACE_MS = 20000; // the room's own timer stops it first; this one is only the backstop
const KEEP_LOGS = 20;
const MAX_LOG = 5 * 1024 * 1024; // a run's output past this is dropped, with a note
const MAX_DELAY = 24 * 86400000; // setTimeout can't wait much longer than this
const LATE_MS = 5 * 60000; // a timer this late (the house slept) means the run was missed: skipped
const ROOM_WAIT_MS = 120000;
const MAX_PROJECTS = 30;
const MAX_FILE = 2 * 1024 * 1024; // a schedules file bigger than this isn't ours: it is left unread

const stamp = (date) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
};
const exists = (file) => fs.access(file).then(() => true, () => false);

// options.local: this one runs the tasks itself (the runner program, and checks). Without it, this
// is the panel's side: it edits the list, and asks the runner program to do the running.
function createRunner(options = {}) {
  const home = options.home || os.homedir();
  const configFile = path.join(home, '.config', 'house', 'schedules.json');
  const logRoot = path.join(home, '.local', 'state', 'house', 'schedules');
  const statusFile = path.join(logRoot, 'status.json');
  const pidFile = path.join(logRoot, 'runner.pid');
  const requestsDir = path.join(logRoot, 'requests');
  const projectsDir = path.join(home, 'projects');
  const roomBin = options.room || path.join(home, '.local', 'bin', 'room');
  const dockerBin = options.docker || 'docker';
  const runnerScript = options.runnerScript || path.join(__dirname, 'schedules-runner.js');
  const limitMs = options.limitMs || LIMIT_MS;
  const graceMs = options.graceMs ?? GRACE_MS;
  const unitMs = options.unitMs || 60000; // "a minute", shorter only in checks
  const allowFast = Boolean(options.allowFast); // every minute and the like, only in checks
  const local = Boolean(options.local);
  const onChange = options.onChange || (() => {});
  const onIdle = options.onIdle || null;

  let tasks = null;
  let problem = '';
  let timer = null;
  let started = false;
  let stopped = false;
  let saving = Promise.resolve();
  let statusData = { tasks: {}, running: {} }; // the runner's results; only the runner writes the file
  let statusSaving = Promise.resolve();
  const watchers = [];
  const nexts = new Map(); // task id -> the time of its next run
  const running = new Map(); // task id -> the promise of the run going now
  const children = new Set();

  // ---- The saved list
  // Reads the file. damaged: it couldn't be understood at all.
  async function readDefinitions() {
    let text;
    try {
      if ((await fs.stat(configFile)).size > MAX_FILE) return { list: [], problem: 'The schedules file is far too big to be right, so the list is empty.', damaged: 'unreadable' };
      text = await fs.readFile(configFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { list: [], problem: '' };
      return { list: [], problem: `The schedules file couldn't be read (${error.code || error.message}), so the list is empty.`, damaged: 'unreadable' };
    }
    try {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.tasks)) throw new Error('not a list of tasks');
      const list = [];
      let dropped = 0;
      for (const raw of data.tasks) {
        try { list.push(tidy(raw)); } catch { dropped += 1; }
      }
      return { list, problem: dropped ? `${dropped} task${dropped === 1 ? '' : 's'} in the schedules file couldn't be read and ${dropped === 1 ? 'was' : 'were'} left out.` : '' };
    } catch {
      return { list: [], problem: '', damaged: 'bad' };
    }
  }

  async function load() {
    if (tasks) return;
    const found = await readDefinitions();
    tasks = found.list;
    problem = found.problem;
    if (found.damaged === 'bad') {
      // Keep the bad file, so nothing the owner typed is lost, and start with an empty list.
      const copy = `${configFile}.bad-${stamp(new Date())}`;
      await fs.copyFile(configFile, copy).catch(() => {});
      problem = `The schedules file was damaged, so the list started empty. The old file is kept as ${path.basename(copy)} in ~/.config/house.`;
    }
  }

  // The runner, after the panel changed the file. A file that can't be read keeps the list it has.
  async function reload() {
    const found = await readDefinitions();
    if (found.damaged) return;
    tasks = found.list;
    plan();
    checkExit();
  }

  // A task as read from the file or the page: checked, and only the parts that belong.
  function tidy(raw, existing) {
    const name = String(raw.name || '').trim();
    if (!name || name.length > 60) throw new Error('Give the task a name, up to 60 letters.');
    const picked = Array.isArray(raw.projects) ? raw.projects : (raw.project ? [raw.project] : []);
    const projects = [...new Set(picked.map(String))];
    if (!projects.length) throw new Error('Pick at least one project.');
    if (projects.length > MAX_PROJECTS || projects.some((one) => !NAME.test(one))) throw new Error('Pick projects from the list.');
    if (raw.kind !== 'command' && raw.kind !== 'ai') throw new Error('Pick what to run: a command or an AI prompt.');
    const run = String(raw.run || '').trim();
    if (!run) throw new Error(raw.kind === 'ai' ? 'Write the prompt for the AI.' : 'Write the command to run.');
    if (run.length > 8000 || run.includes('\0')) throw new Error('That is too long, or has odd characters in it.');
    const when = cron.cleanWhen(raw.when, { allowFast });
    const same = existing && JSON.stringify(existing.when) === JSON.stringify(when);
    return {
      id: existing ? existing.id : (/^[a-f0-9]{12}$/.test(raw.id) ? raw.id : crypto.randomBytes(6).toString('hex')),
      name,
      projects,
      kind: raw.kind,
      run,
      when,
      // "Every n minutes" counts from here; saving a new time starts the count again.
      anchor: existing ? (same ? existing.anchor : Date.now()) : (Number.isFinite(raw.anchor) ? raw.anchor : Date.now()),
      enabled: raw.enabled !== false,
    };
  }

  // One write at a time, a temporary file then a rename, so a crash can't leave half a file.
  async function writeAtomic(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
    await fs.rename(temp, file);
  }

  function save() {
    saving = saving.then(() => writeAtomic(configFile, { version: 2, tasks }))
      .catch((error) => { problem = `The schedules couldn't be saved: ${error.message}`; });
    return saving;
  }

  async function readStatus() {
    try {
      const data = JSON.parse(await fs.readFile(statusFile, 'utf8'));
      return { tasks: data.tasks || {}, running: data.running || {} };
    } catch {
      return { tasks: {}, running: {} };
    }
  }

  function saveStatus() {
    statusSaving = statusSaving.then(() => writeAtomic(statusFile, statusData)).catch(() => {});
    return statusSaving;
  }

  const find = (id) => {
    const task = tasks.find((one) => one.id === id);
    if (!task) throw new Error('That task is gone.');
    return task;
  };

  // ---- The runner program: one at a time, found by its lock file
  async function runnerPid() {
    try {
      const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      if (!Number.isInteger(pid) || pid < 2) return 0;
      // The pid must still be the runner (a number can be reused by another program).
      const line = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
      return line.includes('house-schedules') ? pid : 0;
    } catch {
      return 0;
    }
  }

  // The runner takes the lock for itself. A lock left by a runner that is gone is cleared.
  async function lock() {
    await fs.mkdir(logRoot, { recursive: true });
    // The lock appears with the pid already in it (a link to a finished file), so a second runner
    // starting in the same instant never reads it empty and takes it for one left behind.
    const mine = `${pidFile}.${process.pid}`;
    await fs.writeFile(mine, String(process.pid));
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await fs.link(mine, pidFile);
          // Two clearing the same old lock at once can each think they won: after a moment, only
          // the one whose pid is still in the file stays.
          await new Promise((done) => setTimeout(done, 120));
          return Number(await fs.readFile(pidFile, 'utf8').catch(() => 0)) === process.pid;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const other = await runnerPid();
          if (other && other !== process.pid) return false;
          await fs.rm(pidFile, { force: true });
        }
      }
      return false;
    } finally {
      await fs.rm(mine, { force: true }).catch(() => {});
    }
  }

  async function unlock() {
    if (Number(await fs.readFile(pidFile, 'utf8').catch(() => 0)) === process.pid) await fs.rm(pidFile, { force: true });
  }

  // Starts the runner if it isn't running. It lives on after Station 256 closes. If two start at
  // once, the second sees the lock and ends at once.
  async function ensureRunner() {
    if (local || (await runnerPid())) return;
    const args = [runnerScript, `--home=${home}`];
    const launch = (command, env) => {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', env });
      child.on('error', (error) => {
        // No `node` on the path: Electron can run the same file as plain node.
        if (error.code === 'ENOENT' && command === 'node') launch(process.execPath, { ...process.env, ELECTRON_RUN_AS_NODE: '1' });
      });
      child.unref();
    };
    launch('node', process.env);
  }

  // ---- What the page sees
  function view(task, status, alive) {
    const mine = status.tasks[task.id] || {};
    const next = task.enabled ? cron.nextRun(task.when, Date.now(), task.anchor, unitMs) : null;
    return {
      id: task.id,
      name: task.name,
      projects: task.projects,
      kind: task.kind,
      run: task.run,
      when: task.when,
      words: cron.describe(task.when),
      enabled: task.enabled,
      last: mine.last || null,
      lastSkip: mine.lastSkip || null,
      running: Boolean(status.running[task.id]) && alive,
      next,
      nextLabel: next ? cron.formatTime(next) : '',
    };
  }

  async function list() {
    await load();
    const status = local ? statusData : await readStatus();
    const alive = local || Boolean(await runnerPid());
    // A runner that ended badly is started again the next time the page looks.
    if (!alive && started && !stopped && tasks.some((task) => task.enabled)) await ensureRunner();
    return { tasks: tasks.map((task) => view(task, status, alive)), problem, fast: allowFast, limitMinutes: Math.round(limitMs / 60000), runnerOn: alive };
  }

  // Live "Next run" while the page is edited. Nothing is saved.
  function preview(when) {
    try {
      const clean = cron.cleanWhen(when, { allowFast });
      const next = cron.nextRun(clean, Date.now(), Date.now(), unitMs);
      return { ok: true, words: cron.describe(clean), next, nextLabel: next ? cron.formatTime(next) : 'Never' };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async function projects() {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory() && NAME.test(entry.name)).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  }

  // ---- Editing the list. The runner notices the file change (or, here, plans again).
  async function changed() {
    await save();
    if (local) plan();
    else if (tasks.some((task) => task.enabled)) await ensureRunner();
    onChange();
  }

  async function saveTask(input) {
    await load();
    const existing = input.id ? find(input.id) : null;
    const task = tidy(input, existing);
    const have = await projects();
    const missing = task.projects.find((one) => !have.includes(one));
    if (missing) throw new Error(`There's no project called "${missing}".`);
    if (existing) tasks[tasks.indexOf(existing)] = task;
    else tasks.push(task);
    await changed();
    return list();
  }

  async function setEnabled(id, on) {
    await load();
    find(id).enabled = Boolean(on);
    await changed();
    return list();
  }

  const isRunning = async (id) => (local ? running.has(id) : Boolean((await readStatus()).running[id]) && Boolean(await runnerPid()));

  async function remove(id) {
    await load();
    const task = find(id);
    if (await isRunning(id)) throw new Error('It is running right now. Try again when it has finished.');
    tasks.splice(tasks.indexOf(task), 1);
    await changed();
    // The task's saved output goes too (this folder is the task's own, inside the schedules folder).
    await fs.rm(path.join(logRoot, task.id), { recursive: true, force: true }).catch(() => {});
    return list();
  }

  async function runNow(id) {
    await load();
    const task = find(id);
    if (await isRunning(id)) throw new Error('It is still running.');
    if (local) {
      begin(task, true);
    } else {
      await fs.mkdir(requestsDir, { recursive: true });
      await fs.writeFile(path.join(requestsDir, task.id), String(Date.now()));
      await ensureRunner();
    }
    return list();
  }

  async function output(id) {
    await load();
    const task = find(id);
    const status = local ? statusData : await readStatus();
    const last = status.tasks[task.id] && status.tasks[task.id].last;
    if (!last || !last.log) return { text: '', at: null };
    let text;
    try {
      text = await fs.readFile(path.join(logRoot, task.id, path.basename(last.log)), 'utf8');
    } catch {
      return { text: '', at: last.at };
    }
    return { text: text.length > 200000 ? `...\n${text.slice(-200000)}` : text, at: last.at, ok: last.ok };
  }

  // ---- The timer: one, for the soonest task.
  function plan(floors = new Map()) {
    clearTimeout(timer);
    timer = null;
    nexts.clear();
    if (!tasks) return;
    const now = Date.now();
    for (const task of tasks) {
      if (!task.enabled) continue;
      try {
        const after = Math.max(now, floors.get(task.id) || 0);
        const next = cron.nextRun(task.when, after, task.anchor, unitMs);
        if (next !== null) nexts.set(task.id, next);
      } catch {
        // A time that can't be worked out leaves that one task out, not the rest.
      }
    }
    if (!started || stopped || !nexts.size) return;
    const soonest = Math.min(...nexts.values());
    timer = setTimeout(fire, Math.min(Math.max(soonest - now, 0), MAX_DELAY));
  }

  function fire() {
    timer = null;
    if (stopped) return;
    const now = Date.now();
    const floors = new Map();
    for (const task of tasks) {
      const due = nexts.get(task.id);
      if (!task.enabled || due === undefined || due > now + 500) continue;
      floors.set(task.id, due); // the next one comes after this one, even if the timer fired early
      if (now - due > LATE_MS) continue; // missed (the house was asleep): skipped, never made up
      if (running.has(task.id)) {
        skipped(task, now);
        continue;
      }
      begin(task, false);
    }
    plan(floors);
  }

  function skipped(task, now) {
    statusData.tasks[task.id] = { ...statusData.tasks[task.id], lastSkip: { at: now, note: 'Skipped: the last run was still going.' } };
    fs.mkdir(logRoot, { recursive: true })
      .then(() => fs.appendFile(path.join(logRoot, 'schedules.log'), `${new Date(now).toISOString()} ${task.name}: still running, this run was skipped\n`))
      .catch(() => {});
    saveStatus().then(onChange);
  }

  // ---- Running one task
  function runChild(command, args, { input, out, limit }) {
    return new Promise((resolve) => {
      let child;
      let collected = '';
      let timedOut = false;
      try {
        child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ error: error.message });
        return;
      }
      children.add(child);
      let written = 0;
      const take = (chunk) => {
        if (!out) { if (collected.length < 65536) collected += chunk; return; }
        if (written < MAX_LOG) out.write(chunk);
        else if (written === MAX_LOG) out.write('\n[Too much output. The rest was dropped.]\n');
        written += chunk.length;
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      if (input !== undefined) {
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      }
      let hardKill = null;
      const stopper = limit ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        hardKill = setTimeout(() => child.kill('SIGKILL'), 3000);
      }, limit) : null;
      const finish = (result) => {
        clearTimeout(stopper);
        clearTimeout(hardKill);
        children.delete(child);
        resolve({ ...result, timedOut, stdout: collected });
      };
      child.on('error', (error) => finish({ error: error.message }));
      child.on('close', (code, signal) => finish({ code, signal }));
    });
  }

  const roomName = (project) => `room-${project.replace(/ /g, '.')}`; // the same as room_id in bin/room

  async function roomIsUp(project) {
    const asked = await runChild(dockerBin, ['ps', '--filter', `label=house.room=${project}`, '--format', '{{.Names}}'], { limit: 15000 });
    if (asked.error || asked.code !== 0) throw new Error('Docker isn\'t answering, so the room was left alone.');
    return asked.stdout.trim().length > 0;
  }

  // Starts the project's room without opening a window or a terminal (the way docs/05-tests.md
  // says: room open NAME with nothing to type into). Says whether this run started it.
  async function ensureRoom(project, say, out) {
    if (await roomIsUp(project)) return false;
    say('The room is off, so it is being started.');
    await runChild(roomBin, ['open', project], { out, limit: ROOM_WAIT_MS });
    if (!(await roomIsUp(project))) throw new Error('The room wouldn\'t start. The lines above say why.');
    return true;
  }

  // What a room nobody is using has in it: its own start-up, the ssh door, and Herdr waiting.
  const ROOM_OWN = [/^\/sbin\/docker-init /, /^sleep infinity$/, /^sshd: \/\S*sshd /, /(^|\/)herdr server$/];

  // Why a room must stay open, or '' when nobody else is in it. Anything in the room besides its
  // own start-up counts: a terminal, an AI session, an ssh line, another task's run, a Station tab.
  // When it can't tell, it says so, and the room stays open: a room is never closed under someone.
  async function roomInUse(project) {
    const top = await runChild(dockerBin, ['top', roomName(project), '-eo', 'pid,tty,args'], { limit: 15000 });
    if (top.error || top.code !== 0 || top.stdout.length >= 65536) return 'it could not be checked for other work';
    const lines = top.stdout.split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return 'it could not be checked for other work';
    for (const line of lines) {
      const [, tty, ...rest] = line.split(/\s+/);
      const what = rest.join(' ');
      if (tty !== '?' || !ROOM_OWN.some((own) => own.test(what))) return 'something else is running in it';
    }
    const tabs = await runChild(roomBin, ['tabs', project], { limit: 30000 });
    if (tabs.error || tabs.code !== 0) return 'its terminals could not be checked';
    return tabs.stdout.trim() ? 'a terminal is still running in it' : '';
  }

  function begin(task, manual) {
    statusData.running[task.id] = { since: Date.now() };
    saveStatus().then(onChange);
    const promise = execute(task, manual).catch(() => {}).finally(() => {
      running.delete(task.id);
      delete statusData.running[task.id];
      if (!stopped) saveStatus().then(onChange);
      checkExit();
    });
    running.set(task.id, promise);
  }

  // One project: the room first, then the command or the prompt. Returns { ok, note }.
  async function runIn(project, task, say, out) {
    let ok = false;
    let note = '';
    let startedRoom = false;
    try {
      startedRoom = await ensureRoom(project, say, out);
      const seconds = String(Math.ceil(limitMs / 1000));
      // The room's own `timeout` stops it first, even inside the room; the timer here is the backstop.
      const base = ['exec', '-w', '/workspace', roomName(project), 'timeout', '-k', '15', seconds];
      // The prompt goes in on standard input and the command as one argument, never into a shell
      // line of ours. The room's House Rules are its own files (/etc/claude-code), so they apply.
      const result = task.kind === 'ai'
        ? await runChild(dockerBin, [...base.slice(0, 1), '-i', ...base.slice(1), 'claude', '-p'], { input: task.run, out, limit: limitMs + graceMs })
        : await runChild(dockerBin, [...base, 'bash', '-c', task.run], { out, limit: limitMs + graceMs });
      if (stopped) note = 'The runner was stopped, so the run was stopped.';
      else if (result.error) note = `Couldn't start: ${result.error}`;
      else if (result.timedOut || result.code === 124 || result.code === 137) note = `Stopped after ${limitMs >= 60000 ? `${Math.round(limitMs / 60000)} minutes` : `${Math.round(limitMs / 1000)} seconds`} (the time limit).`;
      else if (result.code === 0) ok = true;
      else note = `Ended with an error (code ${result.code ?? result.signal}).`;
    } catch (error) {
      note = error.message;
    }
    // A room this run had to start is closed again, so it doesn't keep the house awake all night.
    // But only when nobody came into it meanwhile: closing would end their terminal or AI session.
    if (startedRoom && !stopped) {
      const busy = await roomInUse(project);
      if (busy) {
        say(`The room this run started was left open: ${busy}.`);
      } else {
        say('Closing the room this run started.');
        await runChild(roomBin, ['close', project], { out, limit: 60000 });
      }
    }
    return { ok, note };
  }

  async function execute(task, manual) {
    const dir = path.join(logRoot, task.id);
    await fs.mkdir(dir, { recursive: true });
    let name = `${stamp(new Date())}.log`;
    for (let n = 2; await exists(path.join(dir, name)); n += 1) name = `${stamp(new Date())}-${n}.log`;
    const out = createWriteStream(path.join(dir, name), { flags: 'a' });
    const say = (text) => out.write(`${text}\n`);
    say(`${task.name}  (${task.projects.join(', ')})`);
    say(`Started ${new Date().toString()}${manual ? ', with Run now' : ''}`);
    say(task.kind === 'ai' ? `AI prompt: ${task.run}` : `Command: ${task.run}`);
    const results = [];
    for (const project of task.projects) {
      if (stopped) break;
      say('');
      say(`===== ${project} =====`);
      const result = await runIn(project, task, say, out);
      results.push({ project, ...result });
      say('');
      say(`${project}: ${result.ok ? 'worked' : result.note}`);
    }
    say('');
    const ok = results.length > 0 && results.every((one) => one.ok);
    say(`Finished ${new Date().toString()}: ${ok ? 'worked.' : 'something did not work.'}`);
    await new Promise((done) => out.end(done));
    if (stopped) return; // the runner is closing: nothing more to save
    const note = results.filter((one) => !one.ok).map((one) => (task.projects.length > 1 ? `${one.project}: ${one.note}` : one.note)).join('; ');
    statusData.tasks[task.id] = { ...statusData.tasks[task.id], last: { at: Date.now(), ok, note, results, log: name } };
    prune(dir);
  }

  async function prune(dir) {
    const names = (await fs.readdir(dir).catch(() => [])).filter((one) => one.endsWith('.log')).sort();
    for (const old of names.slice(0, Math.max(0, names.length - KEEP_LOGS))) await fs.rm(path.join(dir, old), { force: true }).catch(() => {});
  }

  // ---- Runner program: asked to run now from the panel, and ending when there is nothing to do
  async function processRequests() {
    const names = await fs.readdir(requestsDir).catch(() => []);
    for (const id of names) {
      // Whatever is in the folder goes, even something that isn't a request, so it can't pile up.
      await fs.rm(path.join(requestsDir, id), { recursive: true, force: true }).catch(() => {});
      const task = tasks.find((one) => one.id === id);
      if (!task) continue;
      if (running.has(id)) skipped(task, Date.now());
      else begin(task, true);
    }
  }

  // Ends the runner when no task is switched on and nothing is running (nothing keeps it going
  // for no reason). A request that just arrived keeps it.
  async function checkExit() {
    if (!started || stopped || !onIdle || running.size || tasks.some((task) => task.enabled)) return;
    // Looked at once, not again and again: something that can't be cleared mustn't spin forever.
    if ((await fs.readdir(requestsDir).catch(() => [])).length) await processRequests();
    if (!running.size && !stopped) onIdle();
  }

  // The runner program's whole life: lock, watch the list and the requests, plan, run.
  async function serve() {
    if (!(await lock())) return false;
    await load();
    statusData = await readStatus();
    statusData.running = {}; // a runner that ended badly left these behind
    await fs.mkdir(requestsDir, { recursive: true });
    started = true;
    // A short wait of its own for each, so a Run now right after a change can't cancel the reload.
    const waits = new Map();
    const soon = (action) => { clearTimeout(waits.get(action)); waits.set(action, setTimeout(() => action().catch(() => {}), 150)); };
    // The list is read again before a request: the task asked for may have been saved a moment ago.
    const asked = () => reload().then(processRequests);
    watchers.push(watch(path.dirname(configFile), (_event, file) => { if (!file || file === 'schedules.json') soon(reload); }));
    watchers.push(watch(requestsDir, () => soon(asked)));
    plan();
    await processRequests();
    await saveStatus();
    checkExit();
    return true;
  }

  // ---- Starting and stopping
  async function start() {
    await load();
    started = true;
    if (local) {
      plan();
      return;
    }
    // The panel's side: ask for a runner if any task is on, and redraw when its results change.
    await fs.mkdir(logRoot, { recursive: true });
    let wait = null;
    watchers.push(watch(logRoot, (_event, file) => {
      if (file !== 'status.json') return;
      clearTimeout(wait);
      wait = setTimeout(onChange, 100);
    }));
    if (tasks.some((task) => task.enabled)) await ensureRunner();
    onChange();
  }

  // The panel closing only stops watching: the runner program carries on. A local one (the runner
  // itself, or a check) ends any run going and stops the timer.
  function stop() {
    stopped = true;
    clearTimeout(timer);
    timer = null;
    for (const one of watchers) one.close();
    for (const child of children) child.kill('SIGKILL');
    if (local) unlock().catch(() => {});
  }

  // For checks: resolves when nothing is running.
  async function idle() {
    while (running.size) await Promise.all([...running.values()]);
    await statusSaving;
  }

  return { list, preview, projects, saveTask, setEnabled, remove, runNow, output, start, stop, idle, serve, ensureRunner, runnerPid };
}

// What a check changes: every minute allowed, a shorter minute, a short time limit. Only when the
// picture runs say so (HOUSE_SHOTS), never in the real app.
function testOptions() {
  if (!(process.env.HOUSE_SHOTS && process.env.HOUSE_SCHEDULE_TEST)) return {};
  return {
    allowFast: true,
    unitMs: Number(process.env.HOUSE_SCHEDULE_UNIT) || 60000,
    limitMs: Number(process.env.HOUSE_SCHEDULE_LIMIT) || LIMIT_MS,
    graceMs: 500,
  };
}

// The one the panel uses, made the first time it's asked for.
let shared = null;
function app(onChange) {
  if (!shared) shared = createRunner({ onChange, ...testOptions() });
  return shared;
}

// Station 256 closing: only stops watching. The runner program keeps going.
function shutdown() {
  if (shared) shared.stop();
}

module.exports = { createRunner, testOptions, app, shutdown, LIMIT_MS };
