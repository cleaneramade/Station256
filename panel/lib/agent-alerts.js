// Watches the AI in every open room's terminals the whole time Station 256 is open, for two things:
//   - the colors on terminal tabs: green while the AI works, yellow when it needs you;
//   - a Windows notification when an AI finishes, or needs you. When it's asking permission (Claude's
//     "Do you want to ...?"), the notification can answer it: Approve or Deny. Only while that same
//     question is still on the screen, with Yes picked. Otherwise the button just opens the tab.
// Herdr reads each AI's state off its screen (lib/herdr.js). A change has to show twice in a row
// before it counts, so a passing flicker never sends a notification.
// Everything read from a room is untrusted: it's only matched against a few known words, and what's
// shown is plain text, cut short.
const crypto = require('crypto');
const herdr = require('./herdr');

const EVERY = 3000;
const REPEAT = 8000; // the same question still up this long after it was answered counts as a new one
const NAME = /^[A-Za-z0-9]([A-Za-z0-9 _-]*[A-Za-z0-9_-])?$/;
const RANK = { blocked: 4, working: 3, done: 2, idle: 1, unknown: 0 };

// What one terminal tab is doing: its pane that matters most (needs you, then working), as on the
// Agents page. Null when no AI is running in it.
function tabState(panes) {
  const top = panes.filter((pane) => pane.agent).sort((a, b) => (RANK[b.status] || 0) - (RANK[a.status] || 0))[0];
  if (!top) return null;
  return { status: top.status === 'unknown' ? 'idle' : top.status, agent: top.agent, title: top.title || '', pane: top.pane || '' };
}

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const flat = (text) => herdr.plain(String(text || ''), 400);
const RULE = /^\s*[╭╰├]?[─━]{8,}/;
const OPTION = /^\s*([❯›>])?\s*(\d)[.)]\s+(.*)$/;

// A multiple-choice menu at the bottom of the screen (Claude's question with numbered options and a
// ❯ on the one picked). Gives { choices, picked, recommended, multi, fingerprint }, or {} when there
// isn't one. recommended = the numbers of the options marked "(Recommended)". multi = several
// questions (tabs) or tick boxes, which are never answered for you.
function readChoices(lines) {
  const tail = lines.slice(-40);
  let first = -1;
  tail.forEach((line, i) => { if (/^\s*[❯›>]?\s*1[.)]\s/.test(line)) first = i; });
  if (first < 0) return {};
  const choices = [];
  for (let i = first; i < tail.length; i += 1) {
    const match = tail[i].match(OPTION);
    if (match && Number(match[2]) === choices.length + 1) choices.push({ picked: match[1] === '❯', number: Number(match[2]), text: cut(flat(match[3]), 160) });
  }
  // Only the live menu counts: Claude's footer comes right after the options (past messages you
  // typed, shown with "> ", have none).
  const last = tail.findIndex((line, i) => i > first && /Enter to select|Esc to cancel|to navigate/.test(line));
  if (last < 0) return {};
  const lastOption = Math.max(...choices.map((choice) => tail.findIndex((line, i) => i >= first && OPTION.test(line) && Number(line.match(OPTION)[2]) === choice.number)));
  if (tail.slice(lastOption + 1, last).some((line) => /\S/.test(line) && !/^\s{3,}\S/.test(line) && !RULE.test(line))) return {};
  const picked = choices.find((choice) => choice.picked);
  if (choices.length < 2 || !picked) return {};
  const above = tail.slice(0, first);
  const question = [...above].reverse().find((line) => /\S.{2,}\?$/.test(line.trim())) || '';
  const multi = above.some((line) => /[☐☒✔☑].*[☐☒✔☑]|Submit/.test(line)) || choices.some((choice) => /^(\[[ xX✔]\]|[☐☒☑])/.test(choice.text));
  return {
    choices,
    picked: picked.number,
    recommended: choices.filter((choice) => choice.text.includes('(Recommended)')).map((choice) => choice.number),
    multi,
    fingerprint: crypto.createHash('sha256').update([question.trim(), ...choices.map((choice) => `${choice.number}. ${choice.text}`)].join('\n')).digest('hex'),
  };
}

