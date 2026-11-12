/* Generic data widgets: a value, a gauge, a chart.
 *
 * All three are fed by the REST/JSON source, so any HTTP endpoint becomes a
 * dashboard tile without new code. Charts are hand-drawn SVG rather than a
 * charting library: an appliance with a strict no-CDN policy cannot pull one
 * at runtime, and bundling one would mean a build step this project
 * deliberately does not have.
 */

import { el } from '../app.js';

const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, String(v));
  }
  return node;
}

/** Apply the widget's number formatting options to a raw value. */
function format(value, config) {
  if (value == null) return config.empty_text || '--';
  if (typeof value === 'boolean') return value ? (config.true_text || 'Yes')
                                               : (config.false_text || 'No');
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);

  let scaled = num * (Number(config.multiply) || 1) + (Number(config.offset) || 0);
  let suffix = '';

  // Big numbers on a wall need to be short, not precise.
  if (config.compact) {
    const abs = Math.abs(scaled);
    if (abs >= 1e9) { scaled /= 1e9; suffix = 'B'; }
    else if (abs >= 1e6) { scaled /= 1e6; suffix = 'M'; }
    else if (abs >= 1e3) { scaled /= 1e3; suffix = 'k'; }
  }
  const places = config.decimals == null
    ? (Math.abs(scaled) >= 100 || suffix ? (suffix ? 1 : 0) : 1)
    : Number(config.decimals);
  return scaled.toFixed(places).replace(/\.0+$/, '') + suffix;
}

/** Resolve a threshold colour, so a gauge can go red when it matters. */
function thresholdColour(value, config) {
  const rules = config.thresholds || [];
  let colour = config.colour || '#5b9dd9';
  for (const rule of rules) {
    if (value >= Number(rule.at)) colour = rule.colour;
  }
  return colour;
}

/* Shared loader. Every widget here reads from one source and one path, and
 * every one of them must keep its last good value visible when a fetch fails —
 * a dashboard tile that blanks on a transient 502 is worse than a stale one. */
function loader(ctx, onData) {
  const { config } = ctx;
  let lastGood = null;

  const load = async () => {
    // A widget reads EITHER a REST source or a pushed variable. Variables are
    // what a webhook writes, so a script pushing a number in is
    // indistinguishable, to the widget, from an API returning one.
    if (!config.source_id && !config.variable) {
      ctx.body.replaceChildren(el('div', { style: { color: '#9aa0a8' } },
        'No data source selected'));
      return;
    }
    try {
      const url = config.variable
        ? `/api/data/variable?name=${encodeURIComponent(config.variable)}`
        : `/api/data/rest?source_id=${config.source_id}`
          + (config.path ? `&path=${encodeURIComponent(config.path)}` : '');
      const data = await ctx.getJSON(url);
      if (data.error) throw new Error(data.error);
      lastGood = data;
      ctx.clearFail();
      onData(data, false);
    } catch (err) {
      ctx.fail(err, load);
      if (lastGood) onData(lastGood, true);   // keep showing it, marked stale
    }
  };

  load();
  ctx.interval(load, Math.max(5, Number(config.refresh_seconds || 60)) * 1000);
}

/* ------------------------------------------------------------------ value */

export const data = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    loader(ctx, (payload, stale) => {
      const value = payload.value;
      ctx.body.replaceChildren(el('div', {
        style: {
          height: '100%', display: 'flex', flexDirection: 'column',
          alignItems: config.align || 'center', justifyContent: 'center',
          opacity: stale ? '.55' : '1', minWidth: '0',
        },
      },
        el('div', {
          style: {
            display: 'flex', alignItems: 'baseline', gap: '.5vmin',
            fontSize: `${config.size || 4}vmin`, fontWeight: '300',
            color: thresholdColour(Number(value), config),
            whiteSpace: 'nowrap',
          },
        },
          config.prefix ? el('span', { style: { fontSize: '.5em' } }, config.prefix) : null,
          format(value, config),
          config.unit ? el('span', { style: { fontSize: '.45em', color: '#9aa0a8' } },
            config.unit) : null,
        ),
        config.label
          ? el('div', { style: { fontSize: '1.5vmin', color: '#9aa0a8' } }, config.label)
          : null,
      ));
    });
  },
};

/* ------------------------------------------------------------------ gauge */

