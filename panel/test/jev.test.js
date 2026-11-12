// Checks lib/jev.js ("By meaning" search) against a stand-in Jev server made here, which answers the
// shape lib/jev.js sends, and once with 429 and a retry-after. The real TypeSafe is never called.
// Plain node, no packages, a made-up HOME and folder tree in the temp folder:
//   node panel/test/jev.test.js
// Exits with 1 if anything is wrong.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-test-'));
process.env.HOME = path.join(sandbox, 'home');
process.env.HOUSE_SHOTS = path.join(sandbox, 'shots'); // lets the stand-in server's address be used
fs.mkdirSync(process.env.HOME, { recursive: true });

let failed = 0;
async function check(label, test) {
  try {
    await test();
    console.log(`PASS ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${label}: ${error.message}`);
  }
}

// The stand-in server: what it was sent, how many ran at once, and what to answer.
const seen = [];
const server = { throttleOnce: true, status: 0, inFlight: 0, mostAtOnce: 0, answered429At: 0, retriedAt: 0 };
const standIn = http.createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', async () => {
    server.inFlight += 1;
    server.mostAtOnce = Math.max(server.mostAtOnce, server.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.inFlight -= 1;
    const body = JSON.parse(raw);
    seen.push({ method: request.method, url: request.url, headers: request.headers, body, raw });
    if (server.status) { response.writeHead(server.status); response.end(server.body || 'no'); return; }
    if (server.throttleOnce) {
      server.throttleOnce = false;
      server.answered429At = Date.now();
      server.throttled = raw;
      response.writeHead(429, { 'retry-after': '1' });
      response.end('slow down');
      return;
    }
    if (raw === server.throttled && !server.retriedAt) server.retriedAt = Date.now(); // the same request, again
    const text = JSON.stringify(body.state).toLowerCase();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ answers: { fit: { noul: text.includes('invoice') ? 0.9 : 0.02 } }, usage: { input_tokens: 10 } }));
  });
});

const make = (base, files) => Object.entries(files).forEach(([file, text]) => {
  fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
  fs.writeFileSync(path.join(base, file), text);
});

