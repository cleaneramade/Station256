// Audit: the video editor tab shows Station 256's name, never "OpenCut", on its projects page and
// with a video open. (The licence and credits stay in the repo, not on screen.)
const { fs, ff, sleep, report, demoHome, until } = require('./audit-lib');

// Every word, tooltip, label and placeholder inside the editor's page, plus its title.
const WORDS = `(() => {
  const out = [document.title];
  for (const node of document.querySelectorAll('body *')) {
    for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) if (node.getAttribute(attr)) out.push(node.getAttribute(attr));
  }
  out.push(document.body.innerText);
  return out.join(' | ');
})()`;

module.exports = {
  async auditEditorBrand({ page, shot }) {
    const { dir, at } = demoHome('AuditEditor');
    ff('-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=2:r=25', '-pix_fmt', 'yuv420p', at('clip.mp4'));
    const guest = (code) => page(`(async () => { const tab = state.tabs.find((t) => t.kind === 'editor'); if (!tab) return ''; try { return await tab.view.executeJavaScript(${JSON.stringify(code)}); } catch (error) { return ''; } })()`);
    await page(`houseTest.navigate(${JSON.stringify(dir)}); true`);
    await sleep(600);
    await page(`openEditor().then(() => true)`);
    const projects = await until(page, `(async () => { const t = state.tabs.find((x) => x.kind === 'editor'); try { const s = await t.view.executeJavaScript('document.body.innerText.length'); return s > 20; } catch { return false; } })()`, 30000);
    await sleep(1500);
    const words1 = await guest(WORDS);
    await shot('audit-editor-projects');
    report(Boolean(projects) && words1.length > 20 && !/opencut/i.test(words1), `editor projects page loaded (${words1.length} chars of text) and shows no "OpenCut"`);
    const tabTitle = await page(`state.tabs.find((t) => t.kind === 'editor').el.querySelector('.tab-title').textContent`);
    report(!/opencut/i.test(tabTitle), `the tab is called "${tabTitle}"`);

    // With a video on the timeline.
    const st = fs.statSync(at('clip.mp4'));
    await page(`openEditor(${JSON.stringify(at('clip.mp4'))}).then(() => true)`);
    await until(page, `(() => { const t = state.tabs.find((x) => x.kind === 'editor'); return t && t.view.getURL().includes('/editor/?project='); })()`, 30000);
    await sleep(4000);
    const words2 = await guest(WORDS);
    await shot('audit-editor-open');
    report(words2.length > 50 && !/opencut/i.test(words2), `editor with a video open (${words2.length} chars of text) shows no "OpenCut"`);
    void st;
    await page(`(() => { for (const tab of [...state.tabs]) if (tab.kind === 'editor' || tab.kind === 'video') removeTab(tab); return true; })()`);
  },
};
