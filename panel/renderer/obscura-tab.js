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

// background: an AI's tab opens behind the tab the owner is on and takes nothing from it.
function openObscura(url = null, background = false) {
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
  const star = el('button', 'ob-star');
  star.type = 'button';
  star.append(icon('star'));
  star.hidden = true;
  const field = el('div', 'ob-field');
  field.append(lock, input, star);
  // On the right: which project this page belongs to, which AI is using it (hidden until set), and
  // the page in Windows' own browser. One compact row, so the page gets everything else.
  // Which project and AI a tab belongs to is kept (setObscuraInfo) but not drawn: the room in the
  // bar is the page's zoom, and an AI at work shows as a banner over the page instead.
  const project = el('span', 'ob-chip', 'Not tied to a project');
  const agent = el('span', 'ob-chip ob-chip-agent');
  agent.hidden = true;
  // Over the page while an AI from a project's room is using this tab (lib/ai-browser.js): Stop
  // takes it back.
  const aiStop = el('button', 'ob-ai-stop', 'Stop');
  aiStop.type = 'button';
  aiStop.title = 'Take this page back from the AI';
  // A pill over the top middle of the page (in the stage below), with a sparkle, who is working and Stop.
  const aiBanner = el('div', 'ob-ai-banner');
  const aiBannerText = el('span', 'ob-ai-banner-text');
  const sparkle = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sparkle.setAttribute('viewBox', '0 0 24 24');
  sparkle.setAttribute('class', 'ob-ai-sparkle');
  const sparkPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  sparkPath.setAttribute('d', 'M12 2C12.6 7.5 16.5 11.4 22 12C16.5 12.6 12.6 16.5 12 22C11.4 16.5 7.5 12.6 2 12C7.5 11.4 11.4 7.5 12 2Z');
  sparkPath.setAttribute('fill', 'currentColor');
  sparkle.append(sparkPath);
  aiBanner.append(sparkle, aiBannerText, aiStop);
  aiBanner.hidden = true;
  aiStop.hidden = true;
  // The page's zoom, in the room the project used to take.
  const zoomOut = button('subtract', 'Zoom out (Ctrl -)');
  const zoomIn = button('add', 'Zoom in (Ctrl +)');
  const zoomText = el('button', 'ob-zoom-level', '100%');
  zoomText.type = 'button';
  zoomText.title = 'Back to 100% (Ctrl 0)';
  const zoomBox = el('div', 'ob-zoom');
  zoomBox.append(zoomOut, zoomText, zoomIn);
  // Only while paired (a tab beside this one, app.js): back to two tabs.
  const unsplit = button('panel_right_contract', 'Separate into two tabs');
  unsplit.hidden = true;
  // Whether websites see a light or a dark look (one setting for every browser tab and window).
  const dark = button('weather_moon', 'Websites: Light');
  const marks = button('bookmarks', 'Bookmarks');
  const past = button('history', 'History (Ctrl+H)');
  const newTab = button('tab_add', 'New browser tab (Ctrl+T)');
  for (const extra of [dark, marks, past, newTab]) extra.classList.add('ob-extra'); // hidden in a narrow page (style.css)
  const bar = el('div', 'ob-bar');
  bar.append(back, forward, reload, field, dark, marks, past, newTab, zoomBox, unsplit);
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
  // The AI's cursor (a second pointer with its name), the ripple where it presses, and a soft glow
  // round the page: all drawn over the page, none of it catching the mouse.
  const aiDot = el('div', 'ob-ai-cursor');
  // Built by hand, never from a string of HTML.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('viewBox', '0 0 22 22');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  for (const [name, value] of Object.entries({ d: 'M3 2 L3 17.5 L7.2 13.6 L10 19.5 L12.6 18.3 L9.8 12.5 L15.5 12.2 Z', fill: '#d97757', stroke: '#fff', 'stroke-width': '1.6', 'stroke-linejoin': 'round' })) arrow.setAttribute(name, value);
  svg.append(arrow);
  aiDot.append(svg);
  const aiName = el('span', 'ob-ai-name');
  aiDot.append(aiName);
  aiDot.hidden = true;
  const aiRing = el('div', 'ob-ai-ring');
  aiRing.hidden = true;
  const aiGlow = el('div', 'ob-ai-glow');
  aiGlow.hidden = true;
  stage.append(view, message, aiGlow, aiBanner, aiRing, aiDot);
  tab.host.append(bar, progress, note, findBar, stage);
  tab.host.hidden = true;
  tab.view = view;
  tab.input = input;
  tab.field = field;
  Object.assign(tab, { dark, star, marks, past, project, agent, aiStop, aiBanner, aiBannerText, aiDot, aiName, aiRing, aiGlow, zoomText, unsplit, back, forward, reload, lock, progress, note, findBar, findInput, findCount, message });
  docArea.append(tab.host);

  showObscuraStart(tab);
  hookObscura(tab);
  aiStop.addEventListener('click', () => stopAiBrowser(tab));
  zoomOut.addEventListener('click', () => zoomObscura(tab, -1));
  zoomIn.addEventListener('click', () => zoomObscura(tab, 1));
  zoomText.addEventListener('click', () => zoomObscura(tab, 0));
  unsplit.addEventListener('click', () => separateTabs(tab));
  dark.addEventListener('click', () => call('obscuraDark', !prefs.darkSites).catch(() => {}));
  showObscuraDark(tab);
  star.addEventListener('click', () => toggleBookmark(tab));
  marks.addEventListener('click', () => showObscuraList(tab, 'bookmarks'));
  past.addEventListener('click', () => showObscuraList(tab, 'history'));
  newTab.addEventListener('click', () => openObscura());
  addTabElement(tab, 'New tab');
  tab.aiTabDot = tab.el.querySelector('.tab-ai-dot');
  state.tabs.push(tab);
  renderTabButtons();
  if (!background) activateTab(tab);
  return tab;
}

