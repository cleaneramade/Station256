// Checks for lib/github.js, with local bare repositories only (no network).
// Run with: node panel/test/github.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const github = require('../lib/github');

let passed = 0;
const ok = (condition, label) => { assert.ok(condition, label); passed += 1; };
const same = (actual, expected, label) => { assert.deepStrictEqual(actual, expected, label); passed += 1; };

// URLs
const good = [
  ['https://github.com/octocat/Hello-World', 'octocat', 'Hello-World'],
  ['https://github.com/octocat/Hello-World.git', 'octocat', 'Hello-World'],
  ['  github.com/octocat/Hello-World/ ', 'octocat', 'Hello-World'],
  ['octocat/Hello-World', 'octocat', 'Hello-World'],
  ['HTTPS://GitHub.com/a-b/c.d_e.git', 'a-b', 'c.d_e'],
  ['octocat/.github', 'octocat', '.github'],
];
for (const [input, owner, repo] of good) {
  const info = github.parseGithub(input);
  ok(info && info.owner === owner && info.repo === repo, `should parse: ${input}`);
  same(info.url, `https://github.com/${owner}/${repo}.git`, `clean url for ${input}`);
}
const bad = [
  '', '   ', null, undefined, 'owner', 'a/b/c', '--upload-pack=touch /tmp/x', '--upload-pack=x/y', '-oProxyCommand=x/y',
  'file:///etc/passwd', 'file://github.com/o/r', '/etc/passwd', '/tmp/repo', 'ext::sh -c touch% /tmp/x', 'ext::sh/x',
  'o/r with space', 'o /r', 'o/r\nx', '../r', 'o/..', 'o/../x', '../../etc', 'o/r/../x', '.../r', 'o/.', '-o/r', 'o/-r',
  'http://github.com/o/r', 'ssh://git@github.com/o/r', 'git@github.com:o/r.git', 'https://evil.com/o/r', 'https://github.com.evil.com/o/r',
  'https://user:pw@github.com/o/r', 'https://github.com@evil.com/o/r', 'evil.com/o/r', 'github.com/o', 'github.com/o/r/extra',
  'https://github.com/o/r?x=1', 'https://github.com/o/r#x', 'o/r;ls', 'o/r$(x)', 'o/r`x`', 'o/r|x', 'o/r%20x', 'o\\r', 'a'.repeat(400),
  'https://github.com/' + 'a'.repeat(50) + '/r',
  // look-alikes and tricks
  'github.com.evil.com/o/r', '\u0261ithub.com/o/r', 'https://\u0261ithub.com/o/r', 'o/r\u202e', 'o/r\0', 'o/r\0.git', 'o/%2e%2e', 'https://github.com/o/%2e%2e',
  'o/r.git/../x', 'https://github.com/o/r.git/../x', 'o/.git', 'o/..git', 'https://github.com\\@evil.com/o/r', 'https://github.com:443/o/r',
  'https://https://github.com/o/r', 'github.com//o/r', '-/r', '--/--', 'o/r\r\n--upload-pack=x', 'o/' + 'r'.repeat(101), '\uff4f/\uff52',
];
for (const input of bad) ok(github.parseGithub(input) === null, `should refuse: ${JSON.stringify(input)}`);

// origins of existing projects
same(github.originInfo('https://github.com/o/r.git'), { page: 'https://github.com/o/r', https: true }, 'https origin');
same(github.originInfo('git@github.com:o/r.git'), { page: 'https://github.com/o/r', https: false }, 'ssh origin');
ok(github.originInfo('https://gitlab.com/o/r') === null, 'other host');
ok(github.originInfo('/tmp/some/repo') === null, 'local origin');
ok(github.originInfo('') === null, 'no origin');

// names
same(github.uniqueName('repo', []), 'repo', 'plain');
same(github.uniqueName('repo', ['Repo']), 'repo 2', 'capitals count as taken');
same(github.uniqueName('repo', ['repo', 'repo 2']), 'repo 3', 'next number');
same(github.uniqueName('my.app.js', []), 'my-app-js', 'dots become dashes');
same(github.uniqueName('.github', []), 'github', 'leading dot dropped');
same(github.uniqueName('...', []), 'project', 'nothing usable');
for (const odd of ['.', '..', '-', '---', '']) same(github.uniqueName(odd, []), 'project', `no folder called ${JSON.stringify(odd)}`);
same(github.uniqueName('CON', []), 'CON-project', 'a name Windows can\'t open');
same(github.uniqueName('nul', ['nul-project']), 'nul-project 2', 'and still unique');
same(github.uniqueName('a.', []), 'a-', 'no dot at the end');

