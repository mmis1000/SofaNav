// Records a demo video of the test page being driven by a (virtual) controller.
// Usage: npm run serve   (in another terminal), then: npm run demo
// Output: demo/sofanav-demo.webm (+ .mp4 if ffmpeg is installed)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const URL = process.env.DEMO_URL || 'http://localhost:8765/test/';
const OUT_DIR = path.join(__dirname, '..', 'demo');
const SIZE = { width: 1280, height: 720 };

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: OUT_DIR, size: SIZE } });
  const page = await context.newPage();
  await page.goto(URL);
  await page.waitForTimeout(800);

  const wait = (ms) => page.waitForTimeout(ms);

  // Caption bar at the top of the page.
  const caption = (text) => page.evaluate((t) => {
    let c = document.getElementById('demoCaption');
    if (!c) {
      c = document.createElement('div');
      c.id = 'demoCaption';
      c.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'background:rgba(16,124,16,.95);color:#fff;font:600 20px system-ui,sans-serif;padding:10px 20px;' +
        'border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.5);pointer-events:none;max-width:90%;text-align:center';
      document.documentElement.append(c);
    }
    c.textContent = t;
    c.style.display = t ? 'block' : 'none';
  }, text);

  // Small on-screen "button pressed" badge, so viewers see the input.
  const showInput = (label) => page.evaluate((l) => {
    let b = document.getElementById('demoInput');
    if (!b) {
      b = document.createElement('div');
      b.id = 'demoInput';
      b.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;background:#111;color:#fff;' +
        'font:700 22px system-ui,sans-serif;padding:8px 16px;border-radius:10px;border:2px solid #4cd964;pointer-events:none';
      document.documentElement.append(b);
    }
    b.textContent = l;
    b.style.opacity = '1';
    clearTimeout(window.__demoInputT);
    window.__demoInputT = setTimeout(() => (b.style.opacity = '0'), 500);
  }, label);

  const LABEL = { ArrowUp: 'D-pad ↑', ArrowDown: 'D-pad ↓', ArrowLeft: 'D-pad ←', ArrowRight: 'D-pad →',
    Enter: 'A', Backspace: 'B', x: 'X', y: 'Y' };
  // Press a controller button through the test page's keyboard shim.
  const press = async (key, gap = 450) => {
    await showInput(LABEL[key] || key);
    await page.keyboard.down(key);
    await wait(90);
    await page.keyboard.up(key);
    await wait(gap);
    if (process.env.VERBOSE) await log(`  ${LABEL[key] || key}`);
  };
  const presses = async (key, n, gap) => { for (let i = 0; i < n; i++) await press(key, gap); };

  // Push a stick (left: 'L', right: 'R') at an angle for a while, then release.
  const stick = async (side, deg, ms, mag = 1) => {
    await showInput(`${side === 'L' ? 'Left' : 'Right'} stick ${deg}°`);
    await page.evaluate(([side, deg, mag]) => {
      const x = Math.cos(deg * Math.PI / 180) * mag, y = Math.sin(deg * Math.PI / 180) * mag;
      virtualPad.axes = side === 'L' ? [x, y, 0, 0] : [0, 0, x, y];
    }, [side, deg, mag]);
    await wait(ms);
    await page.evaluate(() => (virtualPad.axes = [0, 0, 0, 0]));
    await wait(350);
  };

  // Jump to a section and put focus on a starting element (debug hook), like a
  // viewer scrolling there and picking it.
  const section = async (startsWith, selector, offset = 90) => {
    await page.evaluate(async ([t, sel, off]) => {
      const h = [...document.querySelectorAll('h2')].find((x) => x.textContent.startsWith(t));
      scrollTo({ top: h.getBoundingClientRect().top + scrollY - off });
      // Let iframes report in before the first move (recording slows them down).
      await new Promise((r) => setTimeout(r, 200));
      await __sofanav.refreshFrames(); await __sofanav.refreshFrames();
      const el = sel.startsWith('text=')
        ? [...document.querySelectorAll('button, a')].find((x) => x.textContent.trim() === sel.slice(5))
        : document.querySelector(sel);
      __sofanav.focus(el);
    }, [startsWith, selector, offset]);
    await wait(500);
  };

  const focused = () => page.evaluate(() => {
    const el = __sofanav.current();
    if (!el) return 'none';
    if (!el.tagName) return `frame ${el.frame.iframe.id}#${el.id}`;
    return (el.id || el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20) || el.tagName);
  });
  const log = async (step) => console.log(step.padEnd(28), '→', await focused());

  // ---------------- the demo ----------------
  await caption('SofaNav — console-style controller navigation for any web page');
  await wait(1800);

  await section('Store layout', '.install', 60);
  await caption('D-pad moves between links and buttons by their position');
  await presses('ArrowRight', 4, 450); await log('→ x4 along the store row');
  await press('ArrowDown', 600); await log('↓ to the tabs');
  await presses('ArrowRight', 2, 500); await log('→ x2');
  await press('ArrowLeft', 500); await log('←');

  await caption('Y shows where each D-pad direction goes');
  await press('y', 900);
  await press('ArrowUp', 900); await log('↑ with graph');
  await presses('ArrowLeft', 2, 900); await log('← x2 with graph');

  await caption('The left stick aims freely — the pie shows where every angle lands');
  for (const deg of [-160, -110, -60, 0, 60]) { await stick('L', deg, 240); await wait(700); await log(`stick ${deg}°`); }

  await caption('Y again: the D-pad graph for the whole screen');
  await press('y', 2200);
  await press('y', 300); // graph off
  await caption('');

  await section('Containers', '[data-post="1"]');
  await caption('Post cards are one stop each — skim the feed card by card');
  await presses('ArrowDown', 2, 800); await log('↓ x2 cards');
  await press('ArrowUp', 800); await log('↑ card');
  await caption('X enters a card: only its contents exist until B');
  await press('x', 900); await log('X');
  await presses('ArrowRight', 2, 650); await log('→ x2');
  await press('ArrowDown', 650); await log('↓');
  await press('ArrowDown', 900); await log('↓ (edge: bumps)');
  await caption('B leaves the card');
  await press('Backspace', 1000); await log('B');

  await section('Scroll box', '#comments');
  await caption('Scrollable panels are one stop too — the right stick scrolls them directly');
  await wait(700);
  await stick('R', 90, 1000, 0.85);
  await stick('R', -90, 1000, 0.85);
  await caption('A enters the panel; moving past the bottom scrolls it');
  await press('Enter', 800); await log('A');
  await presses('ArrowDown', 10, 380); await log('↓ x10');
  await press('Backspace', 1000); await log('B');

  await section('Iframes', 'text=Before frames');
  await caption('Iframes — even cross-origin — are scroll containers too');
  await press('ArrowRight', 800); await log('→ frame stop');
  await stick('R', 90, 700, 0.85);
  await stick('R', -90, 700, 0.85);
  await caption('A enters the frame; past the last visible item it scrolls');
  await press('Enter', 700); await log('A (enter frame)');
  await presses('ArrowDown', 5, 600); await log('↓ x5 (frame scrolls)');
  await press('Backspace', 800); await log('B');
  await caption('Next frame is cross-origin: same controls');
  await press('ArrowRight', 700); await log('→ next frame');
  await press('x', 700); await log('X (enter)');
  await press('ArrowRight', 600); await log('→');
  await press('Enter', 900); await log('A (click in frame)');
  await press('Backspace', 600); await log('B');

  await section('Iframes', 'text=Left of flat frame', -60);
  await caption("A frame that doesn't scroll has no stop: its buttons belong to the page");
  await presses('ArrowRight', 4, 650); await log('→ x4 through the flat frame');
  await wait(500);

  await caption('SofaNav — D-pad, free-aim stick, cards, scroll panels, iframes');
  await wait(2000);

  // ---------------- save ----------------
  const video = page.video();
  await context.close();
  await browser.close();
  const raw = await video.path();
  const webm = path.join(OUT_DIR, 'sofanav-demo.webm');
  fs.renameSync(raw, webm);
  console.log('saved', path.relative(process.cwd(), webm));
  try {
    const mp4 = path.join(OUT_DIR, 'sofanav-demo.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', mp4]);
    console.log('saved', path.relative(process.cwd(), mp4));
  } catch {
    console.log('(ffmpeg not available: kept .webm only)');
  }
})();
