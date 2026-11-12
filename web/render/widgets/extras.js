/* Buttons, shapes, markdown, task lists, finance.
 *
 * The first three are layout furniture — the things that turn a grid of data
 * tiles into something that looks designed. The last two are real data
 * widgets that happen to be small.
 */

import { el } from '../app.js';

/* ----------------------------------------------------------------- shape */

/* Rectangles, ovals and lines. Unglamorous, and the thing that makes a board
 * look composed rather than assembled: a translucent bar behind a row of text
 * over a photo does more for legibility than any amount of font tuning. */
/* CLIPPED SHAPES.
 *
 * clip-path with a polygon is Chrome 55, which is older than anything this
 * board runs on, and it costs nothing at render time. The trade is that a clip
 * cuts the border off with everything else outside the path - so these are
 * FILLED shapes, and a shape that wants an outline uses `frame` or takes its
 * definition here with the outline drawn as part of the fill.
 */
const CLIPS = {
  diamond: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
  triangle: 'polygon(50% 0%, 100% 100%, 0% 100%)',
  triangle_down: 'polygon(0% 0%, 100% 0%, 50% 100%)',
  hexagon: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
  chevron: 'polygon(0% 0%, 75% 0%, 100% 50%, 75% 100%, 0% 100%, 25% 50%)',
  star: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, '
      + '21% 91%, 32% 57%, 2% 35%, 39% 35%)',
  burst: 'polygon(50% 0%, 60% 20%, 80% 10%, 78% 32%, 100% 35%, 84% 50%, '
       + '100% 65%, 78% 68%, 80% 90%, 60% 80%, 50% 100%, 40% 80%, 20% 90%, '
       + '22% 68%, 0% 65%, 16% 50%, 0% 35%, 22% 32%, 20% 10%, 40% 20%)',
};

/* A LINE IS NOT A THIN RECTANGLE.
 *
 * It was, and that is why it disappeared: the old version centred itself with
 * `inset: calc(50% - 1px) 0`, which an engine without `inset` support had to
 * have expanded for it - and the expansion split the calc() into rubbish. A
 * flex box centring a child needs no arithmetic in a string, works on every
 * engine, and makes the thickness a real setting rather than a hard-coded 1px
 * hidden inside two calls to calc.
 */
