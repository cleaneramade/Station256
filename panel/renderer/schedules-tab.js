/* ---------- The Schedules page: tasks that run again and again in a project's room ---------- */

// The list, the saving and the running are in lib/schedules.js (the main process). This page only
// shows them and asks for changes. Loaded after app.js, which it shares its small helpers with.

const schedulesView = el('section', 'sch-view');
schedulesView.hidden = true;
$('rules-view').after(schedulesView);
let schedData = null; // what the main process last said: { tasks, problem, fast, limitMinutes }

const SCHEDULE_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SCHEDULE_CHOICES = [
  ['minutes', 'Every few minutes'],
  ['hourly', 'Every hour'],
  ['daily', 'Every day'],
  ['weekdays', 'Weekdays (Monday to Friday)'],
  ['weekly', 'Every week'],
  ['cron', 'Advanced: cron text'],
];

// One Schedules tab. Asking again goes back to it.
function openSchedules() {
  const existing = state.tabs.find((tab) => tab.kind === 'schedules');
  if (existing) {
    activateTab(existing);
    return existing;
  }
  const tab = { kind: 'schedules' };
  addTabElement(tab, 'Schedules');
  state.tabs.push(tab);
  renderTabButtons();
  activateTab(tab);
  return tab;
}

// Called by activateTab for every tab: this page shows only when it is the one in front.
window.schedulesPage = {
  show(tab) {
    schedulesView.hidden = tab.kind !== 'schedules';
    if (!schedulesView.hidden) refreshSchedules();
  },
};
window.house.on('schedules:update', () => { if (!schedulesView.hidden) refreshSchedules(); });

async function refreshSchedules() {
  try {
    schedData = await call('schedulesList');
  } catch (error) {
    schedData = { tasks: [], problem: `The schedules couldn't be read: ${cleanError(error)}`, fast: false, limitMinutes: 30 };
  }
  renderSchedules();
}

// "Today 9:00 PM", "Yesterday 9:00 PM", "Tue 9:00 PM" or "Nov 3, 9:00 PM".
function scheduleTime(ms) {
  const at = new Date(ms);
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(at)) / 86400000);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function scheduleButton(label, tip, onClick, danger) {
  const button = el('button', `btn small sch-btn${danger ? ' sch-danger' : ''}`, label);
  button.type = 'button';
  button.title = tip;
  button.addEventListener('click', onClick);
  return button;
}

function renderSchedules() {
  if (schedulesView.hidden || !schedData) return;
  const page = el('div', 'sch-page');
  const head = el('div', 'rules-head');
  const add = el('button', 'btn primary rules-done', 'Add task');
  add.type = 'button';
  add.addEventListener('click', () => editSchedule(null));
  head.append(el('h2', 'rules-title', 'Schedules'), el('p', 'rules-intro', 'Run a command or an AI prompt in a project\'s room, again and again.'), add);
  page.append(head);
  page.append(el('p', 'sch-note', 'Tasks run whenever the Linux house is awake. A run missed while it was asleep is skipped.'));
  if (schedData.problem) page.append(el('p', 'sch-problem', schedData.problem));

  if (!schedData.tasks.length) page.append(el('p', 'sch-empty', 'No tasks yet. Add one to run something on a repeat.'));
  for (const task of schedData.tasks) page.append(scheduleCard(task));
  page.append(el('p', 'rules-foot', `A run is stopped after ${schedData.limitMinutes} minutes. The last 20 outputs of each task are kept. Closing Station 256 does not stop tasks. A room a task had to start is closed again when it is done, unless something else is running in it by then.`));

  const scroll = schedulesView.scrollTop;
  schedulesView.replaceChildren(page);
  schedulesView.scrollTop = scroll;
}

