/* Auto-scrolling for content that does not fit its block.
 *
 * A wall display has no scrollbar and nobody to drag one. When a Tuesday has
 * nine appointments in a block sized for four, or a meeting is called
 * "Quarterly Infrastructure Review - Bridgewater Site (Teams)", the board's
 * only honest options are to lie about it ("+5", an ellipsis) or to move.
 * This module moves.
 *
 * TWO RULES IT IS BUILT AROUND
 * ----------------------------
 * 1. NOTHING MOVES UNLESS IT HAS TO. Overflow is measured; content that fits
 *    is left completely alone. A board where every label drifts is worse than
 *    one that truncates, and on a Pi 3 it is also a real cost.
 * 2. THE ANIMATION IS CSS, NOT JAVASCRIPT. Two keyframe rules, injected once,
 *    driving `transform` only - so the compositor does the work and the main
 *    thread stays free for the fetches the board actually needs. A rAF loop
 *    per label would not survive twenty of them on this hardware.
 *
 * The measurement is the part that has bitten this project before (see the
 * chip-sizing saga): a block that has not been laid out yet reports zero, and
 * a measurement taken then is not wrong-ish, it is meaningless. So every
 * measurement retries until the element has a size, and re-runs when the
 * block is resized in the editor.
 *
 * TWO WAYS TO MOVE
 * ----------------
 * `bounce` (the default) runs to the end, pauses, and comes back. It is the
 * honest choice for a SHORT overflow - two hidden rows out of nine - because
 * the reader keeps their place: the list they glance back at is the list they
 * just looked away from.
 *
 * `continuous` runs one way forever, like credits. It suits a LONG list,
 * where bouncing means the last item is only ever on screen for the instant
 * before the list turns round, and it suits a board somebody watches rather
 * than checks. It works by appending a second copy of the content and looping
 * the exact distance between copy one and copy two, so the wrap lands on a
 * frame identical to the one before it and there is no visible seam.
 */

/* Timing, as a fraction of one cycle. The pauses at each end are not
 * decoration: text that arrives at its far edge and immediately turns round
 * is unreadable exactly where the reader has just caught up with it. */
const CSS = `
@keyframes lb-scroll-y {
  0%, 12%  { transform: translateY(0); }
  50%, 62% { transform: translateY(calc(-1 * var(--lb-dist, 0px))); }
  100%     { transform: translateY(0); }
}
@keyframes lb-scroll-x {
  0%, 14%  { transform: translateX(0); }
  52%, 66% { transform: translateX(calc(-1 * var(--lb-dist, 0px))); }
  100%     { transform: translateX(0); }
}
@keyframes lb-loop-y {
  from { transform: translateY(0); }
  to   { transform: translateY(calc(-1 * var(--lb-dist, 0px))); }
}
@keyframes lb-loop-x {
  from { transform: translateX(0); }
  to   { transform: translateX(calc(-1 * var(--lb-dist, 0px))); }
}
.lb-scroll-inner { will-change: transform; }
`;

/* The moving leg is 38% of the cycle (12% -> 50%). Turning "pixels per second
 * of actual travel" into a total duration means dividing by that, or a long
 * list crawls and a short one whips past. */
const TRAVEL_FRACTION = 0.38;

let injected = false;

function injectCSS() {
  if (injected) return;
  injected = true;
  // The test shim has no real head; a board that cannot inject simply does
  // not animate, which is the correct degradation.
  try {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
  } catch { /* no document.head - shim, or a detached render */ }
}

/* Measure `node` once it actually has a size, then again whenever it changes.
 *
 * Returns a disposer. Widgets that redraw wholesale (the calendar redraws
 * every few minutes) throw the old nodes away, so the observers must go with
 * them or a board accumulates one per redraw for months.
 */
