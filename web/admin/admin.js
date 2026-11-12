/* LifeBoard admin UI.
 *
 * Plain ES modules, no framework, no build step - the same appliance argument
 * as the renderer: what ships is what you can read.
 *
 * The widget property forms are generated from CATALOGUE, imported directly
 * from the renderer's registry. There is therefore exactly one definition of
 * what a widget accepts, and adding a widget makes it configurable here for
 * free. That is the single most important structural decision in this file.
 */

import { CATALOGUE } from '../render/widgets/registry.js';
import { icon, blockIcon, iconNameFor } from './icons.js';

const $ = (sel, root = document) => root.querySelector(sel);
const APP = $('#app');

/* ------------------------------------------------------------------ utils */

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

let toastTimer = null;
function toast(message, bad = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('bad', bad);
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), bad ? 6000 : 2600);
}

async function api(path, options = {}) {
  /* A file upload is not JSON and must not be dressed as it.
   *
   * Everything here speaks JSON, so this helper stringifies the body and
   * stamps a Content-Type on it. A multipart body must be sent untouched and
   * WITHOUT a Content-Type of ours: the browser writes that header itself,
   * including the boundary marker the far end needs to split the parts. Set it
   * by hand and the upload arrives as unparseable bytes.
   */
  const isUpload = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const resp = await fetch(path, {
    headers: isUpload ? {} : { 'Content-Type': 'application/json' },
    ...options,
    body: isUpload
      ? options.body
      : (options.body ? JSON.stringify(options.body) : undefined),
  });
  if (resp.status === 401) { state.authed = false; render(); throw new Error('Session expired'); }
  if (!resp.ok) {
    let detail = resp.statusText;
    try { detail = (await resp.json()).detail || detail; } catch { /* not json */ }
    throw new Error(detail);
  }
  return resp.status === 204 ? null : resp.json();
}

/* Wrap an async handler so a thrown error becomes a toast rather than an
 * unhandled rejection that silently does nothing - the most confusing possible
 * outcome when you have just clicked Save. */
/* Recent failures, newest last.
 *
 * guard() is what stops one broken control taking the whole admin down, but
 * it also means an error becomes a toast that is gone in three seconds. That
 * is fine for "the server said no" and useless for "this page has a bug" -
 * and a ReferenceError reaching here means exactly that: a function called
 * that does not exist, which is the failure that has reached the appliance
 * three times now.
 *
 * Keeping the last few makes them visible to support, and lets the test
 * suite fire every handler and then ask whether anything referenced something
 * that is not there. */
const RECENT_ERRORS = [];

const guard = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    RECENT_ERRORS.push({
      at: new Date().toISOString(),
      name: err && err.name ? err.name : 'Error',
      message: err && err.message ? err.message : String(err),
    });
    if (RECENT_ERRORS.length > 25) RECENT_ERRORS.shift();
    toast(err.message, true);
  }
};

/* ------------------------------------------------------------------ state */

const state = {
  tab: 'templates',
  authed: false,
  setupNeeded: false,
  screens: [],
  layouts: [],
  sources: [],
  templates: [],
  rules: [],
  settings: {},
  display: null,
  editing: null,      // layout being edited
  selected: null,     // index into editing.widgets
  dirty: false,
  todoLists: [],
  wizardStep: 0,
  wizardData: {},
  inSetup: false,     // the wizard continues past the account step until "Open the dashboard"
  // Editor preferences. Snap is on by default because hand-dragging to a
  // pleasing alignment on a 360px preview that renders at 4K is hopeless.
  snap: 1,            // percent; 0 disables
  preview: true,      // draw the real widgets behind the editor blocks
  zoom: 1,            // editor canvas scale; 1 = the size that fits the pane
  // Every selected block. `selected` stays the PRIMARY one - the one the
  // properties panel edits and the one that carries the resize handles.
  selection: new Set(),
  propTab: 'settings',  // which properties tab is open, kept across redraws
  blockTags: false,   // ...which makes a name on every block redundant
  undoStack: [],
  redoStack: [],
};

const UNDO_LIMIT = 50;

/* Push the current widget array onto the undo stack. Called BEFORE a mutation,
 * never after - capturing the result instead of the starting point is the
 * classic off-by-one that makes undo skip a step. */
function pushUndo() {
  if (!state.editing) return;
  state.undoStack.push(JSON.stringify(state.editing.widgets));
  if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
  state.redoStack.length = 0;
}

function undo() {
  if (!state.undoStack.length) { toast('Nothing to undo'); return; }
  state.redoStack.push(JSON.stringify(state.editing.widgets));
  state.editing.widgets = JSON.parse(state.undoStack.pop());
  state.selected = null;
  state.dirty = true;
  render();
}

function redo() {
  if (!state.redoStack.length) { toast('Nothing to redo'); return; }
  state.undoStack.push(JSON.stringify(state.editing.widgets));
  state.editing.widgets = JSON.parse(state.redoStack.pop());
  state.selected = null;
  state.dirty = true;
  render();
}

/* Load everything the admin needs, and survive one of them failing.
 *
 * This was a Promise.all, and that was a real bug rather than a style choice.
 * Promise.all rejects on the FIRST failure, so a single endpoint returning 401
 * or 500 left every list empty - and the admin then told the user "No screen
 * configured" on a board that had a screen, and "no displays" on a board that
 * had one. The message named the wrong problem, which is worse than no message
 * at all: it sends somebody off to configure a screen that already exists.
 *
 * Each call now fails on its own, keeps whatever it had, and SAYS SO.
 */
async function refresh() {
  const wanted = [
    ['screens', '/api/screens', []],
    ['layouts', '/api/layouts', []],
    ['sources', '/api/sources', []],
    ['templates', '/api/templates', []],
    ['settings', '/api/settings', {}],
    ['todoLists', '/api/todo/lists', []],
  ];

  const results = await Promise.all(wanted.map(async ([key, path, empty]) => {
    try {
      return [key, await api(path), null];
    } catch (err) {
      return [key, empty, `${path}: ${err.message || err}`];
    }
  }));

  const problems = [];
  for (const [key, value, problem] of results) {
    // A failed call keeps the last good value rather than blanking the UI -
    // a transient blip should not empty the layout list mid-edit.
    if (problem) {
      problems.push(problem);
      if (state[key] === undefined) state[key] = value;
    } else {
      state[key] = value;
    }
  }
  state.loadProblems = problems;
}


/* ------------------------------------------------------------- rotation */

/* Rotation is two separate things: a value stored in the database, and an
 * instruction to the display server. The first always succeeds. The second
 * decides what the TV shows, and it can fail for reasons the board cannot
 * guess - a driver that will not rotate a composited output, an X server the
 * service cannot authenticate to, a VM whose virtual GPU has no rotation
 * support at all.
 *
 * Reporting the first while discarding the second is how someone ends up
 * staring at an unchanged television wondering which half is broken. */
function reportRotation(result) {
  const rotation = result && result.rotation;
  if (!rotation) { toast('Saved'); return; }

  if (rotation.ok) {
    toast(`Rotated via ${rotation.backend}${rotation.output ? ` (${rotation.output})` : ''}`);
    return;
  }

  const detail = rotation.error || rotation.out || 'the display server refused';
  toast(`Saved, but the screen did not rotate: ${detail}`, true);
}

/* Re-apply what is already stored. Useful after a display has been power
 * cycled - a TV that renegotiates HDMI can come back unrotated while the
 * database still says otherwise - and for retrying without toggling the
 * setting to something else and back. */
async function reapplyRotation(screen) {
  const result = await api(`/api/screens/${screen.id}`, {
    method: 'PATCH', body: { orientation: screen.orientation || 'normal' },
  });
  reportRotation(result);
  await refresh();
  render();
}

/* --------------------------------------------------------------- geometry */

/* Exact numbers, alignment against the board, and a few sizes worth one click.
 *
 * Everything is a percentage of the board rather than pixels, so a layout
 * arranged on this small preview lands identically on a 4K panel. */
function geometryPanel(widget, stage, panel) {
  const redraw = () => { drawStage(stage); drawProps(panel, stage); };

  const numberField = (key, label) => el('div', {},
    el('label', {}, label),
    el('input', {
      type: 'number', step: '0.5', value: Math.round((widget[key] ?? 0) * 10) / 10,
      // No redraw on input - the same focus-stealing trap the property fields
      // had. The stage follows along; the form is left alone.
      oninput: (e) => {
        const v = Number(e.target.value);
        if (!Number.isFinite(v)) return;
        widget[key] = Math.max(0, Math.min(100, v));
        state.dirty = true;
        drawStage(stage);
      },
    }));

  const act = (label, title, fn) => el('button', {
    title,
    onclick: () => { pushUndo(); fn(); state.dirty = true; redraw(); },
  }, label);

  return el('div', {
    class: 'field',
    style: { borderTop: '1px solid var(--line)', paddingTop: '.7rem' },
  },
    el('label', {}, 'Position and size (% of the board)'),
    el('div', { class: 'row' },
      numberField('x', 'Left'), numberField('y', 'Top'),
      numberField('w', 'Width'), numberField('h', 'Height')),

    el('label', { style: { marginTop: '.7rem' } }, 'Align to the board'),
    el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '.3rem' } },
      act('⇤', 'Align left', () => { widget.x = 0; }),
      act('⇥', 'Align right', () => { widget.x = 100 - widget.w; }),
      act('⇞', 'Align top', () => { widget.y = 0; }),
      act('⇟', 'Align bottom', () => { widget.y = 100 - widget.h; }),
      act('↔', 'Centre horizontally', () => { widget.x = (100 - widget.w) / 2; }),
      act('↕', 'Centre vertically', () => { widget.y = (100 - widget.h) / 2; })),

    el('label', { style: { marginTop: '.7rem' } }, 'Quick sizes'),
    el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '.3rem' } },
      act('Full', 'Fill the whole board', () => {
        Object.assign(widget, { x: 0, y: 0, w: 100, h: 100 });
      }),
      act('Top ½', 'Top half', () => {
        Object.assign(widget, { x: 0, y: 0, w: 100, h: 50 });
      }),
      act('Bottom ½', 'Bottom half', () => {
        Object.assign(widget, { x: 0, y: 50, w: 100, h: 50 });
      }),
      act('Left ½', 'Left half', () => {
        Object.assign(widget, { x: 0, y: 0, w: 50, h: 100 });
      }),
      act('Right ½', 'Right half', () => {
        Object.assign(widget, { x: 50, y: 0, w: 50, h: 100 });
      }),
      act('Full width', 'Span the board, keep the height', () => {
        widget.x = 0; widget.w = 100;
      })),

    el('p', { class: 'hint', style: { marginTop: '.5rem' } },
      'Arrow keys nudge the selected block; hold Shift for bigger steps and '
      + 'Alt while dragging to ignore the grid.'),
  );
}

/* ------------------------------------------------------------ block layers */

/* Stacking order is stored as an explicit z on each widget. Reordering
 * rewrites every z from the list position rather than swapping two values, so
 * the order shown is always the order rendered - no drift after a few moves. */
function reindexZ() {
  state.editing.widgets.forEach((w, i) => { w.z = i; });
}

/* Move a block through the stack.
 *
 * `where` is 'front', 'back', or a signed number of steps. Stacking is the
 * array order and z is rewritten from it afterwards, so there is exactly one
 * source of truth: what the layers list shows is what the board draws.
 *
 * The previous "z += 1" could not work in general. After any reorder the z
 * values are 0..n-1, so adding one lands on top of the neighbour rather than
 * above it, and a tie is resolved by DOM order - the button did nothing, or
 * seemed to work intermittently, which is worse.
 *
 * Returns the block's new index so the caller can keep it selected.
 */
function moveInStack(index, where) {
  const widgets = state.editing?.widgets;
  if (!widgets || index == null || !widgets[index]) return index;

  let target;
  if (where === 'front') target = widgets.length - 1;
  else if (where === 'back') target = 0;
  else target = index + where;

  target = Math.max(0, Math.min(widgets.length - 1, target));
  if (target === index) return index;

  pushUndo();
  const [item] = widgets.splice(index, 1);
  widgets.splice(target, 0, item);
  reindexZ();
  state.selected = target;
  state.dirty = true;
  return target;
}

function blockLayers(stage, panel) {
  const widgets = state.editing.widgets;
  const wrap = el('div', { style: { marginBottom: '.8rem' } });

  wrap.append(el('h2', { style: { fontSize: '.95rem', margin: '0 0 .4rem' } },
    `Blocks on this board (${widgets.length})`));

  if (!widgets.length) {
    wrap.append(el('p', { class: 'hint' },
      'Nothing here yet — add a block to get started.'));
    return wrap;
  }

  wrap.append(el('p', { class: 'hint', style: { margin: '0 0 .5rem' } },
    'Topmost first. Use ↑ ↓ to change what covers what.'));

  const list = el('div', {
    style: {
      display: 'flex', flexDirection: 'column', gap: '.2rem',
      maxHeight: '34vh', overflow: 'auto',
    },
  });

  // Highest z at the top, matching how the board actually stacks.
  const order = widgets
    .map((widget, index) => ({ widget, index }))
    .sort((a, b) => (b.widget.z ?? b.index) - (a.widget.z ?? a.index));

  const redraw = () => { drawStage(stage); drawProps(panel, stage); };

  // One implementation, shared with the property dialog's buttons.
  const move = (index, delta) => { moveInStack(index, delta); redraw(); };

  for (const { widget, index } of order) {
    const def = CATALOGUE[widget.kind] || {};
    const selected = index === state.selected;

    const iconButton = (label, title, onclick, dim = false) => el('button', {
      title,
      style: {
        padding: '.1rem .35rem', minWidth: 'auto', fontSize: '.85rem',
        opacity: dim ? '.45' : '1', flex: '0 0 auto',
      },
      onclick: (e) => { e.stopPropagation(); onclick(); },
    }, label);

    list.append(el('div', {
      style: {
        display: 'flex', gap: '.3rem', alignItems: 'center',
        padding: '.3rem .4rem', borderRadius: '6px', cursor: 'pointer',
        background: selected ? 'var(--accent)' : 'var(--panel-2)',
        color: selected ? '#fff' : 'var(--fg)',
        border: '1px solid var(--line)',
      },
      onclick: () => { state.selected = index; redraw(); },
    },
      // A line icon rather than the emoji: emoji render differently on every
      // platform and carry their own colour, so a list of them never looks
      // like one set.
      el('span', { style: { flex: '0 0 auto', opacity: '.85', display: 'flex' } },
        icon(iconNameFor(widget.kind), { size: 16 })),
      el('span', {
        style: {
          flex: '1 1 auto', minWidth: '0', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '.85rem',
        },
      }, widget.name || def.label || widget.kind),

      iconButton(widget.visible === false ? '🚫' : '👁', 'Show or hide on the board',
        () => {
          pushUndo();
          widget.visible = widget.visible === false;
          state.dirty = true; redraw();
        }, widget.visible === false),

      iconButton(widget.locked ? '🔒' : '🔓', 'Lock so it cannot be dragged',
        () => {
          pushUndo();
          widget.locked = !widget.locked;
          state.dirty = true; redraw();
        }, !widget.locked),

      iconButton('↑', 'Bring forward', () => move(index, 1)),
      iconButton('↓', 'Send backward', () => move(index, -1)),

      iconButton('⧉', 'Duplicate', () => {
        pushUndo();
        const copy = JSON.parse(JSON.stringify(widget));
        delete copy.id;
        copy.x = Math.min(92, (copy.x || 0) + 3);
        copy.y = Math.min(92, (copy.y || 0) + 3);
        widgets.push(copy);
        reindexZ();
        state.selected = widgets.length - 1;
        state.dirty = true; redraw();
      }),

      iconButton('✕', 'Remove from the board', () => {
        pushUndo();
        widgets.splice(index, 1);
        reindexZ();
        // Never leave `selected` pointing past the end, or the properties
        // panel reads an undefined widget and the editor goes blank.
        state.selected = null;
        state.dirty = true; redraw();
      }),
    ));
  }

  wrap.append(list);
  return wrap;
}

/* ------------------------------------------------------- the block picker */

/* Presets exist because "Calendar widget + ical source" is the implementation,
 * not the intention. Someone who wants their Gmail calendar on the wall should
 * find "Google Calendar", not be asked to model it as a source and a widget
 * that reference each other.
 *
 * Picking a preset creates BOTH halves and binds them, then hands straight
 * over to whatever that service needs next - sign-in, a URL, a folder. */
const BLOCK_PRESETS = [
  {
    id: 'google-calendar', label: 'Google Calendar', icon: '📆',
    group: 'Calendars', popular: true,
    desc: 'Events from a Google account',
    kind: 'calendar', sourceKind: 'google',
  },
  {
    id: 'ms-calendar', label: 'Microsoft / Outlook Calendar', icon: '📧',
    group: 'Calendars', popular: true,
    desc: 'Events from Outlook or Microsoft 365',
    kind: 'calendar', sourceKind: 'graph',
  },
  {
    id: 'ical-calendar', label: 'Calendar from an .ics link', icon: '🔗',
    group: 'Calendars', popular: true,
    desc: 'Google, Outlook, iCloud and most others — no app registration',
    kind: 'calendar', sourceKind: 'ical',
  },
  {
    id: 'google-photos', label: 'Google Photos', icon: '🖼️',
    group: 'Photos', popular: true,
    desc: 'Slideshow from a shared album link',
    kind: 'photos', sourceKind: 'photos', sourceConfig: { backend: 'google_shared' },
  },
  {
    id: 'immich-photos', label: 'Immich', icon: '🏠',
    group: 'Photos',
    desc: 'Slideshow from your own Immich server',
    kind: 'photos', sourceKind: 'photos', sourceConfig: { backend: 'immich' },
  },
  {
    id: 'local-photos', label: 'Photos from a folder', icon: '📁',
    group: 'Photos',
    desc: 'Any local folder or network mount',
    kind: 'photos', sourceKind: 'photos', sourceConfig: { backend: 'local' },
  },
  {
    id: 'bing-photos', label: 'Bing photo of the day', icon: '🌇',
    group: 'Photos', popular: true,
    desc: 'A new landscape every day, no account needed',
    kind: 'photos', sourceKind: 'photos',
    sourceConfig: { backend: 'bing', market: 'en-US', count: 8, quality: '1920x1080' },
  },
  {
    id: 'unsplash-photos', label: 'Unsplash', icon: '📸',
    group: 'Photos',
    desc: 'Stock photography by search term (free key)',
    kind: 'photos', sourceKind: 'photos',
    sourceConfig: { backend: 'unsplash', orientation: 'landscape', count: 12 },
  },
  {
    id: 'rss-block', label: 'News feed', icon: '📰',
    group: 'News', popular: true,
    desc: 'Headlines from any RSS or Atom feed',
    kind: 'rss', sourceKind: 'rss',
  },
  {
    id: 'weather-block', label: 'Weather', icon: '🌤️',
    group: 'Weather', popular: true,
    desc: 'Current conditions and forecast for a place',
    kind: 'weather', sourceKind: 'weather',
  },
  {
    id: 'ha-block', label: 'Home Assistant', icon: '🏡',
    group: 'Smart home', popular: true,
    desc: 'Show entity states from Home Assistant',
    kind: 'homeassistant', sourceKind: 'homeassistant',
  },
  {
    id: 'ha-control-block', label: 'Home Assistant controls', icon: '🎛️',
    group: 'Smart home',
    desc: 'Toggle lights and run scenes from the board',
    kind: 'ha_control', sourceKind: 'homeassistant',
  },
  {
    id: 'obsidian-notes', label: 'Obsidian notes', icon: '🗒️',
    group: 'Notes',
    desc: 'Excerpts from a folder in your vault',
    kind: 'obsidian_notes', sourceKind: 'obsidian',
    sourceConfig: { base_url: 'http://127.0.0.1:27123' },
  },
  {
    id: 'postit-note', label: 'Sticky note', icon: '📝',
    group: 'Utility', popular: true,
    desc: 'A coloured note - type it, or feed it from Google Tasks',
    kind: 'postit',
  },
];

/* Everything in the picker: the service presets, then every widget kind. A
 * widget that needs a source but was added bare still works - it just says so
 * in its own properties until one is chosen. */
function blockEntries() {
  const fromCatalogue = Object.entries(CATALOGUE).map(([kind, def]) => ({
    id: `kind:${kind}`,
    label: def.label || kind,
    icon: def.icon || '▫',
    group: def.group || 'Other',
    desc: def.blurb || '',
    kind,
  }));
  return [...BLOCK_PRESETS, ...fromCatalogue];
}

async function addBlock(entry, stage, panel) {
  let sourceId = null;

  /* ADDING A BLOCK DOES NOT CREATE A SOURCE.
   *
   * It used to: a preset "owned" its source and made one on the spot, so
   * dragging in a Google Photos block silently created an empty photos source
   * called "Google Photos". Convenient in the intended flow, and wrong in the
   * one people actually use - build the sources you want on the Sources page,
   * then lay blocks out and point them at those. What it produced instead was
   * a Sources page filling up with blanks nobody made on purpose, each one
   * unconfigured and each one therefore reporting an error on the wall.
   *
   * A layout is an arrangement. It should not have side effects on the things
   * it arranges.
   *
   * So a preset now PICKS rather than creates. If exactly one source of the
   * right kind already exists it is selected, because that is unambiguous and
   * saves a step. Otherwise the block is added bare and says so in its own
   * properties, which is what a widget added straight from the catalogue has
   * always done.
   */
  if (entry.sourceKind) {
    const existing = (state.sources || []).filter((src) => {
      if (src.kind !== entry.sourceKind) return false;
      // Photo sources differ by backend, so a Google Photos block must not
      // land on an Immich source just because both are 'photos'.
      const want = (entry.sourceConfig || {}).backend;
      if (!want) return true;
      try {
        const config = typeof src.config === 'string'
          ? JSON.parse(src.config || '{}') : (src.config || {});
        return config.backend === want;
      } catch {
        return false;
      }
    });
    if (existing.length === 1) sourceId = existing[0].id;
  }

  const def = CATALOGUE[entry.kind] || {};
  const d = def.defaults || {};
  const config = {};
  if (sourceId != null) {
    // Calendars take a LIST, because merging several onto one is the point.
    const wantsList = (def.fields || []).some((f) => f.key === 'source_ids');
    if (wantsList) config.source_ids = [sourceId];
    else config.source_id = sourceId;
  }

  state.editing.widgets.push({
    kind: entry.kind,
    x: 5, y: 5, w: d.w || 30, h: d.h || 20,
    z: state.editing.widgets.length,
    config,
  });
  state.selected = state.editing.widgets.length - 1;
  state.dirty = true;
  drawStage(stage);
  drawProps(panel, stage);

  // Hand straight over to the step that service actually needs next.
  const source = state.sources.find((x) => x.id === sourceId);
  if (source && SOURCE_KINDS[source.kind]?.oauth) {
    toast(`Added. Sign in to finish setting up ${entry.label}.`);
    await connectAccount(source);
  } else if (source) {
    toast(`Added. Fill in the details for ${entry.label} on the Sources tab.`);
  } else {
    toast(`Added ${entry.label}`);
  }
}

