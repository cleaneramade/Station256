const Module = require('module'); const assert = require('assert');
let locked = true, sent = [], cleared = [], wrote = [], blocked = 0;
const stubs = {
  electron: { clipboard: { writeText: async (t) => wrote.push(t), readText: async () => '' } },
  './windows-link': { setClipboard: (x) => sent.push(x), clearClipboard: (t) => cleared.push(t) },
  './files': { doorIsOpen: async () => !locked, DOOR: '/mnt/windows-door' },
};
const orig = Module._load; Module._load = (r, ...a) => stubs[r] || orig(r, ...a);
const c = require(require('path').join(__dirname, '..', 'lib', 'clipboard.js'));
c.setBlockedNotice(() => blocked++);
(async () => {
  let r = await c.copyText('secret'); assert.deepStrictEqual(r, { ok: true, locked: true }); assert.equal(blocked, 1);
  r = await c.copyFiles(['/home/alex/a.txt']); assert.equal(r.locked, true); assert.equal(blocked, 2);
  await new Promise((r) => setTimeout(r, 700)); assert.deepStrictEqual(sent, []); 
  c.windowsChanged({ text: 'from windows' }); await new Promise((r) => setTimeout(r, 50)); assert.equal(c.heard.written, 0);
  locked = false;
  await c.copyText('open'); await new Promise((r) => setTimeout(r, 700)); assert.equal(sent.length, 1);
  c.windowsChanged({ text: 'from windows' }); await new Promise((r) => setTimeout(r, 50)); assert.equal(c.heard.written, 1);
  console.log('PASS clipboard lock', { cleared });
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
