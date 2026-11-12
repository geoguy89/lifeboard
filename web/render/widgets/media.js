/* Video, photo slideshows, still images, arbitrary embeds.
 *
 * AUTOPLAY, AND WHY THE KIOSK FLAGS MATTER
 * ----------------------------------------
 * Browsers block autoplay *with sound* unless there has been a user gesture.
 * On a wall display there will never be a user gesture. So:
 *
 *   - muted autoplay works everywhere, always. This is the default and it is
 *     the normal case for a dashboard (a YouTube live feed in the corner).
 *   - unmuted autoplay only works because the kiosk launches Chromium with
 *     --autoplay-policy=no-user-gesture-required. That flag is set in
 *     deploy/kiosk.sh. Without it, enabling audio here silently produces a
 *     paused black box, which is a maddening thing to debug.
 *
 * The `muted` option is therefore honoured in two places at once: the element
 * attribute, and the YouTube embed parameter. Setting only one of them is the
 * classic bug - YouTube's iframe ignores the element and obeys its own param.
 */

import { el, getJSON } from '../app.js';

/* ------------------------------------------------------------------ video */

/** Recognise the common URL shapes and return an embeddable form. */
function resolveVideo(rawUrl, { muted, loop }) {
  let url;
  try { url = new URL(rawUrl); } catch { return { kind: 'invalid' }; }

  const host = url.hostname.replace(/^www\./, '');

  // --- YouTube: watch, youtu.be, /live/, /embed/, and channel live ---------
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be'
      || host === 'youtube-nocookie.com') {
    let id = null;
    let channel = null;

    if (host === 'youtu.be') id = url.pathname.slice(1);
    else if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (url.pathname.startsWith('/embed/')) id = url.pathname.split('/')[2];
    else if (url.pathname.startsWith('/live/')) id = url.pathname.split('/')[2];
    else if (url.pathname.startsWith('/channel/')) channel = url.pathname.split('/')[2];

    const params = new URLSearchParams({
      autoplay: '1',
      // YouTube requires mute=1 for autoplay to be allowed at all in most
      // contexts. With the kiosk autoplay flag set, mute=0 does work.
      mute: muted ? '1' : '0',
      controls: '0',
      modestbranding: '1',
      rel: '0',
      playsinline: '1',
      iv_load_policy: '3',      // no annotations
      disablekb: '1',
      fs: '0',
    });
    if (loop && id) {
      // A single-video loop needs the playlist param naming itself. This does
      // nothing for a live stream, which is correct - a live stream has no end.
      params.set('loop', '1');
      params.set('playlist', id);
    }

    if (channel) {
      // "Whatever this channel is streaming right now" - the thing you
      // actually want for a 24/7 live feed, since the video id changes each
      // time the stream restarts.
      return {
        kind: 'iframe',
        src: `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(channel)}&${params}`,
      };
    }
    if (id) {
      return { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${id}?${params}` };
    }
  }

  // --- Vimeo ---------------------------------------------------------------
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = url.pathname.split('/').filter(Boolean).pop();
    if (id && /^\d+$/.test(id)) {
      const params = new URLSearchParams({
        autoplay: '1', muted: muted ? '1' : '0', loop: loop ? '1' : '0',
        background: '1', controls: '0',
      });
      return { kind: 'iframe', src: `https://player.vimeo.com/video/${id}?${params}` };
    }
  }

  // --- A direct media file, or an HLS stream -------------------------------
  // .m3u8 is how most cameras and local streams present themselves. Chrome on
  // desktop Linux does not play HLS natively, so this is flagged for the
  // caller; hls.js is loaded only if such a source is actually configured.
  const isHls = /\.m3u8(\?|$)/i.test(url.pathname + url.search);
  return { kind: isHls ? 'hls' : 'file', src: rawUrl };
}

