// A snip of Station's own screen is recognised; a snip of anything else isn't (lib/snip-match.js).
// Run: node panel/test/snip-match.test.js
const assert = require('assert');
const { isPieceOf } = require('../lib/snip-match');

let seed = 7;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

// Something like a screen: bands of colour with lots of small dark marks (text) on them.
function screen(w, h, tag) {
  seed = tag;
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) { data[i * 4] = 240; data[i * 4 + 1] = 240; data[i * 4 + 2] = 240; data[i * 4 + 3] = 255; }
  const rect = (x, y, rw, rh, b, g, r) => {
    for (let yy = y; yy < Math.min(h, y + rh); yy += 1) for (let xx = x; xx < Math.min(w, x + rw); xx += 1) { const p = (yy * w + xx) * 4; data[p] = b; data[p + 1] = g; data[p + 2] = r; }
  };
  for (let n = 0; n < 40; n += 1) rect(Math.floor(random() * w), Math.floor(random() * h), 40 + Math.floor(random() * 200), 20 + Math.floor(random() * 80), Math.floor(random() * 255), Math.floor(random() * 255), Math.floor(random() * 255));
  for (let n = 0; n < 1500; n += 1) rect(Math.floor(random() * w), Math.floor(random() * h), 2 + Math.floor(random() * 6), 6 + Math.floor(random() * 4), 30, 30, 30);
  return { w, h, data };
}

const crop = (bitmap, x, y, w, h) => {
  const data = Buffer.alloc(w * h * 4);
  for (let yy = 0; yy < h; yy += 1) bitmap.data.copy(data, yy * w * 4, ((y + yy) * bitmap.w + x) * 4, ((y + yy) * bitmap.w + x + w) * 4);
  return { w, h, data };
};

// As Windows stretches it: bilinear, with a little noise.
function stretch(bitmap, scale, noise = 0) {
  const w = Math.round(bitmap.w * scale);
  const h = Math.round(bitmap.h * scale);
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(bitmap.w - 1.001, x / scale);
      const sy = Math.min(bitmap.h - 1.001, y / scale);
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let c = 0; c < 3; c += 1) {
        const at = (xx, yy) => bitmap.data[(yy * bitmap.w + xx) * 4 + c];
        const value = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
        data[(y * w + x) * 4 + c] = Math.max(0, Math.min(255, value + (noise ? (random() - 0.5) * noise : 0)));
      }
      data[(y * w + x) * 4 + 3] = 255;
    }
  }
  return { w, h, data };
}

const station = screen(640, 400, 11);
const other = screen(640, 400, 99);

assert.ok(isPieceOf(crop(station, 130, 90, 260, 170), [station]), 'a piece of Station, as it is');
assert.ok(!isPieceOf(stretch(crop(station, 130, 90, 260, 170), 1.25, 4), [station]), 'a stretched piece is refused (the safe way to fail)');
assert.ok(isPieceOf(crop(station, 10, 10, 200, 150), [station]), 'a piece of Station, not stretched');
assert.ok(isPieceOf(crop(station, 300, 200, 340, 200), [other, station]), 'found in the second of two windows, at the edge');
assert.ok(!isPieceOf(crop(other, 130, 90, 260, 170), [station]), 'a piece of something else is not Station');
assert.ok(!isPieceOf(crop(station, 5, 5, 10, 10), [station]), 'a speck is never taken for Station');
assert.ok(!isPieceOf(crop(station, 130, 90, 260, 170), []), 'with no window to look at, nothing is Station');
console.log('PASS snip-match: 6 checks');
