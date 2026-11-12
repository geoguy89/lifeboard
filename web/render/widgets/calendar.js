/* Calendar, in several styles.
 *
 * All styles consume the SAME merged event stream from /api/data/calendar, so
 * a board can show a month grid and an agenda side by side and they can never
 * disagree - which is exactly the failure you get if each view fetches its own
 * sources.
 *
 * The dates are the hard part, and there are two traps this file is built to
 * avoid:
 *
 *  1. All-day events. They arrive as midnight-UTC. Converting them to a local
 *     timezone moves a birthday on the 3rd to the 2nd anywhere west of London.
 *     So all-day events are bucketed by their UTC calendar date, never by a
 *     localised one.
 *  2. "Today" is not the browser's today. The board has its own configured
 *     timezone, and a Pi that has not synced or is set to UTC would otherwise
 *     highlight the wrong cell.
 */

import { el } from '../app.js';
import { scrollColumn, scrollingText, disposeScrollers } from './scroll.js';

const DAY_MS = 86_400_000;

/* Overflow behaviour, read once per draw.
 *
 * WHEN AUTO-SCROLL IS ON, THE PER-DAY CAPS ARE IGNORED. That is deliberate
 * and it is the whole point: `max_per_day` and `max_items` exist because a
 * fixed box cannot show more than fits, and a box that scrolls can. Honouring
 * both would produce exactly the thing being complained about - a day that
 * scrolls beautifully through four of its nine meetings.
 *
 * The hard caps below are not a display choice, they are a guard: a runaway
 * feed must not build ten thousand nodes on a Pi 3.
 */
const HARD_CAP_AGENDA = 200;
const HARD_CAP_DAY = 40;

function scrollOpts(config) {
  const speed = Number(config.scroll_speed) > 0 ? Number(config.scroll_speed) : 22;
  return {
    columns: config.scroll_overflow !== false,
    titles: config.scroll_titles !== false,
    // 'bounce' runs to the end and back; 'continuous' runs one way forever
    // and wraps seamlessly. Every scroller in the widget shares the choice,
    // so a board never has one column bouncing beside another that loops.
    mode: config.scroll_mode === 'continuous' ? 'continuous' : 'bounce',
    speed,
    // Text reads faster than a list scans, so it moves faster.
    textSpeed: speed * 1.5,
  };
}

/** How many of a day's events to render, given the overflow mode. */
function dayCap(config, opts, fallback) {
  if (opts.columns) return HARD_CAP_DAY;
  return Number(config.max_per_day || fallback);
}

/** A title that slides sideways when it is too long, instead of ellipsing. */
function eventTitle(text, opts, style) {
  const node = scrollingText(text, {
    enabled: opts.titles, speed: opts.textSpeed, style, mode: opts.mode,
  });
  node.style.minWidth = '0';
  return node;
}

/* ------------------------------------------------------------ date utils */

/** The board's current date as a YYYY-MM-DD key, in the board's timezone. */
function todayKey(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** The calendar-date key an event belongs to. See trap 1 above. */
function eventDayKey(ev, tz) {
  const d = new Date(ev.start);
  if (ev.all_day) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** The first day of the week containing `key`. */
export function weekStartKey(key, weekStartsOn = 0) {
  const dow = keyToDate(key).getUTCDay();
  return addDays(key, -((dow - weekStartsOn + 7) % 7));
}

function addDays(key, n) {
  const d = keyToDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function timeLabel(ev, tz) {
  if (ev.all_day) return 'All day';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ev.start)).replace(':00', '').toLowerCase();
}

function relativeDayLabel(key, tz) {
  const today = todayKey(tz);
  if (key === today) return 'Today';
  if (key === addDays(today, 1)) return 'Tomorrow';
  const d = keyToDate(key);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric',
  }).format(d);
}

/* ------------------------------------------------------------- data load */

