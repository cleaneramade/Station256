/* ---------- Picture editor, inside the preview ---------- */

// A picture opens in the preview over the page. Edit turns the preview into a small photo editor,
// like Windows Photos: Crop (with turning and flipping), Adjust (light and color), Draw (pen,
// highlighter, arrows, boxes and words) and Resize. Nothing changes on disk until Save as Copy
// ("name (edited).ext" beside it, or in Pictures for a C: picture, which is view only) or Save
// (over it, with the old one kept in the Trash and an Undo). main.js: savePicture, putPictureBack.

const pictureEditable = (entry) => ANY_PICTURE.test(entry.name) && !/\.svgz?$/i.test(entry.name);
const PICTURE_IN_PLACE = /\.(png|jpe?g|jfif|webp)$/i;
const PE_COLORS = ['#e81123', '#ff8c00', '#fff100', '#16c60c', '#0078d4', '#886ce4', '#000000', '#ffffff'];
const PE_ASPECTS = [['free', 'Free'], ['original', 'Original'], ['1', 'Square'], ['4/3', '4:3'], ['3/2', '3:2'], ['16/9', '16:9']];
const PE_ADJUST = [['brightness', 'Brightness'], ['contrast', 'Contrast'], ['saturation', 'Color'], ['warmth', 'Warmth']];
const PE_DRAW = [['pen', 'pen', 'Pen'], ['highlight', 'highlight', 'Highlighter'], ['arrow', 'arrow_up_right', 'Arrow'], ['box', 'draw_shape', 'Box'], ['text', 'text_t', 'Words']];
const PE_PREVIEW_SIDE = 2048; // the picture on screen is drawn from a copy this size at most
const PE_PAD = 28;

let pe = null; // the picture being edited

function pictureEditButton(entry) {
  const button = el('button', 'tool preview-close pe-edit-btn');
  button.type = 'button';
  button.title = 'Edit (crop, light and color, draw, resize)';
  button.append(icon('image_edit'), el('span', '', 'Edit'));
  button.addEventListener('click', () => startPictureEdit(entry));
  return button;
}

const peState = () => ({
  rotate: pe.rotate, flipX: pe.flipX, flipY: pe.flipY, crop: pe.crop && { ...pe.crop },
  adjust: { ...pe.adjust }, marks: pe.marks.map((mark) => JSON.parse(JSON.stringify(mark))), resize: pe.resize && { ...pe.resize },
});
const peChanged = () => Boolean(pe) && JSON.stringify(peState()) !== pe.startState;

function peRemember() {
  pe.past.push(JSON.stringify(peState()));
  if (pe.past.length > 80) pe.past.shift();
  pe.future = [];
}

function peRestore(json) {
  Object.assign(pe, JSON.parse(json));
  peShowPanel();
  peDrawNow();
}

function peUndo() {
  if (!pe?.past.length) return;
  pe.future.push(JSON.stringify(peState()));
  peRestore(pe.past.pop());
}

function peRedo() {
  if (!pe?.future.length) return;
  pe.past.push(JSON.stringify(peState()));
  peRestore(pe.future.pop());
}

// The picture, read so it can be drawn and saved. ?edit lets the page read back what it drew.
function peLoad(entry) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', () => reject(new Error('load')), { once: true });
    const view = IMAGE.test(entry.name) ? '' : 'view&';
    image.src = `${fileUrl(entry.path)}?${view}edit&v=${Math.round(entry.mtime || 0)}-${entry.size ?? ''}-${Date.now()}`;
  });
}

