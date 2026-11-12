// Checks the scheduled-task runner (lib/schedules.js) with a made-up house: a fake docker and a fake
// room in a throwaway folder, so no real room, container or crontab is ever reached. Plain node:
//   node panel/test/schedule-runner.test.js
// "A minute" is 150 ms here (unitMs), so schedules fire quickly. Exits with 1 if anything is wrong.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('../lib/schedules');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(test, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return true; await sleep(25); }
  return false;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-sched-'));
const FAKE = path.join(root, 'fake');
fs.mkdirSync(FAKE, { recursive: true });
// The fake docker. ps says whether the room is up (the file "up"). exec records what it was asked
// (a line in exec.log: pid, start, then args; a line in done.log when it ends) and acts by "mode":
// quick (print and finish), slow (finish after a second), hang (never finish).
fs.writeFileSync(path.join(FAKE, 'docker'), `#!/bin/bash
F="${FAKE}"
case "$1" in
  ps) [ -e "$F/up" ] && echo "room-Demo.Project"; exit 0 ;;
  top)
    echo "PID TT COMMAND"; echo "1 ? /sbin/docker-init -- /home/dev/room-start"; echo "7 ? sleep infinity"
    echo "9 ? sshd: /usr/sbin/sshd -f /home/dev/.ssh/sshd_config [listener] 0 of 10-100 startups"
    [ -e "$F/busy" ] && echo "40 pts/0 claude"
    exit 0 ;;
  exec)
    echo "$$ $(date +%s%N) $*" >> "$F/exec.log"
    echo "$$" > "$F/last.pid"
    case "$*" in *" -i "*) cat > "$F/stdin.txt" ;; esac
    mode="$(cat "$F/mode" 2>/dev/null || echo quick)"
    case "$mode" in
      hang) exec sleep 600 ;;
      slow) echo "working"; sleep 1.2 ;;
      *) echo "hello from the room" ;;
    esac
    echo "$$ $(date +%s%N)" >> "$F/done.log"
    exit 0 ;;
esac
exit 1
`, { mode: 0o755 });
fs.writeFileSync(path.join(FAKE, 'room'), `#!/bin/bash
echo "$* stdin=$(readlink /proc/$$/fd/0)" >> "${FAKE}/room.log"
[ "$1" = open ] && touch "${FAKE}/up"
[ "$1" = tabs ] && { cat "${FAKE}/tabs" 2>/dev/null; exit 0; }
echo "room is up"
`, { mode: 0o755 });

