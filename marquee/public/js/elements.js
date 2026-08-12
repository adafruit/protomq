/**
 * Canvas elements: every prop the toolbox can drop, plus the shared wiring that
 * makes one behave like an element (drag, snap, transform-bake, select).
 *
 * Widgets are Konva Groups that rebuild their children from attrs, so resize,
 * recolor, feed refresh and save/load all flow through one code path
 * (rebuildWidget).
 */

import { Konva } from './konva.js';
import { display, logicalDims, PAPER, PALETTES, hexToRGB, neutralShades } from './palette.js';
import { layer, tr, snap, zoom, suspendDitherPreview, scheduleDitherRefresh } from './stage.js';
import { select, refreshProps } from './selection.js';
import { toast } from './util.js';

let counter = 0;
export const nextId = () => 'el' + (++counter);
export const resetCounter = () => { counter = 0; };

/**
 * Group-based elements that rebuild their children from attrs. Membership here
 * is load-bearing, not a convenience: an etype missing from this set falls
 * through wireNode's transformend chain into the LABEL branch and throws on
 * fontSize() (a Group has no such method), and through refreshProps into the
 * DIVIDER branch.
 */
export const WIDGET_TYPES = ['linechart', 'gauge', 'indicator', 'battery'];
export function isWidget(n) { return WIDGET_TYPES.includes(n.getAttr('etype')); }

/**
 * Elements that carry a feedKey and get re-read by refreshFeedElements(). This
 * used to be a bare `etype === 'indicator'` down at the call site, where a new
 * feed-bound widget silently never polls; keep new types listed here.
 */
export const FEED_ETYPES = ['indicator', 'battery'];

/**
 * Which attr each feed-bound widget parks its last sample in. Konva's Node
 * registers a `value` getter/setter whose default is 0, so an attr literally
 * named `value` can never read back as unset: setAttr('value', null) DELETES it
 * and getAttr('value') then returns 0. The battery stores its sample under
 * `feedValue` so "unknown" stays distinguishable from a real reading of zero.
 */
const FEED_VALUE_ATTR = { indicator: 'value', battery: 'feedValue' };
export const feedValueAttr = (n) => FEED_VALUE_ATTR[n.getAttr('etype')] || 'value';

/**
 * Smallest authored width per widget, used when baking a transform back into
 * attrs and by the inspector's size inputs. Anything unlisted floors at 40.
 */
export const MIN_WIDGET_W = { indicator: 6, battery: 20 };

export function elementColor(n) { return isWidget(n) ? n.getAttr('ink') : n.fill(); }

export function setElementColor(n, c) {
  if (isWidget(n)) { n.setAttr('ink', c); rebuildWidget(n); }
  else n.fill(c);
}

// ---------- sample data -----------------------------------------------------

function randTempSeries() {
  const pts = [];
  let v = 60 + Math.random() * 20;
  for (let i = 0; i < 12; i++) {
    v = Math.min(95, Math.max(40, v + (Math.random() - 0.5) * 9));
    pts.push(Math.round(v));
  }
  return pts;
}
function randTemp() { return Math.round(45 + Math.random() * 45); }

// ---------- widget dispatch -------------------------------------------------

/**
 * Explicit dispatch. This was `if (linechart) … else buildGauge()`, which drew
 * any unrecognized widget AS A GAUGE — a silent wrong-render rather than an
 * error.
 */
const WIDGET_BUILDERS = {
  linechart: buildLineChart,
  gauge: buildGauge,
  indicator: buildIndicator,
  battery: buildBattery,
};

export function rebuildWidget(n) {
  const build = WIDGET_BUILDERS[n.getAttr('etype')];
  if (!build) { console.warn('rebuildWidget: no builder for etype', n.getAttr('etype')); return; }
  build(n);
  if (tr.nodes().includes(n)) tr.forceUpdate();
}

// ---------- label + divider -------------------------------------------------

