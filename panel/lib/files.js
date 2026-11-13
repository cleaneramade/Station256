// File operations for the explorer. Delete moves things to a recoverable trash folder.
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const HOME = os.homedir();
const TRASH = path.join(HOME, '.local', 'share', 'house-trash');
const TRASH_INFO = path.join(TRASH, '.info'); // remembers where each trashed item came from
const TEXT_LIMIT = 256 * 1024;

// The explorer's own drive is L:. Windows' C: drive only comes into the house through the Windows
// door: while it's unlocked, C: is mounted read-only at DOOR, and the explorer shows it as
// "Windows (C:)" to look at and copy from, never to change (user, 2026-11-09). Rooms read it too,
// and never change it. The rest of Windows (/mnt/c, WSL's own files) always stays out.
// In checks (HOUSE_SHOTS), a stand-in folder and flag in the throwaway home take their place.
const CHECKS = process.env.HOUSE_SHOTS ? path.dirname(process.env.HOUSE_SHOTS) : null;
const DOOR = CHECKS ? path.join(CHECKS, 'windows-door') : '/mnt/windows-door';
const DOOR_FLAG = CHECKS ? path.join(CHECKS, 'windows-door-open') : '/run/house/windows-door-open';
const WINDOWS_PLACES = ['/mnt/c', DOOR, '/usr/lib/wsl'];
const READ_ONLY = 'Windows (C:) is view and copy only. Nothing on it can be changed from here.';

// What the house and this app run from. Moving or deleting these would break them.
const KEEP_EVERYTHING_IN = [path.join(HOME, 'house'), path.join(HOME, '.config', 'house'), path.join(HOME, '.local', 'bin'), path.join(HOME, '.local', 'state', 'house')];
const KEEP_THE_FOLDER = [HOME, path.join(HOME, 'projects'), path.join(HOME, '.config'), path.join(HOME, '.local'), path.join(HOME, '.local', 'share'), path.join(HOME, '.local', 'state'), TRASH];

const isInside = (target, place) => target === place || target.startsWith(`${place}/`);
const isWindowsPlace = (target) => WINDOWS_PLACES.some((place) => isInside(target, place));

// Follows links first, so a link pointing into one of those places can't get around this.
// For something that doesn't exist yet, checks the nearest folder above it that does.
async function realLocation(target) {
  let current = path.resolve(target);
  const rest = [];
  while (true) {
    try {
      return path.join(await fs.realpath(current), ...rest);
    } catch (error) {
      if (error.code !== 'ENOENT' || current === '/') throw error;
      rest.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
}

const doorIsOpen = () => fs.access(DOOR_FLAG).then(() => true, () => false);

// For anything that changes something: never on Windows' side, C: included.
async function assertAllowed(target) {
  const places = [path.resolve(target), await realLocation(target)];
  if (places.some((place) => isInside(place, DOOR))) throw new Error(READ_ONLY);
  if (places.some(isWindowsPlace)) throw new Error('Windows files aren\'t available here. This explorer only shows the L: drive.');
}

// For looking and copying from: the house, and the C: drive while the door is unlocked.
async function assertReadable(target) {
  for (const place of [path.resolve(target), await realLocation(target)]) {
    if (!isWindowsPlace(place)) continue;
    if (isInside(place, DOOR) && await doorIsOpen()) continue;
    throw new Error(isInside(place, DOOR)
      ? 'Windows (C:) is locked. Unlock it with the lock button at the top right.'
      : 'Windows files aren\'t available here. This explorer only shows the L: drive.');
  }
}

// Where Windows (C:) opens: your own Windows folder, C:\Users\<you>, as File Explorer starts in
// your files. The house isn't told your Windows name, so it's the folder in Users named like you
// are here, or else the one Windows signed into last (its NTUSER.DAT changed last). C:\ itself if
// neither is found. Windows' own shared folders and shortcuts there are never picked.
const NOT_PEOPLE = new Set(['public', 'default', 'default user', 'all users', 'defaultuser0', 'defaultuser100000', 'wdagutilityaccount']);
async function windowsHome() {
  await assertReadable(DOOR);
  const users = path.join(DOOR, 'Users');
  const items = await fs.readdir(users, { withFileTypes: true }).catch(() => []);
  const people = items.filter((item) => item.isDirectory() && !NOT_PEOPLE.has(item.name.toLowerCase())).map((item) => item.name);
  const me = os.userInfo().username.toLowerCase();
  const named = people.find((name) => name.toLowerCase() === me);
  if (named) return path.join(users, named);
  let last = null;
  let newest = -1;
  for (const name of people) {
    const when = await fs.stat(path.join(users, name, 'NTUSER.DAT')).then((info) => info.mtimeMs, () => -1);
    if (when > newest) {
      newest = when;
      last = name;
    }
  }
  if (!last && people.length === 1) [last] = people;
  return last ? path.join(users, last) : DOOR;
}

// A link to these can still be moved or deleted, since that only touches the link.
function assertChangeable(target) {
  const full = path.resolve(target);
  if (KEEP_EVERYTHING_IN.some((place) => isInside(full, place)) || KEEP_THE_FOLDER.includes(full)) {
    throw new Error('This is part of how the house runs, so it can\'t be moved or deleted from here.');
  }
}

function checkName(name) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error('That name can\'t be used. Names can\'t contain "/".');
  }
}

