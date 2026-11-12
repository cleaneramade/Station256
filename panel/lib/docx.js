// Word documents, read-only, through lib/docx.py (Python's own zip and XML tools, which the house has).
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const files = require('./files');

const SCRIPT = path.join(__dirname, 'docx.py');
const DOCX = /\.docx$/i;

async function read(target) {
  await files.assertReadable(target); // only reads, so a file on C: is fine
  await fs.access(target);
  // Pictures come back inside the answer, so it can be large (python caps them at 20 MB).
  return new Promise((resolve, reject) => {
    execFile('python3', ['-I', SCRIPT, target], { maxBuffer: 80 * 1024 * 1024, timeout: 30000 }, (failed, out) => {
      let message = null;
      try { message = JSON.parse(out); } catch { /* handled below */ }
      if (message?.result) resolve(message.result);
      else reject(new Error(message?.error || (failed ? 'That document couldn\'t be read.' : 'That didn\'t work.')));
    });
  });
}

module.exports = { read, DOCX };
