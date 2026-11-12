// Tests snapping both ways, with the real Windows helper. A script on the Windows side does the
// Windows part. The two talk through small files in a throwaway folder.
const fs = require('fs');
const path = require('path');

const DIR = process.env.HOUSE_SNAPTEST;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(win) {
  const page = (code) => win.webContents.executeJavaScript(code);
  const box = () => page(`(() => {
    const f = window.outerWidth / window.innerWidth;
    const b = document.querySelector('.app').getBoundingClientRect();
    return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * f));
  })()`);
  const say = (line) => console.log(line);
  const center = (selector, index = 0) => page(`(() => {
    const f = window.outerWidth / window.innerWidth;
    const b = document.querySelectorAll(${JSON.stringify(selector)})[${index}].getBoundingClientRect();
    return { x: Math.round((b.left + b.width / 2) * f), y: Math.round((b.top + b.height / 2) * f) };
  })()`);
  const held = (point) => win.webContents.sendInputEvent({ type: 'mouseMove', ...point, modifiers: ['leftButtonDown'] });
  const answer = (name, text) => {
    say(`${name}: ${text}`);
    fs.writeFileSync(path.join(DIR, `answer-${name}`), text);
  };

  // Drags to the top, waits for the panel, and returns once it's open.
  const dragToPanel = async () => {
    const at = await center('.drag-space');
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at });
    await sleep(100);
    held({ x: at.x + 40, y: at.y + 40 });
    await sleep(1200); // long enough for the suggestion to join the panel
    held({ x: 960, y: 5 });
    await sleep(350);
  };

  const steps = {
    // Windows' suggested pair: only used if it would pair with the test window, never your apps.
    suggest: async () => {
      await dragToPanel();
      const suggested = await page(`Boolean(document.querySelector('.snap-suggest'))`);
      const icon = await page(`Boolean(document.querySelector('.snap-suggest .partner img'))`);
      fs.writeFileSync(path.join(DIR, 'bar.png'), (await win.webContents.capturePage()).toPNG());
      const cell = await center('.snap-group .snap-cell', 0);
      held(cell);
      await sleep(200);
      const both = await page(`document.querySelectorAll('.snap-suggest .snap-cell.on').length`);
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...cell });
      await sleep(1500);
      answer('suggest', `suggested pair shown=${suggested} partner icon=${icon} both tiles lit=${both === 2} window ${await box()}`);
    },
    // A plain half and half, then the tray for the other side.
    assist: async () => {
      await dragToPanel();
      const group = await page(`document.querySelector('.snap-suggest') ? 1 : 0`);
      const cell = await page(`(() => {
        const f = window.outerWidth / window.innerWidth;
        const b = document.querySelectorAll('.snap-group')[${group}].querySelectorAll('.snap-cell')[0].getBoundingClientRect();
        return { x: Math.round((b.left + b.width / 2) * f), y: Math.round((b.top + b.height / 2) * f) };
      })()`);
      held(cell);
      await sleep(200);
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...cell });
      for (let i = 0; i < 40 && !(await page(`Boolean(document.querySelector('.snap-assist'))`)); i += 1) await sleep(100);
      await sleep(300);
      const titles = await page(`[...document.querySelectorAll('.snap-assist-name')].map((t) => t.textContent)`);
      const pictures = await page(`document.querySelectorAll('.snap-assist-picture img:not(.only-icon)').length`);
      // The photo must never hold your real windows, so everything but the test window is blanked first.
      await page(`[...document.querySelectorAll('.snap-assist-tile')].filter((tile) => !tile.textContent.includes('Snap test window')).forEach((tile) => {
        tile.querySelector('.snap-assist-picture').replaceChildren();
        tile.querySelector('.snap-assist-name').textContent = 'Another app';
      }); true`);
      await sleep(200);
      fs.writeFileSync(path.join(DIR, 'assist.png'), (await win.webContents.capturePage()).toPNG());
      await page(`[...document.querySelectorAll('.snap-assist-tile')].find((t) => t.textContent.includes('Snap test window'))?.click(); true`);
      await sleep(1200);
      answer('assist', `window ${await box()} offered=${titles.length} includes test window=${titles.includes('Snap test window')} real pictures=${pictures} closed after picking=${await page(`!document.querySelector('.snap-assist')`)}`);
    },
    // Where everything is right now, for a script driving the real mouse.
    where: async () => {
      answer('where', JSON.stringify(await page(`(() => {
        const f = window.outerWidth / window.innerWidth;
        const scaled = (b) => ({ x: Math.round(b.left * f), y: Math.round(b.top * f), w: Math.round(b.width * f), h: Math.round(b.height * f) });
        const bar = document.querySelector('.drag-space').getBoundingClientRect();
        const preview = document.querySelector('.snap-preview');
        const tile = [...document.querySelectorAll('.snap-assist-tile')].find((item) => item.querySelector('.snap-assist-name')?.textContent === 'Snap test window');
        return {
          box: scaled(document.querySelector('.app').getBoundingClientRect()),
          bar: { x: Math.round((bar.left + bar.width / 2) * f), y: Math.round((bar.top + bar.height / 2) * f) },
          seams: [...document.querySelectorAll('.snap-seam')].map((el) => ({ ...scaled(el.getBoundingClientRect()), hover: el.matches(':hover'), cursor: getComputedStyle(el).cursor })),
          preview: preview && !preview.hidden && preview.classList.contains('shown') ? scaled(preview.getBoundingClientRect()) : null,
          assist: Boolean(document.querySelector('.snap-assist')),
          tile: tile ? scaled(tile.getBoundingClientRect()) : null,
        };
      })()`)));
    },
    // Records the window's size many times a second, to show whether it followed along live.
    'track-start': async () => {
      await page(`window.seen = []; window.seenTimer = setInterval(() => {
        const b = document.querySelector('.app').getBoundingClientRect();
        window.seen.push(Math.round(b.left) + ',' + Math.round(b.top) + ',' + Math.round(b.width) + ',' + Math.round(b.height));
      }, 16); true`);
      answer('track-start', 'on');
    },
    'track-stop': async () => {
      answer('track-stop', await page(`(() => {
        clearInterval(window.seenTimer);
        const sizes = window.seen.filter((item, i) => item !== window.seen[i - 1]);
        return sizes.length + ' different sizes along the way';
      })()`));
    },
    // Frame timing for maximize and restore, without and with rounded corners during the glide.
    glide: async () => {
      const once = () => page(`new Promise((resolve) => {
        const gaps = [];
        const start = performance.now();
        let last = start;
        const frame = (now) => {
          gaps.push(now - last);
          last = now;
          if (now - start < 420) requestAnimationFrame(frame);
          else {
            gaps.shift();
            resolve(gaps.length + ' frames, worst ' + Math.round(Math.max(...gaps)) + ' ms');
          }
        };
        document.getElementById('win-max').click();
        requestAnimationFrame(frame);
      })`);
      const lines = [];
      for (const [name, css] of [['plain', ''], ['rounded', 'html.gliding .app { border-radius: 8px !important; }']]) {
        await page(`document.getElementById('glide-style')?.remove(); { const s = document.createElement('style'); s.id = 'glide-style'; s.textContent = ${JSON.stringify(css)}; document.head.append(s); } true`);
        for (let i = 0; i < 4; i += 1) {
          lines.push(`${name}: ${await once()}`);
          await sleep(500);
        }
      }
      await page(`document.getElementById('glide-style')?.remove(); true`);
      answer('glide', lines.join(' | '));
    },
    'log-events': async () => {
      const log = (name) => fs.appendFileSync(path.join(DIR, 'events.txt'), `${Date.now()} ${name} max=${win.isMaximized()} min=${win.isMinimized()} ${JSON.stringify(win.getBounds())}\n`);
      for (const name of ['maximize', 'unmaximize', 'minimize', 'restore', 'focus', 'blur', 'resize']) win.on(name, () => log(name));
      answer('log-events', 'on');
    },
    'dump-events': async () => answer('dump-events', 'ok'),
    // Pulls the window away so it's back at its normal size, for the key tests.
    normalize: async () => {
      if (await page(`document.documentElement.classList.contains('maximized')`)) await page(`document.getElementById('win-max').click(); true`);
      await sleep(500);
      const at = await center('.drag-space');
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at });
      await sleep(100);
      held({ x: 900, y: 400 });
      await sleep(400);
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 900, y: 400 });
      await sleep(600);
      answer('normalize', `window ${await box()}`);
    },
    // Whether the tray carried on after Windows' tray closed, and for which spot.
    carryon: async () => {
      await sleep(1200);
      const spot = await page(`(() => {
        const a = document.querySelector('.snap-assist');
        if (!a) return 'none';
        const f = window.outerWidth / window.innerWidth;
        const b = a.getBoundingClientRect();
        return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * f)).join(',');
      })()`);
      const names = await page(`[...document.querySelectorAll('.snap-assist-name')].map((t) => t.textContent)`);
      answer('carryon', `offer for spot ${spot}, ${names.length} app(s), offers the window already placed=${names.includes('Snap test window')}`);
      await page(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
    },
  };

  try {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await sleep(2500);
    say(`start: window ${await box()}`);
    fs.writeFileSync(path.join(DIR, 'ready'), '');
    const end = Date.now() + 170000;
    while (Date.now() < end) {
      const [name] = fs.readdirSync(DIR).filter((file) => file.startsWith('do-'));
      if (name) {
        fs.rmSync(path.join(DIR, name));
        const step = name.slice(3);
        if (step === 'finish') break;
        if (steps[step]) await steps[step]();
        else {
          await sleep(1000);
          answer(step, `window ${await box()} maximized=${await page(`document.documentElement.classList.contains('maximized')`)} minimized-fade=${await page(`getComputedStyle(document.querySelector('.app')).opacity !== '1'`)}`);
        }
        fs.writeFileSync(path.join(DIR, `done-${step}`), '');
      }
      await sleep(100);
    }
  } catch (error) {
    say(`FAIL test stopped: ${error.message.replace(/\s+/g, ' ')}`);
  }
  require('electron').app.exit(0);
}

module.exports = { run };