// Unlike access, this also counts a link whose target is gone, so it can't be overwritten.
const exists = (target) => fs.lstat(target).then(() => true, () => false);

// Windows marks these hidden, and File Explorer leaves them out, but the house can't see that mark
// on C:. So they're known by name, and shown only when hidden items are.
const WINDOWS_HIDDEN = /^(ntuser\..*|appdata|desktop\.ini|thumbs\.db|\$recycle\.bin|\$winreagent|\$windows\.~.*|system volume information|pagefile\.sys|hiberfil\.sys|swapfile\.sys|dumpstack\.log(\.tmp)?|recovery|config\.msi|programdata|msocache|bootmgr|bootnxt)$/i;

async function list(dir, showHidden) {
  await assertReadable(dir);
  const inTrash = path.resolve(dir) === TRASH;
  // On C:, everything listed is Windows' own. Elsewhere, Windows' places stay out of the list.
  const onWindows = isInside(path.resolve(dir), DOOR);
  const items = await fs.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(items
    .filter((item) => (showHidden || !item.name.startsWith('.')) && (onWindows || !isWindowsPlace(path.join(dir, item.name))))
    .filter((item) => showHidden || !onWindows || !WINDOWS_HIDDEN.test(item.name))
    .filter((item) => !(inTrash && item.name === '.info'))
    .map(async (item) => {
      const full = path.join(dir, item.name);
      let stat = null;
      try { stat = await fs.stat(full); } catch { /* broken link or no permission */ }
      // Windows' hidden shortcut folders (like "Documents and Settings") come through as links
      // that lead nowhere here. File Explorer hides them too.
      if (onWindows && !stat && item.isSymbolicLink()) return null;
      return {
        name: inTrash ? item.name.replace(/^\d+-/, '') : item.name,
        path: full,
        isDir: stat ? stat.isDirectory() : item.isDirectory(),
        size: stat ? stat.size : 0,
        mtime: stat ? stat.mtimeMs : 0,
      };
    }));
  return entries.filter(Boolean);
}

// With pickFree, a name that's taken becomes "New folder (2)", as Explorer does. Says where it went.
async function makeFolder(dir, name, pickFree) {
  checkName(name);
  await assertAllowed(dir);
  assertNotTrash(dir);
  const target = pickFree ? await freeName(dir, name) : path.join(dir, name);
  await fs.mkdir(target);
  return target;
}

// An empty file, such as a new text document, or one holding what's given, such as a pasted
// picture. Never over something that's there.
async function makeFile(dir, name, content = '') {
  checkName(name);
  await assertAllowed(dir);
  assertNotTrash(dir);
  const target = await freeName(dir, name);
  await fs.writeFile(target, content, { flag: 'wx' });
  return target;
}

function assertNotTrash(dir) {
  if (isInside(path.resolve(dir), TRASH)) throw new Error('Things can\'t be put straight into the trash. Use Delete instead.');
}

async function rename(target, name) {
  checkName(name);
  await assertAllowed(target);
  assertChangeable(target);
  const next = path.join(path.dirname(target), name);
  if (await exists(next)) throw new Error(`"${name}" already exists here.`);
  await fs.rename(target, next);
  return next;
}

const copy = (source, destination) => fs.cp(source, destination, {
  recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true,
});

// A plain rename can't cross between two disks, so that case copies and then removes.
async function move(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copy(source, destination);
    await fs.rm(source, { recursive: true, force: true });
  }
}