function openBlockPicker(stage, panel) {
  const entries = blockEntries();
  const groups = ['Popular', ...new Set(entries.map((e) => e.group))];
  let activeGroup = 'Popular';
  let query = '';

  const results = el('div', {
    style: {
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
      gap: '.6rem', alignContent: 'start',
      maxHeight: '58vh', overflow: 'auto', paddingRight: '.3rem',
    },
  });

  const sideList = el('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '.15rem', minWidth: '160px' },
  });

  let close = () => {};

  const paint = () => {
    const needle = query.trim().toLowerCase();
    // A search looks everywhere; the categories are for browsing, and applying
    // both at once makes a search silently miss the obvious answer.
    const shown = entries.filter((e) => {
      if (needle) {
        return `${e.label} ${e.desc} ${e.group}`.toLowerCase().includes(needle);
      }
      return activeGroup === 'Popular' ? !!e.popular : e.group === activeGroup;
    });

    results.replaceChildren();
    if (!shown.length) {
      results.append(el('p', { class: 'hint' }, `Nothing matches "${query}".`));
    }
    for (const entry of shown) {
      results.append(el('div', {
        style: {
          border: '1px solid var(--line)', borderRadius: 'var(--radius)',
          padding: '.7rem', cursor: 'pointer', background: 'var(--panel-2)',
          display: 'flex', gap: '.6rem', alignItems: 'flex-start',
        },
        onclick: guard(async () => {
          close();
          await addBlock(entry, stage, panel);
        }),
      },
        el('span', {
          style: {
            flex: '0 0 auto', display: 'flex', alignItems: 'center',
            justifyContent: 'center', width: '2rem', height: '2rem',
            borderRadius: '8px', background: 'var(--panel)',
            border: '1px solid var(--line)', color: 'var(--accent)',
          },
        }, blockIcon(entry, { size: 18 })),
        el('div', { style: { minWidth: '0' } },
          el('div', { style: { fontWeight: '600' } }, entry.label),
          entry.desc
            ? el('div', { class: 'hint', style: { marginTop: '.15rem' } }, entry.desc)
            : null)));
    }

    sideList.replaceChildren();
    for (const group of groups) {
      sideList.append(el('button', {
        class: group === activeGroup && !needle ? 'primary' : '',
        style: { textAlign: 'left' },
        onclick: () => { activeGroup = group; query = ''; search.value = ''; paint(); },
      }, group));
    }
  };

  const search = el('input', {
    placeholder: 'Search blocks…', autofocus: true,
    oninput: (e) => { query = e.target.value; paint(); },
  });

  const body = el('div', {},
    search,
    el('div', {
      style: { display: 'flex', gap: '1rem', marginTop: '.9rem', alignItems: 'stretch' },
    }, sideList, results));

  paint();
  close = modal('Add a block', body, []);
}

/* ------------------------------------------------------------------ modal */

/* Returns a close() so callers that finish asynchronously - a device-code
 * sign-in polling in the background - can dismiss it themselves.
 *
 * `buttons` is [label, handler] pairs; a handler that throws leaves the modal
 * open with the error shown, because closing a dialog on failure loses both
 * the message and whatever the user had typed. */
function modal(title, body, buttons = []) {
  const problem = el('div', {
    style: { color: 'var(--bad)', marginTop: '.6rem', display: 'none' },
  });

  const overlay = el('div', {
    style: {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,.62)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '90', padding: '1.5rem',
    },
  });

  const close = () => overlay.remove();

  const footer = el('div', {
    style: {
      display: 'flex', gap: '.5rem', justifyContent: 'flex-end',
      marginTop: '1.1rem',
    },
  },
    ...buttons.map(([label, handler]) => el('button', {
      class: 'primary',
      onclick: async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        try {
          await handler();
          close();
        } catch (err) {
          problem.textContent = err.message || String(err);
          problem.style.display = 'block';
        } finally {
          button.disabled = false;
        }
      },
    }, label)),
    el('button', { onclick: close }, buttons.length ? 'Cancel' : 'Close'));

  overlay.append(el('div', {
    class: 'card',
    style: {
      maxWidth: '620px', width: '100%', maxHeight: '82vh', overflow: 'auto',
      margin: '0',
    },
    // A click inside must not reach the overlay's dismiss handler.
    onclick: (e) => e.stopPropagation(),
  },
    el('h2', { style: { marginTop: '0' } }, title),
    body,
    problem,
    footer));

  // Click-away and Escape both dismiss, because a dialog you cannot leave is
  // the thing people actually complain about.
  overlay.addEventListener('click', close);
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);

  document.body.append(overlay);
  return close;
}

/* ------------------------------------------------------------ edit source */

/* The same field list the add form uses, rendered against an existing source.
 * One definition, so a field added to SOURCE_KINDS appears in both places. */
function editSource(source) {
  const kindDef = SOURCE_KINDS[source.kind];
  if (!kindDef) { toast(`Nothing to configure for ${source.kind}`, true); return; }

  const config = { ...(source.config || {}) };
  const fieldsBox = el('div', {});

  const rebuild = () => {
    // Seed selects before evaluating conditions, since a field's visibility
    // usually depends on a select that has never been touched.
    for (const [key, , type, options] of kindDef.fields) {
      if (type === 'select' && config[key] == null) config[key] = options[0][0];
    }

    fieldsBox.replaceChildren();
    for (const [key, label, type, options, when] of kindDef.fields) {
      if (typeof when === 'function' && !when(config)) continue;

      let control;
      if (type === 'select') {
        control = el('select', {
          onchange: (e) => { config[key] = e.target.value; rebuild(); },
        }, ...options.map(([v, l]) => el('option', {
          value: v, selected: config[key] === v,
        }, l)));
      } else if (type === 'bool') {
        control = el('input', {
          type: 'checkbox', checked: !!config[key],
          onchange: (e) => { config[key] = e.target.checked; },
        });
      } else if (type === 'geocode') {
        control = geocodeControl(config);
      } else if (type === 'textarea') {
        // A list of URLs. A single-line input technically holds them but is
        // unusable past the second one, which is the whole point of the field.
        control = el('textarea', {
          rows: '4',
          style: { width: '100%', fontFamily: 'inherit', resize: 'vertical' },
          value: config[key] == null ? '' : String(config[key]),
          oninput: (e) => { config[key] = e.target.value; },
        });
      } else {
        control = el('input', {
          type: type === 'password' ? 'password' : type === 'number' ? 'number' : 'text',
          value: config[key] == null ? '' : String(config[key]),
          // No redraw on input, or the field loses focus after every letter -
          // the same bug the widget property panel had.
          oninput: (e) => {
            config[key] = type === 'number' ? Number(e.target.value) : e.target.value;
          },
        });
      }
      fieldsBox.append(el('div', { class: 'field' }, el('label', {}, label), control));
    }
    if (kindDef.help) fieldsBox.append(el('p', { class: 'hint' }, kindDef.help));
  };

  rebuild();

  modal(`${source.name} — ${kindDef.label}`, fieldsBox, [
    ['Save and test', async () => {
      await api(`/api/sources/${source.id}`, { method: 'PATCH', body: { config } });
      await refresh();
      // Test straight away: the whole reason to edit is that it was not
      // working, so saying nothing about whether it works now is useless.
      const result = await api(`/api/sources/${source.id}/test`, { method: 'POST' });
      await refresh();
      render();
      if (result.ok) toast(result.summary || 'Working');
      else toast(result.error || 'Still not working', true);
    }],
  ]);
}

/* ------------------------------------------------------- account linking */

/* Two providers, two flows, and the difference is not cosmetic.
 *
 * Microsoft supports the DEVICE CODE flow: the appliance shows a short code,
 * you type it on any other machine, and nothing ever redirects. That is the
 * right shape for a wall display - no redirect URI to register, no secret to
 * store, and it works when the board has no reachable hostname.
 *
 * Google does not offer device flow for Calendar scopes, and rejects any
 * redirect URI that is not HTTPS or loopback - so a plain LAN address is
 * refused by Google, not by us. docs/oauth.md covers the ways round it. The
 * honest advice, offered here rather than buried, is to use the secret .ics
 * link instead: it needs no app registration and works today. */
async function connectAccount(source) {
  const started = await api(`/api/oauth/${source.id}/start`, {
    method: 'POST',
    body: { redirect_uri: `${location.origin}/api/oauth/callback` },
  }).catch((err) => ({ error: err.message }));

  if (started.error) { toast(started.error, true); return; }

  if (started.flow === 'redirect') {
    // Opened rather than navigated, so an unsaved layout is not lost.
    window.open(started.authorize_url, '_blank', 'noopener');
    modal('Finish in the other tab', el('div', {},
      el('p', {}, 'Approve access to your Google account in the tab that just '
        + 'opened, then come back here and press Done.'),
      el('p', { class: 'hint' },
        'If Google refused the redirect address, that is its policy on plain '
        + 'LAN addresses rather than a fault here — the secret .ics link is '
        + 'the quickest way round it.')),
      [['Done', async () => { await refresh(); render(); }]]);
    return;
  }

  // Device flow: show the code and poll until it is approved or expires.
  const code = el('div', {
    style: {
      fontSize: '2rem', letterSpacing: '.18em', fontWeight: '600',
      margin: '.6rem 0', userSelect: 'all',
    },
  }, started.user_code);
  const statusLine = el('p', { class: 'hint' }, 'Waiting for you to approve it…');

  const close = modal(`Sign in to ${SOURCE_KINDS[source.kind].label}`, el('div', {},
    el('p', {}, 'On any other device, open:'),
    el('p', {}, el('a', {
      href: started.verification_uri, target: '_blank', rel: 'noopener',
    }, started.verification_uri)),
    el('p', {}, 'and enter this code:'),
    code,
    statusLine), []);

  const deadline = Date.now() + (started.expires_in || 900) * 1000;
  let wait = Math.max(2, Number(started.interval || 5)) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));
    let result;
    try {
      result = await api(`/api/oauth/${source.id}/poll`, { method: 'POST' });
    } catch (err) {
      statusLine.textContent = err.message; statusLine.style.color = 'var(--bad)';
      return;
    }
    if (result.ok) {
      close();
      await refresh(); render();
      toast('Account connected');
      await pickCalendars({ ...source, connected: true });
      return;
    }
    // The provider asks us to back off rather than guessing an interval.
    if (result.slow_down) wait += 5000;
    if (result.error) {
      statusLine.textContent = result.error;
      statusLine.style.color = 'var(--bad)';
      return;
    }
  }
  statusLine.textContent = 'The code expired. Close this and press Connect again.';
  statusLine.style.color = 'var(--bad)';
}

/* Which calendars in the account to actually read. Picked from a list rather
 * than typed, because calendar ids are opaque strings nobody knows by heart. */
async function pickCalendars(source) {
  let listing;
  try {
    listing = await api(`/api/oauth/${source.id}/calendars`);
  } catch (err) {
    toast(err.message, true);
    return;
  }

  const chosen = new Set(source.config?.calendar_ids || []);
  const rows = el('div', {});
  for (const cal of listing.calendars || []) {
    const box = el('input', {
      type: 'checkbox', checked: chosen.has(cal.id),
      onchange: (e) => (e.target.checked ? chosen.add(cal.id) : chosen.delete(cal.id)),
    });
    rows.append(el('label', {
      style: {
        display: 'flex', gap: '.6rem', alignItems: 'center', padding: '.3rem 0',
      },
    },
      box,
      cal.colour
        ? el('span', {
            style: {
              width: '.8rem', height: '.8rem', borderRadius: '50%',
              background: cal.colour, flex: '0 0 auto',
            },
          })
        : null,
      el('span', {}, cal.name || cal.id),
      cal.primary ? el('span', { class: 'pill' }, 'primary') : null));
  }

  if (!(listing.calendars || []).length) {
    rows.append(el('p', { class: 'hint' }, 'That account has no calendars.'));
  }

  modal('Calendars to show', rows, [
    ['Save', async () => {
      await api(`/api/sources/${source.id}`, {
        method: 'PATCH',
        body: { config: { ...(source.config || {}), calendar_ids: [...chosen] } },
      });
      await refresh(); render();
      toast('Calendars updated');
    }],
  ]);
}

/* ------------------------------------------------------------------ theme */

/* The tokens the appearance tab exposes. Names match the custom properties
 * defined in index.html; the labels are what a person sees. Anything not
 * listed here stays under the preset's control. */
const THEME_VARS = [
  ['--bg', 'Page background'],
  ['--panel', 'Card background'],
  ['--panel-2', 'Inset background'],
  ['--line', 'Borders'],
  ['--fg', 'Text'],
  ['--dim', 'Muted text'],
  ['--accent', 'Accent'],
  ['--good', 'Success'],
  ['--warn', 'Warning'],
  ['--bad', 'Error'],
];

/* Stored as a JSON object of {token: '#rrggbb'}. A corrupt value must not take
 * the whole UI down with it - an unreadable theme is worth strictly less than
 * a usable admin page. */
function readColours() {
  try {
    const parsed = JSON.parse(state.settings.admin_colours || '{}');
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

/* Apply the stored theme to the document. Called on every render so a preset
 * change, a colour pick or a radius nudge previews immediately. */
function applyTheme() {
  const root = document.documentElement;
  if (!root) return;

  root.setAttribute('data-theme', state.settings.admin_theme || 'dark');

  // Clear previous overrides before applying the current set, or a token that
  // has just been reset would keep the colour it was reset away from.
  for (const [name] of THEME_VARS) root.style.removeProperty(name);

  const colours = readColours();
  for (const [name] of THEME_VARS) {
    if (colours[name]) root.style.setProperty(name, colours[name]);
  }

  const radius = Number(state.settings.admin_radius);
  if (Number.isFinite(radius) && radius >= 0) {
    root.style.setProperty('--radius', `${radius}px`);
  } else {
    root.style.removeProperty('--radius');
  }
}

/* ------------------------------------------------------------ first run */

/* The wizard asks only what cannot be answered later from a browser: who the
 * administrator is, how the box gets on the network, and which way up the
 * screen is. Everything else - sources, layouts, widgets - is deliberately
 * NOT here, because it is far easier to do on a real screen once the appliance
 * is reachable.
 *
 * The network step is the one that matters. It does not just fire a connect
 * and hope: it waits for the link, then shows the address the device actually
 * got, because that address is how you reach it from then on and there is no
 * console to run `ip a` on. */

const WIZARD_STEPS = ['Administrator', 'Network', 'Display', 'Done'];

function wizardShell(title, subtitle, body, footer) {
  const dots = el('div', {
    style: { display: 'flex', gap: '.4rem', marginBottom: '1.2rem' },
  }, ...WIZARD_STEPS.map((label, index) => el('div', {
    style: {
      flex: '1', height: '3px', borderRadius: '2px',
      background: index <= state.wizardStep ? 'var(--accent)' : 'var(--line)',
    },
    title: label,
  })));

  APP.replaceChildren(el('div', {
    style: { maxWidth: '560px', margin: '8vh auto', padding: '0 1rem' },
  },
    el('div', {
      style: {
        fontSize: '.8rem', letterSpacing: '.28em', color: 'var(--dim)',
        marginBottom: '1rem',
      },
    }, 'LIFEBOARD — FIRST RUN'),
    dots,
    el('div', { class: 'card' },
      el('h2', {}, title),
      subtitle ? el('p', { class: 'hint' }, subtitle) : null,
      body,
      footer ? el('div', { style: { marginTop: '1.1rem' } }, footer) : null,
    ),
  ));
}

async function renderWizard() {
  const info = await api('/api/setup/state').catch(() => ({}));
  state.wizardInfo = info;

  // Skip straight past anything already satisfied on a re-run.
  if (state.wizardStep === 0 && info.account) state.wizardStep = 1;
  if (state.wizardStep === 1 && info.network) state.wizardStep = 2;

  if (state.wizardStep === 0) return wizardAccount();
  if (state.wizardStep === 1) return wizardNetwork(info);
  if (state.wizardStep === 2) return wizardDisplay(info);
  return wizardDone(info);
}

function wizardAccount() {
  const username = el('input', { value: 'admin', autofocus: true });
  const password = el('input', { type: 'password', placeholder: 'At least 8 characters' });
  const confirm = el('input', { type: 'password', placeholder: 'Again' });
  const problem = el('div', { style: { color: 'var(--bad)', marginTop: '.5rem' } });

  const submit = guard(async () => {
    problem.textContent = '';
    if (password.value.length < 8) {
      problem.textContent = 'The password needs at least 8 characters.'; return;
    }
    if (password.value !== confirm.value) {
      problem.textContent = 'Those two passwords do not match.'; return;
    }
    await api('/api/setup', {
      method: 'POST',
      body: { username: username.value.trim() || 'admin', password: password.value },
    });
    state.authed = true;
    state.setupNeeded = false;
    // Carry on through Wi-Fi and display. setupNeeded only means "no password
    // yet", so without this the account step dropped straight into the admin
    // and the network step was never shown.
    state.inSetup = true;
    state.wizardStep = 1;
    render();
  });
  confirm.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  wizardShell(
    'Create the administrator',
    'One account runs this appliance — there is no local login on the device '
    + 'itself, so this is how you reach it. Keep it somewhere safe; there is no '
    + 'reset link.',
    el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Username'), username),
      el('div', { class: 'field' }, el('label', {}, 'Password'), password),
      el('div', { class: 'field' }, el('label', {}, 'Confirm password'), confirm),
      problem),
    el('button', { class: 'primary', onclick: submit }, 'Continue'),
  );
}

function wizardNetwork(info) {
  const body = el('div', {});
  const status = el('div', { style: { marginBottom: '.8rem' } });

  const showOnline = () => {
    status.replaceChildren(
      el('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
        el('span', { class: 'pill ok' }, 'connected'),
        el('span', {}, 'This device is on the network.')),
      info.addresses?.length
        ? el('div', { style: { marginTop: '.6rem' } },
            el('label', {}, 'Reach it at'),
            ...info.addresses.map((ip) => el('div', {},
              el('code', { style: { fontSize: '1.05rem' } }, `http://${ip}:8080/admin/`))))
        : null,
    );
  };

  if (info.network) {
    showOnline();
    body.append(status,
      el('p', { class: 'hint' },
        'Wired or already-saved Wi-Fi. You can still join a different network '
        + 'below if you would rather.'));
  } else {
    status.replaceChildren(el('span', { class: 'pill err' }, 'not connected'));
    body.append(status);
  }

  if (!info.has_wifi) {
    body.append(el('p', { class: 'muted' },
      'No Wi-Fi adapter detected — this device is Ethernet only.'));
    return wizardShell('Network', null, body,
      el('button', {
        class: 'primary',
        onclick: () => { state.wizardStep = 2; render(); },
      }, info.network ? 'Continue' : 'Continue anyway'));
  }

  const ssid = el('input', { placeholder: 'Network name' });
  const psk = el('input', { type: 'password', placeholder: 'Wi-Fi password' });
  const hidden = el('input', { type: 'checkbox' });
  const restart = el('input', { type: 'checkbox' });
  const found = el('div', { style: { marginTop: '.4rem' } });
  const result = el('div', { style: { marginTop: '.8rem' } });

  /* The networks in range, as a list to tap. Runs by itself when this step
   * opens, so the person never has to know a network name. On the setup
   * hotspot the radio cannot scan, and the server answers with what it saw
   * just before the hotspot went up (`cached`). */
  const bars = (signal) => (signal >= 70 ? '▂▄▆█' : signal >= 45 ? '▂▄▆ ' : signal >= 20 ? '▂▄  ' : '▂   ');
  const scan = guard(async () => {
    found.replaceChildren(el('span', { class: 'muted' }, 'Looking for networks…'));
    const data = await api('/api/system/network/scan');
    if (!data.networks?.length) {
      found.replaceChildren(el('span', { class: 'muted' },
        'No networks found. Type the name below, or tap Scan again.'));
      return;
    }
    const rows = data.networks.slice(0, 15).map((net) => {
      const locked = net.security && net.security !== 'open';
      const row = el('button', {
        class: 'wifi-row',
        style: {
          display: 'flex', width: '100%', alignItems: 'center', gap: '.6rem',
          textAlign: 'left', padding: '.55rem .7rem', marginTop: '.25rem',
        },
        onclick: () => {
          ssid.value = net.ssid;
          for (const r of rows) r.style.outline = '';
          row.style.outline = '2px solid var(--accent)';
          if (locked) psk.focus(); else psk.value = '';
        },
      },
        el('span', { style: { fontFamily: 'monospace', letterSpacing: '-1px', opacity: '.8' } },
          bars(net.signal)),
        el('span', { style: { flex: '1 1 auto', fontWeight: '600' } }, net.ssid),
        el('span', { class: 'muted' }, locked ? '🔒' : 'open'));
      return row;
    });
    found.replaceChildren(
      ...rows,
      data.cached
        ? el('p', { class: 'hint', style: { marginTop: '.4rem' } },
            'Seen just before setup mode started - the board cannot scan while '
            + 'it is running its own setup network.')
        : null,
    );
  });

  const connect = guard(async () => {
    if (!ssid.value.trim()) {
      result.replaceChildren(el('span', { style: { color: 'var(--bad)' } },
        'Enter a network name.'));
      return;
    }
    result.replaceChildren(el('span', { class: 'muted' },
      'Joining… this can take up to a minute, and this page may briefly lose '
      + 'contact if you are connected through the setup hotspot.'));

    await api('/api/system/network/connect', {
      method: 'POST',
      body: {
        ssid: ssid.value.trim(), password: psk.value, hidden: hidden.checked,
        reboot: restart.checked,
      },
    }).catch(() => null);   // the reply is often lost as the hotspot drops

    if (restart.checked) {
      /* Nothing to poll for: the box is going down, and the browser asking
       * the question is very likely attached to the hotspot that goes with
       * it. The TV is the only thing that can report the outcome, which is
       * exactly what its setup screen is for. */
      result.replaceChildren(
        el('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
          el('span', { class: 'pill' }, 'restarting'),
          el('span', {}, `The board is restarting onto ${ssid.value.trim()}.`)),
        el('p', { class: 'hint' },
          'Rejoin your normal Wi-Fi. In a minute or two the TV shows its own '
          + 'address - open that to carry on.'));
      return;
    }

    // Confirm by polling rather than trusting the call: what matters is that
    // the link actually came up and what address it got.
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 3000));
      const now = await api('/api/setup/state').catch(() => null);
      if (now?.network) {
        state.wizardInfo = now;
        result.replaceChildren(
          el('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
            el('span', { class: 'pill ok' }, 'connected'),
            el('span', {}, `Joined ${ssid.value.trim()}`)),
          el('div', { style: { marginTop: '.6rem' } },
            el('label', {}, 'This device is now at'),
            ...(now.addresses || []).map((ip) => el('div', {},
              el('code', { style: { fontSize: '1.05rem' } }, `http://${ip}:8080/admin/`)))),
          el('p', { class: 'hint' },
            'Write that address down. If you were connected to the setup '
            + 'hotspot, rejoin your normal Wi-Fi and open it there.'),
          el('button', {
            class: 'primary', style: { marginTop: '.6rem' },
            onclick: () => { state.wizardStep = 2; render(); },
          }, 'Continue'),
        );
        return;
      }
    }
    result.replaceChildren(el('div', { style: { color: 'var(--bad)' } },
      'It did not come up within a minute. Check the password and that the '
      + 'network is in range, then try again.'));
  });

  // A failed join drops the phone off the hotspot before it can hear why;
  // when it comes back, say what happened.
  const attempt = info.wifi_attempt;
  if (attempt && !attempt.ok && !info.network) {
    body.append(el('div', {
      style: { color: 'var(--bad)', margin: '.2rem 0 .8rem' },
    }, `Could not join "${attempt.ssid}": ${attempt.error || 'it did not connect.'} `
      + 'Check the password and try again.'));
  }

  body.append(
    el('div', { class: 'field' },
      el('label', {}, 'Choose your Wi-Fi'),
      found,
      el('button', { style: { marginTop: '.4rem' }, onclick: scan }, 'Scan again'),
      el('label', { style: { marginTop: '.8rem' } }, 'Network name'),
      ssid),
    el('div', { class: 'field' }, el('label', {}, 'Password'), psk),
    el('label', { style: { display: 'flex', gap: '.4rem', alignItems: 'center' } },
      hidden, 'Hidden network'),
    el('label', { class: 'check', style: { marginTop: '.8rem' } },
      restart,
      el('span', {}, 'Restart the board after joining')),
    el('p', { class: 'hint', style: { marginTop: '.1rem' } },
      info.hotspot_active
        ? 'Recommended here: this phone is on the board’s setup network, '
          + 'which goes away when it joins yours, so it cannot watch for the '
          + 'result. Rejoin your own Wi-Fi afterwards - the TV shows the '
          + 'board’s new address.'
        : 'Not required - it joins straight away either way, and this page '
          + 'tells you the new address as soon as it connects.'),
    result,
  );
  // On the setup hotspot this page loses contact the moment the board joins
  // the real network, so the restart path - which the TV reports on - is the
  // one that reliably works.
  restart.checked = !!info.hotspot_active;

  wizardShell('Network', 'The appliance needs to be reachable before anything '
    + 'else can be configured.', body,
    el('div', { style: { display: 'flex', gap: '.5rem' } },
      el('button', { class: 'primary', onclick: connect }, 'Join network'),
      info.network
        ? el('button', { onclick: () => { state.wizardStep = 2; render(); } }, 'Skip')
        : null));
  // Fill the list straight away rather than waiting for a tap.
  scan();
}