function buildLine(config, fill, stroke) {
  const vertical = config.orientation === 'vertical';
  const thickness = Math.max(1, Number(config.thickness) || 2);
  const colour = stroke || fill;
  const style = config.line_style || 'solid';

  const line = {
    // Not `inset`: this is the widget that proved that shorthand is a trap on
    // the engines the board has to run on.
    flex: '0 0 auto',
    borderRadius: `${thickness}px`,
  };
  if (vertical) Object.assign(line, { width: `${thickness}px`, height: '100%' });
  else Object.assign(line, { height: `${thickness}px`, width: '100%' });

  if (style === 'solid') {
    line.background = colour;
  } else if (style === 'fade') {
    // Fades out at both ends, so a divider stops without stopping abruptly.
    line.background = `linear-gradient(${vertical ? 'to bottom' : 'to right'}, `
      + `transparent, ${colour}, transparent)`;
    line.borderRadius = '0';
  } else if (style === 'dashed' || style === 'dotted') {
    /* Gradients rather than a dashed border.
     *
     * A border-style dash is drawn by the engine and its dash length is not
     * settable, which at 6px thick looks like a row of bricks. A repeating
     * gradient gives a dash proportional to the thickness, so it still reads
     * as the same line when scaled up on a wall.
     */
    const on = style === 'dotted' ? thickness : thickness * 3;
    const off = style === 'dotted' ? thickness * 2 : thickness * 2.5;
    line.background = `repeating-linear-gradient(`
      + `${vertical ? 'to bottom' : 'to right'}, `
      + `${colour} 0, ${colour} ${on}px, `
      + `transparent ${on}px, transparent ${on + off}px)`;
    if (style === 'dotted') line.borderRadius = '0';
  } else if (style === 'double') {
    const gap = Math.max(2, thickness);
    line.background = 'transparent';
    line.borderRadius = '0';
    if (vertical) {
      Object.assign(line, {
        width: `${thickness * 2 + gap}px`,
        borderLeft: `${thickness}px solid ${colour}`,
        borderRight: `${thickness}px solid ${colour}`,
      });
    } else {
      Object.assign(line, {
        height: `${thickness * 2 + gap}px`,
        borderTop: `${thickness}px solid ${colour}`,
        borderBottom: `${thickness}px solid ${colour}`,
      });
    }
  }

  const kids = [el('div', { style: line })];

  /* An ornament in the middle, for a heading rule.
   *
   * Two half-lines with a mark between them, rather than one line with
   * something sitting on top: overlaying leaves the line visible through a
   * translucent mark, and at a distance that reads as a smudge.
   */
  if (config.ornament && config.ornament !== 'none') {
    const half = { ...line };
    if (vertical) half.height = '100%';
    else half.width = '100%';

    const mark = config.ornament === 'diamond'
      ? el('div', {
          style: {
            width: `${thickness * 4}px`, height: `${thickness * 4}px`,
            background: colour, transform: 'rotate(45deg)', flex: '0 0 auto',
          },
        })
      : config.ornament === 'dot'
        ? el('div', {
            style: {
              width: `${thickness * 3}px`, height: `${thickness * 3}px`,
              background: colour, borderRadius: '50%', flex: '0 0 auto',
            },
          })
        : el('div', {
            style: {
              color: colour, flex: '0 0 auto', lineHeight: '1',
              fontSize: `${Math.max(10, thickness * 5)}px`,
            },
          }, config.ornament_text || '\u2766');

    kids.length = 0;
    kids.push(el('div', { style: half }), mark, el('div', { style: half }));
  }

  return el('div', {
    style: {
      position: 'absolute', top: '0', right: '0', bottom: '0', left: '0',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: vertical ? 'column' : 'row',
      gap: config.ornament && config.ornament !== 'none'
        ? `${thickness * 3}px` : '0',
      overflow: 'hidden',
    },
  }, ...kids);
}

export const shape = {
  panelled: false,
  mount(ctx) {
    const { config } = ctx;
    const kind = config.shape || 'rect';
    const fill = config.fill || 'rgba(255,255,255,.08)';
    const stroke = config.border_colour || 'rgba(255,255,255,.25)';
    const opacity = String(config.opacity ?? 1);

    if (kind === 'line') {
      const node = buildLine(config, fill, stroke);
      node.style.opacity = opacity;
      ctx.body.append(node);
      return;
    }

    /* Longhands, not `inset`.
     *
     * Same reason as the line: on an engine without the shorthand this has to
     * be expanded, and an expansion is one more thing to get wrong. Four
     * properties are not worth a bug on a screen nobody can debug.
     */
    const style = {
      position: 'absolute', top: '0', right: '0', bottom: '0', left: '0',
      background: fill,
      border: config.border_width
        ? `${config.border_width}px solid ${stroke}`
        : 'none',
      opacity,
    };

    if (kind === 'oval') {
      style.borderRadius = '50%';
    } else if (kind === 'rect') {
      style.borderRadius = `${config.radius ?? 8}px`;
    } else if (kind === 'frame') {
      // Outline only: the shape IS the border, so it always has one.
      style.background = 'transparent';
      style.border = `${Math.max(1, Number(config.border_width) || 2)}px `
        + `solid ${stroke}`;
      style.borderRadius = `${config.radius ?? 8}px`;
    } else if (kind === 'brackets') {
      /* Corner brackets - a frame with its middles missing.
       *
       * Four children rather than one bordered box, because the gap between
       * the corners is the whole point and no border can leave a gap.
       */
      style.background = 'transparent';
      style.border = 'none';
      const weight = Math.max(1, Number(config.border_width) || 2);
      const arm = `${Math.min(45, Math.max(5, Number(config.corner_size) || 18))}%`;
      const corner = (v, h) => el('div', {
        style: {
          position: 'absolute', width: arm, height: arm,
          [v === 'top' ? 'top' : 'bottom']: '0',
          [h === 'left' ? 'left' : 'right']: '0',
          [v === 'top' ? 'borderTop' : 'borderBottom']: `${weight}px solid ${stroke}`,
          [h === 'left' ? 'borderLeft' : 'borderRight']: `${weight}px solid ${stroke}`,
          borderRadius: `${config.radius ?? 0}px`,
        },
      });
      ctx.body.append(el('div', { style },
        corner('top', 'left'), corner('top', 'right'),
        corner('bottom', 'left'), corner('bottom', 'right')));
      return;
    } else if (CLIPS[kind]) {
      style.clipPath = CLIPS[kind];
      // WebKit-prefixed as well: some TV WebViews are old enough to want it,
      // and an unrecognised property is ignored rather than harmful.
      style.WebkitClipPath = CLIPS[kind];
      // A clip cuts the border off with everything else outside the path.
      style.border = 'none';
    }

    ctx.body.append(el('div', { style }));
  },
};

