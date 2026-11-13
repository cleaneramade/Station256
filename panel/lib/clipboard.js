// One clipboard for Windows and the house. What you copy here (terminal text, a program's copy in a
// terminal, Copy as path, files) goes on the house's clipboard and, through the Windows helper, on
// Windows' too. Text copied in Windows comes here as soon as it's copied (see windows/snap-link.cs).
//
// Nothing bounces back and forth: the helper marks the changes the house made itself ("ours") and
// never sends text the house already has, and here text from Windows is only written when it's
// different. Without the helper, copying still works inside the house.
const path = require('path');
const { clipboard } = require('electron');
const windowsLink = require('./windows-link');
const files = require('./files');

const MAX_TEXT = 1 << 20; // about a million characters, the same as the helper's limit
// WSLg, which shows the house's windows on Windows, passes text to Windows by itself too, and it
// can crash when both sides change the clipboard in the same moment. So Windows is asked a moment
// later, only for the latest copy, and the helper leaves it alone when Windows has it already.
const SETTLE = 500;
const heard = { changes: 0, ours: 0, fromWindows: 0, written: 0 }; // counted for the tests
let writing = Promise.resolve();
let later = null;

// Lock (the Windows door) closed means nothing crosses between the house and Windows, either way:
// what's copied here stays here, and what's copied in Windows isn't taken. Inside the house, and
// inside Windows, copying works as always. `onBlocked` tells the windows, so they can say so.
let onBlocked = () => {};
const setBlockedNotice = (fn) => { onBlocked = fn; };
const isLocked = async () => !(await files.doorIsOpen());

async function copyText(text) {
  if (typeof text !== 'string' || !text) return;
  clearTimeout(later);
  await clipboard.writeText(text);
  if (await isLocked()) {
    onBlocked();
    // WSLg may have passed it to Windows by itself: once it settles, Windows takes it back.
    later = setTimeout(() => windowsLink.clearClipboard(text.split(String.fromCharCode(13)).join('')), SETTLE);
    return { ok: true, locked: true };
  }
  if (text.length <= MAX_TEXT) later = setTimeout(() => windowsLink.setClipboard({ text }), SETTLE);
}

// Files anywhere in the house can be copied, as anywhere on L: can be browsed. Only whole, plain
// paths go: no "..", no line breaks, nothing absurdly long. The helper checks again on its side.
// The answer is null when Windows isn't linked, so the page can say File Explorer can't paste.
async function copyFiles(paths, move) {
  if (!Array.isArray(paths)) return null;
  const files = paths
    .filter((file) => typeof file === 'string' && file.startsWith('/') && file.length <= 4096 && !/[\0\r\n]/.test(file))
    .map((file) => path.resolve(file))
    .slice(0, 10000);
  if (!files.length) return null;
  clearTimeout(later); // newer than any text still waiting to go
  if (await isLocked()) {
    onBlocked();
    return { ok: true, locked: true };
  }
  // Cut would let File Explorer take things off C: when pasting, and C: is view and copy only, so
  // anything from it only ever goes as a copy.
  const { DOOR } = require('./files');
  const fromC = files.some((file) => file === DOOR || file.startsWith(`${DOOR}/`));
  return windowsLink.setClipboard({ files, move: Boolean(move) && !fromC });
}

// The helper says Windows' clipboard changed. Text comes with it only when it's new to the house.
// Texts are written one after another, so the last one copied is the one that stays.
function windowsChanged(message) {
  heard.changes += 1;
  if (message.ours === true) {
    heard.ours += 1;
    return;
  }
  const { text } = message;
  if (typeof text !== 'string' || !text || text.length > MAX_TEXT) return;
  heard.fromWindows += 1;
  writing = writing.then(async () => {
    if (await isLocked()) return; // locked: what's copied in Windows stays in Windows
    // WSLg may have brought it already, with Windows' line ends or without.
    if ((await clipboard.readText()).replace(/\r\n/g, '\n') === text) return;
    await clipboard.writeText(text);
    heard.written += 1;
  }).catch(() => {});
}

module.exports = { copyText, copyFiles, windowsChanged, setBlockedNotice, heard };
