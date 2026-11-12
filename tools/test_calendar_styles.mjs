/* Render every calendar style against realistic events.
 *
 * The editor test builds property forms, not widget bodies, so a style that
 * throws would ship unnoticed. This mounts each one under a DOM shim with a
 * week of events - timed, all-day, several per day, and a day with more than
 * the cap - and fails if any of them raises.
 */
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..', 'web');

class Node {}
function mk(tag) {
  const n = Object.assign(new Node(), {
    tagName: String(tag).toUpperCase(),
    style: { setProperty() {}, removeProperty() {} },
    children: [], dataset: {}, className: '', textContent: '', id: '',
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c.filter(Boolean)); },
    replaceChildren(...c) { this.children = c.filter(Boolean); },
    setAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    remove() {},
  });
  return n;
}
globalThis.Node = Node;
globalThis.document = {
  createElement: mk,
  createElementNS: mk,
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  getElementById: () => null, querySelector: () => null,
  addEventListener() {},
};
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  location: { search: '', href: 'http://board/render/', reload() {} },
};
// app.js reads location at module scope; the registry pulls it in.
globalThis.location = window.location;
globalThis.URLSearchParams = URLSearchParams;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test' }, configurable: true });
}

/* Enter through the registry, not calendar.js directly: calendar.js imports
 * app.js which imports the registry which imports calendar.js, so loading the
 * leaf first hits the cycle mid-initialisation. */
const { WIDGETS } = await import(pathToFileURL(join(WEB, 'render/widgets/registry.js')).href);
const { weekStartKey } = await import(pathToFileURL(join(WEB, 'render/widgets/calendar.js')).href);
const calendar = WIDGETS.calendar;

/* A week that exercises the awkward cases: an all-day event, several on one
 * day, and a day past the per-day cap. */
const day = (offset, hour) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

const events = [
  { uid: '1', title: 'Ry\u2019s girls', start: day(0, 9), end: day(0, 10), colour: '#e06c75', all_day: false },
  { uid: '2', title: 'Court', start: day(0, 13), end: day(0, 14), colour: '#61afef', all_day: false },
  { uid: '3', title: 'Sam PTO', start: day(1, 0), end: day(1, 23), colour: '#c678dd', all_day: true },
  { uid: '4', title: 'Drop Sam car', start: day(2, 15), end: day(2, 16), colour: '#e5c07b', all_day: false },
  { uid: '5', title: 'IT SCRUM', start: day(2, 10), end: day(2, 11), colour: '#98c379', all_day: false },
  // A day deliberately over the cap, to exercise the overflow counter.
  ...Array.from({ length: 9 }, (_, i) => ({
    uid: `busy${i}`, title: `Meeting ${i + 1}`,
    start: day(3, 8 + i), end: day(3, 9 + i), colour: '#61afef', all_day: false,
  })),
];

const STYLES = ['agenda', 'month', 'week', 'minimonth', 'timeline', 'bubbles'];

/* Bubbles stacks into week rows past 7 days. Check the shape directly: the
 * rows must align to week boundaries, or the weekday columns do not line up
 * between them and the whole point is lost. */
async function weekRowCheck() {
  const problems = [];
  const DAY = 86400000;

  for (const [days, wantRows] of [[7, 1], [14, 2], [21, 3], [10, 2]]) {
    const body = mk('div');
    const ctx = {
      body,
      config: { style: 'bubbles', strip_days: days, strip_back: 1, week_start: 0 },
      timezone: 'America/New_York',
      el0: mk('div'), getJSON: async () => ({ events }),
      interval: () => {}, fail: (e) => { throw e; }, clearFail: () => {},
    };
    calendar.mount(ctx);
    // mount() draws asynchronously - the earlier loop awaits for the same
    // reason. Checking immediately measures an empty node.
    await new Promise((r) => setTimeout(r, 60));
    // The wrapper holds one block per week, plus hairlines between them.
    const wrap = body.children[0];
    const blocks = (wrap?.children || []).filter((c) => (c.children || []).length >= 3);
    if (blocks.length !== wantRows) {
      problems.push(`${days} days -> ${blocks.length} rows, expected ${wantRows}`);
    } else {
      console.log(`  ok   ${days} days -> ${blocks.length} week row(s)`);
    }
  }
  return problems;
}