async function startPictureEdit(entry) {
  if (pe) return;
  let image;
  try {
    image = await peLoad(entry);
    await image.decode();
  } catch {
    // Until Station 256 restarts after an update, the parts that load and save edits aren't there.
    const updated = await call('savePicture', '', new Uint8Array(0), { ext: 'none' }).then(() => true, (error) => !/Unknown request/.test(String(error?.message)));
    toast(updated ? 'This picture couldn\'t be opened to edit.' : 'Editing pictures works after Station 256 restarts.');
    return;
  }
  if (previewEntry !== entry || preview.hidden) return;
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  // A smaller copy to draw on screen, so sliders and drawing keep up on big photos.
  const fit = Math.min(1, PE_PREVIEW_SIDE / Math.max(width, height));
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(width * fit));
  small.height = Math.max(1, Math.round(height * fit));
  const smallContext = small.getContext('2d');
  smallContext.imageSmoothingQuality = 'high';
  smallContext.drawImage(image, 0, 0, small.width, small.height);
  pe = {
    entry, image, small, width, height,
    rotate: 0, flipX: false, flipY: false, crop: null,
    adjust: { brightness: 0, contrast: 0, saturation: 0, warmth: 0 },
    marks: [], resize: null, lockRatio: true,
    tool: 'crop', aspect: 'free', drawTool: 'pen', color: PE_COLORS[0], size: 6,
    past: [], future: [], view: null, drag: null,
  };
  pe.startState = JSON.stringify(peState());
  buildPictureEditor();
}

// Leaving the editor: asks first if something changed. all: the whole preview closes too.
async function leavePictureEdit(all) {
  if (!pe) return true;
  if (pe.saving) return false; // it's being saved: leaving waits for that
  if (peChanged() && !await confirmBox('Leave without saving?', 'Your changes to this picture will be lost.', 'Leave', true)) return false;
  const { entry } = pe;
  stopPictureEdit();
  if (all) closePreview(true);
  else showPreview(entry);
  return true;
}

function stopPictureEdit() {
  if (!pe) return;
  pe.resizeObserver?.disconnect();
  // A big photo's copies are let go now, not whenever the page next tidies up.
  pe.small.width = 0;
  if (pe.canvas) pe.canvas.width = 0;
  pe.image.src = '';
  pe = null;
  preview.classList.remove('editing');
}

/* Geometry: "turned" is the picture after turning and flipping, in its own pixels. */

const peTurned = () => (pe.rotate % 180 ? { w: pe.height, h: pe.width } : { w: pe.width, h: pe.height });
const peRegion = () => pe.crop || { x: 0, y: 0, ...peTurned() };
function peOutSize() {
  const region = peRegion();
  return pe.resize || { w: Math.round(region.w), h: Math.round(region.h) };
}

// Turning or flipping moves what's drawn and the crop with the picture.
function peMovePoints(map) {
  const point = ([x, y]) => map(x, y);
  pe.marks.forEach((mark) => {
    if (mark.points) mark.points = mark.points.map(point);
    if (mark.from) mark.from = point(mark.from);
    if (mark.to) mark.to = point(mark.to);
    if (mark.at) mark.at = point(mark.at);
  });
  if (pe.crop) {
    const [x1, y1] = map(pe.crop.x, pe.crop.y);
    const [x2, y2] = map(pe.crop.x + pe.crop.w, pe.crop.y + pe.crop.h);
    pe.crop = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }
}

function peTurn(step) {
  peRemember();
  const { w, h } = peTurned();
  // Clockwise, a point (x, y) lands at (h - y, x); the other way, at (y, w - x).
  peMovePoints(step > 0 ? (x, y) => [h - y, x] : (x, y) => [y, w - x]);
  // Turning happens before flipping, so a flipped picture turns the other way.
  const flips = (pe.flipX ? 1 : 0) + (pe.flipY ? 1 : 0);
  pe.rotate = (pe.rotate + (flips % 2 ? -step : step) * 90 + 360) % 360;
  if (pe.resize) pe.resize = { w: pe.resize.h, h: pe.resize.w };
  peDrawNow();
}

function peFlip(across) {
  peRemember();
  const { w, h } = peTurned();
  peMovePoints(across ? (x, y) => [w - x, y] : (x, y) => [x, h - y]);
  if (across) pe.flipX = !pe.flipX;
  else pe.flipY = !pe.flipY;
  peDrawNow();
}

/* Drawing it */

function peFilter() {
  const { brightness, contrast, saturation } = pe.adjust;
  const parts = [];
  if (brightness) parts.push(`brightness(${(1 + brightness / 160).toFixed(3)})`);
  if (contrast) parts.push(`contrast(${(1 + contrast / 140).toFixed(3)})`);
  if (saturation) parts.push(`saturate(${(1 + saturation / 100).toFixed(3)})`);
  return parts.join(' ') || 'none';
}

