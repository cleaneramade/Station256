// Station 256's editor, on CodeMirror 6 (the engine Obsidian uses). Markdown shows as it reads: its
// marks (#, **, [ ](...), - [ ]...) only show on the line or part you're typing in. Text and code
// files get a plain editor, code with colors and line numbers. Built into renderer/vendor/editor.js
// with `npm run build` in panel/editor; the page loads it the first time a file opens.
import { EditorState, EditorSelection, StateField, StateEffect, Compartment, Prec, Transaction } from '@codemirror/state';
import {
  EditorView, Decoration, ViewPlugin, WidgetType, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, dropCursor, highlightSpecialChars,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  syntaxTree, syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter,
  foldKeymap, StreamLanguage,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, search, openSearchPanel } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { go } from '@codemirror/legacy-modes/mode/go';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { c, cpp, java, kotlin, csharp, dart, scala } from '@codemirror/legacy-modes/mode/clike';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { r } from '@codemirror/legacy-modes/mode/r';
import { tags as t } from '@lezer/highlight';

/* ---------- Languages ---------- */

const legacy = (mode) => () => StreamLanguage.define(mode);
const LANGUAGES = {
  js: () => javascript(), mjs: () => javascript(), cjs: () => javascript(), javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }), ts: () => javascript({ typescript: true }), typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  py: () => python(), python: () => python(),
  json: () => json(), jsonc: () => json(), jsonl: () => json(), json5: () => json(),
  css: () => css(), scss: () => css(), less: () => css(),
  html: () => html(), htm: () => html(), xml: () => html(), svg: () => html(), vue: () => html(), svelte: () => html(),
  yml: () => yaml(), yaml: () => yaml(),
  sql: () => sql(),
  sh: legacy(shell), bash: legacy(shell), zsh: legacy(shell), shell: legacy(shell), fish: legacy(shell), console: legacy(shell),
  toml: legacy(toml), dockerfile: legacy(dockerFile), docker: legacy(dockerFile),
  ini: legacy(properties), cfg: legacy(properties), conf: legacy(properties), env: legacy(properties), properties: legacy(properties),
  diff: legacy(diff), patch: legacy(diff),
  go: legacy(go), rs: legacy(rust), rust: legacy(rust), rb: legacy(ruby), ruby: legacy(ruby), lua: legacy(lua),
  ps1: legacy(powerShell), powershell: legacy(powerShell), pwsh: legacy(powerShell),
  c: legacy(c), h: legacy(c), cc: legacy(cpp), cpp: legacy(cpp), cxx: legacy(cpp), hpp: legacy(cpp), 'c++': legacy(cpp),
  java: legacy(java), kt: legacy(kotlin), kotlin: legacy(kotlin), cs: legacy(csharp), csharp: legacy(csharp),
  dart: legacy(dart), scala: legacy(scala), swift: legacy(swift), pl: legacy(perl), perl: legacy(perl), r: legacy(r),
};

function languageFor(name) {
  const make = LANGUAGES[String(name || '').toLowerCase()];
  return make ? make() : null;
}

// Code inside ``` blocks in Markdown gets the colors of its language.
function codeLanguage(info) {
  const support = languageFor(info.trim().split(/\s+/)[0]);
  if (!support) return null;
  return support.language || support;
}

/* ---------- Colors ---------- */

const MONO = "'Station Mono', 'Cascadia Mono', Consolas, monospace";

const codeColors = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: '#af00db' },
  { tag: [t.bool, t.null, t.atom, t.self], color: '#0000ff' },
  { tag: [t.string, t.special(t.string), t.character], color: '#a31515' },
  { tag: [t.regexp, t.escape], color: '#811f3f' },
  { tag: [t.number, t.integer, t.float], color: '#098658' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#6a7a6a', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#795e26' },
  { tag: [t.typeName, t.className, t.namespace], color: '#267f99' },
  { tag: [t.propertyName, t.attributeName], color: '#0451a5' },
  { tag: [t.variableName, t.labelName], color: '#001080' },
  { tag: [t.tagName, t.angleBracket], color: '#800000' },
  { tag: [t.meta, t.annotation], color: '#7a7a7a' },
  { tag: t.invalid, color: '#cd3131' },
]);

// In Markdown the page's own look (below) does the headings and lines; these color what's left.
const markdownColors = HighlightStyle.define([
  { tag: t.processingInstruction, color: '#8b929b' }, // the # * ` > marks, while they show
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--blue, #0067c0)' },
  { tag: t.url, color: '#6b7280' },
  { tag: t.monospace, fontFamily: MONO, fontSize: '0.92em' },
  { tag: t.contentSeparator, color: '#8b929b' },
]);

