/* The scroller's arithmetic, against a shim that actually has geometry.
 *
 * Every other test here runs on a DOM shim where everything measures zero,
 * which is fine for "does this widget throw" and useless for "does this
 * widget move when it should". The scroller is nothing BUT measurement - what
 * counts as overflow, how far to travel, whether the loop lands where it
 * started - so it gets a shim that can do sums.
 *
 * The one that matters is the seam. A continuous scroll must travel exactly
 * one copy of its content plus the gap that follows it; a pixel out and the
 * list visibly jumps once a lap, which is the whole thing this mode was
 * supposed to avoid.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..', 'web');

/* ------------------------------------------------------- geometry shim */

const GAP_PX = 6; // whatever the caller's `gap` string works out to

class Node {}

function mk(tag) {
  const attrs = new Map();
  const style = {
    _props: new Map(),
    setProperty(k, v) { this._props.set(k, v); },
    removeProperty(k) { this._props.delete(k); },
    getPropertyValue(k) { return this._props.get(k) || ''; },
  };
  const n = Object.assign(new Node(), {
    tagName: String(tag).toUpperCase(),
    style, children: [], dataset: {}, className: '', textContent: '',
    // What the caller sets; the shim turns these into scrollHeight/Width.
    _h: 0, _w: 0, _boxH: 0, _boxW: 0, _vertical: true,
    append(...kids) { this.children.push(...kids.filter(Boolean)); },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...kids) { this.children = kids.filter(Boolean); },
    remove() {
      for (const p of ALL) {
        const i = p.children.indexOf(n);
        if (i >= 0) p.children.splice(i, 1);
      }
    },
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    cloneNode() {
      const c = mk(this.tagName);
      c._h = this._h; c._w = this._w;
      c.textContent = this.textContent;
      c.style.cssText = this.style.cssText;
      return c;
    },
    addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, contains: () => false },
  });
  // A container's extent is its children laid end to end with gaps between.
  Object.defineProperties(n, {
    scrollHeight: { get() {
      if (!n.children.length) return n._h;
      return n.children.reduce((a, c) => a + (c._h || 0), 0)
        + GAP_PX * (n.children.length - 1);
    } },
    scrollWidth: { get() {
      if (!n.children.length) return n._w;
      return n.children.reduce((a, c) => a + (c._w || 0), 0)
        + GAP_PX * (n.children.length - 1);
    } },
    clientHeight: { get() { return n._boxH; } },
    clientWidth: { get() { return n._boxW; } },
    offsetHeight: { get() { return n._h; } },
    offsetWidth: { get() { return n._w; } },
  });
  ALL.push(n);
  return n;
}

const ALL = [];
globalThis.Node = Node;
globalThis.document = {
  createElement: mk, createElementNS: mk,
  head: mk('head'), body: mk('body'),
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
/* A ResizeObserver that can actually be fired.
 *
 * The re-measure path is where continuous mode can go wrong - it is the only
 * place the previous pass's copies are still in the DOM - so the test has to
 * be able to trigger it rather than approximating it by building a second
 * scroller. */
const OBSERVERS = [];
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; OBSERVERS.push(this); }
  observe(node) { this.node = node; }
  disconnect() { this.dead = true; }
};
function resize(node) {
  for (const o of OBSERVERS) if (o.node === node && !o.dead) o.cb();
}

const scroll = await import(
  pathToFileURL(resolve(WEB, 'render/widgets/scroll.js')).href);

/* --------------------------------------------------------------- tests */

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) return;
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
}

const settle = () => new Promise((r) => setTimeout(r, 400));

/** Build a column of `count` rows `rowH` tall inside a `boxH` tall block. */
async function column({ count, rowH, boxH, mode }) {
  const { outer, inner } = scroll.scrollColumn({
    gap: '0.6vmin', speed: 20, enabled: true, mode,
  });
  outer._boxH = boxH;
  for (let i = 0; i < count; i += 1) {
    const row = mk('div');
    row._h = rowH;
    row.textContent = `Event ${i + 1}`;
    inner.append(row);
  }
  await settle();
  return { outer, inner };
}

const anim = (n) => String(n.style.animation || '');
const dist = (n) => Number(String(n.style.getPropertyValue('--lb-dist') || '0')
  .replace('px', ''));
const clones = (n) => n.children.filter((c) => c.getAttribute('data-lb-clone') === '1');