function wizardDisplay(info) {
  const orientation = el('select', {},
    ...[['normal', 'Landscape'],
        ['right', 'Portrait — rotated right'],
        ['left', 'Portrait — rotated left'],
        ['inverted', 'Upside down']]
      .map(([v, l]) => el('option', {
        value: v, selected: (info.orientation || 'normal') === v,
      }, l)));

  const tz = el('select', {});
  const tzFilter = el('input', { placeholder: 'Type to filter, e.g. New_York' });

  const loadZones = guard(async (q = '') => {
    const data = await api(`/api/system/timezones${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const current = info.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const list = q ? data.all : [...data.common, '——————', ...data.all];
    tz.replaceChildren(...list.map((zone) => el('option', {
      value: zone === '——————' ? '' : zone,
      disabled: zone === '——————',
      selected: zone === current,
    }, zone)));
    if (!q && list.includes(current)) tz.value = current;
  });
  loadZones();
  tzFilter.addEventListener('input', () => loadZones(tzFilter.value.trim()));

  const submit = guard(async () => {
    await api('/api/setup/finish', {
      method: 'POST',
      body: {
        screen_id: info.screen_id || 1,
        orientation: orientation.value,
        timezone: tz.value || undefined,
      },
    });
    state.wizardStep = 3;
    render();
  });

  wizardShell(
    'Display',
    'Rotation is applied to the display itself, not faked in the page — that '
    + 'is what keeps hardware video decode working in portrait.',
    el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Screen orientation'), orientation),
      el('div', { class: 'field' },
        el('label', {}, 'Timezone'),
        tzFilter,
        el('div', { style: { marginTop: '.3rem' } }, tz),
        el('div', { class: 'help' },
          'Used for the clock, calendars and the on/off schedule.')),
    ),
    el('button', { class: 'primary', onclick: submit }, 'Finish setup'),
  );
}

function wizardDone(info) {
  wizardShell(
    'Ready',
    null,
    el('div', {},
      el('p', {}, 'The board is live. From here everything is done in this web UI:'),
      el('ul', { style: { lineHeight: '1.7', paddingLeft: '1.2rem' } },
        el('li', {}, 'Pick a starting point on ', el('strong', {}, 'Templates')),
        el('li', {}, 'Add calendars, weather and photos under ', el('strong', {}, 'Sources')),
        el('li', {}, 'Arrange it on ', el('strong', {}, 'Layout')),
        el('li', {}, 'Set the screen on/off schedule under ', el('strong', {}, 'Display')),
      ),
      info.addresses?.length
        ? el('p', { class: 'hint' },
            `Bookmark http://${info.addresses[0]}:8080/admin/`)
        : null,
    ),
    el('button', {
      class: 'primary',
      onclick: guard(async () => {
        state.inSetup = false;
        await refresh();
        state.tab = 'templates';
        render();
      }),
    }, 'Open the dashboard'),
  );
}

/* ------------------------------------------------------------------- gate */

function renderGate() {
  if (state.setupNeeded) { renderWizard(); return; }

  const username = el('input', {
    value: state.knownUsername || 'admin', autofocus: true,
  });
  const password = el('input', { type: 'password', placeholder: 'Password' });
  const submit = guard(async () => {
    await api('/api/login', {
      method: 'POST',
      body: { username: username.value.trim(), password: password.value },
    });
    state.authed = true;
    // Signing in over the setup hotspot means this board has lost its
    // network (moved house, new router): Wi-Fi is the only thing to do here.
    const setup = await api('/api/setup/state').catch(() => null);
    if (setup && !setup.network && setup.hotspot_active) {
      state.inSetup = true;
      state.wizardStep = 1;
    }
    await refresh();
    render();
  });
  password.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  APP.replaceChildren(el('div', { id: 'gate', class: 'card' },
    el('h2', {}, 'LifeBoard'),
    el('div', { class: 'field' }, el('label', {}, 'Username'), username),
    el('div', { class: 'field' }, el('label', {}, 'Password'), password),
    el('div', { style: { marginTop: '.8rem' } },
      el('button', { class: 'primary', onclick: submit }, 'Sign in')),
  ));
}

/* ------------------------------------------------------------------ shell */

/* The sidebar, in DAKboard's shape: the things you DO at the top, the
 * libraries you pick FROM in the middle, the machine itself at the bottom.
 *
 * A left rail rather than a row of tabs because that is the arrangement the
 * canvas wants - the editor is wide and short of height, and tabs were taking
 * a strip off the top of every page to show six words. */
const NAV = [
  [null, [
    ['layout', 'Layout', 'grid'],
    ['sources', 'Sources', 'link'],
  ]],
  ['Templates', [
    ['templates', 'Screen templates', 'image'],
  ]],
  ['Manage', [
    ['display', 'Display', 'sun'],
    ['system', 'System', 'sliders'],
    ['settings', 'Settings', 'gauge'],
  ]],
];

function render() {
  applyTheme();
  // Setup FIRST. On a fresh appliance `authed` is true (the API is open
  // until a password exists), so checking authed first sent a brand new
  // box straight into an empty admin instead of the wizard.
  if (state.setupNeeded) return renderWizard();
  if (!state.authed) return renderGate();
  if (state.inSetup) return renderWizard();

  const nav = el('nav', {});
  for (const [group, items] of NAV) {
    if (group) nav.append(el('div', { class: 'nav-group' }, group));
    for (const [id, label, iconName] of items) {
      nav.append(el('button', {
        class: state.tab === id ? 'active' : '',
        onclick: () => { state.tab = id; render(); },
      }, icon(iconName, { size: 17 }), el('span', {}, label)));
    }
  }
  nav.append(el('div', { class: 'nav-group' }, 'View'));
  nav.append(el('a', {
    href: '/render/', target: '_blank', class: 'nav-link',
  }, icon('globe', { size: 17 }), el('span', {}, 'Open the board')));

  const body = el('main');
  APP.replaceChildren(
    el('aside', { id: 'sidebar' },
      el('h1', {}, 'LIFEBOARD'),
      nav,
    ),
    body,
  );

  // Anything that failed to load, on every tab, before its content. A board
  // that half-loaded and said nothing is how "No screen configured" ended up
  // being read as "this board has no screen".
  if (state.loadProblems && state.loadProblems.length) {
    body.append(el('div', { class: 'card' },
      el('h2', {}, 'Some of the board could not be loaded'),
      el('p', { class: 'warn' },
        'What is shown below may be incomplete or out of date.'),
      el('ul', { style: { margin: '.4rem 0 .8rem 1rem', fontSize: '.85rem' } },
        ...state.loadProblems.map((p) => el('li', {}, p))),
      el('button', {
        class: 'primary',
        onclick: guard(async () => { await refresh(); render(); }),
      }, 'Try again')));
  }

  ({
    templates: renderTemplates,
    layout: renderLayout,
    sources: renderSources,
    display: renderDisplay,
    system: renderSystem,
    settings: renderSettings,
  })[state.tab](body);
}

/* -------------------------------------------------------------- templates */

function templatePreview(template) {
  /* A real rendering of the template, not a diagram of it.
   *
   * Same trick as the layout editor: an iframe at board resolution, scaled
   * down, running the actual widget modules against fixtures. Boxes told you
   * where things sat but nothing about what they were - picking between
   * fifteen templates meant applying one to find out.
   *
   * LAZY, and that is not optional: fifteen templates times a dozen widgets
   * is ~200 widget mounts, and doing them all on tab open makes the gallery
   * crawl. The observer starts each card only when it scrolls into view, and
   * the boxes stay as the placeholder until then. */
  const portrait = template.aspect === 'portrait';
  const board = portrait ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 };

  const box = el('div', {
    class: 'tpl-preview',
    style: { aspectRatio: portrait ? '9 / 16' : '16 / 9' },
  });

  // The geometry sketch, shown until the live preview has painted. It is also
  // the fallback if the iframe never loads, so a template is never a blank
  // rectangle.
  const sketch = el('div', { class: 'tpl-sketch' });
  for (const w of template.widgets || []) {
    sketch.append(el('i', {
      style: { left: `${w.x}%`, top: `${w.y}%`, width: `${w.w}%`, height: `${w.h}%` },
    }));
  }
  box.append(sketch);

  const start = () => {
    if (box.dataset.started) return;
    box.dataset.started = '1';
    const frame = el('iframe', {
      src: './preview.html',
      scrolling: 'no',
      style: {
        position: 'absolute', left: '0', top: '0', border: '0',
        width: `${board.w}px`, height: `${board.h}px`,
        transformOrigin: 'top left', pointerEvents: 'none',
        opacity: '0', transition: 'opacity .2s ease',
      },
    });
    box.append(frame);

    const fit = () => {
      const r = box.getBoundingClientRect();
      if (!r.width) return;
      frame.style.transform = `scale(${r.width / board.w}, ${r.height / board.h})`;
    };

    frame.addEventListener('load', () => {
      fit();
      const api = frame.contentWindow?.__lifeboardPreview;
      if (!api) return;
      try {
        // Templates have no source ids by design, so the gallery fills in a
        // placeholder to show what the board will look like once bound.
        api.render((template.widgets || []).map((w, i) => ({ ...w, __key: i })),
                   template.background || '#101014', { fillSources: true });
        frame.style.opacity = '1';
        sketch.style.display = 'none';
      } catch (err) {
        console.warn('template preview failed', template.id, err);
      }
    });
    // The card has no width until layout runs; re-fit once it does.
    requestAnimationFrame(fit);
  };

  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { start(); io.disconnect(); }
      }
    }, { rootMargin: '200px' });
    // Observing must wait until the node is in the document.
    requestAnimationFrame(() => io.observe(box));
  } else {
    requestAnimationFrame(start);
  }

  return box;
}

async function renderTemplates(root) {
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Templates'),
    el('p', { class: 'hint' },
      'Applying a template creates a NEW layout and switches the screen to it. '
      + 'Your current board is kept and is one dropdown away on the Layout tab.'),
  ));

  // Full definitions are needed for the previews; the list endpoint strips them.
  const full = await Promise.all(
    state.templates.map((t) => api(`/api/templates/${t.id}`).catch(() => null))
  );

  for (const aspect of ['portrait', 'landscape']) {
    const group = full.filter((t) => t && t.aspect === aspect);
    if (!group.length) continue;
    const grid = el('div', { class: 'grid' });
    for (const template of group) {
      grid.append(el('div', { class: 'tpl' },
        templatePreview(template),
        el('h3', {}, template.name),
        el('p', {}, template.description || ''),
        el('button', {
          class: 'primary',
          onclick: guard(async () => {
            const screenId = state.screens[0]?.id || 1;
            await api(`/api/templates/${template.id}/apply`, {
              method: 'POST', body: { screen_id: screenId },
            });
            await refresh();
            toast(`Applied "${template.name}"`);
            state.tab = 'layout'; state.editing = null; render();
          }),
        }, 'Use this'),
      ));
    }
    root.append(el('div', { class: 'card' },
      el('h2', {}, aspect === 'portrait' ? 'Portrait' : 'Landscape'),
      el('p', { class: 'hint' }, aspect === 'portrait'
        ? 'Designed for a screen rotated 90°. Tall and narrow suits a big clock '
          + 'over a long agenda; a month grid does not fit well here.'
        : 'For a normally mounted display.'),
      grid,
    ));
  }
}

/* ----------------------------------------------------------------- layout */

function renderLayout(root) {
  const screen = state.screens[0];
  if (!screen) {
    // Say which it is. "No screen configured" is only true if the board really
    // has none; if the fetch failed, the screen is fine and the message was
    // pointing at the wrong thing entirely.
    const failed = (state.loadProblems || []).find((p) => p.startsWith('/api/screens'));
    root.append(el('div', { class: 'card' },
      el('h2', {}, failed ? 'Could not load the screen' : 'No screen configured'),
      el('p', { class: failed ? 'warn' : 'hint' },
        failed
          ? `The board could not be asked about its screens — ${failed}`
          : 'This board has no screen row, which should not happen. '
            + 'Restarting the board recreates one.'),
      failed
        ? el('button', { class: 'primary', onclick: guard(async () => {
            await refresh(); render();
          }) }, 'Try again')
        : null));
    return;
  }

  if (!state.editing) {
    const active = state.layouts.find((l) => l.id === screen.active_layout_id);
    state.editing = active ? structuredClone(active) : null;
    state.selected = null;
    state.dirty = false;
  }
  if (!state.editing) {
    root.append(el('div', { class: 'card' },
      el('h2', {}, 'No layout yet'),
      el('p', { class: 'hint' }, 'Pick something from the Templates tab to start.')));
    return;
  }

  /* --- editor chrome -------------------------------------------------
   *
   * Two slim rows, not a settings card. The card that used to live here was
   * ~180px of Name / Background / Export / Import / Versions stacked above a
   * 640px stage - the controls you touch once were permanently larger than
   * the thing you actually work in. Everything rare now lives behind the
   * gear; the bar keeps only what you reach for WHILE placing blocks.
   */
  const layoutPicker = el('select', {
    style: { maxWidth: '11rem' },
    onchange: guard(async (e) => {
      await api(`/api/screens/${screen.id}`, {
        method: 'PATCH', body: { active_layout_id: Number(e.target.value) },
      });
      await refresh();
      state.editing = null; render();
    }),
  }, ...state.layouts.map((l) => el('option', {
    value: l.id, selected: l.id === screen.active_layout_id,
  }, l.name)));

  const tool = (label, title, onclick) =>
    el('button', { class: 'tool', title, onclick }, label);

  const portrait = ['left', 'right'].includes(screen.orientation);
  const stage = el('div', {
    id: 'stage',
    style: {
      width: portrait ? '360px' : '720px',
      height: portrait ? '640px' : '405px',
      background: state.editing.background || '#101014',
    },
  });

  /* Zoom. "Fit" means the size that fits the pane; the slider is for leaning
   * in on a small block without having to open its settings to see it. */
  const applyZoom = () => {
    const base = portrait ? { w: 360, h: 640 } : { w: 720, h: 405 };
    stage.style.width = `${Math.round(base.w * state.zoom)}px`;
    stage.style.height = `${Math.round(base.h * state.zoom)}px`;
    ensurePreview(stage, screen);      // rescale the preview iframe to match
    const out = $('#zoom-label');
    if (out) out.textContent = `${Math.round(state.zoom * 100)}%`;
  };

  const zoomSlider = el('input', {
    type: 'range', min: '50', max: '250', step: '5',
    value: String(Math.round(state.zoom * 100)),
    style: { width: '7rem' },
    oninput: (e) => { state.zoom = Number(e.target.value) / 100; applyZoom(); },
  });

  const eyeLabel = () => (state.preview ? '\u{1f441} Preview' : '\u{1f441} Blocks');
  const tagLabel = () => (state.blockTags ? '\u{1f3f7} Names' : '\u{1f3f7} Hidden');

  const bar = el('div', { id: 'editor-bar' },
    el('div', { class: 'bar-left' },
      layoutPicker,
      el('span', { class: 'bar-sep' }),
      el('span', { class: 'bar-label' }, 'Snap'),
      el('select', {
        style: { width: '5.2rem' },
        onchange: (e) => { state.snap = e.target.value === 'px' ? 'px' : Number(e.target.value); },
      }, ...[['0', 'Off'], ['px', '1 px'], ['0.5', '0.5%'], ['1', '1%'], ['2.5', '2.5%'], ['5', '5%']]
          .map(([v, l]) => el('option', { value: v, selected: String(state.snap) === v }, l))),
      el('span', { class: 'bar-sep' }),
      tool('\u21b6', 'Undo (Ctrl+Z)', undo),
      tool('\u21b7', 'Redo (Ctrl+Shift+Z)', redo),
      el('span', { class: 'bar-sep' }),
      tool('\u2922 Fit', 'Shrink the selected blocks to what they actually draw (F)',
        () => fitSelectionToContent(stage)),
      tool(eyeLabel(), 'Draw the real widgets behind the blocks', (e) => {
        state.preview = !state.preview;
        e.target.textContent = eyeLabel();
        const f = $('#preview-frame');
        if (f) f.style.display = state.preview ? '' : 'none';
      }),
      tool(tagLabel(), 'Name every block, not just the selected one', (e) => {
        state.blockTags = !state.blockTags;
        e.target.textContent = tagLabel();
        $('#stage')?.classList.toggle('hide-tags', !state.blockTags);
      }),
    ),
    el('div', { class: 'bar-right' },
      el('span', { class: 'bar-label' }, 'Zoom'),
      tool('Fit', 'Back to the size that fits the pane', () => {
        state.zoom = 1; zoomSlider.value = '100'; applyZoom();
      }),
      zoomSlider,
      el('span', { id: 'zoom-label', class: 'bar-label' },
        `${Math.round(state.zoom * 100)}%`),
      el('span', { class: 'bar-sep' }),
      tool('\u2699 Screen', 'Layout name, background, export, import and versions',
        () => openLayoutSettings(screen)),
      el('button', { class: 'primary', onclick: guard(save) }, 'Save'),
    ),
  );
  root.append(bar);

  // --- stage + properties ---
  const wrap = el('div', { id: 'editor-wrap' },
    el('div', { id: 'stage-outer' }, stage),
    el('div', { id: 'props' }),
  );
  root.append(wrap);

  // Must happen after the stage is in the document, or the iframe starts
  // loading detached and its module never runs.
  const frame = ensurePreview(stage, screen);
  frame.addEventListener('load', () => syncPreview(stage));
  if (!state.preview) frame.style.display = 'none';
  stage.classList.toggle('hide-tags', !state.blockTags);
  applyZoom();

  drawStage(stage);
  drawProps($('#props', wrap), stage);
}

/* Everything the toolbar no longer shows.
 *
 * Name, background, export/import and version history are things you set once
 * and then never touch while arranging blocks, so they belong behind the gear
 * rather than permanently above the canvas. */
function openLayoutSettings(screen) {
  const body = el('div', { style: { minWidth: '30rem' } },
    el('div', { class: 'field' },
      el('label', {}, 'Layout name'),
      el('input', {
        value: state.editing.name || '',
        oninput: (e) => { state.editing.name = e.target.value; state.dirty = true; },
      })),
    el('div', { class: 'field' },
      el('label', {}, 'Background colour'),
      el('input', {
        value: state.editing.background || '#101014',
        oninput: (e) => {
          state.editing.background = e.target.value;
          const st = $('#stage');
          if (st) st.style.background = e.target.value;
          state.dirty = true;
        },
      })),
    backgroundControls(),
    layoutActions(),
    el('p', { class: 'hint' },
      `Screen is ${screen.width}\u00d7${screen.height}, rotated `
      + `${screen.orientation}. Change that on the Display tab.`),
  );
  // modal() takes [label, handler] tuples and closes on a resolved handler.
  modal('Screen settings', body, [['Done', () => {}]]);
}

/* Layout background.
 *
 * A full-bleed photo behind translucent panels is what nearly every community
 * board looks like, so this is a layout property rather than a widget you have
 * to remember to send to the back. The dim slider is not decoration: white text
 * over a bright sky is unreadable, and a board tuned at night becomes useless
 * at noon when the slideshow rotates onto a beach photo.
 */
function backgroundControls() {
  const layout = state.editing;
  const albums = state.sources.filter((s) => s.kind === 'photos');
  const kind = layout.background_kind || 'none';

  const rows = [
    el('div', {}, el('label', {}, 'Background image'),
      el('select', {
        onchange: (e) => {
          layout.background_kind = e.target.value;
          state.dirty = true;
          render();
        },
      }, ...[
        ['none', 'None - flat colour'],
        ['url', 'A single image URL'],
        ['source', 'A photo album (rotates)'],
      ].map(([v, l]) => el('option', { value: v, selected: kind === v }, l)))),
  ];

  if (kind === 'url') {
    rows.push(el('div', {}, el('label', {}, 'Image URL'),
      el('input', {
        value: layout.background_image || '',
        oninput: (e) => { layout.background_image = e.target.value; state.dirty = true; },
      })));
  } else if (kind === 'source') {
    rows.push(el('div', {}, el('label', {}, 'Album'),
      el('select', {
        onchange: (e) => {
          layout.background_source_id = e.target.value ? Number(e.target.value) : null;
          state.dirty = true;
        },
      },
        el('option', { value: '' },
          albums.length ? '- pick an album -' : '- add a photo source first -'),
        ...albums.map((a) => el('option', {
          value: a.id, selected: Number(layout.background_source_id) === a.id,
        }, a.name)))));
  }

  if (kind !== 'none') {
    rows.push(el('div', { class: 'narrow' }, el('label', {}, 'Dim %'),
      el('input', {
        type: 'number', min: '0', max: '100',
        value: layout.background_dim ?? 35,
        oninput: (e) => { layout.background_dim = Number(e.target.value); state.dirty = true; },
      })));
    rows.push(el('div', { class: 'narrow' }, el('label', {}, 'Blur px'),
      el('input', {
        type: 'number', min: '0', max: '40',
        value: layout.background_blur ?? 0,
        oninput: (e) => { layout.background_blur = Number(e.target.value); state.dirty = true; },
      })));
  }

  return el('div', { class: 'row', style: { marginTop: '.8rem' } }, ...rows);
}

