// House rules: the saved choices, and the files every AI's permissions are made from (Claude's
// here, Codex's and Gemini's in ai-rules.js). Every rule applies to every room, the same way.
// There are no per-project rules.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SUPPORT, codexRequirements, geminiPolicy } = require('./ai-rules');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'house');
const RULES_FILE = path.join(CONFIG_DIR, 'rules.json');
// Claude's rules for Claude in the house itself (/etc/claude-code points here).
const CLAUDE_FILE = path.join(CONFIG_DIR, 'claude-managed.json');
// Each AI's rules for every room. Rooms mount these files read-only, and they're rewritten in
// place, so open rooms see a change at once. Claude reads its file all the time; Codex and Gemini
// read theirs each time they start.
const ROOM_FILE = path.join(CONFIG_DIR, 'claude-room.json');
const CODEX_FILE = path.join(CONFIG_DIR, 'codex-requirements.toml');
const GEMINI_FILE = path.join(CONFIG_DIR, 'gemini-policy.toml');
// Where each project used to get a file of its own. Only cleared away now.
const OLD_ROOM_DIR = path.join(CONFIG_DIR, 'claude-rooms');

// The house folders a room can be given, by the "Your folders" rule. In a room each one is at
// /home/dev/<name>. bin/room mounts the same list, so the two have to stay in step.
const HOME_FOLDERS = ['Documents', 'Pictures', 'Music', 'Videos', 'Downloads'];

// In the order they're shown. section "main" is Main rules; "more" is More controls.
// strength "wall": the room itself can't get past it, so it starts the next time a room opens.
// strength "ai": rules every AI in a room follows (Claude, Codex and Gemini). A script you run by
// hand in a room isn't stopped. The words are kept short and plain, about a grade 6 level.
const RULES = [
  { id: 'web', section: 'main', label: 'Internet', detail: 'AI searches the web or opens web pages.', strength: 'ai', options: ['allow', 'ask', 'block'], default: 'ask' },
  { id: 'deletes', section: 'main', label: 'Deleting files', detail: 'AI deletes files or folders with a command.', strength: 'ai', options: ['allow', 'ask', 'block'], default: 'ask' },
  { id: 'installs', section: 'main', label: 'Installing packages', detail: 'AI downloads code the project needs.\nFor example: npm install, pip install.', strength: 'ai', options: ['allow', 'ask', 'block'], default: 'allow' },
  { id: 'github', section: 'main', label: 'GitHub', detail: 'AI sends your code to GitHub, or gets code from it.', strength: 'ai', options: ['allow', 'ask', 'block'], default: 'ask' },
  { id: 'secrets', section: 'main', label: 'Passwords and keys', detail: 'AI opens files that hold passwords or keys, like .env files.', strength: 'ai', options: ['allow', 'ask', 'block'], default: 'ask' },
  { id: 'projectDoor', section: 'main', label: 'Other projects', detail: 'Rooms can see your other projects, but can\'t change them.\nStarts the next time a room opens.', strength: 'wall', options: ['allow', 'block'], default: 'block' },
  { id: 'homeFolders', section: 'main', label: 'Your folders', detail: 'Rooms can use Documents, Pictures, Music, Videos and Downloads.\nStarts the next time a room opens.', strength: 'wall', options: ['allow', 'readonly', 'block'], default: 'block' },
  { id: 'editing', section: 'more', label: 'Changing project files', detail: 'AI writes or changes files in the project.\nAllow means it won\'t stop to ask each time.', strength: 'ai', options: ['allow', 'ask'], default: 'ask' },
  { id: 'commands', section: 'more', label: 'Running the project', detail: 'AI runs the project\'s code to test it or start it.\nFor example: npm test, python.', strength: 'ai', options: ['allow', 'ask', 'block'], default: 'ask' },
  { id: 'history', section: 'more', label: 'Undoing saved work', detail: 'AI erases saved work or writes over it on GitHub.\nFor example: git reset --hard, git push --force.', strength: 'ai', options: ['allow', 'ask', 'block'], default: 'ask' },
  { id: 'fileAccess', section: 'more', label: 'File permissions', detail: 'AI changes who can open or run a file (chmod).', strength: 'ai', options: ['allow', 'ask', 'block'], default: 'ask' },
  { id: 'globalInstalls', section: 'more', label: 'Installing for the whole room', detail: 'AI installs a tool for the whole room, not just the project.\nFor example: npm install -g, pipx.', strength: 'ai', options: ['allow', 'ask', 'block'], default: 'ask' },
  { id: 'aiTools', section: 'more', label: 'AI settings and add-ons', detail: 'AI changes its own settings, or adds add-ons to the project.', strength: 'ai', options: ['allow', 'ask', 'block'], default: 'ask' },
  { id: 'ci', section: 'more', label: 'GitHub Actions', detail: 'AI changes the jobs GitHub runs for the project (the .github folder).', strength: 'ai', options: ['allow', 'ask', 'block'], default: 'ask' },
  { id: 'outside', section: 'more', label: 'Reading outside the project', detail: 'AI reads your other projects or Windows files, if the room can see them.', strength: 'ai', options: ['allow', 'ask', 'block'], default: 'ask' },
];
const INTRO = 'What AI can do in your rooms. Claude, Codex and Gemini all follow these rules.';

