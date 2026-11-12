// Checks for lib/pasted-image.js: a picture copied in Windows saved for a house terminal, and for
// a room terminal (with a stand-in for docker that runs the room's part right here).
// Run with: node panel/test/pasted-image.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pasted = require('../lib/pasted-image');

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('picture')]);
const when = new Date(2026, 10, 8, 19, 45, 12);
let passed = 0;
const check = async (name, test) => {
  await test();
  passed += 1;
  console.log(`ok - ${name}`);
};

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pasted-image-'));
  try {
    await check('names', () => {
      assert.strictEqual(pasted.terminalName(when), 'pasted-image-2026-11-08-194512');
      assert.strictEqual(pasted.folderName(when), 'Pasted image 2026-11-08 194512.png');
    });

    const folder = path.join(scratch, 'house', 'pastes');
    await check('house: saved, only yours, path has no spaces', () => {
      const file = pasted.saveInHouse(png, when, folder);
      assert.strictEqual(file, path.join(folder, 'pasted-image-2026-11-08-194512.png'));
      assert.ok(fs.readFileSync(file).equals(png));
      assert.strictEqual(fs.statSync(folder).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      assert.ok(!/\s/.test(file));
    });

    await check('house: a second paste in the same second gets its own file', () => {
      const file = pasted.saveInHouse(png, when, folder);
      assert.strictEqual(path.basename(file), 'pasted-image-2026-11-08-194512-2.png');
    });

    await check('house: pictures older than a week go, others stay', () => {
      const old = path.join(folder, 'pasted-image-2026-10-01-000000.png');
      const other = path.join(folder, 'notes.txt');
      fs.writeFileSync(old, png);
      fs.writeFileSync(other, 'keep');
      const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(old, longAgo, longAgo);
      fs.utimesSync(other, longAgo, longAgo);
      pasted.saveInHouse(png, new Date(), folder);
      assert.ok(!fs.existsSync(old));
      assert.ok(fs.existsSync(other));
      assert.ok(fs.existsSync(path.join(folder, 'pasted-image-2026-11-08-194512.png')));
    });

    // Runs "sh -c <script> sh <name>" here instead of in a room, and says which room it was for.
    const fakeDocker = path.join(scratch, 'docker');
    fs.writeFileSync(fakeDocker, `#!/bin/sh\necho "$3" > "${scratch}/room-used"\n[ "$1 $2" = "exec -i" ] || exit 9\nshift 3\nexec "$@"\n`, { mode: 0o755 });
    let roomFile = null;
    await check('room: saved inside the room and its path given back', async () => {
      roomFile = await pasted.saveInRoom('My App', png, when, fakeDocker);
      assert.ok(roomFile.startsWith(`${pasted.ROOM_FOLDER}/pasted-image-2026-11-08-194512`), roomFile);
      assert.ok(fs.readFileSync(roomFile).equals(png));
      assert.strictEqual(fs.readFileSync(path.join(scratch, 'room-used'), 'utf8').trim(), 'room-My.App');
    });

    await check('room: a name that isn\'t a project is refused', async () => {
      await assert.rejects(pasted.saveInRoom('../x', png, when, fakeDocker));
      await assert.rejects(pasted.saveInRoom('a;b', png, when, fakeDocker));
    });

    await check('room: a room that\'s gone says so', async () => {
      const failing = path.join(scratch, 'docker-fails');
      fs.writeFileSync(failing, '#!/bin/sh\ncat > /dev/null\necho "No such container" >&2\nexit 1\n', { mode: 0o755 });
      await assert.rejects(pasted.saveInRoom('My App', png, when, failing), /couldn't be put in the room/);
    });

    if (roomFile) fs.rmSync(roomFile, { force: true });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`\n${passed} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
