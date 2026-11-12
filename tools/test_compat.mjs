/* Guard the safety net itself.
 *
 * compat.js is the one file that runs when everything else has failed: it is a
 * classic script, loaded first, and its job is to put something readable on a
 * wall-mounted screen that would otherwise be black. Two things about it are
 * easy to break by accident and impossible to notice locally.
 *
 *   1. IT MUST BE ES5. The whole point is running on a WebView too old for the
 *      rest of the board. One arrow function turns the file that reports the
 *      problem into a second, silent syntax error - on exactly the devices it
 *      exists for, and nowhere else.
 *
 *   2. IT MUST NOT CRY WOLF. It once decided nothing had painted because it
 *      only looked for the renderer's #board, and covered the working admin
 *      with an error every time. That was fixed; then it did it again from a
 *      different direction, by asking once at six seconds - fine for the board
 *      on loopback, not always enough for the admin making several calls over
 *      the LAN. A diagnostic that fires on healthy pages gets ignored, which
 *      leaves the real black screen unexplained.
 *
 * So this drives the file on a virtual clock and checks what it does to a page
 * that is merely slow, a page that is genuinely broken, and a page that comes
 * good after the complaint has already gone up.
 *
 *   node tools/test_compat.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SOURCE = resolve(ROOT, 'web', 'render', 'compat.js');

const src = readFileSync(SOURCE, 'utf8');
const problems = [];

/* ------------------------------------------------------- 1. ES5 or bust */

/* Deliberately a scan and not a parser.
 *
 * Node happily parses ES2020, so running the file proves nothing about Chrome
 * 66; and there is no parser in this repo's dependencies to borrow, because
 * there are no dependencies. A scan for the handful of constructs that would
 * actually appear in a careless edit catches the realistic mistake, which is
 * somebody writing modern JavaScript here out of habit.
 */