function scheduleCard(task) {
  const card = el('div', `sch-task${task.enabled ? '' : ' paused'}`);
  const text = el('div', 'sch-text');
  const title = el('div', 'sch-name');
  title.append(el('span', 'sch-title', task.name), el('span', 'rules-chip sch-chip', task.kind === 'ai' ? 'AI prompt' : 'Command'));
  if (!task.enabled) title.append(el('span', 'rules-chip sch-chip', 'Paused'));
  text.append(title);
  text.append(el('div', 'sch-meta', `${task.projects.join(', ')}  ·  ${task.words}`));
  text.append(el('div', 'sch-meta', task.enabled ? `Next run: ${task.nextLabel || 'none'}` : 'Next run: paused'));
  const last = el('div', 'sch-meta sch-last');
  if (task.running) {
    last.textContent = 'Running now...';
  } else if (task.last && task.projects.length > 1 && task.last.results) {
    // One line for each project: ✓ or ✗, and why if it didn't work.
    last.append(document.createTextNode(`Last run ${scheduleTime(task.last.at)}:`));
    for (const one of task.last.results) {
      const line = el('div', 'sch-result');
      line.append(el('span', one.ok ? 'sch-ok' : 'sch-bad', one.ok ? '✓' : '✗'), document.createTextNode(` ${one.project}${one.ok ? '' : `: ${one.note}`}`));
      last.append(line);
    }
  } else if (task.last) {
    last.append(el('span', task.last.ok ? 'sch-ok' : 'sch-bad', task.last.ok ? '✓' : '✗'), document.createTextNode(` ${task.last.ok ? 'Worked' : (task.last.note || 'Failed')}, ${scheduleTime(task.last.at)}`));
  } else {
    last.textContent = 'Not run yet';
  }
  text.append(last);
  if (task.lastSkip) text.append(el('div', 'sch-meta', `${task.lastSkip.note} (${scheduleTime(task.lastSkip.at)})`));

  const actions = el('div', 'sch-actions');
  const run = scheduleButton('Run now', 'Run this task once, right now', async () => { await attempt(() => call('schedulesRun', task.id)); refreshSchedules(); });
  run.disabled = task.running;
  actions.append(
    run,
    scheduleButton(task.enabled ? 'Pause' : 'Resume', task.enabled ? 'Stop running this on its schedule' : 'Run this on its schedule again', async () => { await attempt(() => call('schedulesEnable', task.id, !task.enabled)); refreshSchedules(); }),
    scheduleButton('Edit', 'Change this task', () => editSchedule(task)),
    scheduleButton('View output', 'What the last run printed', () => viewScheduleOutput(task)),
    scheduleButton('Delete', 'Delete this task', async () => {
      if (!(await confirmBox('Delete this task?', `"${task.name}" will stop running, and its saved output is deleted.`, 'Delete', true))) return;
      await attempt(() => call('schedulesDelete', task.id));
      refreshSchedules();
    }, true),
  );
  card.append(text, actions);
  return card;
}

async function viewScheduleOutput(task) {
  const out = await attempt(() => call('schedulesOutput', task.id));
  if (!out) return;
  showDialog((host, done) => {
    host.classList.add('sch-dialog');
    dialogFrame(host, `Last output: ${task.name}`, out.at ? `Run ${scheduleTime(out.at)}` : '');
    const pre = el('pre', 'sch-output', out.text || 'Nothing yet. This task has not run, or its output is gone.');
    host.append(pre);
    dialogButtons(host, [{ label: 'Close', primary: true, onClick: () => done() }]);
  });
}

