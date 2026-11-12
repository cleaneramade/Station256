'use strict';
// Checks Station's own saved files when it starts. A file that isn't valid JSON (empty, half
// written, garbage) is set aside as <name>.broken-<date> instead of being silently written over,
// and the code that reads it starts from its defaults. Leftover temp files from an interrupted
// write are cleaned up. Only Station's own files are looked at: never secrets or key files.
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEEP_BROKEN = 3;
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

// The files Station writes itself, in the folders they live in. schedules.json is only tidied of
// temp files: lib/schedules.js sets a damaged one aside itself and says so on the Schedules page.
function ownFiles(home = os.homedir()) {
  const config = path.join(home, '.config', 'house');
  const state = path.join(home, '.local', 'state', 'house');
  return [
    { file: path.join(config, 'panel.json'), check: true },
    { file: path.join(config, 'schedules.json'), check: false },
    { file: path.join(state, 'token-counts.json'), check: true },
    { file: path.join(state, 'parked-tabs.json'), check: true },
    { file: path.join(state, 'housekeeping.json'), check: true },
  ];
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function isDamaged(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false; // not there, or not readable: not ours to judge
  }
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}

// Moves a damaged file aside and keeps only the newest copies. Returns the new name, or null.
function setAside(file, log = console.error) {
  const dir = path.dirname(file);
  const name = path.basename(file);
  let copy = path.join(dir, `${name}.broken-${stamp(new Date())}`);
  try {
    if (fs.existsSync(copy)) copy += `-${process.pid}`; // two in one second
    fs.renameSync(file, copy);
  } catch (error) {
    log(`[station] ${file} is damaged and couldn't be set aside (${error.code || error.message})`);
    return null;
  }
  log(`[station] ${file} was damaged; kept a copy as ${path.basename(copy)} and started it fresh`);
  try {
    const old = fs.readdirSync(dir)
      .filter((entry) => entry.startsWith(`${name}.broken-`))
      .sort() // the date in the name sorts oldest first
      .slice(0, -KEEP_BROKEN);
    for (const entry of old) fs.rmSync(path.join(dir, entry), { force: true });
  } catch {}
  return copy;
}

// Temp files an interrupted write leaves next to a file: exactly name.tmp, name.new, name.<pid>.tmp,
// name.<pid>.new and name.tmp-<pid>.
function isTempName(name, entry) {
  if (!entry.startsWith(`${name}.`)) return false;
  return /^(tmp|new|\d+\.tmp|\d+\.new|tmp-\d+)$/.test(entry.slice(name.length + 1));
}

function removeOldTemps(file, now, log) {
  const dir = path.dirname(file);
  const name = path.basename(file);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (!isTempName(name, entry)) continue;
    const target = path.join(dir, entry);
    try {
      const info = fs.lstatSync(target);
      if (!info.isFile() || now - info.mtimeMs < TEMP_MAX_AGE_MS) continue;
      fs.rmSync(target, { force: true });
      log(`[station] removed leftover ${entry}`);
    } catch {}
  }
}

// Runs at start-up, before anything reads the files. Never throws.
function run({ home = os.homedir(), log = console.error, now = Date.now() } = {}) {
  const moved = [];
  for (const { file, check } of ownFiles(home)) {
    try {
      if (check && isDamaged(file) && setAside(file, log)) moved.push(file);
      removeOldTemps(file, now, log);
    } catch (error) {
      log(`[station] self-check of ${file} failed: ${error.message}`);
    }
  }
  return moved;
}

module.exports = { run, setAside, isDamaged, ownFiles };
