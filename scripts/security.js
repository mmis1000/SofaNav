// Security regression: a page that frames another site must not be able to make
// SofaNav click things inside it (see docs/test-cases.md, E29).
// Runs the forged-command attack in two setups:
//   page script  the test page loads content.js itself (same as the userscript)
//   extension    the real extension, loaded into Chromium
// Usage: npm run serve (another terminal), then: npm run test:security
// CONTENT_JS / EXTENSION_DIR test another copy (e.g. an old commit).
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.TEST_URL || 'http://localhost:8765';
const EXT_DIR = path.resolve(process.env.EXTENSION_DIR || path.join(__dirname, '..', 'extension'));

async function attack(context, ext) {
  const page = await context.newPage();
  if (process.env.CONTENT_JS) {
    const body = fs.readFileSync(process.env.CONTENT_JS, 'utf8');
    await context.route('**/extension/content.js', (r) => r.fulfill({ body, contentType: 'text/javascript' }));
  }
  await page.goto(`${BASE}/test/attack/attacker.html${ext ? '?ext' : ''}`);
  await page.waitForTimeout(4000); // the attacker keeps trying for ~2 s
  const victim = page.frames().find((f) => f.url().includes('/attack/victim.html'));
  const r = await victim.evaluate(() => ({
    submitted: window.__submitted, clicked: window.__clicked,
    sofanav: document.documentElement.hasAttribute('data-sofanav'),
  }));
  const replies = await page.evaluate(() => window.__attackLog.length);
  await page.close();
  return { ok: r.sofanav && r.submitted === 0 && r.clicked.length === 0,
    detail: `SofaNav running in victim=${r.sofanav}, form submitted ${r.submitted}×, clicks [${r.clicked}], replies to attacker: ${replies}` };
}

// With the extension, frames must still work for the real user: the engine in the top
// frame reaches the cross-origin frame through extension messaging. The whole-screen graph
// (Alt+Shift+G twice) draws boxes for the frame's elements only if it got their snapshot.
async function crossOriginStillWorks(context) {
  const page = await context.newPage();
  await page.goto(`${BASE}/test/?ext`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('crossFrame').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(500);
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Alt+Shift+G'); await page.waitForTimeout(600); }
  await page.waitForTimeout(800);
  const r = await page.evaluate(() => {
    const f = document.getElementById('crossFrame').getBoundingClientRect();
    const boxes = [...document.querySelectorAll('svg rect')].map((b) => b.getBoundingClientRect())
      .filter((b) => b.left >= f.left && b.right <= f.right && b.top >= f.top && b.bottom <= f.bottom && b.width < f.width);
    // The graph outlines containers in purple. The cross-origin test frame scrolls, so with a
    // working client it is a scroll container (its item count came through extension messaging);
    // without one it would be a plain element with a grey outline.
    const frameBox = [...document.querySelectorAll('svg rect')].find((b) => {
      const q = b.getBoundingClientRect(); return Math.abs(q.left - f.left) < 3 && Math.abs(q.width - f.width) < 6; });
    return { outline: frameBox?.getAttribute('stroke') || 'none' };
  });
  await page.close();
  const ok = r.outline === '#bf5af2';
  return { ok, detail: `cross-origin frame outline in the graph: ${r.outline} (${ok ? 'container: client reached' : 'not a container: no client'})` };
}

(async () => {
  let failed = 0;
  const report = (name, res) => { console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${name}\n      ${res.detail}`); if (!res.ok) failed++; };

  const browser = await chromium.launch();
  report('E29 forged frame commands do nothing (page script / userscript)', await attack(await browser.newContext(), false));
  await browser.close();

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sofanav-sec-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  try {
    report('E29 forged frame commands do nothing (extension)', await attack(ctx, true));
    report('E29 cross-origin frames still work through extension messaging', await crossOriginStillWorks(ctx));
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exitCode = failed ? 1 : 0;
})();