function makeLoader(ctx) {
  const { config } = ctx;
  const sources = (config.source_ids || []).join(',');
  const days = Number(config.days || 45);
  let last = [];                        // survives a failed refresh

  return async function load() {
    try {
      const data = await ctx.getJSON(
        `/api/data/calendar?days=${days}${sources ? `&sources=${sources}` : ''}`
      );
      last = data.events || [];
      // Per-source errors are reported, but only when there is nothing at all
      // to show - a board with five calendars and one broken feed should not
      // wear a red error label forever.
      const errors = Object.values(data.errors || {});
      if (errors.length && !last.length) ctx.fail(new Error(errors[0]));
      else ctx.clearFail();
    } catch (err) {
      ctx.fail(err, load);
    }
    return last;
  };
}

/* ------------------------------------------------------------- agenda */

/* The default, and the one that works best in portrait: a flat chronological
 * list grouped by day. Portrait boards are tall and narrow, which is exactly
 * the wrong shape for a month grid and exactly the right shape for this. */
function agenda(ctx, events) {
  const { config, timezone: tz } = ctx;
  const opts = scrollOpts(config);
  // Scrolling makes the cap meaningless - see the note at the top of the file.
  const maxItems = opts.columns
    ? HARD_CAP_AGENDA
    : (Number(config.max_items) > 0 ? Number(config.max_items) : 12);
  const today = todayKey(tz);

  const root = el('div', {
    style: { height: '100%', overflow: 'hidden', display: 'flex',
             flexDirection: 'column', minHeight: '0' },
  });

  const upcoming = events
    .filter((ev) => eventDayKey(ev, tz) >= today)
    .slice(0, maxItems);

  if (!upcoming.length) {
    root.append(el('div', { style: { color: '#9aa0a8', fontSize: '1.8vmin' } },
      config.empty_text || 'Nothing scheduled'));
    return root;
  }

  // The list lives inside a scroller: if the agenda is longer than the block,
  // it walks down and back rather than hiding the bottom half of the week.
  const { outer, inner: wrap } = scrollColumn({
    gap: '0.6vmin', speed: opts.speed, enabled: opts.columns, mode: opts.mode,
  });
  root.append(outer);

  /* Day header: a large day-of-month number with the weekday beside it, then
   * the events indented under it. This is the shape DAKboard uses and it reads
   * far better across a room than a single line of small text - the number is
   * what your eye lands on when you glance at the board from the kitchen. */
  const scale = Number(config.scale || 1);

  /* Side by side, or stacked.
   *
   * Stacked is right for a portrait board, where the block is tall and narrow
   * and a day with six things on it reads as a list. It is wrong for a wide
   * block showing one or two days, where the same six things become a very
   * short column in a very empty rectangle.
   *
   * So each day's events can share a row instead. They wrap when they run out
   * of width rather than shrinking to nothing, because four unreadable cards
   * are worse than three readable ones and a second line.
   */
  const sideBySide = config.event_flow === 'row';
  const perRow = Math.max(0, Number(config.events_per_row) || 0);

  // Group first. The old loop emitted a header the moment the day changed,
  // which works when every event is its own row and not when a day's events
  // have to be handed to one container together.
  const byDay = [];
  for (const ev of upcoming) {
    const key = eventDayKey(ev, tz);
    const last = byDay[byDay.length - 1];
    if (last && last.key === key) last.events.push(ev);
    else byDay.push({ key, events: [ev] });
  }

  for (const day of byDay) {
    const key = day.key;
    {
      const isToday = key === today;
      wrap.append(el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', gap: '.8vmin',
          marginTop: wrap.children.length ? '1.4vmin' : '0',
          borderBottom: '1px solid rgba(255,255,255,.10)',
          paddingBottom: '.3vmin',
        },
      },
        el('span', {
          style: {
            fontSize: `${2.9 * scale}vmin`, fontWeight: '300', lineHeight: '1',
            color: isToday ? '#fff' : '#c9cfda',
          },
        }, keyToDate(key).getUTCDate().toString().padStart(2, '0')),
        el('span', {
          style: {
            fontSize: `${1.55 * scale}vmin`,
            color: isToday ? '#f2f3f5' : '#9aa0a8',
          },
        }, relativeDayLabel(key, tz)),
      ));
    }

    if (!sideBySide) {
      for (const ev of day.events) {
        const titleNode = eventTitle(ev.title, opts, { fontSize: `${1.75 * scale}vmin` });
        Object.assign(titleNode.style, { flex: '1 1 auto', alignSelf: 'center' });

        wrap.append(el('div', {
          style: { display: 'flex', gap: '.9vmin', alignItems: 'stretch', minWidth: '0' },
        },
          el('div', {
            style: {
              width: '0.45vmin', borderRadius: '2px',
              background: ev.colour, flex: '0 0 auto',
            },
          }),
          el('div', {
            style: {
              fontSize: `${1.45 * scale}vmin`, color: '#9aa0a8', flex: '0 0 auto',
              minWidth: '8ch', alignSelf: 'center',
            },
          }, timeLabel(ev, tz)),
          titleNode,
        ));
      }
      continue;
    }

    /* One row of cards for this day.
     *
     * `flex: 1 1 0` with a basis of zero shares the width evenly, so three
     * events are three equal cards rather than three cards sized by how long
     * their titles happen to be. The minimum width is what triggers the wrap:
     * below about fourteen characters a title is unreadable at a glance, which
     * is the only thing this block is for.
     */
    const basis = perRow > 0 ? `${100 / perRow}%` : '0';
    const cards = el('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', gap: `${0.7 * scale}vmin`,
        marginTop: `${0.5 * scale}vmin`, minWidth: '0',
      },
    }, ...day.events.map((ev) => el('div', {
      style: {
        flex: perRow > 0 ? `0 0 calc(${basis} - ${0.7 * scale}vmin)` : '1 1 0',
        minWidth: `${14 * scale}ch`, minHeight: '0',
        display: 'flex', gap: `${0.6 * scale}vmin`, alignItems: 'stretch',
        background: 'rgba(255,255,255,.05)',
        borderRadius: '.6vmin',
        padding: `${0.5 * scale}vmin ${0.6 * scale}vmin`,
      },
    },
      el('div', {
        style: {
          width: '0.45vmin', borderRadius: '2px',
          background: ev.colour, flex: '0 0 auto',
        },
      }),
      el('div', { style: { minWidth: '0', flex: '1 1 auto' } },
        el('div', {
          style: {
            fontSize: `${1.35 * scale}vmin`, color: '#9aa0a8',
            whiteSpace: 'nowrap',
          },
        }, timeLabel(ev, tz)),
        el('div', {
          style: {
            fontSize: `${1.7 * scale}vmin`, lineHeight: '1.25',
            marginTop: '.15vmin',
            // Wrapping rather than the sideways scroll a stacked row uses: a
            // card is already narrow, and something sliding back and forth
            // inside it is harder to read than two lines.
            overflow: 'hidden', display: '-webkit-box',
            WebkitLineClamp: String(Number(config.card_lines || 2)),
            WebkitBoxOrient: 'vertical',
          },
        }, ev.title),
      ),
    )));
    wrap.append(cards);
  }
  return root;
}

