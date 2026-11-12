/* A sticky note.
 *
 * The point is that it does NOT look like the rest of the board. Everything
 * else here is a flat panel on a dark ground; a sticky is paper - coloured,
 * very slightly askew, with a shadow - and that difference is what makes the
 * eye go to it. A "reminder" that looks identical to the weather is not a
 * reminder.
 *
 * The content is pluggable because the same piece of paper is the right shape
 * for several things: a literal note somebody typed, a Google Tasks list, one
 * of the board's own to-do lists, or bullets pulled out of an Obsidian note.
 */
import { el } from '../app.js';

/* Real sticky-note colours rather than saturated web ones. These are sampled
 * from actual paper: the yellow is not #ffff00, and the difference between
 * those two yellows is the whole effect. */
export const PAPER = {
  yellow: { bg: '#fdf07a', ink: '#4a441c' },
  pink:   { bg: '#ffb3c6', ink: '#5c2734' },
  blue:   { bg: '#a8dcf0', ink: '#1e4757' },
  green:  { bg: '#b8e6a1', ink: '#2c4a1e' },
  orange: { bg: '#ffc98b', ink: '#5c3a15' },
  purple: { bg: '#d4b8f0', ink: '#3d2757' },
  white:  { bg: '#f5f2e8', ink: '#3a382f' },
  grey:   { bg: '#d8d8d2', ink: '#33332e' },
};

const FONTS = {
  hand: '"Caveat", "Bradley Hand", "Segoe Script", "Comic Sans MS", cursive',
  marker: '"Permanent Marker", "Segoe Print", "Comic Sans MS", cursive',
  plain: 'Inter, "Segoe UI", system-ui, sans-serif',
};

function paperFor(config) {
  const chosen = PAPER[config.colour] || PAPER.yellow;
  return {
    bg: config.custom_colour || chosen.bg,
    ink: config.custom_ink || chosen.ink,
  };
}

/* Where the lines come from. Each returns [{text, done, sub}]. */
async function loadItems(ctx) {
  const { config } = ctx;
  const source = config.content || 'text';
  const limit = Math.max(1, Number(config.max_items || 8));

  if (source === 'text') {
    return String(config.text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, limit)
      .map((text) => ({ text, done: false, sub: false }));
  }

  if (source === 'gtasks') {
    if (!config.source_id || !config.list_id) {
      return [{ text: 'Pick a Google account and a task list', done: false, sub: false }];
    }
    const data = await ctx.getJSON(
      `/api/data/gtasks?source_id=${config.source_id}`
      + `&list_id=${encodeURIComponent(config.list_id)}`
      + `&limit=${limit}`
      + `&show_completed=${config.show_done ? 'true' : 'false'}`);
    if (data.error) throw new Error(data.error);
    return (data.items || []).slice(0, limit).map((t) => ({
      text: t.title, done: t.done, sub: !!t.parent, note: t.notes, due: t.due,
    }));
  }

  if (source === 'todo') {
    // A DIFFERENT key from the Google list: one board can hold a sticky for a
    // Google list and another for a LifeBoard list, and sharing one key would
    // make switching `content` silently carry the wrong id across.
    if (!config.todo_list_id) return [];
    const data = await ctx.getJSON(`/api/todo/lists/${config.todo_list_id}`);
    if (data.error) throw new Error(data.error);
    return (data.items || [])
      .filter((i) => (config.show_done ? true : !i.done))
      .slice(0, limit)
      .map((i) => ({ text: i.text, done: !!i.done, sub: false }));
  }

  if (source === 'obsidian') {
    if (!config.obsidian_source) return [];
    const data = await ctx.getJSON(
      `/api/data/obsidian?source_id=${config.obsidian_source}`);
    if (data.error) throw new Error(data.error);
    return (data.excerpts || [])
      .filter((e) => (config.kinds ? e.kind === config.kinds : true))
      .slice(0, limit)
      .map((e) => ({ text: e.text, done: false, sub: false }));
  }

  return [];
}

export const postit = {
  // No panel: the paper IS the panel, and a card behind it would frame the
  // thing that is meant to look stuck on.
  panelled: false,
  mount(ctx) {
    const { config } = ctx;
    const paper = paperFor(config);
    const size = Number(config.size || 2);
    const font = FONTS[config.font || 'hand'] || FONTS.hand;
    // A sticky pinned at exactly 0 degrees looks like a rectangle, not paper.
    const tilt = Number(config.tilt ?? -1.5);

    const draw = (items) => {
      const lines = items.map((item) => el('div', {
        style: {
          display: 'flex', gap: '.6vmin', alignItems: 'flex-start',
          marginBottom: '.45vmin', minWidth: '0',
          marginLeft: item.sub ? '1.6vmin' : '0',
          opacity: item.done ? '.45' : '1',
          textDecoration: item.done ? 'line-through' : 'none',
        },
      },
        config.bullets === false ? null : el('span', {
          style: { flex: '0 0 auto', opacity: '.65' },
        }, config.bullet_style === 'check' ? (item.done ? '☑' : '☐')
          : config.bullet_style === 'dash' ? '–' : '•'),
        el('span', { style: { minWidth: '0' } }, item.text),
      ));

      const body = el('div', {
        style: {
          flex: '1 1 auto', minHeight: '0', overflow: 'hidden',
          fontSize: `${size}vmin`, lineHeight: '1.35',
        },
      }, ...(lines.length ? lines
        : [el('div', { style: { opacity: '.5' } }, config.empty_text || 'Nothing here')]));

      const note = el('div', {
        style: {
          height: '100%', display: 'flex', flexDirection: 'column',
          background: paper.bg, color: paper.ink, fontFamily: font,
          padding: '1.6vmin 1.8vmin',
          transform: `rotate(${tilt}deg)`,
          // A real sticky is glued along the top and lifts at the bottom, so
          // the shadow is offset downward rather than evenly around.
          boxShadow: config.shadow === false ? 'none'
            : '0 .8vmin 1.6vmin rgba(0,0,0,.45), 0 .2vmin .4vmin rgba(0,0,0,.3)',
          borderRadius: '2px',
        },
      });

      if (config.heading) {
        note.append(el('div', {
          style: {
            fontSize: `${size * 1.25}vmin`, fontWeight: '700',
            marginBottom: '.8vmin', flex: '0 0 auto',
            borderBottom: `1px solid ${paper.ink}33`, paddingBottom: '.4vmin',
          },
        }, config.heading));
      }
      note.append(body);

      if (config.show_count !== false && items.length) {
        const left = items.filter((i) => !i.done).length;
        note.append(el('div', {
          style: {
            fontSize: `${size * 0.6}vmin`, opacity: '.5',
            marginTop: '.5vmin', flex: '0 0 auto', textAlign: 'right',
          },
        }, `${left} left`));
      }

      ctx.body.replaceChildren(note);
    };

    const load = async () => {
      try {
        draw(await loadItems(ctx));
        ctx.clearFail();
      } catch (err) {
        // Keep whatever is on the paper. A blank sticky where the grocery
        // list was is worse than a slightly old grocery list.
        ctx.fail(err, load);
      }
    };

    load();
    ctx.interval(load, Math.max(1, Number(config.refresh_minutes || 5)) * 60_000);
  },
};
