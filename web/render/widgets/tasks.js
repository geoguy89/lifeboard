/* A task list you walk up to and cross off.
 *
 * Distinct from the sticky note, which is a glanceable scrap of paper. This is
 * the whole block: a header saying which list it is and how much is left, then
 * rows sized to be hit with a thumb from arm's length.
 *
 * The one behaviour that defines it: **a completed task leaves the board.** It
 * ticks, greys, and is gone a moment later. That is the difference between a
 * list you maintain and a list you use - if crossing something off leaves it
 * sitting there, the board slowly fills with things nobody needs to see and
 * everybody stops reading it.
 *
 * The pause before it goes is deliberate and is the undo: a mis-tap is
 * recoverable by tapping again while the row is still fading, which is the
 * only undo a wall display can offer.
 */
import { el } from '../app.js';
import { tappable, checkbox, flash } from '../touch.js';

const REMOVE_AFTER_MS = 2200;

/* Group tasks under sub-headings. Which grouping is useful depends entirely on
 * the list: a shopping list wants none, a work list wants due dates. */
function group(items, mode) {
  if (mode === 'none' || !mode) return [{ title: '', items }];

  if (mode === 'due') {
    const today = new Date().toISOString().slice(0, 10);
    const buckets = new Map([
      ['Overdue', []], ['Today', []], ['Later', []], ['No date', []],
    ]);
    for (const item of items) {
      if (!item.due) buckets.get('No date').push(item);
      else if (item.due < today) buckets.get('Overdue').push(item);
      else if (item.due === today) buckets.get('Today').push(item);
      else buckets.get('Later').push(item);
    }
    return [...buckets].filter(([, list]) => list.length)
      .map(([title, list]) => ({ title, items: list }));
  }

  if (mode === 'assignee') {
    const by = new Map();
    for (const item of items) {
      const who = item.assignee || 'Unassigned';
      if (!by.has(who)) by.set(who, []);
      by.get(who).push(item);
    }
    return [...by].map(([title, list]) => ({ title, items: list }));
  }
  return [{ title: '', items }];
}

