/* Station 256: explorer, projects, rooms, terminals, rules and the system panel. */
const $ = (id) => document.getElementById(id);
const call = (name, ...args) => window.house.call(name, ...args);
const PLAIN_ERRORS = {
  ENOENT: 'It isn\'t there anymore.',
  EACCES: 'You don\'t have permission to do that here.',
  EPERM: 'You don\'t have permission to do that here.',
  EROFS: 'This location is read-only.',
  ENOSPC: 'The house is out of space.',
  EEXIST: 'Something with that name is already there.',
  ENOTEMPTY: 'That folder isn\'t empty.',
  EBUSY: 'It\'s being used by something else right now.',
  ENOTDIR: 'That isn\'t a folder.',
};

function cleanError(error) {
  const message = String(error.message || error).replace(/^Error invoking remote method 'call': (Error: )?/, '');
  const code = message.match(/^(E[A-Z]+):/);
  return (code && PLAIN_ERRORS[code[1]]) || message;
}

function setIcon(el, name) {
  el.dataset.i = name;
  el.style.maskImage = `url("icons/${name}.svg")`;
}
const iconsIn = (root) => root.querySelectorAll('i[data-i]').forEach((el) => setIcon(el, el.dataset.i));
iconsIn(document);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name, className) {
  const node = el('i', className);
  setIcon(node, name);
  return node;
}

const state = {
  home: '/',
  projects: '/',
  trash: '/',
  tabs: [],
  active: null,
  entries: [],
  selected: new Set(),
  anchor: null,
  focus: null, // the item the arrow keys move from
  clipboard: null,
  windowsFiles: 0, // how many files are copied in Windows right now
  windowsPicture: false, // whether the newest copy in Windows is a picture, such as a screen snip
  sortBy: 'name',
  sortAsc: true,
  viewMode: 'details',
  showHidden: false,
  search: '',
  status: { rooms: [], dockerOk: true, keeper: '', doorOpen: false },
};
let copyJob = null; // a copy, move or delete running right now, and the pages it belongs to
let renaming = null; // a name being typed in place
// Choices that are remembered: from the View menu, and whether the System panel's Activity list
// is open, with the newest problem in it that was seen.
const prefs = { checks: true, activityOpen: false, activitySeen: '' };

/* ---------- Small dialogs ---------- */

const dialog = $('dialog');

function showDialog(build) {
  return new Promise((resolve) => {
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    dialog.className = 'dialog'; // a look one dialog added (House Rules is wider) isn't kept
    build(dialog, (value) => {
      dialog.close();
      resolve(value);
    });
    // Esc closes a dialog by itself. That counts as cancelling, so nothing is left waiting on it.
    dialog.addEventListener('close', () => resolve(undefined), { once: true });
    iconsIn(dialog);
    dialog.showModal();
    dialog.style.setProperty('--half-height', `${dialog.offsetHeight / 2}px`);
  });
}

// A click off something closes it. Pressing inside and letting go outside, as when selecting text, doesn't count.
function closeOnClickOff(area, isOff, close) {
  let pressedOff = false;
  area.addEventListener('pointerdown', (event) => { pressedOff = isOff(event); });
  area.addEventListener('click', (event) => {
    if (pressedOff && isOff(event)) close();
    pressedOff = false;
  });
}

// Counts as cancelling, the same as Esc. The dialog's own padding is part of it, so the position is what tells.
closeOnClickOff(dialog, (event) => {
  const box = dialog.getBoundingClientRect();
  return event.target === dialog
    && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
}, () => dialog.close());

function dialogFrame(host, title, message) {
  host.append(el('h2', 'dialog-title', title));
  if (message) host.append(el('p', 'dialog-text', fitLines(message, FIT.dialog)));
}

function dialogButtons(host, buttons) {
  const row = el('div', 'dialog-buttons');
  buttons.forEach(({ label, primary, danger, onClick }) => {
    const button = el('button', `btn${primary ? ' primary' : ''}${danger ? ' danger' : ''}`, label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    row.append(button);
  });
  host.append(row);
}

const alertBox = (title, message) => showDialog((host, done) => {
  dialogFrame(host, title, message);
  dialogButtons(host, [{ label: 'OK', primary: true, onClick: () => done() }]);
});

const confirmBox = (title, message, confirmLabel, danger) => showDialog((host, done) => {
  dialogFrame(host, title, message);
  dialogButtons(host, [
    { label: 'Cancel', onClick: () => done(false) },
    { label: confirmLabel, primary: !danger, danger, onClick: () => done(true) },
  ]);
});

const promptBox = (title, message, initial, confirmLabel) => showDialog((host, done) => {
  dialogFrame(host, title, message);
  const input = el('input', 'dialog-input');
  input.value = initial || '';
  input.spellcheck = false;
  host.append(input);
  const submit = () => done(input.value.trim());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); submit(); }
    if (event.key === 'Escape') { event.preventDefault(); done(null); }
  });
  dialogButtons(host, [
    { label: 'Cancel', onClick: () => done(null) },
    { label: confirmLabel, primary: true, onClick: submit },
  ]);
  setTimeout(() => { input.focus(); input.select(); }, 0);
});

async function attempt(action) {
  try {
    return await action();
  } catch (error) {
    await alertBox('That didn\'t work', cleanError(error));
    return undefined;
  }
}

// Actions on several items do what they can, then say which ones didn't work and why. Two lines
// at most: the first one or two, then how many more.
async function reportFailures(failures, total) {
  if (!failures || !failures.length) return;
  const title = total === 1 ? 'That didn\'t work' : `${failures.length} of ${total} items didn't work`;
  const lines = failures.map((failure) => (total === 1 ? cleanError(failure.message) : `${shortName(entryName(failure.path), 30)}: ${cleanError(failure.message)}`));
  const shown = lines.length > 2 ? [lines[0], `…and ${lines.length - 1} more.`] : lines;
  await alertBox(title, shown.join('\n'));
}

/* ---------- Drop-down and right-click menus ---------- */

const menu = $('menu');
let menuOwner = null; // the button that opened the menu, if one did
let closedByOwner = null;

// While a dialog is open, everything outside it can't be clicked, so a menu then opens inside a
// see-through dialog of its own on top. Closing that gives the typing spot back to the box it was in.
const menuHome = menu.parentElement;
const menuLayer = document.createElement('dialog');
menuLayer.className = 'menu-layer';
document.body.append(menuLayer);
menuLayer.addEventListener('close', () => {
  menu.hidden = true;
  menuHome.append(menu);
});

function closeMenu() {
  menu.hidden = true;
  if (menuLayer.open) menuLayer.close();
}

function openMenu(x, y, items) {
  menuOwner = null;
  if (dialog.open && !menuLayer.open) {
    menuLayer.append(menu);
    menuLayer.showModal();
  }
  menu.replaceChildren();
  items.forEach((item) => {
    if (item === '-') {
      menu.append(el('div', 'menu-rule'));
      return;
    }
    const row = el('button', 'menu-item');
    if (item.icon) row.append(icon(item.icon, item.tint || ''));
    else row.append(el('span', 'menu-gap'));
    row.append(el('span', '', item.label));
    if (item.checked) row.append(icon('checkmark', 'menu-check'));
    row.disabled = Boolean(item.disabled);
    row.addEventListener('click', () => {
      closeMenu();
      item.run();
    });
    menu.append(row);
  });
  menu.hidden = false;
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 4))}px`;
}

function menuUnder(button, items) {
  // Pressing the button that opened the menu closes it, and the click that follows mustn't reopen it.
  if (closedByOwner === button) {
    closedByOwner = null;
    return;
  }
  const box = button.getBoundingClientRect();
  openMenu(box.left, box.bottom + 2, items);
  menuOwner = button;
}

// Pressing a menu item mustn't take the typing spot (and the picked words) off a text box: the
// menu's Cut, Copy and Paste work on them.
menu.addEventListener('mousedown', (event) => event.preventDefault());

// Every right-click menu starts with the same four, in the same places: greyed out where they can't
// work, never left out. What belongs to the thing clicked comes after them. shared is
// { cut, copy, paste, selectAll }, each a function or nothing.
function rightClickMenu(x, y, shared, items = []) {
  const common = [
    { label: 'Cut', icon: 'cut', run: shared.cut },
    { label: 'Copy', icon: 'copy', run: shared.copy },
    { label: 'Paste', icon: 'clipboard_paste', run: shared.paste },
    { label: 'Select All', icon: 'select_all_on', run: shared.selectAll },
  ].map((item) => ({ ...item, disabled: typeof item.run !== 'function' }));
  while (items[0] === '-') items = items.slice(1);
  openMenu(x, y, items.length ? [...common, '-', ...items] : common);
}

// A box you can type in (not a checkbox or a button), or null.
function typingBox(node) {
  const box = node?.closest?.('input, textarea, [contenteditable]:not([contenteditable="false"])');
  if (!box || box.disabled) return null;
  if (box.tagName === 'INPUT' && !['text', 'search', 'url', 'email', 'password', 'number', 'tel'].includes(box.type)) return null;
  return box;
}

// Words shown on the page that can be picked (the rest of the page can't be, as in an app), or null.
function pickableText(node) {
  for (let at = node instanceof Element ? node : node?.parentElement; at && at !== document.body; at = at.parentElement) {
    if (getComputedStyle(at).userSelect === 'text') {
      // The outermost part that can be picked, so Select All takes all of it.
      while (at.parentElement && at.parentElement !== document.body && getComputedStyle(at.parentElement).userSelect === 'text') at = at.parentElement;
      return at;
    }
  }
  return null;
}

// Cut, Copy, Paste and Select All for words: in a text box, or picked on the page. Copying goes on
// Windows' clipboard too, the same way a terminal's does (lib/clipboard.js).
function textActions(target) {
  const box = typingBox(target);
  const picked = window.getSelection();
  if (box) {
    const field = 'selectionStart' in box && box.selectionStart !== null;
    const words = field ? box.value.slice(box.selectionStart, box.selectionEnd) : (box.contains(picked.anchorNode) ? picked.toString() : '');
    const secret = box.type === 'password';
    const writable = !box.readOnly;
    const copy = () => call('clipboardWrite', words);
    return {
      cut: writable && words && !secret ? async () => { await copy(); box.focus(); document.execCommand('delete'); } : null,
      copy: words && !secret ? copy : null,
      paste: writable ? async () => {
        const text = await call('clipboardRead').catch(() => '');
        box.focus();
        if (text) document.execCommand('insertText', false, box.tagName === 'INPUT' ? text.replace(/\r?\n/g, ' ') : text);
      } : null,
      selectAll: () => { box.focus(); if (field) box.select(); else document.execCommand('selectAll'); },
    };
  }
  const area = pickableText(target);
  const words = picked.toString();
  return {
    copy: words.trim() ? () => call('clipboardWrite', words) : null,
    selectAll: area ? () => picked.selectAllChildren(area) : null,
  };
}

// Anything without a menu of its own: the four, for words picked there or the box clicked in.
// A box can add Undo and Redo, and a place in the sidebar its own items.
document.addEventListener('contextmenu', (event) => {
  if (event.defaultPrevented) return;
  event.preventDefault();
  const items = [];
  if (typingBox(event.target)) {
    items.push(
      { label: 'Undo', icon: 'arrow_undo', run: () => document.execCommand('undo') },
      { label: 'Redo', icon: 'arrow_redo', run: () => document.execCommand('redo') },
    );
  }
  const place = event.target.closest?.('.nav-item');
  if (place) items.push(...navItems(place));
  const said = event.target.closest?.('.llama-bubble .llama-words'); // a Local AI chat message
  if (said) items.push({ label: 'Copy Message', icon: 'copy', run: () => call('clipboardWrite', said.textContent) });
  rightClickMenu(event.clientX, event.clientY, textActions(event.target), items);
});

document.addEventListener('pointerdown', (event) => {
  closedByOwner = null;
  if (menu.hidden || menu.contains(event.target)) return;
  if (menuOwner?.contains(event.target)) closedByOwner = menuOwner;
  closeMenu();
}, true);
window.addEventListener('blur', closeMenu);

/* ---------- Paths ---------- */

// Home is a page, not a folder, as in File Explorer. A Files tab on it has this as its place, so
// Back and Forward go to and from it like any folder.
const HOME_PAGE = 'home:';
const atHome = () => state.active?.kind === 'files' && state.active.path === HOME_PAGE;
const parentOf = (target) => (target === '/' ? '/' : target.slice(0, target.lastIndexOf('/')) || '/');
const baseName = (target) => {
  if (target === HOME_PAGE) return 'Home';
  if (target === '/') return 'Linux House (L:)';
  if (target === state.windows) return 'Windows (C:)';
  if (target === state.trash) return 'Trash';
  if (target === state.projects) return 'Projects';
  return target.slice(target.lastIndexOf('/') + 1);
};
// A name short enough for a pop-up or hover text to stay within two lines. keepEnd keeps the end
// of it instead, for paths, where the file's own name is at the end.
// A few names in a row, for a note: "A, B and 3 more".
function nameList(names, show = 2) {
  const shown = names.slice(0, show).map((name) => shortName(name, 20));
  return names.length > show ? `${shown.join(', ')} and ${names.length - show} more` : shown.join(', ');
}

function shortName(name, max = 40, keepEnd = false) {
  const text = String(name);
  if (text.length <= max) return text;
  return keepEnd ? `…${text.slice(-(max - 1))}` : `${text.slice(0, max - 1)}…`;
}

// The projects folder is lowercase on disk, because rooms and scripts rely on that path. It's only shown capitalized.
const shownName = (entry) => (entry.path === state.projects ? 'Projects' : entry.name);
const inTrash = () => state.active?.kind === 'files' && state.active.path === state.trash;
// Windows' own C: drive, shown while the Windows lock is open: view and copy only.
const READ_ONLY = 'Windows (C:) is view and copy only. Nothing on it can be changed from here.';
const inWindowsDrive = (target) => Boolean(state.windows) && typeof target === 'string' && (target === state.windows || target.startsWith(`${state.windows}/`));
const onWindows = () => state.active?.kind === 'files' && inWindowsDrive(state.active.path);
// The way a path is written in Windows: L:\... in the house, C:\... on the Windows drive.
function windowsPath(target) {
  if (inWindowsDrive(target)) return `C:${target.slice(state.windows.length).replaceAll('/', '\\') || '\\'}`;
  return `L:${target.replaceAll('/', '\\')}`;
}
// Items in the trash are stored under a longer name, so the list's name is the one to show.
const entryName = (target) => state.entries.find((entry) => entry.path === target)?.name || baseName(target);

function projectOf(target) {
  const prefix = `${state.projects}/`;
  if (!target.startsWith(prefix)) return null;
  const name = target.slice(prefix.length).split('/')[0];
  return /^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9_-])?$/.test(name) ? name : null;
}

// Where a path sits in its project: the project, and the folder inside it written from the
// project's top ('' for the top itself), which is where a room terminal opened there starts.
function roomPlace(target) {
  const project = projectOf(target);
  if (!project) return null;
  return { project, folder: target.slice(`${state.projects}/${project}`.length).replace(/^\/+|\/+$/g, '') };
}

const roomIsUp = (name) => state.status.rooms.some((room) => room.name === name);

const fileUrl = (target) => `house-file://f${target.split('/').map(encodeURIComponent).join('/')}`;

function kindOf(entry) {
  if (entry.isDir) return parentOf(entry.path) === state.projects ? 'Project' : 'File folder';
  const dot = entry.name.lastIndexOf('.');
  return dot > 0 ? `${entry.name.slice(dot + 1).toUpperCase()} File` : 'File';
}

// What the page itself can show and play.
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
const VIDEO = /\.(mp4|webm|mov|mkv|ogv|m4v)$/i;
const AUDIO = /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i;
// Every picture, video and song type, for icons. The icon views show a small picture of each,
// and of PDFs (lib/thumbs.js makes them with the house's ffmpeg and keeps the same lists).
const ANY_PICTURE = /\.(png|jpe?g|jfif|pjpeg|pjp|gif|webp|bmp|ico|cur|avif|apng|svgz?|tiff?|heic|heif|hif|psd|tga|dds|exr|hdr|jxl|jp2|j2k|jpf|jpx|qoi|pcx|ppm|pgm|pbm|pnm|pam|pfm|sgi|xbm|xpm|xwd|dpx)$/i;
const ANY_VIDEO = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpe?g|m2v|mts|m2ts|3gp|3g2|ogv|vob|asf|divx)$/i;
const ANY_AUDIO = /\.(mp3|m4a|m4b|aac|flac|ogg|oga|opus|wav|wma|aiff?|ape|wv|dsf)$/i;
const PDF = /\.pdf$/i;
const thumbed = (name) => ANY_PICTURE.test(name) || ANY_VIDEO.test(name) || ANY_AUDIO.test(name) || PDF.test(name);
// The date and size are in it, so a changed file never shows its old picture.
const thumbUrl = (entry) => `${fileUrl(entry.path)}?thumb&v=${Math.round(entry.mtime || 0)}-${entry.size ?? ''}`;

