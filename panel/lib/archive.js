// Zip and unzip, through lib/archive.py (Python's own zip and tar tools, which the house has).
// Each job reports how far along it is, the same way copies do.
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const files = require('./files');

const SCRIPT = path.join(__dirname, 'archive.py');
const ARCHIVE = /\.(zip|tar|tgz|txz|tbz2?|gz|xz|bz2)$/i;

function run(args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let result = null;
    let problem = null;
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.result) result = message.result;
        else if (message.error) problem = message.error;
        else if (onProgress) onProgress(message);
      }
    });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('error', () => reject(new Error('Python isn\'t available in the house, so zip files can\'t be handled.')));
    child.on('close', (code) => {
      if (code === 0 && result) resolve(result);
      else reject(new Error(problem || errors.trim().split('\n').pop() || 'That didn\'t work.'));
    });
  });
}

// One zip of these items, beside them, named after the first one (or the folder they're in).
async function compress(paths, onProgress) {
  if (!paths.length) throw new Error('Nothing is picked.');
  const folder = path.dirname(paths[0]);
  files.assertNotTrash(folder);
  const stem = paths.length === 1 ? path.basename(paths[0]).replace(/\.[^.]+$/, '') || path.basename(paths[0]) : path.basename(folder);
  await Promise.all([folder, ...paths].map((item) => files.assertAllowed(item)));
  const target = await files.freeName(folder, `${stem}.zip`);
  return run(['compress', target, ...paths], onProgress);
}

// mode "all": into a new folder named after the archive. mode "here": loose, if it holds one thing.
async function extract(archive, mode, onProgress) {
  const folder = path.dirname(archive);
  files.assertNotTrash(folder);
  await files.assertAllowed(archive);
  return run(['extract', archive, folder, mode === 'here' ? 'here' : 'all'], onProgress);
}

async function list(archive) {
  await files.assertReadable(archive); // only looks inside, so a zip on C: is fine
  await fs.access(archive);
  return run(['list', archive]);
}

module.exports = { compress, extract, list, ARCHIVE };
