/* A SharePoint list on the wall.
 *
 * Unlike every other list widget here, this one does not know what it is
 * showing. A SharePoint list has whatever columns somebody made: one is a
 * punch list with Status and Assigned To, the next is an asset register with
 * serial numbers. So the widget is TOLD which columns to show, in which order,
 * and draws them as rows of a table or as cards.
 *
 * The same applies to ticking things off. There is no "done" field to assume,
 * so the board is told which column means done and what value counts as done -
 * a Yes/No column set to true, or a Status choice set to "Complete". Guessing
 * between those would be wrong about half the time.
 */
import { el } from '../app.js';
import { tappable, checkbox } from '../touch.js';

const REMOVE_AFTER_MS = 2000;

/* SharePoint hands back several shapes for what a person thinks of as one
 * value: a person column is an object, a choice column can be an array, a date
 * is an ISO string nobody wants to read on a wall. */
function show(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(show).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return String(value.DisplayName || value.displayName || value.Title
                  || value.Label || value.Value || '').trim();
  }
  const text = String(value);
  // An ISO timestamp becomes a date; anything else is left exactly as typed,
  // because a serial number that gets "helpfully" reformatted is wrong.
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
  }
  return text;
}

/* Is this row already done, by whatever rule the board was given? */
function isDone(item, config) {
  const column = config.done_column;
  if (!column) return false;
  const value = item.fields?.[column];
  const wanted = config.done_value;
  if (wanted === undefined || wanted === '') return value === true;
  return String(show(value)).toLowerCase() === String(wanted).toLowerCase();
}

export const splist = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const size = Number(config.size || 2.1);
    const cols = String(config.columns || '')
      .split(',').map((c) => c.trim()).filter(Boolean);
    const titles = String(config.column_titles || '')
      .split(',').map((c) => c.trim());
    const interactive = config.interactive !== false && Boolean(config.done_column);
    let items = [];

    const query = () => new URLSearchParams({
      source_id: String(config.source_id || 0),
      site_id: String(config.site_id || ''),
      list_id: String(config.list_id || ''),
      // The done column is fetched whether or not it is displayed - the board
      // has to know a row's state to draw its checkbox correctly.
      fields: [...cols, config.done_column].filter(Boolean).join(','),
      limit: String(Math.max(1, Number(config.max_items || 20))),
      order_by: String(config.order_by || ''),
      filter_query: String(config.filter || ''),
    });

    const row = (item) => {
      const done = isDone(item, config);
      const cells = cols.map((name, index) => el('div', {
        style: {
          flex: index === 0 ? '2 1 0' : '1 1 0', minWidth: '0',
          fontSize: `${index === 0 ? size : size * 0.82}vmin`,
          fontWeight: index === 0 ? '500' : '400',
          opacity: index === 0 ? '1' : '.7',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          textDecoration: done ? 'line-through' : 'none',
        },
      }, show(item.fields?.[name])));

      const box = interactive ? checkbox(done, size * 1.15) : null;

      const line = el('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: `${size * 0.5}vmin`,
          padding: `${size * 0.32}vmin 0`, minWidth: '0',
          borderBottom: '1px solid rgba(255,255,255,.07)',
          opacity: done ? '.45' : '1',
          transition: 'opacity .4s ease, max-height .4s ease, transform .4s ease',
        },
      }, box, ...cells);

      if (box) {
        let pending = null;
        tappable(box, async () => {
          const next = !isDone(item, config);
          const wanted = config.done_value;
          // Write back exactly what the column expects: a boolean for a Yes/No
          // column, the configured text for a choice column.
          const value = (wanted === undefined || wanted === '')
            ? next
            : (next ? wanted : (config.not_done_value || ''));

          item.fields = { ...(item.fields || {}), [config.done_column]: value };
          box.setLb(next);
          line.style.opacity = next ? '.45' : '1';
          for (const cell of cells) {
            cell.style.textDecoration = next ? 'line-through' : 'none';
          }

          clearTimeout(pending);
          if (next && config.remove_when_done !== false) {
            pending = setTimeout(() => {
              line.style.maxHeight = '0';
              line.style.opacity = '0';
              line.style.transform = 'translateX(2vmin)';
              setTimeout(() => line.remove(), 420);
            }, REMOVE_AFTER_MS);
          }

          const resp = await fetch('/api/sharepoint/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source_id: config.source_id,
              site_id: config.site_id,
              list_id: config.list_id,
              item_id: item.id,
              values: { [config.done_column]: value },
            }),
          });
          if (!resp.ok) {
            clearTimeout(pending);
            const body = await resp.json().catch(() => ({}));
            throw new Error(body.error || `the board could not save that (${resp.status})`);
          }
        }, {
          revert: () => {
            clearTimeout(pending);
            const back = !isDone(item, config);
            box.setLb(back);
            line.style.opacity = back ? '.45' : '1';
            line.style.maxHeight = '';
            line.style.transform = '';
          },
        });
      }
      return line;
    };

    const draw = () => {
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
          }, config.heading || 'List'),
          el('div', {
            style: { fontSize: `${size * 0.8}vmin`, opacity: '.55' },
          }, String(items.length)),
        ));
      }

      // Column headings, when there is more than one - a single column is
      // obviously itself and a heading over it is noise.
      if (config.show_columns !== false && cols.length > 1) {
        parts.push(el('div', {
          style: {
            display: 'flex', gap: `${size * 0.5}vmin`, flex: '0 0 auto',
            fontSize: `${size * 0.66}vmin`, textTransform: 'uppercase',
            letterSpacing: '.1em', opacity: '.45',
            paddingBottom: `${size * 0.2}vmin`,
            paddingLeft: interactive ? `${size * 1.65}vmin` : '0',
          },
        }, ...cols.map((name, index) => el('div', {
          style: {
            flex: index === 0 ? '2 1 0' : '1 1 0', minWidth: '0',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, titles[index] || name))));
      }

      const visible = config.show_done ? items : items.filter((i) => !isDone(i, config));
      const body = el('div', {
        style: { flex: '1 1 auto', minHeight: '0', overflow: 'hidden' },
      }, ...(visible.length
        ? visible.map(row)
        : [el('div', { style: { fontSize: `${size}vmin`, opacity: '.5', paddingTop: '1vmin' } },
            config.empty_text || 'Nothing here')]));

      ctx.body.replaceChildren(el('div', {
        style: { height: '100%', display: 'flex', flexDirection: 'column' },
      }, ...parts, body));
    };

    const load = async () => {
      if (!config.site_id || !config.list_id) {
        ctx.body.replaceChildren(el('div', { style: { opacity: '.6' } },
          'No SharePoint list selected'));
        return;
      }
      if (!cols.length) {
        ctx.body.replaceChildren(el('div', { style: { opacity: '.6' } },
          'Choose which columns to show'));
        return;
      }
      try {
        const data = await ctx.getJSON(`/api/sharepoint/items?${query()}`);
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
