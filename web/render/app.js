/* LifeBoard renderer.
 *
 * Loads a board definition, mounts widgets, and keeps them refreshed. Written
 * as plain ES modules with no build step - which is a deliberate appliance
 * decision, not laziness: there is no local login on this box, so the ability
 * to open devtools from another machine and read the actual shipped source is
 * the debugging story.
 *
 * Three rules the whole file is built around:
 *
 *  1. NEVER go blank. Any failure keeps the last good render on screen. A wall
 *     display showing yesterday's weather is useful; a black rectangle is a
 *     support call.
 *  2. NEVER leak timers. This process runs for months. Every widget gets its
 *     intervals tracked and cleared on unmount, or a few layout edits later
 *     the board is running forty copies of the same fetch.
 *  3. Re-render only on real change. The layout is polled, but the DOM is only
 *     rebuilt when the revision actually differs.
 */

import { WIDGETS, CATALOGUE } from './widgets/registry.js';

const BOARD = document.getElementById('board');
const SCREEN_ID = new URLSearchParams(location.search).get('screen') || '1';

// How often to ask the server whether the layout changed. Cheap query, and it
// is what makes "save in the admin UI, watch the TV update" work without any
// websocket plumbing to keep alive across suspends.
const LAYOUT_POLL_MS = 10_000;

let currentRevision = null;
let currentLayoutId = null;
// key -> { el, widget, timers:[], destroy?, identity }
let mounted = new Map();
let consecutiveFailures = 0;

/* ---------------------------------------------------------------- helpers */

/* Apply a style object, expanding shorthands an old engine will not take.
 *
 * `inset: 0` is Chrome 87. On anything older the browser silently drops the
 * whole declaration - no error, no warning - and an element that was meant to
 * fill its parent collapses to nothing. Silently is the problem: the board
 * looks broken and nothing anywhere says why.
 *
 * Expanding it here rather than at 12 call sites means new code can keep
 * writing the shorthand, which is the readable way to say it.
 */
function applyStyle(node, styles) {
  for (const [key, value] of Object.entries(styles)) {
    if (key === 'inset' && node.style.inset === undefined) {
      /* Split on the spaces BETWEEN values, not the ones inside them.
       *
       * `inset: calc(50% - 1px) 0` is two values. Splitting on whitespace
       * makes it four - `calc(50%`, `-`, `1px)`, `0` - and every one of them
       * is invalid, so the element loses its positioning entirely and
       * collapses to nothing. That is what made the Line shape invisible on a
       * TV while working perfectly on a Pi: modern Chrome supports `inset`
       * natively and never reaches this code, so the bug could only ever
       * appear on the old engine this code exists to support.
       */
      const parts = String(value).trim().match(/(?:\([^()]*\)|[^\s()])+/g) || [];
      const [top, right, bottom, left] = parts.length === 1
        ? [parts[0], parts[0], parts[0], parts[0]]
        : parts.length === 2
          ? [parts[0], parts[1], parts[0], parts[1]]
          : parts.length === 3
            ? [parts[0], parts[1], parts[2], parts[1]]
            : parts;
      node.style.top = top;
      node.style.right = right;
      node.style.bottom = bottom;
      node.style.left = left;
      continue;
    }
    node.style[key] = value;
  }
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') applyStyle(node, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  if (NEEDS_GAP_FALLBACK) applyGapFallback(node, attrs.style);
  return node;
}

/* Does this engine understand `gap` on a FLEX container?
 *
 * Grid gap is Chrome 57 and flex gap is Chrome 84, which is a twenty-seven
 * version hole that TV boxes sit squarely inside. Probed once: a board builds
 * thousands of elements and this must not be a per-element question.
 */
const NEEDS_GAP_FALLBACK = (() => {
  try {
    const probe = document.createElement('div');
    probe.style.display = 'flex';
    probe.style.gap = '1px';
    return probe.style.gap !== '1px';
  } catch {
    return false;
  }
})();

