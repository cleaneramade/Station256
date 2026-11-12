// Checks the Codex and Gemini rule files made by lib/ai-rules.js. Plain node, no packages:
//   node panel/test/ai-rules.test.js
// It reads the made files the way Codex and Gemini do (simplified), and runs Codex's patch hook
// with sh, as Codex does. Exits with 1 if anything is wrong.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ai = require('../lib/ai-rules');
const { RULES, CLAUDE_PATTERNS, HOME_FOLDERS } = require('../lib/rules');

let failed = 0;
function check(label, test) {
  try {
    test();
    console.log(`PASS ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${label}: ${error.message}`);
  }
}

const DEFAULTS = Object.fromEntries(RULES.map((rule) => [rule.id, rule.default]));
const withRules = (changes) => ({ ...DEFAULTS, ...changes });
const everything = (value) => Object.fromEntries(RULES.map((rule) => [rule.id, rule.options.includes(value) ? value : rule.options[0]]));

// ---- Codex, as Codex reads it: the strictest rule whose words start the command wins.
function codexRules(text) {
  return [...text.matchAll(/\{ pattern = \[(.*?)\], decision = "(\w+)"/g)].map(([, pattern, decision]) => ({
    words: [...pattern.matchAll(/token = "([^"]*)"/g)].map((match) => match[1]),
    decision,
  }));
}
function codexDecides(text, command) {
  const words = command.split(' ');
  const found = codexRules(text).filter((rule) => rule.words.every((word, i) => words[i] === word)).map((rule) => rule.decision);
  return ['forbidden', 'prompt'].find((decision) => found.includes(decision)) || 'no rule';
}
function codexHook(text, id) {
  const block = text.split('\n# ').find((part) => part.startsWith(`${ai.NAMES[id]}:`));
  return block && block.match(/command = '''(.*) '''/)[1];
}
// What Codex hands a PreToolUse hook for a patch (seen in a real run).
function runHook(command, patch) {
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'apply_patch', cwd: '/workspace',
    transcript_path: '/home/dev/.codex/sessions/2026/11/08/rollout.jsonl', tool_input: { command: patch },
  });
  return spawnSync('/bin/sh', ['-c', command], { input, encoding: 'utf8' });
}
const patch = (file, body = '+x') => `*** Begin Patch\n*** Add File: ${file}\n${body}\n*** End Patch\n`;

