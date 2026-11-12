/* Making a block respond to a finger.
 *
 * A wall display is not a desktop and not a phone. It is a screen somebody
 * walks up to, touches once, and walks away from - usually without watching to
 * see what happened. Everything here follows from that.
 *
 * WHAT A TAP ON A WALL HAS TO DO
 * -------------------------------
 * 1. **Answer instantly.** The round trip to Google is 200-800ms and the write
 *    can fail. If the tick waits for the server, the board feels broken and
 *    people tap again. So the change is applied locally first and reverted if
 *    the write fails - and the revert has to be visible, or a failed write
 *    looks like a successful one.
 *
 * 2. **Be hard to do by accident and easy to do on purpose.** A 2vmin checkbox
 *    is about 8mm on a 32" screen: reachable with a mouse, not with a thumb.
 *    The hit area is enlarged beyond the drawn control rather than the control
 *    being made ugly.
 *
 * 3. **Never fire twice.** A resistive panel and a cold finger produce double
 *    taps constantly, and the second one un-ticks what the first ticked. Every
 *    handler here is locked while its write is in flight.
 *
 * 4. **Say when it will not work.** These writes can be refused by the server
 *    (`allow_complete` off on the source). A checkbox that silently does
 *    nothing is worse than one that says why.
 *
 * WHY NOT JUST `onclick`
 * -----------------------
 * Chromium synthesises a click ~300ms after a touch, and on a kiosk with no
 * mouse that delay is the whole interaction. `pointerdown` fires immediately,
 * and `touch-action: manipulation` on the board removes the double-tap-zoom
 * wait that causes it.
 */

const PRESSED_MS = 140;

/* Board-level touch behaviour, applied once when a screen is marked as touch.
 *
 * These are all about REMOVING browser conveniences that are hostile on a
 * kiosk: text selection on long-press, the magnifier callout, tap highlight,
 * and the zoom gesture that makes a board drift off-centre with no way to put
 * it back. */
export function enableTouchMode(root) {
  if (!root || root._lbTouchMode) return;
  root._lbTouchMode = true;
  try {
    const style = document.createElement('style');
    style.textContent = `
      .lb-touch, .lb-touch * {
        touch-action: manipulation;
        -webkit-user-select: none; user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
      }
      .lb-tap { cursor: pointer; }
      .lb-tap-pressed { transform: scale(0.94); filter: brightness(1.35); }
      .lb-tap, .lb-tap-target { transition: transform .1s ease, filter .1s ease; }
      /* The hit area is grown with a pseudo-element so the drawn control keeps
         its size. Padding would move everything around it. */
      .lb-tap-target { position: relative; }
      .lb-tap-target::after {
        content: ''; position: absolute;
        /* The four longhands rather than the inset shorthand.
           This is an injected STYLESHEET, so it never passes through el()'s
           style handling - and inset is Chrome 87, which the TV is not. An old
           engine drops the whole declaration silently, and the enlarged hit
           area quietly stops existing: the checkbox still works, it just
           becomes as hard to hit as it was before any of this was added.
           (No backticks in here: this comment lives inside a template
           literal, and one would end the string.) */
        top: -1.4vmin; right: -1.4vmin; bottom: -1.4vmin; left: -1.4vmin;
      }
    `;
    document.head.append(style);
    root.classList?.add('lb-touch');
  } catch { /* shim, or a detached render */ }
}

/* Make one element tappable.
 *
 * `handler` returns a promise. Resolving means it worked; throwing means it
 * did not and whatever was shown optimistically must be put back - which is
 * `revert`'s job, passed separately because only the caller knows what it drew.
 */
export function tappable(node, handler, { revert = null, grow = true } = {}) {
  if (!node) return node;
  // Injected on first use rather than from a board-level setting. There is no
  // screen where selecting the text of a task, or double-tap-zooming the
  // board off-centre with no way to put it back, is wanted - so there is
  // nothing to configure. What IS per-block is whether a widget offers a
  // control at all, and that is each widget's own `interactive` field.
  enableTouchMode(document.body);
  node.classList?.add('lb-tap');
  if (grow) node.classList?.add('lb-tap-target');
  node.setAttribute?.('role', 'button');
  node.setAttribute?.('tabindex', '0');

  let busy = false;

  const fire = async (event) => {
    // A pointerdown AND the click Chromium synthesises after it would both
    // arrive. Taking the first and cancelling the rest is what stops one
    // finger counting as two.
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (busy) return;
    busy = true;
    node.classList?.add('lb-tap-pressed');
    setTimeout(() => node.classList?.remove('lb-tap-pressed'), PRESSED_MS);
    try {
      await handler();
    } catch (err) {
      try { revert?.(err); } catch { /* the caller's problem, not ours */ }
      flash(node, String(err?.message || err));
    } finally {
      busy = false;
    }
  };

  node.addEventListener('pointerdown', fire);
  // Keyboard is not for the wall - it is for testing the board from a laptop
  // without a touchscreen, which is how most of this gets exercised.
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') fire(e);
  });
  return node;
}

/* Say something went wrong, near the thing that was touched.
 *
 * Not a toast in the corner: the person is standing at the board looking at
 * the row they just pressed, and a message anywhere else will not be read.
 * It clears itself, because nobody is coming back to dismiss it.
 */
export function flash(node, message, seconds = 6) {
  if (!node || !message) return;
  try {
    const host = node.closest?.('[data-lb-widget]') || node.parentElement || node;
    const existing = host.querySelector?.('.lb-tap-error');
    if (existing) existing.remove();
    const bubble = document.createElement('div');
    bubble.className = 'lb-tap-error';
    bubble.textContent = message.slice(0, 200);
    Object.assign(bubble.style, {
      position: 'absolute', left: '0', right: '0', bottom: '0',
      background: 'rgba(120,30,30,.94)', color: '#fff',
      font: '400 1.5vmin/1.35 Inter, system-ui, sans-serif',
      padding: '.8vmin 1.1vmin', zIndex: '40', borderRadius: '0 0 6px 6px',
    });
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.append(bubble);
    setTimeout(() => bubble.remove(), seconds * 1000);
  } catch { /* never let an error message cause an error */ }
}

/* A checkbox sized for a finger.
 *
 * Returned rather than drawn inline by each widget so the tasks list, the
 * Kanban card and the sticky note all present the same target - somebody who
 * has learnt to tick one has learnt to tick all three.
 */
export function checkbox(done, size = 2.6) {
  const box = document.createElement('div');
  Object.assign(box.style, {
    width: `${size}vmin`, height: `${size}vmin`, flex: '0 0 auto',
    borderRadius: `${size * 0.22}vmin`,
    border: `${Math.max(1, size * 0.08)}px solid rgba(255,255,255,.45)`,
    background: done ? '#7fb069' : 'transparent',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: `${size * 0.7}vmin`, color: '#10240c', fontWeight: '700',
    lineHeight: '1',
  });
  box.textContent = done ? '✓' : '';
  box.setLb = (next) => {
    box.style.background = next ? '#7fb069' : 'transparent';
    box.textContent = next ? '✓' : '';
  };
  return box;
}