const fails = [];

for (const style of STYLES) {
  for (const events_ of [events, []]) {
    try {
      const body = mk('div');
      const ctx = {
        body,
        config: { style, source_ids: [1], max_per_day: 5, max_items: 10 },
        // Deliberately NOT ctx.board - that property does not exist, and
        // passing it here is what hid a style reading it and silently
        // falling back to the machine's own timezone.
        timezone: 'America/New_York',
        el0: mk('div'),
        getJSON: async () => ({ events: events_ }),
        interval: () => {},
        fail: (e) => { throw e; },
        clearFail: () => {},
      };
      calendar.mount(ctx);
      await new Promise((r) => setTimeout(r, 60));
      const label = events_.length ? 'with events' : 'empty';
      if (!body.children.length) {
        fails.push(`${style} (${label}) rendered nothing`);
      } else {
        console.log(`  ok   ${style.padEnd(10)} ${label}`);
      }
    } catch (err) {
      fails.push(`${style}: ${String(err.stack || err).split('\n').slice(0, 2).join(' | ')}`);
    }
  }
}

fails.push(...(await weekRowCheck()));

/* Today must land on today IN THE BOARD'S TIMEZONE.
 *
 * Both new styles read ctx.board?.timezone, which does not exist, so Intl
 * fell back to the machine's timezone. On a laptop set to the same zone that
 * looks perfect; on the appliance - whose clock is Europe/London - the marker
 * sat a day ahead. The check therefore runs with a timezone deliberately far
 * from this machine's. */
async function todayMarkerCheck() {
  const problems = [];
  const zones = ['America/New_York', 'Pacific/Auckland', 'Asia/Kolkata'];

  for (const zone of zones) {
    const body = mk('div');
    calendar.mount({
      body,
      config: { style: 'bubbles', strip_days: 7, strip_back: 1, today_colour: '#fb923c' },
      timezone: zone,
      el0: mk('div'), getJSON: async () => ({ events: [] }),
      interval: () => {}, fail: (e) => { throw e; }, clearFail: () => {},
    });
    await new Promise((r) => setTimeout(r, 60));

    const expected = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date()).slice(-2).replace(/^0/, '');

    // Find the cell drawn with the accent fill - that is the today disc.
    const marked = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (child.style && child.style.background === '#fb923c') {
          marked.push(String(child.children?.[0]?.textContent ?? child.textContent ?? ''));
        }
        walk(child);
      }
    };
    walk(body);

    const found = marked.map((t) => t.replace(/^0/, ''));
    if (!found.includes(expected)) {
      problems.push(`${zone}: today should be day ${expected}, marker on [${found.join(',')}]`);
    } else {
      console.log(`  ok   today marker correct in ${zone} (day ${expected})`);
    }
  }
  return problems;
}

fails.push(...(await todayMarkerCheck()));

/* The stacked view must lead with the week containing today, every day of the
 * week.
 *
 * The old code started at `today - strip_back` and snapped back to a week
 * boundary, so on a SUNDAY - with strip_back at 1 - it snapped into the week
 * that had just ended and led the board with a dead week. A bug that appears
 * on one day in seven is not one to find in use, so every weekday is checked
 * against the pure helper rather than against whatever today happens to be.
 */
