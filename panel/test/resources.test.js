// Station asks Docker and the rooms as little as it can (lib/house.js, lib/herdr.js, lib/agent-alerts.js).
// A stand-in docker counts the calls; never touches a real room:
//   node panel/test/resources.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resources-'));
const count = path.join(dir, 'calls');
fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\necho "$1" >> ${count}\n[ "$1" = ps ] && echo 'abc|Demo|'\nexit 0\n`, { mode: 0o755 });
process.env.PATH = `${dir}:${process.env.PATH}`;
const calls = () => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim().split('\n').filter(Boolean) : []);

const house = require('../lib/house');
const herdr = require('../lib/herdr');
const alerts = require('../lib/agent-alerts');

(async () => {
  // Many askers at once: one docker ps.
  const answers = await Promise.all([house.rooms(), house.rooms(), house.rooms()]);
  assert.deepStrictEqual(answers[0], [{ name: 'Demo', windowsDoor: false }]);
  assert.strictEqual(calls().filter((c) => c === 'ps').length, 1, 'one docker ps for three askers');
  await new Promise((done) => { setTimeout(done, 1600); });
  await house.rooms();
  assert.strictEqual(calls().filter((c) => c === 'ps').length, 2, 'asked again once the answer is old');

  // Two readers of one room's tabs: one docker exec.
  await Promise.all([herdr.roomTabs('Demo'), herdr.roomTabs('Demo')]);
  assert.strictEqual(calls().filter((c) => c === 'exec').length, 1, 'one trip into the room for two readers');

  // Alerts: slow while nothing works, fast after a poke.
  let looks = 0;
  const wait = (ms) => new Promise((done) => { setTimeout(done, ms); });
  const a = alerts.create({ listRooms: async () => { looks += 1; return []; }, statuses: () => {}, notify: () => {}, unnotify: () => {}, every: 40, read: { roomTabs: async () => [] } });
  assert.strictEqual(a.busyNow(), false, 'nothing working: resting');
  a.start();
  await wait(650);
  const resting = looks;
  a.poke();
  assert.strictEqual(a.busyNow(), true, 'a poke means someone just typed');
  looks = 0;
  await wait(650);
  const quick = looks;
  a.stop();
  looks = 0;
  await wait(300);
  assert.ok(resting >= 3 && resting <= 6, `resting looks every 160 ms: ${resting} in 650 ms`);
  assert.ok(quick >= 12, `after a poke, every 40 ms: ${quick} in 650 ms`);
  assert.strictEqual(looks, 0, 'stopped means stopped');

  console.log('PASS resources: rooms and room tabs shared, alerts rest while idle');
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((error) => {
  console.log(`FAIL resources: ${error.message}`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