function formatDate(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  const hours = date.getHours() % 12 || 12;
  const suffix = date.getHours() < 12 ? 'AM' : 'PM';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hours}:${pad(date.getMinutes())} ${suffix}`;
}

function formatSize(bytes) {
  const kb = Math.ceil(bytes / 1024);
  if (kb < 1024) return `${kb.toLocaleString()} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / (1024 * 1024)).toFixed(1)} GB`;
}

/* ---------- Tabs ---------- */

const tabsEl = $('tabs');
const newTabButton = $('new-tab');
const termArea = $('term-area');
const filesView = $('files-view');
const tabTemplate = $('tab-template');

// How many Station 256 windows are open, and whether this is the main one (main.js keeps it up to
// date). Any tab can have a window of its own, and tabs move between windows, as in Chrome.
const windowInfo = { count: 1, main: true };
window.house.on('windows:changed', ({ count, main } = {}) => {
  if (Number.isInteger(count)) windowInfo.count = count;
  windowInfo.main = main === true;
  renderTabButtons();
});

// A terminal that has ended can't be shown anywhere else. Any other tab can move.
// A video being saved stays put until it's done (video-tab.js).
const canMove = (tab) => !(tab.kind === 'term' && tab.ended) && !(tab.kind === 'video' && tab.job);

function renderTabButtons() {
  const onlyTab = state.tabs.length === 1;
  const otherWindows = windowInfo.count > 1;
  state.tabs.forEach((tab) => {
    // The only window keeps its last Files tab, so it's never empty. With other windows open,
    // closing a window's last tab closes the window.
    tab.el.querySelector('.close-tab').hidden = onlyTab && tab.kind === 'files' && !otherWindows;
    // A window of its own only makes sense when there's another tab to leave behind.
    tab.el.querySelector('.popout').hidden = onlyTab || !canMove(tab);
    // A window's only tab can go back to the main window instead.
    tab.el.querySelector('.bring-back').hidden = !(onlyTab && otherWindows && !windowInfo.main && canMove(tab));
    tab.el.querySelector('.tab-folder').hidden = tab.kind !== 'files' || Boolean(tab.placeIcon);
    tab.el.querySelector('.tab-term-icon').hidden = tab.kind === 'files' && !tab.placeIcon;
  });
  paintAgentTabs();
}

// What the AI in each room terminal is doing (lib/agent-alerts.js): its tab turns green while the
// AI works, and yellow when it needs you. Done and idle look like any other tab.
let agentStatuses = {};
function paintAgentTabs() {
  state.tabs.forEach((tab) => {
    const status = tab.kind === 'term' && tab.tab && !tab.ended ? agentStatuses[`${tab.room}\t${tab.tab}`] : null;
    tab.el.classList.toggle('agent-working', status === 'working');
    tab.el.classList.toggle('agent-blocked', status === 'blocked');
  });
}
window.house.on('agents:tabs', (map) => {
  agentStatuses = map && typeof map === 'object' ? map : {};
  paintAgentTabs();
});
call('agentStatuses').then((map) => {
  agentStatuses = map && typeof map === 'object' ? map : {};
  paintAgentTabs();
}).catch(() => {});
// A Windows notification about a room's AI was clicked: go to that terminal.
window.house.on('agents:open', ({ room, tab } = {}) => {
  if (typeof room === 'string' && typeof tab === 'string') openRoomTab(room, tab);
});

// A Files tab on one of the places in the left pane (Home, Documents, Videos, Downloads, the L:
// drive, Trash...) shows that place's icon, as File Explorer's tabs do. Anywhere else, a folder.
function showPlaceIcon(tab) {
  const item = [...document.querySelectorAll('#nav .nav-item')].find((node) => navPath(node.dataset.nav) === tab.path);
  const found = item?.querySelector(':scope > i[data-i]:not(.expander):not(.pin)');
  const slot = tab.el.querySelector('.tab-term-icon');
  tab.placeIcon = found ? found.dataset.i : null;
  slot.className = ['tab-term-icon', ...(found ? [...found.classList].filter((name) => name.startsWith('tint-')) : [])].join(' ');
  if (found) setIcon(slot, tab.placeIcon);
  renderTabButtons();
}

// Keeps a dragged tab under the mouse and slides it past its neighbors, which glide out of the way.
// Places come from offsetLeft, which ignores that glide, so a neighbor still moving can't trigger a swap back.
function moveTabTo(node, left) {
  node.style.transform = '';
  const origin = node.getBoundingClientRect().left - node.offsetLeft;
  const wanted = left - origin;
  const stripEnd = newTabButton.offsetLeft + newTabButton.offsetWidth;
  const place = Math.max(tabsEl.firstElementChild.offsetLeft, Math.min(wanted, stripEnd - node.offsetWidth));
  const others = [...tabsEl.querySelectorAll('.tab')].filter((other) => other !== node);
  const middle = wanted + node.offsetWidth / 2;
  const next = others.find((other) => other.offsetLeft + other.offsetWidth / 2 >= middle) || newTabButton;
  if (next !== node.nextElementSibling) {
    const was = others.map((other) => other.offsetLeft);
    // The neighbors move, not the dragged tab: moving it in the page would make it lose hold of the mouse.
    const strip = [...tabsEl.children];
    const from = strip.indexOf(node);
    const to = strip.indexOf(next);
    const after = node.nextElementSibling;
    if (to < from) strip.slice(to, from).forEach((other) => tabsEl.insertBefore(other, after));
    else strip.slice(from + 1, to).forEach((other) => tabsEl.insertBefore(other, node));
    others.forEach((other, index) => {
      const shift = was[index] - other.offsetLeft;
      if (shift) other.animate([{ transform: `translateX(${shift}px)` }, { transform: 'none' }], { duration: 150, easing: 'ease-out' });
    });
  }
  node.style.transform = `translateX(${place - node.offsetLeft}px)`;
}

// The small window a lifted tab becomes while it's carried. It's drawn on the whole screen, so it
// can follow the pointer past this window's edge. Over another window's tabs it shrinks to a tab,
// so the gap opening there shows. Let go anywhere else and it grows into the new window, right
// where that window will be, and stays until the window is on screen, so nothing blinks.
const tabGhost = el('div', 'tab-ghost');
const tabGhostTitle = el('span', 'tab-ghost-title');
const tabGhostHead = el('div', 'tab-ghost-head');
const tabGhostIcon = icon('window_console');
tabGhostHead.append(tabGhostIcon, tabGhostTitle);
const tabGhostBody = el('div', 'tab-ghost-body');
tabGhost.append(tabGhostHead, tabGhostBody);
tabGhost.hidden = true;
document.body.append(tabGhost);

const GHOST_ICONS = { files: 'folder_open', agents: 'grid', rules: 'shield', llama: 'bot', schedules: 'calendar_ltr', term: 'window_console', doc: 'document', video: 'video', song: 'music_note_2', editor: 'video_clip' };
const GHOST_HOLD = { x: 60, y: 16 }; // where the pointer holds it (CARRIED_AT in main.js)
let ghostRun = 0; // counts carries, so a finished one's timer can't hide the next
let ghostTimer = null;
let ghostFrame = 0;
let ghostAt = { x: 0, y: 0 };

// Moves it at most once per frame, by its position alone, so nothing is laid out again.
function placeGhost(x, y) {
  ghostAt = { x, y };
  if (ghostFrame) return;
  ghostFrame = requestAnimationFrame(() => {
    ghostFrame = 0;
    tabGhost.style.translate = `${ghostAt.x}px ${ghostAt.y}px`;
  });
}

function placeGhostNow(x, y) {
  if (ghostFrame) cancelAnimationFrame(ghostFrame);
  ghostFrame = 0;
  ghostAt = { x, y };
  tabGhost.style.translate = `${x}px ${y}px`;
}

// at: where its top left starts, when it isn't under the pointer (the "own window" button).
// chip: as a tab only, from the start.
function showTabGhost(tab, { at = null, chip = false } = {}) {
  ghostRun += 1;
  clearTimeout(ghostTimer);
  tabGhost.className = chip ? 'tab-ghost chip' : 'tab-ghost';
  tabGhost.style.width = '';
  tabGhost.style.height = '';
  if (at) placeGhostNow(at.x, at.y);
  tabGhostTitle.textContent = tab.el.querySelector('.tab-title').textContent;
  setIcon(tabGhostIcon, (tab.kind === 'files' && tab.placeIcon) || GHOST_ICONS[tab.kind] || 'window_console');
  // A peek at what's in it: a terminal's last few lines, or the first few things in a folder.
  const lines = [];
  const buffer = tab.live?.term?.buffer?.active;
  if (buffer) {
    for (let row = buffer.baseY + buffer.cursorY; row >= 0 && lines.length < 9; row--) {
      const text = buffer.getLine(row)?.translateToString(true) || '';
      if (text.trim() || lines.length) lines.unshift(text);
    }
  } else if (tab.kind === 'files' && state.active === tab) {
    visibleEntries().slice(0, 9).forEach((entry) => lines.push(entry.name));
  }
  tabGhostBody.textContent = lines.join('\n');
  tabGhost.hidden = false;
  void tabGhost.offsetWidth; // its starting shape, so a change straight after glides from it
  requestAnimationFrame(() => tabGhost.classList.add('shown'));
}

function moveTabGhost(x, y) {
  placeGhost(x - GHOST_HOLD.x, y - GHOST_HOLD.y);
}

// Fades it out, shrinking toward the pointer.
function hideTabGhost() {
  if (tabGhost.hidden) return;
  const run = ghostRun;
  tabGhost.classList.add('leaving');
  clearTimeout(ghostTimer);
  ghostTimer = setTimeout(() => {
    if (run !== ghostRun) return;
    tabGhost.hidden = true;
    tabGhost.className = 'tab-ghost';
  }, 180);
}

// Let go away from any tabs: it grows into the new window's shape where that window will be (box,
// in this page's units), and goes once the window is on screen ('tab:landed'), or after a while.
function landTabGhost(box) {
  if (tabGhost.hidden || !box) return;
  const run = ghostRun;
  placeGhostNow(ghostAt.x, ghostAt.y); // a move still waiting for its frame mustn't jump ahead
  tabGhost.classList.remove('chip', 'leaving');
  tabGhost.classList.add('shown', 'landing');
  tabGhost.style.translate = `${box.x}px ${box.y}px`;
  tabGhost.style.width = `${box.w}px`;
  tabGhost.style.height = `${box.h}px`;
  clearTimeout(ghostTimer);
  ghostTimer = setTimeout(() => { if (run === ghostRun) hideTabGhost(); }, 4000);
}

window.house.on('tab:landed', () => {
  if (!tabGhost.hidden && tabGhost.classList.contains('landing')) hideTabGhost();
});

// Asks which other window's tabs the pointer is over, opening a gap there. One question at a time,
// and once more when it's answered if the pointer moved meanwhile. still(): whether the carry is
// still going, so nothing is asked once it has ended.
function asksOver(still, answer) {
  let asking = false;
  let again = false;
  const ask = () => {
    if (asking) {
      again = true;
      return;
    }
    asking = true;
    again = false;
    call('tabHover', true)
      .then((over) => { if (still()) answer(Boolean(over)); }, () => {})
      .finally(() => {
        asking = false;
        if (again && still()) ask();
      });
  };
  return ask;
}

// While a tab (or a window, by its only tab) is carried over this window's tabs, a gap opens where
// it would land.
const tabSlot = el('div', 'tab-slot');
window.house.on('tabs:gap', ({ x }) => {
  if (typeof x !== 'number') {
    tabSlot.classList.remove('open');
    setTimeout(() => { if (!tabSlot.classList.contains('open')) tabSlot.remove(); }, 160);
    return;
  }
  const before = [...tabsEl.querySelectorAll('.tab')].find((other) => {
    const box = other.getBoundingClientRect();
    return box.left + box.width / 2 > x;
  }) || newTabButton;
  if (tabSlot.nextElementSibling !== before || !tabSlot.isConnected) {
    const was = [...tabsEl.querySelectorAll('.tab')].map((other) => [other, other.getBoundingClientRect().left]);
    tabsEl.insertBefore(tabSlot, before);
    was.forEach(([other, left]) => {
      const shift = left - other.getBoundingClientRect().left;
      if (shift) other.animate([{ transform: `translateX(${shift}px)` }, { transform: 'none' }], { duration: 150, easing: 'ease-out' });
    });
  }
  requestAnimationFrame(() => tabSlot.classList.add('open'));
});

// The AI chat in a terminal tab, saved as a page (Markdown) in Downloads: what you and the AI said
// as the terminal shows it, or with details (every command, file change and result). A note says
// where it went, with a button to see it.
async function exportChat(tab, detail) {
  toast(detail ? 'Saving the chat with details…' : 'Saving the chat…');
  const saved = await attempt(() => call('chatExport', tab.termId, detail));
  if (!saved) {
    hideToast();
    return;
  }
  toast(`Chat saved to Downloads as "${shortName(baseName(saved), 44)}"`, 'Show', () => {
    const shown = openFilesTab(parentOf(saved));
    state.selected = new Set([saved]);
    state.anchor = saved;
    state.focus = saved;
    shown.revealSelected = true;
  });
}

function addTabElement(tab, title) {
  const node = tabTemplate.content.firstElementChild.cloneNode(true);
  iconsIn(node);
  node.querySelector('.tab-title').textContent = title;
  if (tab.kind === 'agents') setIcon(node.querySelector('.tab-term-icon'), 'grid');
  if (tab.kind === 'rules') setIcon(node.querySelector('.tab-term-icon'), 'shield');
  if (tab.kind === 'llama') setIcon(node.querySelector('.tab-term-icon'), 'bot');
  if (tab.kind === 'schedules') setIcon(node.querySelector('.tab-term-icon'), 'calendar_ltr');
  if (tab.kind === 'doc') setIcon(node.querySelector('.tab-term-icon'), 'document');
  if (tab.kind === 'video') setIcon(node.querySelector('.tab-term-icon'), 'video');
  if (tab.kind === 'song') setIcon(node.querySelector('.tab-term-icon'), 'music_note_2');
  if (tab.kind === 'editor') setIcon(node.querySelector('.tab-term-icon'), 'video_clip');
  if (tab.kind === 'obscura') setIcon(node.querySelector('.tab-term-icon'), 'link');
  node.addEventListener('click', () => activateTab(tab));
  // Every tab's menu. A terminal's also saves its AI chat as a page, as it reads or with every step.
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const items = [];
    if (tab.kind === 'term' && !tab.ended && tab.termId) {
      items.push(
        { label: 'Export Chat', icon: 'document_arrow_down', run: () => exportChat(tab, false) },
        { label: 'Export Chat with Details', icon: 'document_arrow_down', run: () => exportChat(tab, true) },
        '-',
      );
    }
    items.push(
      { label: 'New Tab', icon: 'tab_add', run: () => openFilesTab(HOME_PAGE) },
      { label: 'Move to New Window', icon: 'window_new', disabled: state.tabs.length < 2 || !canMove(tab), run: () => popOutTab(tab) },
      { label: 'Close Tab', icon: 'dismiss', run: () => closeTab(tab) },
      ...(isRoomTerminal(tab) && roomIsUp(tab.room) ? [{ label: 'Close Room', icon: 'checkbox_unchecked', tint: 'tint-red', run: () => closeOneRoom(tab) }] : []),
    );
    rightClickMenu(event.clientX, event.clientY, textActions(event.target), items);
  });
  node.querySelector('.close-tab').addEventListener('click', (event) => {
    event.stopPropagation();
    closeTab(tab);
  });
  node.querySelector('.popout').addEventListener('click', (event) => {
    event.stopPropagation();
    popOutTab(tab);
  });
  // About to be used: a window gets ready for it out of sight, so it opens at once.
  node.querySelector('.popout').addEventListener('pointerenter', () => call('tabWarm').catch(() => {}));
  node.querySelector('.bring-back').addEventListener('click', (event) => {
    event.stopPropagation();
    attempt(() => call('tabMoveBack', describeTab(tab)));
  });
  // Dragging a tab moves it along the strip, its neighbors gliding aside. A tab pulled down off the
  // strip lifts into a small window that follows the pointer, as in Chrome: let go over another
  // window's tabs and it joins them, anywhere else and it becomes a window of its own right there.
  // Bring it back to the strip and it drops back in. A window's only tab moves the whole window
  // instead (see window-motion.js and barDrag below).
  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button') || state.tabs.length === 1) return;
    const grabX = event.clientX - node.getBoundingClientRect().left;
    const canLift = () => state.tabs.length > 1 && canMove(tab);
    let lifted = false;
    // Over another window's tabs, a gap opens there, and the carried picture shrinks to a tab.
    const hoverOthers = asksOver(() => lifted, (over) => tabGhost.classList.toggle('chip', over));
    const offStrip = (point) => {
      const box = tabsEl.getBoundingClientRect();
      const reach = lifted ? 12 : 36; // harder to pull off than to drop back, so it doesn't flicker
      return point.clientY < box.top - reach || point.clientY > box.bottom + reach;
    };
    const lift = (on) => {
      if (on === lifted) return;
      lifted = on;
      node.classList.toggle('tab-lifted', on);
      node.style.transform = '';
      if (on) {
        showTabGhost(tab);
      } else {
        hideTabGhost();
        call('tabHover', false).catch(() => {});
      }
    };
    window.houseFrame.track(node, event, {
      begin() {
        activateTab(tab);
        node.classList.add('tab-moving');
        // It may be carried off to a window of its own: one gets ready out of sight meanwhile.
        if (canLift()) call('tabWarm').catch(() => {});
      },
      move(current) {
        lift(canLift() && offStrip(current));
        if (lifted) {
          moveTabGhost(current.clientX, current.clientY);
          hoverOthers();
        } else {
          moveTabTo(node, current.clientX - grabX);
        }
      },
      async end(_last, moved, cancelled) {
        const letGo = lifted && !cancelled;
        // Let go off the strip, the tab stays out of sight while it moves, the gap in another
        // window stays open for it to land in, and its picture stays until it has landed.
        if (letGo) lifted = false;
        else lift(false);
        node.classList.remove('tab-moving');
        node.style.transform = '';
        if (!moved) return;
        sortTabs();
        if (letGo && !await dropTab(tab)) {
          node.classList.remove('tab-lifted');
          hideTabGhost();
          call('tabHover', false).catch(() => {});
        }
      },
    });
  });
  tab.el = node;
  tabsEl.insertBefore(node, newTabButton);
}

// The tabs in the order they sit on the strip.
function sortTabs() {
  state.tabs.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

// A window with one tab, carried by that tab (window-motion.js): over another window's tabs a gap
// opens there, the window fades away and its tab's picture shows under the pointer instead, so the
// gap can be seen. Let go there, the tab joins them and this window closes.
let joinable = false;
let barCarry = false;
const barHover = asksOver(() => barCarry, (over) => { joinable = over; });
window.houseFrame.barDrag = {
  move(current) {
    const [only] = state.tabs;
    if (!current || !only || !canMove(only) || windowInfo.count < 2) {
      if (barCarry) call('tabHover', false).catch(() => {});
      barCarry = false;
      joinable = false;
      if (tabGhost.classList.contains('docking')) hideTabGhost();
      return false;
    }
    barCarry = true;
    barHover();
    if (joinable && (tabGhost.hidden || !tabGhost.classList.contains('docking') || tabGhost.classList.contains('leaving'))) {
      showTabGhost(only, { chip: true });
      tabGhost.classList.add('docking');
    } else if (!joinable && tabGhost.classList.contains('docking')) {
      hideTabGhost();
    }
    if (joinable) moveTabGhost(current.clientX, current.clientY);
    return joinable;
  },
  // Says whether it joined. If not, the window comes back (window-motion.js).
  async end() {
    barCarry = false;
    joinable = false;
    const [only] = state.tabs;
    const joined = only ? await attempt(() => call('tabJoin', describeTab(only))) : false;
    hideTabGhost();
    return Boolean(joined);
  },
};

function activateTab(tab) {
  if (!preview.hidden) closePreview();
  state.active = tab;
  tab.usedAt = Date.now();
  state.tabs.forEach((other) => {
    other.el.classList.toggle('active', other === tab);
    if (other.host) other.host.hidden = other !== tab;
  });
  const isFiles = tab.kind === 'files';
  filesView.hidden = !isFiles;
  termArea.hidden = tab.kind !== 'term';
  agentsView.hidden = tab.kind !== 'agents';
  rulesView.hidden = tab.kind !== 'rules';
  $('llama-view').hidden = tab.kind !== 'llama';
  window.schedulesPage?.show(tab); // renderer/schedules-tab.js
  // Files opened in a page (doc-tab.js, video-tab.js), and the video editor (editor-tab.js).
  $('doc-area').hidden = tab.kind !== 'doc' && tab.kind !== 'video' && tab.kind !== 'song' && tab.kind !== 'editor' && tab.kind !== 'obscura';
  document.body.classList.toggle('term-active', !isFiles);
  document.body.classList.toggle('obscura-front', tab.kind === 'obscura'); // the page gets the whole tab area (end of style.css)
  call('obscuraFront', tab.kind === 'obscura').catch(() => {}); // and Ctrl + / Ctrl - zoom the page, not Station (main.js)
  if (isFiles) {
    loadFolder();
  } else if (tab.kind === 'agents') {
    renderAgents();
  } else if (tab.kind === 'rules') {
    renderRules();
    rulesView.focus({ preventScroll: true }); // so the arrow keys, Page Down and Esc work right away
  } else if (tab.kind === 'llama') {
    showLlama(tab);
  } else if (tab.kind === 'schedules') {
    // drawn by schedules-tab.js
  } else if (tab.kind === 'doc') {
    showDoc(tab);
  } else if (tab.kind === 'video') {
    showVideo(tab);
  } else if (tab.kind === 'song') {
    showSong(tab);
  } else if (tab.kind === 'editor') {
    showEditor(tab);
  } else if (tab.kind === 'obscura') {
    showObscura(tab);
  } else {
    tab.live.refit();
    tab.live.term.focus();
  }
  // So a notification isn't sent about the terminal you're looking at.
  call('termShown', tab.kind === 'term' ? tab.termId : null).catch(() => {});
  watchAgents();
  // Right away, even if a folder is slow to load, so the room button can't still mean the last tab's room.
  renderChrome();
}

// history: the Back and Forward lists of a tab that came from another window.
function openFilesTab(target, history = {}) {
  const tab = { kind: 'files', path: target, back: [...(history.back || [])], forward: [...(history.forward || [])] };
  addTabElement(tab, baseName(target));
  state.tabs.push(tab);
  renderTabButtons();
  activateTab(tab);
  return tab;
}

function adoptTerminal(session, initialText) {
  const host = el('div', 'term-host');
  host.hidden = true;
  termArea.append(host);
  termArea.hidden = false;
  const tab = { kind: 'term', termId: session.id, room: session.room, tab: session.tab, host };
  addTabElement(tab, session.title);
  state.tabs.push(tab);
  tab.live = mountTerminal(host, session.id, initialText, { room: Boolean(session.tab) });
  renderTabButtons();
  activateTab(tab);
  // A tab that lost its line to this same room terminal makes way for it, in its place.
  const stale = session.tab && state.tabs.find((other) => other !== tab && other.kind === 'term' && other.ended && other.room === session.room && other.tab === session.tab);
  if (stale) {
    tabsEl.insertBefore(tab.el, stale.el);
    removeTab(stale);
    sortTabs();
  }
  return tab;
}

async function openTerminal(options) {
  const session = await attempt(() => call('termCreate', options));
  if (!session) return null;
  if (!session.existing) return adoptTerminal(session);
  // That room terminal is already shown: its tab here, or its own window, or else (only after a
  // crash) nowhere, and then it's shown here.
  const here = state.tabs.find((tab) => tab.termId === session.id);
  if (here) {
    activateTab(here);
    return here;
  }
  if (await call('termFocusRoomTab', session.room, session.tab).catch(() => false)) return null;
  const found = await attempt(() => call('termAttach', session.id));
  return found ? adoptTerminal({ id: session.id, title: found.title, room: found.room, tab: found.tab }, found.buffer) : null;
}

// Goes back to the room's terminal if it has one. The one with an AI in it (Claude, Codex, Gemini)
// comes first, wherever it is: its tab, its own window, or still running in the room with its tab
// closed. With no AI running, it's the tab last used, then a window, then the terminal closed last.
// Only starts one if there's none. Another terminal is only ever made by asking for one.
// For a folder inside the project, it's the terminal already sitting in that folder, or a new one
// that starts there.
// A second click while the first is still on its way just waits for it, so it can't open two.
const entering = new Map();
function enterRoom(name, folder = '') {
  const key = `${name}\n${folder}`;
  if (!entering.has(key)) entering.set(key, goIntoRoom(name, folder).finally(() => entering.delete(key)));
  return entering.get(key);
}

// Room terminals still running from last time, coming back as tabs when Station 256 opens.
let restoring = Promise.resolve();

async function goIntoRoom(name, folder) {
  // Right after Station 256 opens, those come back first, so Enter Room finds them instead of
  // starting another. It waits only a few seconds for a slow Docker.
  await Promise.race([restoring, wait(8000)]);
  // The room is asked even if it doesn't look open yet: right after Station 256 opens, the list of
  // open rooms is still filling in. A room that isn't open just has nothing to go back to.
  if (folder) {
    const tabName = await call('termRoomTabAt', name, folder).catch(() => null);
    if (tabName) await openRoomTab(name, tabName);
    else await openTerminal({ room: name, cwd: folder });
    return;
  }
  const open = state.tabs.filter((tab) => tab.kind === 'term' && tab.room === name && !tab.ended).sort((a, b) => b.usedAt - a.usedAt);
  const agents = await call('termAgentTabs', name).catch(() => []);
  if (agents.length) {
    const here = open.find((tab) => agents.includes(tab.tab));
    if (here) {
      activateTab(here);
      return;
    }
    for (const tabName of agents) if (await call('termFocusRoomTab', name, tabName).catch(() => false)) return;
    // Not shown anywhere, so its tab was closed: termResumable picks it before any other.
  } else if (open.length) {
    activateTab(open[0]);
    return;
  } else if (await call('termFocusRoom', name).catch(() => false)) {
    return;
  }
  const waiting = await call('termResumable', name).catch(() => null);
  if (waiting) await openTerminal({ room: name, tab: waiting });
  else if (open.length) activateTab(open[0]);
  else if (!await call('termFocusRoom', name).catch(() => false)) await openTerminal({ room: name });
}

// Goes back to a files tab already inside the project, so you land where you left off.
function showRoomFiles(name) {
  const folder = `${state.projects}/${name}`;
  const filesTabs = state.tabs.filter((tab) => tab.kind === 'files');
  const inside = filesTabs.find((tab) => tab.path === folder || tab.path.startsWith(`${folder}/`));
  if (inside) {
    activateTab(inside);
  } else if (filesTabs.length) {
    activateTab(filesTabs[0]);
    navigate(folder);
  } else {
    openFilesTab(folder);
  }
}

// Takes a tab out of this window. A terminal keeps running: only its view here goes. A page opened
// from somewhere (House Rules) goes back there, if that tab is still here.
function removeTab(tab) {
  const index = state.tabs.indexOf(tab);
  if (index < 0) return;
  // The window's last tab. With other windows open, the window closes instead; only the only
  // window gets a fresh Files tab.
  if (state.tabs.length === 1 && windowInfo.count > 1 && !tab.leaving) {
    tab.leaving = true;
    call('windowEmpty').then((closed) => { if (!closed) removeTab(tab); }, () => removeTab(tab));
    return;
  }
  state.tabs.splice(index, 1);
  if (tab.kind === 'term') {
    tab.live.dispose();
    tab.host.remove();
  }
  if (tab.kind === 'doc') closeDoc(tab); // saves what's typed first
  if (tab.kind === 'video') closeVideo(tab);
  if (tab.kind === 'song') closeSong(tab);
  if (tab.kind === 'editor') closeEditor(tab);
  if (tab.kind === 'obscura') closeObscura(tab);
  tab.el.remove();
  const back = state.tabs.includes(tab.returnTo) ? tab.returnTo : state.tabs[Math.max(0, index - 1)];
  if (!state.tabs.length) openFilesTab(HOME_PAGE);
  else if (state.active === tab) activateTab(back);
  renderTabButtons();
  watchAgents();
}

// What another window needs to show this tab: a Files tab's folder with its Back and Forward,
// or which terminal.
function describeTab(tab) {
  if (tab.kind === 'files') return { kind: 'files', path: tab.path, back: tab.back, forward: tab.forward };
  if (tab.kind === 'term') return { kind: 'term', termId: tab.termId };
  if (tab.kind === 'doc') return { kind: 'doc', path: tab.path };
  if (tab.kind === 'video') return videoDescription(tab);
  if (tab.kind === 'song') return { kind: 'song', path: tab.path };
  if (tab.kind === 'editor') return editorDescription(tab);
  if (tab.kind === 'obscura') return obscuraDescription(tab);
  return { kind: tab.kind };
}

// The tab's "own window" button. Only when another tab is left behind. Its picture lifts off the
// tab and grows into the new window, which then fades in over it.
async function popOutTab(tab) {
  if (state.tabs.length < 2 || !state.tabs.includes(tab) || !canMove(tab)) return false;
  const from = tab.el.getBoundingClientRect();
  showTabGhost(tab, { at: { x: from.left, y: from.top } });
  if (tab.kind === 'doc') await saveDoc(tab); // the new window reads it from the file
  const opened = await attempt(() => call('tabPopOut', describeTab(tab)));
  if (!opened) {
    hideTabGhost();
    return false;
  }
  landTabGhost(opened.box);
  removeTab(tab);
  return true;
}

// A tab carried off the strip and let go: it has joined another window (its picture fades as the
// tab fades in there), or has a window of its own (its picture grows into it).
async function dropTab(tab) {
  if (tab.kind === 'doc') await saveDoc(tab); // the other window reads it from the file
  const dropped = await attempt(() => call('tabDrop', describeTab(tab)));
  if (dropped?.where === 'popped') landTabGhost(dropped.box);
  else if (dropped?.where === 'moved') hideTabGhost();
  else return false;
  removeTab(tab);
  return true;
}

// Closing a room terminal's tab only closes the view of it. It keeps running in the room, and
// Enter Room goes back into it. Any other terminal ends, so that asks first if it's busy.
async function closeTab(tab) {
  // A window's last tab, with other windows open: the window closes, the same as its X.
  if (state.tabs.length === 1 && state.tabs[0] === tab && windowInfo.count > 1) {
    window.houseFrame.close();
    return;
  }
  if (tab.kind === 'term') {
    if (!tab.ended && await call('termBusy', tab.termId).catch(() => false)) {
      const message = 'Something is still running in it. Closing stops it.\nYour files are kept.';
      if (!await confirmBox('Close this terminal?', message, 'Close', true)) return;
    }
    call('termClose', tab.termId);
    removeTab(tab);
    if (tab.room && tab.tab && !tab.ended) {
      const { room, tab: tabName } = tab;
      toast('Still running in the room. Enter Room takes you back to it.', 'Undo', () => openRoomTab(room, tabName));
    }
    return;
  }
  if (tab.kind === 'video' && !await videoMayClose(tab)) return; // saving, or changes not saved
  if (tab.kind === 'doc' && !await docMayClose(tab)) return; // it couldn't be saved
  if (tab.kind === 'song' && !await songMayClose(tab)) return; // changes not saved
  if (tab.kind === 'editor') await saveEditor(tab);
  if (tab.kind === 'llama') closeLlama(); // llama-tab.js
  removeTab(tab);
}

window.house.on('term:exit', ({ id, exitCode }) => {
  const tab = state.tabs.find((candidate) => candidate.termId === id);
  if (!tab) return;
  if (exitCode === 0) {
    removeTab(tab);
    return;
  }
  tab.ended = true;
  // 4: the connection couldn't be made again, but the terminal is still running in its room.
  tab.live.term.write(exitCode === 4
    ? '\r\n\x1b[33m[Lost the connection. This terminal is still running in its room. Close this tab, then use Enter Room to go back to it.]\x1b[0m\r\n'
    : '\r\n\x1b[33m[This session ended. Close this tab when you\'re done.]\x1b[0m\r\n');
  renderTabButtons();
});

// A tab from another window, shown here. A terminal's history is replayed and it carries on
// running; a Files tab keeps its Back and Forward. One Agents page and one House Rules page per
// window: one already here is used.
async function addMovedTab(incoming) {
  const kind = incoming?.kind;
  if (kind === 'files' && typeof incoming.path === 'string') return openFilesTab(incoming.path, incoming);
  if (kind === 'agents') return openAgents();
  if (kind === 'rules') return showRules();
  if (kind === 'llama') return openLlama();
  if (kind === 'schedules') return openSchedules();
  if (kind === 'doc' && typeof incoming.path === 'string') return openDoc(incoming.path);
  if (kind === 'video' && typeof incoming.path === 'string') return openVideo(incoming.path, incoming.edits);
  if (kind === 'song' && typeof incoming.path === 'string') return openSong(incoming.path);
  if (kind === 'editor' && typeof incoming.url === 'string') return openEditorAt(incoming.url);
  if (kind === 'obscura') return openObscura(/^https?:\/\//i.test(incoming.url) ? incoming.url : null);
  if (kind === 'term') {
    const session = await attempt(() => call('termAttach', incoming.termId));
    return session ? adoptTerminal({ id: incoming.termId, title: session.title, room: session.room, tab: session.tab }, session.buffer) : null;
  }
  return null;
}

// A tab coming from another window. Carried onto these tabs, it lands in the gap that opened for
// it, and the tabs beside it glide to their new places rather than jump.
window.house.on('tab:arrive', async ({ tab: incoming } = {}) => {
  const landing = tabSlot.isConnected ? tabSlot.nextElementSibling : null;
  const tab = await addMovedTab(incoming);
  const was = [...tabsEl.querySelectorAll('.tab')].filter((other) => other !== tab?.el).map((other) => [other, other.getBoundingClientRect().left]);
  if (tab && landing && landing !== tab.el && landing.isConnected) {
    tabsEl.insertBefore(tab.el, landing);
    sortTabs();
  }
  tabSlot.classList.remove('open');
  tabSlot.remove();
  was.forEach(([other, left]) => {
    const shift = left - other.getBoundingClientRect().left;
    if (shift) other.animate([{ transform: `translateX(${shift}px)` }, { transform: 'none' }], { duration: 150, easing: 'ease-out' });
  });
  if (tab) tab.el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
});

// A terminal in this window was asked for from elsewhere (Enter Room in another window, or a
// notification): its tab comes to the front.
window.house.on('term:show', ({ id } = {}) => {
  const tab = state.tabs.find((candidate) => candidate.kind === 'term' && candidate.termId === id);
  if (tab) activateTab(tab);
});

// A new tab opens on Home, as in File Explorer.
newTabButton.addEventListener('click', () => openFilesTab(HOME_PAGE));

/* ---------- Explorer ---------- */

const rowsEl = $('rows');

const nameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareEntries(a, b) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  let result;
  if (state.sortBy === 'mtime') result = a.mtime - b.mtime;
  else if (state.sortBy === 'size') result = a.size - b.size;
  else if (state.sortBy === 'type') result = nameOrder.compare(kindOf(a), kindOf(b));
  else if (state.sortBy === 'reader') result = ((a.readBy?.time || a.readInside?.time || 0) - (b.readBy?.time || b.readInside?.time || 0));
  else if (state.sortBy === 'tokens') result = tokenTotal(a.tokens) - tokenTotal(b.tokens);
  else if (state.sortBy === 'editor') result = nameOrder.compare(cellText(a, 'editor') || '~', cellText(b, 'editor') || '~') || ((editorOf(b)?.time || 0) - (editorOf(a)?.time || 0));
  else result = nameOrder.compare(a.name, b.name);
  if (result) return state.sortAsc ? result : -result;
  return nameOrder.compare(a.name, b.name); // equal dates or sizes: by name, whichever way it is sorted
}

// Sorting a huge folder is slow, so it only happens again when something that affects it changed.
let sorted = {};
function visibleEntries() {
  if (window.deepSearch?.on()) return deepSearch.list(); // "All folders inside" (search.js)
  const { entries, sortBy, sortAsc, search } = state;
  if (sorted.entries !== entries || sorted.sortBy !== sortBy || sorted.sortAsc !== sortAsc || sorted.search !== search) {
    const query = search.toLowerCase();
    const list = entries.filter((entry) => !query || entry.name.toLowerCase().includes(query)).sort(compareEntries);
    sorted = { entries, sortBy, sortAsc, search, list };
  }
  return sorted.list;
}

// Selecting only changes how rows look, so a click never has to rebuild the whole list.
function updateSelection() {
  for (const node of rowsEl.children) {
    if (!node.dataset.path) continue;
    node.classList.toggle('selected', state.selected.has(node.dataset.path));
    node.classList.toggle('focused', state.focus === node.dataset.path);
  }
  renderChrome();
}

function setSelection(paths, anchor) {
  state.selected = new Set(paths);
  if (anchor !== undefined) {
    state.anchor = anchor;
    state.focus = anchor;
  }
  updateSelection();
}

// The tick box adds or removes one item, leaving the rest picked, like Ctrl+click.
function toggleEntry(entry) {
  rowsEl.focus();
  if (state.selected.has(entry.path)) state.selected.delete(entry.path);
  else state.selected.add(entry.path);
  state.anchor = entry.path;
  state.focus = entry.path;
  updateSelection();
}

function fileIcon(entry, large) {
  if (entry.isDir) {
    const image = el('img', 'folder');
    image.src = 'folder.svg';
    image.alt = '';
    return image;
  }
  if (large && thumbed(entry.name)) {
    // Its small picture; the type's icon if there's none (a song without a cover).
    const image = el('img', 'thumb');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => image.replaceWith(typeIcon(entry)), { once: true });
    image.src = thumbUrl(entry);
    return image;
  }
  return typeIcon(entry);
}

function typeIcon(entry) {
  let name = 'document';
  if (ANY_PICTURE.test(entry.name)) name = 'image';
  else if (ANY_VIDEO.test(entry.name)) name = 'video';
  else if (ANY_AUDIO.test(entry.name)) name = 'music_note_2';
  return icon(name, 'file');
}

// The box you tick to pick things, as in File Explorer. It shows on hover and on anything picked.
function checkBox() {
  const box = el('span', 'check');
  box.append(icon('checkmark'));
  return box;
}

function wireEntry(node, entry) {
  node.dataset.path = entry.path;
  window.deepSearch?.tag(node, entry);
  node.classList.toggle('selected', state.selected.has(entry.path));
  node.classList.toggle('focused', state.focus === entry.path);
  node.classList.toggle('cut', Boolean(state.clipboard?.move && state.clipboard.paths.includes(entry.path)));
  node.addEventListener('click', (event) => {
    if (takeClick()) return;
    if (event.target.closest('.check')) toggleEntry(entry);
    else selectEntry(entry, event);
  });
  node.addEventListener('dblclick', (event) => {
    if (!event.target.closest('.check, .rename-input')) openEntry(entry);
  });
  // The middle button opens a folder in a new tab, as in File Explorer.
  node.addEventListener('auxclick', (event) => {
    if (event.button === 1 && entry.isDir) openFilesTab(entry.path);
  });
  node.addEventListener('pointerdown', (event) => pressOnEntry(event, node, entry));
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!state.selected.has(entry.path)) {
      state.selected = new Set([entry.path]);
      updateSelection();
    }
    entryMenu(entry, event.clientX, event.clientY);
  });
}

/* ---------- Last edited by ---------- */

const TOOL_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

// "claude-opus-5-5" -> "Claude Opus 5.5", "gpt-5-codex" -> "GPT-5 Codex", "gemini-2.5-pro" -> "Gemini 2.5 Pro".
function modelName(model, tool) {
  const raw = String(model || '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '').trim();
  if (!raw) return TOOL_NAMES[tool] || tool || 'AI';
  const words = raw.split(/[-_\s]+/);
  const out = [];
  words.forEach((word) => {
    const last = out[out.length - 1];
    if (/^\d+$/.test(word) && last && /\d$/.test(last)) out[out.length - 1] = `${last}.${word}`;
    else if (/^gpt$/i.test(word)) out.push('GPT');
    else if (/^\d/.test(word) && last === 'GPT') out[out.length - 1] = `GPT-${word}`;
    else out.push(word.charAt(0).toUpperCase() + word.slice(1));
  });
  return out.join(' ');
}

function ago(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDate(ms);
}

// What to show for an item: { label, tip, tool }, or null if nothing is known about who changed it.
function editorOf(entry) {
  if (entry.edits?.length) {
    const [last, before] = entry.edits;
    const lines = [`${modelName(last.model, last.tool)} · ${ago(last.time)}`];
    if (before) lines.push(`Before that: ${modelName(before.model, before.tool)} · ${ago(before.time)}`);
    return { label: modelName(last.model, last.tool), tip: lines.join('\n'), tool: last.tool, time: last.time };
  }
  // Changed after the AI's last note while it was working here: probably a command it ran. Shown as a guess.
  if (entry.likely) {
    const label = modelName(entry.likely.model, entry.likely.tool);
    return { label, tip: `${label} · ${ago(entry.likely.time)}
Likely a command it ran while working here`, tool: entry.likely.tool, time: entry.likely.time, inside: true, likely: true };
  }
  if (entry.owner) {
    const tip = entry.owner.via === 'station' ? `${entry.owner.name} · ${ago(entry.owner.time)}
Saved in Station 256` : `${entry.owner.name} · ${ago(entry.owner.time)}
Changed after the AI's last edit`;
    return { label: entry.owner.name, tip, tool: 'owner', time: entry.owner.time, person: true };
  }
  if (entry.editsInside) {
    const inside = entry.editsInside;
    return {
      label: modelName(inside.model, inside.tool),
      tip: `Last AI change inside: ${shortName(inside.file, 20, true)}\n${modelName(inside.model, inside.tool)} · ${ago(inside.time)}`,
      tool: inside.tool,
      time: inside.time,
      inside: true,
    };
  }
  return null;
}

function editorCell(entry) {
  const cell = el('span', 'cell-editor');
  const who = editorOf(entry);
  if (!who) return cell;
  cell.classList.add(`by-${who.tool || 'ai'}`);
  if (who.inside) cell.classList.add('inside');
  cell.append(el('span', 'editor-dot'), el('span', 'editor-name', who.label));
  cell.title = who.tip;
  return cell;
}

// "Last read by": which AI and model last read the file (or edited it, which reads it too), and when.
// A folder has no read of its own, so it shows the newest read inside it, like Last edited by does.
function readerOf(entry) {
  const read = entry.readBy;
  if (!read && entry.readInside) {
    const inside = entry.readInside;
    const label = modelName(inside.model, inside.tool);
    return { label, time: inside.time, tool: inside.tool, inside: true, tip: `Last AI read inside: ${shortName(inside.file, 20, true)}
${label} · ${ago(inside.time)}` };
  }
  if (!read) return null;
  const label = modelName(read.model, read.tool);
  return { label, time: read.time, tool: read.tool, tip: `${label} · ${ago(read.time)}\nClaude only. Codex and Gemini aren't tracked` };
}

