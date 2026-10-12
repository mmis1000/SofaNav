# webpad

Console-style controller navigation for any web page. The D-pad and left stick
move a focus ring between links and buttons by their position on screen (like
an Xbox/TV app), not a mouse cursor.

Ships as a browser extension (Chrome, Edge, Firefox) and as a userscript built
from the same source.

## Layout

```
extension/            the extension; content.js is the single source for everything
  manifest.json       MV3, runs in all frames
  background.js       LB/RB tab switching (extension only)
  content.js          all navigation logic (engine in the top frame, client in iframes)
build-userscript.js   builds dist/gamepad-nav.user.js from extension/content.js
dist/                 generated userscript (do not edit)
test/
  index.html          main test page, one section per behaviour / past bug
  frame.html          page loaded into the test page's iframes
  stress.html         Twitter-sized page for performance checks
docs/
  test-cases.md       what to check, and every edge case / bug found so far
```

## Install

- **Extension**: `chrome://extensions` (or `edge://extensions`) → Developer mode →
  Load unpacked → pick `extension/`. Firefox: `about:debugging` → Load Temporary
  Add-on → `extension/manifest.json`.
- **Userscript**: `npm run build` (or `node build-userscript.js`), then install
  `dist/gamepad-nav.user.js` in Tampermonkey/Violentmonkey. LB/RB do nothing there.
- **Quick try on any page**: paste `dist/gamepad-nav.user.js` into the DevTools console.

## Controls

| Input | Action |
|---|---|
| D-pad | Move between elements (4-direction scored graph) |
| Left stick | Free aim at any angle (ray cast) |
| A | Click / focus a text field |
| B | Leave text field → leave container → close dialog → history back |
| X | Enter the focused container (a post card, or a scrollable panel — A also enters a panel) |
| Y | Cycle graph view: off → focused item → whole screen |
| LB / RB | Previous / next tab (extension only) |
| LT / RT | Page up / down |
| Right stick | Scroll (a focused scrollable panel scrolls itself, without entering) |
| View | Turn navigation on/off |
| Alt+Shift+G (keyboard) | Same as Y |

## How it works (short)

- **Candidates**: focusable elements within one screen of the viewport, that are
  visible, not covered, and reachable by scrolling (not inside a closed drawer).
- **D-pad**: score = distance across the gap between boxes × (1/cos(angle off
  direction))^`ANGLE_PENALTY`, rejecting anything > `MAX_DEVIATION` off or merely
  beside. Then a graph pass rescues elements nothing points to.
- **Stick**: a ray from the focused element's center; first box hit wins; misses
  take the angularly nearest element within `AIM_TOLERANCE`; wedges narrower than
  `MIN_WEDGE` are merged. The pie in the graph view is this exact table.
- **"Go back"**: right after a move, pushing the reverse direction returns to
  where you came from.
- **Containers**: focusable elements with focusable contents, and scrollable
  panels holding focusable items, are one stop; X (or A for panels) enters (only
  its contents exist), B leaves. Scopes stack.
- **Frames**: the top frame is the engine; each iframe runs the same script as a
  client that reports its elements (postMessage) and executes commands. Frame
  elements become proxies with translated rects, so all logic treats them alike.
- **Recovery**: if the focused element vanishes or is scrolled away, focus lands
  on the nearest visible element in the same scroll area.

Tunable constants are at the top of `extension/content.js` (stick thresholds,
repeat timing, scoring, wedge sizes); each has a comment.

## Testing

```bash
npm run serve
```

Then open http://localhost:8765/test/ (the cross-origin frame loads from
127.0.0.1, so use `localhost` in the address). See [docs/test-cases.md](docs/test-cases.md).

- No controller? Keyboard fallback on the test page: arrows = D-pad, Enter = A,
  Backspace = B, X, Y, PgUp/PgDn = LT/RT, V = View, Q/E/Z/C = stick at 45°,
  J/L rotate aim + K = push stick at aim.
- `?timer` drives polling with a timer instead of animation frames (for automated
  runs in a background tab).
- The test pages set `window.__gpnDebug = true`, which exposes `window.__gpn`
  (`candidates()`, `buildGraph()`, `current()`, `scopes()`, ...) for inspection.
