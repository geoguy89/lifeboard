/* A Kanban board on the wall, backed by Planner or by LifeBoard's own lists.
 *
 * It mirrors the columns the source already has rather than inventing its own.
 * If the wall shows a different arrangement to the app people work in, nobody
 * trusts either of them.
 *
 * WHAT A TICK DOES IS CONFIGURED, NOT ASSUMED
 * --------------------------------------------
 * The obvious design is "checking a card completes it". That is wrong for most
 * real boards: on one wall the columns are Backlog / Doing / Done and a tick
 * means *advance to the next column*; on another the left column is a shopping
 * list and a tick means done and gone. Guessing produces a board that does the
 * wrong thing confidently.
 *
 * So each column carries its own rule (`config.column_rules`, keyed by column
 * title):
 *
 *     next      move the card to the column on its right   (default)
 *     complete  mark it done and drop it off the board
 *     move:Name move it to a named column
 *     none      no checkbox at all - a column you only read
 *
 * A column with no rule uses `config.default_action`, so a board of ten
 * columns does not need ten settings to behave sensibly.
 */
import { el } from '../app.js';
import { tappable, checkbox } from '../touch.js';

const REMOVE_AFTER_MS = 1800;

/* Resolve what a tick on this column should do, and where it should land. */
function ruleFor(config, column, columns) {
  const rules = config.column_rules || {};
  const raw = String(rules[column.title] ?? rules[column.id] ?? config.default_action
                     ?? 'next').trim();

  if (raw === 'none') return { kind: 'none' };
  if (raw === 'complete') return { kind: 'complete' };
  if (raw.startsWith('move:')) {
    const wanted = raw.slice(5).trim().toLowerCase();
    const target = columns.find((c) => c.title.toLowerCase() === wanted);
    return target ? { kind: 'move', to: target } : { kind: 'none' };
  }
  // 'next': the column to the right, and completion when there is none - which
  // makes the rightmost column behave like Done without being told it is Done.
  const index = columns.indexOf(column);
  const next = columns[index + 1];
  return next ? { kind: 'move', to: next } : { kind: 'complete' };
}