export const video = {
  panelled: false,
  mount(ctx) {
    const { config } = ctx;
    const url = config.url || '';
    const muted = config.muted !== false;      // default: silent
    const loop = config.loop !== false;

    if (!url) {
      ctx.body.append(el('div', { style: { color: '#9aa0a8', padding: '1vmin' } },
        'No video URL configured'));
      return;
    }

    /* ENGINE
     *
     * 'native'  - the server runs mpv in an always-on-top window positioned
     *             exactly over this rectangle. The page renders a black hole
     *             and nothing else. This is the only way a Raspberry Pi plays
     *             a 1080p live stream without melting: Chromium has no
     *             hardware decode for YouTube's VP9/AV1 there, whereas mpv
     *             fed an H.264 stream by yt-dlp does.
     * 'browser' - the iframe/<video> path below. Fine on x86.
     * 'auto'    - native wherever the server reports mpv is available.
     *
     * The server owns placement; the page does not report its geometry,
     * because that would race with layout edits.
     */
    const engine = config.engine || 'auto';
    if (engine === 'native' || (engine === 'auto' && ctx.nativeVideo)) {
      ctx.el0.classList.add('native-video');
      return;
    }

    const resolved = resolveVideo(url, { muted, loop });

    if (resolved.kind === 'invalid') {
      ctx.fail(new Error('not a valid URL'));
      return;
    }

    /* 'direct' - let the SERVER turn a page link into a stream URL.
     *
     * This is what makes a live YouTube feed play on a device with no mpv. The
     * embed path below hands the job to YouTube's own player, which on an old
     * TV browser either refuses to load or negotiates VP9/AV1 the hardware
     * cannot decode - the exact problem mpv was brought in to solve on the Pi.
     * Asking the server for a direct H.264 rendition instead means YouTube's
     * player is never involved and the decoder gets the one codec every device
     * of that era can do.
     *
     * In 'auto' this sits BELOW native and ABOVE the embed, so a board with
     * mpv behaves exactly as it did.
     */
    const widgetId = ctx.widget && ctx.widget.id;
    if (resolved.kind === 'iframe' && widgetId
        && (engine === 'direct' || (engine === 'auto' && ctx.streamResolver))) {
      let gone = false;
      const cap = Number(config.max_height) || 0;

      const load = async () => {
        try {
          const data = await ctx.getJSON(
            '/api/data/stream?widget_id=' + widgetId
            + (cap ? '&max_height=' + cap : ''));
          if (gone) return;
          if (data.error || !data.url) throw new Error(data.error || 'no stream found');

          ctx.body.replaceChildren();
          // `renew` is the difference between recovering and not: see the
          // error handler in playDirect. A resolved stream URL is signed and
          // perishable, so the way back from a failure is a NEW url, not
          // another go at the dead one.
          playDirect(ctx, data.url, data.kind,
                     { config, muted, loop, renew: load });
          ctx.clearFail();

          /* Re-resolve BEFORE the link dies rather than after.
           *
           * A signed stream URL lasts a few hours, and a live stream gets a
           * new one whenever the broadcaster restarts. Waiting for playback to
           * fail means a frozen frame on the wall until somebody notices, so
           * the server says how long it considers the answer good for and this
           * asks again at three quarters of it.
           */
          const good = Number(data.expires_in) || 5400;
          ctx.timeout(load, Math.max(60, good * 0.75) * 1000);
        } catch (err) {
          if (!gone) ctx.fail(err, load);
        }
      };

      load();
      return () => { gone = true; };
    }

    if (resolved.kind === 'iframe') {
      /* object-fit does nothing to an iframe - the embed letterboxes itself
       * inside whatever box it gets, so "Fill" and "Fit" were the same
       * picture. To fill the card we give the iframe the 16:9 rectangle that
       * COVERS the card, centre it, and let the card clip the overhang.
       *
       * The card's shape is only known at runtime and changes whenever the
       * block is resized, so this is measured rather than written in CSS. */
      const frame = el('iframe', {
        src: resolved.src,
        frameborder: '0',
        allow: 'autoplay; encrypted-media; picture-in-picture',
        allowfullscreen: 'true',
        style: {
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          border: '0', display: 'block', pointerEvents: 'none',
        },
      });

      ctx.body.style.overflow = 'hidden';
      // The iframe is positioned against this, so it must be a containing
      // block - without it the frame centres on the page instead of the card.
      if (getComputedStyle(ctx.body).position === 'static') {
        ctx.body.style.position = 'relative';
      }
      ctx.body.append(frame);

      // 16:9 unless told otherwise. A wrong ratio here shows up as bars on
      // two sides, which is why it is worth being able to override.
      const aspect = Number(config.aspect) > 0 ? Number(config.aspect) : 16 / 9;

      // 1 = exactly cover. Above that the picture grows and the card crops
      // more of it, which is how you lose a channel bug or a baked-in bar.
      const zoom = Math.max(1, Number(config.zoom) || 1);
      const panX = Number(config.pan_x) || 0;   // percent of the frame
      const panY = Number(config.pan_y) || 0;

      const size = () => {
        const width = ctx.body.clientWidth;
        const height = ctx.body.clientHeight;
        if (!width || !height) return;      // not laid out yet

        // cover: the smallest 16:9 box that contains the card.
        // contain: the largest that fits inside it.
        const wider = width / height > aspect;
        const cover = (config.fit || 'cover') !== 'contain';
        const useWidth = cover ? wider : !wider;

        // Zoom only means anything when filling - enlarging a picture that is
        // deliberately letterboxed would just crop what Fit exists to show.
        const scale = cover ? zoom : 1;

        if (useWidth) {
          frame.style.width = `${Math.ceil(width * scale)}px`;
          frame.style.height = `${Math.ceil((width * scale) / aspect)}px`;
        } else {
          frame.style.height = `${Math.ceil(height * scale)}px`;
          frame.style.width = `${Math.ceil(height * scale * aspect)}px`;
        }

        // Pan is applied on top of the centring translate, in percent of the
        // frame, so it means the same thing at any card size.
        frame.style.transform =
          `translate(calc(-50% + ${panX}%), calc(-50% + ${panY}%))`;
      };

      size();
      // Re-measure on resize. A layout edit changes the card's shape without
      // remounting the widget, so a one-off measurement goes stale.
      let observer = null;
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(size);
        observer.observe(ctx.body);
      } else {
        ctx.interval(size, 2000);
      }

      // A live stream that ends leaves a dead frame. Reloading on a long timer
      // is crude but it is the only signal available from inside a
      // cross-origin iframe, and a stale frame is the failure people actually
      // hit after a week of uptime.
      const reloadMinutes = Number(config.reload_minutes || 0);
      if (reloadMinutes > 0) {
        ctx.interval(() => { frame.src = resolved.src; }, reloadMinutes * 60_000);
      }

      // Returned cleanup: an observer left watching a removed element keeps it
      // alive, and a board is re-laid-out often enough for that to accumulate.
      return () => observer?.disconnect();
    }

    return playDirect(ctx, resolved.src, resolved.kind, { config, muted, loop });
  },
};

