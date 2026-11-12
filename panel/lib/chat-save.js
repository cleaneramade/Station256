// Saves the AI chat in a terminal tab as a page (Markdown) in Downloads, from a right-click on the
// tab. lib/chat-export.js makes the page: inside the room for a room terminal, in the house for a
// house one. Only the finished page comes back, and the house picks the file's name and place.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const files = require('./files');

const PROGRAM = `${fs.readFileSync(path.join(__dirname, 'chat-export.js'), 'utf8')}\n;runFromStdin();`;
const NAME = /^[A-Za-z0-9]([A-Za-z0-9 _-]*[A-Za-z0-9_-])?$/;
const TAB = /^tab-\d{1,4}$/;
const MOST = 256 * 1024 * 1024; // a page bigger than this isn't something anyone could read
const LONGEST = 2 * 60 * 1000;

// Runs the page maker and gives back the page. Its first line says whether it worked.
function make(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0;
    let tooBig = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), LONGEST);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MOST) {
        tooBig = true;
        child.kill('SIGKILL');
      } else {
        chunks.push(chunk);
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('The chat couldn\'t be read.'));
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (tooBig) {
        reject(new Error('That chat is too big to save as one page.'));
        return;
      }
      const all = Buffer.concat(chunks);
      const end = all.indexOf(10);
      let head = null;
      try { head = JSON.parse(all.subarray(0, end < 0 ? all.length : end).toString('utf8')); } catch { /* nothing usable came back */ }
      if (!head || typeof head !== 'object') reject(new Error('The chat couldn\'t be read. Is the room still open?'));
      else if (head.error) reject(new Error(String(head.error).replace(/[\u0000-\u001f]/g, ' ').slice(0, 200)));
      else if (head.ok !== true || end < 0) reject(new Error('The chat couldn\'t be read.'));
      else resolve(all.subarray(end + 1));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

const pad = (value) => String(value).padStart(2, '0');
// 2026-11-09 8-41 PM: sorts by date, and a colon can't be in a Windows file name.
function stamp(date) {
  const hour = date.getHours();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hour % 12 || 12}-${pad(date.getMinutes())} ${hour < 12 ? 'AM' : 'PM'}`;
}

// place: { room, tab } for a room terminal, or { shellPid } for a house one (lib/terminals.js).
// detail: with every step the AI took, not just what was said. Says where the file went.
async function save(place, detail) {
  const now = Date.now();
  const input = { detail: Boolean(detail), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, now };
  let page;
  let where;
  if (place && place.room) {
    if (!NAME.test(place.room) || !TAB.test(place.tab || '')) throw new Error('That isn\'t a room terminal.');
    where = place.room;
    page = await make('docker', ['exec', '-i', `room-${place.room.replaceAll(' ', '.')}`, 'node', '-e', PROGRAM], { ...input, tab: place.tab, room: place.room });
  } else if (place && Number.isInteger(place.shellPid) && place.shellPid > 1) {
    where = 'Linux House';
    page = await make('node', ['-e', PROGRAM], { ...input, shellPid: place.shellPid, room: '' });
  } else {
    throw new Error('This terminal has no chat to save.');
  }
  const folder = path.join(os.homedir(), 'Downloads');
  await fs.promises.mkdir(folder, { recursive: true });
  const target = await files.freeName(folder, `${where} chat${detail ? ' with details' : ''} ${stamp(new Date(now))}.md`);
  await fs.promises.writeFile(target, page, { flag: 'wx' });
  return target;
}

module.exports = { save };
