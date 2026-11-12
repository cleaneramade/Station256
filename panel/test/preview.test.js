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
  await check('subfolders only when the top has nothing', async () => {
    const found = await preview.plan(project('k', { 'frontend/package.json': pkg({ dev: 'x' }), 'frontend/node_modules/': '' }));
    assert.deepStrictEqual(found, { command: 'npm run dev', folder: 'frontend' });
    const top = await preview.plan(project('l', { 'index.html': '', 'web/package.json': pkg({ dev: 'x' }) }));
    assert.deepStrictEqual(top, { command: 'python3 -m http.server 8000', folder: '' });
    assert.strictEqual((await preview.plan(project('m', { 'other/package.json': pkg({ dev: 'x' }) }))).command, null);
  });

  // run(): the typed command and the wait for a new port, with fake terminals and ports.
  const fakes = (portSteps, opts = {}) => {
    const typed = [];
    const opened = [];
    let step = 0;
    return {
      typed,
      opened,
      deps: {
        terminals: { has: () => opts.gone !== true, buffer: () => (opts.screen ? opts.screen() : 'prompt$ '), write: (id, text) => typed.push(text) },
        ports: { portsOf: async () => (opts.noLook ? null : new Set(portSteps[Math.min(step++, portSteps.length - 1)])) },
        openUrl: async (url) => opened.push(url),
      },
    };
  };
  const quick = { settleMs: 5, pollMs: 5, readyMs: 500, waitMs: 200 };
  await check('run types the command, then opens the first new port', async () => {
    const f = fakes([[22, 3000], [22, 3000], [22, 3000, 5173]]);
    const result = await preview.run({ room: 'Run One', termId: 1, command: 'npm run dev' }, f.deps, quick);
    assert.deepStrictEqual(f.typed, ["npm run dev; printf 'STATION-DONE-%s\\n' \"$?\"\r"]);
    assert.deepStrictEqual(f.opened, ['http://localhost:5173']);
    assert.strictEqual(result.ok, true);
    // Asked again while its port still answers: begin() says it's running, nothing is typed.
    const again = await preview.begin('Run One', async () => new Set([5173]));
    assert.deepStrictEqual(again, { running: true, port: 5173 });
    const stopped = await preview.begin('Run One', async () => new Set([]));
    assert.notStrictEqual(stopped.running, true);
  });
  await check('run gives up with the plain message when no site appears', async () => {
    const f = fakes([[3000]]);
    const result = await preview.run({ room: 'Run Two', termId: 1, command: 'x' }, f.deps, quick);
    assert.deepStrictEqual(result, { ok: false, message: 'The project started but no site appeared. Check its terminal.' });
    assert.deepStrictEqual(f.opened, []);
  });
  await check('run does not hang when the terminal is gone or the room can\'t be looked at', async () => {
    const gone = await preview.run({ room: 'Run Three', termId: 1, command: 'x' }, fakes([[]], { gone: true }).deps, quick);
    assert.strictEqual(gone.ok, false);
    const blind = fakes([[]], { noLook: true });
    const result = await preview.run({ room: 'Run Four', termId: 1, command: 'x' }, blind.deps, quick);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(blind.typed, []);
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

  // Fast failure: the end marker shows in the terminal before any port does.
  await check('run says a missing tool at once', async () => {
    const f = fakes([[]], { screen: () => 'prompt$ Flutter isn\'t installed in this room.\nSTATION-DONE-127\n' });
    const began = Date.now();
    const result = await preview.run({ room: 'Fast One', termId: 1, command: 'x', missing: 'Flutter isn\'t installed in this room.' }, f.deps, { ...quick, waitMs: 5000 });
    assert.deepStrictEqual(result, { ok: false, message: 'Flutter isn\'t installed in this room.' });
    assert.ok(Date.now() - began < 1500);
  });
  await check('run says a crash at once, and the typed line alone is not an ending', async () => {
    const crashed = fakes([[]], { screen: () => 'prompt$ x\nboom\nSTATION-DONE-1\n' });
    assert.deepStrictEqual(await preview.run({ room: 'Fast Two', termId: 1, command: 'x' }, crashed.deps, quick), { ok: false, message: 'The project stopped before a site appeared. Check its terminal.' });
    const typedOnly = fakes([[]], { screen: () => 'prompt$ x; printf \'STATION-DONE-%s\\n\' "$?"' });
    assert.strictEqual((await preview.run({ room: 'Fast Three', termId: 1, command: 'x' }, typedOnly.deps, quick)).message, 'The project started but no site appeared. Check its terminal.');
  });
  await check('isRunning forgets a site that stopped', async () => {
    const f = fakes([[22], [22, 4000]]);
    await preview.run({ room: 'Run Five', termId: 1, command: 'x' }, f.deps, quick);
    assert.strictEqual(await preview.isRunning('Run Five', async () => new Set([4000])), true);
    assert.strictEqual(await preview.isRunning('Run Five', async () => new Set([])), false);
    assert.strictEqual(await preview.isRunning('Run Five', async () => new Set([4000])), false);
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
