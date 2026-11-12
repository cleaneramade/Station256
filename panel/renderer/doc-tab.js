/* ---------- Files opened in a page of their own: Markdown, text and code ---------- */

// Double-clicking a Markdown, text or code file opens it in a tab, like House Rules, to read and
// change. Markdown shows as it reads, with its marks only where you type, as in Obsidian; a toolbar
// does bold, italic, underline, strikethrough, headings, lists, quotes, code and links. Text size
// is the page's own (no font choices). Changes save by themselves. When AI (or anything else)
// changes the file while it's open, the page takes the new text, or asks if you changed it too.
// The editor (vendor/editor.js, built from panel/editor) loads the first time a file opens.

const docArea = $('doc-area');
const MARKDOWN = /\.(md|markdown|mdown|mkd|mdx)$/i;
const PLAIN_TEXT = /\.(txt|text|log|csv|tsv|srt|vtt|nfo|me)$/i;
const NAMED_TEXT = /^(dockerfile|makefile|license|licence|readme|changelog|authors|contributing|notice|copying|gemfile|procfile|vagrantfile|\.?env(\..+)?|\.gitignore|\.gitattributes|\.dockerignore|\.editorconfig|\.npmrc|\.bashrc|\.zshrc|\.profile)$/i;
const DOC_SAVE_MS = 450;
const DOC_WATCH_MS = 1500;
const DOC_SIZES = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28];
const DOC_SIZE_DEFAULT = 15;

const opensAsDoc = (entry) => !entry.isDir && (MARKDOWN.test(entry.name) || TEXTISH.test(entry.name) || PLAIN_TEXT.test(entry.name)
  || NAMED_TEXT.test(entry.name) || !/\.[^./]+$/.test(entry.name));

function docKind(name) {
  if (MARKDOWN.test(name)) return 'markdown';
  const ext = (/\.([^./]+)$/.exec(name) || [])[1] || (/^dockerfile$/i.test(name) ? 'dockerfile' : '');
  if (ext && window.StationEditor?.languageFor(ext)) return 'code';
  return 'text';
}

let editorLoading = null;
function loadEditor() {
  if (window.StationEditor) return Promise.resolve();
  if (!editorLoading) {
    editorLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/editor.js';
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => {
        editorLoading = null;
        script.remove();
        reject(new Error('The editor couldn\'t load.'));
      }, { once: true });
      document.head.append(script);
    });
  }
  return editorLoading;
}

const docSize = () => {
  const size = Number(prefs.docSize);
  return DOC_SIZES.includes(size) ? size : DOC_SIZE_DEFAULT;
};
call('prefs').then((saved) => { if (DOC_SIZES.includes(Number(saved?.docSize))) prefs.docSize = Number(saved.docSize); }).catch(() => {});

// Opens the file in its page, or goes to it if it's already open in this window. Binary files and
// ones too big go to the preview instead.
async function openDoc(target) {
  const open = () => state.tabs.find((tab) => tab.kind === 'doc' && tab.path === target);
  if (open()) {
    activateTab(open());
    return open();
  }
  const reading = call('docRead', target).catch(async (error) => {
    // Until Station 256 restarts after an update, the part that reads files for pages isn't there yet.
    if (/Unknown request/.test(String(error?.message))) return { binary: true, waiting: true };
    await alertBox('That didn\'t work', cleanError(error));
    return null;
  });
  const [doc] = await Promise.all([reading, loadEditor().catch(() => null)]);
  if (!doc) return null;
  if (open()) {
    activateTab(open());
    return open();
  }
  if (doc.binary || doc.tooBig || !window.StationEditor) {
    const entry = { path: target, name: baseName(target), isDir: false, size: doc.size || 0, mtime: doc.mtime || 0 };
    if (doc.waiting) toast('Changing files here works after Station 256 restarts.');
    else if (doc.tooBig) toast('This file is too big to change here, so it opens to look at.');
    else if (!window.StationEditor) toast('The editor couldn\'t load, so it opens to look at.');
    showPreview(entry);
    return null;
  }
  const tab = { kind: 'doc', path: target, returnTo: state.active, host: el('div', 'doc-host') };
  tab.host.hidden = true;
  docArea.append(tab.host);
  buildDoc(tab, doc);
  addTabElement(tab, baseName(target));
  state.tabs.push(tab);
  renderTabButtons();
  activateTab(tab);
  return tab;
}

function toolButton(iconName, title, run) {
  const button = el('button', 'doc-tool');
  button.type = 'button';
  button.title = title;
  button.append(icon(iconName));
  button.addEventListener('mousedown', (event) => event.preventDefault()); // the text keeps its cursor
  button.addEventListener('click', run);
  return button;
}

