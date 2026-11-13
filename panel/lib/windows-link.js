// The live link to the Windows helper, for everything snapping needs from Windows. The house listens
// on its own localhost, Windows connects, and a secret kept in the house proves it's the helper.
// Rooms can't reach it: the room firewall blocks them from the house.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// A test copy of the panel, running beside the real one, uses its own port (HOUSE_LINK_PORT).
const PORT = Number(process.env.HOUSE_LINK_PORT) || 47256;
const STATE = path.join(os.homedir(), '.local', 'state', 'house');
let client = null;
let nextId = 1;
const waiting = new Map();
const progress = new Map();

function send(message) {
  if (client) client.write(`${JSON.stringify(message)}\n`);
}

function start(onEvent) {
  const secret = crypto.randomBytes(32).toString('hex');
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    let proven = false;
    // A line can be big (a pasted picture is several MB), so each chunk is searched for line ends
    // once, and the pieces of a line are only joined when it's whole.
    let pieces = [];
    socket.on('data', (chunk) => {
      const lines = [];
      let start = 0;
      let end = chunk.indexOf(10);
      while (end >= 0) {
        pieces.push(chunk.subarray(start, end));
        lines.push(Buffer.concat(pieces).toString('utf8'));
        pieces = [];
        start = end + 1;
        end = chunk.indexOf(10, start);
      }
      if (start < chunk.length) pieces.push(chunk.subarray(start));
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line.replace(/^﻿/, ''));
        } catch {
          continue;
        }
        if (!proven) {
          if (message.token !== secret) {
            socket.destroy();
            return;
          }
          proven = true;
          if (client) client.destroy();
          client = socket;
          onEvent({ type: 'connected' });
        } else if (message.type === 'reply') {
          const done = waiting.get(message.id);
          if (done) done(message);
          waiting.delete(message.id);
          progress.delete(message.id);
        } else if (message.type === 'copy-progress') {
          progress.get(message.id)?.(Number(message.done) || 0);
        } else {
          onEvent(message);
        }
      }
    });
    const gone = () => {
      if (client !== socket) return;
      client = null;
      // Nothing it was asked will be answered now, so nobody waits for it.
      for (const done of waiting.values()) done(null);
      waiting.clear();
      progress.clear();
    };
    socket.on('close', gone);
    socket.on('error', gone);
  });
  // Another copy of the app, such as a test, already has the port. This one just goes without.
  server.on('error', () => {});
  server.listen(PORT, '127.0.0.1', () => {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(path.join(STATE, 'link-token'), secret, { mode: 0o600 });
  });
}

// Asks the helper something and waits for its answer. Without the helper, or if it doesn't answer
// in time, the answer is the fallback.
// onProgress, if given, hears how far along a long job is.
function ask(message, fallback, ms, onProgress) {
  return new Promise((resolve) => {
    if (!client) {
      resolve(fallback);
      return;
    }
    const id = nextId;
    nextId += 1;
    if (onProgress) progress.set(id, onProgress);
    const timer = setTimeout(() => {
      waiting.delete(id);
      progress.delete(id);
      resolve(fallback);
    }, ms);
    waiting.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply || fallback);
    });
    send({ ...message, id });
  });
}

// The helper's list of open Windows apps. Without the helper, it's simply empty.
const list = (pictures) => ask({ op: 'list', pictures: Boolean(pictures) }, { Windows: [] }, 3000);

// A house path the way Windows reaches it. Something on the C: drive (the unlocked Windows door) is
// simply its own C:\ path.
function forWindows(file) {
  const { DOOR } = require('./files');
  if (file === DOOR || file.startsWith(`${DOOR}/`)) return `C:${file.slice(DOOR.length).replace(/\//g, '\\') || '\\'}`;
  return `\\\\wsl.localhost\\${process.env.WSL_DISTRO_NAME || 'Ubuntu'}${file.replace(/\//g, '\\')}`;
}

// Puts what was copied in the house on Windows' clipboard too: { text }, or { files, move } with
// house paths. Without the helper the copy still works inside the house, so nothing is waited on
// for long and a missing answer is no error.
function setClipboard({ text, files, move } = {}) {
  if (Array.isArray(files)) {
    const targets = files.filter((file) => typeof file === 'string' && file.startsWith('/') && !file.includes('\n')).map(forWindows);
    if (targets.length) return ask({ op: 'clipboard-set', files: targets, move: Boolean(move) }, null, 5000);
  } else if (typeof text === 'string' && text) {
    return ask({ op: 'clipboard-set', text }, null, 5000);
  }
  return Promise.resolve(null);
}

// Lock is on and the house's copy reached Windows anyway (WSLg passes text on by itself): Windows
// drops it again, but only if it still holds exactly that text, so a newer copy there stays.
function clearClipboard(text) {
  return typeof text === 'string' && text ? ask({ op: 'clipboard-clear', text }, null, 5000) : Promise.resolve(null);
}

const connected = () => Boolean(client);

// The files copied in Windows File Explorer right now, as Windows paths.
async function clipboardFiles() {
  const reply = await ask({ op: 'clipboard-files' }, null, 6000);
  if (!reply) throw new Error('Windows didn\'t answer. Please try pasting again.');
  return Array.isArray(reply.files) ? reply.files.map(String) : [];
}

