// Turns a path an AI printed in a terminal (or one typed in the address bar) into a path in the
// house. The mapping itself (toHouse) needs no disk, so it can be checked on its own.
const fs = require('fs/promises');
const path = require('path');
const { mapRoomPath } = require('./edits');

// Folders a room mounts from the house home, at /home/dev/<Folder>.
const ROOM_HOME = ['Documents', 'Pictures', 'Music', 'Videos', 'Downloads'];

// ctx: { home, base (the room's project folder, or null), door (the C: mount, or null while locked) }.
// Returns an absolute house path, or null if the text isn't a place we can open.
function toHouse(raw, ctx) {
  const text = String(raw).trim().replace(/^["'`]+|["'`]+$/g, '').replace(/:\d+(?::\d+)?$/, '');
  // Nothing may climb with "..": that's how a path would leave the room or the folder it names.
  if (!text || text.split(/[\\/]/).includes('..')) return null;
  const slashed = (rest) => path.posix.normalize(`/${rest.replaceAll('\\', '/')}`);
  const noTail = (p) => p.replace(/(.)\/$/, '$1');
  let m;
  if (text === '/workspace' || text.startsWith('/workspace/')) return ctx.base ? noTail(mapRoomPath(ctx.base, path.posix.normalize(text))) : null;
  if ((m = /^\/home\/dev\/([^/]+)(\/.*)?$/.exec(text))) return ROOM_HOME.includes(m[1]) ? noTail(path.posix.normalize(`${ctx.home}/${m[1]}${m[2] || ''}`)) : null;
  if ((m = /^~(\/.*)?$/.exec(text))) return noTail(path.posix.normalize(`${ctx.home}${m[1] || ''}`));
  if (text === ctx.home || text.startsWith(`${ctx.home}/`)) return noTail(path.posix.normalize(text));
  if ((m = /^[Ll]:[\\/]?(.*)$/.exec(text))) return noTail(slashed(m[1]));
  if ((m = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(?:\\(.*))?$/i.exec(text))) return noTail(slashed(m[1] || ''));
  if ((m = /^[Cc]:[\\/]?(.*)$/.exec(text))) return ctx.door ? noTail(path.posix.normalize(`${ctx.door}${slashed(m[1])}`)) : null;
  return null;
}

// { path, isDir } for something that exists, else null.
async function resolve(raw, ctx) {
  const target = toHouse(raw, ctx);
  if (!target) return null;
  try {
    return { path: target, isDir: (await fs.stat(target)).isDirectory() };
  } catch {
    return null;
  }
}

module.exports = { toHouse, resolve };
