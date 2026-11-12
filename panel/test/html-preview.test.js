// Checks the local page server behind "Open in Web Browser" (lib/html-preview.js): what it serves
// and what it refuses. Plain node:  node panel/test/html-preview.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const htmlPreview = require('../lib/html-preview');

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
const get = (url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  http.request(url, { method, headers }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
  }).on('error', reject).end();
});

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'html-preview-test-')));
const site = path.join(root, 'site');
fs.mkdirSync(path.join(site, 'img'), { recursive: true });
fs.mkdirSync(path.join(site, '.git'));
fs.writeFileSync(path.join(site, 'page.html'), '<link rel="stylesheet" href="style.css">hi');
fs.writeFileSync(path.join(site, 'style.css'), 'body{color:red}');
fs.writeFileSync(path.join(site, 'img', 'a.png'), 'png');
fs.writeFileSync(path.join(site, 'notes.pdf'), 'pdf');
fs.writeFileSync(path.join(site, 'notes.txt'), 'txt');
fs.writeFileSync(path.join(site, 'data.json'), '{}');
fs.writeFileSync(path.join(site, '.git', 'config.css'), 'secret');
fs.writeFileSync(path.join(site, '.env.css'), 'secret');
fs.writeFileSync(path.join(root, 'outside.css'), 'outside');
fs.symlinkSync(path.join(root, 'outside.css'), path.join(site, 'link.css'));

(async () => {
  const url = await htmlPreview.urlFor(path.join(site, 'page.html'));
  const base = url.replace(/page\.html$/, '');
  await check('the address is local, under a secret path', () => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/page\.html$/);
  });
  await check('the page and its CSS and pictures load', async () => {
    assert.strictEqual((await get(url)).type, 'text/html; charset=utf-8');
    assert.strictEqual((await get(`${base}style.css`)).body, 'body{color:red}');
    assert.strictEqual((await get(`${base}img/a.png`)).status, 200);
  });
  await check('the same folder keeps one address', async () => {
    assert.strictEqual(await htmlPreview.urlFor(path.join(site, 'page.html')), url);
  });
  await check('refused: other types, dotfiles, links out, folders, wrong secret, other methods', async () => {
    assert.strictEqual((await get(`${base}notes.pdf`)).status, 404);
    assert.strictEqual((await get(`${base}notes.txt`)).status, 404);
    assert.strictEqual((await get(`${base}data.json`)).status, 404);
    assert.strictEqual((await get(`${base}.git/config.css`)).status, 404);
    assert.strictEqual((await get(`${base}.env.css`)).status, 404);
    assert.strictEqual((await get(`${base}link.css`)).status, 404);
    assert.strictEqual((await get(`${base}img`)).status, 404);
    assert.strictEqual((await get(`${base}..%2Foutside.css`)).status, 404);
    assert.strictEqual((await get(`${base}%2e%2e/outside.css`)).status, 404);
    assert.strictEqual((await get(url.replace(/\/[0-9a-f]{32}\//, `/${'0'.repeat(32)}/`))).status, 404);
    assert.strictEqual((await get(url, {}, 'POST')).status, 405);
  });
  await check('refused: a name other than 127.0.0.1 (DNS rebinding)', async () => {
    assert.strictEqual((await get(url, { Host: 'evil.example' })).status, 403);
  });
  await check('every response carries the CSP that blocks other sites', async () => {
    const res = await new Promise((resolve) => http.get(url, resolve));
    assert.match(res.headers['content-security-policy'], /default-src 'self'.*form-action 'self'/);
    res.resume();
  });
  await check('a page in the home folder or a whole drive is refused', async () => {
    const home = path.join(os.homedir(), `.html-preview-test-${process.pid}.html`);
    fs.writeFileSync(home, '<p>');
    try { await assert.rejects(htmlPreview.urlFor(home), /too much/); } finally { fs.rmSync(home); }
    assert.ok(htmlPreview.tooBroad('/') && htmlPreview.tooBroad('/mnt/c') && htmlPreview.tooBroad('/mnt/c/Users/me') && htmlPreview.tooBroad(os.homedir()));
    assert.ok(!htmlPreview.tooBroad('/mnt/c/Users/me/Downloads') && !htmlPreview.tooBroad(path.join(os.homedir(), 'Downloads')));
  });
  await check('only .html files are opened', async () => {
    await assert.rejects(htmlPreview.urlFor(path.join(site, 'style.css')), /web page/);
    await assert.rejects(htmlPreview.urlFor(path.join(site, 'nope.html')));
  });
  fs.rmSync(root, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : 'All passed');
  process.exit(failed ? 1 : 0);
})();