/* Per-widget scheduling.
 *
 * Evaluated on the SERVER, so a widget that is out of schedule is never sent
 * to the renderer at all - its data is not fetched and its config does not sit
 * in the page. Filtering in the browser would pay for both. */
function scheduleControls(widget, stage, panel) {
  const sched = widget.schedule || (widget.schedule = {});
  const days = new Set((sched.days || []).map(Number));
  const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const body = el('div', {});
  if (sched.enabled) {
    body.append(el('div', {
      style: { display: 'flex', gap: '.2rem', margin: '.3rem 0' },
    }, ...DAY.map((label, index) => el('label', {
      style: {
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        fontSize: '.68rem', color: 'var(--dim)', cursor: 'pointer',
      },
    },
      label,
      el('input', {
        type: 'checkbox', checked: days.has(index),
        onchange: (e) => {
          if (e.target.checked) days.add(index); else days.delete(index);
          sched.days = [...days].sort((a, b) => a - b);
          state.dirty = true;
        },
      })))));

    const pair = (key, label, type) => el('div', { class: 'narrow' },
      el('label', {}, label),
      el('input', {
        type, value: sched[key] || '',
        oninput: (e) => { sched[key] = e.target.value; state.dirty = true; },
      }));

    body.append(el('div', { class: 'row' },
      pair('from', 'From', 'time'), pair('to', 'To', 'time')));
    body.append(el('div', { class: 'row' },
      pair('start_date', 'Start date', 'date'), pair('end_date', 'End date', 'date')));
    body.append(el('div', { class: 'help' },
      'An overnight window works: 22:00 to 06:00 means across midnight.'));
  }

  return el('div', { class: 'field', style: { borderTop: '1px solid var(--line)', paddingTop: '.6rem' } },
    el('label', {}, 'Schedule'),
    el('label', {
      style: { display: 'flex', gap: '.4rem', alignItems: 'center', color: 'var(--fg)' },
    },
      el('input', {
        type: 'checkbox', checked: !!sched.enabled,
        onchange: (e) => {
          sched.enabled = e.target.checked;
          state.dirty = true;
          drawProps(panel, stage);
        },
      }),
      'Only show at certain times'),
    body,
  );
}

/* Saving, switching and moving layouts between appliances.
 *
 * Export is the same shape as a built-in template on purpose: a board you
 * export can be dropped straight into `templates/` and becomes one. One
 * format rather than two that drift apart.
 */
function layoutActions() {
  const fileInput = el('input', {
    type: 'file', accept: '.json,application/json',
    style: { display: 'none' },
    onchange: guard(async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error('That file is not valid JSON');
      }
      const result = await api('/api/layouts/import', { method: 'POST', body: parsed });
      await refresh();
      state.editing = null;
      state.tab = 'layout';
      render();
      if (result.unmatched_sources?.length) {
        // Say which widgets need re-pointing rather than leaving blanks to be
        // discovered one at a time.
        toast(
          `Imported ${result.widgets} widgets. These sources do not exist here `
          + `and need re-selecting: ${result.unmatched_sources.join(', ')}`,
          true);
      } else {
        toast(`Imported "${parsed.name || 'layout'}" — ${result.widgets} widgets`);
      }
      event.target.value = '';
    }),
  });

  return el('div', { class: 'row', style: { marginTop: '.8rem' } },
    el('div', { class: 'narrow' }, el('label', {}, 'Copy'),
      el('button', {
        onclick: guard(async () => {
          const made = await api(`/api/layouts/${state.editing.id}/duplicate`, {
            method: 'POST', body: { name: `${state.editing.name} copy` },
          });
          await refresh();
          toast('Duplicated');
          state.editing = null;
          render();
          return made;
        }),
      }, 'Duplicate')),

    el('div', { class: 'narrow' }, el('label', {}, 'Backup'),
      el('button', {
        onclick: guard(async () => {
          const data = await api(`/api/layouts/${state.editing.id}/export`);
          const blob = new Blob([JSON.stringify(data, null, 2)],
                                { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = el('a', {
            href: url,
            download: `${(data.name || 'layout').replace(/[^\w-]+/g, '-').toLowerCase()}.json`,
          });
          document.body.append(link);
          link.click();
          link.remove();
          // Revoking immediately can cancel the download in some browsers.
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
          toast('Exported');
        }),
      }, 'Export JSON')),

    el('div', { class: 'narrow' }, el('label', {}, 'Restore'),
      el('button', { onclick: () => fileInput.click() }, 'Import JSON')),

    el('div', { class: 'narrow' }, el('label', {}, 'History'),
      el('button', { onclick: guard(() => showRevisions(state.editing.id)) }, 'Versions')),

    fileInput,
  );
}

/* Revision history. Every save snapshots the board first, so a bad edit is
 * recoverable without an export having been taken in advance. */
async function showRevisions(layoutId) {
  const revisions = await api(`/api/layouts/${layoutId}/revisions`);
  const list = el('div', {});
  if (!revisions.length) {
    list.append(el('p', { class: 'muted' }, 'No saved versions yet.'));
  }
  for (const revision of revisions) {
    list.append(el('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: '.6rem',
        padding: '.35rem 0', borderBottom: '1px solid var(--line)',
      },
    },
      el('div', { style: { flex: '1' } }, revision.created_at,
        revision.note ? el('span', { class: 'muted' }, ` — ${revision.note}`) : null),
      el('button', {
        onclick: guard(async () => {
          await api(`/api/layouts/${layoutId}/revisions/${revision.id}/restore`,
                    { method: 'POST' });
          await refresh();
          state.editing = null;
          render();
          toast('Restored — the previous state was saved too, so this is undoable');
        }),
      }, 'Restore'),
    ));
  }
  const card = el('div', { class: 'card', style: { borderColor: 'var(--accent)' } },
    el('h2', {}, 'Saved versions'),
    el('p', { class: 'hint' },
      'Every save keeps a snapshot. Restoring also snapshots what is there now, '
      + 'so a restore can itself be undone.'),
    list,
    el('button', { onclick: (e) => e.target.closest('.card').remove() }, 'Close'));
  $('main').prepend(card);
}

/* Where each resize handle sits, and which edges it moves. The name encodes
 * the compass direction, which is also how the drag decides what to change. */
const HANDLES = [
  ['nw', { left: '0', top: '0', cursor: 'nwse-resize' }],
  ['n', { left: 'calc(50% - 6px)', top: '0', cursor: 'ns-resize' }],
  ['ne', { right: '0', top: '0', cursor: 'nesw-resize' }],
  ['e', { right: '0', top: 'calc(50% - 6px)', cursor: 'ew-resize' }],
  ['se', { right: '0', bottom: '0', cursor: 'nwse-resize' }],
  ['s', { left: 'calc(50% - 6px)', bottom: '0', cursor: 'ns-resize' }],
  ['sw', { left: '0', bottom: '0', cursor: 'nesw-resize' }],
  ['w', { left: '0', top: 'calc(50% - 6px)', cursor: 'ew-resize' }],
];

/* Percent of the board. Small enough for a thin divider, large enough that a
 * block can always be grabbed again after being shrunk. */
const MIN_SIZE = 3;

/* ---------------------------------------------------------------- preview */

/* The editor draws the REAL widgets behind its drag boxes.
 *
 * Before this, a block was a labelled rectangle, so building a board meant
 * dragging "Weather" over "Calendar" with no idea what either would actually
 * look like or how much of its box it would fill. The preview is the same
 * widget code the wall runs, so it cannot drift.
 *
 * It lives in an IFRAME sized to the board's real pixel dimensions and scaled
 * down with a transform. That is not incidental: widgets size themselves in
 * `vmin`, which resolves against the viewport, so rendering them straight
 * into the admin page would measure vmin against the browser window and a
 * 9vmin clock would come out several times too big. Inside a 1080x1920
 * iframe, vmin means exactly what it means on the wall.
 */
function boardPixels(screen) {
  const w = Number(screen?.width) || 1920;
  const h = Number(screen?.height) || 1080;
  // A screen rotated left/right reports its panel size; the board is the
  // rotated one.
  return ['left', 'right'].includes(screen?.orientation)
    ? { w: Math.min(w, h), h: Math.max(w, h) }
    : { w: Math.max(w, h), h: Math.min(w, h) };
}

function ensurePreview(stage, screen) {
  let frame = stage.querySelector('#preview-frame');
  const board = boardPixels(screen);
  if (!frame) {
    frame = el('iframe', {
      id: 'preview-frame',
      src: './preview.html',
      // Never interactive: every pointer event belongs to the drag boxes on
      // top. Without this the iframe would swallow the first click of every
      // drag.
      style: {
        position: 'absolute', left: '0', top: '0', border: '0',
        transformOrigin: 'top left', pointerEvents: 'none', zIndex: '0',
        background: 'transparent',
      },
      scrolling: 'no',
    });
    stage.append(frame);
  }
  frame.style.width = `${board.w}px`;
  frame.style.height = `${board.h}px`;

  /* Measure the stage, do not take its word for it.
   *
   * The drag boxes are positioned in PERCENT, so they follow whatever size the
   * stage really ends up. Scaling the preview from `style.width` instead
   * assumes nothing else touched it - and something did: as a flex item the
   * stage was shrunk to fit its pane, so the painting was drawn at the width
   * the zoom asked for while the boxes sat at the width it actually got. The
   * two drifted apart exactly when you zoomed in to line something up.
   *
   * The CSS above stops the shrinking. Measuring as well means any FUTURE
   * constraint - a narrower pane, a phone, a sidebar someone adds - moves the
   * picture and the boxes together instead of separating them again.
   */
  const intended = {
    w: parseFloat(stage.style.width) || board.w,
    h: parseFloat(stage.style.height) || board.h,
  };
  // clientWidth, not offsetWidth: the blocks are positioned against the
  // stage's padding box, inside its 1px border. Scaling from the border box
  // drew the preview 2px wider than the boxes laid over it.
  const rect = {
    w: stage.clientWidth || intended.w,
    h: stage.clientHeight || intended.h,
  };
  frame.style.transform = `scale(${rect.w / board.w}, ${rect.h / board.h})`;
  state.boardPx = board;
  return frame;
}

/* Push the current editing state into the preview. Debounced through rAF so a
 * burst of edits coalesces into one rebuild. */
let previewPending = false;
function syncPreview(stage) {
  // The preview is an enhancement: drawStage must work without it. The test
  // harness has no requestAnimationFrame and no iframes, so both are optional
  // rather than assumed.
  const soon = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 0);
  if (previewPending) return;
  previewPending = true;
  soon(() => {
    previewPending = false;
    const frame = stage.querySelector('#preview-frame');
    const api = frame?.contentWindow?.__lifeboardPreview;
    if (!api) return;   // still loading; the load handler will call again
    try {
      api.render(
        (state.editing?.widgets || []).map((w, i) => ({ ...w, __key: i })),
        state.editing?.background_kind === 'none'
          ? (state.editing?.background || '#101014') : 'transparent',
      );
    } catch (err) {
      console.warn('preview render failed', err);
      return;
    }
    measureSoon(stage);
  });
}

/* Content outlines.
 *
 * A block's box is the area it owns; what it draws is often much smaller - a
 * clock in a wide strip, a QR code in a square. The preview reports where the
 * drawn content really is (text, images, media, painted backgrounds), and
 * each block gets a second, solid outline around exactly that.
 *
 * Measured a few times after each redraw because images and fonts finish
 * loading after the first frame. Stored RELATIVE to the block (percent of the
 * block), so the outline travels with a block while it is dragged without
 * re-measuring; a resize hides it until the next measurement. */
let measureTimers = [];
function measureSoon(stage) {
  for (const t of measureTimers) clearTimeout(t);
  measureTimers = [50, 400, 1500].map((ms) => setTimeout(() => {
    const api = stage.querySelector?.('#preview-frame')?.contentWindow?.__lifeboardPreview;
    if (!api?.measure || !state.editing) return;
    let measured;
    try { measured = api.measure(); } catch { return; }
    state.ink = {};
    for (const [key, m] of Object.entries(measured || {})) {
      const w = state.editing.widgets[Number(key)];
      if (!w || !m?.ink || !(w.w > 0) || !(w.h > 0)) continue;
      const [x, y, iw, ih] = m.ink;
      state.ink[key] = {
        rel: [((x - w.x) / w.w) * 100, ((y - w.y) / w.h) * 100, (iw / w.w) * 100, (ih / w.h) * 100],
        inset: m.inset, chrome: m.chrome,
      };
    }
    paintInk(stage);
  }, ms));
}

function paintInk(stage) {
  for (const item of stage.__placed || []) {
    item.node.querySelector?.('.ink')?.remove();
    const m = state.preview ? state.ink?.[item.index] : null;
    if (!m) continue;
    const [l, t, w, h] = m.rel;
    // Nothing to show when the content already fills the block.
    if (l < 0.5 && t < 0.5 && w > 99 && h > 99) continue;
    item.node.append(el('div', {
      class: 'ink',
      style: { left: `${l}%`, top: `${t}%`, width: `${w}%`, height: `${h}%` },
    }));
  }
}

/* The block's box shrunk to its content, in board percent: the content
 * outline, plus the block's own padding and border when it draws a card or
 * frame, so fitting a panelled block keeps its panel around the content.
 * null when there is no measurement or nothing would change. */
function contentFit(index) {
  const w = state.editing?.widgets[index];
  const m = state.ink?.[index];
  if (!w || !m) return null;
  const [l, t, rw, rh] = m.rel;
  let x = w.x + (l / 100) * w.w;
  let y = w.y + (t / 100) * w.h;
  let fw = (rw / 100) * w.w;
  let fh = (rh / 100) * w.h;
  if (m.chrome && m.inset) {
    const [top, right, bottom, left] = m.inset;
    x -= left; y -= top; fw += left + right; fh += top + bottom;
  }
  const r3 = (v) => Math.round(v * 1000) / 1000;
  x = Math.max(0, x); y = Math.max(0, y);
  const fit = {
    x: r3(x), y: r3(y),
    w: r3(Math.max(MIN_SIZE / 3, Math.min(100 - x, fw))),
    h: r3(Math.max(MIN_SIZE / 3, Math.min(100 - y, fh))),
  };
  const same = ['x', 'y', 'w', 'h'].every((k) => Math.abs(fit[k] - w[k]) < 0.05);
  return same ? null : fit;
}

/* Fit every selected, unlocked block to its content. */
function fitSelectionToContent(stage) {
  const targets = [...(state.selection?.size ? state.selection : [state.selected])]
    .filter((i) => i != null && !state.editing.widgets[i]?.locked);
  const fits = targets.map((i) => [i, contentFit(i)]).filter(([, f]) => f);
  if (!fits.length) {
    toast(targets.length ? 'Already fits its content.' : 'Select a block first.');
    return;
  }
  pushUndo();
  for (const [i, f] of fits) Object.assign(state.editing.widgets[i], f);
  state.dirty = true;
  drawStage(stage);
  drawProps($('#props'), stage);
}

/* Board pixels as percent, per axis - one pixel is a different percentage
 * across and down on anything that is not square. */
function pxStep() {
  const b = state.boardPx || { w: 1920, h: 1080 };
  return { x: 100 / b.w, y: 100 / b.h };
}

/* Move one block in the preview without rebuilding it, so dragging stays
 * smooth and a slideshow does not restart sixty times a second. */
function nudgePreview(stage, index, widget) {
  const api = stage.querySelector('#preview-frame')?.contentWindow?.__lifeboardPreview;
  try { api?.move(index, widget); } catch { /* preview is best-effort */ }
}

function drawStage(stage) {
  /* Keep the group in step with the primary selection.
   *
   * Plenty of code sets `state.selected` on its own - the layers list, adding
   * a block, undo, delete. Rather than teach all of them about groups, the
   * group collapses to whatever `selected` is whenever the two disagree.
   * That is also the behaviour you want: clicking a row in the layers list
   * means "just this one". It doubles as the fix for stale indices after a
   * delete or reorder, since this runs after both.
   */
  if (state.selected == null) state.selection = new Set();
  else if (!state.selection.has(state.selected)) state.selection = new Set([state.selected]);

  // Everything EXCEPT the preview iframe: re-creating it here would reload
  // the page on every redraw, which happens on every keystroke in the
  // properties panel.
  for (const child of [...stage.children]) {
    if (child.id !== 'preview-frame') child.remove();
  }
  syncPreview(stage);

  // Kept so selection can be shown without rebuilding - see applySelection.
  const placed = [];

  // One readout for the whole stage rather than one per block.
  const readout = el('div', {
    style: {
      position: 'absolute', right: '.4rem', bottom: '.4rem', display: 'none',
      background: 'rgba(0,0,0,.75)', color: '#fff', padding: '.2rem .45rem',
      borderRadius: '4px', fontSize: '.75rem', zIndex: '20',
      pointerEvents: 'none', fontVariantNumeric: 'tabular-nums',
    },
  });
  stage.append(readout);
  state.editing.widgets.forEach((widget, index) => {
    // Eight handles, not one. The single bottom-right grip could only grow a
    // block down and right, so moving its top edge meant dragging the whole
    // block and then resizing to compensate.
    const handles = widget.locked ? [] : HANDLES.map(([name, css]) => el('div', {
      class: `grip-${name}`,
      style: {
        position: 'absolute', width: '12px', height: '12px', zIndex: '5',
        background: 'var(--accent)', borderRadius: '3px',
        border: '1px solid rgba(255,255,255,.75)',
        display: index === state.selected ? 'block' : 'none',
        ...css,
      },
    }));

    const node = el('div', {
      class: 'w' + (index === state.selected ? ' sel' : '') + (widget.locked ? ' locked' : ''),
      style: {
        left: `${widget.x}%`, top: `${widget.y}%`,
        width: `${widget.w}%`, height: `${widget.h}%`, zIndex: String(widget.z ?? index),
        opacity: widget.visible === false ? '.35' : '1',
        cursor: widget.locked ? 'default' : 'move',
      },
    },
      // In a chip, not across the block: the preview behind it is the point,
      // and a label painted over the middle of a widget hides exactly what
      // you came to look at.
      el('div', { class: 'tag' },
        `${widget.locked ? '🔒 ' : ''}${widget.visible === false ? '👁 ' : ''}`
        + `${CATALOGUE[widget.kind]?.icon || ''} `
        + `${widget.name || CATALOGUE[widget.kind]?.label || widget.kind}`),
      ...handles,
    );

    node.addEventListener('dblclick', (event) => {
      event.preventDefault();
      state.selected = index;
      openWidgetEditor(stage, $('#props'));
    });

    node.addEventListener('pointerdown', (event) => {
      // Which handle - if any - decides what the drag does. Worked out up
      // front because SHIFT means two different things: on a grip it is
      // "resize proportionally", on the block body it is "add to selection".
      const gripName = (event.target.className || '')
        .split(' ').find((c) => c.startsWith('grip-'))?.slice(5) || '';
      const resizing = !!gripName;

      if (event.shiftKey && !resizing) {
        // Extend the selection rather than replacing it. Moving a clock and
        // its date together is the common case, and doing it one block at a
        // time loses their relative spacing every single time.
        if (state.selection.has(index) && state.selected !== index) {
          state.selection.delete(index);
        } else {
          state.selection.add(index);
          state.selected = index;
        }
      } else if (!state.selection.has(index)) {
        state.selection = new Set([index]);
        state.selected = index;
      } else {
        state.selected = index;
      }
      // Show the selection WITHOUT rebuilding the stage. Rebuilding here was
      // the bug: it removed this very node from the DOM, which released the
      // pointer capture and killed the drag before it moved a pixel.
      applySelection();

      if (widget.locked) {
        // Selected but not movable. Locking exists so a full-bleed background
        // photo can be clicked past instead of grabbed every time.
        drawProps($('#props'), stage);
        return;
      }
      pushUndo();
      const edges = {
        north: gripName.includes('n'),
        south: gripName.includes('s'),
        west: gripName.includes('w'),
        east: gripName.includes('e'),
      };
      const rect = stage.getBoundingClientRect();
      const startX = event.clientX, startY = event.clientY;
      const orig = { ...widget };
      // Every block that moves with this one, and where each started. Only a
      // MOVE takes the others along - resizing several blocks at once from
      // one corner has no obvious meaning.
      const others = resizing ? [] : [...state.selection]
        .filter((i) => i !== index && !state.editing.widgets[i]?.locked)
        .map((i) => ({ i, w: state.editing.widgets[i], orig: { ...state.editing.widgets[i] } }));
      const ratio = orig.h ? orig.w / orig.h : 1;
      node.setPointerCapture(event.pointerId);
      event.preventDefault();
      // The content outline is relative to the block, so it would stretch
      // with a resize; hide it until the next measurement.
      if (resizing) node.classList?.add('resizing');

      // The stage's inner size: the blocks sit inside its 1px border.
      const innerW = stage.clientWidth || rect.width;
      const innerH = stage.clientHeight || rect.height;

      // Alignment targets for a move: every other block's content edges and
      // centres, plus the board's centre lines. Content, not boxes - lining up
      // what you can see is the point.
      const moving = new Set([index, ...others.map((o) => o.i)]);
      const contentOf = (i, w) => {
        const m = state.ink?.[i];
        if (!m) return { x: w.x, y: w.y, w: w.w, h: w.h };
        return {
          x: w.x + (m.rel[0] / 100) * w.w, y: w.y + (m.rel[1] / 100) * w.h,
          w: (m.rel[2] / 100) * w.w, h: (m.rel[3] / 100) * w.h,
        };
      };
      const targets = { x: [50], y: [50] };
      if (!resizing) {
        state.editing.widgets.forEach((w, i) => {
          if (moving.has(i) || w.visible === false) return;
          const c = contentOf(i, w);
          targets.x.push(c.x, c.x + c.w / 2, c.x + c.w);
          targets.y.push(c.y, c.y + c.h / 2, c.y + c.h);
        });
      }
      const ownInk = contentOf(index, orig);
      const inkOffset = { x: ownInk.x - orig.x, y: ownInk.y - orig.y, w: ownInk.w, h: ownInk.h };
      const guides = [el('div', { class: 'guide guide-v' }), el('div', { class: 'guide guide-h' })];
      stage.append(...guides);
      // How close counts as "lined up": four screen pixels, in percent. Any
      // wider and a busy board always has some edge in range, so the block
      // never moves freely.
      const near = { x: (4 / innerW) * 100, y: (4 / innerH) * 100 };
      const align = (pos, axis) => {
        // pos = proposed block position; returns [snapped position, guide or null]
        const lead = pos + inkOffset[axis];
        const size = inkOffset[axis === 'x' ? 'w' : 'h'];
        let best = null;
        for (const edge of [0, size / 2, size]) {
          for (const tgt of targets[axis]) {
            const d = tgt - (lead + edge);
            if (Math.abs(d) <= near[axis] && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: tgt };
          }
        }
        return best ? [pos + best.d, best.at] : [pos, null];
      };

      const move = (moveEvent) => {
        // Percent, not pixels - so a layout dragged on this 360px preview
        // lands identically on a 4K panel.
        const dx = ((moveEvent.clientX - startX) / innerW) * 100;
        const dy = ((moveEvent.clientY - startY) / innerH) * 100;
        // Hold Alt to bypass snapping and alignment for one drag, the way
        // every design tool does - you want the grid until the one time you
        // do not. 'px' snaps to whole board pixels on each axis.
        const step = moveEvent.altKey ? 0 : state.snap;
        const px = pxStep();
        const stepX = step === 'px' ? px.x : Number(step) || 0;
        const stepY = step === 'px' ? px.y : Number(step) || 0;
        const fitX = (v) => (stepX ? Math.round(v / stepX) * stepX : v);
        const fitY = (v) => (stepY ? Math.round(v / stepY) * stepY : v);
        let guideX = null, guideY = null;
        if (resizing) {
          // Dragging a west or north handle moves that edge and leaves the
          // opposite one where it is, which is what "resize" means everywhere
          // else. The MIN_SIZE clamps stop a block being inverted through
          // itself by an overshooting drag.
          if (edges.east) {
            widget.w = Math.max(MIN_SIZE, Math.min(100 - orig.x, fitX(orig.w + dx)));
          }
          if (edges.west) {
            const right = orig.x + orig.w;
            widget.x = Math.max(0, Math.min(right - MIN_SIZE, fitX(orig.x + dx)));
            widget.w = right - widget.x;
          }
          if (edges.south) {
            widget.h = Math.max(MIN_SIZE, Math.min(100 - orig.y, fitY(orig.h + dy)));
          }
          if (edges.north) {
            const bottom = orig.y + orig.h;
            widget.y = Math.max(0, Math.min(bottom - MIN_SIZE, fitY(orig.y + dy)));
            widget.h = bottom - widget.y;
          }
          // Hold Shift to keep the aspect ratio. Width leads, because a
          // resize is nearly always driven by how wide the block may be; the
          // anchored edges stay put so the block grows the way it was
          // dragged rather than jumping across the board.
          if (moveEvent.shiftKey && ratio > 0) {
            const wantH = Math.max(MIN_SIZE, widget.w / ratio);
            if (edges.north) widget.y = Math.max(0, (orig.y + orig.h) - wantH);
            widget.h = Math.min(wantH, 100 - widget.y);
          }
        } else {
          let nx = fitX(orig.x + dx);
          let ny = fitY(orig.y + dy);
          // Alignment wins over the grid when it is close: lining a clock up
          // with the date under it matters more than a round number.
          if (!moveEvent.altKey) {
            [nx, guideX] = align(nx, 'x');
            [ny, guideY] = align(ny, 'y');
          }
          widget.x = Math.max(0, Math.min(100 - widget.w, nx));
          widget.y = Math.max(0, Math.min(100 - widget.h, ny));
          // The rest of the selection moves by the SAME delta the dragged
          // block actually took, not by the raw pointer delta - otherwise
          // snapping and the edge clamps desynchronise the group.
          const tookX = widget.x - orig.x;
          const tookY = widget.y - orig.y;
          for (const o of others) {
            o.w.x = Math.max(0, Math.min(100 - o.w.w, o.orig.x + tookX));
            o.w.y = Math.max(0, Math.min(100 - o.w.h, o.orig.y + tookY));
            const n = placed.find((pl) => pl.index === o.i)?.node;
            if (n) { n.style.left = `${o.w.x}%`; n.style.top = `${o.w.y}%`; }
            nudgePreview(stage, o.i, o.w);
          }
        }
        node.style.left = `${widget.x}%`; node.style.top = `${widget.y}%`;
        node.style.width = `${widget.w}%`; node.style.height = `${widget.h}%`;
        // The preview follows the box, so what you are dragging is the
        // widget itself rather than a rectangle standing in for it.
        nudgePreview(stage, index, widget);
        guides[0].style.display = guideX == null ? 'none' : 'block';
        guides[0].style.left = `${guideX}%`;
        guides[1].style.display = guideY == null ? 'none' : 'block';
        guides[1].style.top = `${guideY}%`;
        // A live readout in BOARD pixels, because a two-percent nudge on a
        // small preview is otherwise indistinguishable from having missed the
        // block entirely.
        const bp = state.boardPx || { w: 1920, h: 1080 };
        const X = (v) => Math.round((v / 100) * bp.w);
        const Y = (v) => Math.round((v / 100) * bp.h);
        readout.textContent =
          `${X(widget.x)}, ${Y(widget.y)} px  ·  `
          + `${X(widget.w)}×${Y(widget.h)}`
          + (others.length ? `  ·  +${others.length} more` : '');
        readout.style.display = 'block';
        state.dirty = true;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        readout.style.display = 'none';
        for (const g of guides) g.remove();
        // Safe here: the gesture is over, so losing the node costs nothing.
        drawStage(stage);
        drawProps($('#props'), stage);
      };

      // On window rather than the node. Pointer capture alone is not enough -
      // it is released the moment the element leaves the DOM, and any redraw
      // during a drag would otherwise strand the gesture half-finished.
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);

      drawProps($('#props'), stage);
    });

    stage.append(node);
    placed.push({ node, handles, index });
  });
  // Content outlines from the last measurement; the next one repaints them.
  stage.__placed = placed;
  paintInk(stage);

  // Repaint selection in place. Cheap, and crucially it does not replace any
  // node, so a drag in progress is unaffected.
  function applySelection() {
    for (const item of placed) {
      const primary = item.index === state.selected;
      const inGroup = state.selection.has(item.index);
      // Only the PRIMARY block gets handles. Eight grips on every block of a
      // six-block selection is unreadable, and resizing a group from one
      // corner has no obvious meaning anyway.
      item.node.className = 'w' + (primary ? ' sel' : (inGroup ? ' co-sel' : ''))
        + (state.editing.widgets[item.index]?.locked ? ' locked' : '');
      for (const handle of item.handles) handle.style.display = primary ? 'block' : 'none';
    }
  }
}

