/* Our own hover text. The browser's built-in one decides its own timing and lingers after the mouse
   has moved away. Any element given a title anywhere in the app is picked up here automatically. */
/* A pop-up, hover text or note says what it has to in two lines at most. fitLines wraps text the way
   the screen would, at about "width" characters a line, a little under what really fits. Text that
   fits comes back as it was; longer text keeps its first two lines and ends with "…". FIT is about
   how many characters fit a line in each: the 460px pop-up, the 300px hover text, and a note at the
   bottom with its button. panel/test/text-length.js holds the app's own words to the same numbers. */
const FIT = { dialog: 54, tip: 44, toast: 52 };

function fitLines(text, width, max = 2) {
  const whole = String(text ?? '');
  const lines = [];
  for (const part of whole.split('\n')) {
    let line = '';
    for (let word of part.split(' ')) {
      // A long name or path with no spaces breaks where the line ends.
      while (word.length > width) {
        if (line) { lines.push(line); line = ''; }
        lines.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  if (lines.length <= max) return whole;
  const kept = lines.slice(0, max);
  kept[max - 1] = `${kept[max - 1].slice(0, width - 1).trimEnd()}…`;
  return kept.join('\n');
}

// Hover text only where it helps. Returns the text to show for an element with a tip, or null for none:
// an icon-only control gets its tip; cut-off text shows in full; a tip that adds something the screen
// doesn't (a second line, a shortcut, or an element marked data-tip-fact) shows as written.
// Plain text that fits gets nothing. Screen-reader labels are not touched by any of this.
function tipFor(el) {
  const tip = el.dataset.tip || '';
  if (!el.textContent.trim()) return tip;
  if (el.hasAttribute('data-tip-fact') || tip.includes('\n') || /\((Ctrl|Alt|Shift|Esc|F\d+|Space)\b/.test(tip)) return tip;
  const cut = [el, ...el.querySelectorAll('*')].some((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1);
  return cut ? el.textContent.trim().replace(/\s+/g, ' ') : null;
}

(function tooltips() {
  const SHOW_MS = 500; // how long to rest on something before its text appears
  const RESHOW_MS = 300; // moving straight on to a neighbor shows its text at once, as Windows does
  const CURSOR_GAP = 22;
  const SIDE_GAP = 4;
  const EDGE = 4;

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.popover = 'manual'; // this also keeps it above an open dialog
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);

  let hovered = null;
  let timer = null;
  let shown = false;
  let lastHidden = -Infinity;
  let pointer = { x: 0, y: 0 };

  function adopt(el) {
    const text = el.getAttribute('title');
    if (text === null) return;
    el.removeAttribute('title');
    el.dataset.tip = text;
    if (el.tagName === 'BUTTON') el.setAttribute('aria-label', text);
    if (el === hovered && shown) tip.textContent = fitLines(text, FIT.tip);
  }

  function adoptWithin(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.hasAttribute('title')) adopt(node);
    node.querySelectorAll('[title]').forEach(adopt);
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    hovered = null;
    if (shown) {
      shown = false;
      lastHidden = performance.now();
      tip.hidePopover();
    }
  }

  function show() {
    if (!hovered || !hovered.isConnected) {
      hide();
      return;
    }
    const text = tipFor(hovered);
    if (!text) return;
    tip.textContent = fitLines(text, FIT.tip);
    tip.showPopover();
    shown = true;
    const box = tip.getBoundingClientRect();
    // A marked area shows it just past its right edge, never covering the area itself, level with the
    // item wherever the mouse is on it.
    const area = hovered.closest('[data-tip-side="right"]');
    if (area) {
      const item = hovered.getBoundingClientRect();
      tip.style.left = `${Math.max(EDGE, Math.min(area.getBoundingClientRect().right + SIDE_GAP, window.innerWidth - box.width - EDGE))}px`;
      tip.style.top = `${Math.max(EDGE, Math.min(item.top + (item.height - box.height) / 2, window.innerHeight - box.height - EDGE))}px`;
      return;
    }
    const below = pointer.y + CURSOR_GAP;
    const top = below + box.height + EDGE <= window.innerHeight ? below : pointer.y - box.height - 8;
    tip.style.left = `${Math.max(EDGE, Math.min(pointer.x, window.innerWidth - box.width - EDGE))}px`;
    tip.style.top = `${Math.max(EDGE, top)}px`;
  }

  document.addEventListener('pointermove', (event) => {
    pointer = { x: event.clientX, y: event.clientY };
  }, { passive: true });

  document.addEventListener('pointerover', (event) => {
    const el = event.target.closest?.('[data-tip]') || null;
    if (el === hovered) return;
    hide();
    if (!el) return;
    hovered = el;
    pointer = { x: event.clientX, y: event.clientY };
    if (performance.now() - lastHidden < RESHOW_MS) show();
    else timer = setTimeout(show, SHOW_MS);
  }, { passive: true });

  // Pressing a button or starting to do anything ends its text until the mouse comes back.
  document.addEventListener('pointerdown', hide, { capture: true, passive: true });
  document.addEventListener('keydown', hide, { capture: true, passive: true });
  document.addEventListener('wheel', hide, { capture: true, passive: true });
  document.documentElement.addEventListener('pointerleave', hide, { passive: true });
  window.addEventListener('blur', hide);

  new MutationObserver((records) => {
    records.forEach((record) => {
      if (record.type === 'attributes') adopt(record.target);
      else record.addedNodes.forEach(adoptWithin);
    });
    // What it was describing was removed from the page, so no mouse-off will ever arrive.
    if (hovered && !hovered.isConnected) hide();
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  document.querySelectorAll('[title]').forEach(adopt);
}());
