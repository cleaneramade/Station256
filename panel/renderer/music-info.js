/* ---------- Songs in a page of their own: cover, player, song info ---------- */

// Double-clicking a song (or right-click, Edit song info, or the button in its preview) opens it in a
// tab, like a video: its cover on the left with a small player under it, and its title, artist, album
// and the rest on the right. Save puts the changed song in its place, the old one in the Trash with
// an Undo; Save as Copy makes "name (edited)" beside it. Only the info changes: the sound is copied
// untouched (lib/music.js checks that before anything replaces the song). Songs on Windows (C:) can
// be looked at but not changed. main.js: songInfo, songInfoSave.

const SONG_KINDS = /\.(mp3|flac|m4a|ogg|oga|opus|wav)$/i;
const songEditable = (entry) => !entry.isDir && SONG_KINDS.test(entry.name);
const SONG_FIELDS = [
  ['title', 'Title', 2], ['artist', 'Artist', 1], ['featured', 'Featured artists', 1], ['album', 'Album', 1], ['albumArtist', 'Album artist', 1],
  ['year', 'Year', 1], ['track', 'Track number', 1], ['genre', 'Genre', 2], ['comment', 'Comment', 2],
];
const MAX_NEW_COVER = 20 * 1024 * 1024;

function songInfoButton(entry) {
  const button = el('button', 'tool preview-close pe-edit-btn');
  button.type = 'button';
  button.title = 'Change its title, artist, album and cover picture';
  button.append(icon('music_note_2'), el('span', '', 'Song info'));
  button.addEventListener('click', () => {
    closePreview(true);
    openSong(entry.path);
  });
  return button;
}

// Opens the song in its page, or goes to it if it's already open in this window.
async function openSong(target) {
  const open = () => state.tabs.find((tab) => tab.kind === 'song' && tab.path === target);
  if (open()) {
    activateTab(open());
    return open();
  }
  let info = null;
  try {
    info = await call('songInfo', target);
  } catch (error) {
    // Until Station 256 restarts after an update, the part that reads songs isn't there yet.
    if (/Unknown request/.test(String(error?.message))) {
      toast('Songs open in their own page after Station 256 restarts.');
      showPreview({ path: target, name: baseName(target), isDir: false, size: 0, mtime: 0 });
    } else {
      await alertBox('That didn\'t work', cleanError(error));
    }
    return null;
  }
  if (open()) {
    activateTab(open());
    return open();
  }
  const tab = { kind: 'song', path: target, returnTo: state.active, host: el('div', 'doc-host sg-host') };
  tab.host.hidden = true;
  docArea.append(tab.host);
  buildSong(tab, info);
  addTabElement(tab, baseName(target));
  state.tabs.push(tab);
  renderTabButtons();
  activateTab(tab);
  return tab;
}

const songChanges = (tab) => Object.fromEntries(SONG_FIELDS.map(([field]) => field)
  .filter((field) => !tab.inputs[field].disabled && tab.inputs[field].value.trim() !== (tab.was[field] || '').trim())
  .map((field) => [field, tab.inputs[field].value]));
const songNotSaved = (tab) => Object.keys(songChanges(tab)).length > 0 || tab.cover !== undefined;

function buildSong(tab, info) {
  tab.windowsFile = inWindowsDrive(tab.path);
  tab.inputs = {};

  // Title row: name and how it stands.
  const head = el('div', 'doc-head');
  const titleRow = el('div', 'doc-title-row');
  const name = el('span', 'doc-name', baseName(tab.path));
  name.title = windowsPath(tab.path);
  tab.statusEl = el('span', 'doc-status');
  titleRow.append(fileIcon({ name: baseName(tab.path), path: tab.path }), name, tab.statusEl, el('div', 'grow'));
  head.append(titleRow);

  tab.body = el('div', 'sg-body');
  tab.foot = el('div', 'sg-foot');
  tab.problem = el('div', 'sg-problem');
  tab.copyButton = el('button', 'btn vt-save', 'Save as Copy');
  tab.copyButton.type = 'button';
  tab.copyButton.title = 'Save the changed song as a new one beside this';
  tab.copyButton.addEventListener('click', () => saveSong(tab, true));
  tab.saveButton = el('button', 'btn primary vt-save', 'Save');
  tab.saveButton.type = 'button';
  tab.saveButton.title = 'Save over this song (Ctrl+S). The old one goes to the Trash.';
  tab.saveButton.addEventListener('click', () => saveSong(tab, false));
  tab.foot.append(tab.problem, el('div', 'grow'), tab.copyButton, tab.saveButton);

  tab.host.append(head, tab.body, tab.foot);
  fillSong(tab, info);
}

