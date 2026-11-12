/* Live widget previews for the layout editor.
 *
 * This runs inside an iframe the editor sizes to the BOARD's real pixel
 * dimensions and then scales down with a CSS transform. The iframe is the
 * whole point: widgets size themselves in `vmin`, which resolves against the
 * viewport. Rendering a preview directly in the admin page would measure vmin
 * against the browser window, so a 9vmin clock would come out roughly the
 * height of the admin sidebar instead of a ninth of the board. Inside an
 * iframe that is 1080x1920, vmin means exactly what it means on the wall.
 *
 * It mounts the REAL widget modules rather than drawing mock shapes, so a
 * preview cannot drift from the board. What it does NOT do is touch the
 * network, run timers, or start video - see makeContext below.
 */

import { WIDGETS, CATALOGUE } from '../render/widgets/registry.js';
import { el, applyBlockStyle, panelClass, frameClass } from '../render/app.js';
import { previewFetch } from './preview-data.js';

const stage = document.getElementById('stage');

/* Widgets that must never really run in the editor.
 *
 * `video` would start a stream - and on the appliance the server-side agent
 * would then try to place an mpv window over the ADMIN page. `iframe` and
 * `html` load third-party content that can be slow, noisy, or navigate
 * itself. Each gets an honest placeholder at the correct size instead. */
const STUBBED = {
  video: ['▶', 'Video'],
  iframe: ['\u{1f310}', 'Web page'],
  html: ['\u{1f4c4}', 'Custom HTML'],
};

const mounted = new Map();   // widget id -> { node, destroy }

function stub(kind, config = {}) {
  const [ico, label] = STUBBED[kind];
  const card = el('div', { class: 'pw-stub' },
    el('div', { class: 'ico' }, ico),
    el('div', { class: 'lbl' }, label));
  // A contained video is a 16:9 picture letterboxed inside the block, not the
  // whole block - draw the placeholder at that size.
  if (kind === 'video' && config.fit === 'contain') {
    card.classList.add('pw-stub--169');
    return el('div', { class: 'pw-stub-frame' }, card);
  }
  return card;
}

/* The preview context.
 *
 * Deliberately the same shape as the renderer's, minus anything with a
 * lifetime or a side effect:
 *   - getJSON is served from fixtures; nothing leaves the page.
 *   - interval/timeout are NO-OPS. A widget that rotates every 12s would
 *     otherwise leave a timer per redraw, and dragging a block redraws
 *     constantly - within a minute the editor would be running hundreds of
 *     them. A preview only ever needs the first frame.
 *   - fail/clearFail are silent; a preview must never paint a red error.
 */
function makeContext(instance, body, widget) {
  return {
    body,
    el0: instance.node,
    config: widget.config || {},
    widget,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    nativeVideo: false,
    el,
    getJSON: async (url) => previewFetch(url),
    interval: () => 0,
    timeout: () => 0,
    fail: () => {},
    clearFail: () => {},
    preview: true,
  };
}

function place(node, w) {
  node.style.left = `${w.x}%`;
  node.style.top = `${w.y}%`;
  node.style.width = `${w.w}%`;
  node.style.height = `${w.h}%`;
  node.style.zIndex = String(w.z ?? 0);
  node.style.opacity = w.visible === false ? '.35' : '1';
}

/* Templates ship with their source ids stripped - they are meaningless on
 * another appliance and are re-bound by name on import. A weather widget with
 * no source renders "No weather source selected", which is the truth for the
 * template file and completely useless as a preview of what it will look like
 * once applied.
 *
 * So the gallery fills in a placeholder id and the fixtures answer for it. The
 * LAYOUT editor deliberately does NOT: there, an unset source is a real
 * mistake the user needs to see rather than have papered over. */
function fillSources(kind, config) {
  const fields = CATALOGUE[kind]?.fields || [];
  const out = { ...config };
  for (const f of fields) {
    if (f.type === 'source' && (out[f.key] === undefined || out[f.key] === '')) {
      out[f.key] = 1;
    }
    if (f.type === 'sources' && !(out[f.key] || []).length) {
      out[f.key] = [1];
    }
    if (f.type === 'entities' && !out[f.key]) {
      out[f.key] = 'sensor.living_room_temperature, sensor.humidity';
    }
    if (f.type === 'todolist' && out[f.key] === undefined) {
      out[f.key] = 1;
    }
  }
  return out;
}

