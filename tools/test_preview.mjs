/* Does the editor's live preview actually draw every widget?
 *
 *   node tools/test_preview.mjs
 *
 * The editor mounts the REAL widget modules behind its drag boxes, fed canned
 * data instead of the network. That is what stops a preview drifting from the
 * board - but it also means any widget that throws on fixture data, or that
 * has no fixture and renders nothing, shows up as an empty box in the editor
 * and looks broken.
 *
 * So this mounts EVERY widget in the catalogue against the real fixtures and
 * fails if one throws or produces nothing. It is the check that keeps
 * preview-data.js honest as widgets are added: a new widget with no fixture
 * fails here rather than quietly looking broken in the UI.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..', 'web');

/* ------------------------------------------------------------- DOM shim */
class Node {}
function mk(tag) {
  return Object.assign(new Node(), {
    tagName: String(tag).toUpperCase(),
    style: { setProperty() {}, removeProperty() {} },
    children: [], dataset: {}, className: '', textContent: '', id: '',
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c.filter(Boolean)); },
    prepend(...c) { this.children.unshift(...c.filter(Boolean)); },
    replaceChildren(...c) { this.children = c.filter(Boolean); },
    insertBefore(c) { this.children.push(c); return c; },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 300, height: 200, top: 0, left: 0 }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    remove() {}, focus() {}, load() {}, play: async () => {}, pause() {},
    closest: () => null, contains: () => false,
  });
}
globalThis.Node = Node;
globalThis.document = {
  createElement: mk, createElementNS: mk,
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, createDocumentFragment: () => mk('fragment'),
};
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  location: { search: '', href: 'http://board/admin/', reload() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  devicePixelRatio: 1,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
};
globalThis.location = window.location;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.URLSearchParams = URLSearchParams;
globalThis.fetch = async () => { throw new Error('preview must not touch the network'); };
// The slideshow preloads through `new Image()` and fires the load handler
// itself; without this the module throws at import-time rather than telling
// us anything about the preview.
globalThis.Image = class {
  constructor() { this.onload = null; this.onerror = null; this._src = ''; }
  set src(v) { this._src = v; setTimeout(() => this.onload?.(), 0); }
  get src() { return this._src; }
};
globalThis.HTMLElement = class {};
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'test' }, configurable: true });
}

const { WIDGETS, CATALOGUE } = await import(
  pathToFileURL(join(WEB, 'render/widgets/registry.js')).href);