let counter = 0;
function house(extra = {}) {
  counter += 1;
  const home = path.join(root, `home${counter}`);
  fs.mkdirSync(path.join(home, 'projects', 'Demo Project'), { recursive: true });
  fs.mkdirSync(path.join(home, 'projects', 'Other'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'house'), { recursive: true });
  for (const name of ['exec.log', 'done.log', 'room.log', 'stdin.txt', 'mode', 'last.pid', 'up', 'busy', 'tabs']) fs.rmSync(path.join(FAKE, name), { force: true });
  const runner = createRunner({ home, docker: path.join(FAKE, 'docker'), room: path.join(FAKE, 'room'), unitMs: 150, allowFast: true, graceMs: 200, local: true, ...extra });
  return { home, runner };
}
const mode = (value) => fs.writeFileSync(path.join(FAKE, 'mode'), value);
const execs = () => (fs.existsSync(path.join(FAKE, 'exec.log')) ? fs.readFileSync(path.join(FAKE, 'exec.log'), 'utf8').split('\n').filter(Boolean) : []);
const logsOf = (home, id) => { const dir = path.join(home, '.local', 'state', 'house', 'schedules', id); return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.log')).sort() : []; };
const first = async (runner) => (await runner.list()).tasks[0];
const command = { name: 'Nightly', project: 'Demo Project', kind: 'command', run: 'echo hi', when: { mode: 'daily', time: '03:00' } };

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

(async () => {
  await check('Run now runs a command in the project folder, starts the room headlessly, and saves the output', async () => {
    const { home, runner } = house();
    mode('quick');
    await runner.saveTask({ ...command, run: 'echo "$HOME"; ls' });
    const task = await first(runner);
    await runner.runNow(task.id);
    await runner.idle();
    const done = await first(runner);
    assert.ok(done.last && done.last.ok, `result ${JSON.stringify(done.last)}`);
    const call = execs()[0];
    assert.ok(call.includes('exec -w /workspace room-Demo.Project timeout -k 15 1800 bash -c echo "$HOME"; ls'), call);
    const opened = fs.readFileSync(path.join(FAKE, "room.log"), "utf8"); assert.ok(opened.startsWith("open Demo Project stdin=/dev/null"), opened);
    const out = await runner.output(task.id);
    assert.ok(out.text.includes('hello from the room') && out.text.includes('worked'), out.text);
    assert.strictEqual(logsOf(home, task.id).length, 1);
    assert.ok(fs.existsSync(path.join(home, '.config', 'house', 'schedules.json')));
    assert.deepStrictEqual(fs.readdirSync(path.join(home, '.config', 'house')), ['schedules.json'], 'no temporary file left');
    runner.stop();
  });

  await check('an AI prompt goes to claude -p on standard input, never into a shell line', async () => {
    const { runner } = house();
    mode('quick');
    const evil = `"; touch ${FAKE}/pwned; $(touch ${FAKE}/pwned2) \`touch ${FAKE}/pwned3\` -- --dangerous`;
    await runner.saveTask({ ...command, kind: 'ai', run: evil });
    const task = await first(runner);
    await runner.runNow(task.id);
    await runner.idle();
    assert.ok((await first(runner)).last.ok);
    const call = execs()[0];
    assert.ok(call.includes('exec -i -w /workspace room-Demo.Project timeout -k 15 1800 claude -p'), call);
    assert.ok(!call.includes('pwned'), 'the prompt is not in the command line');
    assert.strictEqual(fs.readFileSync(path.join(FAKE, 'stdin.txt'), 'utf8'), evil);
    for (const name of ['pwned', 'pwned2', 'pwned3']) assert.ok(!fs.existsSync(path.join(FAKE, name)), name);
    runner.stop();
  });

  await check('a room that is already up is not opened again', async () => {
    const { runner } = house();
    fs.writeFileSync(path.join(FAKE, 'up'), '');
    await runner.saveTask(command);
    await runner.runNow((await first(runner)).id);
    await runner.idle();
    assert.ok(!fs.existsSync(path.join(FAKE, 'room.log')));
    runner.stop();
  });

  await check('an every-minute schedule (checks only) fires on its own and logs each run', async () => {
    const { home, runner } = house();
    mode('quick');
    await runner.saveTask({ ...command, when: { mode: 'minutes', n: 1 } });
    await runner.start();
    const id = (await first(runner)).id;
    assert.ok(await until(() => logsOf(home, id).length >= 3), `only ${logsOf(home, id).length} runs`);
    runner.stop();
    await runner.idle();
    assert.ok((await first(runner)).last.ok);
  });

  await check('the real page refuses every minute', async () => {
    const { runner } = house({ allowFast: false });
    await assert.rejects(runner.saveTask({ ...command, when: { mode: 'minutes', n: 1 } }), /5 to/);
    await assert.rejects(runner.saveTask({ ...command, when: { mode: 'cron', text: '* * * * *' } }), /more often/);
  });

  await check('a run slower than the schedule never overlaps itself; the skipped ones are noted', async () => {
    const { home, runner } = house();
    mode('slow'); // about 1.2 s, while the schedule fires every 0.15 s
    await runner.saveTask({ ...command, when: { mode: 'minutes', n: 1 } });
    await runner.start();
    const id = (await first(runner)).id;
    assert.ok(await until(async () => (await first(runner)).lastSkip, 3000), 'no skip noted');
    assert.ok(await until(() => fs.existsSync(path.join(FAKE, 'done.log'))));
    runner.stop();
    await runner.idle();
    const starts = execs().map((line) => ({ pid: line.split(' ')[0], at: BigInt(line.split(' ')[1]) }));
    const ends = Object.fromEntries(fs.readFileSync(path.join(FAKE, 'done.log'), 'utf8').split('\n').filter(Boolean).map((line) => line.split(' ')));
    starts.forEach((a, i) => starts.slice(i + 1).forEach((b) => {
      if (ends[a.pid]) assert.ok(BigInt(ends[a.pid]) <= b.at, 'two runs were going at once');
    }));
    assert.ok((await first(runner)).lastSkip.note.includes('still going'));
    assert.ok(fs.readFileSync(path.join(home, '.local', 'state', 'house', 'schedules', 'schedules.log'), 'utf8').includes('still running'));
    assert.ok(logsOf(home, id).length >= 1);
  });

  await check('Run now while it is running says so', async () => {
    const { runner } = house();
    mode('slow');
    await runner.saveTask(command);
    const id = (await first(runner)).id;
    await runner.runNow(id);
    await assert.rejects(runner.runNow(id), /still running/);
    await runner.idle();
    runner.stop();
  });

  await check('the time limit stops a hung run, and the process is gone', async () => {
    const { runner } = house({ limitMs: 300 });
    mode('hang');
    await runner.saveTask(command);
    const id = (await first(runner)).id;
    await runner.runNow(id);
    assert.ok(await until(() => fs.existsSync(path.join(FAKE, 'last.pid'))));
    const pid = Number(fs.readFileSync(path.join(FAKE, 'last.pid'), 'utf8'));
    await runner.idle();
    const done = await first(runner);
    assert.strictEqual(done.last.ok, false);
    assert.ok(done.last.note.includes('time limit'), done.last.note);
    assert.ok(!alive(pid), 'the hung process is still alive');
    assert.ok(!done.running);
  });

  await check('editing re-plans the timer, and pausing stops runs', async () => {
    const { runner } = house();
    mode('quick');
    await runner.saveTask(command); // 3:00 every day: nothing soon
    await runner.start();
    const task = await first(runner);
    assert.ok(task.next > Date.now() + 1000);
    await sleep(500);
    assert.strictEqual(execs().length, 0);
    const edited = (await runner.saveTask({ ...command, id: task.id, when: { mode: 'minutes', n: 1 } })).tasks[0];
    assert.ok(edited.next < Date.now() + 400, 'the next run moved up');
    assert.ok(await until(() => execs().length >= 1), 'the edited schedule ran');
    await runner.setEnabled(task.id, false);
    await runner.idle();
    const count = execs().length;
    assert.strictEqual((await first(runner)).next, null);
    await sleep(600);
    assert.strictEqual(execs().length, count, 'a paused task ran');
    runner.stop();
  });

  await check('closing Station stops the run and leaves no process behind', async () => {
    const { runner } = house();
    mode('hang');
    await runner.saveTask({ ...command, when: { mode: 'minutes', n: 1 } });
    await runner.start();
    assert.ok(await until(() => fs.existsSync(path.join(FAKE, 'last.pid'))));
    const pid = Number(fs.readFileSync(path.join(FAKE, 'last.pid'), 'utf8'));
    assert.ok(alive(pid));
    runner.stop();
    assert.ok(await until(() => !alive(pid), 2000), 'the run is still going');
    const count = execs().length;
    await sleep(500);
    assert.strictEqual(execs().length, count, 'a run started after closing');
  });

  await check('only the last 20 outputs are kept', async () => {
    const { home, runner } = house();
    mode('quick');
    await runner.saveTask(command);
    const id = (await first(runner)).id;
    for (let i = 0; i < 23; i += 1) { await runner.runNow(id); await runner.idle(); }
    await sleep(100);
    assert.strictEqual(logsOf(home, id).length, 20);
    runner.stop();
  });

  await check('a missing, damaged or partly bad schedules file is handled, and the bad one is kept', async () => {
    const a = house();
    assert.deepStrictEqual((await a.runner.list()).tasks, []);
    assert.strictEqual((await a.runner.list()).problem, '');
    const b = house();
    const file = path.join(b.home, '.config', 'house', 'schedules.json');
    fs.writeFileSync(file, '{ this is not json');
    const list = await b.runner.list();
    assert.deepStrictEqual(list.tasks, []);
    assert.ok(list.problem.includes('damaged'));
    assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith('schedules.json.bad-')));
    await b.runner.saveTask(command); // and a fresh file is written
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length, 1);
    const c = house();
    fs.writeFileSync(path.join(c.home, '.config', 'house', 'schedules.json'), JSON.stringify({ version: 1, tasks: [{ ...command, id: 'abcabcabcabc' }, { name: 'bad' }] }));
    const some = await c.runner.list();
    assert.strictEqual(some.tasks.length, 1);
    assert.ok(some.problem.includes('1 task'));
  });

  await check('a task for a project that does not exist, or with a bad name or time, is refused', async () => {
    const { runner } = house();
    await assert.rejects(runner.saveTask({ ...command, project: 'Nope' }), /no project/);
    await assert.rejects(runner.saveTask({ ...command, project: '../etc' }), /project/);
    await assert.rejects(runner.saveTask({ ...command, name: '  ' }), /name/);
    await assert.rejects(runner.saveTask({ ...command, run: ' ' }), /command/);
    await assert.rejects(runner.saveTask({ ...command, kind: 'shell' }), /command or an AI/);
    await assert.rejects(runner.saveTask({ ...command, when: { mode: 'daily', time: '99:00' } }), /time/);
    assert.deepStrictEqual((await runner.list()).tasks, []);
  });

  await check('deleting a task removes it and its output', async () => {
    const { home, runner } = house();
    mode('quick');
    await runner.saveTask(command);
    const id = (await first(runner)).id;
    await runner.runNow(id);
    await runner.idle();
    assert.strictEqual(logsOf(home, id).length, 1);
    assert.deepStrictEqual((await runner.remove(id)).tasks, []);
    assert.strictEqual(logsOf(home, id).length, 0);
    runner.stop();
  });

  await check('multi-project: each project in turn, a result for each, a started room is closed again', async () => {
    const { runner } = house();
    mode('quick');
    await runner.saveTask({ ...command, project: undefined, projects: ['Demo Project', 'Other'] });
    const id = (await first(runner)).id;
    await runner.runNow(id);
    await runner.idle();
    const done = await first(runner);
    assert.deepStrictEqual(done.projects, ['Demo Project', 'Other']);
    assert.deepStrictEqual(done.last.results.map((r) => [r.project, r.ok]), [['Demo Project', true], ['Other', true]]);
    assert.strictEqual(execs().length, 2);
    assert.ok(execs()[0].includes('room-Demo.Project') && execs()[1].includes('room-Other'));
    const log = (await runner.output(id)).text;
    assert.ok(log.includes('===== Demo Project =====') && log.includes('===== Other ====='), log);
    assert.ok(fs.readFileSync(path.join(FAKE, 'room.log'), 'utf8').includes('close Demo Project'), 'the room this run started was closed');
    runner.stop();
  });

  await check('a room the run started is left open when someone else is in it, or when that can\'t be told', async () => {
    const closes = () => (fs.readFileSync(path.join(FAKE, 'room.log'), 'utf8').match(/^close /gm) || []).length;
    fs.writeFileSync(path.join(FAKE, 'docker-notop'), `#!/bin/bash\n[ "$1" = top ] && exit 1\nexec "${FAKE}/docker" "$@"\n`, { mode: 0o755 });
    const cases = [
      ['a terminal', {}, () => fs.writeFileSync(path.join(FAKE, 'busy'), '')],
      ['a Station tab', {}, () => fs.writeFileSync(path.join(FAKE, 'tabs'), 'Demo Project\ttab-1\n')],
      ['a docker that won\'t say', { docker: path.join(FAKE, 'docker-notop') }, () => {}],
    ];
    for (const [what, extra, set] of cases) {
      const { runner } = house(extra);
      mode('quick');
      await runner.saveTask(command);
      const id = (await first(runner)).id;
      set();
      await runner.runNow(id);
      await runner.idle();
      assert.strictEqual(closes(), 0, `closed with ${what} in it`);
      assert.ok((await runner.output(id)).text.includes('was left open'), `${what}: the output says the room was left open`);
      assert.ok((await first(runner)).last.ok, 'the run itself still worked');
      runner.stop();
    }
  });

  await check('the runner program: keeps firing after the panel quits, only one runs, and it ends when the last task is deleted', async () => {
    Object.assign(process.env, { HOUSE_SHOTS: '1', HOUSE_SCHEDULE_TEST: '1', HOUSE_SCHEDULE_UNIT: '150', PATH: `${FAKE}:${process.env.PATH}` });
    const { home } = house();
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.copyFileSync(path.join(FAKE, 'room'), path.join(home, '.local', 'bin', 'room'));
    fs.chmodSync(path.join(home, '.local', 'bin', 'room'), 0o755);
    mode('quick');
    const script = path.join(__dirname, '..', 'lib', 'schedules-runner.js');
    const panel = createRunner({ home, unitMs: 150, allowFast: true, runnerScript: script });
    const panel2 = createRunner({ home, unitMs: 150, allowFast: true, runnerScript: script });
    const copies = () => fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).filter((n) => { try { return fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').includes(`--home=${home}`); } catch { return false; } });
    let pid = 0;
    try {
      await panel.start();
      await sleep(400);
      assert.strictEqual(await panel.runnerPid(), 0, 'no runner while there is nothing to run');
      await panel.saveTask({ ...command, when: { mode: 'minutes', n: 1 } });
      assert.ok(await until(async () => (pid = await panel.runnerPid()) > 0), 'the panel started a runner');
      assert.strictEqual(fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(), 'house-schedules', 'it has a name the keeper ignores');
      const id = (await first(panel)).id;
      assert.ok(await until(() => logsOf(home, id).length >= 2), 'it runs the task');
      panel.stop(); // Station closes
      const seen = logsOf(home, id).length;
      assert.ok(await until(() => logsOf(home, id).length > seen + 1), 'it keeps firing after the panel is gone');
      assert.ok((await first(panel2)).last.ok, 'a second panel sees the results');
      await panel2.ensureRunner();
      await panel2.ensureRunner();
      await sleep(700);
      assert.strictEqual(await panel2.runnerPid(), pid, 'the same runner');
      assert.strictEqual(copies().length, 1, `a second runner started: ${copies()}`);
      await panel2.runNow(id).catch(() => {});
      let deleted = false;
      for (let i = 0; i < 50 && !deleted; i += 1) { deleted = await panel2.remove(id).then(() => true, () => false); if (!deleted) await sleep(50); }
      assert.ok(deleted, 'the task was deleted');
      assert.ok(await until(() => !alive(pid), 5000), 'the runner ended by itself with nothing to run');
      assert.ok(!fs.existsSync(path.join(home, '.local', 'state', 'house', 'schedules', 'runner.pid')), 'its lock is gone');
      assert.strictEqual(copies().length, 0);
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGTERM');
      panel2.stop();
    }
  });

  // Only this run's own throwaway folder is removed.
  if (root.startsWith(os.tmpdir()) && path.basename(root).startsWith('house-sched-')) fs.rmSync(root, { recursive: true, force: true });
  if (failed) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('All checks passed');
  process.exit(0);
})();