function drawProps(panel, stage) {
  panel.replaceChildren();

  // `propsOnly` is set on the dialog's own container. Several controls in the
  // form re-render by calling drawProps on the element they live in; without
  // this they would replace the dialog's contents with the whole sidebar.
  if (panel.dataset && panel.dataset.propsOnly === '1') {
    widgetPropsInto(panel, stage);
    return;
  }

  // One button rather than 31. The old flat palette listed every widget kind
  // with no search and no grouping, which made finding "the calendar one" a
  // scan of the whole list - and offered no way at all to say "my Gmail".
  panel.append(el('button', {
    class: 'primary',
    style: { width: '100%', marginBottom: '.7rem' },
    onclick: () => openBlockPicker(stage, panel),
  }, '+  Add a block'));

  panel.append(blockLayers(stage, panel));

  if (state.selected == null) {
    panel.append(el('p', { class: 'muted', style: { marginTop: '1rem' } },
      'Pick a block above, or click one on the board, to configure it.'));
    return;
  }

  const chosen = state.editing.widgets[state.selected];
  const chosenDef = CATALOGUE[chosen.kind] || {};
  panel.append(el('div', {
    style: {
      borderTop: '1px solid var(--line)', marginTop: '.8rem', paddingTop: '.8rem',
    },
  },
    el('div', { style: { marginBottom: '.5rem' } },
      `${chosen.name || chosenDef.label || chosen.kind}`),
    el('button', {
      class: 'primary',
      style: { width: '100%' },
      onclick: () => openWidgetEditor(stage, panel),
    }, 'Edit this block'),
    el('p', { class: 'hint', style: { marginTop: '.4rem' } },
      'Or double-click it on the board.')));
}

/* The dialog. Wide, scrollable inside itself, and closing it leaves the board
 * exactly as the form left it - the form edits the widget directly and the
 * canvas is redrawn as you go, so there is nothing to "apply". */
function openWidgetEditor(stage, panel) {
  if (state.selected == null) return;
  const widget = state.editing.widgets[state.selected];
  const def = CATALOGUE[widget.kind] || {};

  const box = el('div', {});
  box.dataset.propsOnly = '1';
  widgetPropsInto(box, stage);

  modal(`${def.label || widget.kind}`, box, []);
}

/* The property form itself, unchanged except for where it is mounted. */
/* Per-block formatting.
 *
 * Everything here is a property that CASCADES into the widget's own markup,
 * which is the whole reason one control can work for every widget kind
 * without each one knowing about it.
 *
 * `Text size` is the honest exception, and the help text says so. Most
 * widgets compute their sizes in vmin from their own settings, so a base
 * font-size only reaches text that has not been given a size of its own -
 * offering it unlabelled would be a control that silently does nothing on a
 * clock.
 */
function formattingPanel(widget, stage, panel) {
  widget.style = widget.style || {};
  const st = widget.style;
  const touch = () => { state.dirty = true; drawStage(stage); };

  const box = el('div', {});

  const pick = (label, key, options, help) => box.append(el('div', { class: 'field' },
    el('label', {}, label),
    el('select', {
      onchange: (e) => { st[key] = e.target.value; touch(); },
    }, ...options.map(([v, l]) => el('option', {
      value: v, selected: (st[key] || '') === v,
    }, l))),
    help ? el('div', { class: 'help' }, help) : null));

  const text = (label, key, placeholder, help) => box.append(el('div', { class: 'field' },
    el('label', {}, label),
    el('input', {
      value: st[key] ?? '', placeholder: placeholder || '',
      oninput: (e) => { st[key] = e.target.value; touch(); },
    }),
    help ? el('div', { class: 'help' }, help) : null));

  const num = (label, key, placeholder, help) => el('div', { class: 'narrow' },
    el('label', {}, label),
    el('input', {
      type: 'number', value: st[key] ?? '', placeholder: placeholder || '',
      oninput: (e) => {
        st[key] = e.target.value === '' ? '' : Number(e.target.value);
        touch();
      },
    }),
    help ? el('div', { class: 'help' }, help) : null);

  pick('Font', 'font', [
    ['', 'Board default'],
    ['sans', 'Sans'],
    ['serif', 'Serif'],
    ['script', 'Script'],
    ['mono', 'Monospace'],
    ['condensed', 'Condensed'],
  ]);
  text('Text colour', 'colour', 'board default',
       'Any CSS colour: #ffcc00, white, rgba(255,255,255,.7).');
  pick('Align', 'align', [
    ['', 'Default'], ['left', 'Left'], ['center', 'Centre'], ['right', 'Right'],
  ]);

  box.append(el('div', { class: 'row' },
    num('Text size', 'text_size', 'auto',
        'vmin. Only reaches text without its own size setting.'),
    num('Opacity %', 'opacity', '100'),
    num('Corners', 'radius', 'auto'),
  ));

  box.append(el('hr', {
    style: { border: 'none', borderTop: '1px solid var(--line)', margin: '.9rem 0' },
  }));

  text('Background', 'bg', 'none',
       'Overrides the panel above. Leave empty to keep the panel style.');
  text('Gradient to', 'gradient', 'none',
       'A second colour. With Background set, the block fades between them.');
  box.append(el('div', { class: 'row' },
    num('Angle', 'gradient_angle', '180'),
    num('Blur behind', 'blur', '0'),
  ));

  box.append(el('div', { style: { marginTop: '.6rem' } },
    el('button', {
      onclick: () => {
        pushUndo();
        widget.style = {};
        state.dirty = true;
        drawStage(stage);
        drawProps(panel, stage);
      },
    }, 'Clear formatting')));
  return box;
}

function widgetPropsInto(panel, stage) {
  const widget = state.editing.widgets[state.selected];
  const def = CATALOGUE[widget.kind];
  panel.append(el('hr', {
    style: { border: 'none', borderTop: '1px solid var(--line)', margin: '1rem 0' },
  }));
  panel.append(el('h2', { style: { fontSize: '.95rem', margin: '0 0 .6rem' } },
    `${def?.label || widget.kind}`));

  /* Three tabs, not one long scroll.
   *
   * A weather block has fourteen settings, a position, a frame, a panel, nine
   * formatting controls and a schedule. Stacked in one column, the thing you
   * came for is always below the fold. Splitting on what you are trying to DO
   * - change the data, change how it looks, change when it shows - is the
   * split DAKboard uses, and it is the right one.
   */
  const bodies = {
    settings: el('div', {}),
    format: el('div', { style: { display: 'none' } }),
    schedule: el('div', { style: { display: 'none' } }),
  };
  const names = [['settings', 'Settings'], ['format', 'Formatting'], ['schedule', 'Schedule']];
  const tabs = el('div', { class: 'prop-tabs' });
  const showTab = (which) => {
    state.propTab = which;
    for (const [key] of names) bodies[key].style.display = key === which ? '' : 'none';
    for (const b of (tabs.children || [])) {
      b.className = 'prop-tab' + (b.dataset.tab === which ? ' on' : '');
    }
  };
  for (const [key, label] of names) {
    tabs.append(el('button', {
      class: 'prop-tab', 'data-tab': key, onclick: () => showTab(key),
    }, label));
  }
  panel.append(tabs, bodies.settings, bodies.format, bodies.schedule);

  // ------------------------------------------------------------- Settings
  // Per-widget fields, generated from CATALOGUE.
  for (const field of def?.fields || []) {
    // `when` hides a field that only applies in another mode - e.g. the Wi-Fi
    // password only matters when the QR is in wifi mode.
    if (field.when) {
      const [k, v] = Object.entries(field.when)[0];
      const current = widget.config[k] ?? def.fields.find((f) => f.key === k)?.default;
      // An array means "any of these". A task list applies to Google AND
      // Microsoft but not to a LifeBoard list, and writing that as one
      // condition beats duplicating the field per back end.
      const wanted = Array.isArray(v) ? v : [v];
      if (!wanted.includes(current)) continue;
    }
    bodies.settings.append(fieldControl(widget, field, (rebuild) => {
      state.dirty = true;
      // The board preview always follows along, so typing a caption shows up
      // as you type. Redrawing the stage cannot steal focus: the field being
      // typed into lives in the properties panel, not on the stage.
      drawStage(stage);
      // Only a change that can reveal or hide OTHER fields needs the panel
      // rebuilt - and rebuilding is what was destroying the input mid-word.
      if (rebuild) drawProps(panel, stage);
    }));
  }

  // Name, so a board with six text blocks is navigable.
  bodies.settings.append(el('div', { class: 'field' },
    el('label', {}, 'Name (editor only)'),
    el('input', {
      value: widget.name || '',
      placeholder: CATALOGUE[widget.kind]?.label || widget.kind,
      oninput: (e) => { widget.name = e.target.value; state.dirty = true; drawStage(stage); },
    })));

  // ----------------------------------------------------------- Formatting
  bodies.format.append(geometryPanel(widget, stage, panel));

  const geo = el('div', { class: 'row' });
  for (const key of ['x', 'y', 'w', 'h']) {
    geo.append(el('div', { class: 'narrow' },
      el('label', {}, key.toUpperCase() + ' %'),
      el('input', {
        type: 'number', value: Math.round(widget[key] * 10) / 10, step: '0.5',
        oninput: (e) => {
          widget[key] = Number(e.target.value);
          state.dirty = true; drawStage(stage);
        },
      })));
  }
  bodies.format.append(geo);

  // A frame is a mount, not a container - which is why it is separate from
  // the panel. A photo or a video usually wants NO panel and a white frame,
  // and one combined setting could not say that.
  bodies.format.append(el('div', { class: 'field' },
    el('label', {}, 'Frame'),
    el('select', {
      onchange: (e) => {
        widget.frame = e.target.value === 'none' ? '' : e.target.value;
        state.dirty = true;
        drawStage(stage);
      },
    }, ...[
      ['none', 'No frame'],
      ['framed', 'White frame'],
      ['framed-dark', 'Dark frame'],
    ].map(([v, l]) => el('option', {
      value: v, selected: (widget.frame || 'none') === v,
    }, l))),
    el('div', { class: 'help' },
      'A printed-and-pinned look for photos and video. Works with any panel, '
      + 'including none.')));

  // Panel chrome. Lives on the widget row, not in config, because it applies
  // to every widget kind and the renderer needs it before the widget mounts.
  bodies.format.append(el('div', { class: 'field' },
    el('label', {}, 'Panel'),
    el('select', {
      onchange: (e) => { widget.panel = e.target.value; state.dirty = true; drawStage(stage); },
    }, ...[
      ['auto', 'Auto (widget decides)'],
      ['none', 'None — transparent'],
      ['solid', 'Solid card'],
      ['glass', 'Frosted glass'],
      ['lumen', 'Lit glass — bright rim and highlight'],
      ['outline', 'Outline only'],
    ].map(([v, l]) => el('option', {
      value: v, selected: (widget.panel || 'auto') === v,
    }, l))),
    el('div', { class: 'help' },
      'Frosted glass is the look for a widget floating over a background photo.'),
  ));

  bodies.format.append(formattingPanel(widget, stage, panel));

  // ------------------------------------------------------------- Schedule
  bodies.schedule.append(scheduleControls(widget, stage, panel));

  // Kept across redraws, or typing in Formatting would bounce you back to
  // Settings on every keystroke.
  showTab(bodies[state.propTab] ? state.propTab : 'settings');

  // ------------------------------------------- actions, always visible
  const act = (label, fn, cls) => el('button', {
    class: cls || '',
    onclick: () => { pushUndo(); fn(); state.dirty = true; drawStage(stage); drawProps(panel, stage); },
  }, label);

  panel.append(el('div', {
    style: { marginTop: '1rem', display: 'flex', gap: '.4rem', flexWrap: 'wrap' },
  },
    act(widget.locked ? 'Unlock' : 'Lock', () => { widget.locked = !widget.locked; }),
    act(widget.visible === false ? 'Show' : 'Hide', () => {
      widget.visible = widget.visible === false;
    }),
    act('Duplicate', () => {
      const copy = JSON.parse(JSON.stringify(widget));
      copy.x = Math.min(95, copy.x + 2);
      copy.y = Math.min(95, copy.y + 2);
      copy.z = (copy.z ?? 0) + 1;
      state.editing.widgets.push(copy);
      state.selected = state.editing.widgets.length - 1;
    }),
    // All the way, in one press. Stacking is the list order - see
    // moveInStack - so these move the block within it rather than nudging a
    // number that ties with its neighbour and appears to do nothing.
    act('Bring to front', () => moveInStack(state.selected, 'front')),
    act('Send to back', () => moveInStack(state.selected, 'back')),
    act('Forward', () => moveInStack(state.selected, +1)),
    act('Backward', () => moveInStack(state.selected, -1)),
    act('Delete', () => {
      state.editing.widgets.splice(state.selected, 1);
      state.selected = null;
    }, 'danger'),
  ));

  panel.append(el('div', { style: { marginTop: '.6rem' } },
    el('button', { class: 'primary', onclick: guard(save) }, 'Save')));
}

