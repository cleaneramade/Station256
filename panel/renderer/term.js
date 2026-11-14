/* A terminal drawn in the page, connected to a session that lives in the main process. */
// Light, like the File Explorer around it: a white page, dark gray text and the same blue.
// Every color is dark enough to read on white. "White" is a gray for the same reason.
// Herdr's look in room/herdr-config.toml uses these same colors, so keep the two in step.
const TERM_THEME = {
  background: '#ffffff',
  foreground: '#1b1b1b',
  cursor: '#0f6cbd',
  cursorAccent: '#ffffff',
  // The soft blue of a selected row in File Explorer.
  selectionBackground: '#cce4f7',
  selectionInactiveBackground: '#e5f1fb',
  scrollbarSliderBackground: '#00000033',
  scrollbarSliderHoverBackground: '#00000055',
  scrollbarSliderActiveBackground: '#00000077',
  black: '#1b1b1b',
  red: '#c42b1c',
  green: '#107c10',
  yellow: '#8a5d00',
  blue: '#0f6cbd',
  magenta: '#8b3fb8',
  cyan: '#0b7285',
  white: '#6d6d6d',
  brightBlack: '#767676',
  brightRed: '#d13438',
  brightGreen: '#0e8a43',
  brightYellow: '#9d6a00',
  brightBlue: '#1f74c9',
  brightMagenta: '#9b4fcf',
  brightCyan: '#0e8296',
  brightWhite: '#8a8a8a',
};

// Station Mono comes with the panel. It's Cascadia Mono, the Windows Terminal font, with its block
// and line shapes stretched to fill each row, the way Windows Terminal draws them, so shapes like
// Claude's logo have no gaps (see make-terminal-font.py; SIL Open Font License, see
// fonts/StationMono-LICENSE.txt).
// Anything it doesn't have comes from the same fonts Windows Terminal falls back on: Segoe UI
// Symbol for marks like ⏺ ⎿ ✻, Segoe UI Emoji in color, and the Chinese, Japanese and Korean
// fonts. Those are Windows' own, so they're only on this PC (see docs: windows-local fonts).
const TERM_FALLBACKS = [
  '"Station Emoji"', '"Segoe UI Symbol"', '"Segoe UI Emoji"', '"Microsoft YaHei"', '"Yu Gothic"', '"Malgun Gothic"',
  '"Noto Color Emoji"', '"DejaVu Sans Mono"', 'monospace',
].join(', ');
const TERM_FONT = `"Station Mono", ${TERM_FALLBACKS}`;
const TERM_FONT_FALLBACK = `Consolas, "Ubuntu Sans Mono", ${TERM_FALLBACKS}`;
// Characters that show as color emoji in Windows Terminal. Segoe UI Symbol has black-and-white
// copies of many of them, so these go to the emoji font first.
const EMOJI_RANGE = 'U+200D,U+20E3,U+FE0F,U+231A-231B,U+23E9-23EC,U+23F0,U+23F3,U+25FD-25FE,U+2614-2615,U+2648-2653,U+267F,U+2693,U+26A1,U+26AA-26AB,U+26BD-26BE,U+26C4-26C5,U+26CE,U+26D4,U+26EA,U+26F2-26F3,U+26F5,U+26FA,U+26FD,U+2705,U+270A-270B,U+2728,U+274C,U+274E,U+2753-2755,U+2757,U+2795-2797,U+27B0,U+27BF,U+2B1B-2B1C,U+2B50,U+2B55,U+1F000-1FAFF';
const termFontsReady = (() => {
  // Not there on a PC without the Windows fonts, and that's fine: the next font is used instead.
  const emoji = new FontFace('Station Emoji', 'local("Segoe UI Emoji"), local("SegoeUIEmoji"), local("Noto Color Emoji")', { unicodeRange: EMOJI_RANGE });
  document.fonts.add(emoji);
  emoji.load().catch(() => {});
  const faces = ['400', '700'].map((weight) => {
    const face = new FontFace('Station Mono', `url("fonts/station-mono-${weight}.woff2")`, { weight });
    document.fonts.add(face);
    return face.load();
  });
  return Promise.all(faces).then(() => true, () => false);
})();
let termFontsLoaded = false;
termFontsReady.then((ok) => { termFontsLoaded = ok; });

