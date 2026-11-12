/* Home Assistant, beyond a value on a tile.
 *
 * A history sparkline, a camera frame, a now-playing card and a glance grid.
 * All four go through the source the entity tiles already use, so there is
 * nothing new to configure - which is the point: the connection exists, these
 * just ask it different questions.
 */
import { el } from '../app.js';

/* ------------------------------------------------------------- sparkline */

/* An SVG polyline, drawn from the downsampled series the server returns.
 *
 * The vertical scale is the DATA's range, not zero-based. A room thermometer
 * that moved between 20.1 and 21.4 degrees is a flat line against a zero
 * baseline and tells you nothing; against its own range you can see the
 * heating come on. The number is always shown too, so the shape being
 * relative can never be mistaken for an absolute reading.
 */
function sparkline(points, { width = 100, height = 30, fill = true }) {
  if (points.length < 2) return null;
  const values = points.map((p) => p.v);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // A dead-flat series would divide by zero; centre it instead.
  const span = hi - lo || 1;
  const step = width / (points.length - 1);
  const xy = points.map((p, i) => [
    i * step,
    height - ((p.v - lo) / span) * height,
  ]);

  const line = xy.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `0,${height} ${line} ${width},${height}`;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');

  if (fill) {
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', area);
    poly.setAttribute('fill', 'currentColor');
    poly.setAttribute('opacity', '.18');
    svg.append(poly);
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  path.setAttribute('points', line);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(path);
  return svg;
}

export const ha_history = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    if (!config.source_id || !config.entity) {
      ctx.body.replaceChildren(el('div', { style: { opacity: '.6' } },
        'Pick a Home Assistant source and an entity'));
      return;
    }
    const size = Number(config.size || 2.6);

    const draw = (data) => {
      const pts = data.points || [];
      if (!pts.length) {
        ctx.body.replaceChildren(el('div', { style: { opacity: '.6' } },
          'No numeric history yet'));
        return;
      }
      const unit = config.unit || '';
      const value = Number(data.last).toFixed(Number(config.decimals ?? 1));

      const head = el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', gap: '.6vmin',
          justifyContent: config.align === 'left' ? 'flex-start' : 'center',
        },
      },
        el('span', { style: { fontSize: `${size}vmin`, fontWeight: '500' } }, value),
        unit ? el('span', { style: { fontSize: `${size * 0.5}vmin`, opacity: '.7' } }, unit) : null,
      );

      const chart = el('div', {
        style: {
          flex: '1 1 auto', minHeight: '0', marginTop: '.5vmin',
          color: config.colour || 'var(--accent, #5b9dd9)',
        },
      }, sparkline(pts, { fill: config.fill !== false }));

      const foot = config.show_range === false ? null : el('div', {
        style: {
          display: 'flex', justifyContent: 'space-between',
          fontSize: `${size * 0.42}vmin`, opacity: '.55', marginTop: '.2vmin',
        },
      },
        el('span', {}, `${data.min}${unit}`),
        el('span', {}, `${data.hours}h`),
        el('span', {}, `${data.max}${unit}`),
      );

      ctx.body.replaceChildren(el('div', {
        style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: '0' },
      }, head, chart, foot));
    };

    const load = async () => {
      try {
        const data = await ctx.getJSON(
          `/api/data/ha/history?source_id=${config.source_id}`
          + `&entity=${encodeURIComponent(config.entity)}`
          + `&hours=${Number(config.hours || 24)}`
          + `&points=${Number(config.points || 60)}`);
        if (data.error) throw new Error(data.error);
        draw(data);
        ctx.clearFail();
      } catch (err) {
        ctx.fail(err, load);
      }
    };
    load();
    ctx.interval(load, Math.max(1, Number(config.refresh_minutes || 5)) * 60_000);
  },
};

/* ---------------------------------------------------------------- camera */

export const ha_camera = {
  panelled: false,
  mount(ctx) {
    const { config } = ctx;
    if (!config.source_id || !config.entity) {
      ctx.body.replaceChildren(el('div', { style: { opacity: '.6' } },
        'Pick a Home Assistant source and a camera'));
      return;
    }

    const img = el('img', {
      style: {
        width: '100%', height: '100%',
        objectFit: config.fit === 'contain' ? 'contain' : 'cover',
        display: 'block',
      },
    });
    const wrap = el('div', { style: { position: 'relative', height: '100%' } }, img);

    if (config.label) {
      wrap.append(el('div', {
        style: {
          position: 'absolute', left: '0', right: '0', bottom: '0',
          padding: '.6vmin .9vmin', fontSize: `${Number(config.size || 1.5)}vmin`,
          background: 'linear-gradient(transparent, rgba(0,0,0,.65))',
        },
      }, config.label));
    }

    // A cache-busting stamp is not optional: without it the browser serves
    // the same frame forever and the camera looks frozen, which is the most
    // alarming possible failure for a camera block.
    const refresh = () => {
      img.src = `/api/data/ha/camera?source_id=${config.source_id}`
        + `&entity=${encodeURIComponent(config.entity)}&_=${Date.now()}`;
    };
    // A broken-image icon reads as "the board is broken". Say what actually
    // happened instead - most often a stream-only camera that cannot produce
    // a still, which no amount of retrying will fix.
    img.addEventListener('error', () => {
      wrap.replaceChildren(el('div', {
        style: {
          height: '100%', display: 'flex', alignItems: 'center',
          justifyContent: 'center', textAlign: 'center', padding: '1vmin',
          fontSize: '1.4vmin', opacity: '.6',
        },
      }, `No still image from ${config.entity}`));
    });

    refresh();
    ctx.body.replaceChildren(wrap);
    ctx.interval(refresh, Math.max(2, Number(config.refresh_seconds || 10)) * 1000);
  },
};

