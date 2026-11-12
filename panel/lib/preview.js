// One-click Preview: works out how a project starts its site, runs that in the project's room (in a
// terminal tab you can see, so Ctrl+C stops it), and opens the page in your browser once the room
// starts listening on a new port (lib/ports.js carries that port out to Windows).
const fs = require('fs');
const os = require('os');
const path = require('path');

const NOT_SURE = 'Station couldn\'t find a website to start in this project. If it has one, write its start command in a file named .station-preview in the project folder.';
// Where a built or plain site often keeps its index.html, checked in this order. Only these fixed names ever go into a command.
const STATIC_FOLDERS = ['public', 'site', 'dist', 'build', 'docs', 'www'];
// A project's own start steps, which win over anything Station works out. Run with bash in the
// project's room, so it can hold several lines (cd into a subfolder first, start a helper, …).
const OWN_START = '.station-preview';
const NO_SITE = 'The project started but no site appeared. Check its terminal.';
const STOPPED = 'The project stopped before a site appeared. Check its terminal.';
const NO_FLUTTER_WEB = 'This Flutter app has no web version yet. Run `flutter create --platforms web .` in its room to add one.';
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9_-])?$/;
const SCRIPTS = ['dev', 'start', 'preview', 'serve'];
// Folders looked in, one level down, only when the project's top has nothing to start.
const SUBFOLDERS = ['web', 'app', 'frontend', 'client'];
// Files whose words decide things (a framework named inside them). Read up to 200 KB each.
const TEXT_FILES = ['package.json', 'pubspec.yaml', 'requirements.txt', 'main.py', 'app.py', 'wsgi.py', 'streamlit_app.py',
  'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'deno.json', 'deno.jsonc'];
// Marks a command's end in the terminal, with its exit code. The typed line shows "%s", so only the
// real output matches.
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

// What to run for a project folder: { command, folder, missing? } (folder is inside the project, ''
// for its top), or { command: null, message }. A .station-preview file at the top comes first.
async function plan(projectDir) {
  const top = await look(projectDir);
  if (!top) return { command: null, message: NOT_SURE };
  if (top.files.includes(OWN_START) && /\S/.test(await head(path.join(projectDir, OWN_START)))) {
    return { command: `bash ./${OWN_START}`, folder: '' };
  }
  for (const place of ['', ...SUBFOLDERS]) {
    const found = place ? await look(path.join(projectDir, place)) : top;
    const result = found && commandFor(found);
    if (!result) continue;
    if (result.message) return { command: null, message: result.message };
    return { command: result.command, folder: place, ...(result.missing ? { missing: result.missing } : {}) };
  }
  return { command: null, message: NOT_SURE };
}

// Previews started here and still running: room name → port. Asked again, the page just opens.
const active = new Map();

// Whether a preview started here still has its site up. Forgets one that stopped.
async function isRunning(name, portsOf) {
  const port = active.get(name);
  if (!port) return false;
  const now = await portsOf(name);
  if (now && now.has(port)) return true;
  active.delete(name);
  return false;
}

// The first Preview click for a project: its page's port if it's already running, else what to run.
async function begin(name, portsOf) {
  if (!NAME.test(name || '')) return { command: null, message: NOT_SURE };
  if (await isRunning(name, portsOf)) return { running: true, port: active.get(name) };
  return plan(path.join(os.homedir(), 'projects', name));
}

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

// Types the command into the room terminal, then waits for a port the room didn't have before.
// After the command it prints a marker with its exit code, so a command that ends (a missing tool,
// a crash) is noticed at once instead of after the wait. missing is the plain line for a missing tool.
// deps: { terminals (has, buffer, write), ports (portsOf), openUrl }. Gives { ok, url } or
// { ok: false, message }; never waits longer than the times given.
async function run({ room, termId, command, missing }, deps, times = {}) {
  const t = { settleMs: 1500, readyMs: 60000, waitMs: 120000, pollMs: 1000, ...times };
  if (!await shellReady(deps, termId, t)) {
    return { ok: false, message: 'The room didn\'t start. Close this tab and try Preview again.' };
  }
  const before = await deps.ports.portsOf(room);
  if (!before) return { ok: false, message: 'Station couldn\'t look inside the room. Is it still open?' };
  deps.terminals.write(termId, `${command}; printf 'STATION-DONE-%s\\n' "$?"\r`);
  const until = Date.now() + t.waitMs;
  while (Date.now() < until) {
    await sleep(t.pollMs);
    if (!deps.terminals.has(termId)) return { ok: false, message: 'The terminal closed before a site appeared.' };
    const now = await deps.ports.portsOf(room);
    const port = now && [...now].sort((a, b) => a - b).find((p) => !before.has(p));
    if (port) {
      const url = `http://localhost:${port}`;
      active.set(room, port);
      await deps.openUrl(url);
      return { ok: true, url, port };
    }
    const done = DONE.exec(deps.terminals.buffer(termId));
    if (done) return { ok: false, message: Number(done[1]) === MISSING_CODE && missing ? missing : STOPPED };
  }
  return { ok: false, message: NO_SITE };
}

module.exports = { begin, isRunning, plan, commandFor, run };
