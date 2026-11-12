// Builds the editor into one file the page loads: renderer/vendor/editor.js.
// Run `npm install` once here, then `npm run build` after changing src/editor.js.
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(here, 'src', 'editor.js')],
  outfile: path.join(here, '..', 'renderer', 'vendor', 'editor.js'),
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'chrome130',
  legalComments: 'eof',
  logLevel: 'warning',
  banner: { js: '/* Station 256 editor: CodeMirror 6 (MIT) and its language packages (MIT). Source: panel/editor. */' },
});
console.log('built renderer/vendor/editor.js');
