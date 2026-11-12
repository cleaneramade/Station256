// Sites running in a room, opened in your browser on Windows.
//
// A room is sealed off, so a site started in it (npm run dev and the like) can't be reached from
// Windows by itself. For every port a room's programs listen on, this opens a one-way path: the
// house listens on the same port on its own localhost, which Windows reaches as localhost too, and
// each connection is carried over the room's ssh door to the room's own localhost (`room forward`).
// So http://localhost:3000 works in your browser the same as for a site on Windows. The room still
// can't reach the house or Windows: the path only goes in.
//
// The ports are read from the house side (/proc/PID/net of the room's first process), so nothing
// extra runs inside a room.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOM = path.join(os.homedir(), '.local', 'bin', 'room');
const POLL_MS = 3000;
// A site that stops listening gets this long to come back (a dev server restarting) before its
// path is closed.
const GONE_MS = 20000;
// The room's own ssh door. Never a site.
const SKIP = new Set([22]);
// Addresses the room's localhost reaches: any, 127.0.0.1, ::, ::1 and ::ffff:127.0.0.1. Docker's
// name server (127.0.0.11) and the room's own network address don't count.
const REACHABLE = new Set([
  '00000000', '0100007F',
  '00000000000000000000000000000000', '00000000000000000000000001000000', '0000000000000000FFFF00000100007F',
]);

const run = (file, args, ms = 10000) => new Promise((resolve) => {
  execFile(file, args, { timeout: ms }, (error, stdout) => resolve(error ? null : String(stdout)));
});

// The ports a room listens on, from the lines of /proc/net/tcp and tcp6.
function listening(text) {
  const ports = new Set();
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '0A') continue; // 0A: listening
    const [address, hex] = (fields[1] || '').split(':');
    const port = parseInt(hex, 16);
    if (REACHABLE.has(address) && port > 0 && !SKIP.has(port)) ports.add(port);
  }
  return ports;
}

const isFree = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
});

const anyFreePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(null));
  server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const answers = (port) => new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  const done = (ok) => { socket.destroy(); resolve(ok); };
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
  socket.setTimeout(1000, () => done(false));
});

const rooms = new Map();    // container name → { name, pid, allowed: Promise<boolean> }
const forwards = new Map(); // `${room}\n${port}` → { room, port, housePort, child, ready, ended, seenAt }
const failedAt = new Map(); // `${room}\n${port}` → when a path there last failed to start, so it isn't retried every look
let timer = null;
let polling = false;

const keyOf = (room, port) => `${room}\n${port}`;
const roomName = (container) => container.slice('room-'.length).replace(/\./g, ' ');

// Rooms opened before paths were allowed can't have them until they're opened again.
function allowedIn(container) {
  return run('docker', ['exec', container, 'grep', '-q', '^AllowTcpForwarding local', '/home/dev/.ssh/sshd_config'])
    .then((out) => out !== null);
}

function end(forward) {
  forward.ended = true;
  try { forward.child.kill(); } catch { /* already gone */ }
  if (forwards.get(keyOf(forward.room, forward.port)) === forward) forwards.delete(keyOf(forward.room, forward.port));
}

