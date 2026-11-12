/* ---------- Local AI: a model running on this computer, and a chat with it ---------- */

// The page runs llama.cpp's server (lib/llama.js, in the main process, which also does all the talking
// to it: this page's security policy only allows its own files). Pick a .gguf model, Start, and chat
// when it says Ready. One Local AI tab. The page is built once and kept, so a chat survives going
// to another tab. Reply text is added to one text node as it arrives, so a long chat stays quick.
// Model text only ever goes in as text, never as page code.

const llamaView = $('llama-view');
const llamaPage = {
  built: false,
  data: null, // the latest from llamaOverview
  history: [], // the chat so far: { role, content }
  turn: null, // the reply being written: { id, bubble, words, line, text, typed }
  picked: null, // a model file typed in with Choose…
  next: 1,
};
const llamaParts = {}; // the page's own pieces, filled by buildLlama
const LLAMA_MISSING = 'Local AI uses llama.cpp, which isn\'t installed yet. To install it with a small model, open a House Terminal, type ~/house/system/install-llama.sh and press Enter. When it says it\'s ready, press Check again.';

// One Local AI tab. Asking again goes back to it.
function openLlama() {
  const existing = state.tabs.find((tab) => tab.kind === 'llama');
  if (existing) {
    activateTab(existing);
    return existing;
  }
  const tab = { kind: 'llama' };
  addTabElement(tab, 'Local AI');
  state.tabs.push(tab);
  renderTabButtons();
  activateTab(tab);
  return tab;
}

function showLlama() {
  if (!llamaPage.built) buildLlama();
  refreshLlama();
}

async function refreshLlama() {
  try {
    llamaPage.data = await call('llamaOverview');
  } catch (error) {
    llamaPage.data = null;
    llamaParts.missing.hidden = false;
    llamaParts.setup.hidden = true;
    llamaParts.chat.hidden = true;
    llamaParts.missing.firstChild.textContent = 'Local AI couldn\'t look for llama.cpp just now. Press Check again.';
    return;
  }
  llamaParts.missing.firstChild.textContent = LLAMA_MISSING;
  fillLlamaModels();
  const { data } = llamaPage;
  llamaParts.context.value = llamaParts.context.value || data.context;
  llamaParts.layers.value = llamaParts.layers.value || data.layers;
  showLlamaState(data.state);
}