function readerCell(entry) {
  const cell = el('span', 'cell-reader');
  const who = readerOf(entry);
  if (!who) return cell;
  cell.classList.add(`by-${who.tool || 'ai'}`);
  if (who.inside) cell.classList.add('inside');
  cell.append(el('span', 'editor-dot'), el('span', 'editor-name', who.label));
  cell.title = who.tip;
  return cell;
}

// What the Tokens column and its sort use: a project's all-time total when it has one, else read + written.
const tokenTotal = (got) => (got ? (got.allTime ?? got.in + got.out) : 0);

// The tokens of the AI steps that read or changed a file: what they read plus what they wrote, as Home counts them.
function tokensOf(entry) {
  const got = entry.tokens;
  const total = tokenTotal(got);
  if (total <= 0) return null;
  const used = got.in + got.out;
  // Each is whole here, with both lines, so test/text-length.js can hold it to two lines of hover text.
  let tip;
  if (got.allTime === undefined) {
    tip = entry.isDir ? `${got.in.toLocaleString()} read + ${got.out.toLocaleString()} written\nBy AI steps on the files in this folder`
      : `${got.in.toLocaleString()} read + ${got.out.toLocaleString()} written\nShared by the files each AI step touched`;
  } else if (entry.path === state.projects) {
    // Home's All time tile also counts AI work outside any project, so this doesn't claim to match it.
    tip = `${got.allTime.toLocaleString()} tokens all time, all projects\n${used.toLocaleString()} on files AI read or changed`;
  } else {
    // Not "of them": a conversation started outside the project can read its files too.
    tip = used > 0 ? `${got.allTime.toLocaleString()} tokens all time, as on Home\n${used.toLocaleString()} on files AI read or changed`
      : `${got.allTime.toLocaleString()} tokens all time, as on Home\nNo file in it read or changed by AI yet`;
  }
  return { total, tip };
}

function tokensCell(entry) {
  const cell = el('span', 'cell-tokens');
  const got = tokensOf(entry);
  if (!got) return cell;
  cell.textContent = bigNumber(got.total);
  cell.title = got.tip;
  return cell;
}

function cellText(entry, key) {
  if (key === 'name') return shownName(entry);
  if (key === 'mtime') return formatDate(entry.mtime);
  if (key === 'size') return entry.isDir ? '' : formatSize(entry.size);
  if (key === 'editor') return editorOf(entry)?.label || '';
  if (key === 'reader') return readerOf(entry)?.label || '';
  if (key === 'tokens') return tokensOf(entry) ? bigNumber(tokensOf(entry).total) : '';
  return kindOf(entry) === 'Project' && roomIsUp(entry.name) ? 'Project, room up' : kindOf(entry);
}

// Every view except Details. Sizes and layout come from the stylesheet, by the list's data-view.
function tileFor(entry, up) {
  const view = state.viewMode;
  const tile = el('div', 'tile');
  const art = el('div', 'tile-art');
  art.append(fileIcon(entry, !['small', 'list'].includes(view)));
  const text = el('div', 'tile-text');
  text.append(el('div', 'tile-name', shownName(entry)));
  tile.append(checkBox(), art, text);
  const line = (value) => el('div', 'tile-detail', value);
  if (view === 'tiles') {
    text.append(line(cellText(entry, 'type')));
    if (!entry.isDir) text.append(line(cellText(entry, 'size')));
  }
  if (view === 'content') {
    text.append(line(cellText(entry, 'type')));
    const side = el('div', 'tile-side');
    side.append(line(`Date modified: ${cellText(entry, 'mtime')}`));
    if (editorOf(entry)) side.append(line(`Last edited by: ${cellText(entry, 'editor')}${editorOf(entry).likely ? ' (likely)' : ''}`));
    if (readerOf(entry)) side.append(line(`Last read by: ${readerOf(entry).label} · ${ago(readerOf(entry).time)}`));
    if (tokensOf(entry)) side.append(line(`Tokens: ${cellText(entry, 'tokens')}`));
    if (!entry.isDir) side.append(line(`Size: ${cellText(entry, 'size')}`));
    tile.append(side);
  }
  if (up) tile.append(el('span', 'light tile-light'));
  tile.title = shownName(entry);
  wireEntry(tile, entry);
  return tile;
}

function renderEntries() {
  // A name being typed in place would be lost, so the list waits until it's done.
  if (renaming) {
    renaming.pending = true;
    return;
  }
  const entries = visibleEntries();
  rowsEl.replaceChildren();
  rowsEl.classList.toggle('icon-view', state.viewMode !== 'details');
  rowsEl.dataset.view = state.viewMode;

  // Station clears out old Trash by itself (panel/lib/housekeeping.js).
  if (inTrash()) rowsEl.append(el('div', 'trash-note', 'Items in the Trash are deleted for good after 30 days.'));

  if (!entries.length) {
    rowsEl.append(el('div', 'empty', window.deepSearch?.on() ? deepSearch.emptyText() : state.search ? 'No results in this folder.' : 'This folder is empty.'));
  }

  entries.forEach((entry) => {
    const project = kindOf(entry) === 'Project' ? entry.name : null;
    const up = project && roomIsUp(project);
    if (state.viewMode !== 'details') {
      rowsEl.append(tileFor(entry, up));
      return;
    }
    const row = el('div', 'row row-grid');
    const name = el('span', 'name cell-name');
    const nameText = el('span', 'name-text', shownName(entry));
    nameText.title = shownName(entry); // only shows when the name is cut off (tooltip.js)
    name.append(checkBox(), fileIcon(entry), nameText);
    if (up) name.append(el('span', 'light'));
    row.append(
      name,
      el('span', 'cell-mtime', cellText(entry, 'mtime')),
      editorCell(entry),
      readerCell(entry),
      tokensCell(entry),
      el('span', 'cell-type', cellText(entry, 'type')),
      el('span', 'size cell-size', cellText(entry, 'size')),
    );
    wireEntry(row, entry);
    rowsEl.append(row);
  });
  window.deepSearch?.decorate(rowsEl);

  renderChrome();
}

function renderAddress() {
  const address = $('address');
  const tab = state.active;
  address.replaceChildren();
  if (tab.kind === 'doc' || tab.kind === 'video' || tab.kind === 'song') {
    docAddress(address, tab);
    return;
  }
  if (tab.kind !== 'files') {
    const kindIcon = { agents: 'grid', rules: 'shield', llama: 'bot', schedules: 'calendar_ltr', editor: 'video_clip' }[tab.kind] || 'window_console';
    address.append(icon(kindIcon, 'address-icon'), el('span', 'crumb plain', tab.el.querySelector('.tab-title').textContent));
    return;
  }
  if (tab.path === HOME_PAGE) {
    address.append(icon('home-filled', 'address-icon tint-orange'), icon('chevron_right', 'crumb-sep'), el('span', 'crumb plain', 'Home'));
    return;
  }
  if (tab.path === state.trash) { // not the folder's real path (.local/share/house-trash)
    address.append(icon('delete', 'address-icon'), icon('chevron_right', 'crumb-sep'), el('span', 'crumb plain', 'Trash'));
    return;
  }
  address.append(icon('desktop', 'address-icon'), icon('chevron_right', 'crumb-sep'));
  const crumb = (label, target) => {
    const button = el('button', 'crumb', label);
    button.dataset.path = target; // so things can be dragged onto it
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      navigate(target);
    });
    address.append(button, icon('chevron_right', 'crumb-sep'));
  };
  const windows = inWindowsDrive(tab.path);
  crumb(windows ? 'Windows (C:)' : 'Linux House (L:)', windows ? state.windows : '/');
  let built = windows ? state.windows : '';
  tab.path.slice(built.length).split('/').filter(Boolean).forEach((part) => {
    built += `/${part}`;
    crumb(built === state.projects ? 'Projects' : part, built);
  });
  fitAddress();
}

// When a path doesn't fit, its oldest folders step aside whole, as Explorer does. The last one stays.
function fitAddress() {
  const address = $('address');
  const parts = [...address.children];
  parts.forEach((part) => { part.hidden = false; });
  // parts are the icon and its arrow, then a folder and its arrow, over and over
  for (let i = 2; i + 3 < parts.length && address.scrollWidth > address.clientWidth; i += 2) {
    parts[i].hidden = true;
    parts[i + 1].hidden = true;
  }
}

new ResizeObserver(fitAddress).observe($('address'));

// The top bar's labels fold away at set widths (style.css). When the buttons that come and go
// (a room's, Preview, a copy's ring) still don't fit, more fold, a step at a time, until they do.
const BAR_FOLDS = 5;
function fitCommandbar() {
  const bar = document.querySelector('.commandbar');
  for (let fold = 1; fold <= BAR_FOLDS; fold += 1) bar.classList.remove(`fold-${fold}`);
  for (let fold = 1; fold <= BAR_FOLDS && bar.scrollWidth > bar.clientWidth + 1; fold += 1) bar.classList.add(`fold-${fold}`);
}
new ResizeObserver(fitCommandbar).observe(document.querySelector('.commandbar'));
// A button shown or hidden, or a label changed, doesn't change the bar's size, so watch for those too.
new MutationObserver(fitCommandbar).observe(document.querySelector('.commandbar'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });

// Clicking the empty part of the address bar lets you type a path. So do Ctrl+L, Alt+D and F4.
$('address').addEventListener('click', () => editAddress());
function editAddress() {
  const tab = state.active;
  if (tab.kind !== 'files' || $('address').querySelector('input')) return;
  const input = el('input', 'address-input');
  input.value = tab.path === HOME_PAGE ? 'Home' : inWindowsDrive(tab.path) ? windowsPath(tab.path) : tab.path;
  input.spellcheck = false;
  $('address').replaceChildren(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const typed = input.value.trim();
      // C:\... goes to the Windows drive, which only opens while the Windows lock is open.
      const onC = /^[Cc]:([\\/]|$)/.test(typed) && state.windows;
      const typedPath = onC
        ? `${state.windows}/${typed.slice(2).replaceAll('\\', '/')}`.replace(/\/+/g, '/').replace(/\/$/, '')
        : typed.replace(/^[Ll]:[\\/]?/, '/').replaceAll('\\', '/');
      navigate(typed.toLowerCase() === 'home' ? HOME_PAGE : typedPath);
      input.blur();
      if (input.isConnected) renderAddress(); // the box closes even if it had lost focus
    }
    if (event.key === 'Escape') renderAddress();
  });
  input.addEventListener('blur', () => renderAddress());
}

function setEnabled(id, enabled) {
  $(id).disabled = !enabled;
}

function renderChrome() {
  const tab = state.active;
  if (!tab) return;
  // Home has no list, so what works on a list (sorting, views, search, paste) is off there.
  const home = tab.kind === 'files' && tab.path === HOME_PAGE;
  const isFiles = tab.kind === 'files' && !home;
  // Recent files picked on Home count too: Cut, Copy, Rename and Delete work on them.
  const selection = isFiles || home ? [...state.selected] : [];

  if (!$('address').querySelector('input')) renderAddress();
  setEnabled('back', tab.kind === 'files' && tab.back.length > 0);
  setEnabled('forward', tab.kind === 'files' && tab.forward.length > 0);
  // The Windows drive is view and copy only, so nothing that changes it is pressable there.
  const windows = isFiles ? onWindows() : selection.some(inWindowsDrive);
  setEnabled('up', isFiles ? tab.path !== '/' && tab.path !== state.windows : FILE_TABS.includes(tab.kind));
  setEnabled('refresh', isFiles || home);
  setEnabled('cut', selection.length > 0 && !inTrash() && !windows);
  setEnabled('copy', selection.length > 0);
  // Files copied in Windows keep Paste pressable while locked, so pressing it can say why it won't work.
  const lockedPaste = !state.clipboard && state.windowsFiles > 0 && !state.status.doorOpen;
  setEnabled('paste', isFiles && (canPaste() || lockedPaste) && !inTrash() && !windows);
  $('paste').title = lockedPaste ? 'Paste (Ctrl+V)\nUnlock Windows access first.' : 'Paste (Ctrl+V)';
  setEnabled('rename', selection.length === 1 && !inTrash() && !windows);
  $('trash-restore').hidden = !inTrash();
  $('trash-empty').hidden = !inTrash();
  setEnabled('trash-restore', selection.length > 0);
  setEnabled('trash-empty', state.entries.length > 0);
  setEnabled('delete', selection.length > 0 && !windows);
  setEnabled('sort-btn', isFiles);
  setEnabled('view-btn', isFiles);
  $('search').disabled = !isFiles;
  $('search').placeholder = isFiles ? (window.deepSearch?.placeholder(baseName(tab.path)) || `Search ${baseName(tab.path)}`) : 'Search';
  $('view-details').disabled = !isFiles;
  $('view-icons').disabled = !isFiles;

  $('view-details').classList.toggle('on', state.viewMode === 'details');
  $('view-icons').classList.toggle('on', state.viewMode === 'large');
  // The View button says which view you're in, and changes with the two buttons at the bottom right.
  const view = VIEWS.find((item) => item.id === state.viewMode) || VIEWS[5];
  $('view-btn-label').textContent = view.label.replace(' icons', '');
  setIcon($('view-btn-icon'), view.icon);
  // The little arrow sits on whichever column the list is sorted by, as in File Explorer.
  const mark = $('sort-mark');
  const sortedHead = $('columns').querySelector(`[data-sort="${state.sortBy}"]`);
  if (sortedHead && mark.parentElement !== sortedHead) sortedHead.insertBefore(mark, sortedHead.querySelector('.col-grip'));
  mark.hidden = !sortedHead;
  setIcon(mark, state.sortAsc ? 'chevron_up' : 'chevron_down');

  // As in File Explorer: how many, and how many are picked, with their size when they're all files.
  const shown = isFiles ? visibleEntries() : [];
  let count = isFiles ? plural(shown.length, 'item') : '';
  if (selection.length) {
    const pickedEntries = shown.filter((entry) => state.selected.has(entry.path));
    const bytes = pickedEntries.every((entry) => !entry.isDir) ? pickedEntries.reduce((sum, entry) => sum + entry.size, 0) : null;
    count += `     ${plural(selection.length, 'item')} selected${bytes !== null && pickedEntries.length ? `     ${formatSize(bytes)}` : ''}`;
  }
  if (windows) count += '     View and copy only';
  $('item-count').textContent = count;
  $('nav-windows').hidden = !state.status.windowsDrive;
  const headCheck = $('check-all');
  headCheck.classList.toggle('on', shown.length > 0 && selection.length === shown.length);
  headCheck.classList.toggle('some', selection.length > 0 && selection.length < shown.length);

  document.querySelectorAll('.nav-item').forEach((item) => {
    const here = navPath(item.dataset.nav) === tab.path || (item.dataset.nav === 'windows' && Boolean(state.windowsHome) && tab.path === state.windowsHome);
    item.classList.toggle('selected', tab.kind === 'files' && here);
  });

  // Room buttons follow the selected project, or the project you're inside. In a project, a room
  // terminal starts in the folder you picked, or else the folder you're looking at.
  const selectedEntry = selection.length === 1 ? state.entries.find((entry) => entry.path === selection[0]) : null;
  let project = null;
  let folder = '';
  const place = isFiles ? roomPlace(selectedEntry?.isDir ? selectedEntry.path : tab.path) : null;
  if (place) ({ project, folder } = place);
  else if (isFiles) project = projectOf(tab.path);
  else project = tab.room;
  state.currentProject = project;
  state.currentFolder = folder;
  const up = project && roomIsUp(project);
  // One button, both ways: from a project's files into its room, and from its terminal back to its files.
  $('room-btn').hidden = !project;
  // The project's site, one click away (preview.js keeps its words and spinner up to date).
  $('room-preview-btn').hidden = !project;
  $('room-preview-btn').dataset.project = project || '';
  if (project && typeof previewPaint === 'function') previewPaint($('room-preview-btn')); // preview.js loads after this file
  // Another terminal needs a room to join. Until it's up, Open room does the same job.
  $('room-new-btn').hidden = !up;
  $('room-close-btn').hidden = !up;
  // On a room terminal it closes just that one. From the project's files it closes them all.
  const oneRoom = isRoomTerminal(tab);
  $('room-close-label').textContent = oneRoom ? 'Close Room' : 'Close All Rooms';
  $('room-close-btn').title = oneRoom ? 'Close this room. Other rooms in this project keep going' : 'Close every room in this project';
  if (project) {
    const roomLabel = up ? 'Enter Room' : 'Open Room';
    setIcon($('room-btn-icon'), isFiles ? 'play' : 'folder_open');
    $('room-btn-icon').className = isFiles ? 'tint-green' : 'tint-orange';
    $('room-btn-label').textContent = isFiles ? roomLabel : 'View Files';
    const shown = shortName(project, 24);
    const where = folder ? ` in ${shortName(baseName(folder), 20)}` : '';
    $('room-btn').title = isFiles ? (up ? `Go to the ${shown} room's terminal${where}.` : `Start the ${shown} room, so AI can work there.`) : `See the ${shown} files.`;
  }

  syncCopyView();
  renderHouseNote();
}

function renderHouseNote() {
  const { rooms, dockerOk, keeper, doorOpen, lowDisk, freeGb } = state.status;
  const note = $('house-note');
  let text = keeper.startsWith('idle') ? 'House idle' : keeper.replace('awake: ', 'House awake: ');
  if (rooms.length) text = `${rooms.length} room${rooms.length === 1 ? '' : 's'} open, house stays awake until closed`;
  if (!dockerOk) text = 'Docker isn\'t answering, so rooms may not be available';
  if (lowDisk) text = `House storage is almost full: ${Math.floor(freeGb)} GB left`;
  // The status bar only counts items now, as in File Explorer. This note lives in the System panel.
  note.textContent = text;
  note.hidden = true;
  note.classList.toggle('attention', rooms.length > 0 || !dockerOk || Boolean(lowDisk));
  // A problem the house has puts a dot on the System button, so it's seen without the old status bar note.
  const problem = !dockerOk ? 'Docker isn\'t answering' : lowDisk ? `Storage is almost full: ${Math.floor(freeGb)} GB left` : '';
  $('toggle-system').classList.toggle('attention', Boolean(problem));
  $('toggle-system').title = problem ? `${problem}.\nClick to see more.` : 'How the house is doing: rooms, memory, storage.';

  // Locked is the calm, normal state. Unlocked stands out, so an open door is never missed.
  setIcon($('lock-icon'), doorOpen ? 'lock_open-filled' : 'lock_closed-filled');
  $('lock-icon').className = '';
  $('lock-btn').classList.toggle('unlocked', Boolean(doorOpen));
  $('lock-label').textContent = doorOpen ? 'Unlocked' : 'Locked';
  $('lock-btn').title = doorOpen
    ? 'Unlocked: rooms can read your C: drive.\nClick to lock.'
    : 'Locked: rooms can\'t see your C: drive.\nClick to unlock.';
}

async function loadFolder() {
  const tab = state.active;
  if (!tab || tab.kind !== 'files') return;
  const folder = tab.path;
  // Small pictures still waiting to be made for the folder just left aren't needed (lib/thumbs.js).
  if (tab.listed && tab.listed !== folder) call('thumbsLeft', tab.listed).catch(() => {});
  tab.listed = folder;
  showHome(folder === HOME_PAGE);
  if (folder === HOME_PAGE) {
    state.entries = [];
    state.selected = new Set();
    tab.el.querySelector('.tab-title').textContent = 'Home';
    showPlaceIcon(tab);
    renderChrome();
    await renderHome();
    return;
  }
  // A slow folder that finishes after you've moved on must not replace what's on screen.
  const stillWanted = () => state.active === tab && tab.path === folder;
  try {
    const entries = await call('list', folder, state.showHidden);
    if (!stillWanted()) return;
    state.entries = entries;
    window.deepSearch?.rerun();
    const known = new Set(entries.map((entry) => entry.path));
    state.selected = new Set([...state.selected].filter((target) => known.has(target)));
    tab.el.querySelector('.tab-title').textContent = baseName(folder);
    showPlaceIcon(tab);
    renderEntries();
    // Once, on arriving. A later refresh mustn't move the list if you've scrolled away.
    if (tab.revealSelected) rowsEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    tab.revealSelected = false;
  } catch (error) {
    if (!stillWanted()) return;
    // Stays on the last folder that worked, so the address bar always matches what's listed.
    const previous = tab.back.pop();
    if (previous === undefined) {
      state.entries = [];
      renderEntries();
    } else {
      tab.path = previous;
    }
    await alertBox('This folder can\'t be opened', cleanError(error));
    if (previous !== undefined) loadFolder();
  }
}

// The folder directly inside `folder` that leads to `from`, if `from` is somewhere inside it.
function folderLeadingTo(from, folder) {
  const prefix = folder === '/' ? '/' : `${folder}/`;
  return from.startsWith(prefix) ? prefix + from.slice(prefix.length).split('/')[0] : null;
}

function navigate(target, keepHistory) {
  const tab = state.active;
  if (!tab || tab.kind !== 'files' || (!target.startsWith('/') && target !== HOME_PAGE)) return;
  const clean = target.length > 1 && target !== HOME_PAGE ? target.replace(/\/+$/, '') : target;
  // Coming back out of a folder leaves it selected, as File Explorer does, by any route: Back, Up or the address bar.
  const cameFrom = folderLeadingTo(tab.path, clean);
  if (!keepHistory && clean !== tab.path) {
    tab.back.push(tab.path);
    tab.forward = [];
  }
  tab.path = clean;
  state.selected = new Set(cameFrom ? [cameFrom] : []);
  state.anchor = cameFrom;
  tab.revealSelected = Boolean(cameFrom);
  state.search = '';
  $('search').value = '';
  loadFolder();
}

function navPath(key) {
  if (key === 'home') return HOME_PAGE;
  if (key === 'projects') return state.projects;
  if (key === 'trash') return state.trash;
  if (key === 'root') return '/';
  if (key === 'windows') return state.windows;
  return `${state.home}/${key}`;
}

function selectEntry(entry, event) {
  rowsEl.focus();
  rowsEl.classList.remove('keyboard');
  if (event.ctrlKey) {
    if (state.selected.has(entry.path)) state.selected.delete(entry.path);
    else state.selected.add(entry.path);
    state.anchor = entry.path;
  } else if (event.shiftKey && visibleEntries().some((item) => item.path === state.anchor)) {
    state.selected = new Set(rangeTo(entry.path));
  } else {
    state.selected = new Set([entry.path]);
    state.anchor = entry.path;
  }
  state.focus = entry.path;
  updateSelection();
}

// Everything from the anchor to here, in the order shown.
function rangeTo(target) {
  const paths = visibleEntries().map((item) => item.path);
  const from = Math.max(0, paths.indexOf(state.anchor));
  const to = paths.indexOf(target);
  return paths.slice(Math.min(from, to), Math.max(from, to) + 1);
}

function openEntry(entry) {
  if (entry.isDir) navigate(entry.path);
  else openFile(entry);
}

// Markdown, text and code open in a page of their own to change (doc-tab.js), and so do videos
// (video-tab.js); the rest in the preview.
function openFile(entry) {
  if (opensAsDoc(entry)) openDoc(entry.path);
  else if (opensAsVideo(entry)) openVideo(entry.path);
  else if (songEditable(entry)) openSong(entry.path); // music-info.js
  else if (/\.gguf$/i.test(entry.name)) useInLlama(entry.path); // llama-tab.js
  else showPreview(entry);
}

// The shared four for files, doing just what the toolbar's buttons do, and greyed when they are.
// selectAll is what Select All picks here (a folder's list, or Home's recent files).
const fileActions = (selectAllRun = selectAll) => ({
  cut: $('cut').disabled ? null : () => $('cut').click(),
  copy: $('copy').disabled ? null : () => $('copy').click(),
  paste: $('paste').disabled ? null : () => $('paste').click(),
  selectAll: selectAllRun,
});

const isHtmlFile = (entry) => !entry.isDir && /\.html?$/i.test(entry.name);
// Beside Open (which stays the text editor): the page in Station's own Web Browser tab.
const browserItem = (entry) => ({ label: 'Open in Web Browser', icon: 'link', disabled: state.selected.size > 1, run: () => openHtmlInBrowser(entry) });

function entryMenu(entry, x, y) {
  const picked = () => [...state.selected];
  const openMenu = (left, top, items) => rightClickMenu(left, top, fileActions(), items); // every exit below gets the four first
  if (inTrash()) {
    openMenu(x, y, [
      { label: entry.isDir ? 'Open' : 'Preview', icon: entry.isDir ? 'folder_open' : 'eye', run: () => openEntry(entry) },
      '-',
      { label: 'Restore', icon: 'arrow_left', run: restoreSelected },
      { label: 'Delete Forever', icon: 'delete', run: () => deleteSelected(true) },
      '-',
      { label: 'Properties', icon: 'info', run: () => showProperties(picked()) },
    ]);
    return;
  }
  // A project, or a folder inside one: its room's terminal then starts in that folder.
  const place = entry.isDir ? roomPlace(entry.path) : null;
  const project = place?.project || null;
  const folder = place?.folder || '';
  const items = [{ label: 'Open', icon: entry.isDir ? 'folder_open' : 'eye', disabled: state.selected.size > 1, run: () => openEntry(entry) }]; // as Enter: one item
  window.deepSearch?.openLocationItems(entry, items);
  if (isHtmlFile(entry)) items.push(browserItem(entry));
  if (entry.isDir) items.push({ label: 'Open in New Tab', icon: 'tab_add', run: () => openFilesTab(entry.path) });
  // On the Windows drive: only looking, opening and copying.
  const windows = inWindowsDrive(entry.path);
  if (isArchive(entry) && !windows) {
    items.push({ label: 'Extract All', icon: 'archive', run: () => extractArchive(entry, 'all') });
    items.push({ label: 'Extract Here', icon: 'archive', run: () => extractArchive(entry, 'here') });
  }
  if (!entry.isDir && !shownHere(entry)) {
    items.push({ label: 'Open in Windows App', icon: 'open', run: () => openInWindows(entry, false) });
    items.push({ label: 'Open With…', icon: 'open', run: () => openInWindows(entry, true) });
  }
  if (!entry.isDir && /\.gguf$/i.test(entry.name) && !windows) items.push({ label: 'Load in Local AI', icon: 'bot', run: () => useInLlama(entry.path) }); // llama-tab.js
  if (songEditable(entry)) items.push({ label: 'Edit song info', icon: 'music_note_2', disabled: state.selected.size > 1, run: () => openSong(entry.path) }); // music-info.js
  if (project) {
    const up = roomIsUp(project);
    items.push({ label: up ? 'Enter Room' : 'Open Room', icon: 'play', tint: 'tint-green', run: () => enterRoom(project, folder) });
    items.push({ label: previewLabel(project), icon: 'open', tint: 'tint-blue', run: () => previewProject(project) }); // preview.js
    if (up) {
      items.push({ label: 'New Room', icon: 'window_console', tint: 'tint-blue', run: () => openTerminal({ room: project, cwd: folder }) });
      items.push({ label: 'Close All Rooms', icon: 'checkbox_unchecked', tint: 'tint-red', run: () => closeRoom(project) });
    }
  }
  if (windows) {
    items.push(
      '-',
      { label: 'Copy as Path', icon: 'link', run: () => copyAsPath(picked()) },
      '-',
      { label: 'Properties', icon: 'info', run: () => showProperties(picked()) },
    );
    openMenu(x, y, items);
    return;
  }
  items.push(
    '-',
    { label: 'Copy as Path', icon: 'link', run: () => copyAsPath(picked()) },
    { label: 'Compress to ZIP File', icon: 'folder_zip', run: compressSelected },
    { label: 'Rename', icon: 'rename', disabled: state.selected.size !== 1, run: renameSelected },
    { label: 'Delete', icon: 'delete', run: deleteSelected },
    '-',
    { label: 'Properties', icon: 'info', run: () => showProperties(picked()) },
  );
  openMenu(x, y, items);
}

rowsEl.addEventListener('click', (event) => {
  if (takeClick()) return;
  if (event.target === rowsEl || event.target.classList.contains('empty')) {
    state.selected = new Set();
    updateSelection();
  }
});

/* ---------- Picking and moving things, as in File Explorer ---------- */

// After a drag, the button coming up would also count as a click. This makes sure it doesn't.
let clickTaken = false;
function takeClick() {
  const taken = clickTaken;
  clickTaken = false;
  return taken;
}
const swallowNextClick = () => {
  clickTaken = true;
  setTimeout(() => { clickTaken = false; }, 0); // only the click from this same press
};

// A point on the list, counted from the top-left of everything in it, scrolled or not.
function onList(x, y) {
  const box = rowsEl.getBoundingClientRect();
  return { x: x - box.left + rowsEl.scrollLeft, y: y - box.top + rowsEl.scrollTop };
}

// Where each item sits on the list. In Details only the columns count, not the empty space past them.
function itemBoxes() {
  const listBox = rowsEl.getBoundingClientRect();
  const columnsWide = parseFloat(filesView.style.getPropertyValue('--cols-total')) || 0;
  return [...rowsEl.children].filter((node) => node.dataset.path).map((node) => {
    const box = node.getBoundingClientRect();
    const left = box.left - listBox.left + rowsEl.scrollLeft;
    const top = box.top - listBox.top + rowsEl.scrollTop;
    const isRow = node.classList.contains('row');
    const width = isRow && columnsWide ? Math.min(box.width, columnsWide) : box.width;
    return { path: node.dataset.path, left: left + (isRow ? 8 : 0), top, right: left + width - (isRow ? 8 : 0), bottom: top + box.height };
  });
}