/* --------------------------------------------------------- now playing */

export const ha_media = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const ids = String(config.entities || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (!config.source_id || !ids.length) {
      ctx.body.replaceChildren(el('div', { style: { opacity: '.6' } },
        'Pick a Home Assistant source and a media player'));
      return;
    }
    const size = Number(config.size || 1.8);

    const draw = (data) => {
      const players = (data.players || [])
        .filter((p) => (config.hide_idle !== false ? !p.idle : true));

      if (!players.length) {
        ctx.body.replaceChildren(el('div', {
          style: { opacity: '.5', fontSize: `${size}vmin`, textAlign: 'center' },
        }, config.idle_text || 'Nothing playing'));
        return;
      }

      const rows = players.map((p) => {
        const bits = [p.media_artist, p.media_album_name].filter(Boolean);
        return el('div', {
          style: {
            display: 'flex', gap: '.9vmin', alignItems: 'center',
            minWidth: '0', marginBottom: '.5vmin',
          },
        },
          config.show_art !== false && p.art
            ? el('img', {
                src: p.art,
                style: {
                  width: `${size * 3.4}vmin`, height: `${size * 3.4}vmin`,
                  borderRadius: '6px', objectFit: 'cover', flex: '0 0 auto',
                },
              })
            : null,
          el('div', { style: { minWidth: '0', flex: '1 1 auto' } },
            el('div', {
              style: {
                fontSize: `${size}vmin`, fontWeight: '500',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              },
            }, p.media_title || p.name),
            bits.length ? el('div', {
              style: {
                fontSize: `${size * 0.75}vmin`, opacity: '.65',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              },
            }, bits.join(' · ')) : null,
            config.show_source && p.app_name ? el('div', {
              style: { fontSize: `${size * 0.62}vmin`, opacity: '.45' },
            }, p.app_name) : null,
          ),
        );
      });

      ctx.body.replaceChildren(el('div', {
        style: { height: '100%', overflow: 'hidden' },
      }, ...rows));
    };

    const load = async () => {
      try {
        const data = await ctx.getJSON(
          `/api/data/ha/media?source_id=${config.source_id}`
          + `&entities=${encodeURIComponent(ids.join(','))}`);
        if (data.error) throw new Error(data.error);
        draw(data);
        ctx.clearFail();
      } catch (err) {
        ctx.fail(err, load);
      }
    };
    load();
    // Seconds, not minutes: a track change shown a minute late is the one
    // case where staleness is obvious to anyone standing in the room.
    ctx.interval(load, Math.max(5, Number(config.refresh_seconds || 15)) * 1000);
  },
};

/* ----------------------------------------------------------- glance grid */

/* Many entities, small, in a grid - HA's own "glance" card. The entity tile
 * is one big number; this is for the dozen things you want visible at once
 * without a dozen blocks to place and keep aligned. */
export const ha_glance = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const ids = String(config.entities || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (!config.source_id || !ids.length) {
      ctx.body.replaceChildren(el('div', { style: { opacity: '.6' } },
        'Pick a Home Assistant source and some entities'));
      return;
    }
    const size = Number(config.size || 1.6);
    const columns = Math.max(1, Number(config.columns || 3));

    const draw = (data) => {
      const cells = (data.entities || []).map((e) => el('div', {
        style: {
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: '.15vmin', minWidth: '0', padding: '.3vmin',
        },
      },
        config.show_names !== false ? el('div', {
          style: {
            fontSize: `${size * 0.62}vmin`, opacity: '.6',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            maxWidth: '100%',
          },
        }, e.name) : null,
        el('div', { style: { fontSize: `${size}vmin`, fontWeight: '500' } },
          `${e.state}${e.unit ? ` ${e.unit}` : ''}`),
      ));

      ctx.body.replaceChildren(el('div', {
        style: {
          height: '100%', display: 'grid',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          alignContent: 'center', gap: '.4vmin', overflow: 'hidden',
        },
      }, ...cells));
    };

    const load = async () => {
      try {
        const data = await ctx.getJSON(
          `/api/data/ha/states?source_id=${config.source_id}`
          + `&entities=${encodeURIComponent(ids.join(','))}`);
        if (data.error) throw new Error(data.error);
        draw(data);
        ctx.clearFail();
      } catch (err) {
        ctx.fail(err, load);
      }
    };
    load();
    ctx.interval(load, Math.max(5, Number(config.refresh_seconds || 30)) * 1000);
  },
};
