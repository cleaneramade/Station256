// What the AI agents are doing, for the Agents page. Each room terminal tab is its own Herdr
// session inside its room (see room/herdr-tabs.toml), and Herdr reads each agent's state off its
// screen: working, blocked (it needs you), done, idle. The house's own Herdr, when it's running
// (Open Herdr), is asked over its socket. Nothing here ever starts a Herdr: a house Herdr server
// left running counts as a background job, which keeps the house awake (house-keeper.sh).
//
// Everything that comes back was made inside a room, so it's untrusted: only the fields picked
// out here are kept, as plain text with control characters taken out, and long text is cut.
const fs = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, 'projects');
const HOUSE_SOCKET = path.join(HOME, '.config', 'herdr', 'herdr.sock');
const NAME = /^[A-Za-z0-9]([A-Za-z0-9 _-]*[A-Za-z0-9_-])?$/;
const TAB = /^tab-\d{1,4}$/;
const STATES = ['working', 'blocked', 'done', 'idle', 'unknown'];
const TIMEOUT = 4000; // the most any one question may take
const EVERY = 3000; // how often the page is brought up to date while it's showing

// One trip into a room asks every tab session for its snapshot: one line each, the tab's name, a
// tab character, then Herdr's answer. A session that has stopped just gives an empty answer.
const ROOM_SCRIPT = [
  'cd /home/dev/.config/station-tabs/herdr/sessions 2>/dev/null || exit 0',
  'for s in tab-*; do',
  '  [ -S "$s/herdr.sock" ] || continue',
  '  printf "%s\\t" "$s"',
  '  XDG_CONFIG_HOME=/home/dev/.config/station-tabs timeout 3 /home/dev/.local/bin/herdr --session "$s" api snapshot 2>/dev/null | head -c 500000 | tr -d "\\n"',
  '  echo',
  'done',
].join('\n');