/* Play a direct stream URL in a real <video>.
 *
 * Split out of mount() because there are now two ways to arrive here: a URL
 * that was already a file or an HLS playlist, and a YouTube page link the
 * SERVER resolved into one. Both play the same way; only the route differs.
 */
function playDirect(ctx, src, kind, options) {
    const { config, muted, loop, renew } = options;
    // A real <video> gives hardware decode and genuine mute control.
    const node = el('video', {
      autoplay: 'true',
      playsinline: 'true',
      loop: loop ? 'true' : null,
      style: {
        width: '100%', height: '100%', display: 'block',
        objectFit: config.fit || 'cover',
        // object-position moves the crop window; the scale pushes past cover.
        objectPosition: `${50 + (Number(config.pan_x) || 0)}% `
                      + `${50 + (Number(config.pan_y) || 0)}%`,
        transform: (Number(config.zoom) || 1) > 1
          ? `scale(${Math.max(1, Number(config.zoom))})` : '',
      },
    });
    // A scaled <video> overflows its box; the card has to clip it.
    ctx.body.style.overflow = 'hidden';
    node.muted = muted;               // must be the property, not the attribute
    node.volume = muted ? 0 : Number(config.volume ?? 1);
    ctx.body.append(node);

    const play = () => node.play().catch((err) => ctx.fail(
      new Error(`autoplay blocked: ${err.message}. Unmuted playback needs the kiosk autoplay flag.`)
    ));

    if (kind === 'hls' && !node.canPlayType('application/vnd.apple.mpegurl')) {
      // Loaded on demand so a board with no HLS source pays nothing for it.
      import('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js')
        .then(() => {
          /* global Hls */
          if (window.Hls && window.Hls.isSupported()) {
            const hls = new window.Hls({ liveDurationInfinity: true });
            hls.loadSource(src);
            hls.attachMedia(node);
            play();
          } else {
            ctx.fail(new Error('HLS not supported in this browser'));
          }
        })
        .catch(() => ctx.fail(new Error('could not load HLS support')));
    } else {
      node.src = src;
      play();
    }

    /* WHEN A STREAM DIES, ASK FOR A NEW ADDRESS - DO NOT REDIAL THE OLD ONE.
     *
     * This used to call node.load() and play() again on the SAME src. For a
     * file that is fine. For a resolved YouTube stream it cannot work: the URL
     * is signed and perishable, and a live broadcast gets an entirely new one
     * whenever it restarts. Retrying the dead link fails identically every
     * fifteen seconds, forever - so the banner never cleared, and the reported
     * symptom is exactly that: an interrupted feed that stays interrupted with
     * "stream error, retrying" sitting on it.
     *
     * `renew` re-asks the server, which is the only thing that can actually
     * produce a working URL. It replaces the whole element, so this node and
     * its listeners go with it.
     */
    let recovering = false;

    node.addEventListener('error', () => {
      if (recovering) return;
      recovering = true;

      /* A short grace before saying anything.
       *
       * A <video> fires `error` for things it shrugs off by itself - one bad
       * segment, a source swapped mid-load - and a board that flashes a red
       * banner every time a stream hiccups teaches people to ignore the corner
       * of the screen. Three seconds is long enough to tell a blip from a
       * break, and short enough that a real failure is still reported promptly.
       */
      ctx.timeout(() => {
        if (!recovering) return;
        ctx.fail(new Error('stream error, retrying'));
      }, 3_000);

      ctx.timeout(() => {
        if (!recovering) return;
        if (typeof renew === 'function') renew();
        else { node.load(); play(); }
      }, 15_000);
    });

    /* AND SAY SO WHEN IT COMES BACK.
     *
     * The banner was only ever written, never cleared, so a stream that
     * hiccuped during start-up and then played perfectly for a week still
     * carried "stream error, retrying" in the corner. An error message that
     * outlives the error is worse than none.
     */
    for (const good of ['playing', 'canplay']) {
      node.addEventListener(good, () => {
        recovering = false;
        ctx.clearFail();
      });
    }
    node.addEventListener('ended', () => { if (loop) { node.load(); play(); } });

    return () => { try { node.pause(); node.removeAttribute('src'); node.load(); } catch { /* teardown */ } };
}