/* Space flex children with margins when the engine has no flex gap.
 *
 * Margins on the children rather than padding on the parent, and only BETWEEN
 * them - never before the first or after the last - so the result matches what
 * gap actually does. Getting that wrong shifts every block by one gap and the
 * whole board sits slightly off-centre, which looks like a layout bug rather
 * than a missing feature.
 *
 * Only for flex. Grid handles its own gap on any engine that gets here, and
 * writing margins onto grid children would fight it.
 */
function applyGapFallback(node, styles) {
  if (!styles || !styles.gap) return;
  const display = String(styles.display || '');
  if (display !== 'flex' && display !== 'inline-flex') return;

  // `gap: A B` is row-gap then column-gap; a single value is both.
  const parts = String(styles.gap).trim().split(/\s+/);
  const rowGap = parts[0];
  const columnGap = parts.length > 1 ? parts[1] : parts[0];
  const column = String(styles.flexDirection || 'row').startsWith('column');
  const between = column ? rowGap : columnGap;
  const property = column ? 'marginTop' : 'marginLeft';

  const children = node.children;
  for (let i = 1; i < children.length; i++) {
    children[i].style[property] = between;
  }
  // A wrapping row needs the cross-axis spacing too, or wrapped lines touch.
  if (!column && String(styles.flexWrap || '').startsWith('wrap')) {
    for (let i = 0; i < children.length; i++) {
      children[i].style.marginBottom = rowGap;
    }
    node.style.marginBottom = `-${rowGap}`;
  }
}

export async function getJSON(url) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    let detail = resp.statusText;
    try { detail = (await resp.json()).error || detail; } catch { /* body was not json */ }
    throw new Error(`${resp.status}: ${detail}`);
  }
  return resp.json();
}

function setOffline(isOffline) {
  document.body.classList.toggle('offline', isOffline);
}

/* How long to wait before re-running a load that just failed, per attempt.
 *
 * Without this a widget that fails once sits on its error until the next
 * scheduled refresh - fifteen minutes for weather. A board that boots during a
 * brief network hiccup therefore comes up broken and STAYS broken, which is
 * exactly why rebooting the appliance appears to fix nothing. The delays back
 * off so a source that is genuinely down is not hammered, and after the last
 * one the widget's own interval takes over again. */
const RETRY_DELAYS_MS = [15_000, 45_000, 120_000];

/* ------------------------------------------------------------ widget host */

/* The context handed to every widget. `interval` exists so widgets never call
 * setInterval directly - that is what guarantees rule 2 above. */
function makeContext(instance, bodyEl, widget, board) {
  return {
    body: bodyEl,
    // The widget's outer element. Needed by anything that has to style the
    // frame itself rather than its contents - the native-video hole, mainly.
    el0: instance.el,
    config: widget.config || {},
    widget,
    timezone: board.timezone || 'UTC',
    // True when the server has mpv and is driving video windows itself, so a
    // widget on 'auto' should render a hole instead of an embed.
    nativeVideo: !!board.native_video,
    streamResolver: !!board.stream_resolver,
    el,
    getJSON,

    interval(fn, ms) {
      const id = setInterval(fn, ms);
      instance.timers.push(id);
      return id;
    },
    timeout(fn, ms) {
      const id = setTimeout(fn, ms);
      instance.timers.push(id);
      return id;
    },

    /* Show a small non-fatal error in the corner without destroying whatever
     * is already rendered. */
    fail(err, retry) {
      const message = err && err.message ? err.message : String(err);
      let node = instance.el.querySelector('.widget-error');
      if (!node) {
        node = el('div', { class: 'widget-error' });
        instance.el.append(node);
      }
      node.textContent = message.slice(0, 120);

      // Pass the loader as `retry` and a transient failure clears itself
      // instead of waiting out the refresh interval. Timers go on
      // instance.timers like every other one, so unmount still cleans up.
      if (typeof retry !== 'function') return;
      const attempt = instance.retries || 0;
      if (attempt >= RETRY_DELAYS_MS.length) return;
      instance.retries = attempt + 1;
      instance.timers.push(setTimeout(retry, RETRY_DELAYS_MS[attempt]));
    },
    clearFail() {
      // A success is what ends a retry sequence, so the next failure starts
      // from the shortest delay rather than the longest.
      instance.retries = 0;
      const node = instance.el.querySelector('.widget-error');
      if (node) node.remove();
    },
  };
}

