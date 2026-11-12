// House rules for Codex and Gemini: the files that make them follow the same rules as Claude.
// rules.js makes Claude's file. This makes the other two AIs' files, from the same choices, and
// bin/room mounts them read-only into every room:
// - Codex: /etc/codex/requirements.toml. Codex takes it as the admin's word, so nothing changed in
//   Codex's own settings, by you or by the AI, can loosen it.
// - Gemini: an admin policy, /etc/gemini-cli/policies/house.toml, which wins over every other
//   Gemini rule.
// Gemini's system settings (no YOLO, your folders) never change, so they're in the room
// blueprint instead: room/gemini-settings.json, which is geminiSettings() written out.
// The order is the same as Claude's everywhere: block beats ask, and ask beats allow.

// The same five folders as HOME_FOLDERS in rules.js (the test checks they stay in step). Not
// taken from rules.js itself, because rules.js uses this file.
const HOME_FOLDERS = ['Documents', 'Pictures', 'Music', 'Videos', 'Downloads'];

// The commands each rule covers, word by word. The same commands as Claude's Bash(...) patterns in
// rules.js (the test checks they stay in step), plus Codex's and Gemini's own add-on commands.
const COMMANDS = {
  web: ['curl', 'wget'],
  github: ['git push', 'git pull', 'git clone', 'git fetch', 'gh'],
  installs: ['npm install', 'npm i', 'pnpm add', 'pnpm install', 'yarn add', 'pip install', 'pip3 install', 'uv add', 'uv pip install'],
  deletes: ['rm', 'rmdir', 'git clean'],
  secrets: ['printenv', 'env'],
  commands: ['npm run', 'npm test', 'npm start', 'node', 'python', 'python3', 'pytest', 'make'],
  history: ['git reset --hard', 'git rebase', 'git push --force', 'git push -f', 'git push --force-with-lease', 'git branch -D', 'git checkout --', 'git restore'],
  fileAccess: ['chmod', 'chown', 'chgrp'],
  globalInstalls: ['npm install -g', 'npm i -g', 'npm install --global', 'pnpm add -g', 'yarn global', 'pip install --user', 'pip3 install --user', 'pipx', 'uv tool'],
  aiTools: ['claude mcp', 'codex mcp', 'codex plugin', 'gemini mcp', 'gemini extensions'],
};

// How a rule is named in the message an AI gets when it's stopped or asks. The same names as the
// House Rules page (the test checks they stay in step).
const NAMES = {
  web: 'Internet', deletes: 'Deleting files', installs: 'Installing packages', github: 'GitHub',
  secrets: 'Passwords and keys', editing: 'Changing project files', commands: 'Running the project',
  history: 'Undoing saved work', fileAccess: 'File permissions',
  globalInstalls: 'Installing for the whole room', aiTools: 'AI settings and add-ons', ci: 'GitHub Actions',
  outside: 'Reading outside the project', homeFolders: 'Your folders', projectDoor: 'Other projects',
};

