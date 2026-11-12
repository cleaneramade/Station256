// The house's own terminals (Linux House tabs) for the Agents page: which AI runs in each one, and
// what it's doing. A room's terminals are Herdr sessions, and Herdr reads that off their screens.
// A house terminal is a plain terminal, so it's read here the same way: the AI from the programs
// running under its shell, and its state from what the window showing it has on screen.
//
// The screen is whatever the AI or any other program printed, so it's only ever checked for a few
// known words, and the title is cut down to plain text before it's shown.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { plain } = require('./herdr');

const HOME = os.homedir();
const AGENTS = ['claude', 'codex', 'gemini', 'opencode'];
// While an AI works, the bottom of its screen says how to stop it: Claude and Codex "esc to
// interrupt", Gemini "esc to cancel".
const WORKING = /\besc to (interrupt|cancel)\b/i;
// When it needs you, it asks: may it run this, make this change, go ahead.
const BLOCKED = [
  /\bdo you want to (proceed|make this edit|make these edits|create|allow|run|overwrite|delete|fetch)\b/i,
  /\bwould you like to (run|make|apply|proceed|allow)\b/i,
  /\ballow (execution|this command|this action)\b/i,
  /\bapply this change\?/i,
  /\byes, (allow|proceed)\b/i,
  /\bwaiting for (your )?(approval|permission|confirmation)\b/i,
];

function parentOf(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[1]) || 0;
  } catch {
    return 0;
  }
}

// Every program running now, by its parent.
function children() {
  const map = new Map();
  let names = [];
  try { names = fs.readdirSync('/proc'); } catch { return map; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const parent = parentOf(name);
    if (!parent) continue;
    if (!map.has(parent)) map.set(parent, []);
    map.get(parent).push(Number(name));
  }
  return map;
}

// The AI a program is, by its name or the script it runs ("node .../bin/codex"). '' for any other.
function agentOf(pid) {
  let args = [];
  try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, 2); } catch { return ''; }
  for (const arg of args) {
    const base = path.basename(arg || '').toLowerCase().replace(/\.(js|mjs|cjs)$/, '');
    if (AGENTS.includes(base)) return base;
  }
  return '';
}

// The first AI found under a shell, with the folder it's working in.
function agentUnder(shellPid, tree) {
  const queue = [...(tree.get(shellPid) || [])];
  for (let seen = 0; queue.length && seen < 400; seen += 1) {
    const pid = queue.shift();
    const agent = agentOf(pid);
    if (agent) return { agent, pid };
    queue.push(...(tree.get(pid) || []));
  }
  return { agent: '', pid: shellPid };
}

// A folder as it's shown: "~/house/panel" inside your home, the full path anywhere else.
function folderOf(pid) {
  let folder = '';
  try { folder = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return ''; }
  if (folder === HOME) return '~';
  return plain(folder.startsWith(`${HOME}/`) ? `~/${folder.slice(HOME.length + 1)}` : folder, 120);
}

function stateOf(screen) {
  if (typeof screen !== 'string' || !screen) return 'idle';
  const bottom = screen.split('\n').slice(-30).join('\n');
  if (BLOCKED.some((pattern) => pattern.test(bottom))) return 'blocked';
  return WORKING.test(bottom) ? 'working' : 'idle';
}

// list: the house terminals, as lib/terminals.js houseList gives them. screenOf(id) asks the window
// showing one what's on its screen: { text, title }, or null.
async function look(list, screenOf) {
  if (!list.length) return [];
  const tree = children();
  return Promise.all(list.map(async ({ id, shellPid }) => {
    const { agent, pid } = agentUnder(shellPid, tree);
    const folder = folderOf(pid);
    if (!agent) return { id, agent: '', status: 'none', title: folder };
    const screen = await screenOf(id).catch(() => null);
    const title = plain(screen?.title || '').replace(/^[^A-Za-z0-9]+/, '');
    return { id, agent, status: stateOf(screen?.text), title: title || folder };
  }));
}

module.exports = { look, stateOf, agentOf };
