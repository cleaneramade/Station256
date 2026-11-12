// The API Keys dialog (renderer/keys.js), with the real key file in the throwaway home: a bad key
// refused, a key saved (owner-only), replaced and removed, and the search box's menu hearing each.
// Run: SHOT_HOME=/tmp/house-shots-keys SHOT_PATH=<repo>/panel/test/stub panel/test/shotrun.sh apiKeys
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = {
  async apiKeys({ page, shot, sleep, win }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} apiKeys: ${text}`);
    const home = os.homedir();
    if (!home.startsWith('/tmp/')) { report(false, 'needs the throwaway HOME'); return; }
    const keyFile = path.join(home, '.config', 'house', 'jev-key');
    fs.rmSync(keyFile, { force: true });
    const keyText = () => (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : null);

    report(await page(`newItems().some((item) => item && item.label === 'API Keys')`), 'New has API Keys');
    const row = `document.querySelector('#dialog[open] .keys-row[data-service="jev"]')`;
    const look = () => page(`(() => { const r = ${row}; if (!r) return null; return { status: r.querySelector('.keys-status').textContent, remove: !r.querySelector('.keys-remove').hidden, problem: r.querySelector('.keys-problem').textContent, field: r.querySelector('.keys-field').value }; })()`);
    const type = (text) => page(`(() => { const f = ${row}.querySelector('.keys-field'); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    const done = () => page(`(() => { const b = [...document.querySelectorAll('#dialog[open] .dialog-buttons .btn')].find((n) => n.textContent === 'Done'); b?.click(); return !!b; })()`);
    const scopeMenu = async () => {
      await page(`document.getElementById('search-scope').click(); true`);
      await sleep(250);
      const labels = await page(`[...document.querySelectorAll('#menu:not([hidden]) .menu-item')].map((b) => b.textContent.trim())`);
      await page(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
      await sleep(200);
      return labels;
    };

    page(`openKeys()`); // settles only when the dialog closes
    await sleep(700);
    let now = await look();
    report(now?.status === 'Not set' && !now.remove, `no key yet: ${JSON.stringify(now)}`);
    await shot('api-keys-empty');

    await type('not a key, it has spaces');
    await sleep(400);
    now = await look();
    report(now.status === 'Not set' && /doesn't look like a key/.test(now.problem) && keyText() === null, `a bad key is refused, nothing saved: ${JSON.stringify(now)}`);

    await type('ts-first-1234');
    await sleep(400);
    now = await look();
    const mode = fs.existsSync(keyFile) ? (fs.statSync(keyFile).mode & 0o777).toString(8) : null;
    report(now.status === 'Saved' && now.remove && now.problem === '' && now.field === '' && keyText() === 'ts-first-1234' && mode === '600', `saved, owner-only, the box emptied: ${JSON.stringify([now, mode])}`);
    await shot('api-keys-saved');

    await type('ts-second-5678');
    await sleep(400);
    report(keyText() === 'ts-second-5678', 'a new key replaces the old');
    report(await done(), 'Done closes it');
    await sleep(300);
    let labels = await scopeMenu();
    report(labels.includes('API Keys') && labels.includes('Remove Jev Key'), `the search menu has API Keys and knows a key is saved: ${JSON.stringify(labels)}`);

    page(`openKeys()`);
    await sleep(700);
    now = await look();
    report(now?.status === 'Saved', `opened again, it says Saved: ${JSON.stringify(now)}`);
    await page(`${row}.querySelector('.keys-remove').click(); true`);
    await sleep(400);
    now = await look();
    report(now.status === 'Not set' && !now.remove && keyText() === null, `Remove takes the key away: ${JSON.stringify(now)}`);

    // Keys that aren't keys: too long, not plain letters, only spaces. Nothing is written.
    for (const [what, bad] of [['over 400 characters', 'k'.repeat(401)], ['other alphabets', 'ts-ключ-1234'], ['only spaces', '   ']]) {
      await type(bad);
      await sleep(300);
      now = await look();
      report(now.status === 'Not set' && keyText() === null, `${what} is refused, nothing saved: ${JSON.stringify([now.status, now.problem])}`);
    }
    // Pasted with spaces and a line break around it: only the key is kept.
    await type('  \tts-padded-42 \n');
    await sleep(400);
    now = await look();
    report(now.status === 'Saved' && now.field === '' && keyText() === 'ts-padded-42', `spaces around a pasted key are dropped: ${JSON.stringify(now)}`);
    // Save twice at once, then Save and Remove at once: the row and the file agree each time.
    await page(`(() => { const r = ${row}; r.querySelector('.keys-field').value = 'ts-twice-77'; const b = r.querySelector('.keys-save'); b.click(); b.click(); return true; })()`);
    await sleep(500);
    now = await look();
    report(now.status === 'Saved' && now.problem === '' && now.field === '' && keyText() === 'ts-twice-77' && !fs.existsSync(`${keyFile}.new`), `Save clicked twice saves once, with no complaint: ${JSON.stringify(now)}`);
    await page(`(() => { const r = ${row}; r.querySelector('.keys-field').value = 'ts-then-gone-88'; r.querySelector('.keys-save').click(); r.querySelector('.keys-remove').click(); return true; })()`);
    await sleep(500);
    now = await look();
    report(now.status === 'Not set' && !now.remove && keyText() === null, `Save then Remove at once ends with no key: ${JSON.stringify(now)}`);
    // The key is nowhere on the page, in the settings, or left behind when the dialog closes.
    await page(`${row}.querySelector('.keys-field').value = 'ts-typed-not-saved'; true`);
    const measure = () => page(`(() => { const d = document.getElementById('dialog').getBoundingClientRect(); const inside = [...document.querySelectorAll('#dialog .keys-row *, #dialog .dialog-buttons *')].every((n) => { const b = n.getBoundingClientRect(); return b.width === 0 || (b.left >= d.left - 1 && b.right <= d.right + 1 && b.top >= d.top - 1 && b.bottom <= d.bottom + 1); }); return { inside, wide: d.width, window: window.innerWidth, focus: document.activeElement?.className || '' }; })()`);
    let fit = await measure();
    report(fit.inside && fit.wide <= fit.window && /keys-field/.test(fit.focus), `everything sits inside the dialog, the box has focus: ${JSON.stringify(fit)}`);
    // A narrow window at 150% zoom: still inside the window, nothing clipped.
    const size = win.getSize();
    const zoom = win.webContents.getZoomFactor();
    win.setSize(700, 560);
    win.webContents.setZoomFactor(1.5);
    await sleep(600);
    fit = await measure();
    report(fit.inside && fit.wide <= fit.window, `it fits a 700 px window at 150%: ${JSON.stringify(fit)}`);
    await shot('api-keys-narrow-150');
    win.webContents.setZoomFactor(zoom);
    win.setSize(size[0], size[1]);
    await sleep(400);
    await page(`document.getElementById('dialog').dispatchEvent(new Event('cancel')); document.getElementById('dialog').close(); true`);
    await sleep(300);
    const left = await page(`(() => { const text = document.documentElement.outerHTML + [...document.querySelectorAll('input')].map((i) => i.value).join(' '); return ['ts-first-1234', 'ts-second-5678', 'ts-padded-42', 'ts-twice-77', 'ts-then-gone-88', 'ts-typed-not-saved'].filter((k) => text.includes(k)); })()`);
    const settings = path.join(home, '.config', 'house', 'panel.json');
    const inSettings = fs.existsSync(settings) && /ts-(first|second|padded|twice|then|typed)/.test(fs.readFileSync(settings, 'utf8'));
    report(left.length === 0 && !inSettings, `no key is left on the page or in the settings: ${JSON.stringify(left)}`);
    await sleep(100);
    labels = await scopeMenu();
    report(labels.includes('API Keys') && !labels.includes('Remove Jev Key'), `the search menu heard it: ${JSON.stringify(labels)}`);
  },
};
