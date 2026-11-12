/* Current conditions and a forecast strip.
 *
 * Icons are inline SVG rather than an icon font or fetched images: an
 * appliance that has lost its internet connection should still render its
 * chrome correctly and show stale-but-labelled data, not a grid of broken
 * image boxes.
 */

import { el } from '../app.js';

/* Each icon is a small scene rather than a glyph: a sun with its own rays, a
 * cloud that can drift, drops that fall on their own schedule. The classes
 * below are what the stylesheet animates - an icon with no classes is simply
 * a still drawing, which is exactly what the reduced-motion path wants. */
export const ICONS = {
  clear:
    '<g class="lb-rays"><g stroke-width="4" stroke-linecap="round">'
    + '<path d="M32 4v8M32 52v8M4 32h8M52 32h8M12 12l6 6M46 46l6 6M52 12l-6 6M18 46l-6 6"/>'
    + '</g></g><circle class="lb-sun" cx="32" cy="32" r="13"/>',

  partly:
    '<g class="lb-rays-slow"><g stroke-width="3" stroke-linecap="round" opacity=".85">'
    + '<path d="M24 6v6M24 36v6M6 24h6M36 24h6M11 11l4 4M33 33l4 4M37 11l-4 4M15 33l-4 4"/>'
    + '</g></g><circle class="lb-sun" cx="24" cy="24" r="9"/>'
    + '<path class="lb-cloud" d="M22 46a11 11 0 0 1 2-21 15 15 0 0 1 28 5 9 9 0 0 1-2 17z"/>',

  cloudy:
    '<path class="lb-cloud-back" opacity=".45" '
    + 'd="M12 42a10 10 0 0 1 2-19 13 13 0 0 1 25 5 8 8 0 0 1-2 16z"/>'
    + '<path class="lb-cloud" d="M18 48a12 12 0 0 1 2-23 16 16 0 0 1 30 6 10 10 0 0 1-2 19z"/>',

  fog:
    '<path class="lb-cloud" d="M18 40a12 12 0 0 1 2-23 16 16 0 0 1 30 6 10 10 0 0 1-2 19z"/>'
    + '<g stroke-width="4" stroke-linecap="round">'
    + '<path class="lb-fog1" d="M12 50h40"/><path class="lb-fog2" d="M18 58h28"/></g>',

  drizzle:
    '<path class="lb-cloud" d="M18 40a12 12 0 0 1 2-23 16 16 0 0 1 30 6 10 10 0 0 1-2 19z"/>'
    + '<g stroke-width="4" stroke-linecap="round">'
    + '<path class="lb-drop lb-d1" d="M24 48v5"/><path class="lb-drop lb-d2" d="M36 48v7"/>'
    + '<path class="lb-drop lb-d3" d="M48 48v5"/></g>',

  rain:
    '<path class="lb-cloud" d="M18 38a12 12 0 0 1 2-23 16 16 0 0 1 30 6 10 10 0 0 1-2 19z"/>'
    + '<g stroke-width="4" stroke-linecap="round">'
    + '<path class="lb-drop lb-d1" d="M22 46l-3 10"/><path class="lb-drop lb-d2" d="M34 46l-3 12"/>'
    + '<path class="lb-drop lb-d3" d="M46 46l-3 10"/></g>',

  sleet:
    '<path class="lb-cloud" d="M18 38a12 12 0 0 1 2-23 16 16 0 0 1 30 6 10 10 0 0 1-2 19z"/>'
    + '<g stroke-width="4" stroke-linecap="round">'
    + '<path class="lb-drop lb-d1" d="M24 46l-2 8"/><path class="lb-drop lb-d3" d="M44 46l-2 8"/>'
    + '<g class="lb-flake lb-d2"><path d="M32 48v8M28 50l8 4M36 50l-8 4"/></g></g>',

  snow:
    '<path class="lb-cloud" d="M18 38a12 12 0 0 1 2-23 16 16 0 0 1 30 6 10 10 0 0 1-2 19z"/>'
    + '<g stroke-width="3.5" stroke-linecap="round">'
    + '<g class="lb-flake lb-d1"><path d="M22 46v9M18 49l8 3M26 49l-8 3"/></g>'
    + '<g class="lb-flake lb-d3"><path d="M42 46v9M38 49l8 3M46 49l-8 3"/></g></g>',

  storm:
    '<path class="lb-cloud" d="M18 38a12 12 0 0 1 2-23 16 16 0 0 1 30 6 10 10 0 0 1-2 19z"/>'
    + '<path class="lb-bolt" d="M34 42l-9 12h7l-3 10 11-14h-7z" stroke-width="3"/>',
};

