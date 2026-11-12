/* Shapes have to be VISIBLE, on the old engine too.
 *
 * The Line shape rendered perfectly on a Raspberry Pi and did not appear at
 * all inside the Android app. The cause was not in the shape code: the line
 * centred itself with `inset: calc(50% - 1px) 0`, and on an engine without
 * `inset` support app.js expands the shorthand by splitting on whitespace -
 * which turns two values into four pieces of nonsense (`calc(50%`, `-`,
 * `1px)`, `0`). Every one is invalid, the element loses its positioning, and
 * it collapses to nothing. Modern Chrome supports `inset` and never reaches
 * that code, so the bug was invisible everywhere it was being tested.
 *
 * Two things follow, and both are checked here:
 *
 *   1. The expansion must not split a value that contains spaces of its own.
 *   2. A shape must produce something with real size, on both paths.
 *
 *   node tools/test_shapes.mjs
 */
import { readFileSync } from 'node:fs';

const problems = [];
const app = readFileSync(new URL('../web/render/app.js', import.meta.url), 'utf8');

/* -------------------------------------------- 1. the shorthand expansion */

// Pulled out by source: importing app.js runs the renderer's boot path.
const splitter = /const parts = String\(value\)\.trim\(\)(.+);/.exec(app);
if (!splitter) {
  problems.push('could not find the inset splitter in app.js');
} else {
  const expr = new Function('value',
    `return String(value).trim()${splitter[1]};`);

  const cases = [
    ['0', 1, 'a single value'],
    ['0 10px', 2, 'two values'],
    ['calc(50% - 1px) 0', 2, 'a calc() and a value'],
    ['0 calc(50% - 1px)', 2, 'a value and a calc()'],
    ['calc(50% - 1px) calc(50% - 1px)', 2, 'two calc()s'],
    ['1px 2px 3px 4px', 4, 'all four'],
  ];
  for (const [value, want, label] of cases) {
    const got = expr(value) || [];
    if (got.length !== want) {
      problems.push(`${label}: "${value}" split into ${got.length} `
        + `(${JSON.stringify(got)}), expected ${want}`);
    }
  }
  if (!problems.length) {
    console.log('  ok   inset expansion keeps calc() in one piece');
  }
}

/* ------------------------------------------------ 2. the shapes themselves */

/* A DOM shim just real enough to see whether a shape has size.
 *
 * `el()` is taken from app.js by source for the same reason as above. The
 * shim's job is only to record the styles that were set, so the test can ask
 * the one question that matters: would this element occupy space?
 */
/* Everything is taken by SOURCE rather than imported.
 *
 * extras.js imports app.js, which imports registry.js, which imports
 * extras.js. A browser resolves that cycle; Node hits the temporal dead zone
 * and throws. Cutting the pieces out keeps the test honest about what it is
 * exercising, and it is the same approach test_reconcile.mjs takes.
 */
const extras = readFileSync(
  new URL('../web/render/widgets/extras.js', import.meta.url), 'utf8');

function cutBlock(src, startNeedle, endNeedle) {
  const from = src.indexOf(startNeedle);
  const to = src.indexOf(endNeedle, from);
  if (from < 0 || to < 0) throw new Error(`could not cut ${startNeedle}`);
  return src.slice(from, to);
}

