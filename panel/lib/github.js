// GitHub connection: get a project from GitHub, see when it has news, and bring the news in.
// Git is always run with an argument list (never a shell), never asks for a password, and never
// forces anything: no reset, no stash, no discard. Everything here works on plain folders, so the
// tests run it against local bare repositories.
const { execFile, spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const FAILED = 'Station couldn\'t get that repository. If it\'s private, signing in to GitHub comes in the next version.';
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
// The same letters a project name may have (lib/house.js).
const PROJECT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9_-])?$/;

const projectsHome = () => path.join(os.homedir(), 'projects');

// "https://github.com/o/r", "github.com/o/r", "o/r" or a ".git" link -> { owner, repo, url, page }.
// Strict: only github.com over https, and only sane owner and repository characters.
function parseGithub(input) {
  const text = String(input ?? '').trim();
  if (!text || text.length > 300) return null;
  let rest = text.replace(/^https:\/\//i, '');
  // Nothing but letters, numbers, dots, dashes, underscores and slashes can get past here.
  if (!/^[A-Za-z0-9._\/-]+$/.test(rest)) return null;
  rest = rest.replace(/\/+$/, '');
  if (/^github\.com\//i.test(rest)) rest = rest.slice('github.com/'.length);
  else if (/^http:/i.test(text) || (/^https:\/\//i.test(text))) return null; // https to some other host
  else if (rest.split('/')[0].includes('.')) return null; // some other host
  const parts = rest.split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(repo) || /^\.+$/.test(repo) || repo.includes('..') || repo.startsWith('-')) return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git`, page: `https://github.com/${owner}/${repo}` };
}

// A project's saved "origin" address, if it's on github.com. ssh-style addresses show the page
// but aren't fetched (they can't sign in here).
function originInfo(origin) {
  const text = String(origin || '').trim();
  const ssh = text.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (ssh && OWNER.test(ssh[1]) && REPO.test(ssh[2])) return { page: `https://github.com/${ssh[1]}/${ssh[2]}`, https: false };
  if (!/^https:\/\//i.test(text)) return null;
  const info = parseGithub(text.replace(/^https:\/\/[^/@]*@/i, 'https://'));
  return info ? { page: info.page, https: true } : null;
}

// A folder name for the project: only what project names allow, and one that isn't taken
// (Windows treats capitals alike). Parentheses aren't allowed in project names, so: "repo 2".
function uniqueName(repo, taken) {
  let base = String(repo).replace(/[^A-Za-z0-9 _-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60).replace(/ +$/, '');
  if (!base || !PROJECT_NAME.test(base)) base = 'project';
  // Windows can't open folders with these old device names, and projects are also seen from Windows.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base += '-project';
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base} ${n}`;
  return name;
}

function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C', LANG: 'C' };
}

// A project's own .git folder can be written from inside its room, and this git runs outside the
// room. So nothing in there may start a program: only https is spoken (no ssh, no helpers), hooks
// and sign-in helpers are off, and submodules are left alone.
const safety = (allowFile) => [
  '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', `protocol.file.allow=${allowFile ? 'always' : 'never'}`,
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'submodule.recurse=false',
];

const live = new Set(); // every git that's running, so none is left going when Station quits
process.once('exit', () => { for (const child of live) child.kill(); });

// Names the project's folders outright (not -C), so its settings can't point git at some other folder.
function git(dir, args, { timeout = 30000, allowFile = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...safety(allowFile), '--git-dir', path.join(dir, '.git'), '--work-tree', dir, ...args], { cwd: dir, env: gitEnv(), timeout, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      live.delete(child);
      if (error) {
        error.stderr = String(stderr || '');
        reject(error);
      } else resolve(String(stdout));
    });
    live.add(child);
  });
}

/* ---------- Getting a project ---------- */

let job = null; // one clone at a time: { child, stopped, timedOut }

const STAGES = [
  [/Counting objects:\s+(\d+)%/, 0, 5, 'Counting'], [/Compressing objects:\s+(\d+)%/, 5, 10, 'Counting'],
  [/Receiving objects:\s+(\d+)%/, 10, 85, 'Downloading'], [/Resolving deltas:\s+(\d+)%/, 85, 97, 'Finishing'], [/Updating files:\s+(\d+)%/, 97, 100, 'Finishing'],
];

// A project arrives in a hidden folder with a made-up name (".getting-Ab3xYz") inside projects, and
// only gets its real name once it's whole. So a half-made project is never on Home, and the only
// folder this file ever removes is that hidden one.
const TEMP = '.getting-';

// Removes the hidden folder a stopped or failed clone was using, and nothing else, ever. It must
// still be the very folder that was made (same name, same number on the disk), a real folder and
// not a link, straight inside the real projects folder. Any doubt: it's left where it is.
async function removeMade(made) {
  if (!made) return;
  try {
    const name = path.basename(made.dir);
    if (path.dirname(made.dir) !== made.parent || !name.startsWith(TEMP) || name.length !== TEMP.length + 6) return;
    const now = await fs.lstat(made.dir);
    if (!now.isDirectory() || now.ino !== made.ino || now.dev !== made.dev) return;
    if (await fs.realpath(made.dir) !== made.dir) return;
    await fs.rm(made.dir, { recursive: true, force: true });
  } catch { /* already gone, or not ours any more */ }
}

// Gives the finished hidden folder a project name nobody has. The name is taken first with mkdir
// (which fails if it exists), then the folder is moved onto that empty folder: a move can only
// replace an empty folder, so nothing of anyone's can be lost here.
async function moveIntoPlace(made, repo) {
  for (;;) {
    const name = uniqueName(repo, await fs.readdir(made.parent));
    const target = path.join(made.parent, name);
    try {
      await fs.mkdir(target);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    try {
      await fs.rename(made.dir, target);
      return { name, path: target };
    } catch (error) {
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') continue; // someone put things in it: it's theirs now
      await fs.rmdir(target).catch(() => {}); // rmdir only ever removes an empty folder
      throw error;
    }
  }
}

// url must already be checked (clone() does that).
async function cloneRepo({ url, repo, projectsDir = projectsHome(), onProgress = () => {}, allowFile = false, timeout = 15 * 60 * 1000 }) {
  if (job) throw new Error('A project is already coming from GitHub. Wait for it, or stop it first.');
  const mine = {};
  job = mine;
  let made = null;
  try {
    await fs.mkdir(projectsDir, { recursive: true });
    const parent = await fs.realpath(projectsDir);
    const dir = await fs.mkdtemp(path.join(parent, TEMP));
    const { ino, dev } = await fs.lstat(dir);
    made = { dir, parent, ino, dev };
    let percent = 0;
    const report = (value, label) => {
      if (value > percent) percent = value;
      onProgress({ percent, label });
    };
    report(0, 'Connecting');
    const failure = await new Promise((resolve) => {
      const child = spawn('git', [...safety(allowFile), 'clone', '--progress', '--no-recurse-submodules', '--', url, dir], { env: gitEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
      mine.child = child;
      live.add(child);
      child.on('close', () => live.delete(child));
      if (mine.stopped) child.kill('SIGTERM');
      const timer = setTimeout(() => { mine.timedOut = true; child.kill('SIGKILL'); }, timeout);
      let buffer = '';
      child.stderr.on('data', (chunk) => {
        buffer = (buffer + chunk).slice(-4000);
        const lines = buffer.split(/[\r\n]/);
        buffer = lines.pop();
        for (const line of lines) {
          for (const [pattern, from, to, label] of STAGES) {
            const found = line.match(pattern);
            if (found) report(Math.round(from + (to - from) * Number(found[1]) / 100), label);
          }
        }
      });
      child.on('error', () => { clearTimeout(timer); resolve('error'); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? null : 'exit'); });
    });
    if (mine.stopped) throw Object.assign(new Error('Stopped. Nothing was kept.'), { stopped: true });
    if (failure) throw new Error(mine.timedOut ? 'Getting that repository took too long, so Station stopped. Nothing was kept.' : FAILED);
    await fs.chmod(dir, 0o755); // the hidden folder was private; a project is an ordinary folder
    const result = await moveIntoPlace(made, repo);
    made = null; // it's a project now: never removed from here on, whatever happens
    onProgress({ percent: 100, label: 'Done' });
    return result;
  } finally {
    await removeMade(made);
    job = null;
  }
}

async function clone(input, options = {}) {
  const info = parseGithub(input);
  if (!info) throw new Error('That doesn\'t look like a GitHub repository. Paste something like https://github.com/owner/repo or owner/repo.');
  return cloneRepo({ ...options, url: info.url, repo: info.repo });
}

function stop() {
  if (!job) return false;
  job.stopped = true;
  const child = job.child;
  if (!child) return true;
  child.kill('SIGTERM');
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000).unref();
  return true;
}

/* ---------- News and updates ---------- */

// How far a project is from its branch on GitHub: { ahead, behind }, after asking GitHub.
async function fetchStatus(dir, { allowFile = false, timeout = 30000 } = {}) {
  await git(dir, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-auto-gc', 'origin'], { timeout, allowFile });
  const out = await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { allowFile });
  const [ahead, behind] = out.trim().split(/\s+/).map(Number);
  return { ahead, behind };
}

const readOrigin = (dir) => git(dir, ['config', '--get', 'remote.origin.url'], { timeout: 5000 }).then((out) => out.trim(), () => '');

async function projectDir(projectsDir, name) {
  if (!PROJECT_NAME.test(String(name || ''))) throw new Error('That isn\'t a project.');
  const dir = path.join(projectsDir, name);
  if (!(await fs.stat(path.join(dir, '.git')).then(() => true, () => false))) return null;
  return dir;
}

const cache = new Map(); // project folder -> { at, value }
const inflight = new Map();
let running = 0;
const waiting = [];
const slot = () => new Promise((resolve) => {
  const go = () => {
    running += 1;
    resolve(() => { running -= 1; if (waiting.length) waiting.shift()(); });
  };
  if (running < 2) go(); else waiting.push(go);
});

async function checkOne(projectsDir, name) {
  const key = path.join(projectsDir, name);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const work = (async () => {
    const dir = await projectDir(projectsDir, name).catch(() => null);
    const info = dir ? originInfo(await readOrigin(dir)) : null;
    let value = null;
    if (info) {
      value = { page: info.page, behind: hit?.value?.behind || 0 };
      if (info.https) {
        const release = await slot();
        try {
          value.behind = (await fetchStatus(dir)).behind;
        } catch { /* offline or private: no new badge, try again in 10 minutes */ } finally { release(); }
      }
    }
    cache.set(key, { at: Date.now(), value });
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

// { name: { behind, page } } for the named projects that are from github.com.
async function checkMany(projectsDir, names) {
  const out = {};
  await Promise.all((Array.isArray(names) ? names : []).slice(0, 200).map(async (name) => {
    const value = await checkOne(projectsDir, name).catch(() => null);
    if (value) out[name] = value;
  }));
  return out;
}

// Brings in what's new, only when it can be done without touching the owner's own work.
async function pullDir(dir, { allowFile = false } = {}) {
  let status;
  try {
    status = await fetchStatus(dir, { allowFile });
  } catch (error) {
    if (/no upstream|unknown revision|ambiguous argument/i.test(error.stderr || '')) {
      throw new Error('This project isn\'t following a branch on GitHub right now, so there\'s nothing to get.');
    }
    throw new Error('Station couldn\'t reach GitHub for this project. Check the internet, or whether the repository is private.');
  }
  if (status.behind === 0) return { state: 'current', count: 0 };
  if (status.ahead > 0) {
    throw new Error('This project has changes of its own that GitHub doesn\'t have, and GitHub has new changes too. Station won\'t mix them for you, so nothing was changed.');
  }
  try {
    // fetchStatus just asked GitHub, so this only moves forward to what it found: no second trip,
    // and never a stash, a mix or a rebase, whatever the owner's git settings say.
    await git(dir, ['merge', '--ff-only', '--no-autostash', '--no-stat', '--no-verify-signatures', '@{upstream}'], { timeout: 120000, allowFile });
  } catch (error) {
    const text = error.stderr || '';
    if (/overwritten|would be lost|local changes|untracked working tree/i.test(text)) {
      throw new Error('You have unsaved changes in files that GitHub also changed. Station didn\'t touch anything. Save them (commit them) or move them aside, then try again.');
    }
    if (/fast-forward|diverge/i.test(text)) throw new Error('This project and GitHub have gone different ways, so Station didn\'t change anything.');
    throw new Error('Station couldn\'t get the updates, and changed nothing.');
  }
  return { state: 'updated', count: status.behind };
}

const pulling = new Set();
async function pullProject(projectsDir, name) {
  const dir = await projectDir(projectsDir, name);
  if (!dir) throw new Error('That project isn\'t from GitHub.');
  const info = originInfo(await readOrigin(dir));
  if (!info) throw new Error('That project isn\'t from GitHub.');
  if (!info.https) throw new Error('This project talks to GitHub by ssh, which Station can\'t sign in to yet.');
  if (pulling.has(dir)) throw new Error('Already getting updates for this project.');
  pulling.add(dir);
  try {
    const result = await pullDir(dir);
    cache.set(dir, { at: Date.now(), value: { page: info.page, behind: 0 } });
    return result;
  } finally {
    pulling.delete(dir);
  }
}

async function pageOf(projectsDir, name) {
  const dir = await projectDir(projectsDir, name);
  const info = dir ? originInfo(await readOrigin(dir)) : null;
  if (!info) throw new Error('That project isn\'t from GitHub.');
  return info.page;
}

module.exports = {
  FAILED, parseGithub, originInfo, uniqueName, cloneRepo, stop, fetchStatus, pullDir,
  _resetCache: () => cache.clear(), // for checks
  clone: (input, options) => clone(input, { ...options, projectsDir: options?.projectsDir || projectsHome() }),
  checkMany: (names, projectsDir = projectsHome()) => checkMany(projectsDir, names),
  pullProject: (name, projectsDir = projectsHome()) => pullProject(projectsDir, name),
  pageOf: (name, projectsDir = projectsHome()) => pageOf(projectsDir, name),
};