/* ----------------------------------------------------------- mini month */

/* A compact month grid: numbers only, today ringed, no event chips. This is
 * the "This Month" block on a DAKboard - it answers "what's the date
 * and where are we in the month", which is a different question from "what is
 * on", and putting event chips in it would make it unreadable at this size. */
function minimonth(ctx, events) {
  const { config, timezone: tz } = ctx;
  const today = todayKey(tz);
  const anchor = keyToDate(today);
  const year = anchor.getUTCFullYear();
  const monthIndex = anchor.getUTCMonth();
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const weekStartsMonday = config.week_starts === 'monday';

  let offset = first.getUTCDay();
  if (weekStartsMonday) offset = (offset + 6) % 7;
  const gridStart = new Date(first.getTime() - offset * DAY_MS);

  // Which days have anything on them, for the optional dot marker.
  const busy = new Set(events.map((ev) => eventDayKey(ev, tz)));

  const wrap = el('div', {
    style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: '0' },
  });

  const names = weekStartsMonday
    ? ['M', 'T', 'W', 'T', 'F', 'S', 'S']
    : ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  wrap.append(el('div', {
    style: {
      display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
      fontSize: '1.15vmin', color: '#8b93a3', textAlign: 'center',
      flex: '0 0 auto', marginBottom: '.5vmin', letterSpacing: '.06em',
    },
  }, ...names.map((n) => el('div', {}, n))));

  const grid = el('div', {
    style: {
      display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
      gridAutoRows: '1fr', flex: '1 1 auto', minHeight: '0',
      placeItems: 'center',
    },
  });

  // Six rows always, so the block does not change height between months and
  // shove everything below it up and down.
  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart.getTime() + i * DAY_MS);
    const key = cellDate.toISOString().slice(0, 10);
    const inMonth = cellDate.getUTCMonth() === monthIndex;
    const isToday = key === today;
    const day = cellDate.getUTCDate();

    // The first cell of a spill-over month gets its name instead of a number,
    // which is how you tell July 27 from August 27 at a glance.
    const spillLabel = !inMonth && (day === 1 || i === 0)
      ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' }).format(cellDate)
      : null;

    grid.append(el('div', {
      style: {
        width: '2.6vmin', height: '2.6vmin', borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '1.5vmin',
        background: isToday ? (config.today_colour || '#d0342c') : 'transparent',
        color: isToday ? '#fff' : inMonth ? '#e8eaf0' : '#5c6371',
        fontWeight: isToday ? '600' : '400',
        position: 'relative',
      },
    },
      spillLabel || String(day),
      config.show_busy_dots !== false && busy.has(key) && !isToday
        ? el('span', {
            style: {
              position: 'absolute', bottom: '-.1vmin', width: '.35vmin',
              height: '.35vmin', borderRadius: '50%', background: '#5b9dd9',
            },
          })
        : null,
    ));
  }

  wrap.append(grid);
  return wrap;
}

