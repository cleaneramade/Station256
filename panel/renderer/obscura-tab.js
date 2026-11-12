/* ---------- Obscura: a web browser in a tab ---------- */

// A web page in a <webview> of its own (lib/obscura.js shuts it in: its own session, no Node, no
// permissions, no house files). The tab has Back, Forward, Reload, an address bar, a loading bar,
// and find in page. The page's title and picture become the tab's name and icon. Other features
// open a page with openInObscura(url).

const OBSCURA_PARTITION = 'persist:obscura';
const OBSCURA_SEARCH = 'https://duckduckgo.com/?q=';
// What the address bar's text means: a web address ({ url }), a search ({ url }), or a no ({ error }).
function obscuraAddress(text) {
  const typed = String(text || '').trim();
  if (!typed) return null;
  const search = () => ({ url: OBSCURA_SEARCH + encodeURIComponent(typed) });
  if (/\s/.test(typed)) return search();
  // localhost:3000 and other host:port, or a host with a dot, with no http:// in front.
  const bare = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|[^\s/:?#@]+\.[^\s/:?#@]+)(:\d+)?([/?#].*)?$/i.exec(typed);
  if (bare && !/^[a-z][a-z0-9+.-]*:\/\//i.test(typed)) {
    const local = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])$/i.test(bare[1]);
    return { url: `${local ? 'http' : 'https'}://${typed}` };
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(typed);
  if (scheme) {
    if (/^https?$/i.test(scheme[1])) {
      try { return { url: new URL(typed).href }; } catch { return { error: 'That isn\'t a web address.' }; }
    }
    if (/^about:blank$/i.test(typed)) return { url: 'about:blank' };
    return { error: 'The browser only opens web pages (http and https).' };
  }
  return search();
}

// Reasons a page may not have loaded because the network isn't there (not the page's own fault).
const OBSCURA_NO_NETWORK = new Set([-2, -7, -21, -100, -101, -102, -105, -106, -109, -118, -130, -137]);

