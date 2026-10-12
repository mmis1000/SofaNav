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
      await __sofanav.refreshFrames(); await __sofanav.refreshFrames();
      __sofanav.focus(el);
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
    const scopes = await page.evaluate(() => __sofanav.scopes().map((s) => s.id));
    for (let i = 0; i < 3; i++) await press('ArrowDown', 700);
    const r = await page.evaluate(() => ({ frameY: document.getElementById('sparseFrame').contentWindow.scrollY, pageY: scrollY }));
    const detail = `scopes=${scopes} frame scrollY=${r.frameY} page scrollY ${pageY0}→${r.pageY}`;
    return { ok: scopes[0] === 'sparseFrame' && r.frameY > 200 && Math.abs(r.pageY - pageY0) < 5, detail };
  },

  // E20: B must close a native <dialog> opened with showModal().
  async 'E20 B closes a native showModal() dialog'(page) {
    const { press, wait } = helpers(page);
    await press('ArrowUp');
    await page.evaluate(() => { document.getElementById('dlg').showModal(); __sofanav.focus(document.getElementById('ok')); });
    await wait(300);
    await press('Backspace');
    const open = await page.evaluate(() => document.getElementById('dlg').open);
    return { ok: !open, detail: `dialog.open=${open}` };
  },

  // E31: B must close a popup (X's account menu: no menu markup, on a full-screen mask) or a
  // popover, not go back a page; over something that ignores Escape it stays; holding B goes back.
  async 'E31 B closes popups instead of going back; holding B goes back'(page) {
    const { press, wait } = helpers(page);
    const open = (btn, sel) => page.evaluate(async ([b, s]) => {
      document.getElementById(b).scrollIntoView({ block: 'center' });
      document.getElementById(b).click();
      await new Promise((r) => setTimeout(r, 300));
      __sofanav.focus(document.querySelector(s));
    }, [btn, sel]);
    await press('ArrowUp');
    await page.evaluate(() => { location.hash = 'before-menu'; });
    // As on X: from the menu's scroll box, X then ↓ lands on the role="group" (as in the user's
    // debug report); one B must close the menu.
    await open('menuBtn', '#xScroll');
    await wait(300);
    await press('KeyX');
    await press('ArrowDown');
    const inside = await page.evaluate(() => { const c = __sofanav.current(); return c.id || c.tagName; });
    await press('Backspace', 700);
    const menu = await page.evaluate(() => ({ open: !document.getElementById('xMenu').hidden, hash: location.hash }));
    if (menu.hash !== '#before-menu') return { ok: false, detail: `B went back a page (X-style menu open=${menu.open})` };
    if (menu.open) return { ok: false, detail: `X-style menu still open after one B from #${inside}` };
    await open('popBtn', '#pop button');
    await wait(300);
    await press('Backspace', 700);
    const pop = await page.evaluate(() => ({ open: !!document.getElementById('pop')?.matches(':popover-open'), hash: location.hash }));
    await open('stuckBtn', '#menu');
    await wait(300);
    await press('Backspace', 700);
    const stuck = await page.evaluate(() => ({ open: !document.getElementById('menuLayer').hidden, hash: location.hash }));
    await page.keyboard.down('Backspace'); await wait(1000); await page.keyboard.up('Backspace'); await wait(500);
    const held = await page.evaluate(() => location.hash);
    const ok = !menu.open && !pop.open && pop.hash === '#before-menu' && stuck.hash === '#before-menu' && held === '';
    return { ok, detail: `X-style menu (B from #${inside}) open=${menu.open}, popover open=${pop.open}, stuck overlay: B ${stuck.hash === '#before-menu' ? 'stayed' : 'went back'}, hold B ${held === '' ? 'went back' : 'stayed'}` };
  },

  // E21: a frame that navigates to a page without the script must become one plain element.
  async 'E21 frame that loses its client becomes a plain element'(page) {
    const { press, wait } = helpers(page);
    await press('ArrowUp');
    const before = await page.evaluate(async () => {
      const f = document.getElementById('navFrame');
      f.scrollIntoView({ block: 'center' });
      await __sofanav.refreshFrames(); await __sofanav.refreshFrames();
      return __sofanav.frameState(f).hasClient;
    });
    await page.evaluate(() => document.getElementById('swapFrame').click());
    await wait(800);
    const after = await page.evaluate(async () => {
      const f = document.getElementById('navFrame');
      await __sofanav.refreshFrames(); await __sofanav.refreshFrames();
      const c = __sofanav.candidates();
      return { hasClient: __sofanav.frameState(f).hasClient, frameIsElement: c.includes(f),
        staleProxies: c.filter((e) => !e.tagName && e.frame.iframe === f).length };
    });
    const detail = `before hasClient=${before}; after hasClient=${after.hasClient} plain=${after.frameIsElement} stale proxies=${after.staleProxies}`;
    return { ok: before && !after.hasClient && after.frameIsElement && after.staleProxies === 0, detail };
  },

  // E22: a scrolling list inside a non-scrolling frame (YouTube live chat) is a container you can
  // enter; past its visible part the list scrolls; B returns to it.
  async 'E22 chat list inside a frame is an enterable scroll container'(page) {
    const { press, wait } = helpers(page);
    await page.evaluate(() => { history.back = () => {}; });
    await press('ArrowUp');
    await page.evaluate(async () => {
      const f = document.getElementById('chatMenus');
      f.scrollIntoView({ block: 'center' });
      f.contentDocument.getElementById('item-scroller').scrollTop = 1e6;
      await new Promise((r) => setTimeout(r, 300));
      await __sofanav.refreshFrames(); await __sofanav.refreshFrames();
      __sofanav.focus([...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Before chats'));
    });
    const listTop = () => page.evaluate(() => document.getElementById('chatMenus').contentDocument.getElementById('item-scroller').scrollTop);
    const atList = () => page.evaluate(() => { const c = __sofanav.current(); return !!c && !c.tagName && c.frame.iframe.id === 'chatMenus' && __sofanav.isScrollContainer(c); });
    for (let i = 0; i < 3 && !(await atList()); i++) await press('ArrowRight');
    const onList = await atList();
    await press('Enter'); // A enters the list
    const entered = await page.evaluate(() => __sofanav.scopes().length === 1);
    const before = await listTop();
    for (let i = 0; i < 12; i++) await press('ArrowUp', 350);
    const after = await listTop();
    await press('Backspace');
    const back = await page.evaluate(() => __sofanav.scopes().length === 0) && await atList();
    return { ok: onList && entered && after < before - 50 && back, detail: `list stop=${onList} entered=${entered} list scrollTop ${Math.round(before)}→${Math.round(after)} B back on list=${back}` };
  },

  // E22: the same list with nothing focusable in it is still a stop the right stick scrolls.
  async 'E22 chat list without buttons is a right-stick scroll stop'(page) {
    const { press, wait } = helpers(page);
    await press('ArrowUp');
    await page.evaluate(async () => {
      const h = [...document.querySelectorAll('h2')].find((x) => x.textContent.startsWith('Live chat frames'));
      scrollTo({ top: h.getBoundingClientRect().top + scrollY - 60 });
      await new Promise((r) => setTimeout(r, 300));
      await __sofanav.refreshFrames(); await __sofanav.refreshFrames();
      __sofanav.focus([...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Before chats'));
    });
    await wait(300);
    await press('ArrowRight');
    const stop = await page.evaluate(() => { const c = __sofanav.current(); return !!c && !c.tagName && c.frame.iframe.id === 'chatPlain' && __sofanav.isScrollStop(c); });
    const top = () => page.evaluate(() => document.getElementById('chatPlain').contentDocument.getElementById('item-scroller').scrollTop);
    const t0 = await top();
    await page.evaluate(() => (virtualPad.axes = [0, 0, 0, -0.9])); await wait(600); await page.evaluate(() => (virtualPad.axes = [0, 0, 0, 0])); await wait(300);
    const t1 = await top();
    return { ok: stop && t1 < t0 - 100, detail: `scroll stop=${stop} right stick: scrollTop ${Math.round(t0)}→${Math.round(t1)}` };
  },

  // E24: focus left on an element that is no longer a stop (Twitter: the timeline column after a
  // page change) must re-anchor onto a stop, not skip everything inside it.
  async 'E24 focus on a non-stop wrapper re-anchors instead of skipping its contents'(page) {
    const { press, wait } = helpers(page);
    await press('ArrowUp');
    await page.evaluate(async () => {
      const feed = document.querySelector('.feed');
      feed.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 300));
      __sofanav.focus(feed); // simulate the desync: focus on a wrapper that isn't a stop
    });
    await wait(300);
    await press('ArrowDown');
    const r = await page.evaluate(() => {
      const c = __sofanav.current();
      const card = c?.closest?.('[data-post]');
      return { card: card?.dataset.post || null, what: c ? (c.className || c.tagName) + ' ' + (c.textContent || '').trim().slice(0, 20) : 'none' };
    });
    return { ok: !!r.card, detail: `after ↓: ${r.card ? 'card ' + r.card : r.what}` };
  },

  // E25: the button hint must stay on screen, also for a stop taller than the screen.
  async 'E25 hint stays on screen for a stop taller than the screen'(page) {
    const { press, wait } = helpers(page);
    await page.setViewportSize({ width: 1280, height: 180 }); // the 200px comments panel no longer fits
    await press('ArrowUp');
    await page.evaluate(async () => {
      const box = document.getElementById('comments');
      box.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 300));
      __sofanav.candidates();
      __sofanav.focus(box);
    });
    await wait(400);
    const r = await page.evaluate(() => {
      const h = [...document.documentElement.children].filter((e) => e.tagName === 'DIV').find((e) => e.style.whiteSpace === 'nowrap');
      const b = h.getBoundingClientRect();
      return { shown: h.style.display !== 'none', text: h.textContent, rect: [b.left, b.top, b.right, b.bottom].map(Math.round), vw: innerWidth, vh: innerHeight };
    });
    const inside = r.rect[0] >= 0 && r.rect[1] >= 0 && r.rect[2] <= r.vw && r.rect[3] <= r.vh;
    return { ok: r.shown && inside, detail: `hint "${r.text}" at ${r.rect} in ${r.vw}x${r.vh}` };
  },

  // E26: after an SPA page change, focus must not stay on the new page's loading placeholder
  // (an empty focusable timeline that later grows into a page-sized wrapper).
  async 'E26 SPA page change does not leave focus on a loading placeholder'(page) {
    const { press, wait } = helpers(page);
    await press('ArrowUp');
    await page.evaluate(async () => {
      const b = document.getElementById('spaBack');
      b.scrollIntoView({ block: 'start' });
      await new Promise((r) => setTimeout(r, 300));
      __sofanav.candidates();
      __sofanav.focus(b);
    });
    await wait(300);
    await press('Enter', 100); // A on "Back": the page "navigates"
    await wait(2500); // timeline fills in after 700 ms
    const r = await page.evaluate(() => {
      const c = __sofanav.current();
      return { tag: c?.tagName, id: c?.id || '', text: (c?.textContent || '').trim().slice(0, 16), isStop: __sofanav.candidates().includes(c) };
    });
    const onPlaceholder = r.id === 'spaTimeline';
    return { ok: !onPlaceholder && r.isStop, detail: `focus: ${r.tag}${r.id ? '#' + r.id : ''} "${r.text}" stop=${r.isStop}` };
  },

  // E27: an element beside the focused one whose corner nearly touches it must not count as "ahead".
  async 'E27 up from a post goes to the reply box, not a sidebar link at its corner'(page) {
    const { press, wait } = helpers(page);
    await press('ArrowUp');
    await page.evaluate(async () => {
      const post = document.getElementById('nmPost');
      post.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 300));
      __sofanav.candidates();
      __sofanav.focus(post);
    });
    await wait(300);
    await press('ArrowUp');
    const id = await page.evaluate(() => __sofanav.current()?.id);
    return { ok: id === 'nmReply', detail: `↑ from the post → ${id}` };
  },

  // E28: the hint hides while its element is scrolled off screen (instead of being clamped onto it).
  async 'E28 hint hides when its element scrolls off screen'(page) {
    const { press, wait } = helpers(page);
    await press('ArrowUp');
    await page.evaluate(async () => {
      const card = document.querySelector('[data-post="1"]');
      card.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 300));
      __sofanav.candidates();
      __sofanav.focus(card);
    });
    await wait(400);
    const hint = () => page.evaluate(() => {
      const h = [...document.documentElement.children].filter((e) => e.tagName === 'DIV').find((e) => e.style.whiteSpace === 'nowrap');
      return h.style.display !== 'none' ? h.textContent : null;
    });
    const before = await hint();
    await page.evaluate(() => scrollBy(0, 2000)); // the card is now far above the screen
    await wait(400);
    const after = await hint();
    return { ok: !!before && after === null, detail: `on screen: "${before}" · scrolled away: ${after === null ? 'hidden' : '"' + after + '"'}` };
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
