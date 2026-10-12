// Security regression: a page that frames another site must not be able to make
// SofaNav click things inside it (see docs/test-cases.md, E29).
// The attacker page forges SofaNav's frame messages and fakes a controller (getGamepads) for
// SofaNav in its own top frame. Runs in three setups:
//   page script    the test page loads content.js itself (like sofanav.js on a site)
//   extension      the real extension, loaded into Chromium
//   userscript     dist/sofanav.user.js installed in Violentmonkey (pinned release, downloaded
//                  by scripts/fetch-violentmonkey.js)
// Usage: npm run serve (another terminal), then: npm run test:security
// CONTENT_JS / EXTENSION_DIR / USERSCRIPT test another copy (e.g. an old commit).
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.TEST_URL || 'http://localhost:8765';
const EXT_DIR = path.resolve(process.env.EXTENSION_DIR || path.join(__dirname, '..', 'extension'));
const USER_JS = path.resolve(process.env.USERSCRIPT || path.join(__dirname, '..', 'dist', 'sofanav.user.js'));
const { execFileSync } = require('child_process');

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
async function crossOriginStillWorks(context, how) {
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
  return { ok, detail: `cross-origin frame outline in the graph: ${r.outline} (${ok ? `container: client reached through ${how}` : 'not a container: no client'})` };
}

async function launchWith(dir) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sofanav-sec-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  return { ctx, done: async () => { await ctx.close(); fs.rmSync(profile, { recursive: true, force: true }); } };
}

// Violentmonkey with the userscript installed. Chrome runs userscript managers only with the
// extension's "Allow user scripts" switch on, so flip it on its details page first.
async function launchViolentmonkey() {
  const vm = execFileSync(process.execPath, [path.join(__dirname, 'fetch-violentmonkey.js')], { encoding: 'utf8' }).trim();
  const run = await launchWith(vm);
  const { ctx } = run;
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const settings = await ctx.newPage();
  await settings.goto(`chrome://extensions/?id=${id}`);
  await settings.waitForTimeout(800);
  const on = await settings.evaluate(() => {
    const view = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-detail-view');
    const row = view.shadowRoot.querySelector('#allow-user-scripts');
    const toggle = row?.shadowRoot.querySelector('cr-toggle');
    if (toggle && !toggle.checked) toggle.click();
    return !!toggle;
  });
  if (!on) throw new Error('Allow user scripts switch not found');
  await settings.goto(`chrome-extension://${id}/options/index.html`);
  await settings.waitForTimeout(1000);
  const res = await settings.evaluate((code) => chrome.runtime.sendMessage({ cmd: 'ParseScript', data: { code } }), fs.readFileSync(USER_JS, 'utf8'));
  if (res?.errors?.length) throw new Error(`install failed: ${JSON.stringify(res.errors)}`);
  await settings.close();
  return run;
}

(async () => {
  let failed = 0;
  const report = (name, res) => { console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${name}\n      ${res.detail}`); if (!res.ok) failed++; };

  const browser = await chromium.launch();
  report('E29 forged frame commands do nothing (page script)', await attack(await browser.newContext(), false));
  await browser.close();

  let run = await launchWith(EXT_DIR);
  try {
    report('E29 forged frame commands do nothing (extension)', await attack(run.ctx, true));
    report('E29 cross-origin frames still work through extension messaging', await crossOriginStillWorks(run.ctx, 'extension messaging'));
  } finally { await run.done(); }

  run = await launchViolentmonkey();
  try {
    report('E29 forged frame commands do nothing (userscript in Violentmonkey)', await attack(run.ctx, true));
    report('E29 cross-origin frames still work through GM storage (userscript in Violentmonkey)', await crossOriginStillWorks(run.ctx, 'GM storage'));
  } finally { await run.done(); }
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exitCode = failed ? 1 : 0;
})();