function unmountOne(instance) {
  for (const id of instance.timers) { clearInterval(id); clearTimeout(id); }
  try { instance.destroy?.(); } catch (err) { console.warn('destroy failed', err); }
  instance.el.remove();
}

function unmountAll() {
  for (const instance of mounted.values()) unmountOne(instance);
  mounted.clear();
}

/* The setup panel is not a widget, so nothing was taking it down.
 *
 * renderOnboarding() calls BOARD.replaceChildren(), which makes the panel the
 * board's only child. The widget path then APPENDS to the same board, and the
 * panel is `position:absolute; inset:0` - so a fully configured board mounted
 * its widgets underneath a full-screen setup screen and a QR code, and looked
 * exactly as it had before it was configured. It clears on reload, which is
 * why this survives testing: you configure the board from a laptop and never
 * reload the screen on the wall, which is the one that matters.
 *
 * `mounted` cannot help here - the panel was never a widget instance - so the
 * node is tracked on its own and removed the moment onboarding goes quiet.
 */
let onboardingNode = null;

function clearOnboarding() {
  if (!onboardingNode) return;
  onboardingNode.remove();
  onboardingNode = null;
}

/* WHAT MAKES A WIDGET "THE SAME WIDGET"
 *
 * Everything that would change what it displays — but NOT where it sits. A
 * video that is merely moved or resized must keep playing, so geometry is
 * applied to the existing node instead of triggering a rebuild.
 *
 * This is the whole reason a board can refresh its calendar, weather and tasks
 * every few minutes without a live stream ever stuttering: those widgets
 * refresh themselves on their own timers, and the ones that did not change are
 * never touched at all. */
/* A config list that might not be a list.
 *
 * `entity_ids` is written by the editor as an array, and arrives as one from a
 * template. It arrives as a STRING from anywhere a human has been: a
 * hand-edited bundle, an imported screen, a value typed straight into the
 * database. `(config.entity_ids || []).filter(...)` then throws "filter is not
 * a function" and the block does not mount at all - a whole widget lost to a
 * comma.
 *
 * Splitting on commas and newlines is exactly what the editor does with typed
 * input, so accepting that shape here costs nothing and means the widget
 * renders either way.
 */
export function idList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') {
    return value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function identityOf(widget) {
  return JSON.stringify([
    widget.kind,
    widget.config || {},
    widget.panel || 'auto',
    widget.title || '',
    // Formatting is part of the identity on purpose. Without it a colour or
    // font change is reconciled away as "nothing changed" and never reaches
    // the wall until something else forces a rebuild.
    widget.style || {},
    widget.frame || '',
  ]);
}

export function keyOf(widget, index) {
  // The database id is stable across edits; fall back to position for a widget
  // that has not been saved yet (the editor preview).
  return widget.id != null ? `w${widget.id}` : `i${index}:${widget.kind}`;
}

/* Move/resize an already-mounted widget without rebuilding it. */
function placeWidget(node, widget, index) {
  node.style.left = `${widget.x}%`;
  node.style.top = `${widget.y}%`;
  node.style.width = `${widget.w}%`;
  node.style.height = `${widget.h}%`;
  node.style.zIndex = String(widget.z ?? index);
}

/* Panel chrome. 'auto' defers to the widget's own preference, which is what
 * makes a template look right without every widget being configured by hand:
 * a calendar wants a card, a full-bleed video or photo must not have one. */
export function panelClass(widget, def) {
  const choice = widget.panel && widget.panel !== 'auto'
    ? widget.panel
    : (def?.panelled ? 'solid' : 'none');
  return choice === 'none' ? '' : ` panel-${choice}`;
}

/* The frame is independent of the panel: a photo commonly wants no panel and
 * a white mount, which one combined setting could not express. */
export function frameClass(widget) {
  const frame = widget.frame;
  return frame && frame !== 'none' ? ` ${frame}` : '';
}

/* Font stacks for the per-block formatting override.
 *
 * Deliberately the same list the text widget offers, and every one ends in a
 * generic family: an appliance may not have the first choice installed, and
 * falling back to the default sans beats rendering boxes. */
