// Which AI tools the rooms have. Station 256 installs none of them for you: you tick the ones you
// use (House Rules > Your AI tools) and only those go into the room blueprint. The choice is one
// line in ~/.config/house/ai-tools, like "claude,codex". bin/room reads it ("room ai", "room build").
// No file means nothing chosen yet. A choice rebuilds the blueprint in the background; rooms that
// are already open keep what they had until they are opened again.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const FILE = path.join(HOME, '.config', 'house', 'ai-tools');
const ROOM = path.join(HOME, '.local', 'bin', 'room');

const TOOLS = [
  { id: 'claude', name: 'Claude Code', maker: 'Anthropic', signIn: 'Signs in with your Claude account.' },
  { id: 'codex', name: 'Codex', maker: 'OpenAI', signIn: 'Signs in with your ChatGPT account.' },
  { id: 'gemini', name: 'Gemini', maker: 'Google', signIn: 'Signs in with your Google account or a free key.' },
];
const KNOWN = TOOLS.map((tool) => tool.id);

let job = null; // the build that is running now, if any
let line = ''; // the last thing the build said
let error = '';
let tell = () => {};

// The chosen ids, or null when nothing has been chosen yet.
function chosen() {
  let text;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { return null; }
  return KNOWN.filter((id) => text.split(/[\s,]+/).includes(id));
}

function overview() {
  return { tools: TOOLS, chosen: chosen(), building: Boolean(job), line, error };
}

function report() { tell(overview()); }

// Saves the choice and, unless build is false, rebuilds the room blueprint with it.
function set(ids, { build = true } = {}) {
  if (!Array.isArray(ids) || ids.some((id) => !KNOWN.includes(id))) throw new Error('That is not one of the AI tools.');
  if (job) throw new Error('The rooms are being set up right now. Wait until it finishes.');
  const list = KNOWN.filter((id) => ids.includes(id));
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `${list.join(',')}\n`);
  error = '';
  line = '';
  if (build) {
    job = spawn(ROOM, ['build'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (chunk) => {
      const last = String(chunk).split(/\r?\n|\r/).map((part) => part.trim()).filter(Boolean).pop();
      if (last) { line = last.slice(0, 140); report(); }
    };
    job.stdout.on('data', take);
    job.stderr.on('data', take);
    job.on('error', (failure) => { error = `Could not start the build: ${failure.message}`; job = null; report(); });
    job.on('close', (code) => {
      if (!job) return;
      job = null;
      if (code !== 0) error = `The rooms could not be set up. ${line || 'Docker did not answer.'}`;
      else line = '';
      report();
    });
  }
  report();
  return overview();
}

module.exports = { TOOLS, overview, set, chosen, onStatus: (callback) => { tell = callback; } };