const look = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-size, 15px)', color: 'var(--text, #1b1b1b)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '18px 0 45vh', caretColor: 'var(--blue, #0067c0)' },
  '.cm-cursor': { borderLeftColor: 'var(--blue, #0067c0)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#cce4fb !important' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: '#a0a6ad' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#1b1b1b' },
  '.cm-activeLine': { backgroundColor: 'rgba(0, 103, 192, 0.04)' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(0, 103, 192, 0.12)', outline: 'none' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(255, 196, 0, 0.25)' },
  '.cm-searchMatch': { backgroundColor: 'rgba(255, 196, 0, 0.35)', outline: '1px solid rgba(200, 150, 0, 0.5)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(255, 150, 0, 0.5)' },
  '.cm-panels': { backgroundColor: 'var(--surface, #fff)', color: 'inherit', fontFamily: 'Selawik, "Segoe UI", sans-serif' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line, #e5e5e5)' },
  '.cm-panel.cm-search': { padding: '8px 12px', fontSize: '13px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'inherit', fontSize: '13px' },
  '.cm-panel.cm-search .cm-textfield': { border: '1px solid var(--line, #d0d0d0)', borderRadius: '5px', padding: '3px 8px', outline: 'none' },
  '.cm-panel.cm-search .cm-textfield:focus': { borderColor: 'var(--blue, #0067c0)' },
  '.cm-panel.cm-search .cm-button': { background: 'var(--surface, #fff)', backgroundImage: 'none', border: '1px solid var(--line, #d0d0d0)', borderRadius: '5px', padding: '3px 10px' },
  '.cm-panel.cm-search label': { fontSize: '13px' },
  '.cm-panel.cm-search [name=close]': { fontSize: '18px', right: '10px' },
  // Code and text files
  '&.cm-code .cm-scroller': { fontFamily: MONO, fontSize: '0.9em', lineHeight: '1.55' },
  '&.cm-plain .cm-content': { maxWidth: '980px', margin: '0 auto', padding: '18px 32px 45vh' },
  // Markdown, at a line length that reads well, as Obsidian does
  '&.cm-md .cm-content': { maxWidth: '860px', margin: '0 auto', padding: '26px 36px 45vh' },
  '.cm-h1': { fontSize: '1.8em', fontWeight: '700', lineHeight: '1.3', paddingTop: '0.5em !important' },
  '.cm-h2': { fontSize: '1.45em', fontWeight: '650', lineHeight: '1.35', paddingTop: '0.45em !important' },
  '.cm-h3': { fontSize: '1.25em', fontWeight: '650', paddingTop: '0.35em !important' },
  '.cm-h4': { fontSize: '1.1em', fontWeight: '650', paddingTop: '0.25em !important' },
  '.cm-h5': { fontSize: '1em', fontWeight: '650' },
  '.cm-h6': { fontSize: '0.95em', fontWeight: '650', color: '#5f6670' },
  '.cm-quote': { borderLeft: '3px solid #b9d9f6', paddingLeft: '14px !important', color: '#4a515a' },
  '.cm-bullet': { color: '#7a828c', display: 'inline-block', width: '1.1em', fontWeight: '700' },
  '.cm-list-number': { color: '#7a828c' },
  '.cm-check': { width: '15px', height: '15px', margin: '0 7px 0 1px', verticalAlign: '-2px', accentColor: 'var(--blue, #0067c0)', cursor: 'pointer' },
  '.cm-task-done': { color: '#8b929b', textDecoration: 'line-through' },
  '.cm-inline-code': { backgroundColor: '#eff1f3', borderRadius: '4px', padding: '1px 4px' },
  '.cm-codeblock': { backgroundColor: '#f5f6f8', fontFamily: MONO, fontSize: '0.9em', padding: '0 14px !important' },
  '.cm-codeblock-first': { borderTopLeftRadius: '6px', borderTopRightRadius: '6px', paddingTop: '4px !important' },
  '.cm-codeblock-last': { borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px', paddingBottom: '4px !important' },
  '.cm-fence': { color: '#9aa1a9', fontSize: '0.8em' },
  '.cm-link': { color: 'var(--blue, #0067c0)', textDecoration: 'underline', textDecorationColor: 'rgba(0, 103, 192, 0.35)', textUnderlineOffset: '2px' },
  '.cm-link-live': { cursor: 'pointer' },
  '.cm-underline': { textDecoration: 'underline', textUnderlineOffset: '2px' },
  '.cm-hr': { display: 'inline-block', width: '100%', verticalAlign: 'middle', borderTop: '1px solid #d6d9dd' },
  '.cm-image': { display: 'block', maxWidth: '100%', maxHeight: '480px', margin: '6px 0', borderRadius: '6px' },
  '.cm-image-missing': { color: '#8b929b', fontStyle: 'italic' },
  '.cm-frontmatter': { fontFamily: MONO, fontSize: '0.85em', color: '#6b7280', backgroundColor: '#fafafa' },
  '.cm-frontmatter *': { color: 'inherit !important', textDecoration: 'none !important', fontWeight: 'inherit !important', fontStyle: 'normal !important' },
  '.cm-table': { display: 'block', overflowX: 'auto', margin: '4px 0' },
  '.cm-table table': { borderCollapse: 'collapse', fontSize: '0.95em' },
  '.cm-table th, .cm-table td': { border: '1px solid #dfe2e6', padding: '5px 12px', textAlign: 'left', verticalAlign: 'top' },
  '.cm-table th': { backgroundColor: '#f5f6f8', fontWeight: '650' },
  '.cm-table code': { fontFamily: MONO, fontSize: '0.92em', backgroundColor: '#eff1f3', borderRadius: '4px', padding: '1px 4px' },
  '.cm-table-src': { fontFamily: MONO, fontSize: '0.9em' },
});

/* ---------- Markdown as it reads ---------- */

const hidden = Decoration.replace({});
const lineClass = (name) => Decoration.line({ class: name });
const markClass = (name, attributes) => Decoration.mark({ class: name, attributes });

class Bullet extends WidgetType {
  eq() { return true; }
  toDOM() {
    const node = document.createElement('span');
    node.className = 'cm-bullet';
    node.textContent = '•';
    return node;
  }
}

class Check extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(other) { return other.checked === this.checked; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-check';
    box.checked = this.checked;
    box.addEventListener('mousedown', (event) => event.preventDefault());
    box.addEventListener('click', (event) => {
      event.preventDefault();
      if (view.state.readOnly) return;
      const at = view.posAtDOM(box);
      const text = view.state.sliceDoc(at, at + 3);
      if (!/^\[[ xX]\]$/.test(text)) return;
      view.dispatch({ changes: { from: at + 1, to: at + 2, insert: text[1] === ' ' ? 'x' : ' ' }, userEvent: 'input.check' });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

class Rule extends WidgetType {
  eq() { return true; }
  toDOM() {
    const node = document.createElement('span');
    node.className = 'cm-hr';
    return node;
  }
}

class Picture extends WidgetType {
  constructor(src, alt, url) { super(); this.src = src; this.alt = alt; this.url = url; }
  eq(other) { return other.src === this.src && other.alt === this.alt; }
  toDOM() {
    const image = document.createElement('img');
    image.className = 'cm-image';
    image.alt = this.alt;
    image.title = this.alt || this.src;
    image.addEventListener('error', () => {
      const note = document.createElement('span');
      note.className = 'cm-image-missing';
      note.textContent = `Picture not found: ${this.alt || this.src}`;
      image.replaceWith(note);
    }, { once: true });
    image.src = this.url;
    return image;
  }
}

// A few inline marks inside table cells, made as page parts (never as HTML text).
function inline(text) {
  const out = document.createDocumentFragment();
  const pattern = /(\*\*|__)(.+?)\1|(\*|_)([^*_]+?)\3|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|<u>(.+?)<\/u>/g;
  let last = 0;
  let found;
  while ((found = pattern.exec(text))) {
    if (found.index > last) out.append(text.slice(last, found.index));
    let node;
    if (found[2] !== undefined) { node = document.createElement('strong'); node.append(inline(found[2])); }
    else if (found[4] !== undefined) { node = document.createElement('em'); node.append(inline(found[4])); }
    else if (found[5] !== undefined) { node = document.createElement('s'); node.append(inline(found[5])); }
    else if (found[6] !== undefined) { node = document.createElement('code'); node.textContent = found[6]; }
    else if (found[7] !== undefined) { node = document.createElement('span'); node.className = 'cm-link cm-link-live'; node.dataset.href = found[8]; node.append(inline(found[7])); }
    else { node = document.createElement('u'); node.append(inline(found[9])); }
    out.append(node);
    last = pattern.lastIndex;
  }
  out.append(text.slice(last));
  return out;
}

function cells(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

class Table extends WidgetType {
  constructor(source) { super(); this.source = source; }
  eq(other) { return other.source === this.source; }
  toDOM(view) {
    const box = document.createElement('div');
    box.className = 'cm-table';
    const table = document.createElement('table');
    const lines = this.source.split('\n').filter((line) => line.trim());
    const align = (lines[1] ? cells(lines[1]) : []).map((cell) => {
      if (/^:-+:$/.test(cell)) return 'center';
      if (/^-+:$/.test(cell)) return 'right';
      return '';
    });
    lines.forEach((line, index) => {
      if (index === 1) return;
      const row = document.createElement('tr');
      cells(line).forEach((cell, column) => {
        const node = document.createElement(index === 0 ? 'th' : 'td');
        if (align[column]) node.style.textAlign = align[column];
        node.append(inline(cell));
        row.append(node);
      });
      table.append(row);
    });
    box.append(table);
    // A click goes into the table's text, to change it.
    box.addEventListener('mousedown', (event) => {
      if (event.target.closest('.cm-link-live')) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(box) } });
      view.focus();
    });
    return box;
  }
  ignoreEvent() { return true; }
}

const touches = (state, from, to) => state.selection.ranges.some((range) => range.from <= to && range.to >= from);
const lineTouched = (state, pos) => {
  const line = state.doc.lineAt(pos);
  return touches(state, line.from, line.to);
};

// The YAML block some notes start with (between --- lines) stays as it is, small and gray.
function frontmatterEnd(state) {
  if (state.doc.lines < 3 || state.doc.line(1).text !== '---') return 0;
  for (let number = 2; number <= Math.min(state.doc.lines, 200); number += 1) {
    const line = state.doc.line(number);
    if (line.text === '---' || line.text === '...') return line.to;
  }
  return 0;
}

function liveMarks(view, options) {
  const { state } = view;
  const focused = view.hasFocus;
  const near = (from, to) => focused && touches(state, from, to);
  const nearLine = (pos) => focused && lineTouched(state, pos);
  const found = [];
  const add = (from, to, deco) => { if (to >= from) found.push(deco.range(from, to)); };
  const addLine = (pos, name) => found.push(lineClass(name).range(state.doc.lineAt(pos).from));
  const front = frontmatterEnd(state);
  if (front) {
    for (let pos = 0; pos <= front;) {
      const line = state.doc.lineAt(pos);
      addLine(line.from, 'cm-frontmatter');
      pos = line.to + 1;
    }
  }
  const underlines = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.from < front) return node.to > front;
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name) || /^SetextHeading(\d)$/.exec(name);
        if (heading) {
          addLine(node.from, `cm-h${heading[1]}`);
          if (name.startsWith('ATX') && !nearLine(node.from)) {
            for (let mark = node.node.firstChild; mark; mark = mark.nextSibling) {
              if (mark.name !== 'HeaderMark') continue;
              const space = state.sliceDoc(mark.to, mark.to + 1) === ' ' ? 1 : 0;
              add(mark.from === node.from ? mark.from : mark.from - 1, mark.from === node.from ? mark.to + space : mark.to, hidden);
            }
          }
          return true;
        }
        switch (name) {
          case 'Emphasis':
          case 'StrongEmphasis':
          case 'Strikethrough':
          case 'InlineCode': {
            if (name === 'InlineCode') add(node.from, node.to, markClass('cm-inline-code'));
            if (!near(node.from, node.to)) {
              const markName = { Emphasis: 'EmphasisMark', StrongEmphasis: 'EmphasisMark', Strikethrough: 'StrikethroughMark', InlineCode: 'CodeMark' }[name];
              for (let mark = node.node.firstChild; mark; mark = mark.nextSibling) if (mark.name === markName) add(mark.from, mark.to, hidden);
            }
            return true;
          }
          case 'Link': {
            const marks = node.node.getChildren('LinkMark');
            const url = node.node.getChild('URL');
            if (marks.length < 2) return true;
            const textFrom = marks[0].to;
            const textTo = marks[1].from;
            const href = url ? state.sliceDoc(url.from, url.to) : '';
            const live = !near(node.from, node.to);
            add(textFrom, textTo, markClass(`cm-link${live ? ' cm-link-live' : ''}`, href ? { 'data-href': href } : undefined));
            if (live) {
              add(node.from, textFrom, hidden);
              add(textTo, node.to, hidden);
            }
            return true;
          }
          case 'Image': {
            if (near(node.from, node.to)) return false;
            const marks = node.node.getChildren('LinkMark');
            const url = node.node.getChild('URL');
            if (!url || marks.length < 2) return false;
            const src = state.sliceDoc(url.from, url.to).replace(/^<|>$/g, '');
            const alt = state.sliceDoc(marks[0].to, marks[1].from);
            add(node.from, node.to, Decoration.replace({ widget: new Picture(src, alt, options.imageUrl ? options.imageUrl(src) : src) }));
            return false;
          }
          case 'Autolink': {
            const url = node.node.getChild('URL');
            const live = !near(node.from, node.to);
            if (url) add(url.from, url.to, markClass(`cm-link${live ? ' cm-link-live' : ''}`, { 'data-href': state.sliceDoc(url.from, url.to) }));
            if (live) for (const mark of node.node.getChildren('LinkMark')) add(mark.from, mark.to, hidden);
            return false;
          }
          case 'URL': {
            const parent = node.node.parent?.name;
            if (parent === 'Link' || parent === 'Image' || parent === 'Autolink') return false;
            add(node.from, node.to, markClass('cm-link', { 'data-href': state.sliceDoc(node.from, node.to) }));
            return false;
          }
          case 'Blockquote': {
            for (let pos = node.from; pos <= node.to;) {
              const line = state.doc.lineAt(pos);
              addLine(line.from, 'cm-quote');
              pos = line.to + 1;
            }
            return true;
          }
          case 'QuoteMark': {
            if (!nearLine(node.from)) add(node.from, node.to + (state.sliceDoc(node.to, node.to + 1) === ' ' ? 1 : 0), hidden);
            return false;
          }
          case 'ListMark': {
            const item = node.node.parent;
            const list = item?.parent?.name;
            if (list === 'OrderedList') {
              add(node.from, node.to, markClass('cm-list-number'));
              return false;
            }
            if (nearLine(node.from)) return false;
            const task = item?.getChild('Task');
            const space = state.sliceDoc(node.to, node.to + 1) === ' ' ? 1 : 0;
            if (task) add(node.from, node.to + space, hidden);
            else add(node.from, node.to + space, Decoration.replace({ widget: new Bullet() }));
            return false;
          }
          case 'TaskMarker': {
            const text = state.sliceDoc(node.from, node.to);
            const done = /x/i.test(text);
            if (done) addLine(node.from, 'cm-task-done');
            if (!near(node.from, node.to)) add(node.from, node.to + (state.sliceDoc(node.to, node.to + 1) === ' ' ? 1 : 0), Decoration.replace({ widget: new Check(done) }));
            return false;
          }
          case 'HorizontalRule': {
            if (!nearLine(node.from)) add(node.from, node.to, Decoration.replace({ widget: new Rule() }));
            return false;
          }
          case 'FencedCode':
          case 'CodeBlock': {
            const first = state.doc.lineAt(node.from).number;
            const last = state.doc.lineAt(node.to).number;
            for (let number = first; number <= last; number += 1) {
              const line = state.doc.line(number);
              let names = 'cm-codeblock';
              if (number === first) names += ' cm-codeblock-first';
              if (number === last) names += ' cm-codeblock-last';
              if (name === 'FencedCode' && (number === first || (number === last && /^\s*(`{3,}|~{3,})\s*$/.test(line.text)))) names += ' cm-fence';
              found.push(lineClass(names).range(line.from));
            }
            return false;
          }
          case 'Table': {
            // Shown as its text while it's being changed. Otherwise tableField draws it.
            if (near(node.from, node.to)) {
              for (let pos = node.from; pos <= node.to;) {
                const line = state.doc.lineAt(pos);
                addLine(line.from, 'cm-table-src');
                pos = line.to + 1;
              }
            }
            return false;
          }
          case 'HTMLTag': {
            const text = state.sliceDoc(node.from, node.to).toLowerCase();
            if (text === '<u>' || text === '</u>') underlines.push({ from: node.from, to: node.to, open: text === '<u>' });
            return false;
          }
          default:
            return true;
        }
      },
    });
  }
  // <u>…</u>: underlined, with the tags out of sight unless you're in it.
  for (let index = 0; index < underlines.length - 1; index += 1) {
    const open = underlines[index];
    const close = underlines[index + 1];
    if (!open.open || close.open) continue;
    add(open.to, close.from, markClass('cm-underline'));
    if (!near(open.from, close.to)) {
      add(open.from, open.to, hidden);
      add(close.from, close.to, hidden);
    }
    index += 1;
  }
  return Decoration.set(found, true);
}

function livePlugin(options) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = liveMarks(view, options); }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged
        || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = liveMarks(update.view, options);
      }
    }
  }, {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const link = event.target.closest?.('.cm-link');
        if (!link || event.button !== 0) return false;
        const href = link.dataset.href || link.closest('[data-href]')?.dataset.href;
        if (!href) return false;
        // A drawn link opens with a click; one showing its text opens with Ctrl+click, as in Obsidian.
        if (link.classList.contains('cm-link-live') || event.ctrlKey || event.metaKey) {
          event.preventDefault();
          options.openLink?.(href);
          return true;
        }
        return false;
      },
    },
  });
}

// Tables are drawn as tables while you're not in them. That swaps whole lines, which only a
// field (not the plugin above) may do.
function tableMarks(state) {
  const found = [];
  const focused = state.field(focusField, false);
  if (state.doc.length > 2_000_000) return Decoration.none;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return !['FencedCode', 'CodeBlock', 'HTMLBlock'].includes(node.name);
      if (focused && touches(state, node.from, node.to)) return false;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      found.push(Decoration.replace({ widget: new Table(state.sliceDoc(from, to)), block: true }).range(from, to));
      return false;
    },
  });
  return Decoration.set(found, true);
}

const focusEffect = StateEffect.define();
const focusField = StateField.define({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(focusEffect)) return effect.value;
    return value;
  },
});

const tableField = StateField.define({
  create: (state) => tableMarks(state),
  update(marks, transaction) {
    const refocused = transaction.effects.some((effect) => effect.is(focusEffect));
    if (transaction.docChanged || transaction.selection || refocused) return tableMarks(transaction.state);
    return marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const focusTracking = [
  focusField,
  EditorView.focusChangeEffect.of((_state, focusing) => focusEffect.of(focusing)),
];

/* ---------- Formatting ---------- */

function wrapped(state, range, open, close) {
  const before = state.sliceDoc(range.from - open.length, range.from);
  const after = state.sliceDoc(range.to, range.to + close.length);
  if (before !== open || after !== close) return false;
  // *italic* around a **bold** word isn't italic.
  if (open === '*' && state.sliceDoc(range.from - 2, range.from) === '**' && state.sliceDoc(range.from - 3, range.from) !== '***') return false;
  return true;
}

function wrap(view, open, close = open) {
  const { state } = view;
  const change = state.changeByRange((range) => {
    if (wrapped(state, range, open, close)) {
      return {
        changes: [{ from: range.from - open.length, to: range.from }, { from: range.to, to: range.to + close.length }],
        range: EditorSelection.range(range.anchor - open.length, range.head - open.length),
      };
    }
    let { from, to } = range;
    if (range.empty) {
      const word = state.wordAt(range.head);
      if (word) ({ from, to } = word);
    }
    const text = state.sliceDoc(from, to);
    if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      return {
        changes: { from, to, insert: text.slice(open.length, text.length - close.length) },
        range: EditorSelection.range(from, to - open.length - close.length),
      };
    }
    if (from === to) return { changes: { from, insert: open + close }, range: EditorSelection.cursor(from + open.length) };
    return {
      changes: [{ from, insert: open }, { from: to, insert: close }],
      range: range.empty ? EditorSelection.cursor(range.head + open.length) : EditorSelection.range(from + open.length, to + open.length),
    };
  });
  view.dispatch(state.update(change, { scrollIntoView: true, userEvent: 'input.format' }));
  view.focus();
  return true;
}

function selectedLines(state) {
  const lines = [];
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to;) {
      const line = state.doc.lineAt(pos);
      if (!lines.some((seen) => seen.number === line.number)) lines.push(line);
      pos = line.to + 1;
    }
  }
  return lines;
}

const BLOCK_PREFIX = /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;

// kind: heading0..heading6, bullet, number, task, quote.
function setLines(view, kind) {
  const { state } = view;
  const lines = selectedLines(state);
  const is = {
    bullet: (text) => /^\s*[-*+]\s+(?!\[[ xX]\])/.test(text),
    number: (text) => /^\s*\d+[.)]\s+/.test(text),
    task: (text) => /^\s*[-*+]\s+\[[ xX]\]\s+/.test(text),
    quote: (text) => /^\s*>/.test(text),
  };
  const heading = /^heading(\d)$/.exec(kind);
  const undo = !heading && lines.every((line) => is[kind](line.text));
  let count = 0;
  const changes = lines.map((line) => {
    const [whole, indent, prefix = ''] = BLOCK_PREFIX.exec(line.text);
    let next;
    if (heading) {
      const level = Number(heading[1]);
      const keep = /^#{1,6}\s+$/.test(prefix) ? '' : prefix; // a heading line drops only its #s
      next = `${level ? `${'#'.repeat(level)} ` : ''}${keep}`;
      return { from: line.from + indent.length, to: line.from + whole.length, insert: next };
    }
    if (undo) next = kind === 'quote' ? prefix.replace(/^>\s?/, '') : '';
    else if (kind === 'bullet') next = '- ';
    else if (kind === 'number') { count += 1; next = `${count}. `; }
    else if (kind === 'task') next = '- [ ] ';
    else next = `> ${prefix}`;
    return { from: line.from + indent.length, to: line.from + whole.length, insert: next };
  });
  view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.format' });
  view.focus();
  return true;
}

function codeBlock(view) {
  const { state } = view;
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);
  if (range.empty && !first.text.trim()) {
    view.dispatch({ changes: { from: first.from, to: first.to, insert: '```\n\n```' }, selection: { anchor: first.from + 4 }, userEvent: 'input.format' });
  } else {
    view.dispatch({ changes: [{ from: first.from, insert: '```\n' }, { from: last.to, insert: '\n```' }], userEvent: 'input.format' });
  }
  view.focus();
  return true;
}

function link(view) {
  const { state } = view;
  const range = state.selection.main;
  const text = state.sliceDoc(range.from, range.to);
  if (/^(https?:\/\/|www\.)\S+$/.test(text)) {
    view.dispatch({ changes: { from: range.from, to: range.to, insert: `[](${text})` }, selection: { anchor: range.from + 1 }, userEvent: 'input.format' });
  } else {
    const insert = `[${text}](https://)`;
    const at = range.from + text.length + 3;
    view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: text ? { anchor: at, head: at + 8 } : { anchor: range.from + 1 }, userEvent: 'input.format' });
  }
  view.focus();
  return true;
}

function rule(view) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const insert = line.text.trim() ? '\n\n---\n' : '---\n';
  view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length }, userEvent: 'input.format' });
  view.focus();
  return true;
}

// A small table to fill in, with a blank line on each side (Markdown needs them): a header row and
// two empty rows. The first heading is picked, so typing replaces it.
function table(view) {
  const { doc } = view.state;
  const line = doc.lineAt(view.state.selection.main.head);
  const blank = !line.text.trim();
  const prev = line.number > 1 ? doc.line(line.number - 1) : null;
  const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
  const before = blank ? (prev && prev.text.trim() ? '\n' : '') : '\n\n';
  const after = next && next.text.trim() ? '\n' : '';
  const insert = `${before}| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |${after}`;
  const from = blank ? line.from : line.to;
  const start = from + before.length + 2;
  view.dispatch({ changes: { from, to: line.to, insert }, selection: { anchor: start, head: start + 8 }, userEvent: 'input.format' });
  view.focus();
  return true;
}

function toggleTask(view) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const found = /^(\s*[-*+]\s+\[)([ xX])\]/.exec(line.text);
  if (!found) return false;
  const at = line.from + found[1].length;
  view.dispatch({ changes: { from: at, to: at + 1, insert: found[2] === ' ' ? 'x' : ' ' }, userEvent: 'input.check' });
  return true;
}

const COMMANDS = {
  bold: (view) => wrap(view, '**'),
  italic: (view) => wrap(view, '*'),
  underline: (view) => wrap(view, '<u>', '</u>'),
  strike: (view) => wrap(view, '~~'),
  code: (view) => wrap(view, '`'),
  codeBlock,
  link,
  rule,
  table,
  bullet: (view) => setLines(view, 'bullet'),
  number: (view) => setLines(view, 'number'),
  task: (view) => setLines(view, 'task'),
  quote: (view) => setLines(view, 'quote'),
  heading0: (view) => setLines(view, 'heading0'),
  heading1: (view) => setLines(view, 'heading1'),
  heading2: (view) => setLines(view, 'heading2'),
  heading3: (view) => setLines(view, 'heading3'),
  heading4: (view) => setLines(view, 'heading4'),
};

// Which formats are on where the cursor is, so the toolbar can show them pressed.
function formatsAt(state) {
  const on = new Set();
  const head = state.selection.main.head;
  for (let node = syntaxTree(state).resolveInner(head, -1); node; node = node.parent) {
    if (node.name === 'StrongEmphasis') on.add('bold');
    else if (node.name === 'Emphasis') on.add('italic');
    else if (node.name === 'Strikethrough') on.add('strike');
    else if (node.name === 'InlineCode') on.add('code');
    else if (node.name === 'Link') on.add('link');
    else if (node.name === 'Blockquote') on.add('quote');
    else if (node.name === 'FencedCode') on.add('codeBlock');
    const heading = /^ATXHeading(\d)$/.exec(node.name);
    if (heading) on.add(`heading${heading[1]}`);
  }
  const line = state.doc.lineAt(head).text;
  if (/^\s*[-*+]\s+\[[ xX]\]/.test(line)) on.add('task');
  else if (/^\s*[-*+]\s+/.test(line)) on.add('bullet');
  else if (/^\s*\d+[.)]\s+/.test(line)) on.add('number');
  const before = state.sliceDoc(Math.max(0, head - 200), head).toLowerCase();
  if (before.lastIndexOf('<u>') > before.lastIndexOf('</u>')) on.add('underline');
  return on;
}

/* ---------- Making one ---------- */

// A line this long (a minified file, a data dump) can't be wrapped quickly: the page would stop for
// a second or more measuring it. Such a file opens with its lines unwrapped.
const LONG_LINE = 100000;
function hasLongLine(text) {
  for (let from = 0; from < text.length;) {
    const end = text.indexOf('\n', from);
    const stop = end < 0 ? text.length : end;
    if (stop - from > LONG_LINE) return true;
    from = stop + 1;
  }
  return false;
}

// kind: 'markdown', 'code' or 'text'. ext: the file's ending, for code colors.
function create({ parent, text = '', kind = 'text', ext = '', readOnly = false, crlf = false, onChange, onSave, onCursor, openLink, imageUrl }) {
  const editable = new Compartment();
  const livePart = new Compartment();
  const wrapPart = new Compartment();
  const lock = (on) => [EditorState.readOnly.of(on), EditorView.editable.of(!on)];
  const wrap = hasLongLine(text) ? [] : EditorView.lineWrapping;
  const extensions = [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    highlightSelectionMatches(),
    search({ top: true }),
    look,
    // The Find bar's words, as the rest of the app writes them.
    EditorState.phrases.of({
      next: 'Next', previous: 'Previous', all: 'All', 'match case': 'Match case', regexp: 'Pattern',
      'by word': 'Whole word', replace: 'Replace', 'replace all': 'Replace all', close: 'Close',
    }),
    editable.of(lock(readOnly)),
    Prec.highest(keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { onSave?.(); return true; } }])),
    keymap.of([...closeBracketsKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab, ...defaultKeymap]),
    syntaxHighlighting(codeColors),
    EditorView.updateListener.of((update) => {
      // A change from outside (setText below) isn't something to save.
      if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(Transaction.remote))) onChange?.(update);
      if (update.docChanged || update.selectionSet) onCursor?.(update);
    }),
  ];
  if (crlf) extensions.push(EditorState.lineSeparator.of('\r\n'));
  if (kind === 'markdown') {
    extensions.push(
      EditorView.editorAttributes.of({ class: 'cm-md' }),
      wrapPart.of(wrap),
      markdown({ base: markdownLanguage, codeLanguages: codeLanguage }),
      syntaxHighlighting(markdownColors),
      focusTracking,
      livePart.of([livePlugin({ openLink, imageUrl }), tableField]),
      Prec.high(keymap.of([
        { key: 'Mod-b', run: COMMANDS.bold },
        { key: 'Mod-i', run: COMMANDS.italic },
        { key: 'Mod-u', run: COMMANDS.underline },
        { key: 'Mod-Shift-x', run: COMMANDS.strike },
        { key: 'Mod-e', run: COMMANDS.code },
        { key: 'Mod-k', run: COMMANDS.link },
        { key: 'Mod-Enter', run: toggleTask },
      ])),
    );
  } else if (kind === 'code') {
    const language = languageFor(ext);
    extensions.push(
      EditorView.editorAttributes.of({ class: 'cm-code' }),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      foldGutter(),
      closeBrackets(),
      wrapPart.of([]),
      ...(language ? [language] : []),
    );
  } else {
    extensions.push(EditorView.editorAttributes.of({ class: 'cm-plain' }), wrapPart.of(wrap));
  }
  const view = new EditorView({ parent, state: EditorState.create({ doc: text, extensions }) });
  let liveOn = true;
  return {
    view,
    // sliceDoc joins lines with the file's own ending (CRLF), unlike doc.toString().
    getText: () => view.state.sliceDoc(),
    // The file changed outside (AI, or another program): its new text, keeping your place.
    setText(next) {
      const head = Math.min(view.state.selection.main.head, next.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        selection: { anchor: head },
        annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
      });
    },
    setReadOnly: (on) => view.dispatch({ effects: editable.reconfigure(lock(on)) }),
    // Markdown as it reads (true), or every mark showing (false).
    setLive(on) {
      if (kind !== 'markdown') return;
      liveOn = on;
      view.dispatch({ effects: livePart.reconfigure(on ? [livePlugin({ openLink, imageUrl }), tableField] : []) });
    },
    isLive: () => liveOn,
    setWrap: (on) => view.dispatch({ effects: wrapPart.reconfigure(on ? EditorView.lineWrapping : []) }),
    run(name) {
      const command = COMMANDS[name];
      return command ? command(view) : false;
    },
    formats: () => formatsAt(view.state),
    find: () => { view.focus(); openSearchPanel(view); },
    // Where the cursor is, and how many words, for the status bar.
    stats() {
      const { doc, selection } = view.state;
      const line = doc.lineAt(selection.main.head);
      const words = doc.length > 400000 ? null : (doc.toString().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
      const picked = selection.ranges.reduce((sum, range) => sum + (range.to - range.from), 0);
      return { line: line.number, column: selection.main.head - line.from + 1, lines: doc.lines, words, picked };
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

window.StationEditor = { create, languageFor: (ext) => Boolean(LANGUAGES[String(ext || '').toLowerCase()]) };
