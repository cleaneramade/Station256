// What lib/ai-browser.js runs inside the page a room's AI is using. It runs in Station's own
// isolated world (so the page's scripts can't swap it out), and only does what the AI's commands
// need: list the page as a tree with refs (@e1, @e2 ...), find a part, aim at it, read its words.
// The ideas (an accessibility-style snapshot with refs, find by role or text) follow vercel-labs/agent-browser
// (Apache-2.0); the code here is written for Station's page and walls, not copied.
//
// install() is serialized and run in the page, so it must not use anything outside itself.
// shortcut: same-origin iframes aren't listed (only the top page and open shadow roots); add if a site needs it.
function install(limit) {
  if (window.__st) return window.__st;
  const SECRET = 'input[type=password], [autocomplete~="cc-number"], [autocomplete~="cc-csc"], [autocomplete~="one-time-code"], [autocomplete~="current-password"], [autocomplete~="new-password"]';
  const TAGS = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button', img: 'img', nav: 'navigation', main: 'main', form: 'form', dialog: 'dialog', table: 'table', ul: 'list', ol: 'list', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading' };
  const TYPES = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', search: 'searchbox' };
  const ACTIVE = new Set(['link', 'button', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'slider', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'treeitem', 'clickable']);
  const LANDMARK = new Set(['navigation', 'main', 'form', 'dialog', 'alertdialog', 'table', 'list']);
  const PARTS = 'a[href], button, input, textarea, select, summary, [role], [onclick], [tabindex], [contenteditable=""], [contenteditable=true], h1, h2, h3, h4, h5, h6, img, nav, main, form, dialog, table, ul, ol';
  const INNER = 'a[href], button, input, select, textarea, [role], [onclick], [tabindex]';
  const refs = [];
  const ids = new Map(); // the same part keeps its number between snapshots
  const words = (text, most = 80) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, most);

  const roleOf = (el) => {
    const given = (el.getAttribute('role') || '').split(' ')[0];
    if (given) return given;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return el.type === 'hidden' || el.type === 'file' ? '' : TYPES[el.type] || 'textbox';
    if (TAGS[tag]) return tag === 'a' && !el.hasAttribute('href') ? '' : TAGS[tag];
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    if (el.hasAttribute('onclick') || (el.tabIndex >= 0 && el.hasAttribute('tabindex'))) return 'clickable';
    return '';
  };
  // A tick box or radio the page hides (display none, or no size) and styles through its label: the label is the part to use.
  const hiddenBox = (el) => el.tagName === 'LABEL' && el.control && /^(checkbox|radio)$/.test(el.control.type) && !shown(el.control);
  const nameOf = (el) => {
    const by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => (id && document.getElementById(id) ? document.getElementById(id).innerText : '')).join(' ');
    const img = el.querySelector && el.querySelector('img[alt]');
    const field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
    const button = el.tagName === 'INPUT' && /^(submit|button|reset)$/.test(el.type);
    return words(el.getAttribute('aria-label') || by || (el.labels && el.labels[0] && el.labels[0].innerText) || (el.tagName === 'IMG' && el.alt) || (button && el.value) || el.placeholder || el.title || el.name || (!field && el.innerText) || (img && img.alt), 100);
  };
  const secret = (el) => el.matches(SECRET);
  const shown = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const ref = (el) => {
    if (!ids.has(el)) { refs.push(el); ids.set(el, refs.length); }
    return ids.get(el);
  };
  const stateOf = (el, role) => {
    const out = [];
    if (role === 'checkbox' || role === 'radio' || role === 'switch') out.push(((hiddenBox(el) ? el.control : el).checked ?? el.getAttribute('aria-checked') === 'true') ? 'checked' : 'unchecked');
    if (el.getAttribute('aria-expanded')) out.push(el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')) out.push('selected');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    return out.map((one) => ` [${one}]`).join('');
  };
  // One line for a part: role, name, ref, state and (for boxes and choices) what it holds.
  const describe = (el, role, indent = '', forceRef = false) => {
    let line = `${indent}- ${role} "${nameOf(el)}"`;
    if (ACTIVE.has(role) || forceRef) line += ` [ref=e${ref(el)}]`;
    line += stateOf(el, role);
    if (role === 'link' && el.href) line += ` -> ${words(el.href, 200)}`;
    if (el.tagName === 'SELECT') line += ` options: ${[...el.options].slice(0, 30).map((o) => (o.selected ? '*' : '') + words(o.text, 40)).join(' | ')}`;
    else if ((role === 'textbox' || role === 'searchbox' || role === 'slider') && !(el.value === undefined && !el.isContentEditable)) {
      const value = el.isContentEditable ? el.textContent : el.value;
      if (value) line += ` value="${words(value, 60)}"`;
    }
    return line;
  };

  const snapshot = (flat) => {
    const lines = [];
    let size = 0;
    let parts = 0;
    let seen = 0;
    let hidden = 0;
    let cut = false;
    const add = (line) => { lines.push(line); size += line.length; if (size > limit) cut = true; };
    const text = (value, indent) => {
      const words2 = words(value, 300);
      if (words2 && lines[lines.length - 1] !== `${indent}- text "${words2}"`) add(`${indent}- text "${words2}"`);
    };
    const walk = (el, depth) => {
      if (cut || (seen += 1) > 8000) { cut = true; return; }
      const tag = el.tagName.toLowerCase();
      if (/^(script|style|noscript|template|svg|head|link|meta)$/.test(tag)) return;
      if (el.getAttribute('aria-hidden') === 'true' || el.inert) return;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return;
      const indent = '  '.repeat(Math.min(depth, 8));
      if (s.display !== 'contents') {
        if (secret(el)) { hidden += 1; return; }
        let role = roleOf(el);
        if (hiddenBox(el)) role = el.control.type;
        // Not a tag or role, but it looks and works like a button (a pointer cursor that its parent doesn't have).
        else if (!role && s.cursor === 'pointer' && el.parentElement && getComputedStyle(el.parentElement).cursor !== 'pointer' && el.innerText && el.innerText.trim()) role = 'clickable';
        const inner = role && ACTIVE.has(role) && !hiddenBox(el) && el.querySelector(INNER);
        // A wrapper that only looks clickable (tabindex, onclick) is not a part itself when real parts are inside it.
        if (role && ACTIVE.has(role) && !(role === 'clickable' && inner)) {
          if (!shown(el) || el.type === 'file') return;
          if ((parts += 1) > 300) { cut = true; return; }
          add(describe(el, role, flat ? '' : indent));
          if (!inner) return; // what is inside has been used for its name
        }
        if (flat && !el.querySelector(PARTS)) return;
        const level = el.getAttribute('aria-level') || (/^h[1-6]$/.test(tag) ? tag[1] : '');
        if (!flat && role === 'heading' && !el.querySelector(INNER)) { add(`${indent}- heading "${words(el.innerText, 200)}"${level ? ` [level=${level}]` : ''}`); return; }
        if (!flat && role === 'img') { if (el.alt) add(`${indent}- img "${words(el.alt, 100)}"`); return; }
        if (!flat && role === 'heading') add(`${indent}- heading${level ? ` [level=${level}]` : ''}`);
        if (!flat && LANDMARK.has(role)) add(`${indent}- ${role}${nameOf(el) && el.getAttribute('aria-label') ? ` "${nameOf(el)}"` : ''}`);
        else if (!flat && !el.querySelector(PARTS) && !el.shadowRoot) { if (shown(el) && !(tag === 'label' && el.control && !secret(el.control))) text(el.innerText, indent); return; } // a label's words are already the name of its box
      }
      const next = flat ? 0 : depth + (LANDMARK.has(roleOf(el)) || roleOf(el) === 'heading' ? 1 : 0);
      if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, next);
      for (const node of el.childNodes) {
        if (node.nodeType === 1) walk(node, next);
        else if (node.nodeType === 3 && !flat && !(tag === 'label' && el.control)) text(node.textContent, '  '.repeat(Math.min(next, 8)));
      }
    };
    if (document.body) walk(document.body, 0);
    return { title: words(document.title, 200), url: location.href, lines, cut, secrets: hidden, scroll: Math.round(scrollY), height: Math.round(document.documentElement.scrollHeight), view: innerHeight };
  };

  const part = (n) => {
    const el = refs[n - 1];
    if (!el || !el.isConnected) return { error: `Part @e${n} is not on the page any more. Use snapshot to see the page again.` };
    if (secret(el)) return { error: 'That is a password or card box. Only the user types there.' };
    if (el.type === 'file' || (el.tagName === 'LABEL' && el.control && el.control.type === 'file')) return { error: 'That opens a file picker, which the AI can\'t use.' };
    return { el };
  };
  // Scrolls part N into view and says where its middle is. typing: also focus it and select what is in it.
  const aim = (n, typing) => {
    const found = part(n);
    if (found.error) return found;
    const el = found.el;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    if (top && (top.type === 'file' || top.closest('input[type=file]'))) return { error: 'A file picker is on top of that spot.' };
    if (!typing) return { x, y, covered: top && top !== el && !el.contains(top) && !top.contains(el) ? `${top.tagName.toLowerCase()} "${nameOf(top)}"` : '' };
    if (el.tagName === 'SELECT') return { x, y, select: true };
    const box = (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|image|range|color)$/.test(el.type)) || el.tagName === 'TEXTAREA' || el.isContentEditable;
    if (!box) return { error: 'That part is not a box you can type in. Use click, check or select.' };
    el.focus();
    if (typeof el.select === 'function') el.select(); else document.getSelection().selectAllChildren(el);
    return { x, y, focused: document.activeElement === el };
  };
  const hover = (n) => {
    const found = part(n);
    if (found.error) return found;
    const r = found.el.getBoundingClientRect();
    for (const type of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointermove', 'mousemove']) {
      found.el.dispatchEvent(new MouseEvent(type, { bubbles: !/enter$/.test(type), cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    }
    return {};
  };
  const valueOf = (n) => { const el = refs[n - 1]; return el ? (el.isContentEditable ? el.textContent : el.value) : null; };
  const setValue = (n, text) => {
    const el = refs[n - 1];
    if (!el || secret(el)) return false;
    if (el.isContentEditable) el.textContent = text;
    else {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (setter && setter.set) setter.set.call(el, text); else el.value = text;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const choose = (n, wanted) => {
    const found = part(n);
    if (found.error) return found;
    const el = found.el;
    if (el.tagName !== 'SELECT') return { error: `Part @e${n} is not a choice.` };
    const want = String(wanted).toLowerCase();
    const option = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) || [...el.options].find((o) => o.text.toLowerCase().includes(want));
    if (!option) return { error: `Choice @e${n} has no option like that. It has: ${[...el.options].slice(0, 30).map((o) => words(o.text, 40)).join(' | ')}` };
    el.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { chose: option.text.trim() };
  };
  // Whether a tick box (or a switch) is ticked now; null if the part isn't one.
  const ticked = (n) => {
    const found = part(n);
    if (found.error) return found;
    const el = hiddenBox(found.el) ? found.el.control : found.el;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return { on: el.checked, radio: el.type === 'radio' };
    if (/^(checkbox|switch|radio|menuitemcheckbox)$/.test(el.getAttribute('role') || '')) return { on: el.getAttribute('aria-checked') === 'true', radio: el.getAttribute('role') === 'radio' };
    return { error: `Part @e${n} is not a tick box.` };
  };
  const textOf = (n) => {
    const found = part(n);
    if (found.error) return found;
    const el = found.el;
    return { text: words(el.isContentEditable || el.value === undefined ? el.innerText || el.textContent : el.value, 4000) };
  };
  // Parts matching: kind 'text' (what they say) or 'role' (with a name, optional).
  const find = (kind, wanted, name) => {
    const q = String(wanted).toLowerCase();
    const out = [];
    let looked = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (out.length >= 20 || (looked += 1) > 6000) break;
      if (/^(script|style|noscript|template|svg|option)$/i.test(el.tagName) || secret(el) || el.type === 'file') continue;
      let role = roleOf(el);
      if (kind === 'role') {
        if (role !== q || !shown(el)) continue;
        if (name && !nameOf(el).toLowerCase().includes(String(name).toLowerCase())) continue;
      } else {
        const own = [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join(' ').toLowerCase();
        if (!(own.includes(q) || (ACTIVE.has(role) && nameOf(el).toLowerCase().includes(q))) || !shown(el)) continue;
        role = role || 'text';
      }
      out.push(describe(el, role, '', true));
    }
    return out;
  };
  // Is part N there and showing, or are these words on the page?
  const there = (n, text) => {
    if (n) { const el = refs[n - 1]; return !!el && el.isConnected && shown(el); }
    return !!document.body && document.body.innerText.toLowerCase().includes(String(text).toLowerCase());
  };
  window.__st = { snapshot, aim, hover, valueOf, setValue, choose, ticked, textOf, find, there };
  return window.__st;
}

module.exports = { install };