export function addLabel(attrs = {}) {
  const { w, h } = logicalDims();
  const node = new Konva.Text(Object.assign({
    x: Math.round(w / 2 - 30), y: Math.round(h / 2 - 10),
    text: 'Label', fontSize: 20, fontFamily: 'monospace',
    fill: PALETTES[display.type][0], draggable: true,
    name: 'element', id: nextId(),
  }, attrs));
  node.setAttr('etype', 'label');
  wireNode(node);
  layer.add(node);
  return node;
}

export function addDivider(attrs = {}) {
  const { w, h } = logicalDims();
  const node = new Konva.Rect(Object.assign({
    x: Math.round(w * 0.1), y: Math.round(h / 2),
    width: Math.round(w * 0.8), height: 2,
    fill: PALETTES[display.type][0], draggable: true,
    name: 'element', id: nextId(),
  }, attrs));
  node.setAttr('etype', 'divider');
  wireNode(node);
  layer.add(node);
  return node;
}

// ---------- line chart ------------------------------------------------------

function buildLineChart(g) {
  g.destroyChildren();
  const w = g.getAttr('w'), h = g.getAttr('h');
  const ink = g.getAttr('ink'), data = g.getAttr('data'), title = g.getAttr('title');
  g.add(new Konva.Rect({ width: w, height: h, fill: '#000', opacity: 0 })); // hit area
  g.add(new Konva.Text({ text: `${title} °F`, fontSize: 9, fontFamily: 'monospace', fill: ink, x: 1, y: 0 }));
  g.add(new Konva.Text({
    text: `${data[data.length - 1]}°`, fontSize: 9, fontFamily: 'monospace',
    fill: ink, x: 0, y: 0, width: w - 1, align: 'right',
  }));
  const top = 12;
  g.add(new Konva.Line({ points: [0.5, top, 0.5, h - 0.5, w, h - 0.5], stroke: ink, strokeWidth: 1 }));
  const lo = Math.min(...data), hi = Math.max(...data), span = Math.max(1, hi - lo);
  const pts = [];
  data.forEach((v, i) => {
    pts.push(3 + i / (data.length - 1) * (w - 6));
    pts.push(top + 3 + (1 - (v - lo) / span) * (h - top - 8));
  });
  g.add(new Konva.Line({ points: pts, stroke: ink, strokeWidth: 1, lineJoin: 'round' }));
}

export function addLineChart(attrs = {}) {
  const { w, h } = logicalDims();
  const g = new Konva.Group({
    x: attrs.x ?? Math.round(w / 2 - 60), y: attrs.y ?? Math.round(h / 2 - 30),
    draggable: true, name: 'element', id: nextId(),
  });
  g.setAttr('etype', 'linechart');
  g.setAttr('w', attrs.w ?? 120);
  g.setAttr('h', attrs.h ?? 60);
  g.setAttr('ink', attrs.ink ?? PALETTES[display.type][0]);
  g.setAttr('title', attrs.title ?? 'Temperature');
  g.setAttr('data', attrs.data ?? randTempSeries());
  buildLineChart(g);
  wireNode(g);
  layer.add(g);
  return g;
}

// ---------- gauge -----------------------------------------------------------