// Warmth: a little more red and less blue (or the other way), pixel by pixel.
function peWarm(context, width, height) {
  const amount = pe.adjust.warmth * 0.35;
  if (!amount) return;
  const data = context.getImageData(0, 0, width, height);
  const pixels = data.data;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = Math.min(255, Math.max(0, pixels[i] + amount));
    pixels[i + 2] = Math.min(255, Math.max(0, pixels[i + 2] - amount));
  }
  context.putImageData(data, 0, 0);
}

// region: which part of the turned picture; scaleX/scaleY: canvas pixels for each picture pixel.
function peRender(context, { region, scaleX, scaleY, width, height, source, marks = true }) {
  const { w: turnedW, h: turnedH } = peTurned();
  context.save();
  context.clearRect(0, 0, width, height);
  context.imageSmoothingQuality = 'high';
  context.filter = peFilter();
  context.setTransform(scaleX, 0, 0, scaleY, -region.x * scaleX, -region.y * scaleY);
  context.translate(turnedW / 2, turnedH / 2);
  context.scale(pe.flipX ? -1 : 1, pe.flipY ? -1 : 1);
  context.rotate((pe.rotate * Math.PI) / 180);
  context.drawImage(source, -pe.width / 2, -pe.height / 2, pe.width, pe.height);
  context.restore();
  peWarm(context, width, height);
  if (!marks) return;
  context.save();
  context.setTransform(scaleX, 0, 0, scaleY, -region.x * scaleX, -region.y * scaleY);
  pe.marks.forEach((mark) => peMark(context, mark));
  if (pe.drag?.mark) peMark(context, pe.drag.mark);
  context.restore();
}

function peMark(context, mark) {
  context.save();
  context.strokeStyle = mark.color;
  context.fillStyle = mark.color;
  context.lineWidth = mark.size;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (mark.type === 'pen' || mark.type === 'highlight') {
    if (mark.type === 'highlight') context.globalAlpha = 0.38;
    context.beginPath();
    mark.points.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
    if (mark.points.length === 1) context.lineTo(mark.points[0][0] + 0.01, mark.points[0][1]);
    context.stroke();
  } else if (mark.type === 'arrow') {
    const [x1, y1] = mark.from;
    const [x2, y2] = mark.to;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(mark.size * 3.2, 12);
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2 - Math.cos(angle) * head * 0.6, y2 - Math.sin(angle) * head * 0.6);
    context.stroke();
    context.beginPath();
    context.moveTo(x2, y2);
    context.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45));
    context.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45));
    context.closePath();
    context.fill();
  } else if (mark.type === 'box') {
    const [x1, y1] = mark.from;
    const [x2, y2] = mark.to;
    context.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  } else if (mark.type === 'text') {
    context.font = `600 ${mark.size}px Selawik, "Segoe UI", sans-serif`;
    context.textBaseline = 'top';
    // Light words get a dark edge and dark ones a light edge, so they read on any picture.
    context.lineWidth = Math.max(2, mark.size / 8);
    context.strokeStyle = ['#ffffff', '#fff100'].includes(mark.color) ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)';
    mark.text.split('\n').forEach((line, index) => {
      context.strokeText(line, mark.at[0], mark.at[1] + index * mark.size * 1.2);
      context.fillText(line, mark.at[0], mark.at[1] + index * mark.size * 1.2);
    });
  }
  context.restore();
}

