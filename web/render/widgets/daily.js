/* Daily content: quote, verse, word, joke, advice, on-this-day.
 *
 * Six blocks, one implementation. Every source is normalised to
 * {text, attribution, extra} on the server, so the only thing that differs
 * between them is which endpoint is asked and how the three parts are laid
 * out - and that is a config difference, not a code one.
 *
 * These are decorations. They must never show an error where a quote used to
 * be: the server keeps the last good answer through an outage, and a failed
 * load here leaves whatever is on screen alone.
 */
import { el } from '../app.js';

/* Text that has to fit a box it was not measured for.
 *
 * A quote can be twelve words or ninety, and a wall display has no scrollbar
 * and nobody standing there to resize it. So the size is chosen from the
 * LENGTH of what actually arrived - long text steps down until it fits rather
 * than being clipped mid-sentence. The steps are deliberately coarse; smooth
 * scaling just produces a different size every day and looks unsettled. */
function autoSize(text, base) {
  const n = (text || '').length;
  if (n > 260) return base * 0.55;
  if (n > 170) return base * 0.68;
  if (n > 110) return base * 0.8;
  if (n > 60) return base * 0.9;
  return base;
}

function build(kind, defaults = {}) {
  return {
    panelled: true,
    mount(ctx) {
      const { config } = ctx;
      const size = Number(config.size ?? defaults.size ?? 2.4);
      const showAttr = config.show_attribution !== false;

      const draw = (data) => {
        const text = data.text || '';
        if (!text) return;                     // keep whatever is there

        const parts = [];

        // The word block leads with the word itself, big, and the definition
        // is the body - the opposite shape to a quote, where the words are
        // the point and the author is a footnote.
        const isWord = kind === 'word';

        parts.push(el('div', {
          style: {
            fontSize: `${isWord ? size * 1.4 : autoSize(text, size)}vmin`,
            lineHeight: '1.25',
            fontWeight: isWord ? '600' : '400',
            fontStyle: config.italic ? 'italic' : 'normal',
            textTransform: isWord && config.capitalise !== false ? 'capitalize' : 'none',
          },
        }, config.quote_marks && !isWord ? `“${text}”` : text));

        if (data.extra && isWord) {
          parts.push(el('div', {
            style: {
              fontSize: `${size * 0.72}vmin`, opacity: '.6',
              fontStyle: 'italic', marginTop: '.2vmin',
            },
          }, data.extra));
        }

        // The translation is part of the citation when one was chosen: a verse
        // that quietly fell back to NIV because the NLT file is missing must
        // not look like the NLT.
        const cite = (showAttr && data.attribution)
          ? (config.show_translation !== false && data.extra && !isWord
              ? `${data.attribution} (${data.extra})` : data.attribution)
          : '';
        if (cite) {
          parts.push(el('div', {
            style: {
              fontSize: `${isWord ? size * 0.85 : size * 0.75}vmin`,
              opacity: isWord ? '.85' : '.65',
              marginTop: isWord ? '.7vmin' : '.9vmin',
              lineHeight: '1.35',
            },
          }, isWord ? data.attribution : `— ${cite}`));
        }

        // on-this-day reads as "1969 · July 20", so the date is worth having
        // even though the year is already the attribution.
        if (data.extra && kind === 'on_this_day') {
          parts.push(el('div', {
            style: { fontSize: `${size * 0.65}vmin`, opacity: '.5', marginTop: '.3vmin' },
          }, data.extra));
        }

        ctx.body.replaceChildren(el('div', {
          style: {
            height: '100%', display: 'flex', flexDirection: 'column',
            justifyContent: config.align_v || 'center',
            alignItems: config.align === 'left' ? 'flex-start'
              : config.align === 'right' ? 'flex-end' : 'center',
            textAlign: config.align || 'center',
            overflow: 'hidden', minWidth: '0',
          },
        }, ...parts));
      };

      const load = async () => {
        try {
          const data = await ctx.getJSON(`/api/data/daily?kind=${kind}`
            + (config.translation ? `&translation=${encodeURIComponent(config.translation)}` : ''));
          if (data.error) throw new Error(data.error);
          draw(data);

          /* A note means "you asked for one thing and got another".
           *
           * The citation already says (NIV), which is honest but not an
           * explanation: somebody who chose NLT sees the wrong translation and
           * has no way to learn that the file is simply missing. The note says
           * so, and it is actionable - upload the file and it goes away - so
           * it belongs in the corner rather than buried in a log.
           */
          if (data.note) ctx.fail(new Error(data.note));
          else ctx.clearFail();
        } catch (err) {
          // Leave the previous line up. A blank box where a verse was is a
          // worse outcome than yesterday's verse.
          ctx.fail(err, load);
        }
      };

      load();
      // These change once a day. Checking hourly is already generous; the
      // server caches per calendar day regardless.
      ctx.interval(load, Math.max(15, Number(config.refresh_minutes || 180)) * 60_000);
    },
  };
}

export const quote = build('quote', { size: 2.4 });
export const bible_verse = build('bible_verse', { size: 2.2 });
export const word_of_day = build('word', { size: 2.6 });
export const dad_joke = build('dad_joke', { size: 2.4 });
export const advice = build('advice', { size: 2.4 });
export const on_this_day = build('on_this_day', { size: 2.0 });