function fieldControl(widget, field, onChange) {
  const value = widget.config[field.key] ?? field.default;

  /* `rebuild` says whether this change can alter which OTHER fields are
   * visible. Selects and checkboxes can - they are what `when` conditions key
   * off. Typing cannot, so text fields pass false and keep their focus. */
  const set = (v, rebuild = false) => {
    widget.config[field.key] = v;
    onChange(rebuild);
  };
  let control;

  switch (field.type) {
    case 'bool':
      control = el('input', {
        type: 'checkbox', checked: !!value,
        onchange: (e) => set(e.target.checked, true),
      });
      break;
    case 'number':
      control = el('input', {
        type: 'number', value: value ?? '', placeholder: field.placeholder || '',
        step: 'any',
        oninput: (e) => set(e.target.value === '' ? undefined : Number(e.target.value)),
      });
      break;
    case 'select':
      control = el('select', { onchange: (e) => set(e.target.value, true) },
        ...field.options.map((o) => el('option', {
          value: o.value, selected: String(value) === String(o.value),
        }, o.label)));
      break;
    case 'textarea':
      control = el('textarea', {
        rows: 4, value: value ?? '', style: { width: '100%' },
        oninput: (e) => set(e.target.value),
      });
      break;
    case 'password':
      control = el('input', {
        type: 'password', value: value ?? '',
        oninput: (e) => set(e.target.value),
      });
      break;
    case 'date':
      control = el('input', {
        type: 'datetime-local', value: value ?? '',
        oninput: (e) => set(e.target.value),
      });
      break;
    case 'source': {
      const usable = state.sources.filter((s) => !field.kinds || field.kinds.includes(s.kind));
      control = el('select', { onchange: (e) => set(e.target.value ? Number(e.target.value) : undefined, true) },
        el('option', { value: '' }, usable.length ? '— pick one —' : '— none configured —'),
        ...usable.map((s) => el('option', {
          value: s.id, selected: Number(value) === s.id,
        }, `${s.name} (${s.kind})`)));
      break;
    }
    case 'sources': {
      const usable = state.sources.filter((s) => !field.kinds || field.kinds.includes(s.kind));
      const chosen = new Set(value || []);

      if (!usable.length) {
        // An empty list used to render as nothing at all, which reads as "this
        // feature does not exist" rather than "you have not added one yet".
        // The wording comes from the field: this control is no longer
        // calendars-only, and "No calendars have been added yet" under a photo
        // slideshow is worse than no message at all.
        control = el('div', {},
          el('p', { class: 'hint', style: { margin: '0 0 .4rem' } },
            field.empty || 'Nothing has been added yet.'),
          el('button', {
            onclick: () => { state.tab = 'sources'; render(); },
          }, field.emptyAction || 'Add a source'));
        break;
      }

      control = el('div', {},
        ...usable.map((s) => el('label', {
          style: {
            display: 'flex', gap: '.5rem', alignItems: 'center',
            color: 'var(--fg)', marginBottom: '.2rem',
          },
        },
          el('input', {
            type: 'checkbox', checked: chosen.has(s.id),
            onchange: (e) => {
              if (e.target.checked) chosen.add(s.id); else chosen.delete(s.id);
              set([...chosen]);
            },
          }),
          // The dot is the whole point of merging several calendars into one
          // widget: it is how you tell whose event it is on the wall.
          el('span', {
            style: {
              width: '.75rem', height: '.75rem', borderRadius: '50%',
              background: s.colour || '#5b9dd9', flex: '0 0 auto',
              outline: '1px solid rgba(255,255,255,.25)',
            },
          }),
          el('span', { style: { flex: '1 1 auto' } }, s.name),
          s.enabled ? null : el('span', { class: 'pill' }, 'disabled'))),
        el('p', { class: 'hint', style: { marginTop: '.4rem' } },
          // Per-field wording, because the sentence is not merely differently
          // worded per widget - it is differently TRUE. An empty calendar
          // selection means "all of them"; an empty photo or feed selection
          // means the widget shows nothing at all. One hardcoded line told
          // RSS users that "every enabled calendar is included".
          chosen.size
            ? (field.chosenHint
                ? `${chosen.size} selected. ${field.chosenHint}`
                : `${chosen.size} selected.`)
            : (field.emptyHint || 'Nothing ticked yet.')));
      break;
    }
    case 'spsite': {
      /* Sites, with a search box.
       *
       * Graph has no "list every site I can reach" call - /sites?search= is
       * the documented way and it returns followed sites plus the root, never
       * everything. Pretending the dropdown is complete would send somebody
       * hunting for a site that is simply not in it, so the search is part of
       * the control rather than hidden behind it. */
      const chosen = String(value ?? '');
      const select = el('select', {
        onchange: (e) => set(e.target.value || undefined, true),
      }, el('option', { value: '' }, '- loading sites -'));
      const search = el('input', {
        placeholder: 'Search for a site by name',
        style: { marginTop: '.3rem' },
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); fill(e.target.value); } },
      });

      const accountId = widget.config?.source_id;
      function fill(term) {
        if (!accountId) {
          select.replaceChildren(el('option', { value: '' },
            '- pick a Microsoft account above first -'));
          return;
        }
        select.replaceChildren(el('option', { value: '' }, '- loading sites -'));
        api(`/api/sharepoint/sites?source_id=${accountId}`
            + `&search=${encodeURIComponent(term || '')}`)
          .then((data) => {
            const found = data.sites || [];
            select.replaceChildren(
              el('option', { value: '' },
                found.length ? '- pick a site -' : '- nothing found; try a search -'),
              ...found.map((site) => el('option', {
                value: site.id, selected: chosen === site.id,
              }, site.title)));
          })
          .catch((err) => {
            select.replaceChildren(el('option', { value: '' },
              `- ${String(err.message || err).slice(0, 80)} -`));
          });
      }
      fill('');
      control = el('div', {}, select, search);
      break;
    }

    case 'splist': {
      const chosen = String(value ?? '');
      control = el('select', {
        onchange: (e) => set(e.target.value || undefined, true),
      }, el('option', { value: '' }, '- loading lists -'));

      const accountId = widget.config?.source_id;
      const siteId = widget.config?.site_id;
      if (!accountId || !siteId) {
        control.replaceChildren(el('option', { value: '' },
          '- pick a site above first -'));
      } else {
        api(`/api/sharepoint/lists?source_id=${accountId}`
            + `&site_id=${encodeURIComponent(siteId)}`)
          .then((data) => {
            const found = data.lists || [];
            control.replaceChildren(
              el('option', { value: '' },
                found.length ? '- pick a list -' : '- no lists on this site -'),
              ...found.map((list) => el('option', {
                value: list.id, selected: chosen === list.id,
              }, list.title)));
          })
          .catch((err) => {
            control.replaceChildren(el('option', { value: '' },
              `- ${String(err.message || err).slice(0, 80)} -`));
          });
      }
      break;
    }

    case 'spcolumns': {
      /* The list's own columns, ticked in the order they should appear.
       *
       * This is the control that makes the widget usable at all. A SharePoint
       * column's DISPLAY name and its INTERNAL name are usually different, and
       * the API wants the internal one - so typing them by hand means getting
       * "Assigned To" wrong as "AssignedTo" or "Assigned_x0020_To" and seeing
       * an empty column with no explanation.
       *
       * `single: true` turns it into a dropdown, for "which column means done". */
      const single = Boolean(field.single);
      const current = single
        ? [String(value ?? '')].filter(Boolean)
        : String(value ?? '').split(',').map((c) => c.trim()).filter(Boolean);
      const box = el('div', { class: 'muted' }, 'loading columns…');

      const accountId = widget.config?.source_id;
      const siteId = widget.config?.site_id;
      const listId = widget.config?.list_id;
      if (!accountId || !siteId || !listId) {
        box.textContent = 'Pick a list above first.';
      } else {
        api(`/api/sharepoint/columns?source_id=${accountId}`
            + `&site_id=${encodeURIComponent(siteId)}`
            + `&list_id=${encodeURIComponent(listId)}`)
          .then((data) => {
            const found = data.columns || [];
            if (!found.length) { box.textContent = 'This list has no columns.'; return; }

            if (single) {
              const select = el('select', {
                onchange: (e) => set(e.target.value || undefined, true),
              },
                el('option', { value: '' }, '- none, read only -'),
                ...found.map((col) => el('option', {
                  value: col.name, selected: current[0] === col.name,
                }, `${col.title}${col.type !== 'text' ? ` (${col.type})` : ''}`)));
              box.replaceChildren(select);
              return;
            }

            /* Order matters - the first column carries the row - so the
             * chosen ones are kept in the order they were ticked rather than
             * the order SharePoint happens to return them. */
            const picked = current.slice();
            const redraw = () => set(picked.join(','), false);
            box.replaceChildren(...found.map((col) => {
              const input = el('input', {
                type: 'checkbox',
                checked: picked.includes(col.name),
                onchange: (e) => {
                  if (e.target.checked) {
                    if (!picked.includes(col.name)) picked.push(col.name);
                  } else {
                    const at = picked.indexOf(col.name);
                    if (at >= 0) picked.splice(at, 1);
                  }
                  order.textContent = picked.length
                    ? `Order: ${picked.join(' \u2192 ')}`
                    : 'Nothing chosen yet.';
                  redraw();
                },
              });
              return el('label', { class: 'check' }, input,
                el('span', {}, `${col.title}`),
                el('span', { class: 'muted', style: { marginLeft: '.3rem' } },
                  col.type !== 'text' ? col.type : ''));
            }));
            const order = el('div', {
              class: 'muted', style: { marginTop: '.35rem' },
            }, picked.length ? `Order: ${picked.join(' \u2192 ')}` : 'Nothing chosen yet.');
            box.append(order);
          })
          .catch((err) => {
            box.textContent = String(err.message || err).slice(0, 140);
          });
      }
      control = box;
      break;
    }

    case 'plan': {
      /* Planner plans, fetched on demand for the same reason task lists are:
       * listing them needs a live Graph token, and nobody should have their
       * Microsoft token refreshed just for opening the Sources tab. */
      const chosen = String(value ?? '');
      control = el('select', {
        onchange: (e) => set(e.target.value || undefined, true),
      }, el('option', { value: '' }, '- loading your plans -'));

      const accountId = widget.config?.source_id;
      if (!accountId) {
        control.replaceChildren(el('option', { value: '' },
          '- pick a Microsoft account above first -'));
      } else {
        api(`/api/tasks/plans?source_id=${accountId}`)
          .then((data) => {
            const plans = data.plans || [];
            control.replaceChildren(
              el('option', { value: '' },
                plans.length ? '- pick a plan -' : '- no plans on this account -'),
              ...plans.map((pl) => el('option', {
                value: pl.id, selected: chosen === pl.id,
              }, pl.title)));
          })
          .catch((err) => {
            control.replaceChildren(el('option', { value: '' },
              `- ${String(err.message || err).slice(0, 70)} -`));
          });
      }
      break;
    }

    case 'json': {
      /* A small object, edited as text.
       *
       * Deliberately not a builder UI. The per-column Kanban rules are the
       * only thing that uses this, there are usually three of them, and a
       * drag-and-drop editor for three lines would be more to get wrong than
       * the lines are. It validates on blur and says so rather than silently
       * keeping the last good value. */
      const problem = el('div', {
        style: { color: 'var(--bad)', fontSize: '.78rem', marginTop: '.2rem' },
      });
      control = el('textarea', {
        rows: 3, spellcheck: false,
        placeholder: field.placeholder || '{}',
        value: typeof value === 'string' ? value
          : value ? JSON.stringify(value, null, 1) : '',
        oninput: () => { problem.textContent = ''; },
        onblur: (e) => {
          const text = e.target.value.trim();
          if (!text) { problem.textContent = ''; set(undefined, true); return; }
          try {
            const parsed = JSON.parse(text);
            if (typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('needs to be an object like {"Done": "complete"}');
            }
            problem.textContent = '';
            set(parsed, true);
          } catch (err) {
            problem.textContent = `Not valid: ${err.message}`;
          }
        },
      });
      control = el('div', {}, control, problem);
      break;
    }

    case 'tasklist': {
      /* Google's task lists, fetched on demand.
       *
       * Not preloaded with the rest of the admin state: it needs a live
       * access token, so asking for it on every page load would refresh
       * somebody's Google token whether or not they own a sticky note. The
       * select fills itself in once, when it is actually shown. */
      const chosen = String(value ?? '');
      control = el('select', {
        onchange: (e) => set(e.target.value || undefined, true),
      }, el('option', { value: '' }, '- loading your lists -'));

      /* Which back end decides both the endpoint and whether an account is
       * needed at all - a LifeBoard list has no account, and demanding one
       * would make the offline option look broken. */
      const backend = widget.config?.backend || 'google';
      const accountId = widget.config?.source_id;
      if (backend !== 'local' && !accountId) {
        control.replaceChildren(el('option', { value: '' },
          '- pick an account above first -'));
      } else {
        api(`/api/tasks/lists?backend=${encodeURIComponent(backend)}`
            + `&source_id=${accountId || 0}`)
          .then((data) => {
            const lists = data.lists || [];
            control.replaceChildren(
              el('option', { value: '' },
                lists.length ? '- pick a list -' : '- no task lists on this account -'),
              ...lists.map((l) => el('option', {
                value: l.id, selected: chosen === l.id,
              }, l.title)));
          })
          .catch((err) => {
            // Say WHY rather than showing an empty select: the usual cause is
            // an account connected before Tasks permission existed.
            control.replaceChildren(el('option', { value: '' },
              String(err.message || err).slice(0, 90)));
          });
      }
      break;
    }
    case 'todolist': {
      control = el('select', { onchange: (e) => set(e.target.value ? Number(e.target.value) : undefined, true) },
        el('option', { value: '' },
          state.todoLists.length ? '- pick a list -' : '- create a list first -'),
        ...state.todoLists.map((l) => el('option', {
          value: l.id, selected: Number(value) === l.id,
        }, `${l.name} (${l.done}/${l.total})`)));
      break;
    }
    case 'layout': {
      control = el('select', { onchange: (e) => set(e.target.value ? Number(e.target.value) : undefined, true) },
        el('option', { value: '' }, '- pick a layout -'),
        ...state.layouts.map((l) => el('option', {
          value: l.id, selected: Number(value) === l.id,
        }, l.name)));
      break;
    }
    case 'entities': {
      // Free text, comma separated. A live picker needs the HA source chosen
      // first, which is a chicken-and-egg in a static form; the Sources tab
      // has a browser that lists entity ids to copy.
      control = el('input', {
        value: (value || []).join(', '),
        placeholder: 'sensor.outside_temp, person.alex',
        oninput: (e) => set(e.target.value.split(',').map((s) => s.trim()).filter(Boolean)),
      });
      break;
    }
    default:
      control = el('input', {
        value: value ?? '', placeholder: field.placeholder || '',
        oninput: (e) => set(e.target.value),
      });
  }

  return el('div', { class: 'field' },
    el('label', {}, field.label),
    control,
    field.help ? el('div', { class: 'help' }, field.help) : null,
  );
}

async function save() {
  await api(`/api/layouts/${state.editing.id}`, {
    method: 'PUT',
    body: {
      name: state.editing.name,
      background: state.editing.background,
      background_kind: state.editing.background_kind ?? 'none',
      background_image: state.editing.background_image ?? '',
      background_source_id: state.editing.background_source_id ?? null,
      background_dim: state.editing.background_dim ?? 35,
      background_blur: state.editing.background_blur ?? 0,
      widgets: state.editing.widgets.map((w) => ({
        ...w,
        name: w.name || '',
        schedule: w.schedule || {},
        style: w.style || {},
        visible: w.visible !== false,
        locked: !!w.locked,
      })),
    },
  });
  state.dirty = false;
  await refresh();
  toast('Saved — the board will pick it up within 10 seconds');
}

/* ---------------------------------------------------------------- sources */

const SOURCE_KINDS = {
  // Named by SERVICE, because that is how you think about them. "Calendar
  // (iCal / .ics URL)" is the right technical description and the wrong first
  // thing to read when what you have is a Gmail account.
  google: {
    label: 'Google Calendar',
    oauth: true,
    help: 'Google will not accept a plain LAN address as a redirect URI. '
        + 'See docs/oauth.md — or skip all of this and use the secret .ics '
        + 'link from Google Calendar settings, which needs no app at all. '
        + 'Covers Google Calendar and Google Tasks on one connection. “Let the '
        + 'board complete tasks” is what allows a touch on the wall to tick '
        + 'something off — leave it off and the board can only read.',
    fields: [
      ['client_id', 'OAuth client id', 'text'],
      ['client_secret', 'OAuth client secret', 'password'],
      ['redirect_uri', 'Redirect URI', 'text'],
      // OFF by default, and checked on the SERVER for every tap. The renderer
      // is unauthenticated, so a client-side flag would be no check at all -
      // anything on the LAN can post to the complete endpoint. This is the
      // switch that decides whether the board may change a real account.
      ['allow_complete', 'Let the board complete tasks', 'bool'],
    ],
  },
  graph: {
    label: 'Microsoft / Outlook Calendar',
    oauth: true,
    help: 'Uses device-code sign-in: no redirect URI, no client secret. '
        + 'Register an app in Entra ID and paste its Application (client) id. '
        + 'Covers Outlook calendar, Microsoft To Do and Planner on one '
        + 'connection. “Let the board complete tasks” is what allows a touch '
        + 'on the wall to tick something off or move a Planner card — leave it '
        + 'off and the board can only read. SharePoint is separate because its '
        + 'permission usually has to be granted by a tenant administrator: tick '
        + 'it, then RECONNECT the account. If it still fails, your admin has not '
        + 'consented to it. A dedicated account with access to only the lists the '
        + 'wall should show works well here — the board can never display more '
        + 'than that account itself can see.',
    fields: [
      ['client_id', 'Application (client) id', 'text'],
      ['allow_complete', 'Let the board complete tasks', 'bool'],
      // Opt-in because Sites.Read.All usually needs a TENANT ADMIN to consent,
      // while Tasks.ReadWrite does not. Requesting it on every Microsoft
      // connection would turn a working To Do and Planner setup into one that
      // needs a ticket raised with IT.
      ['include_sharepoint', 'Also connect SharePoint / Lists', 'bool'],
    ],
  },
  ical: {
    label: 'Calendar — iCal / .ics link',
    help: 'Google Calendar: Settings → pick the calendar → Integrate calendar '
        + '→ "Secret address in iCal format". Use the SECRET one unless the '
        + 'calendar is published publicly — the public address only exists for '
        + 'public calendars, and the embed/share link is a web page rather '
        + 'than a feed. Outlook: Settings → Calendar → Shared calendars → '
        + 'publish, then take the ICS link. Anyone holding a secret address '
        + 'can read that calendar, so treat it like a password. '
        + 'Hide events matching: a comma separated list, case-insensitive, '
        + 'matched anywhere in the title — "sprint, lunch" removes both '
        + '"Morning Productivity Sprint" and "IDE Sprint". Wrap a term in '
        + 'slashes for a regular expression, e.g. /^Lunch$/ to hide only the '
        + 'standing block and keep "Lunch with Sam".',
    fields: [
      ['url', 'Calendar address (.ics)', 'text'],
      ['hide_titles', 'Hide events matching', 'text'],
    ],
  },
  weather: { label: 'Weather location', fields: [['place', 'Search a place', 'geocode']] },
  rss: {
    label: 'RSS / Atom feed',
    help: 'Put SEVERAL feeds here, one per line, and one block shows them as a '
        + 'single stream, newest first, with each headline labelled by the '
        + 'outlet it came from. Items: how many articles to fetch PER FEED. '
        + '0 fetches everything; leave blank for 10. The widget then decides '
        + 'how many of those to show. One dead feed never blanks the others.',
    fields: [
      ['urls', 'Feed URLs — one per line', 'textarea'],
      ['limit', 'Items per feed (0 = all)', 'number'],
      ['browser_agent', 'Identify as a web browser', 'bool'],
    ],
  },
  photos: {
    label: 'Photo album',
    help: 'An album may hold videos as well as photos — the slideshow plays '
        + 'them muted, thirty seconds at a time by default, starting somewhere '
        + 'random in anything longer. A share link is checked item by item to '
        + 'find which are videos, because the page itself does not say; that '
        + 'check happens once per item, not every refresh. Add as many albums '
        + 'as you like and tick several on one slideshow widget.',
    fields: [
      ['backend', 'Where the photos are', 'select', [
        ['google_shared', 'Google Photos — public share link'],
        ['local', 'A folder on the appliance'],
        ['immich', 'Immich server'],
        ['bing', 'Bing photo of the day — no setup'],
        ['unsplash', 'Unsplash — needs a free key'],
      ]],
      ['market', 'Region', 'select', [
        ['en-US', 'United States'], ['en-GB', 'United Kingdom'],
        ['en-CA', 'Canada'], ['en-AU', 'Australia'],
        ['de-DE', 'Germany'], ['fr-FR', 'France'], ['ja-JP', 'Japan'],
      ], (c) => c.backend === 'bing'],
      ['count', 'How many days back', 'number', null, (c) => c.backend === 'bing'],
      ['quality', 'Resolution', 'select', [
        ['1920x1080', '1920×1080'], ['1366x768', '1366×768'],
        ['UHD', 'Ultra HD — x86 boards only'],
      ], (c) => c.backend === 'bing'],
      ['access_key', 'Unsplash Access Key', 'password', null,
       (c) => c.backend === 'unsplash'],
      ['query', 'Search for', 'text', null, (c) => c.backend === 'unsplash'],
      ['orientation', 'Orientation', 'select', [
        ['landscape', 'Landscape'], ['portrait', 'Portrait'], ['squarish', 'Square'],
      ], (c) => c.backend === 'unsplash'],
      ['share_urls', 'Google Photos share links — one per line', 'textarea', null,
       (c) => c.backend === 'google_shared'],
      ['skip_video_detection', 'Skip the video check (photos only)', 'bool', null,
       (c) => c.backend === 'google_shared'],
      ['video_suffix', 'Video quality', 'select', [
        ['m18', 'Standard — right for a Pi 3'],
        ['m22', '720p — x86 boards'],
        ['m37', '1080p — x86 boards'],
      ], (c) => c.backend === 'google_shared'],
      ['path', 'Folder path, as seen BY THE APPLIANCE', 'text', null,
       (c) => c.backend === 'local'],
      ['base_url', 'Immich URL', 'text', null, (c) => c.backend === 'immich'],
      ['album_id', 'Immich album id', 'text', null, (c) => c.backend === 'immich'],
      ['api_key', 'Immich API key', 'password', null, (c) => c.backend === 'immich'],
    ],
  },
  obsidian: {
    label: 'Obsidian vault',
    help: 'Reads notes through the Local REST API plugin, which has to be '
        + 'enabled in Obsidian and needs Obsidian RUNNING - the plugin lives '
        + 'inside the app, not beside it. The key is on the plugin settings '
        + 'page. Use the http:// port (27123) unless you have set up a real '
        + 'certificate; the https one is self-signed. The folder is '
        + 'vault-relative, exactly as it appears in Obsidian, emoji and all.',
    fields: [
      ['base_url', 'Obsidian API URL', 'text'],
      ['api_key', 'API key', 'password'],
      ['folder', 'Folder in the vault', 'text'],
    ],
  },
  homeassistant: {
    label: 'Home Assistant',
    fields: [
      ['base_url', 'Home Assistant URL', 'text'],
      ['token', 'Long-lived access token', 'password'],
      ['insecure', 'Allow self-signed certificate', 'bool'],
    ],
  },
};

function renderSources(root) {
  const table = el('table', {},
    el('tr', {}, ...['Name', 'Type', 'Status', ''].map((h) => el('th', {}, h))));

  for (const source of state.sources) {
    const status = source.last_error
      ? el('span', { class: 'pill err', title: source.last_error }, 'error')
      : source.last_ok
        ? el('span', { class: 'pill ok' }, 'ok')
        : el('span', { class: 'pill' }, 'not fetched');

    // The colour is what tells three merged calendars apart on the board, so
    // it belongs next to the name rather than buried in a widget's options.
    const swatch = el('input', {
      type: 'color',
      value: normaliseHex(source.colour || '#5b9dd9'),
      title: 'Colour for this calendar\'s events',
      style: { width: '2.4rem', height: '2rem', padding: '0', flex: '0 0 auto' },
      onchange: guard(async (e) => {
        await api(`/api/sources/${source.id}`, {
          method: 'PATCH', body: { colour: e.target.value },
        });
        await refresh(); render(); toast('Colour updated');
      }),
    });

    const enabled = el('input', {
      type: 'checkbox', checked: !!source.enabled,
      title: 'Include this source on the board',
      onchange: guard(async (e) => {
        await api(`/api/sources/${source.id}`, {
          method: 'PATCH', body: { enabled: e.target.checked ? 1 : 0 },
        });
        await refresh(); toast(e.target.checked ? 'Enabled' : 'Disabled');
      }),
    });

    table.append(el('tr', {},
      el('td', {},
        el('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
          enabled,
          swatch,
          el('input', {
            value: source.name,
            style: { flex: '1 1 auto' },
            onchange: guard(async (e) => {
              await api(`/api/sources/${source.id}`, { method: 'PATCH', body: { name: e.target.value } });
              toast('Renamed');
            }),
          }))),
      el('td', {}, SOURCE_KINDS[source.kind]?.label || source.kind),
      el('td', {}, status, source.last_error
        ? el('div', { class: 'muted', style: { fontSize: '.75rem', maxWidth: '340px' } }, source.last_error)
        : null),
      el('td', {},
        el('button', { onclick: guard(() => editSource(source)) }, 'Edit'),
        el('button', { onclick: guard(() => testSource(source)) }, 'Test'),
        source.kind === 'homeassistant'
          ? el('button', { onclick: guard(() => browseEntities(source)) }, 'Entities')
          : null,
        SOURCE_KINDS[source.kind]?.oauth
          ? el('button', {
              class: source.connected ? '' : 'primary',
              onclick: guard(() => connectAccount(source)),
            }, source.connected ? 'Reconnect' : 'Connect')
          : null,
        SOURCE_KINDS[source.kind]?.oauth && source.connected
          ? el('button', { onclick: guard(() => pickCalendars(source)) }, 'Calendars')
          : null,
        el('button', {
          class: 'danger',
          onclick: guard(async () => {
            await api(`/api/sources/${source.id}`, { method: 'DELETE' });
            await refresh(); render(); toast('Removed');
          }),
        }, 'Delete')),
    ));
  }

  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Sources'),
    el('p', { class: 'hint' },
      'Accounts and feeds the board reads from. A credential is stored once here '
      + 'and shared by every widget that needs it. The colour beside each name is '
      + 'what distinguishes its events when several calendars share one widget; '
      + 'the checkbox includes or excludes it from the board.'),
    table,
  ));

  root.append(addSourceCard());
}