export const BLOCK_FONTS = {
  sans: 'Inter, "Segoe UI", system-ui, sans-serif',
  serif: '"Playfair Display", Georgia, "Times New Roman", serif',
  script: '"Dancing Script", "Segoe Script", "Brush Script MT", cursive',
  mono: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  condensed: '"Roboto Condensed", "Arial Narrow", "Segoe UI", sans-serif',
};

/* Per-block formatting, applied to the block's own element.
 *
 * Everything here is a property that CASCADES, which is the whole reason this
 * can be generic: colour, font-family and text-align reach into a widget's
 * markup without the widget knowing anything about it.
 *
 * `text_size` is the honest exception. Most widgets compute their own sizes in
 * vmin from their settings, so a base font-size only reaches the text that has
 * not been given a size of its own. The settings form says so rather than
 * offering a control that silently does nothing on a clock.
 */
export function applyBlockStyle(node, widget) {
  const st = widget.style || {};
  if (st.font && BLOCK_FONTS[st.font]) node.style.fontFamily = BLOCK_FONTS[st.font];
  if (st.colour) node.style.color = st.colour;
  if (st.align) node.style.textAlign = st.align;
  if (st.text_size) node.style.fontSize = `${st.text_size}vmin`;

  // A background here deliberately overrides the panel: a block given an
  // explicit colour should get that colour, not that colour behind the
  // panel's own translucent card.
  if (st.bg) {
    node.style.background = st.gradient
      ? `linear-gradient(${st.gradient_angle || 180}deg, ${st.bg}, ${st.gradient})`
      : st.bg;
  }
  if (st.blur) node.style.backdropFilter = `blur(${st.blur}px)`;
  if (st.opacity != null && st.opacity !== '' && Number(st.opacity) !== 100) {
    node.style.opacity = String(Math.max(0, Math.min(100, Number(st.opacity))) / 100);
  }
  if (st.radius != null && st.radius !== '') node.style.borderRadius = `${st.radius}px`;
}

function mountWidget(widget, board, key) {
  const def = WIDGETS[widget.kind];

  const node = el('div', {
    class: 'widget' + panelClass(widget, def) + frameClass(widget),
    style: {
      left: `${widget.x}%`,
      top: `${widget.y}%`,
      width: `${widget.w}%`,
      height: `${widget.h}%`,
      zIndex: String(widget.z ?? 0),
    },
  });

  if (!def) {
    // An unknown kind means the DB is newer than this renderer. Say so on the
    // board rather than rendering an invisible empty box.
    node.classList.add('panel-solid');
    node.append(el('div', { class: 'widget-title' }, 'unknown widget'));
    node.append(el('div', { class: 'widget-body' }, widget.kind));
    BOARD.append(node);
    mounted.set(key, {
      el: node, widget, timers: [], destroy: null,
      identity: identityOf(widget), key,
    });
    return;
  }

  applyBlockStyle(node, widget);

  const title = widget.config?.title;
  if (title) node.append(el('div', { class: 'widget-title' }, title));
  const body = el('div', { class: 'widget-body' });
  node.append(body);
  BOARD.append(node);

  /* Apply the catalogue's declared defaults.
   *
   * Without this, `default:` in the catalogue is documentation rather than
   * behaviour, and a widget that forgets its own fallback disagrees with what
   * its own settings form says it will do. That is how a Wi-Fi QR whose
   * `mode` key was absent rendered as an empty TEXT QR: the catalogue said
   * the default was 'wifi', and nothing read it.
   *
   * Stored values always win - this only fills in keys that are absent, so a
   * deliberate setting is never overridden by a default.
   */
  const declared = (CATALOGUE[widget.kind]?.fields || []);
  for (const field of declared) {
    if (field.default === undefined) continue;
    if (widget.config[field.key] === undefined) {
      widget.config[field.key] = field.default;
    }
  }

  const instance = {
    el: node, widget, timers: [], destroy: null,
    identity: identityOf(widget), key,
  };
  mounted.set(key, instance);

  try {
    const ctx = makeContext(instance, body, widget, board);
    // A widget may return a cleanup function, the way an effect does.
    instance.destroy = def.mount(ctx) || null;
  } catch (err) {
    console.error(`widget ${widget.kind} failed to mount`, err);
    body.append(el('div', { class: 'widget-error' }, String(err.message || err)));
  }
}

