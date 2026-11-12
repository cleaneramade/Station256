// Terminal sessions live here, not in a window, so a tab can move between windows and keep running.
// A room terminal is a Herdr session in its room. Closing its tab or window only closes the line to
// it: it keeps running, and Enter Room goes back into it, the way Herdr is meant to work.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const pty = require('node-pty');
const herdr = require('./herdr');

const ROOM = path.join(os.homedir(), '.local', 'bin', 'room');
// Room terminals whose tab was closed, oldest first, as "project<tab>tab-N". Kept on disk so they
// don't pop back up as tabs the next time Station 256 opens; Enter Room picks them up instead.
const PARKED_FILE = path.join(os.homedir(), '.local', 'state', 'house', 'parked-tabs.json');
const KEEP_BYTES = 400 * 1024;
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9_-])?$/;
const TAB = /^tab-([0-9]{1,4})$/;
// What the room script ends with when only the connection ended and the terminal is still
// running in the room. See tab_connect in bin/room.
const STILL_RUNNING = 4;
const sessions = new Map();
let nextId = 1;
// Set while Station 256 quits: room terminals are only let go then, never ended.
let leaving = false;
let restored = false;

function send(session, channel, payload) {
  if (session.owner && !session.owner.isDestroyed()) session.owner.send(channel, payload);
}