// Scrolls the list while the pointer is held near or past its edge, faster the further out it is.
function edgeScroller(getPoint, onScroll) {
  let frame = 0;
  const step = () => {
    const point = getPoint();
    const box = rowsEl.getBoundingClientRect();
    const speed = (over) => Math.sign(over) * Math.min(28, Math.ceil(Math.abs(over) / 3));
    let dy = 0;
    let dx = 0;
    if (point.y < box.top + 16) dy = speed(point.y - (box.top + 16));
    else if (point.y > box.bottom - 16) dy = speed(point.y - (box.bottom - 16));
    if (point.x < box.left + 16) dx = speed(point.x - (box.left + 16));
    else if (point.x > box.right - 16) dx = speed(point.x - (box.right - 16));
    const before = [rowsEl.scrollTop, rowsEl.scrollLeft];
    rowsEl.scrollTop += dy;
    rowsEl.scrollLeft += dx;
    if (rowsEl.scrollTop !== before[0] || rowsEl.scrollLeft !== before[1]) onScroll();
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

/* Dragging across empty space draws a box, and everything it touches is picked, as in File Explorer.
   Ctrl flips what it touches; Shift adds to what's already picked. */
const marquee = el('div', 'marquee');

function startMarquee(event, holder) {
  const ctrl = event.ctrlKey;
  const add = event.shiftKey;
  const before = new Set(state.selected);
  const origin = onList(event.clientX, event.clientY);
  let boxes = [];
  let last = event;
  let stopScroll = () => {};
  let shown = '';
  const draw = () => {
    const point = onList(last.clientX, last.clientY);
    const left = Math.min(origin.x, point.x);
    const top = Math.min(origin.y, point.y);
    const right = Math.max(origin.x, point.x);
    const bottom = Math.max(origin.y, point.y);
    if (!marquee.isConnected) rowsEl.append(marquee); // the list may have been redrawn meanwhile
    Object.assign(marquee.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    const touched = boxes.filter((item) => item.left < right && item.right > left && item.top < bottom && item.bottom > top).map((item) => item.path);
    let next;
    if (ctrl) {
      next = new Set(before);
      touched.forEach((target) => (before.has(target) ? next.delete(target) : next.add(target)));
    } else {
      next = new Set(add ? [...before, ...touched] : touched);
    }
    const key = [...next].join('\n');
    if (key === shown) return;
    shown = key;
    state.selected = next;
    if (touched.length) state.focus = touched[touched.length - 1];
    updateSelection();
  };
  window.houseFrame.track(holder, event, {
    begin(current) {
      rowsEl.focus();
      boxes = itemBoxes();
      last = current;
      rowsEl.append(marquee);
      draw();
      stopScroll = edgeScroller(() => ({ x: last.clientX, y: last.clientY }), draw);
    },
    move(current) {
      last = current;
      draw();
    },
    end(_last, moved) {
      stopScroll();
      marquee.remove();
      if (moved) swallowNextClick();
    },
  });
}

rowsEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || state.active?.kind !== 'files' || renaming) return;
  if (event.target === rowsEl || event.target.classList.contains('empty')) startMarquee(event, rowsEl);
});

/* Dragging things moves them, as in File Explorer: onto a folder, a place in the sidebar, a folder in
   the address bar, or a tab. Hold Ctrl to copy instead. Onto Trash deletes them. Esc cancels. A label
   by the pointer always says what letting go will do. In Details, a drag that starts away from the
   name (on the date, say) draws a box instead, as Explorer does. */
const dragGhost = el('div', 'drag-ghost');
const dragCard = el('div', 'drag-card');
const dragArt = el('div', 'drag-art');
const dragText = el('div', 'drag-text');
const dragName = el('div', 'drag-name');
const dragMore = el('div', 'drag-more');
dragText.append(dragName, dragMore);
const dragCount = el('span', 'drag-count');
dragCard.append(dragArt, dragText, dragCount);
const dragTip = el('div', 'drag-tip');
const dragTipIcon = icon('arrow_right');
const dragTipText = el('span');
dragTip.append(dragTipIcon, dragTipText);
dragGhost.append(dragCard, dragTip);
document.body.append(dragGhost);
dragGhost.hidden = true;

// The card under the pointer: the item's picture and name, and what else comes along.
function showDragCard(entry, paths) {
  const items = paths.map((target) => state.entries.find((item) => item.path === target)).filter(Boolean);
  const lead = items.find((item) => item.path === entry.path) || entry;
  dragArt.replaceChildren(fileIcon(lead, thumbed(lead.name)));
  dragName.textContent = shownName(lead);
  const rest = items.length - 1;
  if (rest > 0) {
    const folders = items.filter((item) => item.isDir).length;
    const filesCount = items.length - folders;
    const parts = [];
    if (filesCount) parts.push(plural(filesCount, 'file'));
    if (folders) parts.push(plural(folders, 'folder'));
    dragMore.textContent = `and ${rest} more · ${parts.join(', ')}`;
  } else {
    dragMore.textContent = lead.isDir ? kindOf(lead) : [kindOf(lead), lead.size ? formatSize(lead.size) : ''].filter(Boolean).join(' · ');
  }
  dragCount.textContent = String(items.length);
  dragCount.hidden = items.length < 2;
  dragCard.classList.toggle('stack', items.length > 1);
}

let dragging = null; // what's being dragged right now
let dragHoverTimer = null;

function pressOnEntry(event, node, entry) {
  if (event.button !== 0 || renaming || event.target.closest('.check, .rename-input')) return;
  event.stopPropagation(); // the list's own press is for drawing a box
  // As in File Explorer: pressing on an item, picked or not, drags it (and everything else picked).
  // In Details, the space to the right of the columns is empty space, so a box starts there.
  if (node.classList.contains('row')) {
    const columnsWide = parseFloat(filesView.style.getPropertyValue('--cols-total')) || 0;
    const fromLeft = event.clientX - node.getBoundingClientRect().left;
    if (columnsWide && fromLeft > columnsWide) {
      startMarquee(event, node);
      return;
    }
  }
  if (inTrash()) return; // things in the trash come out with Restore
  window.houseFrame.track(node, event, {
    begin(current) {
      // Ctrl+drag on something not picked adds it to the rest, as Explorer does.
      if (!state.selected.has(entry.path)) {
        if (current.ctrlKey) {
          state.selected.add(entry.path);
          state.focus = entry.path;
          updateSelection();
        } else {
          setSelection([entry.path], entry.path);
        }
      }
      const paths = visibleEntries().filter((item) => state.selected.has(item.path)).map((item) => item.path);
      dragging = { paths, from: state.active.path, target: null, copy: false };
      showDragCard(entry, paths);
      dragGhost.hidden = false;
      document.documentElement.classList.add('item-dragging');
      document.addEventListener('keydown', dragKeys, true);
      document.addEventListener('keyup', dragKeys, true);
      dragging.holder = node;
      dragging.pointerId = current.pointerId;
      dragging.stopScroll = edgeScroller(() => dragging?.point || { x: current.clientX, y: current.clientY }, () => dragAt(dragging.point));
      dragAt({ x: current.clientX, y: current.clientY, ctrl: current.ctrlKey });
    },
    move(current) {
      dragAt({ x: current.clientX, y: current.clientY, ctrl: current.ctrlKey });
    },
    async end(_last, moved, cancelled) {
      const job = dragging;
      endItemDrag();
      if (!moved) return;
      swallowNextClick();
      if (!cancelled && job?.target?.ok) await dropItems(job.paths, job.target, job.copy);
    },
  });
}

// Esc cancels, and pressing or letting go of Ctrl switches between moving and copying.
function dragKeys(event) {
  if (!dragging) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    dragging.target = null;
    try { dragging.holder.releasePointerCapture(dragging.pointerId); } catch { /* already let go */ }
  } else if (event.key === 'Control' && dragging.point) {
    dragAt({ ...dragging.point, ctrl: event.type === 'keydown' });
  }
}

function endItemDrag() {
  if (!dragging) return;
  dragging.stopScroll?.();
  clearTimeout(dragHoverTimer);
  document.removeEventListener('keydown', dragKeys, true);
  document.removeEventListener('keyup', dragKeys, true);
  document.querySelectorAll('.drop-into').forEach((node) => node.classList.remove('drop-into'));
  document.documentElement.classList.remove('item-dragging');
  dragGhost.hidden = true;
  dragging = null;
}

// What letting go here would do: { path or trash, name, node, ok, why }.
function dropTargetAt(x, y) {
  const under = document.elementFromPoint(x, y);
  if (!under) return null;
  const { paths } = dragging;
  const into = (folder, name, node) => {
    if (paths.some((source) => folder === source || folder.startsWith(`${source}/`))) return { node, name, ok: false, why: 'A folder can\'t go inside itself' };
    // The Windows drive is view and copy only: nothing goes onto it, and nothing on it goes to Trash.
    if (inWindowsDrive(folder)) return { node, name, ok: false, why: 'Windows (C:) is view and copy only' };
    if (folder === state.trash && paths.some(inWindowsDrive)) return { node, name, ok: false, why: 'Things on Windows (C:) can\'t be deleted from here' };
    if (folder === state.trash) return { node, trash: true, name: 'Trash', ok: true };
    const sameFolder = paths.every((source) => parentOf(source) === folder);
    return { node, path: folder, name, ok: !sameFolder || dragging.copy };
  };
  const item = under.closest('[data-path]');
  if (item && rowsEl.contains(item)) {
    const entry = state.entries.find((candidate) => candidate.path === item.dataset.path);
    if (entry?.isDir && !paths.includes(entry.path)) return into(entry.path, shownName(entry), item);
  }
  if (under.closest('#rows') && state.active?.kind === 'files' && !inTrash()) return into(state.active.path, baseName(state.active.path), null);
  // Home is a page, not a folder: nothing can be dropped on it.
  const place = under.closest('.nav-item');
  if (place) return navPath(place.dataset.nav) === HOME_PAGE ? null : into(navPath(place.dataset.nav), place.querySelector('span').textContent, place);
  const crumb = under.closest('.crumb[data-path]');
  if (crumb) return into(crumb.dataset.path, crumb.textContent, crumb);
  const tabNode = under.closest('.tab');
  const tab = tabNode && state.tabs.find((candidate) => candidate.el === tabNode);
  if (tab?.kind === 'files' && tab.path !== HOME_PAGE) {
    // Resting on a tab for a moment opens it, so things can be dropped right into its list.
    if (state.active !== tab && dragging.waitingOn !== tab) {
      clearTimeout(dragHoverTimer);
      dragging.waitingOn = tab;
      dragHoverTimer = setTimeout(() => { if (dragging) activateTab(tab); }, 600);
    }
    return into(tab.path, baseName(tab.path), tabNode);
  }
  return null;
}

function dragAt(point) {
  if (!dragging) return;
  dragging.point = point;
  // Things on the Windows drive are only ever copied, never moved off it.
  dragging.copy = Boolean(point.ctrl) || dragging.paths.some(inWindowsDrive);
  dragGhost.style.transform = `translate(${point.x + 14}px, ${point.y + 18}px)`;
  const target = dropTargetAt(point.x, point.y);
  if (!target?.node?.classList.contains('tab')) {
    clearTimeout(dragHoverTimer);
    dragging.waitingOn = null;
  }
  dragging.target = target;
  document.querySelectorAll('.drop-into').forEach((node) => { if (node !== target?.node) node.classList.remove('drop-into'); });
  if (target?.ok && target.node) target.node.classList.add('drop-into');
  dragTip.hidden = !target || (!target.ok && !target.why);
  dragTip.classList.toggle('no', Boolean(target && !target.ok));
  if (!target) return;
  if (!target.ok) {
    setIcon(dragTipIcon, 'dismiss');
    dragTipText.textContent = target.why || '';
    return;
  }
  if (target.trash) {
    setIcon(dragTipIcon, 'delete');
    dragTipText.textContent = 'Move to Trash';
  } else {
    setIcon(dragTipIcon, dragging.copy ? 'add' : 'arrow_right');
    dragTipText.textContent = `${dragging.copy ? 'Copy' : 'Move'} to ${target.name}`;
  }
}

async function dropItems(paths, target, copy) {
  if (target.trash) {
    await trashPaths(paths);
    return;
  }
  const count = paths.length;
  const what = count === 1 ? `"${entryName(paths[0])}"` : `${count} items`;
  if (copy) {
    await runJob({
      verb: 'Copying', count, dir: target.path, icon: 'copy',
      run: async () => {
        const result = await call('transfer', paths, target.path, false);
        if (result.done.length) remember({ type: 'copy', label: 'copy', paths: result.done.map((pair) => pair.to) });
        return result.failures;
      },
    });
    toast(`Copied ${what} to ${target.name}`);
    return;
  }
  const result = await attempt(() => call('transfer', paths, target.path, true));
  if (!result) return;
  if (result.done.length) {
    const undo = { type: 'move', label: 'move', pairs: result.done };
    remember(undo);
    toast(`Moved ${result.done.length === 1 ? `"${baseName(result.done[0].to)}"` : `${result.done.length} items`} to ${target.name}`, 'Undo', () => undoAction(undo));
  }
  state.selected = new Set();
  await reportFailures(result.failures, count);
  loadFolder();
}

/* ---------- Toasts: a short note at the bottom that goes away by itself ---------- */

const toastEl = el('div', 'toast');
const toastText = el('span', 'toast-text');
const toastButton = el('button', 'toast-button');
toastEl.append(toastText, toastButton);
toastEl.hidden = true;
document.querySelector('.app').append(toastEl);
let toastTimer = null;
let toastAction = null;