// Paths are matched as in .gitignore. "//" starts at the very top of the disk, and a pattern with no
// slash in front is inside the project. Edit rules cover every tool that writes files.
const CLAUDE_PATTERNS = {
  web: ['WebSearch', 'WebFetch', 'Bash(curl:*)', 'Bash(wget:*)'],
  github: ['Bash(git push:*)', 'Bash(git pull:*)', 'Bash(git clone:*)', 'Bash(git fetch:*)', 'Bash(gh:*)', 'WebFetch(domain:github.com)'],
  installs: ['Bash(npm install:*)', 'Bash(npm i:*)', 'Bash(pnpm add:*)', 'Bash(pnpm install:*)', 'Bash(yarn add:*)', 'Bash(pip install:*)', 'Bash(pip3 install:*)', 'Bash(uv add:*)', 'Bash(uv pip install:*)'],
  deletes: ['Bash(rm:*)', 'Bash(rmdir:*)', 'Bash(git clean:*)'],
  // A room's own secrets folder is mounted at /secrets, outside the project.
  secrets: ['Read(**/.env)', 'Read(**/.env.*)', 'Read(**/secrets/**)', 'Read(//secrets/**)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Bash(printenv:*)', 'Bash(env:*)'],
  commands: ['Bash(npm run:*)', 'Bash(npm test:*)', 'Bash(npm start:*)', 'Bash(node:*)', 'Bash(python:*)', 'Bash(python3:*)', 'Bash(pytest:*)', 'Bash(make:*)'],
  // Asking wins over allowing, so these still ask even while GitHub or Installing is on Allow.
  history: ['Bash(git reset --hard:*)', 'Bash(git rebase:*)', 'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push --force-with-lease:*)', 'Bash(git branch -D:*)', 'Bash(git checkout --:*)', 'Bash(git restore:*)'],
  fileAccess: ['Bash(chmod:*)', 'Bash(chown:*)', 'Bash(chgrp:*)'],
  globalInstalls: ['Bash(npm install -g:*)', 'Bash(npm i -g:*)', 'Bash(npm install --global:*)', 'Bash(pnpm add -g:*)', 'Bash(yarn global:*)', 'Bash(pip install --user:*)', 'Bash(pip3 install --user:*)', 'Bash(pipx:*)', 'Bash(uv tool:*)'],
  aiTools: ['Edit(**/.claude/**)', 'Edit(**/.mcp.json)', 'Bash(claude mcp:*)'],
  ci: ['Edit(**/.github/**)', 'Edit(**/.gitlab-ci.yml)', 'Edit(**/.circleci/**)'],
  // In a room: the other projects (Other projects) and Windows (the Windows door). Your folders
  // has its own rule below, so it isn't covered here.
  outside: ['Read(//projects/**)', 'Read(//windows/**)'],
};

