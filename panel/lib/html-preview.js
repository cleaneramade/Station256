// "Open in Web Browser" for an .html file: a tiny local web server that serves the file's folder, so
// its CSS, scripts and pictures load as they would on a real site (never file:). Only on 127.0.0.1,
// only under a secret random path, only web-type files (no keys, documents or dotfiles), and nothing
// outside the folder. It is not one of a room's ports, so the AI's browser wall (lib/ai-browser.js)
// never lets an AI page reach it.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { Readable } = require('stream');
const files = require('./files');

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', // no txt, json, xml: a page could read notes or keys beside it
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
};

// The page may not load from, or send to, any other site. So CDN scripts, fonts and pictures won't
// load in this preview: it is for checking a local page, not a live one.
const CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; form-action 'self'; base-uri 'self'";
// Folders too broad to serve: /, the home folder, a Windows drive (/mnt/c) or a Windows profile (/mnt/c/Users/me).
const tooBroad = (dir) => dir === '/' || dir === os.homedir() || /^\/mnt\/[^/]+(\/Users\/[^/]+)?$/i.test(dir);

const folders = new Map(); // secret → the folder it opens
const secrets = new Map(); // folder → its secret, so a folder keeps one address
let server = null;
let port = 0;

const typeOf = (name) => TYPES[path.extname(name).slice(1).toLowerCase()] || null;

async function handle(request, response) {
  const deny = (code) => { response.writeHead(code, { 'Content-Type': 'text/plain' }); response.end('Not available'); };
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') return deny(405);
    if (request.headers.host !== `127.0.0.1:${port}`) return deny(403); // a name pointed at us (DNS rebinding) is refused
    const parts = new URL(request.url, 'http://x').pathname.split('/').slice(1).map(decodeURIComponent);
    const root = folders.get(parts[0]);
    const rest = parts.slice(1);
    if (!root || !rest.length || rest.some((part) => !part || part === '..' || part.startsWith('.') || /[\/\0]/.test(part))) return deny(404);
    const type = typeOf(rest[rest.length - 1]);
    if (!type) return deny(404);
    const target = path.join(root, ...rest);
    const real = await fs.promises.realpath(target);
    if (!real.startsWith(`${root}${path.sep}`)) return deny(404); // a link out of the folder
    await files.assertReadable(real);
    const info = await fs.promises.stat(real);
    if (!info.isFile()) return deny(404);
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP });
    if (request.method === 'HEAD') return response.end();
    return Readable.from(fs.createReadStream(real)).pipe(response);
  } catch {
    return deny(404);
  }
}

// The address of this page, starting the server the first time. Throws a plain message if it can't.
async function urlFor(file) {
  if (!/\.html?$/i.test(file)) throw new Error('That isn\'t a web page.');
  await files.assertReadable(file);
  const real = await fs.promises.realpath(file);
  if (!(await fs.promises.stat(real)).isFile()) throw new Error('That isn\'t a file.');
  if (!server) {
    server = http.createServer(handle);
    server.unref();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port: 0, host: '127.0.0.1' }, resolve);
    }).catch((error) => { server = null; throw error; });
    port = server.address().port;
  }
  const root = path.dirname(real);
  if (tooBroad(root)) throw new Error('This page is in a folder that holds too much (your home folder or a whole drive). Move it into its own folder, such as Downloads or a project, and try again.');
  if (!secrets.has(root)) {
    const secret = crypto.randomBytes(16).toString('hex');
    secrets.set(root, secret);
    folders.set(secret, root);
  }
  return `http://127.0.0.1:${port}/${secrets.get(root)}/${encodeURIComponent(path.basename(real))}`;
}

module.exports = { urlFor, typeOf, tooBroad };