// The form for a new task (null) or an existing one.
async function editSchedule(task) {
  const projects = await attempt(() => call('schedulesProjects'));
  if (!projects) return;
  if (!projects.length) {
    await alertBox('No projects yet', 'Make a project first. A task runs in a project\'s room.');
    return;
  }
  const saved = await showDialog((host, done) => {
    host.classList.add('sch-dialog');
    dialogFrame(host, task ? 'Edit task' : 'Add task', '');
    const form = {
      kind: task ? task.kind : 'command',
      mode: task ? task.when.mode : 'daily',
      n: task && task.when.mode === 'minutes' ? task.when.n : 15,
      time: task && task.when.time ? task.when.time : '09:00',
      day: task && task.when.mode === 'weekly' ? task.when.day : 1,
      text: task && task.when.mode === 'cron' ? task.when.text : '0 9 * * 1-5',
    };
    const field = (label, control) => {
      const wrap = el('label', 'sch-field');
      wrap.append(el('span', 'sch-label', label), control);
      host.append(wrap);
      return control;
    };
    const name = field('Name', el('input', 'dialog-input'));
    name.value = task ? task.name : '';
    name.maxLength = 60;
    name.placeholder = 'For example: Nightly tests';
    // One or several projects: a run does each one in turn.
    const picked = new Set(task ? task.projects : [projects[0]]);
    const projectBox = field('Projects (pick one or more)', el('div', 'sch-projects'));
    projects.forEach((one) => {
      const row = el('label', 'sch-check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = picked.has(one);
      box.addEventListener('change', () => { if (box.checked) picked.add(one); else picked.delete(one); });
      row.append(box, el('span', '', one));
      projectBox.append(row);
    });

    const kindRow = el('div', 'segmented sch-kind');
    const area = el('textarea', 'dialog-input sch-area');
    area.value = task ? task.run : '';
    area.spellcheck = false;
    const help = el('p', 'sch-help');
    const kinds = { command: ['Command', 'The command to run, in the project\'s folder', 'npm test'], ai: ['AI prompt', 'What to ask the AI', 'Look for broken links and fix them.'] };
    const showKind = () => {
      Object.keys(kinds).forEach((key) => kindRow.querySelector(`[data-kind="${key}"]`).classList.toggle('on', key === form.kind));
      areaLabel.textContent = kinds[form.kind][1];
      area.placeholder = kinds[form.kind][2];
      help.textContent = form.kind === 'ai'
        ? 'Runs Claude without a window, in the project\'s room. The room\'s House Rules still apply. Nobody is there to answer, so anything the rules say to Ask about is not done.'
        : 'Runs in each project\'s room, in the project folder. A room that is off is started first, and closed again after if nothing else is using it.';
    };
    Object.entries(kinds).forEach(([key, [label]]) => {
      const button = el('button', 'segment', label);
      button.type = 'button';
      button.dataset.kind = key;
      button.addEventListener('click', () => { form.kind = key; showKind(); });
      kindRow.append(button);
    });
    field('What to run', kindRow);
    const areaWrap = el('label', 'sch-field');
    const areaLabel = el('span', 'sch-label');
    areaWrap.append(areaLabel, area);
    host.append(areaWrap, help);

    const modeSelect = field('When', el('select', 'dialog-input'));
    SCHEDULE_CHOICES.forEach(([key, label]) => modeSelect.append(new Option(label, key)));
    modeSelect.value = form.mode;
    const extras = el('div', 'sch-extras');
    host.append(extras);
    const next = el('p', 'sch-next');
    const problem = el('p', 'sch-error');
    host.append(next, problem);

    const getWhen = () => {
      if (form.mode === 'minutes') return { mode: 'minutes', n: form.n };
      if (form.mode === 'daily' || form.mode === 'weekdays') return { mode: form.mode, time: form.time };
      if (form.mode === 'weekly') return { mode: 'weekly', day: form.day, time: form.time };
      if (form.mode === 'cron') return { mode: 'cron', text: form.text };
      return { mode: 'hourly' };
    };
    let waiting = 0;
    const preview = async () => {
      const mine = ++waiting;
      let answer;
      try { answer = await call('schedulesPreview', getWhen()); } catch (error) { answer = { ok: false, error: cleanError(error) }; }
      if (mine !== waiting) return;
      next.textContent = answer.ok ? `Next run: ${answer.nextLabel}` : answer.error;
      next.classList.toggle('bad', !answer.ok);
    };
    const showMode = () => {
      form.mode = modeSelect.value;
      extras.replaceChildren();
      const add = (label, control, key, type) => {
        control.value = form[key];
        control.addEventListener('input', () => { form[key] = type === 'number' ? Number(control.value) : control.value; preview(); });
        const wrap = el('label', 'sch-field');
        wrap.append(el('span', 'sch-label', label), control);
        extras.append(wrap);
      };
      if (form.mode === 'minutes') {
        const input = el('input', 'dialog-input');
        input.type = 'number';
        input.min = schedData && schedData.fast ? 1 : 5;
        add('Every how many minutes (5 or more)', input, 'n', 'number');
      }
      if (form.mode === 'weekly') {
        const select = el('select', 'dialog-input');
        SCHEDULE_DAYS.forEach((day, i) => select.append(new Option(day, i)));
        add('Day', select, 'day', 'number');
      }
      if (form.mode === 'daily' || form.mode === 'weekdays' || form.mode === 'weekly') {
        const input = el('input', 'dialog-input');
        input.type = 'time';
        add('At', input, 'time');
      }
      if (form.mode === 'cron') {
        const input = el('input', 'dialog-input');
        input.spellcheck = false;
        add('Cron text: minute hour day-of-month month day-of-week', input, 'text');
        extras.append(el('p', 'sch-help', 'For example: 0 9 * * mon-fri is weekdays at 9:00 AM. */10 * * * * is every 10 minutes. Lists (1,15), ranges (1-5), steps (*/10) and names (mon, jan) work.'));
      }
      preview();
    };
    modeSelect.addEventListener('change', showMode);
    showKind();
    showMode();

    dialogButtons(host, [
      { label: 'Cancel', onClick: () => done(false) },
      {
        label: 'Save',
        primary: true,
        onClick: async () => {
          problem.textContent = '';
          try {
            await call('schedulesSave', { id: task ? task.id : undefined, name: name.value, projects: projects.filter((one) => picked.has(one)), kind: form.kind, run: area.value, when: getWhen(), enabled: task ? task.enabled : true });
            done(true);
          } catch (error) {
            problem.textContent = cleanError(error);
          }
        },
      },
    ]);
    setTimeout(() => name.focus(), 0);
  });
  if (saved) refreshSchedules();
}

$('schedules-btn').addEventListener('click', () => openSchedules());