const valid = (id, value) => Boolean(RULES.find((rule) => rule.id === id)?.options.includes(value));

function readSaved() {
  try {
    const saved = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

// The house's choices. Anything missing or not valid is its default. Per-project choices that an
// older version saved are ignored, and left out the next time the file is written.
function readRules() {
  const saved = readSaved();
  const values = Object.fromEntries(RULES.map((rule) => [rule.id, rule.default]));
  for (const rule of RULES) if (valid(rule.id, saved[rule.id])) values[rule.id] = saved[rule.id];
  return values;
}

// In a room, Claude also reports each project file it changes, for "Last edited by". The script
// is part of the room blueprint (room/house-edit-log). A room from an older blueprint doesn't
// have it, so then the hook does nothing.
const EDIT_LOG = '/usr/local/bin/house-edit-log';
const editHook = { type: 'command', command: `[ -x ${EDIT_LOG} ] && ${EDIT_LOG} claude || true`, timeout: 5 };
const ROOM_HOOKS = {
  // Before a shell command its start time is noted, so files it changed can be found after.
  PreToolUse: [{ matcher: 'Bash', hooks: [editHook] }],
  PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [editHook] }],
};

// In the house, Claude's shell commands first pass the delete guard (bin/protect-home.js), which
// refuses ones that could delete the home folder, the projects or Station 256 as a whole. Windows'
// Claude Code runs the same guard from its own settings. Made after the 2026-11-08 wipe.
const GUARD = path.join(__dirname, '..', '..', 'bin', 'protect-home.js');
const HOUSE_HOOKS = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${GUARD}"`, timeout: 10 }] }],
};

// Claude's look, in the house and in every room: light, with Station 256's blue. The theme file
// is room/station-blue.json. Rooms get it from their blueprint; the house gets it from ensureTheme.
// The house rules set it, so they win over what Claude remembers in its own .claude.json, even an
// old "light" from before (tested: a room whose .claude.json said light still drew Station blue).
// A look picked with /theme inside Claude lasts only until Claude starts again.
const THEME = 'station-blue';
const THEME_SOURCE = path.join(__dirname, '..', '..', 'room', `${THEME}.json`);
const HOUSE_THEME = path.join(os.homedir(), '.claude', 'themes', `${THEME}.json`);

function ensureTheme() {
  try {
    const text = fs.readFileSync(THEME_SOURCE, 'utf8');
    JSON.parse(text);
    fs.mkdirSync(path.dirname(HOUSE_THEME), { recursive: true });
    writeSafely(HOUSE_THEME, text);
  } catch {
    // Without it Claude keeps its own look. The rules matter more, so they're written anyway.
  }
}

// Ponytail (github.com/DietrichGebert/ponytail), the owner's pick: Claude writes the least code
// that does the job, and never cuts validation, error handling, security or accessibility. It is
// on for Claude in the house and in every room, all the time, whatever else is in use. Set here,
// in the house rules, nothing in a room can turn it off. Claude installs it from GitHub when a
// session starts and keeps it up to date, also in rooms, where Claude's own updates are off
// (FORCE_AUTOUPDATE_PLUGINS). Kept plain: no task board (ledger), and room-start hides its band
// and status-badge offer.
const PLUGINS = {
  extraKnownMarketplaces: {
    ponytail: { source: { source: 'github', repo: 'DietrichGebert/ponytail' }, autoUpdate: true },
  },
  enabledPlugins: { 'ponytail@ponytail': true },
  pluginConfigs: { 'ponytail@ponytail': { options: { ledger: false } } },
  env: { FORCE_AUTOUPDATE_PLUGINS: '1' },
};

