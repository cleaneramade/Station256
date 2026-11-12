// Local AI: runs a model on this computer with llama.cpp's own server program (llama-server) and
// chats with it. Station 256 doesn't bundle llama.cpp: it looks for llama-server (on PATH,
// ~/.local/bin, ~/llama.cpp/build/bin, or a path written in ~/.config/house/llama.json).
//
// The panel's page can't talk to localhost itself (its security policy allows only its own files),
// so everything runs here and the page is told over channels: llama:status (the server) and
// llama:chat (a reply as it's written). Only one server runs at a time, and it only ever listens on
// 127.0.0.1. It is stopped when Station 256 closes. Windows can reach the house's 127.0.0.1, so
// each start gets a fresh key (handed over in LLAMA_API_KEY, out of sight of ps and the log) and
// the server answers only Station.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const { constants } = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CONFIG = path.join(HOME, '.config', 'house', 'llama.json');
const PROGRAM = 'llama-server';
const PLACES = [path.join(HOME, '.local', 'bin'), path.join(HOME, 'llama.cpp', 'build', 'bin')];
const MODEL_FOLDERS = ['models', 'Downloads', 'projects'].map((name) => path.join(HOME, name));
const SKIP = new Set(['node_modules', '.git']);
const SCAN_DEPTH = 2; // folders below the ones above
const SCAN_FOLDERS = 400; // the most folders looked into, so a huge tree can't make this slow
const SCAN_MODELS = 200;
const SCAN_MS = 2000; // and the longest it looks, for a slow disk
const LOG_LINES = 20;
const HEALTH_MS = 500;
const STOP_WAIT_MS = 4000;
const BATCH_MS = 40; // reply text is sent this often, not once per word
const MAX_MESSAGES = 400;
const ALL_LAYERS = 99; // more than any small model has, so every layer goes on the card

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/* ---------- Settings: ~/.config/house/llama.json ---------- */