function openInObscura(url) {
  const asked = url ? obscuraAddress(url) : null;
  if (url && (!asked || asked.error || !/^https?:\/\//i.test(asked.url))) return null;
  return openObscura(asked ? asked.url : null);
}

function openObscura(url = null) {
  const tab = { kind: 'obscura', returnTo: state.active, host: el('div', 'doc-host ob-host'), url: url || '', zoom: 1, loading: false };
  const button = (name, title, label) => {
    const node = el('button', 'tool ob-btn');
    node.type = 'button';
    node.title = title;
    node.setAttribute('aria-label', label || title);
    node.append(icon(name));
    return node;
  };
  const back = button('arrow_left', 'Back (Alt+Left)');
  const forward = button('arrow_right', 'Forward (Alt+Right)');
  const reload = button('arrow_clockwise', 'Reload (F5)');
  const lock = icon('lock_open-filled', 'ob-lock');
  lock.hidden = true;
  const input = el('input', 'ob-address');
  input.type = 'text';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Web address');
  input.placeholder = 'Search or type a web address';
  const field = el('div', 'ob-field');
  field.append(lock, input);
  // On the right: which project this page belongs to, which AI is using it (hidden until set), and
  // the page in Windows' own browser. One compact row, so the page gets everything else.
  const project = el('span', 'ob-chip', 'Not tied to a project');
  const agent = el('span', 'ob-chip ob-chip-agent');
  agent.hidden = true;
  // While an AI from a project's room is using this tab (lib/ai-browser.js): Stop takes it back.
  const aiStop = el('button', 'ob-ai-stop', 'Stop');
  aiStop.type = 'button';
  aiStop.title = 'Take this page back from the AI';
  aiStop.hidden = true;
  const outside = el('button', 'ob-outside');
  outside.type = 'button';
  outside.title = 'Open this page in your browser on Windows';
  outside.append(icon('open'), el('span', '', 'Open in browser'));
  const bar = el('div', 'ob-bar');
  bar.append(back, forward, reload, field, project, agent, aiStop, outside);
  const progress = el('div', 'ob-load');
  progress.hidden = true;
  const note = el('div', 'ob-note');
  note.hidden = true;
  // Find in page.
  const findBar = el('div', 'ob-find');
  findBar.hidden = true;
  const findInput = el('input', 'ob-find-input');
  findInput.type = 'text';
  findInput.placeholder = 'Find in page';
  const findCount = el('span', 'ob-find-count');
  const findPrev = button('chevron_up', 'Previous match (Shift+Enter)');
  const findNext = button('chevron_down', 'Next match (Enter)');
  const findClose = button('dismiss', 'Close (Esc)');
  findBar.append(findInput, findCount, findPrev, findNext, findClose);
  // The page, and a plain message over it when there's no page to show.
  const stage = el('div', 'ob-stage');
  const view = document.createElement('webview');
  view.className = 'ob-view';
  view.setAttribute('partition', OBSCURA_PARTITION);
  view.setAttribute('src', url || 'about:blank');
  const message = el('div', 'ob-message');
  const aiDot = el('div', 'ob-ai-dot');
  aiDot.hidden = true;
  stage.append(view, message, aiDot);
  tab.host.append(bar, progress, note, findBar, stage);
  tab.host.hidden = true;
  tab.view = view;
  tab.input = input;
  Object.assign(tab, { outside, project, agent, aiStop, aiDot, back, forward, reload, lock, progress, note, findBar, findInput, findCount, message });
  docArea.append(tab.host);

  showObscuraStart(tab);
  hookObscura(tab);
  outside.addEventListener('click', () => { if (/^https?:\/\//i.test(tab.url)) attempt(() => call('openLink', tab.url)); });
  aiStop.addEventListener('click', () => stopAiBrowser(tab));
  addTabElement(tab, 'New tab');
  state.tabs.push(tab);
  renderTabButtons();
  activateTab(tab);
  return tab;
}

// What the info area on the right says. Other features fill it: { project: 'Name', agent: 'Claude' }.
// No project: "Not tied to a project". No agent: its chip stays hidden.
function setObscuraInfo(info = {}, tab = state.active) {
  if (tab?.kind !== 'obscura') return;
  tab.project.textContent = info.project || 'Not tied to a project';
  tab.project.classList.toggle('set', !!info.project);
  tab.agent.textContent = info.agent || '';
  tab.agent.hidden = !info.agent;
}

function showObscuraMessage(tab, title, text) {
  tab.message.replaceChildren(el('h2', 'ob-message-title', title), el('p', 'ob-message-text', text));
  tab.message.hidden = false;
}

// The sites a new tab offers: the ones visited most (kept in the app's prefs, like its other small
// settings), or a few good starts when there is no history yet.
const OBSCURA_DEFAULT_SITES = [
  { url: 'https://en.wikipedia.org', name: 'Wikipedia' },
  { url: 'https://duckduckgo.com', name: 'DuckDuckGo' },
  { url: 'https://github.com', name: 'GitHub' },
  { url: 'https://www.youtube.com', name: 'YouTube' },
];
let obscuraSites = null; // [{ url (the site's front door), name, count, fav }], loaded once from the prefs
const obscuraSitesReady = () => (obscuraSites ? Promise.resolve(obscuraSites) : call('prefs').catch(() => ({})).then((saved) => {
  obscuraSites = obscuraSites || (Array.isArray(saved.sites) ? saved.sites.filter((site) => /^https?:\/\//.test(site?.url)) : []);
  return obscuraSites;
}));
const saveObscuraSites = () => call('setPrefs', { sites: obscuraSites.slice(0, 24) }).catch(() => {});

// A page opened in a tab (not an AI's, not a project's preview): count its site.
function rememberObscuraSite(tab, url, favicon) {
  if (!obscuraSites || tab.aiOf || tab.previewOf || !/^https?:\/\//i.test(url)) return;
  let origin;
  try { origin = new URL(url).origin; } catch { return; }
  if (/^https?:\/\/(localhost|\d{1,3}(\.\d{1,3}){3}|\[)/i.test(origin)) return;
  let site = obscuraSites.find((other) => other.url === origin);
  if (!site) {
    site = { url: origin, name: obscuraHost(origin).replace(/^www\./, ''), count: 0 };
    obscuraSites.push(site);
  }
  if (favicon === undefined) site.count += 1;
  else if (favicon.length < 3000) site.fav = favicon; // shortcut: big pictures are not kept, so prefs stay small
  obscuraSites.sort((a, b) => b.count - a.count);
  saveObscuraSites();
}

// A new tab's page: Station's logo, a big search box (the address bar's own rules), and tiles.
function showObscuraStart(tab) {
  if (tab.url) {
    tab.message.hidden = true;
    return;
  }
  const logo = el('img', 'ob-logo');
  logo.src = 'station-256.png';
  logo.alt = '';
  const box = el('input', 'ob-home-search');
  box.type = 'text';
  box.spellcheck = false;
  box.autofocus = true;
  box.placeholder = 'Search the web or type an address';
  box.setAttribute('aria-label', 'Search the web or type an address');
  box.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    goObscura(tab, box.value);
  });
  const tiles = el('div', 'ob-tiles');
  tab.homeBox = box;
  tab.message.className = 'ob-message ob-home';
  tab.message.replaceChildren(el('div', 'ob-home-inner'));
  tab.message.firstChild.append(logo, box, tiles);
  tab.message.hidden = false;
  const draw = () => {
    const mine = obscuraSites.slice(0, 8);
    tiles.replaceChildren(...(mine.length ? mine : OBSCURA_DEFAULT_SITES).map((site) => {
      const tile = el('div', 'ob-tile');
      const open = el('button', 'ob-tile-open');
      open.type = 'button';
      open.title = site.url;
      const badge = site.fav ? el('img', 'ob-tile-pic') : el('span', 'ob-tile-pic ob-tile-letter', (site.name || '?')[0].toUpperCase());
      if (site.fav) { badge.src = site.fav; badge.alt = ''; }
      open.append(badge, el('span', 'ob-tile-name', site.name));
      open.addEventListener('click', () => goObscura(tab, site.url));
      tile.append(open);
      if (mine.length) {
        const gone = el('button', 'ob-tile-x', '×');
        gone.type = 'button';
        gone.title = `Remove ${site.name} from this list`;
        gone.setAttribute('aria-label', gone.title);
        gone.addEventListener('click', () => {
          obscuraSites.splice(obscuraSites.indexOf(site), 1);
          saveObscuraSites();
          draw();
        });
        tile.append(gone);
      }
      return tile;
    }));
  };
  obscuraSitesReady().then(draw);
}

// A short line under the address bar ("Saved to Downloads: name.zip"); it goes away by itself.
function obscuraNote(tab, text) {
  tab.note.textContent = text;
  tab.note.hidden = false;
  clearTimeout(tab.noteTimer);
  tab.noteTimer = setTimeout(() => { tab.note.hidden = true; }, 9000);
}

// Go to what was typed. Only web addresses: file: and the rest are refused here, and again by main.
function goObscura(tab, text) {
  const asked = obscuraAddress(text);
  if (!asked) return;
  if (asked.error) {
    obscuraNote(tab, asked.error);
    return;
  }
  tab.message.hidden = true;
  tab.url = asked.url;
  tab.input.value = asked.url;
  try {
    tab.view.loadURL(asked.url).catch(() => {}); // a page that fails is shown by did-fail-load
  } catch {
    tab.view.setAttribute('src', asked.url);
  }
  tab.view.focus();
}

function setObscuraTitle(tab, title, favicon) {
  if (tab.closed) return;
  const label = String(title || '').trim() || (tab.url ? obscuraHost(tab.url) : 'New tab');
  tab.el.querySelector('.tab-title').textContent = label.length > 40 ? `${label.slice(0, 39)}…` : label;
  const picture = tab.el.querySelector('.tab-term-icon');
  if (favicon !== undefined) tab.favicon = favicon;
  if (tab.favicon) {
    picture.style.maskImage = 'none';
    picture.style.background = `center / contain no-repeat url("${tab.favicon}")`;
  } else {
    picture.style.background = '';
    setIcon(picture, 'link');
  }
  if (state.active === tab) renderAddress();
}

function obscuraHost(url) {
  try { return new URL(url).host || url; } catch { return url; }
}

// The address bar shows the page's address, with a lock for https and an open lock for http.
function obscuraShowAddress(tab, url) {
  const real = /^https?:\/\//i.test(url);
  // Only words being typed are kept; an empty bar (a new tab, or a page an AI opened) shows the address.
  const typing = document.activeElement === tab.input && tab.input.value && tab.input.value !== tab.url;
  tab.url = real ? url : '';
  if (!typing) tab.input.value = real ? url : '';
  tab.lock.hidden = !real;
  if (real) {
    const secure = /^https:/i.test(url);
    setIcon(tab.lock, secure ? 'lock_closed-filled' : 'lock_open-filled');
    tab.lock.classList.toggle('insecure', !secure);
    tab.lock.title = secure ? 'The connection is secure (https)' : 'Not secure: this page is sent without encryption (http)';
  }
  try {
    tab.back.disabled = !tab.view.canGoBack();
    tab.forward.disabled = !tab.view.canGoForward();
  } catch { /* not ready yet */ }
}

function hookObscura(tab) {
  const { view } = tab;
  tab.back.disabled = true;
  tab.forward.disabled = true;
  tab.back.addEventListener('click', () => { if (view.canGoBack()) view.goBack(); });
  tab.forward.addEventListener('click', () => { if (view.canGoForward()) view.goForward(); });
  tab.reload.addEventListener('click', () => (tab.loading ? view.stop() : reloadObscura(tab)));
  tab.input.addEventListener('focus', () => tab.input.select());
  tab.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      goObscura(tab, tab.input.value);
    } else if (event.key === 'Escape') {
      tab.input.value = tab.url;
      tab.input.blur();
      view.focus();
    }
  });
  const setLoading = (on) => {
    tab.loading = on;
    tab.progress.hidden = !on;
    tab.reload.replaceChildren(icon(on ? 'dismiss' : 'arrow_clockwise'));
    tab.reload.title = on ? 'Stop (Esc)' : 'Reload (F5)';
    tab.reload.setAttribute('aria-label', on ? 'Stop' : 'Reload');
  };
  view.addEventListener('did-start-loading', () => setLoading(true));
  view.addEventListener('did-stop-loading', () => {
    setLoading(false);
    try { obscuraShowAddress(tab, view.getURL()); } catch { /* gone */ }
  });
  view.addEventListener('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isInPlace && /^https?:/i.test(event.url)) {
      tab.message.hidden = true;
      tab.favicon = null;
    }
  });
  view.addEventListener('did-navigate', (event) => {
    obscuraShowAddress(tab, event.url);
    obscuraSitesReady().then(() => rememberObscuraSite(tab, event.url));
  });
  view.addEventListener('did-navigate-in-page', (event) => { if (event.isMainFrame) obscuraShowAddress(tab, event.url); });
  view.addEventListener('page-title-updated', (event) => setObscuraTitle(tab, event.title));
  view.addEventListener('dom-ready', () => {
    try {
      tab.wcId = view.getWebContentsId();
      view.setZoomFactor(tab.zoom);
    } catch { /* gone */ }
  });
  view.addEventListener('found-in-page', (event) => {
    const { activeMatchOrdinal, matches } = event.result;
    tab.findCount.textContent = matches ? `${activeMatchOrdinal} of ${matches}` : 'No matches';
  });
  view.addEventListener('did-fail-load', (event) => {
    if (!event.isMainFrame || event.errorCode === -3) return; // -3: the page was changed before it finished
    const where = obscuraHost(event.validatedURL || tab.url);
    if (!/^https?:\/\//i.test(event.validatedURL || '')) return;
    setObscuraTitle(tab, where, null); // the tab is named for the site, not for the page before it
    if (OBSCURA_NO_NETWORK.has(event.errorCode)) {
      showObscuraMessage(tab, 'Can\'t reach this page', event.errorCode === -105 || event.errorCode === -106 || event.errorCode === -137
        ? 'The browser can\'t reach the internet from the house right now.'
        : `${where} didn't answer. If it's a site in a room, check that the room is open and the site is running.`);
    } else {
      showObscuraMessage(tab, 'This page couldn\'t be opened', `${where}: ${event.errorDescription || 'something went wrong'}.`);
    }
  });
  // Find in page.
  const find = (forward = true, again = true) => {
    const text = tab.findInput.value;
    if (!text) { view.stopFindInPage('clearSelection'); tab.findCount.textContent = ''; return; }
    view.findInPage(text, { forward, findNext: again });
  };
  tab.findInput.addEventListener('input', () => find(true, false));
  tab.findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); find(!event.shiftKey); }
    else if (event.key === 'Escape') { event.preventDefault(); closeObscuraFind(tab); }
  });
  tab.findBar.querySelectorAll('button')[0].addEventListener('click', () => find(false));
  tab.findBar.querySelectorAll('button')[1].addEventListener('click', () => find(true));
  tab.findBar.querySelectorAll('button')[2].addEventListener('click', () => closeObscuraFind(tab));
}