function dueLabel(due) {
  if (!due) return '';
  const today = new Date().toISOString().slice(0, 10);
  if (due === today) return 'today';
  const d = new Date(`${due}T00:00:00`);
  const days = Math.round((d - new Date(`${today}T00:00:00`)) / 86400000);
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days < 0) return `${Math.abs(days)}d late`;
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const tasks = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const backend = config.backend || 'local';
    const size = Number(config.size || 2.4);
    const interactive = config.interactive !== false;
    let items = [];

    const query = () => new URLSearchParams({
      backend,
      list_id: String(config.list_id || ''),
      source_id: String(config.source_id || 0),
      show_completed: config.show_done ? 'true' : 'false',
      limit: String(Math.max(1, Number(config.max_items || 25))),
    });

    const row = (item) => {
      const box = checkbox(item.done, Math.max(2, size * 1.05));
      const label = el('div', {
        style: {
          fontSize: `${size}vmin`, flex: '1 1 auto', minWidth: '0',
          lineHeight: '1.3',
          // Wrapping rather than ellipsing: a task you cannot read the end of
          // is a task you cannot decide about, and there is room here.
          overflow: 'hidden', display: '-webkit-box',
          WebkitLineClamp: String(Number(config.title_lines || 2)),
          WebkitBoxOrient: 'vertical',
          textDecoration: item.done ? 'line-through' : 'none',
        },
      }, item.title);

      const meta = [];
      if (config.show_due !== false && item.due) {
        const late = item.due < new Date().toISOString().slice(0, 10);
        meta.push(el('div', {
          style: {
            fontSize: `${size * 0.68}vmin`, flex: '0 0 auto',
            color: late ? '#e08c8c' : 'var(--fg-dim, #9aa0a8)',
            fontWeight: late ? '600' : '400',
          },
        }, dueLabel(item.due)));
      }
      if (config.show_notes && item.notes) {
        label.append(el('div', {
          style: { fontSize: `${size * 0.62}vmin`, opacity: '.6', marginTop: '.2vmin' },
        }, item.notes.slice(0, 120)));
      }

      const line = el('div', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: `${size * 0.55}vmin`,
          padding: `${size * 0.32}vmin 0`, minWidth: '0',
          opacity: item.done ? '.45' : '1',
          transition: 'opacity .4s ease, max-height .4s ease, transform .4s ease',
        },
      }, box, label, ...meta);

      if (interactive) {
        let pendingRemoval = null;
        tappable(box, async () => {
          const next = !item.done;
          // Optimistic, and the tap that reverses it cancels the removal -
          // which is the only undo a wall display can offer.
          item.done = next;
          box.setLb(next);
          label.style.textDecoration = next ? 'line-through' : 'none';
          line.style.opacity = next ? '.45' : '1';

          clearTimeout(pendingRemoval);
          if (next && config.remove_when_done !== false) {
            pendingRemoval = setTimeout(() => {
              line.style.maxHeight = '0';
              line.style.opacity = '0';
              line.style.transform = 'translateX(2vmin)';
              setTimeout(() => line.remove(), 420);
            }, REMOVE_AFTER_MS);
          }

          const resp = await fetch('/api/tasks/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              backend,
              list_id: String(config.list_id || ''),
              source_id: config.source_id || null,
              task_id: item.id,
              done: next,
            }),
          });
          if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            throw new Error(body.error || `the board could not save that (${resp.status})`);
          }
        }, {
          revert: () => {
            clearTimeout(pendingRemoval);
            item.done = !item.done;
            box.setLb(item.done);
            label.style.textDecoration = item.done ? 'line-through' : 'none';
            line.style.opacity = item.done ? '.45' : '1';
            line.style.maxHeight = '';
            line.style.transform = '';
          },
        });
      }
      return line;
    };

    const draw = () => {
      const left = items.filter((i) => !i.done).length;
      const parts = [];

      if (config.show_header !== false) {
        parts.push(el('div', {
          style: {
            display: 'flex', alignItems: 'baseline', gap: '1vmin',
            flex: '0 0 auto', marginBottom: `${size * 0.4}vmin`,
            paddingBottom: `${size * 0.3}vmin`,
            borderBottom: '1px solid rgba(255,255,255,.14)',
          },
        },
          el('div', {
            style: { fontSize: `${size * 1.25}vmin`, fontWeight: '600', flex: '1 1 auto' },
          }, config.heading || config.title || 'Tasks'),
          config.show_count !== false
            ? el('div', {
                style: { fontSize: `${size * 0.8}vmin`, opacity: '.55', flex: '0 0 auto' },
              }, left ? `${left} left` : 'all done')
            : null,
        ));
      }

      const body = el('div', {
        style: { flex: '1 1 auto', minHeight: '0', overflow: 'hidden' },
      });

      const visible = config.show_done ? items : items.filter((i) => !i.done);
      if (!visible.length) {
        body.append(el('div', {
          style: { fontSize: `${size}vmin`, opacity: '.5', paddingTop: '1vmin' },
        }, config.empty_text || 'Nothing to do'));
      }

      for (const section of group(visible, config.group_by)) {
        if (section.title) {
          body.append(el('div', {
            style: {
              fontSize: `${size * 0.72}vmin`, textTransform: 'uppercase',
              letterSpacing: '.12em', opacity: '.5',
              margin: `${size * 0.5}vmin 0 ${size * 0.2}vmin`,
            },
          }, section.title));
        }
        for (const item of section.items) body.append(row(item));
      }

      ctx.body.replaceChildren(el('div', {
        style: { height: '100%', display: 'flex', flexDirection: 'column' },
      }, ...parts, body));
    };

    const load = async () => {
      if (!config.list_id) {
        ctx.body.replaceChildren(el('div', { style: { opacity: '.6' } },
          'No list selected'));
        return;
      }
      try {
        const data = await ctx.getJSON(`/api/tasks/items?${query()}`);
        if (data.error && !data.items) throw new Error(data.error);
        items = data.items || [];
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
