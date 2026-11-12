// Holds Station 256's own words to two lines: every pop-up message, hover text and note at the
// bottom, as written in the code. Run: node panel/test/text-length.js. It exits 1 if any is too long.
// Names and other text filled in while the app runs are fitted by fitLines in renderer/tooltip.js,
// with the same numbers, so they can't go past two lines either.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RENDERER = path.join(__dirname, '..', 'renderer');

// The app's own fitting, taken from tooltip.js, so the two can't drift apart.
const shared = {};
const tooltipCode = fs.readFileSync(path.join(RENDERER, 'tooltip.js'), 'utf8').split('(function tooltips()')[0];
vm.runInNewContext(`${tooltipCode}; this.FIT = FIT; this.fitLines = fitLines;`, shared);
const { FIT, fitLines } = shared;

// Text filled in while the app runs counts as this many characters, or as the cap shortName gives it.
const filledIn = (expression) => 'x'.repeat(Number((expression.match(/shortName\([^,]+,\s*(\d+)/) || [])[1]) || 12);

const ESCAPES = { n: '\n', t: '\t', r: '', '\\': '\\', "'": "'", '"': '"', '`': '`', $: '$', '\n': '' };

// Finds every string and template in a script, with the code of its statement up to it.
function literals(src) {
  const found = [];
  let i = 0;
  let statement = 0;
  const lineOf = (at) => src.slice(0, at).split('\n').length;
  const escape = () => {
    const next = src[i + 1];
    i += 2;
    return next in ESCAPES ? ESCAPES[next] : next;
  };
  const add = (at, value) => found.push({ value, line: lineOf(at), context: src.slice(statement, at) });
  // A "/" starts a regular expression unless it follows something a division could follow.
  const regexHere = () => {
    const before = src.slice(Math.max(0, i - 40), i).trimEnd();
    if (/\b(return|typeof|case|in|of|void|delete|throw|else|do)$/.test(before)) return true;
    return !/[\w$)\]'"`]$/.test(before);
  };
  function quoted(quote) {
    const at = i;
    let value = '';
    i += 1;
    while (i < src.length && src[i] !== quote) value += src[i] === '\\' ? escape() : src[i++];
    i += 1;
    add(at, value);
  }
  function template() {
    const at = i;
    let value = '';
    i += 1;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') value += escape();
      else if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        const start = i;
        code('}');
        value += filledIn(src.slice(start, i - 1));
      } else value += src[i++];
    }
    i += 1;
    add(at, value);
  }
  function code(until) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) i = src.length; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
      if (c === "'" || c === '"') { quoted(c); continue; }
      if (c === '`') { template(); continue; }
      if (c === '/' && regexHere()) {
        i += 1;
        let inClass = false;
        while (i < src.length && (inClass || src[i] !== '/')) {
          if (src[i] === '\\') i += 1;
          else if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          i += 1;
        }
        i += 1;
        continue;
      }
      if (c === '{' || c === '(' || c === '[') depth += 1;
      if (c === '}' || c === ')' || c === ']') {
        if (depth === 0 && c === until) { i += 1; return; }
        depth -= 1;
      }
      if (c === ';' || c === '{' || c === '}') statement = i + 1;
      i += 1;
    }
  }
  code(null);
  return found;
}

// Where a text goes decides how wide its two lines are.
function kind({ value, context }) {
  if (/\b(confirmBox|alertBox|promptBox|dialogFrame)\s*\(/.test(context)) return 'dialog';
  if (/\btoast\s*\(/.test(context)) return 'toast';
  if (/(\.title\s*=|\btitle\s*:|\btip\s*[:=]|dataset\.tip\s*=)/.test(context)) return 'tip';
  // Anything else that reads like a sentence is held to the pop-up's width.
  if (/^[A-Z0-9x"…]/.test(value) && /[a-z]{2,} [a-z]{2,}/i.test(value)) return 'dialog';
  return null;
}

const problems = [];
let checked = 0;
const check = (file, line, where, value) => {
  checked += 1;
  if (fitLines(value, FIT[where]) !== value) problems.push(`${file}:${line} ${where} (${FIT[where]} a line): ${JSON.stringify(value)}`);
};

for (const file of ['app.js', 'term.js', 'tooltip.js', 'window-motion.js']) {
  const src = fs.readFileSync(path.join(RENDERER, file), 'utf8');
  for (const item of literals(src)) {
    const where = kind(item);
    if (where) check(file, item.line, where, item.value);
  }
}
// Hover text written straight into the pages.
for (const file of ['index.html']) {
  const src = fs.readFileSync(path.join(RENDERER, file), 'utf8');
  for (const match of src.matchAll(/\btitle="([^"]*)"/g)) {
    check(file, src.slice(0, match.index).split('\n').length, 'tip', match[1].replaceAll('&amp;', '&'));
  }
}

problems.forEach((problem) => console.log(`FAIL ${problem}`));
console.log(`${problems.length ? 'FAIL' : 'PASS'} texts checked: ${checked}, longer than two lines: ${problems.length}`);
process.exit(problems.length ? 1 : 0);
