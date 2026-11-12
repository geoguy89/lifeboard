/* The slideshow deck: is it actually random, and does it actually show
 * everything?
 *
 * This exists because the bug it guards against is invisible by inspection
 * and nearly invisible in use. The old slideshow shuffled an array and walked
 * an index, then RE-SHUFFLED on every album re-fetch while leaving the index
 * alone. Every fifteen minutes it threw away its progress and drew a new
 * random order, so with forty photos on a thirty-second dwell a pass never
 * completed: some photos came round twice an hour and others never appeared
 * at all. Watching a wall for an evening is not a test.
 *
 *     node tools/test_slideshow.mjs
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..', 'web');

/* Minimal shim: the registry pulls in app.js, which reads the document at
 * module scope. Enter through the registry for the same reason the calendar
 * test does - media.js imports app.js imports the registry imports media.js,
 * and loading the leaf first hits that cycle mid-initialisation. */
function mk() {
  return {
    style: { setProperty() {}, removeProperty() {} },
    children: [], className: '', textContent: '',
    append() {}, appendChild() {}, replaceChildren() {},
    setAttribute() {}, addEventListener() {}, remove() {},
    querySelector: () => null, querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {} },
  };
}
globalThis.document = {
  createElement: mk, createElementNS: mk,
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  head: mk(), body: mk(), getElementById: () => null,
  querySelector: () => null, addEventListener() {},
};
globalThis.window = { addEventListener() {}, location: { search: '', reload() {} } };
globalThis.location = window.location;
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

await import(pathToFileURL(join(WEB, 'render/widgets/registry.js')).href);
const { createDeck, isVideo } = await import(
  pathToFileURL(join(WEB, 'render/widgets/media.js')).href
);

const fails = [];
const ok = (msg) => console.log(`  ok   ${msg}`);
const bad = (msg) => fails.push(msg);

const album = (n, prefix = 'p') =>
  Array.from({ length: n }, (_, i) => ({ url: `${prefix}${i}.jpg`, kind: 'image' }));

/* 1. A pass deals every item exactly once. */
{
  const deck = createDeck({});
  deck.sync(album(40));
  const drawn = Array.from({ length: 40 }, () => deck.next().url);
  const unique = new Set(drawn);
  if (unique.size !== 40) bad(`first pass drew ${unique.size} distinct of 40`);
  else ok('a pass shows all 40 photos, each exactly once');

  const second = Array.from({ length: 40 }, () => deck.next().url);
  if (new Set(second).size !== 40) bad(`second pass drew ${new Set(second).size} distinct of 40`);
  else ok('the next pass shows all 40 again');

  if (drawn.join() === second.join()) bad('two passes came out in identical order');
  else ok('the two passes are in different orders');
}

/* 2. THE ACTUAL REPORTED BUG. Re-fetching the album mid-pass must not restart
 *    the shuffle. Simulated exactly as it happens on the board: 30-second
 *    dwell, album re-checked every 15 minutes, i.e. a sync every 30 slides. */
{
  const deck = createDeck({});
  const items = album(40);
  deck.sync(items);
  const seen = new Set();
  for (let slide = 0; slide < 40; slide += 1) {
    if (slide > 0 && slide % 30 === 0) deck.sync(items);   // the 15-minute re-fetch
    seen.add(deck.next().url);
  }
  if (seen.size !== 40) {
    bad(`with a mid-pass re-fetch, only ${seen.size} of 40 photos appeared in 40 slides`);
  } else {
    ok('an album re-fetch mid-pass does not restart the shuffle');
  }
}

/* 3. No item ends one pass and opens the next. */
{
  let offences = 0;
  for (let trial = 0; trial < 300; trial += 1) {
    const deck = createDeck({});
    deck.sync(album(6));
    let last = null;
    for (let i = 0; i < 18; i += 1) {
      const url = deck.next().url;
      if (url === last) offences += 1;
      last = url;
    }
  }
  if (offences) bad(`${offences} back-to-back repeats across pass boundaries`);
  else ok('no photo is ever shown twice in a row, including across passes');
}