// Claude's permission question on a pane's screen, if it's showing one:
//   Bash command
//     npm install left-pad
//   Do you want to proceed?
//   ❯ 1. Yes
//     2. Yes, and don't ask again for ...
//     3. No, and tell Claude what to do differently (esc)
// Gives { question, heading, detail, canAnswer, yesPicked, fingerprint }. fingerprint stands for the
// whole question, so an answer can't land on a different one that has taken its place.
function readPrompt(screen) {
  const lines = String(screen || '').split('\n').slice(-120)
    .map((line) => line.replace(/^\s*│\s?/, '').replace(/\s?│\s*$/, '').replace(/\s+$/, ''));
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i -= 1) {
    if (/^\s*Do you want to .{1,300}\?$/.test(lines[i])) at = i;
  }
  if (at < 0) {
    // Some other question, such as one with choices to pick from: its last line asking something.
    const asked = lines.slice(-30).reverse().find((line) => /\S.{2,}\?$/.test(line.trim()) && !OPTION.test(line));
    return { question: asked ? cut(flat(asked), 160) : '', canAnswer: false, ...readChoices(lines) };
  }
  const options = [];
  for (let i = at + 1; i < lines.length && i <= at + 12; i += 1) {
    const match = lines[i].match(OPTION);
    if (match) options.push({ picked: match[1] === '❯', number: Number(match[2]), text: match[3].trim(), line: i });
    else if (options.length && /^\s*\S/.test(lines[i]) && !/^\s{3,}\S/.test(lines[i])) break; // past the list
  }
  const question = cut(flat(lines[at]), 160);
  const yes = options.find((option) => option.number === 1 && /^Yes\b/.test(option.text));
  const no = options.find((option) => /^No\b/.test(option.text));
  if (!yes || !no) return { question, canAnswer: false };
  // Only the live question counts: below it, nothing but its own lines, a rule or Claude's footer.
  // Text left in the scrollback above the input box has more under it.
  const below = lines.slice(Math.max(...options.map((option) => option.line)) + 1);
  if (below.some((line) => /\S/.test(line) && !/^\s{3,}\S/.test(line) && !RULE.test(line) && !/Esc to cancel/.test(line))) return { question, canAnswer: false };
  // What it's asking about: everything from the rule line above the question.
  let start = at;
  while (start > 0 && at - start < 40 && !RULE.test(lines[start - 1])) start -= 1;
  const raw = lines.slice(start, at);
  const about = raw.map((line) => flat(line)).filter((line) => line && !/^Tip:/.test(line));
  // Newer Claude draws the command between two dashed rules: that is the detail.
  const dashed = raw.map((line, i) => (/^\s*╌{4,}/.test(line) ? i : -1)).filter((i) => i >= 0);
  const command = dashed.length >= 2 ? flat(raw.slice(dashed[0] + 1, dashed[1]).join(' ')) : '';
  const end = Math.max(...options.map((option) => option.line));
  const block = lines.slice(start, end + 1).map((line) => {
    const match = line.match(OPTION);
    return match ? `${match[2]}. ${match[3].trim()}` : line.replace(/\s+/g, ' ').trim();
  }).join('\n');
  return {
    question,
    heading: cut(about[0] || '', 80),
    detail: cut(command || about[1] || '', 160),
    canAnswer: true,
    yesPicked: yes.picked,
    fingerprint: crypto.createHash('sha256').update(block).digest('hex'),
  };
}

// The notification's words.
function words(kind, item, prompt) {
  const where = item.tab === 'tab-1' ? item.room : `${item.room} (terminal ${item.tab.slice(4)})`;
  if (kind === 'done') return { title: `${where} is done`, body: cut(item.title || 'The AI has finished.', 160) };
  if (prompt?.canAnswer) {
    const about = [prompt.heading, prompt.detail].filter(Boolean).join(': ');
    return { title: `${where} needs you`, body: cut(about ? `${about}\n${prompt.question}` : prompt.question, 300) };
  }
  return { title: `${where} needs you`, body: cut(prompt?.question || item.title || 'The AI is waiting for you.', 200) };
}