// Does each item on its own. One failing never stops the rest. Returns the ones that failed.
async function eachItem(paths, action) {
  const failures = [];
  for (const target of paths) {
    try {
      await action(target);
    } catch (error) {
      failures.push({ path: target, message: error.message });
    }
  }
  return failures;
}

// Says where each item went in the trash, so it can be put back with Undo.
async function trashItems(paths) {
  const trashed = [];
  const failures = await eachItem(paths, async (target) => {
    await assertAllowed(target);
    assertChangeable(target);
    if (path.dirname(path.resolve(target)) === TRASH) throw new Error('This is already in the trash.');
    await fs.mkdir(TRASH_INFO, { recursive: true });
    // Two things with the same name trashed in the same moment still get their own places.
    let stored = `${Date.now()}-${path.basename(target)}`;
    for (let i = 2; await exists(path.join(TRASH, stored)); i += 1) stored = `${Date.now()}${i}-${path.basename(target)}`;
    await move(target, path.join(TRASH, stored));
    await fs.writeFile(path.join(TRASH_INFO, `${stored}.json`), JSON.stringify({ from: path.resolve(target) }));
    trashed.push(path.join(TRASH, stored));
  });
  return { failures, trashed };
}

const trash = async (paths) => (await trashItems(paths)).failures;

// How many files and folders something holds, counting itself.
async function countEntries(target) {
  const info = await fs.lstat(target);
  if (!info.isDirectory()) return 1;
  let total = 1;
  for (const name of await fs.readdir(target)) total += await countEntries(path.join(target, name)).catch(() => 1);
  return total;
}

// Removes one piece at a time, so a big delete can show how far along it is.
async function removeCounted(target, counted) {
  const info = await fs.lstat(target);
  if (info.isDirectory()) {
    for (const name of await fs.readdir(target)) await removeCounted(path.join(target, name), counted);
    await fs.rmdir(target);
  } else {
    await fs.unlink(target);
  }
  counted(1);
}

// Counts everything first, then removes it, telling onProgress how far along it is.
async function removeAll(paths, check, after, onProgress = () => {}) {
  const names = paths.map((target) => path.basename(target).replace(/^\d+-/, ''));
  onProgress({ done: 0, total: 0, names, measuring: true });
  // Checked before anything is even counted, so nothing off-limits is looked through.
  const allowed = [];
  const failures = await eachItem(paths, async (target) => {
    await check(target);
    allowed.push(target);
  });
  let total = 0;
  for (const target of allowed) total += await countEntries(target).catch(() => 0);
  let done = 0;
  failures.push(...await eachItem(allowed, async (target) => {
    await removeCounted(target, (count) => {
      done += count;
      onProgress({ done, total, names });
    });
    if (after) await after(target);
  }));
  onProgress({ done: total, total, names, final: true });
  return failures;
}

async function freeName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i += 1) {
    const candidate = path.join(dir, i === 0 ? name : `${stem} (${i + 1})${ext}`);
    if (!await exists(candidate)) return candidate;
  }
}

function assertInTrash(target) {
  if (path.dirname(path.resolve(target)) !== TRASH) throw new Error('Only items in the trash can do this.');
}

const forgetTrashInfo = (target) => fs.rm(path.join(TRASH_INFO, `${path.basename(target)}.json`), { force: true });

// Puts things back where they came from, never over something that's there now.
function restore(paths) {
  return eachItem(paths, async (target) => {
    assertInTrash(target);
    let from;
    try {
      ({ from } = JSON.parse(await fs.readFile(path.join(TRASH_INFO, `${path.basename(target)}.json`), 'utf8')));
    } catch {
      from = path.join(HOME, 'Documents', path.basename(target).replace(/^\d+-/, ''));
    }
    await fs.mkdir(path.dirname(from), { recursive: true });
    await move(target, await freeName(path.dirname(from), path.basename(from)));
    await forgetTrashInfo(target);
  });
}

function destroy(paths, onProgress) {
  return removeAll(paths, async (target) => assertInTrash(target), forgetTrashInfo, onProgress);
}

// Shift+Delete: gone for good, without going through the trash.
function removeForever(paths, onProgress) {
  return removeAll(paths, async (target) => {
    await assertAllowed(target);
    assertChangeable(target);
  }, null, onProgress);
}