// What's on screen: the whole picture while cropping, otherwise the cropped part.
function peDrawNow() {
  if (!pe) return;
  const stage = pe.stage;
  const canvas = pe.canvas;
  const cropping = pe.tool === 'crop';
  const region = cropping ? { x: 0, y: 0, ...peTurned() } : peRegion();
  const room = { w: Math.max(50, stage.clientWidth - PE_PAD * 2), h: Math.max(50, stage.clientHeight - PE_PAD * 2) };
  const scale = Math.min(room.w / region.w, room.h / region.h, cropping ? 1.5 : 4);
  const shownW = Math.max(1, Math.round(region.w * scale));
  const shownH = Math.max(1, Math.round(region.h * scale));
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(shownW * ratio);
  canvas.height = Math.round(shownH * ratio);
  canvas.style.width = `${shownW}px`;
  canvas.style.height = `${shownH}px`;
  const left = Math.round((stage.clientWidth - shownW) / 2);
  const top = Math.round((stage.clientHeight - shownH) / 2);
  canvas.style.left = `${left}px`;
  canvas.style.top = `${top}px`;
  pe.view = { region, scale, left, top, shownW, shownH };
  const context = canvas.getContext('2d', { willReadFrequently: Boolean(pe.adjust.warmth) });
  peRender(context, { region, scaleX: scale * ratio, scaleY: scale * ratio, width: canvas.width, height: canvas.height, source: pe.small, marks: !cropping });
  peShowCrop();
  peShowSize();
  pe.undoButton.disabled = !pe.past.length;
  pe.redoButton.disabled = !pe.future.length;
  pe.saveButton.disabled = !peChanged();
  pe.copyButton.disabled = !peChanged();
}

let peFrame = 0;
function peDrawSoon() {
  if (peFrame) return;
  peFrame = requestAnimationFrame(() => {
    peFrame = 0;
    peDrawNow();
  });
}

/* Crop */

function peAspect() {
  if (pe.aspect === 'free') return null;
  if (pe.aspect === 'original') return pe.width / pe.height;
  const [a, b = 1] = pe.aspect.split('/').map(Number);
  const value = a / b;
  const { w, h } = peTurned();
  return w >= h ? value : 1 / value; // the shape follows the picture's way round
}

function peSetAspect(aspect) {
  pe.aspect = aspect;
  const ratio = peAspect();
  if (ratio) {
    peRemember();
    const { w: turnedW, h: turnedH } = peTurned();
    const region = peRegion();
    let w = region.w;
    let h = w / ratio;
    if (h > region.h) { h = region.h; w = h * ratio; }
    if (w > turnedW) { w = turnedW; h = w / ratio; }
    if (h > turnedH) { h = turnedH; w = h * ratio; }
    pe.crop = { x: region.x + (region.w - w) / 2, y: region.y + (region.h - h) / 2, w, h };
  }
  peShowPanel();
  peDrawNow();
}

function peShowCrop() {
  const box = pe.cropBox;
  if (pe.tool !== 'crop') {
    box.hidden = true;
    return;
  }
  const region = peRegion();
  const { scale, left, top } = pe.view;
  box.hidden = false;
  box.style.left = `${left + region.x * scale}px`;
  box.style.top = `${top + region.y * scale}px`;
  box.style.width = `${region.w * scale}px`;
  box.style.height = `${region.h * scale}px`;
}

function peCropDrag(event, handle) {
  event.preventDefault();
  event.stopPropagation();
  peRemember();
  const start = { ...peRegion() };
  const from = { x: event.clientX, y: event.clientY };
  const { w: turnedW, h: turnedH } = peTurned();
  const ratio = peAspect();
  const least = Math.max(8, Math.min(turnedW, turnedH) * 0.02);
  const move = (moveEvent) => {
    const dx = (moveEvent.clientX - from.x) / pe.view.scale;
    const dy = (moveEvent.clientY - from.y) / pe.view.scale;
    let { x, y, w, h } = start;
    if (handle === 'move') {
      x = Math.min(Math.max(0, x + dx), turnedW - w);
      y = Math.min(Math.max(0, y + dy), turnedH - h);
    } else {
      let left = x;
      let right = x + w;
      let topEdge = y;
      let bottom = y + h;
      if (handle.includes('w')) left = Math.min(Math.max(0, x + dx), right - least);
      if (handle.includes('e')) right = Math.max(Math.min(turnedW, x + w + dx), left + least);
      if (handle.includes('n')) topEdge = Math.min(Math.max(0, y + dy), bottom - least);
      if (handle.includes('s')) bottom = Math.max(Math.min(turnedH, y + h + dy), topEdge + least);
      w = right - left;
      h = bottom - topEdge;
      if (ratio) {
        // The shape stays: the side dragged leads, the other follows, inside the picture.
        if (handle === 'n' || handle === 's') w = h * ratio;
        else h = w / ratio;
        if (handle.includes('w')) left = right - w;
        if (handle.includes('n')) topEdge = bottom - h;
        if (handle === 'n' || handle === 's') left = x + (start.w - w) / 2;
        if (handle === 'e' || handle === 'w') topEdge = y + (start.h - h) / 2;
        if (left < 0 || topEdge < 0 || left + w > turnedW || topEdge + h > turnedH) return;
      }
      x = left;
      y = topEdge;
    }
    pe.crop = { x, y, w, h };
    peShowCrop();
    peShowSize();
  };
  const done = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', done);
    if (JSON.stringify(start) === JSON.stringify(peRegion())) pe.past.pop(); // nothing moved
    if (pe.crop && Math.round(pe.crop.x) === 0 && Math.round(pe.crop.y) === 0 && Math.round(pe.crop.w) === turnedW && Math.round(pe.crop.h) === turnedH) pe.crop = null;
    peDrawNow();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', done);
}