/* -------------------------------------------------------------- month */

function month(ctx, events) {
  const { config, timezone: tz } = ctx;
  const opts = scrollOpts(config);
  const today = todayKey(tz);
  const anchor = keyToDate(today);

  const year = anchor.getUTCFullYear();
  const monthIndex = anchor.getUTCMonth();
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const weekStartsMonday = config.week_starts === 'monday';

  // Back up to the start of the grid's first week.
  let offset = first.getUTCDay();                 // 0 = Sunday
  if (weekStartsMonday) offset = (offset + 6) % 7;
  const gridStart = new Date(first.getTime() - offset * DAY_MS);

  const byDay = new Map();
  for (const ev of events) {
    const key = eventDayKey(ev, tz);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  const wrap = el('div', {
    style: { height: '100%', display: 'flex', flexDirection: 'column', gap: '0.4vmin' },
  });

  const names = weekStartsMonday
    ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  wrap.append(el('div', {
    style: {
      display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '0.4vmin',
      fontSize: '1.2vmin', color: '#9aa0a8', textTransform: 'uppercase',
      letterSpacing: '.1em', textAlign: 'center', flex: '0 0 auto',
    },
  }, ...names.map((n) => el('div', {}, n))));

  const grid = el('div', {
    style: {
      display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
      gridAutoRows: '1fr', gap: '0.4vmin', flex: '1 1 auto', minHeight: '0',
    },
  });

  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart.getTime() + i * DAY_MS);
    const key = cellDate.toISOString().slice(0, 10);
    const inMonth = cellDate.getUTCMonth() === monthIndex;
    const isToday = key === today;
    const dayEvents = byDay.get(key) || [];

    const cell = el('div', {
      style: {
        background: isToday ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.03)',
        border: isToday ? '1px solid rgba(255,255,255,.35)' : '1px solid transparent',
        borderRadius: '6px', padding: '0.4vmin',
        opacity: inMonth ? '1' : '0.35',
        overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '0.2vmin',
        minWidth: '0', minHeight: '0',
      },
    });
    cell.append(el('div', {
      style: { fontSize: '1.3vmin', fontWeight: isToday ? '700' : '400', flex: '0 0 auto' },
    }, String(cellDate.getUTCDate())));

    /* With auto-scroll off: only as many chips as fit, the rest a count -
     * overflowing the cell is what makes month grids look broken on a real
     * display. With it on: every chip, and the cell scrolls through them. */
    const maxChips = dayCap(config, opts, 3);
    const { outer, inner } = scrollColumn({
      gap: '0.2vmin', speed: opts.speed, enabled: opts.columns, mode: opts.mode,
    });
    for (const ev of dayEvents.slice(0, maxChips)) {
      const chip = eventTitle(ev.title, opts, { fontSize: '1.05vmin' });
      Object.assign(chip.style, {
        borderRadius: '3px', padding: '0 .3vmin',
        background: ev.colour, color: '#0d0d10', flex: '0 0 auto',
      });
      inner.append(chip);
    }
    if (dayEvents.length > maxChips) {
      inner.append(el('div', { style: { fontSize: '1vmin', color: '#9aa0a8' } },
        `+${dayEvents.length - maxChips}`));
    }
    cell.append(outer);
    grid.append(cell);
  }

  wrap.append(grid);
  return wrap;
}