/* Paint the layout's backdrop.
 *
 * Nearly every community board built for one of these displays is a full-bleed
 * photo with translucent panels floating on it, so the background is a layout
 * property rather than a widget you have to remember to send to the back.
 *
 * The dim layer matters more than it sounds: white text over a bright sky is
 * unreadable, and a board that looks perfect at night becomes useless at noon
 * when the slideshow rotates onto a beach photo. Dimming is applied to the
 * IMAGE only, never to the widgets on top of it. */
function paintBackground(layout) {
  const backdrop = document.getElementById('backdrop');
  const base = layout?.background || '#101014';
  document.body.style.background = base;
  BOARD.style.background = 'transparent';

  const image = layout?.background_image;
  if (!image || layout?.background_kind === 'none') {
    backdrop.style.backgroundImage = 'none';
    backdrop.style.setProperty('--dim', '0');
    return;
  }
  backdrop.style.backgroundImage = `url("${image}")`;
  backdrop.style.filter = layout.background_blur
    ? `blur(${layout.background_blur}px)` : 'none';
  // Slight scale-up so a blur does not reveal soft edges at the screen border.
  backdrop.style.transform = layout.background_blur ? 'scale(1.04)' : 'none';
  backdrop.style.setProperty('--dim', String((layout.background_dim ?? 35) / 100));
}

/* ------------------------------------------------------------- onboarding */

/* The device has no keyboard and no local login, so the screen is the only way
 * it can explain itself. Until it has a network AND an admin password, it puts
 * instructions here instead of an empty board — otherwise a fresh appliance is
 * indistinguishable from a broken one. */