function weekRollCheck() {
  const problems = [];
  // A known Sunday, then each following day.
  const week = ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02',
                '2026-09-03', '2026-09-04', '2026-09-05'];

  for (const day of week) {
    const start = weekStartKey(day, 0);
    if (start !== '2026-08-30') {
      problems.push(`week of ${day} started ${start}, expected 2026-08-30`);
    }
  }
  // The next Sunday must roll to the next week, not stay on the old one.
  const rolled = weekStartKey('2026-09-06', 0);
  if (rolled !== '2026-09-06') {
    problems.push(`Sunday 2026-09-06 started ${rolled}, expected it to roll`);
  } else {
    console.log('  ok   weeks roll on Sunday, and every day maps to its own week');
  }

  // Monday-start households get their own boundary.
  const mondayStart = weekStartKey('2026-09-06', 1);
  if (mondayStart !== '2026-08-31') {
    problems.push(`Monday-start week of 2026-09-06 began ${mondayStart}, expected 2026-08-31`);
  } else {
    console.log('  ok   Monday-start weeks use the Monday boundary');
  }

  return problems;
}

fails.push(...weekRollCheck());

/* AUTO-SCROLL: does a busy day actually render everything?
 *
 * The animation itself cannot be tested here - the shim has no geometry, and
 * something that only moves when scrollHeight exceeds clientHeight is exactly
 * the shape of code a DOM shim cannot exercise. What CAN be checked, and is
 * the part that decides whether the ninth meeting is visible at all, is the
 * structural consequence: with scrolling on every event is in the DOM and
 * there is no "+5" counter; with it off the old capped behaviour is intact.
 *
 * Tomorrow, not "day 3": a fixed offset lands outside some styles' window
 * depending on which day the suite happens to run, and a test that quietly
 * checks nothing two days a week is worse than no test.
 */
function walk(node, fn) {
  fn(node);
  for (const child of node.children || []) walk(child, fn);
}

function textsUnder(root) {
  const out = [];
  walk(root, (n) => {
    if (typeof n.textContent === 'string' && n.textContent) out.push(n.textContent);
    for (const child of n.children || []) {
      if (child.nodeType === 3 && child.textContent) out.push(child.textContent);
    }
  });
  return out;
}

async function draw(config, evts) {
  const body = mk('div');
  calendar.mount({
    body, config, timezone: 'America/New_York', el0: mk('div'),
    getJSON: async () => ({ events: evts }),
    interval: () => {}, fail: (e) => { throw e; }, clearFail: () => {},
  });
  await new Promise((r) => setTimeout(r, 60));
  return body;
}

async function overflowCheck() {
  const problems = [];
  // Nine meetings tomorrow, which every style's default window includes.
  const busy = Array.from({ length: 9 }, (_, i) => ({
    uid: `b${i}`, title: `Standup number ${i + 1} with a deliberately long name`,
    start: day(1, 8 + i), end: day(1, 9 + i), colour: '#61afef', all_day: false,
  }));

  for (const style of ['agenda', 'month', 'week', 'timeline', 'bubbles']) {
    const on = await draw({ style, max_per_day: 3, max_items: 4 }, busy);
    const texts = textsUnder(on);
    const rendered = busy.filter((ev) => texts.includes(ev.title)).length;
    const counter = texts.some((t) => /^\+\d+$/.test(t));

    if (style === 'week') {
      // The week grid shows a fixed Sunday-Saturday week, and tomorrow falls
      // outside it one day in seven, so this style is checked for the counter
      // rather than for a count that would be right six days out of seven.
      if (counter) problems.push(`${style}: still showed a "+N" counter with scrolling on`);
      else console.log(`  ok   ${style.padEnd(9)} no "+N" counter when scrolling`);
    } else if (rendered !== 9) {
      problems.push(`${style}: rendered ${rendered} of 9 events with auto-scroll on`);
    } else if (counter) {
      problems.push(`${style}: rendered everything but still shows a "+N" counter`);
    } else {
      console.log(`  ok   ${style.padEnd(9)} shows all 9 of a busy day, no "+N"`);
    }

    // ...and with it off, the old capped behaviour is untouched.
    if (style === 'week') continue;
    const off = await draw(
      { style, max_per_day: 3, max_items: 4, scroll_overflow: false, scroll_titles: false },
      busy,
    );
    const offTexts = textsUnder(off);
    const offRendered = busy.filter((ev) => offTexts.includes(ev.title)).length;
    const cap = style === 'agenda' ? 4 : 3;
    if (offRendered !== cap) {
      problems.push(`${style}: with scrolling off rendered ${offRendered}, expected the cap of ${cap}`);
    } else if (style !== 'agenda' && !offTexts.some((t) => /^\+\d+$/.test(t))) {
      problems.push(`${style}: with scrolling off the "+N" counter went missing`);
    } else {
      console.log(`  ok   ${style.padEnd(9)} still caps at ${cap} when scrolling is off`);
    }
  }
  return problems;
}