/* Draw */

function pePoint(event) {
  const box = pe.canvas.getBoundingClientRect();
  const { region, scale } = pe.view;
  return [region.x + (event.clientX - box.left) / scale, region.y + (event.clientY - box.top) / scale];
}

async function peCanvasDown(event) {
  if (pe.tool !== 'draw' || event.button !== 0) return;
  event.preventDefault();
  const point = pePoint(event);
  const size = (pe.drawTool === 'highlight' ? pe.size * 3 : pe.size) / pe.view.scale;
  if (pe.drawTool === 'text') {
    const text = await promptBox('Add Words', '', '', 'Add');
    if (!text || !pe) return;
    peRemember();
    pe.marks.push({ type: 'text', color: pe.color, size: Math.max(12, pe.size * 4) / pe.view.scale, at: point, text });
    peDrawNow();
    return;
  }
  const mark = pe.drawTool === 'pen' || pe.drawTool === 'highlight'
    ? { type: pe.drawTool, color: pe.color, size, points: [point] }
    : { type: pe.drawTool, color: pe.color, size, from: point, to: point };
  pe.drag = { mark };
  try { pe.canvas.setPointerCapture(event.pointerId); } catch { /* not a real pointer */ }
  peDrawSoon();
}

function peCanvasMove(event) {
  const mark = pe?.drag?.mark;
  if (!mark) return;
  const point = pePoint(event);
  if (mark.points) mark.points.push(point);
  else mark.to = point;
  peDrawSoon();
}

function peCanvasUp() {
  const mark = pe?.drag?.mark;
  if (!mark) return;
  pe.drag = null;
  const tiny = mark.from && Math.hypot(mark.to[0] - mark.from[0], mark.to[1] - mark.from[1]) * pe.view.scale < 4;
  if (!tiny) {
    peRemember();
    pe.marks.push(mark);
  }
  peDrawNow();
}

/* Resize */

function peShowSize() {
  if (!pe.sizeNote) return;
  const out = peOutSize();
  pe.sizeNote.textContent = `Saves at ${out.w.toLocaleString()} × ${out.h.toLocaleString()} pixels`;
  if (pe.widthInput && document.activeElement !== pe.widthInput) pe.widthInput.value = out.w;
  if (pe.heightInput && document.activeElement !== pe.heightInput) pe.heightInput.value = out.h;
}

function peSetSize(width, height) {
  const region = peRegion();
  const full = { w: Math.round(region.w), h: Math.round(region.h) };
  const w = Math.max(1, Math.min(16000, Math.round(width)));
  const h = Math.max(1, Math.min(16000, Math.round(height)));
  peRemember();
  pe.resize = w === full.w && h === full.h ? null : { w, h };
  peDrawNow();
}

/* The panel at the side */