function addSourceCard() {
  const kindSelect = el('select', { onchange: () => rebuild() },
    ...Object.entries(SOURCE_KINDS).map(([k, v]) => el('option', { value: k }, v.label)));
  const nameInput = el('input', { placeholder: 'Name' });
  const fieldsBox = el('div', {});
  const config = {};

  let lastKind = null;

  function rebuild() {
    const kind = kindSelect.value;
    const fields = SOURCE_KINDS[kind].fields;

    // Only wipe when the TYPE changes. Wiping on every redraw was the bug:
    // a select's onchange set its value and then immediately deleted it,
    // so the field snapped back to the first option and stayed there.
    if (kind !== lastKind) {
      Object.keys(config).forEach((k) => delete config[k]);
      lastKind = kind;
    }
    // Drop values belonging to fields this type does not have, so a leftover
    // key is never posted with a source that has no use for it.
    const valid = new Set(fields.map(([key]) => key));
    for (const key of Object.keys(config)) if (!valid.has(key)) delete config[key];

    // Seed defaults BEFORE deciding what to show, because a field's condition
    // usually depends on a select that has not been touched yet.
    for (const [key, , type, options] of fields) {
      if (type === 'select' && config[key] == null) config[key] = options[0][0];
    }

    fieldsBox.replaceChildren();
    for (const [key, label, type, options, when] of fields) {
      if (typeof when === 'function' && !when(config)) continue;

      let control;
      if (type === 'select') {
        control = el('select', { onchange: (e) => { config[key] = e.target.value; rebuild(); } },
          // `selected` matters: without it the browser shows the first option
          // however the config actually reads.
          ...options.map(([v, l]) => el('option', {
            value: v, selected: config[key] === v,
          }, l)));
      } else if (type === 'bool') {
        control = el('input', {
          type: 'checkbox', checked: !!config[key],
          onchange: (e) => { config[key] = e.target.checked; },
        });
      } else if (type === 'geocode') {
        control = geocodeControl(config);
      } else if (type === 'textarea') {
        // A list of URLs. A single-line input technically holds them but is
        // unusable past the second one, which is the whole point of the field.
        control = el('textarea', {
          rows: '4',
          style: { width: '100%', fontFamily: 'inherit', resize: 'vertical' },
          value: config[key] == null ? '' : String(config[key]),
          oninput: (e) => { config[key] = e.target.value; },
        });
      } else {
        control = el('input', {
          type: type === 'password' ? 'password' : type === 'number' ? 'number' : 'text',
          value: config[key] == null ? '' : String(config[key]),
          oninput: (e) => { config[key] = type === 'number' ? Number(e.target.value) : e.target.value; },
        });
      }
      fieldsBox.append(el('div', { class: 'field' }, el('label', {}, label), control));
    }

    const note = SOURCE_KINDS[kind].help;
    if (note) fieldsBox.append(el('p', { class: 'hint' }, note));
  }
  rebuild();

  return el('div', { class: 'card' },
    el('h2', {}, 'Add a source'),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Type'), kindSelect),
      el('div', {}, el('label', {}, 'Name'), nameInput),
    ),
    fieldsBox,
    el('button', {
      class: 'primary',
      onclick: guard(async () => {
        await api('/api/sources', {
          method: 'POST',
          body: { kind: kindSelect.value, name: nameInput.value || 'Untitled', config },
        });
        await refresh(); render(); toast('Source added');
      }),
    }, 'Add'),
  );
}

function geocodeControl(config) {
  const input = el('input', { placeholder: 'e.g. Springfield, Illinois' });
  const results = el('div', { class: 'muted' });
  input.addEventListener('change', guard(async () => {
    const data = await api(`/api/geocode?q=${encodeURIComponent(input.value)}`);
    results.replaceChildren(...(data.results || []).map((hit) => el('div', {},
      el('button', {
        onclick: () => {
          Object.assign(config, {
            latitude: hit.latitude, longitude: hit.longitude, units: 'imperial', days: 5,
          });
          results.replaceChildren(el('span', { class: 'pill ok' },
            `${hit.name}, ${hit.admin1 || hit.country}`));
        },
      }, `${hit.name}, ${hit.admin1 || ''} ${hit.country || ''}`))));
  }));
  return el('div', {}, input, results);
}

/* Exercise a source for real and show what came back. The difference between
 * "the code supports Google Photos" and "your album works" is this button. */
async function testSource(source) {
  const result = await api(`/api/sources/${source.id}/test`, { method: 'POST' });
  const body = el('div', {});

  body.append(el('div', {
    style: { display: 'flex', gap: '.5rem', alignItems: 'center' },
  },
    el('span', { class: result.ok ? 'pill ok' : 'pill err' },
      result.ok ? 'working' : 'not working'),
    result.summary ? el('span', {}, result.summary) : null,
  ));

  if (result.error) {
    body.append(el('p', { style: { color: 'var(--bad)', marginTop: '.5rem' } }, result.error));
  }
  if (result.hint) {
    body.append(el('p', { class: 'muted', style: { marginTop: '.3rem' } }, result.hint));
  }
  if (result.sample?.length) {
    body.append(el('div', { style: { marginTop: '.5rem' } },
      el('div', { class: 'muted', style: { fontSize: '.78rem' } }, 'Sample:'),
      ...result.sample.map((item) => el('div', {
        style: { fontSize: '.82rem', overflow: 'hidden', textOverflow: 'ellipsis',
                 whiteSpace: 'nowrap' },
      }, String(item)))));
  }
  if (result.shape) {
    body.append(el('div', { style: { marginTop: '.5rem' } },
      el('div', { class: 'muted', style: { fontSize: '.78rem' } },
        'Response shape (use this to write the path):'),
      el('pre', {
        style: { background: 'var(--panel-2)', padding: '.5rem', borderRadius: '6px',
                 fontSize: '.75rem', overflow: 'auto', maxHeight: '14rem' },
      }, JSON.stringify(result.shape, null, 2))));
  }
  if (result.value !== undefined) {
    body.append(el('div', { style: { marginTop: '.4rem' } },
      el('div', { class: 'muted', style: { fontSize: '.78rem' } }, 'Value at your path:'),
      el('code', {}, JSON.stringify(result.value))));
  }

  $('main').prepend(el('div', {
    class: 'card',
    style: { borderColor: result.ok ? 'var(--good)' : 'var(--bad)' },
  },
    el('h2', {}, `${source.name}`),
    body,
    el('button', {
      style: { marginTop: '.6rem' },
      onclick: (e) => e.target.closest('.card').remove(),
    }, 'Close'),
  ));
}

async function browseEntities(source) {
  const data = await api(`/api/data/ha/entities?source_id=${source.id}`);
  const list = el('div', { style: { maxHeight: '60vh', overflow: 'auto', marginTop: '.6rem' } });
  for (const entity of data.entities || []) {
    list.append(el('div', {
      style: { display: 'flex', gap: '.6rem', padding: '.2rem 0', borderBottom: '1px solid var(--line)' },
    },
      el('code', { style: { flex: '1', fontSize: '.8rem' } }, entity.entity_id),
      el('span', { class: 'muted', style: { fontSize: '.8rem' } },
        `${entity.state}${entity.unit ? ' ' + entity.unit : ''}`),
    ));
  }
  const card = el('div', { class: 'card' },
    el('h2', {}, `${source.name}: ${(data.entities || []).length} entities`),
    el('p', { class: 'hint' }, 'Copy an entity id into a Home Assistant widget.'),
    list);
  $('main').prepend(card);
}

async function renderSystem(root) {
  const [deviceList, keys, hooks, variables, oauth] = await Promise.all([
    api('/api/devices').catch(() => []),
    api('/api/keys').catch(() => []),
    api('/api/webhooks').catch(() => []),
    api('/api/variables').catch(() => []),
    api('/api/oauth/status').catch(() => ({ accounts: [], secrets: {} })),
  ]);

  // --- devices ---
  const deviceTable = el('table', {},
    el('tr', {}, ...['Display', 'Status', 'Resolution', 'Last seen', ''].map((h) => el('th', {}, h))));
  for (const device of deviceList) {
    deviceTable.append(el('tr', {},
      el('td', {}, el('input', {
        value: device.name,
        onchange: guard(async (e) => {
          await api(`/api/devices/${device.id}`, {
            method: 'PATCH', body: { name: e.target.value } });
          toast('Renamed');
        }),
      })),
      el('td', {}, el('span', { class: device.online ? 'pill ok' : 'pill' },
        device.online ? 'online' : 'offline')),
      el('td', {}, device.resolution || '—'),
      el('td', {}, device.seen_seconds_ago == null ? '—'
        : device.seen_seconds_ago < 90 ? 'just now'
        : `${Math.round(device.seen_seconds_ago / 60)}m ago`),
      el('td', {},
        el('button', {
          onclick: guard(async () => {
            await api('/api/devices/refresh', { method: 'POST', body: { device_id: device.id } });
            toast('Refresh queued — it reloads within a minute');
          }),
        }, 'Refresh'),
        el('button', {
          class: 'danger',
          onclick: guard(async () => {
            await api(`/api/devices/${device.id}`, { method: 'DELETE' });
            render();
          }),
        }, 'Forget')),
    ));
  }

  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Displays'),
    el('p', { class: 'hint' },
      'Every screen that has loaded the board registers itself. Refresh is a '
      + 'counter the display checks each minute, so it works across a reboot '
      + 'with nothing to keep connected.'),
    deviceList.length ? deviceTable
      : el('p', { class: 'muted' }, 'No displays have checked in yet.'),
    el('button', {
      style: { marginTop: '.8rem' },
      onclick: guard(async () => {
        const res = await api('/api/devices/refresh', { method: 'POST', body: {} });
        toast(`Refresh queued for ${res.devices} display(s)`);
      }),
    }, 'Refresh all displays'),
  ));

  // --- connected accounts ---
  if (oauth.accounts?.length) {
    const rows = el('table', {},
      el('tr', {}, ...['Account', 'Type', 'Status', ''].map((h) => el('th', {}, h))));
    for (const account of oauth.accounts) {
      rows.append(el('tr', {},
        el('td', {}, account.name),
        el('td', {}, account.kind === 'google' ? 'Google' : 'Microsoft 365'),
        el('td', {}, el('span', { class: account.connected ? 'pill ok' : 'pill err' },
          account.connected ? 'connected' : 'not connected'),
          account.last_error
            ? el('div', { class: 'muted', style: { fontSize: '.75rem' } }, account.last_error)
            : null),
        el('td', {}, el('button', {
          onclick: guard(() => connectAccount(account)),
        }, account.connected ? 'Reconnect' : 'Connect')),
      ));
    }
    root.append(el('div', { class: 'card' },
      el('h2', {}, 'Connected accounts'),
      el('p', { class: 'hint' },
        'Microsoft uses a device code — you type a short code on your phone. '
        + 'Google needs a redirect URL it will accept (HTTPS or loopback); see '
        + 'docs/oauth.md.'),
      rows,
      oauth.secrets && oauth.secrets.encrypted === false
        ? el('p', { style: { color: 'var(--warn)' } },
            `Credentials are NOT encrypted at rest: ${oauth.secrets.reason}`)
        : el('p', { class: 'muted' }, 'Credentials are encrypted at rest.'),
    ));
  }

  // --- API keys ---
  const keyTable = el('table', {},
    el('tr', {}, ...['Name', 'Prefix', 'Access', 'Last used', ''].map((h) => el('th', {}, h))));
  for (const key of keys) {
    keyTable.append(el('tr', {},
      el('td', {}, key.name),
      el('td', {}, el('code', {}, key.prefix + '…')),
      el('td', {}, key.read_only ? 'read only' : 'full'),
      el('td', {}, key.last_used || 'never'),
      el('td', {}, el('button', {
        class: 'danger',
        onclick: guard(async () => {
          await api(`/api/keys/${key.id}`, { method: 'DELETE' });
          render();
        }),
      }, 'Revoke')),
    ));
  }

  const keyName = el('input', { placeholder: 'What is it for?' });
  const keyReadOnly = el('input', { type: 'checkbox' });
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'API keys'),
    el('p', { class: 'hint' },
      'For scripts that drive LifeBoard. A key works anywhere a login does, via '
      + 'the X-API-Key header. It is shown once and cannot be recovered.'),
    keys.length ? keyTable : el('p', { class: 'muted' }, 'No keys yet.'),
    el('div', { class: 'row', style: { marginTop: '.8rem' } },
      el('div', {}, el('label', {}, 'Name'), keyName),
      el('div', { class: 'narrow' }, el('label', {}, 'Read only'), keyReadOnly),
      el('div', { class: 'narrow' }, el('label', {}, 'Create'),
        el('button', {
          class: 'primary',
          onclick: guard(async () => {
            const made = await api('/api/keys', {
              method: 'POST',
              body: { name: keyName.value || 'API key', read_only: keyReadOnly.checked },
            });
            showOnce('Copy this key now — it will not be shown again', made.key);
            render();
          }),
        }, 'Create')))),
  );

  // --- send tasks to the board -------------------------------------------
  await inboxCard(root, hooks.filter((h) => h.kind === 'task'));

  // --- webhooks ---
  const hookTable = el('table', {},
    el('tr', {}, ...['Name', 'Writes variable', 'URL', 'Hits', ''].map((h) => el('th', {}, h))));
  for (const hook of hooks.filter((h) => h.kind !== 'task')) {
    hookTable.append(el('tr', {},
      el('td', {}, hook.name),
      el('td', {}, el('code', {}, hook.variable)),
      el('td', {}, el('code', { style: { fontSize: '.75rem' } },
        `${location.origin}${hook.url}`)),
      el('td', {}, String(hook.hits)),
      el('td', {}, el('button', {
        class: 'danger',
        onclick: guard(async () => {
          await api(`/api/webhooks/${hook.id}`, { method: 'DELETE' });
          render();
        }),
      }, 'Delete')),
    ));
  }

  const hookName = el('input', { placeholder: 'Backup status' });
  const hookVar = el('input', { placeholder: 'backup_status' });
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Webhooks'),
    el('p', { class: 'hint' },
      'For things that only need to push a value IN — a Grafana alert, a cron '
      + 'job, a Home Assistant automation. A webhook can write its one variable '
      + 'and read nothing, which is deliberately far less than an API key. '
      + 'Point a Data / Gauge / Chart widget at the variable name to display it.'),
    hooks.some((h) => h.kind !== 'task') ? hookTable
      : el('p', { class: 'muted' }, 'No webhooks yet.'),
    el('div', { class: 'row', style: { marginTop: '.8rem' } },
      el('div', {}, el('label', {}, 'Name'), hookName),
      el('div', {}, el('label', {}, 'Variable'), hookVar),
      el('div', { class: 'narrow' }, el('label', {}, 'Create'),
        el('button', {
          class: 'primary',
          onclick: guard(async () => {
            await api('/api/webhooks', {
              method: 'POST',
              body: { name: hookName.value || 'Webhook', variable: hookVar.value },
            });
            render();
          }),
        }, 'Create')))),
  );

  if (variables.length) {
    const varTable = el('table', {},
      el('tr', {}, ...['Variable', 'Value', 'Updated', 'From'].map((h) => el('th', {}, h))));
    for (const v of variables) {
      varTable.append(el('tr', {},
        el('td', {}, el('code', {}, v.name)),
        el('td', {}, el('code', { style: { fontSize: '.75rem' } }, String(v.value).slice(0, 80))),
        el('td', {}, v.updated_at),
        el('td', {}, v.source),
      ));
    }
    root.append(el('div', { class: 'card' }, el('h2', {}, 'Pushed values'), varTable));
  }

  await bibleCard(root);
  await backupCard(root);
}

/* Installing a Bible text on THIS board.
 *
 * The NLT is not shipped and never will be: it is a licensed text, and putting
 * somebody's copy inside an image handed to family and friends would be
 * redistributing it. So each board gets its own copy, put there by whoever
 * owns one.
 *
 * On a Pi you could always drop the file next to the database and skip this
 * card entirely. Inside the Android app you cannot - the board's data lives in
 * the app's private directory, which no file manager reaches - so on a TV this
 * is the ONLY way a chosen translation can ever come true. Without it the verse
 * block silently served NIV to somebody who had asked for NLT, every day.
 */
async function bibleCard(root) {
  let status = null;
  try {
    status = await api('/api/bible/nlt');
  } catch {
    return;   // an older server; nothing to offer
  }

  const line = el('p', { class: status.installed ? 'muted' : 'warn' });
  const say = (info) => {
    if (info.installed && info.verses) {
      line.className = 'muted';
      line.textContent = `Installed: ${info.verses.toLocaleString()} verses `
        + `(${Math.round(info.bytes / 1048576)} MB). Blocks set to NLT will use it.`;
    } else if (info.installed) {
      line.className = 'warn';
      line.textContent = 'A file is present but has not indexed - re-upload it.';
    } else {
      line.className = 'warn';
      line.textContent = 'No NLT on this board, so any block set to NLT shows '
        + 'NIV instead. Upload a complete NLT JSON to fix that.';
    }
  };
  say(status);

  const file = el('input', {
    type: 'file', accept: '.json,application/json',
    style: { display: 'none' },
    onchange: guard(async (e) => {
      const chosen = e.target.files && e.target.files[0];
      if (!chosen) return;
      toast('Indexing the text - a complete Bible takes a few seconds');
      const body = new FormData();
      body.append('file', chosen);
      try {
        const info = await api('/api/bible/nlt', { method: 'POST', body });
        say(info);
        toast(`Installed ${info.verses.toLocaleString()} verses`);
      } finally {
        // So choosing the same file twice still fires a change event.
        e.target.value = '';
      }
    }),
  });

  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Bible text'),
    el('p', { class: 'muted' },
      'The verse block can read NLT from a file on this board. Nothing is '
      + 'shipped with LifeBoard - a licensed translation is not ours to '
      + 'distribute - so supply your own JSON. Every other translation on '
      + 'offer is fetched online and needs nothing here.'),
    line,
    file,
    el('div', { class: 'row' },
      el('div', { class: 'narrow' },
        el('label', {}, 'NLT JSON'),
        el('button', { onclick: () => file.click() },
          status.installed ? 'Replace file' : 'Upload file'))),
  ));
}

/* Moving a whole board onto other hardware.
 *
 * Deliberately a different thing from the layout export on the Layout tab.
 * That one moves a DESIGN and strips the source ids, because an id from
 * another appliance points at an arbitrary row here. This moves a BOARD -
 * layouts, screens, sources, lists, schedule, settings - so replacing a dead
 * Pi is a restore rather than an evening of re-entering feed URLs.
 *
 * The credentials switch has to be a decision rather than a default. Off, the
 * file is safe to send somebody and the sources arrive needing
 * re-authorising. On, the board comes up working and the file is as sensitive
 * as the box it came from - so the UI names the sources involved BEFORE the
 * download rather than after.
 */
async function backupCard(root) {
  const scope = { credentials: false, media: true, replace: false };
  const card = el('div', { class: 'card' });

  const draw = async () => {
    let preview = null;
    try {
      preview = await api('/api/backup/preview');
    } catch { /* a preview is a nicety; the buttons work without it */ }

    const summary = preview
      ? `${preview.layouts} layout(s), ${preview.widgets} widgets, `
        + `${preview.sources} source(s), ${preview.todo_lists} list(s)`
        + (preview.media_files ? `, ${preview.media_files} uploaded file(s)` : '')
      : 'Everything on this board.';
    const credentialled = preview?.credentialled_sources || [];

    const fileInput = el('input', {
      type: 'file', accept: '.json,application/json', style: { display: 'none' },
      onchange: guard(async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        event.target.value = '';
        let parsed;
        try {
          parsed = JSON.parse(await file.text());
        } catch {
          throw new Error('That file is not valid JSON');
        }
        if (!parsed.lifeboard_bundle) {
          throw new Error('That is not a board bundle. A single exported '
            + 'layout goes in through Import JSON on the Layout tab.');
        }
        if (scope.replace && !window.confirm(
          'This erases every layout, screen and source on this board first, '
          + 'then loads the bundle. Continue?')) return;

        const report = await api(`/api/backup/restore?replace=${scope.replace}`, {
          method: 'POST', body: parsed,
        });
        await refresh();
        state.editing = null;
        render();

        const parts = [`${report.layouts} layout(s)`,
                       `${report.widgets} widgets`,
                       `${report.sources} new source(s)`];
        if (report.sources_reused) parts.push(`${report.sources_reused} matched`);
        if (report.media) parts.push(`${report.media} file(s)`);
        // What still needs a human is the whole reason for saying anything.
        if (report.needs_credentials?.length) {
          toast(`Restored ${parts.join(', ')}. These need re-connecting on the `
            + `Sources tab: ${report.needs_credentials.join(', ')}`, true);
        } else {
          toast(`Restored ${parts.join(', ')}`);
        }
      }),
    });

    card.replaceChildren(
      el('h2', {}, 'Backup and restore'),
      el('p', { class: 'hint' },
        'A bundle is everything this board needs to come up working on other '
        + 'hardware: layouts, the screens that show them, the sources they '
        + 'read, your lists, the power schedule and your settings.'),
      el('p', { class: 'muted', style: { marginTop: '-.4rem' } }, summary),

      el('div', { style: { marginTop: '.8rem' } },
        el('label', {}, 'What to include'),
        el('label', { class: 'check' },
          el('input', {
            type: 'checkbox', checked: scope.media,
            onchange: (e) => { scope.media = e.target.checked; },
          }),
          el('span', {}, 'Uploaded photos and video')),
        el('label', { class: 'check' },
          el('input', {
            type: 'checkbox', checked: scope.credentials,
            onchange: guard(async (e) => {
              scope.credentials = e.target.checked;
              await draw();
            }),
          }),
          el('span', {}, 'API keys and connected accounts'))),

      scope.credentials
        ? el('p', { class: 'warn' },
            (credentialled.length
              ? `This file will contain live credentials for: ${credentialled.join(', ')} - `
              : 'This file will contain any stored credentials and ')
            + 'plus your board password. Keep it as you would keep the box '
            + 'itself: do not email it or drop it in a shared folder.')
        : el('p', { class: 'muted' },
            credentialled.length
              ? 'Credentials are left out, so after restoring you will need to '
                + `re-connect: ${credentialled.join(', ')}.`
              : 'There are no stored credentials to leave out.'),

      el('div', { class: 'row', style: { marginTop: '.6rem' } },
        el('div', { class: 'narrow' },
          el('label', {}, 'Download'),
          el('button', {
            onclick: guard(async () => {
              const query = new URLSearchParams({
                credentials: String(scope.credentials),
                media: String(scope.media),
              });
              /* Straight through the browser rather than fetched into memory.
               * With photos included a bundle runs to hundreds of megabytes,
               * and building that as a JS string first is how a Pi runs out
               * of memory with nothing on screen to say why. */
              const link = el('a', { href: `/api/backup?${query}`, download: '' });
              document.body.append(link);
              link.click();
              link.remove();
              toast('Building the bundle - the download starts in a moment');
            }),
          }, 'Export board')),

        el('div', { class: 'narrow' },
          el('label', {}, 'Load'),
          el('button', { onclick: () => fileInput.click() }, 'Import bundle')),

        el('div', {},
          el('label', {}, 'On import'),
          el('label', { class: 'check' },
            el('input', {
              type: 'checkbox', checked: scope.replace,
              onchange: (e) => { scope.replace = e.target.checked; },
            }),
            el('span', {}, 'Erase this board first (fresh hardware)')),
          el('p', { class: 'hint', style: { marginTop: '.2rem' } },
            'Left off, a bundle merges: sources are matched by name, so '
            + 'importing the same one twice does not leave two of everything.'))),
      fileInput,
    );
  };

  root.append(card);
  await draw();
}

