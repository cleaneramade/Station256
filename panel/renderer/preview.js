// One-click Preview (the work is in lib/preview.js): a project's Preview button starts its site in
// its room, in a terminal tab you can see, and opens the page. Loaded after app.js.
const previewing = new Map(); // project name → 'starting' | 'running'

const previewLabel = (name) => (previewing.get(name) === 'starting' ? 'Starting…' : previewing.get(name) === 'running' ? 'Open Preview' : 'Preview');
// The words for the card's button, which shows only an icon.
const previewTip = (name) => (previewing.get(name) === 'starting' ? 'Starting the site…' : previewing.get(name) === 'running' ? 'Open Preview' : 'Preview — start this project\'s site and open it');

// Shows a button's state: turning while the site starts, a green dot once it's up.
function previewPaint(button) {
  const value = previewing.get(button.dataset.project);
  button.title = previewTip(button.dataset.project);
  button.setAttribute('aria-label', button.title);
  button.classList.toggle('busy', value === 'starting');
  button.classList.toggle('running', value === 'running');
  const words = button.querySelector('span'); // the top bar's button has words; a card's has none
  if (words) words.textContent = previewLabel(button.dataset.project);
}

function previewSet(name, value) {
  if (value) previewing.set(name, value);
  else previewing.delete(name);
  document.querySelectorAll('.preview-btn').forEach((button) => {
    if (button.dataset.project === name) previewPaint(button);
  });
}

async function previewProject(name) {
  if (previewing.get(name) === 'starting') return;
  previewSet(name, 'starting');
  let state = null;
  try {
    const found = await call('previewBegin', name);
    if (found.running) {
      state = 'running';
      return;
    }
    if (!found.command) {
      toast(found.message);
      return;
    }
    // The room starts here if it isn't open, and the command is typed into its new terminal.
    const tab = await openTerminal({ room: name, cwd: found.folder });
    if (!tab || !tab.termId) {
      toast('Station couldn\'t open this project\'s room, so Preview didn\'t start.');
      return;
    }
    const result = await call('previewRun', name, tab.termId, found.command, found.missing);
    if (result.ok) state = 'running';
    else toast(result.message);
  } catch (error) {
    toast(cleanError(error));
  } finally {
    previewSet(name, state);
  }
}

// A site that was stopped (Ctrl+C, room closed) takes its "Open Preview" back to "Preview".
setInterval(async () => {
  for (const [name, value] of [...previewing]) {
    if (value !== 'running') continue;
    const up = await call('previewUp', name).catch(() => true);
    if (!up && previewing.get(name) === 'running') previewSet(name, null);
  }
}, 5000);

// The button: only an icon, the size of the ▾ beside Enter Room, so every card keeps one row.
function previewButton(project) {
  const button = el('button', 'home-card-btn more preview-btn');
  button.dataset.project = project.name;
  button.append(icon('open', 'tint-blue'));
  previewPaint(button);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    previewProject(project.name);
  });
  return button;
}