const { previewFetch } = await import(
  pathToFileURL(join(WEB, 'admin/preview-data.js')).href);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) { failures++; console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`); }
  return ok;
};

/* Count rendered content, not just children: a widget that appended one empty
 * div has not really drawn anything. */
function weight(node, depth = 0) {
  if (!node || depth > 40) return 0;
  if (node.nodeType === 3) return String(node.textContent || '').trim().length;
  let n = String(node.textContent || '').trim().length;
  for (const c of (node.children || [])) n += weight(c, depth + 1);
  return n + (node.children?.length || 0);
}

/* The same context the editor's preview.js builds: fixtures for data, no
 * timers, silent failures. Kept in step by construction - if this drifts from
 * preview.js the test stops meaning anything, so any change to one belongs in
 * the other. */
function previewCtx(kind, body) {
  const config = {};
  for (const f of (CATALOGUE[kind]?.fields || [])) {
    if (f.default !== undefined) config[f.key] = f.default;
  }
  // Widgets gate on having a source; the fixtures answer for any id.
  config.source_id = config.source_id ?? 1;
  if (CATALOGUE[kind]?.fields?.some((f) => f.type === 'sources')) config.source_ids = [1, 2];
  if (kind === 'entity') config.entities = 'sensor.living_room_temperature, sensor.humidity';
  // The HA extras gate on an entity being named, so without these they would
  // draw their 'pick an entity' message and PASS while proving nothing.
  if (kind === 'ha_history' || kind === 'ha_camera') config.entity = 'sensor.living_room_temperature';
  if (kind === 'ha_media') config.entities = 'media_player.living_room';
  if (kind === 'ha_glance') config.entities = 'sensor.living_room_temperature, sensor.humidity';
  if (kind === 'obsidian_notes') config.source_id = 1;
  // The sticky is only interesting fed from somewhere; the text path would
  // pass with an empty note and prove nothing.
  if (kind === 'splist') {
    config.source_id = 1; config.site_id = 's1'; config.list_id = 'l1';
    config.columns = 'Title,AssignedTo,Status';
    config.done_column = 'Status'; config.done_value = 'Complete';
  }
  if (kind === 'tasks') { config.backend = 'local'; config.list_id = '1'; }
  if (kind === 'kanban') { config.backend = 'planner'; config.plan_id = 'p'; config.source_id = 1; }
  if (kind === 'postit') {
    config.content = 'gtasks';
    config.source_id = 1;
    config.list_id = 'preview';
  }
  if (kind === 'ha_control') config.entities = 'light.kitchen';
  if (kind === 'todo') config.list_id = 1;
  if (kind === 'iframe' || kind === 'image') config.url = 'https://example.invalid/x.png';
  if (kind === 'html') config.html = '<b>hi</b>';
  if (kind === 'markdown') config.text = '# Title\n\nSome **text**.';
  if (kind === 'text') config.text = 'Our Story';
  if (kind === 'countdown') config.target = new Date(Date.now() + 864e5).toISOString();
  if (kind === 'qr') { config.ssid = 'Net'; config.password = 'pw'; }
  if (kind === 'button') config.label = 'Go';
  if (kind === 'shape') config.shape = 'line';

  const errors = [];
  return {
    ctx: {
      body,
      el0: mk('div'),
      config,
      widget: { kind, config },
      timezone: 'America/New_York',
      nativeVideo: false,
      getJSON: async (url) => previewFetch(url),
      interval: () => 0,
      timeout: () => 0,
      fail: (e) => errors.push(e),
      clearFail: () => {},
      preview: true,
    },
    errors,
  };
}

/* Video, iframe and html are deliberately stubbed in the editor rather than
 * really mounted - see STUBBED in preview.js. Mounting them here would prove
 * nothing about what the editor draws. */
const STUBBED = new Set(['video', 'iframe', 'html']);

console.log('mounting every widget against the preview fixtures\n');

const kinds = Object.keys(CATALOGUE).filter((k) => !STUBBED.has(k));
let drew = 0;

for (const kind of kinds) {
  const def = WIDGETS[kind];
  if (!check(`${kind}: is in WIDGETS`, !!def)) continue;

  const body = mk('div');
  const { ctx, errors } = previewCtx(kind, body);
  let threw = null;
  try {
    const destroy = def.mount(ctx);
    // Widgets load asynchronously; give the microtasks and the setTimeout(0)
    // shim a chance to resolve before measuring.
    await new Promise((r) => setTimeout(r, 25));
    if (typeof destroy === 'function') destroy();
  } catch (err) {
    threw = err;
  }

  if (!check(`${kind}: mounts without throwing`, !threw, threw && (threw.stack || '').split('\n')[0])) continue;
  if (!check(`${kind}: no fetch error`, errors.length === 0,
             errors[0] && String(errors[0].message || errors[0]))) continue;
  if (check(`${kind}: draws something`, weight(body) > 0,
            'rendered an empty body - is a fixture missing?')) drew++;
}

console.log(`\n  ${drew}/${kinds.length} widgets drew real content from fixtures`);
console.log(`  ${STUBBED.size} deliberately stubbed: ${[...STUBBED].join(', ')}`);

/* The fixtures must cover every endpoint the widgets actually call, or a
 * widget silently previews empty. */
const ENDPOINTS = [
  '/api/data/weather?source_id=1',
  '/api/data/weather/hourly?source_id=1',
  '/api/data/weather/air?source_id=1',
  '/api/data/weather/alerts?source_id=1',
  '/api/data/weather/sunmoon?source_id=1',
  '/api/data/calendar?days=7',
  '/api/data/rss?source_id=1',
  '/api/data/photos?source_id=1',
  '/api/data/ha/trackers?source_id=1',
  '/api/data/ha/states?source_id=1&entities=sensor.x',
  '/api/data/finance?symbols=AAPL',
  '/api/data/rest?source_id=1',
  '/api/todo/lists/1',
];
for (const url of ENDPOINTS) {
  const got = previewFetch(url);
  check(`fixture for ${url.split('?')[0]}`,
        got && Object.keys(got).length > 0, 'returned nothing');
}

/* Longest-prefix routing: /api/data/weather/hourly must not be answered by
 * the /api/data/weather fixture, which was the bug this ordering prevents. */
check('hourly is not swallowed by the weather route',
      Array.isArray(previewFetch('/api/data/weather/hourly').hours));
check('weather still resolves to the forecast',
      Array.isArray(previewFetch('/api/data/weather').daily));

console.log(failures
  ? `\n${failures} FAILED`
  : '\npreview: every widget renders from fixtures, with no network');
process.exit(failures ? 1 : 0);