/* ---------------------------------------------------------------- button */

/* Touch targets. A button either opens a URL or switches the board to another
 * layout — the second is how a touch display gets multiple pages without a
 * navigation concept baked into the renderer. */
export const button = {
  panelled: false,
  mount(ctx) {
    const { config } = ctx;
    const node = el('div', {
      style: {
        position: 'absolute', inset: '0',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: '1vmin', cursor: 'pointer',
        background: config.background || 'rgba(255,255,255,.10)',
        border: `1px solid ${config.border_colour || 'rgba(255,255,255,.18)'}`,
        borderRadius: `${config.radius ?? 12}px`,
        fontSize: `${config.size || 2.2}vmin`,
        color: config.colour || 'inherit',
        // The board sets `cursor:none` globally; a touch target should still
        // give feedback, so it gets its own press state instead.
        transition: 'transform .12s ease, background .12s ease',
        userSelect: 'none',
      },
    },
      config.icon ? el('span', { style: { fontSize: '1.4em' } }, config.icon) : null,
      config.label || '',
    );

    const press = () => {
      node.style.transform = 'scale(.97)';
      node.style.background = config.active_background || 'rgba(255,255,255,.18)';
    };
    const release = () => {
      node.style.transform = 'none';
      node.style.background = config.background || 'rgba(255,255,255,.10)';
    };
    node.addEventListener('pointerdown', press);
    node.addEventListener('pointerup', release);
    node.addEventListener('pointercancel', release);
    node.addEventListener('pointerleave', release);

    node.addEventListener('click', async () => {
      const action = config.action || 'url';
      if (action === 'url' && config.url) {
        if (config.new_tab) window.open(config.url, '_blank');
        else location.href = config.url;
      } else if (action === 'layout' && config.target_layout_id) {
        // Ask the server to switch the screen; the renderer picks the change
        // up on its next poll, so there is one source of truth for what is on
        // screen rather than the page holding local override state.
        try {
          await fetch('/api/board/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              screen_id: Number(new URLSearchParams(location.search).get('screen') || 1),
              layout_id: Number(config.target_layout_id),
            }),
          });
        } catch (err) { ctx.fail(err); }
      } else if (action === 'reload') {
        location.reload();
      }
    });

    ctx.body.append(node);
  },
};

/* -------------------------------------------------------------- markdown */

/* A very small Markdown subset, rendered without a library.
 *
 * Deliberately limited to headings, bold, italic, links, lists, code and
 * rules — and it builds DOM nodes rather than assigning innerHTML, so a feed
 * or an API response rendered through it cannot inject markup. That matters
 * because the same renderer is used for text pulled from external sources. */
