/* ---------- Videos in a page of their own: watch, a quick trim, save ---------- */

// Double-clicking a video opens it in a tab, like a note: a plain player in Station's own look.
// Under it is its timeline, a row of its frames, with blue handles at each end for a quick trim
// (or Start Here / End Here, keys I and O). Save as Copy makes "name (edited)"; Save puts the
// trimmed video in its place, the old one in the Trash, with Undo. Real editing (cuts, text,
// music, effects) is the Editor's job. A video the page can't play by itself (AVI, WMV, HEVC...)
// is made ready to play first. The house's ffmpeg does the work (lib/video.js).

const VIDEO_SHORTEST = 0.1; // seconds: the least a trimmed video can be
const VIDEO_JUMP = 5; // seconds, for the arrow keys

const opensAsVideo = (entry) => !entry.isDir && ANY_VIDEO.test(entry.name);
const newJob = () => `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const roundTime = (seconds) => Math.round(seconds * 1000) / 1000;
const clampTo = (value, low, high) => Math.min(high, Math.max(low, value));

// 1:05 or 1:05.3; hours when it's that long.
function clockTime(seconds, tenths = false) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const whole = Math.floor(total % 60);
  const pad = (value) => String(value).padStart(2, '0');
  let text = hours ? `${hours}:${pad(minutes)}:${pad(whole)}` : `${minutes}:${pad(whole)}`;
  if (tenths) text += `.${Math.min(9, Math.floor((total - Math.floor(total)) * 10))}`;
  return text;
}

// The preview's button for a video: opens it in its page.
function videoEditButton(entry) {
  const button = el('button', 'tool preview-close pe-edit-btn');
  button.type = 'button';
  button.title = 'Open it to trim and save';
  button.append(icon('video_clip'), el('span', '', 'Trim'));
  button.addEventListener('click', () => {
    closePreview(true);
    openVideo(entry.path);
  });
  return button;
}

// Opens the video in its page, or goes to it if it's already open in this window. edits: a trim
// not saved yet, from a tab that came from another window.
async function openVideo(target, edits = null) {
  const open = () => state.tabs.find((tab) => tab.kind === 'video' && tab.path === target);
  if (open()) {
    activateTab(open());
    return open();
  }
  let info = null;
  try {
    info = await call('videoInfo', target);
  } catch (error) {
    // Until Station 256 restarts after an update, the part that works on videos isn't there yet.
    if (/Unknown request/.test(String(error?.message))) {
      toast('Videos open in their own page after Station 256 restarts.');
      if (VIDEO.test(target)) showPreview({ path: target, name: baseName(target), isDir: false, size: 0, mtime: 0 });
    } else {
      await alertBox('That didn\'t work', cleanError(error));
    }
    return null;
  }
  if (open()) {
    activateTab(open());
    return open();
  }
  const tab = { kind: 'video', path: target, returnTo: state.active, host: el('div', 'doc-host vt-host') };
  tab.host.hidden = true;
  docArea.append(tab.host);
  buildVideo(tab, info, edits);
  addTabElement(tab, baseName(target));
  state.tabs.push(tab);
  renderTabButtons();
  activateTab(tab);
  return tab;
}

/* The trim: kept from start to end */

const freshTrim = (info) => ({ start: 0, end: roundTime(info.duration), mute: false });
const trimKey = (trim) => JSON.stringify([trim.start, trim.end, trim.mute]);

function cleanTrim(raw, info) {
  const trim = freshTrim(info);
  if (!raw || typeof raw !== 'object') return trim;
  const time = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? clampTo(roundTime(value), 0, trim.end) : fallback);
  trim.start = time(raw.start, 0);
  trim.end = Math.max(trim.start + Math.min(VIDEO_SHORTEST, trim.end - trim.start), time(raw.end, trim.end));
  trim.mute = raw.mute === true && info.sound;
  return trim;
}

const trimLength = (trim) => Math.max(0, trim.end - trim.start);
const trimmed = (tab) => trimKey(tab.trim) !== trimKey(freshTrim(tab.info));
// The whole video untrimmed is the file as it is on disk, so there's nothing to lose (even after a
// trim was saved as a copy and then undone).
const notSaved = (tab) => trimmed(tab) && trimKey(tab.trim) !== tab.savedKey;

// A change is remembered for Undo once it's done (a drag counts once, when it's let go).
function rememberTrim(tab, before) {
  if (before === trimKey(tab.trim)) return;
  tab.past.push(before);
  if (tab.past.length > 300) tab.past.shift();
  tab.future = [];
  refreshVideo(tab);
}

function changeTrim(tab, change) {
  if (tab.job) return;
  const before = trimKey(tab.trim);
  change(tab.trim);
  rememberTrim(tab, before);
}

function undoVideo(tab) {
  if (tab.job || !tab.past.length) return;
  tab.future.push(trimKey(tab.trim));
  const [start, end, mute] = JSON.parse(tab.past.pop());
  tab.trim = { start, end, mute };
  refreshVideo(tab);
}

function redoVideo(tab) {
  if (tab.job || !tab.future.length) return;
  tab.past.push(trimKey(tab.trim));
  const [start, end, mute] = JSON.parse(tab.future.pop());
  tab.trim = { start, end, mute };
  refreshVideo(tab);
}

/* The page */

function videoButton(iconName, label, title, run) {
  const button = el('button', 'vt-tool');
  button.type = 'button';
  button.title = title;
  if (iconName) button.append(icon(iconName));
  if (label) button.append(el('span', '', label));
  button.addEventListener('mousedown', (event) => event.preventDefault()); // keys stay with the page
  button.addEventListener('click', run);
  return button;
}

function buildVideo(tab, info, edits) {
  tab.info = info;
  tab.trim = cleanTrim(edits, info);
  tab.savedKey = trimKey(freshTrim(info));
  tab.past = [];
  tab.future = [];
  tab.playable = false;
  tab.windowsFile = inWindowsDrive(tab.path);

  // Title row: name, how it stands, Undo and Redo, the saves, More.
  const head = el('div', 'doc-head');
  const titleRow = el('div', 'doc-title-row');
  const name = el('span', 'doc-name', baseName(tab.path));
  name.title = windowsPath(tab.path);
  tab.statusEl = el('span', 'doc-status');
  tab.stopButton = el('button', 'btn vt-stop', 'Stop');
  tab.stopButton.type = 'button';
  tab.stopButton.hidden = true;
  tab.stopButton.addEventListener('click', () => { if (tab.job) call('videoCancel', tab.job).catch(() => {}); });
  tab.undoButton = toolButton('arrow_undo', 'Undo (Ctrl+Z)', () => undoVideo(tab));
  tab.redoButton = toolButton('arrow_redo', 'Redo (Ctrl+Y)', () => redoVideo(tab));
  tab.copyButton = el('button', 'btn vt-save', 'Save as Copy');
  tab.copyButton.type = 'button';
  tab.copyButton.title = info.beside ? 'Save the trimmed video as a new one beside this' : 'Save the trimmed video as a new one in Videos';
  tab.copyButton.addEventListener('click', () => saveVideo(tab, false));
  tab.saveButton = el('button', 'btn primary vt-save', 'Save');
  tab.saveButton.type = 'button';
  tab.saveButton.title = 'Save over this video (Ctrl+S). The old one goes to the Trash.';
  tab.saveButton.hidden = !info.replaceable;
  tab.saveButton.addEventListener('click', () => saveVideo(tab, true));
  const more = toolButton('more_horizontal', 'More', (event) => menuUnder(event.currentTarget, videoMenuItems(tab)));
  // The full editor (OpenCut, editor-tab.js): cuts, text, music, effects, captions...
  const editor = el('button', 'btn vt-save vt-editor');
  editor.type = 'button';
  editor.title = 'Open it in the video editor: cuts, text, music, effects, captions';
  editor.append(icon('video_clip'), el('span', '', 'Editor'));
  editor.addEventListener('click', () => openEditor(tab.path));
  titleRow.append(fileIcon({ name: baseName(tab.path), path: tab.path }), name, tab.statusEl, tab.stopButton, el('div', 'grow'),
    tab.undoButton, tab.redoButton, el('span', 'doc-tool-gap'), editor, tab.copyButton, tab.saveButton, more);
  head.append(titleRow);

  // The picture, as big as fits.
  tab.stage = el('div', 'vt-stage');
  tab.video = el('video', 'vt-video');
  tab.video.preload = 'auto';
  tab.video.playsInline = true;
  tab.waitBox = el('div', 'vt-wait');
  tab.waitBox.hidden = true;
  tab.stage.append(tab.video, tab.waitBox);
  tab.video.addEventListener('click', () => togglePlay(tab));
  tab.video.addEventListener('dblclick', () => toggleVideoFullScreen(tab));

  // Playing, stepping, and the trim.
  const controls = el('div', 'vt-controls');
  tab.playButton = videoButton('play-filled', '', 'Play (Space)', () => togglePlay(tab));
  tab.playButton.classList.add('vt-play');
  const back = videoButton('previous_frame', '', 'One frame back (,)', () => stepFrames(tab, -1));
  const forward = videoButton('next_frame', '', 'One frame on (.)', () => stepFrames(tab, 1));
  tab.timeEl = el('span', 'vt-time');
  tab.lengthEl = el('span', 'vt-length');
  const startHere = videoButton('', 'Start Here', 'Trim: the video starts where you are (I)', () => trimHere(tab, 'start'));
  const endHere = videoButton('', 'End Here', 'Trim: the video ends where you are (O)', () => trimHere(tab, 'end'));
  tab.soundButton = videoButton('speaker', 'Sound on', 'Sound is kept in the saved video. Click to remove it.', () => changeTrim(tab, (trim) => { trim.mute = !trim.mute; }));
  tab.soundButton.hidden = !info.sound; // no sound in the video, nothing to remove
  tab.resetButton = videoButton('arrow_reset', '', 'The whole video again', () => changeTrim(tab, (trim) => Object.assign(trim, freshTrim(tab.info))));
  controls.append(tab.playButton, back, forward, tab.timeEl, el('div', 'grow'), tab.lengthEl, el('span', 'doc-tool-gap'), startHere, endHere, tab.soundButton, tab.resetButton);

  tab.timeline = el('div', 'vt-timeline');
  tab.track = el('div', 'vt-track');
  tab.strip = el('div', 'vt-strip');
  tab.shadeStart = el('div', 'vt-shade');
  tab.shadeEnd = el('div', 'vt-shade');
  tab.range = el('div', 'vt-range');
  const startGrip = el('div', 'vt-grip vt-grip-start');
  startGrip.dataset.grip = 'start';
  startGrip.title = 'Drag to trim the start';
  const endGrip = el('div', 'vt-grip vt-grip-end');
  endGrip.dataset.grip = 'end';
  endGrip.title = 'Drag to trim the end';
  tab.range.append(startGrip, endGrip);
  tab.head = el('div', 'vt-head');
  tab.tip = el('div', 'vt-tip');
  tab.tip.hidden = true;
  tab.track.append(tab.strip, tab.shadeStart, tab.shadeEnd, tab.range, tab.head, tab.tip);
  tab.timeline.append(tab.track);

  const player = el('div', 'vt-player');
  player.append(tab.stage, controls, tab.timeline);
  tab.host.append(head, player);

  hookVideo(tab);
  hookTimeline(tab);
  loadVideo(tab);
  refreshVideo(tab);
}

function videoMenuItems(tab) {
  const entry = { path: tab.path, name: baseName(tab.path), folder: parentOf(tab.path) };
  return [
    { label: 'Open File Location', icon: 'folder_open', run: () => { openFilesTab(parentOf(tab.path)); openLocation(entry); } },
    { label: 'Copy as Path', icon: 'link', run: () => copyAsPath([tab.path]) },
    { label: 'Open in Windows App', icon: 'open', run: () => openInWindows(entry, false) },
    { label: 'Open With…', icon: 'open', run: () => openInWindows(entry, true) },
  ];
}

function toggleVideoFullScreen(tab) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else tab.stage.requestFullscreen?.().catch(() => {});
}

// The video, or the copy made so it can play here.
function videoSource(tab) {
  const { mtime, size } = tab.info;
  return `${fileUrl(tab.path)}?${tab.playable ? 'play&' : ''}v=${Math.round(mtime || 0)}-${size ?? ''}`;
}

function loadVideo(tab) {
  tab.triedPlayable = false;
  tab.playable = false;
  tab.waitBox.hidden = true;
  tab.strip.style.backgroundImage = `url("${fileUrl(tab.path)}?strip&v=${Math.round(tab.info.mtime || 0)}-${tab.info.size ?? ''}")`;
  if (tab.info.plays) tab.video.src = videoSource(tab);
  else makePlayable(tab);
}

// A video the page can't play by itself: ffmpeg makes a copy it can, once (kept in ~/.cache/house).
async function makePlayable(tab) {
  if (tab.triedPlayable || tab.closed) return;
  tab.triedPlayable = true;
  tab.video.removeAttribute('src');
  tab.video.load();
  tab.playJob = newJob();
  showWait(tab, 'Getting this video ready to play…', 0);
  try {
    await call('videoPlayable', tab.path, tab.playJob);
    if (tab.closed) return;
    tab.playable = true;
    tab.waitBox.hidden = true;
    tab.video.src = videoSource(tab);
  } catch (error) {
    if (tab.closed) return;
    const stopped = /Stopped/.test(String(error?.message));
    showWait(tab, stopped ? 'Stopped. It can still be opened in a Windows app.' : 'This video can\'t be played here.', null);
  } finally {
    tab.playJob = null;
  }
}

function showWait(tab, text, done) {
  tab.waitBox.replaceChildren(el('div', 'vt-wait-text', text));
  if (done !== null) {
    const bar = el('div', 'vt-bar');
    tab.waitFill = el('div', 'vt-bar-fill');
    tab.waitFill.style.width = `${Math.round(done * 100)}%`;
    bar.append(tab.waitFill);
    tab.waitBox.append(bar);
  } else {
    tab.waitFill = null;
    tab.waitBox.append(windowsButtons({ path: tab.path, name: baseName(tab.path), isDir: false }));
  }
  tab.waitBox.hidden = false;
}

window.house.on('video:progress', ({ job, done } = {}) => {
  const tab = state.tabs.find((candidate) => candidate.kind === 'video' && (candidate.job === job || candidate.playJob === job));
  if (!tab || typeof done !== 'number') return;
  if (tab.playJob === job && tab.waitFill) tab.waitFill.style.width = `${Math.round(done * 100)}%`;
  if (tab.job === job) {
    tab.jobDone = done;
    setVideoStatus(tab);
  }
});

function hookVideo(tab) {
  const { video } = tab;
  video.addEventListener('error', () => {
    // The page couldn't play it after all (a kind it can't, or sound it can't): make a copy it can.
    if (!tab.playable && !tab.triedPlayable) makePlayable(tab);
    else if (tab.playable) showWait(tab, 'This video can\'t be played here.', null);
  });
  video.addEventListener('play', () => {
    const { start, end } = tab.trim;
    if (video.currentTime >= end - 0.05 || video.currentTime < start - 0.01) video.currentTime = start;
    tab.playButton.replaceChildren(icon('pause-filled'));
    tab.playButton.title = 'Pause (Space)';
    cancelAnimationFrame(tab.tickFrame);
    tab.tickFrame = requestAnimationFrame(() => videoTick(tab));
  });
  video.addEventListener('pause', () => {
    tab.playButton.replaceChildren(icon('play-filled'));
    tab.playButton.title = 'Play (Space)';
    drawHead(tab);
  });
  ['seeked', 'timeupdate', 'loadeddata'].forEach((name) => video.addEventListener(name, () => drawHead(tab)));
}

// While it plays, it stops at the end of the trim, as the saved video will.
function videoTick(tab) {
  const { video, trim } = tab;
  if (tab.closed) return;
  if (!video.paused && !tab.scrubbing) {
    if (video.currentTime >= trim.end - 0.02) {
      video.pause();
      video.currentTime = trim.end;
    } else if (video.currentTime < trim.start - 0.05) {
      video.currentTime = trim.start;
    }
  }
  drawHead(tab);
  if (!video.paused) tab.tickFrame = requestAnimationFrame(() => videoTick(tab));
}

function togglePlay(tab) {
  if (!tab.video.src || tab.video.readyState < 1) return;
  if (tab.video.paused) tab.video.play().catch(() => {});
  else tab.video.pause();
}

function seekVideo(tab, seconds) {
  if (!tab.video.src) return;
  tab.video.currentTime = clampTo(seconds, 0, tab.info.duration);
  drawHead(tab);
}

function stepFrames(tab, count) {
  tab.video.pause();
  seekVideo(tab, tab.video.currentTime + count / (tab.info.fps || 30));
}

// Start Here / End Here: the trim moves to where you are.
function trimHere(tab, side) {
  const now = roundTime(tab.video.currentTime);
  changeTrim(tab, (trim) => {
    if (side === 'start') trim.start = clampTo(now, 0, trim.end - VIDEO_SHORTEST);
    else trim.end = clampTo(now, trim.start + VIDEO_SHORTEST, roundTime(tab.info.duration));
  });
}

/* The timeline */

const timeToPercent = (tab, seconds) => `${(clampTo(seconds, 0, tab.info.duration) / (tab.info.duration || 1)) * 100}%`;

function timeAt(tab, event) {
  const box = tab.track.getBoundingClientRect();
  return roundTime(clampTo((event.clientX - box.left) / (box.width || 1), 0, 1) * tab.info.duration);
}

function drawTimeline(tab) {
  const { start, end } = tab.trim;
  tab.shadeStart.style.left = '0';
  tab.shadeStart.style.width = timeToPercent(tab, start);
  tab.shadeEnd.style.left = timeToPercent(tab, end);
  tab.shadeEnd.style.right = '0';
  tab.range.style.left = timeToPercent(tab, start);
  tab.range.style.width = `calc(${timeToPercent(tab, end)} - ${timeToPercent(tab, start)})`;
  drawHead(tab);
}

function drawHead(tab) {
  if (tab.closed) return;
  const now = tab.video.currentTime || 0;
  tab.head.style.left = timeToPercent(tab, now);
  tab.timeEl.textContent = `${clockTime(now, true)} / ${clockTime(tab.info.duration, true)}`;
}

function showTip(tab, seconds) {
  tab.tip.hidden = false;
  tab.tip.textContent = clockTime(seconds, true);
  tab.tip.style.left = timeToPercent(tab, seconds);
}

function hookTimeline(tab) {
  const { timeline } = tab;
  timeline.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || tab.job) return;
    event.preventDefault();
    const grip = event.target.closest('[data-grip]')?.dataset.grip || null;
    const before = trimKey(tab.trim);
    const playing = !tab.video.paused;
    if (grip) tab.video.pause();
    tab.scrubbing = true;
    try { timeline.setPointerCapture(event.pointerId); } catch { /* the pointer may already be gone */ }
    const duration = roundTime(tab.info.duration);
    const move = (moved) => {
      let at = timeAt(tab, moved);
      const { trim } = tab;
      if (grip) {
        // A handle sticks to the play head and to the ends of the strip when it's within 8 px.
        const near = (8 / (tab.track.getBoundingClientRect().width || 1)) * duration;
        const target = [roundTime(tab.video.currentTime), 0, duration].find((time) => Math.abs(at - time) <= near);
        if (target !== undefined) at = target;
      }
      if (grip === 'start') {
        trim.start = clampTo(at, 0, trim.end - VIDEO_SHORTEST);
        showTip(tab, trim.start);
      } else if (grip === 'end') {
        trim.end = clampTo(at, trim.start + VIDEO_SHORTEST, duration);
        showTip(tab, trim.end);
      } else {
        seekVideo(tab, at);
        showTip(tab, at);
        return;
      }
      drawTimeline(tab);
      showLength(tab);
    };
    const up = () => {
      timeline.removeEventListener('pointermove', move);
      timeline.removeEventListener('pointerup', up);
      timeline.removeEventListener('pointercancel', up);
      tab.scrubbing = false;
      tab.tip.hidden = true;
      // The play head stays where it was, unless the trim now leaves it outside: then the nearest kept edge.
      if (grip) seekVideo(tab, clampTo(tab.video.currentTime, tab.trim.start, tab.trim.end));
      rememberTrim(tab, before);
      if (playing && !grip) tab.video.play().catch(() => {});
    };
    timeline.addEventListener('pointermove', move);
    timeline.addEventListener('pointerup', up);
    timeline.addEventListener('pointercancel', up);
    if (!grip) move(event); // a plain press on a handle changes nothing until it moves
  });
}

/* How it stands */

function showLength(tab) {
  const length = trimLength(tab.trim);
  const changed = trimmed(tab);
  tab.lengthEl.textContent = changed ? `Trimmed to ${clockTime(length, true)} (was ${clockTime(tab.info.duration, true)})` : `Length ${clockTime(tab.info.duration, true)}`;
  tab.lengthEl.classList.toggle('changed', changed);
}

function setVideoStatus(tab, flash) {
  const node = tab.statusEl;
  node.className = 'doc-status';
  node.replaceChildren();
  let text = '';
  let title = '';
  if (tab.job) {
    text = `Saving… ${Math.round((tab.jobDone || 0) * 100)}%`;
  } else if (flash) {
    node.append(icon('checkmark'));
    text = flash;
  } else if (!tab.info.beside) {
    node.classList.add('locked');
    node.append(icon('lock_closed-filled'));
    text = 'View only';
    title = tab.windowsFile ? 'Windows files are view only here. Save as Copy puts a copy in Videos.' : 'This video can\'t be changed where it is. Save as Copy puts a copy in Videos.';
  } else if (notSaved(tab)) {
    text = 'Not saved yet';
  }
  if (text) node.append(el('span', '', text));
  node.title = title;
  tab.stopButton.hidden = !tab.job;
}

function refreshVideo(tab) {
  if (tab.closed) return;
  tab.undoButton.disabled = Boolean(tab.job) || !tab.past.length;
  tab.redoButton.disabled = Boolean(tab.job) || !tab.future.length;
  const changed = trimmed(tab);
  tab.copyButton.disabled = Boolean(tab.job) || !changed;
  tab.saveButton.disabled = Boolean(tab.job) || !changed;
  tab.resetButton.disabled = Boolean(tab.job) || !changed;
  tab.host.classList.toggle('saving', Boolean(tab.job));
  tab.video.muted = tab.trim.mute;
  tab.soundButton.hidden = !tab.info.sound;
  tab.soundButton.replaceChildren(icon(tab.trim.mute ? 'speaker_off' : 'speaker'), el('span', '', tab.trim.mute ? 'Sound off' : 'Sound on'));
  tab.soundButton.title = tab.trim.mute ? 'The saved video has no sound. Click to keep it.' : 'Sound is kept in the saved video. Click to remove it.';
  drawTimeline(tab);
  showLength(tab);
  setVideoStatus(tab);
}

/* Saving */

async function saveVideo(tab, overwrite) {
  if (tab.job || tab.closed) return;
  if (!trimmed(tab)) {
    toast('Trim it first: drag the blue handles under the video.');
    return;
  }
  if (overwrite && !tab.info.replaceable) overwrite = false;
  tab.video.pause();
  const plan = { start: tab.trim.start, end: tab.trim.end, mute: tab.trim.mute };
  const job = newJob();
  tab.job = job;
  tab.jobDone = 0;
  refreshVideo(tab);
  let result = null;
  try {
    result = await call('videoSave', tab.path, plan, { overwrite, job });
  } catch (error) {
    const stopped = /Stopped/.test(String(error?.message));
    tab.job = null;
    if (!tab.closed) refreshVideo(tab);
    if (stopped) toast('Stopped. Nothing was saved.');
    else if (/Unknown request/.test(String(error?.message))) toast('Saving videos works after Station 256 restarts.');
    else await alertBox('The video wasn\'t saved', cleanError(error));
    return;
  }
  tab.job = null;
  if (overwrite) {
    // The trimmed video is the file now: it opens fresh.
    if (!tab.closed) await reloadVideo(tab, 'Saved');
    toast('Saved. The old video is in the Trash.', 'Undo', async () => {
      if (!await attempt(() => call('putFileBack', result.path, result.kept))) return;
      const open = state.tabs.find((candidate) => candidate.kind === 'video' && candidate.path === result.path);
      if (open) await reloadVideo(open, 'The old video is back');
    });
    return;
  }
  if (!tab.closed) {
    tab.savedKey = trimKey(tab.trim);
    refreshVideo(tab);
    setVideoStatus(tab, 'Saved a copy');
  }
  toast(`Saved as "${shortName(baseName(result.path), 40)}"`, 'Open', () => openVideo(result.path));
}

async function reloadVideo(tab, flash) {
  const info = await attempt(() => call('videoInfo', tab.path));
  if (!info || tab.closed) return;
  tab.info = info;
  tab.trim = freshTrim(info);
  tab.savedKey = trimKey(tab.trim);
  tab.past = [];
  tab.future = [];
  tab.saveButton.hidden = !info.replaceable;
  loadVideo(tab);
  refreshVideo(tab);
  if (flash) {
    setVideoStatus(tab, flash);
    clearTimeout(tab.flashTimer);
    tab.flashTimer = setTimeout(() => { if (!tab.closed) setVideoStatus(tab); }, 2500);
  }
}

/* The tab */

function showVideo(tab) {
  requestAnimationFrame(() => {
    if (tab.closed || state.active !== tab) return;
    const { duration, width, height, size } = tab.info;
    $('item-count').textContent = `${clockTime(duration)}   ${width} × ${height}   ${formatSize(size)}`;
  });
}

// Closing: asks first if it's saving or has a trim not saved.
async function videoMayClose(tab) {
  if (tab.job) {
    if (!await confirmBox('Stop saving?', 'This video is still being saved. Closing stops it, and nothing is saved.', 'Stop and Close', true)) return false;
    await call('videoCancel', tab.job).catch(() => {});
    return true;
  }
  if (notSaved(tab)) return confirmBox('Close without saving?', 'Your trim isn\'t saved.', 'Close', true);
  return true;
}

function closeVideo(tab) {
  if (tab.closed) return;
  tab.closed = true;
  if (tab.playJob) call('videoCancel', tab.playJob).catch(() => {});
  cancelAnimationFrame(tab.tickFrame);
  clearTimeout(tab.flashTimer);
  tab.video.pause();
  tab.video.removeAttribute('src');
  tab.video.load();
  tab.host.remove();
}

// A trim not saved yet goes with the tab to another window, or through a reload.
const videoDescription = (tab) => ({ kind: 'video', path: tab.path, edits: { start: tab.trim.start, end: tab.trim.end, mute: tab.trim.mute } });

// Keys for a video's page, as a video player's: Space plays, the arrows jump, I and O trim.
document.addEventListener('keydown', (event) => {
  const tab = state.active;
  if (tab?.kind !== 'video' || dialog.open || !preview.hidden || event.target.matches?.('input, textarea')) return;
  const { key } = event;
  const lower = key.toLowerCase();
  if (event.ctrlKey && !event.altKey) {
    if (key === 'Tab') cycleTab(event.shiftKey ? -1 : 1);
    else if (!event.shiftKey && lower === 'w') closeTab(tab);
    else if (!event.shiftKey && lower === 't') openFilesTab(HOME_PAGE);
    else if (!event.shiftKey && lower === 'z') undoVideo(tab);
    else if (lower === 'y' || (event.shiftKey && lower === 'z')) redoVideo(tab);
    else if (!event.shiftKey && lower === 's') saveVideo(tab, tab.info.replaceable);
    else return;
    event.preventDefault();
    return;
  }
  if (event.altKey || event.metaKey) return;
  if (key === ' ' || lower === 'k') togglePlay(tab);
  else if (key === 'ArrowLeft') seekVideo(tab, tab.video.currentTime - VIDEO_JUMP);
  else if (key === 'ArrowRight') seekVideo(tab, tab.video.currentTime + VIDEO_JUMP);
  else if (key === ',') stepFrames(tab, -1);
  else if (key === '.') stepFrames(tab, 1);
  else if (key === 'Home') seekVideo(tab, tab.trim.start);
  else if (key === 'End') seekVideo(tab, tab.trim.end);
  else if (lower === 'i') trimHere(tab, 'start');
  else if (lower === 'o') trimHere(tab, 'end');
  else if (lower === 'f') toggleVideoFullScreen(tab);
  else return;
  event.preventDefault();
});