function mountOne(widget, opts = {}) {
  const def = WIDGETS[widget.kind];
  // The renderer's class names and stylesheet (render/board.css), so panel
  // padding, borders and frames land where they do on the wall.
  const node = el('div', { class: 'widget' + panelClass(widget, def) + frameClass(widget) });
  place(node, widget);
  // Same formatting the renderer applies, from the same function - a preview
  // that styled blocks its own way would be a second implementation to keep
  // in step, which is exactly what this whole file exists to avoid.
  applyBlockStyle(node, widget);

  const title = widget.config?.title;
  if (title) node.append(el('div', { class: 'widget-title' }, title));
  const body = el('div', { class: 'widget-body' });
  node.append(body);
  stage.append(node);

  const record = { node, destroy: null };

  if (STUBBED[widget.kind]) {
    body.append(stub(widget.kind, widget.config || {}));
    return record;
  }
  if (!def) {
    body.append(el('div', { class: 'pw-stub' },
      el('div', { class: 'ico' }, '?'),
      el('div', { class: 'lbl' }, widget.kind)));
    return record;
  }

  // Same defaults pass the renderer does, or a preview disagrees with the
  // board for any widget relying on a catalogue default.
  let config = { ...(widget.config || {}) };
  for (const field of (CATALOGUE[widget.kind]?.fields || [])) {
    if (field.default !== undefined && config[field.key] === undefined) {
      config[field.key] = field.default;
    }
  }
  if (opts.fillSources) config = fillSources(widget.kind, config);

  try {
    const ctx = makeContext(record, body, { ...widget, config });
    record.destroy = def.mount(ctx) || null;
  } catch (err) {
    // A widget that throws on sample data must not take the editor down with
    // it; show the placeholder and carry on with the rest of the board.
    console.warn(`preview: ${widget.kind} failed to mount`, err);
    body.replaceChildren(el('div', { class: 'pw-stub' },
      el('div', { class: 'ico' }, CATALOGUE[widget.kind]?.icon || '?'),
      el('div', { class: 'lbl' }, CATALOGUE[widget.kind]?.label || widget.kind)));
  }
  return record;
}

function unmountAll() {
  for (const rec of mounted.values()) {
    try { rec.destroy?.(); } catch { /* teardown */ }
    rec.node.remove();
  }
  mounted.clear();
}

/* What the editor calls. Two entry points on purpose:
 *
 *   render() is a full rebuild - use it when the set of widgets or their
 *   settings change.
 *
 *   move() only restyles, so dragging is smooth. Remounting a photo widget on
 *   every pointermove would restart its slideshow sixty times a second and
 *   make the editor crawl.
 */
window.__lifeboardPreview = {
  render(widgets, background, opts = {}) {
    unmountAll();
    document.body.style.background = background || 'transparent';
    for (const w of widgets) {
      if (w.visible === false && w.hide_in_preview) continue;
      mounted.set(w.__key, mountOne(w, opts));
    }
  },

  move(key, widget) {
    const rec = mounted.get(key);
    if (rec) place(rec.node, widget);
  },

  /* Where each block's content is actually drawn, for the editor's content
   * outline and "Fit to content". Keyed like render(); values are percent of
   * the board:
   *   ink   [x, y, w, h] - union of text, images, media and anything with a
   *         background, border or shadow inside the block, clipped to it.
   *         null when nothing is drawn.
   *   inset [top, right, bottom, left] - the block's own padding + border,
   *         so a panelled block can be fitted with its card intact.
   *   chrome - whether the block paints its own card or frame. */
  measure() {
    const out = {};
    const sw = stage.clientWidth || 1, sh = stage.clientHeight || 1;
    const origin = stage.getBoundingClientRect();
    for (const [key, rec] of mounted) out[key] = inkOf(rec.node, origin, sw, sh);
    return out;
  },

  ready: true,
};

function paints(style) {
  const bg = style.backgroundColor;
  const hasBg = (bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg))
    || (style.backgroundImage && style.backgroundImage !== 'none');
  const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some((k) =>
    parseFloat(style[`border${k}Width`]) > 0 && style[`border${k}Style`] !== 'none');
  return hasBg || hasBorder || (style.boxShadow && style.boxShadow !== 'none');
}

function inkOf(node, origin, sw, sh) {
  const box = node.getBoundingClientRect();
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  const add = (q) => {
    const L = Math.max(q.left, box.left), T = Math.max(q.top, box.top);
    const R = Math.min(q.right, box.right), B = Math.min(q.bottom, box.bottom);
    if (R - L < 0.5 || B - T < 0.5) return;
    if (L < l) l = L;
    if (T < t) t = T;
    if (R > r) r = R;
    if (B > b) b = B;
  };
  const shown = (e) => {
    const s = getComputedStyle(e);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.02;
  };
  const walk = (e) => {
    if (!shown(e)) return;
    if (e !== node && paints(getComputedStyle(e))) add(e.getBoundingClientRect());
    if (/^(IMG|CANVAS|VIDEO|IFRAME|svg|SVG)$/.test(e.tagName)) { add(e.getBoundingClientRect()); return; }
    for (const c of e.childNodes) {
      if (c.nodeType === 3 && c.textContent.trim()) {
        const range = document.createRange();
        range.selectNodeContents(c);
        for (const q of range.getClientRects()) add(q);
      } else if (c.nodeType === 1) walk(c);
    }
  };
  walk(node);

  const s = getComputedStyle(node);
  const px = (v) => parseFloat(v) || 0;
  const pct = (v, of) => (v / of) * 100;
  return {
    ink: l === Infinity ? null : [
      pct(l - origin.left, sw), pct(t - origin.top, sh), pct(r - l, sw), pct(b - t, sh),
    ],
    inset: [
      pct(px(s.paddingTop) + px(s.borderTopWidth), sh),
      pct(px(s.paddingRight) + px(s.borderRightWidth), sw),
      pct(px(s.paddingBottom) + px(s.borderBottomWidth), sh),
      pct(px(s.paddingLeft) + px(s.borderLeftWidth), sw),
    ],
    chrome: !!paints(s),
  };
}

// Tell the parent it can start driving. Without this the editor would have to
// guess when the module finished loading.
window.parent?.postMessage({ type: 'lifeboard-preview-ready' }, '*');