function renderMarkdown(text) {
  const root = el('div', {});
  let list = null;

  const inline = (line, parent) => {
    // One pass, alternating between plain runs and the first construct found.
    const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/;
    let rest = line;
    while (rest) {
      const match = pattern.exec(rest);
      if (!match) { parent.append(document.createTextNode(rest)); break; }
      if (match.index) parent.append(document.createTextNode(rest.slice(0, match.index)));
      const token = match[0];
      if (token.startsWith('**')) {
        parent.append(el('strong', {}, token.slice(2, -2)));
      } else if (token.startsWith('`')) {
        parent.append(el('code', {
          style: { background: 'rgba(255,255,255,.10)', padding: '0 .3em', borderRadius: '3px' },
        }, token.slice(1, -1)));
      } else if (token.startsWith('[')) {
        const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(token);
        // Only http(s) — a javascript: URL in a feed must not become clickable.
        const safe = /^https?:\/\//i.test(href) ? href : '#';
        parent.append(el('a', { href: safe, style: { color: '#7fb0e0' } }, label));
      } else {
        parent.append(el('em', {}, token.slice(1, -1)));
      }
      rest = rest.slice(match.index + token.length);
    }
  };

  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) { list = el('ul', { style: { margin: '.2em 0', paddingLeft: '1.2em' } }); root.append(list); }
      const li = el('li', {});
      inline(bullet[1], li);
      list.append(li);
      continue;
    }
    list = null;

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const node = el(`h${heading[1].length}`, {
        style: { margin: '.3em 0 .2em', fontWeight: '500' },
      });
      inline(heading[2], node);
      root.append(node);
    } else if (/^\s*---+\s*$/.test(line)) {
      root.append(el('hr', {
        style: { border: 'none', borderTop: '1px solid rgba(255,255,255,.15)', margin: '.5em 0' },
      }));
    } else if (!line.trim()) {
      root.append(el('div', { style: { height: '.5em' } }));
    } else {
      const p = el('div', { style: { margin: '.15em 0' } });
      inline(line, p);
      root.append(p);
    }
  }
  return root;
}

export const markdown = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const render = (text) => {
      ctx.body.replaceChildren(el('div', {
        style: {
          height: '100%', overflow: 'hidden',
          fontSize: `${config.size || 1.9}vmin`, lineHeight: '1.4',
          color: config.colour || 'inherit',
        },
      }, renderMarkdown(text)));
    };

    // Either static text, or text pulled from a data source.
    if (config.source_id) {
      const load = async () => {
        try {
          const query = config.path ? `&path=${encodeURIComponent(config.path)}` : '';
          const data = await ctx.getJSON(`/api/data/rest?source_id=${config.source_id}${query}`);
          render(typeof data.value === 'string' ? data.value : JSON.stringify(data.value, null, 2));
          ctx.clearFail();
        } catch (err) { ctx.fail(err, load); }
      };
      load();
      ctx.interval(load, Math.max(10, Number(config.refresh_seconds || 300)) * 1000);
    } else {
      render(config.text || '');
    }
  },
};

/* ------------------------------------------------------------------ todo */