async function emptyTrash(onProgress) {
  const items = await fs.readdir(TRASH).catch(() => []);
  return destroy(items.filter((name) => name !== '.info').map((name) => path.join(TRASH, name)), onProgress);
}

// The names of everything in the trash, as they were before being trashed.
async function trashedNames() {
  const items = await fs.readdir(TRASH).catch(() => []);
  return items.filter((name) => name !== '.info').map((name) => name.replace(/^\d+-/, ''));
}

/* Moves or copies things into a folder. Says where each one ended up, so it can be undone, and
   which ones failed. A copy counts as it goes when onProgress is given; a move inside the house is
   just a rename, so it's instant. */
async function transfer(paths, dir, moving, onProgress) {
  await assertAllowed(dir);
  assertNotTrash(dir);
  const names = paths.map((target) => path.basename(target));
  const done = [];
  let total = 0;
  let sofar = 0;
  if (!moving && onProgress) {
    onProgress({ done: 0, total: 0, names, measuring: true });
    for (const source of paths) total += await sizeOf(source).catch(() => 0);
  }
  const counted = (bytes) => {
    sofar += bytes;
    onProgress({ done: sofar, total, names });
  };
  const failures = await eachItem(paths, async (source) => {
    // Copying only reads, so it can come from C:. Moving would take it away from there, so it can't.
    if (moving) await assertAllowed(source);
    else await assertReadable(source);
    if (dir === source || dir.startsWith(`${source}/`)) throw new Error('A folder can\'t go inside itself.');
    if (moving) assertChangeable(source);
    if (moving && path.dirname(source) === dir) return;
    const destination = await freeName(dir, path.basename(source));
    // From C:, the copy becomes ordinary house files, as a copy brought in from Windows does.
    const fromWindows = isInside(path.resolve(source), DOOR);
    if (moving) await move(source, destination);
    else if (fromWindows) await copyIn(source, destination, onProgress ? counted : () => {}, false);
    else if (onProgress) await copyIn(source, destination, counted, true);
    else await copy(source, destination);
    done.push({ from: source, to: destination });
  });
  if (onProgress) onProgress({ done: total, total, names, final: true });
  return { failures, done };
}

const paste = async (paths, dir, moving) => (await transfer(paths, dir, moving)).failures;

// Undo for a move or a rename: each thing goes back to where it was, never over something new.
function moveBack(pairs) {
  return eachItem(pairs.map((pair) => pair.to), async (to) => {
    const { from } = pairs.find((pair) => pair.to === to);
    await assertAllowed(to);
    await assertAllowed(from);
    assertChangeable(to);
    assertChangeable(from);
    if (await exists(from)) throw new Error(`Something called "${path.basename(from)}" is there now.`);
    await fs.mkdir(path.dirname(from), { recursive: true });
    await move(to, from);
  });
}

/* What File Explorer's Properties shows: for one item its details, and for any number, how much
   they hold. Folders are counted all the way down. Links aren't followed, so nothing is counted twice. */
async function properties(paths) {
  const totals = { files: 0, folders: 0, bytes: 0 };
  const tally = async (target) => {
    const info = await fs.lstat(target);
    if (info.isDirectory()) {
      totals.folders += 1;
      for (const name of await fs.readdir(target).catch(() => [])) await tally(path.join(target, name)).catch(() => {});
    } else {
      totals.files += 1;
      totals.bytes += info.isFile() ? info.size : 0;
    }
  };
  for (const target of paths) {
    await assertReadable(target);
    await tally(target);
  }
  let single = null;
  if (paths.length === 1) {
    const info = await fs.lstat(paths[0]);
    let linkTo = null;
    if (info.isSymbolicLink()) linkTo = await fs.readlink(paths[0]).catch(() => null);
    const folder = info.isDirectory() || (linkTo !== null && (await fs.stat(paths[0]).then((s) => s.isDirectory(), () => false)));
    single = {
      name: path.basename(paths[0]),
      location: path.dirname(paths[0]),
      isDir: folder,
      linkTo,
      created: info.birthtimeMs || info.ctimeMs,
      modified: info.mtimeMs,
      accessed: info.atimeMs,
      mode: info.mode & 0o7777,
    };
    // A folder itself isn't one of the folders it holds.
    if (info.isDirectory()) totals.folders -= 1;
  }
  return { ...totals, count: paths.length, single };
}

