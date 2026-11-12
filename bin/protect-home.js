#!/usr/bin/env node
// Station 256's delete guard. Claude Code runs it before every shell command an AI wants to run
// (a PreToolUse hook: in the house via its locked settings, and on Windows via the user's
// settings). It refuses commands that could empty the home folder, the projects folder, Station
// 256 itself, the Linux disk or the rooms' saved AI records. Everything else goes ahead untouched.
//
// Made after a cleanup line sent through wsl.exe deleted a whole home folder:
// the first shell turned "$HOME" into another path before Linux saw it.
//
// It reads Claude Code's JSON on stdin. To refuse, it prints a "deny" answer with a plain reason;
// to allow, it prints nothing. If it can't read its input it allows, so a broken guard never
// stops all work. Tests: panel/test/protect-home.test.js.
'use strict';
const os = require('os');

const NAME = (() => { try { return os.userInfo().username.toLowerCase(); } catch { return ''; } })();

// A path kept safe: it can't be deleted as a whole, and nor can "everything in it" (dir/*).
// Paths below these are fine (a project's build folder, a temp folder), except where noted.
const LINUX_KEEP = [
  '/', '/home', '/root', '/etc', '/usr', '/var', '/var/lib/docker', '/workspace',
  '~', '$home', '~/projects', '$home/projects', '~/house', '$home/house',
  '~/.config', '$home/.config', '~/.config/house', '$home/.config/house', '~/.local', '$home/.local',
  '~/.local/share', '$home/.local/share', '~/.local/state', '$home/.local/state',
  '~/.ssh', '$home/.ssh', '~/.claude', '$home/.claude', '~/documents', '~/pictures', '~/music',
  '~/videos', '~/downloads',
];
// Folders whose own children are kept safe too: one project, one house part.
const LINUX_KEEP_CHILDREN = ['~/projects', '$home/projects'];

function windowsKeep() {
  const keep = ['c:', 'c:/users', 'c:/windows', '$env:userprofile', '%userprofile%',
    '$env:localappdata', '%localappdata%', '$env:appdata', '%appdata%', 'l:'];
  const homes = [`c:/users/${NAME}`, '$env:userprofile', '%userprofile%', '~'];
  for (const h of homes) {
    for (const sub of ['', '/documents', '/desktop', '/downloads', '/pictures', '/music', '/videos',
      '/onedrive', '/appdata', '/appdata/local', '/appdata/local/linuxhouse', '/appdata/local/packages',
      '/appdata/local/wsl', '/documents/station backup', '/documents/station backup/restore',
      '/documents/station backup/projects-backup', '/.claude']) keep.push(h + sub);
  }
  return keep;
}
const WINDOWS_KEEP_CHILDREN = [`c:/users/${NAME}/documents/station backup/projects-backup`,
  '$env:userprofile/documents/station backup/projects-backup', '~/documents/station backup/projects-backup', 'l:'];

// The Linux home seen from Windows. A path through here is a Linux path.
const UNC = /^(\/\/wsl\.localhost\/[^/]+|\/\/wsl\$\/[^/]+)(?=\/|$)/;

const KEEP = new Set([...LINUX_KEEP, ...windowsKeep()]);
const KEEP_CHILDREN = [...LINUX_KEEP_CHILDREN, ...WINDOWS_KEEP_CHILDREN];

