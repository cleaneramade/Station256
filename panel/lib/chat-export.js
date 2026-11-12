// house-chat-export: makes a page (Markdown) of the AI chat in one terminal tab. Two kinds:
//   - plain: what you and the AI said, as the terminal shows it, with a short line for the steps
//     it took in between ("Ran 2 commands and changed 1 file (app.js).");
//   - detail: also every step itself: the command, the change to the file, what came back.
//
// It runs as a small program, like token-count.js: inside the room for a room terminal (docker
// exec ... node -e), or in the house for a house terminal, so only the finished page comes back.
//   stdin:  { tab } or { shellPid }, with { detail, room, timeZone, now }
//   stdout: one line of JSON ({ ok: true } or { error }), then the page.
//
// Which chat: Claude Code keeps a note for each chat that's running, ~/.claude/sessions/<pid>.json,
// with the chat's id and folder. The one whose program runs in this terminal is used. A room tab
// is known by its Herdr session (HERDR_SOCKET_PATH, which every program in that tab has), a house
// terminal by the program being started from its shell. The chat itself is ~/.claude/projects/
// <folder>/<id>.jsonl, one line per message or step. What's read from it only ever becomes text on
// the page.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const RESULT_LINES = 300; // what came back from a step, at most, with details
const RESULT_CHARS = 30000;
const SHORT_LINES = 12; // a slash command's answer, without details
const ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;

/* ---------- Which chat ---------- */

function procStat(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return text.slice(text.lastIndexOf(')') + 2).split(' ');
  } catch {
    return null;
  }
}
const parentPid = (pid) => Number(procStat(pid)?.[1]) || 0;
const startedAt = (pid) => procStat(pid)?.[19] || null; // when it started, in clock ticks

