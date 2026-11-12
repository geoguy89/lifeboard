/* RSS headlines and QR codes.
 *
 * The QR widget's headline use is wifi access: a guest points a phone at the
 * TV and joins the network without anyone reading a password aloud. The
 * payload is built server-side and the SVG is generated there too, so the
 * wifi password never appears in the page source - only the finished QR.
 * That matters, because "view source on the kiosk" is otherwise a way to read
 * the password off a screen that is deliberately login-free.
 */

import { el } from '../app.js';

/** "28 minutes ago". Coarse on purpose - nobody reads seconds off a wall. */
function relativeAge(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 120) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export const rss = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    if (!config.source_id) {
      ctx.body.append(el('div', { style: { color: '#9aa0a8' } }, 'No feed selected'));
      return;
    }

    // 0 means every article the feed gave us. A list of forty is unreadable
    // on a wall, so the default stays small - but "all" has to be reachable,
    // and rotating through them one at a time is the way to actually read
    // forty headlines on a board.
    const configuredMax = Number(config.max_items);
    const maxItems = configuredMax === 0 ? Infinity : (configuredMax || 5);
    let items = [];
    let feedTitle = '';
    let cursor = 0;

    /* "WCSH RSS Feed: news · 28 minutes ago" — attribution plus age. The age
     * is the useful half: a headline with no timestamp on a wall display is
     * indistinguishable from a feed that stopped updating three days ago. */
    const byline = (item) => {
      const bits = [];
      // With feeds mixed together, each headline names ITS OWN outlet -
      // saying "3 feeds" against a specific article would be worse than
      // saying nothing. A single-feed widget still shows the feed name, and
      // an explicit override always wins.
      const source = config.source_label || item.feed_title || feedTitle;
      if (config.show_source !== false && source) bits.push(source);
      if (config.show_age !== false && item.published) bits.push(relativeAge(item.published));
      return bits.join(' · ');
    };

    /* One article: headline, attribution, body. Shared by both views so the
     * rotating one cannot drift into showing less than the list does - which
     * is exactly what had happened. */
    const article = (item, { titleSize, bodyLines }) => {
      const line = byline(item);
      return el('div', { style: { minWidth: '0' } },
        el('div', {
          style: {
            fontSize: `${titleSize}vmin`, lineHeight: '1.25',
            display: '-webkit-box', WebkitLineClamp: String(config.title_lines || 2),
            WebkitBoxOrient: 'vertical', overflow: 'hidden',
          },
        }, item.title),
        line
          ? el('div', {
              style: { fontSize: '1.15vmin', color: '#8b93a3', marginTop: '.15vmin' },
            }, line)
          : null,
        config.show_summary !== false && item.summary
          ? el('div', {
              style: {
                fontSize: '1.3vmin', color: '#9aa0a8', marginTop: '.35vmin',
                display: '-webkit-box', WebkitLineClamp: String(bodyLines),
                WebkitBoxOrient: 'vertical', overflow: 'hidden',
              },
            }, item.summary)
          : null);
    };

    const drawList = () => {
      const wrap = el('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '1vmin',
                 height: '100%', overflow: 'hidden' },
      });
      // When the list rotates it shows a WINDOW into the feed rather than
      // always the first few, so later articles are reachable at all.
      const start = config.rotate ? (cursor % Math.max(1, items.length)) : 0;
      const window_ = [];
      const shown = Math.min(maxItems, items.length);
      for (let i = 0; i < shown; i += 1) {
        window_.push(items[(start + i) % items.length]);
      }
      for (const item of window_) {
        wrap.append(article(item, {
          titleSize: Number(config.size || 1.8), bodyLines: config.summary_lines || 2,
        }));
      }
      ctx.body.replaceChildren(wrap);
    };

    /* "ticker" shows one headline at a time, rotating. On a narrow portrait
     * board this fits where a list of five would not. */
    const drawTicker = () => {
      const item = items[cursor % (items.length || 1)];
      if (!item) { ctx.body.replaceChildren(); return; }
      ctx.body.replaceChildren(el('div', {
        style: {
          height: '100%', display: 'flex', flexDirection: 'column',
          justifyContent: 'center', gap: '.2vmin', overflow: 'hidden',
        },
      }, article(item, {
        titleSize: Number(config.size || 2.2),
        bodyLines: config.summary_lines || 4,
      })));
    };

    const draw = config.style === 'ticker' ? drawTicker : drawList;

    /* WHICH FEEDS
     *
     * `source_ids` is the multi-feed field; `source_id` is what every board
     * built before it stored. Reading both means an existing widget keeps
     * working and gains the new field the moment anything is ticked, rather
     * than going blank on upgrade - the same contract the photos widget uses
     * for albums. */
    const feedIds = [
      ...(Array.isArray(config.source_ids) ? config.source_ids : []),
      ...(config.source_id != null && config.source_id !== '' ? [config.source_id] : []),
    ].map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const uniqueFeeds = [...new Set(feedIds)];

    const load = async () => {
      if (!uniqueFeeds.length) {
        ctx.body.replaceChildren(el('div', { style: { opacity: '.6' } },
          'No feed selected'));
        return;
      }
      try {
        // One slow or broken feed must not blank the others, so each is
        // settled independently and failures are counted, not thrown. Only a
        // total wipeout is worth showing the user an error for.
        const results = await Promise.allSettled(uniqueFeeds.map(async (id) => {
          const data = await ctx.getJSON(`/api/data/rss?source_id=${id}`);
          return { id, title: data.feed_title || '', items: data.items || [] };
        }));

        const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
        if (!ok.length) {
          const why = results[0]?.reason;
          throw new Error(why?.message || 'no feed could be read');
        }

        // Carry the feed's own name on every article, so a mixed widget can
        // say which outlet each headline came from - the point of mixing.
        const gathered = [];
        for (const feed of ok) {
          for (const item of feed.items) {
            gathered.push({ ...item, feed_title: item.feed_title || feed.title });
          }
        }

        // Interleave by date so a mixed widget reads as one newest-first
        // stream rather than one feed then the next. Undated entries keep
        // their arrival order at the end instead of jumping to 1970.
        gathered.sort((a, b) => {
          const at = a.published ? Date.parse(a.published) : NaN;
          const bt = b.published ? Date.parse(b.published) : NaN;
          if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
          if (Number.isNaN(at)) return 1;
          if (Number.isNaN(bt)) return -1;
          return bt - at;
        });

        items = gathered;
        // With several feeds there is no single feed name; label it by count
        // unless the user overrode it.
        feedTitle = config.source_label
          || (ok.length === 1 ? ok[0].title : `${ok.length} feeds`);
        cursor = 0;
        ctx.clearFail();
        draw();
      } catch (err) {
        ctx.fail(err, load);
      }
    };

    load();
    ctx.interval(load, Math.max(5, Number(config.refresh_minutes || 20)) * 60_000);

    // The ticker always rotates - one at a time is the whole idea. A list
    // rotates only if asked, because a list that reshuffles under you while
    // you are reading it is worse than a static one.
    if (config.style === 'ticker' || config.rotate) {
      ctx.interval(() => {
        // Advance HERE rather than inside draw, or an unrelated redraw would
        // skip an article.
        cursor += 1;
        draw();
      }, Math.max(4, Number(config.rotate_seconds || 12)) * 1000);
    }
  },
};

