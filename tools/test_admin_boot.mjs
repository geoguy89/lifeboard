/* Boot the admin and renderer module graphs headlessly.
 *
 * This exists because the smoke test checked that /admin/admin.js returned
 * HTTP 200 and concluded the admin UI worked. It did not work at all: render()
 * called applyTheme(), which was never defined, so the very first render threw
 * and the page stayed black. Three functions - applyTheme, readColours and
 * THEME_VARS - were called in six places and defined in none. Serving a file
 * is not the same as running it.
 *
 * The DOM shim below is deliberately minimal. It is not trying to be a
 * browser; it only needs to be truthful enough that a ReferenceError in the
 * boot path surfaces as a failure here rather than as a black screen on a wall
 * -mounted appliance.
 *
 *   node tools/test_admin_boot.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..', 'web');

const problems = [];
const note = (what, err) => problems.push(
  `${what}: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n    ') : err}`);

/* The real `el()` does `kid instanceof Node`, so the shim needs a Node class
 * for created elements to be recognised as children rather than stringified. */
class Node {}
globalThis.Node = Node;

function makeNode(tag) {
  return Object.assign(new Node(), {
    tagName: String(tag).toUpperCase(),
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    children: [], dataset: {}, className: '', textContent: '', value: '',
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    replaceChildren(...c) { this.children = c; },
    insertBefore(c) { this.children.push(c); return c; },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100, top: 0, left: 0 }),
    remove() {}, focus() {}, click() {}, closest: () => null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  });
}

/** Install a DOM. `boardPresent` decides whether #board exists, which is what
 *  tells the renderer it is on the board page rather than being imported. */
function installDom({ boardPresent }) {
  const app = makeNode('div');
  const board = makeNode('div');
  const backdrop = makeNode('div');
  const byId = { app, backdrop };
  if (boardPresent) byId.board = board;

  const root = makeNode('html');
  globalThis.document = {
    documentElement: root,
    body: makeNode('body'),
    head: makeNode('head'),
    createElement: makeNode,
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    createElementNS: makeNode,
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => byId[String(sel).replace('#', '')] || null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  const win = {
    addEventListener() {}, removeEventListener() {},
    location: { href: 'http://appliance/admin/', search: '', origin: 'http://appliance', reload() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    devicePixelRatio: 1,
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  globalThis.window = win;
  globalThis.location = win.location;
  globalThis.localStorage = win.localStorage;
  globalThis.getComputedStyle = win.getComputedStyle;
  globalThis.matchMedia = win.matchMedia;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.URLSearchParams = URLSearchParams;
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'lifeboard-test' }, configurable: true,
    });
  }
  return { app, board };
}

/* Every API call answers with an empty-but-plausible payload. The point is to
 * exercise the boot path, not to simulate a server. */
globalThis.fetch = async (url) => {
  const path = String(url);
  let body = {};
  if (path.includes('/api/session')) body = { setup_needed: true, authenticated: false, username: 'admin' };
  else if (path.includes('/api/setup/state')) body = { account: false, network: true, addresses: ['10.0.0.5'], has_wifi: false, timezone: 'UTC', orientation: 'normal', complete: false, screen_id: 1 };
  else if (path.includes('/api/board')) body = { revision: 1, layout: null, widgets: [] };
  else if (/\/api\/(screens|layouts|sources|templates|todo\/lists)/.test(path)) body = [];
  return { ok: true, status: 200, headers: { get: () => 'application/json' },
           json: async () => body, text: async () => JSON.stringify(body) };
};

process.on('unhandledRejection', (err) => note('unhandled rejection during boot', err));
process.on('uncaughtException', (err) => note('uncaught exception during boot', err));

/* --- 1. the admin page ------------------------------------------------- */
installDom({ boardPresent: false });
try {
await import(pathToFileURL(resolve(WEB, 'admin', 'admin.js')).href);
} catch (err) {
  note('importing admin.js threw', err);
}

/* --- 2. the board page -------------------------------------------------- */
installDom({ boardPresent: true });
try {
await import(pathToFileURL(resolve(WEB, 'render', 'app.js')).href + '?board');
} catch (err) {
  note('importing render/app.js threw', err);
}

/* Give the async boot paths a turn to fail. */
await new Promise((r) => setTimeout(r, 1200));

if (problems.length) {
  console.error(`\n${problems.length} problem(s) booting the UI:\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}
console.log('\nadmin and renderer both boot cleanly');
process.exit(0);
