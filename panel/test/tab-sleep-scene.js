// Browser tabs out of sight go to sleep and wake at the same page (renderer/obscura-tab.js), in the hidden copy:
//   SHOT_PATH=$PWD/panel/test/stub SHOT_HOME=/tmp/house-shots-sleep panel/test/shotrun.sh tabSleep
const http = require('http');

module.exports = {
  async tabSleep({ page, sleep }) {
    const report = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'} tabSleep: ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`);
    let hits = 0;
    const site = http.createServer((request, response) => {
      if (request.url.startsWith('/page')) hits += 1;
      response.setHeader('Content-Type', 'text/html');
      response.end(`<title>Sleepy ${request.url}</title><p>hello</p>`);
    });
    await new Promise((resolve) => { site.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${site.address().port}/page-a`;
    const waitFor = async (code, ms = 8000) => {
      for (let waited = 0; waited < ms; waited += 200) {
        if (await page(code).catch(() => false)) return true;
        await sleep(200);
      }
      return false;
    };
    try {
      await page(`(() => { window.__home = houseTest.state.active; window.__a = houseTest.openInObscura(${JSON.stringify(url)}); window.__b = houseTest.openInObscura(${JSON.stringify(url.replace('page-a', 'page-b'))}); return true; })()`);
      const loaded = await waitFor('window.__a.view.getURL().includes("page-a") && !window.__a.loading && window.__b.view.getURL().includes("page-b") && !window.__b.loading');
      report(loaded, `both pages loaded (${hits} requests)`);
      const visits = await page('houseTest.history().length');
      // __b stands for a tab an AI is using: it must never sleep.
      await page('(() => { window.__b.aiOf = "Test"; houseTest.activateTab(window.__home); houseTest.sleepCheck(Date.now(), 0); return true; })()');
      const asleep = await page('({ a: window.__a.asleep, inPage: document.contains(window.__a.view), faded: window.__a.el.classList.contains("asleep"), b: window.__b.asleep || null, bInPage: document.contains(window.__b.view) })');
      report(asleep.a && asleep.a.includes('page-a') && !asleep.inPage && asleep.faded, `a hidden tab sleeps and lets its page go: ${JSON.stringify(asleep)}`);
      report(!asleep.b && asleep.bInPage, 'a tab an AI is using stays awake');
      const before = hits;
      await page('(() => { houseTest.activateTab(window.__a); return true; })()');
      const woke = await waitFor('document.contains(window.__a.view) && window.__a.view.getURL().includes("page-a") && !window.__a.loading');
      const after = await page('({ asleep: window.__a.asleep, faded: window.__a.el.classList.contains("asleep"), visits: houseTest.history().length })');
      report(woke && hits > before && !after.asleep && !after.faded, `showing it again wakes it at the same page (requests ${before} -> ${hits}): ${JSON.stringify(after)}`);
      report(after.visits === visits, `waking isn't a new History visit (${visits} -> ${after.visits})`);
      // The front tab never sleeps, however long it has been shown.
      await page('houseTest.sleepCheck(Date.now() + 3600000, 0)');
      report(await page('!window.__a.asleep && document.contains(window.__a.view)'), 'the tab in front never sleeps');
    } catch (error) {
      report(false, error.message);
    } finally {
      site.close();
    }
  },
};
