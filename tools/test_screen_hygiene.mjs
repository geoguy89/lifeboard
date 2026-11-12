/* Things that must be TAKEN DOWN, not just put up.
 *
 * Both bugs behind this file are the same mistake: something is drawn on the
 * screen in one state and nothing removes it when that state ends. Neither
 * shows up in development, because a developer reloads constantly and a reload
 * clears everything. A board on a wall does not reload for weeks.
 *
 *   1. THE SETUP PANEL. renderOnboarding() calls BOARD.replaceChildren(), so
 *      the panel becomes the board's only child. When the board is configured
 *      the widget path APPENDS to that same board - and the panel is
 *      `position:absolute; inset:0`. Result: a fully working board mounting
 *      its widgets underneath a full-screen setup screen and a QR code,
 *      indistinguishable from one that was never configured.
 *
 *   2. THE STREAM BANNER. A <video> fires `error` for things it recovers from
 *      on its own. The corner banner was written and never cleared, so a
 *      stream that hiccuped once during start-up and then played perfectly for
 *      a week still read "stream error, retrying".
 *
 * WHY THIS IS A STRUCTURAL TEST AND NOT A BEHAVIOURAL ONE
 * ------------------------------------------------------
 * app.js cannot be imported outside a browser - importing it runs the boot
 * path, which wants fetch, timers and a document - and render() reaches most
 * of the module. Standing up a DOM complete enough to drive it would be a
 * bigger, less truthful fixture than the thing being checked. So this reads
 * the source and asserts the teardown is wired up.
 *
 * That is weaker than proving the pixels go away, and it is worth being clear
 * about the difference: this catches the fix being deleted or drifting, which
 * is the realistic regression. It would NOT catch clearOnboarding() being
 * called somewhere that never runs. The live check for that is a board that
 * has been configured while its screen stayed open.
 *
 *   node tools/test_screen_hygiene.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const app = read('../web/render/app.js');
const media = read('../web/render/widgets/media.js');

const problems = [];

/* ------------------------------------------------- 1. the setup panel */

// The panel has to be remembered, or there is nothing to remove later.
if (!/onboardingNode\s*=\s*BOARD\.firstElementChild/.test(app)) {
  problems.push('renderOnboarding no longer records the panel it drew');
} else {
  console.log('  ok   the setup panel is remembered when it is drawn');
}

if (!/function clearOnboarding\s*\(/.test(app)) {
  problems.push('clearOnboarding is gone');
} else if (!/onboardingNode\.remove\(\)/.test(app)) {
  problems.push('clearOnboarding no longer removes the node');
} else {
  console.log('  ok   clearOnboarding removes it');
}

/* The ordering is the whole fix: the call has to happen on the path taken when
 * the board IS configured, before the widgets go up. Finding the call anywhere
 * in the file would pass just as happily with it sitting in dead code. */
const renderStart = app.indexOf('function render(board) {');
if (renderStart < 0) {
  problems.push('could not find render() in app.js');
} else {
  const body = app.slice(renderStart, renderStart + 900);
  const guard = body.indexOf('if (board.onboarding)');
  const clear = body.indexOf('clearOnboarding()');
  const paint = body.indexOf('paintBackground(board.layout)');

  if (clear < 0) {
    problems.push('render() never clears the setup panel — a configured board '
      + 'will mount its widgets underneath it');
  } else if (guard >= 0 && clear < guard) {
    problems.push('render() clears the panel before deciding whether it is '
      + 'still needed');
  } else if (paint >= 0 && clear > paint) {
    problems.push('render() paints the board before clearing the panel');
  } else {
    console.log('  ok   render() clears it on the configured path, before painting');
  }
}

/* ------------------------------------------------ 2. the stream banner */

const errorHandler = media.indexOf("addEventListener('error'");
if (errorHandler < 0) {
  problems.push('the video error handler is gone from media.js');
} else if (!/ctx\.fail\(new Error\('stream error, retrying'\)\)/.test(media)) {
  problems.push('the stream failure is no longer reported at all');
} else {
  console.log('  ok   a stream error is still reported');
}

/* A DEAD STREAM NEEDS A NEW ADDRESS, NOT A REDIAL.
 *
 * The retry used to be node.load() on the same src. That works for a file and
 * cannot work for a resolved YouTube stream: the URL is signed and perishable,
 * and a live broadcast gets a new one when it restarts. Retrying the dead link
 * fails identically every fifteen seconds forever, so an interrupted feed
 * stayed interrupted with the banner sitting on it - which is precisely what
 * clearing the banner on recovery could not fix, because recovery never came.
 */
if (!/renew:\s*load/.test(media)) {
  problems.push('the resolver no longer hands playDirect a way to renew the '
    + 'stream, so a perished URL can never be replaced');
} else if (!/typeof renew === 'function'\s*\)\s*renew\(\)/.test(media)) {
  problems.push('the error handler no longer asks for a fresh stream URL');
} else {
  console.log('  ok   a failed stream is renewed, not redialled');
}

// A blip should not be announced at all.
if (!/ctx\.timeout\(/.test(media) || !/recovering/.test(media)) {
  problems.push('the banner is shown the instant a <video> hiccups, with no '
    + 'grace period to tell a blip from a break');
} else {
  console.log('  ok   a momentary hiccup is given a few seconds before it is announced');
}

// ...and withdrawn. Either recovery event is enough; both is what we ship.
const clearsOnRecovery = /\['playing',\s*'canplay'\]/.test(media)
  && /ctx\.clearFail\(\)/.test(media);
if (!clearsOnRecovery) {
  problems.push('nothing clears the stream banner when playback recovers — '
    + 'a transient error will sit on screen until the widget is rebuilt');
} else {
  console.log('  ok   the banner is withdrawn when playback recovers');
}

/* ---------------------------------------------------------------- verdict */

if (problems.length) {
  console.error('\nFAILED:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\nWhat goes up comes back down.');
