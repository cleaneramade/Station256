// Checks lib/agent-alerts.js with made-up screens and made-up Herdr answers. Plain node, no packages,
// never touches Docker or a room:
//   node panel/test/agent-alerts.test.js
// Exits with 1 if anything is wrong.
const assert = require('assert');
const alerts = require('../lib/agent-alerts');

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

const RULE = '─'.repeat(60);
const bash = (picked = 1, command = 'npm install left-pad') => [
  '⏺ I\'ll add the package now.',
  '',
  RULE,
  ' Bash command',
  '',
  `   ${command}`,
  '   Install left-pad',
  '',
  ' Do you want to proceed?',
  ` ${picked === 1 ? '❯' : ' '} 1. Yes`,
  ` ${picked === 2 ? '❯' : ' '} 2. Yes, and don't ask again for npm install commands in`,
  '     /workspace',
  ` ${picked === 3 ? '❯' : ' '} 3. No, and tell Claude what to do differently (esc)`,
  '',
].join('\n');

const boxed = [
  '╭──────────────────────────────────────────╮',
  '│ Edit file                                │',
  '│   src/app.js                             │',
  '│ Do you want to make this edit to app.js? │',
  '│ ❯ 1. Yes                                 │',
  '│   2. Yes, allow all edits during this session (shift+tab) │',
  '│   3. No, and tell Claude what to do differently (esc) │',
  '╰──────────────────────────────────────────╯',
].join('\n');

const choices = [
  '⏺ A couple of ways to do this.',
  '',
  ' Which layout should the home page use?',
  ' ❯ 1. Cards',
  '   2. List',
  '   3. Type something.',
].join('\n');