/* ---------------------------------------------------------- slideshow */

/* Photos AND videos, from one or several albums.
 *
 * WHY THIS IS A DECK AND NOT AN INDEX
 * -----------------------------------
 * The first version shuffled an array and walked an index through it. That
 * looks random and is not, because the album is re-fetched every fifteen
 * minutes and the fetch re-shuffled the array while leaving the index where
 * it was. With forty photos and thirty seconds each you get thirty slides
 * between re-fetches, so a pass NEVER completed: every re-shuffle threw away
 * whatever progress had been made and drew a fresh random order, which is
 * sampling WITH replacement in everything but name. The observable symptom is
 * exactly the one reported - "I keep seeing the same photo every other time,
 * and I never see some of them at all".
 *
 * A deck fixes it properly: shuffle once, deal every item exactly once, then
 * reshuffle. Re-fetching MERGES into the deck instead of replacing it, so
 * newly added photos join the pass in progress and nothing already dealt
 * comes back early. `createDeck` is exported so this is testable without a
 * browser, because "is it actually random and complete" is not a thing you
 * can verify by looking at a wall.
 */

export function createDeck({ shuffle = true, random = Math.random } = {}) {
  let byId = new Map();     // id -> item, everything currently in the albums
  let queue = [];           // ids not yet dealt this pass
  let dealt = new Set();    // ids dealt this pass
  let lastId = null;

  const pick = (list) => {
    if (!shuffle) return list.slice();
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  return {
    /** Replace the known items, preserving progress through the current pass. */
    sync(items) {
      const next = new Map();
      for (const item of items) {
        if (item && item.url && !next.has(item.url)) next.set(item.url, item);
      }
      const added = [...next.keys()].filter((id) => !byId.has(id));
      byId = next;

      // Drop anything deleted from the album, keep the rest of the pass, and
      // shuffle the newcomers in among what is still to come.
      queue = queue.filter((id) => byId.has(id));
      for (const id of dealt) if (!byId.has(id)) dealt.delete(id);
      if (added.length) queue = pick([...queue, ...added]);
      return { total: byId.size, added: added.length };
    },

    /** The next item, or null when there is nothing at all to show. */
    next() {
      if (!byId.size) return null;
      if (!queue.length) {
        // A pass is finished. Deal a fresh one, but never let the same item
        // end one pass and open the next - back-to-back repeats are the thing
        // that makes a slideshow look broken even when it is correct.
        dealt = new Set();
        queue = pick([...byId.keys()]);
        if (queue.length > 1 && queue[0] === lastId) {
          const swap = 1 + Math.floor(random() * (queue.length - 1));
          [queue[0], queue[swap]] = [queue[swap], queue[0]];
        }
      }
      const id = queue.shift();
      dealt.add(id);
      lastId = id;
      return byId.get(id) || null;
    },

    /** For tests and diagnostics. */
    stats() {
      return { total: byId.size, remaining: queue.length, dealt: dealt.size };
    },
  };
}

/* Videos are recognised by the server, which knows what an album actually
 * holds. This is the fallback for a source that has not been taught to say
 * so - and for Google's own URLs, where the =m18 suffix IS the answer. */
const VIDEO_URL = /(\.(mp4|m4v|webm|mov|ogv)(\?|$))|(=m\d+$)|([?&]kind=video)/i;

export function isVideo(item) {
  if (!item) return false;
  if (item.kind) return item.kind === 'video';
  return VIDEO_URL.test(item.url || '');
}

export const photos = {
  panelled: false,
  mount(ctx) {
    const { config } = ctx;
    const dwellMs = Math.max(2, Number(config.interval_seconds || 30)) * 1000;
    const fit = config.fit || 'cover';
    const transition = Number(config.transition_ms ?? 1200);

    const includeVideos = config.include_videos !== false;
    const clipSeconds = Math.max(2, Number(config.video_seconds || 30));
    const randomStart = config.video_random_start !== false;
    const videoMuted = config.video_muted !== false;

    /* WHICH ALBUMS
     *
     * `source_ids` is the multi-album field; `source_id` is what every board
     * built before it stored. Reading both means an existing widget keeps
     * working and gains the new field the moment anything is ticked, rather
     * than going blank on upgrade. */
    const sourceIds = [
      ...(Array.isArray(config.source_ids) ? config.source_ids : []),
      ...(config.source_id != null && config.source_id !== '' ? [config.source_id] : []),
    ].map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const uniqueSources = [...new Set(sourceIds)];

    const deck = createDeck({ shuffle: config.shuffle !== false });

    // Two stacked layers so one can fade in over the other. Swapping a single
    // element's source produces a visible flash of empty box on large photos.
    const layers = [0, 1].map(() => el('div', {
      style: {
        position: 'absolute', inset: '0',
        backgroundSize: fit === 'contain' ? 'contain' : 'cover',
        backgroundPosition: 'center', backgroundRepeat: 'no-repeat',
        opacity: '0', transition: `opacity ${transition}ms ease-in-out`,
      },
    }));
    layers.forEach((l) => ctx.body.append(l));
    ctx.body.style.overflow = 'hidden';

    let front = 0;
    // Every scheduled hand-off carries the generation it was made in, so a
    // late 'ended' from a video that has already been replaced cannot skip
    // the slide that replaced it.
    let generation = 0;
    // Which generation last wrote to each layer. A delayed tear-down must not
    // wipe a layer that has since been reused - with two layers and a slide
    // that fails fast, the layer being retired is the very next one used.
    const layerGen = [0, 0];

    /* TIMERS ARE OWNED HERE, NOT BY ctx.timeout.
     *
     * ctx.timeout remembers every id it ever handed out so it can clear them
     * on unmount, which is right for a widget that sets three timers at mount
     * and wrong for this one: at two or three timers per slide, a board left
     * up for a month would be holding a couple of hundred thousand dead ids.
     * This set holds only what is actually pending - never more than a
     * handful - and the returned cleanup clears it. */
    const pending = new Set();
    function after(ms, fn) {
      const id = setTimeout(() => { pending.delete(id); fn(); }, ms);
      pending.add(id);
      return id;
    }

    async function load({ initial = false } = {}) {
      if (!uniqueSources.length) {
        ctx.fail(new Error('no album chosen'));
        return;
      }
      const gathered = [];
      const errors = [];

      // Albums are fetched independently: one broken share link must not take
      // the working ones down with it, which is the whole reason for allowing
      // several in the first place.
      await Promise.all(uniqueSources.map(async (id) => {
        try {
          const data = await ctx.getJSON(`/api/data/photos?source_id=${id}`);
          const items = data.items
            || (data.photos || []).map((url) => ({ url, kind: 'image' }));
          for (const item of items) {
            if (!includeVideos && isVideo(item)) continue;
            gathered.push({ ...item, source_id: id });
          }
        } catch (err) {
          /* Strip the plumbing back off.
           *
           * getJSON reports failures as "502: <server's message>", which is
           * the right shape for a log and the wrong one for a television: the
           * number is the transport's opinion, not the album's, and it pushes
           * the part a person can act on off the end of a one-line banner.
           */
          const raw = String(err && err.message ? err.message : err);
          errors.push(`album ${id}: ${raw.replace(/^\d{3}:\s*/, '')}`);
        }
      }));

      if (gathered.length) {
        deck.sync(gathered);
        // Report a partly broken set of albums without going red over a board
        // that is still showing photos from the others.
        if (errors.length) ctx.fail(new Error(errors[0]));
        else ctx.clearFail();
      } else if (errors.length) {
        ctx.fail(new Error(errors[0]));
      } else if (initial) {
        ctx.fail(new Error('album returned no photos'));
      }
    }

    /** Clear whatever the retiring layer was showing. */
    function clearLayer(layer) {
      const old = layer.querySelector?.('video');
      if (old) {
        try { old.pause(); old.removeAttribute('src'); old.load(); } catch { /* teardown */ }
        old.remove();
      }
      layer.style.backgroundImage = 'none';
    }

    function reveal(back) {
      layers[back].style.opacity = '1';
      layers[front].style.opacity = '0';
      const retiring = front;
      const owner = layerGen[retiring];
      front = back;
      // Let the crossfade finish before tearing the old slide down, or a
      // video is yanked away mid-fade and the fade shows a black rectangle.
      // Only if the layer is still showing what it was showing when this was
      // scheduled - a slide that fails fast reuses this very layer.
      after(transition + 200, () => {
        if (layerGen[retiring] === owner) clearLayer(layers[retiring]);
      });
    }

    function scheduleNext(gen, ms) {
      after(ms, () => { if (gen === generation) advance(); });
    }

    function showImage(item, gen, back) {
      const img = new Image();
      img.onload = () => {
        if (gen !== generation) return;
        layers[back].style.backgroundImage = `url("${item.url}")`;
        reveal(back);
        scheduleNext(gen, dwellMs);
      };
      // A single unreachable photo should skip, not stall the whole slideshow.
      img.onerror = () => { if (gen === generation) scheduleNext(gen, 400); };
      img.src = item.url;
    }

    function showVideo(item, gen, back) {
      const node = el('video', {
        playsinline: 'true',
        preload: 'auto',
        style: {
          width: '100%', height: '100%', display: 'block',
          objectFit: fit === 'contain' ? 'contain' : 'cover',
        },
      });
      // Muted must be the PROPERTY. Setting the attribute alone is the classic
      // way to get a video that autoplay policy refuses to start.
      node.muted = videoMuted;
      node.volume = videoMuted ? 0 : Number(config.video_volume ?? 1);
      node.loop = false;
      layers[back].append(node);

      let handedOff = false;
      const handOff = (delay = 0) => {
        if (handedOff || gen !== generation) return;
        handedOff = true;
        scheduleNext(gen, delay);
      };

      const play = () => {
        const attempt = node.play();
        if (attempt && typeof attempt.catch === 'function') {
          attempt.catch((err) => {
            // Muted playback is allowed everywhere; if even that is refused
            // the slide is unshowable, so say why and move on rather than
            // leaving the board on a black rectangle.
            ctx.fail(new Error(`video would not play: ${err.message || err}`));
            if (gen === generation && !handedOff) { handedOff = true; advance(); }
          });
        }
      };

      node.addEventListener('loadedmetadata', () => {
        /* A RANDOM CLIP, NOT ALWAYS THE OPENING.
         *
         * Thirty seconds of a four-minute video is always the same thirty
         * seconds unless you move the start, and the opening of a phone video
         * is the least interesting part of it - it is the second where the
         * camera is still being raised.
         *
         * Playback starts HERE rather than beside the src assignment, so the
         * seek happens before the first frame is ever shown. Playing first and
         * seeking second shows a second of the opening, then jumps. */
        const duration = Number(node.duration);
        if (randomStart && Number.isFinite(duration) && duration > clipSeconds + 1) {
          try { node.currentTime = Math.random() * (duration - clipSeconds); } catch { /* not seekable */ }
        }
        play();
      });

      const start = () => {
        if (gen !== generation) return;
        reveal(back);
        // Whichever comes first: the clip length, or the end of the video.
        const duration = Number(node.duration);
        const remaining = Number.isFinite(duration) && duration > 0
          ? Math.max(1, duration - (node.currentTime || 0))
          : clipSeconds;
        handOff(Math.min(clipSeconds, remaining) * 1000);
      };

      // 'playing' is the honest signal that pixels are moving. 'canplay' can
      // fire on a video that then stalls, which would fade in a black box.
      node.addEventListener('playing', start, { once: true });
      node.addEventListener('ended', () => {
        // A clip shorter than the budget moves on rather than freezing on its
        // last frame for the rest of the dwell. advance() bumps the
        // generation, which is what invalidates the timer start() scheduled.
        if (gen !== generation) return;
        handedOff = true;
        advance();
      });
      node.addEventListener('error', () => {
        after(200, () => {
          if (gen === generation && !handedOff) { handedOff = true; advance(); }
        });
      });

      node.src = item.url;

      // Nothing playing after this long is a dead source, not a slow one. The
      // budget is generous because a Pi 3 opening a 1080p file is genuinely
      // slow, and cutting it off early would skip every video on the board.
      after(12_000, () => {
        if (gen === generation && !handedOff && node.paused) {
          handedOff = true;
          advance();
        }
      });
    }

    function advance() {
      const item = deck.next();
      if (!item) {
        /* Nothing to show yet - every album was unreachable at boot, which on
         * this appliance usually means the network came up after the browser
         * did. Retry rather than stopping: the old fixed interval recovered
         * from this by accident, and a self-scheduling chain has to do it on
         * purpose or the board stays black until someone reboots it.
         *
         * Bumping the generation first means only ONE retry chain survives, so
         * this cannot fan out into a storm of them. */
        generation += 1;
        scheduleNext(generation, Math.min(dwellMs, 30_000));
        return;
      }
      generation += 1;
      const gen = generation;
      const back = 1 - front;
      layerGen[back] = gen;
      clearLayer(layers[back]);

      if (isVideo(item)) showVideo(item, gen, back);
      else showImage(item, gen, back);
    }

    load({ initial: true }).then(() => {
      advance();

      /* Ask the albums again periodically, so photos added to a shared album
       * turn up without anyone reloading the board. The server caches per
       * source, so asking more often than its TTL costs nothing and simply
       * gets the cached answer.
       *
       * This used to run TWICE on two different timers, both re-shuffling -
       * which was half of why the same photos kept coming round. */
      const reloadMinutes = Math.max(1, Number(config.reload_minutes || 15));
      ctx.interval(() => load(), reloadMinutes * 60_000);
    });

    return () => {
      // Bump first: a timer that fires between here and the clear would
      // otherwise start a slide on a widget that no longer exists.
      generation += 1;
      for (const id of pending) clearTimeout(id);
      pending.clear();
      layers.forEach(clearLayer);
    };
  },
};

/* -------------------------------------------------------------- image */

export const image = {
  panelled: false,
  mount(ctx) {
    const { config } = ctx;
    const node = el('div', {
      style: {
        position: 'absolute', inset: '0',
        backgroundImage: config.url ? `url("${config.url}")` : 'none',
        backgroundSize: config.fit || 'cover',
        backgroundPosition: 'center', backgroundRepeat: 'no-repeat',
      },
    });
    ctx.body.append(node);

    // Cache-busting refresh, for a camera snapshot or a generated chart.
    const minutes = Number(config.refresh_minutes || 0);
    if (minutes > 0 && config.url) {
      ctx.interval(() => {
        const sep = config.url.includes('?') ? '&' : '?';
        node.style.backgroundImage = `url("${config.url}${sep}_t=${Date.now()}")`;
      }, minutes * 60_000);
    }
  },
};

/* ------------------------------------------------------------- iframe */

/* Any other web page. The escape hatch that means "anything DAKboard can do"
 * is at worst one iframe away - Grafana, Home Assistant, a traffic map. */
export const iframe = {
  panelled: false,
  mount(ctx) {
    const { config } = ctx;
    if (!config.url) {
      ctx.body.append(el('div', { style: { color: '#9aa0a8' } }, 'No URL configured'));
      return;
    }
    const frame = el('iframe', {
      src: config.url,
      frameborder: '0',
      style: {
        width: '100%', height: '100%', border: '0', display: 'block',
        pointerEvents: config.interactive ? 'auto' : 'none',
        // Lets a desktop-only page be shrunk to fit a narrow portrait column.
        transform: config.zoom ? `scale(${config.zoom})` : null,
        transformOrigin: 'top left',
      },
    });
    ctx.body.style.overflow = 'hidden';
    ctx.body.append(frame);

    const minutes = Number(config.refresh_minutes || 0);
    if (minutes > 0) ctx.interval(() => { frame.src = config.url; }, minutes * 60_000);
  },
};
