/* The widget catalogue.
 *
 * Adding a widget is: write a module exporting { panelled, mount(ctx) }, then
 * add one line to WIDGETS and one entry to CATALOGUE. The admin UI builds its
 * "add widget" palette and its per-widget settings form straight from
 * CATALOGUE, so a new widget becomes configurable without touching the UI.
 *
 * `tools/check_widgets.py` enforces that these stay in step with what the
 * widget code actually reads. Run it after editing this file.
 */

import { clock, date, text, countdown } from './basic.js';
import { calendar } from './calendar.js';
import { weather } from './weather.js';
import { rss, qr } from './feeds.js';
import { video, photos, image, iframe } from './media.js';
import { entity, tracker } from './homeassistant.js';
import { data, gauge, chart } from './data.js';
import { shape, button, markdown, todo, finance, html } from './extras.js';
import { weather_hourly, air_quality, weather_alerts, sunmoon } from './weather2.js';
import { ha_control } from './hacontrol.js';
import { ha_history, ha_camera, ha_media, ha_glance } from './ha2.js';
import { tides, airport_delays } from './local.js';
import { obsidian_notes } from './notes.js';
import { postit } from './postit.js';
import { tasks } from './tasks.js';
import { kanban } from './kanban.js';
import { splist } from './splist.js';
import { quote, bible_verse, word_of_day, dad_joke, advice, on_this_day }
  from './daily.js';

export const WIDGETS = {
  clock, date, text, countdown,
  calendar, weather, rss, qr,
  video, photos, image, iframe,
  entity, tracker,
  data, gauge, chart,
  shape, button, markdown, todo, finance, html,
  weather_hourly, air_quality, weather_alerts, sunmoon,
  ha_control,
  ha_history, ha_camera, ha_media, ha_glance,
  tides, airport_delays,
  obsidian_notes, postit, tasks, kanban, splist,
  quote, bible_verse, word_of_day, dad_joke, advice, on_this_day,
};

/* Field types the admin form understands:
 *   text | number | bool | select | colour | date | textarea | password
 *   source | sources | entities | todolist | layout | person | people
 */