function buildGauge(g) {
  g.destroyChildren();
  const w = g.getAttr('w');
  const ink = g.getAttr('ink'), value = g.getAttr('value'), title = g.getAttr('title');
  const min = 0, max = 100;
  const cx = w / 2, r = w / 2 - 2, cy = r + 6;
  const H = cy + 34;
  g.setAttr('h', H); // derived from width
  g.add(new Konva.Rect({ width: w, height: H, fill: '#000', opacity: 0 })); // hit area
  g.add(new Konva.Arc({ x: cx, y: cy, innerRadius: r - 3, outerRadius: r, angle: 180, rotation: 180, fill: ink }));
  for (let t = min; t <= max; t += 25) {
    const a = Math.PI + (t - min) / (max - min) * Math.PI;
    g.add(new Konva.Line({
      points: [cx + Math.cos(a) * (r - 5), cy + Math.sin(a) * (r - 5),
               cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10)],
      stroke: ink, strokeWidth: 1,
    }));
  }
  const va = Math.PI + (Math.min(max, Math.max(min, value)) - min) / (max - min) * Math.PI;
  g.add(new Konva.Line({
    points: [cx, cy, cx + Math.cos(va) * (r - 12), cy + Math.sin(va) * (r - 12)],
    stroke: ink, strokeWidth: 2, lineCap: 'round',
  }));
  g.add(new Konva.Circle({ x: cx, y: cy, radius: 3, fill: ink }));
  g.add(new Konva.Text({
    text: `${value}°F`, fontSize: 12, fontFamily: 'monospace', fill: ink,
    x: 0, y: cy + 6, width: w, align: 'center',
  }));
  g.add(new Konva.Text({
    text: title, fontSize: 9, fontFamily: 'monospace', fill: ink,
    x: 0, y: cy + 21, width: w, align: 'center',
  }));
}

export function addGauge(attrs = {}) {
  const { w, h } = logicalDims();
  const g = new Konva.Group({
    x: attrs.x ?? Math.round(w / 2 - 45), y: attrs.y ?? Math.round(h / 2 - 45),
    draggable: true, name: 'element', id: nextId(),
  });
  g.setAttr('etype', 'gauge');
  g.setAttr('w', attrs.w ?? 90);
  g.setAttr('ink', attrs.ink ?? PALETTES[display.type][0]);
  g.setAttr('title', attrs.title ?? 'Temperature');
  g.setAttr('value', attrs.value ?? randTemp());
  buildGauge(g);
  wireNode(g);
  layer.add(g);
  return g;
}

// ---------- indicator: on/off lamp driven by an Adafruit IO feed -------------

/** Operators are stored as JSON-safe tokens and shown as symbols in the UI. */
export const INDICATOR_OPS = [
  { op: 'eq', label: '=' }, { op: 'ne', label: '≠' },
  { op: 'gt', label: '>' }, { op: 'lt', label: '<' },
  { op: 'ge', label: '≥' }, { op: 'le', label: '≤' },
];

/**
 * Numeric when BOTH sides parse as finite numbers, else a case-insensitive
 * string compare: all values are assumed numeric, and a feed value that can't
 * be converted to a number is treated as a string.
 */
export function compareValues(raw, op, cmp) {
  const a = Number(raw), b = Number(cmp);
  const numeric = String(raw).trim() !== '' && String(cmp).trim() !== ''
    && Number.isFinite(a) && Number.isFinite(b);
  const [x, y] = numeric
    ? [a, b]
    : [String(raw ?? '').trim().toLowerCase(), String(cmp ?? '').trim().toLowerCase()];
  switch (op) {
    case 'eq': return x === y;
    case 'ne': return x !== y;
    case 'gt': return x > y;
    case 'lt': return x < y;
    case 'ge': return x >= y;
    case 'le': return x <= y;
    default:   return false;
  }
}

/** An unavailable value (never bound, fetch failed, empty feed) is false -> Off. */
export function indicatorValueKnown(g) {
  const v = g.getAttr('value');
  return v !== null && v !== undefined && v !== '';
}

function evalIndicator(g) {
  if (!indicatorValueKnown(g)) return false;
  return compareValues(g.getAttr('value'), g.getAttr('op'), g.getAttr('cmp'));
}

function buildIndicator(g) {
  g.destroyChildren();
  const w = g.getAttr('w');
  g.setAttr('h', w);                                                        // square
  g.add(new Konva.Rect({ width: w, height: w, fill: '#000', opacity: 0 })); // hit area
  // The outline is not decoration: on a mono panel the palette is only ink and
  // paper, so an Off lamp filled with paper would be invisible against the page.
  g.add(new Konva.Circle({
    x: w / 2, y: w / 2, radius: Math.max(1, w / 2 - 1),
    fill: evalIndicator(g) ? g.getAttr('onColor') : g.getAttr('offColor'),
    stroke: g.getAttr('ink'), strokeWidth: 1,
  }));
}