/* Files copied or dragged in from Windows, only while the Windows door is unlocked. Where they come
   from decides how they come in:
   - the C: drive: read through the Windows door, which is only there while the lock is open
   - the house itself (L: in Windows): copied inside the house, like any paste
   - anywhere else, such as a network drive: Windows copies them in, through the helper
   What comes through the door becomes ordinary house files: links and special files are left out,
   and nothing keeps a run permission from Windows. */
const DISTRO = process.env.WSL_DISTRO_NAME || 'Ubuntu';

function windowsParts(rest) {
  const parts = rest.split('\\').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || part.includes('/') || part.includes('\0'))) {
    throw new Error('That can\'t be brought in.');
  }
  return parts;
}

// { door } for the C: drive, { house } for the house itself, { windows } for anywhere else.
function whereFrom(windowsPath) {
  const text = String(windowsPath);
  const drive = /^([A-Za-z]):\\(.*)$/.exec(text);
  if (drive) {
    const parts = windowsParts(drive[2]);
    if (!parts.length) throw new Error('A whole drive can\'t be brought in. Copy the folders inside it instead.');
    return drive[1].toUpperCase() === 'C' ? { door: path.join(DOOR, ...parts) } : { windows: text };
  }
  const share = /^\\\\([^\\?.][^\\]*)\\(.*)$/.exec(text); // \\computer\share\..., but not \\?\ or \\.\
  if (!share) throw new Error('That can\'t be brought in.');
  const [, computer, rest] = share;
  const parts = windowsParts(rest);
  if (/^(wsl\.localhost|wsl\$)$/i.test(computer)) {
    if (!parts.length || parts[0].toLowerCase() !== DISTRO.toLowerCase()) throw new Error('Only files from this house or from Windows can be brought in.');
    return { house: path.join('/', ...parts.slice(1)) };
  }
  if (parts.length < 2) throw new Error('A whole network drive can\'t be brought in. Copy the folders inside it instead.');
  return { windows: text };
}

// How much a copy will bring, so its progress can be shown. Links count as nothing, since they're
// left out (from Windows) or copied as links (in the house).
async function sizeOf(target) {
  const info = await fs.lstat(target);
  if (!info.isDirectory()) return info.isFile() ? info.size : 0;
  let total = 0;
  for (const name of await fs.readdir(target)) total += await sizeOf(path.join(target, name)).catch(() => 0);
  return total;
}

// Copies a file a piece at a time, so progress can be counted as it goes.
async function copyCounted(source, destination, mode, counted) {
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      counted(chunk.length);
      done(null, chunk);
    },
  });
  try {
    await pipeline(fsSync.createReadStream(source), counter, fsSync.createWriteStream(destination, { flags: 'wx', mode }));
  } catch (error) {
    if (error.code !== 'EEXIST') await fs.rm(destination, { force: true }); // no half-copied file left behind
    throw error;
  }
  await fs.chmod(destination, mode);
}

// From the Windows door: links and special files are left out, and nothing gets run permission.
// Inside the house (keep): everything stays as it was, links and run permissions included.
async function copyIn(source, destination, counted, keep) {
  const info = await fs.lstat(source);
  if (info.isDirectory()) {
    await fs.mkdir(destination, 0o755);
    for (const name of await fs.readdir(source)) await copyIn(path.join(source, name), path.join(destination, name), counted, keep);
    if (keep) await fs.chmod(destination, info.mode & 0o7777); // only now, so a read-only folder could still be filled
    await fs.utimes(destination, info.atime, info.mtime);
  } else if (info.isFile()) {
    await copyCounted(source, destination, keep ? info.mode & 0o7777 : 0o644, counted);
    await fs.utimes(destination, info.atime, info.mtime); // keeps its date modified, as Explorer does
  } else if (info.isSymbolicLink() && keep) {
    await fs.symlink(await fs.readlink(source), destination);
  }
}

async function assertDoorOpen() {
  if (!await fs.access(DOOR_FLAG).then(() => true, () => false)) {
    throw new Error('The Windows door is locked. Unlock it with the lock button at the top right, then try again.');
  }
}

/* windows: { measure(windowsPath), copy(windowsPath, destination, counted) }, for places only
   Windows can read. onProgress({ done, total, names, final }) is told how far along the copy is:
   everything is measured first, then counted as it copies. */
