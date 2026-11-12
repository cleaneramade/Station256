// A photo's details (when it was taken, the camera, where) sit in a part of the JPEG called Exif.
// A picture saved from the editor is drawn fresh and has none, so the original's part is put into
// the new file. The pixels are already turned the way the camera said, so its "which way up" is
// set to plain. Anything odd about the part, and the picture is saved without it.
const fs = require('fs/promises');

const HEAD_BYTES = 256 * 1024; // Exif sits at the front, and one part is 64 KB at most

// The Exif part, marker and all, from the front of a JPEG. Null when there's none.
function exifPart(head) {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= head.length && head[at] === 0xff) {
    const marker = head[at + 1];
    if (marker === 0xda || marker === 0xd9) return null; // the picture itself starts here
    const length = head.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > head.length) return null;
    if (marker === 0xe1 && length >= 16 && head.toString('latin1', at + 4, at + 10) === 'Exif\0\0') {
      return Buffer.from(head.subarray(at, at + 2 + length)); // a copy: it gets changed below
    }
    at += 2 + length;
  }
  return null;
}

// Sets "which way up" (tag 0x0112) to 1, plain. False when the part isn't laid out as it should be.
// Reading past its end throws, which the caller takes as odd too.
function upright(part) {
  const tiff = part.subarray(10); // after the marker, its length and "Exif\0\0"
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return false;
  const little = order === 'II';
  const short = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const long = (at) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (short(2) !== 42) return false;
  const list = long(4);
  const count = short(list);
  for (let index = 0; index < count; index += 1) {
    const entry = list + 2 + index * 12;
    if (short(entry) !== 0x0112) continue;
    if (short(entry + 2) !== 3 || long(entry + 4) !== 1) return false;
    if (little) tiff.writeUInt16LE(1, entry + 8);
    else tiff.writeUInt16BE(1, entry + 8);
  }
  return true;
}

// made: the new JPEG. Gives it back with the original's details in it, or as it was.
async function keepDetails(original, made) {
  try {
    if (made[0] !== 0xff || made[1] !== 0xd8) return made;
    const handle = await fs.open(original, 'r');
    let head;
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const part = exifPart(head);
    if (!part || !upright(part)) return made;
    // After the new file's own first part (JFIF) when it has one, where programs look for it.
    const at = made[2] === 0xff && made[3] === 0xe0 ? 4 + made.readUInt16BE(4) : 2;
    return Buffer.concat([made.subarray(0, at), part, made.subarray(at)]);
  } catch {
    return made;
  }
}

module.exports = { keepDetails };
