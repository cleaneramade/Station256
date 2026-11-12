// Station 256's video editor: OpenCut (MIT, github.com/OpenCut-app/opencut-classic), made Station's
// own in ../editor and built into ../editor/out. Its pages are served as station-editor://app in a
// session of its own, where it keeps its projects. It reads house files through
// station-editor://app/house/<path>, and saves what it exports through editor-preload.js.
// It's shown in a Station tab as a <webview> (renderer/editor-tab.js).
const { net, session, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SCHEME = 'station-editor';
const ORIGIN = `${SCHEME}://app`;
const PARTITION = 'persist:station-editor';
const BUILT = path.join(__dirname, '..', '..', 'editor', 'out');
const PRELOAD = path.join(__dirname, '..', 'editor-preload.js');
// What the editor may ask for: copy and paste in the timeline, full screen, a voiceover.
const ALLOWED = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'fileSystem', 'storage-access', 'top-level-storage-access', 'pointerLock', 'media']);

const ready = () => fs.existsSync(path.join(BUILT, 'index.html'));
const isFile = (file) => fs.promises.stat(file).then((info) => info.isFile(), () => false);
let editorSession = null;
let copies = 0;
// Exports on their way over from the editor, a piece at a time (editor-preload.js).
const arriving = new Map();
let exportsBegun = 0;

// The built page for a path: the file itself, or its folder's index.html (/projects/).
async function builtFile(route) {
  const inside = path.normalize(path.join(BUILT, route));
  if (inside !== BUILT && !inside.startsWith(`${BUILT}${path.sep}`)) return null;
  for (const candidate of [inside, path.join(inside, 'index.html'), `${inside}.html`]) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

// deps: files (lib/files.js), partOfFile (a Range answer), editableFor, stopCopy and exportFile
// (lib/video.js), saveExport, openLink (Windows' browser).
function start({ files, partOfFile, editableFor, stopCopy, exportFile, saveExport, openLink }) {
  editorSession = session.fromPartition(PARTITION);
  editorSession.protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const route = decodeURIComponent(url.pathname);
    if (route.startsWith('/house/')) {
      const target = route.slice('/house'.length);
      try {
        await files.assertReadable(target);
      } catch {
        return new Response('Not available', { status: 403 });
      }
      const asked = request.headers.get('range');
      if (asked) {
        const part = await partOfFile(target, asked).catch(() => null);
        if (part) return part;
      }
      return net.fetch(pathToFileURL(target).toString(), { bypassCustomProtocolHandlers: true });
    }
    const file = await builtFile(route);
    if (!file) {
      const missing = path.join(BUILT, '404.html');
      return new Response(await fs.promises.readFile(missing).catch(() => 'Not found'), { status: 404, headers: { 'Content-Type': 'text/html' } });
    }
    return net.fetch(pathToFileURL(file).toString(), { bypassCustomProtocolHandlers: true });
  });
  editorSession.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED.has(permission)));
  editorSession.setPermissionCheckHandler((_contents, permission) => ALLOWED.has(permission));

  ipcMain.handle(SCHEME, async (event, name, args) => {
    if (event.sender.session !== editorSession) throw new Error('Only the editor can ask this.');
    // An export comes in pieces and goes straight into a file: sent as one message, the whole
    // video was held in memory here and Station stopped answering while it arrived.
    if (name === 'exportStart') {
      const [size] = Array.isArray(args) ? args : [];
      if (typeof size !== 'number' || !(size > 0)) throw new Error('There was nothing to save.');
      const file = await exportFile(size);
      const handle = await fs.promises.open(file, 'w');
      exportsBegun += 1;
      const id = `export-${exportsBegun}`;
      // Dropped if the editor's tab closes, or the editor gives up, before it's all here.
      const drop = () => {
        if (!arriving.delete(id)) return;
        event.sender.removeListener('destroyed', drop);
        handle.close().catch(() => {}).then(() => fs.promises.rm(file, { force: true })).catch(() => {});
      };
      event.sender.once('destroyed', drop);
      arriving.set(id, { file, handle, drop, left: size });
      return id;
    }
    if (name === 'exportPart' || name === 'exportStop' || name === 'saveExport') {
      const [id, value, source] = Array.isArray(args) ? args : [];
      const coming = arriving.get(id);
      if (!coming) throw new Error('There was nothing to save.');
      if (name === 'exportStop') {
        coming.drop();
        return true;
      }
      if (name === 'exportPart') {
        if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new Error('There was nothing to save.');
        const part = value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (part.length > coming.left) throw new Error('More came than was said.');
        coming.left -= part.length;
        await coming.handle.write(part);
        return true;
      }
      if (coming.left !== 0) {
        coming.drop();
        throw new Error('The video didn\'t all arrive.');
      }
      arriving.delete(id);
      event.sender.removeListener('destroyed', coming.drop);
      await coming.handle.close();
      return saveExport(coming.file, String(value || 'Video.mp4'), typeof source === 'string' ? source : null);
    }
    if (name === 'editable') {
      // The file to read for this one: itself, or a copy the editor can read (lib/video.js).
      // Pictures, sounds and anything that isn't a video are read as they are.
      const [target] = Array.isArray(args) ? args : [];
      if (typeof target !== 'string' || !target.startsWith('/')) throw new Error('There was no file.');
      await files.assertReadable(target);
      const tell = (part) => { if (!event.sender.isDestroyed()) event.sender.send(`${SCHEME}:progress`, { target, percent: Math.round(part * 100) }); };
      // The copy stops being made if the editor's tab closes first: nobody is waiting for it.
      copies += 1;
      const job = `editor-copy-${copies}`;
      const stop = () => stopCopy(job);
      event.sender.once('destroyed', stop);
      return editableFor(target, { job, onProgress: tell }).catch((error) => {
        if (/no picture|couldn't be read/i.test(error.message)) return target;
        throw error;
      }).finally(() => event.sender.removeListener('destroyed', stop));
    }
    throw new Error(`Unknown request: ${name}`);
  });

  // The editor stays on its own pages; links out open in Windows' browser. Its "leave this page?"
  // check is skipped: Station saves its project first (renderer/editor-tab.js).
  return (guest) => {
    guest.on('will-prevent-unload', (event) => event.preventDefault());
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) openLink(url);
      return { action: 'deny' };
    });
    guest.on('will-navigate', (event, url) => {
      if (url.startsWith(`${ORIGIN}/`)) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) openLink(url);
    });
  };
}

// A Station window may only hold the editor, in its own session, with only its own bridge.
function guardAttach(event, webPreferences, params) {
  if (!String(params.src || '').startsWith(`${ORIGIN}/`)) {
    event.preventDefault();
    return;
  }
  delete webPreferences.preloadURL;
  webPreferences.preload = PRELOAD;
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  params.partition = PARTITION;
}

function guardWebviews(contents) {
  contents.on('will-attach-webview', guardAttach);
}

module.exports = { start, guardWebviews, guardAttach, ready, SCHEME, ORIGIN, PARTITION };
