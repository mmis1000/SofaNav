// ==UserScript==
// @name         Gamepad Spatial Navigation
// @namespace    gamepad-spatial-nav
// @version      0.3.0.202610121517
// @description  Navigate web pages with a controller: D-pad / left stick move focus, A click, B back, X enter, Y graph view. (build def5ba84a658)
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
// Generated from extension/content.js by build-userscript.js. Edit that file, not this one.
// Build def5ba84a658 = first 12 hex digits of sha256(extension/content.js).
// LB/RB (switch tabs) needs the extension; in a userscript they do nothing.

// Gamepad spatial navigation: D-pad / left stick moves a focus ring between
// interactive elements by on-screen geometry (like a console UI), not a cursor.
(() => {
  if (window.__gamepadNav) return;
  window.__gamepadNav = true;
  // In a frame this script is only a client: it reports its elements to the
  // parent and carries out commands; the top frame does all navigation.
  const IS_FRAME = window.top !== window;
  // Replaced with the content hash by build-userscript.js; 'dev' when loaded unbuilt (extension, test pages).
  const BUILD = 'def5ba84a658';
  if (!IS_FRAME) console.info('[webpad] build', BUILD);

  // Standard-mapping button indexes.
  const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
  const STICK_PRESS = 0.55; // stick deflection that counts as pushing
  const STICK_RELEASE = 0.45; // ...and that it must drop below to count as released (keep close to STICK_PRESS)
  const STICK_SETTLE = 40; // ms to let a stick push finish before reading its angle
  const STICK_CALM_MS = 80; // after a release, the stick must rest near center this long before it counts again
  const STICK_BOUNCE_MAX_MS = 250; // ...but never ignore it longer than this
  const SCROLL_DEADZONE = 0.2;
  const REPEAT_DELAY = 400; // pause after the first move before repeating
  const REPEAT_INTERVAL = 120; // fastest repeat: at most ~8 moves per second
  const SCROLL_SPEED = 28;
  const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const DIRS = Object.keys(OPPOSITE);
  // Two independent ways to move (angles in degrees, screen-style: 0 = right, 90 = down):
  //  - D-pad: 4 directions, scored graph (score() / buildGraph()).
  //  - Left stick: free aim at any angle. A ray from the focused element's center
  //    goes to the first element it hits; wedges narrower than MIN_WEDGE are
  //    merged into a neighbour (angleTable()). The D-pad graph is not used.
  const DIR_ANGLE = { right: 0, down: 90, left: 180, up: -90 };
  // D-pad scoring: distance x (1/cos(angle off the pressed direction)) ** ANGLE_PENALTY.
  // Higher = stronger preference for items in the same row/column; lower = more
  // willing to go diagonal (fewer unreachable items).
  const ANGLE_PENALTY = 1;
  const MAX_DEVIATION = 70; // degrees; anything further off the pressed direction is never a target
  // For boxes that don't overlap sideways at all, the angle between their centers too:
  // two boxes can almost touch at a corner (a sidebar link next to a feed post), which makes
  // the gap look 45° off and tiny although the target is really beside, not ahead.
  const MAX_CENTER_DEVIATION = 60;
  const RAY_PAD = 4; // px added around each element so rays don't slip through small gaps
  const MIN_WEDGE = 10; // degrees
  const AIM_TOLERANCE = 30; // a ray that hits nothing still takes an element within this many degrees
  const HYSTERESIS = 16; // degrees the stick must turn before it counts as a new direction
  const RETURN_TOLERANCE = 20; // pushing within this of the reverse angle goes back where you came from
  const angDiff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
  // Nearest of the 4 directions (for scrolling when a stick push finds nothing).
  const dominantDir = (angle) => DIRS.reduce((a, b) => (angDiff(angle, DIR_ANGLE[b]) < angDiff(angle, DIR_ANGLE[a]) ? b : a));

  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[tabindex]:not([tabindex="-1"])', '[contenteditable=""]', '[contenteditable="true"]',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=menuitemradio]',
    '[role=menuitemcheckbox]', '[role=option]', '[role=checkbox]', '[role=radio]',
    '[role=switch]', '[role=treeitem]', '[role=slider]',
  ].join(',');

  let enabled = true;
  let current = null;
  let lastMove = null; // {from, to, angle} so pushing the opposite way returns
  let scrolledAway = false; // user scrolled manually since focus last moved
  let prevButtons = [];
  // phase: idle -> settle (stick only) -> held. See handleDirection.
  const held = { phase: 'idle', stick: false, angle: null, since: 0, next: 0, lastMoveAt: -Infinity, releasedAt: null, calmSince: null };
  let looping = false;
  let ring, toast, toastTimer, hint, scopeBox;

  // ---------- candidate discovery ----------

  function collect(root, out) {
    for (const el of root.querySelectorAll(SELECTOR)) out.push(el);
    for (const host of shadowHosts(root)) if (host.shadowRoot) collect(host.shadowRoot, out);
    return out;
  }

  // Finding open shadow roots means visiting every element, which is slow on big
  // pages (Twitter), so the document-wide scan is reused for up to SHADOW_SCAN_MS.
  const SHADOW_SCAN_MS = 1000;
  let docHosts = [], docHostsAt = -Infinity;
  function shadowHosts(root) {
    const scan = () => [...root.querySelectorAll('*')].filter((el) => el.shadowRoot);
    if (root !== document) return scan();
    const now = performance.now();
    if (now - docHostsAt > SHADOW_SCAN_MS) { docHosts = scan(); docHostsAt = now; }
    return docHosts;
  }

  function containsDeep(a, b) {
    for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true;
    return false;
  }

  function activeModal() {
    const modals = [...document.querySelectorAll('dialog[open], [aria-modal="true"]')];
    return modals.reverse().find((m) => m.getBoundingClientRect().width > 0) || null;
  }

  function usable(el) {
    if (el instanceof RemoteEl) return remoteVisible(el);
    if (!el?.isConnected || el.disabled) return false;
    if (el.closest('[inert], [aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') return false;
    if (!inViewport(r) && !reachable(el, r, cs)) return false;
    // Skip elements covered by something else (only checkable when on screen).
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) {
      const hit = document.elementFromPoint(x, y);
      if (hit && !containsDeep(el, hit) && !containsDeep(hit, el)) {
        // Shadow DOM: elementFromPoint returns the host.
        const host = el.getRootNode().host;
        if (!host || !containsDeep(hit, host)) return false;
      }
    }
    return true;
  }

  // Off-screen element that no scrolling can bring into view: parked off-canvas
  // drawers and menus (cut off by overflow:hidden/clip, e.g. body overflow-x:hidden),
  // inside a position:fixed panel, or before the page's start.
  let styleCache = null; // per candidates() call
  const styleOf = (n) => {
    if (!styleCache) return getComputedStyle(n);
    let cs = styleCache.get(n);
    if (!cs) styleCache.set(n, (cs = getComputedStyle(n)));
    return cs;
  };

  function reachable(el, r, ownStyle) {
    if (r.right + scrollX <= 0 || r.bottom + scrollY <= 0) return false;
    if (ownStyle.position === 'fixed') return false;
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = styleOf(n);
      if (cs.position === 'fixed') return false;
      const clipX = /hidden|clip/.test(cs.overflowX), clipY = /hidden|clip/.test(cs.overflowY);
      if (clipX || clipY) {
        const b = n.getBoundingClientRect();
        if (clipX && (r.right <= b.left || r.left >= b.right)) return false;
        if (clipY && (r.bottom <= b.top || r.top >= b.bottom)) return false;
      }
    }
    return true;
  }

  function candidates() {
    styleCache = new Map();
    try { return candidatesNow(); } finally { styleCache = null; }
  }

  function candidatesNow() {
    const modal = activeModal();
    // Cheap position check first: elements far off screen are never targets (scrolling reaches them).
    const found = collect(modal || document, []).filter((el) => nearViewport(el.getBoundingClientRect()) && usable(el));
    addScrollBoxes(found);
    addScrollOnlyBoxes(found);
    // Only the top layer of the current scope: a container's contents stay hidden until it is entered (X).
    // Frames do this too, against their own scope stack (kept in step by the top frame).
    const scope = activeScope(modal);
    const all = layer(found, scope);
    if (IS_FRAME) return all; // nested frames aren't handled
    // Elements inside iframes appear as RemoteEl proxies; an iframe without a client is one plain element.
    const remoteScope = scope instanceof RemoteEl ? scope : null;
    for (const iframe of document.querySelectorAll('iframe')) {
      if (modal && !modal.contains(iframe)) continue;
      // Inside a container that lives in a frame, only that frame's (already scoped) elements exist.
      if (remoteScope ? remoteScope.frame.iframe !== iframe : scope ? !scope.contains(iframe) : insideContainer(iframe)) continue;
      const f = frameState(iframe);
      if (f.hasClient && f.scroll?.scrollable && scope !== iframe && !remoteScope) {
        // A frame whose page scrolls is a scroll container like any panel: one stop until entered.
        if (usable(iframe)) {
          all.push(iframe);
          scrollBoxes.add(iframe);
          containerKids.set(iframe, [...f.remotes.values()].filter(remoteVisible).length);
        }
      } else if (f.hasClient) { for (const r of f.remotes.values()) if (!r.isScope && remoteVisible(r)) all.push(r); }
      else if (usable(iframe)) all.push(iframe);
    }
    return all;
  }

  // ---------- containers and scopes ----------
  // A container is a focusable element with focusable elements inside (a Twitter
  // post card: the card opens the post, the avatar/name/buttons inside do their
  // own thing). Like a TV app, navigation sees only the card; X enters it, after
  // which only its contents exist; B leaves and focus returns to the card.
  // Scopes stack for nested containers. Two kinds of wrapper don't count:
  // page-sized ones (they would hide the whole page behind X) and ones around a
  // single item (the item itself is kept).

  const BIG_CONTAINER = 0.5; // share of the viewport above which a container is ignored
  // In a frame, "the viewport" for that rule is the top window (sent with each snapshot
  // request): a chat list filling its small chat frame is a container, not the page.
  let topViewportArea = null;
  const viewportArea = () => topViewportArea || innerWidth * innerHeight;
  const scopes = []; // entered containers, innermost last
  let containerKids = new Map(); // container -> number of items inside (from the last candidates() call)
  let outerOf = new Map(); // element -> its effective container (or null)

  const upOne = (n) => (n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentElement);

  // The scope in force: the innermost entered container, unless a dialog that
  // isn't inside it is open (then the dialog is the boundary until it closes).
  function activeScope(modal = activeModal()) {
    const top = scopes[scopes.length - 1] || null;
    return top && (!modal || modal.contains(nodeOf(top))) ? top : null;
  }

  // The DOM node standing for an element: a frame element's iframe.
  const nodeOf = (el) => (el instanceof RemoteEl ? el.frame.iframe : el);

  // From candidates, keep those directly inside `scope` (or at top level) and
  // record which of them are containers.
  function layer(found, scope) {
    const set = new Set(found);
    for (const sc of scopes) set.add(sc); // entered containers count even if scrolled partly away
    const parentOf = new Map();
    for (const el of set) {
      let p = null;
      for (let n = upOne(el); n; n = upOne(n)) if (set.has(n)) { p = n; break; }
      parentOf.set(el, p);
    }
    const kids = new Map();
    for (const el of set) {
      const p = parentOf.get(el);
      if (p) (kids.get(p) || kids.set(p, []).get(p)).push(el);
    }
    const vpArea = viewportArea();
    const ignored = new Set();
    for (const [c, ks] of kids) {
      if (scopes.includes(c)) continue;
      const r = c.getBoundingClientRect();
      if (r.width * r.height > vpArea * BIG_CONTAINER) ignored.add(c); // page-wide wrapper: see through it
      else if (ks.length === 1 && !kids.has(ks[0]) && !scrollBoxes.has(c)) ignored.add(c); // wraps one item: keep the item instead
    }
    const outer = (el) => { let p = parentOf.get(el); while (p && ignored.has(p)) p = parentOf.get(p); return p; };
    containerKids = new Map();
    outerOf = new Map();
    for (const el of set) {
      if (ignored.has(el)) continue;
      const o = outer(el);
      outerOf.set(el, o);
      if (o) containerKids.set(o, (containerKids.get(o) || 0) + 1);
    }
    return found.filter((el) => !ignored.has(el) && el !== scope && outerOf.get(el) === scope);
  }

  // An iframe inside some (not entered) container belongs to that container's contents.
  function insideContainer(el) {
    for (const c of containerKids.keys()) if (c !== el && c.contains(el)) return true;
    return false;
  }

  // Items inside a container (frame containers report their own count).
  const kidsOf = (el) => (el instanceof RemoteEl ? el.kids || 0 : containerKids.get(el) || 0);
  const isContainer = (el) => kidsOf(el) > 0;

  // Scrollable areas (comment panels, chat, side lists) are containers too, even
  // when the page didn't make them focusable: one stop whose contents you enter
  // with A or X, and which the right stick scrolls directly while it's focused.
  let scrollBoxes = new Set(); // from the last candidates() call

  function isScrollBox(n) {
    if (n === document.body || n === document.documentElement) return false;
    const cs = styleOf(n);
    return (/(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) ||
      (/(auto|scroll|overlay)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1);
  }

  // Add the scroll boxes that hold candidates (each found once by walking up).
  function addScrollBoxes(found) {
    scrollBoxes = new Set();
    const seen = new Set();
    for (const el of [...found]) {
      for (let n = upOne(el); n && n !== document.body && n !== document.documentElement; n = upOne(n)) {
        if (seen.has(n)) break;
        seen.add(n);
        if (!isScrollBox(n)) continue;
        scrollBoxes.add(n);
        if (!found.includes(n) && nearViewport(n.getBoundingClientRect()) && usable(n)) found.push(n);
      }
    }
  }

  // Scroll boxes with nothing focusable inside (live chat, logs, code blocks):
  // still a stop, so the right stick can scroll them; there is nothing to enter.
  let scrollOnly = new Set(); // from the last candidates() call
  const SCROLL_SCAN_MS = 1000; // finding them means checking every element, so the scan is reused this long
  const MIN_SCROLL_BOX = [120, 60]; // px; smaller scrolling areas aren't worth a stop
  let scanBoxes = [], scanAt = -Infinity;

  function addScrollOnlyBoxes(found) {
    scrollOnly = new Set();
    const now = performance.now();
    if (now - scanAt > SCROLL_SCAN_MS) {
      scanAt = now;
      scanBoxes = [];
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        // Cheap size test first; computed style only for elements that overflow at all.
        if (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1) if (isScrollBox(n)) scanBoxes.push(n);
      }
    }
    const vpArea = viewportArea();
    for (const n of scanBoxes) {
      if (scrollBoxes.has(n) || !n.isConnected || !isScrollBox(n)) continue;
      const r = n.getBoundingClientRect();
      if (!inViewport(r) || r.width < MIN_SCROLL_BOX[0] || r.height < MIN_SCROLL_BOX[1]) continue;
      if (r.width * r.height > vpArea * BIG_CONTAINER || !usable(n)) continue; // page-sized: that's the page scrolling
      scrollBoxes.add(n);
      scrollOnly.add(n);
      if (!found.includes(n)) found.push(n);
    }
  }

  const isScrollContainer = (el) => (el instanceof RemoteEl ? !!el.scrollInfo : scrollBoxes.has(el)) && isContainer(el);
  // A stop the right stick scrolls: a scroll container, or a scroll box with nothing to enter.
  const isScrollStop = (el) => isScrollContainer(el) ||
    (el instanceof RemoteEl ? !!el.scrollInfo && el.scrollOnly : scrollOnly.has(el));
  // A scroll box the page itself doesn't treat as clickable: A enters it instead of clicking.
  const enterOnA = (el) => isScrollContainer(el) && !(el instanceof RemoteEl ? el.native : el.matches(SELECTOR));

  // Room left to scroll el in a direction.
  function canScroll(el, dir) {
    if (el instanceof RemoteEl) return !!el.scrollInfo?.[dir];
    if (el.tagName === 'IFRAME') {
      const s = frameState(el).scroll;
      if (!s) return false;
      return { down: s.top < s.maxTop - 1, up: s.top > 0, right: s.left < s.maxLeft - 1, left: s.left > 0 }[dir];
    }
    return {
      down: el.scrollTop + el.clientHeight < el.scrollHeight - 1, up: el.scrollTop > 0,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1, left: el.scrollLeft > 0,
    }[dir];
  }

  // What the right stick / LT / RT scroll: a focused scroll box itself, else whatever contains focus.
  const scrollTarget = (axis) => (current && isScrollStop(current) ? current : scrollParent(current, axis));

  async function enterScope() {
    if (!current || !isContainer(current)) return;
    const container = current;
    scopes.push(container);
    if (container instanceof RemoteEl) {
      // The frame scopes its own snapshot; ask for a fresh one taken inside the container.
      postToFrame(container.frame, { type: 'enter', id: container.id });
      await refreshFrames();
    }
    const list = candidates();
    if (!list.length) { leaveScopeTop(); return; }
    // First item in reading order, preferring ones on screen.
    const onScreen = list.filter((el) => inViewport(el.getBoundingClientRect()));
    const order = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.top / 16) * 100000 + r.left; };
    const first = (onScreen.length ? onScreen : list).reduce((a, b) => (order(b) < order(a) ? b : a));
    lastMove = null;
    setCurrent(first);
  }

  // Pop the innermost scope (telling its frame, if it lives in one).
  function leaveScopeTop() {
    const container = scopes.pop();
    if (container instanceof RemoteEl) postToFrame(container.frame, { type: 'leave' });
    return container;
  }

  async function leaveScope() {
    const container = leaveScopeTop();
    if (!container) return false;
    lastMove = null;
    if (container instanceof RemoteEl) await refreshFrames(); // the frame lists the container again
    candidates(); // refresh container info for the hint
    if (container.isConnected && !gone(container)) setCurrent(container);
    else recoverFocus();
    return true;
  }

  // Containers that vanished (feed recycled the card, dialog closed...) end their scopes.
  function checkScopes() {
    let changed = false;
    while (scopes.length) {
      const top = scopes[scopes.length - 1];
      if (top.isConnected && !gone(top)) break;
      leaveScopeTop();
      changed = true;
    }
    if (changed) { candidates(); recoverFocus(); updateHint(); }
  }

  // Nothing further inside the scope: shake the ring instead of leaving it.
  function bump(dir) {
    if (!ring) return;
    const d = { left: [-5, 0], right: [5, 0], up: [0, -5], down: [0, 5] }[dir];
    ring.animate([{ translate: '0 0' }, { translate: `${d[0]}px ${d[1]}px` }, { translate: '0 0' }], { duration: 160 });
  }

  // ---------- frames ----------
  // Each frame runs this script as a client (startClient). The top frame asks
  // every iframe for its elements before each move and wraps them in RemoteEl
  // proxies whose rects are translated into top-frame coordinates, so scoring,
  // the stick pie, focus recovery and the ring treat them like any element.
  // Prototype limits: one level of frames, postMessage transport.

  const PROTO = 'gpn-1';
  const FRAME_TIMEOUT = 60; // ms to wait for frames to answer a snapshot request

  class RemoteEl {
    constructor(frame, id) {
      this.frame = frame;
      this.id = id;
      this.local = null; // rect in the frame's own viewport
      this.anc = []; // ids of candidate ancestors inside the frame
      this.text = false; // text input (A focuses it instead of clicking)
      this.alive = false; // present in the latest snapshot
      this.goneFlag = false; // the frame reported it removed/hidden
      this.kids = 0; // items inside, if it's a container
      this.scrollInfo = null; // {up, down, left, right}: room to scroll, if it's a scroll box
      this.scrollOnly = false; // scroll box with nothing focusable inside
      this.native = false; // focusable/clickable in its own right
      this.isScope = false; // the frame's current scope (reported only to stay alive)
    }
    get isConnected() { return this.frame.iframe.isConnected && this.alive && !this.goneFlag; }
    getBoundingClientRect() { return toTop(this.frame, this.local); }
    focus() {
      try { this.frame.iframe.focus({ preventScroll: true }); } catch {}
      postToFrame(this.frame, { type: 'focus', id: this.id });
    }
    scrollIntoView(opts) { this.frame.iframe.scrollIntoView(opts); }
  }

  const frames = new WeakMap(); // iframe -> state
  function frameState(iframe) {
    let f = frames.get(iframe);
    if (!f) frames.set(iframe, (f = { iframe, hasClient: false, answered: false, remotes: new Map(), vw: 1, vh: 1 }));
    return f;
  }

  function postToFrame(f, msg) {
    try { f.iframe.contentWindow?.postMessage({ gpn: PROTO, ...msg }, '*'); } catch {}
  }

  // Frame-viewport rect -> top viewport rect, clipped to the iframe's content box.
  function toTop(f, l, clip = true) {
    const empty = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    if (!l || !f.iframe.isConnected) return empty;
    const ir = f.iframe.getBoundingClientRect();
    const cs = getComputedStyle(f.iframe);
    const sx = f.iframe.offsetWidth ? ir.width / f.iframe.offsetWidth : 1; // CSS transform scale
    const sy = f.iframe.offsetHeight ? ir.height / f.iframe.offsetHeight : 1;
    const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
    const padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
    const ox = ir.left + (f.iframe.clientLeft + padL) * sx;
    const oy = ir.top + (f.iframe.clientTop + padT) * sy;
    const cw = (f.iframe.clientWidth - padL - padR) * sx, ch = (f.iframe.clientHeight - padT - padB) * sy;
    const kx = cw / f.vw, ky = ch / f.vh;
    let left = ox + l.left * kx, right = ox + l.right * kx, top = oy + l.top * ky, bottom = oy + l.bottom * ky;
    if (clip) {
      left = Math.max(left, ox); right = Math.min(right, ox + cw);
      top = Math.max(top, oy); bottom = Math.min(bottom, oy + ch);
    }
    if (right <= left || bottom <= top) return empty;
    return { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top };
  }

  // Visible in the top frame: not clipped away, and the iframe isn't covered there.
  function remoteVisible(r) {
    if (!r.alive || r.goneFlag) return false;
    const b = r.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) return false;
    const x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2;
    if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) return document.elementFromPoint(x, y) === r.frame.iframe;
    return true;
  }

  let reqSeq = 0;
  const pending = new Map(); // req -> (frameState, data) => void

  // Ask every iframe for its elements; resolves when all answered or after FRAME_TIMEOUT.
  function refreshFrames() {
    const list = [...document.querySelectorAll('iframe')];
    if (!list.length) return Promise.resolve();
    const req = ++reqSeq;
    const answered = new Set();
    return new Promise((resolve) => {
      const done = () => { pending.delete(req); clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, FRAME_TIMEOUT);
      pending.set(req, (f, d) => {
        if (answered.has(f)) return;
        answered.add(f);
        applySnapshot(f, d);
        if (answered.size === list.length) done();
      });
      for (const iframe of list) postToFrame(frameState(iframe), { type: 'snapshot', req, vpArea: innerWidth * innerHeight });
    }).then(() => {
      // A frame that has never answered has no client (sandboxed, blocked...): it stays one plain element.
      // One that stops answering (client gone without a load event) becomes one after FRAME_MISSES rounds;
      // a single miss keeps the last data, since slow frames are common.
      for (const iframe of list) {
        const f = frameState(iframe);
        if (answered.has(f)) continue;
        if (!f.answered) f.hasClient = false;
        else if (++f.misses >= FRAME_MISSES) resetFrame(f);
      }
    });
  }

  // The frame's document changed (it navigated, or its srcdoc was replaced): what
  // we knew about the old document no longer applies. Old proxies are marked dead
  // so anything still holding one (focus, lastMove) recovers through gone().
  function resetFrame(f) {
    if (!f) return;
    for (const r of f.remotes.values()) r.alive = false;
    f.remotes = new Map();
    f.answered = f.hasClient = false;
    f.scroll = undefined;
    f.misses = 0;
  }
  // iframe load events don't bubble, but they can be caught on the way down.
  if (!IS_FRAME) document.addEventListener('load', (e) => { if (e.target?.tagName === 'IFRAME') resetFrame(frames.get(e.target)); }, true);
  const FRAME_MISSES = 2; // consecutive unanswered snapshots after which a frame counts as client-less

  function applySnapshot(f, d) {
    f.hasClient = f.answered = true;
    f.misses = 0;
    f.scroll = d.scroll;
    f.vw = d.vw || 1; f.vh = d.vh || 1;
    for (const r of f.remotes.values()) r.alive = false;
    const next = new Map();
    for (const item of d.items) {
      const r = f.remotes.get(item.id) || new RemoteEl(f, item.id);
      Object.assign(r, { local: item.rect, anc: item.anc, text: item.text, kids: item.kids || 0, scrollInfo: item.scroll || null,
        scrollOnly: !!item.scrollOnly, native: !!item.native, isScope: !!item.isScope, alive: true, goneFlag: false });
      next.set(item.id, r);
    }
    f.remotes = next; // dropped proxies stay alive=false for anyone still holding them (current, lastMove)
  }

  function frameOfSource(source) {
    for (const iframe of document.querySelectorAll('iframe')) if (iframe.contentWindow === source) return frameState(iframe);
    return null;
  }

  // Replies from clients. Only messages from our own child frames are accepted.
  if (!IS_FRAME) addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.gpn !== PROTO) return;
    const f = frameOfSource(e.source);
    if (!f) return;
    if (d.type === 'snapshot-reply') pending.get(d.req)?.(f, d);
    else if (d.type === 'back-reply') pending.get(d.req)?.(f, d);
    else if (d.type === 'focused') {
      const r = f.remotes.get(d.id);
      if (!r) return;
      f.vw = d.vw || f.vw; f.vh = d.vh || f.vh;
      if (d.rect) r.local = d.rect;
      r.goneFlag = !!d.gone;
    }
  });

  // Ask the frame to handle B (leave a text field); resolves true if it did.
  function askFrameBack(f) {
    const req = ++reqSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(req); resolve(false); }, FRAME_TIMEOUT);
      pending.set(req, (from, d) => { if (from !== f) return; clearTimeout(timer); pending.delete(req); resolve(!!d.handled); });
      postToFrame(f, { type: 'back', req });
    });
  }

  // ---------- frame client ----------

  function startClient() {
    const ids = new WeakMap();
    let byId = new Map();
    let seq = 0;
    let engineEl = null, engineId = null, lastSent = '';
    const idOf = (el) => {
      let id = ids.get(el);
      if (!id) ids.set(el, (id = ++seq));
      byId.set(id, el);
      return id;
    };
    const send = (msg) => window.parent.postMessage({ gpn: PROTO, ...msg }, '*');
    // Whether this frame's document scrolls, and how far it can go each way.
    const docScroll = () => {
      const se = document.scrollingElement || document.documentElement;
      const hidden = (n) => n && /hidden|clip/.test(getComputedStyle(n).overflowY + getComputedStyle(n).overflowX);
      const blocked = hidden(document.documentElement) && hidden(document.body);
      const maxTop = se.scrollHeight - innerHeight, maxLeft = se.scrollWidth - innerWidth;
      return { scrollable: !blocked && (maxTop > 1 || maxLeft > 1), top: scrollY, left: scrollX, maxTop, maxLeft };
    };
    const plain = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

    // While the engine has focus here, report the element's rect (it moves when this frame scrolls) and if it vanishes.
    function track() {
      if (!engineEl) return;
      const isGone = gone(engineEl);
      const msg = { type: 'focused', id: engineId, rect: isGone ? null : plain(engineEl.getBoundingClientRect()), gone: isGone, vw: innerWidth, vh: innerHeight };
      const key = JSON.stringify(msg);
      if (key !== lastSent) { lastSent = key; send(msg); }
      requestAnimationFrame(track);
    }

    addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.gpn !== PROTO || e.source !== window.parent) return;
      if (d.type === 'snapshot') {
        topViewportArea = d.vpArea || null;
        byId = new Map();
        if (engineEl) byId.set(engineId, engineEl);
        // Scopes whose element went away end here too (the top frame drops them when they stop being reported).
        while (scopes.length && gone(scopes[scopes.length - 1])) scopes.pop();
        const list = candidates().filter((el) => inViewport(el.getBoundingClientRect()));
        const set = new Set(list);
        const room = (el) => ({ up: canScroll(el, 'up'), down: canScroll(el, 'down'), left: canScroll(el, 'left'), right: canScroll(el, 'right') });
        const items = list.map((el) => {
          const anc = [];
          for (let n = el.parentElement; n; n = n.parentElement) if (set.has(n)) anc.push(idOf(n));
          return { id: idOf(el), rect: plain(el.getBoundingClientRect()), anc, text: el.matches(TEXT_LIKE),
            kids: containerKids.get(el) || 0, scroll: scrollBoxes.has(el) ? room(el) : null, scrollOnly: scrollOnly.has(el),
            native: el.matches(SELECTOR) };
        });
        // The current scope is reported too, flagged, so the top frame keeps it alive (and can scroll it).
        const sc = scopes[scopes.length - 1];
        if (sc) items.push({ id: idOf(sc), rect: plain(sc.getBoundingClientRect()), anc: [], isScope: true,
          scroll: scrollBoxes.has(sc) || isScrollBox(sc) ? room(sc) : null });
        send({ type: 'snapshot-reply', req: d.req, items, vw: innerWidth, vh: innerHeight, scroll: docScroll() });
      } else if (d.type === 'focus') {
        const el = byId.get(d.id);
        if (!el) return;
        const wasTracking = !!engineEl;
        engineEl = el; engineId = d.id; lastSent = '';
        try { el.focus({ preventScroll: true }); } catch {}
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        if (!wasTracking) requestAnimationFrame(track);
      } else if (d.type === 'release') {
        engineEl = null;
      } else if (d.type === 'activate') {
        const el = byId.get(d.id);
        if (el) activate(el);
      } else if (d.type === 'back') {
        const ae = document.activeElement;
        const handled = !!ae?.matches?.(TEXT_LIKE);
        if (handled) ae.blur();
        send({ type: 'back-reply', req: d.req, handled });
      } else if (d.type === 'enter') {
        const el = byId.get(d.id);
        if (el) scopes.push(el);
      } else if (d.type === 'leave') {
        scopes.pop();
      } else if (d.type === 'scrollBox') {
        // Inside a scroll container in this frame, pressed past the last visible item.
        const el = byId.get(d.id);
        const horiz = d.dir === 'left' || d.dir === 'right', sign = d.dir === 'down' || d.dir === 'right' ? 1 : -1;
        el?.scrollBy({ [horiz ? 'left' : 'top']: (horiz ? el.clientWidth : el.clientHeight) * 0.6 * sign, behavior: 'smooth' });
      } else if (d.type === 'scroll') {
        // A focused scroll stop scrolls itself; otherwise whatever contains focus.
        (engineEl && scrollBoxes.has(engineEl) ? engineEl : scrollParent(engineEl, 'y')).scrollBy(d.dx, d.dy);
      } else if (d.type === 'page') {
        const t = engineEl && scrollBoxes.has(engineEl) ? engineEl : scrollParent(engineEl, 'y');
        t.scrollBy({ top: (t === document.scrollingElement ? innerHeight : t.clientHeight) * 0.85 * d.sign, behavior: 'smooth' });
      } else if (d.type === 'scrollStep') {
        // Pressed past the last visible item while the frame is the scope: scroll the document on.
        const horiz = d.dir === 'left' || d.dir === 'right', sign = d.dir === 'down' || d.dir === 'right' ? 1 : -1;
        scrollBy({ [horiz ? 'left' : 'top']: (horiz ? innerWidth : innerHeight) * 0.6 * sign, behavior: 'smooth' });
      }
    });
  }

  // ---------- geometry ----------

  function inViewport(r) {
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }

  // The area navigation looks at: the viewport plus one screen on every side.
  function nearViewport(r) {
    return r.bottom > -innerHeight && r.top < innerHeight * 2 && r.right > -innerWidth && r.left < innerWidth * 2;
  }

  // Lower is better; Infinity means "not in that direction".
  // Distance across the gap between a and b, amplified by how far off
  // the pressed direction that point lies: x 1/cos(deviation), so 1 straight
  // ahead, about 1.41 at 45°, growing fast toward 90°. ANGLE_PENALTY raises that
  // factor to a power: 1 is the plain 1/cos. Being gentle on diagonals (rather
  // than a hard "same row first" rule) is what keeps off-grid items reachable.
  function score(dir, a, b) {
    const acx = (a.left + a.right) / 2, acy = (a.top + a.bottom) / 2;
    const bcx = (b.left + b.right) / 2, bcy = (b.top + b.bottom) / 2;
    // b must lie past a's center and reach beyond a's far edge in that direction.
    switch (dir) {
      case 'right': if (bcx <= acx + 1 || b.right <= a.right) return Infinity; break;
      case 'left': if (bcx >= acx - 1 || b.left >= a.left) return Infinity; break;
      case 'down': if (bcy <= acy + 1 || b.bottom <= a.bottom) return Infinity; break;
      case 'up': if (bcy >= acy - 1 || b.top >= a.top) return Infinity; break;
    }
    // Gap between the two rectangles (0 on an axis where they overlap). It's the
    // same measured from either side, so A→B and B→A always score the same and
    // pressing back the opposite way tends to return. A wide element straight
    // below counts as straight ahead, not as a diagonal to its far-off center.
    const gx = Math.max(0, b.left - a.right, a.left - b.right);
    const gy = Math.max(0, b.top - a.bottom, a.top - b.bottom);
    const horizontal = dir === 'left' || dir === 'right';
    const lateral = horizontal ? gy : gx;
    // Overlapping along the pressed axis but separated across it: b is beside
    // (e.g. below) a, not ahead of it — even if it pokes out a little further.
    if ((horizontal ? gx : gy) === 0 && lateral > 0) return Infinity;
    // Touching along the pressed axis: count as half a pixel ahead.
    const forward = Math.max(horizontal ? gx : gy, 0.5);
    // Too far off the pressed direction to count, however empty that side is.
    if (Math.atan2(lateral, forward) * 180 / Math.PI > MAX_DEVIATION) return Infinity;
    // Separated sideways: judge by centers as well, so a corner that happens to be close
    // doesn't make a sideways neighbour count as ahead.
    if (lateral > 0) {
      const ahead = { right: bcx - acx, left: acx - bcx, down: bcy - acy, up: acy - bcy }[dir];
      const across = horizontal ? Math.abs(bcy - acy) : Math.abs(bcx - acx);
      if (Math.atan2(across, ahead) * 180 / Math.PI > MAX_CENTER_DEVIATION) return Infinity;
    }
    const dist = Math.hypot(forward, lateral);
    return dist * (dist / forward) ** ANGLE_PENALTY + Math.hypot(bcx - acx, bcy - acy) * 0.01; // tiny tie-break by center
  }

  function related(a, b) {
    if (a === b) return true;
    if (a instanceof RemoteEl || b instanceof RemoteEl) {
      if (!(a instanceof RemoteEl && b instanceof RemoteEl) || a.frame !== b.frame) return false;
      return a.anc.includes(b.id) || b.anc.includes(a.id);
    }
    return containsDeep(a, b) || containsDeep(b, a);
  }

  function findNext(dir, from, list, rects) {
    const rectOf = (el) => rects?.get(el) || el.getBoundingClientRect();
    const a = rectOf(from);
    let best = null, bestScore = Infinity;
    for (const el of list) {
      const s = score(dir, a, rectOf(el));
      // related() walks the DOM, so only check would-be winners.
      if (s < bestScore && !related(el, from)) { bestScore = s; best = el; }
    }
    return best ? { to: best, score: bestScore } : null;
  }

  // Distance along the ray to where it enters rect r (padded), or Infinity.
  function rayHit(ox, oy, dx, dy, r) {
    let t0 = -Infinity, t1 = Infinity;
    for (const [o, d, lo, hi] of [[ox, dx, r.left - RAY_PAD, r.right + RAY_PAD], [oy, dy, r.top - RAY_PAD, r.bottom + RAY_PAD]]) {
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return Infinity; continue; }
      let a = (lo - o) / d, b = (hi - o) / d;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    }
    return t0 <= t1 && t0 > 0 ? t0 : Infinity; // t0 <= 0: ray starts inside it (overlaps from)
  }

  // First element a ray from the center of `from` at `angle` runs into.
  function castRay(angle, from, nodes, rects) {
    const a = rects.get(from) || from.getBoundingClientRect();
    const ox = (a.left + a.right) / 2, oy = (a.top + a.bottom) / 2;
    const dx = Math.cos(angle * Math.PI / 180), dy = Math.sin(angle * Math.PI / 180);
    let best = null, bestT = Infinity;
    for (const el of nodes) {
      const t = rayHit(ox, oy, dx, dy, rects.get(el));
      if (t < bestT && !related(el, from)) { bestT = t; best = el; }
    }
    if (best) return best;

    // Missed everything: take the element whose edge is angularly closest to the
    // ray (within AIM_TOLERANCE), so gaps between targets split between them
    // instead of leaving thin, hard-to-hit wedges. For a convex box the closest
    // direction is one of its corners. Ties go to the nearer element, so an
    // element can't win the gap from behind another one.
    let bestDev = AIM_TOLERANCE, bestDist = Infinity;
    for (const el of nodes) {
      const r = rects.get(el);
      for (const [cx, cy] of [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]]) {
        const dev = angDiff(Math.atan2(cy - oy, cx - ox) * 180 / Math.PI, angle);
        const dist = Math.hypot(cx - ox, cy - oy);
        if ((dev < bestDev - 0.01 || (Math.abs(dev - bestDev) <= 0.01 && dist < bestDist)) && !related(el, from)) {
          bestDev = dev; bestDist = dist; best = el;
        }
      }
    }
    return best;
  }

  // ---------- navigation graph ----------
  // Picking each element's best target per direction can leave some element
  // that no direction leads to (e.g. a small item between four aligned ones).
  // After building the plain graph, each such orphan takes over the edge it
  // came closest to winning, as long as the target it displaces still has
  // another way in. Orphans that can't be rescued stay listed as unreachable.

  function buildGraph(list) {
    // Only lay out the neighbourhood of the viewport (candidates() already limits
    // this; elements may have moved since).
    const rects = new Map();
    const nodes = [];
    for (const el of list) {
      // Plain copies: DOMRect property getters are slow, and scoring reads them N² times.
      const { left, top, right, bottom, width, height } = el.getBoundingClientRect();
      const r = { left, top, right, bottom, width, height };
      if (nearViewport(r)) {
        rects.set(el, r);
        nodes.push(el);
      }
    }

    const edges = new Map(); // el -> {dir: {to, score, rescued?}}
    const indeg = new Map(nodes.map((el) => [el, 0]));
    for (const el of nodes) {
      const out = {};
      for (const dir of DIRS) {
        const e = findNext(dir, el, nodes, rects);
        if (e) { out[dir] = e; indeg.set(e.to, indeg.get(e.to) + 1); }
      }
      edges.set(el, out);
    }

    // Judge orphans only on screen: near the region's edge, the real way in may lie outside it.
    const orphans = nodes.filter((el) => indeg.get(el) === 0 && inViewport(rects.get(el)));
    const rescued = new Set();
    const unreachable = new Set();
    for (const o of orphans) {
      let best = null;
      for (const src of nodes) {
        for (const dir of DIRS) {
          const s = score(dir, rects.get(src), rects.get(o));
          const cur = edges.get(src)[dir];
          if (!Number.isFinite(s) || !cur || indeg.get(cur.to) < 2) continue;
          const cost = s - cur.score; // how far o was from winning this slot
          if ((!best || cost < best.cost) && !related(src, o)) best = { src, dir, cost, score: s, displaced: cur.to };
        }
      }
      if (!best) { unreachable.add(o); continue; }
      indeg.set(best.displaced, indeg.get(best.displaced) - 1);
      indeg.set(o, 1);
      edges.get(best.src)[best.dir] = { to: o, score: best.score, rescued: true };
      rescued.add(o);
    }
    return { nodes, rects, edges, rescued, unreachable };
  }

  // `via` says why: 'graph' (best score), 'rescued' (orphan rescue), 'fallback' (outside the graph area).
  function nextFrom(dir, el, list, graph) {
    const e = graph.edges.get(el)?.[dir];
    if (e) return { ...e, via: e.rescued ? 'rescued' : 'graph' };
    const f = findNext(dir, el, list);
    return f && { ...f, via: 'fallback' };
  }

  const isReturn = (angle, from) => from === current && lastMove?.to === from && usable(lastMove.from) &&
    angDiff(angle, lastMove.angle + 180) <= RETURN_TOLERANCE;

  // Where a D-pad press leads.
  function resolveCardinal(dir, from, list, graph) {
    if (isReturn(DIR_ANGLE[dir], from)) return { to: lastMove.from, via: 'return' }; // go back the way you came
    return nextFrom(dir, from, list, graph);
  }

  // Stick target for every whole degree (index = angle + 180).
  // move() and the pie both read this table, so the pie always shows what will happen.
  function angleTable(from, graph) {
    const table = new Array(360);
    const locked = new Array(360).fill(false); // the return wedge is never merged away
    for (let i = 0; i < 360; i++) {
      const angle = i - 180;
      if (isReturn(angle, from)) { table[i] = lastMove.from; locked[i] = true; }
      else table[i] = castRay(angle, from, graph.nodes, graph.rects);
    }

    // Merge free-aim runs (targets or empty gaps) narrower than MIN_WEDGE into the
    // wider neighbouring run, narrowest first, until none are left.
    for (let guard = 0; guard < 360; guard++) {
      // Runs are split by target only; a run touching a locked sample is itself locked
      // (a sliver merged into the return wedge's target then grows that wedge).
      const runs = [];
      for (let i = 0; i < 360; i++) {
        const last = runs[runs.length - 1];
        if (last && table[i] === last.to) { last.len++; last.locked ||= locked[i]; }
        else runs.push({ start: i, len: 1, to: table[i], locked: locked[i] });
      }
      // Join the run that wraps around 180° back to the first one.
      if (runs.length > 1) {
        const first = runs[0], last = runs[runs.length - 1];
        if (first.to === last.to) { first.start = last.start; first.len += last.len; first.locked ||= last.locked; runs.pop(); }
      }
      if (runs.length < 2) break;
      const small = runs.filter((r) => !r.locked && r.len < MIN_WEDGE).sort((a, b) => a.len - b.len)[0];
      if (!small) break;
      const k = runs.indexOf(small);
      const prev = runs[(k - 1 + runs.length) % runs.length], next = runs[(k + 1) % runs.length];
      // Prefer a real target over an empty gap, then the wider neighbour.
      const pick = (!prev.to) !== (!next.to) ? (prev.to ? prev : next) : (prev.len >= next.len ? prev : next);
      for (let n = 0; n < small.len; n++) table[(small.start + n) % 360] = pick.to;
    }
    return table;
  }

  const tableIndex = (angle) => ((Math.round(angle) + 180) % 360 + 360) % 360;

  // When nothing is focused (or focus scrolled away), enter from the edge we're moving from.
  function entryPoint(dir, list) {
    const visible = list.filter((el) => inViewport(el.getBoundingClientRect()));
    if (!visible.length) return null;
    const key = {
      down: (r) => r.top * 10 + r.left,
      up: (r) => -r.bottom * 10 + r.left,
      right: (r) => r.left * 10 + r.top,
      left: (r) => -r.right * 10 + r.top,
    }[dir] || ((r) => r.top * 10 + r.left);
    return visible.reduce((best, el) =>
      key(el.getBoundingClientRect()) < key(best.getBoundingClientRect()) ? el : best);
  }

  // ---------- scrolling ----------

  function scrollParent(el, axis) {
    for (let n = el?.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const ov = axis === 'y' ? cs.overflowY : cs.overflowX;
      const canScroll = axis === 'y' ? n.scrollHeight > n.clientHeight + 1 : n.scrollWidth > n.clientWidth + 1;
      if (canScroll && /(auto|scroll|overlay)/.test(ov)) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollStep(dir) {
    const axis = dir === 'up' || dir === 'down' ? 'y' : 'x';
    const target = scrollParent(current, axis);
    scrolledAway = true;
    const sign = dir === 'down' || dir === 'right' ? 1 : -1;
    const amount = (axis === 'y' ? innerHeight : innerWidth) * 0.6 * sign;
    target.scrollBy({ [axis === 'y' ? 'top' : 'left']: amount, behavior: 'smooth' });
  }

  // ---------- focus ----------

  function setCurrent(el) {
    if (current instanceof RemoteEl && current !== el) postToFrame(current.frame, { type: 'release' });
    current = el;
    focusRect = el.getBoundingClientRect();
    focusArea = focusRect.width * focusRect.height;
    scrolledAway = false;
    try { el.focus({ preventScroll: true }); } catch {}
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    showRing();
    scheduleViz();
  }

  // ---------- focus recovery ----------
  // Clicking something can make it vanish (YouTube's chip-bar arrow hides once
  // scrolled to the end; a dialog's close button goes with the dialog). Rather
  // than restarting from the page's top-left, focus moves to whatever is now
  // nearest to where the vanished element was.

  let lastRect = null; // viewport rect of `current` the last time it was visible
  let lastGoneCheck = 0;
  const GONE_CHECK_MS = 100;

  // SPA page changes (Twitter): when focus vanishes mid-change, the next page is
  // still loading, and recovering at once can pick a placeholder (an empty
  // focusable timeline that later grows into a page-sized wrapper). So recovery
  // waits until the DOM has been quiet for SETTLE_MS (at most SETTLE_MAX_MS).
  const SETTLE_MS = 300, SETTLE_MAX_MS = 1500;
  let lastMutationAt = -Infinity, goneSince = null;
  new MutationObserver(() => { lastMutationAt = performance.now(); })
    .observe(document.documentElement, { childList: true, subtree: true });

  function settling(now) {
    if (!current || !gone(current)) { goneSince = null; return false; }
    goneSince ??= now;
    return now - lastMutationAt < SETTLE_MS && now - goneSince < SETTLE_MAX_MS;
  }

  // The focused element changed size a lot since it got focus (a placeholder filled
  // up): check it is still a stop, and if not, re-anchor without waiting for a press.
  const RESIZE_RECHECK = 3; // area ratio that triggers the check
  let focusArea = 0, focusRect = null; // size/position of the focused element when it got focus
  function revalidateCurrent() {
    if (!current || current instanceof RemoteEl || !current.isConnected) return;
    const r = current.getBoundingClientRect();
    const area = r.width * r.height;
    const ratio = focusArea > 0 && area > 0 ? Math.max(area / focusArea, focusArea / area) : 1;
    if (ratio < RESIZE_RECHECK) return;
    focusArea = area; // check once per big change
    const list = candidates();
    if (list.includes(current)) return;
    // Measured from where it was when focused (a grown timeline's middle is meaningless);
    // adjusted for page scrolling since then by keeping its current top-left.
    const pos = { left: r.left, top: r.top, right: r.left + focusRect.width, bottom: r.top + focusRect.height };
    const next = reentryPoint(current, list, pos);
    if (!next) return;
    const ringWasVisible = ring?.style.display === 'block';
    lastMove = null;
    setCurrent(next);
    if (!ringWasVisible) hideRing();
  }

  function rememberRect() {
    if (!current?.isConnected) return;
    const r = current.getBoundingClientRect();
    if (r.width >= 2 && r.height >= 2) lastRect = r;
  }

  // Removed, hidden or disabled. Being covered (e.g. by a tooltip) does not count.
  function gone(el) {
    if (el instanceof RemoteEl) return !el.isConnected;
    if (!el.isConnected || el.disabled || el.closest('[inert]')) return true;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return true;
    const cs = getComputedStyle(el);
    return cs.visibility === 'hidden' || cs.opacity === '0';
  }

  // Closest usable element to rect (gap between boxes, ties broken by centers).
  function nearestTo(rect, list) {
    const cx = (rect.left + rect.right) / 2, cy = (rect.top + rect.bottom) / 2;
    let best = null, bestD = Infinity;
    for (const el of list) {
      const r = el.getBoundingClientRect();
      if (!inViewport(r)) continue;
      const gx = Math.max(0, r.left - rect.right, rect.left - r.right);
      const gy = Math.max(0, r.top - rect.bottom, rect.top - r.bottom);
      const d = Math.hypot(gx, gy) + Math.hypot((r.left + r.right) / 2 - cx, (r.top + r.bottom) / 2 - cy) * 0.01;
      if (d < bestD) { bestD = d; best = el; }
    }
    return best;
  }

  // Returns true if focus was moved to a replacement.
  function recoverFocus() {
    if (!current || !lastRect || scrolledAway || !gone(current)) return false;
    const next = reentryPoint(current, candidates()); // same scroll area first, near where it was
    if (!next) return false;
    const ringWasVisible = ring?.style.display === 'block';
    lastMove = null;
    setCurrent(next);
    if (!ringWasVisible) hideRing();
    return true;
  }

  // ---------- re-entry after scrolling away ----------
  // The focused element was scrolled out of view (page, a scrollable box, or an
  // iframe). Land on the visible element nearest to where it actually is now,
  // staying inside the same scroll area if anything there is visible.

  // Nearest scrollable ancestor box, or null for the page itself.
  function scrollBox(el) {
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if ((/(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) ||
          (/(auto|scroll|overlay)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1)) return n;
    }
    return null;
  }

  function sameScrollArea(el, ref) {
    if (ref instanceof RemoteEl) return el instanceof RemoteEl && el.frame === ref.frame;
    if (el instanceof RemoteEl) return false;
    const box = scrollBox(ref);
    return box ? box.contains(el) : true;
  }

  // Where the element really is (not clipped to its frame), or null if unknown.
  function actualRect(el) {
    if (el instanceof RemoteEl) {
      if (!el.local) return null;
      const r = toTop(el.frame, el.local, false);
      return r.width ? r : null;
    }
    if (!el.isConnected) return null;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 ? r : null;
  }

  function reentryPoint(from, list, pos = actualRect(from) || lastRect) {
    if (!pos) return null;
    const visible = list.filter((el) => el !== from && inViewport(el.getBoundingClientRect()));
    const local = visible.filter((el) => sameScrollArea(el, from));
    return nearestTo(pos, local.length ? local : visible);
  }

  // Nothing to move to in this direction. Inside a scope nothing else exists: scroll
  // the scope itself if it continues that way (a scroll box or an entered frame),
  // the page if the scope extends off screen, otherwise bump. Outside a scope,
  // scroll whatever contains focus. Never fall through to the page from inside a
  // scope: scrollStep() resolves a frame element's scroll parent to the outer page.
  function scrollWithin(dir) {
    const scope = activeScope();
    if (!scope) { scrollStep(dir); return; }
    // (An entered frame isn't in scrollBoxes: its own elements replaced it in the candidates.)
    if ((scope instanceof RemoteEl || scrollBoxes.has(scope) || scope.tagName === 'IFRAME') && canScroll(scope, dir)) {
      scrolledAway = true;
      if (scope instanceof RemoteEl) { postToFrame(scope.frame, { type: 'scrollBox', id: scope.id, dir }); return; }
      if (scope.tagName === 'IFRAME') { postToFrame(frameState(scope), { type: 'scrollStep', dir }); return; }
      const horiz = dir === 'left' || dir === 'right', sign = dir === 'down' || dir === 'right' ? 1 : -1;
      scope.scrollBy({ [horiz ? 'left' : 'top']: (horiz ? scope.clientWidth : scope.clientHeight) * 0.6 * sign, behavior: 'smooth' });
      return;
    }
    const c = scope.getBoundingClientRect();
    const more = { down: c.bottom > innerHeight, up: c.top < 0, right: c.right > innerWidth, left: c.left < 0 }[dir];
    if (!more) { bump(dir); return; }
    // The container itself continues off screen: scroll the page that holds it.
    scrolledAway = true;
    const horiz = dir === 'left' || dir === 'right', sign = dir === 'down' || dir === 'right' ? 1 : -1;
    scrollParent(nodeOf(scope), horiz ? 'x' : 'y').scrollBy({ [horiz ? 'left' : 'top']: (horiz ? innerWidth : innerHeight) * 0.6 * sign, behavior: 'smooth' });
  }

  // dpad: one of the 4 D-pad directions (scored graph); otherwise a free stick angle.
  // Asks iframes for their elements first (usually a few ms), then moves.
  let moving = false;
  async function move(angle, dpad) {
    if (moving) return;
    moving = true;
    try { await refreshFrames(); moveNow(angle, dpad); } finally { moving = false; }
  }

  function moveNow(angle, dpad) {
    // If focus vanished since the last check, land next to where it was; the press is used up.
    if (recoverFocus()) return;
    const list = candidates();
    const dir = dominantDir(angle);
    // Focus may be mid smooth-scroll into view; only re-enter if the user scrolled it away.
    // Focus must be one of the current stops: on SPA page changes (Twitter) an element can stop
    // being a stop (a loading area that filled with posts) while staying on screen. Moving from
    // it would skip everything inside it, so re-anchor like after scrolling away.
    const startOk = current && usable(current) && list.includes(current) &&
      (!scrolledAway || inViewport(current.getBoundingClientRect()));
    if (!startOk) {
      const entry = (current && reentryPoint(current, list)) || entryPoint(dir, list);
      // Nothing visible to land on (e.g. a blank stretch of a scrolled frame): keep scrolling, within the scope.
      if (entry) setCurrent(entry); else scrollWithin(dir);
      lastMove = null;
      return;
    }
    const graph = buildGraph(list);
    const to = dpad
      ? resolveCardinal(dir, current, list, graph)?.to
      : angleTable(current, graph)[tableIndex(angle)];
    if (!to) { scrollWithin(dir); return; }
    if (dpad && !isReturn(angle, current)) {
      // Target far off screen: scroll toward it first so content in between can be read.
      const r = to.getBoundingClientRect();
      const far = { down: r.top - innerHeight, up: -r.bottom, right: r.left - innerWidth, left: -r.right }[dir];
      if (far > (dir === 'up' || dir === 'down' ? innerHeight : innerWidth) * 0.5) { scrollStep(dir); return; }
    }
    lastMove = { from: current, to, angle };
    setCurrent(to);
  }

  // ---------- actions ----------

  const TEXT_LIKE = 'textarea, [contenteditable=""], [contenteditable="true"], input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=image]):not([type=file]):not([type=color]):not([type=range])';

  function activate(el) {
    if (el instanceof RemoteEl) {
      if (enterOnA(el)) { enterScope(); return; } // a scroll container in a frame: enter it, don't click it
      if (el.isConnected) postToFrame(el.frame, { type: 'activate', id: el.id });
      return;
    }
    if (!el || !usable(el)) return;
    if (enterOnA(el)) { enterScope(); return; }
    if (el.matches(TEXT_LIKE)) { el.focus(); return; }
    if (el.tagName === 'SELECT') { el.focus(); try { el.showPicker(); } catch {} return; }
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const pOpts = { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', pOpts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', pOpts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  async function back() {
    // Focus inside a frame: let it leave a text field first.
    if (current instanceof RemoteEl && await askFrameBack(current.frame)) return;
    const ae = document.activeElement;
    if (ae && ae.matches?.(TEXT_LIKE)) { ae.blur(); return; }
    if (activeScope() && await leaveScope()) return;
    const modal = activeModal();
    if (modal?.tagName === 'DIALOG') {
      // A script-dispatched Escape is untrusted, so browsers ignore it for <dialog>.
      // requestClose() is the real close request (fires cancel, honours preventDefault).
      if (typeof modal.requestClose === 'function') modal.requestClose();
      else if (modal.dispatchEvent(new Event('cancel', { cancelable: true }))) modal.close();
      return;
    }
    if (modal) {
      // ARIA dialogs: their own code listens for Escape.
      const target = ae || document.body;
      for (const type of ['keydown', 'keyup']) {
        target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
      }
      return;
    }
    history.back();
  }

  function pageScroll(sign) {
    scrolledAway = true;
    if (current instanceof RemoteEl) { postToFrame(current.frame, { type: 'page', sign }); return; }
    if (current?.tagName === 'IFRAME' && frameState(current).hasClient) { postToFrame(frameState(current), { type: 'page', sign }); return; }
    const t = scrollTarget('y');
    t.scrollBy({ top: (t === document.scrollingElement ? innerHeight : t.clientHeight) * 0.85 * sign, behavior: 'smooth' });
  }

  function switchTab(delta) {
    try { chrome.runtime.sendMessage({ cmd: 'tab', delta }); } catch {}
  }

  // ---------- UI ----------

  function ensureUi() {
    if (ring) return;
    ring = document.createElement('div');
    ring.setAttribute('style', 'position:fixed;pointer-events:none;z-index:2147483647;border:3px solid #fff;' +
      'border-radius:6px;box-shadow:0 0 0 2px #107c10,0 0 14px 4px rgba(16,124,16,.7);' +
      'transition:all .12s ease-out;display:none;box-sizing:border-box;');
    toast = document.createElement('div');
    toast.setAttribute('style', 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483647;' +
      'background:rgba(0,0,0,.85);color:#fff;font:14px system-ui,sans-serif;padding:8px 16px;border-radius:8px;' +
      'pointer-events:none;display:none;');
    // Button hint under the ring ("A open · X enter (6)", "B leave").
    hint = document.createElement('div');
    hint.setAttribute('style', 'position:fixed;z-index:2147483647;pointer-events:none;display:none;white-space:nowrap;' +
      'background:rgba(0,0,0,.85);color:#fff;font:12px system-ui,sans-serif;padding:3px 8px;border-radius:5px;');
    // Active scope: outlined, with everything outside it dimmed.
    scopeBox = document.createElement('div');
    scopeBox.setAttribute('style', 'position:fixed;z-index:2147483645;pointer-events:none;display:none;box-sizing:border-box;' +
      'border:2px dashed #ffcc00;border-radius:8px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35);');
    document.documentElement.append(ring, toast, hint, scopeBox);
  }

  function showRing() { ensureUi(); ring.style.display = 'block'; updateHint(); updateRing(); }
  function hideRing() { if (ring) { ring.style.display = 'none'; hint.style.display = 'none'; scopeBox.style.display = 'none'; } }

  function updateHint() {
    if (!hint) return;
    const parts = [];
    if (current && enterOnA(current)) parts.push(`A/X enter (${kidsOf(current)}) · right stick scrolls`);
    else if (current && isContainer(current)) parts.push(`A open · X enter (${kidsOf(current)})`);
    else if (current && isScrollStop(current)) parts.push('right stick scrolls');
    if (activeScope()) parts.push('B leave');
    hint.textContent = parts.join(' · ');
    hint.style.display = parts.length && ring.style.display !== 'none' ? 'block' : 'none';
  }

  function updateRing() {
    if (!ring || ring.style.display === 'none') return;
    if (!current?.isConnected) { hideRing(); return; }
    const r = current.getBoundingClientRect();
    const pad = 4;
    Object.assign(ring.style, {
      left: r.left - pad + 'px', top: r.top - pad + 'px',
      width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px',
    });
    if (hint.style.display !== 'none') {
      // Below the element, else above it; for elements taller than the screen (a full-height
      // sidebar) neither fits, so sit inside it along its visible bottom edge. Always on screen.
      const h = hint.offsetHeight || 22, w = hint.offsetWidth || 160, gap = pad + 4;
      let top;
      if (r.bottom + gap + h <= innerHeight) top = r.bottom + gap;
      else if (r.top - gap - h >= 0) top = r.top - gap - h;
      else top = Math.min(r.bottom, innerHeight) - h - 8;
      top = Math.min(Math.max(top, 4), innerHeight - h - 4);
      const left = Math.min(Math.max(r.left - pad, 4), innerWidth - w - 4);
      Object.assign(hint.style, { left: left + 'px', top: top + 'px' });
    }
    const scope = activeScope();
    if (scope) {
      const c = scope.getBoundingClientRect();
      Object.assign(scopeBox.style, { display: 'block', left: c.left - 6 + 'px', top: c.top - 6 + 'px', width: c.width + 12 + 'px', height: c.height + 12 + 'px' });
    } else scopeBox.style.display = 'none';
  }

  function say(text) {
    ensureUi();
    toast.textContent = text;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.style.display = 'none'), 1200);
  }

  // ---------- navigation graph visualization ----------
  // Mode 0: off. 1: arrows from the focused element. 2: arrows for every element on screen.

  const VIZ_MODES = ['Graph: off', 'Graph: focused item (D-pad arrows / stick pie, whichever you use)', 'Graph: whole screen (D-pad)'];
  const VIZ_COLORS = { up: '#ff9a3c', down: '#ff7ad9', left: '#3fa9ff', right: '#4cd964' };
  // One colour per distinct target in the pie.
  const PIE_COLORS = ['#4cd964', '#3fa9ff', '#ff9a3c', '#ff7ad9', '#ffd60a', '#64d2ff', '#bf5af2', '#ff453a', '#a2845e', '#30b0c7'];
  const PIE_RADIUS = 70;
  const PIE_STEP = 1; // degrees per angleTable entry
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let vizMode = 0;
  let vizInput = 'dpad'; // focused mode shows only the input used last: 'dpad' arrows or 'stick' pie
  let svg, vizLayer, needle, vizTimer;

  function ensureSvg() {
    if (svg) return;
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('style', 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;' +
      'z-index:2147483646;overflow:visible;');
    const defs = document.createElementNS(SVG_NS, 'defs');
    for (const [dir, color] of Object.entries(VIZ_COLORS)) {
      const m = document.createElementNS(SVG_NS, 'marker');
      Object.entries({ id: 'gpn-arrow-' + dir, viewBox: '0 0 10 10', refX: 9, refY: 5,
        markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }).forEach(([k, v]) => m.setAttribute(k, v));
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', 'M0,0 L10,5 L0,10 z');
      p.setAttribute('fill', color);
      m.append(p);
      defs.append(m);
    }
    // Redrawn content goes in vizLayer; the live stick needle sits above it and survives redraws.
    vizLayer = document.createElementNS(SVG_NS, 'g');
    needle = document.createElementNS(SVG_NS, 'line');
    Object.entries({ stroke: '#fff', 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0.9, display: 'none' })
      .forEach(([k, v]) => needle.setAttribute(k, v));
    svg.append(defs, vizLayer, needle);
    document.documentElement.append(svg);
  }

  // Center to center, shifted a few px to the right-hand side of travel (like
  // road lanes) so a pair of opposite arrows between two items stays parallel.
  function centerPoints(a, b) {
    const x1 = (a.left + a.right) / 2, y1 = (a.top + a.bottom) / 2;
    const x2 = (b.left + b.right) / 2, y2 = (b.top + b.bottom) / 2;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = -(y2 - y1) / len * 3, ny = (x2 - x1) / len * 3;
    return [x1 + nx, y1 + ny, x2 + nx, y2 + ny];
  }

  // Rescued edges (see buildGraph) are drawn dashed.
  // via 'rescued' is dashed, 'return' (go back the way you came) dotted; see nextFrom/resolveCardinal.
  function addArrow(dir, from, to, width, opacity, via) {
    const [x1, y1, x2, y2] = centerPoints(from.getBoundingClientRect(), to.getBoundingClientRect());
    const line = document.createElementNS(SVG_NS, 'line');
    // Element opacity (not stroke-opacity) so the arrowhead marker fades too.
    Object.entries({ x1, y1, x2, y2, stroke: VIZ_COLORS[dir], 'stroke-width': width, opacity,
      'marker-end': `url(#gpn-arrow-${dir})` }).forEach(([k, v]) => line.setAttribute(k, v));
    if (via === 'rescued') line.setAttribute('stroke-dasharray', '6 4');
    if (via === 'return') { line.setAttribute('stroke-dasharray', '1 6'); line.setAttribute('stroke-linecap', 'round'); }
    vizLayer.append(line);
  }

  function addBox(el, color, width = 1.5, dash = '4 3') {
    const r = el.getBoundingClientRect();
    const rect = document.createElementNS(SVG_NS, 'rect');
    Object.entries({ x: r.left, y: r.top, width: r.width, height: r.height, rx: 4, fill: 'none',
      stroke: color, 'stroke-width': width }).forEach(([k, v]) => rect.setAttribute(k, v));
    if (dash) rect.setAttribute('stroke-dasharray', dash);
    vizLayer.append(rect);
  }

  // Where each cardinal direction would go from el, including the "return the way you came" rule.
  function neighbors(el, list, graph) {
    const out = {};
    for (const dir of DIRS) out[dir] = resolveCardinal(dir, el, list, graph);
    return out;
  }

  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    vizLayer.append(n);
    return n;
  }

  const polar = (cx, cy, r, deg) => [cx + r * Math.cos(deg * Math.PI / 180), cy + r * Math.sin(deg * Math.PI / 180)];

  // Pie around the focused element: sample every angle the stick can point,
  // merge runs that lead to the same element into wedges, colour by target.
  function drawPie(list, graph) {
    const r = current.getBoundingClientRect();
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    const samples = angleTable(current, graph);

    // Runs of identical targets; start at a boundary so no run wraps past the end.
    let start = samples.findIndex((t, i) => t !== samples[(i - 1 + samples.length) % samples.length]);
    if (start < 0) start = 0;
    const runs = [];
    for (let k = 0; k < samples.length; k++) {
      const i = (start + k) % samples.length;
      const a = -180 + i * PIE_STEP;
      const last = runs[runs.length - 1];
      if (last && last.to === samples[i]) last.end += PIE_STEP;
      else runs.push({ to: samples[i], start: a, end: a + PIE_STEP });
    }

    const colors = new Map();
    for (const run of runs) if (run.to && !colors.has(run.to)) colors.set(run.to, PIE_COLORS[colors.size % PIE_COLORS.length]);

    svgEl('circle', { cx, cy, r: PIE_RADIUS, fill: 'rgba(0,0,0,.35)', stroke: 'rgba(255,255,255,.25)' });
    for (const run of runs) {
      if (!run.to) continue; // nothing that way: leave the dark background showing
      const a0 = run.start, a1 = Math.min(run.end, run.start + 359.99);
      const [x0, y0] = polar(cx, cy, PIE_RADIUS, a0), [x1, y1] = polar(cx, cy, PIE_RADIUS, a1);
      const large = a1 - a0 > 180 ? 1 : 0;
      svgEl('path', { d: `M${cx},${cy} L${x0},${y0} A${PIE_RADIUS},${PIE_RADIUS} 0 ${large} 1 ${x1},${y1} Z`,
        fill: colors.get(run.to), 'fill-opacity': 0.45, stroke: 'rgba(0,0,0,.5)', 'stroke-width': 1 });
    }
    // Each target: outline plus a leader line from the middle of its widest wedge.
    for (const [el, color] of colors) {
      const widest = runs.filter((x) => x.to === el).reduce((m, x) => (x.end - x.start > m.end - m.start ? x : m));
      const [lx, ly] = polar(cx, cy, PIE_RADIUS, (widest.start + widest.end) / 2);
      const b = el.getBoundingClientRect();
      const tx = (b.left + b.right) / 2, ty = (b.top + b.bottom) / 2;
      svgEl('line', { x1: lx, y1: ly, x2: tx, y2: ty, stroke: color, 'stroke-width': 1.5, opacity: 0.7 });
      svgEl('circle', { cx: tx, cy: ty, r: 3, fill: color });
      addBox(el, color, 2, null);
    }
  }

  // Live stick direction drawn over the pie.
  function updateNeedle(angle) {
    if (!needle) return;
    if (vizMode !== 1 || vizInput !== 'stick' || angle === null || !current?.isConnected) { needle.setAttribute('display', 'none'); return; }
    const r = current.getBoundingClientRect();
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    const [x2, y2] = polar(cx, cy, PIE_RADIUS + 10, angle);
    Object.entries({ x1: cx, y1: cy, x2, y2, display: 'inline' }).forEach(([k, v]) => needle.setAttribute(k, v));
  }

  // ---------- live stick panel ----------
  // Bottom-left while the graph view is on: each stick's raw position, its
  // press/release rings (left) or scroll dead zone (right), value, angle and state.

  const HUD_R = 40; // px radius of a stick diagram (= stick value 1.0)
  const HUD_STATE_COLOR = { idle: '#bbb', settle: '#ffcc00', held: '#4cd964', ignored: '#ff453a' };
  let hud;

  function ensureHud() {
    if (hud) return;
    const box = document.createElement('div');
    box.setAttribute('style', 'position:fixed;left:12px;bottom:12px;z-index:2147483647;pointer-events:none;' +
      'background:rgba(0,0,0,.8);border-radius:8px;padding:8px 10px;display:none;gap:14px;' +
      'font:11px/1.4 ui-monospace,Consolas,monospace;color:#ddd;');
    const make = (label) => {
      const wrap = document.createElement('div');
      wrap.setAttribute('style', 'display:flex;flex-direction:column;align-items:center;gap:4px;');
      const s = document.createElementNS(SVG_NS, 'svg');
      const size = HUD_R * 2 + 8;
      Object.entries({ width: size, height: size, viewBox: `${-size / 2} ${-size / 2} ${size} ${size}` })
        .forEach(([k, v]) => s.setAttribute(k, v));
      const text = document.createElement('div');
      text.setAttribute('style', 'white-space:pre;text-align:center;min-width:110px;');
      wrap.append(s, text);
      box.append(wrap);
      const add = (tag, attrs) => {
        const n = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
        s.append(n);
        return n;
      };
      return { label, svg: s, text, add };
    };
    const left = make('L'), right = make('R');

    // Left: outer edge, press ring (solid), release ring (dashed), live line + dot.
    left.add('circle', { r: HUD_R, fill: 'rgba(255,255,255,.05)', stroke: 'rgba(255,255,255,.3)' });
    left.add('circle', { r: HUD_R * STICK_PRESS, fill: 'none', stroke: '#4cd964', 'stroke-width': 1.5 });
    left.add('circle', { r: HUD_R * STICK_RELEASE, fill: 'none', stroke: '#ffcc00', 'stroke-width': 1.5, 'stroke-dasharray': '3 2' });
    left.line = left.add('line', { x1: 0, y1: 0, x2: 0, y2: 0, stroke: '#fff', 'stroke-width': 2 });
    left.dot = left.add('circle', { r: 4, fill: '#fff' });

    // Right: per-axis dead zone is a cross-shaped band through the middle.
    const dz = HUD_R * SCROLL_DEADZONE;
    right.add('circle', { r: HUD_R, fill: 'rgba(255,255,255,.05)', stroke: 'rgba(255,255,255,.3)' });
    right.add('rect', { x: -dz, y: -HUD_R, width: dz * 2, height: HUD_R * 2, fill: 'rgba(255,204,0,.18)' });
    right.add('rect', { x: -HUD_R, y: -dz, width: HUD_R * 2, height: dz * 2, fill: 'rgba(255,204,0,.18)' });
    right.line = right.add('line', { x1: 0, y1: 0, x2: 0, y2: 0, stroke: '#fff', 'stroke-width': 2 });
    right.dot = right.add('circle', { r: 4, fill: '#fff' });

    document.documentElement.append(box);
    hud = { box, left, right };
  }

  function drawStick(part, x, y, color, lines) {
    const px = x * HUD_R, py = y * HUD_R;
    part.line.setAttribute('x2', px); part.line.setAttribute('y2', py); part.line.setAttribute('stroke', color);
    part.dot.setAttribute('cx', px); part.dot.setAttribute('cy', py); part.dot.setAttribute('fill', color);
    part.text.textContent = lines.join('\n');
  }

  let hudKey = '';
  function updateHud(axes) {
    if (!vizMode) { if (hud && hudKey) { hud.box.style.display = 'none'; hudKey = ''; } return; }
    // Only touch the DOM when something visible changed (writing every frame forces layout).
    const key = axes.slice(0, 4).map((v) => v.toFixed(2)).join() + held.phase + held.stick + (held.releasedAt !== null);
    if (key === hudKey) return;
    hudKey = key;
    ensureHud();
    hud.box.style.display = 'flex';
    const fmtAngle = (x, y) => (Math.round(Math.atan2(y, x) * 180 / Math.PI) + '°').padStart(5);

    const [lx, ly, rx, ry] = axes;
    const lmag = Math.hypot(lx, ly);
    const lstate = held.releasedAt !== null ? 'ignored' : held.stick && held.phase !== 'idle' ? held.phase : 'idle';
    drawStick(hud.left, lx, ly, HUD_STATE_COLOR[lstate], [
      `L ${lmag.toFixed(2)} @${fmtAngle(lx, ly)}`,
      lstate === 'ignored' ? 'ignored (bounce)' : lstate,
      `press ${STICK_PRESS} / release ${STICK_RELEASE}`,
    ]);

    const sx = Math.abs(rx) > SCROLL_DEADZONE, sy = Math.abs(ry) > SCROLL_DEADZONE;
    drawStick(hud.right, rx, ry, sx || sy ? '#4cd964' : HUD_STATE_COLOR.idle, [
      `R x ${rx.toFixed(2)} y ${ry.toFixed(2)}`,
      sx || sy ? `scrolling ${sx ? 'x' : ''}${sy ? 'y' : ''}` : 'idle',
      `dead zone ${SCROLL_DEADZONE} per axis`,
    ]);
  }

  const RESCUED_COLOR = '#ffcc00';
  const UNREACHABLE_COLOR = '#ff3b30';

  function drawViz() {
    if (!svg && !vizMode) return;
    ensureSvg();
    vizLayer.replaceChildren();
    if (!vizMode) needle.setAttribute('display', 'none');
    if (!vizMode) return;
    const list = candidates();
    const graph = buildGraph(list);
    if (vizMode === 2) {
      const visible = graph.nodes.filter((el) => inViewport(el.getBoundingClientRect()));
      for (const el of visible) addBox(el, isContainer(el) ? '#bf5af2' : 'rgba(255,255,255,.35)', isContainer(el) ? 2 : 1.5, isContainer(el) ? '8 4' : '4 3');
      for (const el of visible) {
        for (const [dir, e] of Object.entries(neighbors(el, list, graph))) {
          if (e) addArrow(dir, el, e.to, el === current ? 3 : 1.5, el === current ? 0.8 : 0.45, e.via);
        }
      }
    } else if (current?.isConnected && vizInput === 'stick') {
      drawPie(list, graph);
    } else if (current?.isConnected) {
      // D-pad targets (scored graph), each outlined in its direction's colour.
      for (const [dir, e] of Object.entries(neighbors(current, list, graph))) {
        if (!e) continue;
        addBox(e.to, VIZ_COLORS[dir]);
        addArrow(dir, current, e.to, 3, 0.8, e.via);
      }
    }
    // Both modes: flag elements that plain nearest-neighbour scoring left orphaned.
    for (const el of graph.rescued) addBox(el, RESCUED_COLOR, 2, '2 2');
    for (const el of graph.unreachable) addBox(el, UNREACHABLE_COLOR, 3, null);
  }

  // Coalesce redraws (scrolling fires many events; layout settles after smooth scroll).
  function scheduleViz() {
    if (!vizMode) return;
    clearTimeout(vizTimer);
    vizTimer = setTimeout(() => refreshFrames().then(() => requestAnimationFrame(drawViz)), 60);
  }

  function cycleViz() {
    vizMode = (vizMode + 1) % VIZ_MODES.length;
    say(VIZ_MODES[vizMode]);
    refreshFrames().then(drawViz);
  }

  if (IS_FRAME) { startClient(); return; }

  // Test pages can set window.__gpnDebug before loading this script to inspect state.
  if (window.__gpnDebug) window.__gpn = { candidates, refreshFrames, frameState, buildGraph, angleTable, isContainer, isScrollContainer, isScrollStop, current: () => current, focus: (el) => { lastMove = null; candidates(); setCurrent(el); }, state: () => ({ moving, enabled, held: { ...held } }), lastMove: () => lastMove, scopes: () => scopes.slice() };

  // Menu (☰) or Alt+Shift+D: what is focused and how the script classifies it (for bug reports).
  async function debugReport() {
    await refreshFrames();
    const list = candidates();
    const describe = (el) => {
      if (!el) return null;
      if (el instanceof RemoteEl) {
        return { frame: el.frame.iframe.id || el.frame.iframe.src.slice(0, 60), id: el.id, kids: el.kids, scroll: el.scrollInfo, scrollOnly: el.scrollOnly, alive: el.alive };
      }
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return {
        el, tag: el.tagName.toLowerCase(), id: el.id, role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'),
        testid: el.getAttribute('data-testid'), label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
        rect: [r.left, r.top, r.width, r.height].map(Math.round), overflow: cs.overflowX + '/' + cs.overflowY,
        scroll: `${el.scrollHeight}/${el.clientHeight}`, connected: el.isConnected, usable: usable(el), gone: gone(el),
        container: kidsOf(el), scrollBox: scrollBoxes.has(el), scrollOnly: scrollOnly.has(el), native: el.matches(SELECTOR),
      };
    };
    // Where each D-pad direction would go from here, and why.
    const brief = (el) => (el instanceof RemoteEl ? `frame ${el.frame.iframe.id || ''}#${el.id}`
      : `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? '[' + el.getAttribute('data-testid') + ']' : ''} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}"`);
    const targets = {};
    if (current && list.includes(current)) {
      const graph = buildGraph(list);
      for (const dir of DIRS) {
        const e = resolveCardinal(dir, current, list, graph);
        targets[dir] = e ? { to: brief(e.to), via: e.via, el: e.to } : null;
      }
    }
    console.info('[webpad] debug', {
      build: BUILD, url: location.href, current: describe(current), currentIsStop: list.includes(current), targets,
      lastMove: lastMove && { from: brief(lastMove.from), angle: Math.round(lastMove.angle) },
      scopes: scopes.map(describe), modal: describe(activeModal()), stops: list.length, scrolledAway,
      lastRect: lastRect && [lastRect.left, lastRect.top, lastRect.width, lastRect.height].map(Math.round),
    });
    say('webpad debug info written to the console');
  }

  addEventListener('scroll', scheduleViz, { passive: true, capture: true });
  addEventListener('resize', scheduleViz, { passive: true });
  addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyG') { e.preventDefault(); cycleViz(); }
    if (e.altKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); debugReport(); }
  }, true);

  // Mouse use hides the ring; the next controller input brings it back.
  addEventListener('wheel', () => { scrolledAway = true; }, { passive: true });
  addEventListener('mousemove', (e) => { if (e.movementX || e.movementY) hideRing(); }, { passive: true });

  // ---------- gamepad polling ----------

  function readPads() {
    const pads = [...(navigator.getGamepads?.() || [])].filter(Boolean);
    const buttons = [];
    const axes = [0, 0, 0, 0];
    for (const p of pads) {
      p.buttons.forEach((b, i) => { buttons[i] = buttons[i] || b.pressed || b.value > 0.5; });
      p.axes.slice(0, 4).forEach((v, i) => { if (Math.abs(v) > Math.abs(axes[i])) axes[i] = v; });
    }
    return { pads, buttons, axes };
  }

  // The direction being pushed, or null. D-pad wins over the stick and stays
  // cardinal: rolling from up to up+right keeps "up" rather than going diagonal.
  // The stick engages at STICK_PRESS but only lets go below STICK_RELEASE.
  function readDirection(buttons, axes, ignoreStick) {
    const v = (buttons[BTN.DOWN] ? 1 : 0) - (buttons[BTN.UP] ? 1 : 0);
    const h = (buttons[BTN.RIGHT] ? 1 : 0) - (buttons[BTN.LEFT] ? 1 : 0);
    if (v || h) {
      const vd = v ? (v > 0 ? 'down' : 'up') : null, hd = h ? (h > 0 ? 'right' : 'left') : null;
      const angle = vd && hd ? (held.angle === DIR_ANGLE[hd] ? DIR_ANGLE[hd] : DIR_ANGLE[vd]) : DIR_ANGLE[vd || hd];
      return { angle, stick: false, mag: 1 };
    }
    if (ignoreStick) return null;
    const [x, y] = axes;
    const mag = Math.hypot(x, y);
    const engaged = held.phase !== 'idle' && held.stick;
    if (mag < (engaged ? STICK_RELEASE : STICK_PRESS)) return null;
    return { angle: Math.atan2(y, x) * 180 / Math.PI, stick: true, mag };
  }

  // Keyboard-style repeat: move once, pause REPEAT_DELAY, then repeat every
  // REPEAT_INTERVAL. Turning to a new direction acts like pressing a new key
  // (moves right away and pauses again) but never faster than REPEAT_INTERVAL.
  function handleDirection(now, buttons, axes) {
    // A released stick springs back and oscillates (past center, back again...).
    // Ignore the stick until it has rested near center for STICK_CALM_MS, or at
    // most STICK_BOUNCE_MAX_MS so a deliberate new push held right away still counts.
    if (held.releasedAt !== null) {
      if (Math.hypot(axes[0], axes[1]) < STICK_RELEASE) held.calmSince ??= now;
      else held.calmSince = null;
      if ((held.calmSince !== null && now - held.calmSince >= STICK_CALM_MS) || now - held.releasedAt >= STICK_BOUNCE_MAX_MS) {
        held.releasedAt = held.calmSince = null;
      }
    }
    const input = readDirection(buttons, axes, held.releasedAt !== null);
    if (!input) {
      if (held.phase === 'held' && held.stick) { held.releasedAt = now; held.calmSince = null; }
      held.phase = 'idle';
      return null;
    }
    const { angle, stick } = input;

    if (held.phase === 'idle') {
      const source = stick ? 'stick' : 'dpad';
      if (vizInput !== source) { vizInput = source; scheduleViz(); }
      held.stick = stick;
      held.since = now;
      if (stick) { held.phase = 'settle'; return angle; }
      startHold(now, angle);
      return held.angle;
    }

    if (held.phase === 'settle') {
      // Let a stick push finish travelling before reading its angle.
      if (now - held.since >= STICK_SETTLE || input.mag >= 0.95) startHold(now, angle);
      return angle;
    }

    held.stick = stick;
    if (sameDirection(angle, held.angle)) {
      if (now >= held.next) {
        held.next = now + REPEAT_INTERVAL;
        fireMove(now, stick ? angle : held.angle);
      }
      return stick ? angle : held.angle;
    }
    if (now - held.lastMoveAt >= REPEAT_INTERVAL) startHold(now, angle);
    return angle;
  }

  function startHold(now, angle) {
    held.phase = 'held';
    held.angle = angle;
    held.next = now + REPEAT_DELAY;
    fireMove(now, held.angle);
  }

  function fireMove(now, angle) {
    held.lastMoveAt = now;
    move(angle, !held.stick);
  }

  // Same direction as the one held? D-pad: exactly. Stick: within HYSTERESIS,
  // so a wobbling stick doesn't fire extra moves.
  function sameDirection(angle, prev) {
    if (prev === null) return false;
    return held.stick ? angDiff(angle, prev) <= HYSTERESIS : angle === prev;
  }

  function tick(now) {
    const { pads, buttons, axes } = readPads();
    if (!pads.length) { looping = false; return; }

    const pressed = (i) => buttons[i] && !prevButtons[i];

    if (pressed(BTN.VIEW)) {
      enabled = !enabled;
      if (!enabled) hideRing();
      say(`Gamepad navigation ${enabled ? 'ON' : 'OFF'} · build ${BUILD}`);
    }

    if (enabled && !document.hidden) {
      updateNeedle(handleDirection(now, buttons, axes));

      if (pressed(BTN.A)) { if (current && usable(current)) activate(current); else move(DIR_ANGLE.down, true); }
      if (pressed(BTN.B)) back();
      if (pressed(BTN.Y)) cycleViz();
      if (pressed(BTN.X)) enterScope();
      if (pressed(BTN.MENU)) debugReport(); // ☰: debug report (Alt+Shift+D can be taken by the page)
      if (pressed(BTN.LB)) switchTab(-1);
      if (pressed(BTN.RB)) switchTab(1);
      if (pressed(BTN.LT)) pageScroll(-1);
      if (pressed(BTN.RT)) pageScroll(1);

      // Right stick: free scroll of whatever contains the focused element.
      const sx = Math.abs(axes[2]) > SCROLL_DEADZONE ? axes[2] : 0;
      const sy = Math.abs(axes[3]) > SCROLL_DEADZONE ? axes[3] : 0;
      if (sx || sy) {
        scrolledAway = true;
        const curve = (v) => Math.sign(v) * v * v * SCROLL_SPEED;
        const frameOfCurrent = current instanceof RemoteEl ? current.frame
          : current?.tagName === 'IFRAME' && frameState(current).hasClient ? frameState(current) : null;
        if (frameOfCurrent) postToFrame(frameOfCurrent, { type: 'scroll', dx: sx ? curve(sx) : 0, dy: sy ? curve(sy) : 0 });
        else {
          if (sy) scrollTarget('y').scrollBy(0, curve(sy));
          if (sx) scrollTarget('x').scrollBy(curve(sx), 0);
        }
      }
    }

    prevButtons = buttons;
    if (now - lastGoneCheck >= GONE_CHECK_MS) {
      lastGoneCheck = now;
      checkScopes();
      if (!settling(now)) { recoverFocus(); revalidateCurrent(); }
    }
    rememberRect();
    updateRing();
    updateHud(axes);
    requestAnimationFrame(tick);
  }

  function startLoop() {
    if (looping) return;
    looping = true;
    requestAnimationFrame(tick);
  }

  addEventListener('gamepadconnected', startLoop);
  // Pads already connected (e.g. after navigating to a new page) — start right away.
  if ([...(navigator.getGamepads?.() || [])].some(Boolean)) startLoop();
  // Chrome sometimes only reports pads after focus returns to the tab.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && [...(navigator.getGamepads?.() || [])].some(Boolean)) startLoop();
  });
})();