function inTab(pid, tab) {
  let env = [];
  try { env = fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0'); } catch { /* gone, or not ours */ }
  const end = `/sessions/${tab}/herdr.sock`;
  return env.some((line) => line.startsWith('HERDR_SOCKET_PATH=') && line.endsWith(end));
}

function underShell(pid, shellPid) {
  let at = pid;
  for (let step = 0; step < 64 && at > 1; step += 1) {
    if (at === shellPid) return true;
    at = parentPid(at);
  }
  return false;
}

// The Claude chats running in this terminal now, the one used last first.
function runningChats(home, here) {
  const dir = path.join(home, '.claude', 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* none */ }
  const found = [];
  for (const name of names) {
    const match = /^(\d{1,9})\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    let note;
    try { note = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (!note || typeof note.sessionId !== 'string' || !ID.test(note.sessionId)) continue;
    // A note can outlive its program, and a new program can get the same number.
    const started = startedAt(pid);
    if (!started || (note.procStart && String(note.procStart) !== started)) continue;
    if (here(pid)) found.push(note);
  }
  return found.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}

function chatFile(home, note) {
  const projects = path.join(home, '.claude', 'projects');
  const name = `${note.sessionId}.jsonl`;
  if (typeof note.cwd === 'string') {
    const guess = path.join(projects, note.cwd.replace(/[^A-Za-z0-9]/g, '-'), name);
    if (fs.existsSync(guess)) return guess;
  }
  let folders = [];
  try { folders = fs.readdirSync(projects); } catch { /* none */ }
  for (const folder of folders) {
    const file = path.join(projects, folder, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Another AI in this terminal, by name, to say why there's nothing to save.
function otherAI(here) {
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number); } catch { /* none */ }
  for (const pid of pids) {
    let command = '';
    try { command = fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').split('\0').slice(0, 3).join(' '); } catch { continue; }
    const name = /(?:^|[/\s])(codex|gemini)(?:\s|$)/i.exec(command);
    if (name && here(pid)) return name[1].toLowerCase() === 'codex' ? 'Codex' : 'Gemini';
  }
  return null;
}

/* ---------- Reading the chat ---------- */

function readEntries(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('{') || !line.includes('"uuid"')) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a line still being written */ }
  }
  return entries;
}

// The chat as it stands: from its last message back to the start. A message you went back and
// changed leaves the old one behind on a side branch, so following the links skips it. Where the
// chat was summarized to make room, the link jumps over the summary (logicalParentUuid).
function thread(entries) {
  const byId = new Map();
  for (const entry of entries) if (entry && typeof entry.uuid === 'string') byId.set(entry.uuid, entry);
  const talk = entries.filter((entry) => entry && ['user', 'assistant', 'system'].includes(entry.type) && !entry.isSidechain && entry.uuid);
  const out = [];
  const seen = new Set();
  let at = talk[talk.length - 1];
  while (at && !seen.has(at.uuid)) {
    seen.add(at.uuid);
    out.push(at);
    at = byId.get(at.parentUuid) || byId.get(at.logicalParentUuid);
  }
  return out.reverse();
}

/* ---------- Writing the page ---------- */

const str = (value) => (typeof value === 'string' ? value : '');
const oneLine = (text, max = 200) => {
  const flat = str(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const strip = (text) => str(text)
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g, '')
  .trim();
const tag = (text, name) => {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return found ? found[1].trim() : null;
};

// A block of text shown as it is. The fence is longer than any run of backticks inside it.
function fence(text, lang = '') {
  const body = str(text).replace(/\s+$/, '');
  const longest = Math.max(2, ...(body.match(/`+/g) || []).map((run) => run.length));
  const mark = '`'.repeat(longest + 1);
  return `${mark}${lang}\n${body}\n${mark}`;
}
function code(text) {
  const flat = oneLine(text, 300);
  const longest = Math.max(0, ...(flat.match(/`+/g) || []).map((run) => run.length));
  const mark = '`'.repeat(longest + 1);
  return longest ? `${mark} ${flat} ${mark}` : `${mark}${flat}${mark}`;
}
function cut(text, lines = RESULT_LINES, chars = RESULT_CHARS) {
  const all = str(text).split('\n');
  let body = all.slice(0, lines).join('\n');
  let left = all.length - Math.min(all.length, lines);
  if (body.length > chars) {
    body = body.slice(0, chars);
    left = Math.max(left, 1);
  }
  return { body, note: left ? `(${left.toLocaleString('en-US')} more ${left === 1 ? 'line' : 'lines'} not shown)` : '' };
}
const shown = (text, lines, chars) => {
  const { body, note } = cut(text, lines, chars);
  return note ? `${fence(body)}\n\n*${note}*` : fence(body);
};
const quote = (text) => str(text).split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
const plural = (count, one, many) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
const fileName = (file) => path.posix.basename(str(file)) || str(file);

function resultText(result) {
  const content = result && result.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block && block.type === 'text' ? str(block.text) : block && block.type === 'image' ? '(picture)' : '')).filter(Boolean).join('\n');
}
function resultBlock(result) {
  const text = strip(resultText(result));
  if (!text) return '';
  return `${result.is_error ? 'Error' : 'Result'}:\n\n${shown(text)}`;
}

function diff(edits) {
  const lines = [];
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') continue;
    if (lines.length) lines.push('');
    str(edit.old_string).split('\n').forEach((line) => lines.push(`- ${line}`));
    str(edit.new_string).split('\n').forEach((line) => lines.push(`+ ${line}`));
  }
  const { body, note } = cut(lines.join('\n'));
  return note ? `${fence(body, 'diff')}\n\n*${note}*` : fence(body, 'diff');
}

// One step the AI took, in full: what it did, then what came back.
function step(block, result) {
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const where = input.path ? ` in ${code(input.path)}` : '';
  const parts = [];
  switch (block.name) {
    case 'Bash':
      parts.push(`**Ran a command**${input.description ? `: ${oneLine(input.description)}` : ''}`, fence(str(input.command), 'bash'));
      break;
    case 'Read':
      parts.push(`**Read** ${code(input.file_path)}`);
      break;
    case 'Write':
      parts.push(`**Wrote** ${code(input.file_path)}`, shown(input.content));
      break;
    case 'Edit':
      parts.push(`**Changed** ${code(input.file_path)}`, diff([input]));
      break;
    case 'MultiEdit':
      parts.push(`**Changed** ${code(input.file_path)}`, diff(Array.isArray(input.edits) ? input.edits : []));
      break;
    case 'NotebookEdit':
      parts.push(`**Changed** ${code(input.notebook_path)}`, shown(input.new_source));
      break;
    case 'Grep':
      parts.push(`**Searched for** ${code(input.pattern)}${where}`);
      break;
    case 'Glob':
      parts.push(`**Looked for files** ${code(input.pattern)}${where}`);
      break;
    case 'WebFetch':
      parts.push(`**Opened** ${oneLine(input.url, 500)}`);
      break;
    case 'WebSearch':
      parts.push(`**Searched the web for** "${oneLine(input.query)}"`);
      break;
    case 'Agent':
    case 'Task':
      parts.push(`**Started a helper**${input.description ? `: ${oneLine(input.description)}` : ''}`, shown(input.prompt, 60));
      break;
    case 'TodoWrite':
      parts.push('**Updated its to-do list**');
      if (Array.isArray(input.todos)) parts.push(input.todos.map((todo) => `- [${todo && todo.status === 'completed' ? 'x' : ' '}] ${oneLine(todo && todo.content)}`).join('\n'));
      break;
    default:
      parts.push(`**Used ${oneLine(block.name || 'a tool', 80)}**`, shown(JSON.stringify(input, null, 2), 60));
  }
  const came = result ? resultBlock(result) : '';
  if (came) parts.push(came);
  return parts.join('\n\n');
}

// The steps between two things the AI said, as one short line.
const newTally = () => ({ commands: 0, changed: [], read: new Set(), searches: 0, web: 0, helpers: 0, other: 0 });
function count(tally, block) {
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  switch (block.name) {
    case 'Bash': tally.commands += 1; break;
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': {
      const name = fileName(input.file_path || input.notebook_path);
      if (!tally.changed.includes(name)) tally.changed.push(name);
      break;
    }
    case 'Read': tally.read.add(str(input.file_path)); break;
    case 'Grep': case 'Glob': tally.searches += 1; break;
    case 'WebFetch': case 'WebSearch': tally.web += 1; break;
    case 'Agent': case 'Task': tally.helpers += 1; break;
    case 'TodoWrite': case 'ToolSearch': case 'BashOutput': case 'KillShell': break;
    default: tally.other += 1;
  }
}
function tallyLine(tally) {
  const parts = [];
  if (tally.commands) parts.push(`ran ${plural(tally.commands, 'command', 'commands')}`);
  if (tally.changed.length) {
    const names = tally.changed.slice(0, 3).join(', ') + (tally.changed.length > 3 ? ', …' : '');
    parts.push(`changed ${plural(tally.changed.length, 'file', 'files')} (${names})`);
  }
  if (tally.read.size) parts.push(`read ${plural(tally.read.size, 'file', 'files')}`);
  if (tally.searches) parts.push(`searched ${plural(tally.searches, 'time', 'times')}`);
  if (tally.web) parts.push(`looked online ${plural(tally.web, 'time', 'times')}`);
  if (tally.helpers) parts.push(`used ${plural(tally.helpers, 'helper', 'helpers')}`);
  if (tally.other) parts.push(`used ${plural(tally.other, 'other tool', 'other tools')}`);
  if (!parts.length) return '';
  const said = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `*${said[0].toUpperCase()}${said.slice(1)}.*`;
}

// A question the AI asked you with choices to pick, and what you picked. Shown either way: you
// saw it in the terminal.
function askedYou(block, result) {
  const questions = Array.isArray(block.input && block.input.questions) ? block.input.questions : [];
  const asked = questions.map((item) => {
    const options = Array.isArray(item && item.options) ? item.options : [];
    return [`**Asked you:** ${oneLine(item && item.question, 500)}`, options.map((option) => `- ${oneLine(option && option.label, 120)}${option && option.description ? ` (${oneLine(option.description, 300)})` : ''}`).join('\n')].filter(Boolean).join('\n\n');
  });
  const text = resultText(result);
  const picks = [...text.matchAll(/"([^"]*)"="([^"]*)"/g)].map((match) => `**You picked:** ${oneLine(match[2], 500)}`);
  return { asked: asked.join('\n\n'), picked: picks.length ? picks.join('\n\n') : (result && text ? `**You answered:** ${oneLine(text, 500)}` : '') };
}

function makeDate(zone) {
  const make = (options) => {
    try { return new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone || undefined }); } catch { return new Intl.DateTimeFormat('en-US', options); }
  };
  const day = make({ year: 'numeric', month: '2-digit', day: '2-digit' });
  const long = make({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const clock = make({ hour: 'numeric', minute: '2-digit' });
  const full = make({ month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return { key: (ms) => day.format(ms), day: (ms) => long.format(ms), clock: (ms) => clock.format(ms), full: (ms) => full.format(ms) };
}

function render(entries, { detail = false, agent = 'Claude', room = '', timeZone, now = Date.now() } = {}) {
  const dates = makeDate(timeZone);
  const steps = thread(entries);
  const results = new Map();
  // From every line, not just the thread: when the AI takes several steps at once, only the last
  // one's result is on the way back from the end, and the others hang off to the side.
  for (const entry of entries) {
    const content = entry && entry.type === 'user' && !entry.isSidechain && entry.message && entry.message.content;
    if (Array.isArray(content)) for (const block of content) if (block && block.type === 'tool_result') results.set(block.tool_use_id, block);
  }

  const out = [];
  let day = '';
  let speaker = '';
  let tally = newTally();
  let tallyAt = 0;
  const heading = (who, ms) => {
    if (Number.isFinite(ms)) {
      const key = dates.key(ms);
      if (key !== day) {
        day = key;
        speaker = '';
        out.push(`## ${dates.day(ms)}`);
      }
    }
    if (who !== speaker) {
      speaker = who;
      out.push(`### ${who}${Number.isFinite(ms) ? ` · ${dates.clock(ms)}` : ''}`);
    }
  };
  const flush = () => {
    const line = tallyLine(tally);
    if (line) {
      heading(agent, tallyAt);
      out.push(line);
    }
    tally = newTally();
    tallyAt = 0;
  };
  const said = (who, ms, text) => {
    flush();
    heading(who, ms);
    out.push(text);
  };
  const output = (text, ms) => {
    const body = strip(text);
    if (body) said(speaker || 'You', ms, shown(body, detail ? RESULT_LINES : SHORT_LINES));
  };

  for (const entry of steps) {
    const ms = Date.parse(entry.timestamp);
    const content = entry.message && entry.message.content;
    if (entry.type === 'system') {
      if (entry.subtype === 'compact_boundary') {
        flush();
        out.push('*The chat was summarized here to make room. The AI keeps the summary, not every word before it.*');
        speaker = '';
      } else if (entry.subtype === 'local_command') {
        const text = str(entry.content);
        const name = tag(text, 'command-name');
        if (name) said('You', ms, code(`${name.startsWith('/') ? '' : '/'}${name}${tag(text, 'command-args') ? ` ${tag(text, 'command-args')}` : ''}`));
        const answer = tag(text, 'local-command-stdout') ?? tag(text, 'local-command-stderr');
        if (answer) output(answer, ms);
      }
      continue;
    }
    if (entry.type === 'user') {
      if (entry.isMeta) continue;
      if (entry.isCompactSummary) {
        if (detail) {
          flush();
          out.push(`**What the AI kept from before:**\n\n${quote(strip(typeof content === 'string' ? content : resultText({ content })))}`);
        }
        continue;
      }
      const pieces = [];
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const block of blocks) {
        if (!block) continue;
        if (block.type === 'image') pieces.push('*(picture)*');
        if (block.type !== 'text') continue;
        const text = str(block.text);
        if (/^\[Request interrupted by user/.test(text)) {
          flush();
          out.push('*(You stopped the AI here.)*');
          continue;
        }
        const ran = tag(text, 'bash-input');
        if (ran !== null) {
          pieces.push(code(`! ${ran}`));
          continue;
        }
        const printed = [tag(text, 'bash-stdout'), tag(text, 'bash-stderr'), tag(text, 'local-command-stdout')].filter(Boolean).join('\n');
        if (/<(bash-stdout|bash-stderr|local-command-stdout)>/.test(text)) {
          output(printed, ms);
          continue;
        }
        const name = tag(text, 'command-name');
        if (name) {
          const args = tag(text, 'command-args');
          pieces.push(code(`${name.startsWith('/') ? '' : '/'}${name}${args ? ` ${args}` : ''}`));
          continue;
        }
        if (/<local-command-caveat>/.test(text)) continue;
        const clean = strip(text);
        if (clean) pieces.push(clean);
      }
      if (pieces.length) said('You', ms, pieces.join('\n\n'));
      continue;
    }
    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        if (block.type === 'text' && str(block.text).trim()) {
          said(agent, ms, str(block.text).trim());
        } else if (block.type === 'thinking' && detail && str(block.thinking).trim()) {
          said(agent, ms, quote(`**Thinking:** ${str(block.thinking).trim()}`));
        } else if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
          const { asked, picked } = askedYou(block, results.get(block.id));
          if (asked) said(agent, ms, asked);
          if (picked) said('You', ms, picked);
        } else if (block.type === 'tool_use' && block.name === 'ExitPlanMode' && str(block.input && block.input.plan).trim()) {
          said(agent, ms, `**The plan:**\n\n${str(block.input.plan).trim()}`);
        } else if (block.type === 'tool_use' && detail) {
          said(agent, ms, step(block, results.get(block.id)));
        } else if (block.type === 'tool_use') {
          if (!tallyAt) tallyAt = ms;
          count(tally, block);
        }
      }
    }
  }
  flush();

  const where = room ? `${room} room` : 'Linux House';
  const head = [
    `# Chat in the ${where}`,
    [
      `- AI: ${agent}`,
      `- Saved: ${dates.full(now)}`,
      detail ? '- With details: every command, file change and result, plus the AI\'s thinking where it was kept.' : '- What you and the AI said, as the terminal shows it.',
    ].join('\n'),
    '---',
  ];
  if (!out.length) out.push('*Nothing has been said in this chat yet.*');
  return `${[...head, ...out].join('\n\n')}\n`;
}

/* ---------- The program ---------- */

function exportChat(options = {}) {
  const home = typeof options.home === 'string' && options.home ? options.home : os.homedir();
  const tab = typeof options.tab === 'string' && /^tab-\d{1,4}$/.test(options.tab) ? options.tab : null;
  const shellPid = Number.isInteger(options.shellPid) && options.shellPid > 1 ? options.shellPid : null;
  const here = tab ? (pid) => inTab(pid, tab) : shellPid ? (pid) => underShell(pid, shellPid) : null;
  if (!here) return { error: 'That isn\'t a terminal with a chat in it.' };
  const [note] = runningChats(home, here);
  if (!note) {
    const other = otherAI(here);
    return { error: other ? `This terminal's AI is ${other}. Saving a chat works with Claude for now.` : 'No AI chat is running in this terminal. Start one, then try again.' };
  }
  const file = chatFile(home, note);
  if (!file) return { error: 'This chat hasn\'t been saved by the AI yet. Say something to it first.' };
  const page = render(readEntries(file), {
    detail: Boolean(options.detail), agent: 'Claude', room: typeof options.room === 'string' ? options.room : '', timeZone: options.timeZone, now: Number(options.now) || Date.now(),
  });
  return { ok: true, page };
}

function runFromStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    let answer;
    try {
      answer = exportChat(JSON.parse(input || '{}'));
    } catch {
      answer = { error: 'The chat couldn\'t be read.' };
    }
    const { page = '', ...head } = answer;
    process.stdout.write(`${JSON.stringify(head)}\n${page}`);
  });
}

if (typeof module !== 'undefined') module.exports = { exportChat, render, thread, runFromStdin };
