// Checks the clean-up routine (lib/housekeeping.js) in a throwaway HOME with a fake docker.
// Run: node panel/test/housekeeping.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A made-up home, set before the routine is loaded. Nothing outside it is touched.
const base = fs.mkdtempSync('/tmp/hk-test-');
const home = path.join(base, 'house-shots-home'); // looks like a leftover folder, but it is the HOME in use
fs.mkdirSync(home);
process.env.HOME = home;
const housekeeping = require('../lib/housekeeping');

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
let failures = 0;
async function check(name, test) {
  try {
    await test();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

// A fake docker that writes down what it was asked and answers like the real one.
const bin = path.join(base, 'bin');
fs.mkdirSync(bin);
const docker = path.join(bin, 'docker');
const record = path.join(base, 'docker.log');
fs.writeFileSync(docker, `#!/bin/bash
echo "$*" >> "${record}"
[ -f "${base}/docker-fails" ] && { echo "boom" >&2; exit 1; }
case "$1" in
  ps) printf 'room-Old.One\\texited\\nroom-Running\\trunning\\nroom-Fresh\\tcreated\\nother-thing\\texited\\nroom-;bad\\texited\\nroom-Dead\\tdead\\n' ;;
  inspect) echo 5000 ;;
  rm) case " $* " in *" -f "*) exit 2 ;; esac ;;
  builder) echo "Total reclaimed space: 6.4GB" ;;
  image) echo "Total reclaimed space: 0B" ;;
esac
`, { mode: 0o755 });
const calls = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\n').filter(Boolean) : []);

const elfHeader = (type) => {
  const head = Buffer.alloc(64);
  head.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  head.writeUInt16LE(type, 16);
  return head;
};
const writeElf = (file, type, size = 1.2 * MB) => {
  const data = Buffer.alloc(Math.floor(size));
  elfHeader(type).copy(data);
  fs.writeFileSync(file, data);
};

const projects = path.join(home, 'projects');
const shots = path.join(projects, 'Room', '.tools', 'shots-new');
const trash = path.join(home, '.local', 'share', 'house-trash');
const state = path.join(home, '.local', 'state', 'house');
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(path.join(projects, 'Room', 'node_modules', 'x'), { recursive: true });
fs.mkdirSync(path.join(trash, '.info'), { recursive: true });
fs.mkdirSync(state, { recursive: true });

(async () => {
  // A leftover test folder, old, and one next to it that is new.
  const oldLeft = path.join(base, 'house-shots-old');
  const newLeft = path.join(base, 'house-shots-new');
  fs.mkdirSync(oldLeft);
  fs.writeFileSync(path.join(oldLeft, 'a.png'), 'x');
  fs.mkdirSync(newLeft);
  fs.utimesSync(oldLeft, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));
  fs.utimesSync(home, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));

  // Crash dumps and look-alikes.
  writeElf(path.join(shots, 'core.1234'), 4);
  writeElf(path.join(shots, 'core'), 4);
  fs.writeFileSync(path.join(shots, 'core.js'), Buffer.alloc(2 * MB));
  writeElf(path.join(shots, 'core.1'), 2); // a program, not a dump
  writeElf(path.join(shots, 'core.2'), 4, 1000); // a real header but too small to be a dump
  writeElf(path.join(base, 'outside-core'), 4);
  fs.symlinkSync(path.join(base, 'outside-core'), path.join(shots, 'core.5'));
  writeElf(path.join(projects, 'Room', 'node_modules', 'x', 'core.9'), 4);
  // In the Trash: a dump with its note, and an old item with a note, a new one, and a link.
  const old = Date.now() - 31 * DAY;
  const fresh = Date.now() - 2 * DAY;
  writeElf(path.join(trash, `${fresh}-core.77`), 4);
  fs.writeFileSync(path.join(trash, '.info', `${fresh}-core.77.json`), '{}');
  fs.writeFileSync(path.join(trash, `${old}-notes.txt`), 'old');
  fs.writeFileSync(path.join(trash, '.info', `${old}-notes.txt.json`), '{}');
  fs.mkdirSync(path.join(trash, `${old}-folder`));
  fs.writeFileSync(path.join(trash, `${old}-folder`, 'inner'), 'x');
  fs.writeFileSync(path.join(trash, `${fresh}-new.txt`), 'new');
  fs.writeFileSync(path.join(trash, '.info', `${fresh}-new.txt.json`), '{}');
  fs.writeFileSync(path.join(trash, 'no-stamp.txt'), 'x');
  // Two thrown away in the same ms: the second is stored as <ms>2-<name> (lib/files.js).
  fs.writeFileSync(path.join(trash, `${old}2-twin.txt`), 'old twin');
  fs.writeFileSync(path.join(trash, `${fresh}2-twin.txt`), 'new twin');
  const outsideDir = path.join(base, 'outside-dir');
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'precious.txt'), 'keep me');
  fs.symlinkSync(outsideDir, path.join(trash, `${old}-link`));
  fs.mkdirSync(path.join(trash, `${old}-real`));
  fs.symlinkSync(outsideDir, path.join(trash, `${old}-real`, 'inside-link'));
  // A log over the limit, with a recognisable end.
  const log = path.join(state, 'panel.log');
  const logData = Buffer.concat([Buffer.alloc(6 * MB, 'a'), Buffer.alloc(MB - 5, 'b'), Buffer.from('LAST\n')]);
  fs.writeFileSync(log, logData);
  fs.writeFileSync(path.join(state, 'room.log'), 'small log\n');
  const inode = fs.statSync(log).ino;

  const result = await housekeeping.run({ docker, tmp: base });
  const rule = (id) => result.rules.find((entry) => entry.id === id);

  await check('result has every rule, with no errors', () => {
    assert.deepStrictEqual(result.rules.map((entry) => entry.id), ['roomContainers', 'crashDumps', 'trashOld', 'buildCache', 'logs', 'testLeftovers']);
    assert.ok(result.rules.every((entry) => !entry.error && Array.isArray(entry.removed) && typeof entry.bytes === 'number'), JSON.stringify(result));
  });
  await check('a real core file is deleted, and its size is counted', () => {
    assert.ok(!fs.existsSync(path.join(shots, 'core.1234')));
    assert.ok(!fs.existsSync(path.join(shots, 'core')));
    assert.ok(rule('crashDumps').bytes >= 2 * MB, `bytes ${rule('crashDumps').bytes}`);
  });
  await check('core.js, an ELF program named core.1, a small one, a link and node_modules are kept', () => {
    for (const name of ['core.js', 'core.1', 'core.2', 'core.5']) assert.ok(fs.existsSync(path.join(shots, name)), name);
    assert.ok(fs.existsSync(path.join(base, 'outside-core')), 'the link target');
    assert.ok(fs.existsSync(path.join(projects, 'Room', 'node_modules', 'x', 'core.9')));
  });
  await check('a dump in the Trash goes with its note', () => {
    assert.ok(!fs.existsSync(path.join(trash, `${fresh}-core.77`)));
    assert.ok(!fs.existsSync(path.join(trash, '.info', `${fresh}-core.77.json`)));
  });
  await check('Trash: items over 30 days go with their notes; newer ones, .info and unstamped stay', () => {
    assert.ok(!fs.existsSync(path.join(trash, `${old}-notes.txt`)));
    assert.ok(!fs.existsSync(path.join(trash, '.info', `${old}-notes.txt.json`)));
    assert.ok(!fs.existsSync(path.join(trash, `${old}-folder`)));
    assert.ok(fs.existsSync(path.join(trash, `${fresh}-new.txt`)));
    assert.ok(fs.existsSync(path.join(trash, '.info', `${fresh}-new.txt.json`)));
    assert.ok(fs.existsSync(path.join(trash, '.info')));
    assert.ok(fs.existsSync(path.join(trash, 'no-stamp.txt')));
    assert.ok(rule('trashOld').removed.includes('notes.txt'));
  });
  await check('Trash: a same-moment twin follows the same 30 days', () => {
    assert.ok(!fs.existsSync(path.join(trash, `${old}2-twin.txt`)));
    assert.ok(fs.existsSync(path.join(trash, `${fresh}2-twin.txt`)));
    assert.ok(rule('trashOld').removed.includes('twin.txt'));
  });
  await check('Trash: a link pointing outside is not followed', () => {
    assert.ok(!fs.existsSync(path.join(trash, `${old}-link`)) && !fs.lstatSync(path.join(trash, `${old}-link`), { throwIfNoEntry: false }));
    assert.ok(fs.existsSync(path.join(outsideDir, 'precious.txt')), 'target survived');
  });
  await check('the log is trimmed in place: same file, last 1 MB kept', () => {
    assert.strictEqual(fs.statSync(log).ino, inode);
    const now = fs.readFileSync(log);
    assert.strictEqual(now.length, MB);
    assert.ok(now.equals(logData.subarray(logData.length - MB)));
    assert.strictEqual(fs.readFileSync(path.join(state, 'room.log'), 'utf8'), 'small log\n');
  });
  await check('roomContainers removes only stopped room- containers, never with -f', () => {
    const removes = calls().filter((line) => line.startsWith('rm '));
    assert.deepStrictEqual(removes.sort(), ['rm room-Dead', 'rm room-Fresh', 'rm room-Old.One']);
    assert.ok(calls().filter((line) => /^(rm|kill|stop) /.test(line)).every((line) => !/(^| )(-f|--force)( |$)/.test(line)));
    assert.deepStrictEqual(rule('roomContainers').removed.sort(), ['room-Dead', 'room-Fresh', 'room-Old.One']);
    assert.strictEqual(rule('roomContainers').bytes, 15000);
  });
  await check('buildCache prunes a week-old cache and plain images, never -a, and reads the size', () => {
    const lines = calls().filter((line) => /prune/.test(line));
    assert.deepStrictEqual(lines, ['builder prune -f --filter until=168h', 'image prune -f']);
    assert.ok(calls().filter((line) => /prune/.test(line)).every((line) => !/(^| )(-a|--all|-af|-fa)( |$)/.test(line)));
    assert.strictEqual(rule('buildCache').bytes, 6.4e9);
  });
  await check('testLeftovers removes old /tmp/house-shots-* folders, not new ones, never the HOME in use', () => {
    assert.ok(!fs.existsSync(oldLeft));
    assert.ok(fs.existsSync(newLeft));
    assert.ok(fs.existsSync(home), 'HOME survived although old and named like a leftover');
  });
  await check('results are saved, with one log line per rule that removed something', () => {
    const saved = JSON.parse(fs.readFileSync(path.join(state, 'housekeeping.json'), 'utf8'));
    assert.strictEqual(saved.lastRun.time, result.time);
    assert.strictEqual(saved.runs.length, 1);
    assert.strictEqual(housekeeping.lastRunTime(), result.time);
    const lines = fs.readFileSync(path.join(state, 'housekeeping.log'), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, result.rules.filter((entry) => entry.removed.length).length);
  });
  await check('only the last ten runs are kept', async () => {
    for (let i = 0; i < 12; i += 1) await housekeeping.run({ docker, tmp: base });
    assert.strictEqual(housekeeping.status().runs.length, 10);
  });

  // A second run finds nothing more to do.
  await check('a second run removes nothing it should keep', async () => {
    const again = await housekeeping.run({ docker, tmp: base });
    assert.strictEqual(again.rules.find((entry) => entry.id === 'trashOld').removed.length, 0);
    assert.ok(fs.existsSync(path.join(shots, 'core.js')) && fs.existsSync(path.join(trash, `${fresh}-new.txt`)));
  });

  await check('a docker that fails is reported, and the rest still runs', async () => {
    fs.writeFileSync(path.join(base, 'docker-fails'), '');
    writeElf(path.join(shots, 'core.4321'), 4);
    const broken = await housekeeping.run({ docker, tmp: base });
    assert.ok(broken.rules.find((entry) => entry.id === 'roomContainers').error);
    assert.ok(broken.rules.find((entry) => entry.id === 'buildCache').error);
    assert.ok(!fs.existsSync(path.join(shots, 'core.4321')), 'crash dumps still cleaned');
    fs.rmSync(path.join(base, 'docker-fails'));
  });
  await check('a missing docker does not throw', async () => {
    const missing = await housekeeping.run({ docker: path.join(base, 'no-such-docker'), tmp: base });
    assert.ok(missing.rules.find((entry) => entry.id === 'roomContainers').error);
    assert.strictEqual(missing.rules.length, 6);
  });
  await check('a rule from the app that throws is reported, not thrown', async () => {
    const out = await housekeeping.run({ docker, tmp: base, extra: [{ id: 'x', label: 'X', fn: async () => { throw new Error('nope'); } }, { id: 'y', label: 'Y', fn: async () => ({ removed: ['a'], bytes: 3 }) }] });
    assert.strictEqual(out.rules.find((entry) => entry.id === 'x').error, 'nope');
    assert.strictEqual(out.rules.find((entry) => entry.id === 'y').bytes, 3);
  });
  await check('asked twice at once, it runs once', async () => {
    fs.rmSync(record, { force: true });
    const [one, two] = [housekeeping.run({ docker, tmp: base }), housekeeping.run({ docker, tmp: base })];
    assert.strictEqual(await one, await two);
    assert.strictEqual(calls().filter((line) => line.startsWith('ps ')).length, 1);
  });

  // The editor script follows import.ts: only "station-import", only entries over 12 hours old.
  await check('editor copies: old ones go, new ones and other folders stay', async () => {
    const files = new Map([['old', 100], [`${Date.now() - 13 * 3600000}-aaa`, 360], [`${Date.now() - 1000}-bbb`, 50], ['junk', 5]]);
    files.delete('old');
    const gone = [];
    const folder = {
      async *keys() { yield* [...files.keys()]; },
      async getFileHandle(name) { return { getFile: async () => ({ size: files.get(name) }) }; },
      async removeEntry(name) { files.delete(name); gone.push(name); },
    };
    const asked = [];
    const root = { async getDirectoryHandle(name) { asked.push(name); if (name !== 'station-import') throw new Error('never touched'); return folder; } };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const answer = await new AsyncFunction('navigator', `return ${housekeeping.EDITOR_COPIES_SCRIPT}`)({ storage: { getDirectory: async () => root } });
    assert.deepStrictEqual(asked, ['station-import']);
    assert.strictEqual(answer.removed.length, 2); // the 13-hour-old copy and "junk" (no stamp: the same rule as import.ts)
    assert.strictEqual(answer.bytes, 365);
    assert.strictEqual(files.size, 1);
  });

  fs.rmSync(base, { recursive: true, force: true });
  console.log(`${failures ? 'FAIL' : 'PASS'} housekeeping: ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
