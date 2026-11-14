// Station's own code must never delete a project's Claude volume (house-claude-*: chat history,
// sign-in). An automatic clean-up that did so wiped real chat histories twice (Nov 2026).
// Run with: node panel/test/keep-ai-history.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const panel = path.join(__dirname, '..');
const files = [path.join(panel, 'main.js'), path.join(panel, '..', 'bin', 'room')]
  .concat(fs.readdirSync(path.join(panel, 'lib')).filter((f) => f.endsWith('.js')).map((f) => path.join(panel, 'lib', f)));
// 'volume', 'rm' (execFile style) or "volume rm" / "volume prune" (shell style).
const deletes = /['"]volume['"]\s*,\s*['"](rm|remove|prune)['"]|\bvolume\s+(rm|remove|prune)\b/;
for (const file of files) {
  const hit = fs.readFileSync(file, 'utf8').split('\n').find((line) => deletes.test(line) && !/^\s*(\/\/|#)/.test(line));
  assert.ok(!hit, `${path.relative(panel, file)} deletes a Docker volume: ${hit && hit.trim()}`);
}
assert.ok(!deletes.test("run('docker', ['volume', 'ls'])"), 'listing is fine');
assert.ok(deletes.test("run('docker', ['volume', 'rm', v])"), 'the old clean-up line is caught');
console.log(`PASS no code deletes a project's Claude volume (${files.length} files)`);