// A right-click in the page (lib/obscura.js passes it on): the same four as everywhere, then the
// browser's own. The page's spot is counted from the page's top left corner.
function obscuraMenu(tab, event) {
  const box = tab.view.getBoundingClientRect();
  const view = tab.view;
  const items = [];
  if (event.link) {
    items.push(
      { label: 'Open Link in New Tab', icon: 'tab_add', run: () => openInObscura(event.link) },
      { label: 'Copy Link', icon: 'link', run: () => call('clipboardWrite', event.link) },
      '-',
    );
  }
  items.push(
    { label: 'Back', icon: 'arrow_left', disabled: !view.canGoBack(), run: () => view.goBack() },
    { label: 'Forward', icon: 'arrow_right', disabled: !view.canGoForward(), run: () => view.goForward() },
    { label: 'Reload', icon: 'arrow_clockwise', run: () => reloadObscura(tab) },
  );
  // event.at is where the mouse is in Station's own page (lib/obscura.js reads it from the screen).
  rightClickMenu(event.at ? event.at.x : box.left + event.x, event.at ? event.at.y : box.top + event.y, {
    cut: event.canCut ? () => view.cut() : null,
    copy: event.words ? () => call('clipboardWrite', event.words) : null,
    paste: event.canPaste ? () => view.paste() : null,
    selectAll: event.canSelectAll ? () => view.selectAll() : null,
  }, items);
}