export function whenSized(node, measure, { retries = 20, delay = 120, settle = 0 } = {}) {
  let dead = false;
  let observer = null;
  let attempts = 0;

  /* `settle` waits a beat after the element has a size before measuring.
   *
   * Continuous scrolling copies the content, and the copy is only faithful
   * once the things INSIDE it have settled - a title that scrolls sideways
   * applies its own animation on a later frame, and a copy taken before that
   * is a still of a moving part. Bounce mode needs none of this and passes 0.
   */
  const run = () => {
    if (dead) return;
    if (settle > 0) setTimeout(() => { if (!dead) measure(); }, settle);
    else measure();
  };

  const attempt = () => {
    if (dead) return;
    // A shim element has no numeric geometry at all. Not an error - there is
    // simply nothing to measure, and pretending otherwise is how a test
    // passes over code that never ran.
    const height = node.clientHeight;
    const width = node.clientWidth;
    if (!Number.isFinite(height) || !Number.isFinite(width)) return;
    if (height === 0 && width === 0 && attempts < retries) {
      attempts += 1;
      setTimeout(attempt, delay);
      return;
    }
    run();
  };

  // Two frames: one for the element to be in the document, one for layout to
  // have happened. One frame is enough on a laptop and not on a Pi.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(attempt));
  } else {
    setTimeout(attempt, 0);
  }

  if (typeof ResizeObserver === 'function') {
    let pending = null;
    observer = new ResizeObserver(() => {
      // Debounced: applying an animation changes nothing about layout, but a
      // drag in the editor fires this continuously.
      clearTimeout(pending);
      pending = setTimeout(() => { if (!dead) run(); }, 200);
    });
    try { observer.observe(node); } catch { /* shim */ }
  }

  return () => { dead = true; observer?.disconnect(); };
}

/* HOW MUCH OVERFLOW COUNTS AS "CUT OFF".
 *
 * Not "more than zero". A block whose content is nine pixels taller than its
 * box has nothing hidden that anyone could read, and animating it produces
 * exactly the complaint this replaced: two appointments, both plainly
 * visible, bouncing up and down forever.
 *
 * So the threshold is expressed in the units of the thing being hidden - a
 * fraction of one card, one row, one line of text - with a small floor for
 * sub-pixel rounding and a ceiling relative to the box, so a single item far
 * taller than its container still scrolls rather than setting a threshold
 * nothing can exceed.
 *
 * `unit` is the height (or line height) of the item at the clipped edge.
 */
export function scrollThreshold(unit, container) {
  const fromItem = Math.max(6, (Number(unit) || 0) * 0.35);
  const cap = (Number(container) || 0) * 0.25;
  return cap > 6 ? Math.min(fromItem, cap) : fromItem;
}

function applyAnimation(inner, name, distance, speed, threshold) {
  const moving = distance > threshold;

  /* Leave the decision on the element.
   *
   * The appliance has no devtools and the board is across the room, so "why
   * is that block moving when it clearly fits" was answerable only by
   * reasoning about pixels I could not see. This makes it a fact anyone can
   * read out of the DOM. It costs one attribute per scroller. */
  inner.setAttribute?.('data-lb-scroll',
    `overflow=${Math.round(distance)} threshold=${threshold.toFixed(1)} `
    + `-> ${moving ? 'scrolling' : 'static'}`);

  if (!moving) {
    // Nothing meaningful is hidden. Leave it completely static - see rule 1.
    inner.style.animation = '';
    inner.style.removeProperty?.('--lb-dist');
    return false;
  }
  const seconds = Math.min(180, Math.max(8, (distance / Math.max(4, speed)) / TRAVEL_FRACTION));
  inner.style.setProperty?.('--lb-dist', `${Math.round(distance)}px`);
  inner.style.animation = `${name} ${seconds.toFixed(1)}s ease-in-out infinite`;
  return true;
}

/* ----------------------------------------------------------- continuous */

const CLONE_FLAG = 'data-lb-clone';

/* Throw away the copies a previous continuous pass appended.
 *
 * Every re-measure starts from the original content. Measuring a container
 * that already holds a copy of itself would double the distance each time,
 * and after three resizes in the editor the list would be crawling through
 * eight copies of Tuesday.
 */
function stripClones(inner) {
  for (const node of [...(inner.children || [])]) {
    if (node.getAttribute?.(CLONE_FLAG) === '1') node.remove();
  }
}

