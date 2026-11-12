// Checks lib/search.js on a made-up folder tree in the system's temp folder. Plain node, no packages:
//   node panel/test/search.test.js
// Exits with 1 if anything is wrong.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const search = require('../lib/search');

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

const everything = async () => {};
const run = async (root, query, options = {}) => {
  const found = [];
  const done = await search.search(root, query, { readable: everything, ...options }, (batch) => found.push(...batch), { cancelled: false });
  return { found, done };
};
const names = (found) => found.map((entry) => entry.name);
const make = (base, ...files) => files.forEach((file) => {
  fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
  fs.writeFileSync(path.join(base, file), 'x');
});

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'search-test-'));
  make(base, 'Report.txt', 'a/Quarterly Report.pdf', 'a/b/report-final.docx', 'a/b/notes.txt',
    'node_modules/report.js', '.git/report.txt', '.hidden/report.txt', 'build/report.txt', 'dist/report.txt', 'target/report.txt',
    '.cache/report.txt', '.next/report.txt', '__pycache__/report.txt', '.venv/report.txt', 'a/.secret-report.txt');
  fs.symlinkSync(path.join(base, 'a'), path.join(base, 'linked-report'));

  await check('matcher: every word must appear, any order, any capitals', () => {
    const wanted = search.words('  REPORT quarterly ');
    assert.deepStrictEqual(wanted, ['report', 'quarterly']);
    assert.ok(search.matches('Quarterly Report.pdf', wanted));
    assert.ok(!search.matches('Report.txt', wanted));
    assert.ok(!search.matches('anything', search.words('   ')));
  });

  await check('skip rules: the named folders and hidden folders', () => {
    for (const name of ['node_modules', '.git', '.cache', '.next', 'target', 'dist', 'build', '__pycache__', '.venv', '.anything']) assert.ok(search.skipFolder(name), name);
    for (const name of ['src', 'Documents', 'targets', 'builds']) assert.ok(!search.skipFolder(name), name);
  });

  await check('finds matches in nested folders, nearest first, with relative folder', async () => {
    const { found } = await run(base, 'report');
    assert.deepStrictEqual(names(found).sort(), ['Report.txt', 'linked-report', 'Quarterly Report.pdf', 'report-final.docx'].sort());
    assert.ok(names(found).indexOf('Report.txt') < names(found).indexOf('report-final.docx'), 'nearer first');
    assert.strictEqual(found.find((entry) => entry.name === 'report-final.docx').where, 'a/b');
    assert.strictEqual(found.find((entry) => entry.name === 'Report.txt').where, '');
    const deeper = found.find((entry) => entry.name === 'Quarterly Report.pdf');
    assert.strictEqual(deeper.folder, path.join(base, 'a'));
    assert.ok(deeper.size === 1 && deeper.mtime > 0, 'size and date filled in');
  });

  await check('two words narrow it', async () => {
    assert.deepStrictEqual(names((await run(base, 'report quarterly')).found), ['Quarterly Report.pdf']);
  });

  await check('hidden files only when asked, skipped folders never', async () => {
    assert.ok(!names((await run(base, 'secret')).found).length);
    assert.deepStrictEqual(names((await run(base, 'secret', { showHidden: true })).found), ['.secret-report.txt']);
    assert.ok(!(await run(base, 'report', { showHidden: true })).found.some((entry) => /node_modules|\.git|build|dist|target|cache|next|venv|__pycache__|hidden/.test(entry.where)));
  });

  await check('a link to a folder is not followed', async () => {
    const found = (await run(base, 'notes')).found;
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].where, 'a/b');
  });

  await check('a folder the house does not allow is left out', async () => {
    const readable = async (dir) => { if (dir.endsWith(`${path.sep}b`)) throw new Error('no'); };
    assert.deepStrictEqual(names((await run(base, 'notes', { readable })).found), []);
  });

  await check('stops at 1,000 and says so', async () => {
    const big = path.join(base, 'big');
    fs.mkdirSync(big);
    for (let i = 0; i < 1100; i += 1) fs.writeFileSync(path.join(big, `file-${i}.txt`), '');
    const { found, done } = await run(big, 'file');
    assert.strictEqual(found.length, search.LIMIT);
    assert.ok(done.capped);
  });

  await check('cancelling stops it and sends nothing more', async () => {
    const token = { cancelled: false };
    let batches = 0;
    const going = search.search(base, 'e', { readable: everything }, () => { batches += 1; }, token);
    token.cancelled = true;
    const done = await going;
    assert.ok(done.cancelled);
    assert.strictEqual(batches, 0);
  });

  await check('a new search for the same window stops the one before', async () => {
    const sent = [];
    const window = Object.assign(new (require('events'))(), { isDestroyed: () => false, send: (channel, payload) => sent.push([channel, payload.id]) });
    search.start(window, 7, 1, base, 'e', false, everything);
    search.start(window, 7, 2, base, 'report', false, everything);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!sent.some(([, id]) => id === 1), 'nothing from the first');
    assert.ok(sent.some(([channel, id]) => channel === 'search:done' && id === 2));
    assert.strictEqual(window.listenerCount('destroyed') + window.listenerCount('did-navigate'), 0, 'stops watching the page when done');
  });

  await check('a search stops when its page closes or loads again', async () => {
    const sent = [];
    const window = Object.assign(new (require('events'))(), { isDestroyed: () => false, send: (channel, payload) => sent.push([channel, payload.id]) });
    search.start(window, 8, 1, base, 'e', false, everything);
    window.emit('did-navigate');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepStrictEqual(sent, []);
  });

  fs.rmSync(base, { recursive: true, force: true }); // only the made-up tree this test just made
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
}

main();
