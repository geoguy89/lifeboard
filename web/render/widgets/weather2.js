/* Weather extras: hourly strip, air quality, severe alerts, sun and moon.
 *
 * Separate widgets rather than options on the main weather block, because on a
 * portrait board these want completely different shapes — an hourly strip is
 * wide and short, an alert is a full-width banner, and the moon is a small
 * square. Cramming them into one widget would make all four worse.
 */

import { el } from '../app.js';

/* One icon set, imported from the main weather widget. Duplicating it here
 * would mean two tables to keep in step, and the second one silently going
 * stale the first time a WMO code is added. */
import { icon } from './weather.js';

/* Shared loader: keep the last good payload on a failed fetch. */
function feed(ctx, url, onData, defaultMinutes) {
  const { config } = ctx;
  if (!config.source_id) {
    ctx.body.replaceChildren(el('div', { style: { color: '#9aa0a8' } },
      'No weather source selected'));
    return;
  }
  const load = async () => {
    try {
      const data = await ctx.getJSON(url());
      if (data.error) throw new Error(data.error);
      onData(data);
      ctx.clearFail();
    } catch (err) { ctx.fail(err, load); }
  };
  load();
  ctx.interval(load, Math.max(5, Number(config.refresh_minutes || defaultMinutes)) * 60_000);
}

/* ----------------------------------------------------------------- hourly */

export const weather_hourly = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const count = Number(config.hours || 12);

    feed(ctx, () =>
      `/api/data/weather/hourly?source_id=${config.source_id}&hours=${count}`,
    (data) => {
      const hours = (data.hours || []).slice(0, count);
      const strip = el('div', {
        style: {
          display: 'grid', gridTemplateColumns: `repeat(${hours.length || 1}, 1fr)`,
          gap: '.6vmin', height: '100%', alignContent: 'center',
        },
      });
      for (const hour of hours) {
        strip.append(el('div', {
          style: {
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: '.25vmin', minWidth: '0',
          },
        },
          el('div', { style: { fontSize: '1.2vmin', color: '#9aa0a8' } }, hour.hour),
          el('div', { style: { width: '2.8vmin', height: '2.8vmin' } }, icon(hour.icon, '100%', false)),
          el('div', { style: { fontSize: '1.6vmin' } },
            hour.temp == null ? '--' : `${hour.temp}°`),
          config.show_precip !== false && hour.precip_chance
            ? el('div', { style: { fontSize: '1.1vmin', color: '#6fa8dc' } },
                `${hour.precip_chance}%`)
            : null,
          config.show_wind && hour.wind != null
            ? el('div', { style: { fontSize: '1.05vmin', color: '#8b93a3' } },
                `${hour.wind}`)
            : null,
        ));
      }
      ctx.body.replaceChildren(strip);
    }, 30);
  },
};

/* ------------------------------------------------------------ air quality */

export const air_quality = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const scale = config.scale || 'us';

    feed(ctx, () => `/api/data/weather/air?source_id=${config.source_id}`, (data) => {
      const value = scale === 'eu' ? data.european_aqi : data.us_aqi;
      ctx.body.replaceChildren(el('div', {
        style: {
          height: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: '.3vmin',
        },
      },
        el('div', {
          style: {
            fontSize: `${config.size || 4.5}vmin`, fontWeight: '300',
            color: data.colour || '#9aa0a8', lineHeight: '1',
          },
        }, value == null ? '--' : value),
        el('div', { style: { fontSize: '1.4vmin', color: '#9aa0a8', textAlign: 'center' } },
          data.label || 'Air quality'),
        config.show_detail
          ? el('div', { style: { fontSize: '1.15vmin', color: '#8b93a3' } },
              `PM2.5 ${data.pm2_5 ?? '--'} · PM10 ${data.pm10 ?? '--'}`)
          : null,
      ));
    }, 30);
  },
};

/* ---------------------------------------------------------------- alerts */