export function addIndicator(attrs = {}) {
  const { w: cw, h: ch } = logicalDims();
  const g = new Konva.Group({
    x: attrs.x ?? Math.round(cw / 2 - 8), y: attrs.y ?? Math.round(ch / 2 - 8),
    draggable: true, name: 'element', id: nextId(),
  });
  g.setAttr('etype', 'indicator');
  g.setAttr('w', attrs.w ?? 16);
  // Defaults use the darkest ink and the PAPER constant, both of which exist in
  // EVERY palette. Positional shortcuts don't: [1] is a dark grey on gray4, and
  // the last entry is paper on gray4 (an invisible "on" lamp).
  g.setAttr('onColor', attrs.onColor ?? PALETTES[display.type][0]);
  g.setAttr('offColor', attrs.offColor ?? PAPER);
  g.setAttr('ink', attrs.ink ?? PALETTES[display.type][0]);
  g.setAttr('op', attrs.op ?? 'eq');
  g.setAttr('cmp', attrs.cmp ?? '1');
  g.setAttr('feedKey', attrs.feedKey ?? '');
  g.setAttr('feedName', attrs.feedName ?? '');
  g.setAttr('value', attrs.value ?? null);
  buildIndicator(g);
  wireNode(g);
  layer.add(g);
  return g;
}

// ---------- battery level gauge ---------------------------------------------
//
// The feed's last value drives the bar length (assumed numeric, 0-100). A list
// of conditions is evaluated top to bottom against the SAME value; the first
// that holds supplies the fill shade, otherwise `defaultShade` is used.
//
// Shades are neutrals only (see neutralShades). A grey ramp reads correctly on
// every panel type, where a red/yellow one would exist on quadcolor and nowhere
// else.

const BATTERY_ASPECT = 0.5;    // body height as a fraction of body width

/**
 * Bar length only. Unknown or non-numeric reads as EMPTY, not full: a broken
 * feed binding should look obviously wrong rather than like a healthy battery.
 */
export function batteryFraction(g) {
  const raw = g.getAttr('feedValue');
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v / 100));
}

/** First matching condition wins, top to bottom. */
function batteryShade(g) {
  const raw = g.getAttr('feedValue');
  if (raw !== null && raw !== undefined && raw !== '') {
    for (const c of g.getAttr('conds') || [])
      if (compareValues(raw, c.op, c.cmp)) return c.color;
  }
  return g.getAttr('defaultShade');
}

function buildBattery(g) {
  g.destroyChildren();
  const w = g.getAttr('w');
  const ink = g.getAttr('ink');
  const bodyH = Math.max(6, Math.round(w * BATTERY_ASPECT));
  const nubW = Math.max(2, Math.round(w * 0.07));
  const nubH = Math.max(2, Math.round(bodyH * 0.4));
  const bodyW = w - nubW;                       // `w` is the whole icon, nub included
  g.setAttr('h', bodyH);                        // derived from width, as buildGauge does

  const frac = batteryFraction(g);
  const pctText = frac === null ? '—' : `${Math.round(Number(g.getAttr('feedValue')))}%`;
  const fontSize = Math.max(7, Math.round(bodyH * 0.6));
  // Reserve a fixed 4-character box so the icon doesn't shift as the value changes.
  const textW = g.getAttr('showPct') ? Math.ceil(fontSize * 0.62 * 4) : 0;
  const gap = g.getAttr('showPct') ? Math.max(2, Math.round(w * 0.08)) : 0;
  const totalW = w + gap + textW;

  // Hit area spans the percentage text too, so the whole widget is grabbable.
  g.add(new Konva.Rect({ width: totalW, height: bodyH, fill: '#000', opacity: 0 }));

  // Body outline. Always drawn in ink, never in the condition shade: on a mono
  // panel a paper-shaded fill is invisible, so the outline is what keeps the
  // battery on the page at all. Same reasoning as the indicator's lamp stroke.
  g.add(new Konva.Rect({
    x: 0.5, y: 0.5, width: bodyW - 1, height: bodyH - 1,
    stroke: ink, strokeWidth: 1, cornerRadius: 1,
  }));
  // Terminal nub on the right edge.
  g.add(new Konva.Rect({
    x: bodyW, y: Math.round((bodyH - nubH) / 2), width: nubW, height: nubH, fill: ink,
  }));

  // Fill bar, inset inside the outline so the two never touch.
  const inset = 2;
  const innerW = bodyW - 1 - inset * 2;
  const innerH = bodyH - 1 - inset * 2;
  if (frac !== null && frac > 0 && innerW > 0 && innerH > 0) {
    g.add(new Konva.Rect({
      x: inset + 0.5, y: inset + 0.5,
      width: Math.max(1, Math.round(innerW * frac)), height: innerH,
      fill: batteryShade(g),
    }));
  }

  if (g.getAttr('showPct')) {
    g.add(new Konva.Text({
      text: pctText, fontSize, fontFamily: 'monospace', fill: ink,
      x: w + gap, y: Math.round((bodyH - fontSize) / 2), width: textW, align: 'left',
    }));
  }
}