function toast(text, actionLabel, action) {
  clearTimeout(toastTimer);
  toastText.textContent = fitLines(text, FIT.toast);
  toastButton.hidden = !actionLabel;
  toastButton.textContent = actionLabel || '';
  toastAction = action || null;
  toastEl.hidden = false;
  toastEl.classList.remove('leaving');
  // Restarts the little rise each time, even when one note replaces another.
  toastEl.getAnimations().forEach((animation) => animation.cancel());
  toastEl.animate([{ opacity: 0, transform: 'translate(-50%, 6px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 160, easing: 'ease-out' });
  toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 3500);
}

function hideToast() {
  clearTimeout(toastTimer);
  if (toastEl.hidden) return;
  const fade = toastEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in' });
  fade.onfinish = () => { toastEl.hidden = true; };
}

toastButton.addEventListener('click', () => {
  const action = toastAction;
  hideToast();
  if (action) action();
});
// A note from a terminal, such as a link that couldn't be opened (term.js).
window.addEventListener('station:notice', (event) => toast(String(event.detail || '')));
// Resting on it keeps it, so there's time to press Undo.
toastEl.addEventListener('pointerenter', () => clearTimeout(toastTimer));
toastEl.addEventListener('pointerleave', () => { toastTimer = setTimeout(hideToast, 2500); });

/* ---------- Undo (Ctrl+Z) ---------- */

const undoStack = [];
function remember(action) {
  undoStack.push(action);
  if (undoStack.length > 30) undoStack.shift();
}

async function undoAction(action) {
  const index = undoStack.indexOf(action);
  if (index >= 0) undoStack.splice(index, 1);
  let failures = null;
  let count = 1;
  if (action.type === 'move' || action.type === 'rename') {
    count = action.pairs.length;
    failures = await attempt(() => call('moveBack', action.pairs));
  } else if (action.type === 'trash') {
    count = action.trashed.length;
    failures = await attempt(() => call('restore', action.trashed));
  } else if (action.type === 'copy' || action.type === 'create') {
    count = action.paths.length;
    failures = (await attempt(() => call('trashItems', action.paths)))?.failures;
  }
  if (!failures) return;
  await reportFailures(failures, count);
  if (failures.length < count) toast(`Undid the ${action.label}`);
  loadFolder();
}

function undoLast() {
  const action = undoStack[undoStack.length - 1];
  if (action) undoAction(action);
  else toast('There\'s nothing to undo.');
}

/* ---------- Renaming in place ---------- */

// The name turns into a box you can type in, as in File Explorer. Enter or clicking away keeps it, Esc doesn't.
function renameInPlace(target) {
  if (inTrash() || renaming) return;
  const node = [...rowsEl.children].find((child) => child.dataset.path === target);
  const label = node?.querySelector('.name-text, .tile-name');
  if (!label) return;
  node.scrollIntoView({ block: 'nearest' });
  const entry = state.entries.find((item) => item.path === target);
  const input = el('input', 'rename-input');
  input.value = entry.name;
  input.spellcheck = false;
  label.hidden = true;
  label.after(input);
  input.focus();
  // Only the part before the extension is picked, so typing keeps ".txt".
  const dot = entry.isDir ? -1 : entry.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  renaming = { target };
  let finished = false;
  const finish = async (keep) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    const wasPending = renaming.pending;
    renaming = null;
    input.remove();
    label.hidden = false;
    rowsEl.focus();
    if (keep && name && name !== entry.name) {
      const next = await attempt(() => call('rename', target, name));
      if (next) {
        remember({ type: 'rename', label: 'rename', pairs: [{ from: target, to: next }] });
        setSelection([next], next);
      }
      loadFolder();
    } else if (wasPending) {
      renderEntries();
    }
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  ['pointerdown', 'click', 'dblclick'].forEach((type) => input.addEventListener(type, (event) => event.stopPropagation()));
}

/* ---------- Properties (Alt+Enter) ---------- */

const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

function exactSize(bytes) {
  return bytes < 1024 ? plural(bytes, 'byte') : `${formatSize(bytes)} (${bytes.toLocaleString()} bytes)`;
}

async function showProperties(paths) {
  if (!paths.length) return;
  const single = paths.length === 1 ? state.entries.find((entry) => entry.path === paths[0]) : null;
  const title = single ? shownName(single) : paths.length === 1 ? baseName(paths[0]) : plural(paths.length, 'item');
  let fill = null;
  const shown = showDialog((host, done) => {
    host.classList.add('properties');
    dialogFrame(host, `${title} Properties`);
    const table = el('div', 'props');
    const line = (label, value) => {
      table.append(el('div', 'props-label', label), el('div', 'props-value', value));
    };
    host.append(table);
    line('Size', 'Counting…');
    fill = (info) => {
      table.replaceChildren();
      if (info.single) {
        const kind = single ? kindOf(single) : info.single.isDir ? 'File folder' : 'File';
        line('Type', info.single.linkTo ? `Shortcut (link) to ${info.single.linkTo}` : kind);
        line('Location', windowsPath(info.single.location));
      }
      line('Size', exactSize(info.bytes));
      if (info.folders || info.files > 1 || info.single?.isDir) line('Contains', `${plural(info.files, 'file')}, ${plural(info.folders, 'folder')}`);
      if (info.single) {
        line('Created', formatDate(info.single.created));
        line('Modified', formatDate(info.single.modified));
        line('Opened', formatDate(info.single.accessed));
        line('Read-only', info.single.mode & 0o200 && !inWindowsDrive(paths[0]) ? 'No' : 'Yes');
      }
    };
    dialogButtons(host, [{ label: 'OK', primary: true, onClick: () => done() }]);
  });
  const info = await call('properties', paths).catch((error) => ({ error }));
  if (!dialog.open || !fill) return shown;
  if (info.error) {
    dialog.querySelector('.props').replaceChildren(el('div', 'props-value', cleanError(info.error)));
  } else {
    fill(info);
  }
  return shown;
}

// Copy as path, as in File Explorer: in quotes, the way Windows writes it, so it works in Windows apps.
function copyAsPath(paths) {
  if (!paths.length) return;
  call('clipboardWrite', paths.map((target) => `"${windowsPath(target)}"`).join('\r\n'));
  toast(paths.length === 1 ? 'Path copied.' : `${paths.length} paths copied.`);
}

/* ---------- Moving around the list with the keyboard ---------- */

// How many items sit side by side, and how many fit on one screen, in the current view.
function layoutOf(nodes) {
  if (!nodes.length) return { across: 1, down: 1, columnFlow: false };
  const columnFlow = state.viewMode === 'list';
  const first = nodes[0];
  let along = 0;
  for (const node of nodes) {
    if ((columnFlow ? node.offsetLeft : node.offsetTop) !== (columnFlow ? first.offsetLeft : first.offsetTop)) break;
    along += 1;
  }
  const height = first.offsetHeight || 30;
  return { across: columnFlow ? 1 : along, perColumn: columnFlow ? along : 1, columnFlow, page: Math.max(1, Math.floor(rowsEl.clientHeight / height)) };
}

function moveFocus(key, event) {
  const nodes = [...rowsEl.children].filter((node) => node.dataset.path);
  if (!nodes.length) return false;
  const paths = nodes.map((node) => node.dataset.path);
  let index = paths.indexOf(state.focus);
  const { across, perColumn, columnFlow, page } = layoutOf(nodes);
  const grid = state.viewMode !== 'details' && state.viewMode !== 'content';
  let next = index;
  if (index < 0) next = 0;
  else if (key === 'ArrowDown') next = index + (columnFlow ? 1 : across);
  else if (key === 'ArrowUp') next = index - (columnFlow ? 1 : across);
  else if (key === 'ArrowRight' && (grid || columnFlow)) next = index + (columnFlow ? perColumn : 1);
  else if (key === 'ArrowLeft' && (grid || columnFlow)) next = index - (columnFlow ? perColumn : 1);
  else if (key === 'Home') next = 0;
  else if (key === 'End') next = nodes.length - 1;
  else if (key === 'PageDown') next = index + page * across;
  else if (key === 'PageUp') next = index - page * across;
  else return false;
  index = Math.max(0, Math.min(nodes.length - 1, next));
  const target = paths[index];
  rowsEl.classList.add('keyboard');
  if (event.shiftKey) {
    if (!state.anchor || !paths.includes(state.anchor)) state.anchor = state.focus || target;
    state.selected = new Set(rangeTo(target));
    state.focus = target;
  } else if (event.ctrlKey) {
    state.focus = target; // Ctrl moves without picking; Ctrl+Space picks
  } else {
    state.selected = new Set([target]);
    state.anchor = target;
    state.focus = target;
  }
  updateSelection();
  nodes[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

// Typing a name jumps to it. Typing the same first letter again moves on to the next one.
let typed = '';
let typedAt = 0;
function typeToFind(character) {
  const now = Date.now();
  typed = now - typedAt > 1000 ? character : typed + character;
  typedAt = now;
  const entries = visibleEntries();
  const start = Math.max(0, entries.findIndex((entry) => entry.path === state.focus));
  const repeat = typed.length > 1 && [...typed].every((letter) => letter === typed[0]);
  const wanted = (repeat ? typed[0] : typed).toLowerCase();
  const order = [...entries.slice(start + (typed.length === 1 || repeat ? 1 : 0)), ...entries.slice(0, start + 1)];
  const found = order.find((entry) => shownName(entry).toLowerCase().startsWith(wanted));
  if (!found) return;
  setSelection([found.path], found.path);
  rowsEl.classList.add('keyboard');
  [...rowsEl.children].find((node) => node.dataset.path === found.path)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

rowsEl.addEventListener('contextmenu', (event) => {
  if (state.active.kind !== 'files') return; // the page-wide menu answers
  event.preventDefault();
  const openMenu = (x, y, items) => rightClickMenu(x, y, fileActions(visibleEntries().length ? selectAll : null), items); // the four first
  if (inTrash()) {
    openMenu(event.clientX, event.clientY, [
      { label: 'Empty Trash', icon: 'delete', disabled: !state.entries.length, run: emptyTrash },
      { label: 'Refresh', icon: 'arrow_clockwise', run: refreshNow },
    ]);
    return;
  }
  if (onWindows()) {
    openMenu(event.clientX, event.clientY, [
      { label: 'Invert Selection', icon: 'select_all_off', disabled: !visibleEntries().length, run: invertSelection },
      { label: 'Refresh', icon: 'arrow_clockwise', run: refreshNow },
      '-',
      { label: 'Copy as Path', icon: 'link', run: () => copyAsPath([state.active.path]) },
      { label: 'Properties', icon: 'info', run: () => showProperties([state.active.path]) },
    ]);
    return;
  }
  const lastUndo = undoStack[undoStack.length - 1];
  // Inside a project: its site, one click away.
  const project = projectOf(state.active.path);
  openMenu(event.clientX, event.clientY, [
    ...newItems(),
    '-',
    ...(project ? [{ label: previewLabel(project), icon: 'open', tint: 'tint-blue', run: () => previewProject(project) }, '-'] : []),
    { label: lastUndo ? `Undo ${lastUndo.label[0].toUpperCase()}${lastUndo.label.slice(1)}` : 'Undo', icon: 'arrow_undo', disabled: !lastUndo, run: undoLast },
    '-',
    { label: 'Invert Selection', icon: 'select_all_off', disabled: !visibleEntries().length, run: invertSelection },
    { label: 'Refresh', icon: 'arrow_clockwise', run: refreshNow },
    '-',
    { label: 'Copy as Path', icon: 'link', run: () => copyAsPath([state.active.path]) },
    { label: 'Properties', icon: 'info', run: () => showProperties([state.active.path]) },
  ]);
});

function selectAll() {
  const paths = visibleEntries().map((entry) => entry.path);
  state.selected = new Set(paths);
  if (!paths.includes(state.focus)) state.focus = paths[0] || null;
  updateSelection();
}

function invertSelection() {
  state.selected = new Set(visibleEntries().map((entry) => entry.path).filter((target) => !state.selected.has(target)));
  updateSelection();
}

/* ---------- File actions ---------- */

/* Two clipboards, as one: things copied in here, and files copied in Windows File Explorer.
   Whichever was copied last is what Paste uses, as in Explorer. Files from Windows can only be
   pasted while the Windows door is unlocked. A picture copied in Windows, such as a screen snip,
   pastes as a new picture file, locked or not, the way copied text pastes anywhere. */
const canPaste = () => Boolean(state.clipboard) || (state.windowsFiles > 0 && state.status.doorOpen) || state.windowsPicture;

function toClipboard(move) {
  if (move && inTrash()) return;
  if (move && [...state.selected].some(inWindowsDrive)) {
    toast(READ_ONLY);
    return;
  }
  state.clipboard = { paths: [...state.selected], move };
  state.windowsFiles = 0; // copied here after Windows, so this is what Paste uses now
  state.windowsPicture = false;
  // Also on Windows' clipboard, so File Explorer can paste them (lib/clipboard.js). If Windows
  // isn't linked, that's said once; pasting here works either way.
  call('clipboardFiles', state.clipboard.paths, move).then((reply) => {
    if (reply?.ok || toldNotLinked) return;
    toldNotLinked = true;
    // No answer at all: the helper isn't running. An answer with a problem: Windows said no.
    toast(reply ? 'Copied here. Windows couldn\'t take it, so File Explorer can\'t paste it.' : 'Copied. File Explorer can\'t paste it until the Windows helper is back.');
  }).catch(() => {});
  renderEntries();
}
let toldNotLinked = false;

// Files copied in Windows. The helper only says how many; the house asks for them when you paste.
// "ours" is the house's own copy coming back from Windows: no files from Windows, and what was
// copied in here stays.
function windowsClipboardChanged(count, ours = false, picture = false) {
  const had = state.windowsFiles;
  state.windowsFiles = ours ? 0 : count;
  state.windowsPicture = !ours && picture;
  // Newer than anything copied in here.
  if (!ours && ((count > 0 && count !== had) || picture)) state.clipboard = null;
  if (state.active?.kind === 'files') renderEntries();
}

// Paste, or a short note saying why it can't: locked, nothing copied, or in the Trash.
function pasteOrSay() {
  if (state.active?.kind !== 'files') return;
  if (inTrash()) toast('Things can\'t be pasted into the Trash.');
  else if (onWindows()) toast(READ_ONLY);
  else if (!state.clipboard && state.windowsFiles > 0 && !state.status.doorOpen) lockedNote();
  else if (!canPaste()) toast('Nothing is copied yet.');
  else pasteHere();
}

const lockedNote = () => toast('Windows access is locked. Unlock it to bring files in.', 'Unlock', toggleDoor);

async function pasteFromWindows() {
  if (!state.status.doorOpen) {
    lockedNote();
    return;
  }
  const dir = state.active.path;
  await copyFromWindows(state.windowsFiles, dir, () => call('pasteFromWindows', dir));
}

// The picture becomes "Pasted image <date> <time>.png" here, picked so you can see it. Undo puts
// it in the Trash.
async function pastePicture() {
  const made = await attempt(() => call('pastePicture', state.active.path));
  if (!made) return;
  const undo = { type: 'copy', label: 'paste', paths: [made] };
  remember(undo);
  state.search = '';
  $('search').value = '';
  setSelection([made], made);
  await loadFolder();
  toast('Picture pasted.', 'Undo', () => undoAction(undo));
}

async function pasteHere() {
  if (inTrash() || state.active?.kind !== 'files') return;
  if (onWindows()) {
    toast(READ_ONLY);
    return;
  }
  if (!state.clipboard) {
    if (state.windowsFiles > 0) await pasteFromWindows();
    else if (state.windowsPicture) await pastePicture();
    return;
  }
  const { paths, move } = state.clipboard;
  const dir = state.active.path;
  if (move) {
    const result = await attempt(() => call('transfer', paths, dir, true));
    if (!result) return;
    // After a failed move, only what's still left to move stays cut, so you can try again.
    state.clipboard = result.failures.length ? { paths: result.failures.map((failure) => failure.path), move } : null;
    if (result.done.length) remember({ type: 'move', label: 'move', pairs: result.done });
    state.selected = new Set(result.done.map((pair) => pair.to));
    await reportFailures(result.failures, paths.length);
    loadFolder();
    return;
  }
  // A copy can take a while, so it shows how far along it is, like a copy from Windows.
  let copies = [];
  await runJob({
    verb: 'Copying', count: paths.length, dir, icon: 'copy', quietMs: 400,
    run: async () => {
      const result = await call('transfer', paths, dir, false);
      copies = result.done.map((pair) => pair.to);
      if (copies.length) remember({ type: 'copy', label: 'copy', paths: copies });
      return result.failures;
    },
  });
  if (copies.length && state.active?.path === dir) setSelection(copies, copies[0]);
}

// Delete, as in File Explorer: straight to the Trash, with Undo. Nothing is gone for good until the
// Trash is emptied.
async function trashPaths(paths) {
  if (paths.some(inWindowsDrive)) {
    toast(READ_ONLY);
    return;
  }
  const result = await attempt(() => call('trashItems', paths));
  if (!result) return;
  if (result.trashed.length) {
    const undo = { type: 'trash', label: 'delete', trashed: result.trashed };
    remember(undo);
    const what = result.trashed.length === 1 ? `"${entryName(paths.find((target) => !result.failures.some((failure) => failure.path === target)))}"` : `${result.trashed.length} items`;
    toast(`Moved ${what} to the Trash`, 'Undo', () => undoAction(undo));
  }
  state.selected = new Set();
  await reportFailures(result.failures, paths.length);
  loadFolder();
}

async function restoreSelected() {
  const paths = [...state.selected];
  if (!paths.length) return;
  const failures = await attempt(() => call('restore', paths));
  await reportFailures(failures, paths.length);
  state.selected = new Set();
  loadFolder();
}

async function emptyTrash() {
  const count = state.entries.length;
  if (!count) return;
  const yes = await confirmBox('Empty Trash?', `Delete ${count === 1 ? 'the item' : `all ${plural(count, 'item')}`} in the Trash for good?\nThis can't be undone.`, 'Delete Forever', true);
  if (!yes) return;
  state.selected = new Set();
  await runJob({ verb: 'Deleting', count, dir: state.trash, icon: 'delete', quietMs: 400, run: () => call('emptyTrash') });
}

function renameSelected() {
  if (state.selected.size !== 1 || inTrash()) return;
  const [target] = state.selected;
  if (inWindowsDrive(target)) {
    toast(READ_ONLY);
    return;
  }
  renameInPlace(target);
}

// Delete moves things to the Trash. In the Trash, or with Shift+Delete, they're gone for good, so it asks first.
async function deleteSelected(forever) {
  const paths = [...state.selected];
  if (!paths.length) return;
  if (paths.some(inWindowsDrive)) {
    toast(READ_ONLY);
    return;
  }
  const permanent = inTrash() || forever === true;
  if (!permanent) {
    await trashPaths(paths);
    return;
  }
  const what = paths.length === 1 ? `"${shortName(entryName(paths[0]))}"` : plural(paths.length, 'item');
  const yes = await confirmBox('Delete Forever?', `Delete ${what} for good?\nIt skips the Trash, and this can't be undone.`, 'Delete Forever', true);
  if (!yes) return;
  state.selected = new Set();
  const fromTrash = inTrash();
  await runJob({ verb: 'Deleting', count: paths.length, dir: state.active.path, icon: 'delete', quietMs: 400, run: () => call(fromTrash ? 'destroy' : 'removeForever', paths) });
}

// A new folder appears with its name ready to type over, as in File Explorer.
async function newFolder() {
  if (inTrash() || state.active?.kind !== 'files') return;
  if (onWindows()) {
    toast(READ_ONLY);
    return;
  }
  const made = await attempt(() => call('makeFolder', state.active.path, 'New folder', true));
  if (made) await nameNewItem(made);
}

async function newTextFile() {
  if (inTrash() || state.active?.kind !== 'files') return;
  if (onWindows()) {
    toast(READ_ONLY);
    return;
  }
  const made = await attempt(() => call('makeFile', state.active.path, 'New Text Document.txt'));
  if (made) await nameNewItem(made);
}

async function nameNewItem(made) {
  remember({ type: 'create', label: 'new item', paths: [made] });
  state.search = '';
  $('search').value = '';
  setSelection([made], made);
  await loadFolder();
  renameInPlace(made);
}

async function newProject() {
  const name = await promptBox('New Project', 'Use letters, numbers, spaces, - and _.\nIts room opens right after.', '', 'Create and Open');
  if (!name) return;
  const made = await attempt(async () => {
    await call('newProject', name);
    return true;
  });
  if (!made) return;
  await refreshStatus();
  await openTerminal({ room: name });
}

function newItems() {
  const items = [{ label: 'Project', icon: 'briefcase', run: newProject }, { label: 'From GitHub', icon: 'arrow_download-filled', run: () => ghUi.openForm() }];
  if (state.active.kind === 'files' && !inTrash() && !atHome() && !onWindows()) {
    items.push({ label: 'Folder', icon: 'folder_add', run: newFolder });
    items.push({ label: 'Text Document', icon: 'document_add', run: newTextFile });
  }
  items.push({ label: 'Agents', icon: 'grid', run: () => openAgents() });
  items.push({ label: 'Local AI', icon: 'bot', run: () => openLlama() });
  items.push({ label: 'Schedules', icon: 'calendar_ltr', run: () => openSchedules() });
  items.push({ label: 'Web Browser', icon: 'link', run: () => openObscura() });
  items.push({ label: 'API Keys', icon: 'key', run: () => openKeys() }); // keys.js
  items.push({ label: 'House Terminal', icon: 'window_console', run: () => openTerminal({ cwd: state.active.kind === 'files' && !atHome() && !onWindows() ? state.active.path : state.home }) });
  return items;
}

// Each terminal in a project is one of its rooms (New Room opens another). This closes them all:
// the project's whole room stops.
async function closeRoom(name) {
  const yes = await confirmBox(
    'Close All Rooms?',
    `Every room in "${shortName(name, 20)}" stops.\nYour project files stay. Extra tools are removed.`,
    'Close All Rooms',
    true,
  );
  if (!yes) return;
  await closeWholeRoom(name);
}

async function closeWholeRoom(name) {
  const closed = await attempt(async () => {
    await call('closeRoom', name);
    return true;
  });
  if (closed) closeRoomTabs(name);
  await refreshStatus();
}

function isRoomTerminal(tab) {
  return Boolean(tab && tab.kind === 'term' && tab.room && tab.tab);
}

// Close Room on one terminal ends just that one. Only when it's the last one in its project does
// the whole room close as well, so a room is never left open with nothing in it.
async function closeOneRoom(tab) {
  if (!isRoomTerminal(tab)) return;
  await closeRoomTerminal(tab.room, tab.tab, tab);
}

// The same, from the Agents page or a Home card: the terminal may be a tab here, in another
// window, or running with no tab at all.
async function closeRoomTerminal(name, tabName, tab = null) {
  const others = await call('termOthers', name, tabName).catch(() => null);
  let message = 'Its AI and anything running in it stop.\nAny other rooms you have open keep going.';
  if (others === 0) message = 'It\'s the last one, so the whole room closes.\nYour project files stay. Extra tools are removed.';
  else if (others === 1) message = 'Its AI and anything running in it stop.\nYour other room keeps going.';
  else if (others > 1) message = `Its AI and anything running in it stop.\nYour other ${others} rooms keep going.`;
  if (!await confirmBox('Close Room?', message, 'Close Room', true)) return;
  if (others === 0) {
    await closeWholeRoom(name);
    return;
  }
  const here = tab || state.tabs.find((other) => other.kind === 'term' && other.room === name && other.tab === tabName);
  if (here && (here.ended || !here.termId)) call('termStopTab', name, tabName);
  else if (here) call('termKill', here.termId);
  else call('termEndRoomTab', name, tabName);
  if (here) removeTab(here);
  await refreshStatus();
  if (state.active?.kind === 'agents') watchAgents();
}

// A room's terminals, each with Close Room, for a Home card's menus. Empty if the room can't say.
async function roomCloseItems(name) {
  const tabs = await call('roomTerminals', name).catch(() => null);
  return (tabs || []).map((tab) => {
    const summary = tabSummary(tab.panes);
    const what = summary.agent ? `${agentName(summary.agent)}, ${summary.label}` : 'No AI';
    return { label: `Close Room ${tab.tab.slice(4)} · ${what}`, icon: 'dismiss', tint: 'tint-red', run: () => closeRoomTerminal(name, tab.tab) };
  });
}

// A closed room's terminals have nothing left to connect to, so their tabs go with it.
function closeRoomTabs(name) {
  const tabs = state.tabs.filter((tab) => tab.kind === 'term' && tab.room === name);
  const wasShowing = tabs.includes(state.active);
  tabs.forEach((tab) => {
    call('termKill', tab.termId);
    removeTab(tab);
  });
  if (wasShowing) showRoomFiles(name);
}

/* ---------- Preview overlay ---------- */

const preview = $('preview');
let previewEntry = null;

// force: close even while a picture is being edited (picture-editor.js asks first otherwise).
function closePreview(force) {
  if (force !== true && pe) {
    leavePictureEdit(true);
    return;
  }
  stopPictureEdit();
  preview.hidden = true;
  preview.replaceChildren();
  previewEntry = null;
}

closeOnClickOff(preview, (event) => event.target.classList.contains('preview-body'), closePreview);

async function showPreview(entry) {
  previewEntry = entry;
  preview.replaceChildren();
  preview.hidden = false;

  const bar = el('div', 'preview-bar');
  bar.append(el('span', 'preview-name', entry.name), el('span', 'preview-meta', `${formatSize(entry.size)}   ${formatDate(entry.mtime)}`));
  const close = el('button', 'tool preview-close');
  close.title = 'Close (Esc)';
  close.append(icon('dismiss'));
  close.addEventListener('click', closePreview);
  if (pictureEditable(entry)) bar.append(pictureEditButton(entry)); // picture-editor.js
  else if (opensAsVideo(entry)) bar.append(videoEditButton(entry)); // video-tab.js
  else if (songEditable(entry)) bar.append(songInfoButton(entry)); // music-info.js
  bar.append(close);

  const body = el('div', 'preview-body');
  preview.append(bar, body);

  if (ANY_PICTURE.test(entry.name)) {
    // Kinds the page can't show itself (TIFF, HEIC, PSD...) are made into one it can (lib/thumbs.js).
    const image = el('img', 'preview-media');
    image.addEventListener('error', () => image.replaceWith(el('div', 'preview-message', 'This picture couldn\'t be opened.'), windowsButtons(entry)), { once: true });
    image.src = IMAGE.test(entry.name) ? fileUrl(entry.path) : `${fileUrl(entry.path)}?view&v=${Math.round(entry.mtime || 0)}-${entry.size ?? ''}`;
    body.append(image);
  } else if (PDF.test(entry.name)) {
    // Chromium's own PDF viewer (pages, zoom, search, print). Windows' app stays one click away.
    const open = el('button', 'btn', 'Open in Windows App');
    open.addEventListener('click', () => openInWindows(entry, false));
    bar.insertBefore(open, close);
    const frame = el('iframe', 'preview-pdf');
    frame.title = entry.name;
    frame.src = fileUrl(entry.path);
    body.append(frame);
  } else if (VIDEO.test(entry.name)) {
    const video = el('video', 'preview-media');
    video.src = fileUrl(entry.path);
    video.controls = true;
    video.autoplay = true;
    body.append(video);
  } else if (ANY_VIDEO.test(entry.name)) {
    // Kinds the page can't play by itself (AVI, WMV...) play in the video's own page, made ready first.
    const poster = el('img', 'preview-media');
    poster.addEventListener('error', () => poster.remove(), { once: true });
    poster.src = thumbUrl(entry);
    const row = windowsButtons(entry);
    row.querySelector('.primary')?.classList.remove('primary');
    const play = el('button', 'btn primary', 'Play Here');
    play.addEventListener('click', () => {
      closePreview(true);
      openVideo(entry.path);
    });
    row.prepend(play);
    body.append(poster, row);
  } else if (isArchive(entry)) {
    let result = null;
    try {
      result = await call('archiveList', entry.path);
    } catch (error) {
      body.append(el('div', 'preview-message', cleanError(error)));
      return;
    }
    if (previewEntry !== entry) return;
    body.append(archiveView(entry, result));
  } else if (/\.docx$/i.test(entry.name)) {
    let result = null;
    try {
      result = await call('docxRead', entry.path);
    } catch (error) {
      body.append(el('div', 'preview-message', cleanError(error)), windowsButtons(entry));
      return;
    }
    if (previewEntry !== entry) return;
    body.append(docxView(entry, result), windowsButtons(entry)); // docx-view.js
  } else if (AUDIO.test(entry.name)) {
    const audio = el('audio');
    audio.src = fileUrl(entry.path);
    audio.controls = true;
    audio.autoplay = true;
    body.append(audio);
  } else {
    let result = null;
    try {
      result = await call('readText', entry.path);
    } catch (error) {
      body.append(el('div', 'preview-message', cleanError(error)));
      return;
    }
    if (previewEntry !== entry) return;
    if (result.binary) {
      body.append(el('div', 'preview-message', 'Station 256 can\'t show this kind of file yet.'), windowsButtons(entry));
    } else {
      body.append(el('pre', 'preview-text', result.text));
      if (result.truncated) body.append(el('div', 'preview-note', 'Showing the first 256 KB.'));
      if (!shownHere(entry)) body.append(windowsButtons(entry)); // shown as text, but it may be meant for an app
    }
  }
}

preview.addEventListener('click', (event) => {
  if (event.target === preview) closePreview();
});

/* ---------- Zip files, built in, and Windows apps as the last resort ---------- */

const ARCHIVE = /\.(zip|tar|tgz|txz|tbz2?|gz|xz|bz2)$/i;
const TEXTISH = /\.(txt|md|markdown|json|jsonc|jsonl|ya?ml|toml|ini|cfg|conf|env|log|csv|tsv|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|bat|cmd|sql|lua|pl|r|swift|dart|gradle|lock|gitignore|dockerignore|editorconfig|srt|vtt|diff|patch)$/i;
const isArchive = (entry) => !entry.isDir && ARCHIVE.test(entry.name);
// Kinds the panel shows itself. Files with no ending are usually text, so they count too.
const shownHere = (entry) => ANY_PICTURE.test(entry.name) || PDF.test(entry.name) || VIDEO.test(entry.name) || AUDIO.test(entry.name)
  || isArchive(entry) || /\.docx$/i.test(entry.name) || TEXTISH.test(entry.name) || !/\.[^./]+$/.test(entry.name);

async function openInWindows(entry, pick) {
  await attempt(() => call('openInWindows', entry.path, pick));
}

function windowsButtons(entry) {
  const row = el('div', 'preview-actions');
  const open = el('button', 'btn primary', 'Open in Windows App');
  open.addEventListener('click', () => openInWindows(entry, false));
  const pick = el('button', 'btn', 'Open With…');
  pick.addEventListener('click', () => openInWindows(entry, true));
  row.append(open, pick);
  return row;
}

// One zip of everything picked, beside it, with its name ready to type over.
async function compressSelected() {
  const paths = [...state.selected];
  if (!paths.length || inTrash() || state.active?.kind !== 'files') return;
  let made = null;
  await runJob({
    verb: 'Zipping', count: paths.length, dir: state.active.path, icon: 'folder_zip', quietMs: 400,
    run: async () => { made = (await call('compress', paths)).made; return []; },
  });
  if (made) await nameNewItem(made);
}

// "all": into a new folder named after it. "here": loose, if it only holds one thing.
async function extractArchive(entry, mode) {
  if (inTrash() || state.active?.kind !== 'files') return;
  closePreview();
  let made = [];
  await runJob({
    verb: 'Unzipping', count: 1, dir: state.active.path, icon: 'archive', quietMs: 400,
    run: async () => { made = (await call('extract', entry.path, mode)).made || []; return []; },
  });
  if (!made.length) return;
  remember({ type: 'create', label: 'unzip', paths: made });
  setSelection(made, made[0]);
  await loadFolder();
  rowsEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}

function archiveView(entry, { entries, count }) {
  const box = el('div', 'archive-view');
  const files = entries.filter((item) => !item.dir);
  const total = files.reduce((sum, item) => sum + (item.size || 0), 0);
  const head = el('div', 'archive-head');
  head.append(el('span', 'archive-sum', `${plural(files.length, 'file')} inside · ${formatSize(total)} unpacked`));
  if (!inTrash()) {
    const all = el('button', 'btn primary', 'Extract All');
    all.addEventListener('click', () => extractArchive(entry, 'all'));
    const here = el('button', 'btn', 'Extract Here');
    here.addEventListener('click', () => extractArchive(entry, 'here'));
    head.append(all, here);
  }
  const list = el('div', 'archive-list');
  // As a tree: each folder's folders first, then its files, A to Z.
  const partsOf = (item) => item.name.split('/').filter((part) => part && part !== '.');
  const keyOf = (item) => partsOf(item).map((part, i, all) => `${i < all.length - 1 || item.dir ? 0 : 1}${part.toLowerCase()}`);
  const tree = entries.filter((item) => partsOf(item).length).sort((a, b) => {
    const x = keyOf(a);
    const y = keyOf(b);
    for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return x.length - y.length;
  });
  for (const item of tree) {
    const parts = partsOf(item);
    const line = el('div', 'archive-line');
    line.style.paddingLeft = `${10 + (parts.length - 1) * 18}px`;
    line.append(icon(item.dir ? 'folder_open' : 'document'), el('span', 'archive-name', parts[parts.length - 1]), el('span', 'archive-size', item.dir ? '' : formatSize(item.size)));
    list.append(line);
  }
  if (count > entries.length) list.append(el('div', 'archive-line archive-more', `…and ${count - entries.length} more`));
  box.append(head, list);
  return box;
}

function previewStep(direction) {
  const files = visibleEntries().filter((entry) => !entry.isDir);
  const index = files.findIndex((entry) => entry.path === previewEntry?.path);
  const next = files[index + direction];
  if (next) {
    state.selected = new Set([next.path]);
    renderEntries();
    showPreview(next);
  }
}

/* ---------- Home ---------- */

// File Explorer's Home, made for working with AI: a few fun numbers, every project with its room,
// and recent files. The sidebar already has the folders, so they aren't repeated here.
const homeView = $('home-view');
let homeData = null; // the last numbers, so the page shows at once while new ones are read
let homeAsked = 0;

function showHome(on) {
  homeView.hidden = !on;
  window.ghUi?.homeShown(on);
  $('columns').hidden = on;
  rowsEl.hidden = on;
}

async function renderHome() {
  drawHome();
  const asked = ++homeAsked;
  const data = await call('homeStats').catch(() => null);
  if (asked !== homeAsked) return;
  if (data) homeData = data;
  if (atHome()) drawHome();
  // Tokens take longest to count, so they come on their own.
  const tokens = await call('homeTokens').catch(() => null);
  if (asked !== homeAsked || !tokens || !homeData) return;
  homeData.tokens = tokens;
  if (atHome()) drawHome();
}

// 166356193 -> "166.4M", 285310 -> "285K".
function bigNumber(value) {
  const n = Number(value) || 0;
  const short = (amount, unit) => `${amount >= 100 ? Math.round(amount) : amount.toFixed(1).replace(/\.0$/, '')}${unit}`;
  if (n >= 1e9) return short(n / 1e9, 'B');
  if (n >= 1e6) return short(n / 1e6, 'M');
  if (n >= 1e3) return short(n / 1e3, 'K');
  return String(Math.round(n));
}

function homeTile(iconName, tint, label, value, note, tip) {
  const tile = el('div', 'home-tile');
  if (tip) tile.title = tip;
  const head = el('div', 'home-tile-head');
  head.append(icon(iconName, tint), el('span', 'home-tile-label', label));
  const shown = el('div', 'home-tile-value');
  shown.append(value);
  tile.append(head, shown, el('div', 'home-tile-note', note));
  return tile;
}

function homeTiles(data) {
  const tiles = el('div', 'home-tiles');
  if (!data) {
    tiles.append(
      homeTile('fire-filled', 'tint-orange', 'Day Streak', '…', 'Counting'),
      homeTile('arrow_trending_down-filled', 'tint-blue', 'Today\'s Input Tokens', '…', 'Counting'),
      homeTile('arrow_trending-filled', 'tint-blue', 'Today\'s Output Tokens', '…', 'Counting'),
      homeTile('document_edit-filled', 'tint-blue', 'Files AI Created/Modified', '…', 'Counting'),
    );
    return tiles;
  }
  const { streak, files, tokens } = data;
  const streakNote = streak.today ? 'AI worked today. Keep it going!' : streak.days ? 'Work with AI today to keep it.' : 'Work with AI to start one.';
  // Two colors only: the streak's fire is orange, everything else is the app's blue.
  tiles.append(
    homeTile('fire-filled', 'tint-orange', 'Day Streak', `${streak.days.toLocaleString()} ${streak.days === 1 ? 'Day' : 'Days'}`, streakNote, 'Days in a row that AI worked in your projects.'),
    homeTile('arrow_trending_down-filled', 'tint-blue', 'Today\'s Input Tokens', bigNumber(tokens.todayIn), `This week: ${bigNumber(tokens.weekIn)}`,
      `What AI read today, since midnight.\nAll time, every conversation: ${bigNumber(tokens.allIn)}`),
    homeTile('arrow_trending-filled', 'tint-blue', 'Today\'s Output Tokens', bigNumber(tokens.todayOut), `This week: ${bigNumber(tokens.weekOut)}`,
      `What AI wrote today, since midnight.\nAll time, every conversation: ${bigNumber(tokens.allOut)}`),
    homeTile('document_edit-filled', 'tint-blue', 'Files AI Created/Modified', files.today.toLocaleString(),
      files.busiest ? `Most in ${shortName(files.busiest.name, 24)} (${files.busiest.count.toLocaleString()})` : 'None yet today',
      'Files AI created or modified in your projects today.\nBuild and hidden files are left out.'),
  );
  return tiles;
}

async function projectMenu(project, x, y) {
  const up = roomIsUp(project.name);
  const items = [
    { label: 'Open', icon: 'folder_open', run: () => navigate(project.path) },
    { label: 'Open in New Tab', icon: 'tab_add', run: () => openFilesTab(project.path) },
    { label: up ? 'Enter Room' : 'Open Room', icon: 'play', tint: 'tint-green', run: () => enterRoom(project.name) },
    { label: previewLabel(project.name), icon: 'open', tint: 'tint-blue', run: () => previewProject(project.name) },
  ];
  if (up) {
    items.push({ label: 'New Room', icon: 'window_console', tint: 'tint-blue', run: () => openTerminal({ room: project.name }) });
    items.push('-', ...await roomCloseItems(project.name));
    items.push({ label: 'Close All Rooms', icon: 'checkbox_unchecked', tint: 'tint-red', run: () => closeRoom(project.name) });
  }
  items.push(...(window.ghUi?.menuItems(project) || []));
  items.push('-', { label: 'Copy as Path', icon: 'link', run: () => copyAsPath([project.path]) });
  rightClickMenu(x, y, textActions(null), items);
}

// The arrow beside an open room's Enter Room: its rooms, to close one, or all of them.
async function roomsMenu(project, button) {
  const items = [
    { label: 'New Room', icon: 'window_console', tint: 'tint-blue', run: () => openTerminal({ room: project.name }) },
    '-',
    ...await roomCloseItems(project.name),
    { label: 'Close All Rooms', icon: 'checkbox_unchecked', tint: 'tint-red', run: () => closeRoom(project.name) },
  ];
  menuUnder(button, items);
}

// Short enough for a card's corner: "just now", "5 min ago", "2 h ago", "3 d ago", then "Nov 7".
// Never a full date before 30 days (23 h 40 min rounds to "1 d ago", not to a date).
function cardAgo(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.max(1, Math.round(hours / 24));
  return days < 30 ? `${days} d ago` : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function projectCard(project) {
  const up = roomIsUp(project.name);
  const card = el('div', `home-card${up ? ' up' : ''}`);
  card.tabIndex = 0;
  card.dataset.project = project.name;
  const last = project.lastEdit;
  const changed = last ? last.time : project.mtime;
  const top = el('div', 'home-card-top');
  top.append(fileIcon({ isDir: true, name: project.name, path: project.path }), el('span', 'home-card-name', project.name));
  // Top right: an open room's green light (its button says Enter Room), or else when it last changed.
  if (up) {
    const light = el('span', 'light');
    light.title = 'Room open';
    top.append(light);
  } else if (changed) {
    top.append(el('span', 'home-card-time', cardAgo(changed)));
  }
  const note = last ? modelName(last.model, last.tool) : 'No recent AI changes';
  // A room that's open: Enter Room is filled in green, so it looks live, not like Open Room.
  const button = el('button', `home-card-btn${up ? ' live' : ''}`);
  button.append(icon(up ? 'play-filled' : 'play', 'tint-green'), el('span', '', up ? 'Enter Room' : 'Open Room'));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    enterRoom(project.name);
  });
  const buttons = el('div', 'home-card-buttons');
  buttons.append(button);
  if (up) {
    const more = el('button', 'home-card-btn live more');
    more.append(icon('chevron_down'));
    more.title = 'Rooms in this project: close one, or all of them';
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      roomsMenu(project, more);
    });
    buttons.append(more);
  }
  buttons.append(previewButton(project));
  const lifetime = project.tokensAllTime > 0 ? el('div', 'home-card-tokens', `${bigNumber(project.tokensAllTime)} tokens all time`) : null;
  if (lifetime) lifetime.title = 'Everything AI read and wrote in this project\nCounted from its conversation records';
  card.append(top, el('div', 'home-card-note', note), ...(lifetime ? [lifetime] : []), buttons);
  card.title = last ? `Last AI change: ${shortName(last.file || '', 28, true)}\n${modelName(last.model, last.tool)} · ${ago(last.time)}` : changed ? `Changed ${ago(changed)}` : '';
  window.ghUi?.decorate(card, project.name);
  card.addEventListener('click', () => navigate(project.path));
  card.addEventListener('keydown', (event) => { if (event.key === 'Enter' && event.target === card) navigate(project.path); });
  card.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    projectMenu(project, event.clientX, event.clientY);
  });
  return card;
}

// The folder a recent file is in, with the file picked, as File Explorer's "Open file location".
function openLocation(entry) {
  navigate(entry.folder);
  state.selected = new Set([entry.path]);
  state.anchor = entry.path;
  state.focus = entry.path;
  if (state.active) state.active.revealSelected = true;
}

// Home's recent files work like a folder's: picked with a click, Ctrl+click or Shift+click, with the
// same right-click menu and keys (Ctrl+C, Ctrl+X, Delete, F2...). Home isn't a folder, so there's
// nothing to paste into here.
let recentAnchor = null;
const recentRows = () => [...homeView.querySelectorAll('.home-recent-row[data-path]')];

function markRecent() {
  recentRows().forEach((row) => row.classList.toggle('selected', state.selected.has(row.dataset.path)));
  renderChrome();
}

function pickRecent(entry, event) {
  if (event.ctrlKey) {
    const next = new Set(state.selected);
    if (next.has(entry.path)) next.delete(entry.path);
    else next.add(entry.path);
    state.selected = next;
    recentAnchor = entry.path;
  } else if (event.shiftKey && recentAnchor) {
    const paths = recentRows().map((row) => row.dataset.path);
    const from = Math.max(0, paths.indexOf(recentAnchor));
    const to = paths.indexOf(entry.path);
    state.selected = new Set(paths.slice(Math.min(from, to), Math.max(from, to) + 1));
  } else {
    state.selected = new Set([entry.path]);
    recentAnchor = entry.path;
  }
  markRecent();
}

function recentMenu(entry, x, y) {
  const picked = () => [...state.selected];
  const items = [
    { label: 'Open', icon: 'eye', run: () => openFile(entry) },
    { label: 'Open File Location', icon: 'folder_open', run: () => openLocation(entry) },
  ];
  if (isHtmlFile(entry)) items.splice(1, 0, browserItem(entry)); // right after Open
  if (!shownHere(entry)) {
    items.push({ label: 'Open in Windows App', icon: 'open', run: () => openInWindows(entry, false) });
    items.push({ label: 'Open With…', icon: 'open', run: () => openInWindows(entry, true) });
  }
  items.push(
    '-',
    { label: 'Copy as Path', icon: 'link', run: () => copyAsPath(picked()) },
    { label: 'Compress to ZIP File', icon: 'folder_zip', run: compressRecent },
    { label: 'Rename', icon: 'rename', disabled: state.selected.size !== 1, run: renameRecent },
    { label: 'Delete', icon: 'delete', run: deleteSelected },
    '-',
    { label: 'Properties', icon: 'info', run: () => showProperties(picked()) },
  );
  rightClickMenu(x, y, fileActions(selectAllRecent), items);
}

function selectAllRecent() {
  state.selected = new Set(recentRows().map((row) => row.dataset.path));
  markRecent();
}

// There's no list to type the new name into on Home, so it's asked for.
async function renameRecent() {
  if (state.selected.size !== 1) return;
  const [target] = state.selected;
  const name = await promptBox('Rename', '', entryName(target), 'Rename');
  if (!name || name === entryName(target)) return;
  const next = await attempt(() => call('rename', target, name));
  if (!next) return;
  remember({ type: 'rename', label: 'rename', pairs: [{ from: target, to: next }] });
  state.selected = new Set([next]);
  recentAnchor = next;
  await renderHome();
  markRecent();
}

// The zip goes beside the first file, as in a folder. A note says where, with a way there.
async function compressRecent() {
  const paths = [...state.selected];
  if (!paths.length) return;
  const folder = parentOf(paths[0]);
  let made = null;
  await runJob({
    verb: 'Zipping', count: paths.length, dir: folder, icon: 'folder_zip', quietMs: 400,
    run: async () => { made = (await call('compress', paths)).made; return []; },
  });
  if (made) toast(`Zipped as "${shortName(entryName(made), 40)}"`, 'Show', () => openLocation({ path: made, folder: parentOf(made) }));
}

function recentRow(entry) {
  const row = el('div', 'home-recent-row');
  row.tabIndex = 0;
  row.dataset.path = entry.path;
  row.classList.toggle('selected', state.selected.has(entry.path));
  const name = el('span', 'home-recent-name');
  name.append(fileIcon(entry), el('span', 'name-text', entry.name));
  const place = el('button', 'home-recent-place', shortName(entry.location, 60, true));
  place.title = 'Open file location';
  place.addEventListener('click', (event) => {
    event.stopPropagation();
    openLocation(entry);
  });
  row.append(name, el('span', 'home-recent-date', formatDate(entry.mtime)), place, editorCell(entry));
  row.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    pickRecent(entry, event);
  });
  row.addEventListener('dblclick', () => openFile(entry));
  row.addEventListener('keydown', (event) => { if (event.key === 'Enter') openFile(entry); });
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // As in a folder: right-clicking something not picked picks just it.
    if (!state.selected.has(entry.path)) pickRecent(entry, {});
    recentMenu(entry, event.clientX, event.clientY);
  });
  return row;
}

// A click on Home away from the recent files lets go of them.
homeView.addEventListener('click', (event) => {
  if (event.target.closest('.home-recent-row[data-path], button, a') || !state.selected.size || !atHome()) return;
  state.selected = new Set();
  markRecent();
});