// The dark-look button says what websites see now, and the moon is lit while they see dark.
function showObscuraDark(tab) {
  tab.dark.title = prefs.darkSites ? 'Websites: Dark' : 'Websites: Light';
  tab.dark.setAttribute('aria-label', tab.dark.title);
  tab.dark.classList.toggle('on', prefs.darkSites);
}
window.house.on('obscura:dark', (on) => {
  prefs.darkSites = on === true;
  state.tabs.filter((tab) => tab.kind === 'obscura').forEach(showObscuraDark);
});

// What the info area on the right says. Other features fill it: { project: 'Name', agent: 'Claude' }.
// No project: "Not tied to a project". No agent: its chip stays hidden.
function setObscuraInfo(info = {}, tab = state.active) {
  if (tab?.kind !== 'obscura') return;
  tab.project.textContent = info.project || 'Not tied to a project';
  tab.project.classList.toggle('set', !!info.project);
  tab.agent.textContent = info.agent || '';
  tab.agent.hidden = !info.agent;
  tab.field.title = info.project ? `Tied to ${info.project}` : '';
}

// The pill and glow over the page while an AI is at work; they go by themselves a few seconds after
// the AI's last move (the same moment as the orange dot on the tab), and come back with the next one.
function aiAtWork(tab, agent, doing) {
  if (!tab.aiOf) return;
  if (agent) { tab.aiBase = agent; tab.aiName.textContent = agent.replace(/ is using this page$/, ''); }
  const who = tab.aiName.textContent.replace(/^An AI$/, '') || 'AI';
  tab.aiBannerText.textContent = `${who} is working here${doing ? ` · ${doing}` : ''}`;
  tab.aiBanner.hidden = false;
  tab.aiStop.hidden = false;
  tab.aiGlow.hidden = false;
  tab.aiTabDot.hidden = false;
  clearTimeout(tab.aiBannerTimer);
  tab.aiBannerTimer = setTimeout(() => aiResting(tab), 7000);
}
// A few seconds after its last move the strip, glow and cursor go; the next move brings them back.
function aiResting(tab) {
  tab.aiBanner.hidden = true;
  tab.aiGlow.hidden = true;
  tab.aiTabDot.hidden = true;
  tab.aiDot.hidden = true;
  tab.aiRing.hidden = true;
  tab.aiAt = null;
}
// Its cursor glides to where it will act along a gentle curve and eases in and out, then presses.
const aiEase = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);
function aiGlide(tab, to, doing) {
  const from = tab.aiAt || [to[0], Math.max(8, to[1] - 140)]; // the first time it comes down from above
  tab.aiAt = to;
  const cursor = tab.aiDot;
  cursor.hidden = false;
  const bend = 0.05 * (to[0] < from[0] ? -1 : 1);
  const mx = (from[0] + to[0]) / 2 - (to[1] - from[1]) * bend * 4;
  const my = (from[1] + to[1]) / 2 + (to[0] - from[0]) * bend * 4;
  const start = performance.now();
  const duration = 400;
  const token = (tab.aiGlideId = (tab.aiGlideId || 0) + 1);
  requestAnimationFrame(function frame(now) {
    if (tab.aiGlideId !== token || tab.closed) return;
    const q = aiEase(Math.min(1, (now - start) / duration));
    const x = (1 - q) ** 2 * from[0] + 2 * (1 - q) * q * mx + q * q * to[0];
    const y = (1 - q) ** 2 * from[1] + 2 * (1 - q) * q * my + q * q * to[1];
    cursor.style.translate = `${x}px ${y}px`;
    if (q < 1) { requestAnimationFrame(frame); return; }
    if (doing === 'click') {
      cursor.animate([{ scale: 1 }, { scale: 0.86 }, { scale: 1 }], 220);
      tab.aiRing.style.translate = `${to[0] - 14}px ${to[1] - 14}px`;
      tab.aiRing.hidden = false;
      tab.aiRing.animate([{ scale: 0.3, opacity: 0.7 }, { scale: 1, opacity: 0 }], { duration: 420, easing: 'cubic-bezier(.33,1,.68,1)' });
    }
  });
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
// Bookmarks and history are kept in the same place, on this computer only: [{ url, title, fav? }] and
// [{ url, title, at }], newest first.
let obscuraBookmarks = [];
let obscuraHistory = [];
const webPages = (list) => (Array.isArray(list) ? list.filter((page) => /^https?:\/\//.test(page?.url)) : []);
const obscuraSitesReady = () => (obscuraSites ? Promise.resolve(obscuraSites) : call('prefs').catch(() => ({})).then((saved) => {
  obscuraSites = obscuraSites || webPages(saved.sites);
  obscuraBookmarks = webPages(saved.bookmarks);
  obscuraHistory = webPages(saved.history);
  return obscuraSites;
}));
let pagesSaveTimer = 0;
const saveObscuraPages = () => {
  clearTimeout(pagesSaveTimer);
  pagesSaveTimer = setTimeout(() => call('setPrefs', { bookmarks: obscuraBookmarks.slice(0, 300), history: obscuraHistory.slice(0, 400) }).catch(() => {}), 800);
};
const obscuraTabs = () => state.tabs.filter((tab) => tab.kind === 'obscura' && !tab.closed);
const isLocalAddress = (url) => /^https?:\/\/(localhost|\d{1,3}(\.\d{1,3}){3}|\[)/i.test(url);

// A page opened in a tab (not an AI's, not a project's preview) goes in the history.
function rememberObscuraVisit(tab, url) {
  if (tab.aiOf || tab.previewOf || !/^https?:\/\//i.test(url) || isLocalAddress(url)) return;
  const last = obscuraHistory[0];
  if (last && last.url === url) { last.at = Date.now(); } else obscuraHistory.unshift({ url, title: '', at: Date.now() });
  if (obscuraHistory.length > 400) obscuraHistory.length = 400;
  saveObscuraPages();
}
function titleObscuraVisit(tab, title) {
  const last = obscuraHistory[0];
  if (last && last.url === tab.url && title) { last.title = String(title).slice(0, 120); saveObscuraPages(); }
}
const bookmarkOf = (url) => obscuraBookmarks.find((page) => page.url === url);
function toggleBookmark(tab) {
  if (!/^https?:\/\//i.test(tab.url || '')) return;
  const found = bookmarkOf(tab.url);
  if (found) obscuraBookmarks.splice(obscuraBookmarks.indexOf(found), 1);
  else {
    const title = tab.el.querySelector('.tab-title').textContent;
    obscuraBookmarks.unshift({ url: tab.url, title: String(title || obscuraHost(tab.url)).slice(0, 120), ...(tab.favicon && tab.favicon.length < 3000 ? { fav: tab.favicon } : {}) });
  }
  saveObscuraPages();
  obscuraTabs().forEach(refreshObscuraStar);
  obscuraNote(tab, found ? 'Bookmark removed.' : 'Bookmarked.');
}
function refreshObscuraStar(tab) {
  const real = /^https?:\/\//i.test(tab.url || '');
  const on = real && Boolean(bookmarkOf(tab.url));
  tab.star.hidden = !real;
  tab.star.classList.toggle('on', on);
  setIcon(tab.star.firstChild, on ? 'star-filled' : 'star');
  tab.star.title = on ? 'Remove the bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
  tab.star.setAttribute('aria-label', tab.star.title);
  tab.drawHome?.();
}
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
  const tilesLabel = el('div', 'ob-home-label');
  const recent = el('div', 'ob-recent');
  tab.homeBox = box;
  tab.message.className = 'ob-message ob-home';
  tab.message.replaceChildren(el('div', 'ob-home-inner'));
  tab.message.firstChild.append(logo, box, tilesLabel, tiles, recent);
  tab.message.hidden = false;
  const draw = () => {
    // Bookmarks first; until there are some, the sites visited most (or a few to start with).
    const kept = obscuraBookmarks.slice(0, 8).map((page) => ({ ...page, name: page.title || obscuraHost(page.url), bookmark: true }));
    const mine = kept.length ? kept : obscuraSites.slice(0, 8);
    tilesLabel.textContent = kept.length ? 'Bookmarks' : mine.length ? 'Most visited' : 'Start with';
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
          if (site.bookmark) { obscuraBookmarks.splice(obscuraBookmarks.findIndex((page) => page.url === site.url), 1); saveObscuraPages(); obscuraTabs().forEach(refreshObscuraStar); return; }
          obscuraSites.splice(obscuraSites.indexOf(site), 1);
          saveObscuraSites();
          draw();
        });
        tile.append(gone);
      }
      return tile;
    }));
    // The last few pages visited.
    const lately = obscuraHistory.slice(0, 6);
    recent.replaceChildren(...(lately.length ? [el('div', 'ob-home-label', 'Recently visited')] : []), ...lately.map((page) => {
      const row = el('button', 'ob-recent-row');
      row.type = 'button';
      row.title = page.url;
      row.append(el('span', 'ob-pop-title', page.title || obscuraHost(page.url)), el('span', 'ob-pop-host', obscuraHost(page.url)));
      row.addEventListener('click', () => goObscura(tab, page.url));
      return row;
    }));
  };
  tab.drawHome = draw;
  obscuraSitesReady().then(draw);
}