export const todo = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const listId = config.list_id;

    const draw = (items) => {
      const wrap = el('div', {
        style: { height: '100%', overflow: 'hidden', display: 'flex',
                 flexDirection: 'column', gap: '.6vmin' },
      });

      const shown = config.hide_done
        ? items.filter((i) => !i.done)
        : items.slice().sort((a, b) => Number(a.done) - Number(b.done));

      if (!shown.length) {
        wrap.append(el('div', { style: { color: '#9aa0a8', fontSize: '1.7vmin' } },
          config.empty_text || 'Nothing to do'));
      }

      for (const item of shown.slice(0, Number(config.max_items || 12))) {
        const box = el('div', {
          style: {
            width: '2vmin', height: '2vmin', flex: '0 0 auto', borderRadius: '4px',
            border: '1px solid rgba(255,255,255,.35)',
            background: item.done ? '#7fb069' : 'transparent',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.4vmin', color: '#0d0d10',
            cursor: config.interactive !== false ? 'pointer' : 'default',
          },
        }, item.done ? '✓' : '');

        const row = el('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '1vmin', minWidth: '0',
            opacity: item.done ? '.5' : '1',
          },
        },
          box,
          el('div', {
            style: {
              fontSize: `${config.size || 1.9}vmin`, flex: '1 1 auto',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              textDecoration: item.done ? 'line-through' : 'none',
            },
          }, item.text),
          item.due
            ? el('div', { style: { fontSize: '1.3vmin', color: '#9aa0a8', flex: '0 0 auto' } },
                item.due)
            : null,
        );

        // Touch-to-complete. Optimistic: flip it locally straight away, because
        // a wall display that takes a round trip to respond feels broken even
        // when it is working.
        if (config.interactive !== false) {
          box.addEventListener('click', async () => {
            const next = !item.done;
            item.done = next;
            box.style.background = next ? '#7fb069' : 'transparent';
            box.textContent = next ? '✓' : '';
            row.style.opacity = next ? '.5' : '1';
            try {
              await fetch(`/api/todo/items/${item.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ done: next }),
              });
            } catch (err) {
              item.done = !next;      // put it back if the write failed
              ctx.fail(err);
            }
          });
        }
        wrap.append(row);
      }
      ctx.body.replaceChildren(wrap);
    };

    const load = async () => {
      if (!listId) {
        ctx.body.replaceChildren(el('div', { style: { color: '#9aa0a8' } },
          'No list selected'));
        return;
      }
      try {
        const data = await ctx.getJSON(`/api/todo/lists/${listId}`);
        draw(data.items || []);
        ctx.clearFail();
      } catch (err) { ctx.fail(err, load); }
    };

    load();
    ctx.interval(load, Math.max(10, Number(config.refresh_seconds || 30)) * 1000);
  },
};

/* --------------------------------------------------------------- finance */

export const finance = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const kind = config.market || 'stocks';

    const draw = (quotes) => {
      const wrap = el('div', {
        style: { height: '100%', display: 'flex', flexDirection: 'column',
                 gap: '.6vmin', overflow: 'hidden' },
      });
      for (const q of quotes) {
        const up = (q.percent ?? 0) >= 0;
        wrap.append(el('div', {
          style: { display: 'flex', alignItems: 'baseline', gap: '.8vmin', minWidth: '0' },
        },
          el('div', {
            style: { fontSize: '1.7vmin', flex: '0 0 auto', minWidth: '6ch',
                     textTransform: kind === 'crypto' ? 'capitalize' : 'uppercase' },
          }, q.symbol),
          el('div', {
            style: { fontSize: `${config.size || 2.1}vmin`, flex: '1 1 auto',
                     textAlign: 'right' },
          }, q.ok === false ? '--' : formatPrice(q.price, kind, config)),
          q.percent != null
            ? el('div', {
                style: {
                  fontSize: '1.5vmin', flex: '0 0 auto', minWidth: '7ch',
                  textAlign: 'right', color: up ? '#7fb069' : '#d98b8b',
                },
              }, `${up ? '+' : ''}${q.percent}%`)
            : null,
        ));
      }
      ctx.body.replaceChildren(wrap);
    };

    const load = async () => {
      try {
        const params = new URLSearchParams({ market: kind });
        if (kind === 'currency') {
          params.set('base', config.base || 'USD');
          params.set('symbols', config.symbols || 'EUR,GBP,CAD');
        } else {
          params.set('symbols', config.symbols || (kind === 'crypto' ? 'bitcoin,ethereum' : 'AAPL,MSFT'));
          if (kind === 'crypto') params.set('vs', (config.base || 'usd').toLowerCase());
        }
        const data = await ctx.getJSON(`/api/data/finance?${params}`);
        if (data.error) throw new Error(data.error);
        draw(data.quotes || []);
        ctx.clearFail();
      } catch (err) { ctx.fail(err, load); }
    };

    load();
    ctx.interval(load, Math.max(60, Number(config.refresh_seconds || 900)) * 1000);
  },
};

function formatPrice(value, kind, config) {
  if (value == null) return '--';
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  // Crypto spans nine orders of magnitude between BTC and a memecoin, so fixed
  // decimals are wrong for one end or the other.
  const places = config.decimals != null ? Number(config.decimals)
    : kind === 'currency' ? 4
    : num >= 1000 ? 0 : num >= 1 ? 2 : 6;
  const text = num.toLocaleString(undefined, {
    minimumFractionDigits: places, maximumFractionDigits: places,
  });
  return (config.symbol_prefix ?? (kind === 'stocks' ? '$' : '')) + text;
}

/* ------------------------------------------------------------------- html */

/* Arbitrary HTML/CSS/JS, for the long tail nothing else covers.
 *
 * SANDBOXING — the important part.
 *
 * The markup goes into an iframe with `sandbox="allow-scripts"` and
 * deliberately WITHOUT `allow-same-origin`. That combination gives the frame a
 * unique opaque origin, which means the code inside it:
 *
 *   - cannot reach `parent` or touch the board's DOM,
 *   - cannot read cookies or localStorage, so it cannot steal the session,
 *   - cannot call the LifeBoard API with the admin's credentials.
 *
 * Granting `allow-same-origin` alongside `allow-scripts` would undo all three
 * at once and is the single mistake worth naming here, because it looks like
 * a convenience and is actually a full escape.
 *
 * The trade is that the snippet cannot read LifeBoard's own data directly. It
 * gets it pushed in instead: if a data source is configured, its value is
 * posted into the frame with postMessage, and the snippet listens for it.
 */
export const html = {
  panelled: false,
  mount(ctx) {
    const { config } = ctx;

    const frame = el('iframe', {
      sandbox: 'allow-scripts',          // NEVER add allow-same-origin here
      referrerpolicy: 'no-referrer',
      style: {
        width: '100%', height: '100%', border: '0', display: 'block',
        background: config.background || 'transparent',
        colorScheme: 'dark',
      },
    });

    // A tiny shim so the snippet has a sane starting point and a documented
    // way to receive data, rather than every user reinventing both.
    const shim = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;font:400 16px Inter,system-ui,sans-serif;
            color:${config.colour || '#e8eaf0'};background:transparent;overflow:hidden}
  *{box-sizing:border-box}
</style>
<script>
  // window.lifeboard.onData(fn) - called whenever the configured source updates.
  (function(){
    var handlers = [];
    window.lifeboard = {
      onData: function(fn){ handlers.push(fn); },
      data: null,
    };
    window.addEventListener('message', function(e){
      if (!e.data || e.data.__lifeboard !== 'data') return;
      window.lifeboard.data = e.data.value;
      handlers.forEach(function(fn){ try { fn(e.data.value); } catch(err){ console.error(err); } });
    });
  })();
<\/script>
${config.html || ''}`;

    frame.setAttribute('srcdoc', shim);
    ctx.body.style.overflow = 'hidden';
    ctx.body.append(frame);

    if (!config.source_id && !config.variable) return;

    const push = async () => {
      try {
        const url = config.variable
          ? `/api/data/variable?name=${encodeURIComponent(config.variable)}`
          : `/api/data/rest?source_id=${config.source_id}`
            + (config.path ? `&path=${encodeURIComponent(config.path)}` : '');
        const payload = await ctx.getJSON(url);
        // '*' as the target origin is correct here: the frame has an opaque
        // origin precisely because it is sandboxed, so there is no specific
        // origin to name. Nothing secret is sent - only the value the widget
        // was configured to display.
        frame.contentWindow?.postMessage(
          { __lifeboard: 'data', value: payload.value ?? payload }, '*');
        ctx.clearFail();
      } catch (err) { ctx.fail(err); }
    };

    // Wait for the frame to parse the shim before the first push, or the
    // listener is not registered yet and the first update is lost.
    frame.addEventListener('load', push);
    ctx.interval(push, Math.max(5, Number(config.refresh_seconds || 60)) * 1000);
  },
};