async function main() {
  await new Promise((resolve) => standIn.listen(0, '127.0.0.1', resolve));
  process.env.HOUSE_JEV_URL = `http://127.0.0.1:${standIn.address().port}/v1/systemone`;
  const jev = require('../lib/jev');

  const everything = async () => {};
  const token = () => ({ cancelled: false });
  const go = async (root, meaning) => {
    const found = [];
    let last = null;
    const done = await jev.run(root, meaning, false, everything, (results, progress) => { found.push(...results); last = progress; }, token());
    return { found, done, last };
  };

  await check('secret rules: names, folders, Windows', () => {
    const secret = ['/h/p/.env', '/h/p/.env.local', '/h/a/cert.pem', '/h/a/server.KEY', '/h/.ssh/config', '/h/id_rsa', '/h/id_ed25519.pub', '/h/aws-credentials.json', '/h/my_Secret_notes.txt',
      '/h/p/secrets/db.txt', '/h/.config/house/jev-key', '/h/.config/house/panel.json', '/mnt/c/Users/x/a.txt', '/mnt/d/a.txt', '/h/.netrc', '/h/.npmrc',
      '/h/.config/house/claude-token', '/h/.config/house/secrets/a/b', '/h/.local/state/house/link-token', '/h/p/.git/config', '/h/.claude/settings.json', '/h/.claude.json', '/h/.bash_history',
      '/h/p/config/secrets.yml', '/h/id_ed25519', '/h/p/api-token.txt', '/h/p/passwords.csv', '/h/.config/other/a.txt', '/proc/1/environ', '/dev/tty'];
    const fine = ['/h/p/readme.md', '/h/p/environment.txt', '/h/p/keyboard.txt', '/h/p/monkey.js', '/h/p/minutes.txt'];
    secret.forEach((file) => assert.ok(jev.isSecretPath(file), `should be secret: ${file}`));
    fine.forEach((file) => assert.ok(!jev.isSecretPath(file), `should be fine: ${file}`));
  });

  await check('request building: model, state, one noul question, long text cut', () => {
    const request = jev.buildRequest('the invoice from March', 'a/b.txt', 'hello');
    assert.strictEqual(request.model, 'jev-latest');
    assert.deepStrictEqual(request.state, { file: 'a/b.txt', start: 'hello' });
    assert.deepStrictEqual(Object.keys(request.questions), ['fit']);
    assert.strictEqual(request.questions.fit.type, 'noul');
    assert.ok(request.questions.fit.instructions.includes('the invoice from March'));
    assert.deepStrictEqual(jev.buildRequest('x', 'n.png', '').state, { file: 'n.png' });
    assert.ok(jev.buildRequest('y'.repeat(5000), 'n', '').questions.fit.instructions.length < 800);
  });

  await check('the key: saved private and atomically, page only learns yes or no', async () => {
    assert.strictEqual(await jev.keyIsSet(), false);
    await assert.rejects(() => jev.saveKey('two words'));
    await assert.rejects(() => jev.saveKey('   '));
    await jev.saveKey('  sk-test-123  ');
    assert.strictEqual(fs.statSync(jev.KEY_FILE).mode & 0o777, 0o600);
    assert.strictEqual(fs.readFileSync(jev.KEY_FILE, 'utf8'), 'sk-test-123');
    assert.ok(!fs.existsSync(`${jev.KEY_FILE}.new`));
    assert.strictEqual(await jev.keyIsSet(), true);
    assert.ok(!fs.existsSync(path.join(process.env.HOME, '.config', 'house', 'panel.json')), 'not in panel.json');
  });

  const tree = path.join(sandbox, 'tree');
  make(tree, {
    'invoice-march.txt': 'Invoice for March work',
    'notes.txt': 'shopping list',
    'photo.png': 'PNGDATA',
    'deep/er/invoice-old.md': 'old invoice',
    '.env': 'TOKEN=hunter2',
    'config.key': 'KEYDATA',
    'id_rsa': 'RSADATA',
    'aws-credentials.json': '{"k":1}',
    'my-secret-plan.txt': 'plan',
    'secrets/db.txt': 'DBPASSWORD',
    '.ssh/known': 'SSHDATA',
    'leaky.txt': '-----BEGIN RSA PRIV' + 'ATE KEY-----\nabc',
    'big.txt': 'x'.repeat(2 * 1024 * 1024),
    // Keys inside ordinary-looking files, past the first line and past the part that would be sent.
    'ssh-notes.txt': `my notes\n${'word '.repeat(400)}\n${'-----BEGIN OPENSSH PRIV' + 'ATE KEY-----'}\nOPENSSHDATA`,
    'claude-notes.txt': 'todo\n' + 'sk-ant-' + 'api03-AbCdEfGhIjKlMnOpQrStUv\n',
    'github-notes.md': 'todo\nuse ' + 'ghp_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\n',
    'aws-notes.txt': 'todo\n' + 'AKIA' + 'IOSFODNN7EXAMPLE\n',
    'settings.yml': 'name: app\npassword: hunter2hunter2\n',
    'remote.txt': 'origin\nhttps://alex:GITPASSWORD@github.com/x/y.git\n',
    '.npmrc': '//registry.npmjs.org/:_authToken=NPMTOKEN',
    '.git/config': '[remote]\nurl = https://u:GITCONFIGPASS@github.com/x/y',
    'config/secrets.yml': 'YMLSECRET',
    'key/id_ed25519': 'EDDATA',
    'certs/site.pem': 'PEMDATA',
    '.env.local': 'LOCALENV',
  });
  // Hidden files shown, a folder opened through a link, and a pipe that would hang if opened.
  fs.symlinkSync(path.join(tree, 'secrets'), path.join(sandbox, 'innocent'));
  require('child_process').execFileSync('mkfifo', [path.join(tree, 'pipe.txt')]);

  await check('keys and passwords never leave: by name, by place, by what the file holds, hidden files shown or not', async () => {
    seen.length = 0;
    server.throttleOnce = false;
    for (const showHidden of [false, true]) {
      await jev.run(tree, 'invoice', showHidden, everything, () => {}, token());
      await jev.run(path.join(sandbox, 'innocent'), 'invoice', showHidden, everything, () => {}, token());
      await jev.run(path.join(tree, '.git'), 'invoice', showHidden, everything, () => {}, token());
    }
    const sent = seen.map((entry) => entry.raw).join('\n');
    for (const never of ['OPENSSHDATA', 'BEGIN OPENSSH', 'sk-ant', 'ghp_', 'AKIA', 'hunter2', 'GITPASSWORD', 'NPMTOKEN', 'GITCONFIGPASS', 'YMLSECRET', 'EDDATA', 'PEMDATA', 'LOCALENV', 'DBPASSWORD', 'npmrc', 'id_ed25519', 'pipe.txt', 'sk-test-123']) assert.ok(!sent.includes(never), `sent ${never}`);
    assert.ok(sent.includes('Invoice for March work'), 'ordinary files still go');
    server.throttleOnce = true;
    seen.length = 0;
  });

  await check('a search sends only safe files, with the key as Bearer, retries a 429 after retry-after, and sorts by closeness', async () => {
    const { found, done, last } = await go(tree, 'invoice');
    const sent = seen.map((entry) => entry.raw).join('\n');
    for (const never of ['hunter2', 'KEYDATA', 'RSADATA', 'DBPASSWORD', 'SSHDATA', 'config.key', 'id_rsa', 'aws-credentials', 'my-secret-plan', '.env', 'BEGIN RSA', 'leaky']) assert.ok(!sent.includes(never), `sent ${never}`);
    assert.ok(seen.every((entry) => entry.method === 'POST' && entry.headers.authorization === 'Bearer sk-test-123' && entry.headers['content-type'] === 'application/json'));
    assert.ok(sent.includes('Invoice for March work'), 'text start sent');
    assert.ok(!sent.includes('xxxxxxxxxxxxxxxxxxxx'), 'a file over 1 MB goes by name only');
    assert.ok(sent.includes('big.txt'));
    assert.deepStrictEqual(found.map((entry) => entry.name).sort(), ['invoice-march.txt', 'invoice-old.md']);
    assert.ok(found.every((entry) => entry.score === 0.9 && typeof entry.where === 'string'));
    assert.ok(server.retriedAt - server.answered429At >= 900, `waited ${server.retriedAt - server.answered429At} ms`);
    assert.strictEqual(done.checked, last.total);
    assert.ok(server.mostAtOnce <= 8 && server.mostAtOnce > 1, `at once: ${server.mostAtOnce}`);
  });

  await check('at most 300 files are judged', async () => {
    const big = path.join(sandbox, 'many');
    for (let i = 0; i < 350; i += 1) make(big, { [`d${i % 7}/f${i}.txt`]: `file ${i}` });
    seen.length = 0;
    const { done } = await go(big, 'anything');
    assert.strictEqual(seen.length, 300);
    assert.ok(done.limited);
  });

  await check('a refused key says so in plain words, and stops', async () => {
    server.status = 401;
    seen.length = 0;
    await assert.rejects(() => go(tree, 'invoice'), (error) => error.kind === 'key' && /key/.test(error.message) && /waitlist/.test(error.message));
    assert.ok(seen.length <= 8, `kept asking: ${seen.length}`);
    server.status = 0;
  });

  await check('an empty balance says so plainly and stops, whether it comes as 402 or as a refusal that names it', async () => {
    try {
      for (const [status, body] of [[402, 'Payment required'], [429, '{"error":"Insufficient balance"}'], [403, 'Your credit has run out']]) {
        server.status = status;
        server.body = body;
        await new Promise((done) => setTimeout(done, 300)); // requests the last round let go may still be arriving
        seen.length = 0;
        await assert.rejects(() => go(tree, 'invoice'), (error) => error.kind === 'balance' && /balance has run out/.test(error.message));
        assert.ok(seen.length <= 8, `kept asking after ${status}: ${seen.length}`);
      }
    } finally {
      await new Promise((done) => setTimeout(done, 300)); // the same, so the next check counts only its own
      server.status = 0;
      server.body = '';
    }
  });

  await check('no key: asks for one, sends nothing', async () => {
    await jev.removeKey();
    seen.length = 0;
    await assert.rejects(() => go(tree, 'invoice'), (error) => error.kind === 'key');
    assert.strictEqual(seen.length, 0);
    await jev.saveKey('sk-test-123');
  });

  await check('Windows is never searched', async () => {
    await assert.rejects(() => go('/mnt/c/Users', 'invoice'), /Windows/);
  });

  await check('cancelling sends no more requests', async () => {
    seen.length = 0;
    const stopper = token();
    const going = jev.run(path.join(sandbox, 'many'), 'anything', false, everything, () => {}, stopper);
    await new Promise((resolve) => setTimeout(resolve, 120));
    stopper.cancelled = true;
    stopper.stop?.();
    await going;
    const atStop = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(atStop < 300 && seen.length <= atStop + 8, `${atStop} then ${seen.length}`);
  });

  await check('no internet is said plainly', async () => {
    await new Promise((resolve) => standIn.close(resolve));
    await assert.rejects(() => go(tree, 'invoice'), (error) => error.kind === 'offline' && /internet/.test(error.message));
  });

  fs.rmSync(sandbox, { recursive: true, force: true }); // only the made-up folders this test just made
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
}

main();