function peSlider(label, value, min, max, onInput) {
  const row = el('label', 'pe-slider');
  const head = el('div', 'pe-slider-head');
  const shown = el('span', 'pe-slider-value', String(value));
  head.append(el('span', '', label), shown);
  const input = el('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  let remembered = false;
  input.addEventListener('pointerdown', () => { remembered = false; });
  input.addEventListener('input', () => {
    if (!remembered) { peRemember(); remembered = true; }
    shown.textContent = input.value;
    onInput(Number(input.value));
  });
  input.addEventListener('change', () => { remembered = false; });
  input.addEventListener('dblclick', () => { peRemember(); input.value = '0'; shown.textContent = '0'; onInput(0); });
  row.append(head, input);
  return row;
}

function peChoice(items, current, onPick, className = '') {
  const row = el('div', `pe-choices ${className}`);
  items.forEach(([value, label, iconName]) => {
    const button = el('button', `pe-choice${value === current ? ' on' : ''}`);
    button.type = 'button';
    if (iconName) button.append(icon(iconName));
    if (label) button.append(el('span', '', label));
    button.addEventListener('click', () => onPick(value));
    row.append(button);
  });
  return row;
}

function peButton(iconName, label, run, className = '') {
  const button = el('button', `pe-action ${className}`);
  button.type = 'button';
  button.append(icon(iconName), el('span', '', label));
  button.addEventListener('click', run);
  return button;
}

function peShowPanel() {
  const panel = pe.panel;
  panel.replaceChildren();
  pe.tabs.querySelectorAll('.segment').forEach((button) => button.classList.toggle('on', button.dataset.tool === pe.tool));
  pe.sizeNote = null;
  pe.widthInput = null;
  pe.heightInput = null;
  if (pe.tool === 'crop') {
    const turns = el('div', 'pe-row');
    turns.append(
      peButton('rotate_left', 'Turn left', () => peTurn(-1)),
      peButton('rotate_right', 'Turn right', () => peTurn(1)),
      peButton('flip_horizontal', 'Flip across', () => peFlip(true)),
      peButton('flip_vertical', 'Flip down', () => peFlip(false)),
    );
    panel.append(el('h4', 'pe-heading', 'Turn and flip'), turns, el('h4', 'pe-heading', 'Shape'),
      peChoice(PE_ASPECTS, pe.aspect, peSetAspect, 'pe-aspects'),
      peButton('arrow_reset', 'Whole picture', () => { peRemember(); pe.crop = null; pe.aspect = 'free'; peShowPanel(); peDrawNow(); }, 'pe-wide'),
      el('p', 'pe-note', 'Drag the corners or edges. Drag inside to move it.'));
  } else if (pe.tool === 'adjust') {
    PE_ADJUST.forEach(([key, label]) => panel.append(peSlider(label, pe.adjust[key], -100, 100, (value) => {
      pe.adjust[key] = value;
      peDrawSoon();
    })));
    panel.append(peButton('arrow_reset', 'Undo all light and color', () => {
      peRemember();
      pe.adjust = { brightness: 0, contrast: 0, saturation: 0, warmth: 0 };
      peShowPanel();
      peDrawNow();
    }, 'pe-wide'), el('p', 'pe-note', 'Double-click a slider to put it back.'));
  } else if (pe.tool === 'draw') {
    panel.append(el('h4', 'pe-heading', 'Draw with'), peChoice(PE_DRAW.map(([value, iconName, label]) => [value, label, iconName]), pe.drawTool, (value) => { pe.drawTool = value; peShowPanel(); }, 'pe-draw-tools'));
    const colors = el('div', 'pe-colors');
    PE_COLORS.forEach((color) => {
      const swatch = el('button', `pe-color${color === pe.color ? ' on' : ''}`);
      swatch.type = 'button';
      swatch.style.background = color;
      swatch.title = color;
      swatch.addEventListener('click', () => { pe.color = color; peShowPanel(); });
      colors.append(swatch);
    });
    panel.append(el('h4', 'pe-heading', 'Color'), colors, peSlider('Size', pe.size, 1, 40, (value) => { pe.size = value; }));
    panel.append(el('p', 'pe-note', pe.drawTool === 'text' ? 'Click where the words go.' : 'Draw on the picture. Ctrl+Z takes back the last one.'));
  } else if (pe.tool === 'resize') {
    const out = peOutSize();
    const region = peRegion();
    const fields = el('div', 'pe-size');
    const field = (label) => {
      const box = el('label', 'pe-size-field');
      const input = el('input', 'dialog-input');
      input.type = 'number';
      input.min = '1';
      input.max = '16000';
      box.append(el('span', '', label), input);
      fields.append(box);
      return input;
    };
    pe.widthInput = field('Width');
    pe.heightInput = field('Height');
    pe.widthInput.value = out.w;
    pe.heightInput.value = out.h;
    const ratio = region.w / region.h;
    pe.widthInput.addEventListener('change', () => {
      const w = Number(pe.widthInput.value) || out.w;
      peSetSize(w, pe.lockRatio ? w / ratio : Number(pe.heightInput.value) || out.h);
    });
    pe.heightInput.addEventListener('change', () => {
      const h = Number(pe.heightInput.value) || out.h;
      peSetSize(pe.lockRatio ? h * ratio : Number(pe.widthInput.value) || out.w, h);
    });
    const lock = el('label', 'pe-lock');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = pe.lockRatio;
    box.addEventListener('change', () => { pe.lockRatio = box.checked; });
    lock.append(box, el('span', '', 'Keep its shape'));
    const presets = peChoice([['25', '25%'], ['50', '50%'], ['75', '75%'], ['100', '100%']], '', (value) => peSetSize(region.w * value / 100, region.h * value / 100), 'pe-presets');
    pe.sizeNote = el('p', 'pe-note');
    panel.append(el('h4', 'pe-heading', 'New size'), fields, lock, presets, pe.sizeNote);
    peShowSize();
  }
}

function buildPictureEditor() {
  const { entry } = pe;
  preview.classList.add('editing');
  preview.replaceChildren();
  const bar = el('div', 'preview-bar');
  bar.append(el('span', 'preview-name', entry.name), el('span', 'preview-meta', `${pe.width.toLocaleString()} × ${pe.height.toLocaleString()}`));
  pe.undoButton = el('button', 'tool preview-close');
  pe.undoButton.title = 'Undo (Ctrl+Z)';
  pe.undoButton.append(icon('arrow_undo'));
  pe.undoButton.addEventListener('click', peUndo);
  pe.redoButton = el('button', 'tool preview-close');
  pe.redoButton.title = 'Redo (Ctrl+Y)';
  pe.redoButton.append(icon('arrow_redo'));
  pe.redoButton.addEventListener('click', peRedo);
  const cancel = el('button', 'btn pe-bar-btn', 'Cancel');
  cancel.addEventListener('click', () => leavePictureEdit(false));
  pe.copyButton = el('button', 'btn pe-bar-btn', 'Save as Copy');
  pe.copyButton.addEventListener('click', () => savePictureEdit(false));
  pe.saveButton = el('button', 'btn primary pe-bar-btn', 'Save');
  const inPlace = PICTURE_IN_PLACE.test(entry.name) && !inWindowsDrive(entry.path) && !inTrash();
  pe.saveButton.hidden = !inPlace;
  pe.saveButton.title = 'Save over it. The old picture is kept in the Trash.';
  pe.saveButton.addEventListener('click', () => savePictureEdit(true));
  if (!inPlace) {
    pe.copyButton.classList.add('primary');
    pe.copyButton.title = inWindowsDrive(entry.path) ? 'Windows files are view only, so the copy goes in Pictures.' : 'Saved as a PNG beside it.';
  }
  bar.append(pe.undoButton, pe.redoButton, cancel, pe.copyButton, pe.saveButton);

  const main = el('div', 'pe');
  pe.stage = el('div', 'pe-stage');
  pe.canvas = el('canvas', 'pe-canvas');
  pe.canvas.addEventListener('pointerdown', peCanvasDown);
  pe.canvas.addEventListener('pointermove', peCanvasMove);
  pe.canvas.addEventListener('pointerup', peCanvasUp);
  pe.canvas.addEventListener('pointercancel', peCanvasUp);
  pe.cropBox = el('div', 'pe-crop');
  pe.cropBox.addEventListener('pointerdown', (event) => peCropDrag(event, 'move'));
  ['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se'].forEach((handle) => {
    const grip = el('span', `pe-grip pe-grip-${handle}`);
    grip.addEventListener('pointerdown', (event) => peCropDrag(event, handle));
    pe.cropBox.append(grip);
  });
  pe.cropBox.append(el('span', 'pe-third pe-third-v1'), el('span', 'pe-third pe-third-v2'), el('span', 'pe-third pe-third-h1'), el('span', 'pe-third pe-third-h2'));
  pe.stage.append(pe.canvas, pe.cropBox);

  const side = el('div', 'pe-side');
  pe.tabs = el('div', 'segmented pe-tabs');
  [['crop', 'Crop'], ['adjust', 'Adjust'], ['draw', 'Draw'], ['resize', 'Resize']].forEach(([tool, label]) => {
    const button = el('button', 'segment', label);
    button.type = 'button';
    button.dataset.tool = tool;
    button.addEventListener('click', () => {
      pe.tool = tool;
      pe.stage.classList.toggle('drawing', tool === 'draw');
      peShowPanel();
      peDrawNow();
    });
    pe.tabs.append(button);
  });
  pe.panel = el('div', 'pe-panel');
  side.append(pe.tabs, pe.panel);
  main.append(pe.stage, side);
  preview.append(bar, main);
  pe.resizeObserver = new ResizeObserver(() => peDrawSoon());
  pe.resizeObserver.observe(pe.stage);
  peShowPanel();
  peDrawNow();
}

/* Saving */

async function savePictureEdit(overwrite) {
  if (!pe || pe.saving) return;
  const { entry } = pe;
  const region = peRegion();
  const out = peOutSize();
  pe.saving = true;
  pe.saveButton.disabled = true;
  pe.copyButton.disabled = true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = out.w;
    canvas.height = out.h;
    const context = canvas.getContext('2d', { willReadFrequently: Boolean(pe.adjust.warmth) });
    peRender(context, { region, scaleX: out.w / region.w, scaleY: out.h / region.h, width: out.w, height: out.h, source: pe.image });
    const same = (/\.([^.]+)$/.exec(entry.name)?.[1] || '').toLowerCase();
    const ext = PICTURE_IN_PLACE.test(entry.name) ? (same === 'jfif' ? 'jpg' : same) : 'png';
    const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext];
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
    if (!blob) throw new Error('The picture couldn\'t be made.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const saved = await call('savePicture', entry.path, bytes, { overwrite, ext });
    const done = { ...entry, mtime: Date.now(), size: bytes.length };
    pe.startState = JSON.stringify(peState()); // saved, so leaving won't ask
    stopPictureEdit();
    if (overwrite) {
      showPreview(done);
      toast('Saved. The old picture is in the Trash.', 'Undo', async () => {
        await attempt(() => call('putPictureBack', entry.path, saved.kept));
        if (previewEntry?.path === entry.path) showPreview({ ...entry, mtime: Date.now() });
        loadFolder();
      });
    } else {
      showPreview(entry);
      toast(`Saved as "${shortName(baseName(saved.path), 40)}"`, 'Show', () => {
        closePreview(true);
        openLocation({ path: saved.path, folder: parentOf(saved.path) });
      });
    }
    if (state.active?.kind === 'files') loadFolder();
  } catch (error) {
    if (pe) {
      pe.saving = false;
      peDrawNow();
    }
    await alertBox('That didn\'t work', cleanError(error));
  }
}

// The editor's keys. The preview's own (Esc closes, arrows go to the next file) wait while it's open.
document.addEventListener('keydown', (event) => {
  if (!pe || preview.hidden || dialog.open || event.target.matches?.('input[type="number"], input[type="text"], textarea')) return;
  const lower = event.key.toLowerCase();
  if (event.ctrlKey && !event.altKey && lower === 'z' && !event.shiftKey) { event.preventDefault(); peUndo(); }
  else if (event.ctrlKey && !event.altKey && (lower === 'y' || (lower === 'z' && event.shiftKey))) { event.preventDefault(); peRedo(); }
  else if (event.ctrlKey && !event.altKey && lower === 's') { event.preventDefault(); savePictureEdit(!pe.saveButton.hidden); }
  else if (event.key === 'Escape') { event.preventDefault(); leavePictureEdit(false); }
});
