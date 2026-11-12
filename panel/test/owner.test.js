// "Last edited by": the decision (edits.whoChanged) and the record of the owner's saves through
// Station (owner-saves.js), on small made-up data. Plain node: node panel/test/owner.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A home of its own, so the real notes and saves are never touched.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-test-'));
process.env.HOME = home;
const { whoChanged, SLACK_MS, ACTIVE_MS } = require('../lib/edits');
const ownerSaves = require('../lib/owner-saves');

const FILE = `${home}/projects/P/a.txt`;
const NOW = 1_800_000_000_000;
const note = (time, extra = {}) => ({ time, tool: 'claude', model: 'claude-opus-5-5', action: 'edit', ...extra });
const timeline = (...notes) => notes.map(({ time, tool, model }) => ({ time, tool, model })).sort((a, b) => a.time - b.time);
const me = 'Alex';
const ask = (over) => whoChanged({ path: FILE, mtime: NOW, notes: [], activity: [], saves: new Map(), me, ...over });

// The AI is the latest: the rule as it was.
const first = note(NOW - 1000);
assert.deepStrictEqual(ask({ notes: [first, note(NOW - 9000)], activity: [timeline(first)] }).edits.length, 2);
assert.ok(ask({ notes: [note(NOW - SLACK_MS)], activity: [] }).edits, 'saved exactly SLACK_MS after the note is still the AI');
assert.ok(!ask({ notes: [note(NOW - SLACK_MS - 1)], activity: [] }).edits, 'one ms past the slack is not');

// A save in Station after the AI's note is the owner's, for certain.
const old = note(NOW - 3600000);
assert.deepStrictEqual(ask({ notes: [old], activity: [timeline(old)], saves: new Map([[FILE, NOW + 500]]) }), { owner: { name: me, time: NOW, via: 'station' } });
// A save whose time doesn't match the file's mtime isn't evidence (a program changed it afterwards).
assert.deepStrictEqual(ask({ notes: [old], activity: [timeline(old)], saves: new Map([[FILE, NOW - 60000]]) }), { owner: { name: me, time: NOW } });
// A save in Station of a file with no AI notes at all.
assert.deepStrictEqual(ask({ saves: new Map([[FILE, NOW]]) }), { owner: { name: me, time: NOW, via: 'station' } });
// No notes and no save: nothing is known.
assert.strictEqual(ask({}), null);
assert.strictEqual(ask({ saves: new Map([[FILE, NOW - 600000]]) }), null);
// A newer AI note wins over a save before it.
assert.ok(ask({ notes: [note(NOW - 500)], activity: [], saves: new Map([[FILE, NOW - 400]]) }).edits);

// Changed after the AI's last note while it was working in the room: likely the AI, by the nearest note's model.
const other = note(NOW - 60000, { model: 'claude-sonnet-5-5' });
const result = ask({ notes: [old], activity: [timeline(old, other)] });
assert.deepStrictEqual(result, { likely: { tool: 'claude', model: 'claude-sonnet-5-5', time: NOW } });
// The nearest in time wins, before or after the file changed.
const before = note(NOW - 200000, { model: 'before' });
const after = note(NOW + 100000, { model: 'after' });
assert.strictEqual(ask({ notes: [old], activity: [timeline(old, before, after)] }).likely.model, 'after');
assert.strictEqual(ask({ notes: [old], activity: [timeline(old, note(NOW - 50000, { model: 'closer' }), after)] }).likely.model, 'closer');
// Two rooms: the nearest across both.
assert.strictEqual(ask({ notes: [old], activity: [timeline(old, before), timeline(note(NOW - 10000, { tool: 'codex', model: 'gpt' }))] }).likely.tool, 'codex');
// The 5-minute edge: exactly ACTIVE_MS away counts, one ms more doesn't.
assert.ok(ask({ notes: [old], activity: [timeline(old, note(NOW - ACTIVE_MS))] }).likely);
assert.ok(ask({ notes: [old], activity: [timeline(old, note(NOW + ACTIVE_MS))] }).likely);
assert.ok(ask({ notes: [old], activity: [timeline(old, note(NOW - ACTIVE_MS - 1))] }).owner);
// Nobody working nearby: the owner's name, without evidence.
assert.deepStrictEqual(ask({ notes: [old], activity: [timeline(old)] }), { owner: { name: me, time: NOW } });
// Deleted by the AI, then made again by a command or by hand.
const gone = note(NOW - 100000, { action: 'delete' });
assert.ok(ask({ notes: [gone], activity: [timeline(gone, note(NOW - 90000))] }).likely);
assert.deepStrictEqual(ask({ notes: [note(NOW - 5 * 3600000, { action: 'delete' })], activity: [[]] }), { owner: { name: me, time: NOW } });
// A file with the AI's note but a big gap: an AI at work elsewhere in time doesn't count.
assert.ok(ask({ notes: [old], activity: [[]] }).owner);

// The record of the owner's saves.
(async () => {
  const projects = path.join(home, 'projects', 'P');
  fs.mkdirSync(projects, { recursive: true });
  const log = path.join(home, '.local', 'state', 'house', 'owner-saves.jsonl');
  ownerSaves.note(path.join(home, 'Documents', 'x.txt'));
  ownerSaves.note(path.join(home, 'projects'));
  ownerSaves.note(`${home}/projects/../Music/y.wav`);
  ownerSaves.note(undefined);
  assert.ok(!fs.existsSync(log), 'only files inside projects are noted');
  ownerSaves.note(`${projects}/a.txt`);
  ownerSaves.note(`${projects}/b.txt`);
  const first = await ownerSaves.latest();
  assert.deepStrictEqual([...first.keys()].sort(), [`${projects}/a.txt`, `${projects}/b.txt`]);
  assert.strictEqual(await ownerSaves.latest(), first, 'not read again while the file is the same');
  await new Promise((resolve) => setTimeout(resolve, 15));
  ownerSaves.note(`${projects}/a.txt`);
  const second = await ownerSaves.latest();
  assert.notStrictEqual(second, first);
  assert.ok(second.get(`${projects}/a.txt`) >= first.get(`${projects}/a.txt`));

  // Past 1 MB it keeps the last 5,000 lines.
  const filler = Array.from({ length: 12000 }, (_, i) => JSON.stringify({ time: i, path: `${projects}/f${i}.txt` })).join('\n');
  fs.writeFileSync(log, `${filler}\n`);
  fs.writeFileSync(log, `${filler}\n${filler}\n`);
  assert.ok(fs.statSync(log).size > 1024 * 1024);
  ownerSaves.note(`${projects}/last.txt`);
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 5000);
  assert.strictEqual(JSON.parse(lines[lines.length - 1]).path, `${projects}/last.txt`);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(log)).filter((name) => name.endsWith('.tmp')), []);

  // It never throws into a save: the log is a folder, or the state folder can't be made.
  fs.rmSync(log);
  fs.mkdirSync(log);
  ownerSaves.note(`${projects}/a.txt`);
  assert.deepStrictEqual([...(await ownerSaves.latest())], []);
  process.env.HOME = '/dev/null/nowhere';
  ownerSaves.note('/dev/null/nowhere/projects/a.txt');
  fs.rmSync(home, { recursive: true, force: true });
  console.log('PASS owner.test.js');
})().catch((error) => { console.log('FAIL owner.test.js'); console.error(error); process.exit(1); });