export const qr = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;

    const params = new URLSearchParams();
    if (config.mode === 'wifi') {
      params.set('mode', 'wifi');
      params.set('ssid', config.ssid || '');
      params.set('password', config.password || '');
      params.set('security', config.security || 'WPA');
      if (config.hidden) params.set('hidden', '1');
    } else {
      params.set('mode', 'text');
      params.set('text', config.text || config.url || '');
    }
    params.set('scale', String(config.scale || 8));

    const wrap = el('div', {
      style: {
        height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: '.8vmin',
      },
    });

    const img = el('img', {
      // src is set by load() below, which owns retrying.
      alt: 'QR code',
      style: {
        // QR codes must never be scaled smoothly - interpolation blurs the
        // module edges and phones stop reading them from across a room.
        imageRendering: 'pixelated',
        maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
        background: '#fff', borderRadius: '6px', padding: '1vmin',
        flex: '1 1 auto', minHeight: '0',
      },
    });
    wrap.append(img);

    // Whatever is typed in the caption box, and nothing else. The generated
    // "Wi-Fi: <ssid>" line is opt-in: a widget inventing text that cannot then
    // be removed is worse than one that shows none.
    const auto = config.show_ssid && config.mode === 'wifi' && config.ssid
      ? `Wi-Fi: ${config.ssid}`
      : '';
    const caption = (config.caption ?? '').trim() || auto;
    if (caption) {
      wrap.append(el('div', {
        style: { fontSize: '1.5vmin', color: '#9aa0a8', flex: '0 0 auto' },
      }, caption));
    }

    /* Retry rather than give up.
     *
     * A board runs for months and the renderer only rebuilds a widget when its
     * identity changes, so "failed once" would mean "broken until someone
     * notices". The cache-buster matters: without it the browser serves the
     * failed response back from its own cache and every retry fails
     * identically. */
    let attempt = 0;
    const load = () => {
      attempt += 1;
      img.src = `/api/qr?${params}${attempt > 1 ? `&_=${Date.now()}` : ''}`;
    };

    img.addEventListener('error', () => {
      // Quick at first - a server still starting is the usual cause and it
      // will be up in seconds - then settling to a slow beat.
      const delay = Math.min(60_000, 2_000 * attempt);
      ctx.fail(new Error(`QR not generated yet — retrying (attempt ${attempt})`));
      setTimeout(load, delay);
    });
    img.addEventListener('load', () => ctx.clearFail());

    load();
    ctx.body.append(wrap);
  },
};
