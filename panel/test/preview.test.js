// Checks how Preview works out a project's start command (lib/preview.js), against fake project
// folders, and its run (typing the command, waiting for a new port) against fakes. Plain node:
//   node panel/test/preview.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const preview = require('../lib/preview');

let failed = 0;
async function check(label, test) {
  try {
    await test();
    console.log(`PASS ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${label}: ${error.message}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-test-'));
// A fake project: files is { name: contents }, a name ending in / is a folder.
function project(name, files) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    if (file.endsWith('/')) fs.mkdirSync(path.join(dir, file), { recursive: true });
    else {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
  }
  return dir;
}
const pkg = (scripts) => JSON.stringify({ scripts });
const need = (bin, label) => `{ command -v ${bin} >/dev/null || { echo "${label} isn't installed in this room."; (exit 127); }; }`;

(async () => {
  await check('npm dev with node_modules', async () => {
    assert.deepStrictEqual(await preview.plan(project('a', { 'package.json': pkg({ dev: 'vite', start: 'x' }), 'node_modules/': '' })), { command: 'npm run dev', folder: '' });
  });
  await check('script order: dev, start, preview, serve', async () => {
    const one = (scripts) => preview.plan(project(`order-${Object.keys(scripts).join('-')}`, { 'package.json': pkg(scripts), 'node_modules/': '' }));
    assert.strictEqual((await one({ serve: 'a', preview: 'b', start: 'c' })).command, 'npm run start');
    assert.strictEqual((await one({ serve: 'a', preview: 'b' })).command, 'npm run preview');
    assert.strictEqual((await one({ serve: 'a', test: 'b' })).command, 'npm run serve');
  });
  await check('runner follows the lock file', async () => {
    const cmd = async (lock) => (await preview.plan(project(`lock-${lock}`, { 'package.json': pkg({ dev: 'x' }), 'node_modules/': '', [lock]: '' }))).command.replace(/^\{ command -v \w+ .*?\}; \} && /, '');
    assert.strictEqual(await cmd('bun.lock'), 'bun run dev');
    assert.strictEqual(await cmd('bun.lockb'), 'bun run dev');
    assert.strictEqual(await cmd('pnpm-lock.yaml'), 'pnpm run dev');
    assert.strictEqual(await cmd('yarn.lock'), 'yarn dev');
    assert.strictEqual(await cmd('package-lock.json'), 'npm run dev');
  });
  await check('missing node_modules installs first', async () => {
    assert.strictEqual((await preview.plan(project('b', { 'package.json': pkg({ dev: 'x' }) }))).command, 'npm install && npm run dev');
    assert.strictEqual((await preview.plan(project('c', { 'package.json': pkg({ dev: 'x' }), 'yarn.lock': '' }))).command, `${need('yarn', 'yarn')} && yarn install && yarn dev`);
    assert.strictEqual((await preview.plan(project('d', { 'package.json': pkg({ start: 'x' }), 'pnpm-lock.yaml': '' }))).command, `${need('pnpm', 'pnpm')} && pnpm install && pnpm run start`);
  });
  await check('index.html and manage.py', async () => {
    assert.strictEqual((await preview.plan(project('e', { 'index.html': '<p>' }))).command, 'python3 -m http.server 8000');
    assert.strictEqual((await preview.plan(project('f', { 'manage.py': '' }))).command, 'python3 manage.py runserver 0.0.0.0:8000');
    // A package.json script wins over index.html; a package.json with no start script falls through.
    assert.strictEqual((await preview.plan(project('g', { 'package.json': pkg({ dev: 'x' }), 'node_modules/': '', 'index.html': '' }))).command, 'npm run dev');
    assert.strictEqual((await preview.plan(project('h', { 'package.json': pkg({ test: 'x' }), 'index.html': '' }))).command, 'python3 -m http.server 8000');
  });
  await check('a page in a common static folder', async () => {
    assert.strictEqual((await preview.plan(project('s1', { 'site/index.html': '<p>' }))).command, 'python3 -m http.server 8000 --directory site');
    assert.strictEqual((await preview.plan(project('s2', { 'public/index.html': '<p>', 'docs/index.html': '<p>' }))).command, 'python3 -m http.server 8000 --directory public');
    assert.strictEqual((await preview.plan(project('s3', { 'index.html': '<p>', 'site/index.html': '<p>' }))).command, 'python3 -m http.server 8000');
    // A Node project with a start script still uses it, whatever is in dist/.
    assert.strictEqual((await preview.plan(project('s4', { 'package.json': pkg({ dev: 'x' }), 'node_modules/': '', 'dist/index.html': '<p>' }))).command, 'npm run dev');
    assert.strictEqual((await preview.plan(project('s5', { 'site/readme.txt': 'x' }))).command, null);
  });
  await check('a broken package.json is ignored', async () => {
    assert.strictEqual((await preview.plan(project('i', { 'package.json': '{ nope', 'index.html': '' }))).command, 'python3 -m http.server 8000');
  });
  await check('nothing to start says so', async () => {
    const found = await preview.plan(project('j', { 'notes.txt': 'hi' }));
    assert.strictEqual(found.command, null);
    assert.strictEqual(found.message, 'Station couldn\'t find a website to start in this project. If it has one, write its start command in a file named .station-preview in the project folder.');
    assert.strictEqual((await preview.plan(path.join(root, 'does-not-exist'))).command, null);
  });
  await check('a .station-preview file wins over everything else', async () => {
    const own = await preview.plan(project('own-start', { '.station-preview': 'cd crates/app\ntrunk serve\n', 'package.json': pkg({ dev: 'x' }), 'node_modules/': '' }));
    assert.deepStrictEqual(own, { command: 'bash ./.station-preview', folder: '' });
    // An empty one, or a folder by that name, is ignored.
    assert.strictEqual((await preview.plan(project('own-empty', { '.station-preview': '  \n', 'index.html': '' }))).command, 'python3 -m http.server 8000');
    assert.strictEqual((await preview.plan(project('own-folder', { '.station-preview/': '', 'index.html': '' }))).command, 'python3 -m http.server 8000');
    // Only at the top: one in a subfolder doesn't count.
    assert.strictEqual((await preview.plan(project('own-sub', { 'web/.station-preview': 'x' }))).command, null);
  });
  await check('detection: none, one at the top, one in a folder', async () => {
    assert.strictEqual((await preview.plan(project('d-none', { 'notes.txt': 'x' }))).command, null);
    assert.strictEqual((await preview.plan(project('d-none2', { 'other/readme.md': 'x' }))).command, null);
    assert.deepStrictEqual(await preview.plan(project('d-top', { 'package.json': pkg({ dev: 'x' }), 'node_modules/': '' })), { command: 'npm run dev', folder: '' });
    assert.deepStrictEqual(await preview.plan(project('k', { 'frontend/package.json': pkg({ dev: 'x' }), 'frontend/node_modules/': '' })), { command: 'npm run dev', folder: 'frontend' });
  });
  await check('detection: three sites in subfolders gives a list, in order', async () => {
    const dir = project('d-three', { 'web/package.json': pkg({ dev: 'x' }), 'web/node_modules/': '', 'api/main.py': 'FastAPI(', 'docs-site/index.html': '' });
    const found = await preview.plan(dir);
    assert.strictEqual(found.command, null);
    assert.deepStrictEqual(found.choose.map((site) => site.folder), ['api', 'docs-site', 'web']);
    assert.strictEqual(found.choose[2].command, 'npm run dev');
  });
  await check('detection: node_modules, dist, hidden folders and a top-level static folder are not sites', async () => {
    const found = await preview.plan(project('d-skip', { 'index.html': '', 'node_modules/x/package.json': pkg({ dev: 'x' }), 'dist/package.json': pkg({ dev: 'x' }), '.cache/package.json': pkg({ dev: 'x' }), 'public/index.html': '' }));
    assert.deepStrictEqual(found, { command: 'python3 -m http.server 8000', folder: '' });
    // A top that serves public/ itself doesn't list public/ as another site, but a docs/ app of its own counts.
    const two = await preview.plan(project('d-static', { 'public/index.html': '', 'docs/package.json': pkg({ dev: 'x' }), 'docs/node_modules/': '' }));
    assert.deepStrictEqual(two.choose.map((site) => site.folder), ['', 'docs']);
  });
  await check('detection: a picked folder is used, a vanished one asks again', async () => {
    const dir = project('d-pick', { 'package.json': pkg({ dev: 'x' }), 'node_modules/': '', 'web/index.html': '' });
    assert.strictEqual((await preview.plan(dir, 'web')).folder, 'web');
    assert.strictEqual((await preview.plan(dir, '')).folder, '');
    assert.strictEqual((await preview.plan(dir, 'gone')).choose.length, 2);
    assert.strictEqual((await preview.plan(dir)).choose.length, 2);
  });

  // run(): starts in the room's background and waits for a new port, with a fake docker and ports.
  // log is what the room's log file holds (docker tail gives it back).
  const fakes = (portSteps, opts = {}) => {
    const calls = [];
    const opened = [];
    let step = 0;
    return {
      calls,
      opened,
      deps: {
        docker: async (args) => { calls.push(args); return args[2] === 'tail' ? (opts.log || '') : ''; },
        openRoom: async () => { calls.push(['openRoom']); },
        ports: { portsOf: async () => (opts.noLook ? null : (portSteps[Math.min(step++, portSteps.length - 1)] ? new Set(portSteps[Math.min(step - 1, portSteps.length - 1)]) : null)) },
        openUrl: async (url) => opened.push(url),
      },
    };
  };
  const quick = { pollMs: 5, waitMs: 200 };
  const started = (f) => f.calls.find((args) => args[0] === 'exec' && args[1] === '-d');
  await check('run starts it in the background (no terminal), then opens the first new port', async () => {
    const f = fakes([[22, 3000], [22, 3000], [22, 3000, 5173]]);
    const result = await preview.run({ room: 'Run One', folder: 'web', command: 'npm run dev' }, f.deps, quick);
    const args = started(f);
    assert.deepStrictEqual(args.slice(0, 5), ['exec', '-d', '-w', '/workspace/web', 'room-Run.One']);
    assert.deepStrictEqual(args.slice(5, 8), ['setsid', '-f', 'bash']);
    assert.ok(args.includes('npm run dev'));
    assert.deepStrictEqual(f.opened, ['http://localhost:5173']);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(preview.list(), [{ room: 'Run One', folder: 'web', port: 5173 }]);
    // Asked again while its port still answers: begin() says it's running, nothing is started.
    assert.deepStrictEqual(await preview.begin('Run One', async () => new Set([5173])), { running: true, port: 5173 });
    // Closing the tab: stop() kills the process group in the room and forgets it.
    assert.strictEqual(await preview.stop('Run One', f.deps.docker), true);
    const kill = f.calls[f.calls.length - 1];
    assert.ok(kill[4].includes('kill -TERM -- -"$p"'), kill[4]);
    assert.deepStrictEqual(preview.list(), []);
    assert.strictEqual(await preview.stop('Run One', f.deps.docker), false);
    const stopped = await preview.begin('Run One', async () => new Set([]), undefined, async () => '');
    assert.notStrictEqual(stopped.running, true);
  });
  await check('run starts a closed room first, with no terminal', async () => {
    const f = fakes([null, [22], [22, 4000]]);
    const result = await preview.run({ room: 'Run Six', command: 'x' }, f.deps, quick);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(f.calls[0][0], 'openRoom');
    assert.strictEqual(started(f)[3], '/workspace');
    await preview.stop('Run Six', f.deps.docker);
  });
  await check('run gives up with the plain message when no site appears, and stops what it started', async () => {
    const f = fakes([[3000]]);
    const result = await preview.run({ room: 'Run Two', command: 'x' }, f.deps, quick);
    assert.deepStrictEqual(result, { ok: false, message: 'The project started but no site appeared.' });
    assert.deepStrictEqual(f.opened, []);
    assert.ok(f.calls[f.calls.length - 1][4].includes('kill -TERM'));
    assert.deepStrictEqual(preview.list(), []);
  });
  await check('run does not hang when the room can\'t be looked at', async () => {
    const blind = fakes([[]], { noLook: true });
    const result = await preview.run({ room: 'Run Four', command: 'x' }, blind.deps, quick);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(started(blind), undefined);
  });

  // Every kind of project: [label, files, expected command (a string, or a check of it)].
  const kinds = [
    ['Expo', { 'package.json': JSON.stringify({ dependencies: { expo: '1' }, scripts: { start: 'expo start' } }), 'node_modules/': '' }, 'npx expo start --web'],
    ['Expo with a web script', { 'package.json': JSON.stringify({ dependencies: { expo: '1' }, scripts: { web: 'expo start --web' } }), 'node_modules/': '' }, 'npm run web'],
    ['Flutter with web', { 'pubspec.yaml': 'name: x\nflutter:\n  uses-material-design: true\n', 'web/': '' }, (c) => c.endsWith('flutter run -d web-server --web-hostname 0.0.0.0 --web-port 8080') && c.includes('command -v flutter')],
    ['Django', { 'manage.py': '' }, 'python3 manage.py runserver 0.0.0.0:8000'],
    ['Django with requirements', { 'manage.py': '', 'requirements.txt': 'django' }, 'python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && python3 manage.py runserver 0.0.0.0:8000'],
    ['FastAPI', { 'main.py': 'app = FastAPI()', '.venv/': '' }, (c) => c.startsWith('. .venv/bin/activate && ') && c.endsWith('uvicorn main:app --host 0.0.0.0 --port 8000 --reload') && c.includes('command -v uvicorn')],
    ['Flask', { 'wsgi.py': 'app = Flask(__name__)' }, (c) => c.endsWith('flask --app wsgi run --host 0.0.0.0 --port 5000')],
    ['Flask with requirements, no venv', { 'app.py': 'Flask(x)', 'requirements.txt': 'flask' }, (c) => c.startsWith('python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && { command -v flask') && c.endsWith('flask --app app run --host 0.0.0.0 --port 5000')],
    ['Streamlit', { 'requirements.txt': 'streamlit==1.0\n', 'streamlit_app.py': '', '.venv/': '' }, (c) => c.endsWith('streamlit run streamlit_app.py')],
    ['Trunk', { 'Trunk.toml': '' }, (c) => c.endsWith('trunk serve --address 0.0.0.0')],
    ['Rust wasm page', { 'Cargo.toml': '[package]', 'index.html': '' }, (c) => c.endsWith('trunk serve --address 0.0.0.0')],
    ['Rust axum', { 'Cargo.toml': '[dependencies]\naxum = "0.7"\n' }, (c) => c.endsWith('cargo run') && c.includes('command -v cargo')],
    ['Go', { 'go.mod': 'module x' }, (c) => c.endsWith('go run .')],
    ['Deno', { 'deno.json': '{"tasks":{"dev":"deno run main.ts"}}' }, (c) => c.endsWith('deno task dev')],
    ['Laravel', { artisan: '' }, (c) => c.endsWith('php artisan serve --host 0.0.0.0')],
    ['PHP page', { 'index.php': '' }, (c) => c.endsWith('php -S 0.0.0.0:8000')],
    ['Rails', { 'bin/rails': '' }, (c) => c.endsWith('bin/rails server -b 0.0.0.0')],
    ['Jekyll', { '_config.yml': '', Gemfile: '' }, (c) => c.endsWith('bundle exec jekyll serve --host 0.0.0.0')],
    ['Hugo (hugo.toml)', { 'hugo.toml': '' }, (c) => c.endsWith('hugo server --bind 0.0.0.0')],
    ['Hugo (config.toml + content)', { 'config.toml': '', 'content/': '' }, (c) => c.endsWith('hugo server --bind 0.0.0.0')],
    ['.NET', { 'App.csproj': '' }, (c) => c.endsWith('dotnet watch run')],
    ['Spring Maven wrapper', { 'pom.xml': '<artifactId>spring-boot-starter</artifactId>', mvnw: '' }, (c) => c.endsWith('./mvnw spring-boot:run')],
    ['Spring Maven', { 'pom.xml': 'spring-boot' }, (c) => c.endsWith('mvn spring-boot:run') && c.includes('command -v mvn')],
    ['Spring Gradle', { 'build.gradle.kts': 'id("org.springframework.boot")', gradlew: '' }, (c) => c.endsWith('./gradlew bootRun')],
  ];
  for (const [label, files, expected] of kinds) {
    await check(`plan: ${label}`, async () => {
      const found = await preview.plan(project(`kind-${label.replace(/\W+/g, '-')}`, files));
      assert.strictEqual(found.folder, '');
      if (typeof expected === 'string') assert.strictEqual(found.command, expected);
      else assert.ok(expected(found.command), found.command);
    });
  }
  await check('a missing tool gets a plain line and a marker the run reads', async () => {
    const found = await preview.plan(project('missing-tool', { 'go.mod': 'module x' }));
    assert.strictEqual(found.missing, 'Go isn\'t installed in this room.');
    assert.ok(found.command.includes('echo "Go isn\'t installed in this room."; (exit 127)'));
  });
  await check('Flutter without web says how to add it, and runs nothing', async () => {
    const found = await preview.plan(project('flutter-noweb', { 'pubspec.yaml': 'flutter:\n  x: 1', 'android/': '' }));
    assert.deepStrictEqual(found, { command: null, message: 'This Flutter app has no web version yet. Run `flutter create --platforms web .` in its room to add one.' });
  });
  await check('more subfolders: client/ and app/', async () => {
    assert.deepStrictEqual(await preview.plan(project('sub-client', { 'client/package.json': pkg({ dev: 'x' }), 'client/node_modules/': '' })), { command: 'npm run dev', folder: 'client' });
    assert.strictEqual((await preview.plan(project('sub-app', { 'app/go.mod': 'module x' }))).folder, 'app');
  });
  await check('a Flutter folder one level down', async () => {
    const found = await preview.plan(project('sub-flutter', { 'app/pubspec.yaml': 'flutter:\n', 'app/web/': '' }));
    assert.strictEqual(found.folder, 'app');
    assert.ok(found.command.endsWith('--web-port 8080'));
  });
  await check('a package.json script beats a stray index.php', async () => {
    assert.strictEqual((await preview.plan(project('order-node-first', { 'package.json': pkg({ dev: 'x' }), 'node_modules/': '', 'index.php': '' }))).command, 'npm run dev');
  });

  // Fast failure: the end marker shows in the log before any port does.
  await check('run says a missing tool at once', async () => {
    const f = fakes([[]], { log: 'Flutter isn\'t installed in this room.\nSTATION-DONE-127\n' });
    const began = Date.now();
    const result = await preview.run({ room: 'Fast One', command: 'x', missing: 'Flutter isn\'t installed in this room.' }, f.deps, { ...quick, waitMs: 5000 });
    assert.deepStrictEqual(result, { ok: false, message: 'Flutter isn\'t installed in this room.' });
    assert.ok(Date.now() - began < 1500);
  });
  await check('run says a crash at once', async () => {
    const crashed = fakes([[]], { log: 'boom\nSTATION-DONE-1\n' });
    assert.deepStrictEqual(await preview.run({ room: 'Fast Two', command: 'x' }, crashed.deps, quick), { ok: false, message: 'The project stopped before a site appeared.' });
  });
  await check('show log types a tail of the log into the terminal', async () => {
    const typed = [];
    const deps = { terminals: { has: () => true, buffer: () => 'prompt$ ', write: (id, text) => typed.push(text) } };
    assert.strictEqual(await preview.showLog('Fast Two', 1, deps, { settleMs: 5, pollMs: 5, readyMs: 500 }), true);
    assert.ok(/^tail -n 200 \/tmp\/station-preview-[a-z0-9]+\.log\r$/.test(typed[0]), typed[0]);
  });
  const none = async () => '';
  await check('isRunning forgets a site that stopped', async () => {
    const f = fakes([[22], [22, 4000]]);
    await preview.run({ room: 'Run Five', command: 'x' }, f.deps, quick);
    assert.strictEqual(await preview.isRunning('Run Five', async () => new Set([4000]), none), true);
    assert.strictEqual(await preview.isRunning('Run Five', async () => new Set([]), none), false);
    assert.strictEqual(await preview.isRunning('Run Five', async () => new Set([4000]), none), false);
  });
  await check('after a restart the newest live preview is taken back and older ones are stopped', async () => {
    const calls = [];
    const listing = '/tmp/station-preview-aaa.pid 11 3000 old\n/tmp/station-preview-bbb.pid 22 5173 web\nnoise\n';
    const docker = async (args) => { calls.push(args); return args[3] === undefined || args[2] !== 'bash' ? '' : (args[4].startsWith('for f') ? listing : ''); };
    assert.strictEqual(await preview.isRunning('Back One', async () => new Set([5173]), docker), true);
    assert.deepStrictEqual(preview.list(), [{ room: 'Back One', folder: 'web', port: 5173 }]);
    const killed = calls.filter((args) => args[4] && args[4].includes('kill -TERM'));
    assert.deepStrictEqual(killed.map((args) => args[6]), ['/tmp/station-preview-aaa.pid']);
    // Its tab closing stops it as normal.
    assert.strictEqual(await preview.stop('Back One', docker), true);
    assert.strictEqual(calls[calls.length - 1][6], '/tmp/station-preview-bbb.pid');
  });
  await check('nothing found after a restart means not running', async () => {
    assert.strictEqual(await preview.isRunning('Back Two', async () => new Set([5173]), async () => ''), false);
    assert.strictEqual(await preview.isRunning('Back Two', async () => new Set([5173]), async () => { throw new Error('no room'); }), false);
  });

  // A downloaded project is a stranger's: nothing of its names or words may reach the typed line.
  await check('hostile file names and script names never reach the command', async () => {
    const nasty = ['$(touch pwned).py', '`id`.csproj', 'a;rm -rf ~;.py', '-rf', 'x y\'z".py', 'new\nline.py', 'ünï.csproj'];
    const files = { 'requirements.txt': 'streamlit\nflask', 'app.py': 'app = Flask(__name__)' };
    for (const name of nasty) files[name] = 'Flask( FastAPI(';
    for (const kind of [files, { ...files, 'package.json': JSON.stringify({ scripts: { '$(touch pwned)': 'x', 'dev;id': 'x', start: 'vite' } }) }, { '`id`.csproj': '' }]) {
      const got = await preview.plan(project(`Hostile ${Object.keys(kind).length}`, kind));
      assert.ok(got.command, 'a command was found');
      assert.ok(!/pwned|rm -rf|`|\n|ünï|x y/.test(got.command), got.command);
    }
    assert.strictEqual((await preview.plan(project('Hostile Scripts', { 'package.json': JSON.stringify({ scripts: { '$(touch pwned)': 'x' } }) }))).command, null);
  });
  await check('an endless or huge file under a known name is not read whole', async () => {
    const dir = project('Endless', { 'index.html': '<p>' });
    fs.symlinkSync('/dev/zero', path.join(dir, 'package.json'));
    fs.symlinkSync(dir, path.join(dir, 'web')); // a folder that links back to itself
    assert.strictEqual((await preview.plan(dir)).command, 'python3 -m http.server 8000');
    const big = project('Big', { 'package.json': `{"scripts":{"dev":"vite"},"pad":"${'x'.repeat(5000000)}"}`, 'node_modules/': '' });
    assert.strictEqual((await preview.plan(big)).command, null); // cut short, so not valid: no script from it
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : 'All passed');
  process.exit(failed ? 1 : 0);
})();
