/* GitHub on Home: "From GitHub" in the New menu opens a small bar above the projects to paste a
   repository; project cards show "3 new on GitHub"; the project menu gets the updates. All the git
   work is in lib/github.js. This file loads after app.js and uses its helpers. */
const ghUi = (() => {
  const bar = $('gh-bar');
  const known = new Map(); // project -> { behind, page }, from the background checks
  let open = false;
  let busy = false;
  let checking = false;
  let input;
  let note;
  let fill;
  let stage;
  let getButton;
  let cancelButton;
  let stopButton;

  function build() {
    input = el('input', 'gh-input');
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = 'github.com/owner/repo, or just owner/repo';
    input.setAttribute('aria-label', 'GitHub repository');
    getButton = el('button', 'gh-btn primary', 'Get Project');
    cancelButton = el('button', 'gh-btn', 'Cancel');
    stopButton = el('button', 'gh-btn', 'Stop');
    fill = el('div', 'gh-fill');
    const track = el('div', 'gh-track');
    track.append(fill);
    stage = el('span', 'gh-stage');
    note = el('div', 'gh-note');
    const form = el('div', 'gh-row gh-form');
    form.append(icon('arrow_download-filled', 'tint-blue'), input, getButton, cancelButton);
    const progress = el('div', 'gh-row gh-progress');
    progress.append(stage, track, stopButton);
    bar.append(form, progress, note);
    getButton.addEventListener('click', submit);
    cancelButton.addEventListener('click', close);
    stopButton.addEventListener('click', () => { stopButton.disabled = true; call('githubStop').catch(() => {}); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      else if (event.key === 'Escape') close();
      event.stopPropagation();
    });
  }

  function paint() {
    bar.hidden = !(open && atHome());
    bar.classList.toggle('busy', busy);
    input.disabled = busy;
    getButton.disabled = busy;
    stopButton.disabled = false;
  }

  function openForm() {
    if (!input) build();
    open = true;
    note.textContent = '';
    note.classList.remove('bad');
    if (!atHome()) navigate(HOME_PAGE);
    paint();
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  function close() {
    if (busy) return;
    open = false;
    paint();
  }

  async function submit() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    busy = true;
    note.classList.remove('bad');
    note.textContent = '';
    stage.textContent = 'Connecting';
    fill.style.width = '0%';
    paint();
    try {
      const made = await call('githubClone', text);
      busy = false;
      open = false;
      input.value = '';
      paint();
      await refreshStatus();
      if (atHome()) renderHome();
      toast(`"${shortName(made.name, 24)}" is ready.`, 'Open Room', () => enterRoom(made.name));
    } catch (error) {
      busy = false;
      note.classList.add('bad');
      note.textContent = cleanError(error);
      paint();
    }
  }

  window.house.on('github:progress', ({ percent, label }) => {
    if (!busy) return;
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    stage.textContent = `${label} ${Math.floor(percent)}%`;
  });

  function badge(card, name) {
    card.querySelector('.gh-badge')?.remove();
    const behind = known.get(name)?.behind || 0;
    if (!behind) return;
    const tag = el('div', 'gh-badge', `${behind.toLocaleString()} new on GitHub`);
    tag.title = 'GitHub has changes this project doesn\'t have yet.\nRight-click the project, then Get updates from GitHub.';
    card.querySelector('.home-card-note')?.after(tag);
  }

  // Asks (quietly, in the background) which of these projects are on GitHub and have news.
  async function afterHome(names) {
    if (checking || !names.length) return;
    checking = true;
    try {
      const found = await call('githubCheck', names);
      for (const name of names) {
        if (found[name]) known.set(name, found[name]);
        else known.delete(name);
      }
      if (!atHome()) return;
      homeView.querySelectorAll('.home-card[data-project]').forEach((card) => badge(card, card.dataset.project));
    } catch { /* offline: no badges */ } finally {
      checking = false;
    }
  }

  async function pull(name) {
    toast('Getting updates from GitHub…');
    try {
      const result = await call('githubPull', name);
      known.set(name, { ...known.get(name), behind: 0 });
      homeView.querySelectorAll('.home-card[data-project]').forEach((card) => badge(card, card.dataset.project));
      toast(result.state === 'current' ? 'Already up to date.' : `Got ${result.count} new ${result.count === 1 ? 'change' : 'changes'} from GitHub.`);
    } catch (error) {
      hideToast();
      await alertBox('Couldn\'t get updates', cleanError(error));
    }
  }

  async function openPage(name) {
    try {
      await call('openLink', await call('githubPage', name));
    } catch (error) {
      await alertBox('That didn\'t work', cleanError(error));
    }
  }

  // Extra items for a project's right-click menu: only for projects known to be from GitHub.
  function menuItems(project) {
    if (!known.has(project.name)) return [];
    return [
      '-',
      { label: 'Get updates from GitHub', icon: 'arrow_download-filled', tint: 'tint-blue', run: () => pull(project.name) },
      { label: 'Open on GitHub', icon: 'link', run: () => openPage(project.name) },
    ];
  }

  return {
    openForm,
    homeShown: () => { if (input) paint(); },
    decorate: (card, name) => badge(card, name),
    afterHome,
    menuItems,
  };
})();
window.ghUi = ghUi;