function cutFunction(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`${signature} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  throw new Error(`could not find the end of ${signature}`);
}

const made = [];
let nodeStyleHasInset = false;   // false = the old engine, the broken one

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: nodeStyleHasInset ? { inset: '' } : {},
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); return kid; },
    setAttribute() {}, addEventListener() {},
  };
  made.push(node);
  return node;
}

// The REAL expansion, lifted out of app.js — that is the code under test.
const applyStyleSrc = cutFunction(app, 'function applyStyle(');
const applyStyle = new Function(`${applyStyleSrc}; return applyStyle;`)();

function el(tag, attrs = {}, ...children) {
  const node = makeNode(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'style' && typeof v === 'object') applyStyle(node, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

const shapeSrc = cutBlock(extras, '/* CLIPPED SHAPES.',
  '/* ---------------------------------------------------------------- button */')
  .replace(/^export /gm, '');
const { shape } = new Function('el', `${shapeSrc}; return { shape };`)(el);

function draw(config, { modernEngine = false } = {}) {
  nodeStyleHasInset = modernEngine;
  made.length = 0;
  const body = makeNode('div');
  made.length = 0;                 // the body itself is not a shape
  shape.mount({ config, body, el });
  // A COPY. `made` is reused by the next draw, and handing the live array back
  // means two results silently become the same result - which reads as "the
  // setting is ignored" when in fact the test overwrote its own evidence.
  return { body, all: [...made] };
}

/* Does anything here have a real extent?
 *
 * A shape is positioned absolutely inside its block, so it has size if it
 * pins opposite edges, or if it states a width or a height outright. What it
 * must NOT have is `calc(50%` - the signature of the split going wrong.
 */
function hasExtent(node) {
  const s = node.style || {};
  const pinnedV = s.top !== undefined && s.bottom !== undefined;
  const pinnedH = s.left !== undefined && s.right !== undefined;
  const sized = !!(s.width || s.height);
  return (pinnedV && pinnedH) || sized;
}

function broken(node) {
  const s = node.style || {};
  return Object.values(s).some(
    (v) => typeof v === 'string' && /^calc\([^)]*$/.test(v.trim()));
}

const SHAPES = [
  'rect', 'oval', 'line', 'frame', 'brackets', 'diamond', 'triangle',
  'triangle_down', 'hexagon', 'chevron', 'star', 'burst',
];

for (const kind of SHAPES) {
  const { all } = draw({ shape: kind });
  const mangled = all.filter(broken);
  if (mangled.length) {
    problems.push(`${kind}: a style value was split mid-calc(): `
      + JSON.stringify(mangled[0].style));
  } else if (!all.some(hasExtent)) {
    problems.push(`${kind}: nothing it drew has any size, so it will not appear`);
  }
}
if (!problems.some((p) => SHAPES.some((k) => p.startsWith(k + ':')))) {
  console.log(`  ok   all ${SHAPES.length} shapes draw something with size`);
}

// The line in every direction and style, since that is the one that failed.
for (const orientation of ['horizontal', 'vertical']) {
  for (const line_style of ['solid', 'fade', 'dashed', 'dotted', 'double']) {
    const { all } = draw({ shape: 'line', orientation, line_style, thickness: 4 });
    const sized = all.filter((n) => n.style && (n.style.width || n.style.height));
    if (!sized.length) {
      problems.push(`line ${orientation}/${line_style}: nothing was given a size`);
    } else if (all.some(broken)) {
      problems.push(`line ${orientation}/${line_style}: a value was split mid-calc()`);
    }
  }
}
if (!problems.some((p) => p.startsWith('line '))) {
  console.log('  ok   every line direction and style has a real thickness');
}

// Thickness must actually reach the element, or the setting is decorative.
const thin = draw({ shape: 'line', thickness: 2 });
const thick = draw({ shape: 'line', thickness: 12 });
const heightOf = (r) => (r.all.find((n) => n.style && n.style.height) || {})
  .style?.height;
if (heightOf(thin) === heightOf(thick)) {
  problems.push(`thickness is ignored: 2px and 12px both gave ${heightOf(thin)}`);
} else {
  console.log(`  ok   thickness reaches the line (${heightOf(thin)} vs ${heightOf(thick)})`);
}

// An ornament splits the rule rather than sitting on top of it.
const plain = draw({ shape: 'line' });
const fancy = draw({ shape: 'line', ornament: 'diamond' });
if (fancy.all.length <= plain.all.length) {
  problems.push('the centre ornament added nothing to the line');
} else {
  console.log('  ok   a centre ornament splits the rule in two');
}

if (problems.length) {
  console.error('\nFAILED:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\nShapes appear, on the engine that could not draw them before.');
