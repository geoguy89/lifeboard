/* Does a widget that fails once recover on its own?
 *
 * This is the behaviour that makes a reboot work. A widget loads on an
 * interval - fifteen minutes for weather - so before the retry existed, a
 * board that booted during a brief network hiccup showed "timed out" for a
 * quarter of an hour and rebooting it changed nothing, because the reboot just
 * lined up another cold start against the same hiccup.
 *
 *   node tools/test_retry.mjs
 *
 * makeContext is pulled out of app.js by source rather than imported, for the
 * same reason as test_reconcile.mjs: importing runs the renderer's boot code.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../web/render/app.js', import.meta.url), 'utf8');

function extract(decl) {
  const start = src.indexOf(decl);
  if (start < 0) throw new Error(`${decl} is not in app.js`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`could not find the end of ${decl}`);
}

const delays = src.match(/const RETRY_DELAYS_MS = \[[^\]]*\];/);
if (!delays) throw new Error('RETRY_DELAYS_MS is not in app.js');

// A DOM stub thin enough to be obviously correct: the context only ever
// queries, appends and removes one .widget-error node.
const shim = `
  const el = (tag, attrs = {}) => ({ class: attrs.class, textContent: '', remove() { this.gone = true; } });
  const getJSON = async () => ({});
`;

const { makeContext, RETRY_DELAYS_MS } = await import(
  'data:text/javascript,' + encodeURIComponent(
    shim + delays[0] + '\n' + extract('function makeContext(')
    + '\nexport { makeContext, RETRY_DELAYS_MS };')
);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};

function harness() {
  let node = null;
  const instance = {
    timers: [],
    el: {
      querySelector: () => (node && !node.gone ? node : null),
      append: (n) => { node = n; },
    },
  };
  const ctx = makeContext(instance, {}, { config: {} }, { timezone: 'UTC' });
  return { ctx, instance };
}

// Timers are captured, not run, so the test asserts on scheduling rather than
// sleeping through two minutes of backoff.
const scheduled = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };

const { ctx, instance } = harness();

ctx.fail(new Error('ConnectTimeout: boom'));
check('a plain fail schedules nothing', scheduled.length === 0);

const loads = [];
const load = () => loads.push(1);

ctx.fail(new Error('ConnectTimeout: boom'), load);
check('a fail with a loader schedules a retry', scheduled.length === 1);
check('the first retry uses the shortest delay',
  scheduled[0]?.ms === RETRY_DELAYS_MS[0], String(scheduled[0]?.ms));
check('the retry timer is registered for unmount cleanup', instance.timers.length === 1);

ctx.fail(new Error('again'), load);
check('the second retry backs off', scheduled[1]?.ms === RETRY_DELAYS_MS[1], String(scheduled[1]?.ms));

ctx.fail(new Error('again'), load);
ctx.fail(new Error('again'), load);
check('retries stop after the last delay', scheduled.length === RETRY_DELAYS_MS.length,
  `scheduled ${scheduled.length}`);

// A success ends the sequence, so the next outage starts short again.
ctx.clearFail();
ctx.fail(new Error('a new outage'), load);
check('a success resets the backoff',
  scheduled.at(-1)?.ms === RETRY_DELAYS_MS[0], String(scheduled.at(-1)?.ms));

// The retry must actually be the loader, not a wrapper that drops it.
scheduled.at(-1).fn();
check('the scheduled callback is the loader', loads.length === 1);

// Every delay must be far shorter than a weather refresh, or the retry is
// decorative: waiting 15 minutes to retry is what this exists to prevent.
check('every delay is well under a refresh interval',
  RETRY_DELAYS_MS.every((ms) => ms < 5 * 60_000), RETRY_DELAYS_MS.join(','));

globalThis.setTimeout = realSetTimeout;
console.log(failures ? `\n${failures} FAILED` : '\nwidget retry: transient failures clear themselves');
process.exit(failures ? 1 : 0);