// What each AI really does with each choice, so the panel can tell the truth.
// true: it follows the rule. 'partial': only part of it (see note). 'block': it can't stop to ask,
// so the rule blocks instead. false: it can't follow the rule. 'room': the room's own walls hold
// every AI to it.
// Codex reads and changes files with shell commands and its own patch tool, which no house rule
// can see, and Codex's sandbox can't run inside a room. So file rules don't reach Codex.
// The notes are shown on the House Rules page, under a rule set to a choice Codex can't fully keep.
const SUPPORT = {
  web: {
    allow: { claude: true, gemini: true, codex: true },
    ask: { claude: true, gemini: true, codex: 'block' },
    block: { claude: true, gemini: true, codex: true },
    note: { codex: 'Codex can\'t ask before it searches the web, so Ask turns its web search off.' },
  },
  deletes: {
    allow: { claude: true, gemini: true, codex: true },
    ask: { claude: true, gemini: true, codex: 'partial' },
    block: { claude: true, gemini: true, codex: 'partial' },
    note: { codex: 'Codex can still delete a file with its own editing tool.' },
  },
  installs: same(true, true, true),
  github: same(true, true, true),
  secrets: {
    allow: { claude: true, gemini: true, codex: true },
    ask: { claude: true, gemini: true, codex: 'partial' },
    block: { claude: true, gemini: true, codex: 'partial' },
    note: { codex: 'Codex isn\'t stopped from opening .env files. Claude and Gemini are.' },
  },
  editing: {
    allow: { claude: true, gemini: true, codex: true },
    ask: { claude: true, gemini: true, codex: false },
    note: { codex: 'Codex changes project files without asking first.' },
  },
  commands: same(true, true, true),
  history: same(true, true, true),
  fileAccess: same(true, true, true),
  globalInstalls: same(true, true, true),
  aiTools: {
    allow: { claude: true, gemini: true, codex: true },
    ask: { claude: true, gemini: true, codex: 'partial' },
    block: { claude: true, gemini: true, codex: 'partial' },
    note: { codex: 'Codex can\'t ask before it changes AI settings files, so Ask blocks those changes.' },
  },
  ci: {
    allow: { claude: true, gemini: true, codex: true },
    ask: { claude: true, gemini: true, codex: 'block' },
    block: { claude: true, gemini: true, codex: 'partial' },
    note: { codex: 'Codex can\'t ask before it changes these files, so Ask blocks those changes.' },
  },
  outside: {
    allow: { claude: true, gemini: true, codex: true },
    ask: { claude: true, gemini: true, codex: false },
    block: { claude: true, gemini: true, codex: false },
    note: { codex: 'Codex isn\'t stopped by this rule. It still can\'t change those files.' },
  },
  projectDoor: { allow: walls(), block: walls() },
  homeFolders: { allow: walls(), readonly: walls(), block: walls() },
};

function same(claude, gemini, codex) {
  const each = { claude, gemini, codex };
  return { allow: { ...each }, ask: { ...each }, block: { ...each } };
}

function walls() {
  return { claude: 'room', gemini: 'room', codex: 'room' };
}

const message = (id, value) => `Station 256 house rules: ${NAMES[id]} is set to ${value === 'block' ? 'Block' : 'Ask'}.`;

// ---- Codex ----

// Files Codex changes with its own patch tool. A hook reads the patch, and stops it when it names
// one of these files. A hook can only stop a change, not ask, so Ask blocks too. Changes made
// with shell commands aren't seen.
const CODEX_PATCH_FILES = {
  aiTools: String.raw`([.]claude/|[.]gemini/|[.]codex/|[.]mcp[.]json)`,
  ci: String.raw`([.]github/|[.]gitlab-ci[.]yml|[.]circleci/)`,
};
// What the hook is given is JSON, so the patch is one line, with each new line written as \n.
// A patch names its files on lines starting "*** Add File: " and so on. A path ends at a \ or ".
const PATCH_FILE_LINE = String.raw`(\\n|")[*][*][*] (Add File|Update File|Delete File|Move to): ([^\"]*/)?`;

function codexHooks(rules) {
  const hooks = [];
  for (const [id, files] of Object.entries(CODEX_PATCH_FILES)) {
    if (rules[id] !== 'ask' && rules[id] !== 'block') continue;
    const why = rules[id] === 'ask' ? `${message(id, 'ask')} Codex cannot ask first, so the change is blocked.` : message(id, 'block');
    const check = `grep -qE "${shellQuoted(PATCH_FILE_LINE + files)}" && { echo "${shellQuoted(why)}" >&2; exit 2; }; exit 0`;
    // The check sits inside '...', which can't hold a ' of its own.
    if (check.includes("'")) throw new Error(`Codex hook for ${id} can't hold a ' mark`);
    hooks.push(
      '',
      `# ${NAMES[id]}: ${rules[id]}${rules[id] === 'ask' ? ' (Codex can\'t ask here, so it blocks)' : ''}`,
      '[[hooks.PreToolUse]]',
      'matcher = "^apply_patch$"',
      '[[hooks.PreToolUse.hooks]]',
      'type = "command"',
      `command = '''/bin/sh -c '${check}' '''`,
      'timeout = 5',
    );
  }
  return hooks;
}

