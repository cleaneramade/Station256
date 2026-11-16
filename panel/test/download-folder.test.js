// Which folder a browser download goes to. Run: node test/download-folder.test.js
// lib/obscura.js needs electron, so it is loaded with a stand-in.
const Module = require('module');
const load = Module._load;
Module._load = (request, ...rest) => (request === 'electron' ? { app: {}, BrowserWindow: {}, screen: {}, session: {}, webContents: {} } : load(request, ...rest));
Object.defineProperty(process.versions, 'chrome', { value: '1.0.0', configurable: true });
const { folderFor } = require('../lib/obscura');

let failed = 0;
const check = (name, mime, want) => {
  const got = folderFor(name, mime);
  console.log(`${got === want ? 'PASS' : 'FAIL'} ${name} (${mime || 'no type'}) -> ${got}`);
  if (got !== want) failed += 1;
};
check('song.mp3', 'audio/mpeg', 'Music');
check('clip.bin', 'video/mp4', 'Videos');
check('MOVIE.MKV', '', 'Videos');
check('photo.jpg', 'image/jpeg', 'Pictures');
check('logo.svg', '', 'Pictures');
check('report.pdf', 'application/pdf', 'Documents');
check('Sheet.XLSX', 'application/octet-stream', 'Documents');
check('notes.md', 'text/markdown', 'Documents');
check('setup.exe', 'application/octet-stream', 'Downloads');
check('site.zip', 'application/zip', 'Downloads');
check('page.html', 'text/html', 'Downloads');
check('', '', 'Downloads');
process.exit(failed ? 1 : 0);