/* 4. Photos added to a shared album join the pass in progress. */
{
  const deck = createDeck({});
  const items = album(10);
  deck.sync(items);
  for (let i = 0; i < 5; i += 1) deck.next();
  deck.sync([...items, ...album(3, 'new')]);

  const rest = new Set();
  for (let i = 0; i < 8; i += 1) rest.add(deck.next().url);
  const newcomers = ['new0.jpg', 'new1.jpg', 'new2.jpg'].filter((u) => rest.has(u));
  if (newcomers.length !== 3) {
    bad(`only ${newcomers.length} of 3 newly added photos appeared in the rest of the pass`);
  } else if (rest.size !== 8) {
    bad(`the rest of the pass repeated itself (${rest.size} distinct of 8)`);
  } else {
    ok('photos added mid-pass appear before the pass ends, with no repeats');
  }
}

/* 5. A deleted photo stops appearing. */
{
  const deck = createDeck({});
  deck.sync(album(5));
  deck.next();
  deck.sync(album(5).filter((i) => i.url !== 'p3.jpg'));
  const drawn = new Set();
  for (let i = 0; i < 30; i += 1) drawn.add(deck.next().url);
  if (drawn.has('p3.jpg')) bad('a photo removed from the album was still shown');
  else ok('a photo removed from the album stops appearing');
}

/* 6. Shuffle off means source order, in order, forever. */
{
  const deck = createDeck({ shuffle: false });
  deck.sync(album(4));
  const drawn = Array.from({ length: 8 }, () => deck.next().url);
  const want = ['p0.jpg', 'p1.jpg', 'p2.jpg', 'p3.jpg', 'p0.jpg', 'p1.jpg', 'p2.jpg', 'p3.jpg'];
  if (drawn.join() !== want.join()) bad(`shuffle off gave ${drawn.join(',')}`);
  else ok('with shuffle off the album plays in order');
}

/* 7. An empty deck returns null rather than throwing - a board with a broken
 *    album must keep showing the last good slide, not die. */
{
  const deck = createDeck({});
  if (deck.next() !== null) bad('an empty deck did not return null');
  else ok('an empty album yields null instead of throwing');
}

/* 8. Video recognition. The server says so explicitly; the URL sniff is the
 *    fallback for a source that has not been taught to. */
{
  const cases = [
    [{ url: 'a.jpg', kind: 'video' }, true, 'the server saying so wins'],
    [{ url: 'clip.mp4', kind: 'image' }, false, 'the server saying image wins over the extension'],
    [{ url: 'clip.mp4' }, true, '.mp4'],
    [{ url: 'clip.MOV' }, true, '.MOV'],
    [{ url: 'https://lh3.googleusercontent.com/abc=m18' }, true, 'a Google =m18 rendition'],
    [{ url: 'https://lh3.googleusercontent.com/abc=w1920' }, false, 'a Google =w1920 still'],
    [{ url: '/api/photo?source_id=2&asset_id=x&kind=video' }, true, 'an Immich video proxy URL'],
    [{ url: '/api/photo?source_id=2&index=4' }, false, 'an Immich/local still'],
  ];
  let wrong = 0;
  for (const [item, want, label] of cases) {
    if (isVideo(item) !== want) { bad(`isVideo wrong for ${label}: ${item.url}`); wrong += 1; }
  }
  if (!wrong) ok(`video recognition correct for all ${cases.length} URL shapes`);
}