function claudeSettings(rules, room = false) {
  const permissions = { allow: [], ask: [], deny: [] };
  for (const [id, patterns] of Object.entries(CLAUDE_PATTERNS)) {
    const bucket = { allow: 'allow', ask: 'ask', block: 'deny' }[rules[id]];
    permissions[bucket].push(...patterns);
  }
  // Allow: edits go ahead without asking each time. Ask: Claude's usual way, asking first.
  if (rules.editing === 'allow') permissions.defaultMode = 'acceptEdits';
  // Your folders, when a room has them. They're working folders for Claude, so it can use them
  // without asking, and on Read only it can't change anything in them.
  if (room && rules.homeFolders !== 'block') {
    const folders = HOME_FOLDERS.map((name) => `/home/dev/${name}`);
    permissions.additionalDirectories = folders;
    permissions.allow.push(...folders.map((folder) => `Read(/${folder}/**)`));
    if (rules.homeFolders === 'allow') permissions.allow.push(...folders.map((folder) => `Edit(/${folder}/**)`));
    else permissions.deny.push(...folders.map((folder) => `Edit(/${folder}/**)`));
  }
  const look = { theme: `custom:${THEME}` };
  return room ? { permissions, hooks: ROOM_HOOKS, ...look, ...PLUGINS } : { permissions, hooks: HOUSE_HOOKS, ...look, ...PLUGINS };
}

const settingsText = (rules, room = false) => `${JSON.stringify(claudeSettings(rules, room), null, 2)}\n`;

// A trial write comes first. If the disk is full, that fails and the real file is left as it was,
// instead of being emptied. The real write stays in place, so rooms already using it see the change.
function writeSafely(file, text) {
  const trial = `${file}.new`;
  fs.writeFileSync(trial, text);
  fs.rmSync(trial);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
  fs.writeFileSync(file, text);
}

function writeAll(values) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeSafely(RULES_FILE, `${JSON.stringify(values, null, 2)}\n`);
  writeSafely(CLAUDE_FILE, settingsText(values));
  writeSafely(ROOM_FILE, settingsText(values, true));
  writeSafely(CODEX_FILE, codexRequirements(values));
  writeSafely(GEMINI_FILE, geminiPolicy(values));
  ensureTheme();
  // Each project used to have its own file. Every room now shares the one above.
  fs.rmSync(OLD_ROOM_DIR, { recursive: true, force: true });
}

// A rule set to a choice Codex can't fully keep says so under it, in plain words.
function codexNote(id, value) {
  const support = SUPPORT[id];
  const codex = support?.[value]?.codex;
  return codex === true || codex === 'room' ? '' : support?.note?.codex || '';
}

function allRules() {
  const values = readRules();
  return { intro: INTRO, definitions: RULES.map((rule) => ({ ...rule, who: codexNote(rule.id, values[rule.id]) })), values };
}

function setRule(id, value) {
  if (!valid(id, value)) throw new Error(`Not a valid rule: ${id}=${value}`);
  writeAll({ ...readRules(), [id]: value });
  return allRules();
}

// Rebuilds the files if any is missing, damaged or out of date. Otherwise leaves them alone.
function ensureFiles() {
  writeAll(readRules());
}

// For a room about to open: the files every room uses, and what the room's walls let in.
function prepareRoom() {
  ensureFiles();
  const rules = readRules();
  return { file: ROOM_FILE, codex: CODEX_FILE, gemini: GEMINI_FILE, projectDoor: rules.projectDoor, homeFolders: rules.homeFolders };
}

module.exports = { RULES, HOME_FOLDERS, CLAUDE_PATTERNS, readRules, allRules, setRule, ensureFiles, prepareRoom, claudeSettings };

// Rooms run "node rules.js room" before they open, so every AI's rules are always there and up to
// date. It prints Claude's room file, then "codex=...", "gemini=...", "projectDoor=..." and
// "homeFolders=...". With nothing after it, it only makes sure the files are there and up to date.
if (require.main === module) {
  if (process.argv[2] === 'room') {
    const room = prepareRoom();
    process.stdout.write(`${room.file}\ncodex=${room.codex}\ngemini=${room.gemini}\nprojectDoor=${room.projectDoor}\nhomeFolders=${room.homeFolders}\n`);
  } else {
    ensureFiles();
  }
}
