// Last read by and tokens per file: the attribution rule and the path mapping, on small made-up
// conversation files. Plain node: node panel/test/tokens.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { countTokens } = require('../lib/token-count');
const { buildIndex, buildFolders, lifetimeByProject } = require('../lib/touches');
const { mapRoomPath } = require('../lib/edits');
const { fromAccount } = require('../lib/owner');

const PROJECTS = path.join(os.homedir(), 'projects');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-test-'));
const file = path.join(dir, 'session.jsonl');
const T1 = '2026-11-10T10:00:00.000Z';
const T2 = '2026-11-10T11:00:00.000Z';
const T3 = '2026-11-10T12:00:00.000Z';

const reply = (id, time, model, usage, ...tools) => ({
  type: 'assistant', timestamp: time, message: { id, model, usage, content: tools.map(([name, input]) => ({ type: 'tool_use', name, input })) },
});
const lines = (...items) => `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;
const usage = (input, cacheCreate, cacheRead, output) => ({ input_tokens: input, cache_creation_input_tokens: cacheCreate, cache_read_input_tokens: cacheRead, output_tokens: output });
const count = (known) => countTokens({ root: dir, timeZone: 'UTC', files: known || {} })[file];

// One reply, saved as two lines with the same id (the way Claude Code writes it), touching two files and a Grep.
fs.writeFileSync(file, lines(
  reply('m1', T1, 'claude-opus-5-5', usage(10, 100, 890, 100), ['Read', { file_path: '/workspace/a.js' }]),
  reply('m1', T1, 'claude-opus-5-5', usage(10, 100, 890, 100), ['Edit', { file_path: '/workspace/src/b.js' }], ['Grep', { pattern: 'x', path: '/workspace/c.js' }]),
  reply('m2', T2, 'claude-sonnet-5-5', usage(0, 0, 400, 100), ['Read', { file_path: '/workspace/a.js' }]),
  { type: 'user', timestamp: T2, message: { content: 'hi' } },
));
let got = count();
assert.deepStrictEqual(got.days['2026-11-10'], [1000 + 400, 200], 'Home counts each reply once: read = input + cache, written = output');
// m1 has 1000 read + 100 written, shared by a.js and b.js (Grep's c.js doesn't count). m2: 400 + 100 for a.js alone.
assert.deepStrictEqual(Object.keys(got.touch).sort(), ['/workspace/a.js', '/workspace/src/b.js']);
assert.deepStrictEqual(got.touch['/workspace/a.js'], [Date.parse(T2), 'claude-sonnet-5-5', 500 + 400, 50 + 100]);
assert.deepStrictEqual(got.touch['/workspace/src/b.js'], [Date.parse(T1), 'claude-opus-5-5', 500, 50]);
// What the files got adds up to what Home counts (all of it went to a file here).
const sum = (index) => Object.values(index).reduce((s, v) => s + v[2] + v[3], 0);
assert.strictEqual(sum(got.touch), 1400 + 200);

// Later, a Write by Opus is added: only the new lines are read, and the latest time wins.
const known = { [file]: { offset: got.offset, ids: got.ids } };
fs.appendFileSync(file, lines(reply('m3', T3, 'claude-opus-5-5', usage(0, 0, 200, 50), ['Write', { file_path: '/workspace/src/b.js' }], ['Read', { file_path: 'relative.js' }])));
const more = count(known);
assert.deepStrictEqual(more.touch['/workspace/src/b.js'], [Date.parse(T3), 'claude-opus-5-5', 200, 50]);
assert.strictEqual(Object.keys(more.touch).length, 1, 'a path that isn\'t absolute is ignored');
assert.deepStrictEqual(more.days['2026-11-10'], [200, 50]);

// A reply split across two reads of the file: its tokens are counted once (the first time), and go to
// the file its later line read. A third line reading another file takes half back from the first.
const split = path.join(dir, 'split.jsonl');
const again = (last) => countTokens({ root: dir, timeZone: 'UTC', files: { [split]: { offset: last.offset, ids: last.ids, open: last.open } } })[split];
fs.writeFileSync(split, lines(reply('s1', T1, 'claude-opus-5-5', usage(0, 0, 100, 10))));
const first = countTokens({ root: dir, timeZone: 'UTC' })[split];
fs.appendFileSync(split, lines(reply('s1', T1, 'claude-opus-5-5', usage(0, 0, 100, 10), ['Read', { file_path: '/workspace/z.js' }])));
const second = again(first);
assert.deepStrictEqual(second.touch['/workspace/z.js'].slice(2), [100, 10]);
assert.deepStrictEqual(second.days, {});
fs.appendFileSync(split, lines({ type: 'user', timestamp: T1, message: { content: 'result' } }, reply('s1', T1, 'claude-opus-5-5', usage(0, 0, 100, 10), ['Read', { file_path: '/workspace/y.js' }])));
const third = again(second);
assert.deepStrictEqual([third.touch['/workspace/z.js'].slice(2), third.touch['/workspace/y.js'].slice(2)], [[-50, -5], [50, 5]]);
assert.deepStrictEqual(third.days, {});

// Path mapping: /workspace in a room is the project's folder in the house, nothing outside it.
const base = path.join(PROJECTS, 'Notes App');
assert.strictEqual(mapRoomPath(base, '/workspace/src/../a.js'), `${base}/a.js`);
assert.strictEqual(mapRoomPath(base, '/workspace/a.js'), `${base}/a.js`);
assert.strictEqual(mapRoomPath(base, '/workspace/../etc/passwd'), null);
assert.strictEqual(mapRoomPath(base, '/etc/passwd'), null);
assert.strictEqual(mapRoomPath(base, '/workspaceX/a.js'), null);

// The index: room paths mapped by room, the house's own conversations kept as they are, newest read wins, tokens add up.
const counts = {
  sources: {
    'room:Notes.App': { files: { r1: { touch: { '/workspace/a.js': [100, 'claude-opus-5-5', 10, 1], '/workspace/../x': [1, 'm', 1, 1] } }, r2: { touch: { '/workspace/a.js': [200, 'claude-sonnet-5-5', 5, 2] } } } },
    house: { files: { h1: { touch: { [`${PROJECTS}/SampleApp/b.js`]: [50, 'claude-opus-5-5', 7, 3], '/etc/passwd': [1, 'm', 1, 1] } } } },
    'room:Gone.Room': { files: { g: { touch: { '/workspace/a.js': [1, 'm', 1, 1] } } } },
  },
};
const index = buildIndex(counts, new Map([['Notes.App', 'Notes App']]), mapRoomPath);
assert.deepStrictEqual([...index.keys()].sort(), [`${base}/a.js`, `${PROJECTS}/SampleApp/b.js`].sort());
assert.deepStrictEqual(index.get(`${base}/a.js`), { time: 200, model: 'claude-sonnet-5-5', in: 15, out: 3 });

// Lifetime tokens per project: every day of every conversation file of its room (and the house's folder for it).
const life = lifetimeByProject({
  sources: {
    'room:Notes.App': { files: { a: { days: { '2026-11-01': [1000, 100], '2026-11-02': [500, 50] } }, b: { days: { '2026-11-02': [10, 1] } } } },
    house: { files: { [`/home/x/.claude/projects/${path.join(PROJECTS, 'SampleApp').replace(/[^A-Za-z0-9]/g, '-')}/s.jsonl`]: { days: { '2026-11-03': [7, 3] } } } },
  },
}, ['Notes App', 'SampleApp', 'Other']);
assert.strictEqual(life.get('Notes App'), 1661);
assert.strictEqual(life.get('SampleApp'), 10);
assert.strictEqual(life.get('Other'), undefined);

// Folder rollup: every file adds to each folder above it, up to ~/projects; the newest read wins, named from that folder.
const rolled = buildFolders(new Map([
  [`${PROJECTS}/SampleApp/src/deep/a.js`, { time: 100, model: 'claude-opus-5-5', in: 10, out: 1 }],
  [`${PROJECTS}/SampleApp/src/b.js`, { time: 300, model: 'claude-sonnet-5-5', in: 20, out: 2 }],
  [`${PROJECTS}/SampleApp/c.js`, { time: 200, model: 'claude-opus-5-5', in: 5, out: 0 }],
  [`${PROJECTS}/Other/d.js`, { time: 50, model: 'claude-opus-5-5', in: 1, out: 1 }],
  [`${os.homedir()}/elsewhere/e.js`, { time: 999, model: 'm', in: 100, out: 100 }],
]));
assert.deepStrictEqual(rolled.get(`${PROJECTS}/SampleApp/src/deep`), { in: 10, out: 1, last: { time: 100, model: 'claude-opus-5-5', file: 'a.js' } });
assert.deepStrictEqual(rolled.get(`${PROJECTS}/SampleApp/src`), { in: 30, out: 3, last: { time: 300, model: 'claude-sonnet-5-5', file: 'b.js' } }, 'nested folders sum, newest read wins');
assert.deepStrictEqual(rolled.get(`${PROJECTS}/SampleApp`), { in: 35, out: 3, last: { time: 300, model: 'claude-sonnet-5-5', file: 'src/b.js' } }, 'the file is named from the folder');
assert.deepStrictEqual(rolled.get(PROJECTS), { in: 36, out: 4, last: { time: 300, model: 'claude-sonnet-5-5', file: 'SampleApp/src/b.js' } }, '~/projects itself gets the sum');
assert.strictEqual(rolled.has(`${os.homedir()}/elsewhere`), false, 'a path outside ~/projects is not rolled up');
assert.strictEqual(rolled.has(os.homedir()), false);
// A folder the AI tried to read as a file ("~/projects/" above all) is not a file, and the walk never climbs above ~/projects.
const odd = buildFolders(new Map([
  [`${PROJECTS}/`, { time: 5, model: 'm', in: 7, out: 1 }],
  [`${PROJECTS}/SampleApp/src/`, { time: 6, model: 'm', in: 7, out: 1 }],
  [PROJECTS, { time: 7, model: 'm', in: 7, out: 1 }],
  [`${PROJECTS}X/a.js`, { time: 8, model: 'm', in: 7, out: 1 }],
  [`${PROJECTS}/Notes App/top.txt`, { time: 9, model: 'm', in: 2, out: 1 }],
]));
assert.deepStrictEqual([...odd.keys()].sort(), [PROJECTS, `${PROJECTS}/Notes App`], 'only the real file rolls up');
assert.deepStrictEqual(odd.get(PROJECTS), { in: 2, out: 1, last: { time: 9, model: 'm', file: 'Notes App/top.txt' } });
// A project row's all-time number comes from lifetimeByProject, not the rollup.
assert.strictEqual(life.get('SampleApp'), 10);
assert.notStrictEqual(life.get('SampleApp'), rolled.get(`${PROJECTS}/SampleApp`).in + rolled.get(`${PROJECTS}/SampleApp`).out);

// The owner's name from the account.
assert.strictEqual(fromAccount('alex'), 'Alex');
assert.strictEqual(fromAccount(''), 'You');

try { fs.rmSync(dir, { recursive: true }); } catch { /* left in the temp folder */ }
console.log('tokens.test.js: all passed');
