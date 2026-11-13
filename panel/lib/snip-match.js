// Is a picture copied in Windows (a screen snip) a piece of Station 256's own screen?
//
// Lock keeps what is copied in Windows out of Station. A snip of Station itself isn't from Windows
// in any way that matters (it shows only what Station already shows), so it may come in. Windows
// says nothing about where a snip came from, so Station looks: it takes a picture of its own
// windows when the snip is made and checks whether the snip is a piece of one of them. Windows
// shows Station at the size Station draws it (measured on the real screen: a snip of Station
// matched Station's own picture with a difference of 0.0, and a snip of another app scored 54), so
// only that size counts. If Windows ever stretches it, snips of Station fall back to being refused
// with a note: the safe way to fail. Both are made soft first (grey, and shrunk).
//
// A bitmap here is { w, h, data } with data in B, G, R, A order, as Electron's toBitmap() gives.

const MIN_SIDE = 24; // a snip smaller than this is never taken for Station's
const SHRINK = 2; // both pictures are made this much smaller before they are compared
const POINTS = 700; // how many spots of the snip are compared
const MAX_MEAN = 4; // how far apart (0-255) the grey of a spot may be, on average (a real match is 0, anything else 30+)
const SCALES = [1]; // how much bigger Windows draws Station than Station draws itself

function grey(bitmap) {
  const out = new Float32Array(bitmap.w * bitmap.h);
  const { data } = bitmap;
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) out[i] = 0.114 * data[p] + 0.587 * data[p + 1] + 0.299 * data[p + 2];
  return { w: bitmap.w, h: bitmap.h, g: out };
}

// Shrunk by averaging, so a soft picture stays soft rather than jagged.
function shrink(image, ratio) {
  const w = Math.max(1, Math.floor(image.w / ratio));
  const h = Math.max(1, Math.floor(image.h / ratio));
  const sums = new Float64Array((image.w + 1) * (image.h + 1));
  for (let y = 0; y < image.h; y += 1) {
    let row = 0;
    for (let x = 0; x < image.w; x += 1) {
      row += image.g[y * image.w + x];
      sums[(y + 1) * (image.w + 1) + x + 1] = sums[y * (image.w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.min(image.h - 1, Math.round(y * ratio));
    const y1 = Math.min(image.h, Math.max(y0 + 1, Math.round((y + 1) * ratio)));
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.min(image.w - 1, Math.round(x * ratio));
      const x1 = Math.min(image.w, Math.max(x0 + 1, Math.round((x + 1) * ratio)));
      const total = sums[y1 * (image.w + 1) + x1] - sums[y0 * (image.w + 1) + x1] - sums[y1 * (image.w + 1) + x0] + sums[y0 * (image.w + 1) + x0];
      out[y * w + x] = total / ((x1 - x0) * (y1 - y0));
    }
  }
  return { w, h, g: out };
}

// The spots worth comparing: where the picture changes most (flat spots match anything).
function spots(piece) {
  const found = [];
  const stride = Math.max(1, Math.floor(Math.sqrt((piece.w * piece.h) / (POINTS * 3))));
  for (let y = 1; y < piece.h - 1; y += stride) {
    for (let x = 1; x < piece.w - 1; x += stride) {
      const i = y * piece.w + x;
      found.push([Math.abs(piece.g[i + 1] - piece.g[i - 1]) + Math.abs(piece.g[i + piece.w] - piece.g[i - piece.w]), i]);
    }
  }
  found.sort((a, b) => b[0] - a[0]);
  return found.slice(0, POINTS).filter(([change], index) => change > 8 || index < 40).map(([, i]) => [i % piece.w, Math.floor(i / piece.w)]);
}

// The best (lowest) average difference of the piece against the picture, wherever it sits in it.
function bestFit(piece, whole) {
  if (piece.w > whole.w || piece.h > whole.h) return Infinity;
  const marks = spots(piece);
  if (marks.length < 12) return Infinity;
  const wants = marks.map(([x, y]) => piece.g[y * piece.w + x]);
  const offsets = marks.map(([x, y]) => y * whole.w + x);
  let best = Infinity;
  for (let oy = 0; oy <= whole.h - piece.h; oy += 1) {
    for (let ox = 0; ox <= whole.w - piece.w; ox += 1) {
      const base = oy * whole.w + ox;
      const limit = best * marks.length;
      let sum = 0;
      let k = 0;
      for (; k < marks.length; k += 1) {
        sum += Math.abs(wants[k] - whole.g[base + offsets[k]]);
        if (sum >= limit) break;
      }
      if (k === marks.length) best = sum / marks.length;
    }
  }
  return best;
}

// snip and each of shots are bitmaps; true when the snip is a piece of one of the shots.
function isPieceOf(snip, shots, scales = SCALES) {
  if (!snip || snip.w < MIN_SIDE || snip.h < MIN_SIDE) return false;
  const snipGrey = grey(snip);
  for (const shot of shots) {
    if (!shot || shot.w < MIN_SIDE) continue;
    const whole = shrink(grey(shot), SHRINK);
    for (const scale of scales) {
      if (snipGrey.w / scale < MIN_SIDE || snipGrey.h / scale < MIN_SIDE) continue;
      if (bestFit(shrink(snipGrey, scale * SHRINK), whole) <= MAX_MEAN) return true;
    }
  }
  return false;
}

module.exports = { isPieceOf, bestFit, grey, shrink, SCALES };