const ES6 = [
  [/=>/, 'arrow function'],
  [/(^|[^.\w])(const|let)\s+[A-Za-z_$]/, 'const/let'],
  [/(^|[^\\])`/, 'template literal'],
  [/(^|[^.\w])class\s+[A-Za-z_$]/, 'class'],
  [/(^|[^.\w])async\s+function/, 'async function'],
  [/\.\.\.[A-Za-z_$]/, 'spread/rest'],
  [/(^|[^.\w])of\s+[A-Za-z_$]+\s*\)/, 'for...of'],
  [/\?\./, 'optional chaining'],
  [/\?\?/, 'nullish coalescing'],
];

/* Strip comments AND string literals before looking.
 *
 * The file explains itself at length, and the prose mentions `=>` and
 * backticks that are not code. Strings matter for the same reason: the engine
 * probe legitimately reads
 *
 *     new Function('return (async function () { return 1; })();')()
 *
 * which is a feature test written as text, not an async function. Scanning it
 * raw fails the file for containing the very check that makes it work.
 */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

const es6Found = [];
for (const [pattern, name] of ES6) {
  const m = pattern.exec(code);
  if (!m) continue;
  const line = code.slice(0, m.index).split('\n').length;
  es6Found.push(`${name} (line ~${line} of the stripped file)`);
}
if (es6Found.length) {
  problems.push(`compat.js is not ES5 any more: ${es6Found.join('; ')}`);
} else {
  console.log('  ok   compat.js is ES5 — it will parse on the WebView it exists for');
}

/* -------------------------------------------- 2. a clock we control */

function makeWorld({ paintsAt }) {
  let now = 0;
  let seq = 0;
  const timers = new Map();

  const setTimer = (fn, ms, repeat) => {
    const id = ++seq;
    timers.set(id, { fn, due: now + (ms || 0), every: repeat ? (ms || 0) : 0 });
    return id;
  };

  const flush = () => new Promise((r) => setImmediate(r));

  const advance = async (ms) => {
    const target = now + ms;
    // Step through in due-time order so an interval that schedules work still
    // runs the right number of times.
    for (;;) {
      let next = null;
      for (const [id, t] of timers) {
        if (t.due <= target && (!next || t.due < next[1].due)) next = [id, t];
      }
      if (!next) break;
      const [id, timer] = next;
      now = Math.max(now, timer.due);
      if (timer.every) timer.due = now + timer.every;
      else timers.delete(id);
      try { timer.fn(); } catch (err) { problems.push(`timer threw: ${err.message}`); }
      // Anything the callback kicked off - a fetch, a chained then - gets to
      // run before the clock moves on, exactly as it would in a browser.
      await flush();
    }
    now = target;
  };

  const app = { children: [], id: 'app' };

  /* Count appends, do not just look at the end state.
   *
   * The self-healing watcher takes the overlay back down once the page paints,
   * which means "no overlay when the dust settles" is true both for a page
   * that was never accused and for one that was accused and then apologised
   * to. Those are not the same thing: the second still puts a red error across
   * a healthy board for a couple of seconds, which is the whole complaint.
   */
  let everOverlaid = 0;
  const body = {
    children: [],
    appendChild(node) {
      everOverlaid += 1;
      this.children.push(node); node.parentNode = this; return node;
    },
    removeChild(node) {
      this.children = this.children.filter((c) => c !== node);
      node.parentNode = null;
    },
  };

  const makeEl = () => ({
    style: {}, children: [], noModule: true, type: '', textContent: '',
    setAttribute() {}, appendChild(c) { this.children.push(c); return c; },
  });

  const listeners = {};
  const sandbox = {
    console,
    Promise,
    JSON,
    Math,
    Date: { now: () => now },
    fetch: () => Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'text/javascript' },
    }),
    ResizeObserver: class {},
    Function,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/152.0.0.0' },
    setTimeout: (fn, ms) => setTimer(fn, ms, false),
    setInterval: (fn, ms) => setTimer(fn, ms, true),
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    document: {
      getElementById: (id) => (id === 'app' ? app : null),
      createElement: () => makeEl(),
      createTextNode: (t) => ({ text: t }),
      documentElement: { style: {}, textContent: '' },
      body,
      head: { appendChild() {} },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = (name, fn) => {
    (listeners[name] = listeners[name] || []).push(fn);
  };
  sandbox.window.removeEventListener = (name, fn) => {
    listeners[name] = (listeners[name] || []).filter((f) => f !== fn);
  };
  sandbox.addEventListener = sandbox.window.addEventListener;
  sandbox.removeEventListener = sandbox.window.removeEventListener;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'compat.js' });

  // The page finishes loading; the backstop arms itself here.
  for (const fn of listeners.load || []) fn();

  // ...and paints whenever the scenario says it does.
  if (paintsAt !== null) setTimer(() => app.children.push(makeEl()), paintsAt, false);

  const overlaid = () => body.children.length > 0;
  const text = () => body.children.map(
    (b) => (b.children || []).map((c) => c.textContent).join(' ')).join(' ');

  return {
    advance, overlaid, text,
    everOverlaid: () => everOverlaid > 0,
    paint: () => app.children.push(makeEl()),
  };
}

/* ------------------------------------------------------------ 3. the cases */

// The admin over the LAN: several calls, first row drawn at ten seconds. This
// is the regression - it used to be accused at six.
const slow = makeWorld({ paintsAt: 10000 });
await slow.advance(60000);
if (slow.everOverlaid()) {
  problems.push('a page that painted at 10s was accused before it finished');
} else {
  console.log('  ok   a slow page is never accused in the first place');
}

// Slower still. A cold boot where the network arrives late.
const slower = makeWorld({ paintsAt: 22000 });
await slower.advance(120000);
if (slower.everOverlaid()) {
  problems.push('a page that painted at 22s was accused before it finished');
} else {
  console.log('  ok   a very slow page is never accused either');
}

// Genuinely broken: nothing ever paints. This must still be reported, because
// a black screen with no explanation is the failure the file exists to prevent.
const broken = makeWorld({ paintsAt: null });
await broken.advance(120000);
if (!broken.overlaid()) {
  problems.push('a page that never painted was never diagnosed');
} else if (!/drew nothing/i.test(broken.text())) {
  problems.push(`the message was not the "drew nothing" one: ${broken.text().slice(0, 80)}`);
} else {
  console.log('  ok   a page that never paints is still diagnosed');
}

// And the awkward one: the complaint goes up, then the page comes good.
const late = makeWorld({ paintsAt: null });
await late.advance(120000);
if (!late.overlaid()) {
  problems.push('setup for the late-paint case failed — no overlay to clear');
} else {
  late.paint();
  await late.advance(5000);
  if (late.overlaid()) {
    problems.push('the overlay stayed up over a page that had since painted');
  } else {
    console.log('  ok   the overlay steps aside if the page paints late');
  }
}

/* ---------------------------------------------------------------- verdict */

if (problems.length) {
  console.error('\nFAILED:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\ncompat.js: ES5, patient, and still honest about a dead page.');