function dueLabel(due) {
  if (!due) return '';
  const today = new Date().toISOString().slice(0, 10);
  if (due === today) return 'today';
  const d = new Date(`${due}T00:00:00`);
  const days = Math.round((d - new Date(`${today}T00:00:00`)) / 86400000);
  if (days < 0) return `${Math.abs(days)}d late`;
  if (days === 1) return 'tomorrow';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const kanban = {
  panelled: false,   // the columns are the panels
  mount(ctx) {
    const { config } = ctx;
    const backend = config.backend || 'planner';
    const size = Number(config.size || 1.6);
    const interactive = config.interactive !== false;
    let columns = [];

    const query = () => new URLSearchParams({
      backend,
      plan_id: String(config.plan_id || config.list_ids || ''),
      source_id: String(config.source_id || 0),
      show_completed: config.show_done ? 'true' : 'false',
    });

    const card = (item, column) => {
      const rule = interactive ? ruleFor(config, column, columns) : { kind: 'none' };

      const title = el('div', {
        style: {
          fontSize: `${size}vmin`, lineHeight: '1.3', flex: '1 1 auto',
          minWidth: '0', overflow: 'hidden', display: '-webkit-box',
          WebkitLineClamp: '3', WebkitBoxOrient: 'vertical',
        },
      }, item.title);

      const meta = el('div', {
        style: {
          display: 'flex', gap: '.8vmin', alignItems: 'center',
          fontSize: `${size * 0.68}vmin`, opacity: '.62', marginTop: '.4vmin',
          flexWrap: 'wrap',
        },
      },
        item.due ? el('span', {
          style: {
            color: item.due < new Date().toISOString().slice(0, 10)
              ? '#e08c8c' : 'inherit',
          },
        }, dueLabel(item.due)) : null,
        item.checklist_total
          ? el('span', {}, `☑ ${item.checklist_total - item.checklist_left}/${item.checklist_total}`)
          : null,
        item.assigned ? el('span', {}, `${item.assigned} assigned`) : null,
      );

      const box = rule.kind === 'none' ? null : checkbox(false, size * 1.5);

      const node = el('div', {
        style: {
          background: 'rgba(255,255,255,.06)',
          border: '1px solid rgba(255,255,255,.10)',
          borderLeft: `.5vmin solid ${item.priority <= 3 ? '#d98b8b' : 'transparent'}`,
          borderRadius: '.7vmin', padding: `${size * 0.55}vmin ${size * 0.6}vmin`,
          display: 'flex', gap: `${size * 0.5}vmin`, alignItems: 'flex-start',
          transition: 'opacity .35s ease, transform .35s ease, max-height .35s ease',
        },
      },
        box,
        el('div', { style: { flex: '1 1 auto', minWidth: '0' } },
          title,
          (item.due || item.checklist_total || item.assigned) ? meta : null),
      );

      if (box) {
        tappable(box, async () => {
          box.setLb(true);
          node.style.opacity = '.45';
          const body = {
            backend,
            card_id: item.id,
            etag: item.etag || '',
            source_id: config.source_id || null,
          };
          if (rule.kind === 'complete') body.complete = true;
          else body.to_column = rule.to.id;

          const timer = setTimeout(() => {
            node.style.maxHeight = '0';
            node.style.opacity = '0';
            node.style.transform = 'translateX(2vmin)';
            setTimeout(() => node.remove(), 380);
          }, REMOVE_AFTER_MS);

          const resp = await fetch('/api/tasks/card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!resp.ok) {
            clearTimeout(timer);
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || `the board could not save that (${resp.status})`);
          }
          // Re-read rather than moving the node by hand: the card may have
          // changed in ways this board cannot see, and Planner is the truth.
          setTimeout(load, REMOVE_AFTER_MS + 600);
        }, {
          revert: () => {
            box.setLb(false);
            node.style.opacity = '1';
            node.style.maxHeight = '';
            node.style.transform = '';
          },
        });
      }
      return node;
    };

    const draw = () => {
      const shown = columns.filter((c) => {
        const only = (config.only_columns || '').trim();
        if (!only) return true;
        return only.split(',').map((s) => s.trim().toLowerCase())
          .includes(c.title.toLowerCase());
      });

      const lanes = shown.map((column) => {
        const rule = interactive ? ruleFor(config, column, columns) : { kind: 'none' };
        const cards = el('div', {
          style: {
            display: 'flex', flexDirection: 'column', gap: `${size * 0.45}vmin`,
            overflow: 'hidden', flex: '1 1 auto', minHeight: '0',
          },
        }, ...column.cards
          .slice(0, Number(config.max_per_column || 12))
          .map((item) => card(item, column)));

        return el('div', {
          style: {
            flex: '1 1 0', minWidth: '0', display: 'flex',
            flexDirection: 'column',
            background: 'rgba(255,255,255,.03)',
            border: '1px solid rgba(255,255,255,.08)',
            borderRadius: '1vmin', padding: `${size * 0.6}vmin`,
          },
        },
          el('div', {
            style: {
              display: 'flex', alignItems: 'baseline', gap: '.6vmin',
              marginBottom: `${size * 0.5}vmin`, flex: '0 0 auto',
            },
          },
            el('div', {
              style: {
                fontSize: `${size * 1.05}vmin`, fontWeight: '600',
                flex: '1 1 auto', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, column.title || 'Unsorted'),
            el('div', {
              style: { fontSize: `${size * 0.75}vmin`, opacity: '.5', flex: '0 0 auto' },
            }, String(column.cards.length)),
          ),
          // Saying what a tick will do, on the column rather than the card.
          // Somebody standing at a board should not have to tap one to learn.
          (interactive && config.show_actions !== false && rule.kind !== 'none')
            ? el('div', {
                style: {
                  fontSize: `${size * 0.62}vmin`, opacity: '.4',
                  marginBottom: `${size * 0.4}vmin`, flex: '0 0 auto',
                },
              }, rule.kind === 'complete' ? '✓ marks done'
                : `✓ moves to ${rule.to.title}`)
            : null,
          cards,
        );
      });

      ctx.body.replaceChildren(el('div', {
        style: {
          height: '100%', display: 'flex', gap: `${size * 0.5}vmin`,
          alignItems: 'stretch',
          // Columns down the screen in portrait, across it in landscape. A
          // four-column board squeezed into a 9:16 panel is four slivers.
          flexDirection: config.direction === 'vertical' ? 'column' : 'row',
        },
      }, ...(lanes.length ? lanes
        : [el('div', { style: { opacity: '.5' } }, config.empty_text || 'No columns')])));
    };

    const load = async () => {
      try {
        const data = await ctx.getJSON(`/api/tasks/board?${query()}`);
        if (data.error && !data.columns) throw new Error(data.error);
        columns = data.columns || [];
        draw();
        ctx.clearFail();
      } catch (err) {
        ctx.fail(err, load);
      }
    };

    load();
    ctx.interval(load, Math.max(1, Number(config.refresh_minutes || 5)) * 60_000);
  },
};
