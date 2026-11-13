// Which AI tools the rooms have (lib/ai-tools.js). Run: node panel/test/ai-tools.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-'));
const aiTools = require('../lib/ai-tools');

assert.strictEqual(aiTools.chosen(), null, 'nothing is chosen until you choose');
assert.strictEqual(aiTools.overview().chosen, null);
assert.strictEqual(aiTools.overview().tools.length, 3);

aiTools.set(['codex', 'claude'], { build: false });
assert.deepStrictEqual(aiTools.chosen(), ['claude', 'codex'], 'saved in a fixed order');
assert.strictEqual(fs.readFileSync(path.join(process.env.HOME, '.config', 'house', 'ai-tools'), 'utf8'), 'claude,codex\n', 'the file bin/room reads');

aiTools.set([], { build: false });
assert.deepStrictEqual(aiTools.chosen(), [], 'choosing none is a choice');

assert.throws(() => aiTools.set(['claude', 'bogus'], { build: false }), /not one of the AI tools/, 'an unknown name is refused');
assert.throws(() => aiTools.set('claude', { build: false }), /not one of the AI tools/, 'a list is needed');
assert.deepStrictEqual(aiTools.chosen(), [], 'a refused choice changes nothing');

// the blueprint and the room command only install what is chosen
const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'room', 'Dockerfile'), 'utf8');
assert.ok(/ARG AI_TOOLS/.test(dockerfile) && !/^RUN curl -fsSL https:\/\/claude\.ai\/install\.sh/m.test(dockerfile), 'Claude is installed only when chosen');
assert.ok(!/npm install -g[^\n]*@openai\/codex@[^\n]*\n/.test(dockerfile.replace(/\$pkgs/g, '')) || /case ",\$AI_TOOLS,"/.test(dockerfile), 'Codex and Gemini only when chosen');
console.log('PASS ai-tools: 8 checks');
