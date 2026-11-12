/* Line icons for the admin UI.
 *
 * The block palette used emoji, and emoji are why it looked like a hobby
 * project next to a commercial one: they render in a different style on every
 * platform, they carry their own colour so they fight the theme, and they sit
 * on a text baseline rather than aligning to a grid.
 *
 * These are drawn here rather than pulled from an icon library so the admin
 * keeps working with no network and nothing to install - the whole appliance
 * is meant to run on a LAN with no internet. They are all 24x24, stroked in
 * `currentColor` at a single weight, so one icon set works on both the dark
 * and light themes and inherits whatever colour its context has.
 */

const NS = 'http://www.w3.org/2000/svg';

/* Path data only. Everything else - size, stroke, colour - is applied
 * uniformly below, which is what keeps forty icons looking like one set. */
const PATHS = {
  clock: ['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M12 7v5l3 2'],
  calendar: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
  calendarDays: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4',
                 'M8 14h1', 'M12 14h1', 'M16 14h1', 'M8 17h1', 'M12 17h1'],
  countdown: ['M12 4a8 8 0 100 16 8 8 0 000-16z', 'M12 8v4l2 2', 'M9 2h6'],
  cloud: ['M7 18a4 4 0 010-8 5.5 5.5 0 0110.5 1.5A3.5 3.5 0 0117 18z'],
  cloudRain: ['M7 15a4 4 0 010-8 5.5 5.5 0 0110.5 1.5A3.5 3.5 0 0117 15z',
              'M8 18v2', 'M12 18v3', 'M16 18v2'],
  sun: ['M12 8a4 4 0 100 8 4 4 0 000-8z', 'M12 2v2', 'M12 20v2', 'M2 12h2',
        'M20 12h2', 'M5 5l1.5 1.5', 'M17.5 17.5L19 19', 'M19 5l-1.5 1.5',
        'M6.5 17.5L5 19'],
  moon: ['M20 14a8 8 0 01-10-10 8 8 0 1010 10z'],
  wind: ['M3 8h11a3 3 0 10-3-3', 'M3 12h15a3 3 0 11-3 3', 'M3 16h8'],
  alert: ['M12 4l9 16H3z', 'M12 10v4', 'M12 17h.01'],
  waves: ['M3 8c2-2 4-2 6 0s4 2 6 0 4-2 6 0',
          'M3 13c2-2 4-2 6 0s4 2 6 0 4-2 6 0',
          'M3 18c2-2 4-2 6 0s4 2 6 0 4-2 6 0'],
  plane: ['M4 14l16-7-6 12-2-5z'],
  news: ['M4 5h13v14H4z', 'M17 9h3v8a2 2 0 01-3 2', 'M7 9h7', 'M7 12h7', 'M7 15h4'],
  quote: ['M7 7h4v5a4 4 0 01-4 4', 'M15 7h4v5a4 4 0 01-4 4'],
  book: ['M5 4h9a3 3 0 013 3v13H8a3 3 0 01-3-3z', 'M8 20a3 3 0 01-3-3', 'M9 8h6'],
  letters: ['M4 18l4-11 4 11', 'M5.5 14h5', 'M15 18V9', 'M15 12h3a3 3 0 010 6h-3'],
  smile: ['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M9 10h.01', 'M15 10h.01',
          'M8.5 14a4 4 0 007 0'],
  bulb: ['M9 18h6', 'M10 21h4', 'M12 3a6 6 0 00-3 11v2h6v-2a6 6 0 00-3-11z'],
  history: ['M12 4a8 8 0 108 8', 'M12 4v4l3 1', 'M4 4v4h4'],
  image: ['M3 5h18v14H3z', 'M8 11a1.5 1.5 0 100-3 1.5 1.5 0 000 3',
          'M3 16l5-4 4 3 3-2 6 5'],
  photos: ['M7 3h14v14H7z', 'M3 7v14h14', 'M12 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3'],
  video: ['M3 6h12v12H3z', 'M15 10l6-3v10l-6-3z'],
  globe: ['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M3 12h18',
          'M12 3a14 14 0 010 18', 'M12 3a14 14 0 000 18'],
  home: ['M4 11l8-7 8 7', 'M6 10v10h12V10'],
  gauge: ['M4 18a8 8 0 1116 0', 'M12 18l4-6'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  data: ['M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z',
         'M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7'],
  money: ['M12 3v18', 'M16 7.5C16 6 14.2 5 12 5S8 6 8 7.5 9.8 10 12 10.5s4 1.4 4 3S14.2 19 12 19s-4-1-4-2.5'],
  qr: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h2v2h-2z',
       'M18 14h2v2h-2z', 'M14 18h2v2h-2z', 'M18 18h2v2h-2z'],
  text: ['M5 6h14', 'M9 6v13', 'M15 6v13', 'M7 19h4', 'M13 19h4'],
  markdown: ['M3 6h18v12H3z', 'M6 15V9l3 3 3-3v6', 'M16 9v6', 'M14 13l2 2 2-2'],
  code: ['M9 8l-5 4 5 4', 'M15 8l5 4-5 4'],
  shape: ['M4 4h16v16H4z'],
  button: ['M3 9h18v6H3z', 'M7 12h10'],
  check: ['M4 5h16v14H4z', 'M8 12l2.5 2.5L16 9'],
  pin: ['M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z',
        'M12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5'],
  sliders: ['M4 8h10', 'M18 8h2', 'M4 16h4', 'M12 16h8',
            'M16 6v4', 'M8 14v4'],
  camera: ['M3 8h4l2-2h6l2 2h4v11H3z',
           'M12 16a3.5 3.5 0 100-7 3.5 3.5 0 000 7'],
  music: ['M9 18V6l10-2v12', 'M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0',
          'M19 16a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  note: ['M6 3h9l4 4v14H6z', 'M15 3v5h4', 'M9 12h7', 'M9 16h5'],
  link: ['M10 14a4 4 0 006 0l2-2a4 4 0 10-6-6l-1 1',
         'M14 10a4 4 0 00-6 0l-2 2a4 4 0 106 6l1-1'],
  question: ['M12 3a9 9 0 100 18 9 9 0 000-18z',
             'M9.5 9.5a2.5 2.5 0 113.5 2.3V14', 'M12 17h.01'],
};

