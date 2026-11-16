// One-click Preview: works out the sites a project can start, runs the chosen one in the project's
// room in the background (no terminal tab), and opens the page in your browser once the room
// starts listening on a new port (lib/ports.js carries that port out to Windows). Closing the
// page's tab stops the site (renderer/app.js closeTab).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { roomName } = require('./herdr'); // a room's container name

const NOT_SURE = 'Station couldn\'t find a website to start in this project. If it has one, write its start command in a file named .station-preview in the project folder.';
// Where a built or plain site often keeps its index.html, checked in this order. Only these fixed names ever go into a command.
const STATIC_FOLDERS = ['public', 'site', 'dist', 'build', 'docs', 'www'];
// A project's own start steps, which win over anything Station works out. Run with bash in the
// project's room, so it can hold several lines (cd into a subfolder first, start a helper, …).
const OWN_START = '.station-preview';
const NO_SITE = 'The project started but no site appeared.';
const STOPPED = 'The project stopped before a site appeared.';
const NO_FLUTTER_WEB = 'This Flutter app has no web version yet. Run `flutter create --platforms web .` in its room to add one.';
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9_-])?$/;
const SCRIPTS = ['dev', 'start', 'preview', 'serve'];
// Files whose words decide things (a framework named inside them). Read up to 200 KB each.
const TEXT_FILES = ['package.json', 'pubspec.yaml', 'requirements.txt', 'main.py', 'app.py', 'wsgi.py', 'streamlit_app.py',
  'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'deno.json', 'deno.jsonc'];
// Marks a command's end in its log, with its exit code.
const DONE = /STATION-DONE-(\d+)/;
// What a missing tool ends with (see need), so Station can tell it from other failures.
const MISSING_CODE = 127;

// Which package manager a project uses, from the lock file it keeps.
function runnerFor(files) {
  if (files.includes('bun.lock') || files.includes('bun.lockb')) return 'bun';
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  return 'npm';
}

// A step that stops the line with a plain message when a tool isn't in the room.
const need = (bin, label) => `{ command -v ${bin} >/dev/null || { echo "${label} isn't installed in this room."; (exit ${MISSING_CODE}); }; }`;
const chain = (...steps) => steps.filter(Boolean).join(' && ');
const has = (text, word) => typeof text === 'string' && text.includes(word);
const guarded = (bin, label, command, before = '') => ({ command: chain(before, need(bin, label), command), missing: `${label} isn't installed in this room.` });

// Python projects: a requirements.txt with no .venv gets one made and filled first, in view; a
// .venv already there is just switched on.
function pythonSetup(files) {
  if (files.includes('.venv')) return '. .venv/bin/activate';
  if (files.includes('requirements.txt')) return 'python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt';
  return '';
}

// What starting one folder takes, from what is in it: { files: its names (and bin/rails), texts:
// { name: contents } of the files in TEXT_FILES }. Gives { command, missing? } or { message } (a
// project that can't preview), or null when nothing says how to start it. The first match wins.
function commandFor({ files, texts = {} }) {
  const hasFile = (name) => files.includes(name);
  let pkg = null;
  try {
    pkg = texts['package.json'] ? JSON.parse(texts['package.json']) : null;
  } catch { /* a broken package.json just means no script from it */ }
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  const deps = { ...(pkg && pkg.devDependencies), ...(pkg && pkg.dependencies) };

  // Node. Without node_modules the project was never set up here, so it is installed first, in view.
  if (pkg) {
    const runner = runnerFor(files);
    const before = hasFile('node_modules') ? '' : `${runner} install`;
    const via = (script) => (runner === 'yarn' ? `yarn ${script}` : `${runner} run ${script}`);
    const wrap = (command) => (runner === 'npm' ? { command: chain(before, command) }
      : { command: chain(need(runner, runner), before, command), missing: `${runner} isn't installed in this room.` });
    if (deps.expo) return wrap(typeof scripts.web === 'string' ? via('web') : 'npx expo start --web');
    const script = SCRIPTS.find((name) => typeof scripts[name] === 'string' && scripts[name].trim());
    if (script) return wrap(via(script));
  }
  // Flutter: only its web version shows in a browser.
  if (/^flutter:/m.test(texts['pubspec.yaml'] || '')) {
    if (!hasFile('web')) return { message: NO_FLUTTER_WEB };
    return guarded('flutter', 'Flutter', 'flutter run -d web-server --web-hostname 0.0.0.0 --web-port 8080');
  }
  // Python.
  const setup = pythonSetup(files);
  if (hasFile('manage.py')) return { command: chain(setup, 'python3 manage.py runserver 0.0.0.0:8000') };
  const fastapi = ['main.py', 'app.py'].find((name) => has(texts[name], 'FastAPI('));
  if (fastapi) return guarded('uvicorn', 'uvicorn', `uvicorn ${fastapi.replace(/\.py$/, '')}:app --host 0.0.0.0 --port 8000 --reload`, setup);
  const flask = ['app.py', 'main.py', 'wsgi.py'].find((name) => has(texts[name], 'Flask('));
  if (flask) return guarded('flask', 'Flask', `flask --app ${flask.replace(/\.py$/, '')} run --host 0.0.0.0 --port 5000`, setup);
  if (/^\s*streamlit\b/mi.test(texts['requirements.txt'] || '')) {
    const file = ['streamlit_app.py', 'app.py', 'main.py'].find(hasFile);
    if (file) return guarded('streamlit', 'Streamlit', `streamlit run ${file}`, setup);
  }
  // Rust.
  if (hasFile('Trunk.toml') || (hasFile('Cargo.toml') && hasFile('index.html'))) return guarded('trunk', 'Trunk', 'trunk serve --address 0.0.0.0');
  if (['axum', 'actix-web', 'rocket', 'warp'].some((crate) => new RegExp(`^\\s*${crate}\\b`, 'm').test(texts['Cargo.toml'] || ''))) return guarded('cargo', 'Rust (cargo)', 'cargo run');
  // Go, Deno.
  if (hasFile('go.mod')) return guarded('go', 'Go', 'go run .');
  const deno = ['deno.json', 'deno.jsonc'].map((name) => texts[name]).find((text) => typeof text === 'string');
  const task = deno !== undefined && ['dev', 'start'].find((name) => new RegExp(`"${name}"\\s*:`).test(deno));
  if (task) return guarded('deno', 'Deno', `deno task ${task}`);
  // PHP.
  if (hasFile('artisan')) return guarded('php', 'PHP', 'php artisan serve --host 0.0.0.0');
  if (hasFile('index.php')) return guarded('php', 'PHP', 'php -S 0.0.0.0:8000');
  // Ruby.
  if (hasFile('bin/rails')) return guarded('ruby', 'Ruby', 'bin/rails server -b 0.0.0.0');
  if (hasFile('_config.yml') && hasFile('Gemfile')) return guarded('bundle', 'Ruby (bundler)', 'bundle exec jekyll serve --host 0.0.0.0');
  // Hugo.
  if (hasFile('hugo.toml') || (hasFile('config.toml') && hasFile('content'))) return guarded('hugo', 'Hugo', 'hugo server --bind 0.0.0.0');
  // .NET, Java.
  if (files.some((name) => name.endsWith('.csproj'))) return guarded('dotnet', '.NET', 'dotnet watch run');
  if (has(texts['pom.xml'], 'spring-boot')) return hasFile('mvnw') ? guarded('java', 'Java', './mvnw spring-boot:run') : guarded('mvn', 'Maven', 'mvn spring-boot:run');
  if (has(texts['build.gradle'], 'spring') || has(texts['build.gradle.kts'], 'spring')) return hasFile('gradlew') ? guarded('java', 'Java', './gradlew bootRun') : guarded('gradle', 'Gradle', 'gradle bootRun');
  // A plain page, last.
  if (hasFile('index.html')) return { command: 'python3 -m http.server 8000' };
  const folder = STATIC_FOLDERS.find((name) => hasFile(`${name}/index.html`));
  if (folder) return { command: `python3 -m http.server 8000 --directory ${folder}` };
  return null;
}

// The start of a file, as text ('' if it can't be read). Only a plain file is opened and only its
// first 200 KB read: a downloaded project can hold a huge file, or a link to something endless
// (/dev/zero), under one of these names, and reading all of it would fill Station's memory.
async function head(file) {
  let handle = null;
  try {
    if (!(await fs.promises.stat(file)).isFile()) return '';
    handle = await fs.promises.open(file, 'r');
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(200000), 0, 200000, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function look(dir) {
  let files;
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return null;
  }
  if (files.includes('bin')) {
    const inBin = await fs.promises.readdir(path.join(dir, 'bin')).catch(() => []);
    if (inBin.includes('rails')) files = [...files, 'bin/rails'];
  }
  // Like bin/rails: a static folder's index.html is listed as 'folder/index.html'.
  for (const name of STATIC_FOLDERS) {
    if (files.includes(name) && (await fs.promises.stat(path.join(dir, name, 'index.html')).then((s) => s.isFile(), () => false))) files = [...files, `${name}/index.html`];
  }
  const texts = {};
  for (const name of TEXT_FILES) {
    if (!files.includes(name)) continue;
    texts[name] = await head(path.join(dir, name));
  }
  return { files, texts };
}

// Folders never looked into for a site of their own: tools' output and caches.
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__']);

// Every site a project can start: the top, then each first-level folder, as a list of
// { command, folder, missing? } (folder is inside the project, '' for its top), plus the plain
// message of a project that can't preview (Flutter without web). A .station-preview file at the top is the only site.
async function sites(projectDir) {
  const top = await look(projectDir);
  if (!top) return { list: [], message: NOT_SURE };
  if (top.files.includes(OWN_START) && /\S/.test(await head(path.join(projectDir, OWN_START)))) {
    return { list: [{ command: `bash ./${OWN_START}`, folder: '' }] };
  }
  const list = [];
  let message = null;
  const consider = (folder, found) => {
    const result = found && commandFor(found);
    if (!result) return;
    if (result.message) message = message || result.message;
    else list.push({ command: result.command, folder, ...(result.missing ? { missing: result.missing } : {}) });
  };
  consider('', top);
  const entries = await fs.promises.readdir(projectDir, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)).map((entry) => entry.name).sort().slice(0, 40);
  for (const name of names) {
    // The top already serves its own public/ or docs/ page, so that folder isn't a second site.
    if (top.files.includes(`${name}/index.html`) && STATIC_FOLDERS.includes(name)) continue;
    consider(name, await look(path.join(projectDir, name)));
  }
  return { list, message };
}

// What to run for a project: { command, folder, missing? }, or { command: null, message } when
// there is nothing, or { command: null, choose: [sites] } when several are found and none is
// picked. pick is a folder remembered or chosen before; it counts only if that site still exists.
async function plan(projectDir, pick) {
  const { list, message } = await sites(projectDir);
  if (!list.length) return { command: null, message: message || NOT_SURE };
  const one = list.find((site) => site.folder === pick) || (list.length === 1 ? list[0] : null);
  return one || { command: null, choose: list };
}

// Previews started here and still running: room name → { port, folder, container, log, pidFile }.
// Asked again, the page just opens.
const active = new Map();
// The last log written for each room's preview, kept after a failure so "Show log" can open it.
const logs = new Map();

// After a Station restart: finds the previews still running in the room (pid files hold group id,
// folder, port). The newest one with a port is taken back, any older one is stopped.
const FIND = 'for f in /tmp/station-preview-*.pid; do [ -f "$f" ] || continue; { read -r p; read -r d; read -r o; } < "$f"; if kill -0 -- -"$p" 2>/dev/null; then echo "$f $p $o $d"; else rm -f "$f"; fi; done';
async function adopt(room, run) {
  const container = roomName(room);
  const out = await run(['exec', container, 'bash', '-c', FIND]).catch(() => '');
  const found = String(out).split('\n').map((line) => /^(\/tmp\/station-preview-[a-z0-9]+\.pid) \d+ (\d+) ?(.*)$/.exec(line)).filter(Boolean)
    .map(([, pidFile, port, folder]) => ({ port: Number(port), folder, container, log: pidFile.replace(/\.pid$/, '.log'), pidFile })).sort((a, b) => (a.pidFile < b.pidFile ? -1 : 1));
  const newest = found.pop();
  for (const old of found) {
    active.set(room, old);
    await stop(room, run);
  }
  if (newest) active.set(room, newest);
}

// Whether a preview started here still has its site up. Forgets one that stopped.
async function isRunning(name, portsOf, run = docker) {
  if (!active.has(name)) await adopt(name, run);
  const port = active.get(name)?.port;
  if (!port) return false;
  const now = await portsOf(name);
  if (now && now.has(port)) return true;
  active.delete(name);
  return false;
}

// The first Preview click for a project: its page's port if it's already running, else what to run.
async function begin(name, portsOf, pick, run = docker) {
  if (!NAME.test(name || '')) return { command: null, message: NOT_SURE };
  if (await isRunning(name, portsOf, run)) return { running: true, port: active.get(name).port };
  return plan(path.join(os.homedir(), 'projects', name), pick);
}

// Docker and the room launcher, as the real thing; tests hand in fakes.
const docker = (args) => new Promise((resolve, reject) => execFile('docker', args, { timeout: 20000 }, (error, out) => (error ? reject(error) : resolve(String(out)))));
// Starts a room with no terminal: with no screen, its last step (the shell) just fails, which is fine.
const openRoom = (room) => new Promise((resolve) => execFile(path.join(os.homedir(), '.local', 'bin', 'room'), ['open', room], { timeout: 120000 }, () => resolve()));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Waits for a new terminal to finish drawing its first screen, so typing into it isn't lost. The
// room may have to start first, which can take a while.
async function shellReady(deps, termId, { settleMs, readyMs, pollMs }) {
  const until = Date.now() + readyMs;
  let last = -1;
  let since = Date.now();
  while (Date.now() < until) {
    if (!deps.terminals.has(termId)) return false;
    const size = deps.terminals.buffer(termId).length;
    if (size !== last) {
      last = size;
      since = Date.now();
    } else if (size > 0 && Date.now() - since >= settleMs) {
      return true;
    }
    await sleep(pollMs);
  }
  return false;
}

// Stops a preview's whole process group in its room: asks nicely, then forces it after two seconds.
async function stop(room, run = docker) {
  const site = active.get(room);
  if (!site) return false;
  active.delete(room);
  const script = 'p=$(head -n1 "$1") || exit 0; kill -TERM -- -"$p"; for i in 1 2 3 4; do kill -0 -- -"$p" 2>/dev/null || break; sleep 0.5; done; kill -KILL -- -"$p" 2>/dev/null; rm -f "$1"';
  await run(['exec', site.container, 'bash', '-c', script, 'bash', site.pidFile]).catch(() => {});
  return true;
}

// What is running: one { room, folder, port } each, for the Agents page.
const list = () => [...active].map(([room, site]) => ({ room, folder: site.folder, port: site.port }));

// Starts the command inside the room with no terminal: docker exec -d, in its own process group
// (setsid) so stop() can end all of it, output going to a log in the room's /tmp. Then waits for a
// port the room didn't have before. The log's last line carries the exit code, so a command that
// ends (a missing tool, a crash) is noticed at once. deps: { docker(args), openRoom(room), ports
// (portsOf), openUrl }. Gives { ok, url, port } or { ok: false, message }; never waits longer than
// the times given.
async function run({ room, folder = '', command, missing }, given, times = {}) {
  const deps = { docker, openRoom, ...given };
  const t = { waitMs: 120000, pollMs: 1000, ...times };
  const container = roomName(room);
  let before = await deps.ports.portsOf(room);
  if (!before) {
    await deps.openRoom(room); // starts it, with no terminal
    before = await deps.ports.portsOf(room);
  }
  if (!before) return { ok: false, message: 'Station couldn\'t look inside the room. Is it still open?' };
  const tag = Date.now().toString(36);
  const log = `/tmp/station-preview-${tag}.log`;
  const pidFile = `/tmp/station-preview-${tag}.pid`;
  logs.set(room, { container, log });
  const script = 'printf "%s\\n%s\\n" $$ "$4" > "$3"; bash -lc "$1" > "$2" 2>&1; echo "STATION-DONE-$?" >> "$2"';
  try {
    await deps.docker(['exec', '-d', '-w', `/workspace${folder ? `/${folder}` : ''}`, container, 'setsid', '-f', 'bash', '-c', script, 'station-preview', command, log, pidFile, folder]);
  } catch {
    return { ok: false, message: 'The room didn\'t start the site. Try Preview again.' };
  }
  const fail = async (message) => {
    active.set(room, { port: 0, folder, container, log, pidFile });
    await stop(room, deps.docker);
    return { ok: false, message };
  };
  const until = Date.now() + t.waitMs;
  while (Date.now() < until) {
    await sleep(t.pollMs);
    const now = await deps.ports.portsOf(room);
    const port = now && [...now].sort((a, b) => a - b).find((p) => !before.has(p));
    if (port) {
      const url = `http://localhost:${port}`;
      active.set(room, { port, folder, container, log, pidFile });
      await deps.docker(['exec', container, 'bash', '-c', 'echo "$1" >> "$2"', 'bash', String(port), pidFile]).catch(() => {}); // so a restarted Station can find it
      await deps.openUrl(url);
      return { ok: true, url, port };
    }
    const tail = await deps.docker(['exec', container, 'tail', '-c', '4000', log]).catch(() => '');
    const done = DONE.exec(tail);
    if (done) return fail(Number(done[1]) === MISSING_CODE && missing ? missing : STOPPED);
  }
  return fail(NO_SITE);
}

// "Show log": types a tail of the room log into a terminal the window just opened (termId).
async function showLog(room, termId, deps, times = {}) {
  const site = logs.get(room);
  if (!site || !await shellReady(deps, termId, { settleMs: 1500, readyMs: 60000, pollMs: 1000, ...times })) return false;
  deps.terminals.write(termId, `tail -n 200 ${site.log}\r`);
  return true;
}

module.exports = { begin, isRunning, plan, sites, commandFor, run, stop, list, showLog };
