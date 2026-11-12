/* Canned data for the editor's live widget previews.
 *
 * The editor mounts the REAL widget modules so a preview cannot drift from
 * what the wall actually shows. That means it also inherits every fetch those
 * widgets make, and an editor that hammered the weather API - or worse,
 * Google Photos - once per widget per redraw would be a menace. So the
 * preview context serves these instead, and makes no network calls at all.
 *
 * The numbers are deliberately plausible rather than round: a forecast of
 * 70/70/70 or a calendar of "Event 1, Event 2" tells you nothing about
 * whether the layout you are building can hold real content. Long titles and
 * uneven values are the point - they are what overflows.
 *
 * Everything is derived from `now` so a preview is never stale-looking and
 * the clock, date and calendar all agree with each other.
 */

const now = new Date();
const iso = (d) => d.toISOString();
const addDays = (n) => {
  const d = new Date(now);
  d.setDate(d.getDate() + n);
  return d;
};
const atHour = (dayOffset, hour, minute = 0) => {
  const d = addDays(dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
};

const DAY_MS = 86_400_000;

/* A week of weather that actually varies - including a wet day, so the
 * precipitation row is exercised rather than sitting at zero. */
const WEATHER_DAYS = [
  { high: 74, low: 55, code: 'cloudy', label: 'Overcast', precip: 10 },
  { high: 78, low: 58, code: 'partly', label: 'Partly cloudy', precip: 5 },
  { high: 68, low: 52, code: 'rain', label: 'Rain showers', precip: 80 },
  { high: 71, low: 49, code: 'sun', label: 'Clear', precip: 0 },
  { high: 77, low: 61, code: 'sun', label: 'Sunny', precip: 0 },
  { high: 66, low: 54, code: 'storm', label: 'Thunderstorms', precip: 65 },
  { high: 70, low: 50, code: 'partly', label: 'Partly cloudy', precip: 15 },
];

const weatherDaily = () => WEATHER_DAYS.map((d, i) => {
  const day = addDays(i);
  return {
    date: day.toISOString().slice(0, 10),
    weekday: day.toLocaleDateString(undefined, { weekday: 'short' }),
    high: d.high,
    low: d.low,
    precip_chance: d.precip,
    label: d.label,
    icon: d.code,
    sunrise: iso(atHour(i, 6, 2)),
    sunset: iso(atHour(i, 19, 11)),
  };
});

const weather = () => ({
  units: 'F',
  wind_units: 'mph',
  current: {
    temp: 71, feels_like: 69, humidity: 54, wind: 7,
    label: 'Overcast', icon: 'cloudy', is_day: true,
  },
  daily: weatherDaily(),
});

const hourly = () => ({
  hours: Array.from({ length: 24 }, (_, i) => {
    const t = new Date(now.getTime() + i * 3_600_000);
    const h = t.getHours();
    return {
      time: iso(t),
      hour: `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`,
      // A curve, not a flat line - a sparkline of identical values looks broken.
      temp: Math.round(66 + 9 * Math.sin(((h - 8) / 24) * Math.PI * 2)),
      feels_like: Math.round(64 + 9 * Math.sin(((h - 8) / 24) * Math.PI * 2)),
      precip_chance: h >= 14 && h <= 18 ? 55 : 5,
      wind: 6 + (h % 5),
      humidity: 50 + (h % 20),
      uv: h > 9 && h < 17 ? 4 : 0,
      pressure: 1018,
      visibility: 24_000,
      label: h >= 14 && h <= 18 ? 'Rain showers' : 'Overcast',
      icon: h >= 14 && h <= 18 ? 'rain' : 'cloudy',
    };
  }),
});

/* Real-looking appointments: varied lengths, an all-day, a couple of
 * overlaps, and titles long enough to test truncation. */
const CAL_EVENTS = [
  { d: 0, h: 9,  len: 1,   title: 'Team stand-up', cal: 'Work', colour: '#4a9eff' },
  { d: 0, h: 12, len: 1.5, title: 'Lunch with Sam', cal: 'Personal', colour: '#ab0ae6' },
  { d: 0, h: 15, len: 2,   title: 'Quarterly infrastructure review', cal: 'Work', colour: '#4a9eff' },
  { d: 1, h: 8,  len: 0.5, title: 'School drop-off', cal: 'Personal', colour: '#ab0ae6' },
  { d: 1, h: 14, len: 1,   title: 'Dentist', cal: 'Personal', colour: '#ab0ae6' },
  { d: 2, allDay: true,    title: 'Alex off until the 7th', cal: 'Work', colour: '#4a9eff' },
  { d: 3, h: 10, len: 3,   title: 'Server migration window', cal: 'Work', colour: '#4a9eff' },
  { d: 4, h: 18, len: 2,   title: 'Dinner at the Hollands', cal: 'Personal', colour: '#ab0ae6' },
  { d: 5, h: 7,  len: 1,   title: 'Long run', cal: 'Personal', colour: '#2ecc71' },
  { d: 6, h: 11, len: 1,   title: 'Church', cal: 'Family', colour: '#2ecc71' },
];

const calendar = () => ({
  timezone: 'UTC',
  errors: {},
  events: CAL_EVENTS.map((e, i) => {
    const start = e.allDay ? addDays(e.d) : atHour(e.d, e.h);
    if (e.allDay) start.setHours(0, 0, 0, 0);
    const end = e.allDay
      ? new Date(start.getTime() + DAY_MS)
      : new Date(start.getTime() + e.len * 3_600_000);
    return {
      uid: `preview-${i}`,
      title: e.title,
      start: iso(start),
      end: iso(end),
      all_day: !!e.allDay,
      location: '',
      description: '',
      source_id: 1,
      source_name: e.cal,
      colour: e.colour,
      recurring: false,
    };
  }),
});

const RSS_ITEMS = [
  ['Library extends weekend hours and opens a new maker space for teens',
   'The space includes 3D printers, a recording booth and free workshops on Saturdays.', 35],
  ['Local runner completes 100-mile journey to fight homelessness, raises over $12,000',
   'The proceeds are going to a warming centre downtown.', 95],
  ['Farmers market moves indoors for the winter season starting this weekend',
   'Vendors will set up in the community centre gym every Saturday morning.', 180],
  ['State lawmakers weigh new rules for short-term rentals ahead of summer season',
   'The proposal would cap the number of licences issued in coastal towns.', 320],
  ['High surf advisory issued for the coast through Thursday evening',
   'Forecasters warn of dangerous rip currents and localised beach erosion.', 500],
];

const rss = () => ({
  feed_title: 'Local News',
  items: RSS_ITEMS.map(([title, summary, minsAgo], i) => ({
    title,
    link: '#',
    summary,
    published: iso(new Date(now.getTime() - minsAgo * 60_000)),
    author: '',
    feed_title: i % 2 ? 'Local News' : 'The Daily Herald',
  })),
});

/* Inline SVG rather than a linked photo: the preview must not reach the
 * network, and a broken-image icon in every slideshow tile would make the
 * editor look faulty. Two different scenes so a crossfade is visible. */
const svgPhoto = (top, bottom, label) =>
  'data:image/svg+xml;charset=utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>
      </linearGradient></defs>
      <rect width="1600" height="900" fill="url(#g)"/>
      <circle cx="1320" cy="180" r="70" fill="rgba(255,255,255,.55)"/>
      <path d="M0 640 L380 430 L700 640 L980 470 L1300 660 L1600 520 L1600 900 L0 900 Z"
            fill="rgba(0,0,0,.35)"/>
      <text x="40" y="850" font-family="sans-serif" font-size="42"
            fill="rgba(255,255,255,.85)">${label}</text>
    </svg>`);

const photos = () => ({
  items: [
    { url: svgPhoto('#2b5876', '#4e4376', 'Sample photo 1'), kind: 'image' },
    { url: svgPhoto('#c94b4b', '#4b134f', 'Sample photo 2'), kind: 'image' },
    { url: svgPhoto('#0f2027', '#2c5364', 'Sample photo 3'), kind: 'image' },
  ],
});

const trackerPerson = (entity_id, name, battery) => ({
  entity_id, name, zone: 'Home', raw_state: 'home',
  home: true, location: 'Home', kind: 'home', phone_state: 'Idle',
  latitude: null, longitude: null, battery, charging: false,
  last_changed: iso(new Date(now.getTime() - 2 * 3_600_000)), picture: '',
});

/* One chip per person the block asks for, so a tracker set to one entity
 * previews as one chip - the same size and position it takes on the wall. */
const trackers = (url) => {
  const asked = new URLSearchParams(String(url).split('?')[1] || '').get('entities');
  const ids = asked ? asked.split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (!ids.length) {
    return { people: [trackerPerson('person.sam', 'Sam', 34), trackerPerson('person.alex', 'Alex', 52)] };
  }
  const nameOf = (id) => id.replace(/^[^.]*\./, '').split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { people: ids.map((id, i) => trackerPerson(id, nameOf(id), [88, 52, 34][i % 3])) };
};

/* A day of room temperature with a real shape: cooler overnight, a climb
 * through the morning, a peak in the afternoon. A flat or random series would
 * not show whether the sparkline box you drew is tall enough to read. */
const haHistory = () => {
  const n = 60;
  const pts = Array.from({ length: n }, (_, i) => {
    const hoursAgo = 24 - (i / (n - 1)) * 24;
    const hour = (new Date(now.getTime() - hoursAgo * 3_600_000)).getHours();
    const v = 67 + 4 * Math.sin(((hour - 9) / 24) * Math.PI * 2) + (i % 5) * 0.12;
    return {
      t: iso(new Date(now.getTime() - hoursAgo * 3_600_000)),
      v: Math.round(v * 10) / 10,
      min: Math.round((v - 0.4) * 10) / 10,
      max: Math.round((v + 0.4) * 10) / 10,
    };
  });
  const vals = pts.map((p) => p.v);
  return {
    entity_id: 'sensor.living_room_temperature',
    points: pts,
    min: Math.min(...vals), max: Math.max(...vals),
    first: pts[0].v, last: pts[pts.length - 1].v,
    hours: 24, count: 812,
  };
};

const haMedia = () => ({
  players: [{
    entity_id: 'media_player.living_room',
    name: 'Living Room', state: 'playing', playing: true, idle: false,
    media_title: 'Rhiannon', media_artist: 'Fleetwood Mac',
    media_album_name: 'Fleetwood Mac', app_name: 'Spotify',
    art: '', volume_level: 0.4,
  }],
  missing: [],
});

const haStates = (url) => {
  const asked = new URLSearchParams(url.split('?')[1] || '').get('entities') || '';
  const ids = asked.split(',').map((s) => s.trim()).filter(Boolean);
  const sample = (id, i) => {
    const guess = /temp/i.test(id) ? { state: '68.4', unit: '°F' }
      : /humid/i.test(id) ? { state: '46', unit: '%' }
      : /power|watt/i.test(id) ? { state: '412', unit: 'W' }
      : /battery/i.test(id) ? { state: '87', unit: '%' }
      : /door|window|lock/i.test(id) ? { state: 'Closed', unit: '' }
      : /light|switch/i.test(id) ? { state: 'On', unit: '' }
      : { state: String(20 + i * 7), unit: '' };
    return {
      entity_id: id,
      name: id.split('.').pop().replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      state: guess.state,
      unit: guess.unit,
      icon: '',
      last_changed: iso(new Date(now.getTime() - (i + 1) * 900_000)),
    };
  };
  // With nothing configured yet, show a couple so the tile is not empty.
  const list = ids.length ? ids : ['sensor.living_room_temperature', 'sensor.humidity'];
  return { entities: list.map(sample), missing: [] };
};

const finance = () => ({
  items: [
    { symbol: 'AAPL', name: 'Apple', price: 228.14, change: 1.87, change_pct: 0.83 },
    { symbol: 'MSFT', name: 'Microsoft', price: 417.62, change: -2.44, change_pct: -0.58 },
    { symbol: 'BTC', name: 'Bitcoin', price: 63241, change: 934, change_pct: 1.5 },
  ],
});

const todoList = () => ({
  id: 1,
  name: 'Shopping',
  items: [
    { id: 1, text: 'Milk', done: false },
    { id: 2, text: 'Bread', done: false },
    { id: 3, text: 'Call the plumber about the upstairs radiator', done: true },
    { id: 4, text: 'Batteries (AA)', done: false },
  ],
});

const rest = () => ({
  data: { value: 42, status: 'ok', name: 'Sample' },
  value: 42,
});

/* One sample per daily source, picked to be REPRESENTATIVE in length: a
 * quote long enough to make the auto-sizing step down, a short joke, a word
 * with a real definition. A preview of three-word placeholders would tell you
 * nothing about whether the box you drew is big enough. */
const DAILY = {
  quote: {
    text: 'However difficult life may seem, there is always something you can do and succeed at.',
    attribution: 'Stephen Hawking', extra: '' },
  // NLT, because that is the block's default translation - a preview showing
  // NIV would not match what the board actually renders.
  bible_verse: {
    text: 'Faith shows the reality of what we hope for; it is the evidence of things we cannot see.',
    attribution: 'Hebrews 11:1', extra: 'NLT' },
  word: {
    text: 'petrichor', attribution: 'The smell of the earth after rain.',
    extra: 'noun' },
  dad_joke: {
    text: "Ever wondered why bees hum? It's because they don't know the words.",
    attribution: '', extra: '' },
  advice: {
    text: 'Take time once in a while to look up at the stars for a bit.',
    attribution: '', extra: '' },
  on_this_day: {
    text: 'Apollo 11 lands the first humans on the surface of the Moon.',
    attribution: '1969', extra: 'July 20' },
};

const dailyContent = (url) => {
  const kind = new URLSearchParams(String(url).split('?')[1] || '').get('kind') || 'quote';
  return { ...(DAILY[kind] || DAILY.quote), kind };
};

/* Two days of tides with a real semidiurnal rhythm - roughly two highs and
 * two lows a day, six hours apart. A made-up flat list would not show whether
 * the box holds four rows without clipping the fourth. */
const tides = () => {
  const out = [];
  for (let i = 0; i < 8; i += 1) {
    const t = new Date(now.getTime() + (i * 6.2 + 1.5) * 3_600_000);
    const high = i % 2 === 0;
    out.push({
      time: iso(t),
      hour: t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
      day: t.toLocaleDateString(undefined, { weekday: 'short' }),
      height: high ? 12.4 + (i % 3) * 0.6 : 0.9 + (i % 3) * 0.3,
      kind: high ? 'high' : 'low',
    });
  }
  return { station: '8518750', station_name: 'The Battery, NY', units: 'ft', events: out };
};

const airports = (url) => {
  const codes = new URLSearchParams(String(url).split('?')[1] || '').get('codes') || '';
  const watched = codes.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
  return {
    updated: now.toUTCString(),
    watched,
    // Delays shown by default: an empty preview would look identical to a
    // broken block, and the all-clear state is easy to picture anyway.
    delays: [
      { airport: 'BOS', type: 'Ground Delay', reason: 'low ceilings', detail: 'average 46 minutes' },
      { airport: 'JFK', type: 'Departure Delay', reason: 'wind', detail: 'delays 30-45 minutes' },
      { airport: 'LGA', type: 'Ground Stop', reason: 'thunderstorms', detail: 'until 7:15 PM' },
    ],
  };
};

/* A sermon note the shape real ones actually are: a heading, a scripture
 * quote, an explanation paragraph and an application bullet. Excerpts of very
 * different LENGTHS, because that is what the auto-sizing has to cope with. */
/* A grocery list of realistic length and phrasing - some items short, one
 * long enough to wrap, one already ticked. A list of three one-word items
 * would not show whether the sticky you drew is big enough. */
const gtasks = () => ({
  list_id: 'preview',
  items: [
    { id: '1', title: 'Milk', done: false, due: '', position: '01', parent: '', notes: '' },
    { id: '2', title: 'Bread and something for lunches', done: false, due: '', position: '02', parent: '', notes: '' },
    { id: '3', title: 'Coffee', done: true, due: '', position: '03', parent: '', notes: '' },
    { id: '4', title: 'Batteries (AA)', done: false, due: '', position: '04', parent: '', notes: '' },
    { id: '5', title: 'Call the plumber about the upstairs radiator', done: false, due: '', position: '05', parent: '', notes: '' },
  ],
});

const taskItems = () => {
  // Dates relative to today, so the Overdue / Today / Later grouping actually
  // has something in each bucket whenever the preview is opened.
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  return {
    list_id: 'preview',
    items: [
      { id: '1', title: 'Renew the car registration', done: false, due: day(-2), notes: '', assignee: 'Alex' },
      { id: '2', title: 'Book the dentist', done: false, due: day(0), notes: 'Ask about the evening slots', assignee: 'Alex' },
      { id: '3', title: 'Pick up the prescription', done: false, due: day(0), notes: '', assignee: 'Sam' },
      { id: '4', title: 'Order the replacement filter for the furnace', done: false, due: day(3), notes: '', assignee: 'Alex' },
      { id: '5', title: 'Sort out the garage shelving', done: false, due: '', notes: '', assignee: '' },
      { id: '6', title: 'Send the insurance paperwork back', done: false, due: day(6), notes: '', assignee: 'Sam' },
      { id: '7', title: 'Water the plants', done: true, due: '', notes: '', assignee: '' },
    ],
  };
};

const kanbanBoard = () => {
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  return {
    plan_id: 'preview',
    columns: [
      { id: 'b1', title: 'Backlog', cards: [
        { id: 'c1', title: 'Replace the basement sump pump', done: false, due: '', priority: 5, etag: 'W/"1"', checklist_total: 0, checklist_left: 0, assigned: 0 },
        { id: 'c2', title: 'Quote the loft insulation', done: false, due: day(9), priority: 5, etag: 'W/"2"', checklist_total: 3, checklist_left: 3, assigned: 1 },
        { id: 'c3', title: 'Renew the domain', done: false, due: day(14), priority: 9, etag: 'W/"3"', checklist_total: 0, checklist_left: 0, assigned: 0 },
      ] },
      { id: 'b2', title: 'In progress', cards: [
        { id: 'c4', title: 'Migrate the photo library to Immich', done: false, due: day(2), priority: 3, etag: 'W/"4"', checklist_total: 5, checklist_left: 2, assigned: 1 },
        { id: 'c5', title: 'Rewire the garage lighting', done: false, due: day(-1), priority: 1, etag: 'W/"5"', checklist_total: 0, checklist_left: 0, assigned: 2 },
      ] },
      { id: 'b3', title: 'Waiting on', cards: [
        { id: 'c6', title: 'Electrician to confirm Thursday', done: false, due: '', priority: 5, etag: 'W/"6"', checklist_total: 0, checklist_left: 0, assigned: 1 },
      ] },
      { id: 'b4', title: 'Done', cards: [
        { id: 'c7', title: 'Fit the new thermostat', done: false, due: '', priority: 5, etag: 'W/"7"', checklist_total: 0, checklist_left: 0, assigned: 0 },
      ] },
    ],
  };
};

const spItems = () => {
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString();
  return {
    list_id: 'preview',
    items: [
      { id: '1', etag: 'W/"1"', fields: { Title: 'Replace the door seal, bay 3', AssignedTo: { DisplayName: 'Dan' }, Due: day(-1), Status: 'In progress' } },
      { id: '2', etag: 'W/"2"', fields: { Title: 'Calibrate the line 2 scale', AssignedTo: { DisplayName: 'Priya' }, Due: day(1), Status: 'Not started' } },
      { id: '3', etag: 'W/"3"', fields: { Title: 'Replace fluorescent tubes in the packing area', AssignedTo: { DisplayName: 'Dan' }, Due: day(4), Status: 'Not started' } },
      { id: '4', etag: 'W/"4"', fields: { Title: 'Service the compressor', AssignedTo: { DisplayName: 'Marcus' }, Due: day(9), Status: 'Not started' } },
      { id: '5', etag: 'W/"5"', fields: { Title: 'Re-label the chemical store', AssignedTo: {}, Due: '', Status: 'Complete' } },
    ],
  };
};

const spSites = () => ({ sites: [{ id: 's1', title: 'Operations', url: '' }] });
const spLists = () => ({ lists: [{ id: 'l1', title: 'Punch list', template: 'genericList' }] });
const spColumns = () => ({ columns: [
  { name: 'Title', title: 'Title', type: 'text' },
  { name: 'AssignedTo', title: 'Assigned to', type: 'person' },
  { name: 'Due', title: 'Due', type: 'dateTime' },
  { name: 'Status', title: 'Status', type: 'choice',
    choices: ['Not started', 'In progress', 'Complete'] },
] });

const obsidianNote = () => ({
  note: '05.31.26 - The Advantage of Grace.md',
  path: 'Faith/Sunday Sermons/05.31.26 - The Advantage of Grace.md',
  title: 'The Advantage of Grace',
  total_notes: 20,
  excerpts: [
    { kind: 'quote', heading: 'Day 1: The Alpha and Omega',
      text: 'In the beginning was the Word, and the Word was with God, and the Word was God. The light shines in the darkness, and the darkness has not overcome it.' },
    { kind: 'paragraph', heading: 'Day 1: The Alpha and Omega',
      text: 'To the Greek mind, Logos was the stabilizing, rational principle of the universe. To the Jewish mind, the Word was the creative power of God.' },
    { kind: 'bullet', heading: 'Life Application',
      text: 'Write down one thing you are currently building, and ask whether it started with God.' },
  ],
  // Joined rather than written as one literal: the newlines are what the
  // "whole note" mode lays out, and an editor preview with none of them would
  // not show whether the block is tall enough to be worth scrolling.
  body: [
    'The Advantage of Grace',
    '',
    'Context: Based on your notes from May 31.',
    '',
    'Day 1: The Alpha and Omega',
    '',
    'In the beginning was the Word, and the Word was with God.',
    '',
    'To the Greek mind, Logos was the stabilizing principle of the universe.',
  ].join(String.fromCharCode(10)),
});

/* Ordered longest-prefix-first so /api/data/weather/hourly is not swallowed
 * by /api/data/weather. */
const ROUTES = [
  ['/api/data/weather/hourly', hourly],
  ['/api/data/weather/air', () => ({
    us_aqi: 42, european_aqi: 26, label: 'Good', colour: '#7fb069',
    pm2_5: 4.1, pm10: 5.2, ozone: 68, no2: 3, so2: 1, co: 110 })],
  ['/api/data/weather/alerts', () => ({
    region: 'us',
    alerts: [{
      id: 'preview-alert', event: 'Coastal Flood Advisory',
      headline: 'Coastal Flood Advisory in effect until 8:00 PM',
      description: 'Minor flooding of vulnerable shore roads is expected around the time of high tide.',
      severity: 'Moderate', urgency: 'Expected', certainty: 'Likely',
      colour: '#e0a800', onset: iso(now),
      expires: iso(new Date(now.getTime() + 6 * 3_600_000)),
      sender: 'National Weather Service',
    }] })],
  ['/api/data/weather/sunmoon', () => ({
    days: weatherDaily().map((d) => ({
      date: d.date, weekday: d.weekday, sunrise: d.sunrise, sunset: d.sunset })),
    moon: { phase: 0.42, name: 'Waxing gibbous', illumination: 0.68,
            next_full: iso(addDays(5)), next_new: iso(addDays(19)) } })],
  ['/api/data/weather', weather],
  ['/api/data/calendar', calendar],
  ['/api/data/rss', rss],
  ['/api/data/photos', photos],
  ['/api/data/ha/history', haHistory],
  ['/api/data/ha/media', haMedia],
  ['/api/data/ha/trackers', trackers],
  ['/api/data/ha/states', haStates],
  ['/api/data/ha/entities', () => ({ entities: [] })],
  ['/api/data/finance', finance],
  ['/api/data/tides', tides],
  ['/api/data/airports', airports],
  ['/api/data/gtasks', gtasks],
  ['/api/tasks/items', taskItems],
  ['/api/tasks/board', kanbanBoard],
  ['/api/sharepoint/items', spItems],
  ['/api/sharepoint/sites', spSites],
  ['/api/sharepoint/lists', spLists],
  ['/api/sharepoint/columns', spColumns],
  ['/api/data/obsidian', obsidianNote],
  ['/api/data/daily', dailyContent],
  ['/api/data/rest', rest],
  ['/api/data/variable', () => ({ value: 42, name: 'sample' })],
  ['/api/todo/lists/', todoList],
  ['/api/todo/lists', () => ([{ id: 1, name: 'Shopping' }])],
];

/* What the preview context's getJSON calls. Unknown endpoints resolve to an
 * empty object rather than throwing: a widget that has not been given a
 * fixture should render its own empty state, which is still a truthful
 * preview, instead of painting a red error into the editor. */
export function previewFetch(url) {
  const path = String(url).split('?')[0];
  for (const [prefix, make] of ROUTES) {
    if (path.startsWith(prefix)) return make(url);
  }
  return {};
}

export const PREVIEW_NOW = now;
