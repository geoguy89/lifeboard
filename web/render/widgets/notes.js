/* Excerpts from an Obsidian vault.
 *
 * A 4,000-word sermon note is not a wall display. The server does the
 * extraction - splitting a note into quotes, bullets and paragraphs, each
 * tagged with the heading it sat under - and this decides what to show and
 * when to move on.
 *
 * Two shapes, because they answer different wants:
 *
 *   "excerpts"  one piece at a time, cycling. Good for glancing at while
 *               making coffee; you get a different thought each time.
 *   "note"      one whole note, scrolling slowly. Good for actually reading
 *               something through over the course of a morning.
 */
import { el } from '../app.js';
import { scrollColumn } from './scroll.js';

export const obsidian_notes = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    if (!config.source_id) {
      ctx.body.replaceChildren(el('div', { style: { opacity: '.6' } },
        'Pick an Obsidian vault source'));
      return;
    }

    const size = Number(config.size || 1.9);
    const mode = config.mode || 'excerpts';
    let order = [];
    let cursor = 0;
    let current = null;

    const heading = (text) => (config.show_heading === false || !text) ? null
      : el('div', {
          style: {
            fontSize: `${size * 0.62}vmin`, opacity: '.55',
            textTransform: 'uppercase', letterSpacing: '.06em',
            marginBottom: '.5vmin', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          },
        }, text);

    const noteTitle = (data) => (config.show_title === false) ? null
      : el('div', {
          style: {
            fontSize: `${size * 0.72}vmin`, opacity: '.75',
            marginTop: '.7vmin', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          },
        }, `— ${data.title}`);

    /* One excerpt, sized by its own length so a long paragraph and a short
     * bullet both fill the block sensibly. Same reasoning as the daily blocks:
     * a wall has no scrollbar and nobody there to resize it. */
    const drawExcerpt = (data) => {
      const piece = current;
      if (!piece) return;
      const n = piece.text.length;
      const scale = n > 300 ? 0.62 : n > 200 ? 0.74 : n > 120 ? 0.86 : 1;

      ctx.body.replaceChildren(el('div', {
        style: {
          height: '100%', display: 'flex', flexDirection: 'column',
          justifyContent: 'center', overflow: 'hidden', minWidth: '0',
          textAlign: config.align || 'left',
        },
      },
        heading(piece.heading),
        el('div', {
          style: {
            fontSize: `${size * scale}vmin`, lineHeight: '1.35',
            fontStyle: piece.kind === 'quote' ? 'italic' : 'normal',
            // A quote gets a rule rather than quote marks: the source text
            // often already contains its own.
            borderLeft: piece.kind === 'quote' ? '2px solid currentColor' : 'none',
            paddingLeft: piece.kind === 'quote' ? '1vmin' : '0',
            opacity: piece.kind === 'quote' ? '.9' : '1',
          },
        }, piece.text),
        noteTitle(data),
      ));
    };

    const drawWholeNote = (data) => {
      // The shared scroller, so a long note behaves like every other long
      // column on the board rather than inventing a second scrolling
      // behaviour. It measures itself and only moves if something is
      // genuinely cut off.
      const { outer, inner } = scrollColumn({
        speed: Number(config.scroll_speed || 18),
        enabled: config.scroll !== false,
        // A whole note is exactly the long-content case continuous mode is
        // for: bouncing means the end of the note is on screen for an instant
        // before the text turns round and walks away from it.
        mode: config.scroll_mode === 'continuous' ? 'continuous' : 'bounce',
      });
      inner.append(el('div', {
        style: { fontSize: `${size}vmin`, lineHeight: '1.45', whiteSpace: 'pre-wrap' },
      }, data.body || ''));

      ctx.body.replaceChildren(el('div', {
        style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: '0' },
      },
        config.show_title === false ? null : el('div', {
          style: {
            fontSize: `${size * 0.95}vmin`, fontWeight: '600',
            marginBottom: '.6vmin', flex: '0 0 auto',
          },
        }, data.title),
        outer,
      ));
    };

    const advance = (data) => {
      if (!order.length) return;
      cursor = (cursor + 1) % order.length;
      current = order[cursor];
      drawExcerpt(data);
    };

    const load = async () => {
      try {
        const data = await ctx.getJSON(`/api/data/obsidian?source_id=${config.source_id}`);
        if (data.error) throw new Error(data.error);

        if (mode === 'note') {
          drawWholeNote(data);
          ctx.clearFail();
          return;
        }

        order = data.excerpts || [];
        if (config.shuffle !== false) {
          // Fisher-Yates, so every excerpt is seen once before any repeats.
          // Picking at random each tick shows the same one twice in a row
          // often enough to look broken.
          for (let i = order.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
          }
        }
        if (!order.length) {
          ctx.body.replaceChildren(el('div', { style: { opacity: '.6' } },
            'Nothing long enough to show in that note'));
          return;
        }
        cursor = 0;
        current = order[0];
        drawExcerpt(data);
        ctx.clearFail();

        ctx.interval(() => advance(data),
          Math.max(5, Number(config.seconds || 30)) * 1000);
      } catch (err) {
        // Leave whatever is on screen. A blank panel where a thought was is a
        // worse outcome than yesterday's thought.
        ctx.fail(err, load);
      }
    };

    load();
    ctx.interval(load, Math.max(5, Number(config.refresh_minutes || 60)) * 60_000);
  },
};