// The page's contents from what the file says now (again after a save or an Undo).
function fillSong(tab, info) {
  tab.info = info;
  tab.was = { ...info.fields };
  tab.cover = undefined;
  tab.locked = !info.beside || !info.canEdit;
  tab.problem.textContent = '';
  tab.audio?.pause();
  tab.body.replaceChildren();

  // Left: the cover, and a small player under it.
  const left = el('div', 'sg-left');
  tab.coverBox = el('div', 'sg-cover');
  tab.picker = el('input');
  tab.picker.type = 'file';
  tab.picker.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';
  tab.picker.hidden = true;
  tab.canCover = !tab.locked && info.canCover;
  if (tab.canCover) {
    tab.coverBox.tabIndex = 0;
    tab.coverBox.classList.add('can-change');
    tab.coverBox.title = 'Click to choose a picture, or drop one here';
    tab.coverBox.addEventListener('click', () => tab.picker.click());
    tab.coverBox.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); tab.picker.click(); } });
    tab.coverBox.addEventListener('dragover', (event) => { event.preventDefault(); event.stopPropagation(); tab.coverBox.classList.add('over'); });
    tab.coverBox.addEventListener('dragleave', () => tab.coverBox.classList.remove('over'));
    tab.coverBox.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      tab.coverBox.classList.remove('over');
      const file = event.dataTransfer?.files?.[0];
      if (file) useSongCover(tab, file);
    });
    tab.picker.addEventListener('change', () => {
      const file = tab.picker.files[0];
      tab.picker.value = '';
      if (file) useSongCover(tab, file);
    });
  }
  drawSongCover(tab, info.coverUrl);
  tab.removeCover = el('button', 'btn small', 'Remove cover');
  tab.removeCover.type = 'button';
  tab.removeCover.addEventListener('click', () => {
    tab.cover = null;
    drawSongCover(tab, null);
    refreshSong(tab);
  });
  left.append(tab.coverBox, tab.picker, tab.removeCover);
  if (info.coverNote) left.append(el('div', 'sg-hint', info.coverNote));
  left.append(songPlayer(tab));

  // Right: a note if it can't be changed, the fields, and the facts as a quiet line.
  const right = el('div', 'sg-right');
  if (tab.locked) {
    right.append(el('div', 'sg-note', tab.windowsFile
      ? 'Songs on Windows (C:) can be viewed here but not changed. Copy it into the house to edit it.'
      : info.canEdit ? 'Songs in the Trash can\'t be changed. Restore it first.' : 'This kind of song can\'t be changed here.'));
  } else if (info.kind === 'wav') {
    right.append(el('div', 'sg-note', 'WAV files can\'t hold a cover picture or an album artist, so those are left out.'));
  } else if (!info.canCover) {
    right.append(el('div', 'sg-note', 'This kind of song can\'t hold a cover picture here.'));
  }
  const form = el('div', 'sg-form');
  for (const [field, label, span] of SONG_FIELDS) {
    const row = el('label', `sg-row${span === 2 ? ' wide' : ''}`);
    const input = el(field === 'comment' ? 'textarea' : 'input', 'dialog-input sg-input');
    if (field === 'comment') input.rows = 3;
    input.value = tab.was[field] || '';
    input.spellcheck = false;
    input.disabled = tab.locked || info.without.includes(field);
    if (field === 'year') input.placeholder = '2024';
    if (field === 'track') input.placeholder = '3 or 3/12';
    if (field === 'featured') input.placeholder = 'Shown as "Artist feat. …"';
    input.addEventListener('input', () => refreshSong(tab));
    row.append(el('span', 'sg-label', label), input);
    form.append(row);
    tab.inputs[field] = input;
  }
  right.append(form);
  const bits = [info.length ? clockTime(info.length) : '', `${info.kind.toUpperCase()}${info.codec && info.codec !== info.kind ? ` (${info.codec})` : ''}`,
    info.bitrate ? `${Math.round(info.bitrate / 1000)} kbps` : '', info.sampleRate ? `${(info.sampleRate / 1000).toFixed(info.sampleRate % 1000 ? 1 : 0)} kHz` : ''].filter(Boolean);
  right.append(el('div', 'sg-facts', bits.join('  ·  ')));
  tab.body.append(left, right);

  // Save buttons only where saving is possible.
  tab.copyButton.hidden = tab.saveButton.hidden = tab.locked;
  refreshSong(tab);
}

function drawSongCover(tab, url) {
  tab.coverBox.replaceChildren();
  if (url) {
    const image = el('img');
    image.alt = 'Cover picture';
    image.draggable = false;
    image.src = url;
    tab.coverBox.append(image);
  } else {
    tab.coverBox.append(icon('music_note_2'));
    if (tab.canCover) tab.coverBox.append(el('span', 'sg-cover-hint', 'Click or drop a picture'));
  }
  tab.hasShownCover = Boolean(url);
}

// A picked or dropped picture becomes the cover (the house makes it a plain JPEG when saving).
async function useSongCover(tab, file) {
  if (!/^image\//.test(file.type)) { tab.problem.textContent = 'That isn\'t a picture.'; return; }
  if (file.size > MAX_NEW_COVER) { tab.problem.textContent = 'That picture is too big to use as a cover.'; return; }
  const [bytes, url] = await Promise.all([
    file.arrayBuffer(),
    new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => resolve(null); reader.readAsDataURL(file); }),
  ]);
  if (tab.closed || !url) return;
  tab.cover = new Uint8Array(bytes);
  tab.problem.textContent = '';
  drawSongCover(tab, url);
  refreshSong(tab);
}