/* One stylesheet for every icon on the board, added once.
 *
 * transform-box: fill-box is the part that is easy to miss - without it an
 * SVG child rotates about the origin of the whole viewport rather than its own
 * centre, and the sun's rays swing off the side of the card. */
const ICON_STYLE_ID = 'lb-weather-anim';

function ensureIconStyle() {
  if (document.getElementById(ICON_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = ICON_STYLE_ID;
  style.textContent = `
    .lb-anim [class^="lb-"], .lb-anim [class*=" lb-"] {
      transform-box: fill-box;
      transform-origin: center;
    }
    @keyframes lb-spin { to { transform: rotate(360deg); } }
    @keyframes lb-breathe {
      0%, 100% { transform: scale(1); }
      50%      { transform: scale(1.07); }
    }
    @keyframes lb-drift {
      0%, 100% { transform: translateX(0); }
      50%      { transform: translateX(2.5px); }
    }
    @keyframes lb-drift-back {
      0%, 100% { transform: translateX(0); }
      50%      { transform: translateX(-3.5px); }
    }
    @keyframes lb-fall {
      0%   { transform: translateY(-3px); opacity: 0; }
      15%  { opacity: 1; }
      75%  { opacity: 1; }
      100% { transform: translateY(7px); opacity: 0; }
    }
    @keyframes lb-flutter {
      0%   { transform: translateY(-3px) rotate(0deg);   opacity: 0; }
      20%  { opacity: 1; }
      80%  { opacity: 1; }
      100% { transform: translateY(7px) rotate(140deg);  opacity: 0; }
    }
    @keyframes lb-slide {
      0%, 100% { transform: translateX(-3px); opacity: .55; }
      50%      { transform: translateX(3px);  opacity: 1; }
    }
    /* Mostly dark, with two quick strikes - a bolt lit half the time reads as
       a rendering error rather than lightning. */
    @keyframes lb-flash {
      0%, 44%, 52%, 60%, 100% { opacity: .25; }
      48%, 56%                { opacity: 1; }
    }

    .lb-anim .lb-rays      { animation: lb-spin 38s linear infinite; }
    .lb-anim .lb-rays-slow { animation: lb-spin 55s linear infinite; }
    .lb-anim .lb-sun       { animation: lb-breathe 5s ease-in-out infinite; }
    .lb-anim .lb-cloud     { animation: lb-drift 7s ease-in-out infinite; }
    .lb-anim .lb-cloud-back{ animation: lb-drift-back 9s ease-in-out infinite; }
    .lb-anim .lb-fog1      { animation: lb-slide 6s ease-in-out infinite; }
    .lb-anim .lb-fog2      { animation: lb-slide 6s ease-in-out infinite reverse; }
    .lb-anim .lb-drop      { animation: lb-fall 1.5s linear infinite; }
    .lb-anim .lb-flake     { animation: lb-flutter 3.4s linear infinite; }
    .lb-anim .lb-bolt      { animation: lb-flash 3.6s ease-in-out infinite; }
    /* Staggered, or every drop falls in lockstep and it reads as a machine. */
    .lb-anim .lb-d1 { animation-delay: 0s; }
    .lb-anim .lb-d2 { animation-delay: .45s; }
    .lb-anim .lb-d3 { animation-delay: .9s; }

    /* Someone who has asked their system for less motion has asked for less
       motion here too. This is a screen that runs in a kitchen for months. */
    @media (prefers-reduced-motion: reduce) {
      .lb-anim * { animation: none !important; }
    }
  `;
  document.head.append(style);
}

export function icon(key, size = '100%', animate = true) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '3.5');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.style.width = size;
  svg.style.height = size;
  svg.style.overflow = 'visible';   // a drifting cloud must not be clipped
  svg.innerHTML = ICONS[key] || ICONS.cloudy;
  if (animate) {
    ensureIconStyle();
    svg.classList.add('lb-anim');
  }
  return svg;
}

