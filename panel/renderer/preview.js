// One-click Preview (the work is in lib/preview.js): a project's Preview button starts its site in
// its room's background and opens the page. Right-click picks a site again. Loaded after app.js.
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

// Several sites in one project: one button each, "folder — what runs".
const pickSite = (sites) => showDialog((host, done) => {
  dialogFrame(host, `${sites.length} sites found`, 'Pick one to preview.');
  const what = (site) => `${site.folder || 'Top folder'} — ${site.command.split(' && ').pop()}`;
  dialogButtons(host, [
    ...sites.map((site) => ({ label: what(site).slice(0, 60), primary: true, onClick: () => done(site.folder) })),
    { label: 'Cancel', onClick: () => done(null) },
  ]);
});

// Opens a terminal in the project's room and shows the end of the failed site's log there.
async function previewLog(name) {
  const tab = await openTerminal({ room: name });
  if (tab && tab.termId) await call('previewLog', name, tab.termId);
}

// ask: the owner right-clicked the button, so the remembered site is asked about again.
async function previewProject(name, ask = false) {
  if (previewing.get(name) === 'starting') return;
  previewSet(name, 'starting');
  let state = null;
  try {
    let found = await call('previewBegin', name, undefined, ask);
    if (found.choose) {
      const folder = await pickSite(found.choose);
      if (typeof folder !== 'string') return;
      found = await call('previewBegin', name, folder);
    }
    if (found.running) {
      state = 'running';
      return;
    }
    if (!found.command) {
      toast(found.message);
      return;
    }
    // Runs in the room's background: no terminal tab, the button just says Starting…
    const result = await call('previewRun', name, found.folder, found.command, found.missing);
    if (result.ok) state = 'running';
    else toast(result.message, 'Show log', () => previewLog(name));
  } catch (error) {
    toast(cleanError(error));
  } finally {
    previewSet(name, state);
  }
}
document.addEventListener('contextmenu', (event) => {
  const button = event.target.closest?.('.preview-btn');
  if (button && button.dataset.project) previewProject(button.dataset.project, true);
});

// A site that was stopped (Stop, room closed) takes its "Open Preview" back to "Preview".
setInterval(async () => {
  for (const [name, value] of [...previewing]) {
    if (value !== 'running') continue;
    const up = await call('previewUp', name).catch(() => true);
    if (!up && previewing.get(name) === 'running') previewSet(name, null);
  }
}, 5000);