// Words that delete a whole folder at a time (or many files at once).
const DELETERS = [
  /(^|[\s;&|(`'"])(rm|rmdir)(\s+-[\w-]*|\s+--[\w-]+)*\s+(-[a-z]*r[a-z]*|-r|--recursive)\b/i,
  /(^|[\s;&|(`'"])(rm)\s+[^;&|\n]*\s-[a-z]*r[a-z]*\b/i,
  /\b(remove-item|ri|rm|rmdir|rd|del|erase)\b[^;&|\n]*\s-r(ecurse)?\b/i,
  /\b(rd|rmdir)\b[^;&|\n]*\s\/s\b/i,
  /\bdel\b[^;&|\n]*\s\/s\b/i,
  /\bfind\b[^;&|\n]*\s(-delete|-exec\s+rm)\b/i,
  /\b(shutil\.rmtree|rmtree|rimraf|rmsync|rmdirsync|directory\]::delete|fs\.rm\b|fs\.promises\.rm\b|remove_dir_all)/i,
  /\brsync\b[^;&|\n]*\s--delete/i,
  /\brobocopy\b[^;&|\n]*\s\/(mir|purge)\b/i,
];

const lower = (s) => s.toLowerCase();

// Linux names that wsl --unregister must never remove: Ubuntu, the distro this runs in, and the
// one the installer recorded in house.json (Windows side).
function protectedDistros() {
  const names = new Set(['ubuntu']);
  if (process.env.WSL_DISTRO_NAME) names.add(lower(process.env.WSL_DISTRO_NAME));
  try {
    const file = require('path').join(process.env.LOCALAPPDATA || '', 'LinuxHouse', 'house.json');
    const d = JSON.parse(require('fs').readFileSync(file, 'utf8').replace(/^﻿/, '')).distro;
    if (d) names.add(lower(String(d)));
  } catch { /* no installer config here */ }
  return [...names];
}

// Drops the inside of here-documents that are only being saved to a file (cat > x <<'EOF' ...),
// so writing a script that cleans up its own temp folder isn't mistaken for running it. A
// here-document fed straight to a shell is kept and checked.
function stripSavedHeredocs(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/);
    const ps = line.match(/@(['"])\s*$/);
    if (m && /\b(cat|tee)\b[^|]*>/.test(line) && !/\b(bash|sh|zsh|wsl(\.exe)?)\b/.test(line.split('<<')[0].replace(/\bcat\b.*/, ''))) {
      const end = m[2];
      while (i + 1 < lines.length && lines[i + 1].trim() !== end) i++;
    } else if (ps && /(set-content|out-file|writealltext|\$\w+\s*=)/i.test(line)) {
      const end = ps[1] + '@';
      while (i + 1 < lines.length && !lines[i + 1].startsWith(end)) i++;
    }
  }
  return out.join('\n');
}

// Splits one command into words, keeping quoted parts together.
function words(segment) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Makes a path comparable: lower case, forward slashes, $HOME spelled one way, no trailing /.
function tidy(word) {
  let p = lower(word.trim()).replace(/\\/g, '/');
  p = p.replace(/\$\{home\}/g, '$home').replace(/\$\{env:userprofile\}/g, '$env:userprofile');
  p = p.replace(/^\/mnt\/c(?=\/|$)/, 'c:').replace(/^\/c(?=\/|$)/, 'c:');
  p = p.replace(/^l:(?=[^/]|$)/, 'l:/');
  const unc = p.match(UNC);
  if (unc) p = p.slice(unc[0].length) || '/';
  p = p.replace(/\/{2,}/g, '/');
  if (NAME) p = p.replace(new RegExp(`^/home/${NAME}(?=/|$)`), '~');
  p = p.replace(/^\$home(?=\/|$)/, '$home');
  p = p.replace(/(\/\.)+$/, '');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (p === 'l:') return 'l:';
  return p;
}

const isAbsolute = (p) => /^(\/|~|\$home|\$env:|%|[a-z]:)/.test(p);

// Joins a relative path onto the folder the command runs in, and folds "." and "..".
function resolve(word, cwd) {
  let p = tidy(word);
  if (!isAbsolute(p) && cwd) p = `${cwd}/${p}`;
  const head = p.match(/^(\/|~|\$home|\$env:\w+|%\w+%|[a-z]:)/);
  const root = head ? head[0] : '';
  const parts = [];
  for (const part of p.slice(root.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  if (root === '/') return '/' + parts.join('/');
  return parts.length ? `${root}/${parts.join('/')}` : root;
}

function isKept(word, cwd) {
  let p = resolve(word, cwd);
  if (!p) return false;
  // "dir/*", "dir/.*", "dir/**": everything in a folder.
  const all = p.match(/^(.*?)\/(\*|\.\*|\*\*|\.\[!.\]\*|\{\*,\.\*\})$/);
  if (all) p = all[1] || '/';
  if (p === '*' || p === '.*' || p === '.') return false; // folder unknown
  const homeAlias = p.replace(/^\$home(?=\/|$)/, '~');
  if (KEEP.has(p) || KEEP.has(homeAlias)) return true;
  if (/^\/home\/[^/]+$/.test(p)) return true; // anyone's home folder
  for (const parent of KEEP_CHILDREN) {
    const t = tidy(parent);
    if ((p.startsWith(t + '/') && !p.slice(t.length + 1).includes('/')) ||
        (homeAlias.startsWith(t + '/') && !homeAlias.slice(t.length + 1).includes('/'))) return true;
  }
  return false;
}

// The paths in one delete command that would be removed as a whole.
function targets(segment) {
  const w = words(segment.trim());
  // Code that deletes (shutil.rmtree('/x'), fs.rmSync("/x")): the quoted paths inside it.
  if (DELETERS[6].test(segment)) {
    const quoted = [...segment.matchAll(/(['"])([^'"]+)\1/g)].map((m) => m[2]);
    const inCall = [...segment.matchAll(/\(\s*\\?(['"])([^'"\\]+)\\?\1/g)].map((m) => m[2]);
    return [...quoted, ...inCall, ...w];
  }
  const cmd = w.findIndex((x) => /^(robocopy|rsync|find)$/i.test(x));
  const paths = (list) => list.filter((x) => !/^-/.test(x) && !/^\/(s|q|mir|purge|e|xd|xf|r:\d+|w:\d+)$/i.test(x));
  if (cmd >= 0) {
    const rest = paths(w.slice(cmd + 1));
    const name = lower(w[cmd]);
    if (name === 'robocopy') return rest.slice(1, 2); // only the folder being copied into
    if (name === 'rsync') return rest.slice(-1);
    // find: only when it deletes everything under where it starts.
    if (/\s-(i?name|i?path|i?regex|newer|m?min|mtime|size|empty)\b/i.test(segment)) return [];
    return rest.slice(0, 1);
  }
  return paths(w);
}

function check(command, startDir) {
  const raw = String(command || '');
  const text = stripSavedHeredocs(raw);
  const low = lower(text);
  const deletes = DELETERS.some((re) => re.test(text));

  // Removing the Linux system itself, or its disk file.
  for (const name of protectedDistros()) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\bwsl(\\.exe)?\\b[^;&|\\n]*--unregister\\s+("|')?${esc}(?![\\w.-])`, 'i').test(text)) {
      return `This would remove the whole Linux system (${name}), with every project in it. Only the user can do that, by hand.`;
    }
  }
  if (/ext4\.vhdx/i.test(text) && (deletes || /\b(remove-item|del|erase|rm|ri|move-item|mv)\b/i.test(text))) {
    return 'This touches the Linux disk file (ext4.vhdx). Deleting or moving it loses everything in Linux. Only the user can do that, by hand.';
  }
  // The rooms' saved AI records (Docker volumes). They saved the projects once already.
  if (/\bdocker\b[^;&|\n]*\b(volume\s+prune|system\s+prune[^;&|\n]*--volumes|volume\s+rm\b[^;&|\n]*house-claude)/i.test(text)) {
    return "This would delete the rooms' saved AI records (Docker volumes). They are kept on purpose: never prune or remove them.";
  }
  if (!deletes) return null;

  // Changing HOME in the same command as a delete: the exact mix that once wiped a whole home folder.
  if (/(^|[\s;&|(`])(export\s+)?home=|\$env:home\s*=/i.test(text)) {
    return 'This changes HOME and deletes things in the same command. That is how a whole home folder was once wiped. Use a test-only variable instead of HOME, and delete only plain, full paths.';
  }
  // A delete passed through wsl.exe (or through the \\wsl.localhost door): the first shell can
  // rewrite $HOME, ~ and other names before Linux ever sees them.
  const copyOnly = !DELETERS.slice(0, -2).some((re) => re.test(text)); // only robocopy/rsync
  if (!copyOnly && /\bwsl(\.exe)?\b|\/\/wsl\.localhost|\\\\wsl\.localhost|\/\/wsl\$|\\\\wsl\$/i.test(text)) {
    return "Deleting through a wsl.exe command line (or a \\\\wsl.localhost path) isn't allowed: the first shell can turn $HOME or ~ into another path before Linux sees it. That once wiped a whole home folder. Write the delete into a script file with plain, full paths and run it with: wsl.exe -d Ubuntu -e bash /path/to/script.sh";
  }
  // A delete aimed at a folder that must never go as a whole. "cd" in the command is followed,
  // so "cd ~ && rm -rf *" is caught too.
  let cwd = startDir ? resolve(startDir, '') : '';
  for (const segment of text.split(/[;&|\n]+/)) {
    const cd = segment.trim().match(/^(cd|set-location|sl|pushd)\s+(.+)$/i);
    if (cd) { cwd = resolve(words(cd[2])[0] || '~', cwd); continue; }
    if (/^\s*(cd|set-location|sl|pushd)\s*$/i.test(segment)) { cwd = '~'; continue; }
    if (!DELETERS.some((re) => re.test(segment))) continue;
    for (const w of targets(segment)) {
      if (/^(rm|rmdir|rd|del|erase|ri|remove-item|sudo|xargs|command|builtin|exec|env|nice|time)$/i.test(w)) continue;
      if (isKept(w, cwd)) {
        return `This would delete "${w}", a folder that must never be deleted as a whole (home, projects, Station 256, or a whole project). Delete only the exact files or subfolders you mean, by full path. To remove a project, use Delete in Station 256 so it goes to the Trash.`;
      }
    }
  }
  return null;
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    let data;
    try { data = JSON.parse(input); } catch { return; }
    const tool = data && data.tool_name;
    if (tool !== 'Bash' && tool !== 'PowerShell') return;
    const reason = check(data.tool_input && data.tool_input.command, data.cwd);
    if (!reason) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Station 256 delete guard: ${reason}`,
      },
    }));
  });
}

if (require.main === module) main();
module.exports = { check, isKept, tidy };