/* Sending a task to the board from anywhere.
 *
 * The point is that it needs no account and no login. Somebody in the kitchen
 * scans the QR on the wall, types "milk", and it is on the board - they never
 * see the admin, and nobody has to be given the admin password so they can add
 * a shopping item. That matters more than it sounds: handing out the admin
 * password for convenience is exactly how it ends up written on the fridge.
 *
 * The same token also works as a plain HTTP endpoint, which is what makes this
 * reach the rest of the house's automation - an iOS Shortcut, a Home Assistant
 * routine, an n8n flow forwarding an email subject line. One link, two ways in.
 */
async function inboxCard(root, inboxes) {
  const lists = await api('/api/todo/lists').catch(() => []);
  const card = el('div', { class: 'card' });

  const rows = el('table', {},
    el('tr', {}, ...['Name', 'Adds to', 'Link for phones', 'Tell someone when done',
                     'Sent', ''].map((h) => el('th', {}, h))));

  for (const hook of inboxes) {
    const url = `${location.origin}${hook.add_url}`;
    rows.append(el('tr', {},
      el('td', {}, hook.name),
      el('td', {}, hook.target_name || '\u2014'),
      el('td', {},
        el('code', { style: { fontSize: '.72rem', wordBreak: 'break-all' } }, url),
        el('div', { style: { marginTop: '.3rem', display: 'flex', gap: '.35rem' } },
          el('button', {
            onclick: guard(async () => {
              await navigator.clipboard?.writeText(url);
              toast('Link copied');
            }),
          }, 'Copy'),
          el('button', { onclick: () => showInboxQR(hook, url) }, 'Show QR'))),
      el('td', {},
        /* Editable after the fact, because the order people actually do this
         * in is the reverse of the order it is needed: make the board link,
         * go to Teams to create an Incoming Webhook, come back with the URL. */
        el('input', {
          value: hook.notify_url || '',
          placeholder: 'Teams / n8n URL',
          style: { fontSize: '.75rem' },
          onchange: guard(async (e) => {
            await api(`/api/webhooks/${hook.id}`, {
              method: 'PATCH', body: { notify_url: e.target.value.trim() } });
            toast(e.target.value.trim()
              ? 'Completions will be posted there'
              : 'Completion notices turned off');
          }),
        })),
      el('td', {}, String(hook.hits)),
      el('td', {}, el('button', {
        class: 'danger',
        onclick: guard(async () => {
          if (!window.confirm(
            `Delete “${hook.name}”? Anyone using that link or QR code will no `
            + 'longer be able to add tasks.')) return;
          await api(`/api/webhooks/${hook.id}`, { method: 'DELETE' });
          render();
        }),
      }, 'Delete')),
    ));
  }

  const name = el('input', { placeholder: 'Kitchen' });
  const target = el('select', {},
    ...(lists.length
      ? lists.map((l) => el('option', { value: l.id }, l.name))
      : [el('option', { value: '' }, '- make a to-do list first -')]));

  card.replaceChildren(
    el('h2', {}, 'Send tasks to the board'),
    el('p', { class: 'hint' },
      'A link that can do exactly one thing: add a task to one list. It cannot '
      + 'read the board, see other lists, or change anything \u2014 so it is safe '
      + 'to give to the family or put in a QR code on the wall. Put a QR widget '
      + 'on the board pointing at the link and anyone can scan it and add '
      + 'something without an account or a password.'),
    inboxes.length ? rows
      : el('p', { class: 'muted' }, 'No task links yet.'),
    el('div', { class: 'row', style: { marginTop: '.8rem' } },
      el('div', {}, el('label', {}, 'Name'), name),
      el('div', {}, el('label', {}, 'Adds to list'), target),
      el('div', { class: 'narrow' }, el('label', {}, 'Create'),
        el('button', {
          class: 'primary',
          onclick: guard(async () => {
            if (!target.value) throw new Error('Make a to-do list first.');
            const made = await api('/api/webhooks', {
              method: 'POST',
              body: {
                name: name.value || 'Send tasks',
                kind: 'task',
                target: Number(target.value),
              },
            });
            render();
            return made;
          }),
        }, 'Create'))),
    el('p', { class: 'hint', style: { marginTop: '.8rem' } },
      'Automations can use the same token as a plain endpoint: '),
    el('code', { style: { fontSize: '.72rem', display: 'block' } },
      `curl -X POST ${location.origin}/api/hook/YOUR-TOKEN `
      + `-H 'Content-Type: application/json' -d '{"text":"Milk"}'`),
    el('p', { class: 'hint' },
      'It also accepts plain text, a form post, or '
      + '?text=Milk on a GET \u2014 because an iOS Shortcut, a Home Assistant '
      + 'automation and a cron one-liner all send something different and none '
      + 'of them should have to care.'),
    el('p', { class: 'hint' },
      el('strong', {}, 'From Teams: '),
      'point a Teams Outgoing Webhook at the /api/hook/ address. The bot '
      + 'mention is stripped, so \u201c@Board order more ribbon\u201d becomes a '
      + 'task called \u201corder more ribbon\u201d \u2014 and whoever sent it '
      + 'is remembered.'),
    el('p', { class: 'hint' },
      el('strong', {}, 'Telling them when it is done: '),
      'put a Teams Incoming Webhook URL in the column above, and crossing that '
      + 'task off the board posts a card back to the channel. The same request '
      + 'also carries the sender\u2019s name and email as plain fields, so an '
      + 'n8n or Power Automate URL can email them instead \u2014 which is why '
      + 'the board itself holds no mail credentials.'),
  );
  root.append(card);
}

/* The QR, big enough to scan from where the board hangs. */
function showInboxQR(hook, url) {
  modal(`Scan to add to “${hook.target_name || hook.name}”`, el('div', {
    style: { textAlign: 'center' },
  },
    el('img', {
      src: `/api/qr?mode=text&text=${encodeURIComponent(url)}&scale=8`,
      alt: 'QR code',
      style: {
        width: '260px', height: '260px', background: '#fff',
        padding: '10px', borderRadius: '10px', imageRendering: 'pixelated',
      },
    }),
    el('p', { class: 'hint', style: { marginTop: '.8rem' } },
      'Anyone who scans this can add tasks to that one list. They cannot see '
      + 'the board or anything else.'),
    el('code', { style: { fontSize: '.7rem', wordBreak: 'break-all' } }, url),
  ));
}

/* A secret that is shown exactly once needs somewhere it cannot be missed and
 * can be copied from - a toast that fades after three seconds is not it. */
function showOnce(title, secret) {
  const box = el('div', { class: 'card', style: { borderColor: 'var(--accent)' } },
    el('h2', {}, title),
    el('textarea', {
      readonly: true, rows: 2, value: secret,
      style: { width: '100%', fontFamily: 'monospace' },
      onclick: (e) => e.target.select(),
    }),
    el('button', {
      class: 'primary', style: { marginTop: '.5rem' },
      onclick: (e) => {
        navigator.clipboard?.writeText(secret);
        e.target.textContent = 'Copied';
      },
    }, 'Copy'),
  );
  $('main').prepend(box);
}

/* Start an OAuth connection. Microsoft gets the device flow, which needs no
 * redirect URL at all; Google needs one it will accept. */
/* ---------------------------------------------------------------- display */

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function renderDisplay(root) {
  const screen = state.screens[0];
  const [status, rules] = await Promise.all([
    api('/api/display/status').catch(() => null),
    api('/api/display/rules').catch(() => []),
  ]);
  state.rules = rules.filter((r) => r.screen_id === screen.id);

  // --- orientation + hardware ---
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Screen'),
    el('div', { class: 'row' },
      el('div', {},
        el('label', {}, 'Orientation'),
        el('select', {
          onchange: guard(async (e) => {
            // The response carries whether the DISPLAY actually rotated, which
            // is a different question from whether the setting was saved.
            const result = await api(`/api/screens/${screen.id}`, {
              method: 'PATCH', body: { orientation: e.target.value },
            });
            reportRotation(result);
            await refresh(); render();
          }),
        }, ...[['normal', 'Landscape'], ['right', 'Portrait (rotate right)'],
               ['left', 'Portrait (rotate left)'], ['inverted', 'Upside down']]
          .map(([v, l]) => el('option', { value: v, selected: screen.orientation === v }, l))),
        el('button', {
          style: { marginTop: '.4rem' },
          title: 'Send the stored orientation to the display again',
          onclick: guard(() => reapplyRotation(screen)),
        }, 'Re-apply to the screen')),
      el('div', {},
        el('label', {}, 'Power control'),
        el('div', {},
          status
            ? el('span', { class: status.backend === 'none' ? 'pill err' : 'pill ok' },
                status.backend === 'cec' ? 'HDMI-CEC (real TV power)'
                : status.backend === 'dpms' ? 'DPMS (signal off)'
                : 'unavailable')
            : el('span', { class: 'pill' }, 'unknown')),
      ),
      el('div', {},
        el('label', {}, 'Test'),
        el('div', { style: { display: 'flex', gap: '.4rem' } },
          el('button', { onclick: guard(async () => {
            await api('/api/display/power', { method: 'POST', body: { on: true, screen_id: screen.id } });
            toast('Screen on');
          }) }, 'On'),
          el('button', { onclick: guard(async () => {
            await api('/api/display/power', { method: 'POST', body: { on: false, screen_id: screen.id } });
            toast('Screen off');
          }) }, 'Off'))),
      el('div', {},
        el('label', {}, 'This board'),
        el('div', { style: { display: 'flex', gap: '.4rem' } },
          // Reloads the page the TV is showing, without restarting anything.
          // The usual reason to want it: a layout change that the ten-second
          // poll should have picked up but visibly has not.
          el('button', { onclick: guard(async () => {
            const out = await api('/api/devices/refresh', { method: 'POST', body: {} });
            toast(out.devices ? 'Refreshing the display…' : 'No display is checked in');
          }) }, 'Refresh display'),
          el('button', { onclick: guard(async () => {
            if (!confirm('Restart the board? The screen goes blank for about a minute.')) return;
            await api('/api/system/power', { method: 'POST', body: { action: 'reboot' } });
            toast('Restarting…');
          }) }, 'Restart'),
          el('button', { class: 'danger', onclick: guard(async () => {
            // The one button here that cannot undo itself.
            if (!confirm('Shut the board down?\n\nIt cannot switch itself back '
                       + 'on. Power to it has to be cycled — switching the TV '
                       + 'off and on again does that.')) return;
            await api('/api/system/power', { method: 'POST', body: { action: 'shutdown' } });
            toast('Shutting down…');
          }) }, 'Shut down'))),
    ),
    status && status.backend === 'dpms'
      ? el('p', { class: 'hint', style: { marginTop: '.8rem' } },
          'No CEC adapter found, so this turns the video signal off. A monitor will '
          + 'power down properly; a TV may just show "No Signal". For real TV power, '
          + 'add a USB-CEC adapter (a Raspberry Pi has CEC built in).')
      : null,
  ));

  // --- schedule ---
  const rulesBox = el('div', {});
  const draw = () => {
    rulesBox.replaceChildren();
    state.rules.forEach((rule, index) => {
      const days = new Set(String(rule.days).split(',').filter(Boolean).map(Number));
      rulesBox.append(el('div', { class: 'row', style: { marginBottom: '.6rem', alignItems: 'center' } },
        el('div', { style: { flex: '0 0 auto', display: 'flex', gap: '.25rem' } },
          ...DAY_NAMES.map((name, dayIndex) => el('label', {
            style: {
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              fontSize: '.7rem', color: 'var(--dim)', cursor: 'pointer',
            },
          },
            name,
            el('input', {
              type: 'checkbox', checked: days.has(dayIndex),
              onchange: (e) => {
                if (e.target.checked) days.add(dayIndex); else days.delete(dayIndex);
                rule.days = [...days].sort().join(',');
              },
            })))),
        el('div', { class: 'narrow' }, el('label', {}, 'Rule'),
          el('select', {
            onchange: (e) => { rule.mode = e.target.value; draw(); },
          }, ...[
            ['window', 'On and off'],
            ['off_at', 'Off only'],
            ['shutdown_at', 'Shut the board down'],
          ].map(([v, l]) => el('option', {
            value: v, selected: (rule.mode || 'window') === v,
          }, l)))),
        // Neither off-only nor shutdown has an on time, and showing an
        // input that does nothing is worse than showing none.
        (rule.mode || 'window') === 'window'
          ? el('div', { class: 'narrow' }, el('label', {}, 'On at'),
              el('input', { type: 'time', value: rule.on_time, oninput: (e) => { rule.on_time = e.target.value; } }))
          : null,
        el('div', { class: 'narrow' }, el('label', {}, 'Off at'),
          el('input', { type: 'time', value: rule.off_time, oninput: (e) => { rule.off_time = e.target.value; } })),
        el('button', { class: 'danger', onclick: () => { state.rules.splice(index, 1); draw(); } }, 'Remove'),
      ));
    });
  };
  draw();

  root.append(el('div', { class: 'card' },
    el('h2', {}, 'On/off schedule'),
    el('p', { class: 'hint' },
      'The screen turns itself on and off at these times. An overnight window is '
      + 'fine — set on 18:00 and off 02:00 and it stays on across midnight. '
      + 'Turning the screen on by hand here is left alone until the next scheduled change.'),
    el('p', { class: 'hint' },
      '"Off only" turns the screen off at its time and does nothing else all '
      + 'day. That is what you want when the board itself is powered BY the '
      + 'screen: nothing is left running to turn it back on, and an on-time '
      + 'would only fight you when you switch it on by hand in the morning.'),
    el('p', { class: 'hint' },
      '"Shut the board down" halts the board instead of asking the screen to '
      + 'do anything. Use it when the TV ignores HDMI-CEC: with the board off '
      + 'there is no signal on the input, and most TVs power themselves down '
      + 'a few minutes later. Note that a halted board cannot start itself — '
      + 'it comes back when its power is cycled, which is what switching the '
      + 'TV off and on does.'),
    rulesBox,
    el('div', { style: { display: 'flex', gap: '.5rem', marginTop: '.6rem' } },
      el('button', {
        onclick: () => {
          state.rules.push({ screen_id: screen.id, days: '0,1,2,3,4,5,6', on_time: '07:00', off_time: '23:00', enabled: 1 });
          draw();
        },
      }, 'Add rule'),
      el('button', {
        class: 'primary',
        onclick: guard(async () => {
          await api('/api/display/rules', {
            method: 'PUT',
            body: {
              screen_id: screen.id,
              rules: state.rules.map((r) => ({
                days: String(r.days).split(',').filter(Boolean).map(Number),
                on_time: r.on_time, off_time: r.off_time, enabled: true,
              })),
            },
          });
          toast('Schedule saved');
        }),
      }, 'Save schedule')),
  ));
}

/* --------------------------------------------------------------- settings */

function renderSettings(root) {
  const fields = [
    ['timezone', 'Timezone', 'IANA name, e.g. America/New_York'],
    ['display_backend', 'Power control', 'auto | cec | dpms | none'],
    ['cec_device', 'CEC device address', 'usually 0'],
  ];
  const box = el('div', {});
  for (const [key, label, hint] of fields) {
    box.append(el('div', { class: 'field' },
      el('label', {}, label),
      el('input', {
        value: state.settings[key] ?? '',
        oninput: (e) => { state.settings[key] = e.target.value; },
      }),
      el('div', { class: 'help muted', style: { fontSize: '.75rem' } }, hint)));
  }

  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Settings'),
    box,
    el('button', {
      class: 'primary',
      onclick: guard(async () => {
        await api('/api/settings', { method: 'PUT', body: state.settings });
        toast('Saved');
      }),
    }, 'Save'),
  ));

  // --- theme ---
  const colours = readColours();
  const swatches = el('div', { class: 'grid' });
  for (const [name, label] of THEME_VARS) {
    const current = colours[name] || getComputedStyle(document.documentElement)
      .getPropertyValue(name).trim() || '#000000';
    const picker = el('input', {
      type: 'color', value: normaliseHex(current),
      oninput: (e) => {
        colours[name] = e.target.value;
        state.settings.admin_colours = JSON.stringify(colours);
        applyTheme();
      },
    });
    swatches.append(el('div', {},
      el('label', {}, label),
      el('div', { style: { display: 'flex', gap: '.4rem', alignItems: 'center' } },
        picker,
        el('button', {
          title: 'Back to the preset',
          onclick: () => {
            delete colours[name];
            state.settings.admin_colours = JSON.stringify(colours);
            applyTheme();
            render();
          },
        }, 'Reset')),
    ));
  }

  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Appearance'),
    el('p', { class: 'hint' },
      'This themes the admin pages only — the board itself is styled per layout '
      + 'and per widget. Changes preview live; Save keeps them.'),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Theme'),
        el('select', {
          onchange: (e) => {
            state.settings.admin_theme = e.target.value;
            applyTheme();
            render();
          },
        }, ...[['dark', 'Dark'], ['light', 'Light'], ['system', 'Follow my system']]
          .map(([v, l]) => el('option', {
            value: v, selected: (state.settings.admin_theme || 'dark') === v,
          }, l)))),
      el('div', { class: 'narrow' }, el('label', {}, 'Corner radius'),
        el('input', {
          type: 'number', min: '0', max: '24',
          value: state.settings.admin_radius || 10,
          oninput: (e) => { state.settings.admin_radius = e.target.value; applyTheme(); },
        })),
      el('div', { class: 'narrow' }, el('label', {}, 'Colours'),
        el('button', {
          onclick: guard(async () => {
            state.settings.admin_colours = '{}';
            applyTheme();
            await api('/api/settings', { method: 'PUT', body: state.settings });
            render();
            toast('Colours reset to the preset');
          }),
        }, 'Reset all')),
    ),
    el('div', { style: { marginTop: '.9rem' } }, swatches),
    el('button', {
      class: 'primary', style: { marginTop: '.9rem' },
      onclick: guard(async () => {
        await api('/api/settings', { method: 'PUT', body: state.settings });
        toast('Appearance saved');
      }),
    }, 'Save appearance'),
  ));

  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Session'),
    el('button', {
      onclick: guard(async () => {
        await api('/api/logout', { method: 'POST' });
        state.authed = false; render();
      }),
    }, 'Sign out'),
  ));
}

/* A CSS variable may be a named colour or an rgb() string; <input type=color>
 * only accepts #rrggbb and silently shows black for anything else. */
function normaliseHex(value) {
  const text = String(value).trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text;
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(text);
  if (rgb) {
    return '#' + [1, 2, 3]
      .map((i) => Number(rgb[i]).toString(16).padStart(2, '0')).join('');
  }
  return '#000000';
}

/* ------------------------------------------------------------------- boot */

/* Keyboard shortcuts. Only active on the Layout tab, and never while the
 * focus is in a text field - otherwise Ctrl+Z inside an input would blow away
 * the whole board instead of undoing a character. */
window.addEventListener('keydown', (event) => {
  if (state.tab !== 'layout' || !state.editing) return;
  const tag = (event.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return;

  const ctrl = event.ctrlKey || event.metaKey;
  if (ctrl && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
  } else if (ctrl && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save().then(() => {}, (err) => toast(err.message, true));
  } else if (ctrl && event.key.toLowerCase() === 'd' && state.selected != null) {
    event.preventDefault();
    pushUndo();
    const copy = JSON.parse(JSON.stringify(state.editing.widgets[state.selected]));
    copy.x = Math.min(95, copy.x + 2); copy.y = Math.min(95, copy.y + 2);
    state.editing.widgets.push(copy);
    state.selected = state.editing.widgets.length - 1;
    state.dirty = true; render();
  } else if ((event.key === 'Delete' || event.key === 'Backspace') && state.selected != null) {
    event.preventDefault();
    pushUndo();
    state.editing.widgets.splice(state.selected, 1);
    state.selected = null; state.dirty = true; render();
  } else if (!ctrl && event.key.toLowerCase() === 'f' && state.selected != null) {
    event.preventDefault();
    const stage = $('#stage');
    if (stage) fitSelectionToContent(stage);
  } else if (event.key.startsWith('Arrow') && state.selected != null) {
    // Nudge. Shift makes it a coarse 5%. Otherwise one snap step, or ONE
    // BOARD PIXEL when snap is off or set to 1 px - per axis, since a pixel
    // is a different percentage across and down.
    event.preventDefault();
    pushUndo();
    const w = state.editing.widgets[state.selected];
    const px = pxStep();
    const fine = Number(state.snap) || 0;
    const sx = event.shiftKey ? 5 : (fine || px.x);
    const sy = event.shiftKey ? 5 : (fine || px.y);
    if (event.key === 'ArrowLeft') w.x = Math.max(0, w.x - sx);
    if (event.key === 'ArrowRight') w.x = Math.min(100 - w.w, w.x + sx);
    if (event.key === 'ArrowUp') w.y = Math.max(0, w.y - sy);
    if (event.key === 'ArrowDown') w.y = Math.min(100 - w.h, w.y + sy);
    state.dirty = true; render();
  }
});

// Leaving the editor with unsaved changes loses work silently otherwise.
window.addEventListener('beforeunload', (event) => {
  if (state.dirty) { event.preventDefault(); event.returnValue = ''; }
});

(async function boot() {
  try {
    const session = await api('/api/session');
    state.setupNeeded = session.setup_needed;
    state.knownUsername = session.username || 'admin';
    state.authed = session.authenticated || session.setup_needed;
    if (state.authed && !session.setup_needed) await refresh();
  } catch (err) {
    toast(err.message, true);
  }
  render();
})();

/* Exported for tools/test_editor.mjs.
 *
 * The editor lives behind clicks a headless test cannot make, so these are
 * exported to be called directly. A browser loading this as a module ignores
 * exports nothing imports, so this costs the appliance nothing - and it buys
 * coverage of the code that was black-screening. */
export {
  drawProps, drawStage, blockLayers, openBlockPicker, openWidgetEditor,
  ensurePreview,
  widgetPropsInto, blockEntries, applyTheme, readColours, modal, reindexZ,
  moveInStack,
  state,
  // Every tab, so a helper called by one of them but defined by none is
  // caught here rather than on a wall-mounted appliance. reportRotation was
  // exactly that: called from the Display tab, defined nowhere, and invisible
  // to a test suite that only ever rendered the editor.
  renderTemplates, renderLayout, renderSources, renderSystem,
  renderDisplay, renderSettings,
  // guard() swallows handler errors into a toast so one bad control cannot
  // take the page down. That also hides them from any test that fires
  // handlers, so the record is exported.
  RECENT_ERRORS,
};
