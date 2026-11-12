'use strict';
// Tests lib/selfcheck.js with HOME pointed at a temp folder. Run: node panel/test/selfcheck.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'house-selfcheck-'));
process.env.HOME = home;
const selfcheck = require('../lib/selfcheck');

const config = path.join(home, '.config', 'house');
const state = path.join(home, '.local', 'state', 'house');
fs.mkdirSync(config, { recursive: true });
fs.mkdirSync(state, { recursive: true });
let failed = false;
const report = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} selfcheck: ${label}`); if (!ok) failed = true; };
const quiet = [];
const run = (extra = {}) => selfcheck.run({ home, log: (line) => quiet.push(line), ...extra });
const list = (dir) => fs.readdirSync(dir).sort();
const old = (file, hours) => { const t = new Date(Date.now() - hours * 3600 * 1000); fs.utimesSync(file, t, t); };

// A damaged panel.json is moved aside, and the file is gone so the defaults take over.
const panel = path.join(config, 'panel.json');
fs.writeFileSync(panel, '{"zoomLevel": 1, "window": {');
run();
report(!fs.existsSync(panel), 'a damaged panel.json is moved out of the way');
const copies = list(config).filter((n) => n.startsWith('panel.json.broken-'));
report(copies.length === 1 && fs.readFileSync(path.join(config, copies[0]), 'utf8') === '{"zoomLevel": 1, "window": {', 'the damaged content is kept in a .broken- copy');
report(quiet.some((l) => l.includes('[station]') && l.includes('was damaged; kept a copy as panel.json.broken-') && l.includes('started it fresh')), 'the log line says what happened');

// Empty counts as damaged too; a good file is left alone, and so are missing ones.
fs.writeFileSync(path.join(state, 'token-counts.json'), '');
fs.writeFileSync(path.join(state, 'parked-tabs.json'), '{"a":[1,2]}');
const parkedBefore = fs.statSync(path.join(state, 'parked-tabs.json'));
run();
report(!fs.existsSync(path.join(state, 'token-counts.json')) && list(state).some((n) => n.startsWith('token-counts.json.broken-')), 'an empty file is damaged');
report(fs.readFileSync(path.join(state, 'parked-tabs.json'), 'utf8') === '{"a":[1,2]}' && fs.statSync(path.join(state, 'parked-tabs.json')).mtimeMs === parkedBefore.mtimeMs, 'a good file is untouched');
report(!fs.existsSync(path.join(state, 'housekeeping.json')), 'a missing file is not made');

// Only the newest 3 copies stay.
const results = path.join(state, 'housekeeping.json');
for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(state, `housekeeping.json.broken-2026010${i}-000000`), `old ${i}`);
fs.writeFileSync(results, 'garbage');
run();
const kept = list(state).filter((n) => n.startsWith('housekeeping.json.broken-'));
report(kept.length === 3 && !kept.includes('housekeeping.json.broken-20260101-000000') && !kept.includes('housekeeping.json.broken-20260102-000000') && kept.some((n) => !/^housekeeping\.json\.broken-2026010\d-000000$/.test(n)), `only the newest 3 broken copies are kept (${kept.length})`);

// A damaged schedules.json is left for lib/schedules.js, which sets it aside and says so on its page.
const schedules = path.join(config, 'schedules.json');
fs.writeFileSync(schedules, 'garbage');
run();
report(fs.readFileSync(schedules, 'utf8') === 'garbage' && !list(config).some((n) => n.startsWith('schedules.json.broken-')), 'a damaged schedules.json is left to the Schedules page');

// Old temp files go, new ones stay, other files are not touched.
const names = ['panel.json.new', 'panel.json.tmp', 'panel.json.123.tmp', 'token-counts.json.456.new', 'schedules.json.tmp-789'];
for (const n of names) {
  const dir = n.startsWith('token') ? state : config;
  fs.writeFileSync(path.join(dir, n), 'x');
  old(path.join(dir, n), 2);
}
fs.writeFileSync(path.join(config, 'parked-tabs.json.tmp'), 'new'); // wrong folder name but fresh
fs.writeFileSync(path.join(state, 'parked-tabs.json.tmp'), 'new');
fs.writeFileSync(path.join(state, 'other.json.tmp'), 'x');
old(path.join(state, 'other.json.tmp'), 5);
fs.writeFileSync(path.join(config, 'panel.json.bak'), 'x');
old(path.join(config, 'panel.json.bak'), 5);
run();
report(names.every((n) => !fs.existsSync(path.join(n.startsWith('token') ? state : config, n))), 'old temp files are removed');
report(fs.existsSync(path.join(state, 'parked-tabs.json.tmp')), 'a new temp file stays');
report(fs.existsSync(path.join(state, 'other.json.tmp')) && fs.existsSync(path.join(config, 'panel.json.bak')), 'files that are not exact temp names of Station files stay');

// Secrets and key files are never touched, even broken and old.
const secrets = path.join(config, 'secrets');
const key = path.join(config, 'api-key.json');
const key2 = path.join(config, 'deploy.key');
const keyTemp = path.join(config, 'api-key.json.tmp');
fs.mkdirSync(secrets);
const inside = path.join(secrets, 'token.json');
fs.writeFileSync(inside, '{broken');
for (const f of [secrets + '.json', key, key2, keyTemp]) fs.writeFileSync(f, '{broken');
for (const f of [inside, secrets + '.json', key, key2, keyTemp]) old(f, 9);
run();
report([inside, secrets + '.json', key, key2, keyTemp].every((f) => fs.readFileSync(f, 'utf8') === '{broken'), 'secrets and key files are never touched');
report(!list(config).some((n) => n.includes('secrets') && n.includes('broken-')) && !list(config).some((n) => n.startsWith('api-key') && n.includes('broken-')), 'and no copies of them are made');

// readSettings' use: setAside on its own.
fs.writeFileSync(panel, 'nope');
const moved = selfcheck.setAside(panel, () => {});
report(moved && !fs.existsSync(panel) && fs.readFileSync(moved, 'utf8') === 'nope', 'setAside moves a damaged file once');

fs.rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
