// "Words inside files" search: finds text files whose CONTENTS hold what was typed, by asking
// GNU grep. The words go in as one plain argument (never through a shell), so nothing typed can
// run anything. Hidden things, the folders "All folders inside" skips, and anything that looks
// like a key or password are left out; binary files are skipped by grep itself.
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const search = require('./search');
const jev = require('./jev');

const LIMIT = 500; // files shown; the page says to type more
const LONGEST_MS = 60000; // a search that runs longer than this is stopped
const BATCH = 25;

// Skips hidden folders and files too (".?*" so that the folder being searched, ".", still counts).
const SKIPS = [...search.SKIPPED_FOLDERS].map((name) => `--exclude-dir=${name}`).concat('--exclude-dir=.?*', '--exclude=.?*');

// grep -F reads each line of the pattern as its own word, so line breaks become spaces.
const clean = (query) => String(query || '').replace(/[\0\r\n]+/g, ' ').trim();

// Calls send(entries) with batches shaped like the name search's. Resolves { total, capped }.
async function run(root, query, send, token) {
  const text = clean(query);
  const result = { total: 0, capped: false };
  if (!text) return result;
  const child = spawn('grep', ['-rIl', '-i', '-F', '-Z', ...SKIPS, '-e', text, '.'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  const stop = () => child.kill('SIGKILL');
  token.stop = stop;
  const timer = setTimeout(stop, LONGEST_MS);
  let rest = '';
  let found = [];
  const flush = async () => {
    const batch = found;
    found = [];
    const entries = await Promise.all(batch.map(async (item) => {
      try {
        const stat = await fs.stat(item.path);
        return { ...item, size: stat.size, mtime: stat.mtimeMs };
      } catch {
        return item;
      }
    }));
    if (!token.cancelled) send(entries);
  };
  const take = (relative) => {
    const full = path.join(root, relative);
    if (jev.isSecretPath(full)) return;
    const folder = path.dirname(full);
    found.push({ name: path.basename(full), path: full, isDir: false, size: 0, mtime: 0, folder, where: path.relative(root, folder) });
    if (++result.total >= LIMIT) {
      result.capped = true;
      stop();
    }
  };
  await new Promise((resolve) => {
    child.on('error', resolve); // no grep to run: nothing found
    child.on('close', resolve);
    child.stdout.on('data', async (chunk) => {
      const names = (rest + chunk).split('\0');
      rest = names.pop();
      names.forEach(take);
      if (found.length >= BATCH) await flush();
    });
  });
  clearTimeout(timer);
  await flush();
  return result;
}

// Same hand-off as lib/search.js: results go to the window as 'search:batch' and 'search:done'.
function start(window, windowId, id, root, query, readable) {
  const token = search.register(windowId, id);
  const unwatch = search.stopWithPage(window, token);
  const tell = (channel, payload) => {
    if (token.cancelled || window.isDestroyed()) return;
    window.send(channel, { id, ...payload });
  };
  readable(root)
    .then(() => run(root, query, (results) => tell('search:batch', { results }), token))
    .then((done) => tell('search:done', { total: done.total, capped: done.capped }))
    .catch((error) => tell('search:done', { total: 0, capped: false, error: error.message }))
    .finally(() => { unwatch(); search.release(windowId, token); });
}

module.exports = { LIMIT, clean, run, start };