/* --------------------------------------------------------------- week */

function week(ctx, events) {
  const { config, timezone: tz } = ctx;
  const opts = scrollOpts(config);
  const today = todayKey(tz);
  const weekStartsMonday = config.week_starts === 'monday';
  let offset = keyToDate(today).getUTCDay();
  if (weekStartsMonday) offset = (offset + 6) % 7;
  const start = addDays(today, -offset);

  const byDay = new Map();
  for (const ev of events) {
    const key = eventDayKey(ev, tz);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  const wrap = el('div', {
    style: {
      height: '100%', display: 'grid', gap: '0.5vmin', minHeight: '0',
      // Portrait boards get a vertical week; landscape gets columns.
      gridTemplateColumns: config.vertical ? '1fr' : 'repeat(7, 1fr)',
      // Definite rows when scrolling, or a busy day grows the row instead of
      // scrolling within it.
      gridAutoRows: config.vertical || opts.columns ? 'minmax(0, 1fr)' : 'auto',
    },
  });

  for (let i = 0; i < 7; i++) {
    const key = addDays(start, i);
    const isToday = key === today;
    const col = el('div', {
      style: {
        background: isToday ? 'rgba(255,255,255,.09)' : 'rgba(255,255,255,.03)',
        borderRadius: '8px', padding: '0.6vmin', overflow: 'hidden',
        display: 'flex', flexDirection: 'column', gap: '0.3vmin', minHeight: '0',
      },
    });
    col.append(el('div', {
      style: { fontSize: '1.3vmin', color: isToday ? '#fff' : '#9aa0a8',
               fontWeight: isToday ? '700' : '400', flex: '0 0 auto' },
    }, new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', weekday: 'short', day: 'numeric',
    }).format(keyToDate(key))));

    const dayEvents = byDay.get(key) || [];
    const { outer, inner } = scrollColumn({
      gap: '0.3vmin', speed: opts.speed, enabled: opts.columns, mode: opts.mode,
    });
    for (const ev of dayEvents.slice(0, dayCap(config, opts, 6))) {
      const label = eventTitle(ev.title, opts, { fontSize: '1.2vmin' });
      label.style.flex = '1 1 auto';
      inner.append(el('div', {
        style: {
          fontSize: '1.2vmin', display: 'flex', gap: '.4vmin',
          alignItems: 'baseline', minWidth: '0', flex: '0 0 auto',
        },
      },
        el('span', { style: { color: ev.colour, flex: '0 0 auto' } }, '●'),
        label,
      ));
    }
    col.append(outer);
    wrap.append(col);
  }
  return wrap;
}

/* ------------------------------------------------- concept-board styles */

/* The day strip both styles share.
 *
 * Seven columns from `start`, today picked out. `compact` drops the weekday
 * initials for the bubbles variant, where the cards carry their own dates and
 * repeating them is noise. */