// Bookmarks and History, as a panel under the bar. Text only (never HTML); a click goes there in this tab.
function showObscuraList(tab, kind) {
  const open = tab.pop;
  if (open) { open.remove(); tab.pop = null; if (open.dataset.kind === kind) return; }
  const pop = el('div', 'ob-pop');
  pop.dataset.kind = kind;
  const head = el('div', 'ob-pop-head');
  head.append(el('strong', '', kind === 'history' ? 'History' : 'Bookmarks'));
  const search = el('input', 'ob-pop-search');
  search.type = 'text';
  search.placeholder = kind === 'history' ? 'Search history' : 'Search bookmarks';
  search.spellcheck = false;
  const clear = el('button', 'ob-pop-clear', kind === 'history' ? 'Clear history' : 'Remove all');
  clear.type = 'button';
  head.append(search, clear);
  const list = el('div', 'ob-pop-list');
  pop.append(head, list);
  const close = () => { pop.remove(); tab.pop = null; document.removeEventListener('mousedown', outside, true); };
  const outside = (event) => { if (!pop.contains(event.target) && !tab.marks.contains(event.target) && !tab.past.contains(event.target)) close(); };
  const source = () => (kind === 'history' ? obscuraHistory : obscuraBookmarks);
  const draw = () => {
    const words = search.value.trim().toLowerCase();
    const shown = source().filter((page) => !words || `${page.title || ''} ${page.url}`.toLowerCase().includes(words)).slice(0, 80);
    if (!shown.length) { list.replaceChildren(el('div', 'ob-pop-empty', words ? 'Nothing matches.' : kind === 'history' ? 'Pages you visit show up here.' : 'Press the star in the address bar to keep a page here.')); return; }
    list.replaceChildren(...shown.map((page) => {
      const row = el('div', 'ob-pop-row');
      const go = el('button', 'ob-pop-go');
      go.type = 'button';
      go.title = page.url;
      go.append(el('span', 'ob-pop-title', page.title || obscuraHost(page.url)), el('span', 'ob-pop-host', obscuraHost(page.url)));
      go.addEventListener('click', () => { close(); goObscura(tab, page.url); });
      const gone = el('button', 'ob-pop-x', '×');
      gone.type = 'button';
      gone.title = 'Remove';
      gone.setAttribute('aria-label', `Remove ${page.title || obscuraHost(page.url)}`);
      gone.addEventListener('click', () => {
        source().splice(source().indexOf(page), 1);
        saveObscuraPages();
        obscuraTabs().forEach(refreshObscuraStar);
        draw();
      });
      row.append(go, gone);
      return row;
    }));
  };
  search.addEventListener('input', draw);
  search.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  clear.addEventListener('click', () => {
    source().length = 0;
    saveObscuraPages();
    obscuraTabs().forEach(refreshObscuraStar);
    draw();
  });
  tab.pop = pop;
  tab.host.append(pop);
  document.addEventListener('mousedown', outside, true);
  if (obscuraSites) draw(); else obscuraSitesReady().then(draw);
  search.focus();
}