function buildLlama() {
  llamaPage.built = true;
  const page = el('div', 'llama-page');
  const head = el('div', 'llama-head');
  head.append(el('h2', 'rules-title', 'Local AI'), el('p', 'rules-intro', 'Chat with an AI model that runs on this computer. Nothing you type leaves it.'));

  // llama.cpp isn't installed.
  const missing = el('div', 'llama-box');
  missing.append(el('p', 'llama-note', LLAMA_MISSING));
  const again = el('button', 'btn', 'Check again');
  again.type = 'button';
  again.addEventListener('click', refreshLlama);
  missing.append(again);

  // Model and Start / Stop.
  const setup = el('div', 'llama-box');
  const modelRow = el('div', 'llama-row');
  const select = el('select', 'llama-select');
  select.title = 'The model to run';
  select.addEventListener('change', () => llamaParts.start.disabled = !select.value);
  const choose = el('button', 'btn small', 'Choose…');
  choose.type = 'button';
  choose.title = 'Type the place of a .gguf model file';
  choose.addEventListener('click', () => {
    llamaParts.pathRow.hidden = !llamaParts.pathRow.hidden;
    if (!llamaParts.pathRow.hidden) llamaParts.path.focus();
  });
  modelRow.append(el('label', 'llama-label', 'Model'), select, choose);

  const pathRow = el('div', 'llama-row');
  pathRow.hidden = true;
  const path = el('input', 'llama-input llama-path');
  path.type = 'text';
  path.spellcheck = false;
  path.placeholder = '/home/you/models/name.gguf';
  const use = el('button', 'btn small', 'Use this file');
  use.type = 'button';
  const usePath = async () => {
    try {
      const info = await call('llamaModel', path.value.trim());
      // Kept for this window, so a later look for models (which only knows the usual folders) keeps it.
      llamaPage.picked = info;
      fillLlamaModels();
      select.value = info.path;
      llamaParts.start.disabled = false;
      llamaParts.problem.hidden = true;
      pathRow.hidden = true;
      path.value = '';
    } catch (error) {
      llamaParts.problem.textContent = cleanError(error);
      llamaParts.problem.hidden = false;
    }
  };
  use.addEventListener('click', usePath);
  path.addEventListener('keydown', (event) => { if (event.key === 'Enter') usePath(); });
  pathRow.append(path, use);

  const settings = el('div', 'llama-row');
  const numberBox = (label, title, min) => {
    const box = el('input', 'llama-input llama-number');
    box.type = 'number';
    box.min = String(min);
    box.title = title;
    const part = el('label', 'llama-label', label);
    settings.append(part, box);
    return box;
  };
  const context = numberBox('Memory size', 'How much of the chat the model can remember, in tokens. Bigger uses more memory.', 256);
  const layers = numberBox('GPU layers', 'How many parts of the model run on the graphics card. 0 keeps it all on the processor.', 0);

  const controls = el('div', 'llama-row');
  const start = el('button', 'btn primary', 'Load model');
  start.title = 'Loads the model into memory. Big models can take a minute.';
  start.type = 'button';
  start.addEventListener('click', startLlama);
  const stop = el('button', 'btn', 'Unload model');
  stop.title = 'Ejects the model and gives its memory back to the computer';
  stop.type = 'button';
  stop.addEventListener('click', () => call('llamaStop').catch(() => {}));
  const status = el('span', 'llama-status', 'Not loaded');
  controls.append(start, stop, status);
  const memoryNote = el('p', 'llama-note', 'The model uses this computer\'s memory until you press Unload model or close this tab.');
  memoryNote.hidden = true;

  const problem = el('p', 'llama-problem');
  problem.hidden = true;
  const crashed = el('details', 'llama-log');
  crashed.hidden = true;
  const crashedTitle = el('summary', '', 'What it said before it stopped');
  const crashedText = el('pre', 'llama-log-text');
  crashed.append(crashedTitle, crashedText);
  setup.append(modelRow, pathRow, settings, controls, memoryNote, problem, crashed);

  // The chat.
  const chat = el('div', 'llama-chat');
  const list = el('div', 'llama-list');
  list.append(el('p', 'llama-empty', 'Load a model above, then say something.'));
  const composer = el('div', 'llama-composer');
  const box = el('textarea', 'llama-message');
  box.rows = 2;
  box.placeholder = 'Message (Enter sends, Shift+Enter adds a line)';
  box.disabled = true;
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendLlama();
    }
  });
  const buttons = el('div', 'llama-buttons');
  const send = el('button', 'btn primary', 'Send');
  send.type = 'button';
  send.disabled = true;
  send.addEventListener('click', sendLlama);
  const halt = el('button', 'btn', 'Stop generating');
  halt.type = 'button';
  halt.hidden = true;
  halt.addEventListener('click', () => { if (llamaPage.turn) call('llamaStopChat', llamaPage.turn.id).catch(() => {}); });
  const fresh = el('button', 'btn', 'New chat');
  fresh.type = 'button';
  fresh.addEventListener('click', newLlamaChat);
  buttons.append(send, halt, fresh);
  composer.append(box, buttons);
  chat.append(list, composer);

  // Nothing shows until the first look for llama-server is back.
  missing.hidden = true;
  setup.hidden = true;
  chat.hidden = true;
  list.addEventListener('scroll', () => {
    if (Math.abs(list.scrollTop - llamaScrolledTo) < 2) return; // our own scroll, maybe heard after more text came
    llamaFollow = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }, { passive: true });
  // The chat getting shorter (a smaller window, the page above it growing) keeps the newest text in view.
  if (window.ResizeObserver) new ResizeObserver(() => followLlama()).observe(list);
  page.append(head, missing, setup, chat);
  llamaView.replaceChildren(page);
  Object.assign(llamaParts, { missing, setup, select, pathRow, path, context, layers, start, stop, status, memoryNote, problem, crashed, crashedText, list, box, send, halt, chat });
}