function dayStrip(keys, today, tz, { accent = '#fb923c', compact = false } = {}) {
  const strip = el('div', {
    style: {
      display: 'grid',
      gridTemplateColumns: `repeat(${keys.length}, 1fr)`,
      alignItems: 'end',
      flex: '0 0 auto',
    },
  });

  for (const key of keys) {
    const date = keyToDate(key);
    const isToday = key === today;
    const cell = el('div', {
      style: {
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: '.25vmin', minWidth: '0',
      },
    });

    if (!compact) {
      cell.append(el('div', {
        style: {
          fontSize: '1.25vmin', letterSpacing: '.04em',
          color: isToday ? '#e8eaf0' : '#8b93a3',
          fontWeight: isToday ? '600' : '400',
        },
      }, new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' })
        .format(date)));
    }

    // Today is a filled disc, matching the concepts. Everything else is just
    // the number, so the eye lands on today first.
    cell.append(el('div', {
      style: {
        fontSize: '1.9vmin', lineHeight: '1',
        width: '3vmin', height: '3vmin', borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: isToday ? accent : 'transparent',
        color: isToday ? '#141414' : '#c9cfda',
        fontWeight: isToday ? '700' : '400',
      },
    }, String(date.getUTCDate())));

    strip.append(cell);
  }
  return strip;
}

/* Events as coloured bars in their day's column. */
function timeline(ctx, events) {
  // ctx.timezone, not ctx.board.timezone - the latter does not exist, and an
  // undefined timeZone makes Intl fall back to the machine's own, which on
  // the appliance is not the board's.
  const { config, timezone: tz } = ctx;
  const opts = scrollOpts(config);
  const today = todayKey(tz);
  const days = Math.max(3, Math.min(14, Number(config.strip_days || 7)));
  const start = addDays(today, -Number(config.strip_back || 1));
  const keys = Array.from({ length: days }, (_, i) => addDays(start, i));
  const keySet = new Set(keys);

  const byDay = new Map(keys.map((k) => [k, []]));
  for (const ev of events) {
    const key = eventDayKey(ev, tz);
    if (keySet.has(key)) byDay.get(key).push(ev);
  }

  const wrap = el('div', {
    style: { height: '100%', display: 'flex', flexDirection: 'column', gap: '1vmin',
             overflow: 'hidden' },
  });
  wrap.append(dayStrip(keys, today, tz, { accent: config.today_colour || '#fb923c' }));

  const grid = el('div', {
    style: {
      flex: '1 1 auto', minHeight: '0', position: 'relative',
      display: 'grid', gridTemplateColumns: `repeat(${days}, 1fr)`,
      // A definite row height, so a busy day scrolls inside its column
      // instead of stretching the row past the bottom of the block.
      gridTemplateRows: 'minmax(0, 1fr)',
      gap: '.4vmin', paddingTop: '.6vmin',
    },
  });

  // Column separators, drawn behind. Faint on purpose: they are there to help
  // the eye align a bar with its day, not to be a table.
  const perDay = dayCap(config, opts, 5);
  for (let i = 0; i < days; i += 1) {
    const dayEvents = byDay.get(keys[i]) || [];
    const { outer, inner } = scrollColumn({
      gap: '.4vmin', speed: opts.speed, enabled: opts.columns, mode: opts.mode,
    });

    for (const ev of dayEvents.slice(0, perDay)) {
      const label = eventTitle(ev.title, opts, {
        fontSize: '1.25vmin', fontWeight: '700', lineHeight: '1.2',
      });
      inner.append(el('div', {
        style: {
          background: ev.colour, color: '#10131a',
          borderRadius: '.6vmin', padding: '.35vmin .5vmin',
          minWidth: '0', overflow: 'hidden', flex: '0 0 auto',
        },
      },
        label,
        ev.all_day ? null : el('div', {
          style: { fontSize: '1.05vmin', opacity: '.75', lineHeight: '1.2' },
        }, timeLabel(ev, tz))));
    }

    // Say how many were dropped rather than silently truncating - a day
    // showing three of nine is a lie the board tells confidently. With
    // auto-scroll on there is nothing to drop, so this never appears.
    if (dayEvents.length > perDay) {
      inner.append(el('div', {
        style: { fontSize: '1.05vmin', color: '#8b93a3', paddingLeft: '.2vmin' },
      }, `+${dayEvents.length - perDay}`));
    }

    grid.append(el('div', {
      style: {
        gridColumn: `${i + 1}`, gridRow: '1',
        borderLeft: i === 0 ? 'none' : '1px solid rgba(255,255,255,.06)',
        display: 'flex', flexDirection: 'column',
        minWidth: '0', overflow: 'hidden',
        paddingLeft: '.3vmin', paddingRight: '.3vmin',
      },
    }, outer));
  }

  wrap.append(grid);
  return wrap;
}