function reloadObscura(tab, hard = false) {
  if (!tab.url) return;
  try { if (hard) tab.view.reloadIgnoringCache(); else tab.view.reload(); } catch { /* not ready */ }
}

function openObscuraFind(tab) {
  tab.findBar.hidden = false;
  tab.findInput.focus();
  tab.findInput.select();
}

function closeObscuraFind(tab) {
  tab.findBar.hidden = true;
  tab.findCount.textContent = '';
  try { tab.view.stopFindInPage('clearSelection'); } catch { /* not ready */ }
  tab.view.focus();
}

// The browser's keys. Returns true when it was one of them. F5 and Ctrl+R reload THE PAGE; Station's
// own Ctrl+R (start the window again) never runs inside Obscura.
function obscuraKey(tab, { key, ctrl, shift, alt }) {
  const lower = String(key).toLowerCase();
  if (key === 'F5' || (ctrl && lower === 'r')) { reloadObscura(tab, ctrl && shift); return true; }
  if (alt && !ctrl && key === 'ArrowLeft') { if (tab.view.canGoBack()) tab.view.goBack(); return true; }
  if (alt && !ctrl && key === 'ArrowRight') { if (tab.view.canGoForward()) tab.view.goForward(); return true; }
  if (!ctrl) return false;
  if (lower === 'l') { tab.input.focus(); return true; }
  if (lower === 'f') { openObscuraFind(tab); return true; }
  if (lower === 'w') { closeTab(tab); return true; }
  if (lower === 't') { openFilesTab(HOME_PAGE); return true; }
  if (key === 'Tab') { cycleTab(shift ? -1 : 1); return true; }
  if (['+', '=', '-', '_', '0'].includes(key)) {
    const next = key === '0' ? 1 : Math.max(0.25, Math.min(5, tab.zoom + (key === '-' || key === '_' ? -0.1 : 0.1)));
    tab.zoom = Math.round(next * 100) / 100;
    try { tab.view.setZoomFactor(tab.zoom); } catch { /* not ready */ }
    obscuraNote(tab, `Zoom ${Math.round(tab.zoom * 100)}%`);
    return true;
  }
  return false;
}