fails.push(...(await overflowCheck()));

/* A long title must be wrapped for horizontal scrolling, and must NOT be when
 * that is turned off - the static path still has to render the text. */
async function titleScrollCheck() {
  const problems = [];
  const long = [{
    uid: 'long', all_day: false, colour: '#e06c75',
    title: 'Quarterly Infrastructure Review - Bridgewater Site (Teams)',
    start: day(1, 9), end: day(1, 10),
  }];

  for (const scrollTitles of [true, false]) {
    const body = await draw({ style: 'agenda', scroll_titles: scrollTitles }, long);
    let wrapped = false;
    let present = false;
    walk(body, (n) => {
      if (n.textContent === long[0].title) {
        present = true;
        if (n.className === 'lb-scroll-inner') wrapped = true;
      }
    });
    if (!present) {
      problems.push(`scroll_titles=${scrollTitles}: the title was not rendered at all`);
    } else if (wrapped !== scrollTitles) {
      problems.push(`scroll_titles=${scrollTitles}: wrapped=${wrapped}`);
    } else {
      console.log(`  ok   long titles ${scrollTitles ? 'scroll' : 'stay static'} when scroll_titles=${scrollTitles}`);
    }
  }
  return problems;
}

fails.push(...(await titleScrollCheck()));

/* NOTHING SCROLLS UNLESS SOMETHING IS ACTUALLY CUT OFF.
 *
 * The first version animated any overflow over two pixels, and a day holding
 * two plainly visible appointments bounced up and down forever. Measured on
 * the appliance's own Chromium, a title wrapper came out 19.00px tall around
 * 14.39px of text - so two events carried about nine pixels of overflow while
 * displaying everything.
 *
 * The wrapper no longer does that, and this checks the second line of
 * defence: the threshold is a fraction of the item at the clipped edge, so a
 * few pixels from any other source cannot start an animation either.
 */
async function thresholdCheck() {
  const { scrollThreshold } = await import(
    pathToFileURL(join(WEB, 'render/widgets/scroll.js')).href
  );
  const problems = [];

  const cases = [
    // [overflow, item height, container height, should scroll, label]
    [9, 36, 110, false, 'the reported bug: 9px of slack under two 36px cards'],
    [4, 36, 110, false, 'sub-pixel rounding'],
    [0, 36, 110, false, 'content that fits exactly'],
    [40, 36, 110, true, 'a whole card hidden below the fold'],
    [18, 36, 110, true, 'half a card hidden'],
    [5, 14, 200, false, 'a title clipped by less than half a character'],
    [30, 14, 200, true, 'a title clipped by two words'],
    // A single item far taller than its box must still scroll: without the
    // cap, 35% of a 300px card is a threshold nothing could ever exceed.
    [150, 300, 160, true, 'one item much taller than its container'],
  ];

  for (const [overflow, unit, container, want, label] of cases) {
    const got = overflow > scrollThreshold(unit, container);
    if (got !== want) {
      problems.push(`${label}: overflow ${overflow}px vs threshold `
        + `${scrollThreshold(unit, container).toFixed(1)}px -> scroll=${got}, expected ${want}`);
    } else {
      console.log(`  ok   ${want ? 'scrolls' : 'stays still'}: ${label}`);
    }
  }
  return problems;
}

fails.push(...(await thresholdCheck()));