async function importFromWindows(sources, dir, windows, onProgress = () => {}) {
  await assertAllowed(dir);
  if (isInside(path.resolve(dir), TRASH)) throw new Error('Files can\'t be brought straight into the trash.');
  const names = sources.map((source) => String(source).split('\\').filter(Boolean).pop() || String(source));
  onProgress({ done: 0, total: 0, names, measuring: true });

  // Works out where each one is, and checks it, before anything is copied. Locked, the C: mount
  // isn't there, so C: files come in through Windows' helper like any other drive (decided once).
  const doorOpen = await fs.access(DOOR_FLAG).then(() => true, () => false);
  const items = [];
  for (const [index, windowsPath] of sources.entries()) {
    const item = { windowsPath, name: names[index], size: 0 };
    try {
      let from = whereFrom(windowsPath);
      if (from.door && !doorOpen) from = { windows: windowsPath };
      if (from.door) {
        item.source = await fs.realpath(from.door);
        if (!isInside(item.source, DOOR) || item.source === DOOR) throw new Error('That can\'t be brought in.');
        item.size = await sizeOf(item.source);
      } else if (from.house) {
        await assertAllowed(from.house);
        if (dir === from.house || dir.startsWith(`${from.house}/`)) throw new Error('A folder can\'t go inside itself.');
        item.source = from.house;
        item.keep = true;
        item.size = await sizeOf(item.source);
      } else {
        checkName(item.name);
        item.windows = from.windows;
        item.size = await windows.measure(from.windows);
      }
    } catch (error) {
      item.problem = error;
    }
    items.push(item);
  }

  const total = items.reduce((sum, item) => sum + item.size, 0);
  let done = 0;
  const counted = (bytes) => {
    done += bytes;
    onProgress({ done, total, names });
  };
  const failures = [];
  for (const item of items) {
    const before = done;
    try {
      if (item.problem) throw item.problem;
      if (item.windows) await windows.copy(item.windows, await freeName(dir, item.name), counted);
      else await copyIn(item.source, await freeName(dir, path.basename(item.source)), counted, item.keep);
    } catch (error) {
      failures.push({ path: item.windowsPath, message: error.message });
    }
    done = before + item.size; // whatever happened, this one is finished
    onProgress({ done, total, names });
  }
  onProgress({ done: total, total, names, final: true });
  return failures;
}

async function readText(target) {
  await assertReadable(target);
  // Opening something like a named pipe would wait forever, so only regular files get opened.
  if (!(await fs.stat(target)).isFile()) return { binary: true };
  const handle = await fs.open(target, 'r');
  try {
    const buffer = Buffer.alloc(TEXT_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, TEXT_LIMIT, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) return { binary: true };
    const { size } = await handle.stat();
    return { text: slice.toString('utf8'), truncated: size > TEXT_LIMIT };
  } finally {
    await handle.close();
  }
}

// Files opened in a page of their own to change (Markdown, text, code). The whole file, up to 8 MB.
// readOnly: Windows (C:) files, the Trash, files the house user can't write, and text that isn't UTF-8.
const DOC_LIMIT = 8 * 1024 * 1024;
async function readDoc(target) {
  await assertReadable(target);
  const info = await fs.stat(target);
  if (!info.isFile()) return { binary: true };
  if (info.size > DOC_LIMIT) return { tooBig: true, size: info.size };
  const buffer = await fs.readFile(target);
  if (buffer.subarray(0, 8192).includes(0)) return { binary: true };
  let readOnly = false;
  try {
    await assertAllowed(target);
    if (isInside(path.resolve(target), TRASH)) throw new Error('in the Trash');
    await fs.access(target, fsSync.constants.W_OK);
  } catch {
    readOnly = true;
  }
  let text = buffer.toString('utf8');
  // Text that isn't UTF-8 (an old Windows file, or binary further in) wouldn't be saved back the
  // same: its odd letters would be lost. So it's only shown.
  const lossy = text.includes('\ufffd') && !Buffer.from(text, 'utf8').equals(buffer);
  if (lossy) readOnly = true;
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  return { text, bom, crlf: text.includes('\r\n'), mtime: info.mtimeMs, size: info.size, readOnly, lossy };
}

// When it last changed, so an open page can tell if something else (AI) changed it.
async function docStat(target) {
  try {
    const info = await fs.stat(target);
    return { mtime: info.mtimeMs, size: info.size };
  } catch {
    return { gone: true };
  }
}