/* Which icon each widget kind gets. Kept here rather than in the widget
 * catalogue so the renderer never has to know the admin has icons at all. */
const FOR_KIND = {
  clock: 'clock', date: 'calendar', countdown: 'countdown',
  calendar: 'calendarDays',
  weather: 'cloud', weather_hourly: 'chart', air_quality: 'wind',
  weather_alerts: 'alert', sunmoon: 'moon', tides: 'waves',
  rss: 'news',
  quote: 'quote', bible_verse: 'book', word_of_day: 'letters',
  dad_joke: 'smile', advice: 'bulb', on_this_day: 'history',
  video: 'video', photos: 'photos', image: 'image', iframe: 'globe',
  entity: 'home', tracker: 'pin', ha_control: 'sliders',
  ha_history: 'chart', ha_camera: 'camera', ha_media: 'music',
  ha_glance: 'grid',
  data: 'data', gauge: 'gauge', chart: 'chart', finance: 'money',
  shape: 'shape', button: 'button', markdown: 'markdown', text: 'text',
  html: 'code', qr: 'qr', todo: 'check', airport_delays: 'plane',
  obsidian_notes: 'note',
  postit: 'note',
  tasks: 'check', kanban: 'grid', splist: 'data',
};

/* Icons for the picker presets, which are services rather than widget kinds. */
const FOR_PRESET = {
  'google-cal': 'calendar', 'ms-cal': 'calendar', 'ics-cal': 'link',
  'google-photos': 'photos', 'immich-photos': 'home', 'local-photos': 'image',
  'bing-photos': 'image', 'unsplash-photos': 'camera',
  'rss-block': 'news', 'weather-block': 'cloud',
  'ha-block': 'home', 'ha-control-block': 'sliders',
  'obsidian-notes': 'note',
  'postit-note': 'note',
  'task-list': 'check', 'kanban-board': 'grid',
  'ms-todo': 'check', 'ms-planner': 'grid', 'sharepoint-list': 'data',
};

export function iconNameFor(kind, presetId) {
  return FOR_PRESET[presetId] || FOR_KIND[kind] || 'question';
}

/* One icon element.
 *
 * `currentColor` and a shared stroke width are what make these read as a set:
 * the caller decides colour and size by styling the parent, exactly as it
 * would with text.
 */
export function icon(name, { size = 20, stroke = 1.6 } = {}) {
  const paths = PATHS[name] || PATHS.question;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  // A fixed box keeps rows aligned even where a glyph is visually narrow.
  svg.style.flex = '0 0 auto';
  svg.style.display = 'block';
  for (const d of paths) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/* The icon for a catalogue entry or preset, ready to drop into a row. */
export function blockIcon(entry, opts) {
  return icon(iconNameFor(entry?.kind, entry?.id), opts);
}

export const ICON_NAMES = Object.keys(PATHS);