function room(args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(ROOM, args, { timeout }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

// Each room terminal tab is its own Herdr session in the room, named tab-1, tab-2 and so on, so
// whatever runs in it keeps going when the connection closes. The first is "Room: X", then "(2)".
const tabNumber = (tab) => Number(TAB.exec(tab)?.[1] || 0);
const tabTitle = (name, tab) => (tabNumber(tab) > 1 ? `Room: ${name} (${tabNumber(tab)})` : `Room: ${name}`);

const parkKey = (name, tab) => `${name}\t${tab}`;
const isParkKey = (key) => typeof key === 'string' && NAME.test(key.split('\t')[0] || '') && TAB.test(key.split('\t')[1] || '') && key.split('\t').length === 2;

function readParked() {
  try {
    const list = JSON.parse(fs.readFileSync(PARKED_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter(isParkKey).slice(-200) : [];
  } catch {
    return [];
  }
}
let parked = readParked();

function saveParked() {
  try {
    fs.mkdirSync(path.dirname(PARKED_FILE), { recursive: true });
    fs.writeFileSync(PARKED_FILE, `${JSON.stringify(parked)}\n`);
  } catch {
    // Only means a closed tab may come back as a tab next time. It still keeps running.
  }
}

function unpark(name, tab) {
  const key = parkKey(name, tab);
  if (!parked.includes(key)) return;
  parked = parked.filter((other) => other !== key);
  saveParked();
}

function park(name, tab) {
  parked = [...parked.filter((other) => other !== parkKey(name, tab)), parkKey(name, tab)].slice(-200);
  saveParked();
}

// The room's terminals still running, as tab names. Empty if the room isn't open.
const tabsIn = (output, name) => output.split('\n').map((line) => line.split('\t')).filter(([room, tab]) => room === name && TAB.test(tab || '')).map(([, tab]) => tab);

async function runningTabs(name) {
  return tabsIn(await room(['tabs', name], 15000).catch(() => ''), name);
}

// Close Room on one room terminal: how many others its room still has, shown or not, or being
// opened. Null when the room can't be asked, so only that one terminal ends, never more.
async function othersRunning(name, tab) {
  if (!NAME.test(name || '') || !TAB.test(tab || '')) return null;
  let output;
  try {
    output = await room(['tabs', name], 15000);
  } catch {
    return null;
  }
  const others = new Set(tabsIn(output, name));
  for (const other of sessions.values()) if (other.room === name && other.tab && !other.closing) others.add(other.tab);
  reserved.forEach((key) => { if (key.split('\t')[0] === name) others.add(key.split('\t')[1]); });
  others.delete(tab);
  return others.size;
}

// Ends a room terminal that no tab is joined to any more, as when its line was lost.
async function stopTab(name, tab) {
  if (!NAME.test(name || '') || !TAB.test(tab || '')) return false;
  unpark(name, tab);
  return room(['tab-stop', name, tab]).then(() => true, () => false);
}

// A terminal still running in the room that no tab or window shows. One with an AI in it (Claude,
// Codex, Gemini) comes first, then the one whose tab was closed last, then the lowest number. Null
// when there's none, so Enter Room starts a new one.
async function resumable(name) {
  if (!NAME.test(name || '')) return null;
  const running = await runningTabs(name);
  const agents = new Set(running.length > 1 ? await herdr.agentTabs(name) : []);
  // Worked out after asking the room, so one that came back meanwhile counts as shown.
  const shown = new Set([...sessions.values()].filter((session) => session.room === name && !session.closing).map((session) => session.tab));
  const free = running.filter((tab) => !shown.has(tab));
  if (!free.length) return null;
  const closedAt = (tab) => parked.lastIndexOf(parkKey(name, tab));
  free.sort((a, b) => (agents.has(b) - agents.has(a)) || (closedAt(b) - closedAt(a)) || (tabNumber(a) - tabNumber(b)));
  return free[0];
}

// A folder inside a project, written from its top ("src", "src/my notes"), for a new room terminal
// to start in. Anything else means the top of the project. The room script checks it again.
function roomFolder(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return '';
  const folder = path.posix.normalize(value).replace(/^\/+|\/+$/g, '');
  return folder && folder !== '.' && !folder.split('/').includes('..') ? folder : '';
}

// Numbers handed out but not started yet, so two New Room clicks at once get two numbers.
const reserved = new Set();

async function freeTab(name) {
  // One still running in the room but not shown here is left for Enter Room to go back into.
  const running = await room(['tabs', name], 15000).catch(() => '');
  const taken = new Set([...sessions.values()].filter((session) => session.room === name).map((session) => tabNumber(session.tab)));
  running.split('\n').forEach((line) => taken.add(tabNumber(line.split('\t')[1] || '')));
  reserved.forEach((key) => { if (key.split('\t')[0] === name) taken.add(tabNumber(key.split('\t')[1])); });
  let number = 1;
  while (taken.has(number)) number += 1;
  reserved.add(parkKey(name, `tab-${number}`));
  return `tab-${number}`;
}

function spawn(session, command, args, cwd) {
  const shell = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: session.cols,
    rows: session.rows,
    cwd,
    env: process.env,
  });
  session.shell = shell;
  session.connectedAt = Date.now();
  shell.onData((data) => {
    if (session.shell !== shell) return;
    session.buffer = (session.buffer + data).slice(-KEEP_BYTES);
    send(session, 'term:data', { id: session.id, data });
  });
  shell.onExit(({ exitCode }) => {
    if (session.shell !== shell) return;
    if (exitCode === STILL_RUNNING && session.tab && !session.closing && !leaving) {
      reconnect(session);
      return;
    }
    // Ended on purpose from elsewhere (see end): its tab goes, in whichever window shows it.
    send(session, 'term:exit', { id: session.id, exitCode: session.dismissed ? 0 : exitCode });
    sessions.delete(session.id);
  });
}

// The line to a room terminal dropped, but the terminal is still running in the room. This joins
// it again, and Herdr puts its screen back. Gives up after a few quick failures in a row.
function reconnect(session) {
  session.retries = Date.now() - session.connectedAt > 15000 ? 1 : (session.retries || 0) + 1;
  if (session.retries > 3) {
    // Still running, but nothing can reach it from here now: it waits for Enter Room.
    park(session.room, session.tab);
    send(session, 'term:exit', { id: session.id, exitCode: STILL_RUNNING });
    sessions.delete(session.id);
    return;
  }
  setTimeout(() => {
    if (sessions.get(session.id) !== session) return;
    // Closed in the meantime: there's no line left to close, so it's simply let go.
    if (session.closing || leaving) sessions.delete(session.id);
    else spawn(session, ROOM, ['attach', session.room, session.tab], os.homedir());
  }, 500 * session.retries);
}

async function create(options, owner) {
  let command;
  let args;
  let title;
  let tab = null;
  let cwd = os.homedir();
  if (options.room) {
    if (!NAME.test(options.room)) throw new Error('Not a valid project name.');
    if (options.tab && !TAB.test(options.tab)) throw new Error('Not a valid terminal name.');
    // Already shown, in a tab or a window: that one is used, never a second line to it.
    const shown = options.tab && [...sessions.values()].find((session) => session.room === options.room && session.tab === options.tab && !session.closing);
    if (shown) return { id: shown.id, title: shown.title, room: shown.room, tab: shown.tab, existing: true };
    tab = options.tab || await freeTab(options.room);
    unpark(options.room, tab); // shown again, so it's no longer waiting
    command = ROOM;
    // Bringing one back only needs connecting. A new one may need its room started first, and
    // starts in the folder it was opened from.
    const folder = options.tab ? '' : roomFolder(options.cwd);
    args = options.tab ? ['attach', options.room, tab] : ['open', options.room, '--tab', tab, ...(folder ? ['--cd', folder] : [])];
    title = tabTitle(options.room, tab);
  } else if (options.herdr) {
    // Herdr holds every room's agents in one sidebar. It runs in the house and
    // reaches each room over ssh, so no agent ever runs out here. The room
    // script lists every project first, open or asleep, then starts Herdr.
    command = ROOM;
    args = ['agents'];
    title = 'Agents';
  } else {
    command = '/bin/bash';
    args = ['-l'];
    title = 'Linux House';
    cwd = options.cwd || cwd;
  }

  const id = nextId;
  nextId += 1;
  const session = {
    id, title, room: options.room || null, tab, owner, buffer: '', cols: options.cols || 100, rows: options.rows || 30,
    house: !options.room && !options.herdr, // a plain house terminal, not Agents
  };
  sessions.set(id, session);
  if (tab) reserved.delete(parkKey(options.room, tab)); // it's a session now
  spawn(session, command, args, cwd);
  return { id, title, room: session.room, tab };
}

// Which running room terminals come back as tabs when Station 256 opens: all but the ones whose
// tab was closed, which wait for Enter Room. Also returns the waiting list, without the ones that
// ended. A room that listed nothing may just not have answered, so its ones are kept; an old one
// left there is harmless, as starting that terminal again takes it off the list.
function toRestore(found, waiting) {
  const running = new Set(found.map(([name, tab]) => parkKey(name, tab)));
  const answered = new Set(found.map(([name]) => name));
  const stillWaiting = waiting.filter((key) => running.has(key) || !answered.has(key.split('\t')[0]));
  return { tabs: found.filter(([name, tab]) => !stillWaiting.includes(parkKey(name, tab))), waiting: stillWaiting };
}

// Room terminals still running from before Station 256 last closed, joined again as tabs, in order.
// Only once per page: after that, every one still running already has its tab, or is waiting for
// Enter Room. A page that crashed and came back gets them again (see letGo).
async function restore(owner) {
  if (restored) return [];
  restored = true;
  const output = await room(['tabs'], 60000).catch(() => null);
  if (output === null) return [];
  const all = output.split('\n').map((line) => line.split('\t')).filter(([name, tab]) => NAME.test(name || '') && TAB.test(tab || ''));
  const { tabs: found, waiting } = toRestore(all, parked);
  if (waiting.length !== parked.length) {
    parked = waiting;
    saveParked();
  }
  found.sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }) || tabNumber(a[1]) - tabNumber(b[1]));
  const made = [];
  for (const [name, tab] of found) {
    const session = await create({ room: name, tab }, owner);
    if (!session.existing) made.push(session); // one Enter Room already brought back is left be
  }
  return made;
}