// Inside "..." in a shell, these four are the only special characters.
const shellQuoted = (text) => text.replace(/[\\"$`]/g, (char) => `\\${char}`);

// Codex can't ask before a web search, so Ask turns it off like Block does. curl and wget still ask.
function codexRequirements(rules) {
  const lines = [
    '# Station 256 house rules for Codex, made by panel/lib/ai-rules.js. Changes here are overwritten.',
    '# Codex takes this file as the admin\'s word: its own settings can\'t loosen it.',
    '',
    '# Codex always stops to ask when a rule says to ask, even if its own settings say never to ask.',
    'allowed_approval_policies = ["on-request"]',
    '# Web search. An empty list means off.',
    `allowed_web_search_modes = ${rules.web === 'allow' ? '["cached", "indexed", "live"]' : '[]'}`,
  ];
  // Codex itself uses the strictest rule a command matches, so allow needs no rule of its own.
  const entries = [];
  for (const [id, commands] of Object.entries(COMMANDS)) {
    const decision = { ask: 'prompt', block: 'forbidden' }[rules[id]];
    if (!decision) continue;
    for (const command of commands) {
      const pattern = command.split(' ').map((word) => `{ token = ${toml(word)} }`).join(', ');
      entries.push(`  { pattern = [${pattern}], decision = "${decision}", justification = ${toml(message(id, rules[id]))} },`);
    }
  }
  if (entries.length) lines.push('', '# Commands: prompt means ask first, forbidden means blocked.', '[rules]', 'prefix_rules = [', ...entries, ']');
  // Hooks stay on, even if Codex's own settings turn them off. That keeps the room's
  // "Last edited by" hooks (in /etc/codex/config.toml) on as well.
  lines.push('', '[features]', 'hooks = true');
  const hooks = codexHooks(rules);
  if (hooks.length) lines.push('', '# Changes to these files, through Codex\'s patch tool.', '[hooks]', ...hooks);
  return `${lines.join('\n')}\n`;
}

// ---- Gemini ----

const PRIORITY = { deny: 300, ask_user: 200, allow: 100 };
const DECISION = { allow: 'allow', ask: 'ask_user', block: 'deny' };
// Gemini's plan mode is read-only. Allow and ask rules for commands and changes leave it that way.
const NOT_PLAN = ['default', 'autoEdit', 'yolo'];
const WRITE_TOOLS = ['write_file', 'replace'];
const READ_TOOLS = ['read_file', 'read_many_files', 'grep_search', 'glob', 'list_directory'];
// Matched against a tool's details, written out as JSON, so a path ends at a quote mark.
// Gemini drops a pattern that has a repeat inside a repeated group (like (a+)*), so none do.
const FILES = {
  secrets: { tools: ['read_file', 'read_many_files', 'grep_search'], pattern: String.raw`["/*]\.env"|["/*]\.env\.[^"/]*"|["/]secrets[/"]|\.pem"|\.key"` },
  aiTools: { tools: WRITE_TOOLS, pattern: String.raw`["/]\.(claude|gemini|codex)/|["/]\.mcp\.json"` },
  ci: { tools: WRITE_TOOLS, pattern: String.raw`["/]\.github/|["/]\.gitlab-ci\.yml"|["/]\.circleci/` },
  outside: { tools: READ_TOOLS, pattern: String.raw`"/(projects|windows)[/"]` },
};
const GITHUB_PAGES = String.raw`https?://github\.com[^A-Za-z0-9.-]|https?://[^/"\s]*\.github\.com[^A-Za-z0-9.-]`;
const folderPattern = () => String.raw`"/home/dev/(${HOME_FOLDERS.join('|')})[/"]`;

function geminiPolicy(rules) {
  const blocks = [];
  // changes: the rule is about commands or changing files, which plan mode already turns down.
  const add = (id, value, fields, changes, why = message(id, value)) => {
    const decision = DECISION[value];
    if (!decision) return;
    const lines = Object.entries(fields).map(([key, field]) => `${key} = ${toml(field)}`);
    lines.push(`decision = "${decision}"`, `priority = ${PRIORITY[decision]}`);
    if (decision === 'allow' || (decision === 'ask_user' && changes)) lines.push(`modes = ${toml(NOT_PLAN)}`);
    if (decision === 'deny') lines.push(`denyMessage = ${toml(why)}`);
    blocks.push(`# ${NAMES[id]}: ${value}\n[[rule]]\n${lines.join('\n')}`);
  };
  for (const [id, commands] of Object.entries(COMMANDS)) {
    add(id, rules[id], { toolName: 'run_shell_command', commandPrefix: commands }, true);
  }
  add('web', rules.web, { toolName: ['google_web_search', 'web_fetch'] }, false);
  add('github', rules.github, { toolName: 'web_fetch', argsPattern: GITHUB_PAGES }, false);
  for (const [id, files] of Object.entries(FILES)) {
    add(id, rules[id], { toolName: files.tools, argsPattern: files.pattern }, files.tools === WRITE_TOOLS);
  }
  // Ask is Gemini's usual way for changes, as it is Claude's, so only Allow needs a rule.
  if (rules.editing === 'allow') add('editing', 'allow', { toolName: WRITE_TOOLS }, true);
  // Read only: the room already mounts them read-only. This tells Gemini why a change fails.
  if (rules.homeFolders === 'readonly') {
    add('homeFolders', 'block', { toolName: WRITE_TOOLS, argsPattern: folderPattern() }, true, 'Station 256 house rules: Your folders are read-only.');
  }
  return [
    '# Station 256 house rules for Gemini, made by panel/lib/ai-rules.js. Changes here are overwritten.',
    '# An admin policy: it wins over every other Gemini rule. Block (300) beats ask (200) beats allow (100).',
    ...blocks.map((block) => `\n${block}`),
  ].join('\n') + '\n';
}

// Gemini's system settings, /etc/gemini-cli/settings.json in a room: the "Last edited by" hooks,
// no YOLO, and your folders. Gemini only reads this file when root owns it and only root may
// change it. One owned by the house user is skipped, hooks and all (tested), so it can't be a
// house file mounted into the room. It's in the blueprint instead, as room/gemini-settings.json
// (the test checks the two match), and it's the same whatever the rules say. When Your folders is
// on Block the five folders are just empty. The policy file has no such check (tested); only its
// folder must be root's.
const EDIT_LOG_HOOKS = {
  BeforeTool: [
    { matcher: '^run_shell_command$', hooks: [{ name: 'house-edit-log', type: 'command', command: '/usr/local/bin/house-edit-log gemini', timeout: 5000 }] },
  ],
  AfterTool: [
    { matcher: '^(write_file|replace|run_shell_command)$', hooks: [{ name: 'house-edit-log', type: 'command', command: '/usr/local/bin/house-edit-log gemini', timeout: 5000 }] },
  ],
};

function geminiSettings() {
  const settings = {
    hooks: EDIT_LOG_HOOKS,
    // YOLO would skip every question, so it can't be turned on, even by a flag.
    security: { disableYoloMode: true },
    // Your folders, so Gemini's file tools may use them when the room has them.
    context: { includeDirectories: HOME_FOLDERS.map((name) => `/home/dev/${name}`) },
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

// TOML strings and lists read the same as JSON ones here.
function toml(value) {
  return Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(', ')}]` : JSON.stringify(value);
}

module.exports = { COMMANDS, HOME_FOLDERS, NAMES, SUPPORT, EDIT_LOG_HOOKS, codexRequirements, geminiPolicy, geminiSettings };