const HEADINGS = [
  ['heading0', 'Normal text'],
  ['heading1', 'Heading 1'],
  ['heading2', 'Heading 2'],
  ['heading3', 'Heading 3'],
  ['heading4', 'Heading 4'],
];

function buildDoc(tab, doc) {
  const kind = docKind(baseName(tab.path));
  tab.docKind = kind;
  tab.mtime = doc.mtime;
  tab.saved = doc.text;
  tab.bom = doc.bom;
  tab.readOnly = doc.readOnly;
  tab.lossy = doc.lossy;
  tab.windowsFile = inWindowsDrive(tab.path);

  const head = el('div', 'doc-head');
  const titleRow = el('div', 'doc-title-row');
  const name = el('span', 'doc-name', baseName(tab.path));
  name.title = windowsPath(tab.path);
  tab.statusEl = el('span', 'doc-status');
  titleRow.append(fileIcon({ name: baseName(tab.path), path: tab.path }), name, tab.statusEl, el('div', 'grow'));
  if (kind === 'markdown') {
    // As it reads (marks only where you type), or every mark showing.
    const modes = el('div', 'segmented doc-modes');
    tab.modeButtons = [['live', 'Reading view while you type: marks show only where you are'], ['source', 'Every mark showing']].map(([mode, title]) => {
      const button = el('button', `segment${mode === 'live' ? ' on' : ''}`, mode === 'live' ? 'Live' : 'Source');
      button.type = 'button';
      button.title = title;
      button.addEventListener('click', () => {
        tab.editor.setLive(mode === 'live');
        tab.modeButtons.forEach((other) => other.classList.toggle('on', other === button));
        tab.editor.focus();
      });
      modes.append(button);
      return button;
    });
    titleRow.append(modes);
  }
  const more = toolButton('more_horizontal', 'More', (event) => menuUnder(event.currentTarget, docMenuItems(tab)));
  titleRow.append(more);
  head.append(titleRow);

  const tools = el('div', 'doc-tools');
  tab.formatButtons = new Map();
  const format = (name, iconName, title) => {
    const button = toolButton(iconName, title, () => tab.editor.run(name));
    tab.formatButtons.set(name, button);
    return button;
  };
  const gap = () => el('span', 'doc-tool-gap');
  if (kind === 'markdown') {
    tab.headingButton = el('button', 'doc-heading-pick');
    tab.headingButton.type = 'button';
    tab.headingButton.title = 'Text style';
    tab.headingLabel = el('span', '', 'Normal text');
    tab.headingButton.append(tab.headingLabel, icon('chevron_down'));
    tab.headingButton.addEventListener('mousedown', (event) => event.preventDefault());
    tab.headingButton.addEventListener('click', (event) => menuUnder(event.currentTarget, HEADINGS.map(([command, label]) => ({
      label, icon: command === 'heading0' ? 'text_paragraph' : 'text_header_1', run: () => tab.editor.run(command),
    }))));
    tools.append(
      tab.headingButton, gap(),
      format('bold', 'text_bold', 'Bold (Ctrl+B)'),
      format('italic', 'text_italic', 'Italic (Ctrl+I)'),
      format('underline', 'text_underline', 'Underline (Ctrl+U)'),
      format('strike', 'text_strikethrough', 'Strikethrough (Ctrl+Shift+X)'),
      gap(),
      format('bullet', 'text_bullet_list_ltr', 'Bulleted list'),
      format('number', 'text_number_list_ltr', 'Numbered list'),
      format('task', 'task_list_ltr', 'Checklist (Ctrl+Enter ticks)'),
      gap(),
      format('quote', 'text_quote', 'Quote'),
      format('code', 'code', 'Code (Ctrl+E)'),
      format('link', 'link', 'Link (Ctrl+K)'),
      format('rule', 'line_horizontal_1', 'Divider line'),
      format('table', 'table', 'Insert table'),
    );
  } else {
    tools.append(toolButton('search', 'Find and replace (Ctrl+F)', () => tab.editor.find()));
  }
  tools.append(el('div', 'grow'));
  // Text size: the page's own, kept for every file.
  const smaller = toolButton('subtract', 'Smaller text', () => setDocSize(-1));
  tab.sizeLabel = el('button', 'doc-size', '100%');
  tab.sizeLabel.type = 'button';
  tab.sizeLabel.title = 'Text size (click for normal)';
  tab.sizeLabel.addEventListener('mousedown', (event) => event.preventDefault());
  tab.sizeLabel.addEventListener('click', () => setDocSize(0));
  const larger = toolButton('add', 'Larger text', () => setDocSize(1));
  const sizeBox = el('div', 'doc-size-box');
  sizeBox.title = 'Text size';
  sizeBox.append(icon('text_font_size', 'doc-size-icon'), smaller, tab.sizeLabel, larger);
  tools.append(sizeBox);
  head.append(tools);

  tab.banner = el('div', 'doc-banner');
  tab.banner.hidden = true;
  const editorBox = el('div', 'doc-editor');
  tab.host.append(head, tab.banner, editorBox);

  tab.editor = window.StationEditor.create({
    parent: editorBox,
    text: doc.text,
    kind,
    ext: (/\.([^./]+)$/.exec(baseName(tab.path)) || [])[1] || (/^dockerfile$/i.test(baseName(tab.path)) ? 'dockerfile' : ''),
    readOnly: doc.readOnly,
    crlf: doc.crlf,
    onChange: () => scheduleSave(tab),
    onCursor: () => {
      showFormats(tab);
      showDocCount(tab);
    },
    onSave: () => saveDoc(tab),
    openLink: (href) => openDocLink(tab, href),
    imageUrl: (src) => docImageUrl(tab, src),
  });
  tab.saved = tab.editor.getText(); // the editor's own reading of the file: unchanged means nothing to save
  applyDocSize(tab);
  setDocStatus(tab);
  showFormats(tab);
}

