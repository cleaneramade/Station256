// Pasting uses the newest text: Windows' if it copied after the house, else the house's own.
// Run: node panel/test/clipboard-sync.test.js (stubs the clipboard: touches nothing real)
const Module = require('module'); const assert = require('assert');
let have = '', sent = [], noted = [];
const stubs = {
  electron: { clipboard: { writeText: (t) => { have = t; }, readText: () => have } },
  './windows-link': { setClipboard: (x) => sent.push(x), connected: () => true },
};
const orig = Module._load; Module._load = (r, ...a) => stubs[r] || orig(r, ...a);
console.error = (line) => noted.push(line);
const c = require('../lib/clipboard.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // Windows copied "win" but WSLg dropped it: paste gets it, the house's clipboard is put right, one note.
  have = 'old';
  c.windowsChanged({ text: 'win' }); await wait(20); // the write on the way in may be dropped too
  have = 'old';
  assert.equal(c.windowsInstead(), 'win');
  assert.equal(await c.readText('paste'), 'win'); assert.equal(have, 'win');
  assert.equal(noted.length, 2); assert.ok(noted.every((n) => n.includes('(house 3, Windows 3)')));
  // Nothing disagrees: no note, house text used. Windows' line ends don't count as a difference.
  noted.length = 0; assert.equal(await c.readText('paste'), 'win'); assert.equal(c.windowsInstead(), null);
  have = 'a\nb'; c.windowsChanged({ text: 'a\r\nb' }); await wait(20); assert.equal(await c.readText('focus'), 'a\nb'); assert.equal(noted.length, 0);
  // The house copies after Windows: its text wins and goes to Windows once.
  have = 'a\nb'; await c.copyText('house'); assert.equal(await c.readText('paste'), 'house'); assert.equal(c.windowsInstead(), null);
  await wait(700); assert.deepStrictEqual(sent, [{ text: 'house' }]);
  // A web page's own copy: the house already has it, it only goes to Windows.
  sent.length = 0; have = 'from page'; await c.shareNative(); await wait(700);
  assert.deepStrictEqual(sent, [{ text: 'from page' }]);
  // A page Ctrl+C that copied nothing, while the house's write of Windows' copy was dropped: Windows' copy stays.
  sent.length = 0; have = 'stale'; c.windowsChanged({ text: 'fresh' }); await wait(20); have = 'stale';
  await c.shareNative(); await wait(700); assert.deepStrictEqual(sent, []); assert.equal(await c.readText('paste'), 'fresh');
  // A house copy that skipped copyText (editor tab, Copy Image, a Linux app) after a Windows copy wins.
  c.windowsChanged({ text: 'w3' }); await wait(20); have = 'other app'; assert.equal(await c.readText('paste'), 'other app'); assert.equal(c.windowsInstead(), null);
  have = 'older'; assert.equal(await c.readText('paste'), 'older'); // and stays won, even if it changes back
  // A newer Windows file copy means the old Windows text no longer wins.
  c.windowsChanged({ text: 'w2' }); await wait(20); c.windowsChanged({ files: 2 }); have = 'x'; assert.equal(await c.readText('paste'), 'x');
  console.log('PASS clipboard sync: newest copy wins, notes hold lengths only, page copies reach Windows');
})().catch((e) => { console.log('FAIL clipboard sync:', e.message); process.exit(1); });
