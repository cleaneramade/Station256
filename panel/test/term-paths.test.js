// Checks for lib/term-paths.js. Run with: node panel/test/term-paths.test.js
const assert = require('assert');
const { toHouse } = require('../lib/term-paths');

const ctx = { home: '/home/alex', base: '/home/alex/projects/Bot Builder', door: '/mnt/windows-door' };
const cases = [
  ['/workspace', ctx.base],
  ['/workspace/src/a.js', `${ctx.base}/src/a.js`],
  ['/workspace/src/a.js:12:3', `${ctx.base}/src/a.js`],
  ['"/workspace/x/"', `${ctx.base}/x`],
  ['/home/dev/Downloads/a.png', '/home/alex/Downloads/a.png'],
  ['/home/dev/Secret/a', null],
  ['/home/alex/house/panel', '/home/alex/house/panel'],
  ['/home/someone/x', null],
  ['~/Documents', '/home/alex/Documents'],
  ['~', '/home/alex'],
  ['L:\\home\\alex\\x', '/home/alex/x'],
  ['L:/home/alex/x', '/home/alex/x'],
  ['L:\\', '/'],
  ['\\\\wsl.localhost\\Ubuntu\\home\\alex\\x', '/home/alex/x'],
  ['\\\\wsl$\\Ubuntu\\tmp', '/tmp'],
  ['C:\\Users\\me\\a.txt', '/mnt/windows-door/Users/me/a.txt'],
  ['/workspace/../etc', null],
  ['/workspace/a/../../x', null],
  ['~/../x', null],
  ['L:\\home\\..\\etc', null],
  ['hello', null],
];
for (const [input, want] of cases) {
  assert.strictEqual(toHouse(input, ctx), want, input);
  console.log(`PASS ${input}`);
}
assert.strictEqual(toHouse('C:\\Users', { ...ctx, door: null }), null);
console.log('PASS C: refused when locked');
assert.strictEqual(toHouse('/workspace/a', { ...ctx, base: null }), null);
console.log('PASS /workspace refused outside a room');
