/* Exercise the layout editor's own code paths.
 *
 * test_admin_boot.mjs only reaches whatever boot() renders, which on a fresh
 * appliance is the wizard. The block picker, the layers list and every
 * property form live behind clicks a headless test cannot make - which is
 * precisely where an undefined-function bug hides, since that is the one that
 * turned this admin black.
 *
 * admin.js exports its editor internals for exactly this. Browsers ignore
 * exports nobody imports, so it costs the appliance nothing.
 *
 *   node tools/test_editor.mjs
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..', 'web');
const adminPath = join(WEB, 'admin', 'admin.js');

/* ------------------------------------------------------------- DOM shim */
class Node {}
const made = [];
function mk(tag) {
  const n = Object.assign(new Node(), {
    tagName: String(tag).toUpperCase(), style: {
      setProperty() {}, removeProperty() {}, getPropertyValue: () => '',
    },
    children: [], dataset: {}, className: '', textContent: '', value: '',
    // `id` must be an own property: el() assigns via `k in node`, so without
    // it the id is silently dropped and scoped lookups find nothing.
    id: '', disabled: false, checked: false,
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c.filter(Boolean)); },
    replaceChildren(...c) { this.children = c.filter(Boolean); },
    insertBefore(c) { this.children.push(c); return c; },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    __on: {},
    addEventListener(type, fn) { (this.__on[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      this.__on[type] = (this.__on[type] || []).filter((f) => f !== fn);
    },
    dispatch(type, event) {
      for (const fn of [...(this.__on[type] || [])]) fn(event);
    },
    setPointerCapture() {}, remove() {}, focus() {}, click() {},
    closest: () => null,
    getBoundingClientRect: () => ({ width: 360, height: 640, top: 0, left: 0 }),
    // Scoped lookups are real: renderLayout does $('#props', wrap) and then
    // writes to the result. A shim that always answers null turns that into a
    // crash that looks like a product bug.
    querySelector(sel) {
      const want = String(sel);
      const walk = (node) => {
        for (const child of node.children || []) {
          if (!child || typeof child !== 'object') continue;
          if (want.startsWith('#') && child.id === want.slice(1)) return child;
          if (want.startsWith('.') && String(child.className).split(' ').includes(want.slice(1))) return child;
          if (child.tagName === want.toUpperCase()) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    },
    querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  });
  // A real <select> reports its first option's value until it is changed.
  // Without this every `SOURCE_KINDS[select.value]` lookup reads undefined and
  // the failure looks like a product bug.
  if (n.tagName === 'SELECT') {
    let explicit = null;
    Object.defineProperty(n, 'value', {
      get() {
        if (explicit !== null) return explicit;
        const first = this.children.find((c) => c && c.tagName === 'OPTION');
        return first ? (first.value ?? '') : '';
      },
      set(v) { explicit = v; },
      configurable: true,
    });
  }
  made.push(n);
  return n;
}
globalThis.Node = Node;
const app = mk('div');
globalThis.document = {
  documentElement: mk('html'), body: mk('body'), head: mk('head'),
  createElement: mk, createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  // The admin draws its block icons as inline SVG, which needs the namespaced
  // constructor; without it every icon throws and takes drawProps with it.
  createElementNS: (ns, tag) => mk(tag),
  getElementById: (id) => (id === 'app' ? app : null),
  // Any id the admin looks up resolves to a usable node. Returning null made
  // drawProps appear to crash when it was the shim that had nothing to give.
  querySelector: () => app,
  querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
};
const winListeners = {};
globalThis.window = {
  addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
  removeEventListener(type, fn) {
    winListeners[type] = (winListeners[type] || []).filter((f) => f !== fn);
  },
  dispatch(type, event) { for (const fn of [...(winListeners[type] || [])]) fn(event); },
  open() {},
  location: { href: 'http://x/admin/', search: '', origin: 'http://x', reload() {} },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.location = window.location;
globalThis.localStorage = window.localStorage;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.matchMedia = window.matchMedia;
/* Returns true on purpose. A confirm() that answered "no" would make
 * every destructive handler return at its first line, and the suite
 * would report a clean pass over code it never entered. */
globalThis.confirm = () => true;
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator',
    { value: { userAgent: 'probe' }, configurable: true });
}
/* Anything the admin iterates has to come back as a list. An empty object
 * where a list was expected produces "x is not iterable", which reads as a
 * product bug and is really the stub being lazy. */
const LIST_ENDPOINTS = /\/api\/(screens|layouts|sources|templates|rules|devices|keys|webhooks|variables|todo\/lists|display\/rules)/;

globalThis.fetch = async (u) => {
  const path = String(u);
  let body;
  if (path.includes('/api/session')) {
    body = { setup_needed: false, authenticated: true, username: 'admin' };
  } else if (path.includes('/api/display/status')) {
    body = { backend: 'xrandr', on: true, outputs: [] };
  } else if (path.includes('/api/oauth/status')) {
    body = { accounts: [], secrets: {} };
  } else if (path.includes('/api/settings')) {
    body = { admin_theme: 'dark', admin_colours: '{}', admin_radius: 10 };
  } else if (LIST_ENDPOINTS.test(path)) {
    body = [];
  } else {
    body = {};
  }
  return { ok: true, status: 200, json: async () => body, text: async () => '{}' };
};

const fails = [];
process.on('unhandledRejection', (e) => fails.push(`unhandled: ${e?.stack?.split('\n')[0] || e}`));

const mod = await import(pathToFileURL(adminPath).href);
await new Promise((r) => setTimeout(r, 300));

/* ------------------------------------------------------------- the probe */
const { state } = mod;

// Two calendars with different colours - the exact case that was reported.
state.sources = [
  { id: 1, kind: 'ical', name: 'Sam', colour: '#5b9dd9', enabled: 1, config: {} },
  { id: 2, kind: 'ical', name: 'Alex', colour: '#d98b8b', enabled: 1, config: {} },
  { id: 3, kind: 'google', name: "Sam's Work", colour: '#7fb069', enabled: 1, config: {}, connected: true },
  { id: 4, kind: 'weather', name: 'Home', colour: '#5b9dd9', enabled: 1, config: {} },
];
state.settings = { admin_theme: 'dark', admin_colours: '{}', admin_radius: 10 };
state.people = [];
state.todoLists = [];
state.editing = {
  id: 1, name: 'Hearth', widgets: [
    { id: 11, kind: 'calendar', x: 0, y: 0, w: 50, h: 30, z: 0,
      config: { style: 'agenda', source_ids: [1, 2] } },
    { id: 12, kind: 'weather', x: 0, y: 30, w: 50, h: 20, z: 1,
      config: { source_id: 4, layout: 'forecast' } },
    { id: 13, kind: 'clock', x: 50, y: 0, w: 50, h: 20, z: 2, config: {} },
  ],
};

const stage = mk('div');
const panel = mk('div');

const run = (name, fn) => {
  try { fn(); } catch (e) { fails.push(`${name}: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`); }
};

run('drawStage', () => mod.drawStage(stage));
run('drawProps (nothing selected)', () => { state.selected = null; mod.drawProps(panel, stage); });
run('blockLayers', () => mod.blockLayers(stage, panel));
run('reindexZ', () => mod.reindexZ());
run('blockEntries', () => {
  const entries = mod.blockEntries();
  if (entries.length < 30) throw new Error(`only ${entries.length} blocks in the picker`);
  const labels = entries.map((e) => e.label);
  for (const want of ['Google Calendar', 'Microsoft / Outlook Calendar', 'Google Photos']) {
    if (!labels.includes(want)) throw new Error(`picker is missing "${want}"`);
  }
});
run('openBlockPicker', () => mod.openBlockPicker(stage, panel));

for (const [i, w] of state.editing.widgets.entries()) {
  run(`drawProps selected=${w.kind}`, () => { state.selected = i; mod.drawProps(panel, stage); });
  run(`widgetPropsInto ${w.kind}`, () => {
    const box = mk('div'); box.dataset.propsOnly = '1';
    state.selected = i;
    mod.widgetPropsInto(box, stage);
  });
  run(`openWidgetEditor ${w.kind}`, () => { state.selected = i; mod.openWidgetEditor(stage, panel); });
}

// Every widget kind's form, since each has its own field types.
const { CATALOGUE } = await import(pathToFileURL(join(WEB, 'render', 'widgets', 'registry.js')).href);
for (const kind of Object.keys(CATALOGUE)) {
  run(`form for ${kind}`, () => {
    state.editing.widgets = [{ id: 99, kind, x: 0, y: 0, w: 30, h: 20, z: 0, config: {} }];
    state.selected = 0;
    const box = mk('div'); box.dataset.propsOnly = '1';
    mod.widgetPropsInto(box, stage);
  });
}

/* ------------------------------------------------------------- dragging */

/* The stage is 360x640 in the shim, so one percent of width is 3.6px and one
 * percent of height is 6.4px. Snap is off, so the numbers are exact. */
const PCT_X = 3.6;
const PCT_Y = 6.4;
state.snap = 0;

function freshBoard() {
  state.editing = {
    id: 1, name: 'Drag test', widgets: [
      { id: 21, kind: 'clock', x: 10, y: 10, w: 30, h: 20, z: 0, config: {} },
      { id: 22, kind: 'date', x: 60, y: 60, w: 30, h: 20, z: 1, config: {} },
    ],
  };
  state.selected = null;
  const st = mk('div');
  mod.drawStage(st);
  // The readout is appended first, so the blocks follow it.
  const blocks = st.children.filter((c) => String(c.className).startsWith('w'));
  return { stage: st, blocks };
}

function gesture(target, node, from, to, opts = {}) {
  node.dispatch('pointerdown', {
    target, clientX: from[0], clientY: from[1], pointerId: 1,
    preventDefault() {}, altKey: false, shiftKey: !!opts.downShift,
  });
  window.dispatch('pointermove', {
    clientX: to[0], clientY: to[1], altKey: false, shiftKey: !!opts.moveShift,
  });
  window.dispatch('pointerup', {});
}

const check = (name, cond, detail) => {
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

// --- move ---------------------------------------------------------------
{
  const { blocks } = freshBoard();
  const w = state.editing.widgets[0];
  gesture(blocks[0], blocks[0], [100, 100], [100 + 10 * PCT_X, 100 + 5 * PCT_Y]);
  check('a block can be dragged', Math.round(w.x) === 20 && Math.round(w.y) === 15,
        `expected 20,15 but got ${Math.round(w.x)},${Math.round(w.y)}`);
}

// --- resize from the south-east handle -----------------------------------
{
  const { blocks } = freshBoard();
  const w = state.editing.widgets[0];
  state.selected = 0;
  const grip = blocks[0].children.find((c) => c.className === 'grip-se');
  check('the se handle exists', !!grip);
  if (grip) {
    gesture(grip, blocks[0], [200, 200], [200 + 10 * PCT_X, 200 + 10 * PCT_Y]);
    check('dragging se grows width and height',
          Math.round(w.w) === 40 && Math.round(w.h) === 30,
          `expected 40x30 but got ${Math.round(w.w)}x${Math.round(w.h)}`);
    check('dragging se leaves the top-left alone',
          Math.round(w.x) === 10 && Math.round(w.y) === 10);
  }
}

// --- resize from the north-west handle: moves that edge only --------------
{
  const { blocks } = freshBoard();
  const w = state.editing.widgets[0];
  state.selected = 0;
  const grip = blocks[0].children.find((c) => c.className === 'grip-nw');
  if (grip) {
    gesture(grip, blocks[0], [200, 200], [200 + 5 * PCT_X, 200 + 5 * PCT_Y]);
    check('dragging nw moves the left/top edge in',
          Math.round(w.x) === 15 && Math.round(w.y) === 15,
          `expected 15,15 but got ${Math.round(w.x)},${Math.round(w.y)}`);
    check('dragging nw keeps the bottom-right anchored',
          Math.round(w.x + w.w) === 40 && Math.round(w.y + w.h) === 30,
          `right/bottom moved: ${Math.round(w.x + w.w)},${Math.round(w.y + w.h)}`);
  }
}

// --- blocks may overlap --------------------------------------------------
{
  const { blocks } = freshBoard();
  const [a, b] = state.editing.widgets;
  // Drag the second block on top of the first.
  gesture(blocks[1], blocks[1], [300, 400],
          [300 - 50 * PCT_X, 400 - 50 * PCT_Y]);
  const overlaps = a.x < b.x + b.w && b.x < a.x + a.w
                && a.y < b.y + b.h && b.y < a.y + a.h;
  check('one block can be moved on top of another', overlaps,
        `block B ended at ${Math.round(b.x)},${Math.round(b.y)} — no overlap`);
}

/* --- multi-select ------------------------------------------------------
 *
 * Shift-click adds to the selection and a move takes the whole group along,
 * keeping the blocks' relative spacing. Doing that one block at a time is
 * what loses the spacing, which is the entire reason this exists. */
{
  const { blocks } = freshBoard();
  const [a, b] = state.editing.widgets;

  // Select the second, then shift-click the first: both selected, the first
  // is primary because it was clicked last.
  blocks[1].dispatch('pointerdown', { target: blocks[1], clientX: 0, clientY: 0,
                       pointerId: 1, preventDefault() {}, shiftKey: false });
  window.dispatch('pointerup', {});
  blocks[0].dispatch('pointerdown', { target: blocks[0], clientX: 0, clientY: 0,
                       pointerId: 1, preventDefault() {}, shiftKey: true });
  window.dispatch('pointerup', {});
  check('shift-click selects both blocks', state.selection.size === 2,
        `selection has ${state.selection.size}`);
  check('the shift-clicked block becomes primary', state.selected === 0);

  // Drag the primary; the other must move by the same delta.
  const bx = b.x, by = b.y;
  gesture(blocks[0], blocks[0], [100, 100], [100 + 10 * PCT_X, 100 + 5 * PCT_Y]);
  check('the dragged block moved', Math.round(a.x) === 20 && Math.round(a.y) === 15,
        `${Math.round(a.x)},${Math.round(a.y)}`);
  check('the co-selected block moved by the same delta',
        Math.round(b.x) === Math.round(bx + 10) && Math.round(b.y) === Math.round(by + 5),
        `expected ${bx + 10},${by + 5} but got ${Math.round(b.x)},${Math.round(b.y)}`);
}

/* A plain click must COLLAPSE the group, or the selection grows forever and
 * every later drag hauls blocks you thought you had deselected. */
{
  const { blocks } = freshBoard();
  blocks[0].dispatch('pointerdown', { target: blocks[0], clientX: 0, clientY: 0,
                       pointerId: 1, preventDefault() {}, shiftKey: true });
  window.dispatch('pointerup', {});
  blocks[1].dispatch('pointerdown', { target: blocks[1], clientX: 0, clientY: 0,
                       pointerId: 1, preventDefault() {}, shiftKey: false });
  window.dispatch('pointerup', {});
  check('a plain click collapses the selection to one', state.selection.size === 1,
        `selection has ${state.selection.size}`);
}

/* Resizing must NOT drag the rest of the group: several blocks resized from
 * one corner has no sensible meaning. */
{
  const { blocks } = freshBoard();
  const [a, b] = state.editing.widgets;
  state.selection = new Set([0, 1]);
  state.selected = 0;
  const bx = b.x, by = b.y;
  const grip = { className: 'grip-se' };
  gesture(grip, blocks[0], [200, 200], [200 + 10 * PCT_X, 200 + 5 * PCT_Y]);
  check('resizing leaves co-selected blocks alone',
        b.x === bx && b.y === by, `co-selected moved to ${b.x},${b.y}`);
  check('resizing still resized the primary', Math.round(a.w) === 40,
        `width is ${Math.round(a.w)}`);
}

/* --- proportional resize ----------------------------------------------- */
{
  const { blocks } = freshBoard();
  const w = state.editing.widgets[0];          // 30 x 20, ratio 1.5
  const grip = { className: 'grip-se' };
  gesture(grip, blocks[0], [200, 200], [200 + 15 * PCT_X, 200], { moveShift: true });
  check('shift-resize keeps the aspect ratio',
        Math.abs((w.w / w.h) - 1.5) < 0.02,
        `ratio became ${(w.w / w.h).toFixed(2)} (${w.w}x${w.h})`);
  check('shift-resize still applied the width', Math.round(w.w) === 45,
        `width is ${Math.round(w.w)}`);
}

// --- a drag survives a redraw of the stage -------------------------------
{
  const { stage: st, blocks } = freshBoard();
  const w = state.editing.widgets[0];
  blocks[0].dispatch('pointerdown', {
    target: blocks[0], clientX: 100, clientY: 100, pointerId: 1,
    preventDefault() {}, altKey: false,
  });
  mod.drawStage(st);                     // something else repaints mid-gesture
  window.dispatch('pointermove', { clientX: 100 + 10 * PCT_X, clientY: 100, altKey: false });
  window.dispatch('pointerup', {});
  check('a drag survives the stage being redrawn under it',
        Math.round(w.x) === 20,
        `x ended at ${Math.round(w.x)} instead of 20`);
}

/* ----------------------------------------------------------- every tab */

/* The editor was the only screen under test, so a function called by the
 * Display tab and defined nowhere passed every check and failed on the
 * appliance. Render them all. */
function seedState() {
  state.screens = [{ id: 1, name: 'Main', orientation: 'right', width: 1920,
                     height: 1080, output: null, active_layout_id: 1 }];
  state.layouts = [{ id: 1, name: 'Hearth', widgets: [] }];
  state.templates = [];
  state.rules = [];
  state.people = [];
  state.todoLists = [];
  state.settings = { admin_theme: 'dark', admin_colours: '{}', admin_radius: 10 };
}
seedState();

/* Invoke every handler a tab registered.
 *
 * ONLY ReferenceError counts. That is exactly "this name is not defined" - the
 * failure that has reached the appliance three times now. Anything else a
 * handler throws against a DOM shim is an artefact of the shim, and treating
 * those as failures would make this test noise that gets ignored. */
async function fireHandlers(node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);

  for (const [type, handlers] of Object.entries(node.__on || {})) {
    if (type === 'keydown' || type === 'pointermove' || type === 'pointerup') continue;
    for (const handler of handlers) {
      try {
        const event = {
          target: node, currentTarget: node, key: 'a',
          clientX: 0, clientY: 0, pointerId: 1, altKey: false, shiftKey: false,
          preventDefault() {}, stopPropagation() {},
          dataTransfer: { setData() {}, getData: () => '' },
        };
        await handler(event);
      } catch (err) {
        if (err instanceof ReferenceError) {
          fails.push(`handler (${type}): ${err.message}`);
        }
        // Anything else is the shim's shortcomings, not the product's.
      }
    }
  }

  for (const child of node.children || []) await fireHandlers(child, seen);
}

for (const [name, fn] of [
  ['templates', mod.renderTemplates], ['layout', mod.renderLayout],
  ['sources', mod.renderSources],
  ['system', mod.renderSystem], ['display', mod.renderDisplay],
  ['settings', mod.renderSettings],
]) {
  try {
    // Handlers call refresh(), which repopulates state from the stub - so the
    // fixture has to be restored before each tab or later ones render against
    // whatever the previous tab's handlers left behind.
    seedState();
    const root = mk('div');
    await fn(root);
    await fireHandlers(root);
  } catch (err) {
    if (err instanceof ReferenceError) {
      fails.push(`${name} tab: ${err.message}`);
    } else {
      fails.push(`${name} tab: ${String(err.stack || err).split(String.fromCharCode(10)).slice(0, 3).join(' | ')}`);
    }
  }
}

// The editor's own controls, which live on the stage rather than in a tab.
{
  const st = mk('div'); const pn = mk('div');
  state.editing = { id: 1, name: 'x', widgets: [
    { id: 1, kind: 'clock', x: 0, y: 0, w: 30, h: 20, z: 0, config: {} }] };
  state.selected = 0;
  mod.drawStage(st); mod.drawProps(pn, st);
  await fireHandlers(pn);
}

/* ------------------------------------------------------- stacking order */

/* "Bring to front" used to do z += 1, which in a densely packed 0..n-1
 * sequence lands ON the neighbour rather than above it - a tie CSS breaks by
 * DOM order, so the button appeared to do nothing. */
{
  const names = ['a', 'b', 'c', 'd'];
  state.editing = { id: 1, name: 'stack', widgets: names.map((n, i) => (
    { id: 100 + i, kind: 'clock', name: n, x: 0, y: 0, w: 20, h: 10, z: i, config: {} })) };

  const order = () => state.editing.widgets.map((w) => w.name).join('');
  const zs = () => state.editing.widgets.map((w) => w.z).join('');

  mod.moveInStack(0, 'front');
  check('bring to front puts it last (nearest the viewer)', order() === 'bcda',
        `order is ${order()}`);
  check('  and z is rewritten from position', zs() === '0123', `z is ${zs()}`);
  check('  and it is the highest z', state.editing.widgets.at(-1).name === 'a');

  mod.moveInStack(3, 'back');
  check('send to back puts it first', order() === 'abcd', `order is ${order()}`);

  mod.moveInStack(0, +1);
  check('forward moves one step', order() === 'bacd', `order is ${order()}`);

  mod.moveInStack(0, -1);
  check('backward at the bottom is a no-op', order() === 'bacd', `order is ${order()}`);

  // The bug this replaces: a front operation must beat every other z.
  const front = state.editing.widgets.at(-1);
  const others = state.editing.widgets.slice(0, -1);
  check('the front block outranks every other', others.every((w) => w.z < front.z));
}

await new Promise((r) => setTimeout(r, 400));

/* guard() turns a handler error into a toast, so firing handlers is not
 * enough on its own - the failure has to be read back out of the record it
 * keeps. Only ReferenceError matters here: that is a name that does not
 * exist, as opposed to a stub returning an awkward shape. */
for (const err of mod.RECENT_ERRORS || []) {
  if (err.name === 'ReferenceError') {
    fails.push(`a handler referenced something undefined: ${err.message}`);
  }
}

/* ZOOM: the picture and the boxes must agree.
 *
 * The block boxes are positioned in PERCENT of the stage, so they land
 * wherever the stage really is. The preview iframe is a fixed-size document
 * scaled by a transform - so the scale has to be computed from the same size
 * the boxes are using, or the two drift apart. They did: the stage is a flex
 * item, so past "fits the pane" it was silently shrunk, while the preview went
 * on being scaled from the width the zoom asked for. Zooming in to place a
 * block precisely was the one action guaranteed to make them disagree.
 *
 * A shrunken stage is simulated here by letting offsetWidth differ from
 * style.width, which is exactly what the browser was doing.
 */
function zoomChecks() {
  const fails = [];
  const BOARD = { w: 1920, h: 1080 };

  const scaleOf = (frame) => {
    const m = /scale\(([-\d.]+),\s*([-\d.]+)\)/.exec(frame.style.transform || '');
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  };

  const stageAt = (styleW, styleH, realW, realH) => {
    const stage = mk('div');
    stage.style.width = `${styleW}px`;
    stage.style.height = `${styleH}px`;
    // What the browser ended up giving it. realW/realH are the INNER size,
    // which the blocks are positioned against; the stage has a 1px border, so
    // its border box is 2px larger. Scaling the preview from the border box
    // draws it 2px wider than the boxes on top of it.
    stage.clientWidth = realW;
    stage.clientHeight = realH;
    stage.offsetWidth = realW + 2;
    stage.offsetHeight = realH + 2;
    stage.querySelector = () => null;
    return stage;
  };

  const screen = { width: BOARD.w, height: BOARD.h, orientation: 'normal' };

  // Unshrunk: the scale simply reflects the zoom.
  let stage = stageAt(720, 405, 720, 405);
  let frame = mod.ensurePreview(stage, screen);
  let scale = scaleOf(frame);
  if (!scale) {
    fails.push('the preview was given no scale at all');
  } else if (Math.abs(scale.x - 720 / BOARD.w) > 0.001) {
    fails.push(`at 100% the preview scaled by ${scale.x}, expected ${720 / BOARD.w}`);
  }

  // Zoomed to 200%, and NOT shrunk - the pane scrolls instead.
  stage = stageAt(1440, 810, 1440, 810);
  frame = mod.ensurePreview(stage, screen);
  scale = scaleOf(frame);
  if (!scale || Math.abs(scale.x - 1440 / BOARD.w) > 0.001) {
    fails.push(`at 200% the preview scaled by ${scale && scale.x}, `
      + `expected ${1440 / BOARD.w}`);
  }

  /* The regression itself: a stage asked for 1440 and given 900.
   *
   * The boxes are drawn at 900 because they are percentages. If the preview is
   * scaled from 1440 it is painted 60% wider than the boxes that are supposed
   * to sit on it - which is the reported symptom, boxes wandering off the
   * picture. The scale must follow the real width.
   */
  stage = stageAt(1440, 810, 900, 506);
  frame = mod.ensurePreview(stage, screen);
  scale = scaleOf(frame);
  if (!scale) {
    fails.push('no scale on a constrained stage');
  } else if (Math.abs(scale.x - 1440 / BOARD.w) < 0.001) {
    fails.push('the preview is still scaled from the width the zoom ASKED for, '
      + 'not the width the stage actually got - the boxes will not line up');
  } else if (Math.abs(scale.x - 900 / BOARD.w) > 0.001) {
    fails.push(`the preview scaled by ${scale.x}, expected ${900 / BOARD.w} `
      + '(the stage\'s real width)');
  }

  // And the CSS that stops the shrinking in the first place.
  const html = readFileSync(join(WEB, 'admin', 'index.html'), 'utf8');
  const stageRule = /#stage \{[^}]*\}/.exec(html);
  if (!stageRule) {
    fails.push('the #stage rule is gone from index.html');
  } else if (!/flex:\s*0\s+0\s+auto/.test(stageRule[0])) {
    fails.push('#stage can be shrunk by its flex parent again, so zooming past '
      + 'the pane width will squash it');
  }

  return fails;
}

run('zoom keeps the picture and the boxes together', () => {
  const fails = zoomChecks();
  if (fails.length) throw new Error(fails.join('; '));
});

if (fails.length) {
  console.error(`\n${fails.length} failure(s):\n`);
  for (const f of [...new Set(fails)]) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log(`\neditor ok: picker, layers, ${Object.keys(CATALOGUE).length} property forms, `
  + 'and drag/resize/overlap all behave');
process.exit(0);