function homeSection(title, body, link) {
  const section = el('section', 'home-section');
  const head = el('div', 'home-section-head');
  head.append(el('h3', 'home-section-title', title), ...(link ? [link] : []));
  section.append(head, body);
  return section;
}

function drawHome() {
  const data = homeData;
  // The 6 latest projects, in one row: as many as the window has room for (style.css).
  const projects = el('div', 'home-projects');
  (data?.projects || []).slice(0, 6).forEach((project) => projects.append(projectCard(project)));
  if (data && !data.projects.length) projects.append(el('div', 'home-empty', 'Your projects will show here.'));

  const recent = el('div', 'home-recent');
  const head = el('div', 'home-recent-row home-recent-head');
  head.append(el('span', '', 'Name'), el('span', '', 'Date modified'), el('span', '', 'Location'), el('span', '', 'Last edited by'));
  recent.append(head);
  (data?.recent || []).forEach((entry) => recent.append(recentRow(entry)));
  if (data && !data.recent.length) recent.append(el('div', 'home-empty', 'Files you and AI change will show here.'));

  // The row hides what doesn't fit, so this opens the Projects folder, where every project is.
  let seeAll = null;
  if (data?.projects.length) {
    seeAll = el('button', 'home-see-all', `See all projects (${data.projects.length})`);
    seeAll.addEventListener('click', () => navigate(state.projects));
  }
  homeView.replaceChildren(homeTiles(data), homeSection('Most Recent', projects, seeAll), homeSection('Recent files', recent));
  if (data) window.ghUi?.afterHome(data.projects.slice(0, 6).map((project) => project.name));
}

/* ---------- Keyboard ---------- */

document.addEventListener('keydown', (event) => {
  if (!preview.hidden) {
    if (pe) return; // the picture editor has its own keys (picture-editor.js)
    if (event.key === 'Escape' || event.key === ' ') {
      event.preventDefault();
      closePreview();
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      previewStep(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      previewStep(-1);
    }
    return;
  }
  if (event.key === 'Escape') closeMenu();
  // Ctrl+R starts the window again with its loading screen (reloadWindow). Inside a terminal it's
  // the terminal's own key (searching what was typed before), so it's left to it.
  if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'r') {
    if (event.target.closest?.('.xterm') || state.active?.kind === 'obscura') return; // Obscura reloads its page (obscura-tab.js)
    event.preventDefault();
    if (!dialog.open) reloadWindow();
    return;
  }
  if (dialog.open || state.active?.kind !== 'files' || event.target.matches('input, textarea') || dragging) return;

  // File Explorer's keys. Tab keys like Ctrl+W only work here: in a terminal they belong to the terminal.
  const { key } = event;
  const lower = key.toLowerCase();
  // Home: the keys for tabs, Back and Forward and the address bar, and a folder's keys for the
  // recent files picked there (nothing can be pasted into Home).
  if (atHome()) {
    const chosen = [...state.selected];
    if (chosen.length) {
      const plain = !event.ctrlKey && !event.altKey;
      let handled = true;
      if (event.ctrlKey && !event.altKey && !event.shiftKey && lower === 'c') toClipboard(false);
      else if (event.ctrlKey && !event.altKey && !event.shiftKey && lower === 'x') toClipboard(true);
      else if (event.ctrlKey && !event.altKey && !event.shiftKey && lower === 'd') deleteSelected();
      else if (event.ctrlKey && !event.altKey && event.shiftKey && lower === 'c') copyAsPath(chosen);
      else if (event.altKey && !event.ctrlKey && key === 'Enter') showProperties(chosen);
      else if (plain && key === 'Delete') deleteSelected(event.shiftKey);
      else if (plain && !event.shiftKey && key === 'F2') renameRecent();
      else if (plain && key === 'Escape') { state.selected = new Set(); markRecent(); }
      else handled = false;
      if (handled) {
        event.preventDefault();
        return;
      }
    }
    if (event.ctrlKey && !event.altKey && !event.shiftKey && lower === 'a' && recentRows().length) {
      event.preventDefault();
      selectAllRecent();
      return;
    }
    if (event.ctrlKey && !event.altKey) {
      if (key === 'Tab') { event.preventDefault(); cycleTab(event.shiftKey ? -1 : 1); }
      else if (!event.shiftKey && lower === 't') { event.preventDefault(); openFilesTab(HOME_PAGE); }
      else if (!event.shiftKey && lower === 'w') { event.preventDefault(); closeTab(state.active); }
      else if (!event.shiftKey && lower === 'l') { event.preventDefault(); editAddress(); }
    } else if (event.altKey) {
      if (key === 'ArrowLeft') goBack();
      else if (key === 'ArrowRight') goForward();
      else if (lower === 'd') { event.preventDefault(); editAddress(); }
    } else if (key === 'F4') {
      event.preventDefault();
      editAddress();
    }
    return;
  }
  const selected = visibleEntries().filter((entry) => state.selected.has(entry.path));
  const picked = selected.map((entry) => entry.path);
  const done = () => event.preventDefault();
  if (event.ctrlKey && !event.altKey) {
    if (event.shiftKey && /^Digit[1-8]$/.test(event.code)) { done(); setViewMode(VIEWS[Number(event.code.slice(5)) - 1].id); return; }
    if (event.shiftKey && lower === 'n') { done(); newFolder(); return; }
    if (event.shiftKey && lower === 'c') { done(); copyAsPath(picked.length ? picked : [state.active.path]); return; }
    if (key === 'Tab') { done(); cycleTab(event.shiftKey ? -1 : 1); return; }
    if (event.shiftKey) return;
    if (lower === 'a') { done(); selectAll(); return; }
    if (lower === 'c') { if (picked.length) toClipboard(false); return; }
    if (lower === 'x') { if (picked.length) toClipboard(true); return; }
    if (lower === 'v') { done(); pasteOrSay(); return; }
    if (lower === 'z') { done(); undoLast(); return; }
    if (lower === 'd') { done(); deleteSelected(); return; }
    if (lower === 't') { done(); openFilesTab(HOME_PAGE); return; }
    if (lower === 'w') { done(); closeTab(state.active); return; }
    if (lower === 'l') { done(); editAddress(); return; }
    if (lower === 'f' || lower === 'e') { done(); $('search').focus(); return; }
    if (key === ' ') {
      done();
      const entry = visibleEntries().find((item) => item.path === state.focus);
      if (entry) toggleEntry(entry);
      return;
    }
  }
  if (event.altKey) {
    if (key === 'ArrowLeft') goBack();
    else if (key === 'ArrowRight') goForward();
    else if (key === 'ArrowUp') $('up').click();
    else if (key === 'Enter') { done(); showProperties(picked.length ? picked : [state.active.path]); }
    else if (lower === 'd') { done(); editAddress(); }
    return;
  }
  // The menu key, or Shift+F10: the right-click menu, without the mouse.
  if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) {
    done();
    const entry = selected.find((item) => item.path === state.focus) || selected[0];
    const node = entry && rowsEl.querySelector(`[data-path="${CSS.escape(entry.path)}"]`);
    if (node) {
      const box = node.getBoundingClientRect();
      entryMenu(entry, box.left + 40, box.bottom);
    } else {
      const box = rowsEl.getBoundingClientRect();
      rowsEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 40, clientY: box.top + 20 }));
    }
    return;
  }
  if (key === 'Delete') deleteSelected(event.shiftKey);
  else if (key === 'F2') renameSelected();
  else if (key === 'F5') refreshNow();
  else if (key === 'F4') { done(); editAddress(); }
  else if (key === 'F3') { done(); $('search').focus(); }
  else if (key === 'Backspace') { done(); goBack(); }
  else if (key === 'Enter' && selected.length === 1) openEntry(selected[0]);
  else if (key === ' ' && !(typed && Date.now() - typedAt < 1000)) {
    done();
    if (selected.length === 1 && !selected[0].isDir) showPreview(selected[0]);
  } else if (!event.ctrlKey && !event.metaKey && moveFocus(key, event)) done();
  else if (key.length === 1 && !event.ctrlKey && !event.metaKey) typeToFind(key);
});

// The mouse's own back and forward buttons, as in File Explorer.
window.addEventListener('mouseup', (event) => {
  if (state.active?.kind !== 'files' || (event.button !== 3 && event.button !== 4)) return;
  event.preventDefault();
  if (event.button === 3) goBack();
  else goForward();
});

// Ctrl and the mouse wheel step through the views, from extra large icons down to Content.
// A wheel listener that can cancel the scroll makes every scroll wait for this page's code, so it
// only exists while Ctrl is held down. The rest of the time the list scrolls on its own.
let wheelStepAt = 0;
function stepViewByWheel(event) {
  if (!event.ctrlKey) return;
  event.preventDefault();
  if (Date.now() - wheelStepAt < 150) return;
  wheelStepAt = Date.now();
  const index = VIEWS.findIndex((view) => view.id === state.viewMode);
  const next = VIEWS[Math.max(0, Math.min(VIEWS.length - 1, index + (event.deltaY > 0 ? 1 : -1)))];
  if (next.id !== state.viewMode) setViewMode(next.id);
}
// A touchpad pinch arrives as Ctrl+wheel with no Ctrl key press, so the first Ctrl wheel event seen
// also puts the listener on, for as long as the pinch keeps going. Plain scrolling never does.
let wheelStepOn = false;
let ctrlHeld = false;
let pinchTimer = 0;
function holdWheelStep() {
  if (wheelStepOn) return;
  wheelStepOn = true;
  rowsEl.addEventListener('wheel', stepViewByWheel, { passive: false });
}
function dropWheelStep() {
  wheelStepOn = false;
  ctrlHeld = false;
  clearTimeout(pinchTimer);
  rowsEl.removeEventListener('wheel', stepViewByWheel);
}
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Control') return;
  ctrlHeld = true;
  holdWheelStep();
}, { capture: true, passive: true });
window.addEventListener('keyup', (event) => { if (event.key === 'Control') dropWheelStep(); }, { capture: true, passive: true });
window.addEventListener('blur', dropWheelStep);
window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return;
  holdWheelStep();
  if (!ctrlHeld) {
    clearTimeout(pinchTimer);
    pinchTimer = setTimeout(dropWheelStep, 400);
  }
}, { capture: true, passive: true });

// Wheel and touchpad scrolling on Home, the file list and open documents glides by this page's own
// code. Chromium's own scroll animation eases in (the first few frames hardly move, then it
// catches up), which feels late. This one moves at once and only slows toward the end. At the top
// and bottom it stops asking for more, so nothing is left waiting there. Elsewhere the wheel is
// untouched; Ctrl+wheel (and a pinch) is left to the view stepping above.
const glides = new Map();
function glideStep(box, glide, now) {
  // Elapsed time is kept between 0 and 50 ms: a time ahead of this frame must never push the page backward.
  const share = 1 - 0.5 ** (Math.max(0, Math.min(now - glide.at, 50)) / 16.7);
  glide.at = now;
  ['X', 'Y'].forEach((axis) => {
    const spot = glide[axis];
    spot.now += (spot.to - spot.now) * share;
    if (Math.abs(spot.to - spot.now) < 2) spot.now = spot.to;
    box[`scroll${axis === 'X' ? 'Left' : 'Top'}`] = spot.now;
    spot.seen = box[`scroll${axis === 'X' ? 'Left' : 'Top'}`];
  });
  if (glide.X.now === glide.X.to && glide.Y.now === glide.Y.to) return glides.delete(box);
  glide.frame = requestAnimationFrame((time) => glideStep(box, glide, time));
}
// A touchpad swipe sends many small steps (tenths of a notch); a mouse wheel sends whole clicks.
// The kind is decided for the whole swipe (a run of steps less than 150 ms apart): one step that is
// not a whole number of clicks makes it a touchpad swipe, because a swipe also holds whole-click-sized
// steps. One click is 120 device pixels, so in page pixels it is 120 / devicePixelRatio (zoom included).
// A swipe that follows a touchpad swipe by less than 1.5 s is a touchpad swipe from its first step.
const swipe = { at: -1000, fine: false, proved: false };
function isFineSwipe(event) {
  const gap = event.timeStamp - swipe.at;
  if (gap > 150) { swipe.fine = swipe.proved && gap < 1500; swipe.proved = false; }
  swipe.at = event.timeStamp;
  const notch = 120 / window.devicePixelRatio;
  const whole = (step) => Math.abs(step / notch - Math.round(step / notch)) < 0.03;
  if (event.deltaMode === 0 && !(whole(event.deltaX) && whole(event.deltaY))) swipe.fine = swipe.proved = true;
  return swipe.fine;
}

// A touchpad step goes straight onto the position, with no easing: the page stays under the fingers.
// The exact position is kept, so the browser's rounding to screen pixels does not add up.
const fineAt = new WeakMap();
function followByWheel(box, event) {
  const old = glides.get(box);
  if (old) { cancelAnimationFrame(old.frame); glides.delete(box); }
  let at = fineAt.get(box);
  // A glide cut short by this swipe goes on from its target, so none of its distance is lost.
  if (old && Math.abs(box.scrollTop - old.Y.seen) <= 1.5 && Math.abs(box.scrollLeft - old.X.seen) <= 1.5) at = { x: old.X.to, y: old.Y.to };
  else if (!at || Math.abs(box.scrollTop - at.seenY) > 1.5 || Math.abs(box.scrollLeft - at.seenX) > 1.5) at = { x: box.scrollLeft, y: box.scrollTop };
  at.x = Math.max(0, Math.min(box.scrollWidth - box.clientWidth, at.x + event.deltaX));
  at.y = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, at.y + event.deltaY));
  box.scrollLeft = at.x;
  box.scrollTop = at.y;
  at.seenX = box.scrollLeft;
  at.seenY = box.scrollTop;
  fineAt.set(box, at);
}
function glideByWheel(event) {
  if (event.ctrlKey || event.defaultPrevented) return;
  const box = event.target.closest('#rows, #home-view, .cm-scroller');
  if (!box || !event.currentTarget.contains(box)) return;
  const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? box.clientHeight : 1;
  event.preventDefault();
  if (isFineSwipe(event)) return followByWheel(box, event);
  let glide = glides.get(box);
  // A scrollbar drag or a jump from elsewhere moved it: start again from where it is.
  if (glide && (Math.abs(box.scrollTop - glide.Y.seen) > 1.5 || Math.abs(box.scrollLeft - glide.X.seen) > 1.5)) {
    cancelAnimationFrame(glide.frame);
    glide = null;
  }
  const fresh = !glide;
  if (fresh) {
    glide = { at: performance.now(), X: { now: box.scrollLeft, to: box.scrollLeft, seen: box.scrollLeft }, Y: { now: box.scrollTop, to: box.scrollTop, seen: box.scrollTop } };
    glides.set(box, glide);
  }
  glide.X.to = Math.max(0, Math.min(box.scrollWidth - box.clientWidth, glide.X.to + event.deltaX * unit));
  glide.Y.to = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, glide.Y.to + event.deltaY * unit));
  // The first step is taken now, so the list moves with the first event, not a frame later.
  if (fresh) { const now = performance.now(); glide.at = now - 16.7; glideStep(box, glide, now); }
}
['rows', 'home-view', 'doc-area'].forEach((id) => $(id).addEventListener('wheel', glideByWheel, { capture: true, passive: false }));

function cycleTab(step) {
  const index = state.tabs.indexOf(state.active);
  activateTab(state.tabs[(index + step + state.tabs.length) % state.tabs.length]);
}

/* ---------- Command bar ---------- */

function goBack() {
  const tab = state.active;
  if (tab.kind !== 'files' || !tab.back.length) return;
  tab.forward.push(tab.path);
  navigate(tab.back.pop(), true);
}

function goForward() {
  const tab = state.active;
  if (tab.kind !== 'files' || !tab.forward.length) return;
  tab.back.push(tab.path);
  navigate(tab.forward.pop(), true);
}

$('back').addEventListener('click', goBack);
$('forward').addEventListener('click', goForward);
// A file's own tab (text, video, song): Up closes it (asking what closing it asks) and shows its folder with the file picked.
const FILE_TABS = ['doc', 'video', 'song'];
async function upFromFile(tab) {
  const [from, folder] = [tab.path, parentOf(tab.path)];
  await closeTab(tab);
  if (state.tabs.includes(tab)) return; // kept open
  if (state.active.kind === 'files') navigate(folder);
  else openFilesTab(folder);
  state.selected = new Set([from]);
  state.anchor = from;
  state.active.revealSelected = true;
}

$('up').addEventListener('click', () => {
  const tab = state.active;
  if (FILE_TABS.includes(tab.kind)) upFromFile(tab);
  else navigate(parentOf(tab.path));
});
/* ---------- Loading screen ---------- */

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const splash = () => document.getElementById('splash');
let splashHide = null;

function showSplash() {
  const screen = splash();
  if (!screen) return;
  clearTimeout(splashHide);
  // The ring turns with the clock, so after a Ctrl+R the new page carries it on (again.js).
  if (screen.hidden) document.documentElement.style.setProperty('--spin-phase', `-${Date.now() % 1200}ms`);
  screen.hidden = false;
  screen.classList.remove('fade');
}

function hideSplash() {
  const screen = splash();
  if (!screen) return;
  screen.classList.add('fade');
  clearTimeout(splashHide);
  splashHide = setTimeout(() => {
    screen.hidden = true;
    // Gone, so the next Ctrl+R's loading screen comes in the usual way (again.js).
    document.documentElement.classList.remove('again');
  }, 480); // just past the finish
}

// Nothing is ever left behind the loading screen, even if the house is slow to answer.
const splashLimit = setTimeout(hideSplash, 10000);

// One full turn of the ring, so the loading screen never just blinks.
const SPLASH_SHORTEST = 1200;

// The page is ready before the window is on screen, so the shortest time starts from when it shows.
function windowShown() {
  const root = document.documentElement;
  if (root.classList.contains('ready')) return Promise.resolve();
  return new Promise((done) => {
    const finish = () => { watcher.disconnect(); done(); };
    const watcher = new MutationObserver(() => { if (root.classList.contains('ready')) finish(); });
    watcher.observe(root, { attributes: true, attributeFilter: ['class'] });
    setTimeout(finish, 5000);
  });
}

// The refresh button and F5, as in File Explorer: only what's on screen is read again and drawn
// anew. It blinks out for a moment so you can see it happened. No loading screen (that's Ctrl+R).
// Rooms, terminals and jobs keep running.
const BLINK_MS = 120; // the shortest blink
const BLINK_LONGEST = 600; // a slow folder shows what it had again until its new list is in
let refreshing = false;
async function refreshNow() {
  if (refreshing || state.active?.kind !== 'files') return;
  refreshing = true;
  const view = atHome() ? homeView : rowsEl;
  view.classList.add('blink');
  try { await Promise.race([Promise.all([loadFolder().catch(() => {}), wait(BLINK_MS)]), wait(BLINK_LONGEST)]); }
  finally {
    view.classList.remove('blink');
    refreshing = false;
  }
}
$('refresh').addEventListener('click', refreshNow);
$('cut').addEventListener('click', () => toClipboard(true));
$('copy').addEventListener('click', () => toClipboard(false));
$('paste').addEventListener('click', pasteOrSay);
$('rename').addEventListener('click', () => (atHome() ? renameRecent() : renameSelected()));
$('delete').addEventListener('click', deleteSelected);
$('trash-restore').addEventListener('click', restoreSelected);
$('trash-empty').addEventListener('click', emptyTrash);
$('search').addEventListener('input', (event) => {
  state.search = event.target.value;
  // Anything a search hides is unselected, so Delete can never touch items you can't see.
  const visible = new Set(visibleEntries().map((entry) => entry.path));
  state.selected = new Set([...state.selected].filter((target) => visible.has(target)));
  renderEntries();
});

$('new-btn').addEventListener('click', (event) => menuUnder(event.currentTarget, newItems()));

function setSort(sortBy) {
  if (state.sortBy === sortBy) state.sortAsc = !state.sortAsc;
  else {
    state.sortBy = sortBy;
    state.sortAsc = sortBy !== 'mtime';
  }
  renderEntries();
}

$('sort-btn').addEventListener('click', (event) => {
  const choice = (label, key, sortIcon) => ({ label, icon: sortIcon, checked: state.sortBy === key, run: () => setSort(key) });
  menuUnder(event.currentTarget, [
    choice('Name', 'name', 'text_font'),
    choice('Date modified', 'mtime', 'calendar_ltr'),
    choice('Last edited by', 'editor', 'bot'),
    choice('Last read by', 'reader', 'eye'),
    choice('Tokens', 'tokens', 'data_bar_vertical'),
    choice('Type', 'type', 'tag'),
    choice('Size', 'size', 'data_bar_vertical'),
    '-',
    { label: 'Ascending', icon: 'arrow_sort_up', checked: state.sortAsc, run: () => { state.sortAsc = true; renderEntries(); } },
    { label: 'Descending', icon: 'arrow_sort_down', checked: !state.sortAsc, run: () => { state.sortAsc = false; renderEntries(); } },
  ]);
});

const VIEWS = [
  { id: 'xl', label: 'Extra large icons', icon: 'square' },
  { id: 'large', label: 'Large icons', icon: 'square_multiple' },
  { id: 'medium', label: 'Medium icons', icon: 'grid' },
  { id: 'small', label: 'Small icons', icon: 'grid_dots' },
  { id: 'list', label: 'List', icon: 'text_bullet_list' },
  { id: 'details', label: 'Details', icon: 'list' },
  { id: 'tiles', label: 'Tiles', icon: 'apps_list' },
  { id: 'content', label: 'Content', icon: 'content_view' },
];

// The column headings only mean something in Details. The Sort menu works in every view.
function showViewMode() {
  filesView.classList.toggle('details-view', state.viewMode === 'details');
}

function setViewMode(mode) {
  state.viewMode = mode;
  showViewMode();
  rowsEl.scrollLeft = 0;
  renderEntries();
  call('setViewMode', mode).catch(() => {});
}

async function loadViewMode() {
  const saved = await call('viewMode').catch(() => null);
  if (VIEWS.some((view) => view.id === saved)) state.viewMode = saved;
  showViewMode();
}

$('view-btn').addEventListener('click', (event) => {
  menuUnder(event.currentTarget, [
    ...VIEWS.map(({ id, label, icon: viewIcon }) => ({ label, icon: viewIcon, checked: state.viewMode === id, run: () => setViewMode(id) })),
    '-',
    { label: 'Item Check Boxes', icon: 'checkbox_checked', checked: prefs.checks, run: () => setChecks(!prefs.checks) },
    {
      label: 'Hidden Items',
      icon: 'eye',
      checked: state.showHidden,
      run: () => {
        state.showHidden = !state.showHidden;
        loadFolder();
      },
    },
  ]);
});

// Tick boxes beside every item, for picking several without holding Ctrl. On by default.
function showChecks() {
  filesView.classList.toggle('checks', prefs.checks);
}

function setChecks(on) {
  prefs.checks = on;
  showChecks();
  call('setPrefs', { checks: on }).catch(() => {});
}

async function loadPrefs() {
  const saved = await call('prefs').catch(() => ({}));
  if (typeof saved.checks === 'boolean') prefs.checks = saved.checks;
  if (typeof saved.activityOpen === 'boolean') prefs.activityOpen = saved.activityOpen;
  if (typeof saved.activitySeen === 'string') prefs.activitySeen = saved.activitySeen;
  showChecks();
}

// The box above the names picks everything, or nothing if everything is already picked.
$('check-all').addEventListener('click', (event) => {
  event.stopPropagation();
  const shown = visibleEntries();
  if (shown.length && shown.every((entry) => state.selected.has(entry.path))) setSelection([]);
  else selectAll();
});
$('check-all').addEventListener('pointerdown', (event) => event.stopPropagation());

$('view-details').addEventListener('click', () => setViewMode('details'));
$('view-icons').addEventListener('click', () => setViewMode('large'));

/* ---------- Columns: resize, move, show and hide, all remembered ---------- */

const COLUMN_LABELS = { name: 'Name', mtime: 'Date modified', editor: 'Last edited by', reader: 'Last read by', tokens: 'Tokens', type: 'Type', size: 'Size' };
const COLUMN_MIN = { name: 100, mtime: 50, editor: 60, reader: 60, tokens: 44, type: 50, size: 50 };
const COLUMN_MAX = 900;
const NAME_ROOM = 150; // the least Name gets in a narrow list before another column steps aside
const columnDefaults = () => ({ order: ['name', 'mtime', 'editor', 'reader', 'tokens', 'type', 'size'], widths: { name: 273, mtime: 144, editor: 140, reader: 150, tokens: 70, type: 110, size: 80 }, hidden: [] });
let columnSetup = columnDefaults();
let columnsSqueezedOut = [];
const columnsEl = $('columns');
const columnDrop = $('col-drop');
const clampColumn = (key, width) => Math.round(Math.min(COLUMN_MAX, Math.max(COLUMN_MIN[key], width)));
const saveColumns = () => call('setColumns', columnSetup).catch(() => {});

// Lays the columns out from the settings. The cells stay put in the page and CSS moves them,
// so nothing has to be rebuilt, however long the list is.
function applyColumns() {
  // A smaller window hides Type, then Date, then Last edited by, so Name always has room to be
  // read, even with the System panel open beside it. While a terminal tab is showing there's no
  // width to go by.
  const room = filesView.clientWidth;
  if (room) {
    const out = room <= 420 ? ['tokens', 'reader', 'type', 'mtime'] : room <= 640 ? ['tokens', 'reader', 'type'] : [];
    const beside = () => columnSetup.order
      .filter((key) => key !== 'name' && !columnSetup.hidden.includes(key) && !out.includes(key))
      .reduce((sum, key) => sum + columnSetup.widths[key], 0);
    // With the newer columns, Type, Tokens and Last read by step aside (in that order) even in a window that isn't small.
    for (const key of ['type', 'tokens', 'reader', 'mtime', 'editor']) {
      if ((out.length || ['type', 'tokens', 'reader'].includes(key)) && !out.includes(key) && room - beside() < NAME_ROOM) out.push(key);
    }
    columnsSqueezedOut = out;
  }
  const squeezed = columnsSqueezedOut.length > 0;
  const gone = new Set([...columnSetup.hidden, ...columnsSqueezedOut]);
  const shown = columnSetup.order.filter((key) => !gone.has(key));
  // Squeezed, Name takes what's left. Otherwise the widths are as set, and a spare track fills any extra room.
  const tracks = shown.map((key) => (squeezed && key === 'name' ? 'minmax(0, 1fr)' : `${columnSetup.widths[key]}px`));
  if (!squeezed) tracks.push('minmax(0, 1fr)');
  const total = shown.reduce((sum, key) => sum + columnSetup.widths[key], 0);
  filesView.style.setProperty('--cols', tracks.join(' '));
  filesView.style.setProperty('--cols-total', squeezed ? '0px' : `${total}px`);
  filesView.classList.toggle('columns-squeezed', squeezed);
  columnSetup.order.forEach((key, index) => {
    filesView.style.setProperty(`--order-${key}`, index);
    filesView.classList.toggle(`hide-${key}`, gone.has(key));
  });
}

new ResizeObserver(applyColumns).observe(filesView);

// The list scrolls sideways when the columns are wider than it. The headers go with it.
rowsEl.addEventListener('scroll', () => {
  columnsEl.style.transform = `translateX(${-rowsEl.scrollLeft}px)`;
}, { passive: true });

// The list's scrollbar narrows the rows but not the header, so with Name taking what is left, every column after it
// would sit a bar's width out of line. The header gives the bar's width back.
new ResizeObserver(() => { columnsEl.style.paddingRight = `${rowsEl.offsetWidth - rowsEl.clientWidth}px`; }).observe(rowsEl);

async function loadColumns() {
  const saved = await call('columns').catch(() => ({}));
  const keys = columnDefaults().order;
  if (Array.isArray(saved.order) && saved.order.every((key) => keys.includes(key)) && new Set(saved.order).size === saved.order.length) {
    // A column added since it was saved goes where it is by default, after the one before it.
    const order = [...saved.order];
    keys.filter((key) => !order.includes(key)).forEach((key) => {
      const before = keys[keys.indexOf(key) - 1];
      order.splice(order.includes(before) ? order.indexOf(before) + 1 : order.length, 0, key);
    });
    columnSetup.order = order;
  }
  keys.forEach((key) => {
    if (Number.isFinite(saved.widths?.[key])) columnSetup.widths[key] = clampColumn(key, saved.widths[key]);
  });
  if (Array.isArray(saved.hidden)) columnSetup.hidden = keys.filter((key) => key !== 'name' && saved.hidden.includes(key));
  applyColumns();
}

function changeColumns(change) {
  change();
  applyColumns();
  saveColumns();
}

// Wide enough for its heading and everything in the current folder, with no text cut off.
const columnRuler = document.createElement('canvas').getContext('2d');
function fitWidth(key) {
  columnRuler.font = getComputedStyle(rowsEl).font;
  const roomInCell = { name: 62 + (prefs.checks ? 20 : 0), mtime: 12, editor: 34, reader: 34, tokens: 12, type: 12, size: 14 }[key]; // padding, and for names the icon, tick box and room light
  const roomInHeader = key === 'name' ? 37 + (prefs.checks ? 20 : 0) : 12;
  let widest = columnRuler.measureText(COLUMN_LABELS[key]).width + roomInHeader;
  visibleEntries().forEach((entry) => {
    widest = Math.max(widest, columnRuler.measureText(cellText(entry, key)).width + roomInCell);
  });
  return clampColumn(key, Math.ceil(widest) + 2);
}

const fitColumns = (keys) => changeColumns(() => keys.forEach((key) => { columnSetup.widths[key] = fitWidth(key); }));

let headerDragged = false;

