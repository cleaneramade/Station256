/* ---------- API Keys: one place to add the keys Station's features use ---------- */

// New > API Keys (and the search box's menu) opens it. Each outside service a feature uses has a
// row: whether a key is saved, a box to paste a new one (it replaces the old), and Remove. The page
// only ever learns whether a key is saved, never the key: main.js keeps it in ~/.config/house,
// readable by the owner only. Another service is one more entry in KEY_SERVICES.
const KEY_SERVICES = [
  {
    id: 'jev',
    name: 'TypeSafe (Jev)',
    use: 'Search by meaning, from the search box\'s menu.',
    page: 'https://console.typesafe.ai',
    pageLabel: 'Get a key at console.typesafe.ai',
    isSet: () => call('jevKey'),
    save: (key) => call('setJevKey', key),
    remove: () => call('removeJevKey'),
  },
];

// Tells the features (search.js) that a key came or went, so they don't have to ask main again.
const keyChanged = (id, set) => window.dispatchEvent(new CustomEvent('house-key', { detail: { id, set } }));

function keyRow(service, saved) {
  let set = saved;
  const row = el('div', 'keys-row');
  row.dataset.service = service.id;
  const head = el('div', 'keys-head');
  const status = el('span', 'keys-status');
  head.append(el('span', 'keys-name', service.name), status);
  const field = el('input', 'dialog-input keys-field');
  field.type = 'password';
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.setAttribute('aria-label', `${service.name} key`);
  const problem = el('div', 'keys-problem');
  const save = el('button', 'btn primary keys-save', 'Save');
  const remove = el('button', 'btn keys-remove', 'Remove');
  const get = el('button', 'jev-link keys-get', service.pageLabel);
  [save, remove, get].forEach((button) => { button.type = 'button'; });
  const paint = () => {
    status.textContent = set ? 'Saved' : 'Not set';
    status.classList.toggle('set', set);
    field.placeholder = set ? 'Paste a new key to replace it' : 'Paste your key';
    remove.hidden = !set;
  };
  // Save and Remove take turns (a double click, or Save then Remove at once), and after each the
  // row asks main what is really saved, so what it says always matches the file.
  let turn = Promise.resolve();
  const inTurn = (work) => {
    turn = turn.then(work).catch(() => {});
    return turn;
  };
  const settle = async () => {
    const was = set;
    set = await service.isSet().then((answer) => answer === true, () => set);
    paint();
    if (set !== was || set) keyChanged(service.id, set);
  };
  const submit = () => inTurn(async () => {
    if (!field.value.trim()) {
      field.focus();
      return;
    }
    try {
      await service.save(field.value);
    } catch (error) {
      problem.textContent = cleanError(error);
      await settle();
      return;
    }
    field.value = ''; // the page doesn't keep it
    problem.textContent = '';
    await settle();
  });
  save.addEventListener('click', submit);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
  remove.addEventListener('click', () => inTurn(async () => {
    await service.remove().catch(() => {});
    await settle();
    problem.textContent = set ? 'The key couldn\'t be removed. Try again.' : '';
  }));
  get.addEventListener('click', () => call('openLink', service.page).catch(() => {}));
  const actions = el('div', 'keys-actions');
  actions.append(save, remove, get);
  row.append(head, el('div', 'keys-use', service.use), field, problem, actions);
  paint();
  return row;
}

async function openKeys() {
  const saved = await Promise.all(KEY_SERVICES.map((service) => service.isSet().then((set) => set === true, () => false)));
  return showDialog((host, done) => {
    host.classList.add('keys-dialog');
    dialogFrame(host, 'API Keys', 'Keys for features that use an outside service. A saved key stays on this computer and is never shown again.');
    KEY_SERVICES.forEach((service, index) => host.append(keyRow(service, saved[index])));
    dialogButtons(host, [{ label: 'Done', onClick: () => done() }]);
    // A key typed but not saved doesn't stay behind in the closed dialog.
    const fields = [...host.querySelectorAll('.keys-field')];
    host.addEventListener('close', () => fields.forEach((field) => { field.value = ''; }), { once: true });
    setTimeout(() => host.querySelector('.keys-field')?.focus(), 0);
  });
}
