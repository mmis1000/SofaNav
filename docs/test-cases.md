# Test cases and edge cases

- **Part 1** is the checklist to run after changes. Every check says *why* it
  exists: either a core behaviour, or the bug (`E#`, Part 2) it guards against.
  It also names the code that implements it.
- **Part 2** records every edge case and bug found so far: symptom, cause, fix,
  and where the fix lives, so a later change doesn't quietly bring one back.
- **Part 3** lists known limits.

Code references are function / constant names in `extension/content.js`
(search for them; line numbers drift). Run the test server from the project
root (`npm run serve`) and open http://localhost:8765/test/. "Where" names the
section heading on that page.

## Part 1 — Regression checklist

### D-pad movement

| # | Where | Steps → Expected | Why it exists | Code |
|---|---|---|---|---|
| 1 | Store layout | ↓ to enter, then → repeatedly → 安裝 → 購買 → ♡ → ≡ → … → < → thumbnails, one per press | Core: the original request (navigate the Xbox store layout like the console app) | `score`, `buildGraph`, `entryPoint` |
| 2 | Store layout | From 詳細資料 press ↑ → lands on "…" | Core: matches the arrows in the original reference screenshot; catches scoring regressions | `score` (gap distance × angle penalty) |
| 3 | Store layout | → from 安裝, then ← → back on 安裝 | Guards E9: reversing a move must return even when scores aren't reciprocal | `isReturn`, `lastMove` |
| 4 | Grid | ↓ / → through the cards → same row first, row below on ↓ | Core: grids must not drift diagonally (checks `ANGLE_PENALTY` isn't too low) | `score`, `ANGLE_PENALTY` |
| 5 | Orphan case | Whole-screen graph (Y twice) → no red outlines; E reachable | Guards E2: no element may be unreachable from everywhere | `buildGraph` (rescue pass), `ANGLE_PENALTY` |
| 6 | Orphan case | Reach B with the stick, then D-pad ↓ → E (penalty 1) or D (penalty 2) | Guards E8: D-pad and stick decide independently; documents the penalty trade-off | `resolveCardinal`, `ANGLE_PENALTY` |
| 7 | Long empty space | ↓ past the last item above it → page scrolls, no jump to the bottom buttons | Core: far targets are approached by scrolling so content in between is seen | `moveNow` ("far" check), `scrollStep` |
| 8 | Horizontal scroller | Lands on the scroller as one stop; A/X enters; → along the items → the box scrolls sideways to follow | Core: focus inside overflow containers (the scroller is a scroll container since E17) | `setCurrent` (`scrollIntoView`), `addScrollBoxes` |
| 9 | Form & dialog | A on the text input, then B → input focused, then left; no history back | Core: B's layered meaning (text field first) | `activate`, `back` |
| 10 | Form & dialog | Open dialog, move, B → focus stays in the dialog; B closes it | Core: modal boundary | `activeModal`, `candidatesNow`, `back` |
| 11 | Iframes / any | Move focus, then ↓ at once while it is still scrolling → no reset to the page's top-left | Guards E1: our own smooth scroll must not count as "user scrolled away" | `scrolledAway`, `moveNow` (`startOk`) |
| 12 | Horizontal scroller | Scroll the box so Item 1 pokes out left of Game 1 above; ← from Game 1 → nothing (dark gap / scroll), never Item 1 | Guards E7: elements beside/below must not count as "left" | `score` (overlap rule, `MAX_DEVIATION`) |

### Left stick (free aim) and input feel

| # | Where | Steps → Expected | Why it exists | Code |
|---|---|---|---|---|
| 13 | Orphan case | From A push ↘ (C key) → E; ↘ again → D | Guards E3: a 45° push is one diagonal move, not two cardinal ones | `readDirection`, `castRay` |
| 14 | Orphan case | Y once on B, push the stick → pie shows D straight down and E lower-left; no wedge < 10°; no leader line passes through another element | Guards E4 (thin / pass-through wedges) and E8 (D hidden by D-pad snap zones) | `castRay`, `angleTable` (merge), `drawPie` |
| 15 | Bottom button | Y once on "Bottom button" → no dark gap between the up-right targets and "Another" | Guards E5: gaps between targets are shared out, not left empty | `castRay` (miss fallback), `AIM_TOLERANCE` |
| 16 | Any | Hold the stick right 1 s → move, ~400 ms pause, then a move every ~120 ms; sweeping the stick never fires bursts | Guards E6: keyboard-style repeat, rate-limited direction changes | `handleDirection`, `startHold`, `sameDirection`, `REPEAT_DELAY`, `REPEAT_INTERVAL`, `STICK_SETTLE` |
| 17 | Grid row 2 | Flick → twice from Game 8, then ← twice → 8 → 9 → 10 → 9 → 8 | Guards E10: release bounce must not add moves (the reported 8 → 7 bug) | `handleDirection` (calm period), `STICK_CALM_MS`, `STICK_BOUNCE_MAX_MS` |
| 18 | Any | Hold the stick, ease it back to ~0.4 → counts as released | Guards E11: release must happen where the user expects | `readDirection`, `STICK_PRESS`, `STICK_RELEASE` |
| 19 | Any | Y once, use the stick → panel shows dot, press/release rings, value/angle, state colour (grey/yellow/green/red) | Tool for tuning E10/E11 on a real controller | `updateHud` |

### Focus recovery and re-entry

| # | Where | Steps → Expected | Why it exists | Code |
|---|---|---|---|---|
| 20 | Chip bar | Focus ›, press A → arrow hides; focus on the nearest chip | Guards E12: the YouTube chip-bar arrow bug | `recoverFocus`, `gone`, `rememberRect`, `GONE_CHECK_MS` |
| 21 | Iframes | Focus F1 in the cross-origin frame, right-stick the frame until F1 is gone, ↓ → visible element in the same frame | Guards E13 (the reported "throws focus out" bug) | `reentryPoint`, `actualRect`, `sameScrollArea`, `toTop(…, clip=false)` |
| 22 | Horizontal scroller | Enter the scroller, focus Item 2, right-stick the box until Item 2 is gone, ↓ → nearest visible item in the scroller | Guards E13 outside iframes (same bug in ordinary scroll boxes) | `reentryPoint`, `scrollBox` |
| 23 | Iframes | A on "Hide me" in the cross-origin frame → nearest element in that frame | Guards E12 across frames (the frame client reports `gone`) | `startClient` (`track`), `recoverFocus` |

### Unreachable elements

| # | Where | Steps → Expected | Why it exists | Code |
|---|---|---|---|---|
| 24 | Unreachable off-screen elements | Whole-screen graph → no arrows to the drawer links (fixed panel off the right edge) or to "Clipped B/C" (overflow:hidden) | Guards E14: the esjzone.cc off-canvas `customizer` drawer | `reachable`, `usable` |

### Iframes

| # | Where | Steps → Expected | Why it exists | Code |
|---|---|---|---|---|
| 25 | Iframes | → from "Before frames" → F1 → F2 → F3 (same-origin) → F1 → F2 → F3 (cross-origin) → script-less frame (one element) | Core: frames navigate as if part of the page; frames without a client degrade to one element | `refreshFrames`, `applySnapshot`, `RemoteEl`, `toTop`, `candidatesNow` |
| 26 | Iframes | A on F1 in the cross-origin frame → status box "click in cross-origin: F1" | Core: commands reach cross-origin frames | `activate` (RemoteEl branch), `startClient` |
| 27 | Iframes | A then B on each frame's text box → focus enters then leaves; no history back | Core: B inside frames asks the frame first | `back`, `askFrameBack` |
| 28 | Iframes | Whole-screen graph → arrows cross frame borders | Core: frame elements are ordinary graph nodes | `related` (RemoteEl ancestry), `buildGraph` |

### Containers (cards)

| # | Where | Steps → Expected | Why it exists | Code |
|---|---|---|---|---|
| 29 | Containers | ↓ through the feed → card 1 → 2 → 3; hints "A open · X enter (6/5/4)" | Guards E16: cards are single stops; item counts correct | `layer`, `containerKids`, `updateHint` |
| 30 | Containers | X on card 2, move, ↓ at the bottom → only its contents; edge press shakes the ring | Guards E16: scope boundary, no escape at the edge | `enterScope`, `activeScope`, `moveNow` (edge), `bump` |
| 31 | Containers | X on the quoted post inside card 2 → second scope level, 3 items | Guards E16: nested containers stack | `scopes`, `layer` |
| 32 | Containers | B, B → quoted post, card 2, top level | Guards E16: B leaves one level at a time | `back`, `leaveScope` |
| 33 | Containers | A on a card → "open post N" | Core: A keeps the container's own click | `activate` |
| 34 | Containers | Enter card 3, remove it in devtools → scope ends, focus recovers nearby | Guards E16 + E12: recycled feed items (Twitter) | `checkScopes`, `recoverFocus` |
| 35 | Containers | "Only child" wrapper → the button is a normal target | Guards E16: single-item wrappers aren't containers | `layer` (ignored set) |
| 36 | Scroll box | → from "Before panel" → the comments panel is one stop, hint "A/X enter (n) · right stick scrolls" | Guards E17: scrollable areas are containers even when not focusable | `addScrollBoxes`, `isScrollBox`, `updateHint` |
| 37 | Scroll box | With the panel focused (not entered), right stick down → the panel scrolls, focus stays on it | Guards E17: scroll a panel directly | `scrollTarget` |
| 38 | Scroll box | A enters; ↓ past the last visible comment → the box scrolls, focus continues; B → back on the panel (no history back) | Guards E17: inside a scroll scope the edge scrolls the box before bumping | `enterOnA`, `moveNow` (edge), `canScroll`, `leaveScope` |

### Performance

| # | Where | Steps → Expected | Why it exists | Code |
|---|---|---|---|---|
| 39 | test/stress.html | In the console, time `__gpn.candidates()` and `__gpn.buildGraph(list)` → only ~100 near-screen elements processed; tens of ms | Guards E15: cost must not grow with page size | `nearViewport`, `candidatesNow`, `shadowHosts`, `buildGraph` (plain rects) |
| 40 | Twitter / long feeds | Graph view on, scroll → no sustained lag | Guards E15 on the real site it was reported on | as above, plus `findNext`/`castRay` (score before `related`), `updateHud` (change check) |

## Part 2 — Edge cases and bugs found (in order)

Each entry: **symptom** → cause → fix → where. Checks that guard it are listed.

**E1. Smooth-scroll race reset focus to the top-left.**
Moving onto an element starts a smooth scroll. The next press arrived before it
finished, the element still counted as off-screen, and the code assumed the user
had scrolled away. *Fix:* only re-enter when the user scrolled (right stick,
LT/RT, mouse wheel), not when our own scroll is in flight.
*Where:* `scrolledAway`, `moveNow` (`startOk`), `setCurrent`. *Checks:* 11.

**E2. Unreachable "orphan" elements.**
Best-target-per-direction can leave an element nothing points to (four corners
plus a small middle button E). *Fix:* a rescue pass (an orphan takes the arrow it
came closest to winning, if the displaced target still has another way in), and
the angle-penalty score `gap × (1/cos θ)^ANGLE_PENALTY`, which makes orphans
rarer. The graph view marks rescued (amber) and still-unreachable (red) elements.
*Where:* `buildGraph`, `score`, `ANGLE_PENALTY`. *Checks:* 5.

**E3. Diagonal stick fired two moves.**
A 45° push crossed both the up and right thresholds. *Fix:* one direction per
frame, from the stick's angle. *Where:* `readDirection`, `handleDirection`.
*Checks:* 13.

**E4. Pie wedges too thin; targets "behind" other targets.**
Picking the nearest center within a cone ignored what the ray actually crosses.
*Fix:* ray cast (first box hit wins), then merge wedges narrower than
`MIN_WEDGE`. Follow-up bug: a sliver merged into a locked zone kept being
re-picked and exhausted the merge loop; fixed by splitting runs by target only.
*Where:* `castRay`, `rayHit`, `angleTable`. *Checks:* 14.

**E5. Big dark gap beside a thin wedge.**
Rays that hit nothing left empty space between targets. *Fix:* a miss takes the
element whose corner is angularly closest, within `AIM_TOLERANCE`; ties go to the
nearer one, so nothing wins from behind another element.
*Where:* `castRay` (second loop). *Checks:* 15.

**E6. Repeat didn't feel like a keyboard.**
Rotating the stick counted as new presses and bypassed the initial pause.
*Fix:* move → `REPEAT_DELAY` → repeat every `REPEAT_INTERVAL`; direction
changes are rate-limited; `STICK_SETTLE` waits for a fresh push to finish before
reading its angle. *Where:* `handleDirection`, `startHold`, `sameDirection`,
`fireMove`. *Checks:* 16.

**E7. Sideways element counted as "left".**
A horizontally scrolled box made Item 1 extend further left than Game 1 above
it, so ← went almost straight down. *Fix:* reject targets that overlap on the
pressed axis but are separated across it, and anything more than
`MAX_DEVIATION` off. *Where:* `score`. *Checks:* 12.

**E8. D vanished from the stick pie.**
The stick reused the D-pad graph inside ±15° snap zones, so it inherited a D-pad
decision (B ↓ → E) and hid D, which sat entirely inside that zone. *Fix:* stick
and D-pad are fully separate: the stick is pure ray casting at every angle, and
the scoring formula is D-pad only. *Where:* `moveNow` (`dpad` branch),
`angleTable`, `resolveCardinal`. *Checks:* 6, 14.

**E9. Pressing the opposite way didn't return.**
Scoring from one element's center to the other's nearest point isn't symmetric.
*Fix:* score on the gap between the two boxes (the same from both sides), plus
"go back the way you came" right after a move. Many-to-one fan-in (five buttons
↓ into one tab) can't be fully reciprocal; the return rule covers practical use.
*Where:* `score`, `isReturn`, `RETURN_TOLERANCE`. *Checks:* 3.

**E10. Extra move on release (reported: Game 8 → 10, back → lands on 7).**
A flicked stick springs past center and back; the bounce counted as a new push,
and opposite bounces triggered "go back". *Fix:* after a release, ignore the
stick until it rests near center for `STICK_CALM_MS`, never longer than
`STICK_BOUNCE_MAX_MS`. The D-pad is unaffected. *Where:* `handleDirection`,
`readDirection` (`ignoreStick`). *Checks:* 17.

**E11. Stick still "held" after letting go.**
Press 0.6 / release 0.35 was too wide a band. *Fix:* 0.55 / 0.45; the stick
panel shows both rings live. *Where:* `STICK_PRESS`, `STICK_RELEASE`,
`updateHud`. *Checks:* 18, 19.

**E12. Focus lost when the focused element disappeared.**
YouTube's chip-bar › hides itself after scrolling the bar; the next press
restarted from the page's top-left. *Fix:* remember the last rect; every 100 ms
check whether the element was removed, hidden or disabled (being covered doesn't
count, so tooltips can't steal focus) and move to the nearest visible element.
Frames report this for their own elements. *Where:* `recoverFocus`, `gone`,
`rememberRect`, `startClient` (`track`). *Checks:* 20, 23, 34.

**E13. Focus scrolled out of an iframe or scroll box jumped to the page's top-left.**
Re-entry always started from the edge of the whole window. *Fix:* land on the
visible element nearest to where the focused one actually is now (unclipped for
frame elements), preferring the same scroll area; recovery uses the same rule.
*Where:* `reentryPoint`, `actualRect`, `sameScrollArea`, `scrollBox`, `toTop`.
*Checks:* 21, 22.

**E14. Arrows into empty space off the right edge.**
esjzone.cc keeps a `position:fixed` settings drawer (`customizer`) parked
off-screen; those links counted as reachable by scrolling. *Fix:* drop off-screen
elements no scrolling can reveal: inside a fixed panel, cut off by
`overflow:hidden/clip`, or before the page start. *Where:* `reachable`, `usable`,
`styleOf`. *Checks:* 24.

**E15. Twitter became extremely laggy with the graph view on.**
Firefox profile: `drawViz`, `findNext`, `reachable`, `related` (`parentNode`),
DOMRect getters. Every redraw checked every element on the page, compared every
pair with a DOM walk first, and scanned the whole DOM for shadow roots. *Fix:*
only elements within one screen are considered (cheap rect check first); the
containment check runs only for would-be winners; shadow-root scan cached for
1 s; plain-object rects in the graph; the stick panel redraws only on change.
*Where:* `nearViewport`, `candidatesNow`, `findNext`, `castRay`, `buildGraph`,
`shadowHosts`, `updateHud`. *Checks:* 39, 40.

**E16. Nested clickables (Twitter post card with avatar and buttons inside).**
The card hid its contents: moves never go between an element and its
descendants, and from outside the card always won. *Fix:* container scopes, like
a TV app: the card is one stop, X enters (only its contents exist), B leaves,
scopes stack, and they end if the card disappears. Page-sized (> `BIG_CONTAINER`)
and single-item wrappers don't count. *Where:* `layer`, `enterScope`,
`leaveScope`, `checkScopes`, `activeScope`, `bump`, `updateHint`, `back`.
*Checks:* 29–35.

**E17. Scrollable panels couldn't be scrolled or skipped as a unit (YouTube comment
panel, live chat, side lists).** Their items were navigated one by one with the
rest of the page, and the right stick scrolled whatever contained the focused
item. *Fix:* any box that actually scrolls (`overflow: auto/scroll` with more
content than fits) and holds focusable items is a container even if the page
didn't make it focusable: one stop; the right stick / LT / RT scroll it directly
while it's focused; A or X enters; inside, pressing past the last visible item
scrolls the box before bumping. Page-sized scroll areas stay see-through
(`BIG_CONTAINER`); scroll boxes are exempt from the single-item rule; clipped
carousels (`overflow: hidden`, e.g. YouTube's chip bar) are unaffected.
Side effect: scrolling rows (the test page's horizontal scroller) now take X to
enter, like TV app rows. *Where:* `addScrollBoxes`, `isScrollBox`,
`isScrollContainer`, `enterOnA`, `canScroll`, `scrollTarget`, `moveNow` (edge),
`layer`. *Checks:* 8, 22, 36–38.

### Test-harness pitfalls (not product bugs, but they cost time)

- **Hidden or background pane**: `requestAnimationFrame` barely runs and
  `document.hidden` is true, so the script ignores input. Use `?timer`, and in
  automation override `document.hidden`.
- **Too-short simulated presses** (keydown and keyup in the same frame) are never
  seen by polling; the keyboard shim holds presses at least 60 ms.
- **View turns navigation off**: a stray V/View press leaves it disabled; check
  the toast text.
- **The status box covers the top-right corner**: an element under it is
  correctly "covered" and skipped. Scroll the frames section lower first.
- **CSS class clashes in the test page** (`.card` already existed for the grid)
  broke a layout and looked like a script bug; the card section uses `.pcard`.
- **`localhost` vs `127.0.0.1`** are different origins; the cross-origin frame
  depends on that, so open the test page via `localhost`.

## Part 3 — Known limits

- Frames: one level only; containers aren't detected inside frames; the
  postMessage transport could be spoofed by a hostile embedding page (a hardened
  extension should use `runtime.getFrameId` plus extension messaging).
- Typing into a cross-origin frame's text field may be refused by Chrome without
  a real click there.
- Frames without the script (sandboxed, blocked) are one element.
- Only content within about one screen is a direct target; farther content is
  reached by scrolling.
- Buttons inside an `overflow:hidden` carousel are reached through the carousel's
  own arrows, not directly.
- Closed shadow roots are not reachable.
