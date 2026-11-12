/* Tides and airport delays.
 *
 * Both are local facts rather than weather, and both come from free US
 * government APIs with no key. The tide block borrows the weather source's
 * coordinates instead of asking for a location again - and finds the nearest
 * NOAA station itself, because looking up a station id is exactly the setup
 * step that stops a block being used.
 */
import { el } from '../app.js';

/* ------------------------------------------------------------------ tides */

export const tides = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    if (!config.source_id) {
      ctx.body.replaceChildren(el('div', { style: { opacity: '.6' } },
        'Pick a weather source for the location'));
      return;
    }
    const size = Number(config.size || 1.7);

    const draw = (data) => {
      const all = data.events || [];
      if (!all.length) return;

      // Only what is still ahead: a wall display showing this morning's high
      // tide at teatime is worse than showing nothing.
      const now = Date.now();
      const upcoming = all.filter((e) => Date.parse(e.time) > now)
        .slice(0, Math.max(1, Number(config.count || 4)));
      const shown = upcoming.length ? upcoming : all.slice(-1);

      const rows = shown.map((e) => el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', gap: '.6vmin',
          justifyContent: 'space-between', marginBottom: '.25vmin',
        },
      },
        el('span', { style: { display: 'flex', gap: '.5vmin', alignItems: 'baseline', minWidth: '0' } },
          el('span', {
            style: {
              fontSize: `${size * 0.95}vmin`,
              color: e.kind === 'high' ? (config.high_colour || '#5b9dd9')
                                       : (config.low_colour || '#9aa0a8'),
              fontWeight: '600',
            },
          }, e.kind === 'high' ? '▲' : '▼'),
          el('span', { style: { fontSize: `${size}vmin` } },
            config.show_day !== false ? `${e.day} ${e.hour}` : e.hour)),
        el('span', { style: { fontSize: `${size * 0.9}vmin`, opacity: '.75' } },
          `${e.height} ${data.units}`),
      ));

      const head = config.show_station !== false && data.station_name
        ? el('div', {
            style: { fontSize: `${size * 0.7}vmin`, opacity: '.55', marginBottom: '.4vmin' },
          }, data.station_name)
        : null;

      ctx.body.replaceChildren(el('div', {
        style: {
          height: '100%', display: 'flex', flexDirection: 'column',
          justifyContent: 'center', overflow: 'hidden',
        },
      }, head, ...rows));
    };

    const load = async () => {
      try {
        const data = await ctx.getJSON(
          `/api/data/tides?source_id=${config.source_id}&days=${Number(config.days || 2)}`
          + (config.station ? `&station=${encodeURIComponent(config.station)}` : ''));
        if (data.error) throw new Error(data.error);
        draw(data);
        ctx.clearFail();
      } catch (err) {
        ctx.fail(err, load);
      }
    };
    load();
    ctx.interval(load, Math.max(30, Number(config.refresh_minutes || 180)) * 60_000);
  },
};

/* -------------------------------------------------------- airport delays */

export const airport_delays = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const size = Number(config.size || 1.6);

    const draw = (data) => {
      const delays = data.delays || [];
      const watched = data.watched || [];

      if (!delays.length) {
        // "The airports you asked about are fine" and "we have no data" are
        // different statements, and only one of them is reassuring.
        ctx.body.replaceChildren(el('div', {
          style: { opacity: '.6', fontSize: `${size}vmin`, textAlign: 'center' },
        }, watched.length
          ? (config.clear_text || `No delays at ${watched.join(', ')}`)
          : (config.clear_text || 'No delays reported')));
        return;
      }

      const rows = delays
        .slice(0, Math.max(1, Number(config.max_items || 5)))
        .map((d) => el('div', { style: { marginBottom: '.45vmin', minWidth: '0' } },
          el('div', { style: { display: 'flex', gap: '.6vmin', alignItems: 'baseline' } },
            el('span', {
              style: {
                fontSize: `${size}vmin`, fontWeight: '600',
                color: config.colour || '#d9a06b',
              },
            }, d.airport),
            el('span', { style: { fontSize: `${size * 0.85}vmin`, opacity: '.85' } }, d.type)),
          d.detail && config.show_detail !== false ? el('div', {
            style: {
              fontSize: `${size * 0.72}vmin`, opacity: '.6',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            },
          }, d.detail) : null,
        ));

      ctx.body.replaceChildren(el('div', {
        style: { height: '100%', overflow: 'hidden' },
      }, ...rows));
    };

    const load = async () => {
      try {
        const data = await ctx.getJSON(
          `/api/data/airports?codes=${encodeURIComponent(config.codes || '')}`);
        if (data.error) throw new Error(data.error);
        draw(data);
        ctx.clearFail();
      } catch (err) {
        ctx.fail(err, load);
      }
    };
    load();
    ctx.interval(load, Math.max(5, Number(config.refresh_minutes || 15)) * 60_000);
  },
};