// Play, a slider and the time. The page's own audio does the playing.
function songPlayer(tab) {
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = `${fileUrl(tab.path)}?v=${Math.round(Date.now() / 1000)}`;
  tab.audio = audio;
  const bar = el('div', 'sg-player');
  const play = el('button', 'vt-tool vt-play');
  play.type = 'button';
  play.title = 'Play (Space)';
  play.append(icon('play-filled'));
  const seek = el('input', 'sg-seek');
  seek.type = 'range';
  seek.min = '0';
  seek.max = '1000';
  seek.value = '0';
  const time = el('span', 'vt-time sg-time', `0:00 / ${clockTime(tab.info.length)}`);
  const length = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : tab.info.length);
  const draw = () => {
    time.textContent = `${clockTime(audio.currentTime)} / ${clockTime(length())}`;
    if (!tab.seeking && length()) seek.value = String(Math.round((audio.currentTime / length()) * 1000));
  };
  tab.playToggle = () => { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); };
  play.addEventListener('click', tab.playToggle);
  audio.addEventListener('play', () => play.replaceChildren(icon('pause-filled')));
  audio.addEventListener('pause', () => play.replaceChildren(icon('play-filled')));
  audio.addEventListener('timeupdate', draw);
  audio.addEventListener('ended', () => { audio.currentTime = 0; draw(); });
  seek.addEventListener('pointerdown', () => { tab.seeking = true; });
  seek.addEventListener('input', () => { audio.currentTime = (Number(seek.value) / 1000) * length(); draw(); });
  seek.addEventListener('change', () => { tab.seeking = false; });
  bar.append(play, seek, time);
  return bar;
}

function refreshSong(tab) {
  if (tab.closed) return;
  const changed = !tab.locked && songNotSaved(tab);
  tab.copyButton.disabled = tab.saving || !changed;
  tab.saveButton.disabled = tab.saving || !changed;
  tab.removeCover.disabled = !tab.canCover || !tab.hasShownCover;
  tab.removeCover.hidden = !tab.canCover;
  tab.host.classList.toggle('saving', Boolean(tab.saving));
  const node = tab.statusEl;
  node.className = 'doc-status';
  node.replaceChildren();
  let text = '';
  if (tab.saving) {
    text = 'Saving…';
  } else if (tab.locked) {
    node.classList.add('locked');
    node.append(icon('lock_closed-filled'));
    text = 'View only';
  } else if (changed) {
    text = 'Not saved yet';
  }
  if (text) node.append(el('span', '', text));
}

async function saveSong(tab, copy) {
  if (tab.saving || tab.closed || tab.locked || !songNotSaved(tab)) return;
  tab.saving = true;
  tab.problem.textContent = '';
  refreshSong(tab);
  const path = tab.path;
  try {
    const saved = await call('songInfoSave', path, songChanges(tab), tab.cover, copy);
    if (copy) {
      toast(`Saved as "${shortName(baseName(saved.path), 40)}"`, 'Show', () => openLocation({ path: saved.path, folder: parentOf(saved.path) }));
    } else {
      toast('Saved. The old song is in the Trash.', 'Undo', async () => {
        await attempt(() => call('putFileBack', path, saved.kept));
        if (!tab.closed) await reloadSong(tab);
        loadFolder();
      });
      if (!tab.closed) await reloadSong(tab);
    }
    if (state.active?.kind === 'files') loadFolder();
  } catch (error) {
    tab.problem.textContent = cleanError(error);
  } finally {
    tab.saving = false;
    refreshSong(tab);
  }
}

// The song as it is now, after a save or an Undo.
async function reloadSong(tab) {
  const info = await attempt(() => call('songInfo', tab.path));
  if (info && !tab.closed) fillSong(tab, info);
}

function showSong(tab) {
  requestAnimationFrame(() => {
    if (tab.closed || state.active !== tab) return;
    $('item-count').textContent = `${clockTime(tab.info.length)}   ${tab.info.kind.toUpperCase()}`;
  });
}

// Closing asks first if there are changes not saved.
async function songMayClose(tab) {
  if (tab.saving) return confirmBox('Close while saving?', 'This song is still being saved. Closing is safe: the song is only replaced once the new one is checked and ready.', 'Close', false);
  if (!tab.locked && songNotSaved(tab)) return confirmBox('Close without saving?', 'Your changes to this song aren\'t saved.', 'Close', true);
  return true;
}

function closeSong(tab) {
  if (tab.closed) return;
  tab.closed = true;
  tab.audio?.pause();
  tab.audio?.removeAttribute('src');
  tab.host.remove();
}

// Keys for a song's page: Ctrl+S saves, Space plays when no field is being typed in.
document.addEventListener('keydown', (event) => {
  const tab = state.active;
  if (tab?.kind !== 'song' || dialog.open || !preview.hidden) return;
  if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveSong(tab, false);
  } else if (event.key === ' ' && !event.target.matches?.('input, textarea, button')) {
    event.preventDefault();
    tab.playToggle?.();
  }
});