function fillLlamaModels() {
  const { select } = llamaParts;
  const { models, model } = llamaPage.data;
  const { picked } = llamaPage;
  if (picked && !models.some((found) => found.path === picked.path)) models.push(picked);
  const keep = llamaPage.wanted || select.value || model || '';
  llamaPage.wanted = null;
  select.replaceChildren();
  if (!models.length) {
    const none = el('option', '', 'No models found: use Choose…');
    none.value = '';
    select.append(none);
  }
  for (const found of models) {
    const option = el('option', '', `${found.name}  (${formatSize(found.size)})`);
    option.value = found.path;
    select.append(option);
  }
  if (models.some((found) => found.path === keep)) select.value = keep;
  else if (!select.value) select.selectedIndex = 0;
}

// What the page shows for the server: Stopped, Loading…, Ready, or Stopped unexpectedly.
function showLlamaState(now) {
  const p = llamaParts;
  const installed = Boolean(llamaPage.data?.program);
  p.missing.hidden = installed;
  p.setup.hidden = !installed;
  p.chat.hidden = !installed;
  const running = now.status === 'loading' || now.status === 'ready';
  p.status.textContent = { loading: 'Loading the model…', ready: 'Ready', crashed: 'The model stopped by itself' }[now.status] || 'Not loaded';
  p.status.dataset.state = now.status;
  p.start.hidden = running;
  p.start.disabled = !p.select.value;
  p.stop.hidden = !running;
  for (const field of [p.select, p.context, p.layers]) field.disabled = running;
  p.memoryNote.hidden = !running;
  p.crashed.hidden = !(now.status === 'crashed' && now.log);
  if (now.status === 'crashed') p.crashedText.textContent = now.log || '';
  if (running || now.status === 'stopped') p.problem.hidden = true;
  if (now.status === 'crashed') {
    p.problem.textContent = 'The model stopped by itself. This usually means the computer ran out of memory. Try a smaller model, or a smaller Memory size, then press Load model again.';
    p.problem.hidden = false;
  }
  const ready = now.status === 'ready';
  p.box.disabled = !ready;
  p.send.disabled = !ready || Boolean(llamaPage.turn);
  p.list.querySelector('.llama-empty')?.replaceChildren(ready ? 'Say something to start.' : 'Load a model above, then say something.');
}

async function startLlama() {
  const p = llamaParts;
  p.problem.hidden = true;
  p.start.disabled = true;
  try {
    await call('llamaStart', { model: p.select.value, context: Number(p.context.value), layers: Number(p.layers.value) });
  } catch (error) {
    p.problem.textContent = cleanError(error);
    p.problem.hidden = false;
    p.start.disabled = false;
  }
}

window.house.on('llama:status', (now) => {
  if (!llamaPage.built || !llamaPage.data) return;
  showLlamaState(now);
});

// Keeps the list showing the newest text, unless you've scrolled up to read.
let llamaFollow = true;
let llamaScrolling = false;
let llamaScrolledTo = -1; // where we last scrolled it: that scroll isn't the person scrolling up
function followLlama() {
  if (llamaScrolling) return;
  llamaScrolling = true;
  requestAnimationFrame(() => {
    llamaScrolling = false;
    const { list } = llamaParts;
    if (!llamaFollow) return;
    list.scrollTop = list.scrollHeight;
    llamaScrolledTo = list.scrollTop;
  });
}

function addLlamaBubble(role, text) {
  const { list } = llamaParts;
  list.querySelector('.llama-empty')?.remove();
  const bubble = el('div', `llama-bubble ${role}`);
  const words = document.createTextNode(text);
  const body = el('div', 'llama-words');
  body.append(words);
  const line = el('div', 'llama-line');
  bubble.append(body, line);
  list.append(bubble);
  followLlama();
  return { bubble, words, line };
}

