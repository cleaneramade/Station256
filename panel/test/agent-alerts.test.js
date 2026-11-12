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
    const world = { tabs: { SampleApp: [{ tab: 'tab-1', panes: [{ agent: 'claude', status: 'working', title: 'Fixing login', pane: 'w1:p1' }] }] }, screen: bash(), keys: [] };
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
        pressKey: async (room, tab, pane, key) => { world.keys.push(`${room}/${tab}/${pane}/${key}`); return true; },
      },
    });
    const set = (status) => { world.tabs.SampleApp[0].panes[0].status = status; };
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
    world.screen = choices;
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
  await check('a second terminal in a room is named in the title', () => {
    assert.strictEqual(alerts.words('done', { room: 'SampleApp', tab: 'tab-2', title: '' }).title, 'SampleApp (terminal 2) is done');
  });

  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
}

main();