// The picture copied in Windows right now, as PNG bytes. Null when there's none anymore, or no
// helper to ask.
const PNG_START = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
async function clipboardImage() {
  const reply = await ask({ op: 'clipboard-image' }, null, 15000);
  if (!reply || typeof reply.png !== 'string' || !reply.png) return null;
  const png = Buffer.from(reply.png, 'base64');
  return png.length > 8 && png.subarray(0, 8).equals(PNG_START) ? png : null;
}

function move(id, box, focus) {
  if (![id, box.x, box.y, box.w, box.h].every(Number.isFinite)) throw new Error('Not a valid window position.');
  send({ op: 'move', id, x: box.x, y: box.y, w: box.w, h: box.h, focus: Boolean(focus) });
}

function watch(box) {
  if (!box) send({ op: 'unwatch' });
  else send({ op: 'watch', x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) });
}

function seam(edge, at) {
  if (['left', 'right', 'top', 'bottom'].includes(edge) && Number.isFinite(at)) send({ op: 'seam', edge, at: Math.round(at) });
}

// Where the file list is, so the helper can catch files dragged onto it from Windows. "open" is the
// Windows door: while it's locked, the helper turns drops away.
function dropArea(box, open) {
  if (!box) send({ op: 'drop-off' });
  else if ([box.x, box.y, box.w, box.h].every(Number.isFinite)) {
    send({ op: 'drop-area', x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h), open: Boolean(open) });
  }
}

// How much copying something from Windows will bring, in bytes. Zero if Windows can't say.
async function measure(source) {
  const reply = await ask({ op: 'measure', source }, null, 10 * 60 * 1000);
  return Number(reply?.bytes) || 0;
}

// Has Windows copy a file or folder into the house, for places the house can't read itself, such
// as a network drive. destination is a house path that doesn't exist yet. counted hears each step.
async function copyIn(source, destination, counted = () => {}) {
  const target = forWindows(destination);
  let told = 0;
  const onProgress = (done) => {
    if (done > told) counted(done - told);
    told = Math.max(told, done);
  };
  const reply = await ask({ op: 'copy-in', source, target }, null, 4 * 60 * 60 * 1000, onProgress);
  if (!reply) throw new Error('Windows isn\'t answering, so this couldn\'t be copied. Is Station 256\'s helper running?');
  if (reply.error) throw new Error(reply.error);
  if (reply.failed === 1) throw new Error(reply.first);
  if (reply.failed > 1) throw new Error(`${reply.failed} files inside couldn't be copied, such as ${reply.first}`);
}

// Opens a house file in a Windows app, for kinds of files the panel can't show itself.
// pick: show Windows' own "Open with" list instead of the usual app.
async function openFile(file, pick = false) {
  const target = forWindows(file);
  const reply = await ask({ op: 'open-file', target, pick: Boolean(pick) }, null, 30 * 1000);
  if (!reply) throw new Error('Windows isn\'t answering, so this couldn\'t be opened. Is Station 256\'s helper running?');
  if (reply.error) throw new Error(reply.error);
  return true;
}

// Windows' display scale as a number (1.25 for 125%), or null when the helper isn't there.
async function displayScale() {
  const reply = await ask({ op: 'display-scale' }, null, 5000);
  return reply && reply.scale >= 1 && reply.scale <= 5 ? reply.scale : null;
}

// Opens a web page in your browser on Windows. Only http and https: the helper checks too.
async function openUrl(url) {
  const reply = await ask({ op: 'open-url', url: String(url) }, null, 15 * 1000);
  if (!reply) throw new Error('Windows isn\'t answering, so the link couldn\'t be opened. Is Station 256\'s helper running?');
  if (reply.error) throw new Error(reply.error);
  return true;
}

// A Windows notification about a room's AI (lib/agent-alerts.js): its words, which buttons it has
// (approve, deny, open), and an id. A click comes back as { type: 'notification', id, action,
// room, tab }; what it does is decided here, never by the helper. tag: one per terminal, so a newer
// notification replaces the last one about the same terminal.
function notify({ tag, id, room, tab, title, body, buttons }) {
  send({ op: 'notify', tag: String(tag), id: String(id), room: String(room), tab: String(tab), title: String(title), body: String(body), buttons: (buttons || []).map(String) });
}

// That terminal's notification is out of date, so it's taken away.
const unnotify = (tag) => send({ op: 'unnotify', tag: String(tag) });

// Brings Station 256 to the front, which only Windows can do from here.
const raiseStation = () => send({ op: 'raise' });

// Whether one of Station 256's windows is the one in front in Windows: true or false, or null when
// the helper can't say.
async function appInFront() {
  const reply = await ask({ op: 'front' }, null, 1500);
  return reply && typeof reply.front === 'boolean' ? reply.front : null;
}

module.exports = { start, connected, list, move, watch, seam, dropArea, clipboardFiles, clipboardImage, displayScale, setClipboard, clearClipboard, measure, copyIn, openFile, openUrl, notify, unnotify, raiseStation, appInFront };
