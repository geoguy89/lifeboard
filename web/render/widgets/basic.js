/* Clock, date, free text, countdown.
 *
 * Everything here formats through Intl with an explicit timeZone taken from
 * the board config, never the browser's locale. A kiosk that has not finished
 * NTP sync, or a Pi with no RTC, will otherwise render a confidently wrong
 * time in UTC and look completely normal doing it.
 */

import { el } from '../app.js';

function fit(node, { weight = 200, tracking = '-0.02em' } = {}) {
  // Sizing off the widget box rather than the viewport means a clock keeps its
  // proportions whether it is a corner accent or the whole screen.
  Object.assign(node.style, {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '100%', height: '100%', lineHeight: '1',
    fontWeight: String(weight), letterSpacing: tracking,
    whiteSpace: 'nowrap',
  });
}

/* Scale text to fill its box. ResizeObserver rather than a one-shot
 * measurement because the board re-lays-out on rotation, and a clock that was
 * sized for landscape looks absurd in portrait. */
function autoscale(ctx, node, { max = 40, min = 2 } = {}) {
  const resize = () => {
    const box = node.parentElement;
    if (!box || !box.clientWidth || !box.clientHeight) return;
    let lo = min, hi = max;
    for (let i = 0; i < 12; i++) {          // binary search, 12 passes is plenty
      const mid = (lo + hi) / 2;
      node.style.fontSize = `${mid}vmin`;
      const overflows = node.scrollWidth > box.clientWidth
                     || node.scrollHeight > box.clientHeight;
      if (overflows) hi = mid; else lo = mid;
    }
    node.style.fontSize = `${lo}vmin`;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(node.parentElement || node);
  resize();
  return () => observer.disconnect();
}

export const clock = {
  panelled: false,
  mount(ctx) {
    const { config, timezone } = ctx;
    const tz = config.timezone || timezone;
    const node = el('div');
    fit(node, { weight: config.weight || 200 });
    ctx.body.append(node);

    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      second: config.show_seconds ? '2-digit' : undefined,
      hour12: config.hour12 !== false,
    });

    const tick = () => {
      let text = fmt.format(new Date());
      // Intl always pads to "07:05 AM"; dropping the leading zero and the
      // meridiem is what makes it read like a clock rather than a timestamp.
      if (config.hour12 !== false && config.show_meridiem === false) {
        text = text.replace(/\s?[AP]M$/i, '');
      }
      if (config.pad_hour === false) text = text.replace(/^0/, '');
      node.textContent = text;
    };

    tick();
    // Tick every second when seconds are shown, otherwise every 10s - enough
    // to land on the minute promptly without waking the CPU 86,400 times a day.
    ctx.interval(tick, config.show_seconds ? 1000 : 10_000);
    return autoscale(ctx, node, { max: config.max_size || 40 });
  },
};

export const date = {
  panelled: false,
  mount(ctx) {
    const { config, timezone } = ctx;
    const node = el('div');
    fit(node, { weight: config.weight || 300, tracking: '0.01em' });
    ctx.body.append(node);

    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: config.timezone || timezone,
      weekday: config.weekday === false ? undefined : (config.short ? 'short' : 'long'),
      month: config.short ? 'short' : 'long',
      day: 'numeric',
      year: config.show_year ? 'numeric' : undefined,
    });

    const tick = () => { node.textContent = fmt.format(new Date()); };
    tick();
    ctx.interval(tick, 60_000);
    return autoscale(ctx, node, { max: config.max_size || 12 });
  },
};

/* Font stacks. Every one of these ends in a generic family, because an
 * appliance may not have the first choice installed and silently falling back
 * to the default sans is better than rendering boxes. `script` is what a photo
 * caption heading wants - the "Our Story" treatment on a family board. */
const FONTS = {
  sans: 'Inter, "Segoe UI", system-ui, sans-serif',
  serif: '"Playfair Display", Georgia, "Times New Roman", serif',
  script: '"Dancing Script", "Segoe Script", "Brush Script MT", cursive',
  mono: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  condensed: '"Roboto Condensed", "Arial Narrow", "Segoe UI", sans-serif',
};

export const text = {
  panelled: false,
  mount(ctx) {
    const { config } = ctx;
    const node = el('div', {
      style: {
        width: '100%', height: '100%',
        display: 'flex',
        alignItems: config.align_v || 'center',
        justifyContent: config.align || 'center',
        textAlign: config.align === 'flex-start' ? 'left'
                 : config.align === 'flex-end' ? 'right' : 'center',
        fontSize: `${config.size || 3}vmin`,
        fontWeight: String(config.weight || 300),
        fontFamily: FONTS[config.font] || FONTS.sans,
        fontStyle: config.italic ? 'italic' : 'normal',
        color: config.colour || 'inherit',
        whiteSpace: 'pre-wrap',
        lineHeight: '1.3',
        padding: '0.5vmin',
        textShadow: config.shadow ? '0 2px 12px rgba(0,0,0,.75)' : 'none',
      },
    }, config.text || '');
    ctx.body.append(node);
  },
};

export const countdown = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const target = config.target ? new Date(config.target) : null;
    const node = el('div');
    fit(node, { weight: 250 });
    ctx.body.append(node);

    if (!target || Number.isNaN(target.getTime())) {
      node.textContent = 'set a target date';
      return;
    }

    const tick = () => {
      const ms = target.getTime() - Date.now();
      if (ms <= 0) { node.textContent = config.done_text || 'Now'; return; }
      const days = Math.floor(ms / 86_400_000);
      const hours = Math.floor((ms % 86_400_000) / 3_600_000);
      const mins = Math.floor((ms % 3_600_000) / 60_000);
      node.textContent = days > 0 ? `${days}d ${hours}h`
                       : hours > 0 ? `${hours}h ${mins}m`
                       : `${mins}m`;
    };
    tick();
    ctx.interval(tick, 30_000);
    return autoscale(ctx, node, { max: config.max_size || 16 });
  },
};
