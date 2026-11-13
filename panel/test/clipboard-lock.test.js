// The lock (the Windows door) never gates the clipboard: with it locked, text and files still go to
// Windows, text from Windows still comes in, and nothing ever asks Windows to clear its clipboard.
// Run: node panel/test/clipboard-lock.test.js (stubs the clipboard: touches nothing real)
const Module = require('module'); const assert = require('assert');
let sent = [], cleared = [], wrote = [], linked = true;
const stubs = {
  electron: { clipboard: { writeText: async (t) => wrote.push(t), readText: async () => '' } },
  './windows-link': { setClipboard: (x) => sent.push(x), clearClipboard: (t) => cleared.push(t), connected: () => linked },
  './files': { doorIsOpen: async () => false, DOOR: '/mnt/windows-door' }, // always locked
};
const orig = Module._load; Module._load = (r, ...a) => stubs[r] || orig(r, ...a);
const c = require(require('path').join(__dirname, '..', 'lib', 'clipboard.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // Text copied here, locked: reaches the helper after the settle delay, never cleared.
  assert.deepStrictEqual(await c.copyText('hello'), { ok: true });
  await wait(700);
  assert.deepStrictEqual(sent, [{ text: 'hello' }]); assert.deepStrictEqual(cleared, []);
  // A newer copy cancels the earlier one still waiting.
  sent.length = 0; await c.copyText('one'); await c.copyText('two'); await wait(700);
  assert.deepStrictEqual(sent, [{ text: 'two' }]);
  // No helper: the copy stays here and the answer says so.
  linked = false; sent.length = 0;
  assert.deepStrictEqual(await c.copyText('alone'), { ok: false }); await wait(700);
  assert.deepStrictEqual(sent, []); linked = true;
  // Text copied in Windows, locked: comes in.
  c.windowsChanged({ text: 'from windows' }); await wait(50); assert.equal(c.heard.written, 1);
  // Files copied here, locked: reach the helper. Cut stays a cut, except anything from C:.
  await c.copyFiles(['/home/alex/a.txt'], true);
  assert.deepStrictEqual(sent, [{ files: ['/home/alex/a.txt'], move: true }]);
  await c.copyFiles(['/home/alex/a.txt', '/mnt/windows-door/x.txt'], true);
  assert.equal(sent[1].move, false);
  assert.deepStrictEqual(cleared, []);
  console.log('PASS clipboard lock: text and files cross while locked, nothing cleared, Cut never offers C:');

  // Pasting a C: file from File Explorer while locked goes through the helper (the C: mount is
  // only there unlocked). The door flag lives in a temp folder, as lib/files.js does for checks.
  const fs = require('fs'), os = require('os'), path = require('path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-lock-'));
  process.env.HOUSE_SHOTS = path.join(base, 'shots');
  const dest = path.join(base, 'dest'); fs.mkdirSync(dest);
  const real = require(path.join(__dirname, '..', 'lib', 'files.js')); // by full path, so not the stub above
  const calls = [];
  const windows = { measure: async (p) => { calls.push(['measure', p]); return 5; }, copy: async (p) => { calls.push(['copy', p]); } };
  const source = 'C:\\Users\\x\\a.txt';
  let result = await real.importFromWindows([source], dest, windows);
  assert.deepStrictEqual(calls, [['measure', source], ['copy', source]]);
  assert.deepStrictEqual(result, []);
  // Unlocked: the door path is used as before, so the helper isn't asked.
  fs.writeFileSync(path.join(base, 'windows-door-open'), '');
  calls.length = 0;
  result = await real.importFromWindows([source], dest, windows);
  assert.deepStrictEqual(calls, []); // the file isn't in the (absent) door mount, so it fails there, not via the helper
  assert.equal(result.length, 1);
  fs.rmSync(base, { recursive: true, force: true });
  console.log('PASS paste from C: while locked goes through the helper; unlocked uses the door path');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