// A page's zoom belongs to its tab: 100% is how a normal browser shows it. Station itself is drawn
// larger than the screen's own scale (main.js BASE_ZOOM and the footer's zoom), and a page inside it
// is drawn on its own, so it's multiplied by that too: otherwise every page looks zoomed out next to
// the same address in a normal browser.
const hostZoom = () => { try { return window.house.getZoomFactor() || 1; } catch { return 1; } };
// 100% is the look that was 80% of that: the owner's choice (2026-11-12), so pages sit at a size
// that suits Station's screen without having to zoom out first.
let pageScale = 1.25; // Windows' display scale, from main.js; 100% is as big as in a normal browser
call('pageScale').then((scale) => { pageScale = scale || pageScale; }).catch(() => {});
function applyObscuraZoom(tab) {
  try { tab.view.setZoomFactor(tab.zoom * pageScale); } catch { /* not ready */ }
  if (tab.zoomText) tab.zoomText.textContent = `${Math.round(tab.zoom * 100)}%`;
}
// direction: 1 bigger, -1 smaller, 0 back to 100%. Steps follow Chrome's list.
const OBSCURA_ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
function zoomObscura(tab, direction) {
  if (direction === 0) tab.zoom = 1;
  else if (direction > 0) tab.zoom = OBSCURA_ZOOMS.find((step) => step > tab.zoom + 0.001) || 5;
  else tab.zoom = [...OBSCURA_ZOOMS].reverse().find((step) => step < tab.zoom - 0.001) || 0.25;
  applyObscuraZoom(tab);
  showZoomLabel();
}
// The footer shows the front tab's zoom: the page's in a browser tab, Station's elsewhere.
function showZoomLabel() {
  const tab = state.active;
  $('zoom-level').textContent = tab?.kind === 'obscura' ? `${Math.round(tab.zoom * 100)}%` : `${Math.round((hostZoom() / 1.35) * 100)}%`;
}
// Station's own zoom changed: every page follows it, keeping its own zoom on top.
function rezoomObscuraTabs() {
  for (const tab of state.tabs || []) if (tab.kind === 'obscura') applyObscuraZoom(tab);
  showZoomLabel();
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
  refreshObscuraStar(tab);
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
    tab.waking = false;
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
    if (tab.waking) { tab.waking = false; return; } // back from sleep (sleepObscura): not a new visit
    obscuraSitesReady().then(() => { rememberObscuraSite(tab, event.url); rememberObscuraVisit(tab, event.url); });
  });
  view.addEventListener('did-navigate-in-page', (event) => { if (event.isMainFrame) obscuraShowAddress(tab, event.url); });
  view.addEventListener('page-title-updated', (event) => { setObscuraTitle(tab, event.title); titleObscuraVisit(tab, event.title); });
  view.addEventListener('dom-ready', () => {
    try {
      tab.wcId = view.getWebContentsId();
      applyObscuraZoom(tab);
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
  if (lower === 't') { openObscura(); return true; }
  if (lower === 'd') { toggleBookmark(tab); return true; }
  if (lower === 'h') { showObscuraList(tab, 'history'); return true; }
  if (key === 'Tab') { cycleTab(shift ? -1 : 1); return true; }
  if (['+', '=', '-', '_', '0'].includes(key)) {
    zoomObscura(tab, key === '0' ? 0 : key === '-' || key === '_' ? -1 : 1);
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
  else if (event.kind === 'zoom') zoomObscura(tab, event.direction);
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

// A link clicked in Station (a terminal, a document, a Home button): the Web Browser, never Windows'.
window.house.on('link:open', (event) => {
  if (typeof event?.url === 'string') openInObscura(event.url);
});

window.house.on('preview:open', (event) => {
  if (typeof event?.url === 'string' && typeof event.project === 'string') showPreviewPage(event.url, event.project);
});

/* ---------- An AI using the browser (lib/ai-browser.js) ---------- */

// Each AI session (a project and a terminal tab in its room) gets one tab of its own, marked "Claude
// is using this page", with Stop. It opens behind the tab the owner is on and never comes forward by itself.
const aiBrowserTab = (project, session) => state.tabs.find((tab) => tab.kind === 'obscura' && tab.aiOf === project && tab.aiSession === session && !tab.closed);

// A tab that belongs to an AI session: kept drawn out of sight while it isn't in front, so its page works
// (style.css), and unable to take the keyboard (app.js clears this when the owner opens the tab). It
// can't be moved to another window. Also used when a reload hands it back (app.js addMovedTab).
function markAiTab(tab, project, session) {
  wakeObscura(tab); // an AI needs a live page
  tab.aiOf = project;
  tab.aiSession = session;
  tab.host.classList.add('ai-live');
  tab.host.inert = true;
  renderTabButtons();
}

window.house.on('aibrowser:tab', async ({ ask, project, session = '', agent, open }) => {
  let tab = aiBrowserTab(project, session);
  if (!tab && open) {
    tab = openObscura(null, true);
    markAiTab(tab, project, session);
  }
  if (tab) {
    setObscuraInfo({ project, agent: `${agent} is using this page` }, tab);
    tab.aiName.textContent = agent;
    aiAtWork(tab, `${agent} is using this page`);
    for (let waited = 0; waited < 5000 && !tab.wcId; waited += 100) {
      try { tab.wcId = tab.view.getWebContentsId(); } catch { await new Promise((resolve) => { setTimeout(resolve, 100); }); }
    }
  }
  const answered = call('aiBrowserAnswer', ask, tab?.wcId ?? null);
  if (tab?.aiResume) {
    const url = tab.aiResume;
    tab.aiResume = null;
    await answered.catch(() => {}); // main has the tab in its address wall by now
    goObscura(tab, url);
  }
});

window.house.on('aibrowser:close', ({ ask, project, session = '' }) => {
  const tab = aiBrowserTab(project, session);
  if (tab) closeTab(tab);
  call('aiBrowserAnswer', ask, true);
});

// Stop: the page stays, the AI loses it, and it has to ask before using the browser again.
function stopAiBrowser(tab) {
  const project = tab.aiOf;
  if (!project) return;
  const session = tab.aiSession;
  tab.aiOf = null;
  tab.host.classList.remove('ai-live');
  renderTabButtons();
  clearTimeout(tab.aiBannerTimer);
  aiResting(tab);
  tab.aiStop.hidden = true;
  setObscuraInfo({ project }, tab);
  try { tab.view.stop(); } catch { /* not ready */ } // whatever it was loading stops too
  call('aiBrowserStop', project, session).catch(() => {});
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

// The AI's cursor: it glides to where the AI is about to click or type (lib/ai-browser.js). The
// numbers are the guest's own pixels, so they are divided by this window's zoom to land on the page.
window.house.on('aibrowser:pointer', ({ id, x, y, doing }) => {
  const tab = state.tabs.find((other) => other.kind === 'obscura' && other.wcId === id);
  if (!tab || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const zoom = hostZoom();
  aiAtWork(tab, undefined, doing === 'type' ? 'typing' : doing === 'click' ? 'clicking' : '');
  aiGlide(tab, [x / zoom, y / zoom], doing);
});

// A browser tab out of sight for 10 minutes goes to sleep: its page is let go (its memory and
// everything it was running stop) and comes back at the same address when the tab is shown again.
// Never a page playing sound, still loading, a room's site preview, or one an AI is using.
const OBSCURA_SLEEP_MS = 10 * 60 * 1000;
function sleepObscura(tab) {
  let url = '';
  try { url = tab.view.getURL(); } catch { return; }
  if (!/^https?:\/\//i.test(url) || !tab.view.parentNode) return; // the start page: nothing to let go
  tab.asleep = url;
  tab.sleepParent = tab.view.parentNode;
  tab.view.setAttribute('src', url); // a webview put back loads its src (Electron)
  tab.view.remove();
  tab.el.classList.add('asleep');
}
function wakeObscura(tab) {
  if (!tab.asleep || tab.closed) return;
  tab.asleep = null;
  tab.waking = true; // the reload isn't a new visit for History
  tab.el.classList.remove('asleep');
  tab.sleepParent.prepend(tab.view);
}
function sleepCheck(now = Date.now(), after = OBSCURA_SLEEP_MS) {
  for (const tab of obscuraTabs()) {
    if (!tab.host.hidden) { tab.hiddenSince = 0; wakeObscura(tab); continue; }
    if (tab.asleep) continue;
    tab.hiddenSince ||= now;
    let audible = false;
    try { audible = tab.view.isCurrentlyAudible(); } catch { /* not ready */ }
    if (now - tab.hiddenSince >= after && !audible && !tab.loading && !tab.aiOf && !tab.previewOf) sleepObscura(tab);
  }
}
setInterval(() => sleepCheck(), 30000);

function showObscura(tab) {
  wakeObscura(tab);
  $('item-count').textContent = '';
  requestAnimationFrame(() => {
    if (tab.closed || state.active !== tab || tabDragging) return;
    if (tab.url) tab.view.focus();
    else (tab.homeBox && !tab.message.hidden ? tab.homeBox : tab.input).focus();
  });
}

// Closing the tab takes the page with it.
function closeObscura(tab) {
  if (tab.closed) return;
  tab.closed = true;
  clearTimeout(tab.noteTimer);
  clearTimeout(tab.aiBannerTimer);
  tab.host.remove();
}

// What another window (or a restart) needs to open this tab again: just its address.
function obscuraDescription(tab) {
  let url = tab.asleep || tab.url || '';
  try {
    const now = tab.view.getURL();
    if (/^https?:\/\//i.test(now)) url = now;
  } catch { /* not loaded yet */ }
  return { kind: 'obscura', url, ai: tab.aiOf ? { project: tab.aiOf, session: tab.aiSession || '' } : null }; // main only lets this through for a reload, never another window
}

window.houseTest = Object.assign(window.houseTest || {}, { sleepCheck, aiAtWork, aiGlide, aiResting, zoomObscura, hostZoom, pageScale: () => pageScale, openInObscura, openObscura, obscuraAddress, setObscuraInfo, stopAiBrowser, rememberObscuraVisit, toggleBookmark, showObscuraList, bookmarks: () => obscuraBookmarks, history: () => obscuraHistory, ready: () => obscuraSitesReady() });