function renderOnboarding(info) {
  const big = { fontSize: '3.4vmin', fontWeight: '300' };
  const dim = { fontSize: '2vmin', color: 'var(--fg-dim)', lineHeight: '1.5' };
  const step = (n, ...kids) => el('div', {
    style: { display: 'flex', gap: '1.6vmin', alignItems: 'flex-start', maxWidth: '80vmin' },
  },
    el('div', {
      style: {
        flex: '0 0 auto', width: '4vmin', height: '4vmin', borderRadius: '50%',
        border: '1px solid rgba(255,255,255,.3)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', fontSize: '2vmin',
      },
    }, String(n)),
    el('div', { style: { flex: '1 1 auto' } }, ...kids),
  );

  const steps = [];

  if (!info.online) {
    // No network. The hotspot is the only way in.
    steps.push(step(1,
      el('div', big, 'Join this Wi-Fi network from your phone'),
      el('div', { style: { ...dim, marginTop: '.6vmin' } },
        el('code', { style: { fontSize: '3vmin', color: '#fff' } }, info.hotspot_ssid)),
      info.hotspot_active
        ? null
        : el('div', { style: { ...dim, color: '#d9a06b', marginTop: '.4vmin' } },
            'Starting the setup network… this can take a minute after power on.'),
      info.wifi_error
        ? el('div', { style: { ...dim, color: '#e08a8a', marginTop: '.6vmin' } },
            `Could not join "${info.wifi_error.ssid}": ${info.wifi_error.error} `
            + 'Join the setup network again and try once more.')
        : null,
    ));
    steps.push(step(2,
      el('div', big, 'The setup page opens by itself'),
      el('div', { style: { ...dim, marginTop: '.4vmin' } },
        el('div', {}, 'If it does not, open this in the phone’s browser:'),
        el('code', { style: { fontSize: '2.6vmin', color: '#fff' } },
          'http://10.42.0.1:8080')),
    ));
    steps.push(step(3,
      el('div', big, 'Pick your home Wi-Fi and type its password'),
      el('div', { style: { ...dim, marginTop: '.4vmin' } },
        'This screen will update once it is connected.'),
    ));
  } else {
    /* Online. The address is the ONLY thing anyone needs from this screen
     * now, so it is the thing that gets the size - big enough to read from
     * across the room and type into a phone without walking over. */
    steps.push(step(1,
      el('div', big, 'Open this address on any computer or phone on your network'),
      el('div', { style: { marginTop: '1vmin' } },
        ...(info.addresses.length
          ? info.addresses.map((ip) => el('div', {
              style: {
                fontSize: '4.2vmin', color: '#fff', fontWeight: '300',
                letterSpacing: '.02em', lineHeight: '1.4',
              },
            }, `${ip}:8080`))
          : [el('div', { style: { fontSize: '3vmin', color: '#fff' } },
              'http://<this-device>:8080/admin/')])),
    ));
    if (info.needs_password) {
      steps.push(step(2,
        el('div', big, 'Set an admin password'),
        el('div', { style: { ...dim, marginTop: '.4vmin' } },
          'Then pick a template and this screen becomes your board.'),
      ));
    } else if (info.needs_layout) {
      // Password done, network done, nothing to show. Without this the board
      // went black here, which on a wall-mounted TV with no keyboard looks
      // exactly like a dead appliance.
      steps.push(step(2,
        el('div', big, 'Pick a template for this screen'),
        el('div', { style: { ...dim, marginTop: '.4vmin' } },
          info.screen_name
            ? `Choose a layout for "${info.screen_name}" and it appears here `
              + 'straight away - this screen is waiting for one.'
            : 'Choose a layout and it appears here straight away.'),
      ));
    }
  }

  const qrParams = new URLSearchParams(
    info.online
      ? { mode: 'text', text: `http://${info.addresses[0] || 'lifeboard'}:8080/admin/`, scale: '8' }
      : { mode: 'wifi', ssid: info.hotspot_ssid, security: 'nopass', scale: '8' }
  );

  BOARD.replaceChildren(el('div', {
    style: {
      position: 'absolute', inset: '0', display: 'flex',
      alignItems: 'center', justifyContent: 'center', gap: '6vmin',
      padding: '6vmin', flexWrap: 'wrap',
    },
  },
    el('div', { style: { flex: '1 1 50vmin', minWidth: '40vmin' } },
      el('div', {
        style: {
          fontSize: '2vmin', letterSpacing: '.3em', color: 'var(--fg-dim)',
          marginBottom: '3vmin',
        },
      }, 'LIFEBOARD — SETUP'),
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '3vmin' } },
        ...steps),
    ),
    el('div', {
      style: {
        flex: '0 0 auto', background: '#fff', padding: '2vmin',
        borderRadius: '2vmin', width: '32vmin', height: '32vmin',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      },
    },
      el('img', {
        src: `/api/qr?${qrParams}`,
        alt: 'Setup QR code',
        style: { width: '100%', height: '100%', imageRendering: 'pixelated' },
      })),
  ));
  onboardingNode = BOARD.firstElementChild;
  document.getElementById('boot')?.remove();
}

function render(board) {
  if (board.onboarding) {
    unmountAll();
    paintBackground(null);
    renderOnboarding(board.onboarding);
    return;
  }

  // Configured now, whatever this screen was showing a minute ago.
  clearOnboarding();
  paintBackground(board.layout);

  const widgets = board.widgets || [];
  const seen = new Set();

  widgets.forEach((widget, index) => {
    const key = keyOf(widget, index);
    seen.add(key);
    const existing = mounted.get(key);

    if (existing && existing.identity === identityOf(widget)) {
      // Unchanged. Reposition if it moved and leave everything else alone —
      // its timers keep running and, crucially, a playing video is untouched.
      placeWidget(existing.el, widget, index);
      existing.widget = widget;
      return;
    }
    if (existing) unmountOne(existing);
    mountWidget(widget, board, key);
  });

  // Anything no longer on the board.
  for (const [key, instance] of [...mounted]) {
    if (!seen.has(key)) {
      unmountOne(instance);
      mounted.delete(key);
    }
  }

  document.getElementById('boot')?.remove();
}

/* ------------------------------------------------------------------ cycle */