/* Events as floating cards, grouped week by week.
 *
 * One row per week: the days across the top, that week's appointments
 * underneath, then the next week. Asking for fourteen days means a fortnight
 * in two rows, not one strip of fourteen columns.
 */
function bubbles(ctx, events) {
  // ctx.timezone, not ctx.board.timezone - the latter does not exist, and an
  // undefined timeZone makes Intl fall back to the machine's own, which on
  // the appliance is not the board's.
  const { config, timezone: tz } = ctx;
  const opts = scrollOpts(config);
  const today = todayKey(tz);
  const total = Math.max(1, Math.min(56, Number(config.strip_days || 7)));
  const back = Number(config.strip_back || 1);

  // Sunday by default, matching the month grid elsewhere on the board.
  const weekStartsOn = Number(config.week_start ?? 0);

  const stacked = total > 7;

  /* Stacked rows always begin with the week containing TODAY, so a finished
   * week drops off on its own and the rest move up.
   *
   * `strip_back` is a days offset - useful for the single-row view, where
   * seeing yesterday is worth a column - and actively wrong here: at 1, a
   * Sunday snaps into the week that just ended, leading the board with a dead
   * week on the one morning it matters. Whole rows need a whole-week offset,
   * which is what weeks_back is.
   */
  let first;
  if (stacked) {
    const weeksBack = Math.max(0, Number(config.weeks_back || 0));
    first = addDays(weekStartKey(today, weekStartsOn), -7 * weeksBack);
  } else {
    first = addDays(today, -back);
  }

  const rows = stacked ? Math.ceil(total / 7) : 1;
  const perRow = stacked ? 7 : total;

  const wrap = el('div', {
    style: {
      height: '100%', display: 'flex', flexDirection: 'column',
      gap: `${stacked ? 1.2 : 0.8}vmin`, overflow: 'hidden',
    },
  });

  for (let row = 0; row < rows; row += 1) {
    const keys = Array.from({ length: perRow }, (_, i) => addDays(first, row * 7 + i));
    const keySet = new Set(keys);

    const byDay = new Map(keys.map((k) => [k, []]));
    for (const ev of events) {
      const key = eventDayKey(ev, tz);
      if (keySet.has(key)) byDay.get(key).push(ev);
    }

    const block = el('div', {
      style: {
        display: 'flex', flexDirection: 'column', gap: '.5vmin',
        // Rows share the height evenly, and each scrolls nothing - a row that
        // overflows drops its extra cards rather than pushing the next week
        // off the board.
        flex: rows > 1 ? '1 1 0' : '1 1 auto',
        minHeight: '0', overflow: 'hidden',
      },
    });

    block.append(dayStrip(keys, today, tz, {
      accent: config.today_colour || '#fb923c',
    }));

    // A dot per event under each day: which days carry anything, at a glance.
    const dots = el('div', {
      style: {
        display: 'grid', gridTemplateColumns: `repeat(${perRow}, 1fr)`,
        flex: '0 0 auto',
      },
    });
    for (const key of keys) {
      dots.append(el('div', {
        style: {
          display: 'flex', justifyContent: 'center', gap: '.3vmin',
          minHeight: '.9vmin',
        },
      }, ...(byDay.get(key) || []).slice(0, 4).map((ev) => el('span', {
        style: {
          width: '.65vmin', height: '.65vmin', borderRadius: '50%',
          background: ev.colour, display: 'block',
        },
      }))));
    }
    block.append(dots);

    /* This week's appointments, stacked under the day they belong to.
     *
     * Laying them out as one wrapped row put a Wednesday with three and a
     * Thursday with two into a line of five cards with nothing connecting
     * them to their columns. A day's events belong under that day. */
    /* A scrolling column needs a DEFINITE height to have anything to scroll
     * against - with `align-items: start` the row simply grows to its tallest
     * column and the overflow moves outside the block instead of inside it.
     * Same trap as `container-type: size` needing a definite container. */
    const cards = el('div', {
      style: {
        flex: '1 1 auto', minHeight: '0',
        display: 'grid', gridTemplateColumns: `repeat(${perRow}, 1fr)`,
        gridTemplateRows: opts.columns ? 'minmax(0, 1fr)' : 'auto',
        gap: '.35vmin', alignItems: opts.columns ? 'stretch' : 'start',
        overflow: 'hidden',
      },
    });

    const perDayCap = dayCap(config, opts, 4);
    let anyEvents = false;

    for (const key of keys) {
      const dayEvents = byDay.get(key) || [];
      if (dayEvents.length) anyEvents = true;

      /* A day's cards scroll within their own column when there are more of
       * them than the row is tall. `align-items: start` on the grid would let
       * a busy column grow past the row and push the next week off the board,
       * so the column is stretched to the row height and scrolls inside it. */
      const { outer, inner: column } = scrollColumn({
        gap: '.3vmin', speed: opts.speed, enabled: opts.columns, mode: opts.mode,
      });
      Object.assign(outer.style, { alignSelf: 'stretch', height: '100%' });

      for (const ev of dayEvents.slice(0, perDayCap)) {
        column.append(el('div', {
          style: {
            display: 'flex', alignItems: 'flex-start', gap: '.35vmin',
            background: 'rgba(255,255,255,.07)',
            border: '1px solid rgba(255,255,255,.14)',
            borderRadius: '.9vmin',
            padding: '.28vmin .4vmin',
            minWidth: '0', overflow: 'hidden',
          },
        },
          el('span', {
            style: {
              width: '.6vmin', height: '.6vmin', borderRadius: '50%',
              background: ev.colour, flex: '0 0 auto', marginTop: '.35vmin',
            },
          }),
          el('div', { style: { minWidth: '0', flex: '1 1 auto' } },
            eventTitle(ev.title, opts, { fontSize: '1.1vmin', lineHeight: '1.2' }),
            ev.all_day ? null : el('div', {
              style: { fontSize: '.95vmin', color: '#8b93a3', lineHeight: '1.2' },
            }, timeLabel(ev, tz))),
        ));
      }

      // Count what did not fit, per day, rather than dropping it silently.
      if (dayEvents.length > perDayCap) {
        column.append(el('div', {
          style: { fontSize: '.95vmin', color: '#8b93a3', paddingLeft: '.3vmin' },
        }, `+${dayEvents.length - perDayCap}`));
      }

      cards.append(outer);
    }

    if (!anyEvents) {
      cards.replaceChildren(el('div', {
        style: {
          fontSize: '1.15vmin', color: 'rgba(154,160,168,.55)',
          gridColumn: `1 / -1`,
        },
      }, 'Nothing this week'));
    }

    block.append(cards);
    wrap.append(block);

    // A hairline between weeks, so the rows read as separate weeks rather
    // than one long list that happens to have day numbers in it.
    if (stacked && row < rows - 1) {
      wrap.append(el('div', {
        style: {
          height: '1px', background: 'rgba(255,255,255,.08)', flex: '0 0 auto',
        },
      }));
    }
  }

  return wrap;
}

/* ------------------------------------------------------------ registry */

const STYLES = { agenda, month, week, minimonth, timeline, bubbles, list: agenda };

export const calendar = {
  panelled: true,
  mount(ctx) {
    const load = makeLoader(ctx);
    const style = STYLES[ctx.config.style] || agenda;

    const draw = async () => {
      const events = await load();
      // Every redraw throws the old nodes away, and each scroller holds a
      // ResizeObserver. Left attached they accumulate one set per redraw for
      // as long as the board is up - months, at twelve redraws an hour.
      disposeScrollers(ctx.body);
      ctx.body.replaceChildren(style(ctx, events));
    };

    draw();
    // Calendars change slowly; the server caches per source anyway, so this
    // interval controls redraw (and the "Today" highlight rolling over at
    // midnight) more than it controls fetching.
    ctx.interval(draw, Math.max(1, Number(ctx.config.refresh_minutes || 5)) * 60_000);

    return () => disposeScrollers(ctx.body);
  },
};