export const weather = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    if (!config.source_id) {
      ctx.body.append(el('div', { style: { color: '#9aa0a8' } }, 'No weather source selected'));
      return;
    }

    const draw = (data) => {
      const cur = data.current || {};
      // Three states, not two: with the current block, without the forecast,
      // or forecast alone.
      const mode = config.layout || 'full';
      const showCurrent = mode !== 'forecast';
      const showForecast = mode !== 'compact';
      const down = config.forecast_layout === 'column';

      const now = el('div', {
        style: { display: 'flex', alignItems: 'center', gap: '1.5vmin', flex: '0 0 auto' },
      },
        el('div', { style: { width: '8vmin', height: '8vmin', flex: '0 0 auto' } },
          icon(cur.icon, '100%', config.animate !== false)),
        el('div', {},
          el('div', { style: { fontSize: '5vmin', fontWeight: '250', lineHeight: '1' } },
            cur.temp == null ? '--' : `${cur.temp}°`),
          el('div', { style: { fontSize: '1.6vmin', color: '#9aa0a8' } }, cur.label || ''),
          config.show_feels_like !== false && cur.feels_like != null
            ? el('div', { style: { fontSize: '1.4vmin', color: '#9aa0a8' } },
                `Feels ${cur.feels_like}°`)
            : null,
        ),
      );

      const rows = showCurrent ? [now] : [];

      if (showForecast && (data.daily || []).length) {
        const shown = Math.min(data.daily.length, Number(config.days || 5));
        const strip = el('div', {
          style: down
            ? {
                display: 'grid', gridTemplateRows: `repeat(${shown}, 1fr)`,
                gap: '0.4vmin', flex: '1 1 auto', minHeight: '0',
                marginTop: showCurrent ? '1.2vmin' : '0',
              }
            : {
                display: 'grid', gridTemplateColumns: `repeat(${shown}, 1fr)`,
                gap: '0.8vmin', flex: '1 1 auto', minHeight: '0',
                alignContent: 'start',
                marginTop: showCurrent ? '1.2vmin' : '0',
              },
        });
        // The forecast strip is deliberately still. Five animated icons in a
        // row is a lot of movement for information nobody is reading in the
        // moment; the current conditions are the thing worth drawing the eye.
        for (const day of data.daily.slice(0, Number(config.days || 5))) {
          strip.append(el('div', {
            style: down
              ? { display: 'flex', flexDirection: 'row', alignItems: 'center',
                  gap: '1vmin', justifyContent: 'space-between' }
              : { textAlign: 'center', display: 'flex', flexDirection: 'column',
                  alignItems: 'center', gap: '.3vmin' },
          },
            el('div', { style: { fontSize: '1.3vmin', color: '#9aa0a8' } }, day.weekday),
            el('div', { style: { width: '3.4vmin', height: '3.4vmin' } }, icon(day.icon, '100%', false)),
            el('div', { style: { fontSize: '1.5vmin' } },
              `${day.high == null ? '--' : day.high}°`),
            el('div', { style: { fontSize: '1.3vmin', color: '#9aa0a8' } },
              `${day.low == null ? '--' : day.low}°`),
            config.show_precip !== false && day.precip_chance != null && day.precip_chance > 0
              ? el('div', { style: { fontSize: '1.1vmin', color: '#6fa8dc' } },
                  `${day.precip_chance}%`)
              : null,
          ));
        }
        rows.push(strip);
      }

      ctx.body.replaceChildren(el('div', {
        style: { height: '100%', display: 'flex', flexDirection: 'column' },
      }, ...rows));
    };

    const load = async () => {
      try {
        draw(await ctx.getJSON(`/api/data/weather?source_id=${config.source_id}`));
        ctx.clearFail();
      } catch (err) {
        // Leave the previous forecast on screen; just mark it stale.
        ctx.fail(err, load);
      }
    };

    load();
    ctx.interval(load, Math.max(5, Number(config.refresh_minutes || 15)) * 60_000);
  },
};
