/* ---------- The video editor in a tab: OpenCut, made Station 256's own ---------- */

// Editor on a video's page opens the full editor (../editor, built from OpenCut) with that video in
// a project of its own on the timeline; opening the same video again goes back to that project.
// Exports save into the house beside the video. It runs as a <webview> in its own session, where
// it keeps its projects (lib/editor-app.js), and talks to Station through editor-preload.js.

const EDITOR_ORIGIN = 'station-editor://app';

const editorTab = () => state.tabs.find((tab) => tab.kind === 'editor');

// Opens the editor with this house file (null: its list of projects). One editor tab per window.
async function openEditor(target = null) {
  const url = target ? `${EDITOR_ORIGIN}/open/?path=${encodeURIComponent(target)}` : `${EDITOR_ORIGIN}/projects/`;
  return openEditorAt(url);
}

async function openEditorAt(url) {
  if (!String(url).startsWith(`${EDITOR_ORIGIN}/`)) return null;
  const open = editorTab();
  if (open) {
    activateTab(open);
    if (!/\/projects\/$/.test(url) || !open.view.getURL().startsWith(EDITOR_ORIGIN)) {
      saveEditor(open).then(() => open.view.loadURL(url)).catch(() => {});
    }
    return open;
  }
  let ready = false;
  try {
    ready = await call('editorReady');
  } catch (error) {
    if (/Unknown request/.test(String(error?.message))) {
      toast('The Editor works after Station 256 restarts.');
      return null;
    }
  }
  if (!ready) {
    await alertBox('The Editor isn\'t set up yet', 'It gets built when Station 256 is installed. Ask the AI to build the editor (bun run build in ~/house/editor).');
    return null;
  }
  if (editorTab()) return openEditorAt(url);
  const tab = { kind: 'editor', returnTo: state.active, host: el('div', 'doc-host ed-host') };
  const view = document.createElement('webview');
  view.className = 'ed-view';
  view.setAttribute('partition', 'persist:station-editor');
  view.setAttribute('src', url);
  tab.view = view;
  tab.host.append(view);
  tab.host.hidden = true;
  docArea.append(tab.host);
  hookEditor(tab);
  addTabElement(tab, 'Editor');
  state.tabs.push(tab);
  renderTabButtons();
  activateTab(tab);
  return tab;
}

function hookEditor(tab) {
  const { view } = tab;
  view.addEventListener('ipc-message', (event) => {
    const [value] = event.args || [];
    if (event.channel === 'reveal' && typeof value === 'string' && value.startsWith('/')) {
      openFilesTab(parentOf(value));
      openLocation({ path: value, folder: parentOf(value) });
    } else if (event.channel === 'key' && value && state.active === tab) {
      const lower = String(value.key).toLowerCase();
      if (value.key === 'Tab') cycleTab(value.shift ? -1 : 1);
      else if (lower === 'w') closeTab(tab);
      else if (lower === 't') openFilesTab(HOME_PAGE);
    }
  });
  // The tab says which project is open.
  view.addEventListener('page-title-updated', () => setEditorTitle(tab));
  view.addEventListener('did-navigate-in-page', () => setEditorTitle(tab));
  view.addEventListener('did-fail-load', (event) => {
    if (event.isMainFrame && event.errorCode !== -3) toast('The Editor couldn\'t load. Close its tab and try again.');
  });
}

function setEditorTitle(tab) {
  if (tab.closed) return;
  let title = 'Editor';
  try {
    const page = tab.view.getTitle();
    if (page && !/^Station 256 Editor$/.test(page)) title = `Editor: ${page.replace(/ [|–-] Station 256 Editor$/, '')}`;
  } catch { /* not loaded yet */ }
  tab.el.querySelector('.tab-title').textContent = title;
  if (state.active === tab) renderAddress();
}

// The editor saves a moment after each change; this saves now, before its page goes. (It no longer
// stops its page from going while a save is waiting: lib/editor-app.js.)
async function saveEditor(tab) {
  if (tab.closed) return;
  const wait = new Promise((resolve) => { setTimeout(resolve, 4000); });
  await Promise.race([tab.view.executeJavaScript('window.stationSave ? window.stationSave() : null').catch(() => {}), wait]);
}

function showEditor(tab) {
  $('item-count').textContent = '';
  requestAnimationFrame(() => {
    if (!tab.closed && state.active === tab) tab.view.focus();
  });
}

function closeEditor(tab) {
  if (tab.closed) return;
  tab.closed = true;
  tab.host.remove();
}

// The editor goes with the tab to another window, on the same page.
function editorDescription(tab) {
  let url = `${EDITOR_ORIGIN}/projects/`;
  try {
    const now = tab.view.getURL();
    if (now.startsWith(`${EDITOR_ORIGIN}/`)) url = now;
  } catch { /* not loaded yet */ }
  return { kind: 'editor', url };
}