const working = '⏺ Running the tests...\n✻ Pondering…';
// A multiple-choice question, the arrow on option `at`; marks lists which options say (Recommended).
const pick = (at, marks = [2], extra = []) => [
  '☐ Layout',
  '',
  'Which layout should the home page use?',
  ...['Cards', 'List', 'Grid'].flatMap((name, i) => [
    `${at === i + 1 ? '❯' : ' '} ${i + 1}. ${name}${marks.includes(i + 1) ? ' (Recommended)' : ''}`,
    '     A short description.',
  ]),
  ...extra,
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

async function main() {
  // ---- Reading the question off the screen
  await check('a permission question can be answered', () => {
    const prompt = alerts.readPrompt(bash());
    assert.strictEqual(prompt.canAnswer, true);
    assert.strictEqual(prompt.heading, 'Bash command');
    assert.strictEqual(prompt.detail, 'npm install left-pad');
    assert.strictEqual(prompt.question, 'Do you want to proceed?');
    assert.strictEqual(prompt.yesPicked, true);
  });
  await check('a real v2.1.325 screen: no Tip line, the command between the dashed rules', () => {
    const prompt = alerts.readPrompt([
      ' Bash command',
      ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
      ' Update timestamp of x.txt',
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ' touch /tmp/aa-test/x.txt',
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and always allow access to /tmp/aa-test from this project',
      '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
      '   4. No',
      ' Esc to cancel · Tab to amend',
    ].join('\n'));
    assert.strictEqual(prompt.canAnswer, true);
    assert.strictEqual(prompt.yesPicked, true);
    assert.strictEqual(prompt.detail, 'touch /tmp/aa-test/x.txt');
  });
  await check('Yes is only picked when the arrow is on it', () => {
    assert.strictEqual(alerts.readPrompt(bash(2)).yesPicked, false);
    assert.strictEqual(alerts.readPrompt(bash(3)).yesPicked, false);
  });
  await check('the same question gives the same fingerprint wherever the arrow is', () => {
    assert.strictEqual(alerts.readPrompt(bash(1)).fingerprint, alerts.readPrompt(bash(2)).fingerprint);
  });
  await check('a different command gives a different fingerprint', () => {
    assert.notStrictEqual(alerts.readPrompt(bash(1)).fingerprint, alerts.readPrompt(bash(1, 'rm -rf build')).fingerprint);
  });
  await check('a question in a box is read too', () => {
    const prompt = alerts.readPrompt(boxed);
    assert.strictEqual(prompt.canAnswer, true);
    assert.strictEqual(prompt.heading, 'Edit file');
    assert.strictEqual(prompt.detail, 'src/app.js');
    assert.strictEqual(prompt.question, 'Do you want to make this edit to app.js?');
  });
  await check('a question with choices only opens the tab', () => {
    const prompt = alerts.readPrompt(choices);
    assert.strictEqual(prompt.canAnswer, false);
    assert.strictEqual(prompt.question, 'Which layout should the home page use?');
  });
  await check('a menu with one (Recommended) option is read', () => {
    const prompt = alerts.readPrompt(pick(1));
    assert.deepStrictEqual(prompt.recommended, [2]);
    assert.strictEqual(prompt.picked, 1);
    assert.strictEqual(prompt.multi, false);
    assert.strictEqual(prompt.choices.length, 3);
    assert.strictEqual(prompt.canAnswer, false);
    assert.strictEqual(alerts.readPrompt(pick(1)).fingerprint, alerts.readPrompt(pick(3)).fingerprint);
  });
  await check('a menu with tabs or tick boxes is multi', () => {
    assert.strictEqual(alerts.readPrompt(`← ☐ Layout  ☐ Colour  ✔ Submit →\n${pick(1)}`).multi, true);
    assert.strictEqual(alerts.readPrompt(pick(1).replace('Cards', '[ ] Cards')).multi, true);
  });
  await check('a past message you typed, shown with "> ", is no menu', () => {
    const past = '> I want:\n> 1. First thing\n  2. Second thing\n\n⏺ Sure, working on it.\n✻ Pondering…';
    assert.strictEqual(alerts.readPrompt(past).fingerprint, undefined);
    assert.strictEqual(alerts.readPrompt(past.replace(/> /g, '❯ ')).fingerprint, undefined);
    assert.strictEqual(alerts.readPrompt(pick(1).replace(/\nEnter to select.*$/, '')).fingerprint, undefined); // no footer
  });
  await check('an empty or odd screen is never an answerable question', () => {
    assert.strictEqual(alerts.readPrompt('').canAnswer, false);
    assert.strictEqual(alerts.readPrompt(' Do you want to proceed?\n ❯ 1. Sure\n   2. Nope').canAnswer, false);
  });
  await check('control characters and long lines are cleaned and cut', () => {
    const prompt = alerts.readPrompt(bash(1, `echo \u001b[31m${'x'.repeat(400)}`));
    assert.ok(!/[\u0000-\u001f]/.test(prompt.detail));
    assert.ok(prompt.detail.length <= 160);
  });

  // ---- The watcher, with a pretend Herdr
  const make = () => {
    const world = { tabs: { SampleApp: [{ tab: 'tab-1', panes: [{ agent: 'claude', status: 'working', title: 'Fixing login', pane: 'w1:p1' }] }] }, screen: working, ask: bash(), keys: [], auto: false, logs: [], onKey: null };
    const seen = { statuses: [], notes: [], gone: [], opened: [] };
    let looking = false;
    const watcher = alerts.create({
      listRooms: async () => Object.keys(world.tabs).map((name) => ({ name })),
      statuses: (map) => seen.statuses.push(map),
      notify: (note) => seen.notes.push(note),
      unnotify: (tag) => seen.gone.push(tag),
      looking: async () => looking, // the app asks Windows too, so the answer can take a moment
      openTab: async (room, tab) => seen.opened.push(`${room}/${tab}`),
      read: {
        roomTabs: async (name) => world.tabs[name],
        screenOf: async () => world.screen,
        pressKey: async (room, tab, pane, key) => { world.keys.push(`${room}/${tab}/${pane}/${key}`); if (world.onKey) world.onKey(key); return true; },
      },
      autoApprove: () => world.auto,
      log: (line) => world.logs.push(line),
      pause: 0,
    });
    // A blocked AI has its question on screen; the others don't.
    const set = (status) => {
      world.tabs.SampleApp[0].panes[0].status = status;
      world.screen = status === 'blocked' ? world.ask : working;
    };
    return { world, seen, watcher, set, look: (on) => { looking = on; } };
  };

  await check('tab colors come straight away, notifications only after a change shows twice', async () => {
    const { seen, watcher, set } = make();
    await watcher.tick();
    assert.deepStrictEqual(seen.statuses.at(-1), { 'SampleApp\ttab-1': 'working' });
    set('done');
    await watcher.tick();
    assert.deepStrictEqual(seen.statuses.at(-1), { 'SampleApp\ttab-1': 'done' });
    assert.strictEqual(seen.notes.length, 0);
    await watcher.tick();
    assert.strictEqual(seen.notes.length, 1);
    assert.strictEqual(seen.notes[0].title, 'SampleApp is done');
    assert.strictEqual(seen.notes[0].body, 'Fixing login');
    assert.deepStrictEqual(seen.notes[0].buttons, ['open']);
  });
  await check('what an AI is already doing when Station opens is no news', async () => {
    const { seen, watcher, set } = make();
    set('done');
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    assert.strictEqual(seen.notes.length, 0);
  });
  await check('a flicker never notifies', async () => {
    const { seen, watcher, set } = make();
    await watcher.tick();
    set('idle');
    await watcher.tick();
    set('working');
    await watcher.tick();
    await watcher.tick();
    assert.strictEqual(seen.notes.length, 0);
  });
  await check('needs you, with Approve, Deny and Open for a permission question', async () => {
    const { seen, watcher, set } = make();
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    await watcher.tick();
    const note = seen.notes.at(-1);
    assert.strictEqual(note.title, 'SampleApp needs you');
    assert.ok(note.body.startsWith('Bash command: npm install left-pad'));
    assert.deepStrictEqual(note.buttons, ['approve', 'deny', 'open']);
    assert.strictEqual(note.room, 'SampleApp');
    assert.strictEqual(note.tab, 'tab-1');
  });
  await check('Approve presses Enter when the same question is still there', async () => {
    const { seen, watcher, set, world } = make();
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    await watcher.tick();
    assert.strictEqual(await watcher.answer(seen.notes.at(-1).id, 'approve'), 'approved');
    assert.deepStrictEqual(world.keys, ['SampleApp/tab-1/w1:p1/enter']);
    assert.strictEqual(await watcher.answer(seen.notes.at(-1).id, 'approve'), 'unknown'); // only once
  });
  await check('Deny presses Esc', async () => {
    const { seen, watcher, set, world } = make();
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    await watcher.tick();
    assert.strictEqual(await watcher.answer(seen.notes.at(-1).id, 'deny'), 'denied');
    assert.deepStrictEqual(world.keys, ['SampleApp/tab-1/w1:p1/esc']);
  });
  await check('a different question on screen: nothing is pressed, the tab opens', async () => {
    const { seen, watcher, set, world } = make();
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    await watcher.tick();
    world.screen = bash(1, 'rm -rf build');
    assert.strictEqual(await watcher.answer(seen.notes.at(-1).id, 'approve'), 'changed');
    assert.deepStrictEqual(world.keys, []);
    assert.deepStrictEqual(seen.opened, ['SampleApp/tab-1']);
  });
  await check('Approve with the arrow moved off Yes: nothing is pressed', async () => {
    const { seen, watcher, set, world } = make();
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    await watcher.tick();
    world.screen = bash(2);
    assert.strictEqual(await watcher.answer(seen.notes.at(-1).id, 'approve'), 'changed');
    assert.deepStrictEqual(world.keys, []);
  });
  await check('a question that isn\'t a permission one only offers Open', async () => {
    const { seen, watcher, set, world } = make();
    world.ask = choices;
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    await watcher.tick();
    assert.deepStrictEqual(seen.notes.at(-1).buttons, ['open']);
    assert.strictEqual(seen.notes.at(-1).body, 'Which layout should the home page use?');
    assert.strictEqual(await watcher.answer(seen.notes.at(-1).id, 'approve'), 'changed');
    assert.deepStrictEqual(world.keys, []);
  });
  await check('no notification while you\'re looking at that terminal', async () => {
    const { seen, watcher, set, look } = make();
    await watcher.tick();
    look(true);
    set('done');
    await watcher.tick();
    await watcher.tick();
    assert.strictEqual(seen.notes.length, 0);
  });
  await check('once it moves on, its notification is taken away', async () => {
    const { seen, watcher, set } = make();
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    await watcher.tick();
    const tag = seen.notes.at(-1).tag;
    set('working');
    await watcher.tick();
    await watcher.tick();
    assert.ok(seen.gone.includes(tag));
  });
  await check('a closed tab takes its notification and color with it', async () => {
    const { seen, watcher, set, world } = make();
    await watcher.tick();
    set('done');
    await watcher.tick();
    await watcher.tick();
    const tag = seen.notes.at(-1).tag;
    world.tabs.SampleApp = [];
    await watcher.tick();
    assert.ok(seen.gone.includes(tag));
    assert.deepStrictEqual(seen.statuses.at(-1), {});
  });
  await check('a room that doesn\'t answer keeps its colors', async () => {
    const { seen, watcher, world } = make();
    await watcher.tick();
    world.tabs.SampleApp = null;
    await watcher.tick();
    assert.deepStrictEqual(seen.statuses.at(-1), { 'SampleApp\ttab-1': 'working' });
  });
  await check('looking at the tab takes its notification away', async () => {
    const { seen, watcher, set } = make();
    await watcher.tick();
    set('done');
    await watcher.tick();
    await watcher.tick();
    watcher.seen('SampleApp', 'tab-1');
    assert.ok(seen.gone.includes(seen.notes.at(-1).tag));
    assert.strictEqual(await watcher.answer(seen.notes.at(-1).id, 'open'), 'unknown');
  });
  await check('two different questions back to back both alert', async () => {
    const { seen, watcher, set, world } = make();
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    assert.strictEqual(seen.notes.length, 1);
    world.screen = bash(1, 'rm -rf build'); // the tab never left blocked in between
    await watcher.tick();
    await watcher.tick();
    assert.strictEqual(seen.notes.length, 2);
    assert.ok(seen.notes[1].body.includes('rm -rf build'));
  });
  await check('two identical questions with an answer between both alert', async () => {
    const { seen, watcher, set, world } = make();
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    assert.strictEqual(await watcher.answer(seen.notes.at(-1).id, 'approve'), 'approved');
    world.screen = working; // answered, and Herdr hasn't caught up yet
    await watcher.tick();
    world.screen = bash();
    await watcher.tick();
    assert.strictEqual(seen.notes.length, 2);
  });
  await check('the same question left standing alerts only once', async () => {
    const { seen, watcher, set } = make();
    await watcher.tick();
    set('blocked');
    for (let i = 0; i < 4; i += 1) await watcher.tick();
    assert.strictEqual(seen.notes.length, 1);
  });
  await check('Herdr says working but a question is on screen: blocked, and alerts', async () => {
    const { seen, watcher, world } = make();
    await watcher.tick();
    world.screen = bash(); // Herdr still says working
    await watcher.tick();
    assert.deepStrictEqual(seen.statuses.at(-1), { 'SampleApp\ttab-1': 'blocked' });
    assert.strictEqual(seen.notes.length, 1);
    assert.deepStrictEqual(seen.notes[0].buttons, ['approve', 'deny', 'open']);
  });
  await check('a past typed message while working: stays working, no notification', async () => {
    const { seen, watcher, world } = make();
    await watcher.tick();
    world.screen = '> 1. First thing\n  2. Second thing\n\n✻ Pondering…';
    await watcher.tick();
    await watcher.tick();
    assert.deepStrictEqual(seen.statuses.at(-1), { 'SampleApp\ttab-1': 'working' });
    assert.strictEqual(seen.notes.length, 0);
  });
  await check('a permission question left in the scrollback above the input box: not blocked, nothing pressed', async () => {
    const { seen, watcher, world } = make();
    world.auto = true;
    await watcher.tick();
    world.screen = `${bash()}
${RULE}
> 
${RULE}
  ? for shortcuts`;
    await watcher.tick();
    await watcher.tick();
    assert.strictEqual(alerts.readPrompt(world.screen).canAnswer, false);
    assert.deepStrictEqual(seen.statuses.at(-1), { 'SampleApp	tab-1': 'working' });
    assert.deepStrictEqual(world.keys, []);
    assert.strictEqual(seen.notes.length, 0);
  });
  await check('a plain > is not the picked mark', () => {
    assert.strictEqual(alerts.readPrompt(bash().replace('❯', '>')).yesPicked, false);
  });
  await check('the same question auto-answered twice and back again: you are told', async () => {
    const { seen, watcher, set, world } = make();
    world.auto = true;
    const real = Date.now;
    let now = real();
    Date.now = () => now;
    try {
      await watcher.tick();
      set('blocked'); // the screen never changes: the answer doesn't take
      for (let i = 0; i < 4; i += 1) {
        await watcher.tick();
        now += 9000; // past the repeat time, so the standing question counts as new
      }
    } finally {
      Date.now = real;
    }
    assert.deepStrictEqual(world.keys, ['SampleApp/tab-1/w1:p1/enter', 'SampleApp/tab-1/w1:p1/enter']);
    assert.ok(seen.notes.length >= 1);
  });
  await check('auto-approve off: a question just notifies', async () => {
    const { seen, watcher, set, world } = make();
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    assert.strictEqual(seen.notes.length, 1);
    assert.deepStrictEqual(world.keys, []);
  });
  await check('auto-approve on: Yes is pressed, no notification, one log line', async () => {
    const { seen, watcher, set, world } = make();
    world.auto = true;
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    await watcher.tick();
    assert.deepStrictEqual(world.keys, ['SampleApp/tab-1/w1:p1/enter']); // not twice
    assert.strictEqual(seen.notes.length, 0);
    assert.strictEqual(world.logs.length, 1);
  });
  await check('auto-approve works while you\'re looking at that tab', async () => {
    const { watcher, set, world, look } = make();
    world.auto = true;
    look(true);
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    assert.deepStrictEqual(world.keys, ['SampleApp/tab-1/w1:p1/enter']);
  });
  await check('auto-approve with the arrow off Yes: nothing is pressed, you are told', async () => {
    const { seen, watcher, set, world } = make();
    world.auto = true;
    world.ask = bash(2);
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    assert.deepStrictEqual(world.keys, []);
    assert.strictEqual(seen.notes.length, 1);
  });
  // A pretend menu: Down and Up move the arrow on the screen.
  const menu = (start, marks) => {
    const test = make();
    let at = start;
    test.world.auto = true;
    test.world.onKey = (key) => {
      if (key === 'down') at += 1;
      if (key === 'up') at -= 1;
      test.world.screen = pick(at, marks);
    };
    test.world.ask = pick(at, marks);
    return test;
  };
  await check('auto-approve: one (Recommended) option is picked and confirmed', async () => {
    const { seen, watcher, set, world } = menu(1, [3]);
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    assert.deepStrictEqual(world.keys.map((key) => key.split('/').pop()), ['down', 'down', 'enter']);
    assert.strictEqual(seen.notes.length, 0);
  });
  await check('auto-approve: the arrow can move up to it too', async () => {
    const { watcher, set, world } = menu(3, [1]);
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    assert.deepStrictEqual(world.keys.map((key) => key.split('/').pop()), ['up', 'up', 'enter']);
  });
  await check('auto-approve: no (Recommended) option -> you are told', async () => {
    const { seen, watcher, set, world } = menu(1, []);
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    assert.deepStrictEqual(world.keys, []);
    assert.strictEqual(seen.notes.length, 1);
  });
  await check('auto-approve: two (Recommended) options -> you are told', async () => {
    const { seen, watcher, set, world } = menu(1, [1, 2]);
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    assert.deepStrictEqual(world.keys, []);
    assert.strictEqual(seen.notes.length, 1);
  });
  await check('auto-approve: several questions (tabs) -> you are told', async () => {
    const { seen, watcher, set, world } = menu(1, [2]);
    world.ask = `← ☐ Layout  ☐ Colour  ✔ Submit →\n${pick(1)}`;
    await watcher.tick();
    set('blocked');
    await watcher.tick();
    assert.deepStrictEqual(world.keys, []);
    assert.strictEqual(seen.notes.length, 1);
  });
  await check('a second terminal in a room is named in the title', () => {
    assert.strictEqual(alerts.words('done', { room: 'SampleApp', tab: 'tab-2', title: '' }).title, 'SampleApp (terminal 2) is done');
  });

  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
}

main();