// The page showing these terminals crashed. Room terminals are let go, still running, so the page
// gets them back as tabs when it starts again. Others can't be shown again, so they end.
function letGo(owner) {
  for (const session of [...sessions.values()]) {
    if (session.owner !== owner) continue;
    if (!session.tab) {
      kill(session.id);
      continue;
    }
    session.closing = true;
    session.shell.kill();
  }
  restored = false;
}

function attach(id, owner) {
  const session = sessions.get(id);
  if (!session) throw new Error('This terminal has ended.');
  session.owner = owner;
  return { title: session.title, room: session.room, tab: session.tab, buffer: session.buffer };
}

function write(id, data) {
  const session = sessions.get(id);
  if (session) session.shell.write(data);
}

function resize(id, cols, rows) {
  const session = sessions.get(id);
  if (session && cols > 0 && rows > 0) {
    Object.assign(session, { cols, rows });
    session.shell.resize(cols, rows);
  }
}

// Closing a tab or a terminal's window. A room terminal keeps running in its room: only the line to
// it closes, and Enter Room goes back into it. Any other terminal ends.
function close(id) {
  const session = sessions.get(id);
  // While Station 256 quits, its windows close too. Those terminals come back as tabs next time.
  if (!session || leaving) return;
  if (!session.tab) {
    kill(id);
    return;
  }
  session.closing = true; // so the line isn't joined again
  park(session.room, session.tab);
  session.shell.kill();
}

