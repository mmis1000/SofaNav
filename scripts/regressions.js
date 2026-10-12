// Automated regression checks for bugs that are easy to reintroduce (see docs/test-cases.md).
// Usage: npm run serve   (in another terminal), then: npm run test:regress
// CONTENT_JS=path/to/content.js runs the checks against another copy of the script
// (e.g. an old commit) to confirm a check really catches its bug.
const { chromium } = require('playwright');
const fs = require('fs');

const URL = process.env.TEST_URL || 'http://localhost:8765/test/';

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  if (process.env.CONTENT_JS) {
    const body = fs.readFileSync(process.env.CONTENT_JS, 'utf8');
    // Every frame of the test page loads content.js from this path.
    await page.context().route('**/extension/content.js', (r) => r.fulfill({ body, contentType: 'text/javascript' }));
  }
  await page.goto(URL);
  await page.waitForTimeout(1000);
  return page;
}

const helpers = (page) => {
  const wait = (ms) => page.waitForTimeout(ms);
  return {
    wait,
    // Press a controller button through the test page's keyboard stand-in.
    press: async (key, gap = 450) => { await page.keyboard.down(key); await wait(90); await page.keyboard.up(key); await wait(gap); },
    // Scroll an element into view and put focus on it (debug hook).
    focusOn: (selector) => page.evaluate(async (sel) => {
      const el = document.querySelector(sel);
      el.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 300));
      await __gpn.refreshFrames(); await __gpn.refreshFrames();
      __gpn.focus(el);
    }, selector),
  };
};

const checks = {
  // E19: D-pad inside an entered scrolling frame whose viewport is blank must keep
  // scrolling the frame, and never the outer page.
  async 'E19 blank stretch in an entered frame scrolls the frame, not the page'(page) {
    const { press, wait, focusOn } = helpers(page);
    await press('ArrowUp');
    await focusOn('#sparseFrame');
    await wait(300);
    const pageY0 = await page.evaluate(() => scrollY);
    await press('Enter'); // A enters the frame
    const scopes = await page.evaluate(() => __gpn.scopes().map((s) => s.id));
    for (let i = 0; i < 3; i++) await press('ArrowDown', 700);
    const r = await page.evaluate(() => ({ frameY: document.getElementById('sparseFrame').contentWindow.scrollY, pageY: scrollY }));
    const detail = `scopes=${scopes} frame scrollY=${r.frameY} page scrollY ${pageY0}→${r.pageY}`;
    return { ok: scopes[0] === 'sparseFrame' && r.frameY > 200 && Math.abs(r.pageY - pageY0) < 5, detail };
  },

  // E20: B must close a native <dialog> opened with showModal().
  async 'E20 B closes a native showModal() dialog'(page) {
    const { press, wait } = helpers(page);
    await press('ArrowUp');
    await page.evaluate(() => { document.getElementById('dlg').showModal(); __gpn.focus(document.getElementById('ok')); });
    await wait(300);
    await press('Backspace');
    const open = await page.evaluate(() => document.getElementById('dlg').open);
    return { ok: !open, detail: `dialog.open=${open}` };
  },

  // E21: a frame that navigates to a page without the script must become one plain element.
  async 'E21 frame that loses its client becomes a plain element'(page) {
    const { press, wait } = helpers(page);
    await press('ArrowUp');
    const before = await page.evaluate(async () => {
      const f = document.getElementById('navFrame');
      f.scrollIntoView({ block: 'center' });
      await __gpn.refreshFrames(); await __gpn.refreshFrames();
      return __gpn.frameState(f).hasClient;
    });
    await page.evaluate(() => document.getElementById('swapFrame').click());
    await wait(800);
    const after = await page.evaluate(async () => {
      const f = document.getElementById('navFrame');
      await __gpn.refreshFrames(); await __gpn.refreshFrames();
      const c = __gpn.candidates();
      return { hasClient: __gpn.frameState(f).hasClient, frameIsElement: c.includes(f),
        staleProxies: c.filter((e) => !e.tagName && e.frame.iframe === f).length };
    });
    const detail = `before hasClient=${before}; after hasClient=${after.hasClient} plain=${after.frameIsElement} stale proxies=${after.staleProxies}`;
    return { ok: before && !after.hasClient && after.frameIsElement && after.staleProxies === 0, detail };
  },
};

(async () => {
  const browser = await chromium.launch();
  let failed = 0;
  for (const [name, run] of Object.entries(checks)) {
    const page = await openPage(browser);
    let res;
    try { res = await run(page); } catch (e) { res = { ok: false, detail: 'threw: ' + e.message }; }
    console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${name}\n      ${res.detail}`);
    if (!res.ok) failed++;
    await page.close();
  }
  await browser.close();
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exitCode = failed ? 1 : 0;
})();