// Starts a path from the house's housePort to the room's port. Its ready promise gives the house
// port once the house is listening, or null if it couldn't start.
function open(room, port, housePort) {
  const child = spawn(ROOM, ['forward', room, String(port), String(housePort)], { stdio: 'ignore' });
  const forward = { room, port, housePort, child, ended: false, seenAt: Date.now() };
  forwards.set(keyOf(room, port), forward);
  child.on('exit', () => { if (!forward.ended) end(forward); });
  child.on('error', () => { if (!forward.ended) end(forward); });
  forward.ready = (async () => {
    const until = Date.now() + 8000;
    while (Date.now() < until && !forward.ended) {
      if (await answers(housePort)) return housePort;
      await new Promise((wait) => setTimeout(wait, 150));
    }
    if (!forward.ended) end(forward);
    failedAt.set(keyOf(room, port), Date.now());
    return null;
  })();
  return forward;
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const out = await run('docker', ['ps', '--format', '{{.Names}}'], 8000);
    if (out === null) return; // Docker didn't answer, so nothing is changed
    const up = out.split('\n').filter((line) => /^room-[A-Za-z0-9._-]+$/.test(line));
    for (const container of [...rooms.keys()]) if (!up.includes(container)) rooms.delete(container);
    for (const forward of [...forwards.values()]) {
      if (!up.includes(`room-${forward.room.replace(/ /g, '.')}`)) end(forward);
    }
    for (const container of up) {
      let room = rooms.get(container);
      if (!room) {
        const pid = Number(await run('docker', ['inspect', '-f', '{{.State.Pid}}', container], 8000));
        if (!pid) continue;
        room = { name: roomName(container), pid, allowed: allowedIn(container) };
        rooms.set(container, room);
      }
      let text;
      try {
        text = fs.readFileSync(`/proc/${room.pid}/net/tcp`, 'utf8') + fs.readFileSync(`/proc/${room.pid}/net/tcp6`, 'utf8');
      } catch {
        rooms.delete(container); // the room restarted: its first process is a new one
        continue;
      }
      const ports = listening(text);
      const now = Date.now();
      for (const forward of forwards.values()) {
        if (forward.room !== room.name) continue;
        if (ports.has(forward.port)) forward.seenAt = now;
        else if (now - forward.seenAt > GONE_MS) end(forward);
      }
      if (!await room.allowed) continue;
      for (const port of ports) {
        if (port < 1024 || forwards.has(keyOf(room.name, port))) continue;
        if (Date.now() - (failedAt.get(keyOf(room.name, port)) || 0) < 30000) continue;
        // Only on the same number, so typing the address the room gave works. If the house or
        // another room already has that port, a click on the link still finds another one.
        if (await isFree(port)) open(room.name, port, port);
      }
    }
  } finally {
    polling = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { poll().catch(() => {}); }, POLL_MS);
  poll().catch(() => {});
}

function stop() {
  clearInterval(timer);
  timer = null;
  for (const forward of [...forwards.values()]) end(forward);
}

// The house port that reaches a room's port, opening a path if there isn't one yet. Used when a
// link is clicked, so it works even before the next look at the room, for a site that hasn't
// started yet, and on a port the house already has (another one is used then).
async function reach(room, port) {
  const container = `room-${room.replace(/ /g, '.')}`;
  const existing = forwards.get(keyOf(room, port));
  if (existing && !existing.ended) {
    const ready = await existing.ready;
    if (ready) return ready;
  }
  if (!await allowedIn(container)) {
    throw new Error(`${room}'s room was opened before its sites could be reached from Windows. Close the room and open it again, then try the link.`);
  }
  const housePort = port >= 1024 && await isFree(port) ? port : await anyFreePort();
  const forward = housePort && open(room, port, housePort);
  const ready = forward && await forward.ready;
  if (!ready) throw new Error(`Couldn't open a path to ${room}'s site on port ${port}. Is the room still open?`);
  return ready;
}

// Which room ports have a path, and where: for tests and for showing them.
const list = () => [...forwards.values()].filter((forward) => !forward.ended)
  .map(({ room, port, housePort }) => ({ room, port, housePort }));

// The ports a room listens on right now, or null if it can't be looked at. For Preview, to tell
// which port a just-started site took.
async function portsOf(room) {
  const container = `room-${room.replace(/ /g, '.')}`;
  const known = rooms.get(container);
  const pid = known ? known.pid : Number(await run('docker', ['inspect', '-f', '{{.State.Pid}}', container], 8000));
  if (!pid) return null;
  try {
    const [v4, v6] = await Promise.all([fs.promises.readFile(`/proc/${pid}/net/tcp`, 'utf8'), fs.promises.readFile(`/proc/${pid}/net/tcp6`, 'utf8')]);
    return listening(v4 + v6);
  } catch {
    return null;
  }
}

module.exports = { start, stop, reach, list, listening, poll, portsOf };
