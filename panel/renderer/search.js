// The toolbar search box has four ways to look:
//   "This folder"        the folder's own list, filtered as you type (all in app.js)
//   "All folders inside" names, through every folder inside, as you type (lib/search.js)
//   "Words inside files" the text inside files, on Enter (lib/search-words.js)
//   "By meaning (Jev)"   TypeSafe's Jev scores files against what you describe, on Enter (lib/jev.js)
// The last three are here. The walking and asking is done in the main process, which sends results
// back in batches as it finds them. app.js asks this object a few small questions (on, list, tag...)
// so the usual list, rows, icons, menus and keys all work on the results as they do on a folder.
window.deepSearch = (() => {
  const TYPING_PAUSE = 150; // ms of quiet before a name search starts, so each keystroke doesn't start one
  const REDRAW_EVERY = 120; // ms between redraws while results stream in
  const LIMIT = 1000; // the same cap lib/search.js uses
  const JEV_PAGE = 'https://console.typesafe.ai';

  // 'here', 'deep', 'words' or 'meaning'. Searching starts with every folder inside, as in Windows' File Explorer.
  let scope = 'deep';
  let keySet = false; // whether a Jev key is saved; the page never sees the key itself
  let current = null; // { id, kind, root, results, done, capped, error, progress } for the search on screen
  let generation = 0;
  let typing = null;
  let redrawTimer = null;
  let cache = { list: null, count: -1, sortBy: '', sortAsc: null, sorted: [] };

  const stopped = () => call('searchStop').catch(() => {});

  function redraw() {
    clearTimeout(redrawTimer);
    redrawTimer = null;
    renderEntries();
  }

  // Redraws are spaced out so a flood of batches can't keep the page busy.
  function redrawSoon() {
    if (!redrawTimer) redrawTimer = setTimeout(redraw, REDRAW_EVERY);
  }

  function begin(root, query, delay, kind = 'deep') {
    clearTimeout(typing);
    if (current && !current.done) stopped();
    const mine = { id: ++generation, kind, root, query, results: [], done: false, capped: false, error: '', progress: null };
    current = mine;
    typing = setTimeout(() => {
      const asking = kind === 'meaning' ? call('meaningStart', mine.id, root, query, state.showHidden)
        : kind === 'words' ? call('wordsStart', mine.id, root, query)
          : call('searchStart', mine.id, root, query, state.showHidden);
      asking.catch((error) => {
        if (current !== mine) return;
        mine.done = true;
        mine.error = cleanError(error);
        redraw();
      });
    }, delay);
    return mine;
  }

  function stop() {
    clearTimeout(typing);
    clearTimeout(redrawTimer);
    redrawTimer = null;
    if (current && !current.done) stopped();
    current = null;
  }

  const query = () => state.search.trim();
  const inFolder = () => state.active?.kind === 'files' && state.active.path !== HOME_PAGE;

  // Whether the list shows search results right now. Anything that clears the box or leaves the
  // folder (navigating, a new tab, pasting) ends the search here, so none of them need to know.
  // A search by meaning or by words inside files only starts on Enter; until then the box filters the folder as usual.
  function on() {
    const wanted = scope !== 'here' && inFolder() && query() !== '';
    if (!wanted) {
      if (current) stop();
      return false;
    }
    if (scope === 'meaning' || scope === 'words') {
      if (current && current.root !== state.active.path) stop();
      return Boolean(current);
    }
    if (!current || current.kind !== 'deep' || current.root !== state.active.path) begin(state.active.path, query(), 0);
    return true;
  }

  function list() {
    const { results } = current;
    const byScore = current.kind === 'meaning';
    if (cache.list !== results || cache.count !== results.length || cache.sortBy !== state.sortBy || cache.sortAsc !== state.sortAsc || cache.byScore !== byScore) {
      const sorted = [...results].sort(byScore ? (a, b) => b.score - a.score : compareEntries);
      cache = { list: results, count: results.length, sortBy: state.sortBy, sortAsc: state.sortAsc, byScore, sorted };
    }
    return cache.sorted;
  }

  window.house.on('search:batch', ({ id, results, progress }) => {
    if (!current || current.id !== id) return; // from a search that was already moved on from
    current.results.push(...results);
    if (progress) current.progress = progress;
    redrawSoon();
  });

  window.house.on('search:done', ({ id, capped, error, errorKind }) => {
    if (!current || current.id !== id) return;
    // No TypeSafe balance left: back to the usual search, so searching keeps working. Said once.
    if (errorKind === 'balance') {
      toast(error);
      setScope('here');
      return;
    }
    current.done = true;
    current.capped = capped === true;
    current.error = error || '';
    redraw();
  });

  // Typing: a name search shows "Searching…" at once and starts after a short pause.
  $('search').addEventListener('input', () => {
    if (scope === 'here' || !inFolder()) return;
    if (query() === '') {
      stop();
      return;
    }
    if (scope === 'deep') {
      begin(state.active.path, query(), TYPING_PAUSE);
      redraw();
    }
  });

  // Enter runs a search by meaning (each one costs money) or by words inside files (reading files is slow).
  $('search').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || (scope !== 'meaning' && scope !== 'words') || !inFolder() || query() === '') return;
    event.preventDefault();
    if (scope === 'words') {
      begin(state.active.path, query(), 0, 'words');
      redraw();
      return;
    }
    if (!keySet) {
      showKeyPanel();
      return;
    }
    begin(state.active.path, query(), 0, 'meaning');
    redraw();
  });

  // Esc leaves the search: the box empties and the folder's own list comes back.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !current || !on()) return;
    if (!$('menu').hidden || $('dialog').open || renaming) return;
    event.preventDefault();
    state.search = '';
    $('search').value = '';
    stop();
    renderEntries();
  });

  function setScope(next) {
    scope = next;
    call('setSearchScope', scope).catch(() => {});
    hideKeyPanel();
    stop();
    renderEntries();
    renderChrome();
    if (scope === 'meaning' && !keySet) showKeyPanel();
  }

  /* ---------- The key panel ---------- */

  let panel = null;

  function hideKeyPanel() {
    if (panel) panel.hidden = true;
  }

  function showKeyPanel() {
    if (!panel) {
      panel = el('div', 'jev-panel');
      const field = el('input', 'jev-field');
      field.type = 'password';
      field.autocomplete = 'off';
      field.spellcheck = false;
      field.placeholder = 'TypeSafe API key';
      const problem = el('div', 'jev-problem');
      const save = el('button', 'btn primary', 'Save');
      const link = el('button', 'jev-link', 'Get a key at console.typesafe.ai');
      const cancel = el('button', 'btn', 'Cancel');
      const submit = async () => {
        try {
          await call('setJevKey', field.value);
        } catch (error) {
          problem.textContent = cleanError(error);
          return;
        }
        field.value = ''; // the page doesn't keep it
        problem.textContent = '';
        keySet = true;
        hideKeyPanel();
        if (scope === 'meaning' && query() !== '' && inFolder()) {
          begin(state.active.path, query(), 0, 'meaning');
          redraw();
        }
      };
      save.addEventListener('click', submit);
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit();
        if (event.key === 'Escape') hideKeyPanel();
      });
      link.addEventListener('click', () => call('openLink', JEV_PAGE).catch(() => {}));
      cancel.addEventListener('click', hideKeyPanel);
      const actions = el('div', 'jev-actions');
      actions.append(save, cancel, link);
      panel.append(
        el('p', '', 'Search by meaning uses TypeSafe\'s Jev. Station sends the names of files in this folder and the start of each text file to TypeSafe to score them. Hidden files, Windows files and anything that looks like a password or key are never sent. Your TypeSafe API key:'),
        field,
        problem,
        actions,
      );
      document.body.append(panel);
    }
    const box = $('search').getBoundingClientRect();
    panel.hidden = false;
    panel.style.top = `${box.bottom + 8}px`;
    panel.style.right = `${Math.max(8, window.innerWidth - box.right)}px`;
    panel.querySelector('.jev-field').focus();
  }

  $('search-scope').addEventListener('click', (event) => {
    event.preventDefault();
    const items = [
      { label: 'This folder', icon: 'folder_open', checked: scope === 'here', run: () => setScope('here') },
      { label: 'All folders inside', icon: 'search', checked: scope === 'deep', run: () => setScope('deep') },
      { label: 'Words inside files', icon: 'document', checked: scope === 'words', run: () => setScope('words') },
      { label: 'By meaning (Jev)', icon: 'eye', checked: scope === 'meaning', run: () => setScope('meaning') },
    ];
    items.push('-', { label: 'API Keys', icon: 'key', run: () => openKeys() }); // keys.js
    if (keySet) {
      items.push({
        label: 'Remove Jev Key',
        icon: 'delete',
        run: async () => {
          await call('removeJevKey').catch(() => {});
          keySet = false;
          if (scope === 'meaning') stop();
          renderEntries();
        },
      });
    }
    menuUnder(event.currentTarget, items);
  });

  call('searchScope').then((saved) => {
    if (saved === 'here' || saved === 'deep' || saved === 'words' || saved === 'meaning') scope = saved;
    if (state.active) renderChrome();
  }).catch(() => {});
  call('jevKey').then((set) => { keySet = set === true; }).catch(() => {});
  // A key added or removed in API Keys (keys.js).
  window.addEventListener('house-key', ({ detail }) => {
    if (detail?.id !== 'jev') return;
    keySet = detail.set === true;
    if (keySet) hideKeyPanel();
    else if (scope === 'meaning') stop();
    renderEntries();
  });

  const shortFolder = (root) => baseName(root) || '/';

  function statusText() {
    const { progress } = current;
    if (current.done && current.error) return current.error;
    if (current.kind === 'meaning') {
      if (!current.done) {
        if (!progress) return 'Looking through the folders…';
        return progress.note || `Searching by meaning… ${progress.done} of ${progress.total}`;
      }
      return current.capped && !current.error ? 'Checked the first 300 files found. To search more, open a smaller folder.' : '';
    }
    if (!current.done) return current.kind === 'words' ? 'Searching inside files…' : 'Searching…';
    return current.capped ? `Showing the first ${current.kind === 'words' ? 500 : LIMIT.toLocaleString()} — type more to narrow it` : '';
  }

  return {
    on,
    list,
    // The search box's hint says what it will look through.
    placeholder: (name) => {
      if (scope === 'deep') return `Search ${name} and the folders inside it`;
      if (scope === 'words') return `Type words to find inside files in ${name}, then press Enter`;
      if (scope === 'meaning') return `Describe what you're looking for in ${name}, then press Enter`;
      return null;
    },
    // The folder text on a search result's row, and the whole path as its hover text.
    tag(node, entry) {
      if (!current || entry.where === undefined) return;
      const where = entry.where || 'This folder';
      node.title = `${entry.name}\n${entry.folder}`;
      node.classList.add('found');
      node.querySelector('.name-text')?.after(el('span', 'search-where', where));
      node.querySelector('.tile-name')?.after(el('div', 'tile-detail', where));
      if (entry.score !== undefined) {
        // How close it is to what was described, as a bar rather than a number.
        const bar = el('span', 'search-score');
        const fill = el('i');
        fill.style.width = `${Math.max(6, Math.round(entry.score * 100))}%`;
        bar.append(fill);
        bar.title = 'How close it is to what you described';
        (node.querySelector('.name') || node.querySelector('.tile-text'))?.append(bar);
      }
    },
    // What an empty list says, and the status line above the list.
    emptyText: () => {
      if (!current.done) return '';
      if (current.error) return ''; // the line above the list says why
      if (current.kind === 'meaning') return `Nothing in ${shortFolder(current.root)} or the folders inside it looks close to that.`;
      if (current.kind === 'words') return `No text file in ${shortFolder(current.root)} or the folders inside it has those words.`;
      return `No results in ${shortFolder(current.root)} or the folders inside it.`;
    },
    decorate(rows) {
      if (!current) return;
      const text = statusText();
      if (!text) return;
      const line = el('div', 'search-status', text);
      if (current.kind === 'meaning' && !current.done) {
        const stopButton = el('button', 'search-stop', 'Stop');
        stopButton.addEventListener('click', () => {
          const mine = current;
          stopped();
          mine.done = true;
          mine.capped = false;
          redraw();
        });
        line.append(stopButton);
      }
      rows.prepend(line);
    },
    openLocationItems(entry, items) {
      if (!current || entry.where === undefined) return;
      items.splice(1, 0, { label: 'Open File Location', icon: 'folder_open', run: () => openLocation(entry) });
    },
    // A folder reloaded (Refresh, or after Delete, Rename, Paste): name results must be found again.
    // A search by meaning is never repeated by itself, since each one costs money.
    rerun() {
      if (current && current.kind === 'deep' && on()) begin(current.root, query(), 0);
    },
  };
})();