export function addBattery(attrs = {}) {
  const { w: cw, h: ch } = logicalDims();
  const g = new Konva.Group({
    x: attrs.x ?? Math.round(cw / 2 - 24), y: attrs.y ?? Math.round(ch / 2 - 12),
    draggable: true, name: 'element', id: nextId(),
  });
  const ink = attrs.ink ?? PALETTES[display.type][0];
  g.setAttr('etype', 'battery');
  g.setAttr('w', attrs.w ?? 48);
  // Every default resolves to the darkest ink, which exists in EVERY palette —
  // positional shortcuts don't (see the note on addIndicator). Both the seeded
  // condition and the fallback are visible the moment the widget is dropped.
  g.setAttr('ink', ink);
  g.setAttr('showPct', attrs.showPct ?? false);
  g.setAttr('conds', (attrs.conds ?? [{ op: 'lt', cmp: '20', color: ink }])
    .map((c) => ({ op: c.op, cmp: c.cmp, color: c.color })));
  g.setAttr('defaultShade', attrs.defaultShade ?? ink);
  g.setAttr('feedKey', attrs.feedKey ?? '');
  g.setAttr('feedName', attrs.feedName ?? '');
  g.setAttr('feedValue', attrs.feedValue ?? null);   // not 'value' — see FEED_VALUE_ATTR
  buildBattery(g);
  wireNode(g);
  layer.add(g);
  return g;
}

// ---------- image -----------------------------------------------------------

const IMG_MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/bmp', 'image/x-ms-bmp'];

export function addImage(imageObj, attrs = {}) {
  const { w: cw, h: ch } = logicalDims();
  const iw = imageObj.width, ih = imageObj.height;
  // Default: fit within the panel while keeping aspect ratio.
  let dw = attrs.w, dh = attrs.h;
  if (dw === undefined || dh === undefined) {
    const scale = Math.min(1, (cw * 0.8) / iw, (ch * 0.8) / ih);
    dw = Math.max(1, Math.round(iw * scale));
    dh = Math.max(1, Math.round(ih * scale));
  }
  const node = new Konva.Image({
    image: imageObj,
    x: attrs.x ?? Math.round((cw - dw) / 2),
    y: attrs.y ?? Math.round((ch - dh) / 2),
    width: dw, height: dh,
    draggable: true, name: 'element', id: nextId(),
  });
  node.setAttr('etype', 'image');
  node.setAttr('natW', iw);
  node.setAttr('natH', ih);
  if (attrs.src) node.setAttr('src', attrs.src); // data URL kept for save/load
  wireNode(node);
  layer.add(node);
  return node;
}