export const CATALOGUE = {
  // ------------------------------------------------------------------ Time
  clock: {
    label: 'Clock', icon: '🕐', group: 'Time',
    defaults: { w: 60, h: 18 },
    fields: [
      { key: 'hour12', type: 'bool', label: '12-hour', default: true },
      { key: 'show_seconds', type: 'bool', label: 'Show seconds', default: false },
      { key: 'show_meridiem', type: 'bool', label: 'Show AM/PM', default: true },
      { key: 'pad_hour', type: 'bool', label: 'Leading zero', default: false },
      { key: 'weight', type: 'number', label: 'Font weight', default: 200 },
      { key: 'timezone', type: 'text', label: 'Timezone override', placeholder: 'board default' },
      { key: 'max_size', type: 'number', label: 'Max size (vmin)', default: 40 },
    ],
  },
  date: {
    label: 'Date', icon: '📅', group: 'Time',
    defaults: { w: 60, h: 8 },
    fields: [
      { key: 'short', type: 'bool', label: 'Abbreviated', default: false },
      { key: 'weekday', type: 'bool', label: 'Show weekday', default: true },
      { key: 'show_year', type: 'bool', label: 'Show year', default: false },
      { key: 'weight', type: 'number', label: 'Font weight', default: 300 },
      { key: 'timezone', type: 'text', label: 'Timezone override', placeholder: 'board default' },
      { key: 'max_size', type: 'number', label: 'Max size (vmin)', default: 12 },
    ],
  },
  countdown: {
    label: 'Countdown', icon: '⏳', group: 'Time',
    defaults: { w: 30, h: 15 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'target', type: 'date', label: 'Target date/time' },
      { key: 'done_text', type: 'text', label: 'Text when reached', default: 'Now' },
      { key: 'max_size', type: 'number', label: 'Max size (vmin)', default: 16 },
    ],
  },

  // -------------------------------------------------------------- Calendar
  calendar: {
    label: 'Calendar', icon: '🗓️', group: 'Calendar',
    defaults: { w: 90, h: 40 },
    fields: [
      { key: 'title', type: 'text', label: 'Title', default: 'Calendar' },
      { key: 'style', type: 'select', label: 'Style', default: 'agenda',
        options: [
          { value: 'agenda', label: 'Agenda (best for portrait)' },
          { value: 'minimonth', label: 'Mini month (numbers only)' },
          { value: 'month', label: 'Month grid (with events)' },
          { value: 'week', label: 'Week' },
          { value: 'timeline', label: 'Timeline — coloured bars on a day strip' },
          { value: 'bubbles', label: 'Bubbles — floating cards under a day strip' },
        ] },
      { key: 'strip_days', type: 'number', label: 'Days to show', default: 7,
        help: 'Timeline and Bubbles. More than 7 stacks into week rows: each '
            + 'week on its own line with that week’s appointments below it.' },
      { key: 'week_start', type: 'select', label: 'Weeks start on', default: 0,
        options: [{ value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' }],
        help: 'Bubbles, when stacked. Rows snap to week boundaries so the '
            + 'weekday columns line up between them.' },
      { key: 'strip_back', type: 'number', label: 'Days before today', default: 1,
        help: 'Single-row only. How far left of today the strip starts, so '
            + 'today is not jammed against the edge. Ignored once the view '
            + 'stacks into weeks.' },
      { key: 'weeks_back', type: 'number', label: 'Weeks before this one',
        default: 0,
        help: 'Stacked view. 0 leads with the week containing today, so a '
            + 'finished week drops off by itself and the rest move up.' },
      { key: 'today_colour', type: 'colour', label: 'Today marker',
        default: '#fb923c',
        help: 'The filled disc on the day strip.' },
      { key: 'source_ids', type: 'sources', label: 'Calendars',
        kinds: ['ical', 'google', 'graph'],
        chosenHint: 'Each shows in its own colour — change a colour on the Sources tab.',
        emptyHint: 'None ticked, so every enabled calendar is included.',
        help: 'Leave empty to include every enabled calendar.' },
      { key: 'days', type: 'number', label: 'Days ahead', default: 45 },
      { key: 'max_items', type: 'number', label: 'Max items (agenda)', default: 12 },
      { key: 'max_per_day', type: 'number', label: 'Max per day (month/week)', default: 3 },
      { key: 'week_starts', type: 'select', label: 'Week starts', default: 'sunday',
        options: [{ value: 'sunday', label: 'Sunday' }, { value: 'monday', label: 'Monday' }] },
      { key: 'vertical', type: 'bool', label: 'Stack week vertically', default: false,
        help: 'Week style only. Turn on for portrait boards.' },
      { key: 'event_flow', type: 'select', label: 'A day’s events run',
        default: 'column', when: { style: 'agenda' },
        options: [
          { value: 'column', label: 'Down the block, one per line' },
          { value: 'row', label: 'Side by side, left to right' },
        ],
        help: 'Down the block suits a tall, narrow board where a busy day '
            + 'reads as a list. Side by side suits a WIDE block showing a day '
            + 'or two, where the same events would otherwise be a short column '
            + 'in a mostly empty rectangle. Set “Days to show” to 1 '
            + 'for a single day laid out across the width.' },
      { key: 'events_per_row', type: 'number', label: 'Events across',
        default: 0, when: { event_flow: 'row' },
        help: '0 fits as many as the width allows and wraps the rest onto a '
            + 'second line. Set a number to force exactly that many across, '
            + 'which keeps the cards the same size from day to day.' },
      { key: 'card_lines', type: 'number', label: 'Title lines per card',
        default: 2, when: { event_flow: 'row' },
        help: 'A side-by-side card wraps its title rather than sliding it '
            + 'sideways — a card is already narrow, and something moving '
            + 'inside it is harder to read than two lines.' },
      { key: 'scale', type: 'number', label: 'Agenda text scale', default: 1,
        help: '1 is normal. Raise it for a board read from across a room.' },
      { key: 'today_colour', type: 'colour', label: 'Today marker (mini month)',
        default: '#d0342c' },
      { key: 'show_busy_dots', type: 'bool', label: 'Dot on days with events', default: true,
        help: 'Mini month only.' },
      { key: 'empty_text', type: 'text', label: 'Text when empty', default: 'Nothing scheduled' },
      { key: 'scroll_overflow', type: 'bool', label: 'Scroll when it does not fit',
        default: true,
        help: 'A day with more appointments than its box can hold scrolls '
            + 'them up and down instead of hiding them behind a "+3". While '
            + 'this is on the two Max settings above are ignored — the block '
            + 'shows everything and moves.' },
      { key: 'scroll_mode', type: 'select', label: 'How it scrolls',
        default: 'bounce',
        options: [
          { value: 'bounce', label: 'Down, then back up' },
          { value: 'continuous', label: 'Continuous — one way, on a loop' },
        ],
        help: 'Continuous runs one way forever and wraps with no seam, like '
            + 'credits. Better for a long list, where bouncing puts the last '
            + 'item on screen for only the instant before the list turns '
            + 'round. Down-and-back is easier to read a short list from — you '
            + 'keep your place.' },
      { key: 'scroll_titles', type: 'bool', label: 'Scroll long titles',
        default: true,
        help: 'A title too long for its column slides sideways and back '
            + 'instead of being cut off with an ellipsis.' },
      { key: 'scroll_speed', type: 'number', label: 'Scroll speed (px/sec)',
        default: 22,
        help: 'Travel speed, not cycle length, so a long list takes '
            + 'proportionally longer rather than whipping past. Titles move '
            + 'at half again this — reading is faster than scanning.' },
      { key: 'refresh_minutes', type: 'number', label: 'Redraw every (min)', default: 5,
        help: 'Also what rolls the Today highlight over at midnight.' },
    ],
  },

  // --------------------------------------------------------------- Weather
  weather: {
    label: 'Weather', icon: '⛅', group: 'Weather',
    defaults: { w: 45, h: 22 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'source_id', type: 'source', label: 'Location', kinds: ['weather'] },
      { key: 'layout', type: 'select', label: 'Show', default: 'full',
        options: [{ value: 'full', label: 'Current conditions + forecast' },
                  { value: 'compact', label: 'Current conditions only' },
                  { value: 'forecast', label: 'Forecast only (no current)' }] },
      { key: 'days', type: 'number', label: 'Forecast days', default: 5,
        help: 'How many days the forecast strip shows.' },
      { key: 'forecast_layout', type: 'select', label: 'Forecast direction',
        default: 'row',
        options: [{ value: 'row', label: 'Across (a strip)' },
                  { value: 'column', label: 'Down (a list)' }],
        help: 'A list reads better in a tall, narrow block.' },
      { key: 'show_feels_like', type: 'bool', label: 'Show feels-like', default: true },
      { key: 'show_precip', type: 'bool', label: 'Show rain chance', default: true },
      { key: 'animate', type: 'bool', label: 'Animate the current icon',
        default: true,
        help: 'Rays turn, rain falls, lightning flashes — on the current '
            + 'conditions only. Forecast icons stay still on purpose. Off '
            + 'automatically for anyone whose system asks for reduced motion.' },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh every (min)', default: 15 },
    ],
  },
  weather_hourly: {
    label: 'Hourly forecast', icon: '🕘', group: 'Weather',
    defaults: { w: 90, h: 14 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'source_id', type: 'source', label: 'Location', kinds: ['weather'] },
      { key: 'hours', type: 'number', label: 'Hours ahead', default: 12 },
      { key: 'show_precip', type: 'bool', label: 'Show rain chance', default: true },
      { key: 'show_wind', type: 'bool', label: 'Show wind', default: false },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh (min)', default: 30 },
    ],
  },
  air_quality: {
    label: 'Air quality', icon: '🌫️', group: 'Weather',
    defaults: { w: 20, h: 18 },
    fields: [
      { key: 'title', type: 'text', label: 'Title', default: 'Air quality' },
      { key: 'source_id', type: 'source', label: 'Location', kinds: ['weather'] },
      { key: 'scale', type: 'select', label: 'Scale', default: 'us',
        options: [{ value: 'us', label: 'US AQI' }, { value: 'eu', label: 'European AQI' }] },
      { key: 'show_detail', type: 'bool', label: 'Show PM2.5 / PM10', default: false },
      { key: 'size', type: 'number', label: 'Value size (vmin)', default: 4.5 },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh (min)', default: 30 },
    ],
  },
  weather_alerts: {
    label: 'Weather alerts', icon: '⚠️', group: 'Weather',
    defaults: { w: 90, h: 12 },
    fields: [
      { key: 'source_id', type: 'source', label: 'Location', kinds: ['weather'] },
      { key: 'max_items', type: 'number', label: 'Max alerts', default: 2 },
      { key: 'show_headline', type: 'bool', label: 'Show headline', default: true },
      { key: 'hide_when_clear', type: 'bool', label: 'Hide when nothing active', default: true,
        help: 'On by default: a permanent "no alerts" box wastes the best space on the board.' },
      { key: 'clear_text', type: 'text', label: 'Text when clear', default: 'No active alerts' },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 2 },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh (min)', default: 10 },
    ],
  },
  sunmoon: {
    label: 'Sun & moon', icon: '🌙', group: 'Weather',
    defaults: { w: 25, h: 18 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'source_id', type: 'source', label: 'Location', kinds: ['weather'] },
      { key: 'show_sun', type: 'bool', label: 'Show sunrise/sunset', default: true },
      { key: 'show_moon', type: 'bool', label: 'Show moon phase', default: true },
      { key: 'hour12', type: 'bool', label: '12-hour times', default: true },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh (min)', default: 60 },
    ],
  },

  // ------------------------------------------------------------------ Data
  rss: {
    label: 'News / RSS', icon: '📰', group: 'News',
    defaults: { w: 45, h: 30 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'source_ids', type: 'sources', label: 'Feeds', kinds: ['rss'],
        chosenHint: 'They merge into one stream, newest first.',
        emptyHint: 'Nothing ticked here — the single feed below is used instead.',
        empty: 'No news feeds have been added yet.',
        emptyAction: 'Add a feed',
        help: 'Tick as many as you like — several feeds become one stream, '
            + 'newest first, with each headline labelled by the outlet it came '
            + 'from.' },
      { key: 'source_id', type: 'source', label: 'Feed (single)', kinds: ['rss'],
        help: 'What boards made before multiple feeds existed use. Leave it '
            + 'set or clear it — either way it is included.' },
      { key: 'style', type: 'select', label: 'Show', default: 'list',
        options: [
          { value: 'list', label: 'A list of headlines' },
          { value: 'ticker', label: 'One article at a time' },
        ] },
      { key: 'rotate', type: 'bool', label: 'Rotate through articles',
        default: false,
        help: 'A list normally shows the newest few. Rotating cycles through '
            + 'the whole feed. "One article at a time" always rotates.' },
      { key: 'rotate_seconds', type: 'number', label: 'Seconds per article',
        default: 12 },
      { key: 'max_items', type: 'number', label: 'Headlines (list)', default: 5,
        help: '0 shows every article the feed publishes. A long list is hard '
            + 'to read on a wall \u2014 to see them all, use "One article at a '
            + 'time", which rotates through the whole feed.' },
      { key: 'show_source', type: 'bool', label: 'Show feed name', default: true },
      { key: 'show_age', type: 'bool', label: 'Show how old', default: true },
      { key: 'show_summary', type: 'bool', label: 'Show article text',
        default: true },
      { key: 'summary_lines', type: 'number', label: 'Lines of article text',
        default: 2 },
      { key: 'title_lines', type: 'number', label: 'Lines of headline', default: 2 },
      { key: 'size', type: 'number', label: 'Headline size (vmin)', default: 1.8 },
      { key: 'source_label', type: 'text', label: 'Override feed name' },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh every (min)',
        default: 20 },
    ],
  },
  data: {
    label: 'Data value', icon: '🔢', group: 'Data',
    defaults: { w: 25, h: 15 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'source_id', type: 'source', label: 'Data source', kinds: ['rest'] },
      { key: 'variable', type: 'text', label: 'Or a pushed variable',
        placeholder: 'name of a webhook variable',
        help: 'What a webhook writes. Takes precedence over the data source.' },
      { key: 'path', type: 'text', label: 'Path into the response',
        placeholder: 'results.0.temperature',
        help: 'Dotted keys and [n] indexing. Use Test on the source to see the shape.' },
      { key: 'label', type: 'text', label: 'Caption' },
      { key: 'unit', type: 'text', label: 'Unit' },
      { key: 'prefix', type: 'text', label: 'Prefix' },
      { key: 'decimals', type: 'number', label: 'Decimal places', placeholder: 'auto' },
      { key: 'multiply', type: 'number', label: 'Multiply by', default: 1,
        help: 'For unit conversion — bytes to GB is 0.000000001.' },
      { key: 'offset', type: 'number', label: 'Then add', default: 0 },
      { key: 'compact', type: 'bool', label: 'Shorten big numbers (1.2M)', default: false },
      { key: 'size', type: 'number', label: 'Size (vmin)', default: 4 },
      { key: 'colour', type: 'colour', label: 'Colour', default: '#5b9dd9' },
      { key: 'empty_text', type: 'text', label: 'Text when missing', default: '--' },
      { key: 'true_text', type: 'text', label: 'Text when true', default: 'Yes' },
      { key: 'false_text', type: 'text', label: 'Text when false', default: 'No' },
      { key: 'align', type: 'select', label: 'Align', default: 'center',
        options: [{ value: 'flex-start', label: 'Left' }, { value: 'center', label: 'Centre' },
                  { value: 'flex-end', label: 'Right' }] },
      { key: 'refresh_seconds', type: 'number', label: 'Refresh (s)', default: 60 },
    ],
  },
  gauge: {
    label: 'Gauge', icon: '🎚️', group: 'Data',
    defaults: { w: 22, h: 22 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'source_id', type: 'source', label: 'Data source', kinds: ['rest'] },
      { key: 'variable', type: 'text', label: 'Or a pushed variable',
        placeholder: 'name of a webhook variable',
        help: 'What a webhook writes. Takes precedence over the data source.' },
      { key: 'path', type: 'text', label: 'Path into the response' },
      { key: 'min', type: 'number', label: 'Minimum', default: 0 },
      { key: 'max', type: 'number', label: 'Maximum', default: 100 },
      { key: 'unit', type: 'text', label: 'Unit' },
      { key: 'label', type: 'text', label: 'Caption' },
      { key: 'thickness', type: 'number', label: 'Ring thickness', default: 9 },
      { key: 'colour', type: 'colour', label: 'Colour', default: '#5b9dd9' },
      { key: 'decimals', type: 'number', label: 'Decimal places', placeholder: 'auto' },
      { key: 'size', type: 'number', label: 'Value size (vmin)', default: 3.4 },
      { key: 'multiply', type: 'number', label: 'Multiply by', default: 1 },
      { key: 'offset', type: 'number', label: 'Then add', default: 0 },
      { key: 'compact', type: 'bool', label: 'Shorten big numbers', default: false },
      { key: 'empty_text', type: 'text', label: 'Text when missing', default: '--' },
      { key: 'refresh_seconds', type: 'number', label: 'Refresh (s)', default: 60 },
    ],
  },
  chart: {
    label: 'Chart', icon: '📈', group: 'Data',
    defaults: { w: 40, h: 25 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'source_id', type: 'source', label: 'Data source', kinds: ['rest'] },
      { key: 'variable', type: 'text', label: 'Or a pushed variable',
        placeholder: 'name of a webhook variable',
        help: 'What a webhook writes. Takes precedence over the data source.' },
      { key: 'path', type: 'text', label: 'Path to the array',
        help: 'Must point at a list — of numbers, or of objects.' },
      { key: 'chart', type: 'select', label: 'Type', default: 'line',
        options: [{ value: 'line', label: 'Line' }, { value: 'area', label: 'Area' },
                  { value: 'bar', label: 'Bar' }, { value: 'pie', label: 'Pie' }] },
      { key: 'x_key', type: 'text', label: 'Label key', placeholder: 'for objects' },
      { key: 'y_key', type: 'text', label: 'Value key', placeholder: 'for objects' },
      { key: 'max_points', type: 'number', label: 'Max points', default: 60 },
      { key: 'min', type: 'number', label: 'Y minimum', placeholder: 'auto' },
      { key: 'max', type: 'number', label: 'Y maximum', placeholder: 'auto' },
      { key: 'colour', type: 'colour', label: 'Colour', default: '#5b9dd9' },
      { key: 'thickness', type: 'number', label: 'Line width', default: 1.6 },
      { key: 'unit', type: 'text', label: 'Unit' },
      { key: 'decimals', type: 'number', label: 'Decimal places', placeholder: 'auto' },
      { key: 'compact', type: 'bool', label: 'Shorten big numbers', default: false },
      { key: 'show_last', type: 'bool', label: 'Show latest value', default: true },
      { key: 'refresh_seconds', type: 'number', label: 'Refresh (s)', default: 60 },
    ],
  },
  finance: {
    label: 'Stocks / crypto / FX', icon: '💹', group: 'Data',
    defaults: { w: 28, h: 20 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'market', type: 'select', label: 'Market', default: 'stocks',
        options: [{ value: 'stocks', label: 'Stocks' }, { value: 'crypto', label: 'Crypto' },
                  { value: 'currency', label: 'Currency' }] },
      { key: 'symbols', type: 'text', label: 'Symbols', placeholder: 'AAPL, MSFT',
        help: 'Crypto uses CoinGecko ids (bitcoin, ethereum). Currency uses codes.' },
      { key: 'base', type: 'text', label: 'Base currency', default: 'USD' },
      { key: 'symbol_prefix', type: 'text', label: 'Price prefix', placeholder: '$' },
      { key: 'decimals', type: 'number', label: 'Decimal places', placeholder: 'auto' },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 2.1 },
      { key: 'refresh_seconds', type: 'number', label: 'Refresh (s)', default: 900 },
    ],
  },

  // -------------------------------------------------------- Home Assistant
  entity: {
    label: 'Entity value', icon: '🏠', group: 'Smart home',
    defaults: { w: 45, h: 18 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'source_id', type: 'source', label: 'Home Assistant', kinds: ['homeassistant'] },
      { key: 'entity_ids', type: 'entities', label: 'Entities',
        help: 'Sensors, switches, climate, media players — anything HA exposes.' },
      { key: 'columns', type: 'number', label: 'Columns', default: 1 },
      { key: 'size', type: 'number', label: 'Value size (vmin)', default: 3.6 },
      { key: 'decimals', type: 'number', label: 'Decimal places', placeholder: 'auto' },
      { key: 'show_names', type: 'bool', label: 'Show entity names', default: true },
      { key: 'refresh_seconds', type: 'number', label: 'Refresh (s)', default: 15 },
    ],
  },
  /* One widget can show several people, but they then share a block and move
   * together. For chips that move independently, add one tracker per person
   * with a single entity each - which is why 'People' is a list rather than a
   * single picker. */
  tracker: {
    label: 'People / device tracker', icon: '📍', group: 'Smart home',
    defaults: { w: 45, h: 25 },
    fields: [
      { key: 'title', type: 'text', label: 'Title', default: 'Where everyone is' },
      { key: 'source_id', type: 'source', label: 'Home Assistant', kinds: ['homeassistant'] },
      { key: 'entity_ids', type: 'entities', label: 'People', domain: 'person',
        help: 'Leave empty to show every person Home Assistant knows about. '
            + 'Life360 members appear here automatically once the Life360 '
            + 'integration is set up inside Home Assistant.' },
      { key: 'layout', type: 'select', label: 'Style', default: 'list',
        options: [{ value: 'list', label: 'List — one per row' },
                  { value: 'chips', label: 'Chips — compact pills' }],
        help: 'Chips wrap to fill the block and draw the battery as a ring '
            + 'around each face, which reads from across a room where a '
            + 'percentage does not.' },
      { key: 'chip_size', type: 'number', label: 'Chip size (%)', default: 100,
        help: 'Chips only. A percentage of the size that fits the block: 100 '
            + 'fits it, 120 is a fifth larger, 80 is smaller. The avatar, the '
            + 'battery, the phone icon, the text and the pill all scale '
            + 'together.' },
      { key: 'home_colour', type: 'colour', label: 'Location colour',
        default: '#60a5fa',
        help: 'Home and named zones — both mean somewhere known.' },
      { key: 'away_colour', type: 'colour', label: 'Away colour', default: '#fb923c' },
      { key: 'chip_style', type: 'select', label: 'Chip background', default: 'solid',
        options: [{ value: 'solid', label: 'Solid tint' },
                  { value: 'glass', label: 'Frosted glass' },
                  { value: 'none', label: 'None — text only' }],
        help: 'Chips only. Frosts the pill itself rather than the block around '
            + 'it, which is what the Panel setting would do.' },
      { key: 'centre', type: 'bool', label: 'Centre the chips', default: true,
        help: 'Chips only.' },
      { key: 'show_name', type: 'bool', label: 'Show the name', default: false,
        help: 'Chips only. Off by default when there is a profile photo — the '
            + 'face already says who it is, and the width is better spent on '
            + 'where they are. Always shown when there is no photo.' },
      { key: 'short_names', type: 'bool', label: 'First names only', default: true,
        help: 'Home Assistant returns the full name; a chip is a glance, and a '
            + 'surname that never varies is width spent on nothing.' },
      { key: 'show_phone', type: 'bool', label: 'Show phone state', default: true,
        help: 'Idle, Ringing or On call, read from the companion app phone_state '
            + 'sensor. Ringing and on-call pulse.' },
      { key: 'show_battery', type: 'bool', label: 'Show battery', default: true },
      { key: 'show_updated', type: 'bool', label: 'Show last update', default: true },
      { key: 'refresh_seconds', type: 'number', label: 'Refresh (s)', default: 30 },
    ],
  },

  ha_history: {
    label: 'HA History Graph', icon: '📈', group: 'Smart home',
    defaults: { w: 40, h: 20 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'source_id', type: 'source', label: 'Home Assistant', kinds: ['homeassistant'] },
      { key: 'entity', type: 'text', label: 'Entity',
        placeholder: 'sensor.living_room_temperature',
        help: 'One numeric entity. Non-numeric states are skipped rather than '
            + 'counted as zero, so a gap in the line is a real gap.' },
      { key: 'hours', type: 'number', label: 'Hours of history', default: 24,
        help: 'Up to a week. The server downsamples, so a long window costs '
            + 'the board nothing.' },
      { key: 'points', type: 'number', label: 'Detail (points)', default: 60,
        help: 'How many points the line is drawn from. The server averages '
            + 'into this many buckets, so more is smoother data and a busier '
            + 'line, not more work for the board.' },
      { key: 'unit', type: 'text', label: 'Unit', placeholder: '°F' },
      { key: 'decimals', type: 'number', label: 'Decimal places', default: 1 },
      { key: 'colour', type: 'text', label: 'Line colour', placeholder: 'accent' },
      { key: 'fill', type: 'bool', label: 'Shade under the line', default: true },
      { key: 'show_range', type: 'bool', label: 'Show min/max and window', default: true,
        help: 'Worth leaving on: the graph is scaled to its own range, not to '
            + 'zero, so the numbers are what make the shape readable.' },
      { key: 'size', type: 'number', label: 'Value size (vmin)', default: 2.6 },
      { key: 'align', type: 'select', label: 'Value align', default: 'center',
        options: [{ value: 'center', label: 'Centre' }, { value: 'left', label: 'Left' }] },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh (min)', default: 5 },
    ],
  },
  ha_camera: {
    label: 'HA Camera', icon: '📷', group: 'Smart home',
    defaults: { w: 40, h: 30 },
    fields: [
      { key: 'source_id', type: 'source', label: 'Home Assistant', kinds: ['homeassistant'] },
      { key: 'entity', type: 'text', label: 'Camera entity',
        placeholder: 'camera.front_door' },
      { key: 'refresh_seconds', type: 'number', label: 'New frame every (s)', default: 10,
        help: 'Still frames, not a stream - a Pi will not keep up with several '
            + 'live feeds, and a wall rarely needs one.' },
      { key: 'fit', type: 'select', label: 'Fit', default: 'cover',
        options: [{ value: 'cover', label: 'Fill (crop)' },
                  { value: 'contain', label: 'Fit (letterbox)' }] },
      { key: 'label', type: 'text', label: 'Caption', placeholder: 'Front door' },
      { key: 'size', type: 'number', label: 'Caption size (vmin)', default: 1.5 },
    ],
  },
  ha_media: {
    label: 'HA Now Playing', icon: '🎵', group: 'Smart home',
    defaults: { w: 40, h: 14 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'source_id', type: 'source', label: 'Home Assistant', kinds: ['homeassistant'] },
      { key: 'entities', type: 'text', label: 'Media players',
        placeholder: 'media_player.living_room, media_player.kitchen',
        help: 'Comma separated. Covers Spotify, Sonos, Plex and anything else '
            + 'that reaches Home Assistant as a media player.' },
      { key: 'hide_idle', type: 'bool', label: 'Hide when stopped', default: true },
      { key: 'idle_text', type: 'text', label: 'Text when nothing plays',
        default: 'Nothing playing' },
      { key: 'show_art', type: 'bool', label: 'Show album art', default: true },
      { key: 'show_source', type: 'bool', label: 'Show the app name', default: false },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 1.8 },
      { key: 'refresh_seconds', type: 'number', label: 'Refresh (s)', default: 15 },
    ],
  },
  ha_glance: {
    label: 'HA Glance Grid', icon: '🔢', group: 'Smart home',
    defaults: { w: 40, h: 18 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'source_id', type: 'source', label: 'Home Assistant', kinds: ['homeassistant'] },
      { key: 'entities', type: 'text', label: 'Entities',
        placeholder: 'sensor.temp, sensor.humidity, binary_sensor.door',
        help: 'Comma separated. For the dozen things you want visible at once '
            + 'without a dozen blocks to place and keep aligned.' },
      { key: 'columns', type: 'number', label: 'Columns', default: 3 },
      { key: 'show_names', type: 'bool', label: 'Show names', default: true },
      { key: 'size', type: 'number', label: 'Value size (vmin)', default: 1.6 },
      { key: 'refresh_seconds', type: 'number', label: 'Refresh (s)', default: 30 },
    ],
  },
  tides: {
    label: 'Tides', icon: '🌊', group: 'Weather',
    defaults: { w: 30, h: 20 },
    fields: [
      { key: 'title', type: 'text', label: 'Title', default: 'Tides' },
      { key: 'source_id', type: 'source', label: 'Location from', kinds: ['weather'],
        help: 'Borrows the weather source’s coordinates and finds the nearest '
            + 'NOAA station itself — nothing else to look up.' },
      { key: 'station', type: 'text', label: 'NOAA station override',
        placeholder: 'nearest',
        help: 'Only if the nearest station is not the water you care about.' },
      { key: 'count', type: 'number', label: 'How many to show', default: 4 },
      { key: 'days', type: 'number', label: 'Days to look ahead', default: 2 },
      { key: 'show_day', type: 'bool', label: 'Show the weekday', default: true },
      { key: 'show_station', type: 'bool', label: 'Show the station name', default: true },
      { key: 'high_colour', type: 'text', label: 'High tide colour', placeholder: '#5b9dd9' },
      { key: 'low_colour', type: 'text', label: 'Low tide colour', placeholder: '#9aa0a8' },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 1.7 },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh (min)', default: 180,
        help: 'Predictions, not observations — they do not change during the day.' },
    ],
  },
  airport_delays: {
    label: 'Airport Delays', icon: '✈️', group: 'Utility',
    defaults: { w: 35, h: 18 },
    fields: [
      { key: 'title', type: 'text', label: 'Title', default: 'Airport delays' },
      { key: 'codes', type: 'text', label: 'Airports', placeholder: 'BOS, PWM, JFK',
        help: 'Comma separated, three-letter codes. Leave empty for every '
            + 'delayed US airport — on a bad afternoon that is a long list.' },
      { key: 'max_items', type: 'number', label: 'Most to show', default: 5 },
      { key: 'show_detail', type: 'bool', label: 'Show the detail line', default: true },
      { key: 'clear_text', type: 'text', label: 'Text when all clear',
        placeholder: 'No delays at BOS, PWM' },
      { key: 'colour', type: 'text', label: 'Airport code colour', placeholder: '#d9a06b' },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 1.6 },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh (min)', default: 15 },
    ],
  },
  obsidian_notes: {
    label: 'Obsidian notes', icon: '🗒️', group: 'Notes',
    defaults: { w: 45, h: 25 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'source_id', type: 'source', label: 'Vault folder', kinds: ['obsidian'],
        help: 'An Obsidian source points at ONE folder. Add a second source '
            + 'for a different folder.' },
      { key: 'mode', type: 'select', label: 'Show', default: 'excerpts',
        options: [
          { value: 'excerpts', label: 'Excerpts, one at a time' },
          { value: 'note', label: 'One whole note, scrolling' },
        ],
        help: 'Excerpts are for glancing at; a whole note is for actually '
            + 'reading something through.' },
      { key: 'pick', type: 'select', label: 'Which note', default: 'daily',
        options: [
          { value: 'daily', label: 'One a day — changes at midnight' },
          { value: 'random', label: 'A random one each refresh' },
          { value: 'newest', label: 'Always the newest' },
        ] },
      { key: 'kinds', type: 'select', label: 'Which parts', default: 'all',
        options: [
          { value: 'all', label: 'Everything' },
          { value: 'quote', label: 'Quotes only — scripture and pull-quotes' },
          { value: 'bullet', label: 'Bullets only' },
          { value: 'paragraph', label: 'Paragraphs only' },
          { value: 'quote,bullet', label: 'Quotes and bullets' },
        ] },
      { key: 'seconds', type: 'number', label: 'Seconds per excerpt', default: 30,
        when: { mode: 'excerpts' } },
      { key: 'shuffle', type: 'bool', label: 'Random order', default: true,
        when: { mode: 'excerpts' },
        help: 'Deals every excerpt once before any of them come round again.' },
      { key: 'scroll', type: 'bool', label: 'Scroll if it overflows', default: true,
        when: { mode: 'note' } },
      { key: 'scroll_mode', type: 'select', label: 'How it scrolls',
        default: 'bounce', when: { mode: 'note' },
        options: [
          { value: 'bounce', label: 'Down, then back up' },
          { value: 'continuous', label: 'Continuous — one way, on a loop' },
        ],
        help: 'Continuous suits a whole note: it reaches the end and comes '
            + 'round to the top rather than reading itself backwards.' },
      { key: 'scroll_speed', type: 'number', label: 'Scroll speed', default: 18,
        when: { mode: 'note' },
        help: 'Higher is slower — it is seconds for a full pass.' },
      { key: 'show_heading', type: 'bool', label: 'Show the section heading',
        default: true,
        help: '"Day 3: The Glue of the Universe" is most of the context a '
            + 'single bullet needs to make sense out of its note.' },
      { key: 'show_title', type: 'bool', label: 'Show the note title', default: true },
      { key: 'align', type: 'select', label: 'Align', default: 'left',
        options: [{ value: 'left', label: 'Left' },
                  { value: 'center', label: 'Centre' }] },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 1.9,
        help: 'Long excerpts step down from this on their own so they fit.' },
      { key: 'min_chars', type: 'number', label: 'Shortest excerpt', default: 40,
        help: 'Anything shorter is skipped — a two-word bullet on a wall reads '
            + 'as a rendering fault rather than as content.' },
      { key: 'max_chars', type: 'number', label: 'Longest excerpt', default: 400 },
      { key: 'refresh_minutes', type: 'number', label: 'Re-read the vault (min)',
        default: 60 },
    ],
  },
  tasks: {
    label: 'Task list', icon: 'check', group: 'Lists and tasks',
    defaults: { w: 34, h: 55 },
    fields: [
      { key: 'heading', type: 'text', label: 'Heading', placeholder: 'Today' },
      { key: 'backend', type: 'select', label: 'Where the tasks live',
        default: 'local',
        options: [
          { value: 'local', label: 'A LifeBoard list (no account needed)' },
          { value: 'google', label: 'Google Tasks' },
          { value: 'graph', label: 'Microsoft To Do' },
        ] },
      { key: 'source_id', type: 'source', label: 'Account',
        kinds: ['google', 'graph'], when: { backend: ['google', 'graph'] },
        help: 'The same account a calendar source uses. Tasks needs its own '
            + 'permission, so an account connected before this existed has to '
            + 'be reconnected once.' },
      { key: 'list_id', type: 'tasklist', label: 'List',
        help: 'Reminders, Grocery List, or whichever list you keep on your '
            + 'phone.' },
      { key: 'group_by', type: 'select', label: 'Group by', default: 'none',
        options: [
          { value: 'none', label: 'Nothing \u2014 one flat list' },
          { value: 'due', label: 'When it is due' },
          { value: 'assignee', label: 'Who it is for' },
        ],
        help: 'A shopping list wants no grouping. A work list is much easier '
            + 'to read with Overdue and Today separated out.' },
      { key: 'interactive', type: 'bool', label: 'Touch to complete', default: true,
        help: 'Tapping the box ticks the task off. For a real Google or '
            + 'Microsoft account this ALSO needs \u201cLet the board complete '
            + 'tasks\u201d on that account, on the Sources tab \u2014 the board '
            + 'refuses to change somebody\u2019s account until you say so.' },
      { key: 'remove_when_done', type: 'bool', label: 'Take it off the board',
        default: true,
        help: 'A ticked task fades out after a couple of seconds. Tap it again '
            + 'while it is fading to undo \u2014 which is the only undo a wall '
            + 'display can offer.' },
      { key: 'show_done', type: 'bool', label: 'Show completed tasks', default: false },
      { key: 'show_header', type: 'bool', label: 'Show the heading', default: true },
      { key: 'show_count', type: 'bool', label: 'Show how many are left', default: true },
      { key: 'show_due', type: 'bool', label: 'Show due dates', default: true },
      { key: 'show_notes', type: 'bool', label: 'Show notes under each task',
        default: false },
      { key: 'max_items', type: 'number', label: 'Most tasks to show', default: 25 },
      { key: 'title_lines', type: 'number', label: 'Lines per task', default: 2,
        help: 'A task you cannot read the end of is a task you cannot decide '
            + 'about, so these wrap rather than being cut off.' },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 2.4,
        help: 'Bigger than most widgets on purpose: this one is meant to be '
            + 'read and touched from arm\u2019s length.' },
      { key: 'empty_text', type: 'text', label: 'Text when empty',
        placeholder: 'Nothing to do' },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh (min)', default: 2,
        help: 'How long after adding a task on your phone it appears here. '
            + 'Shorter than most widgets because this is the one you stand in '
            + 'front of waiting - a task added in the kitchen should not take '
            + 'five minutes to show up. Completing something on the board is '
            + 'immediate either way; this only affects things added elsewhere.' },
    ],
  },
  kanban: {
    label: 'Kanban board', icon: 'grid', group: 'Lists and tasks',
    defaults: { w: 92, h: 62 },
    fields: [
      { key: 'backend', type: 'select', label: 'Where the board lives',
        default: 'planner',
        options: [
          { value: 'planner', label: 'Microsoft Planner' },
          { value: 'local', label: 'LifeBoard lists (one list per column)' },
        ] },
      { key: 'source_id', type: 'source', label: 'Microsoft account',
        kinds: ['graph'], when: { backend: 'planner' },
        help: 'Planner needs Tasks.ReadWrite. Reconnect the account once if it '
            + 'was linked before this was added.' },
      { key: 'plan_id', type: 'plan', label: 'Plan', when: { backend: 'planner' },
        help: 'The board is shown with the same buckets, in the same order, as '
            + 'the plan itself \u2014 a wall that disagrees with the app is worse '
            + 'than no wall.' },
      { key: 'list_ids', type: 'text', label: 'Lists (comma separated ids)',
        when: { backend: 'local' },
        help: 'One LifeBoard list per column, left to right.' },
      { key: 'direction', type: 'select', label: 'Columns run', default: 'horizontal',
        options: [
          { value: 'horizontal', label: 'Across the screen (landscape)' },
          { value: 'vertical', label: 'Down the screen (portrait)' },
        ],
        help: 'Four columns squeezed into a portrait panel are four slivers. '
            + 'Stack them instead.' },
      { key: 'interactive', type: 'bool', label: 'Touch to move or complete',
        default: true },
      { key: 'default_action', type: 'select', label: 'What a tick does',
        default: 'next',
        options: [
          { value: 'next', label: 'Move it to the next column' },
          { value: 'complete', label: 'Mark it done and drop it' },
          { value: 'none', label: 'Nothing \u2014 read only' },
        ],
        help: 'The default for every column. The last column completes rather '
            + 'than moving, so the rightmost one behaves like Done without '
            + 'being told it is Done.' },
      { key: 'column_rules', type: 'json', label: 'Per-column rules',
        placeholder: '{"Backlog": "next", "In progress": "move:Done", "Done": "complete"}',
        help: 'Overrides the default for named columns. Use \u201cnext\u201d, '
            + '\u201ccomplete\u201d, \u201cnone\u201d, or \u201cmove:Column '
            + 'name\u201d.' },
      { key: 'only_columns', type: 'text', label: 'Only show these columns',
        placeholder: 'Backlog, In progress, Done',
        help: 'Leave empty for all of them. Useful when a plan has an archive '
            + 'bucket nobody needs on the wall.' },
      { key: 'show_actions', type: 'bool', label: 'Say what a tick will do',
        default: true,
        help: 'Prints \u201c\u2713 moves to Done\u201d under each column '
            + 'heading. Somebody standing at the board should not have to tap '
            + 'one to find out.' },
      { key: 'show_done', type: 'bool', label: 'Show completed cards', default: false },
      { key: 'max_per_column', type: 'number', label: 'Cards per column', default: 12 },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 1.6 },
      { key: 'empty_text', type: 'text', label: 'Text when empty',
        placeholder: 'No columns' },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh (min)', default: 5 },
    ],
  },
  splist: {
    label: 'SharePoint list', icon: 'data', group: 'Lists and tasks',
    defaults: { w: 46, h: 50 },
    fields: [
      { key: 'heading', type: 'text', label: 'Heading', placeholder: 'Punch list' },
      { key: 'source_id', type: 'source', label: 'Microsoft account',
        kinds: ['graph'],
        help: 'The account must have \u201cAlso connect SharePoint\u201d turned '
            + 'on and have been reconnected since \u2014 SharePoint needs a '
            + 'permission that Outlook and To Do do not.' },
      { key: 'site_id', type: 'spsite', label: 'Site' },
      { key: 'list_id', type: 'splist', label: 'List' },
      { key: 'columns', type: 'spcolumns', label: 'Columns to show',
        help: 'The first one is the wide column and carries the row. Two or '
            + 'three is usually right \u2014 a wall display is not a spreadsheet.' },
      { key: 'column_titles', type: 'text', label: 'Rename the headings',
        placeholder: 'Job, Who, Due',
        help: 'Comma separated, in the same order. Leave empty to use '
            + 'SharePoint\u2019s own names.' },
      { key: 'order_by', type: 'text', label: 'Sort by column',
        placeholder: 'Due',
        help: 'The internal column name. Sorting on a column SharePoint has '
            + 'not indexed can fail on a big list \u2014 leave it empty to take '
            + 'the list\u2019s own order.' },
      { key: 'filter', type: 'text', label: 'Filter',
        placeholder: "fields/Status ne 'Complete'",
        help: 'An OData filter, if you want only some rows. Advanced; leave '
            + 'empty and use \u201cshow completed\u201d below instead.' },

      { key: 'done_column', type: 'spcolumns', label: 'Column that means done',
        single: true,
        help: 'Leave empty for a read-only board. Set it and each row gets a '
            + 'checkbox that writes this column.' },
      { key: 'done_value', type: 'text', label: 'Value that means done',
        placeholder: 'Complete',
        when: { interactive: true },
        help: 'For a Yes/No column leave this empty and the box writes true. '
            + 'For a Status choice, put the exact choice \u2014 \u201cComplete\u201d.' },
      { key: 'not_done_value', type: 'text', label: 'Value when un-ticked',
        placeholder: 'Not started', when: { interactive: true } },
      { key: 'interactive', type: 'bool', label: 'Touch to complete', default: true,
        help: 'Also needs \u201cLet the board complete tasks\u201d on the account '
            + '\u2014 the board refuses to change a real list until you say so.' },
      { key: 'remove_when_done', type: 'bool', label: 'Take it off the board',
        default: true },
      { key: 'show_done', type: 'bool', label: 'Show completed rows', default: false },
      { key: 'show_header', type: 'bool', label: 'Show the heading', default: true },
      { key: 'show_columns', type: 'bool', label: 'Show column headings', default: true },
      { key: 'max_items', type: 'number', label: 'Most rows to show', default: 20 },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 2.1 },
      { key: 'empty_text', type: 'text', label: 'Text when empty',
        placeholder: 'Nothing here' },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh (min)', default: 5 },
    ],
  },
  postit: {
    label: 'Sticky note', icon: '🗒️', group: 'Utility',
    defaults: { w: 26, h: 22 },
    fields: [
      { key: 'heading', type: 'text', label: 'Heading', placeholder: 'Grocery List' },
      { key: 'content', type: 'select', label: 'What goes on it', default: 'text',
        options: [
          { value: 'text', label: 'Text I type here' },
          { value: 'gtasks', label: 'Google Tasks list' },
          { value: 'todo', label: 'A LifeBoard to-do list' },
          { value: 'obsidian', label: 'Lines from an Obsidian note' },
        ] },
      { key: 'text', type: 'textarea', label: 'Lines', when: { content: 'text' },
        help: 'One per line.' },
      { key: 'source_id', type: 'source', label: 'Google account',
        kinds: ['google'], when: { content: 'gtasks' },
        help: 'The same account a Google Calendar source uses. Tasks needs its '
            + 'own permission, so an account connected before this existed has '
            + 'to be reconnected once.' },
      { key: 'list_id', type: 'tasklist', label: 'Task list', when: { content: 'gtasks' },
        help: 'Reminders, Grocery List, or whichever list you keep on your phone.' },
      { key: 'todo_list_id', type: 'todolist', label: 'List', when: { content: 'todo' } },
      { key: 'obsidian_source', type: 'source', label: 'Vault folder',
        kinds: ['obsidian'], when: { content: 'obsidian' } },
      { key: 'colour', type: 'select', label: 'Paper', default: 'yellow',
        options: [
          { value: 'yellow', label: 'Yellow' }, { value: 'pink', label: 'Pink' },
          { value: 'blue', label: 'Blue' }, { value: 'green', label: 'Green' },
          { value: 'orange', label: 'Orange' }, { value: 'purple', label: 'Purple' },
          { value: 'white', label: 'White' }, { value: 'grey', label: 'Grey' },
        ] },
      { key: 'custom_colour', type: 'text', label: 'Custom paper colour',
        placeholder: 'e.g. #fdf07a',
        help: 'Overrides the choice above. Pick the ink to match if you go dark.' },
      { key: 'custom_ink', type: 'text', label: 'Custom ink colour', placeholder: '#4a441c' },
      { key: 'font', type: 'select', label: 'Handwriting', default: 'hand',
        options: [
          { value: 'hand', label: 'Handwritten' },
          { value: 'marker', label: 'Marker pen' },
          { value: 'plain', label: 'Plain' },
        ] },
      { key: 'bullet_style', type: 'select', label: 'Bullets', default: 'dot',
        options: [
          { value: 'dot', label: 'Dots' },
          { value: 'check', label: 'Tick boxes' },
          { value: 'dash', label: 'Dashes' },
        ] },
      { key: 'bullets', type: 'bool', label: 'Show bullets', default: true },
      { key: 'show_done', type: 'bool', label: 'Show completed items', default: false },
      { key: 'show_count', type: 'bool', label: 'Show how many are left', default: true },
      { key: 'max_items', type: 'number', label: 'Most lines to show', default: 8,
        help: 'A sticky that overflows is just a broken list — keep it short '
            + 'and let the phone hold the rest.' },
      { key: 'empty_text', type: 'text', label: 'Text when empty',
        placeholder: 'Nothing here' },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 2 },
      { key: 'tilt', type: 'number', label: 'Tilt (degrees)', default: -1.5,
        help: 'A sticky pinned at exactly 0 looks like a rectangle rather than '
            + 'paper. A degree or two is enough.' },
      { key: 'shadow', type: 'bool', label: 'Drop shadow', default: true },
      { key: 'kinds', type: 'select', label: 'Which parts', default: '',
        when: { content: 'obsidian' },
        options: [
          { value: '', label: 'Anything' },
          { value: 'bullet', label: 'Bullets only' },
          { value: 'quote', label: 'Quotes only' },
        ] },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh (min)', default: 5 },
    ],
  },
  // ------------------------------------------------------------- Daily
  //
  // No configuration at all: no key, no account, no source row. That is the
  // whole point of this family - drop one on a board and it works. Long text
  // steps its own size down to fit, because a wall display has no scrollbar
  // and nobody standing there to resize it.
  quote: {
    label: 'Quote of the Day', icon: '💬', group: 'Daily',
    defaults: { w: 60, h: 18 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'quote_marks', type: 'bool', label: 'Curly quote marks', default: true },
      { key: 'italic', type: 'bool', label: 'Italic', default: true },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 2.4,
        help: 'Long text steps down from this on its own so it always fits.' },
      { key: 'align', type: 'select', label: 'Align', default: 'center',
        options: [{ value: 'left', label: 'Left' },
                  { value: 'center', label: 'Centre' },
                  { value: 'right', label: 'Right' }] },
      { key: 'show_attribution', type: 'bool', label: 'Show the author', default: true },
      { key: 'refresh_minutes', type: 'number', label: 'Check every (min)', default: 180,
        help: 'These change once a day; the server caches per calendar day '
            + 'whatever this says.' },
    ],
  },
  bible_verse: {
    label: 'Verse of the Day', icon: '📖', group: 'Daily',
    defaults: { w: 60, h: 20 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'translation', type: 'select', label: 'Translation', default: 'nlt',
        options: [
          { value: 'nlt', label: 'NLT — New Living Translation' },
          { value: 'niv', label: 'NIV — New International Version' },
          { value: 'kjv', label: 'KJV — King James Version' },
          { value: 'web', label: 'WEB — World English Bible' },
          { value: 'bbe', label: 'BBE — Bible in Basic English' },
        ],
        help: 'NLT is read from a local file on the appliance, so it needs no '
            + 'internet. NIV comes from ourmanna; KJV, WEB and BBE from '
            + 'bible-api.com. NASB is not offered — it is copyrighted with '
            + 'no free API, and an option that can never work is worse than '
            + 'one that is not there.' },
      { key: 'show_translation', type: 'bool', label: 'Show which translation',
        default: true,
        help: 'Worth leaving on: if the local NLT is ever missing the verse '
            + 'falls back to NIV, and the citation is what tells you.' },
      { key: 'italic', type: 'bool', label: 'Italic', default: false },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 2.2,
        help: 'Long text steps down from this on its own so it always fits.' },
      { key: 'align', type: 'select', label: 'Align', default: 'center',
        options: [{ value: 'left', label: 'Left' },
                  { value: 'center', label: 'Centre' },
                  { value: 'right', label: 'Right' }] },
      { key: 'show_attribution', type: 'bool', label: 'Show the reference', default: true },
      { key: 'refresh_minutes', type: 'number', label: 'Check every (min)', default: 180 },
    ],
  },
  word_of_day: {
    label: 'Word of the Day', icon: '🔤', group: 'Daily',
    defaults: { w: 45, h: 20 },
    fields: [
      { key: 'title', type: 'text', label: 'Title', default: 'Word of the Day' },
      { key: 'capitalise', type: 'bool', label: 'Capitalise the word', default: true },
      { key: 'size', type: 'number', label: 'Word size (vmin)', default: 2.6 },
      { key: 'align', type: 'select', label: 'Align', default: 'center',
        options: [{ value: 'left', label: 'Left' },
                  { value: 'center', label: 'Centre' },
                  { value: 'right', label: 'Right' }] },
      { key: 'show_attribution', type: 'bool', label: 'Show the definition', default: true },
      { key: 'refresh_minutes', type: 'number', label: 'Check every (min)', default: 180,
        help: 'The word and its definition ship with the board, so this one '
            + 'works with the internet down.' },
    ],
  },
  dad_joke: {
    label: 'Dad Joke', icon: '🤣', group: 'Daily',
    defaults: { w: 55, h: 16 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 2.4,
        help: 'Long text steps down from this on its own so it always fits.' },
      { key: 'align', type: 'select', label: 'Align', default: 'center',
        options: [{ value: 'left', label: 'Left' },
                  { value: 'center', label: 'Centre' },
                  { value: 'right', label: 'Right' }] },
      { key: 'show_attribution', type: 'bool', label: 'Show attribution', default: true },
      { key: 'refresh_minutes', type: 'number', label: 'Check every (min)', default: 180 },
    ],
  },
  advice: {
    label: 'Advice of the Day', icon: '💡', group: 'Daily',
    defaults: { w: 55, h: 16 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'italic', type: 'bool', label: 'Italic', default: false },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 2.4,
        help: 'Long text steps down from this on its own so it always fits.' },
      { key: 'align', type: 'select', label: 'Align', default: 'center',
        options: [{ value: 'left', label: 'Left' },
                  { value: 'center', label: 'Centre' },
                  { value: 'right', label: 'Right' }] },
      { key: 'show_attribution', type: 'bool', label: 'Show attribution', default: true },
      { key: 'refresh_minutes', type: 'number', label: 'Check every (min)', default: 180 },
    ],
  },
  on_this_day: {
    label: 'On This Day', icon: '🗓️', group: 'Daily',
    defaults: { w: 60, h: 20 },
    fields: [
      { key: 'title', type: 'text', label: 'Title', default: 'On This Day' },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 2.0,
        help: 'Long text steps down from this on its own so it always fits.' },
      { key: 'align', type: 'select', label: 'Align', default: 'center',
        options: [{ value: 'left', label: 'Left' },
                  { value: 'center', label: 'Centre' },
                  { value: 'right', label: 'Right' }] },
      { key: 'show_attribution', type: 'bool', label: 'Show the year', default: true },
      { key: 'refresh_minutes', type: 'number', label: 'Check every (min)', default: 180 },
    ],
  },

  todo: {
    label: 'Tasks', icon: '☑️', group: 'Utility',
    defaults: { w: 35, h: 30 },
    fields: [
      { key: 'title', type: 'text', label: 'Title', default: 'To do' },
      { key: 'list_id', type: 'todolist', label: 'List' },
      { key: 'interactive', type: 'bool', label: 'Tap to complete', default: true,
        help: 'Needs a touchscreen. Ticking writes straight back to the list.' },
      { key: 'hide_done', type: 'bool', label: 'Hide completed', default: false },
      { key: 'max_items', type: 'number', label: 'Max items', default: 12 },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 1.9 },
      { key: 'empty_text', type: 'text', label: 'Text when empty', default: 'Nothing to do' },
      { key: 'refresh_seconds', type: 'number', label: 'Refresh (s)', default: 30 },
    ],
  },

  // ----------------------------------------------------------------- Media
  video: {
    label: 'Video', icon: '▶️', group: 'Media',
    defaults: { w: 100, h: 35 },
    fields: [
      { key: 'url', type: 'text', label: 'Video URL',
        placeholder: 'YouTube / Vimeo / .mp4 / .m3u8',
        help: 'A YouTube channel URL plays whatever that channel is streaming live, '
            + 'which survives the stream restarting with a new video id.' },
      { key: 'engine', type: 'select', label: 'Playback engine', default: 'auto',
        options: [
          { value: 'auto', label: 'Auto — the best this device can do' },
          { value: 'native', label: 'Native — mpv, hardware decode' },
          { value: 'direct', label: 'Direct stream — H.264 into the page' },
          { value: 'browser', label: 'In-page embed' },
        ],
        help: 'Auto tries them in order: mpv where it exists, then a direct '
            + 'stream, then the embed. Native runs mpv in a window over the '
            + 'board and is the only way a Raspberry Pi plays a 1080p live '
            + 'stream without melting. Direct asks the server to turn a '
            + 'YouTube link into a plain H.264 stream and plays it in the '
            + 'page — which is what makes a live feed work on Android, '
            + 'where there is no mpv and the embed hands the job to '
            + 'YouTube’s own player. In-page embed is fine on a current '
            + 'desktop browser and nowhere else.' },
      { key: 'max_height', type: 'number', label: 'Maximum stream height',
        placeholder: 'auto — 720 on a Pi 3, 1080 otherwise',
        help: 'Native and direct engines. Ignored by the in-page embed, which gets whatever quality YouTube decides to send.\n\n A Pi 3 has 1GB of RAM shared with the GPU '
            + 'and is also running the rest of the board, so it defaults to '
            + '720p; anything higher tends to stutter in a way that looks like '
            + 'a bad stream rather than a memory limit.' },
      { key: 'hwdec', type: 'text', label: 'Hardware decoder override',
        placeholder: 'auto-detected',
        help: 'Native engine only. Blank auto-detects: v4l2m2m on Pi 4, drm on '
            + 'Pi 5, vaapi on x86.' },
      { key: 'muted', type: 'bool', label: 'Mute audio', default: true,
        help: 'Leave on unless you want sound. Unmuted playback needs the kiosk '
            + 'autoplay flag, which the appliance image sets for you.' },
      { key: 'volume', type: 'number', label: 'Volume (0-1)', default: 1,
        when: { muted: false } },
      { key: 'loop', type: 'bool', label: 'Loop', default: true },
      { key: 'fit', type: 'select', label: 'Fit', default: 'cover',
        options: [{ value: 'cover', label: 'Fill the block (crops edges)' },
                  { value: 'contain', label: 'Fit inside (black bars)' }],
        help: 'Fill scales the picture up until it covers the block, so the '
            + 'sides or the top and bottom are cropped. Fit shows all of it '
            + 'and pads the rest.' },
      { key: 'aspect', type: 'number', label: 'Aspect ratio override',
        placeholder: '1.777 = 16:9',
        help: 'Embeds only, and only if the source is not 16:9 — a wrong '
            + 'ratio shows as bars on two sides even when filling.' },
      { key: 'zoom', type: 'number', label: 'Zoom', default: 1,
        help: '1 fills the block exactly. 1.2 enlarges the picture by a fifth '
            + 'and crops the extra — useful for cutting off a channel logo or '
            + 'a bar baked into the stream. Only applies when filling.' },
      { key: 'pan_x', type: 'number', label: 'Nudge left / right (%)', default: 0,
        help: 'Which part survives the crop. Negative moves the picture left.' },
      { key: 'pan_y', type: 'number', label: 'Nudge up / down (%)', default: 0,
        help: 'Negative moves the picture up, dropping the bottom edge.' },
      { key: 'reload_minutes', type: 'number', label: 'Reload every (min)', default: 0,
        help: 'Recovers a live embed that died. 0 = never.' },
    ],
  },
  photos: {
    label: 'Photo slideshow', icon: '🖼️', group: 'Media',
    defaults: { w: 100, h: 45 },
    fields: [
      { key: 'source_ids', type: 'sources', label: 'Albums', kinds: ['photos'],
        chosenHint: 'They become one shuffled slideshow.',
        emptyHint: 'Nothing ticked here — the single album below is used instead.',
        empty: 'No photo albums have been added yet.',
        emptyAction: 'Add an album',
        help: 'Tick as many as you like — several albums, from several '
            + 'backends, become one shuffled slideshow. A separate album of '
            + 'videos is the intended way to add video.' },
      { key: 'source_id', type: 'source', label: 'Album (single)', kinds: ['photos'],
        help: 'What boards made before multiple albums existed use. Leave it '
            + 'set or clear it — either way it is included.' },
      { key: 'interval_seconds', type: 'number', label: 'Seconds per photo', default: 30 },
      { key: 'reload_minutes', type: 'number', label: 'Check for new photos (min)',
        default: 15,
        help: 'How often to ask the albums for their current contents, so '
            + 'photos added to a shared album appear without reloading the '
            + 'board. The server caches per source, so a small number here '
            + 'costs nothing. New arrivals join the shuffle in progress.' },
      { key: 'shuffle', type: 'bool', label: 'Random order', default: true,
        help: 'Deals every item once before any of them come round again, so '
            + 'a forty-photo album shows all forty before repeating.' },
      { key: 'fit', type: 'select', label: 'Fit', default: 'cover',
        options: [{ value: 'cover', label: 'Fill (crop)' },
                  { value: 'contain', label: 'Fit (letterbox)' }] },
      { key: 'transition_ms', type: 'number', label: 'Crossfade (ms)', default: 1200 },
      { key: 'include_videos', type: 'bool', label: 'Play videos too', default: true,
        help: 'Videos found in the albums are mixed in with the photos. Turn '
            + 'off to show stills only.' },
      { key: 'video_seconds', type: 'number', label: 'Seconds per video', default: 30,
        when: { include_videos: true },
        help: 'A long video is cut off at this; a shorter one moves on when '
            + 'it ends.' },
      { key: 'video_random_start', type: 'bool', label: 'Random clip', default: true,
        when: { include_videos: true },
        help: 'Start somewhere random in a video longer than the limit above, '
            + 'so a four-minute clip is not always the same first thirty '
            + 'seconds — and is a different thirty next time round.' },
      { key: 'video_muted', type: 'bool', label: 'Mute video', default: true,
        when: { include_videos: true },
        help: 'Leave on. Sound needs the kiosk autoplay flag, which the '
            + 'appliance image sets, but a wall display with audio is rarely '
            + 'what anyone wants.' },
      { key: 'video_volume', type: 'number', label: 'Volume (0-1)', default: 1,
        when: { video_muted: false } },
    ],
  },
  image: {
    label: 'Image', icon: '🏞️', group: 'Media',
    defaults: { w: 30, h: 25 },
    fields: [
      { key: 'url', type: 'text', label: 'Image URL' },
      { key: 'fit', type: 'select', label: 'Fit', default: 'cover',
        options: [{ value: 'cover', label: 'Fill (crop)' },
                  { value: 'contain', label: 'Fit (letterbox)' }] },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh every (min)', default: 0,
        help: 'For camera snapshots. 0 = never.' },
    ],
  },
  iframe: {
    label: 'Web page', icon: '🌐', group: 'Media',
    defaults: { w: 50, h: 40 },
    fields: [
      { key: 'url', type: 'text', label: 'Page URL' },
      { key: 'zoom', type: 'number', label: 'Zoom', default: 1,
        help: 'Below 1 shrinks a desktop page to fit a narrow portrait column.' },
      { key: 'refresh_minutes', type: 'number', label: 'Refresh every (min)', default: 0 },
      { key: 'interactive', type: 'bool', label: 'Allow interaction', default: false },
    ],
  },

  // --------------------------------------------------------------- Utility
  html: {
    label: 'Custom HTML', icon: '</>', group: 'Utility',
    defaults: { w: 40, h: 25 },
    fields: [
      { key: 'html', type: 'textarea', label: 'HTML / CSS / JavaScript',
        help: 'Runs in a sandboxed frame with no access to the board, cookies '
            + 'or the API. Call lifeboard.onData(fn) to receive the source value.' },
      { key: 'source_id', type: 'source', label: 'Feed it a data source', kinds: ['rest'] },
      { key: 'variable', type: 'text', label: 'Or a pushed variable',
        placeholder: 'name of a webhook variable' },
      { key: 'path', type: 'text', label: 'Path into the response' },
      { key: 'background', type: 'text', label: 'Background', default: 'transparent' },
      { key: 'colour', type: 'colour', label: 'Text colour', default: '#e8eaf0' },
      { key: 'refresh_seconds', type: 'number', label: 'Refresh (s)', default: 60 },
    ],
  },
  ha_control: {
    label: 'Home Assistant controls', icon: '🎛️', group: 'Smart home',
    defaults: { w: 45, h: 25 },
    fields: [
      { key: 'title', type: 'text', label: 'Title', default: 'Controls' },
      { key: 'source_id', type: 'source', label: 'Home Assistant', kinds: ['homeassistant'] },
      { key: 'entity_ids', type: 'entities', label: 'Entities to control',
        help: 'Lights, switches, fans, locks, covers, scenes, scripts, thermostats. '
            + 'The board can ONLY act on entities listed here — that is the security '
            + 'boundary, since the display has no login.' },
      { key: 'interactive', type: 'bool', label: 'Allow control', default: true,
        help: 'Turn off to show the same entities read-only.' },
      { key: 'show_setpoint', type: 'bool', label: 'Thermostat +/- buttons', default: true },
      { key: 'on_colour', type: 'colour', label: 'Switch colour when on', default: '#7fb069' },
      { key: 'centre', type: 'bool', label: 'Centre vertically', default: false },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 1.8 },
      { key: 'refresh_seconds', type: 'number', label: 'Refresh (s)', default: 15 },
    ],
  },
  text: {
    label: 'Text', icon: '🔤', group: 'Utility',
    defaults: { w: 40, h: 10 },
    fields: [
      { key: 'text', type: 'textarea', label: 'Text' },
      { key: 'size', type: 'number', label: 'Size (vmin)', default: 3 },
      { key: 'weight', type: 'number', label: 'Weight', default: 300 },
      { key: 'colour', type: 'colour', label: 'Colour' },
      { key: 'font', type: 'select', label: 'Font', default: 'sans',
        options: [
          { value: 'sans', label: 'Sans (default)' },
          { value: 'serif', label: 'Serif' },
          { value: 'script', label: 'Script / handwriting' },
          { value: 'mono', label: 'Monospace' },
          { value: 'condensed', label: 'Condensed' },
        ],
        help: 'Script suits a photo caption heading.' },
      { key: 'italic', type: 'bool', label: 'Italic', default: false },
      { key: 'shadow', type: 'bool', label: 'Drop shadow', default: false,
        help: 'Turn on for text sitting over a background photo.' },
      { key: 'align', type: 'select', label: 'Align', default: 'center',
        options: [{ value: 'flex-start', label: 'Left' }, { value: 'center', label: 'Centre' },
                  { value: 'flex-end', label: 'Right' }] },
      { key: 'align_v', type: 'select', label: 'Vertical align', default: 'center',
        options: [{ value: 'flex-start', label: 'Top' }, { value: 'center', label: 'Middle' },
                  { value: 'flex-end', label: 'Bottom' }] },
    ],
  },
  markdown: {
    label: 'Markdown', icon: '📝', group: 'Utility',
    defaults: { w: 35, h: 25 },
    fields: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'text', type: 'textarea', label: 'Markdown',
        help: 'Headings, **bold**, *italic*, `code`, links and - lists.' },
      { key: 'source_id', type: 'source', label: 'Or pull from a source', kinds: ['rest'] },
      { key: 'path', type: 'text', label: 'Path into the response' },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 1.9 },
      { key: 'colour', type: 'colour', label: 'Colour' },
      { key: 'refresh_seconds', type: 'number', label: 'Refresh (s)', default: 300 },
    ],
  },
  qr: {
    label: 'QR code', icon: '🔳', group: 'Utility',
    defaults: { w: 22, h: 22 },
    fields: [
      { key: 'mode', type: 'select', label: 'Type', default: 'wifi',
        options: [{ value: 'wifi', label: 'Wi-Fi join' }, { value: 'text', label: 'URL or text' }] },
      { key: 'ssid', type: 'text', label: 'Wi-Fi network (SSID)', when: { mode: 'wifi' },
        help: 'Type it exactly as it appears, including capitals. Scanning the '
            + 'finished code joins the network automatically.' },
      { key: 'password', type: 'password', label: 'Wi-Fi password', when: { mode: 'wifi' },
        help: 'Rendered into the QR server-side; never appears in the page source.' },
      { key: 'security', type: 'select', label: 'Security', default: 'WPA', when: { mode: 'wifi' },
        options: [{ value: 'WPA', label: 'WPA/WPA2/WPA3' }, { value: 'WEP', label: 'WEP' },
                  { value: 'nopass', label: 'Open' }] },
      { key: 'hidden', type: 'bool', label: 'Hidden network', default: false, when: { mode: 'wifi' } },
      { key: 'text', type: 'text', label: 'URL or text', when: { mode: 'text' } },
      { key: 'url', type: 'text', label: 'URL (alias of text)', when: { mode: 'text' } },
      { key: 'caption', type: 'text', label: 'Caption',
        help: 'Shown under the code. Leave empty for no caption at all.' },
      { key: 'show_ssid', type: 'bool', label: 'Caption with the network name',
        default: false, when: { mode: 'wifi' },
        help: 'Adds "Wi-Fi: <name>" under the code. Off by default — use the '
            + 'caption box above if you want your own wording.' },
      { key: 'scale', type: 'number', label: 'Module size', default: 8,
        help: 'Bigger = chunkier squares, easier to scan from a distance.' },
    ],
  },
  shape: {
    label: 'Shape', icon: '⬜', group: 'Utility',
    defaults: { w: 30, h: 10 },
    fields: [
      { key: 'shape', type: 'select', label: 'Shape', default: 'rect',
        options: [{ value: 'rect', label: 'Rectangle' },
                  { value: 'oval', label: 'Oval' },
                  { value: 'line', label: 'Line / divider' },
                  { value: 'frame', label: 'Frame (outline only)' },
                  { value: 'brackets', label: 'Corner brackets' },
                  { value: 'diamond', label: 'Diamond' },
                  { value: 'triangle', label: 'Triangle' },
                  { value: 'triangle_down', label: 'Triangle (pointing down)' },
                  { value: 'hexagon', label: 'Hexagon' },
                  { value: 'chevron', label: 'Chevron' },
                  { value: 'star', label: 'Star' },
                  { value: 'burst', label: 'Starburst' }],
        help: 'The filled shapes are cut out of the fill colour, so they take '
            + 'no border - use Frame or Corner brackets when you want an '
            + 'outline.' },
      { key: 'fill', type: 'text', label: 'Fill', default: 'rgba(255,255,255,.08)',
        help: 'Any CSS colour, including rgba() for translucency over a photo.' },
      { key: 'radius', type: 'number', label: 'Corner radius', default: 8 },
      { key: 'border_width', type: 'number', label: 'Border width', default: 0 },
      { key: 'border_colour', type: 'colour', label: 'Border colour' },
      { key: 'opacity', type: 'number', label: 'Opacity', default: 1 },
      { key: 'corner_size', type: 'number', label: 'Bracket length (%)', default: 18,
        when: { shape: 'brackets' },
        help: 'How far each corner reaches along the edge.' },
      { key: 'orientation', type: 'select', label: 'Line direction', default: 'horizontal',
        when: { shape: 'line' },
        options: [{ value: 'horizontal', label: 'Horizontal' },
                  { value: 'vertical', label: 'Vertical' }] },
      { key: 'thickness', type: 'number', label: 'Line thickness (px)', default: 2,
        when: { shape: 'line' },
        help: 'A hairline vanishes across a room. Three or four reads as a '
            + 'deliberate divider on a TV.' },
      { key: 'line_style', type: 'select', label: 'Line style', default: 'solid',
        when: { shape: 'line' },
        options: [{ value: 'solid', label: 'Solid' },
                  { value: 'fade', label: 'Fading at both ends' },
                  { value: 'dashed', label: 'Dashed' },
                  { value: 'dotted', label: 'Dotted' },
                  { value: 'double', label: 'Double rule' }] },
      { key: 'ornament', type: 'select', label: 'Centre ornament', default: 'none',
        when: { shape: 'line' },
        options: [{ value: 'none', label: 'None' },
                  { value: 'diamond', label: 'Diamond' },
                  { value: 'dot', label: 'Dot' },
                  { value: 'glyph', label: 'Character\u2026' }],
        help: 'Splits the rule in two and sets a mark between them, the way a '
            + 'printed page breaks a section.' },
      { key: 'ornament_text', type: 'text', label: 'Ornament character',
        when: { ornament: 'glyph' }, placeholder: '\u2766',
        help: 'Any character: \u2766 \u2767 \u273B \u25C6 \u00A7 \u2740' },
    ],
  },
  button: {
    label: 'Button', icon: '🔘', group: 'Utility',
    defaults: { w: 18, h: 8 },
    fields: [
      { key: 'label', type: 'text', label: 'Text' },
      { key: 'icon', type: 'text', label: 'Icon (emoji)' },
      { key: 'action', type: 'select', label: 'On tap', default: 'url',
        options: [{ value: 'url', label: 'Open a URL' },
                  { value: 'layout', label: 'Switch to another layout' },
                  { value: 'reload', label: 'Reload the board' }] },
      { key: 'url', type: 'text', label: 'URL', when: { action: 'url' } },
      { key: 'new_tab', type: 'bool', label: 'Open in a new tab', default: false,
        when: { action: 'url' } },
      { key: 'target_layout_id', type: 'layout', label: 'Layout', when: { action: 'layout' } },
      { key: 'background', type: 'text', label: 'Background',
        default: 'rgba(255,255,255,.10)' },
      { key: 'active_background', type: 'text', label: 'Pressed background' },
      { key: 'colour', type: 'colour', label: 'Text colour' },
      { key: 'border_colour', type: 'colour', label: 'Border colour' },
      { key: 'radius', type: 'number', label: 'Corner radius', default: 12 },
      { key: 'size', type: 'number', label: 'Text size (vmin)', default: 2.2 },
    ],
  },
};