// 1. Content that fits is left alone, in BOTH modes. Rule 1 of the module.
for (const mode of ['bounce', 'continuous']) {
  const { inner } = await column({ count: 3, rowH: 20, boxH: 200, mode });
  check(`${mode}: a list that fits does not move`, anim(inner) === '',
    `animation=${anim(inner)}`);
  check(`${mode}: a list that fits is not copied`, clones(inner).length === 0);
}

// 2. Real overflow bounces by default.
{
  const { inner } = await column({ count: 9, rowH: 30, boxH: 120, mode: 'bounce' });
  check('bounce: overflow animates', anim(inner).includes('lb-scroll-y'), anim(inner));
  check('bounce: eases, so the turn is not abrupt', anim(inner).includes('ease-in-out'));
  check('bounce: never copies the content', clones(inner).length === 0);
  // 9 rows of 30 + 8 gaps of 6 = 318, in a 120 box.
  check('bounce: travels the hidden distance', dist(inner) === 318 - 120,
    `got ${dist(inner)}`);
}

// 3. Continuous copies the content and loops exactly one copy plus its gap,
//    which is the difference between a seamless wrap and a visible jump.
{
  const { inner } = await column({ count: 9, rowH: 30, boxH: 120, mode: 'continuous' });
  check('continuous: overflow animates', anim(inner).includes('lb-loop-y'), anim(inner));
  check('continuous: runs at a constant speed', anim(inner).includes('linear'),
    anim(inner));
  check('continuous: never reverses', !anim(inner).includes('alternate'));
  check('continuous: appends one copy of every row', clones(inner).length === 9,
    `${clones(inner).length} clones`);
  check('continuous: copies are hidden from a screen reader',
    clones(inner).every((c) => c.getAttribute('aria-hidden') === 'true'));
  // One copy is 318 tall, and a gap of 6 sits between the two copies, so the
  // second copy's first row sits exactly 324 below the first copy's.
  check('continuous: loops one copy plus the gap', dist(inner) === 324,
    `got ${dist(inner)}, wanted 318 + ${GAP_PX}`);
}

// 4. Re-measuring must start from the original content. This is the bug the
//    mode would otherwise have: each pass measures the last pass's copies as
//    if they were content, so the list doubles every time the block is
//    resized in the editor and the loop distance runs away.
{
  const { outer, inner } = await column({
    count: 6, rowH: 40, boxH: 100, mode: 'continuous' });
  const first = dist(inner);
  check('re-measure: the first pass copied once', clones(inner).length === 6);
  for (let i = 1; i <= 3; i += 1) {
    resize(outer);                       // the real path, debounce and all
    await new Promise((r) => setTimeout(r, 700));
    check(`re-measure ${i}: copies do not accumulate`,
      clones(inner).length === 6, `${clones(inner).length} clones`);
    check(`re-measure ${i}: the loop distance is stable`, dist(inner) === first,
      `${dist(inner)} vs ${first}`);
  }
}

// 5. A long title loops sideways with a separator, so the repeat does not run
//    into the end of the original.
{
  const node = scroll.scrollingText('Quarterly Infrastructure Review', {
    speed: 30, enabled: true, mode: 'continuous',
  });
  node._boxW = 100;
  const inner = node.children[0];
  const span = inner.children[0];
  span._w = 400; span._h = 14;
  await settle();
  check('title: text became a child so it can be copied', !!span);
  check('title: loops sideways', anim(inner).includes('lb-loop-x'), anim(inner));
  check('title: repeat is separated', String(inner.style.gap || '') !== '');
  check('title: one copy appended', clones(inner).length === 1);
  check('title: loops the text plus the separator', dist(inner) === 400 + GAP_PX,
    `got ${dist(inner)}`);
}

// 6. A short title still ellipses rather than sliding - unchanged behaviour.
{
  const node = scroll.scrollingText('Gym', { speed: 30, enabled: true, mode: 'continuous' });
  node._boxW = 200;
  const inner = node.children[0];
  inner.children[0]._w = 30;
  inner.children[0]._h = 14;
  await settle();
  check('title: a short one does not move', anim(inner) === '', anim(inner));
  check('title: a short one is not copied', clones(inner).length === 0);
}

// 7. The decision is readable out of the DOM, which is how this gets debugged
//    on an appliance with no devtools and the board across the room.
{
  const { inner } = await column({ count: 9, rowH: 30, boxH: 120, mode: 'continuous' });
  const note = inner.getAttribute('data-lb-scroll') || '';
  check('the reason is left on the element', note.includes('continuous'), note);
}

if (failures) {
  console.log(`\n${failures} scroll failure(s)`);
  process.exit(1);
}
console.log('scroll: bounce and continuous both measure, and the loop is seamless');
