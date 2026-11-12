// Station 256 picks up changes to its own pages by itself, so most changes don't need a restart.
// A style change (.css) shows at once, with nothing else touched. A page change (.js, .html)
// reloads each window in place once nobody is using it for a moment, with every tab kept: folders
// with their Back and Forward, terminals (still running), the tab in front (see main.js and
// "Live updates" in renderer/app.js). Changes to the part behind the windows (main.js, lib/) still
// need a restart.
const fs = require('fs');
const path = require('path');

const SETTLE_MS = 1500; // a merge writes files one by one: wait until they've all landed

// Watches the page files and calls onChange(names) once they've settled.
// places: [folder, which names in it count].
function watchPages(places, onChange) {
  let changed = new Set();
  let timer = null;
  const watchers = places.map(([folder, counts]) => {
    try {
      const watcher = fs.watch(folder, (_event, name) => {
        if (!name || !counts(String(name))) return;
        changed.add(String(name));
        clearTimeout(timer);
        timer = setTimeout(() => {
          const names = [...changed];
          changed = new Set();
          onChange(names);
        }, SETTLE_MS);
      });
      watcher.on('error', () => {});
      return watcher;
    } catch {
      return null;
    }
  });
  return () => {
    clearTimeout(timer);
    watchers.forEach((watcher) => watcher?.close());
  };
}

// The pages' own files. Editors' hidden and temporary files don't count.
const pageFile = (name) => !name.startsWith('.') && /^[\w.-]+\.(js|css|html)$/.test(name) && !/~$|\.swp$/.test(name);

function watchPanel(panelFolder, onChange) {
  return watchPages([
    [path.join(panelFolder, 'renderer'), pageFile],
    [panelFolder, (name) => name === 'preload.js'],
  ], onChange);
}

const styleOnly = (names) => names.length > 0 && names.every((name) => name.endsWith('.css'));

module.exports = { watchPages, watchPanel, styleOnly, SETTLE_MS };
