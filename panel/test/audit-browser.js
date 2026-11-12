// Audit: the Web Browser tab, as a first-time user meets it. Start page, address and search, back and
// forward, find, a page that fails, and no "Obscura" anywhere a person can see it.
const http = require('http');
const { sleep, report, until } = require('./audit-lib');

// Every word, tooltip, label and placeholder on the screen (open menus included), as one text.
const VISIBLE = `(() => {
  const out = [];
  for (const node of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE'].includes(node.tagName)) continue;
    for (const attr of ['title', 'data-tip', 'aria-label', 'placeholder', 'alt']) if (node.getAttribute(attr)) out.push(node.getAttribute(attr));
    if (node.childNodes.length && [...node.childNodes].some((child) => child.nodeType === 3)) out.push(node.textContent);
  }
  return out.join(' | ');
})()`;

module.exports = {
  async auditBrowser({ page, shot }) {
    const pages = { '/one': '<title>Page One</title><h1>one</h1><a href="/two">two</a>', '/two': '<title>Page Two</title><h1>two needle needle</h1>' };
    const server = http.createServer((req, res) => {
      const body = pages[req.url];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
      res.end(body || '<title>Missing</title>not here');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://localhost:${server.address().port}`;
    const active = (code) => page(`(() => { const t = houseTest.state.active; return ${code}; })()`);
    const go = (text) => active(`(t.input.value = ${JSON.stringify(text)}, t.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })), true)`);
    try {
      await page(`document.getElementById('new-tab').click(); true`);
      await sleep(300);
      // The New menu, as the owner sees it, before the browser is in front.
      await page(`document.getElementById('new-btn').click(); true`);
      await sleep(300);
      const menu = await page(`document.getElementById('menu').hidden ? '' : [...document.querySelectorAll('#menu .menu-item')].map((row) => row.textContent).join(', ')`);
      report(/Web Browser/.test(menu) && /Local AI/.test(menu), `the New menu lists: ${menu}`);
      const seen = [await page(VISIBLE)];
      await page(`closeMenu(); true`);
      await page(`openObscura(); true`);
      await sleep(800);
      // The home page: a search box (focused) and tiles; the defaults show while there is no history.
      const home = await active(`({ box: !!t.homeBox && t.homeBox.placeholder, focus: document.activeElement === t.homeBox, tiles: [...t.message.querySelectorAll('.ob-tile-name')].map((n) => n.textContent) })`);
      report(/Search the web or type an address/.test(home.box) && home.focus, `the home page has a focused search box: ${JSON.stringify(home)}`);
      report(home.tiles.length >= 1 && home.tiles.length <= 8, `the home page has shortcut tiles: ${home.tiles.join(', ')}`);
      await shot('audit-browser-start');
      // Typing a word and pressing Enter in the home box searches, like the address bar.
      await active(`(t.homeBox.value = 'kittens', t.homeBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })), true)`);
      const searched = await active(`t.url`);
      report(/duckduckgo\.com\/\?q=kittens/.test(searched) && await active(`t.message.hidden`), `typing a word in the home box goes to the search: ${searched}`);
      await page(`closeTab(houseTest.state.active); openObscura(); true`);
      await sleep(800);
      const tabs = await page(`document.querySelector('.tabs').textContent`);
      report(/New tab/.test(tabs), `the new tab is called: ${tabs.trim().slice(0, 60)}`);

      // No Obscura wording: on the page, in the New menu, in the tab's right-click menu.
      seen.push(await page(VISIBLE));
      report(!/obscura/i.test(seen.join(' ')), 'no "Obscura" in any visible word, tooltip, label or menu');

      // What the address bar does with what is typed.
      const reads = await page(`['cats and dogs', 'example.com', 'localhost:3000', 'file:///etc/passwd', 'ftp://x.y'].map((text) => JSON.stringify(obscuraAddress(text)))`);
      report(/duckduckgo\.com\/\?q=cats%20and%20dogs/.test(reads[0]) && /https:\/\/example\.com/.test(reads[1]) && /http:\/\/localhost:3000/.test(reads[2]) && /only opens web pages/.test(reads[3]) && /only opens web pages/.test(reads[4]), `address bar: ${reads.join(' ')}`);
      await go('file:///etc/passwd');
      await sleep(300);
      report(/only opens web pages/.test(await active(`t.note.textContent`)), 'typing file:// says plainly that only web pages open');

      // A page, a link inside it, Back, Forward, Reload, Find.
      await go(`${base}/one`);
      report(Boolean(await until(page, `houseTest.state.active.el.querySelector('.tab-title').textContent === 'Page One'`, 10000)), 'a page loads and names the tab');
      await go(`${base}/two`);
      await until(page, `houseTest.state.active.el.querySelector('.tab-title').textContent === 'Page Two'`, 10000);
      await active(`(t.back.click(), true)`);
      report(Boolean(await until(page, `houseTest.state.active.el.querySelector('.tab-title').textContent === 'Page One'`, 8000)), 'Back goes to Page One');
      await active(`(t.forward.click(), true)`);
      report(Boolean(await until(page, `houseTest.state.active.el.querySelector('.tab-title').textContent === 'Page Two'`, 8000)), 'Forward goes to Page Two');
      await active(`(t.reload.click(), true)`);
      await sleep(600);
      await page(`openObscuraFind(houseTest.state.active); true`);
      await active(`(t.findInput.value = 'needle', t.findInput.dispatchEvent(new Event('input')), true)`);
      const count = await until(page, `houseTest.state.active.findCount.textContent`, 5000);
      report(/of 2/.test(count || ''), `Find in page counts matches: "${count}"`);
      await shot('audit-browser-find');

      // Open in the Windows browser: the button is there, and only for web pages.
      const outside = await active(`[t.outside.textContent, t.outside.dataset.tip || t.outside.title]`);
      report(/Open in browser/.test(outside[0]) && /Windows/.test(outside[1]), `the button says "${outside[0]}", tooltip "${outside[1]}"`);

      // A page that can't be reached, and a missing page.
      await go('http://localhost:39998/');
      const down = await until(page, `houseTest.state.active.message.hidden ? '' : houseTest.state.active.message.textContent`, 15000);
      report(/didn't answer|can't reach/i.test(down || ''), `a site that isn't running says: "${down}"`);
      await shot('audit-browser-fail');
      const failTitle = await active(`t.el.querySelector('.tab-title').textContent`);
      report(failTitle === 'localhost:39998', `after a failed page the tab is named for the site, not the page before: "${failTitle}"`);
      report(!/obscura/i.test(down || ''), 'and the failure page has no Obscura wording');
      await go(`${base}/nothing`);
      await sleep(1200);
      report(/Missing/.test(await active(`t.el.querySelector('.tab-title').textContent`)), 'a missing page (404) shows what the site sent, and the tab is named for it');
    } finally {
      server.close();
      await page(`(() => { for (const tab of [...houseTest.state.tabs]) if (tab.kind === 'obscura') houseTest.closeTab(tab); return true; })()`);
    }
  },
};