columnsEl.querySelectorAll('button').forEach((button) => {
  const key = button.dataset.sort;
  const grip = el('span', 'col-grip');
  button.append(grip);

  button.addEventListener('click', (event) => {
    if (event.target !== grip && !headerDragged) setSort(key);
  });

  // Dragging the edge resizes it. Double-clicking the edge fits it to what's in it.
  grip.addEventListener('dblclick', () => fitColumns([key]));
  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const pressX = event.clientX;
    const startWidth = button.offsetWidth;
    document.documentElement.classList.add('col-sizing');
    window.houseFrame.track(grip, event, {
      move(current) {
        columnSetup.widths[key] = clampColumn(key, startWidth + current.clientX - pressX);
        applyColumns();
      },
      end(_last, moved) {
        document.documentElement.classList.remove('col-sizing');
        if (moved) saveColumns();
      },
    });
  });

  // Dragging the heading moves the column. A line shows where it will land.
  button.addEventListener('pointerdown', (event) => {
    headerDragged = false;
    if (event.button !== 0) return;
    const pressX = event.clientX;
    let before = null;
    window.houseFrame.track(button, event, {
      begin() {
        headerDragged = true;
        button.classList.add('col-moving');
        columnDrop.hidden = false;
      },
      move(current) {
        button.style.transform = `translateX(${current.clientX - pressX}px)`;
        const others = [...columnsEl.querySelectorAll('button')]
          .filter((other) => other !== button && other.offsetWidth)
          .map((other) => ({ key: other.dataset.sort, box: other.getBoundingClientRect() }))
          .sort((a, b) => a.box.left - b.box.left);
        const next = others.find(({ box }) => box.left + box.width / 2 > current.clientX);
        before = next ? next.key : null;
        const edge = next ? next.box.left : others[others.length - 1].box.right;
        columnDrop.style.left = `${edge - columnsEl.getBoundingClientRect().left - 1}px`;
      },
      end(_last, moved, cancelled) {
        button.classList.remove('col-moving');
        button.style.transform = '';
        columnDrop.hidden = true;
        if (!moved || cancelled) return;
        changeColumns(() => {
          const order = columnSetup.order.filter((other) => other !== key);
          order.splice(before ? order.indexOf(before) : order.length, 0, key);
          columnSetup.order = order;
        });
      },
    });
  });
});

columnsEl.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const clicked = event.target.closest('button')?.dataset.sort;
  const items = columnSetup.order.map((key) => ({
    label: COLUMN_LABELS[key],
    checked: !columnSetup.hidden.includes(key),
    disabled: key === 'name', // a list with no names would be no use
    run: () => changeColumns(() => {
      const hidden = columnSetup.hidden.includes(key);
      columnSetup.hidden = hidden ? columnSetup.hidden.filter((other) => other !== key) : [...columnSetup.hidden, key];
    }),
  }));
  items.push('-');
  if (clicked) items.push({ label: 'Size this column to fit', run: () => fitColumns([clicked]) });
  items.push(
    { label: 'Size all columns to fit', run: () => fitColumns(columnSetup.order.filter((key) => !columnSetup.hidden.includes(key))) },
    { label: 'Reset columns', run: () => changeColumns(() => { columnSetup = columnDefaults(); }) },
  );
  rightClickMenu(event.clientX, event.clientY, fileActions(visibleEntries().length ? selectAll : null), items);
});

// A place in the sidebar, right-clicked (the page-wide menu adds these after the shared four).
function navItems(item) {
  const key = item.dataset.nav;
  const target = key === 'windows' ? (state.windowsHome || state.windows) : navPath(key);
  const items = [
    { label: 'Open', icon: 'folder_open', run: () => item.click() },
    { label: 'Open in New Tab', icon: 'tab_add', run: () => openFilesTab(target) },
  ];
  if (target !== HOME_PAGE) {
    items.push(
      '-',
      { label: 'Copy as Path', icon: 'link', run: () => copyAsPath([target]) },
      { label: 'Properties', icon: 'info', run: () => showProperties([target]) },
    );
  }
  return items;
}

$('nav').querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', async () => {
    if (state.active.kind !== 'files') {
      const existing = state.tabs.find((tab) => tab.kind === 'files');
      if (existing) activateTab(existing);
      else openFilesTab(HOME_PAGE);
    }
    // Windows (C:) opens in your Windows user folder (C:\Users\<you>), as File Explorer starts in your files.
    if (item.dataset.nav === 'windows') {
      state.windowsHome = await call('windowsHome').catch(() => state.windows);
      navigate(state.windowsHome);
      return;
    }
    const target = navPath(item.dataset.nav);
    if (item.dataset.nav !== 'root') await attempt(() => call('ensureFolder', target));
    navigate(target);
  });
});

/* The sidebar collapses to icons, and while open, dragging its edge changes its width. Both are remembered. */
const NAV_WIDTH = { min: 120, max: 320 };
const navPane = { width: 158, collapsed: false };

function showNavPane() {
  const nav = $('nav');
  nav.classList.toggle('collapsed', navPane.collapsed);
  nav.style.setProperty('--nav-width', `${navPane.width}px`);
  $('nav-toggle').title = navPane.collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  // Hover text names an icon only while its label is hidden.
  nav.querySelectorAll('.nav-item').forEach((item) => {
    if (navPane.collapsed) item.title = item.querySelector('span').textContent;
    else delete item.dataset.tip;
  });
}

const saveNavPane = () => call('setNavPane', { ...navPane }).catch(() => {});

async function loadNavPane() {
  const saved = await call('navPane').catch(() => ({}));
  if (Number.isFinite(saved.width)) navPane.width = Math.min(NAV_WIDTH.max, Math.max(NAV_WIDTH.min, Math.round(saved.width)));
  navPane.collapsed = saved.collapsed === true;
  showNavPane();
}

$('nav-toggle').addEventListener('click', () => {
  navPane.collapsed = !navPane.collapsed;
  showNavPane();
  saveNavPane();
});

// Using either one shouldn't take typing focus away from a terminal.
[$('nav-toggle'), $('nav-grip')].forEach((part) => part.addEventListener('mousedown', (event) => event.preventDefault()));
$('nav-grip').addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const grip = event.currentTarget;
  const nav = $('nav');
  const pressX = event.clientX;
  const startWidth = nav.offsetWidth;
  const widest = Math.max(NAV_WIDTH.min, Math.min(NAV_WIDTH.max, nav.parentElement.clientWidth / 2));
  grip.classList.add('held');
  window.houseFrame.track(grip, event, {
    move(current) {
      navPane.width = Math.round(Math.min(widest, Math.max(NAV_WIDTH.min, startWidth + current.clientX - pressX)));
      nav.style.setProperty('--nav-width', `${navPane.width}px`);
    },
    end(_last, moved) {
      grip.classList.remove('held');
      if (moved) saveNavPane();
    },
  });
});

$('room-btn').addEventListener('click', () => {
  if (!state.currentProject) return;
  if (state.active.kind === 'term') showRoomFiles(state.currentProject);
  else enterRoom(state.currentProject, state.currentFolder);
});
$('room-preview-btn').addEventListener('click', () => {
  if (state.currentProject) previewProject(state.currentProject);
});
$('room-new-btn').addEventListener('click', () => {
  if (state.currentProject) openTerminal({ room: state.currentProject, cwd: state.currentFolder });
});
$('room-close-btn').addEventListener('click', () => {
  if (isRoomTerminal(state.active)) closeOneRoom(state.active);
  else if (state.currentProject) closeRoom(state.currentProject);
});

/* ---------- Windows door ---------- */

// Locking is always safe, so it happens straight away. Rooms that could still read Windows files
// close to do it, and a short note names them. Unlocking asks first.
async function toggleDoor() {
  const { doorOpen, rooms } = state.status;
  if (doorOpen) {
    const held = rooms.filter((room) => room.windowsDoor).map((room) => room.name);
    const locked = await attempt(async () => {
      await call('closeDoor');
      return true;
    });
    if (locked && held.length) {
      held.forEach(closeRoomTabs);
      toast(`Locked. ${held.length === 1 ? 'This room' : 'These rooms'} closed to do it: ${nameList(held)}.`);
    }
  } else {
    const yes = await confirmBox(
      'Unlock Windows Files?',
      'Rooms you open next can read them, not change them.\nIt locks again when the house restarts.',
      'Unlock',
      true,
    );
    if (!yes) return;
    await attempt(() => call('openDoor'));
  }
  await refreshStatus();
}

$('lock-btn').addEventListener('click', toggleDoor);

/* ---------- Files dragged in from Windows ---------- */
/* Linux windows can't take drops from Windows, so the Windows helper catches them over the file
   list and passes on where they came from. Only while the door is unlocked: locked, it turns them
   away, and this says how to unlock. The house checks the door again before copying anything. */

const dropShade = el('div', 'drop-shade');
const dropLabel = el('div', 'drop-label');
const dropIcon = icon('arrow_download-filled');
const dropText = el('span');
dropLabel.append(dropIcon, dropText);
dropShade.append(dropLabel);
filesView.append(dropShade);
let dropAreaSent = '';
let dropBusy = false;

// The file list, in screen pixels on the app's layer. Nothing at all when it can't take a drop.
function dropArea() {
  const tab = state.active;
  if (!tab || tab.kind !== 'files' || atHome() || inTrash() || onWindows() || dialog.open || dropBusy) return null;
  const box = filesView.getBoundingClientRect();
  if (box.width < 40 || box.height < 40) return null;
  const scale = window.outerWidth / window.innerWidth;
  return { x: box.left * scale, y: box.top * scale, w: box.width * scale, h: box.height * scale };
}

// Checked often, and only sent when something changed, since the list moves with the window.
function sendDropArea() {
  const box = dropArea();
  const now = JSON.stringify([box, state.status.doorOpen]);
  if (now === dropAreaSent) return;
  dropAreaSent = now;
  call('dropArea', box, state.status.doorOpen);
}
setInterval(sendDropArea, 250);

// The folder under the pointer, if it's pointing at one. Otherwise the drop goes in this folder.
function dropFolderAt(x, y) {
  const scale = window.outerWidth / window.innerWidth;
  const node = document.elementFromPoint(x / scale, y / scale)?.closest('[data-path]');
  const entry = node && rowsEl.contains(node) && state.entries.find((item) => item.path === node.dataset.path);
  return entry && entry.isDir ? { node, entry } : null;
}

function showDrop(text, iconName, locked) {
  filesView.classList.add('drop-hover');
  filesView.classList.toggle('drop-locked', Boolean(locked));
  setIcon(dropIcon, iconName);
  dropText.textContent = text;
}

function markDropFolder(found) {
  rowsEl.querySelectorAll('.drop-into').forEach((node) => node.classList.remove('drop-into'));
  if (found) found.node.classList.add('drop-into');
}

// While something is being dragged over the list: where it would go.
function hoverDrop(found) {
  markDropFolder(found);
  showDrop(found ? `Copy into ${shownName(found.entry)}` : `Copy to ${baseName(state.active.path)}`, 'arrow_download-filled');
}

function endDrop() {
  if (dropBusy) return;
  filesView.classList.remove('drop-hover', 'drop-locked');
  markDropFolder(null);
}

async function bringIn({ id, x, y, names }) {
  const found = dropFolderAt(x, y);
  markDropFolder(null);
  if (state.active?.kind !== 'files' || atHome() || inTrash() || dropBusy) {
    endDrop();
    return;
  }
  const dir = found ? found.entry.path : state.active.path;
  await copyFromWindows(names.length, dir, () => call('importDrop', id, dir));
}

/* Copying in from Windows, by paste or drop, with how far along it is beside the label:
   "Copying Notes App from Windows… 63%", and a thin bar under it. */
const dropPercent = el('span', 'drop-percent');
const dropBar = el('div', 'drop-bar');
dropBar.append(el('div', 'drop-bar-fill'));
dropLabel.append(dropPercent, dropBar);

// "Copying Website Theme from Windows…", "Deleting 3 items…"
function jobLabel(names) {
  const { verb, from, count } = copyJob;
  if (!names && count === 1) return `${verb}${from}…`;
  const what = names?.length === 1 ? names[0] : `${names?.length || count} items`;
  return `${verb} ${what}${from}…`;
}

/* A job (a copy, a big delete) belongs to the folder it was started from, and the one it works on.
   It only shows there. Anywhere else, the small ring beside the lock shows it, and takes you back. */
function onCopyPage() {
  return Boolean(copyJob?.shown) && state.active?.kind === 'files' && copyJob.pages.includes(state.active.path);
}

function syncCopyView() {
  const here = onCopyPage();
  filesView.classList.toggle('drop-copying', here);
  filesView.classList.toggle('drop-plain', here && !copyJob.outline);
  if (copyJob?.shown) filesView.classList.toggle('drop-hover', here);
  $('copy-mini').hidden = !copyJob?.shown || here;
}

$('copy-mini').addEventListener('click', () => {
  if (!copyJob) return;
  const [page] = copyJob.pages;
  const tab = state.tabs.find((other) => other.kind === 'files' && other.path === page);
  if (tab) activateTab(tab);
  else if (state.active?.kind === 'files') navigate(page);
  else openFilesTab(page);
});

window.house.on('copy:progress', ({ done, total, names, measuring, final }) => {
  if (!dropBusy || !copyJob) return;
  dropText.textContent = measuring ? 'Getting ready…' : jobLabel(names);
  // Never shows 100% until it's really finished.
  const part = total > 0 ? Math.min(done / total, final ? 1 : 0.99) : (final ? 1 : 0);
  const percent = Math.floor(part * 100);
  dropPercent.textContent = measuring ? '' : `${percent}%`;
  filesView.style.setProperty('--copied', `${part * 100}%`);
  $('copy-ring-fill').style.strokeDashoffset = String(100 - percent);
  $('copy-mini-text').textContent = `${percent}%`;
});

/* Runs one job at a time with its progress on show: { verb, count, dir, icon, run }. run() returns
   the items that failed. outline: the dashed drop outline too, for files coming in from Windows.
   quietMs: a job that's done sooner than this never shows at all, so quick ones don't flash. */
async function runJob({ verb, count, dir, icon: jobIcon, run, from = '', outline = false, quietMs = 0, failurePath = (target) => target }) {
  if (dropBusy) {
    toast('Wait for the current copy or delete to finish first.');
    return;
  }
  dropBusy = true;
  copyJob = { pages: [...new Set([state.active.path, dir])], verb, from, count, outline, shown: false };
  $('copy-mini').title = `${verb} in ${shortName(baseName(dir), 24)}…\nClick to go there.`;
  $('copy-ring-fill').style.strokeDashoffset = '100';
  $('copy-mini-text').textContent = '0%';
  filesView.style.setProperty('--copied', '0%');
  dropPercent.textContent = '';
  const job = copyJob;
  const reveal = () => {
    if (copyJob !== job) return;
    job.shown = true;
    showDrop(dropText.textContent || jobLabel(null), jobIcon); // progress may already have named it
    syncCopyView();
  };
  dropText.textContent = '';
  const timer = quietMs ? setTimeout(reveal, quietMs) : null;
  if (!quietMs) reveal();
  let failures = [];
  let problem = null;
  try {
    failures = await run();
  } catch (error) {
    problem = error;
  }
  clearTimeout(timer);
  dropBusy = false;
  copyJob = null;
  syncCopyView();
  endDrop();
  loadFolder();
  if (problem) await alertBox('That didn\'t work', cleanError(problem));
  else await reportFailures((failures || []).map((failure) => ({ ...failure, path: failurePath(failure.path) })), count);
}

function copyFromWindows(count, dir, run) {
  return runJob({
    verb: 'Copying', from: ' from Windows', count, dir, icon: 'arrow_download-filled', outline: true, run,
    failurePath: (target) => target.split('\\').pop(),
  });
}

window.house.on('window:link', (message) => {
  if (message.type === 'connected') {
    dropAreaSent = ''; // the helper has just (re)joined, so it needs to know where the list is
    sendDropArea();
  } else if (message.type === 'drop-hover') {
    if (dropBusy) return;
    if (message.allowed) hoverDrop(null);
    else showDrop('Windows access is locked. Unlock it at the top right to bring files in.', 'lock_closed-filled', true);
  } else if (message.type === 'drop-over') {
    if (state.status.doorOpen && !dropBusy) hoverDrop(dropFolderAt(message.x, message.y));
  } else if (message.type === 'drop-leave') {
    endDrop();
  } else if (message.type === 'drop') {
    bringIn(message);
  } else if (message.type === 'clipboard') {
    windowsClipboardChanged(Number(message.files) || 0, message.ours === true, message.image === true);
  }
});
// The helper may have said what's on the clipboard before this page was ready to hear it.
Promise.all([call('windowsClipboard'), call('windowsPicture')]).then(([count, picture]) => {
  if (count > 0 || picture) windowsClipboardChanged(count, false, picture === true);
}).catch(() => {});

/* ---------- House rules ---------- */

const OPTION_LABELS = { allow: 'Allow', ask: 'Ask', block: 'Block', readonly: 'Read only' };
const rulesView = $('rules-view');
let rulesData = null; // the rules and their choices, from panel/lib/rules.js

// House Rules is a page of its own, in a tab, like Agents. Done (or Esc) closes it and goes back
// to the page you were on. Every rule applies to every room, the same way. The main rules come
// first, the finer ones further down.
async function showRules() {
  const open = () => state.tabs.find((tab) => tab.kind === 'rules');
  if (open()) {
    activateTab(open());
    return open();
  }
  const data = await attempt(() => call('getRules'));
  if (!data) return null;
  rulesData = data;
  if (open()) { // asked twice while the rules were loading
    activateTab(open());
    return open();
  }
  const tab = { kind: 'rules', returnTo: state.active };
  addTabElement(tab, 'House Rules');
  state.tabs.push(tab);
  renderTabButtons();
  activateTab(tab);
  return tab;
}

// A rule the room's own walls keep (Your folders, Other projects) starts when a room opens. A room
// open right now keeps the old one, and its AI can't see the change, so say so at once.
function tellOpenRooms() {
  const open = state.status.rooms;
  if (!open.length) return;
  toast(open.length === 1
    ? `${shortName(open[0].name, 20)} gets this the next time it opens. Close the room, then open it.`
    : 'Open rooms get this the next time they open. Close each one, then open it again.');
}

function closeRules() {
  const tab = state.tabs.find((other) => other.kind === 'rules');
  if (tab) closeTab(tab);
}

function renderRules(focusKey = '') {
  if (rulesView.hidden || !rulesData) return;
  const page = el('div', 'rules-page');
  const head = el('div', 'rules-head');
  const done = el('button', 'btn primary rules-done', 'Done');
  done.type = 'button';
  done.title = 'Go back to the page you were on';
  done.addEventListener('click', closeRules);
  head.append(el('h2', 'rules-title', 'House Rules'), el('p', 'rules-intro', rulesData.intro), done);
  page.append(head);

  const legend = el('div', 'rules-legend');
  [['Allow', 'AI just does it.'], ['Ask', 'AI asks you first.'], ['Block', 'AI can\'t do it.']].forEach(([word, meaning]) => {
    const item = el('div', 'rules-legend-item');
    item.append(el('span', 'rules-chip', word), el('span', '', meaning));
    legend.append(item);
  });
  page.append(legend);

  let focusButton = null;
  const group = (title, note, section) => {
    page.append(el('h3', 'rules-group', title));
    if (note) page.append(el('p', 'rules-note', note));
    rulesData.definitions.filter((rule) => rule.section === section).forEach((rule) => {
      const row = el('div', 'rule');
      const text = el('div', 'rule-text');
      text.append(el('div', 'rule-label', rule.label), el('div', 'rule-detail', rule.detail));
      // Said only when not every AI keeps this rule the same way.
      if (rule.who) text.append(el('div', 'rule-who', rule.who));
      const choices = el('div', 'segmented');
      choices.setAttribute('role', 'group');
      choices.setAttribute('aria-label', rule.label);
      rule.options.forEach((option) => {
        const on = rulesData.values[rule.id] === option;
        const button = el('button', `segment${on ? ' on' : ''}`, OPTION_LABELS[option]);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(on));
        button.addEventListener('click', async () => {
          if (rulesData.values[rule.id] === option) return;
          const next = await attempt(() => call('setRule', rule.id, option));
          if (next) {
            rulesData = next;
            renderRules(`${rule.id}:${option}`);
            if (rule.strength === 'wall') tellOpenRooms();
          }
        });
        if (focusKey === `${rule.id}:${option}`) focusButton = button;
        choices.append(button);
      });
      row.append(text, choices);
      page.append(row);
    });
  };
  group('Main rules', '', 'main');
  group('More controls', 'Finer rules. Every room follows these too.', 'more');
  page.append(el('p', 'rules-foot', 'Changes save right away. Done takes you back.'));

  const scroll = rulesView.scrollTop;
  rulesView.replaceChildren(page);
  rulesView.scrollTop = scroll;
  focusButton?.focus({ preventScroll: true }); // the keyboard stays on the choice just made
}

rulesView.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('dialog').open) {
    event.preventDefault();
    closeRules();
  }
});

$('rules-btn').addEventListener('click', showRules);

/* ---------- System panel ---------- */

const systemPane = $('system-pane');
let systemTimer = null;

function meter(label, used, total, unit, percent) {
  const block = el('div', 'meter');
  const head = el('div', 'meter-head');
  head.append(el('span', '', label), el('span', 'meter-value', total === null ? `${Math.round(used)}%` : `${used.toFixed(1)} of ${total.toFixed(total < 100 ? 1 : 0)} ${unit}`));
  const track = el('div', 'meter-track');
  const fill = el('div', 'meter-fill');
  fill.style.width = `${Math.min(100, percent)}%`;
  track.append(fill);
  block.append(head, track);
  return block;
}

// Holds still while you're pressing or about to press something, so a redraw can't lose your click
// or slide a different row under the mouse.
let pressingInPane = false;
let showAllPrograms = false;
systemPane.addEventListener('pointerdown', () => { pressingInPane = true; });

const sizeMb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

function longTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  if (hours) return `${hours} h ${minutes} min`;
  return `${Math.max(1, minutes)} min`;
}

// The house keeper's note, in plain words: [look, { title, note }].
function houseMood(keeper = '', rooms = []) {
  const idle = keeper.match(/^idle for (\d+)s of (\d+)s/);
  if (idle) {
    const left = Math.max(0, Number(idle[2]) - Number(idle[1]));
    return ['sleepy', { title: 'House is resting', note: `Nothing is running. It goes to sleep in ${Math.max(1, Math.ceil(left / 60))} min to save power.` }];
  }
  if (keeper.startsWith('going to sleep')) return ['sleepy', { title: 'House is going to sleep', note: 'It wakes up again when you open the panel or a room.' }];
  const why = keeper.replace(/^awake:\s*/, '');
  if (rooms.length) return ['awake', { title: 'House is awake', note: `${rooms.length} room${rooms.length === 1 ? ' is' : 's are'} open. It stays awake until ${rooms.length === 1 ? 'it closes' : 'they close'}.` }];
  if (why.startsWith('docker not answering')) return ['problem', { title: 'House is awake', note: 'Docker isn\'t answering, so it stays awake to be safe.' }];
  if (why.startsWith('jobs running')) return ['awake', { title: 'House is awake', note: `Programs are running: ${why.replace('jobs running: ', '').replace(/,\s*/g, ', ')}.` }];
  if (why.startsWith('background jobs')) return ['awake', { title: 'House is awake', note: `Background programs: ${why.replace('background jobs: ', '').replace(/,\s*/g, ', ')}.` }];
  if (why.startsWith('terminal session')) return ['awake', { title: 'House is awake', note: 'A terminal is open.' }];
  if (why.startsWith('system update')) return ['awake', { title: 'House is awake', note: 'A system update is running.' }];
  if (why.startsWith('files being moved')) return ['awake', { title: 'House is awake', note: 'Files are being copied or moved.' }];
  return ['awake', { title: 'House is awake', note: why || 'Checking…' }];
}
window.addEventListener('pointerup', () => { pressingInPane = false; });

// "2026-11-07 16:26:05" from room.log, shown as "4:26 PM" today, or "Nov 5, 4:26 PM" before.
function logTime(time) {
  const when = new Date(time.replace(' ', 'T'));
  if (!time || Number.isNaN(when.getTime())) return '';
  const clock = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (when.toDateString() === new Date().toDateString()) return clock;
  return `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${clock}`;
}

// Long notes in the System panel stop at two lines. Clicking one shows all of it, and clicking
// again folds it back. Which ones are open is kept while the panel redraws.
const openNotes = new Set();
function foldable(node, key) {
  node.classList.add('foldable');
  node.classList.toggle('unfolded', openNotes.has(key));
  node.addEventListener('click', () => {
    if (openNotes.has(key)) openNotes.delete(key);
    else openNotes.add(key);
    pressingInPane = false;
    renderSystem(true);
  });
}

// The last thing in the System panel: what happened in the rooms, newest first, folded away until
// opened. Its badge counts problems that came in since the list was last open.
function renderActivity(frag, entries) {
  const head = el('button', `sys-title sys-activity-head${prefs.activityOpen ? ' open' : ''}`);
  head.setAttribute('aria-expanded', String(prefs.activityOpen));
  head.append(icon('chevron_right', 'sys-chevron'), el('span', '', 'Activity'));
  const problems = entries.filter((entry) => entry.problem);
  const newest = problems[0]?.time || '';
  if (prefs.activityOpen) {
    if (newest > prefs.activitySeen) {
      prefs.activitySeen = newest;
      call('setPrefs', { activitySeen: newest }).catch(() => {});
    }
  } else {
    const unseen = problems.filter((entry) => entry.time > prefs.activitySeen).length;
    if (unseen) {
      const badge = el('span', 'sys-badge', String(unseen));
      badge.title = `${unseen} new problem${unseen === 1 ? '' : 's'} since you last looked`;
      head.append(badge);
    }
  }
  head.addEventListener('click', () => {
    prefs.activityOpen = !prefs.activityOpen;
    call('setPrefs', { activityOpen: prefs.activityOpen }).catch(() => {});
    pressingInPane = false;
    renderSystem(true);
  });
  frag.append(head);
  if (!prefs.activityOpen) return;
  const list = el('div', 'sys-activity');
  if (!entries.length) list.append(el('p', 'sys-note', 'Nothing has happened in the rooms yet.'));
  entries.forEach((entry) => {
    const row = el('div', `sys-log${entry.problem ? ' problem' : ''}`);
    foldable(row, `log:${entry.time} ${entry.text}`);
    const meta = el('div', 'sys-log-meta');
    meta.append(el('span', 'sys-log-time', logTime(entry.time)));
    if (entry.room) meta.append(el('span', 'sys-log-room', entry.room));
    row.append(meta, el('div', 'sys-log-text', entry.text));
    list.append(row);
  });
  frag.append(list);
}

// Clean-up (panel/lib/housekeeping.js): when it last ran and what it freed, a button to run it now,
// and the switch for the daily run. The hover lists what each part removed.
const CLEANUP_NAMES = { roomContainers: 'closed rooms', crashDumps: 'crash dumps', trashOld: 'old Trash', buildCache: 'build cache', logs: 'logs', testLeftovers: 'test leftovers', editorCopies: 'video copies' };
let cleaning = false;
function renderCleanup(frag, cleanup) {
  const last = cleanup?.lastRun;
  const rules = Array.isArray(last?.rules) ? last.rules : [];
  const freed = rules.reduce((sum, rule) => sum + (Number(rule.bytes) || 0), 0);
  const row = el('div', 'sys-row');
  row.append(el('span', 'sys-row-label', last ? `Last clean-up: ${cardAgo(last.time)} · freed ${formatSize(freed)}` : 'Not run yet'));
  if (last) {
    const parts = rules.filter((rule) => rule.removed?.length).map((rule) => `${CLEANUP_NAMES[rule.id] || rule.label} ${formatSize(rule.bytes)}`).join(', ');
    row.title = parts ? `Removed: ${parts}` : 'Nothing needed removing';
  }
  frag.append(row);

  const auto = el('label', 'sys-check');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = Boolean(cleanup?.on);
  box.addEventListener('change', () => attempt(() => call('setCleanup', box.checked)));
  auto.append(box, el('span', '', 'Clean up automatically'));
  auto.title = 'Once a day: closed rooms, crash dumps, old Trash, caches, logs';
  frag.append(auto);

  const now = agentsButton(cleaning ? 'Cleaning up…' : 'Clean up now', 'arrow_clockwise', '', 'Remove what Station and its rooms left behind', async () => {
    if (cleaning) return;
    cleaning = true;
    pressingInPane = false;
    renderSystem(true);
    const result = await attempt(() => call('cleanupNow'));
    cleaning = false;
    if (result) {
      const total = result.rules.reduce((sum, rule) => sum + (Number(rule.bytes) || 0), 0);
      toast(`Clean-up done: freed ${formatSize(total)}`);
    }
    renderSystem(true);
  });
  now.disabled = cleaning;
  frag.append(now);
}