const liveTerminals = new Map();

window.house.on('term:data', ({ id, data }) => {
  const live = liveTerminals.get(id);
  if (live) live.term.write(data);
});

// Text a program in the terminal asks to copy (OSC 52), such as a selection made inside a room
// terminal. Programs may put text on the clipboard, never read it.
function clipboardRequest(data) {
  const [, payload] = data.split(';');
  if (!payload || payload === '?') return true;
  try {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    if (text) window.house.call('clipboardWrite', text);
  } catch { /* not valid text, so nothing is copied */ }
  return true;
}

// A room terminal runs inside Herdr, which opens its own menus on right and middle clicks (split,
// close, new tab). A room terminal is just a terminal, so those clicks stop here. Left clicks and
// the wheel still go through.
function keepClicksFromHerdr(host) {
  const stop = (event) => {
    const held = event.type === 'mousemove' ? event.buttons & 6 : event.button === 1 || event.button === 2;
    if (!held) return;
    event.stopPropagation();
    event.preventDefault();
  };
  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'mousemove', 'auxclick'].forEach((type) => host.addEventListener(type, stop, true));
  host.addEventListener('contextmenu', (event) => {
    event.stopPropagation();
    event.preventDefault();
  }, true);
}

// Drag to highlight, as in Windows, even when the program wants the mouse (Herdr, Claude). xterm
// only highlights then on a Shift+drag, so a plain press is held back: if the mouse moves, it is
// sent as a Shift press (xterm highlights); if it is let go first, the plain click goes to the
// program. A double click picks a word.
// Herdr and Claude also ask for every mouse move, and xterm wipes the highlight whenever it tells
// the program something. So while highlighting, or while a highlight shows, moves aren't told.
function dragAlwaysSelects(term, host) {
  const ours = new WeakSet();
  let selecting = false;
  const resend = (start, shiftKey) => {
    const copy = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, detail: start.detail,
      clientX: start.clientX, clientY: start.clientY, screenX: start.screenX, screenY: start.screenY, button: 0, buttons: 1, shiftKey });
    ours.add(copy);
    if (shiftKey) {
      selecting = true;
      window.addEventListener('mouseup', () => { selecting = false; }, { capture: true, once: true });
    }
    start.target.dispatchEvent(copy);
  };
  host.addEventListener('mousemove', (event) => {
    if (term.modes.mouseTrackingMode === 'none' || !(selecting || term.hasSelection())) return;
    event.stopPropagation(); // keeps it from the program (xterm's listener on the terminal)
    // xterm grows the highlight from a listener on the page itself, so it still gets the move there.
    if (selecting) document.dispatchEvent(new MouseEvent('mousemove', event));
  }, true);
  host.addEventListener('mousedown', (start) => {
    if (ours.has(start) || start.button !== 0 || start.shiftKey || start.ctrlKey || start.altKey || start.metaKey) return;
    if (term.modes.mouseTrackingMode === 'none') return; // no program wants the mouse: xterm highlights already
    start.stopPropagation();
    start.preventDefault();
    term.focus();
    if (start.detail >= 2) return resend(start, true);
    const done = (shiftKey) => {
      window.removeEventListener('mousemove', moved, true);
      window.removeEventListener('mouseup', letGo, true);
      resend(start, shiftKey);
    };
    const moved = (event) => { if (Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > 3) done(true); };
    const letGo = () => done(false);
    window.addEventListener('mousemove', moved, true);
    window.addEventListener('mouseup', letGo, true);
  }, true);
}

