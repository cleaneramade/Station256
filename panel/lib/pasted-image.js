// A picture copied in Windows (a screen snip, say), pasted in the house.
//
// In a terminal it's saved as a PNG file the terminal can reach, and the terminal gets the file's
// path, the same as dragging a picture file into a terminal. AIs such as Claude Code take a pasted
// picture path as the picture itself. A room's terminal can only reach the room, so for a room the
// file is saved inside it. These files are only for pasting, so ones older than a week go.
//
// In the Files view it becomes a file in the folder you're in (files.makeFile does that).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOUSE_FOLDER = path.join(os.homedir(), '.cache', 'station-256', 'pastes');
const ROOM_FOLDER = '/tmp/station-256-pastes';
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const ROOM_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9_-])?$/;

const two = (number) => String(number).padStart(2, '0');
const day = (when) => `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}`;
const time = (when) => `${two(when.getHours())}${two(when.getMinutes())}${two(when.getSeconds())}`;

// "pasted-image-2026-11-08-194512" for a terminal: no spaces, so the path needs no quotes.
const terminalName = (when = new Date()) => `pasted-image-${day(when)}-${time(when)}`;
// "Pasted image 2026-11-08 194512.png" in a folder, the way Windows names a screenshot.
const folderName = (when = new Date()) => `Pasted image ${day(when)} ${time(when)}.png`;

function clearOld(folder, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(folder); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.png')) continue;
    const file = path.join(folder, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && now - stat.mtimeMs > KEEP_MS) fs.unlinkSync(file);
    } catch { /* gone already */ }
  }
}

// Saved in the house, for a house terminal. Only you can open the folder: snips can show
// anything on your screen.
function saveInHouse(png, when = new Date(), folder = HOUSE_FOLDER) {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error('The folder for pasted pictures isn\'t yours.');
  fs.chmodSync(folder, 0o700);
  clearOld(folder);
  const stem = terminalName(when);
  for (let i = 1; ; i += 1) {
    const file = path.join(folder, `${stem}${i > 1 ? `-${i}` : ''}.png`);
    try {
      fs.writeFileSync(file, png, { flag: 'wx', mode: 0o600 });
      return file;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

// Inside the room, as the room's own user, through docker exec. Says where the file is in there.
const ROOM_SCRIPT = `set -e
dir=${ROOM_FOLDER}
mkdir -p "$dir"; chmod 700 "$dir"
find "$dir" -maxdepth 1 -type f -name '*.png' -mtime +7 -delete 2>/dev/null || true
name="$1"; n=2
while [ -e "$dir/$name.png" ]; do name="$1-$n"; n=$((n+1)); done
cat > "$dir/$name.png"
printf '%s\\n' "$dir/$name.png"`;

function saveInRoom(room, png, when = new Date(), docker = 'docker') {
  if (!ROOM_NAME.test(room)) return Promise.reject(new Error('Not a valid project name.'));
  return new Promise((resolve, reject) => {
    const child = spawn(docker, ['exec', '-i', `room-${room.replaceAll(' ', '.')}`, 'sh', '-c', ROOM_SCRIPT, 'sh', terminalName(when)], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stdin.on('error', () => {}); // the room went away; said below
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const file = out.trim();
      if (code === 0 && file.startsWith(`${ROOM_FOLDER}/`) && /^[A-Za-z0-9/._-]+\.png$/.test(file)) resolve(file);
      else reject(new Error('The picture couldn\'t be put in the room. Is it still open?'));
    });
    child.stdin.end(png);
  });
}

module.exports = { saveInHouse, saveInRoom, terminalName, folderName, clearOld, HOUSE_FOLDER, ROOM_FOLDER };