// Redrawn every few seconds while open, but not while a button in it is pressed or pointed at,
// unless that button's click asked for it (force).
async function renderSystem(force = false) {
  if (systemPane.hidden || document.documentElement.classList.contains('capturing')) return;
  if (!force && (pressingInPane || systemPane.querySelector('button:hover'))) return;
  let info;
  try {
    info = await call('system');
  } catch {
    return;
  }
  const frag = document.createDocumentFragment();
  const section = (title, extra) => {
    const head = el('h3', 'sys-title', title);
    if (extra) head.append(extra);
    frag.append(head);
  };
  const { rooms, dockerOk, lowDisk, freeGb } = state.status;

  frag.append(el('h2', 'sys-heading', 'System'));

  // First: is the house awake, and why. Problems come right under it, so they're never missed.
  const [mood, line] = houseMood(state.status.keeper, rooms);
  const card = el('div', `sys-card ${mood}`);
  const cardText = el('div', 'sys-card-text');
  cardText.append(el('div', 'sys-card-title', line.title), el('div', 'sys-card-note', line.note));
  card.append(icon(mood === 'awake' ? 'flash' : mood === 'sleepy' ? 'weather_moon' : 'warning', 'sys-card-icon'), cardText);
  frag.append(card);
  foldable(card, `card:${line.note}`);
  const warn = (text) => {
    const box = el('div', 'sys-warn');
    foldable(box, `warn:${text}`);
    box.append(icon('warning'), el('span', '', text));
    frag.append(box);
  };
  if (!dockerOk) warn('Docker isn\'t answering, so rooms can\'t open or close right now.');
  if (lowDisk) warn(`Storage is almost full: ${Math.floor(freeGb)} GB left. Empty the Trash or make storage bigger.`);
  if (state.status.doorOpen) warn('Windows access is unlocked. Rooms can see your C: drive.');

  section('Performance');
  frag.append(meter('CPU', info.cpu, null, '', info.cpu));
  frag.lastChild.title = `${info.cores} cores`;
  frag.append(meter('Memory', info.memoryUsed, info.memoryTotal, 'GB', (100 * info.memoryUsed) / info.memoryTotal));
  frag.append(meter('Storage', info.diskUsed, info.diskTotal, 'GB', (100 * info.diskUsed) / info.diskTotal));
  const facts = el('div', 'sys-facts');
  const fact = (label, value) => {
    const item = el('div', 'sys-fact');
    item.append(el('span', '', label), el('span', 'sys-fact-value', value));
    facts.append(item);
  };
  fact('Free in the house', `${Math.floor(freeGb ?? (info.diskTotal - info.diskUsed))} GB`);
  if (info.windows?.fresh) fact('Free on your PC (C:)', `${Math.round(info.windows.cFreeGb)} GB`);
  fact('Awake for', longTime(info.upSeconds));
  frag.append(facts);

  section(`Rooms (${rooms.length})`);
  if (!rooms.length) frag.append(el('p', 'sys-note', 'No rooms are open. Open one from a project.'));
  rooms.forEach((room) => {
    const use = info.roomUse?.[room.name];
    const row = el('div', 'sys-room');
    const name = el('button', 'sys-room-name');
    name.title = 'Go to this room\'s terminal';
    name.append(el('span', 'light'), el('span', 'sys-room-label', room.name));
    name.addEventListener('click', () => enterRoom(room.name));
    const numbers = el('span', 'sys-room-use', use ? `${Math.round(use.cpu)}% · ${sizeMb(use.memoryMb)}` : '…');
    numbers.title = 'CPU and memory this room is using';
    const close = el('button', 'link-btn', 'Close');
    close.title = 'Close every room in this project';
    close.addEventListener('click', () => closeRoom(room.name));
    row.append(name, numbers, close);
    if (room.windowsDoor) row.append(el('span', 'sys-room-door', 'Can see Windows files'));
    frag.append(row);
  });

  // Every copy of a program is one line. Only the busiest few show until you ask for all.
  section('Programs', el('span', 'sys-title-note', 'busiest first'));
  const table = el('div', 'proc-table');
  const head = el('div', 'proc-row proc-head');
  head.append(el('span', '', 'Name'), el('span', 'proc-num', 'CPU'), el('span', 'proc-num', 'Memory'), el('span', ''));
  table.append(head);
  const shown = showAllPrograms ? info.processes : info.processes.slice(0, 5);
  shown.forEach((proc) => {
    const row = el('div', 'proc-row');
    row.title = `${proc.count === 1 ? 'Process' : `${proc.count} copies:`} ${proc.pids.slice(0, 3).join(', ')}${proc.pids.length > 3 ? '…' : ''}\nRun by ${proc.users.slice(0, 2).join(', ')}`;
    const name = el('span', 'proc-name', proc.command);
    if (proc.count > 1) name.append(el('span', 'proc-count', `×${proc.count}`));
    row.append(name, el('span', 'proc-num', `${proc.cpu.toFixed(0)}%`), el('span', 'proc-num', sizeMb(proc.memoryMb)));
    if (proc.mine && proc.command !== 'electron') {
      const end = el('button', 'link-btn', 'End');
      end.title = proc.count > 1 ? `Stop all ${proc.count} copies` : 'Stop this program';
      end.addEventListener('click', async () => {
        const what = proc.count > 1 ? `all ${proc.count} copies of "${proc.command}"` : `"${proc.command}"`;
        if (await confirmBox('End Program?', `Stop ${what}?\nAnything not saved in it is lost.`, 'End', true)) {
          await attempt(() => call('endProcess', proc.pids));
          renderSystem();
        }
      });
      row.append(end);
    } else {
      row.append(el('span', ''));
    }
    table.append(row);
  });
  frag.append(table);
  if (info.processes.length > 5) {
    const more = el('button', 'link-btn sys-more', showAllPrograms ? 'Show fewer' : `Show all ${info.processes.length}`);
    more.addEventListener('click', () => {
      showAllPrograms = !showAllPrograms;
      pressingInPane = false;
      renderSystem(true);
    });
    frag.append(more);
  }

  section('Settings');
  const awake = el('label', 'sys-check');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = info.keepAwake;
  box.disabled = !info.windows?.fresh;
  box.addEventListener('change', () => attempt(() => call('setKeepAwake', box.checked)));
  awake.append(box, el('span', '', 'Keep my PC awake while rooms or jobs run'));
  frag.append(awake);
  const resizeRow = el('div', 'sys-row');
  resizeRow.append(el('span', 'sys-row-label', `Storage size: ${Math.round(info.diskTotal)} GB`));
  const resize = el('button', 'btn small', 'Change Size');
  resize.disabled = !info.windows?.fresh;
  resize.addEventListener('click', () => changeStorage(info));
  resizeRow.append(resize);
  frag.append(resizeRow);
  if (!info.windows?.fresh) frag.append(el('p', 'sys-note', 'The Windows helper isn\'t running, so these two can\'t change right now.'));
  if (info.resizeResult) frag.append(el('p', 'sys-note', info.resizeResult));

  section('Clean-up');
  renderCleanup(frag, await call('cleanupStatus').catch(() => null));

  renderActivity(frag, info.activity || []);

  const scroll = systemPane.scrollTop;
  systemPane.replaceChildren(frag);
  systemPane.scrollTop = scroll;
}

/* ---------- Agents: every project, and what the AI in each open room is doing ---------- */

const agentsView = $('agents-view');
let agentsLook = null; // the latest from Herdr, through panel/lib/herdr.js
let agentsWatching = false;

// One Agents tab. Asking again goes back to it.
function openAgents() {
  const existing = state.tabs.find((tab) => tab.kind === 'agents');
  if (existing) {
    activateTab(existing);
    return existing;
  }
  const tab = { kind: 'agents' };
  addTabElement(tab, 'Agents');
  state.tabs.push(tab);
  renderTabButtons();
  activateTab(tab);
  return tab;
}

// Herdr is only asked while the page is showing.
function watchAgents() {
  const on = state.active?.kind === 'agents' && document.visibilityState === 'visible';
  if (on === agentsWatching) return;
  agentsWatching = on;
  call('agentsWatch', on).catch(() => {});
}
document.addEventListener('visibilitychange', watchAgents);
// A project made outside Station shows up when the window comes back to Home.
window.addEventListener('focus', () => { if (atHome()) renderHome(); });
window.addEventListener('beforeunload', () => {
  if (agentsWatching) call('agentsWatch', false).catch(() => {});
});

window.house.on('agents:update', (look) => {
  agentsLook = look;
  if (state.active?.kind === 'agents') renderAgents();
});

// What each state is called on the page. Blocked means the agent is waiting for you.
const AGENT_STATES = {
  blocked: { label: 'Needs you', rank: 4 },
  working: { label: 'Working', rank: 3 },
  done: { label: 'Done', rank: 2 },
  idle: { label: 'Idle', rank: 1 },
  unknown: { label: 'Idle', rank: 0 },
};

// A tab with several panes shows the one that matters most: one that needs you, then one working.
function tabSummary(panes) {
  const agents = panes.filter((pane) => pane.agent);
  const top = agents.sort((a, b) => AGENT_STATES[b.status].rank - AGENT_STATES[a.status].rank)[0];
  if (!top) return { status: 'none', label: 'No agent', agent: '', title: panes[0]?.title || '' };
  return { status: top.status === 'unknown' ? 'idle' : top.status, label: AGENT_STATES[top.status].label, agent: top.agent, title: top.title };
}

// Goes to a room terminal's tab if it's here, or its own window if it has one, or connects to it again.
async function openRoomTab(name, tabName) {
  const here = state.tabs.find((tab) => tab.kind === 'term' && tab.room === name && tab.tab === tabName && !tab.ended);
  if (here) activateTab(here);
  else if (!await call('termFocusRoomTab', name, tabName).catch(() => false)) await openTerminal({ room: name, tab: tabName });
}

function agentsButton(label, iconName, tint, tip, run) {
  const button = el('button', 'btn small agents-btn');
  button.append(icon(iconName, tint), el('span', '', label));
  button.title = tip;
  button.addEventListener('click', run);
  return button;
}

function renderAgents() {
  if (agentsView.hidden) return;
  const page = el('div', 'agents-page');
  const head = el('div', 'agents-head');
  const look = agentsLook;
  const rooms = look?.rooms || [];
  // Every AI: in the rooms, in the house's own terminals, and in the house's Herdr.
  const houseTermAgents = (Array.isArray(look?.terms) ? look.terms : []).map((term) => ({ agent: term.agent, status: term.status }));
  const panes = [...rooms.flatMap((room) => room.tabs.flatMap((tab) => tab.panes)), ...houseTermAgents, ...(look?.house || [])].filter((pane) => pane.agent);
  const plural = (count, word, many) => `${count} ${count === 1 ? word : many}`;
  const summary = look
    ? [plural(rooms.filter((room) => room.open).length, 'room open', 'rooms open'),
      plural(panes.filter((pane) => pane.status === 'working').length, 'agent working', 'agents working'),
      plural(panes.filter((pane) => pane.status === 'blocked').length, 'needs you', 'need you')].join(' · ')
    : 'Looking…';
  const herdrButton = el('button', 'btn small agents-herdr', 'Open Herdr');
  herdrButton.title = 'Herdr\'s own view of every room, in a terminal';
  herdrButton.addEventListener('click', () => openTerminal({ herdr: true }));
  head.append(el('h2', 'agents-title', 'Agents'), el('p', 'agents-summary', summary), herdrButton);
  page.append(head);
  if (look && !look.dockerOk) {
    const box = el('div', 'sys-warn agents-warn');
    box.append(icon('warning'), el('span', '', 'Docker isn\'t answering, so open rooms can\'t be seen right now.'));
    page.append(box);
  }
  if (look && !rooms.length) page.append(el('p', 'agents-note agents-empty', 'No projects yet. Make one with New, then Project.'));

  // The house comes first, always: its own terminals (Linux House tabs) and what their AI is doing,
  // then any agents in the house's own Herdr.
  if (look) {
    const terms = Array.isArray(look.terms) ? look.terms : [];
    const houseAgents = (look.house || []).filter((pane) => pane.agent);
    const block = el('div', 'agents-room open agents-house');
    const top = el('div', 'agents-room-head');
    const count = terms.length ? plural(terms.length, 'terminal open', 'terminals open') : 'No terminals open';
    top.append(el('span', `agents-light${terms.length ? ' on' : ''}`), el('span', 'agents-room-name', 'Linux House'), el('span', 'agents-room-state', count));
    const actions = el('div', 'agents-actions');
    actions.append(agentsButton('New Terminal', 'window_console', 'tint-blue', 'Open a terminal in the house', () => openTerminal({ cwd: state.home })));
    top.append(actions);
    block.append(top);
    const list = el('div', 'agents-tabs');
    terms.forEach((term, index) => list.append(agentRow(houseSummary(term), `Terminal ${index + 1}`, () => openHouseTerminal(term.id), () => closeHouseTerminal(term.id))));
    houseAgents.forEach((pane) => list.append(agentRow(tabSummary([pane]), '', null)));
    if (list.childElementCount) block.append(list);
    page.append(block);
  }

  rooms.forEach((room) => {
    const block = el('div', `agents-room${room.open ? ' open' : ''}`);
    const top = el('div', 'agents-room-head');
    const name = el('span', 'agents-room-name', room.name);
    top.append(el('span', `agents-light${room.open ? ' on' : ''}`), name, el('span', 'agents-room-state', room.open ? 'Open' : 'Asleep'));
    const actions = el('div', 'agents-actions');
    if (room.open) {
      actions.append(
        agentsButton('Enter Room', 'play', 'tint-green', 'Go to this room\'s terminal', () => enterRoom(room.name)),
        agentsButton('New Room', 'window_console', 'tint-blue', 'Open another terminal in this room', () => openTerminal({ room: room.name })),
        agentsButton('Close All Rooms', 'checkbox_unchecked', 'tint-red', 'Close every room in this project', () => closeRoom(room.name)),
      );
    } else {
      actions.append(agentsButton('Open Room', 'play', 'tint-green', 'Start this room, so AI can work there', () => enterRoom(room.name)));
    }
    top.append(actions);
    block.append(top);
    if (room.open) {
      const list = el('div', 'agents-tabs');
      if (room.unavailable) list.append(el('p', 'agents-note', 'Agent state unavailable'));
      else if (!room.tabs.length) list.append(el('p', 'agents-note', 'No terminals running. Enter the room to start one.'));
      room.tabs.forEach((tab) => list.append(agentRow(tabSummary(tab.panes), `Terminal ${tab.tab.slice(4)}`, () => openRoomTab(room.name, tab.tab), () => closeRoomTerminal(room.name, tab.tab))));
      block.append(list);
    }
    page.append(block);
  });
  const scroll = agentsView.scrollTop;
  agentsView.replaceChildren(page);
  agentsView.scrollTop = scroll;
}

// One line for a terminal: its state as a colored dot and a word, the agent, and what it last said.
// Clicking it goes to the terminal; its Close button ends it.
function agentRow(summary, label, open, close = null) {
  const row = el('div', `agents-tab ${summary.status}${open ? ' can-open' : ''}`);
  if (open) {
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.title = 'Go to this terminal';
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === row) open();
    });
  }
  row.append(
    el('span', 'agents-dot'),
    el('span', 'agents-state', summary.label),
    el('span', 'agents-agent', agentName(summary.agent)),
    el('span', 'agents-tab-title', summary.title),
    el('span', 'agents-tab-name', label || ''),
  );
  const shut = el('button', 'agents-close');
  if (close) {
    shut.append(icon('dismiss'), el('span', '', 'Close'));
    shut.title = 'Close this terminal. Anything running in it stops.';
    shut.addEventListener('click', (event) => {
      event.stopPropagation();
      close();
    });
  } else {
    shut.hidden = true;
  }
  row.append(shut);
  return row;
}

// A house terminal's line: the same words as a room's.
function houseSummary(term) {
  if (!term.agent) return { status: 'none', label: 'No agent', agent: '', title: term.title || '' };
  const status = AGENT_STATES[term.status] ? term.status : 'idle';
  return { status: status === 'unknown' ? 'idle' : status, label: AGENT_STATES[status].label, agent: term.agent, title: term.title || '' };
}

// Goes to a house terminal: its tab here, or the window showing it.
async function openHouseTerminal(id) {
  const here = state.tabs.find((tab) => tab.kind === 'term' && tab.termId === id && !tab.room);
  if (here) activateTab(here);
  else await call('termFocusTerm', id).catch(() => false);
}

// Closes a house terminal, asking first if something is still running in it, as its tab's X does.
async function closeHouseTerminal(id) {
  const here = state.tabs.find((tab) => tab.kind === 'term' && tab.termId === id && !tab.room);
  if (here) {
    await closeTab(here);
  } else {
    if (await call('termBusy', id).catch(() => false)) {
      const message = 'Something is still running in it. Closing stops it.\nYour files are kept.';
      if (!await confirmBox('Close this terminal?', message, 'Close', true)) return;
    }
    call('termKill', id);
  }
  watchAgents();
}

// What a house terminal shows now, for the Agents page (main.js asks): the bottom of its screen
// and the title its program gave it. Null if it isn't shown in this window.
window.houseTermScreen = (id) => {
  const tab = state.tabs.find((candidate) => candidate.kind === 'term' && candidate.termId === id && !candidate.room && candidate.live);
  if (!tab) return null;
  const { term } = tab.live;
  const buffer = term.buffer.active;
  const end = buffer.baseY + term.rows;
  const lines = [];
  for (let y = Math.max(0, end - 40); y < end; y += 1) lines.push(buffer.getLine(y)?.translateToString(true) || '');
  return { text: lines.join('\n'), title: String(tab.live.title || '').slice(0, 300) };
};

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode' };
// The name comes from inside a room, so only the list's own names count (never "constructor").
const agentName = (agent) => (agent && Object.hasOwn(AGENT_NAMES, agent) ? AGENT_NAMES[agent] : agent || '');

async function changeStorage(info) {
  const value = await promptBox(
    'Change House Storage',
    `Now ${Math.round(info.diskTotal)} GB. Type the new size in GB.\nThe house restarts, then Station 256 opens again.`,
    String(Math.round(info.diskTotal)),
    'Continue',
  );
  if (!value) return;
  const yes = await confirmBox('Restart the House?', `Change to ${shortName(value, 6)} GB? Rooms and terminals close.\nProject files are kept.`, 'Restart and Resize', true);
  if (yes) await attempt(() => call('requestResize', Number(value)));
}

function toggleSystem(show) {
  systemPane.hidden = show === undefined ? !systemPane.hidden : !show;
  clearInterval(systemTimer);
  if (!systemPane.hidden) {
    renderSystem();
    systemTimer = setInterval(renderSystem, 2500);
  }
}

$('toggle-system').addEventListener('click', () => toggleSystem());
$('house-note').addEventListener('click', () => toggleSystem(true));

/* ---------- Window buttons and zoom ---------- */

window.house.on('zoom:changed', (zoom) => {
  $('zoom-level').textContent = `${Math.round((zoom / 1.35) * 100)}%`;
});
$('zoom-out').addEventListener('click', () => call('zoomStep', -1));
$('zoom-in').addEventListener('click', () => call('zoomStep', 1));
$('zoom-level').addEventListener('click', () => call('zoomReset'));

// Asked before the window closes, by the X or from the taskbar, if closing would stop anything.
// With other windows open, only this window closes: its room terminals keep running in their
// rooms, and it only asks if one of its other terminals is busy.
async function closeThisWindow() {
  let busy = 0;
  for (const tab of state.tabs) {
    if (tab.kind === 'term' && !tab.room && !tab.ended && await call('termBusy', tab.termId).catch(() => false)) busy += 1;
  }
  if (!busy) return true;
  const which = busy === 1 ? 'a terminal' : `${busy} terminals`;
  return confirmBox('Close this window?', `Closing stops what's running in ${which}.\nYour files are kept.`, 'Close', true);
}

window.houseFrame.beforeClose = async () => {
  if (windowInfo.count > 1) return closeThisWindow();
  const terminals = await call('termCount');
  const roomNames = state.status.rooms.map((room) => room.name);
  if (!terminals && !roomNames.length) return true;
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const lines = [];
  if (terminals) lines.push(`${plural(terminals, 'terminal')} will end, and what runs in them stops.`);
  // Room terminals are their own sessions in the room, so they stay open with it.
  if (roomNames.length) lines.push(`${plural(roomNames.length, 'room')} can stay open. Your PC stays awake.`);
  const choice = await showDialog((host, done) => {
    dialogFrame(host, 'Close Station 256?', lines.join('\n'));
    const buttons = [{ label: 'Cancel', onClick: () => done(false) }];
    if (roomNames.length) {
      buttons.push({ label: 'Keep rooms up', onClick: () => done('keep') });
      buttons.push({ label: 'Close rooms too', danger: true, onClick: () => done('close') });
    } else {
      buttons.push({ label: 'Close', danger: true, onClick: () => done('keep') });
    }
    dialogButtons(host, buttons);
  });
  if (!choice) return false;
  if (choice === 'close') {
    const closed = await attempt(async () => {
      await Promise.all(roomNames.map((name) => call('closeRoom', name)));
      return true;
    });
    if (!closed) return false;
  }
  return true;
};

/* ---------- Live status ---------- */

// Locking Windows takes its C: drive away, so every tab showing it goes back to Home, and nothing
// from it stays copied.
function leaveWindowsDrive() {
  for (const tab of state.tabs) {
    if (tab.kind !== 'files' || !inWindowsDrive(tab.path)) continue;
    if (tab === state.active) {
      navigate(HOME_PAGE);
    } else {
      tab.back.push(tab.path);
      tab.forward = [];
      tab.path = HOME_PAGE;
      tab.el.querySelector('.tab-title').textContent = 'Home';
      showPlaceIcon(tab);
    }
  }
  if (state.clipboard?.paths.some(inWindowsDrive)) state.clipboard = null;
}

async function refreshStatus() {
  try {
    const reported = await call('status');
    // When Docker can't answer, the last known rooms stay, rather than rooms seeming to vanish.
    const rooms = reported.rooms || state.status.rooms;
    const next = { ...reported, rooms, doorOpen: reported.doorOpen || rooms.some((room) => room.windowsDoor) };
    const changed = JSON.stringify(rooms) !== JSON.stringify(state.status.rooms);
    const doorChanged = next.doorOpen !== state.status.doorOpen;
    const driveChanged = Boolean(next.windowsDrive) !== Boolean(state.status.windowsDrive);
    state.status = next;
    if (driveChanged && !next.windowsDrive) leaveWindowsDrive();
    // Nothing on screen is rebuilt unless something it shows has changed.
    if (changed && atHome()) { drawHome(); renderChrome(); } else if (changed && state.active?.kind === 'files') renderEntries();
    else if (changed || doorChanged || driveChanged) renderChrome();
    else renderHouseNote();
  } catch { /* keep the last known status */ }
}

/* ---------- Live updates ---------- */

// A new version of these pages is ready (main.js, lib/live-update.js), so changes show without a
// restart. Styles change in place at once. Page code needs the page to load again: that waits
// until nobody's using this window (no key, click or scroll for a few seconds, and no menu, box,
// preview, rename or typing in a field), then every tab comes back as it was, with the same one in
// front. Terminals keep running through it and show again with all they printed.
const LIVE_QUIET_MS = 4000;
const LIVE_MARK = 'house-live-reload';
let lastUse = Date.now();
['keydown', 'pointerdown', 'wheel'].forEach((type) => window.addEventListener(type, () => { lastUse = Date.now(); }, { capture: true, passive: true }));
window.addEventListener('pointermove', (event) => { if (event.buttons) lastUse = Date.now(); }, true);

// Touchpad scroll recorder, for finding why scrolling feels off. Off unless the file
// ~/.config/house/scroll-log-on exists (checked once, at startup); then it adds nothing at all.
// On, it saves each wheel event to ~/.local/state/house/scroll-log.jsonl (last 5,000 lines, once a second).
call('paths').then(async ({ home }) => {
  await call('docRead', `${home}/.config/house/scroll-log-on`);
  const folder = `${home}/.local/state/house`;
  const file = `${folder}/scroll-log.jsonl`;
  await call('ensureFolder', folder);
  const old = await call('docRead', file).catch(() => null);
  let lines = old && old.text ? old.text.split('\n').filter(Boolean) : [];
  let before = 0;
  let dirty = false;
  const scroller = (node) => {
    for (; node && node !== document.documentElement; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
    }
    return document.scrollingElement;
  };
  window.addEventListener('wheel', (event) => {
    const now = performance.now();
    const box = scroller(event.target);
    lines.push(JSON.stringify({
      t: Math.round(now), gap: Math.round(now - before), dy: event.deltaY, dx: event.deltaX, mode: event.deltaMode, ctrl: event.ctrlKey,
      delay: Math.round(now - event.timeStamp), top: Math.round(box.scrollTop), height: box.scrollHeight, view: box.clientHeight,
    }));
    before = now;
    dirty = true;
  }, { capture: true, passive: true });
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    lines = lines.slice(-5000);
    call('docWrite', file, `${lines.join('\n')}\n`, null, { force: true }).catch(() => {});
  }, 1000);
}).catch(() => {});

function inUse() {
  if (Date.now() - lastUse < LIVE_QUIET_MS) return true;
  if (!menu.hidden || dialog.open || !preview.hidden || renaming) return true;
  const focused = document.activeElement;
  return Boolean(focused?.matches('input, textarea, [contenteditable="true"]') && !focused.closest('.xterm'));
}

window.house.on('live:style', ({ names = [] } = {}) => {
  document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
    const url = new URL(link.href);
    if (!names.includes(url.pathname.split('/').pop())) return;
    url.searchParams.set('v', String(Date.now()));
    const next = link.cloneNode();
    next.href = url.href;
    // The old one goes once the new one is in, so nothing shows unstyled in between.
    next.addEventListener('load', () => link.remove(), { once: true });
    next.addEventListener('error', () => next.remove(), { once: true });
    link.after(next);
  });
});

let liveWaiting = false;
// Ctrl+R: this window starts again, with its loading screen, the way a browser reloads a page. It
// uses the same hand-over as a new version: every tab comes back as it was with the same one in
// front, and room terminals keep running and join up again, so nothing in a room is touched.
// It's one smooth hand-over: the loading screen comes fully in first, and the note below lets the new
// page start with the window in the same place and the loading screen already in (again.js).
const RELOAD_MARK = 'house-ctrl-r';
const SPLASH_IN_MS = 260; // the white is in by 120 ms and the logo by 240 ms (style.css)
let reloading = false;
async function reloadWindow() {
  if (reloading) return;
  reloading = true;
  showSplash();
  const app = document.querySelector('.app');
  const note = {
    at: Date.now(),
    maximized: document.documentElement.classList.contains('maximized'),
    box: { left: app.style.left, top: app.style.top, width: app.style.width, height: app.style.height },
  };
  try { sessionStorage.setItem(RELOAD_MARK, JSON.stringify(note)); } catch { /* it starts with the loading screen anyway */ }
  await Promise.all([wait(SPLASH_IN_MS), flushDocs()]);
  const going = await call('liveReload', state.tabs.map(describeTab), state.tabs.indexOf(state.active)).catch(() => false);
  if (!going) window.location.reload(); // no tabs to keep: it starts like Station 256 does
}

window.house.on('live:reload', () => {
  if (liveWaiting) return;
  liveWaiting = true;
  const tryNow = async () => {
    if (inUse()) {
      setTimeout(tryNow, 1000);
      return;
    }
    try { sessionStorage.setItem(LIVE_MARK, '1'); } catch { /* it starts with the loading screen */ }
    await flushDocs();
    const going = await call('liveReload', state.tabs.map(describeTab), state.tabs.indexOf(state.active)).catch(() => false);
    if (going) return;
    liveWaiting = false;
    try { sessionStorage.removeItem(LIVE_MARK); } catch { /* nothing to undo */ }
  };
  tryNow();
});

/* ---------- Start ---------- */

// A window made from a tab opens straight away, with no loading screen (main.js adds ?tab). So does
// one loading its new version (above): it was already on screen. After Ctrl+R there's always one.
const madeFromTab = new URLSearchParams(window.location.search).has('tab');
const marked = (name) => {
  try {
    const found = sessionStorage.getItem(name) === '1';
    sessionStorage.removeItem(name);
    return found;
  } catch {
    return false;
  }
};
const liveReloaded = marked(LIVE_MARK);
// Ctrl+R's note (reloadWindow): when its loading screen came in, so the shortest time counts from then.
const ctrlNote = (() => {
  try {
    const note = JSON.parse(sessionStorage.getItem(RELOAD_MARK) || 'null');
    sessionStorage.removeItem(RELOAD_MARK);
    return note && typeof note === 'object' && Number.isFinite(note.at) ? note : null;
  } catch {
    return null;
  }
})();
const ctrlReloaded = Boolean(ctrlNote);
const quietStart = (madeFromTab || liveReloaded) && !ctrlReloaded;
// One full turn of the ring in all, counted from when the loading screen first showed.
const splashLongEnough = () => (ctrlNote
  ? wait(Math.max(0, ctrlNote.at + SPLASH_SHORTEST - Date.now()))
  : windowShown().then(() => wait(SPLASH_SHORTEST)));
if (quietStart) {
  splash().hidden = true;
  clearTimeout(splashLimit);
}

(async function start() {
  const opening = await call('windowStart').catch(() => null);
  if (opening) Object.assign(windowInfo, { count: opening.count, main: opening.main });
  const handed = Array.isArray(opening?.tabs) ? opening.tabs : [];
  if (!quietStart) showSplash();
  await loadNavPane();
  await loadColumns();
  await loadViewMode();
  await loadPrefs();
  Object.assign(state, await call('paths'));
  await attempt(() => call('ensureFolder', state.projects));
  // The tabs it was made from, in order, the last one in front. The window never waits on Docker,
  // which can be slow or stuck while the house starts.
  const added = [];
  for (const incoming of handed) added.push(await addMovedTab(incoming));
  if (!state.tabs.length) openFilesTab(HOME_PAGE);
  // After a new version loads, the tab that was in front is in front again.
  const front = Number.isInteger(opening?.front) ? added[opening.front] : null;
  if (front && state.tabs.includes(front)) activateTab(front);
  // A window made from a tab comes on screen only now, with its tab in (main.js).
  if (madeFromTab) call('windowFilled').catch(() => {});
  refreshStatus();
  // Room terminals that kept running while Station 256 was closed come back as tabs, screen and
  // all, in the main window (or in a window that crashed and started again: its own). The tab you're
  // on stays in front. Not awaited: it asks Docker, which can be slow.
  if (!handed.length) {
    restoring = call('termRestore').then((sessions) => {
      const showing = state.active;
      sessions.forEach((session) => adoptTerminal(session));
      if (sessions.length && showing) activateTab(showing);
    }).catch(() => {});
  }
  // Not awaited: a slow folder must not hold up the live status below.
  if (!madeFromTab) {
    Promise.all([loadFolder(), splashLongEnough()]).finally(() => {
      clearTimeout(splashLimit);
      hideSplash();
    });
  } else if (ctrlReloaded) {
    // A window of its own, started again with Ctrl+R: its tabs are already in.
    splashLongEnough().then(() => {
      clearTimeout(splashLimit);
      hideSplash();
    });
  }
  let checking = false;
  setInterval(async () => {
    if (checking) return;
    checking = true;
    await refreshStatus();
    checking = false;
  }, 3000);
}());

// Used only by the automated self-test.
window.houseTest = { state, windowInfo, activateTab, openTerminal, enterRoom, openAgents, navigate, closeRoom: (name) => call('closeRoom', name), popOutTab, dropTab, closeTab, refreshStatus, toggleSystem, showRules, showPreview, loadFolder, toggleDoor, ghost: { show: showTabGhost, move: moveTabGhost, land: landTabGhost, hide: hideTabGhost, el: tabGhost } };
