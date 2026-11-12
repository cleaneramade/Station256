// The video editor's link to Station 256 (lib/editor-app.js): house files to open, saving what it
// exports into the house, and Station's own tab keys while you're in it.
const { contextBridge, ipcRenderer } = require('electron');

const PART = 8 * 1024 * 1024;
const ask = (name, args) => ipcRenderer.invoke('station-editor', name, args);

// An export goes over 8 MB at a time and is written to a file as it arrives, so Station never
// holds the whole video (as one message, a 112 MB video held Station up for 173 ms and took 114 MB).
async function saveExport(bytes, filename, source) {
  const id = await ask('exportStart', [bytes.byteLength]);
  try {
    for (let at = 0; at < bytes.byteLength; at += PART) await ask('exportPart', [id, bytes.slice(at, at + PART)]);
  } catch (error) {
    ask('exportStop', [id]).catch(() => {});
    throw error;
  }
  return ask('saveExport', [id, filename, source]);
}

contextBridge.exposeInMainWorld('station', {
  houseUrl: (target) => `station-editor://app/house${String(target).split('/').map(encodeURIComponent).join('/')}`,
  saveExport,
  // The file to read for a house file: itself, or a copy the editor can read, made first.
  editable: (target) => ipcRenderer.invoke('station-editor', 'editable', [String(target)]),
  onProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('station-editor:progress', listener);
    return () => ipcRenderer.removeListener('station-editor:progress', listener);
  },
  reveal: (target) => ipcRenderer.sendToHost('reveal', String(target)),
});

// Ctrl+Tab, Ctrl+W and Ctrl+T are Station's, as in every other tab.
window.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || event.altKey || event.metaKey) return;
  const lower = event.key.toLowerCase();
  if (event.key !== 'Tab' && (event.shiftKey || (lower !== 'w' && lower !== 't'))) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.sendToHost('key', { key: event.key, shift: event.shiftKey });
}, true);