// ---- Gemini, as Gemini reads it: the matching rule with the highest priority wins.
function geminiRules(text) {
  return text.split(/^\[\[rule\]\]$/m).slice(1).map((part) => {
    const rule = {};
    for (const line of part.split('\n')) {
      const match = line.match(/^(\w+) = (.*)$/);
      if (match) rule[match[1]] = JSON.parse(match[2]);
    }
    return rule;
  });
}
const sorted = (value) => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value);
// The same patterns Gemini makes from commandPrefix (buildArgsPatterns in Gemini 0.67).
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const prefixPattern = (prefix) => `${escapeRegex(`"command":${JSON.stringify(prefix).slice(0, -1)}`)}(?:[\\s"]|\\\\")`;
function geminiDecides(text, name, args, mode = 'default') {
  const details = JSON.stringify(sorted(args));
  let best = { decision: 'no rule', priority: -1 };
  for (const rule of geminiRules(text)) {
    if (rule.modes && !rule.modes.includes(mode)) continue;
    if (![].concat(rule.toolName).includes(name)) continue;
    const patterns = rule.commandPrefix ? [].concat(rule.commandPrefix).map(prefixPattern) : [rule.argsPattern].filter(Boolean);
    if (patterns.length && !patterns.some((pattern) => new RegExp(pattern).test(details))) continue;
    if (rule.priority > best.priority) best = rule;
  }
  return best.decision;
}
const shell = (command) => ['run_shell_command', { command }];
// Gemini 0.67 drops a rule whose pattern fails this (isSafeRegExp).
const isSafe = (pattern) => pattern.length <= 2048 && !/\([^)]*[*+?{].*\)[*+?{]/.test(pattern);

// ---- The checks.

check('every Claude command pattern is covered, rule by rule', () => {
  for (const [id, patterns] of Object.entries(CLAUDE_PATTERNS)) {
    for (const pattern of patterns) {
      const command = pattern.match(/^Bash\((.*):\*\)$/);
      if (command) assert.ok((ai.COMMANDS[id] || []).includes(command[1]), `${id}: ${command[1]} is missing`);
    }
  }
  assert.deepStrictEqual(ai.HOME_FOLDERS, HOME_FOLDERS);
});

check('the panel can tell the truth for every rule and choice', () => {
  for (const rule of RULES) {
    const support = ai.SUPPORT[rule.id];
    assert.ok(support, `${rule.id} has no entry`);
    for (const option of rule.options) {
      for (const tool of ['claude', 'gemini', 'codex']) assert.ok(tool in (support[option] || {}), `${rule.id}.${option}.${tool}`);
    }
  }
});

check('precedence: History on Ask beats GitHub on Allow', () => {
  const rules = withRules({ github: 'allow', history: 'ask' });
  const codex = ai.codexRequirements(rules);
  assert.strictEqual(codexDecides(codex, 'git push --force origin main'), 'prompt');
  assert.strictEqual(codexDecides(codex, 'git push origin main'), 'no rule');
  const gemini = ai.geminiPolicy(rules);
  assert.strictEqual(geminiDecides(gemini, ...shell('git push --force origin main')), 'ask_user');
  assert.strictEqual(geminiDecides(gemini, ...shell('git push origin main')), 'allow');
});

check('precedence: block beats ask beats allow', () => {
  const rules = withRules({ installs: 'allow', globalInstalls: 'ask', deletes: 'block', history: 'ask' });
  const codex = ai.codexRequirements(rules);
  const gemini = ai.geminiPolicy(rules);
  assert.strictEqual(codexDecides(codex, 'npm install -g left-pad'), 'prompt');
  assert.strictEqual(geminiDecides(gemini, ...shell('npm install -g left-pad')), 'ask_user');
  assert.strictEqual(geminiDecides(gemini, ...shell('npm install left-pad')), 'allow');
  assert.strictEqual(codexDecides(codex, 'rm -rf build'), 'forbidden');
  assert.strictEqual(geminiDecides(gemini, ...shell('rm -rf build')), 'deny');
  assert.strictEqual(geminiDecides(gemini, ...shell('rmdir build')), 'deny');
  assert.strictEqual(geminiDecides(gemini, ...shell('rmx build')), 'no rule');
});

check('Codex: asks are kept, web search follows Internet', () => {
  for (const web of ['allow', 'ask', 'block']) {
    const text = ai.codexRequirements(withRules({ web }));
    assert.match(text, /^allowed_approval_policies = \["on-request"\]$/m);
    assert.match(text, web === 'allow' ? /^allowed_web_search_modes = \["cached", "indexed", "live"\]$/m : /^allowed_web_search_modes = \[\]$/m);
    assert.strictEqual(codexDecides(text, 'curl https://example.com'), { allow: 'no rule', ask: 'prompt', block: 'forbidden' }[web]);
  }
});

check('Codex: everything on Allow has no command rules and no hooks, but hooks stay on', () => {
  const text = ai.codexRequirements(everything('allow'));
  assert.ok(!text.includes('[rules]') && !text.includes('[[hooks.PreToolUse]]'));
  assert.match(text, /^\[features\]\nhooks = true$/m);
});

check('Codex: the patch hook stops changes to .github and AI settings, nothing else', () => {
  const text = ai.codexRequirements(withRules({ ci: 'ask', aiTools: 'block' }));
  const ci = codexHook(text, 'ci');
  const tools = codexHook(text, 'aiTools');
  assert.ok(ci && tools, 'both hooks are there');
  assert.strictEqual(runHook(ci, patch('.github/workflows/ci.yml')).status, 2);
  assert.strictEqual(runHook(ci, patch('/workspace/app/.gitlab-ci.yml')).status, 2);
  assert.match(runHook(ci, patch('.github/x.yml')).stderr, /GitHub Actions is set to Ask\. Codex cannot ask first/);
  assert.strictEqual(runHook(ci, patch('notes.txt', '+see .github/ for more\n+*** Add File: .github/x')).status, 0);
  assert.strictEqual(runHook(ci, patch('src/app.js')).status, 0);
  assert.strictEqual(runHook(tools, patch('.codex/config.toml')).status, 2);
  assert.strictEqual(runHook(tools, patch('/workspace/.mcp.json')).status, 2);
  assert.strictEqual(runHook(tools, patch('src/codex/app.js')).status, 0);
  assert.ok(!codexHook(ai.codexRequirements(withRules({ ci: 'allow' })), 'ci'), 'no hook on Allow');
});

check('Gemini: every pattern is one Gemini keeps', () => {
  for (const rules of [everything('allow'), everything('ask'), everything('block'), withRules({ homeFolders: 'readonly' })]) {
    for (const rule of geminiRules(ai.geminiPolicy(rules))) {
      if (!rule.argsPattern) continue;
      new RegExp(rule.argsPattern); // eslint-disable-line no-new
      assert.ok(isSafe(rule.argsPattern), `unsafe: ${rule.argsPattern}`);
    }
  }
});

check('Gemini: files, web and folders', () => {
  const text = ai.geminiPolicy(withRules({ secrets: 'ask', ci: 'block', aiTools: 'ask', outside: 'block', web: 'ask', github: 'block', homeFolders: 'readonly' }));
  assert.strictEqual(geminiDecides(text, 'read_file', { file_path: '/workspace/.env' }), 'ask_user');
  assert.strictEqual(geminiDecides(text, 'read_file', { file_path: '/workspace/.env.local' }), 'ask_user');
  assert.strictEqual(geminiDecides(text, 'read_file', { file_path: '/secrets/token' }), 'ask_user');
  assert.strictEqual(geminiDecides(text, 'read_file', { file_path: '/workspace/src/environment.js' }), 'no rule');
  assert.strictEqual(geminiDecides(text, 'write_file', { file_path: '/workspace/.github/workflows/ci.yml', content: 'x' }), 'deny');
  assert.strictEqual(geminiDecides(text, 'write_file', { file_path: '/workspace/notes.md', content: 'see .github/' }), 'no rule');
  assert.strictEqual(geminiDecides(text, 'replace', { file_path: '/workspace/.gemini/settings.json' }, 'autoEdit'), 'ask_user');
  assert.strictEqual(geminiDecides(text, 'list_directory', { dir_path: '/projects' }), 'deny');
  assert.strictEqual(geminiDecides(text, 'google_web_search', { query: 'x' }), 'ask_user');
  assert.strictEqual(geminiDecides(text, 'web_fetch', { prompt: 'read https://github.com/a/b' }), 'deny');
  assert.strictEqual(geminiDecides(text, 'web_fetch', { prompt: 'read https://example.com/github.com' }), 'ask_user');
  assert.strictEqual(geminiDecides(text, 'write_file', { file_path: '/home/dev/Documents/a.txt' }), 'deny');
});

check('Gemini: Editing on Allow skips the question, but not in plan mode', () => {
  const allow = ai.geminiPolicy(withRules({ editing: 'allow', ci: 'ask' }));
  assert.strictEqual(geminiDecides(allow, 'write_file', { file_path: '/workspace/a.js' }), 'allow');
  assert.strictEqual(geminiDecides(allow, 'write_file', { file_path: '/workspace/a.js' }, 'plan'), 'no rule');
  assert.strictEqual(geminiDecides(allow, 'write_file', { file_path: '/workspace/.github/ci.yml' }), 'ask_user');
  const ask = ai.geminiPolicy(withRules({ editing: 'ask' }));
  assert.strictEqual(geminiDecides(ask, 'write_file', { file_path: '/workspace/a.js' }), 'no rule');
});

check('Gemini settings: the blueprint\'s file is exactly geminiSettings(), with no YOLO and your folders', () => {
  const room = fs.readFileSync(path.join(__dirname, '..', '..', 'room', 'gemini-settings.json'), 'utf8');
  assert.strictEqual(room, ai.geminiSettings(), 'room/gemini-settings.json is out of step: write geminiSettings() to it');
  const settings = JSON.parse(room);
  assert.deepStrictEqual(settings.hooks, ai.EDIT_LOG_HOOKS);
  assert.strictEqual(settings.security.disableYoloMode, true);
  assert.deepStrictEqual(settings.context.includeDirectories, HOME_FOLDERS.map((name) => `/home/dev/${name}`));
});

check('every rule has the same name here as on the House Rules page', () => {
  for (const rule of RULES) assert.strictEqual(ai.NAMES[rule.id], rule.label, rule.id);
});

console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
process.exit(failed ? 1 : 0);