/** Load a File into an <img>, enforcing type + size, then place it. */
export function loadImageFile(file) {
  if (!file) return;
  const typeOk = IMG_TYPES.includes(file.type) || /\.(png|jpe?g|bmp)$/i.test(file.name);
  if (!typeOk) { toast('Only PNG, JPEG and BMP images are allowed'); return; }
  if (file.size > IMG_MAX_BYTES) {
    toast(`Image is ${(file.size / 1048576).toFixed(1)} MB — 25 MB limit`);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const node = addImage(img, { src: reader.result });
      select(node);
      toast(`Placed ${img.width}×${img.height} image`);
    };
    img.onerror = () => toast('Could not decode that image');
    img.src = reader.result;
  };
  reader.onerror = () => toast('Could not read that file');
  reader.readAsDataURL(file); // data URL so it round-trips through save/load
}

// ---------- shared element wiring -------------------------------------------

let activeAnchor = null;

export function wireNode(node) {
  // A live dither overlay would hide the drag entirely (it's a static bitmap
  // painted over the stage), so drop it for the gesture and re-run it after.
  node.on('dragstart', suspendDitherPreview);
  node.on('dragmove', () => {
    node.position({ x: snap(node.x()), y: snap(node.y()) }); // live snap while dragging
  });
  node.on('dragend', () => {
    node.position({ x: snap(node.x()), y: snap(node.y()) });
    refreshProps();
    scheduleDitherRefresh();
  });
  node.on('transformstart', () => { activeAnchor = tr.getActiveAnchor(); suspendDitherPreview(); });
  node.on('transformend', () => {
    // Bake scale into geometry so exports stay pixel-true.
    if (node.getAttr('etype') === 'divider') {
      node.width(Math.max(1, Math.round(node.width() * node.scaleX())));
      node.height(Math.max(1, Math.round(node.height() * node.scaleY())));
    } else if (isWidget(node)) {
      // A lamp is legitimately tiny, so the 40px floor that suits a chart or
      // gauge would stop it shrinking at all. Declared per-etype rather than
      // inline so adding a widget doesn't mean editing a ternary.
      const minW = MIN_WIDGET_W[node.getAttr('etype')] ?? 40;
      node.setAttr('w', Math.max(minW, Math.round(node.getAttr('w') * node.scaleX())));
      if (node.getAttr('etype') === 'linechart')
        node.setAttr('h', Math.max(30, Math.round(node.getAttr('h') * node.scaleY())));
      rebuildWidget(node);
    } else if (node.getAttr('etype') === 'image') {
      node.width(Math.max(1, Math.round(node.width() * node.scaleX())));
      node.height(Math.max(1, Math.round(node.height() * node.scaleY())));
    } else if (activeAnchor === 'middle-left' || activeAnchor === 'middle-right') {
      // Side drag: resize the text box, text re-wraps, type size unchanged.
      node.width(Math.max(8, Math.round(node.width() * node.scaleX())));
    } else {
      // Corner drag: scale the type itself (box width scales along if fixed).
      const boxed = node.attrs.width !== undefined;
      node.fontSize(Math.max(4, Math.round(node.fontSize() * node.scaleY())));
      if (boxed) node.width(Math.max(8, Math.round(node.width() * node.scaleX())));
    }
    node.scale({ x: 1, y: 1 });
    node.position({ x: snap(node.x()), y: snap(node.y()) });
    refreshProps();
    scheduleDitherRefresh();
  });
  node.on('click tap', (e) => { e.cancelBubble = true; select(node); });
  if (node.getAttr('etype') === 'label') {
    node.on('dblclick dbltap', () => editLabel(node));
  }
}

/**
 * Inline rename: overlay a textarea on top of the label, matched to its
 * on-screen size and typography. Enter commits, Esc cancels, blur commits.
 */
