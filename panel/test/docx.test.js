// Plain node check of lib/docx.py on a tiny made-up Word file, plus a broken one and a refused one.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const docx = require('../lib/docx');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-test-'));
  try {
    const file = path.join(dir, 'tiny.docx');
    execFileSync('python3', [path.join(__dirname, 'docx-fixture.py'), file]);
    const { blocks } = await docx.read(file);
    const [heading, para, bullet, table, picture] = blocks;
    assert.strictEqual(heading.level, 2);
    assert.strictEqual(heading.runs[0].x, 'Fixture Heading');
    assert.ok(para.runs.some((r) => r.x === 'BoldWord' && r.b) && !para.runs[0].b);
    assert.strictEqual(bullet.list, '•');
    assert.deepStrictEqual(table.rows.map((row) => row.map((c) => c[0].runs[0].x)), [['A1', 'B1'], ['A2', 'B2']]);
    assert.ok(picture.runs[0].img.startsWith('data:image/png;base64,') && picture.runs[0].w === 10);
    const bad = path.join(dir, 'bad.docx');
    fs.writeFileSync(bad, 'not a zip');
    await assert.rejects(docx.read(bad), /isn't a Word document/);
    const odd = path.join(dir, 'odd.docx');
    execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1],"w").writestr("word/document.xml","<!DOCTYPE x [<!ENTITY a \\"b\\">]><x/>")', odd]);
    await assert.rejects(docx.read(odd), /something odd/);
    console.log('PASS docx: heading, bold, bullet, table, picture, and two bad files refused');
  } catch (error) {
    console.log(`FAIL docx: ${error.message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
