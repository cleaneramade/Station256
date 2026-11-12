// Local AI with real models and the real llama-server, not the stand-in. Each model in SHOT_MODELS
// (a folder of .gguf files, smallest first) is opened from Files, loaded, asked one short question,
// and unloaded; the house must keep at least 2 GB of memory free while it's loaded. Then closing the
// tab must unload too. Run it on its own, with nothing else heavy running:
//   SHOT_MODELS=~/models SHOT_LLAMA=$(readlink -f ~/.local/bin/llama-server) SHOT_HOME=/tmp/house-shots-llamareal \
//     SHOT_TIMEOUT=900 panel/test/shotrun.sh llamaReal
// (add SHOT_SHOW=1 to watch it). No SHOT_PATH: the real llama-server is used. allscenes.sh skips it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SPARE_MB = 2048; // memory the house must still have free with a model loaded
const LARGEST = 6 * 1024 ** 3; // models bigger than this aren't tried here

const freeMb = () => Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1024;
const run = (file, args) => new Promise((done) => { execFile(file, args, (_error, out) => done(String(out || '').trim())); });
const servers = async () => (await run('pgrep', ['-f', 'llama-server -m '])).split('\n').filter(Boolean).length;
const gpuFreeMb = async () => Number(await run('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'])) || null;

module.exports = {
  async llamaReal({ page, shot, sleep }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} llamaReal: ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`);
    const home = os.homedir();
    const source = process.env.SHOT_MODELS;
    const program = process.env.SHOT_LLAMA || '';
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    if (!source || !fs.existsSync(program)) { report(false, `needs SHOT_MODELS and the real llama-server (${program})`); return; }
    const until = async (code, ms) => {
      for (let waited = 0; waited < ms; waited += 250) {
        if (await page(code)) return true;
        await sleep(250);
      }
      return false;
    };
    const status = () => page(`document.querySelector('.llama-status').textContent`);
    const click = (label) => page(`(() => { const b = [...document.querySelectorAll('.llama-view .btn')].find((x) => x.textContent === ${JSON.stringify(label)} && !x.hidden); if (!b || b.disabled) return false; b.click(); return true; })()`);
    try {
      // The real program and the models, reached from the throwaway home by shortcuts (nothing copied).
      fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
      fs.symlinkSync(program, path.join(home, '.local', 'bin', 'llama-server'));
      fs.mkdirSync(path.join(home, 'models'), { recursive: true });
      const models = fs.readdirSync(source).filter((name) => /\.gguf$/i.test(name))
        .map((name) => ({ name, size: fs.statSync(path.join(source, name)).size }))
        .filter((model) => model.size <= LARGEST).sort((a, b) => a.size - b.size);
      for (const model of models) fs.symlinkSync(path.join(source, model.name), path.join(home, 'models', model.name));
      report(models.length > 0, `models to try: ${models.map((m) => `${m.name} (${(m.size / 1024 ** 3).toFixed(1)} GB)`).join(', ')}`);
      const before = freeMb();

      for (const model of models) {
        const file = path.join(home, 'models', model.name);
        // Skipped up front when it couldn't fit with 2 GB to spare: on the graphics card (all layers go
        // there) with 1 GB for its working space, or else in the house's own memory.
        const sizeMb = model.size / 1048576;
        const gpuNow = await gpuFreeMb();
        if (!(gpuNow && gpuNow > sizeMb + 1024) && freeMb() - sizeMb < SPARE_MB) {
          report(true, `${model.name}: skipped, it wouldn't leave ${SPARE_MB} MB free (memory free ${Math.round(freeMb())} MB, graphics card ${gpuNow} MB)`);
          continue;
        }
        await page(`(() => { useInLlama(${JSON.stringify(file)}); return true; })()`);
        report(await until(`state.active?.kind === 'llama' && document.querySelector('.llama-select')?.value === ${JSON.stringify(file)}`, 10000), `${model.name}: picked in Local AI`);
        const started = Date.now();
        report(await click('Load model'), `${model.name}: Load model pressed`);
        const ready = await until(`document.querySelector('.llama-status').textContent === 'Ready'`, 240000);
        const loadSecs = ((Date.now() - started) / 1000).toFixed(1);
        const ram = Math.round(freeMb());
        const gpu = await gpuFreeMb();
        report(ready && await servers() === 1, `${model.name}: loaded in ${loadSecs} s (status "${await status()}")`);
        report(ram >= SPARE_MB, `${model.name}: memory free while loaded ${ram} MB (needs ${SPARE_MB}), graphics card free ${gpu} MB`);
        await shot(`llama-real-${model.name}`);
        if (!ready) break;

        await page(`(() => { const box = document.querySelector('.llama-message'); box.value = 'Reply with one short sentence saying hello. /no_think'; box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
        const done = await until(`/tokens per second/.test([...document.querySelectorAll('.llama-bubble.assistant')].pop()?.querySelector('.llama-line').textContent || '')`, 180000);
        const reply = await page(`(() => { const b = [...document.querySelectorAll('.llama-bubble.assistant')].pop(); return b ? { words: b.querySelector('.llama-words').textContent.trim(), line: b.querySelector('.llama-line').textContent } : null; })()`);
        report(done && reply?.words.length > 0, `${model.name}: replied "${reply?.words.slice(0, 80)}" (${reply?.line})`);
        await sleep(300);
        const seen = await page(`(() => {
          const view = document.querySelector('.llama-view').getBoundingClientRect();
          const list = document.querySelector('.llama-list').getBoundingClientRect();
          const last = [...document.querySelectorAll('.llama-bubble')].pop().getBoundingClientRect();
          const parts = [...document.querySelectorAll('.llama-message, .llama-buttons .btn:not([hidden])')].filter((n) => n.offsetParent).map((n) => n.getBoundingClientRect());
          return { reply: last.top >= list.top - 1 && last.bottom <= list.bottom + 1, typing: parts.every((r) => r.bottom <= view.bottom + 1 && r.right <= view.right + 1), list: Math.round(list.height) };
        })()`);
        report(seen.reply && seen.typing, `${model.name}: the newest reply and the whole typing box are in view (reply ${seen.reply}, typing box ${seen.typing}, chat ${seen.list} tall)`);
        await shot(`llama-real-${model.name}-reply`);

        report(await click('Unload model'), `${model.name}: Unload model pressed`);
        const unloaded = await until(`document.querySelector('.llama-status').textContent === 'Not loaded'`, 30000);
        await sleep(1500);
        report(unloaded && await servers() === 0, `${model.name}: unloaded, servers left ${await servers()}, memory free ${Math.round(freeMb())} MB (was ${Math.round(before)} before any model)`);
      }

      // Closing the tab unloads a loaded model too.
      const smallest = path.join(home, 'models', models[0].name);
      await page(`(() => { useInLlama(${JSON.stringify(smallest)}); return true; })()`);
      await until(`document.querySelector('.llama-select')?.value === ${JSON.stringify(smallest)}`, 10000);
      await click('Load model');
      await until(`document.querySelector('.llama-status').textContent === 'Ready'`, 240000);
      await page(`houseTest.closeTab(state.tabs.find((t) => t.kind === 'llama'))`);
      let left = 1;
      for (let waited = 0; waited < 15000 && left; waited += 250) {
        await sleep(250);
        left = await servers();
      }
      report(left === 0, `closing Local AI with a model loaded unloads it: servers left ${left}`);
    } catch (error) {
      report(false, `the scene stopped: ${error.stack}`);
    }
  },
};