// Keys pressed in Station's own part of the tab (the address bar, the buttons). Captured first, so
// Station's Ctrl+R (restart the window) and its zoom keys don't get them.
window.addEventListener('keydown', (event) => {
  const tab = state.active;
  if (tab?.kind !== 'obscura' || dialog.open) return;
  if (event.key === 'Escape' && tab.loading && document.activeElement !== tab.input) { tab.view.stop(); return; }
  if (obscuraKey(tab, { key: event.key, ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey, alt: event.altKey })) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

// What main says about a page (lib/obscura.js): a key it caught, a window the page asked for, a
// download, an address it refused, the page's picture.
window.house.on('obscura:event', (event) => {
  const tab = state.tabs.find((other) => other.kind === 'obscura' && other.wcId === event?.id);
  if (!tab) return;
  if (event.kind === 'key') obscuraKey(tab, event);
  else if (event.kind === 'menu') obscuraMenu(tab, event);
  // A page's own request for a tab; never more than 20 Obscura tabs that way.
  else if (event.kind === 'open' && typeof event.url === 'string' && state.tabs.filter((other) => other.kind === 'obscura').length < 20) openInObscura(event.url);
  else if (event.kind === 'note' && typeof event.note === 'string') obscuraNote(tab, event.note);
  else if (event.kind === 'blocked') obscuraNote(tab, 'The browser only opens web pages (http and https).');
  else if (event.kind === 'favicon' && /^data:image\//.test(event.src || '')) {
    setObscuraTitle(tab, tab.el.querySelector('.tab-title').textContent, event.src);
    rememberObscuraSite(tab, tab.url, event.src);
  }
});

// A project's Preview page (preview.js asks, main.js sends it once the site is up): one Obscura tab
// per project, tied to it in the bar. Asked again, that tab comes to the front and loads the page again.
function showPreviewPage(url, project, label = project) {
  let tab = state.tabs.find((other) => other.kind === 'obscura' && other.previewOf === project);
  if (tab) {
    activateTab(tab);
    goObscura(tab, url);
  } else {
    tab = openInObscura(url);
    if (!tab) return null;
    tab.previewOf = project;
  }
  setObscuraInfo({ project: label }, tab);
  return tab;
}

// An .html file's menu item: its page on Station's local server, in the same kind of tab (so it
// never counts toward the home page's sites, and the AI's browser can't reach it).
async function openHtmlInBrowser(entry) {
  const url = await attempt(() => call('htmlPreviewUrl', entry.path));
  if (url) showPreviewPage(url, `file:${entry.path}`, `Preview of ${entry.name}`);
}

window.house.on('preview:open', (event) => {
  if (typeof event?.url === 'string' && typeof event.project === 'string') showPreviewPage(event.url, event.project);
});

/* ---------- An AI using the browser (lib/ai-browser.js) ---------- */

// Each project's AI gets one tab of its own, marked "Claude is using this page", with Stop.
const aiBrowserTab = (project) => state.tabs.find((tab) => tab.kind === 'obscura' && tab.aiOf === project && !tab.closed);

window.house.on('aibrowser:tab', async ({ ask, project, agent, open }) => {
  let tab = aiBrowserTab(project);
  if (!tab && open) {
    tab = openObscura();
    tab.aiOf = project;
  } else if (tab && open && state.active !== tab) activateTab(tab);
  if (tab) {
    setObscuraInfo({ project, agent: `${agent} is using this page` }, tab);
    tab.aiStop.hidden = false;
    for (let waited = 0; waited < 5000 && !tab.wcId; waited += 100) {
      try { tab.wcId = tab.view.getWebContentsId(); } catch { await new Promise((resolve) => { setTimeout(resolve, 100); }); }
    }
  }
  call('aiBrowserAnswer', ask, tab?.wcId ?? null);
});

window.house.on('aibrowser:close', ({ ask, project }) => {
  const tab = aiBrowserTab(project);
  if (tab) closeTab(tab);
  call('aiBrowserAnswer', ask, true);
});

// Stop: the page stays, the AI loses it, and it has to ask before using the browser again.
function stopAiBrowser(tab) {
  const project = tab.aiOf;
  if (!project) return;
  tab.aiOf = null;
  tab.aiStop.hidden = true;
  tab.aiDot.hidden = true;
  setObscuraInfo({ project }, tab);
  call('aiBrowserStop', project);
  obscuraNote(tab, 'You have this page back. The AI has to ask you before it uses the browser again.');
}

// The owner's yes or no: a site under the Ask rule, or using the browser again after Stop. One
// question at a time, after any dialog already open.
window.house.on('aibrowser:ask', async ({ ask, project, agent, site, kind }) => {
  while (dialog.open) await new Promise((resolve) => { setTimeout(resolve, 300); });
  const again = kind === 'again';
  const yes = await showDialog((host, done) => {
    dialogFrame(host, again ? `${agent} wants the Web Browser again` : `${agent} wants to open ${site}`, again
      ? `You pressed Stop for ${agent} in ${project}. Let it use the browser again?`
      : `From ${project}. It uses your signed-in browser, so it can act as you on that site.`);
    dialogButtons(host, [
      { label: "Don't allow", onClick: () => done(false) },
      { label: 'Allow', primary: true, onClick: () => done(true) },
    ]);
  });
  call('aiBrowserAnswer', ask, yes === true);
});

// A dot where the AI clicks or types, for a moment.
window.house.on('aibrowser:pointer', ({ id, x, y }) => {
  const tab = state.tabs.find((other) => other.kind === 'obscura' && other.wcId === id);
  if (!tab || !Number.isFinite(x) || !Number.isFinite(y)) return;
  tab.aiDot.style.transform = `translate(${x}px, ${y}px)`;
  tab.aiDot.hidden = false;
  clearTimeout(tab.aiDotTimer);
  tab.aiDotTimer = setTimeout(() => { tab.aiDot.hidden = true; }, 2500);
});

function showObscura(tab) {
  $('item-count').textContent = '';
  requestAnimationFrame(() => {
    if (tab.closed || state.active !== tab) return;
    if (tab.url) tab.view.focus();
    else (tab.homeBox && !tab.message.hidden ? tab.homeBox : tab.input).focus();
  });
}

// Closing the tab takes the page with it.
function closeObscura(tab) {
  if (tab.closed) return;
  tab.closed = true;
  clearTimeout(tab.noteTimer);
  tab.host.remove();
}

// What another window (or a restart) needs to open this tab again: just its address.
function obscuraDescription(tab) {
  let url = tab.url || '';
  try {
    const now = tab.view.getURL();
    if (/^https?:\/\//i.test(now)) url = now;
  } catch { /* not loaded yet */ }
  return { kind: 'obscura', url };
}

window.houseTest = Object.assign(window.houseTest || {}, { openInObscura, obscuraAddress, setObscuraInfo, stopAiBrowser });