async function poll() {
  try {
    const board = await getJSON(`/api/board?screen_id=${encodeURIComponent(SCREEN_ID)}`);
    consecutiveFailures = 0;
    setOffline(false);

    // Rebuild only when the layout genuinely changed. Re-mounting every ten
    // seconds would restart video playback and re-trigger every fetch.
    // Onboarding state is part of the key so the screen flips to the board the
    // moment setup finishes, without anyone touching the device.
    // A different LAYOUT means a genuinely different board, so start clean.
    // Within one layout, reconciliation keeps unchanged widgets alive.
    if (currentLayoutId !== null && board.layout?.id !== currentLayoutId) {
      unmountAll();
    }
    currentLayoutId = board.layout?.id ?? null;

    const revision = JSON.stringify([
      board.revision, board.layout?.id, board.widgets?.length,
      board.onboarding ? [board.onboarding.online, board.onboarding.needs_password,
                          board.onboarding.hotspot_active] : null,
    ]);
    if (revision !== currentRevision) {
      currentRevision = revision;
      render(board);
    }
  } catch (err) {
    consecutiveFailures += 1;
    console.warn('board poll failed', err);
    // Two misses is ~20s - long enough to ignore a service restart, short
    // enough to be honest that the data is stale.
    if (consecutiveFailures >= 2) setOffline(true);
  }
}

/* The clock on an appliance drifts, and a board left running across a DST
 * change or a resume-from-suspend can end up hours out. Watching for a big
 * jump in wall time and re-rendering is cheaper and far more reliable than
 * trying to make every widget individually DST-aware. */
/* ------------------------------------------------------- device identity */

/* Each display keeps its own token so the admin UI can list real screens and
 * refresh one of them remotely. Stored in localStorage rather than issued by
 * the server, because a kiosk that is reimaged or has its storage cleared
 * should simply become a new device rather than needing to be paired again.
 *
 * Remote refresh is a counter, not a push: the server bumps it, this notices
 * on the next heartbeat and reloads. Nothing to keep alive across a suspend,
 * which is the failure mode a websocket would have. */
const DEVICE_KEY = 'lifeboard_device_token';

function deviceToken() {
  try {
    let token = localStorage.getItem(DEVICE_KEY);
    if (!token) {
      token = (crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/-/g, '')
            + Date.now().toString(36);
      localStorage.setItem(DEVICE_KEY, token);
    }
    return token;
  } catch {
    // Private mode, or storage disabled. Fall back to a per-session token so
    // the board still works; it just appears as a new device each boot.
    return 'ephemeral' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

const DEVICE_TOKEN = deviceToken();
let lastRefreshSeq = null;

async function heartbeat() {
  try {
    const resp = await fetch('/api/device/hello', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: DEVICE_TOKEN,
        screen_id: Number(SCREEN_ID) || 1,
        resolution: `${window.screen?.width || 0}x${window.screen?.height || 0}`,
      }),
    });
    if (!resp.ok) return;
    const info = await resp.json();

    if (lastRefreshSeq === null) {
      lastRefreshSeq = info.refresh_seq;
    } else if (info.refresh_seq !== lastRefreshSeq) {
      console.info('remote refresh requested');
      location.reload();
    }
  } catch {
    // A failed heartbeat must never disturb the board. The device simply shows
    // as offline in the admin UI until it comes back.
  }
}

/* Only the board page drives itself.
 *
 * The admin UI imports CATALOGUE from the widget registry, which pulls in this
 * module - and evaluating a module runs its top level. Without this guard the
 * admin tab starts polling /api/board, registers itself as a device sending
 * heartbeats, and can act on a remote-refresh instruction with a
 * location.reload() of the ADMIN page. It also throws on every poll, because
 * paintBackground writes to a #board element that only the renderer has.
 *
 * Importing a module must not have side effects on a page that only wanted one
 * of its exports. */
if (BOARD) startRenderer();

function startRenderer() {
heartbeat();
setInterval(heartbeat, 60_000);

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  if (Math.abs(now - lastTick - 30_000) > 60_000) {
    console.info('wall clock jumped; forcing re-render');
    currentRevision = null;
  }
  lastTick = now;
}, 30_000);

poll();
setInterval(poll, LAYOUT_POLL_MS);

// Chromium in kiosk mode will happily keep a dead page up forever. If the
// renderer itself throws hard, reload rather than leaving a frozen board.
window.addEventListener('error', (event) => {
  console.error('fatal renderer error', event.error);
  setTimeout(() => location.reload(), 30_000);
});
}