/* Side by side.
 *
 * The point of the mode is that a day's events share ONE container laid out as
 * a row, rather than being siblings stacked down the page - so the test looks
 * at the shape of the DOM, not just at whether the titles appear. Counting
 * titles alone would pass just as happily on the stacked layout it is meant to
 * be different from.
 */
async function sideBySideCheck() {
  const problems = [];
  const day = Array.from({ length: 4 }, (_, i) => ({
    title: `Meeting ${i + 1}`,
    start: new Date(Date.now() + 86400000 + i * 3600000).toISOString(),
    end: new Date(Date.now() + 86400000 + i * 3600000 + 1800000).toISOString(),
    colour: '#5b9dd9',
  }));

  const rows = (root) => {
    const found = [];
    walk(root, (n) => {
      if (n.style && n.style.flexWrap === 'wrap' && (n.children || []).length) {
        found.push(n);
      }
    });
    return found;
  };

  // --- stacked, the default, must be unchanged ---------------------------
  const stacked = await draw({ style: 'agenda', scroll_overflow: false }, day);
  const stackedTexts = textsUnder(stacked);
  const allStacked = day.every((ev) => stackedTexts.includes(ev.title));
  if (!allStacked) problems.push('stacked agenda lost an event');
  else if (rows(stacked).length) problems.push('stacked agenda built a wrapping row');
  else console.log('  ok   stacked agenda unchanged, no row container');

  // --- side by side ------------------------------------------------------
  const side = await draw(
    { style: 'agenda', event_flow: 'row', scroll_overflow: false }, day);
  const sideTexts = textsUnder(side);
  const missing = day.filter((ev) => !sideTexts.includes(ev.title));
  if (missing.length) {
    problems.push(`side-by-side dropped ${missing.length} event(s)`);
  } else {
    console.log('  ok   side by side shows every event');
  }

  const containers = rows(side);
  if (containers.length !== 1) {
    problems.push(`side-by-side made ${containers.length} row containers, wanted 1`);
  } else if (containers[0].children.length !== 4) {
    problems.push(`the row holds ${containers[0].children.length} cards, wanted 4`);
  } else {
    console.log('  ok   one row holding all four of the day\'s events');
  }

  // Cards share the width rather than being sized by their titles.
  const card = containers[0] && containers[0].children[0];
  if (card && !/1 1 0/.test(String(card.style.flex || ''))) {
    problems.push(`cards do not share the width evenly: flex=${card.style.flex}`);
  } else if (card) {
    console.log('  ok   cards share the width evenly');
  }

  // --- a cap on how many go across ---------------------------------------
  const capped = await draw(
    { style: 'agenda', event_flow: 'row', events_per_row: 2, scroll_overflow: false },
    day);
  const cappedRow = rows(capped)[0];
  const first = cappedRow && cappedRow.children[0];
  if (!first || !/50%/.test(String(first.style.flex || ''))) {
    problems.push(`events_per_row=2 did not size cards to half: `
      + `flex=${first && first.style.flex}`);
  } else {
    console.log('  ok   events_per_row caps how many go across');
  }

  // --- two days stay separate --------------------------------------------
  const twoDays = [...day, {
    title: 'Next day thing',
    start: new Date(Date.now() + 2 * 86400000).toISOString(),
    end: new Date(Date.now() + 2 * 86400000 + 1800000).toISOString(),
    colour: '#7fb069',
  }];
  const split = await draw(
    { style: 'agenda', event_flow: 'row', scroll_overflow: false }, twoDays);
  const splitRows = rows(split);
  if (splitRows.length !== 2) {
    problems.push(`two days produced ${splitRows.length} rows, wanted one each`);
  } else {
    console.log('  ok   each day gets its own row');
  }

  return problems;
}

fails.push(...(await sideBySideCheck()));

await new Promise((r) => setTimeout(r, 150));

if (fails.length) {
  console.error(`\n${fails.length} failure(s):`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nall ${STYLES.length} calendar styles render, with events and empty`);
process.exit(0);