// repositories on disk
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'github-test-'));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (file, text) => fs.writeFileSync(file, text);

async function main() {
  const bare = path.join(root, 'origin.git');
  git(root, 'init', '--bare', '-b', 'main', bare);
  const maker = path.join(root, 'maker');
  git(root, 'clone', bare, maker);
  write(path.join(maker, 'a.txt'), 'one\n');
  write(path.join(maker, 'b.txt'), 'bee\n');
  git(maker, 'add', '.');
  git(maker, 'commit', '-m', 'first');
  git(maker, 'push', 'origin', 'HEAD:main');

  // cloning, with progress
  const projects = path.join(root, 'projects');
  const seen = [];
  const made = await github.cloneRepo({ url: bare, repo: 'origin', projectsDir: projects, allowFile: true, onProgress: (step) => seen.push(step.percent) });
  same(made.name, 'origin', 'clone name');
  ok(fs.readFileSync(path.join(projects, 'origin', 'a.txt'), 'utf8') === 'one\n', 'clone has the files');
  ok(seen[0] === 0 && seen[seen.length - 1] === 100 && seen.every((v, i) => i === 0 || v >= seen[i - 1]), 'progress only goes up, 0 to 100');
  const second = await github.cloneRepo({ url: bare, repo: 'origin', projectsDir: projects, allowFile: true });
  same(second.name, 'origin 2', 'second clone gets a unique name');

  // without allowFile, a local path is refused and nothing is left behind
  await assert.rejects(github.cloneRepo({ url: bare, repo: 'nope', projectsDir: projects }), /couldn't get that repository/);
  passed += 1;
  ok(!fs.existsSync(path.join(projects, 'nope')), 'failed clone leaves no folder');

  // stop removes only the half-made folder
  fs.mkdirSync(path.join(projects, 'keep'));
  write(path.join(projects, 'keep', 'mine.txt'), 'mine');
  // stop is asked for right away, before git has done anything
  const hung = github.cloneRepo({ url: bare, repo: 'hung', projectsDir: projects, allowFile: true, onProgress: () => {} });
  github.stop();
  await assert.rejects(hung, (error) => error.stopped === true);
  passed += 1;
  ok(!fs.existsSync(path.join(projects, 'hung')), 'stopped clone removed its folder');
  ok(fs.existsSync(path.join(projects, 'keep', 'mine.txt')), 'other folders untouched');
  ok(github.stop() === false, 'nothing to stop afterwards');

  // updates
  const mine = path.join(projects, 'origin');
  same(await github.fetchStatus(mine, { allowFile: true }), { ahead: 0, behind: 0 }, 'up to date');
  write(path.join(maker, 'a.txt'), 'one\ntwo\n');
  git(maker, 'commit', '-am', 'second');
  write(path.join(maker, 'c.txt'), 'see\n');
  git(maker, 'add', '.');
  git(maker, 'commit', '-m', 'third');
  git(maker, 'push', 'origin', 'HEAD:main');
  same(await github.fetchStatus(mine, { allowFile: true }), { ahead: 0, behind: 2 }, 'two new');

  // local changes that would be overwritten: refused, nothing changed
  write(path.join(mine, 'a.txt'), 'my own edit\n');
  const before = git(mine, 'rev-parse', 'HEAD');
  await assert.rejects(github.pullDir(mine, { allowFile: true }), /unsaved changes/);
  passed += 1;
  same(fs.readFileSync(path.join(mine, 'a.txt'), 'utf8'), 'my own edit\n', 'owner edit kept');
  same(git(mine, 'rev-parse', 'HEAD'), before, 'history unchanged after refusal');
  git(mine, 'checkout', '--', 'a.txt');

  // an unrelated local change does not stop an update, and survives it
  write(path.join(mine, 'b.txt'), 'bee edited\n');
  const result = await github.pullDir(mine, { allowFile: true });
  same(result, { state: 'updated', count: 2 }, 'fast-forward');
  same(fs.readFileSync(path.join(mine, 'a.txt'), 'utf8'), 'one\ntwo\n', 'update arrived');
  ok(fs.existsSync(path.join(mine, 'c.txt')), 'new file arrived');
  same(fs.readFileSync(path.join(mine, 'b.txt'), 'utf8'), 'bee edited\n', 'unrelated edit survived');
  same(await github.pullDir(mine, { allowFile: true }), { state: 'current', count: 0 }, 'nothing more');
  git(mine, 'checkout', '--', 'b.txt');

  // divergence: refused, nothing changed
  const other = second.path;
  write(path.join(other, 'own.txt'), 'local commit\n');
  git(other, 'add', '.');
  git(other, 'commit', '-m', 'mine');
  const head = git(other, 'rev-parse', 'HEAD');
  await assert.rejects(github.pullDir(other, { allowFile: true }), /changes of its own/);
  passed += 1;
  same(git(other, 'rev-parse', 'HEAD'), head, 'diverged project unchanged');
  ok(!fs.existsSync(path.join(other, 'c.txt')), 'diverged project got nothing');
  same(git(other, 'status', '--porcelain'), '', 'no mess left');

  // ahead only: nothing to get
  same(await github.pullDir(mine, { allowFile: true }), { state: 'current', count: 0 }, 'still current');

  // not a repo: refused politely
  const plain = path.join(projects, 'keep');
  await assert.rejects(github.pullDir(plain, { allowFile: true }));
  passed += 1;
  await assert.rejects(github.pullProject('keep', projects), /isn't from GitHub/);
  passed += 1;
  await assert.rejects(github.pullProject('../x', projects), /isn't a project/);
  passed += 1;
  same(await github.checkMany(['keep', 'origin', '../x'], projects), {}, 'local-origin and non-repo projects are not checked');

  // asking GitHub never touches the files, and a refusal leaves everything exactly as it was
  write(path.join(maker, 'a.txt'), 'one\ntwo\nthree\n');
  git(maker, 'commit', '-am', 'fourth');
  git(maker, 'push', 'origin', 'HEAD:main');
  write(path.join(mine, 'a.txt'), 'mine again\n');
  const look = () => [git(mine, 'rev-parse', 'HEAD'), git(mine, 'status', '--porcelain'), fs.readFileSync(path.join(mine, 'a.txt'), 'utf8')];
  const was = look();
  same((await github.fetchStatus(mine, { allowFile: true })).behind, 1, 'one new');
  same(look(), was, 'asking changed nothing');
  await assert.rejects(github.pullDir(mine, { allowFile: true }), /unsaved changes/);
  passed += 1;
  same(look(), was, 'the refusal changed nothing');
  git(mine, 'checkout', '--', 'a.txt');

  // a project whose own git settings try to start programs or point somewhere else: none of it happens
  const marks = path.join(root, 'marks');
  const elsewhere = path.join(root, 'elsewhere');
  const hooks = path.join(root, 'hooks');
  for (const dir of [marks, elsewhere, hooks]) fs.mkdirSync(dir);
  write(path.join(elsewhere, 'precious.txt'), 'precious');
  const mark = `#!/bin/sh\ntouch "${marks}/$(basename "$0")"\n`;
  for (const hook of ['reference-transaction', 'post-merge', 'post-checkout', 'pre-auto-gc']) {
    for (const dir of [hooks, path.join(mine, '.git', 'hooks')]) fs.writeFileSync(path.join(dir, hook), mark, { mode: 0o755 });
  }
  write(path.join(root, 'run.sh'), `#!/bin/sh\ntouch "${marks}/ran"\n`);
  fs.chmodSync(path.join(root, 'run.sh'), 0o755);
  git(mine, 'config', 'core.hooksPath', hooks);
  git(mine, 'config', 'core.fsmonitor', path.join(root, 'run.sh'));
  git(mine, 'config', 'credential.helper', `!${path.join(root, 'run.sh')}`);
  git(mine, 'config', 'core.sshCommand', path.join(root, 'run.sh'));
  git(mine, 'config', 'core.worktree', elsewhere);
  same(await github.pullDir(mine, { allowFile: true }), { state: 'updated', count: 1 }, 'still updates');
  same(fs.readdirSync(marks), [], 'no hook or helper ran');
  same(fs.readdirSync(elsewhere), ['precious.txt'], 'the other folder was not touched');
  same(fs.readFileSync(path.join(mine, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n', 'the update landed in the project itself');
  const setting = (...args) => execFileSync('git', ['--git-dir', path.join(mine, '.git'), 'config', ...args]);
  setting('remote.origin.vcs', 'ext');
  setting('remote.origin.url', `sh -c 'touch ${marks}/ext'`);
  await assert.rejects(github.fetchStatus(mine, { allowFile: true }));
  passed += 1;
  setting('remote.origin.url', `ssh://localhost${bare}`);
  setting('--unset', 'remote.origin.vcs');
  await assert.rejects(github.fetchStatus(mine, { allowFile: true }));
  passed += 1;
  same(fs.readdirSync(marks), [], 'no helper program and no ssh');

  // A stand-in git that waits, to act while a clone is under way.
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" clone "*)\n  : > "${root}/started"\n  [ "$GH_TEST" = hang ] && exec sleep 30\n  sleep 1;;\nesac\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const started = async () => { while (!fs.existsSync(path.join(root, 'started'))) await new Promise((r) => setTimeout(r, 20)); fs.rmSync(path.join(root, 'started')); };
  const hidden = () => fs.readdirSync(projects).filter((name) => name.startsWith('.getting-'));
  const everything = () => execFileSync('find', [projects, '-path', '*/.git', '-prune', '-o', '-print'], { encoding: 'utf8' });

  // stop in the middle: only the hidden folder goes, and no half project was ever on show
  let all = everything();
  process.env.GH_TEST = 'hang';
  let going = github.cloneRepo({ url: bare, repo: 'half', projectsDir: projects, allowFile: true });
  await started();
  same(hidden().length, 1, 'the clone is in one hidden folder');
  ok(!fs.existsSync(path.join(projects, 'half')), 'no half project is on show');
  await assert.rejects(github.cloneRepo({ url: bare, repo: 'two', projectsDir: projects, allowFile: true }), /already coming/);
  passed += 1;
  ok(github.stop() === true && github.stop() === true, 'stop, pressed twice');
  await assert.rejects(going, (error) => error.stopped === true);
  passed += 1;
  same(everything(), all, 'after stop, projects is exactly as before');

  // the hidden folder swapped for a link to somewhere precious, mid-clone: the link's target survives
  going = github.cloneRepo({ url: bare, repo: 'swap', projectsDir: projects, allowFile: true });
  await started();
  const temp = path.join(projects, hidden()[0]);
  fs.renameSync(temp, path.join(root, 'moved-away'));
  fs.symlinkSync(elsewhere, temp);
  github.stop();
  await assert.rejects(going, (error) => error.stopped === true);
  passed += 1;
  same(fs.readdirSync(elsewhere), ['precious.txt'], 'a link put in its place is not followed');
  ok(fs.lstatSync(temp).isSymbolicLink(), 'and the link itself is left alone');
  fs.unlinkSync(temp);

  // swapped for another real folder with the same name: not the one that was made, so it stays
  going = github.cloneRepo({ url: bare, repo: 'swap', projectsDir: projects, allowFile: true });
  await started();
  const temp2 = path.join(projects, hidden()[0]);
  fs.renameSync(temp2, path.join(root, 'moved-away-2'));
  fs.mkdirSync(temp2);
  write(path.join(temp2, 'theirs.txt'), 'theirs');
  github.stop();
  await assert.rejects(going, (error) => error.stopped === true);
  passed += 1;
  ok(fs.existsSync(path.join(temp2, 'theirs.txt')), 'a different folder with the same name is left alone');
  fs.rmSync(temp2, { recursive: true });

  // too slow: stopped by the clock, nothing kept
  all = everything();
  await assert.rejects(github.cloneRepo({ url: bare, repo: 'slow', projectsDir: projects, allowFile: true, timeout: 300 }), /took too long/);
  passed += 1;
  fs.rmSync(path.join(root, 'started'), { force: true });
  same(everything(), all, 'after a timeout, projects is exactly as before');

  // the name gets taken while the clone runs: the clone takes the next name, theirs is untouched
  process.env.GH_TEST = 'slow';
  going = github.cloneRepo({ url: bare, repo: 'late', projectsDir: projects, allowFile: true });
  await started();
  fs.mkdirSync(path.join(projects, 'Late'));
  write(path.join(projects, 'Late', 'theirs.txt'), 'theirs');
  const late = await going;
  same(late.name, 'late 2', 'a name taken meanwhile is not reused');
  same(fs.readdirSync(path.join(projects, 'Late')), ['theirs.txt'], 'their folder is untouched');
  ok(fs.existsSync(path.join(late.path, 'a.txt')) && (fs.statSync(late.path).mode & 0o777) === 0o755, 'the project is whole, an ordinary folder');
  same(hidden(), [], 'no hidden folder left');
  ok(github.stop() === false, 'stop after it finished does nothing');
  ok(fs.existsSync(path.join(late.path, 'a.txt')), 'and the finished project stays');

  // projects is itself a link: the hidden folder is still made and removed in the real place
  fs.symlinkSync(projects, path.join(root, 'linked'));
  const viaLink = await github.cloneRepo({ url: bare, repo: 'vialink', projectsDir: path.join(root, 'linked'), allowFile: true });
  ok(fs.existsSync(path.join(projects, 'vialink', 'a.txt')) && viaLink.path === path.join(fs.realpathSync(projects), 'vialink'), 'works through a linked projects folder');
  process.env.PATH = oldPath;
}

main().then(() => {
  console.log(`github.test.js: ${passed} checks passed`);
  fs.rmSync(root, { recursive: true, force: true });
}, (error) => {
  console.error(error);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