export function editLabel(node) {
  select(null);
  node.hide();
  const holder = document.getElementById('stage-holder');
  const ta = document.createElement('textarea');
  holder.appendChild(ta);
  const pos = node.absolutePosition(); // already in on-screen (zoomed) pixels
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
  Object.assign(ta.style, {
    position: 'absolute',
    left: pos.x + 'px',
    top: pos.y + 'px',
    width: (node.width() + 4) * zoom + 'px',
    height: (node.height() + 6) * zoom + 'px',
    minHeight: '0',
    fontSize: node.fontSize() * zoom + 'px',
    fontFamily: node.fontFamily(),
    lineHeight: String(node.lineHeight()),
    textAlign: node.align(),
    color: node.fill(),
    background: 'transparent',
    border: `1px dashed ${accent}`,
    margin: '0',
    padding: '0',
    overflow: 'hidden',
    resize: 'none',
    outline: 'none',
    whiteSpace: 'pre',
    zIndex: '10',
  });
  ta.value = node.text();
  ta.focus();
  ta.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit && ta.value.trim() !== '') node.text(ta.value);
    ta.remove();
    node.show();
    select(node);
  };
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') finish(false);
  });
  ta.addEventListener('blur', () => finish(true));
}

// ---------- palette remapping ------------------------------------------------

/**
 * Snap every element's colors onto the current panel palette. Called whenever
 * the color mode changes: leaving off-palette colors in place would let the
 * dither silently shift them at render time.
 */
export function remapColorsToPalette() {
  // Parameterised by the candidate set so the battery can snap to NEUTRALS only:
  // snapping its grey ramp to the full quadcolor palette could pull a mid-grey
  // onto red, which is exactly what a grey-only widget must never do.
  const nearestIn = (palHex) => {
    const pal = palHex.map(hexToRGB);
    return (hex) => {
      const c = hexToRGB(hex);
      let best = 0, bestD = Infinity;
      pal.forEach((p, i) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      });
      return palHex[best];
    };
  };
  const nearest = nearestIn(PALETTES[display.type]);
  const nearestNeutral = nearestIn(neutralShades());
  layer.find('.element').forEach((n) => {
    if (n.getAttr('etype') === 'image') return; // dithered at render time, no single ink
    // An indicator carries THREE colors, so the single-color elementColor /
    // setElementColor pair can't express it — remap each one explicitly.
    if (n.getAttr('etype') === 'indicator') {
      n.setAttr('onColor', nearest(n.getAttr('onColor')));
      n.setAttr('offColor', nearest(n.getAttr('offColor')));
      n.setAttr('ink', nearest(n.getAttr('ink')));
      rebuildWidget(n);
      return;
    }
    // A battery carries its outline plus one shade per condition plus the
    // default, so it needs the same explicit treatment — and against the neutral
    // subset, since its whole point is a grey ramp.
    if (n.getAttr('etype') === 'battery') {
      n.setAttr('ink', nearestNeutral(n.getAttr('ink')));
      n.setAttr('defaultShade', nearestNeutral(n.getAttr('defaultShade')));
      n.setAttr('conds', (n.getAttr('conds') || [])
        .map((c) => ({ ...c, color: nearestNeutral(c.color) })));
      rebuildWidget(n);
      return;
    }
    setElementColor(n, nearest(elementColor(n)));
  });
}

// ---------- templates -------------------------------------------------------
//
// Pre-built layouts, authored against a 296×128 reference panel (a MagTag) and
// scaled from there. On a MagTag the numbers below land verbatim; on a 250×122
// FeatherWing or an 800×480 the layout scales to match.
//
// Positions and box widths scale on each axis independently, but type and
// square widgets scale on the SMALLER of the two — a font scaled on the wide
// axis alone overflows the moment a panel is proportionally shorter than the
// reference.

const REF_PANEL = { w: 296, h: 128 };

