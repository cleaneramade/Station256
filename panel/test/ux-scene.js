// The audit's four smaller changes, in the hidden copy:
//   SHOT_PATH=$PWD/panel/test/stub SHOT_HOME=/tmp/house-shots-ux panel/test/shotrun.sh uxIdeas
// Insert table in a Markdown page; a .gguf model opened from Files picks it in Local AI; closing the
// Local AI tab unloads the model (the stub llama-server); search starts with every folder inside.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

module.exports = {
  async uxIdeas({ page, shot, sleep }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} uxIdeas: ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`);
    const home = os.homedir();
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    const until = async (code, ms = 8000) => {
      for (let waited = 0; waited < ms; waited += 100) {
        if (await page(code)) return true;
        await sleep(100);
      }
      return false;
    };
    const running = () => new Promise((done) => { execFile('pgrep', ['-f', 'stub/llama-server'], (_error, out) => done(String(out || '').trim().split('\n').filter(Boolean).length)); });
    try {
      // Search starts with every folder inside (nothing saved yet in this home).
      await page(`(() => { navigate(state.projects); return true; })()`);
      await sleep(600);
      const placeholder = await page(`document.getElementById('search').placeholder`);
      report(/folders inside/.test(placeholder), `search starts with every folder inside: "${placeholder}"`);

      // Insert table.
      const note = path.join(home, 'projects', 'SampleApp', 'notes.md');
      fs.writeFileSync(note, '# Notes\n\nSome words.');
      await page(`openDoc(${JSON.stringify(note)}).then(() => true)`);
      await until(`!!state.active?.editor`);
      await page(`(() => { const t = state.active; t.editor.focus(); return true; })()`);
      const clicked = await page(`(() => { const b = [...state.active.host.querySelectorAll('.doc-tool')].find((x) => x.querySelector('[data-i="table"]')); if (!b) return false; b.click(); return true; })()`);
      await sleep(300);
      const chosen = await page(`state.active.editor.stats().picked`);
      await sleep(1500); // the page saves by itself
      const saved = fs.readFileSync(note, 'utf8');
      report(clicked && saved === '# Notes\n\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n\nSome words.', `Insert table adds a table after the cursor's line, keeps the words there, and saves: ${JSON.stringify(saved)}`);
      report(chosen === 8, `the first heading is picked, so typing replaces it: ${chosen} letters picked`);
      await shot('ux-insert-table');
      await page(`houseTest.closeTab(state.active)`);

      // A model in Files: right-click offers it, double-click picks it in Local AI.
      const models = path.join(home, 'Downloads');
      const model = path.join(models, 'my-model.gguf');
      fs.writeFileSync(model, Buffer.alloc(2 * 1024 * 1024));
      await page(`(() => { navigate(${JSON.stringify(models)}); return true; })()`);
      await until(`[...document.querySelectorAll('#rows .row')].some((r) => r.textContent.includes('my-model.gguf'))`);
      const menu = await page(`(() => { const e = state.entries.find((x) => x.name === 'my-model.gguf'); entryMenu(e, 200, 200); const labels = [...document.querySelectorAll('.menu-item')].map((b) => b.textContent.trim()); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return labels; })()`);
      report(menu.some((label) => /Load in Local AI/.test(label)), `right-click on a model offers Load in Local AI: ${JSON.stringify(menu.slice(4, 9))}`);
      await page(`(() => { openEntry(state.entries.find((x) => x.name === 'my-model.gguf')); return true; })()`);
      const picked = await until(`state.active?.kind === 'llama' && document.querySelector('.llama-select')?.value === ${JSON.stringify(model)}`);
      report(picked, `opening a model shows Local AI with it picked: ${await page(`document.querySelector('.llama-select')?.value`)}`);
      report(await page(`!document.querySelector('.llama-view .btn.primary').disabled`), 'and Load model is ready to press');

      // Closing the tab unloads the model.
      await page(`(() => { [...document.querySelectorAll('.llama-view .btn')].find((x) => x.textContent === 'Load model').click(); return true; })()`);
      const ready = await until(`document.querySelector('.llama-status').textContent === 'Ready'`, 15000);
      report(ready && await running() === 1, `the model loads (the stand-in server): ${await page(`document.querySelector('.llama-status').textContent`)}`);
      report(/close this tab/.test(await page(`[...document.querySelectorAll('.llama-note')].map((n) => n.textContent).join(' ')`)), 'the page says closing the tab unloads it');
      await page(`houseTest.closeTab(state.tabs.find((t) => t.kind === 'llama'))`);
      let left = 1;
      for (let waited = 0; waited < 8000 && left; waited += 200) {
        await sleep(200);
        left = await running();
      }
      const told = await page(`document.querySelector('.toast-text')?.textContent || ''`);
      report(left === 0 && /unloaded/.test(told), `closing Local AI unloads the model: servers left ${left}, note "${told}"`);
    } catch (error) {
      report(false, `the scene stopped: ${error.stack}`);
    }
  },
  // Hover text only where it helps (tooltip.js tipFor): icon-only controls, cut-off text, and tips that add a fact.
  async tips({ page, sleep }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} tips: ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`);
    const home = os.homedir();
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    try {
      const folder = path.join(home, 'projects', 'SampleApp', 'tipsdir');
      const longName = `${'a very long file name '.repeat(9).trim().replace(/ /g, '-')}.txt`;
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'short.txt'), 'x');
      fs.writeFileSync(path.join(folder, longName), 'x');
      const day = new Date().toISOString().slice(0, 10);
      const stand = { sources: { house: { dirty: false, files: { '/stand-in.jsonl': { offset: 1, ids: [], days: { [day]: [1000000, 2000] } } } } } };
      fs.mkdirSync(path.join(home, '.local', 'state', 'house'), { recursive: true });
      fs.writeFileSync(path.join(home, '.local', 'state', 'house', 'token-counts.json'), JSON.stringify(stand));
      // Per page: how many elements carry hover text, and how many of them will show it.
      const count = `(() => { const all = [...document.querySelectorAll('[data-tip]')].filter((n) => n.getClientRects().length && !n.matches('.name-text')); return [all.length, all.filter((n) => tipFor(n)).length]; })()`;

      await page(`(() => { houseTest.navigate('home:'); return true; })()`);
      await sleep(4000);
      const [homeAll, homeShown] = await page(count);
      console.log(`INFO tips on Home: ${homeAll} elements had hover text, now ${homeShown}`);
      const tiles = await page(`[...document.querySelectorAll('.home-tile')].map((t) => [t.querySelector('.home-tile-label').textContent, tipFor(t)])`);
      const input = tiles.find(([label]) => /Input/.test(label));
      report(/All time/.test(input?.[1] || ''), `the Input Tokens tile keeps its All time line: ${JSON.stringify(input)}`);
      const streak = tiles.find(([label]) => /Streak/.test(label));
      report(streak?.[1] === null, `a tile with a one-line explanation shows none: ${JSON.stringify(streak)}`);
      console.log(`INFO shown on Home: ${JSON.stringify(await page(`[...document.querySelectorAll('[data-tip]')].filter((n) => n.getClientRects().length && tipFor(n)).map((n) => n.id || n.className || n.tagName)`))}`);
      report(await page(`[...document.querySelectorAll('.home-section-title, .home-tile-label, .home-tile-note')].every((n) => !n.dataset.tip)`), 'headings and tile labels carry no hover text');

      await page(`(() => { houseTest.navigate(${JSON.stringify(folder)}); return true; })()`);
      await sleep(1500);
      await page(`(() => { const c = document.getElementById('view-details'); if (c) c.click(); return true; })()`);
      await sleep(500);
      const [folderAll, folderShown] = await page(count);
      console.log(`INFO tips in a folder (details view): ${folderAll} elements had hover text, now ${folderShown}`);
      const names = await page(`Object.fromEntries([...document.querySelectorAll('#rows .name-text')].map((n) => [n.textContent, tipFor(n)]))`);
      report(names['short.txt'] === null, `a file name that fits shows no hover text: ${JSON.stringify(names['short.txt'])}`);
      report(names[longName] === longName, `a cut-off file name shows its full name: ${JSON.stringify(names[longName])}`);
      const back = await page(`tipFor(document.getElementById('back'))`);
      report(back === 'Back', `an icon-only toolbar button keeps its hover text: ${JSON.stringify(back)}`);
      const labeled = await page(`[tipFor(document.getElementById('view-btn')), document.getElementById('view-btn').getAttribute('aria-label')]`);
      report(labeled[0] === null, `a button with a fitting label and a plain tip shows none: ${JSON.stringify(labeled)}`);
      report(await page(`tipFor(document.getElementById('cut')) === 'Cut (Ctrl+X)' && document.getElementById('cut').getAttribute('aria-label') === 'Cut (Ctrl+X)'`), 'screen-reader labels stay');
    } catch (error) {
      report(false, `the scene stopped: ${error.stack}`);
    }
  },
};