/* One-way loop with no seam.
 *
 * The trick is that the loop distance is NOT the overflow - it is the length
 * of one full copy of the content, gap included. Travel exactly that far and
 * the second copy is sitting precisely where the first one started, so the
 * jump back to 0 is invisible. Getting it from the DOM rather than by parsing
 * the CSS gap means the flex gap can be any unit the caller likes.
 *
 * `axis` is 'y' or 'x'; `unit` is the item at the clipped edge, as elsewhere.
 */
function applyLoop(inner, axis, { extent, box, speed, unit }) {
  const vertical = axis === 'y';
  const overflow = extent - box;
  const threshold = scrollThreshold(unit, box);

  inner.setAttribute?.('data-lb-scroll',
    `overflow=${Math.round(overflow)} threshold=${threshold.toFixed(1)} `
    + `-> ${overflow > threshold ? 'continuous' : 'static'}`);

  if (!(overflow > threshold)) {
    // Rule 1 still applies. A list that fits does not need to be a carousel.
    inner.style.animation = '';
    inner.style.removeProperty?.('--lb-dist');
    return false;
  }

  const originals = [...(inner.children || [])];
  for (const node of originals) {
    const copy = node.cloneNode(true);
    copy.setAttribute?.(CLONE_FLAG, '1');
    // The copy is decoration: it says nothing a reader has not already been
    // told, so it should not be read out twice.
    copy.setAttribute?.('aria-hidden', 'true');
    inner.append(copy);
  }

  // Content plus the gap that now sits between the two copies.
  const after = vertical ? (inner.scrollHeight || 0) : (inner.scrollWidth || 0);
  const distance = after - extent;
  if (!(distance > 0)) {
    // No measurable copy - a shim, or a container that reports nothing.
    stripClones(inner);
    inner.style.animation = '';
    return false;
  }

  // Linear, and no pause: a continuous scroll that hesitates once per lap is
  // just a bounce with extra steps.
  const seconds = Math.min(600, Math.max(6, distance / Math.max(4, speed)));
  inner.style.setProperty?.('--lb-dist', `${Math.round(distance)}px`);
  inner.style.animation =
    `lb-loop-${axis} ${seconds.toFixed(1)}s linear infinite`;
  return true;
}

/* ------------------------------------------------------------- vertical */

/* A column that scrolls its own contents up and down when they overflow.
 *
 * Returns { outer, inner, dispose }. Append to `inner`; put `outer` where the
 * column used to go. The gap and direction live on `inner` so the caller's
 * flex layout is unchanged - the wrapper is invisible when nothing overflows.
 */
export function scrollColumn({ gap = '0', speed = 22, enabled = true,
                               mode = 'bounce' } = {}) {
  injectCSS();
  const loop = mode === 'continuous';

  const inner = document.createElement('div');
  Object.assign(inner.style, {
    display: 'flex', flexDirection: 'column', gap, minHeight: '0',
  });
  const outer = document.createElement('div');
  Object.assign(outer.style, {
    overflow: 'hidden', minHeight: '0', minWidth: '0', flex: '1 1 auto',
  });
  outer.append(inner);

  let dispose = () => {};
  if (enabled) {
    inner.className = 'lb-scroll-inner';
    dispose = whenSized(outer, () => {
      // Measured with the animation cleared: a mid-cycle transform does not
      // change scrollHeight, but clearing first means a block that has just
      // been made taller stops moving instead of animating to a stale
      // distance. Clones go too, or each pass measures the previous one's
      // copy as if it were content.
      inner.style.animation = '';
      if (loop) stripClones(inner);
      const height = outer.clientHeight || 0;
      const extent = inner.scrollHeight || 0;
      // The item at the bottom edge is the one being cut off, so it is the
      // one that decides whether anything is actually hidden.
      const kids = inner.children || [];
      const last = kids[kids.length - 1];
      if (loop) {
        applyLoop(inner, 'y',
          { extent, box: height, speed, unit: last?.offsetHeight });
      } else {
        applyAnimation(inner, 'lb-scroll-y', extent - height, speed,
          scrollThreshold(last?.offsetHeight, height));
      }
    }, { settle: loop ? 180 : 0 });
  }
  outer._lbDispose = dispose;

  return { outer, inner, dispose };
}

