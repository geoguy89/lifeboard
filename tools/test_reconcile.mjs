/* Does a board refresh restart a live video?
 *
 * This is the rule the whole "refresh everything except the video" requirement
 * rests on, so it gets its own test rather than being assumed. A widget is
 * rebuilt only when its IDENTITY changes; moving or resizing it must not
 * count, or dragging a video an inch in the editor would restart the stream.
 *
 *   node tools/test_reconcile.mjs
 *
 * The functions are pulled out of app.js by source rather than imported,
 * because importing the module would run the renderer's boot code (fetch,
 * timers, document) which does not exist outside a browser.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../web/render/app.js', import.meta.url), 'utf8');

function extract(name) {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} is not exported from app.js`);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`could not find the end of ${name}`);
}

const { identityOf, keyOf } = await import(
  'data:text/javascript,' + encodeURIComponent(
    extract('identityOf').replace('export ', '') + '\n'
    + extract('keyOf').replace('export ', '') + '\n'
    + 'export { identityOf, keyOf };')
);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};

const live = {
  id: 7, kind: 'video', panel: 'none', x: 0, y: 40, w: 100, h: 30, z: 1,
  config: { url: 'https://youtube.com/@channel', engine: 'auto', muted: true },
};

console.log('\nreconciliation: what counts as "the same widget"');

check('an identical widget keeps its identity',
      identityOf(live) === identityOf({ ...live }));

check('MOVING a video does not change its identity',
      identityOf(live) === identityOf({ ...live, x: 10, y: 5 }),
      'dragging a video would restart the stream');

check('RESIZING a video does not change its identity',
      identityOf(live) === identityOf({ ...live, w: 60, h: 20 }),
      'resizing would restart the stream');

check('re-stacking does not change its identity',
      identityOf(live) === identityOf({ ...live, z: 9 }));

check('changing the URL DOES change its identity',
      identityOf(live) !== identityOf({
        ...live, config: { ...live.config, url: 'https://youtube.com/@other' } }),
      'a new stream must actually be loaded');

check('un-muting DOES change its identity',
      identityOf(live) !== identityOf({
        ...live, config: { ...live.config, muted: false } }));

check('changing the panel style DOES change its identity',
      identityOf(live) !== identityOf({ ...live, panel: 'glass' }));

console.log('\nkeys are stable across refreshes');

check('a saved widget is keyed by its database id',
      keyOf(live, 0) === keyOf(live, 5),
      'position in the list must not affect the key, or reordering remounts everything');

check('two different widgets get different keys',
      keyOf(live, 0) !== keyOf({ ...live, id: 8 }, 0));

check('an unsaved widget still gets a usable key',
      keyOf({ kind: 'clock' }, 3) === 'i3:clock');

console.log(
  failures ? `\n${failures} FAILED\n` : '\nall reconciliation checks passed\n');
process.exit(failures ? 1 : 0);