function placer() {
  const { w, h } = logicalDims();
  const sx = w / REF_PANEL.w;
  const sy = h / REF_PANEL.h;
  const st = Math.min(sx, sy);
  return {
    x: (v) => Math.round(v * sx),
    y: (v) => Math.round(v * sy),
    w: (v) => Math.max(1, Math.round(v * sx)),
    h: (v) => Math.max(1, Math.round(v * sy)),
    type: (v) => Math.max(4, Math.round(v * st)),
    size: (v) => Math.max(1, Math.round(v * st)),
  };
}

export const TEMPLATES = {
  weather: {
    label: 'Weather Station',
    build() {
      const p = placer();
      const ink = PALETTES[display.type][0];
      addLabel({
        x: p.x(8), y: p.y(8), text: 'WEATHER STATION',
        fontSize: p.type(28), fontFamily: 'monospace', align: 'left', fill: ink,
      });
      addDivider({ x: p.x(8), y: p.y(40), width: p.w(208), height: p.size(2), fill: ink });
      addLabel({
        x: p.x(10), y: p.y(50), text: '72°F',
        fontSize: p.type(33), fontFamily: 'monospace', align: 'left', fill: ink,
      });
      addLineChart({
        x: p.x(120), y: p.y(60), w: p.w(169), h: p.h(58), ink, title: 'Temp',
        data: [64, 63, 60, 64, 67, 71, 72, 75, 80, 80, 82, 78],
      });
      addLabel({
        x: p.x(10), y: p.y(90), text: '40%RH',
        fontSize: p.type(33), fontFamily: 'monospace', align: 'left', fill: ink,
      });
    },
  },
  aqi: {
    label: 'AQI Monitor',
    build() {
      const p = placer();
      const ink = PALETTES[display.type][0];
      addLabel({
        x: p.x(80), y: p.y(10), text: 'Air Quality',
        fontSize: p.type(23), fontFamily: 'monospace', align: 'left', fill: ink,
      });
      addDivider({ x: p.x(10), y: p.y(40), width: p.w(270), height: p.size(1), fill: ink });
      // The battery's seeded condition and default shade are addBattery's own
      // defaults (ink for both), so they are left implicit rather than restated.
      addBattery({ x: p.x(250), y: p.y(0), w: p.size(20), ink, showPct: true });
      addLineChart({
        x: p.x(10), y: p.y(90), w: p.w(141), h: p.h(31), ink, title: 'PM2.5',
        data: [73, 76, 72, 74, 72, 73, 69, 69, 69, 68, 66, 64],
      });
      addLabel({
        x: p.x(110), y: p.y(50), text: 'Good',
        fontSize: p.type(30), fontFamily: 'monospace', align: 'left', fill: ink,
      });
    },
  },
  quote: {
    label: 'Big quote',
    build() {
      const p = placer();
      const ink = PALETTES[display.type][0];
      // Konva word-wraps to the box width, so the quote is one label rather than
      // hand-broken lines — it re-flows correctly when the type scales down onto
      // a narrower panel instead of running off the edge.
      addLabel({
        x: p.x(10), y: p.y(14),
        text: '“A hacker to me is someone creative who does wonderful things”',
        fontSize: p.type(18), fontFamily: 'monospace',
        width: p.w(276), align: 'left', fill: ink,
      });
      addDivider({ x: p.x(10), y: p.y(84), width: p.w(70), height: p.size(2), fill: ink });
      addLabel({
        x: p.x(10), y: p.y(94), text: 'Tim Berners-Lee',
        fontSize: p.type(14), fontFamily: 'monospace', align: 'left', fill: ink,
      });
    },
  },
};

/** Replace the canvas with a template layout. Confirms first if work exists. */
export function applyTemplate(key) {
  const template = TEMPLATES[key];
  if (!template) return;
  const existing = layer.find('.element');
  if (existing.length
    && !confirm(`Replace the current layout with "${template.label}"?\n\nThe ${existing.length} element(s) on the canvas will be removed.`)) return;
  existing.forEach((n) => n.destroy());
  select(null);
  suspendDitherPreview();
  template.build();
  layer.draw();
  scheduleDitherRefresh();
  toast(`Loaded the ${template.label} template`);
}