// Saved in place (the same file, so a room's view of it carries on). If it changed since the page
// read it, nothing is written unless force says to: the page asks which to keep.
async function writeDoc(target, text, expected, { force = false, bom = false } = {}) {
  await assertAllowed(target);
  if (isInside(path.resolve(target), TRASH)) throw new Error('Files in the Trash can\'t be changed. Restore it first.');
  if (typeof text !== 'string' || Buffer.byteLength(text) > DOC_LIMIT) throw new Error('This file is too big to save from here.');
  const info = await fs.stat(target).catch(() => null);
  if (info && !info.isFile()) throw new Error('That isn\'t a file.');
  if (info && !force && expected != null && info.mtimeMs !== expected) return { conflict: true, mtime: info.mtimeMs };
  await fs.writeFile(target, (bom ? '﻿' : '') + text, 'utf8');
  const after = await fs.stat(target);
  return { mtime: after.mtimeMs, size: after.size };
}

const inTrash = (target) => isInside(path.resolve(target), TRASH);

// A file saved over with new contents (an edited picture). The old one is copied to the Trash
// first, so it can come back (putBack). It's written in place, so a room's view of it carries on.
async function replaceFile(target, data) {
  await assertAllowed(target);
  assertChangeable(target);
  if (inTrash(target)) throw new Error('Files in the Trash can\'t be changed. Restore it first.');
  if (!(await fs.stat(target)).isFile()) throw new Error('That isn\'t a file.');
  await fs.mkdir(TRASH_INFO, { recursive: true });
  let stored = `${Date.now()}-${path.basename(target)}`;
  for (let i = 2; await exists(path.join(TRASH, stored)); i += 1) stored = `${Date.now()}${i}-${path.basename(target)}`;
  const kept = path.join(TRASH, stored);
  await fs.copyFile(target, kept);
  await fs.writeFile(path.join(TRASH_INFO, `${stored}.json`), JSON.stringify({ from: path.resolve(target) }));
  await fs.writeFile(target, data);
  return { path: target, kept };
}

// Like replaceFile, for a new version already written beside it (a saved video, too big to pass
// around): the old one goes to the Trash and the new one takes its place.
async function replaceWith(target, made) {
  await assertAllowed(target);
  assertChangeable(target);
  if (inTrash(target)) throw new Error('Files in the Trash can\'t be changed. Restore it first.');
  if (!(await fs.stat(target)).isFile()) throw new Error('That isn\'t a file.');
  if (path.dirname(path.resolve(made)) !== path.dirname(path.resolve(target))) throw new Error('That isn\'t a new version of it.');
  await fs.mkdir(TRASH_INFO, { recursive: true });
  let stored = `${Date.now()}-${path.basename(target)}`;
  for (let i = 2; await exists(path.join(TRASH, stored)); i += 1) stored = `${Date.now()}${i}-${path.basename(target)}`;
  const kept = path.join(TRASH, stored);
  await moveFile(target, kept);
  await fs.writeFile(path.join(TRASH_INFO, `${stored}.json`), JSON.stringify({ from: path.resolve(target) }));
  await fs.rename(made, target);
  return { path: target, kept };
}

// A file moved, across drives too.
async function moveFile(from, to) {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

// A finished file (made hidden beside where it goes) given its name, or the next free one.
async function placeFile(made, dir, name) {
  checkName(name);
  await assertAllowed(dir);
  assertNotTrash(dir);
  const target = await freeName(dir, name);
  await moveFile(made, target);
  return target;
}

// Undo for replaceFile and replaceWith: the old contents back, and out of the Trash.
async function putBack(target, kept) {
  await assertAllowed(target);
  assertInTrash(kept);
  await moveFile(kept, target);
  await fs.rm(kept, { force: true });
  await fs.rm(path.join(TRASH_INFO, `${path.basename(kept)}.json`), { force: true });
  return { path: target };
}

async function ensureFolder(dir) {
  await assertAllowed(dir);
  await fs.mkdir(dir, { recursive: true });
}

module.exports = {
  TRASH, DOOR, DOOR_FLAG, doorIsOpen, assertAllowed, assertReadable, windowsHome, list, makeFolder, makeFile, rename, trash, trashItems, restore, destroy, removeForever, emptyTrash, trashedNames,
  paste, transfer, moveBack, properties, assertDoorOpen, importFromWindows, readText, ensureFolder, freeName, assertNotTrash,
  readDoc, docStat, writeDoc, replaceFile, replaceWith, placeFile, putBack, inTrash,
};
