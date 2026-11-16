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

const MAX_TEXT = 1 << 20; // about a million characters, the same as the helper's limit
// WSLg, which shows the house's windows on Windows, passes text to Windows by itself too, and it
// can crash when both sides change the clipboard in the same moment. So Windows is asked a moment
// later, only for the latest copy, and the helper leaves it alone when Windows has it already.
const SETTLE = 500;
const heard = { changes: 0, ours: 0, fromWindows: 0, written: 0 }; // counted for the tests
let writing = Promise.resolve();
let later = null;
// The newest text copied in Windows, until the house copies something newer. WSLg is supposed to
// bring it to the house's clipboard, but it can drop it (a write needs a focused window), so pasting
// and focusing check this first. shortcut: kept as one string, a very long copy is dropped at MAX_TEXT.
let fromWindows = null;
let houseThen = ''; // what the house held when Windows' text arrived: unchanged later means the write was dropped
let epoch = 0; // counts house copies, so Windows' text that arrives late doesn't beat a newer one
const plain = (text) => text.split('\r\n').join('\n');
const sameText = (a, b) => plain(a) === plain(b);
// Lengths only, never the text. Said only when something disagrees.
const say = (note) => console.error(`[station] clipboard: ${note}`);

// The lock (the Windows door) is about the C: drive, not the clipboard: the clipboard belongs to
// Windows, so it always crosses, locked or not (owner, 2026-11-12).
// The answer is { ok: false } when the helper isn't linked, so the page can say so once.
async function copyText(text) {
  if (typeof text !== 'string' || !text) return;
  await clipboard.writeText(text);
  return toWindows(text);
}

// The text is on the house's clipboard already: send it to Windows a moment later.
function toWindows(text) {
  clearTimeout(later);
  epoch += 1;
  fromWindows = null; // this copy is newer than anything heard from Windows
  if (text.length > MAX_TEXT) return;
  if (!windowsLink.connected()) return { ok: false };
  later = setTimeout(() => windowsLink.setClipboard({ text }), SETTLE);
  return { ok: true };
}

// A copy the page did by itself (a web page's Ctrl+C or Cut): the house's clipboard has it, so it
// only needs to go on to Windows. If the house still holds what it had before Windows' last copy,
// the key copied nothing (no selection, or the page stopped it): leave Windows' newer copy alone.
async function shareNative() {
  const text = await clipboard.readText();
  if (!text || newerFromWindows(text) !== null) return undefined;
  return toWindows(text);
}

// Windows' text when a page's own Ctrl+V would paste something else (it can't wait), else null.
function windowsInstead() {
  const have = clipboard.readText();
  if (newerFromWindows(have) === null) return null;
  say(`house had different text than Windows at web paste (house ${have.length}, Windows ${fromWindows.length}), used Windows'`);
  return fromWindows;
}

// Windows' text if it should beat what the house holds now, else null. If the house clipboard
// changed since Windows' text arrived, something in the house was copied after it: that wins.
function newerFromWindows(have) {
  if (fromWindows === null || typeof have !== 'string' || sameText(have, fromWindows)) return null;
  if (have !== houseThen) { fromWindows = null; return null; }
  return fromWindows;
}

// What a paste should use: the text Windows copied last, unless the house copied something newer.
// The house's clipboard is put right when it disagrees (a focused window's write is accepted).
async function readText(why) {
  const have = await clipboard.readText();
  if (newerFromWindows(have) === null) return have;
  say(`house had different text than Windows at ${why} (house ${have.length}, Windows ${fromWindows.length}), used Windows'`);
  try { await clipboard.writeText(fromWindows); } catch { /* the paste still gets the text */ }
  return fromWindows;
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
  epoch += 1;
  fromWindows = null;
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
  if (message.files > 0 || message.image === true) fromWindows = null; // newest copy isn't text
  const { text } = message;
  if (typeof text !== 'string' || !text || text.length > MAX_TEXT) return;
  heard.fromWindows += 1;
  const seen = epoch;
  writing = writing.then(async () => {
    const have = await clipboard.readText();
    if (epoch !== seen) return; // the house copied since: that's newer
    houseThen = have;
    fromWindows = text;
    // WSLg may have brought it already, with Windows' line ends or without.
    if (sameText(have, text)) return;
    await clipboard.writeText(text);
    heard.written += 1;
  }).catch(() => {});
}

module.exports = { windowsInstead, readText, shareNative, copyText, copyFiles, windowsChanged, heard };