// Ends a terminal for real. For a room terminal that also ends it in the room.
function kill(id) {
  const session = sessions.get(id);
  if (!session) return;
  if (session.tab && !leaving) {
    session.closing = true;
    room(['tab-stop', session.room, session.tab]).catch(() => {});
  }
  session.shell.kill();
}

// Close Room on one room terminal, from wherever it's asked (a tab, the Agents page, a Home card):
// it ends, in its room and in whichever window shows it.
async function endRoomTab(name, tab) {
  if (!NAME.test(name || '') || !TAB.test(tab || '')) return false;
  const shown = [...sessions.values()].find((session) => session.room === name && session.tab === tab && !session.closing);
  if (!shown) return stopTab(name, tab);
  unpark(name, tab);
  end(shown.id);
  return true;
}

// The house's own terminals (Linux House tabs) still open, oldest first, for the Agents page.
const houseList = () => [...sessions.values()]
  .filter((session) => session.house && session.shell && !session.closing && !session.dismissed)
  .sort((a, b) => a.id - b.id)
  .map((session) => ({ id: session.id, shellPid: session.shell.pid }));
// The page showing a terminal, or null.
const ownerOf = (id) => sessions.get(id)?.owner || null;

// Ends a terminal on purpose from somewhere other than its own tab (Close Room on a room, Close
// on the Agents page or a Home card), so its tab goes too, in whichever window shows it.
function end(id) {
  const session = sessions.get(id);
  if (!session) return;
  session.dismissed = true;
  kill(id);
}

// Station 256 is closing. Room terminals keep running in their rooms and come back next time.
function killAll() {
  leaving = true;
  for (const session of sessions.values()) session.shell.kill();
}

function buffer(id) {
  const session = sessions.get(id);
  return session ? session.buffer : '';
}

// The terminals that closing Station 256 would end. Room terminals keep running.
const count = () => [...sessions.values()].filter((session) => !session.tab).length;
const roomOf = (id) => sessions.get(id)?.room || null;
const tabOf = (id) => sessions.get(id)?.tab || null;
const has = (id) => sessions.has(id);

// Where to find the AI chat in a terminal (lib/chat-save.js): a room terminal by its room and tab,
// a house terminal by its shell. Agents has none of its own.
function chatPlace(id) {
  const session = sessions.get(id);
  if (!session) return null;
  if (session.tab) return { room: session.room, tab: session.tab };
  return session.house && session.shell ? { shellPid: session.shell.pid } : null;
}

// The room's terminal (only the one named, if tab is given) that this page shows. Null for none.
function shownBy(owner, name, tab = null) {
  for (const session of sessions.values()) {
    if (session.owner === owner && session.room === name && (!tab || session.tab === tab) && !session.closing) return session.id;
  }
  return null;
}

// A window closed: its terminals close with it, as its tabs would. Room terminals keep running.
function closeOwnedBy(owner) {
  for (const session of [...sessions.values()]) if (session.owner === owner) close(session.id);
}

// Whether closing this terminal would stop something. A plain idle shell wouldn't. A room terminal
// never would: it keeps running in its room (see close).
function busy(id) {
  const session = sessions.get(id);
  if (!session || session.tab) return false;
  return !['bash', 'sh', 'dash'].includes(path.basename(session.shell.process || 'bash'));
}

module.exports = {
  create, restore, letGo, attach, write, resize, close, closeOwnedBy, kill, killAll, othersRunning, buffer, count, roomOf, tabOf, has, chatPlace, shownBy, busy, resumable, toRestore,
  end, endRoomTab, houseList, ownerOf, stopTab,
};
