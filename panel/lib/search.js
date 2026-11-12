// "All folders inside" search: finds files and folders by name anywhere under a folder, as you
// type. It walks one folder at a time, nearest folders first, so the first results come quickly,
// and it hands control back often so the window never stalls however big the tree is.
const fs = require('fs/promises');
const path = require('path');

const LIMIT = 1000; // more than this can't be read anyway; the page says to type more
const BATCH = 50; // results sent together
const BATCH_MS = 80; // but never held longer than this, so the first ones show at once
const YIELD_EVERY = 200; // names looked at before letting the rest of the app run

// Folders full of things nobody searches for by name (and that hold huge numbers of files).
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', '.cache', '.next', 'target', 'dist', 'build', '__pycache__', '.venv']);

// Every word typed must appear in the name, in any order, ignoring capitals.
function words(query) {
  return String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(name, wanted) {
  if (!wanted.length) return false;
  const lower = name.toLowerCase();
  return wanted.every((word) => lower.includes(word));
}

// Folders that are never walked into: the list above, and any hidden folder.
function skipFolder(name) {
  return SKIPPED_FOLDERS.has(name) || name.startsWith('.');
}

const later = () => new Promise((resolve) => setImmediate(resolve));

// Walks `root`. `send(results)` gets batches of entries shaped like the folder list's, plus
// `folder` (where it lives) and `where` (that, relative to root). `token.cancelled` stops it.
// `readable(dir)` throws for folders the house doesn't allow looking in. Resolves with
// { total, capped, cancelled }.
// With `all`, every file `keep(full, item)` accepts counts, whatever its name (by-meaning search
// uses this to gather candidates), up to `limit`.
async function search(root, query, { showHidden = false, readable, all = false, keep = () => true, limit = LIMIT }, send, token) {
  const wanted = words(query);
  const result = { total: 0, capped: false, cancelled: false };
  if (!wanted.length && !all) return result;
  await readable(root);

  let pending = [];
  let sentAt = Date.now();
  const flush = async () => {
    if (!pending.length) return;
    const found = pending;
    pending = [];
    sentAt = Date.now();
    // The size and date come from one look at each result, not at every file passed.
    const entries = await Promise.all(found.map(async (item) => {
      try {
        const stat = await fs.stat(item.path);
        return { ...item, isDir: stat.isDirectory(), size: stat.size, mtime: stat.mtimeMs };
      } catch {
        return item; // a broken link still shows, just without a size
      }
    }));
    if (!token.cancelled) send(entries);
  };

  let looked = 0;
  const queue = [{ dir: root, where: '' }];
  for (let next = 0; next < queue.length && !token.cancelled && !result.capped; next += 1) {
    const { dir, where } = queue[next];
    queue[next] = null; // lets the memory go as the walk moves on
    let handle;
    try {
      handle = await fs.opendir(dir);
    } catch {
      continue; // no permission or gone since it was seen: skipped, not fatal
    }
    try {
      for await (const item of handle) {
        if (token.cancelled) break;
        if (++looked % YIELD_EVERY === 0) await later();
        const hidden = item.name.startsWith('.');
        const full = path.join(dir, item.name);
        // Links are listed if they match but never followed, so a loop can't trap the walk.
        if (item.isDirectory() && !skipFolder(item.name)) {
          try {
            await readable(full);
            queue.push({ dir: full, where: where ? `${where}/${item.name}` : item.name });
          } catch { /* a place the house doesn't allow: left out like the folder list leaves it out */ }
        }
        if ((hidden && !showHidden) || !(all ? keep(full, item) : matches(item.name, wanted))) continue;
        pending.push({ name: item.name, path: full, isDir: item.isDirectory(), size: 0, mtime: 0, folder: dir, where });
        result.total += 1;
        if (result.total >= limit) {
          result.capped = true;
          break;
        }
      }
    } catch { /* a folder that broke while being read: what was found stays */ } finally {
      await handle.close().catch(() => {});
    }
    if (pending.length >= BATCH || (pending.length && Date.now() - sentAt >= BATCH_MS)) await flush();
  }
  await flush();
  result.cancelled = token.cancelled;
  return result;
}

// One search at a time per window: starting another, or cancelling, stops the one before.
const running = new Map(); // window id -> { id, token }

function cancel(windowId) {
  const current = running.get(windowId);
  if (current) {
    current.token.cancelled = true;
    current.token.stop?.(); // a search that is waiting on the network stops waiting
  }
  running.delete(windowId);
}

function register(windowId, id) {
  cancel(windowId);
  const token = { cancelled: false };
  running.set(windowId, { id, token });
  return token;
}

function release(windowId, token) {
  if (running.get(windowId)?.token === token) running.delete(windowId);
}

// A search also stops when its page closes or loads again: nothing is left to show the results
// to, and a search by meaning would go on costing money. Returns how to stop watching.
function stopWithPage(page, token) {
  const stop = () => {
    token.cancelled = true;
    token.stop?.();
  };
  page.once('destroyed', stop);
  page.once('did-navigate', stop);
  return () => {
    page.off('destroyed', stop);
    page.off('did-navigate', stop);
  };
}

// Sends results to the window as 'search:batch' and 'search:done', each tagged with `id` so the
// page can drop anything from a search it has already moved on from.
function start(window, windowId, id, root, query, showHidden, readable) {
  const token = register(windowId, id);
  const unwatch = stopWithPage(window, token);
  const tell = (channel, payload) => {
    if (token.cancelled || window.isDestroyed()) return;
    window.send(channel, { id, ...payload });
  };
  search(root, query, { showHidden, readable }, (results) => tell('search:batch', { results }), token)
    .then((done) => tell('search:done', { total: done.total, capped: done.capped }))
    .catch((error) => tell('search:done', { total: 0, capped: false, error: error.message }))
    .finally(() => { unwatch(); release(windowId, token); });
}

module.exports = { LIMIT, SKIPPED_FOLDERS, words, matches, skipFolder, search, start, cancel, register, release, stopWithPage };