// Terminal codes come out whole first (colors, cursor moves, window titles), so none of their
// letters are left behind, then any other control character.
const plain = (value, max = 80) => (typeof value === 'string'
  ? value
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, ' ')
    .replace(/(\u001b\[|\u009b)[0-9:;<=>?]*[ -\/]*[@-~]/g, '')
    .replace(/\u001b[ -\/]*[0-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
  : '');

// Herdr's snapshot, down to what the page shows of each pane.
function panesOf(raw) {
  let snapshot;
  try {
    snapshot = JSON.parse(raw)?.result?.snapshot;
  } catch {
    return null;
  }
  if (!snapshot || !Array.isArray(snapshot.panes)) return null;
  return snapshot.panes.slice(0, 24).map((pane) => ({
    agent: /^[A-Za-z0-9_-]{1,24}$/.test(pane?.agent || '') ? pane.agent.toLowerCase() : '',
    status: STATES.includes(pane?.agent_status) ? pane.agent_status : 'unknown',
    title: plain(pane?.title) || plain(pane?.terminal_title_stripped),
    // The folder the terminal is in now. Herdr's "cwd" stays where the terminal started, and
    // "foreground_cwd" follows each cd. Only ever compared, never shown or used as a path.
    cwd: folderOf(pane?.foreground_cwd) || folderOf(pane?.cwd),
    // Herdr's name for the pane, such as "w1:p1", for reading its screen or pressing a key in it.
    pane: PANE.test(pane?.pane_id || '') ? pane.pane_id : '',
  }));
}

const PANE = /^[A-Za-z0-9_-]{1,16}:[A-Za-z0-9_-]{1,16}$/;
const HERDR = '/home/dev/.local/bin/herdr';
const roomName = (name) => `room-${name.replaceAll(' ', '.')}`;
// Herdr inside a room, for one terminal tab's session.
const inTab = (name, tab, args) => ['exec', '-e', 'XDG_CONFIG_HOME=/home/dev/.config/station-tabs', roomName(name), HERDR, '--session', tab, ...args];

// What one pane shows on screen right now, as plain text. Made inside a room, so untrusted: only
// ever read for a few known words, and cut before it's shown anywhere.
async function screenOf(name, tab, pane) {
  if (!NAME.test(name || '') || !TAB.test(tab || '') || !PANE.test(pane || '')) return '';
  const out = await run('docker', inTab(name, tab, ['pane', 'read', pane, '--source', 'visible', '--format', 'text']));
  return out.slice(-20000);
}

// Presses one key in a pane: only Enter or Esc, the two a notification can answer with.
async function pressKey(name, tab, pane, key) {
  if (!NAME.test(name || '') || !TAB.test(tab || '') || !PANE.test(pane || '') || !['enter', 'esc'].includes(key)) return false;
  await run('docker', inTab(name, tab, ['pane', 'send-keys', pane, key]));
  return true;
}

const folderOf = (value) => (typeof value === 'string' && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value) ? value : '');

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: TIMEOUT, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

// Every terminal tab still running in one room, in order, with its panes. The AI alerts and the
// Agents page both ask every few seconds, so one trip into the room is shared for a moment.
const recentTabs = new Map(); // room name -> { at, asked }
function roomTabs(name) {
  if (!NAME.test(name || '')) return Promise.reject(new Error('Not a valid project name.'));
  const recent = recentTabs.get(name);
  if (recent && Date.now() - recent.at < 1500) return recent.asked;
  const asked = readRoomTabs(name);
  recentTabs.set(name, { at: Date.now(), asked });
  asked.catch(() => recentTabs.delete(name)); // a failure is never kept
  return asked;
}

async function readRoomTabs(name) {
  const out = await run('docker', ['exec', roomName(name), 'sh', '-c', ROOM_SCRIPT]);
  const tabs = [];
  for (const line of out.split('\n').slice(0, 200)) {
    const cut = line.indexOf('\t');
    const tab = cut > 0 ? line.slice(0, cut) : '';
    if (!TAB.test(tab)) continue;
    const panes = panesOf(line.slice(cut + 1));
    if (panes) tabs.push({ tab, panes });
  }
  return tabs.sort((a, b) => Number(a.tab.slice(4)) - Number(b.tab.slice(4)));
}

// The room's terminals with an AI running in them (Claude, Codex, Gemini and the like), by tab
// name, so Enter Room can go back to the AI first. Empty when the room isn't open or doesn't answer.
async function agentTabs(name) {
  if (!NAME.test(name || '')) return [];
  const tabs = await roomTabs(name).catch(() => []);
  return tabs.filter((tab) => tab.panes.some((pane) => pane.agent)).map((tab) => tab.tab);
}

// The room terminal whose shell is in a folder of the project ("src", "src/my notes"), if there is
// one, so Enter Room on that folder goes back to it instead of opening another. Null when none is.
async function tabAt(name, folder) {
  if (!NAME.test(name) || typeof folder !== 'string' || !folder || folder.length > 1024) return null;
  const want = `/workspace/${folder.replace(/^\/+|\/+$/g, '')}`;
  const tabs = await roomTabs(name).catch(() => []);
  const found = tabs.find((tab) => tab.panes.length === 1 && tab.panes[0].cwd.replace(/\/+$/, '') === want);
  return found ? found.tab : null;
}

// The house's own Herdr, if it's running: one question on its socket, one line back.
function houseAgents() {
  return new Promise((resolve) => {
    let buffer = '';
    const socket = net.createConnection(HOUSE_SOCKET);
    let timer = null;
    const done = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    timer = setTimeout(() => done(null), TIMEOUT);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'station-agents', method: 'session.snapshot', params: {} })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end >= 0) done(panesOf(buffer.slice(0, end)));
      else if (buffer.length > 4000000) done(null);
    });
    socket.on('error', () => done(null));
  });
}

async function projectNames() {
  const entries = await fs.readdir(PROJECTS, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// Every project, open or asleep, and what each open room's tabs are doing. openRooms is the list
// of open rooms, or null when Docker isn't answering.
async function look(openRooms) {
  const [names, house] = await Promise.all([projectNames(), houseAgents()]);
  const open = new Set((openRooms || []).map((room) => room.name));
  const rooms = await Promise.all(names.map(async (name) => {
    if (!open.has(name)) return { name, open: false, tabs: [] };
    try {
      return { name, open: true, tabs: await roomTabs(name) };
    } catch {
      return { name, open: true, tabs: [], unavailable: true };
    }
  }));
  return { time: Date.now(), dockerOk: openRooms !== null, house, rooms };
}

// Looks every few seconds while the page is showing, and never twice at once. send gets each
// answer, with the house's own terminals from houseTerms as "terms". Returns a switch: on while the
// page shows, off when it doesn't.
function watcher(listRooms, send, houseTerms = null) {
  let timer = null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const found = await look(await listRooms().catch(() => null));
      found.terms = houseTerms ? await houseTerms().catch(() => []) : [];
      send(found);
    } catch {
      // The next look tries again.
    } finally {
      busy = false;
    }
  };
  return (on) => {
    clearInterval(timer);
    timer = null;
    if (!on) return;
    tick();
    timer = setInterval(tick, EVERY);
  };
}

module.exports = { look, watcher, tabAt, agentTabs, roomTabs, screenOf, pressKey, panesOf, plain, ROOM_SCRIPT };