async function readConfig() {
  try {
    const value = JSON.parse(await fs.readFile(CONFIG, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// Written beside it and renamed over it, so a cut-off write never leaves half a file.
let saving = Promise.resolve();
function saveConfig(changes) {
  saving = saving.then(async () => {
    const next = { ...await readConfig(), ...changes };
    await fs.mkdir(path.dirname(CONFIG), { recursive: true });
    const temp = `${CONFIG}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
    await fs.rename(temp, CONFIG);
    return next;
  });
  saving = saving.catch(() => {});
  return saving;
}

/* ---------- Finding llama-server ---------- */

async function runnable(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    await fs.access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findProgram() {
  const config = await readConfig();
  const folders = [...String(process.env.PATH || '').split(':').filter(Boolean), ...PLACES];
  const candidates = [];
  if (typeof config.server === 'string' && path.isAbsolute(config.server)) candidates.push(config.server);
  for (const folder of folders) candidates.push(path.join(folder, PROGRAM));
  for (const file of candidates) if (await runnable(file)) return file;
  return null;
}

/* ---------- Finding models ---------- */

// .gguf files in the usual places, two folders deep at most. Looks at a limited number of folders,
// for a limited time. A shortcut to a folder is never followed (so no going round in circles); a
// shortcut to a model file counts, since downloaders often leave those.
async function findModels() {
  const found = [];
  let looked = 0;
  const until = Date.now() + SCAN_MS;
  async function look(folder, depth) {
    if (looked >= SCAN_FOLDERS || found.length >= SCAN_MODELS || Date.now() > until) return;
    looked += 1;
    let entries;
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    const below = [];
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if ((entry.isFile() || entry.isSymbolicLink()) && /\.gguf$/i.test(entry.name)) {
        if (found.length >= SCAN_MODELS) break;
        try {
          const stat = await fs.stat(full);
          if (stat.isFile()) found.push({ path: full, name: entry.name, size: stat.size });
        } catch { /* gone meanwhile */ }
      } else if (entry.isDirectory() && depth < SCAN_DEPTH && !SKIP.has(entry.name)) {
        below.push(full);
      }
    }
    for (const next of below) await look(next, depth + 1);
  }
  for (const folder of MODEL_FOLDERS) await look(folder, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// A model the person typed or picked: checked before it's used.
async function modelInfo(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.gguf$/i.test(file)) throw new Error('That isn\'t a .gguf model file.');
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new Error('That model file isn\'t there.');
  }
  if (!stat.isFile()) throw new Error('That model file isn\'t there.');
  return { path: file, name: path.basename(file), size: stat.size };
}

/* ---------- The server ---------- */

let server = null; // { child, port, model, status, log, stopping }
let tell = () => {};
let last = { status: 'stopped' }; // what the page is shown when it asks

function publish(extra = {}) {
  last = { status: server ? server.status : (last.status === 'crashed' ? 'crashed' : 'stopped'), ...extra };
  if (server) {
    last.port = server.port;
    last.model = server.model;
  }
  tell(last);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const whole = (value, low, high, fallback) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallback;
};

async function start({ model, context, layers } = {}) {
  if (server) throw new Error('The model is already running.');
  const info = await modelInfo(model);
  const program = await findProgram();
  if (!program) throw new Error('llama-server isn\'t installed yet.');
  const ctx = whole(context, 256, 1048576, 4096);
  // All of the model on the graphics card unless asked otherwise: about 6x faster on an NVIDIA build,
  // and a CPU-only build just ignores it.
  const ngl = whole(layers, 0, 999, ALL_LAYERS);
  const port = await freePort();
  if (server) throw new Error('The model is already running.'); // asked twice at once
  const run = { child: null, port, model: info, status: 'loading', log: [], stopping: false, partial: '' };
  server = run;
  saveConfig({ model: info.path, context: ctx, layers: ngl }).catch(() => {});
  const args = ['-m', info.path, '--host', '127.0.0.1', '--port', String(port), '-c', String(ctx), '-ngl', String(ngl)];
  run.key = crypto.randomBytes(24).toString('hex');
  const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LLAMA_API_KEY: run.key } });
  run.child = child;
  run.guard = child.pid ? guard(child.pid) : null;
  const keep = (chunk) => {
    const lines = (run.partial + chunk.toString()).split(/\r?\n/);
    run.partial = lines.pop();
    for (const line of lines) if (line.trim()) run.log.push(line);
    if (run.log.length > LOG_LINES * 3) run.log.splice(0, run.log.length - LOG_LINES * 3);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let ended = false;
  const finish = (why) => {
    if (ended) return;
    ended = true;
    if (run.partial.trim()) run.log.push(run.partial);
    const wasStopped = run.stopping;
    if (server === run) server = null;
    try { run.guard?.kill('SIGKILL'); } catch { /* already gone */ }
    run.status = wasStopped ? 'stopped' : 'crashed';
    last = { status: run.status };
    if (!wasStopped) last.log = run.log.slice(-LOG_LINES).concat(why ? [why] : []).slice(-LOG_LINES).join('\n');
    tell(last);
  };
  child.once('error', (error) => finish(`Couldn't start: ${error.message}`));
  child.once('exit', (code, signal) => finish(signal ? `Ended by ${signal}.` : `Ended with code ${code}.`));
  publish();
  watchHealth(run).catch(() => {});
  return last;
}

// If Station 256 is ended the hard way (no chance to tidy up), the model would be left running and
// holding its memory. So a tiny helper waits on a pipe from us: the pipe closes whenever this program
// is gone, however that happened, and the helper then ends the model. The helper is ended as soon as
// the model stops, so it can never end some other program that later got the same number.
function guard(pid) {
  try {
    const helper = spawn('/bin/sh', ['-c', 'cat >/dev/null; kill -9 "$1" 2>/dev/null', 'sh', String(pid)], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    helper.once('error', () => {});
    helper.stdin.once('error', () => {});
    helper.unref();
    return helper;
  } catch {
    return null;
  }
}

// Asks /health until the model is loaded (503 while loading, 200 when ready).
async function watchHealth(run) {
  while (server === run && run.status === 'loading') {
    try {
      const reply = await fetch(`http://127.0.0.1:${run.port}/health`, { signal: AbortSignal.timeout(2000) });
      if (reply.status === 200 && server === run) {
        run.status = 'ready';
        publish();
        return;
      }
    } catch { /* not listening yet */ }
    await wait(HEALTH_MS);
  }
}

// Stops the one server we started, by its own process, and nothing else.
async function stop() {
  const run = server;
  if (!run) return last;
  run.stopping = true;
  const gone = new Promise((done) => { run.child.once('exit', done); run.child.once('error', done); });
  run.child.kill('SIGTERM');
  const timer = setTimeout(() => { try { run.child.kill('SIGKILL'); } catch { /* already gone */ } }, STOP_WAIT_MS);
  await gone;
  clearTimeout(timer);
  return last;
}

// For closing Station 256: no waiting, and nothing left running.
function stopNow() {
  for (const chat of chats.values()) chat.abort.abort();
  if (!server) return;
  server.stopping = true;
  try { server.child.kill('SIGKILL'); } catch { /* already gone */ }
}

/* ---------- Chat ---------- */

const chats = new Map(); // id -> { abort }

function cleanMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Nothing to send.');
  // A very long chat sends only its newest part, rather than refusing.
  return messages.slice(-MAX_MESSAGES).map((message) => {
    const role = ['user', 'assistant', 'system'].includes(message?.role) ? message.role : 'user';
    return { role, content: String(message?.content ?? '') };
  });
}

// Sends the conversation and passes the reply on as it arrives: send({ id, text }) now and then,
// then send({ id, done: true, tokens, perSecond }) or send({ id, error }). Resolves when it ends.
async function chat(id, messages, send) {
  const body = cleanMessages(messages);
  const run = server;
  if (!run || run.status !== 'ready') throw new Error('The model isn\'t ready.');
  if (chats.has(id)) throw new Error('That reply is already being written.');
  const abort = new AbortController();
  chats.set(id, { abort });
  let pending = '';
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (pending) send({ id, text: pending });
    pending = '';
  };
  let tokens = 0;
  let timings = null;
  let began = 0;
  try {
    const reply = await fetch(`http://127.0.0.1:${run.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${run.key}` },
      body: JSON.stringify({ messages: body, stream: true }),
      signal: abort.signal,
    });
    if (!reply.ok) {
      let why = '';
      try { why = JSON.parse(await reply.text())?.error?.message || ''; } catch { /* not JSON */ }
      throw new Error(why || `The model said no (${reply.status}).`);
    }
    const decoder = new TextDecoder();
    let rest = '';
    for await (const piece of reply.body) {
      rest += decoder.decode(piece, { stream: true });
      const lines = rest.split('\n');
      rest = lines.pop();
      for (const line of lines) {
        // Older llama.cpp reports a problem on an "error:" line instead of a "data:" one.
        const failed = line.startsWith('error:');
        if (!failed && !line.startsWith('data:')) continue;
        const data = line.slice(failed ? 6 : 5).trim();
        if (!data || data === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (failed) parsed = { error: parsed?.error || parsed };
        // The server can give up partway through and say why.
        if (parsed?.error) throw new Error(String(parsed.error.message || 'The model had a problem.'));
        if (parsed?.timings) timings = parsed.timings;
        const text = parsed?.choices?.[0]?.delta?.content;
        if (typeof text === 'string' && text) {
          if (!began) began = Date.now();
          tokens += 1;
          pending += text;
          if (!timer) timer = setTimeout(flush, BATCH_MS);
        }
      }
    }
    flush();
    // The server's own speed when it gives one; otherwise our count of pieces over the time taken.
    let perSecond = Number(timings?.predicted_per_second);
    if (!(perSecond > 0)) {
      const seconds = (Date.now() - began) / 1000;
      perSecond = began && tokens > 1 && seconds > 0 ? (tokens - 1) / seconds : 0;
    }
    const counted = Number(timings?.predicted_n) > 0 ? Number(timings.predicted_n) : tokens;
    send({ id, done: true, tokens: counted, perSecond: Math.round(perSecond * 10) / 10 });
  } catch (error) {
    flush();
    if (abort.signal.aborted) send({ id, done: true, stopped: true });
    else send({ id, error: server === run && !/fetch failed|terminated|closed/i.test(String(error.message)) ? String(error.message || error) : 'The model stopped.' });
  } finally {
    clearTimeout(timer);
    chats.delete(id);
  }
}

function stopChat(id) {
  chats.get(id)?.abort.abort();
}

/* ---------- What the page asks ---------- */

async function overview() {
  const [program, models, config] = await Promise.all([findProgram(), findModels(), readConfig()]);
  let remembered = null;
  if (typeof config.model === 'string') remembered = await modelInfo(config.model).catch(() => null);
  if (remembered && !models.some((model) => model.path === remembered.path)) models.unshift(remembered);
  return {
    program,
    models,
    model: remembered ? remembered.path : null,
    context: whole(config.context, 256, 1048576, 4096),
    layers: whole(config.layers, 0, 999, ALL_LAYERS),
    state: last,
  };
}

module.exports = {
  onStatus: (callback) => { tell = callback; },
  overview, modelInfo, start, stop, stopNow, chat, stopChat,
  status: () => last,
  // For tests: where the settings file is.
  CONFIG,
};