async function sendLlama() {
  const p = llamaParts;
  const text = p.box.value.trim();
  if (!text || llamaPage.turn || p.box.disabled) return;
  p.box.value = '';
  llamaPage.history.push({ role: 'user', content: text });
  llamaFollow = true;
  addLlamaBubble('user', text);
  const reply = addLlamaBubble('assistant', '');
  reply.line.textContent = 'Thinking…';
  const id = `c${Date.now().toString(36)}${llamaPage.next++}`;
  const turn = { id, ...reply, text: '', typed: text };
  llamaPage.turn = turn;
  p.halt.hidden = false;
  p.send.disabled = true;
  try {
    await call('llamaChat', id, llamaPage.history);
  } catch (error) {
    endLlamaTurn(turn, { error: cleanError(error) });
  }
}

window.house.on('llama:chat', (piece) => {
  const turn = llamaPage.turn;
  if (!turn || piece.id !== turn.id) return;
  if (piece.text) {
    if (!turn.text) turn.line.textContent = '';
    turn.text += piece.text;
    turn.words.appendData(piece.text);
    followLlama();
  }
  if (piece.done || piece.error) endLlamaTurn(turn, piece);
});

function endLlamaTurn(turn, piece) {
  if (llamaPage.turn !== turn) return;
  llamaPage.turn = null;
  const p = llamaParts;
  p.halt.hidden = true;
  if (piece.error) {
    if (turn.text) {
      // Part of a reply came: it stays, with its question, marked with what went wrong.
      turn.line.textContent = piece.error;
      turn.bubble.classList.add('broken');
      llamaPage.history.push({ role: 'assistant', content: turn.text });
    } else {
      // The question goes back in the box, and out of the chat, so it can be sent again.
      llamaPage.history.pop();
      turn.bubble.previousElementSibling?.remove();
      turn.bubble.remove();
      p.box.value = turn.typed;
      const note = addLlamaBubble('note', piece.error);
      note.line.remove();
    }
  } else {
    if (turn.text) llamaPage.history.push({ role: 'assistant', content: turn.text });
    else llamaPage.history.pop();
    if (!turn.text) {
      turn.bubble.previousElementSibling?.remove();
      turn.bubble.remove();
      p.box.value = turn.typed;
    } else if (piece.stopped) {
      turn.line.textContent = 'Stopped';
    } else {
      turn.line.textContent = piece.perSecond > 0 ? `${piece.perSecond} tokens per second` : 'Done';
    }
    followLlama(); // the line under the reply makes it taller
  }
  const ready = llamaPage.data && llamaParts.box.disabled === false;
  p.send.disabled = !ready;
  if (ready) p.box.focus();
}

// A .gguf model opened or right-clicked in Files: Local AI opens with it picked, ready to load.
async function useInLlama(file) {
  openLlama();
  let info;
  try {
    info = await call('llamaModel', file);
  } catch (error) {
    toast(cleanError(error));
    return;
  }
  llamaPage.picked = info;
  const now = llamaParts.status?.dataset.state;
  if (now === 'loading' || now === 'ready') {
    toast('Unload the model that is loaded first, then pick this one.');
    return;
  }
  llamaPage.wanted = info.path;
  if (llamaPage.data) {
    fillLlamaModels();
    showLlamaState(llamaPage.data.state);
  }
}

// Closing the tab unloads the model too: its memory (and the graphics card's) isn't held for a page
// you can't see. Moving the tab to another window isn't closing it.
function closeLlama() {
  const now = llamaParts.status?.dataset.state;
  if (now !== 'loading' && now !== 'ready') return;
  if (llamaPage.turn) call('llamaStopChat', llamaPage.turn.id).catch(() => {});
  call('llamaStop').catch(() => {});
  toast('Local AI: the model was unloaded.');
}

function newLlamaChat() {
  const turn = llamaPage.turn;
  if (turn) call('llamaStopChat', turn.id).catch(() => {});
  llamaPage.turn = null;
  llamaPage.history = [];
  const { list, halt, box } = llamaParts;
  halt.hidden = true;
  list.replaceChildren(el('p', 'llama-empty', box.disabled ? 'Load a model above, then say something.' : 'Say something to start.'));
  if (!box.disabled) box.focus();
  llamaParts.send.disabled = box.disabled;
}