/* 9. The mount path, far enough to prove the two promises that matter for
 *    video: it is MUTED, and a long clip starts somewhere other than zero.
 *
 *    A DOM shim cannot play anything, but it can be handed the events a real
 *    <video> would fire, and the decisions the widget makes off the back of
 *    them are the whole feature. */
{
  const { photos } = await import(
    pathToFileURL(join(WEB, 'render/widgets/media.js')).href
  );

  const made = [];
  function element(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      style: { setProperty() {}, removeProperty() {} },
      children: [], listeners: {}, className: '',
      append(...c) { this.children.push(...c.filter(Boolean)); },
      appendChild(c) { this.children.push(c); return c; },
      replaceChildren(...c) { this.children = c.filter(Boolean); },
      setAttribute() {}, removeAttribute() {}, load() {}, pause() {},
      play() { this.playing = true; return Promise.resolve(); },
      addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
      fire(name) { for (const fn of this.listeners[name] || []) fn(); },
      remove() {},
      querySelector(sel) {
        const want = sel.toUpperCase();
        const hunt = (n) => {
          for (const c of n.children || []) {
            if (c.tagName === want) return c;
            const deeper = hunt(c);
            if (deeper) return deeper;
          }
          return null;
        };
        return hunt(this);
      },
    };
    made.push(node);
    return node;
  }
  document.createElement = element;

  const images = [];
  globalThis.Image = class { constructor() { images.push(this); } };

  const mountWith = async (items, config) => {
    made.length = 0; images.length = 0;
    const body = element('div');
    const destroy = photos.mount({
      body, el0: element('div'), config, timezone: 'UTC',
      getJSON: async () => ({ items }),
      interval: () => {}, timeout: (fn, ms) => setTimeout(fn, ms),
      fail: () => {}, clearFail: () => {}, el: undefined,
    });
    await new Promise((r) => setTimeout(r, 30));
    return { body, destroy };
  };

  // A video album.
  {
    const { destroy } = await mountWith(
      [{ url: 'clip.mp4', kind: 'video' }],
      { source_ids: [1], video_seconds: 30 },
    );
    const video = made.find((n) => n.tagName === 'VIDEO');
    if (!video) {
      bad('a video item did not produce a <video> element');
    } else {
      if (video.muted !== true) bad('the slideshow video was not muted');
      else ok('a video slide is muted');

      video.duration = 120;
      video.currentTime = 0;
      video.fire('loadedmetadata');
      const t = video.currentTime;
      if (!(t > 0 && t <= 90)) {
        bad(`random start put a 120s clip at ${t}s (want >0 and <=90)`);
      } else {
        ok(`a 120s clip starts at a random ${t.toFixed(1)}s, not at zero`);
      }
      if (!video.playing) bad('playback was never started after the seek');
      else ok('playback starts after the seek, not before it');
    }
    destroy?.();
  }

  // The same clip with random start turned off must begin at the beginning.
  {
    const { destroy } = await mountWith(
      [{ url: 'clip.mp4', kind: 'video' }],
      { source_ids: [1], video_random_start: false },
    );
    const video = made.find((n) => n.tagName === 'VIDEO');
    video.duration = 300;
    video.currentTime = 0;
    video.fire('loadedmetadata');
    if (video.currentTime !== 0) bad(`random start was off but the clip began at ${video.currentTime}`);
    else ok('with random start off a clip begins at the beginning');
    destroy?.();
  }

  // include_videos off must leave nothing to show rather than showing stills
  // of video - and must not throw.
  {
    const { destroy } = await mountWith(
      [{ url: 'clip.mp4', kind: 'video' }],
      { source_ids: [1], include_videos: false },
    );
    if (made.some((n) => n.tagName === 'VIDEO')) bad('a video played with include_videos off');
    else ok('videos are excluded when the widget is set to stills only');
    destroy?.();
  }

  // A still image goes down the Image-preload path, not the video path.
  {
    const { destroy } = await mountWith(
      [{ url: 'a.jpg', kind: 'image' }],
      { source_ids: [1] },
    );
    if (made.some((n) => n.tagName === 'VIDEO')) bad('a photo was treated as a video');
    else if (images.length !== 1) bad(`a photo slide preloaded ${images.length} images, expected 1`);
    else ok('a photo slide preloads through Image() before fading in');
    destroy?.();
  }
}

if (fails.length) {
  console.error(`\n${fails.length} failure(s):`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nslideshow deck: complete, random, and stable across album re-fetches');
process.exit(0);