export const weather_alerts = {
  panelled: false,
  mount(ctx) {
    const { config } = ctx;

    feed(ctx, () => `/api/data/weather/alerts?source_id=${config.source_id}`, (data) => {
      const alerts = (data.alerts || []).slice(0, Number(config.max_items || 2));

      // An empty alert widget should vanish, not sit there as a labelled empty
      // box - most days there is nothing, and a permanent "no alerts" panel
      // wastes the most valuable space on the board.
      if (!alerts.length) {
        ctx.el0.style.display = config.hide_when_clear === false ? '' : 'none';
        if (config.hide_when_clear === false) {
          ctx.body.replaceChildren(el('div', {
            style: { color: '#9aa0a8', fontSize: '1.5vmin', padding: '.5vmin' },
          }, data.region === 'unsupported'
            ? 'Alerts are US-only (National Weather Service)'
            : (config.clear_text || 'No active alerts')));
        }
        return;
      }
      ctx.el0.style.display = '';

      const wrap = el('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '.5vmin', height: '100%' },
      });
      for (const alert of alerts) {
        wrap.append(el('div', {
          style: {
            background: alert.colour, color: '#14100c', borderRadius: '8px',
            padding: '.7vmin 1vmin', display: 'flex', flexDirection: 'column',
            gap: '.15vmin', overflow: 'hidden',
          },
        },
          el('div', {
            style: {
              fontSize: `${config.size || 2}vmin`, fontWeight: '600',
              display: 'flex', gap: '.6vmin', alignItems: 'baseline',
            },
          },
            el('span', {}, '⚠'),
            el('span', {
              style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, alert.event),
          ),
          config.show_headline !== false && alert.headline
            ? el('div', {
                style: {
                  fontSize: '1.3vmin', opacity: '.85',
                  display: '-webkit-box', WebkitLineClamp: '2',
                  WebkitBoxOrient: 'vertical', overflow: 'hidden',
                },
              }, alert.headline)
            : null,
        ));
      }
      ctx.body.replaceChildren(wrap);
    }, 10);
  },
};

/* ------------------------------------------------------------- sun & moon */

export const sunmoon = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;

    feed(ctx, () => `/api/data/weather/sunmoon?source_id=${config.source_id}`, (data) => {
      const today = (data.days || [])[0] || {};
      const moon = data.moon || {};
      const time = (stamp) => {
        if (!stamp) return '--';
        try {
          return new Date(stamp).toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit', hour12: config.hour12 !== false,
          }).replace(':00', '');
        } catch { return '--'; }
      };

      const rows = [];
      if (config.show_sun !== false) {
        rows.push(el('div', {
          style: { display: 'flex', justifyContent: 'space-around', gap: '1vmin' },
        },
          el('div', { style: { textAlign: 'center' } },
            el('div', { style: { fontSize: '2vmin' } }, '↑'),
            el('div', { style: { fontSize: '1.7vmin' } }, time(today.sunrise)),
            el('div', { style: { fontSize: '1.1vmin', color: '#9aa0a8' } }, 'Sunrise')),
          el('div', { style: { textAlign: 'center' } },
            el('div', { style: { fontSize: '2vmin' } }, '↓'),
            el('div', { style: { fontSize: '1.7vmin' } }, time(today.sunset)),
            el('div', { style: { fontSize: '1.1vmin', color: '#9aa0a8' } }, 'Sunset')),
        ));
      }
      if (config.show_moon !== false) {
        rows.push(el('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: '1vmin', marginTop: rows.length ? '.8vmin' : '0',
          },
        },
          el('div', { style: { fontSize: '3.2vmin', lineHeight: '1' } }, moon.glyph || ''),
          el('div', {},
            el('div', { style: { fontSize: '1.5vmin' } }, moon.name || ''),
            el('div', { style: { fontSize: '1.15vmin', color: '#9aa0a8' } },
              `${moon.illumination ?? '--'}% lit`),
          ),
        ));
      }

      ctx.body.replaceChildren(el('div', {
        style: {
          height: '100%', display: 'flex', flexDirection: 'column',
          justifyContent: 'center',
        },
      }, ...rows));
    }, 60);
  },
};