// Web links open in your browser on Windows, with a click. A link to localhost from a room terminal
// is a site running in that room, and the app opens a path to it first (lib/ports.js).
function openLink(text, id) {
  const url = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  window.house.call('openLink', url, id).catch((error) => {
    const message = String(error.message || error).replace(/^Error invoking remote method 'call': (Error: )?/, '');
    window.dispatchEvent(new CustomEvent('station:notice', { detail: message }));
  });
}

// Addresses with http:// or https://, and bare localhost:PORT ones, as programs print them.
const LINK = /\bhttps?:\/\/[^\s<>"'`]+|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b(?:\/[^\s<>"'`]*)?/gi;

// A link ends before closing punctuation, unless that's part of it, like the ) in a page name.
function trimLink(text) {
  let end = text.length;
  while (end > 0) {
    const last = text[end - 1];
    if ('.,;:!?\'"'.includes(last)) end -= 1;
    else if (')]}>'.includes(last)) {
      const open = { ')': '(', ']': '[', '}': '{', '>': '<' }[last];
      const body = text.slice(0, end);
      if (body.split(open).length >= body.split(last).length) break;
      end -= 1;
    } else break;
  }
  return text.slice(0, end);
}

// Finds the links on screen lines, for xterm to underline and open. A line the terminal wrapped
// counts as one with the next. So does a line filled to its last column that runs straight into
// the next with no space, as a long address does when a program draws it in pieces (Herdr).
function linkFinder(term, id) {
  return {
    provideLinks(y, callback) {
      const buffer = term.buffer.active;
      const cols = term.cols;
      const row = (n) => buffer.getLine(n - 1);
      const full = (n) => {
        const line = row(n);
        const last = line && line.getCell(cols - 1);
        return Boolean(last && last.getChars() && last.getChars() !== ' ');
      };
      const joins = (n) => {
        const next = row(n + 1);
        if (!next) return false;
        if (next.isWrapped) return true;
        const first = next.getCell(0);
        return full(n) && Boolean(first && first.getChars() && /[\w\-._~:/?#[\]@!$&'()*+,;=%]/.test(first.getChars()));
      };
      let start = y;
      while (start > 1 && joins(start - 1) && y - start < 10) start -= 1;
      let end = y;
      while (joins(end) && end - y < 10) end += 1;
      // The text of those lines, and the screen cell each character sits in.
      let text = '';
      const cells = [];
      for (let n = start; n <= end; n += 1) {
        const line = row(n);
        if (!line) break;
        for (let x = 0; x < cols; x += 1) {
          const cell = line.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || ' ';
          for (let i = 0; i < chars.length; i += 1) cells.push({ x: x + 1, y: n, w: cell.getWidth() });
          text += chars;
        }
      }
      const links = [];
      for (const match of text.matchAll(LINK)) {
        const found = trimLink(match[0]);
        if (!found) continue;
        const first = cells[match.index];
        const last = cells[match.index + found.length - 1];
        if (!first || !last || last.y < y || first.y > y) continue;
        links.push({
          range: { start: { x: first.x, y: first.y }, end: { x: last.x + last.w - 1, y: last.y } },
          text: found,
          decorations: { pointerCursor: true, underline: true },
          activate: (_event, linkText) => openLink(linkText, id),
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}

// xterm remembers a line's links while the mouse stays on that line, so a link a program has just
// drawn under a still mouse (Claude redraws all the time) wouldn't be found until the mouse moved
// to another line. After new output, the next move first touches the line next to it, which makes
// xterm look again.
function keepLinksFresh(term, host) {
  let stale = false;
  term.onWriteParsed(() => { stale = true; });
  host.addEventListener('mousemove', (event) => {
    if (!stale) return;
    stale = false;
    const screen = host.querySelector('.xterm-screen');
    if (!screen) return;
    const box = screen.getBoundingClientRect();
    const rowHeight = box.height / term.rows;
    const y = event.clientY - box.top < rowHeight ? event.clientY + rowHeight : event.clientY - rowHeight;
    screen.dispatchEvent(new MouseEvent('mousemove', { clientX: event.clientX, clientY: y, bubbles: true }));
  }, true);
}

// The terminal that last had the keyboard, for words from voice typing.
let lastTyped = null;

// Where words from voice typing (Win + H) go: the text box you were in, or else the terminal.
function voiceTarget() {
  const focused = document.activeElement;
  const lives = [...liveTerminals.values()];
  let live = lives.find((item) => item.term.textarea === focused);
  const field = !live && focused && (focused.tagName === 'TEXTAREA'
    || (focused.tagName === 'INPUT' && /^(text|search|url|)$/i.test(focused.type))
    || focused.isContentEditable) ? focused : null;
  if (field) return { field };
  // Only a terminal that's still open and on screen.
  if (!live && lastTyped && lives.includes(lastTyped) && lastTyped.host.offsetParent !== null) live = lastTyped;
  return live ? { live } : null;
}

// Voice typing as you speak (Win + H). Windows' voice typing works in an invisible Windows box
// (Windows won't type into a Linux window), and each change it makes comes here at once: letters to
// take back, then letters to add. So the words appear where you were typing as you say them, and
// Windows' own corrections show too. Enter only comes when you press it, after the words.
window.house.on('voice:edit', ({ remove, add, enter }) => {
  const target = voiceTarget();
  if (!target) return;
  const words = String(add || '').replace(/[\r\n]+/g, ' ');
  const back = Number.isInteger(remove) && remove > 0 ? remove : 0;
  if (target.live) {
    // A terminal takes a backspace for each letter to take back, like typing.
    const data = '\x7f'.repeat(back) + words + (enter ? '\r' : '');
    if (data) target.live.term.input(data, true);
    return;
  }
  const field = target.field;
  if (field.isContentEditable) {
    for (let i = 0; i < back; i += 1) document.execCommand('delete');
    if (words) document.execCommand('insertText', false, words);
  } else {
    const end = field.selectionEnd ?? field.value.length;
    let start = Math.min(field.selectionStart ?? end, end);
    // Back one letter at a time, never splitting an emoji in two.
    for (let i = 0; i < back && start > 0; i += 1) {
      start -= 1;
      if (start > 0 && /[\uDC00-\uDFFF]/.test(field.value[start]) && /[\uD800-\uDBFF]/.test(field.value[start - 1])) start -= 1;
    }
    field.setRangeText(words, start, end, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (enter) {
    for (const type of ['keydown', 'keyup']) {
      field.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }
});

// Words from voice typing (Win + H) go where you were typing: a terminal, or a text box. They're
// typed in, not sent, so you can check them and press Enter yourself. (Kept for a helper from
// before voice:edit, and for when the words come all at once.)
window.house.on('voice:text', ({ text }) => {
  const words = String(text || '').trim();
  if (!words) return;
  const target = voiceTarget();
  if (!target) return;
  const { field, live } = target;
  if (field) {
    field.focus();
    // Typed the usual way, so Ctrl+Z undoes it. A window that isn't in front can't do that, so
    // then the words go straight in.
    if (!document.execCommand('insertText', false, words) && !field.isContentEditable) {
      field.setRangeText(words, field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length, 'end');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  live.term.focus();
  live.term.input(words.replace(/\s*[\r\n]+\s*/g, ' '), true);
});

function mountTerminal(host, id, initialText, { room = false } = {}) {
  const term = new Terminal({
    theme: TERM_THEME,
    fontFamily: termFontsLoaded ? TERM_FONT : TERM_FONT_FALLBACK,
    fontSize: 13,
    // The font's own row height, as in Windows Terminal. Taller rows leave gaps in block shapes.
    lineHeight: 1,
    cursorStyle: 'bar',
    cursorWidth: 2,
    cursorBlink: true,
    cursorInactiveStyle: 'outline',
    scrollback: 10000,
    smoothScrollDuration: 80,
    // Programs made for dark terminals can print text too pale to read on white. Only that gets
    // darkened. Colors a program picks on purpose, like Claude's orange, stay as they are.
    minimumContrastRatio: 3,
    // Needed only for term.unicode below.
    allowProposedApi: true,
    // Links a program marks as links (OSC 8), such as a long address shown as a short name.
    linkHandler: { activate: (_event, text) => openLink(text, id), allowNonHttpProtocols: false },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // Emoji and Chinese, Japanese and Korean letters take two columns, as in Windows Terminal and
  // in the programs that draw on the screen (Claude, Codex, Herdr). The old rules said one, which
  // pushed the rest of the line out of place.
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(host);
  if (room) keepClicksFromHerdr(host);
  dragAlwaysSelects(term, host);
  term.parser.registerOscHandler(52, clipboardRequest);
  term.registerLinkProvider(linkFinder(term, id));
  keepLinksFresh(term, host);

  // As in Windows Terminal: Ctrl+C copies when text is selected and stops the program when not,
  // and Ctrl+V (or Alt+V) pastes. Ctrl+Shift+C and Ctrl+Shift+V also work, as in the Ubuntu terminal.
  // Drag to highlight in any terminal (dragAlwaysSelects), then Ctrl+C or right-click Copy.
  const copy = () => {
    window.house.call('clipboardWrite', term.getSelection());
    term.clearSelection();
  };
  // A picture copied in Windows pastes as the path of a file holding it (lib/pasted-image.js).
  const paste = () => window.house.call('termPaste', id).then((text) => { if (text) term.paste(text); }, (error) => {
    const message = String(error.message || error).replace(/^Error invoking remote method 'call': (Error: )?/, '');
    window.dispatchEvent(new CustomEvent('station:notice', { detail: message }));
  });
  // Right-click: Station's own menu, the same four as everywhere (app.js). Copy takes what's highlighted.
  host.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    rightClickMenu(event.clientX, event.clientY, {
      copy: term.hasSelection() ? copy : null,
      paste,
      selectAll: () => term.selectAll(),
    });
  }, true);
  const is = (event, letter) => event.code === `Key${letter.toUpperCase()}` || event.key?.toLowerCase() === letter;
  term.attachCustomKeyEventHandler((event) => {
    // Alt+V pastes too: it's how Claude pastes a picture on Windows. Left to the program, Claude
    // in a room can't reach the clipboard (the room is reached over SSH) and says so.
    if (event.type === 'keydown' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && is(event, 'v')) {
      event.preventDefault();
      paste();
      return false;
    }
    if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true;
    if (is(event, 'c') && (event.shiftKey || term.hasSelection())) {
      event.preventDefault();
      if (term.hasSelection()) copy();
      return false;
    }
    if (is(event, 'v')) {
      event.preventDefault(); // otherwise the browser would paste it a second time
      paste();
      return false;
    }
    return true;
  });

  // Connected only after old history has been replayed, so answers to questions a program asked
  // long ago can't get typed into the running session.
  const connect = () => term.onData((data) => window.house.call('termWrite', id, data));
  if (initialText) term.write(initialText, connect);
  else connect();
  term.onResize(({ cols, rows }) => window.house.call('termResize', id, cols, rows));

  const refit = () => {
    if (host.offsetWidth > 0 && host.offsetHeight > 0) fit.fit();
  };
  // A window glide resizes the host on every frame, so the terminal refits once it settles.
  let refitTimer = null;
  const observer = new ResizeObserver(() => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(refit, 90);
  });
  observer.observe(host);
  refit();
  // The first terminal can open before its font has loaded. It switches over as soon as it has.
  if (!termFontsLoaded) {
    termFontsReady.then((ok) => {
      if (!ok || liveTerminals.get(id)?.term !== term) return;
      term.options.fontFamily = TERM_FONT;
      refit();
    });
  }

  const live = {
    term,
    host,
    refit,
    dispose() {
      observer.disconnect();
      liveTerminals.delete(id);
      term.dispose();
    },
  };
  liveTerminals.set(id, live);
  // What the program in it calls it (Claude names it after the task), for the Agents page.
  term.onTitleChange((title) => { live.title = title; });
  term.textarea?.addEventListener('focus', () => { lastTyped = live; });
  return live;
}
