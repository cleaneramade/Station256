// Counts the tokens AI used, by day, from Claude Code's conversation files (one line per message,
// each AI reply with its "usage"). It runs as a small program: in the house for the house's own
// files, and through Docker inside a room (or beside a sleeping room's records) for the room's, so
// only small totals ever come back. Each file is read once; later only what was added to it.
//   stdin:  { root, timeZone, files: { [file]: { offset, ids, open } } }
//   stdout: { files: { [file]: { offset, ids, reset, days: { "YYYY-MM-DD": [in, out] }, touch: { [path]: [time, model, in, out] }, open } } }
// "touch" is which files each AI step read or changed (Read, Edit, Write, MultiEdit, NotebookEdit): the
// latest time and model, and the step's tokens shared equally among the files it touched. "open" is
// the newest reply's [id, in, out, files so far]: a reply is written a line at a time, so more of its
// tool calls can arrive after its first lines were counted. Its tokens are then shared again among all
// its files, which can take some back from the earlier ones (a minus number in "touch").
// Only files that grew (or started again) are in the answer. "In" is everything the AI read, new
// and remembered (cached); "out" is what it wrote. One reply is often saved as several lines with
// the same id, so each id is counted once.
const fs = require('fs');
const path = require('path');

const CHUNK = 8 * 1024 * 1024;
const KEEP_IDS = 40;
const READERS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_PATH = 1024;
const MAX_STEP_FILES = 50;

function findFiles(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full, depth + 1);
      else if (item.isFile() && item.name.endsWith('.jsonl')) found.push(full);
    }
  };
  walk(root, 0);
  return found;
}

// The files one reply's tool calls read or changed.
function touchedBy(message) {
  const found = [];
  if (!message || !Array.isArray(message.content)) return found;
  for (const block of message.content) {
    if (!block || block.type !== 'tool_use' || !READERS.has(block.name) || !block.input) continue;
    const target = block.input.file_path || block.input.notebook_path;
    if (typeof target === 'string' && target.length < MAX_PATH && target.startsWith('/')) found.push(target);
  }
  return found;
}

// `steps` gathers each reply (by id) across its several lines: its time, model, tokens and files.
function countLine(line, ids, days, dayOf, steps, carry) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  const usage = entry && entry.type === 'assistant' && entry.message && entry.message.usage;
  if (!usage || typeof usage !== 'object') return;
  const id = entry.message.id || entry.requestId;
  let first = true;
  if (id) {
    if (ids.includes(id)) first = false;
    else {
      ids.push(id);
      if (ids.length > KEEP_IDS) ids.shift();
    }
  }
  const when = Date.parse(entry.timestamp);
  if (!Number.isFinite(when)) return;
  const n = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  const read = n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens);
  const wrote = n(usage.output_tokens);
  if (first) {
    const key = dayOf.format(when);
    const day = days[key] || (days[key] = [0, 0]);
    day[0] += read;
    day[1] += wrote;
  }
  if (!steps) return;
  const stepKey = id || `line${steps.size}`;
  let step = steps.get(stepKey);
  if (!step) {
    step = { time: when, model: '', in: 0, out: 0, paths: new Set() };
    // Its first lines were counted last time: it carries on with the tokens and files it had then.
    if (!first && carry.open && carry.open[0] === id) {
      step.in = n(carry.open[1]);
      step.out = n(carry.open[2]);
      step.before = (Array.isArray(carry.open[3]) ? carry.open[3] : []).filter((target) => typeof target === 'string' && target.length < MAX_PATH).slice(0, MAX_STEP_FILES);
      step.before.forEach((target) => step.paths.add(target));
    }
    steps.set(stepKey, step);
  }
  if (first) { step.in = read; step.out = wrote; }
  step.time = Math.max(step.time, when);
  if (typeof entry.message.model === 'string' && entry.message.model !== '<synthetic>') step.model = entry.message.model.slice(0, 80);
  touchedBy(entry.message).forEach((target) => { if (step.paths.size < MAX_STEP_FILES) step.paths.add(target); });
  carry.last = id ? [id, step] : null;
}

// Each step's tokens go equally to the files it touched.
function shareSteps(steps, touch) {
  steps.forEach((step) => {
    if (!step.paths.size) return;
    // A reply that carried on from last time gave each of its earlier files this much already.
    const before = step.before || [];
    const given = before.length ? 1 / before.length : 0;
    step.paths.forEach((target) => {
      const part = 1 / step.paths.size - (before.includes(target) ? given : 0);
      const have = touch[target] || (touch[target] = [0, '', 0, 0]);
      if (step.time >= have[0]) { have[0] = step.time; have[1] = step.model; }
      have[2] += step.in * part;
      have[3] += step.out * part;
    });
  });
  Object.values(touch).forEach((have) => { have[2] = Math.round(have[2]); have[3] = Math.round(have[3]); });
}

function countTokens({ root, timeZone, files = {} } = {}) {
  // en-CA writes dates as YYYY-MM-DD.
  const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' });
  const answer = {};
  for (const file of findFiles(String(root || ''))) {
    let size;
    try { size = fs.statSync(file).size; } catch { continue; }
    const known = files[file] || {};
    const reset = size < (known.offset || 0);
    const start = reset ? 0 : known.offset || 0;
    if (size === start) continue;
    const ids = reset ? [] : (Array.isArray(known.ids) ? known.ids.slice(-KEEP_IDS) : []);
    const days = {};
    const steps = new Map();
    const carry = { open: !reset && Array.isArray(known.open) ? known.open : null, last: undefined };
    let pos = start;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      let length = CHUNK;
      while (pos < size) {
        const want = Math.min(length, size - pos);
        const buffer = Buffer.alloc(want);
        const got = fs.readSync(fd, buffer, 0, want, pos);
        const end = buffer.subarray(0, got).lastIndexOf(10);
        if (end < 0) {
          // A line longer than what was read: read more at once, unless it isn't finished yet.
          if (pos + got >= size) break;
          length *= 2;
          continue;
        }
        buffer.subarray(0, end + 1).toString('utf8').split('\n').forEach((line) => countLine(line, ids, days, dayOf, steps, carry));
        pos += end + 1;
        length = CHUNK;
      }
    } catch { /* a file that can't be read is left for next time */ } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (pos !== start || reset) {
      const touch = {};
      shareSteps(steps, touch);
      // No reply in what was added: whatever was waiting still is.
      let open = carry.open;
      if (carry.last !== undefined) open = carry.last ? [carry.last[0], carry.last[1].in, carry.last[1].out, [...carry.last[1].paths]] : null;
      answer[file] = { offset: pos, ids, reset, days, touch, open };
    }
  }
  return answer;
}

function runFromStdin() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* nothing known yet */ }
  process.stdout.write(JSON.stringify({ files: countTokens(input) }));
}

module.exports = { countTokens, runFromStdin, touchedBy };