/* ----------------------------------------------------------- horizontal */

/* One line of text that slides left and back when it is too long for its box.
 *
 * Replaces `text-overflow: ellipsis` at the call site. An ellipsis on a wall
 * display is a promise the board cannot keep: "Quarterly Infrastructure Rev..."
 * and "Quarterly Infrastructure Review CANCELLED" look identical from the
 * kitchen.
 */
export function scrollingText(text, { speed = 34, enabled = true, style = {},
                                      mode = 'bounce' } = {}) {
  injectCSS();
  const loop = enabled && mode === 'continuous';

  const inner = document.createElement('div');
  Object.assign(inner.style, {
    whiteSpace: 'nowrap', ...style,
  });
  const label = text == null ? '' : String(text);

  if (loop) {
    /* The text has to become a CHILD rather than the content, because a
     * continuous loop repeats by copying children and there is nothing to
     * copy in a text node. The gap is the separator: without it the repeat
     * reads "...Bridgewater SiteQuarterly Infrastructure...". */
    inner.style.display = 'flex';
    inner.style.gap = '2.5em';
    const span = document.createElement('span');
    span.style.whiteSpace = 'nowrap';
    span.textContent = label;
    inner.append(span);
  } else {
    inner.textContent = label;
  }

  /* THE WRAPPER IS A FLEX CONTAINER, AND THAT IS NOT A STYLE CHOICE.
   *
   * As a plain block containing an inline-block it gets a LINE BOX, whose
   * height is at least the strut - the wrapper's own inherited font-size and
   * line-height. The wrapper inherits ~16px from the board while the title
   * inside it is ~12px, so measured on the appliance's own Chromium every
   * title wrapper came out 19.00px tall around 14.39px of text.
   *
   * Four and a half pixels per title, and a day with two appointments is
   * therefore nine pixels "taller" than its contents while displaying all of
   * them perfectly. That is enough to look like overflow, which is what set a
   * column of two visible events bouncing up and down.
   *
   * A flex container has no line boxes, so it has no strut: the wrapper is
   * exactly as tall as the text in it.
   */
  const outer = document.createElement('div');
  Object.assign(outer.style, {
    display: 'flex', overflow: 'hidden', minWidth: '0', whiteSpace: 'nowrap',
  });
  outer.append(inner);

  if (!enabled) {
    // Static fallback keeps the old behaviour exactly, ellipsis and all - and
    // carries no `will-change: transform`, which on a static element is a
    // compositor layer bought for nothing. flex-shrink lets it be squeezed to
    // the wrapper, which is what makes the ellipsis appear.
    inner.style.flex = '0 1 auto';
    inner.style.overflow = 'hidden';
    inner.style.textOverflow = 'ellipsis';
    return outer;
  }

  // Never shrink: the whole point is to be wider than the wrapper so there is
  // something to slide. flex-shrink defaults to 1, which would quietly size
  // it to fit and guarantee nothing ever scrolls.
  inner.style.flex = '0 0 auto';

  inner.className = 'lb-scroll-inner';
  outer._lbDispose = whenSized(outer, () => {
    inner.style.animation = '';
    if (loop) stripClones(inner);
    const width = outer.clientWidth || 0;
    const extent = inner.scrollWidth || 0;
    // A line of text is the unit here, so the floor does the work: a title
    // clipped by less than about half a character is not clipped.
    if (loop) {
      applyLoop(inner, 'x',
        { extent, box: width, speed, unit: inner.offsetHeight });
    } else {
      applyAnimation(inner, 'lb-scroll-x', extent - width, speed,
        scrollThreshold(inner.offsetHeight, width));
    }
  });

  return outer;
}

/* Tear down every scroller under `root`.
 *
 * scrollingText hands its disposer back on the node because its callers build
 * dozens of them inline, and threading a list of disposers through every
 * calendar style would be noise. The widget calls this once per redraw.
 */
export function disposeScrollers(root) {
  if (!root) return;
  const walk = (node) => {
    if (node._lbDispose) { try { node._lbDispose(); } catch { /* already gone */ } }
    for (const child of node.children || []) walk(child);
  };
  walk(root);
}