export const gauge = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const min = Number(config.min ?? 0);
    const max = Number(config.max ?? 100);

    loader(ctx, (payload, stale) => {
      const raw = Number(payload.value);
      const value = Number.isNaN(raw) ? min : raw;
      const fraction = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
      const colour = thresholdColour(value, config);

      // 240-degree arc, the shape people read as a gauge. Drawn as a stroked
      // circle with dasharray rather than an arc path: far less trigonometry
      // to get wrong, and it animates for free.
      const R = 42;
      const CIRC = 2 * Math.PI * R;
      const SWEEP = 0.75;                    // 270 degrees of the circle used

      const box = svg('svg', { viewBox: '0 0 100 100', style: 'width:100%;height:100%' });
      const common = {
        cx: 50, cy: 50, r: R, fill: 'none', 'stroke-linecap': 'round',
        'stroke-width': config.thickness || 9,
        transform: 'rotate(135 50 50)',
      };
      box.append(svg('circle', {
        ...common, stroke: 'rgba(255,255,255,.10)',
        'stroke-dasharray': `${CIRC * SWEEP} ${CIRC}`,
      }));
      box.append(svg('circle', {
        ...common, stroke: colour,
        'stroke-dasharray': `${CIRC * SWEEP * fraction} ${CIRC}`,
        style: 'transition: stroke-dasharray .6s ease, stroke .6s ease',
      }));

      ctx.body.replaceChildren(el('div', {
        style: { position: 'relative', height: '100%', opacity: stale ? '.55' : '1' },
      },
        box,
        el('div', {
          style: {
            position: 'absolute', inset: '0', display: 'flex',
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          },
        },
          el('div', { style: { fontSize: `${config.size || 3.4}vmin`, fontWeight: '300' } },
            format(payload.value, config)),
          config.unit
            ? el('div', { style: { fontSize: '1.3vmin', color: '#9aa0a8' } }, config.unit)
            : null,
          config.label
            ? el('div', { style: { fontSize: '1.2vmin', color: '#8b93a3' } }, config.label)
            : null,
        ),
      ));
    });
  },
};

/* ------------------------------------------------------------------ chart */

/* Accepts either a flat array of numbers, or an array of objects with the
 * configured x/y keys. Both shapes are extremely common and requiring one
 * would mean half of all endpoints need a transform step. */
function series(rawValue, config) {
  if (!Array.isArray(rawValue)) return [];
  return rawValue.slice(-Number(config.max_points || 60)).map((item, index) => {
    if (typeof item === 'number') return { label: String(index), value: item };
    if (item && typeof item === 'object') {
      return {
        label: String(config.x_key ? item[config.x_key] ?? index : index),
        value: Number(config.y_key ? item[config.y_key] : Object.values(item)[0]),
      };
    }
    return { label: String(index), value: Number(item) };
  }).filter((p) => !Number.isNaN(p.value));
}

export const chart = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const kind = config.chart || 'line';

    loader(ctx, (payload, stale) => {
      const points = series(payload.value, config);
      if (!points.length) {
        ctx.body.replaceChildren(el('div', { style: { color: '#9aa0a8' } },
          'No numeric series at that path'));
        return;
      }

      const W = 100, H = 60, PAD = 4;
      const values = points.map((p) => p.value);
      const lo = config.min != null ? Number(config.min) : Math.min(...values);
      const hi = config.max != null ? Number(config.max) : Math.max(...values);
      const span = (hi - lo) || 1;
      const colour = config.colour || '#5b9dd9';

      const box = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none',
        style: 'width:100%;height:100%;overflow:visible',
      });

      const xAt = (i) => PAD + (i / Math.max(1, points.length - 1)) * (W - PAD * 2);
      const yAt = (v) => H - PAD - ((v - lo) / span) * (H - PAD * 2);

      if (kind === 'line' || kind === 'area') {
        const d = points.map((p, i) => `${i ? 'L' : 'M'}${xAt(i)},${yAt(p.value)}`).join(' ');
        if (kind === 'area') {
          box.append(svg('path', {
            d: `${d} L${xAt(points.length - 1)},${H - PAD} L${xAt(0)},${H - PAD} Z`,
            fill: colour, opacity: '.22',
          }));
        }
        box.append(svg('path', {
          d, fill: 'none', stroke: colour, 'stroke-width': config.thickness || 1.6,
          'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          'vector-effect': 'non-scaling-stroke',
        }));
      } else if (kind === 'bar') {
        const gap = 0.25;
        const barWidth = (W - PAD * 2) / points.length * (1 - gap);
        points.forEach((p, i) => {
          const y = yAt(p.value);
          box.append(svg('rect', {
            x: xAt(i) - barWidth / 2, y,
            width: barWidth, height: Math.max(0.5, H - PAD - y),
            fill: colour, rx: 0.8,
          }));
        });
      } else if (kind === 'pie') {
        const total = values.reduce((a, b) => a + b, 0) || 1;
        const PALETTE = ['#5b9dd9', '#7fb069', '#d9a06b', '#d98b8b', '#a98bd9',
                         '#6bd9c9', '#d9d06b', '#8b93a3'];
        let angle = -Math.PI / 2;
        const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - PAD;
        points.forEach((p, i) => {
          const sweep = (p.value / total) * Math.PI * 2;
          const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
          angle += sweep;
          const x2 = cx + r * Math.cos(angle), y2 = cy + r * Math.sin(angle);
          box.append(svg('path', {
            d: `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2},${y2} Z`,
            fill: PALETTE[i % PALETTE.length],
          }));
        });
      }

      const parts = [box];
      if (config.show_last !== false && kind !== 'pie') {
        parts.unshift(el('div', {
          style: {
            display: 'flex', alignItems: 'baseline', gap: '.5vmin',
            fontSize: '2.6vmin', fontWeight: '300', flex: '0 0 auto',
          },
        },
          format(values[values.length - 1], config),
          config.unit ? el('span', { style: { fontSize: '.5em', color: '#9aa0a8' } },
            config.unit) : null,
        ));
      }

      ctx.body.replaceChildren(el('div', {
        style: {
          height: '100%', display: 'flex', flexDirection: 'column', gap: '.5vmin',
          opacity: stale ? '.55' : '1', minHeight: '0',
        },
      }, ...parts));
    });
  },
};