// The watcher. listRooms gives the open rooms ([{ name }]), or null when Docker isn't answering.
// Calls:
//   statuses(map)        tab colors, "room<TAB>tab-N" -> working | blocked | done | idle, on change
//   notify(note)         { tag, id, room, tab, title, body, buttons: ['approve', 'deny', 'open'] or ['open'] }
//   unnotify(tag)        that tab's notification is out of date
//   looking(room, tab)   true (or a promise of it) when you're looking at that terminal now, so no
//                        notification
// Gives { start, stop, answer(id, action), seen(room, tab) }. answer returns what happened:
// 'opened', 'approved', 'denied', 'changed' (the question was gone, so the tab was opened instead)
// or 'unknown'.
// autoApprove(room) says whether that room answers by itself, and log(line) hears each time it does.
function create({ listRooms, statuses, notify, unnotify, looking = () => false, openTab, every = EVERY, read = herdr, autoApprove = () => false, log = () => {}, pause = 150 }) {
  const known = new Map(); // "room<TAB>tab-N" -> what that tab is doing
  const notes = new Map(); // notification id -> what it was about
  let timer = null;
  let busy = false;
  let lastStatuses = '';
  const tagOf = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

  const forget = (key) => {
    for (const [id, note] of notes) if (note.key === key) notes.delete(id);
    unnotify(tagOf(key));
  };

  // With Auto-approve on for the room: Yes for a permission question, or the one option marked
  // "(Recommended)" for a multiple-choice one. Anything less clear is left to you. True when answered.
  async function autoAnswer(item, prompt) {
    if (!prompt?.fingerprint || !autoApprove(item.room)) return false;
    const look = async () => readPrompt(await read.screenOf(item.room, item.tab, item.pane).catch(() => ''));
    const press = (key) => read.pressKey(item.room, item.tab, item.pane, key).catch(() => false);
    const where = `${item.room}/${item.tab}`;
    // The same question answered twice already and back again: something's wrong, so you decide.
    const own = known.get(`${item.room}	${item.tab}`);
    if (own?.auto?.fp === prompt.fingerprint && own.auto.n >= 2 && Date.now() - own.auto.at < REPEAT * 3) return false;
    const done = () => {
      const again = own?.auto?.fp === prompt.fingerprint && Date.now() - own.auto.at < REPEAT * 3;
      if (own) own.auto = { fp: prompt.fingerprint, n: again ? own.auto.n + 1 : 1, at: Date.now() };
      return true;
    };
    if (prompt.canAnswer) {
      const now = await look(); // still the same question, with Yes picked?
      if (!now.canAnswer || now.fingerprint !== prompt.fingerprint || !now.yesPicked || !await press('enter')) return false;
      log(`Auto-approved ${where}: ${prompt.question}`);
      return done();
    }
    if (prompt.multi || prompt.recommended?.length !== 1) return false;
    const target = prompt.recommended[0];
    for (let step = 0; step < 12; step += 1) { // move the arrow there, checking the screen each time
      const now = await look();
      if (now.fingerprint !== prompt.fingerprint || now.multi) return false;
      if (now.picked === target) {
        if (!await press('enter')) return false;
        log(`Auto-picked option ${target} in ${where}: ${prompt.question}`);
        return done();
      }
      if (!await press(now.picked < target ? 'down' : 'up')) return false;
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
    return false;
  }

  async function alert(kind, key, item) {
    let prompt = item.prompt || null;
    if (kind === 'needs' && !prompt) prompt = readPrompt(await read.screenOf(item.room, item.tab, item.pane).catch(() => ''));
    // Answered for you, even while you're looking at that terminal.
    if (kind === 'needs' && await autoAnswer(item, prompt)) {
      const own = known.get(key);
      if (own) own.answeredAt = Date.now();
      forget(key);
      return;
    }
    if (await looking(item.room, item.tab)) {
      forget(key);
      return;
    }
    // It may have moved on while the screen was read.
    const current = known.get(key);
    if (!current || (kind === 'needs' && current.settled !== 'blocked')) return;
    forget(key);
    const id = crypto.randomBytes(9).toString('hex');
    notes.set(id, { key, room: item.room, tab: item.tab, pane: item.pane, kind, fingerprint: prompt?.canAnswer ? prompt.fingerprint : null });
    notify({ tag: tagOf(key), id, room: item.room, tab: item.tab, ...words(kind, item, prompt), buttons: prompt?.canAnswer ? ['approve', 'deny', 'open'] : ['open'] });
  }

  async function settle(key, item, was) {
    const now = item.settled;
    if (now === 'blocked') await alert('needs', key, { ...item });
    else if (was === 'working' && (now === 'done' || now === 'idle')) await alert('done', key, { ...item });
    else forget(key);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const open = await listRooms().catch(() => null);
      if (!Array.isArray(open)) return; // Docker isn't answering: keep what was known
      const seen = new Map();
      await Promise.all(open.filter((room) => NAME.test(room?.name || '')).map(async ({ name }) => {
        const tabs = await read.roomTabs(name).catch(() => null);
        if (!tabs) {
          // The room didn't answer this time: it keeps what it had.
          for (const [key, item] of known) if (item.room === name) seen.set(key, { ...item });
          return;
        }
        for (const { tab, panes } of tabs) {
          const state = tabState(panes);
          if (!state) continue;
          // Herdr can lag behind the screen, so a tab it calls working or blocked is checked: a
          // question on the screen means it needs you.
          if ((state.status === 'working' || state.status === 'blocked') && state.pane) {
            const screen = await read.screenOf(name, tab, state.pane).catch(() => null);
            if (screen !== null) {
              state.read = true;
              state.prompt = readPrompt(screen);
              if (state.prompt.fingerprint) state.status = 'blocked';
            }
          }
          seen.set(`${name}\t${tab}`, { room: name, tab, ...state });
        }
      }));
      const settling = [];
      for (const [key, now] of seen) {
        const item = known.get(key);
        if (!item) {
          // First sight, as when Station 256 opens: what it's doing already isn't news.
          known.set(key, { ...now, prompt: null, settled: now.status, pending: null, count: 0, alerted: now.prompt?.fingerprint || null, answeredAt: 0 });
          continue;
        }
        Object.assign(item, { status: now.status, agent: now.agent, title: now.title, pane: now.pane || item.pane });
        // A question on the screen is believed straight away. Each new one alerts: a different one,
        // or the same one again once the last was answered.
        const fp = now.prompt?.fingerprint || null;
        if (now.read && !fp) Object.assign(item, { alerted: null, answeredAt: 0 });
        if (fp) {
          const fresh = item.alerted !== fp || (item.answeredAt && Date.now() - item.answeredAt > REPEAT);
          Object.assign(item, { settled: 'blocked', pending: null, count: 0 });
          if (fresh) {
            Object.assign(item, { alerted: fp, answeredAt: 0 });
            settling.push(alert('needs', key, { ...item, prompt: now.prompt }).catch(() => {}));
          }
          continue;
        }
        if (now.status === item.settled) {
          item.pending = null;
          continue;
        }
        item.count = item.pending === now.status ? item.count + 1 : 1;
        item.pending = now.status;
        if (item.count >= 2) {
          const was = item.settled;
          item.settled = now.status;
          item.pending = null;
          settling.push(settle(key, item, was).catch(() => {}));
        }
      }
      for (const key of [...known.keys()]) {
        if (!seen.has(key)) {
          known.delete(key);
          forget(key);
        }
      }
      const map = Object.fromEntries([...known].map(([key, item]) => [key, item.status]));
      const text = JSON.stringify(map);
      if (text !== lastStatuses) {
        lastStatuses = text;
        statuses(map);
      }
      await Promise.all(settling);
    } finally {
      busy = false;
    }
  }

  // A click on a notification, or one of its buttons.
  async function answer(id, action) {
    const note = notes.get(id);
    if (!note) return 'unknown';
    notes.delete(id);
    if (action === 'approve' || action === 'deny') {
      const prompt = note.fingerprint ? readPrompt(await read.screenOf(note.room, note.tab, note.pane).catch(() => '')) : null;
      const same = prompt?.canAnswer && prompt.fingerprint === note.fingerprint && (action === 'deny' || prompt.yesPicked);
      if (same && await read.pressKey(note.room, note.tab, note.pane, action === 'approve' ? 'enter' : 'esc').catch(() => false)) {
        const item = known.get(note.key);
        if (item) item.answeredAt = Date.now(); // the next question counts as new
        return action === 'approve' ? 'approved' : 'denied';
      }
      await openTab(note.room, note.tab);
      return 'changed';
    }
    await openTab(note.room, note.tab);
    return 'opened';
  }

  // Every few seconds while an AI is working or changing; four times slower while all of them rest,
  // since each look runs programs in every room. Typing in a room terminal (poke) speeds it up again.
  let run = 0;
  let loop = null;
  let quickUntil = 0;
  const busyNow = () => Date.now() < quickUntil || [...known.values()].some((item) => item.pending || item.status === 'working');
  const wait = () => (busyNow() ? every : every * 4);

  return {
    start() {
      const mine = ++run;
      clearTimeout(timer);
      loop = async () => {
        await tick().catch(() => {});
        if (mine !== run) return;
        clearTimeout(timer); // a poke may have set one meanwhile: only one wait at a time
        timer = setTimeout(loop, wait());
      };
      loop();
    },
    stop() {
      run += 1;
      loop = null;
      clearTimeout(timer);
      timer = null;
    },
    poke() {
      const slow = !busyNow();
      quickUntil = Date.now() + 60000;
      if (slow && loop) {
        clearTimeout(timer);
        timer = setTimeout(loop, every);
      }
    },
    busyNow,
    tick,
    answer,
    // You've just looked at that terminal, so its notification has done its job.
    seen(room, tab) {
      const key = `${room}\t${tab}`;
      if ([...notes.values()].some((note) => note.key === key)) forget(key);
    },
  };
}

module.exports = { create, readPrompt, tabState, words };