function docMenuItems(tab) {
  const entry = { path: tab.path, name: baseName(tab.path), folder: parentOf(tab.path) };
  return [
    { label: 'Open File Location', icon: 'folder_open', run: () => { openFilesTab(parentOf(tab.path)); openLocation(entry); } },
    { label: 'Copy as Path', icon: 'link', run: () => copyAsPath([tab.path]) },
    { label: 'Open With…', icon: 'open', run: () => openInWindows(entry, true) },
    '-',
    { label: 'Load Again from Disk', icon: 'arrow_clockwise', run: () => reloadDoc(tab, true) },
  ];
}

// A link in a note: web links open in Windows' browser; a link to another file opens it here.
function openDocLink(tab, href) {
  if (/^(https?:)?\/\//i.test(href) || /^www\./i.test(href)) {
    call('openLink', /^www\./i.test(href) ? `https://${href}` : href).catch((error) => toast(cleanError(error)));
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return;
  const target = docPath(tab, decodeURIComponent(href.split('#')[0]));
  if (!target) return;
  const entry = { path: target, name: baseName(target), isDir: false, folder: parentOf(target) };
  if (opensAsDoc(entry)) openDoc(target);
  else showPreview(entry);
}

function docPath(tab, relative) {
  if (!relative) return null;
  const parts = (relative.startsWith('/') ? relative : `${parentOf(tab.path)}/${relative}`).split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

function docImageUrl(tab, src) {
  if (/^data:image\//i.test(src)) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return ''; // only the house's own pictures load
  const target = docPath(tab, decodeURIComponent(src.split(/[?#]/)[0]));
  return target ? fileUrl(target) : '';
}

function showFormats(tab) {
  if (!tab.formatButtons?.size) return;
  const on = tab.editor.formats();
  tab.formatButtons.forEach((button, name) => button.classList.toggle('on', on.has(name)));
  const heading = HEADINGS.find(([command]) => command !== 'heading0' && on.has(command));
  tab.headingLabel.textContent = heading ? heading[1] : 'Normal text';
}

// The status bar, as a text editor's: where the cursor is, and how many words.
let docCountFrame = 0;
function showDocCount(tab) {
  if (state.active !== tab || docCountFrame) return;
  docCountFrame = requestAnimationFrame(() => {
    docCountFrame = 0;
    if (state.active !== tab || tab.closed) return;
    const { line, column, words, picked } = tab.editor.stats();
    const parts = [`Line ${line}, Column ${column}`];
    if (words !== null) parts.push(`${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`);
    if (picked) parts.push(`${picked.toLocaleString()} picked`);
    $('item-count').textContent = parts.join('   ');
  });
}

// The address bar shows the file's folders (each opens in a new tab) and its name.
function docAddress(address, tab) {
  const windows = inWindowsDrive(tab.path);
  address.append(icon('desktop', 'address-icon'), icon('chevron_right', 'crumb-sep'));
  const crumb = (label, target) => {
    const button = el('button', 'crumb', label);
    button.dataset.path = target;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openFilesTab(target);
    });
    address.append(button, icon('chevron_right', 'crumb-sep'));
  };
  crumb(windows ? 'Windows (C:)' : 'Linux House (L:)', windows ? state.windows : '/');
  let built = windows ? state.windows : '';
  parentOf(tab.path).slice(built.length).split('/').filter(Boolean).forEach((part) => {
    built += `/${part}`;
    crumb(built === state.projects ? 'Projects' : part, built);
  });
  address.append(el('span', 'crumb plain', baseName(tab.path)));
  fitAddress();
}

function setDocSize(step) {
  const now = docSize();
  const index = DOC_SIZES.indexOf(now);
  const next = step === 0 ? DOC_SIZE_DEFAULT : DOC_SIZES[Math.max(0, Math.min(DOC_SIZES.length - 1, index + step))];
  prefs.docSize = next;
  call('setPrefs', { docSize: next }).catch(() => {});
  state.tabs.filter((tab) => tab.kind === 'doc').forEach(applyDocSize);
}

function applyDocSize(tab) {
  const size = docSize();
  tab.host.style.setProperty('--editor-size', `${size}px`);
  tab.sizeLabel.textContent = `${Math.round((size / DOC_SIZE_DEFAULT) * 100)}%`;
}

/* Saving */

function setDocStatus(tab, override) {
  const node = tab.statusEl;
  node.className = 'doc-status';
  node.replaceChildren();
  let text;
  let title = '';
  if (override) {
    ({ text, title = '' } = override);
    if (override.bad) node.classList.add('bad');
  } else if (tab.readOnly) {
    node.classList.add('locked');
    node.append(icon('lock_closed-filled'));
    text = 'Read only';
    title = tab.lossy ? 'This file\'s letters are stored in an older way, and saving here would change them. So it\'s view only.'
      : tab.windowsFile ? 'Windows files are view only here. Copy it to the house to change it.' : 'This file can\'t be changed from here.';
  } else if (tab.saving || tab.saveTimer) {
    text = 'Saving…';
  } else {
    node.append(icon('checkmark'));
    text = 'Saved';
  }
  node.append(el('span', '', text));
  node.title = title;
}

function scheduleSave(tab) {
  if (tab.readOnly) return;
  clearTimeout(tab.saveTimer);
  tab.saveTimer = setTimeout(() => saveDoc(tab), DOC_SAVE_MS);
  setDocStatus(tab);
}

async function saveDoc(tab, force = false) {
  clearTimeout(tab.saveTimer);
  tab.saveTimer = null;
  if (tab.readOnly || tab.closed) return true;
  if (tab.saving) {
    tab.saveAgain = true;
    return tab.saving;
  }
  const text = tab.editor.getText();
  if (text === tab.saved && !force) {
    setDocStatus(tab);
    return true;
  }
  let finished;
  tab.saving = new Promise((resolve) => { finished = resolve; });
  setDocStatus(tab);
  let ok = false;
  try {
    const result = await call('docWrite', tab.path, text, tab.mtime, { force, bom: tab.bom });
    if (result?.conflict) {
      showConflict(tab);
    } else {
      tab.mtime = result.mtime;
      tab.saved = text;
      ok = true;
    }
  } catch (error) {
    setDocStatus(tab, { text: 'Not saved', title: cleanError(error), bad: true });
    finished(false);
    tab.saving = null;
    return false;
  }
  tab.saving = null;
  finished(ok);
  if (tab.saveAgain) {
    tab.saveAgain = false;
    return saveDoc(tab);
  }
  if (ok) setDocStatus(tab);
  return ok;
}

// Every open file saved, before the window reloads or closes.
async function flushDocs() {
  await Promise.all(state.tabs.filter((tab) => tab.kind === 'doc' && !tab.readOnly).map((tab) => saveDoc(tab).catch(() => false)));
}

/* Changes from outside: AI, a room, another program */

function showBanner(tab, text, buttons) {
  tab.banner.replaceChildren(icon('warning', 'doc-banner-icon'), el('span', 'doc-banner-text', text));
  buttons.forEach(({ label, primary, run }) => {
    const button = el('button', `btn${primary ? ' primary' : ''}`, label);
    button.type = 'button';
    button.addEventListener('click', run);
    tab.banner.append(button);
  });
  tab.banner.hidden = false;
}

function hideBanner(tab) {
  tab.banner.hidden = true;
  tab.banner.replaceChildren();
  tab.conflict = false;
}

function showConflict(tab) {
  tab.conflict = true;
  setDocStatus(tab, { text: 'Not saved', title: 'The file changed outside while you were changing it.', bad: true });
  showBanner(tab, 'This file was changed outside Station 256 (maybe by AI) while you were typing.', [
    { label: 'Use Theirs', run: () => reloadDoc(tab, true) },
    { label: 'Keep Mine', primary: true, run: () => { hideBanner(tab); saveDoc(tab, true); } },
  ]);
}

async function reloadDoc(tab, quiet = false) {
  const doc = await attempt(() => call('docRead', tab.path));
  if (!doc || tab.closed) return;
  if (doc.binary || doc.tooBig) {
    toast('This file isn\'t text any more, so it can\'t be shown here.');
    return;
  }
  hideBanner(tab);
  tab.mtime = doc.mtime;
  tab.saved = doc.text;
  tab.bom = doc.bom;
  tab.lossy = doc.lossy;
  if (tab.readOnly !== doc.readOnly) {
    tab.readOnly = doc.readOnly;
    tab.editor.setReadOnly(doc.readOnly);
  }
  if (tab.editor.getText() !== doc.text) tab.editor.setText(doc.text);
  tab.saved = tab.editor.getText();
  setDocStatus(tab);
  if (!quiet) flashDocStatus(tab, 'Updated: it changed outside');
}

function flashDocStatus(tab, text) {
  setDocStatus(tab, { text });
  clearTimeout(tab.flashTimer);
  tab.flashTimer = setTimeout(() => { if (!tab.closed && !tab.conflict) setDocStatus(tab); }, 2500);
}

async function checkDoc(tab) {
  if (tab.closed || tab.checking || tab.saving || tab.conflict) return;
  tab.checking = true;
  try {
    const now = await call('docStat', tab.path).catch(() => null);
    if (!now || tab.closed || tab.saving) return;
    if (now.gone) {
      if (!tab.gone) {
        tab.gone = true;
        showBanner(tab, 'This file was moved or deleted. What you see here isn\'t saved anywhere.', [
          { label: 'Close', run: () => closeTab(tab) },
          ...(tab.readOnly ? [] : [{ label: 'Save It Again', primary: true, run: async () => { tab.gone = false; hideBanner(tab); tab.mtime = null; await saveDoc(tab, true); } }]),
        ]);
      }
      return;
    }
    if (tab.gone) {
      tab.gone = false;
      hideBanner(tab);
    }
    if (now.mtime === tab.mtime) return;
    const mine = tab.editor.getText() !== tab.saved || tab.saveTimer;
    if (mine) showConflict(tab);
    else await reloadDoc(tab);
  } finally {
    tab.checking = false;
  }
}

setInterval(() => {
  if (document.visibilityState !== 'visible' || state.active?.kind !== 'doc') return;
  checkDoc(state.active);
}, DOC_WATCH_MS);

// The tab is shown: its text is checked at once, and the cursor goes back in.
function showDoc(tab) {
  checkDoc(tab);
  requestAnimationFrame(() => {
    if (tab.closed || state.active !== tab) return;
    tab.editor.focus();
    showDocCount(tab);
  });
}

// Before a tab closes by hand: what's typed is saved, and if that can't be done (the file changed
// outside, the disk said no) it asks, so nothing typed is lost without a word.
async function docMayClose(tab) {
  if (tab.readOnly || tab.closed) return true;
  if (await saveDoc(tab).catch(() => false)) return true;
  return confirmBox('Close without saving?', 'This file couldn\'t be saved. What you changed here will be lost.', 'Close', true);
}

// The tab is closing: what's typed is saved first.
async function closeDoc(tab) {
  if (tab.closed) return;
  await saveDoc(tab).catch(() => {});
  tab.closed = true;
  clearTimeout(tab.saveTimer);
  clearTimeout(tab.flashTimer);
  tab.editor?.destroy();
  tab.host.remove();
}

// Keys for a file's page. Ctrl+W, Ctrl+T and Ctrl+Tab work as on other tabs; the rest belong to the editor.
document.addEventListener('keydown', (event) => {
  if (state.active?.kind !== 'doc' || dialog.open || !preview.hidden || !event.ctrlKey || event.altKey) return;
  const lower = event.key.toLowerCase();
  if (event.key === 'Tab') { event.preventDefault(); cycleTab(event.shiftKey ? -1 : 1); }
  else if (!event.shiftKey && lower === 'w') { event.preventDefault(); closeTab(state.active); }
  else if (!event.shiftKey && lower === 't') { event.preventDefault(); openFilesTab(HOME_PAGE); }
});

window.addEventListener('beforeunload', () => { flushDocs(); });
