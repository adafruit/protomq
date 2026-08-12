/**
 * The canvas document: serialize / deserialize, autosave, and the signature that
 * answers "has the design changed since the device last drew it?".
 *
 * The layout JSON is the internal source of truth. On every edit we serialize
 * the canvas, show it live under the panel, and persist it to canvas.json on the
 * backend. Konva fires 'draw' on the content layer after every add, remove,
 * move, transform and attr edit, so one debounced listener captures them all; we
 * de-dupe on the serialized string so pure view changes (zoom, selection,
 * transformer handles) never trigger a write.
 */

import { BACKEND } from './api.js';
import { display } from './palette.js';
import { layer, fitZoom } from './stage.js';
import { select } from './selection.js';
import {
  addLabel, addDivider, addLineChart, addGauge, addIndicator, addBattery, addImage,
} from './elements.js';
import { buildDisplayBody, applyDisplayToForm, setResolution } from './config.js';
import { scheduleWakeResponseSync } from './device.js';
import { $, toast } from './util.js';

export function serialize() {
  return {
    version: 1,
    display: { ...display },
    elements: layer.find('.element').map((n) => {
      const etype = n.getAttr('etype');
      const base = { etype, x: n.x(), y: n.y() };
      if (etype === 'label') {
        Object.assign(base, {
          fill: n.fill(), text: n.text(), fontSize: n.fontSize(),
          fontFamily: n.fontFamily(), align: n.align(),
        });
        if (n.attrs.width !== undefined) base.width = Math.round(n.width());
        // A label dropped by the feed picker remembers where its text came from.
        if (n.getAttr('feedKey')) {
          base.feedKey = n.getAttr('feedKey');
          base.feedName = n.getAttr('feedName') || '';
        }
      } else if (etype === 'divider') {
        Object.assign(base, { fill: n.fill(), width: n.width(), height: n.height() });
      } else if (etype === 'image') {
        Object.assign(base, {
          src: n.getAttr('src'), w: Math.round(n.width()), h: Math.round(n.height()),
          natW: n.getAttr('natW'), natH: n.getAttr('natH'),
        });
      } else if (etype === 'indicator') {
        // Explicit branch: the generic widget shape below is {ink,title,w}+value,
        // which would drop the feed binding, the condition and the on/off colors.
        // The sampled `value` is included deliberately — it is what makes a state
        // change register in canvasSignature() and redraw the panel on the next wake.
        Object.assign(base, {
          w: n.getAttr('w'), ink: n.getAttr('ink'),
          onColor: n.getAttr('onColor'), offColor: n.getAttr('offColor'),
          op: n.getAttr('op'), cmp: n.getAttr('cmp'),
          feedKey: n.getAttr('feedKey') || '', feedName: n.getAttr('feedName') || '',
          value: n.getAttr('value') ?? null,
        });
      } else if (etype === 'battery') {
        // Same reasoning as the indicator: the generic widget shape would drop the
        // feed binding, every condition and the default shade. `conds` is copied
        // rather than passed by reference so the saved doc can't alias live attrs.
        Object.assign(base, {
          w: n.getAttr('w'), ink: n.getAttr('ink'),
          showPct: !!n.getAttr('showPct'),
          conds: (n.getAttr('conds') || []).map((c) => ({ op: c.op, cmp: c.cmp, color: c.color })),
          defaultShade: n.getAttr('defaultShade'),
          feedKey: n.getAttr('feedKey') || '', feedName: n.getAttr('feedName') || '',
          feedValue: n.getAttr('feedValue') ?? null,
        });
      } else {
        Object.assign(base, { ink: n.getAttr('ink'), title: n.getAttr('title'), w: n.getAttr('w') });
        if (etype === 'linechart') Object.assign(base, { h: n.getAttr('h'), data: n.getAttr('data') });
        else base.value = n.getAttr('value');
      }
      return base;
    }),
  };
}

/**
 * Load a saved document onto the canvas.
 *
 * `keepDisplay` decides who owns the panel descriptor. On an explicit file load
 * the document wins — it was authored at that size and mode, and dropping its
 * elements onto a different panel would misplace all of them. On the boot
 * restore it must NOT win: the panel the user picked in Act I lives in
 * localStorage, and letting a stale display block from canvas.json overwrite it
 * would silently revert a panel change made after the last canvas edit.
 */
export function deserialize(doc, { keepDisplay = false } = {}) {
  layer.find('.element').forEach((n) => n.destroy());
  select(null);
  if (!keepDisplay) {
    Object.assign(display, doc.display || {});
    display.dither = display.dither || 'FloydSteinberg';
    display.orderedMap = display.orderedMap || 8;
    applyDisplayToForm();
    setResolution(display.width, display.height);
  }

  const makers = {
    label: addLabel, divider: addDivider, linechart: addLineChart,
    gauge: addGauge, indicator: addIndicator, battery: addBattery,
  };
  (doc.elements || []).forEach((el) => {
    if (el.etype === 'image') {
      if (!el.src) return;
      const img = new Image();
      img.onload = () => addImage(img, el);
      img.src = el.src;
    } else {
      const node = (makers[el.etype] || addLabel)(el);
      // Labels carry their feed binding as plain attrs rather than constructor args.
      if (el.etype === 'label' && el.feedKey) {
        node.setAttr('feedKey', el.feedKey);
        node.setAttr('feedName', el.feedName || '');
      }
    }
  });
  fitZoom();
}

// ---------- autosave --------------------------------------------------------

let lastCanvasJson = null;
let canvasSaveTimer = null;

function setSaveStatus(state, text) {
  const el = $('canvasSaveStatus');
  if (!el) return;
  el.dataset.state = state;
  el.textContent = text;
}

async function persistCanvas(doc) {
  try {
    const res = await fetch(BACKEND + '/canvas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    setSaveStatus('saved', 'saved');
  } catch {
    setSaveStatus('error', 'unsaved (offline)');
  }
}

/** Listeners fired whenever the document content actually changes. */
const changeListeners = new Set();
export function onDocChange(fn) { changeListeners.add(fn); }

export function saveCanvasNow() {
  const doc = serialize();
  const text = JSON.stringify(doc, null, 2);
  const view = $('canvasJson');
  if (view) view.textContent = text;          // keep the on-screen view current
  if (text === lastCanvasJson) return;        // no content change -> no write
  lastCanvasJson = text;
  setSaveStatus('saving', 'saving…');
  persistCanvas(doc);
  // A real content change during a sleep window has to reach the broker's wake
  // response before the device wakes (see syncWakeResponse).
  scheduleWakeResponseSync();
  changeListeners.forEach((fn) => fn(doc));
}

export function scheduleCanvasSave() {
  clearTimeout(canvasSaveTimer);
  canvasSaveTimer = setTimeout(saveCanvasNow, 400);
}

export function cancelCanvasSave() {
  clearTimeout(canvasSaveTimer);
  canvasSaveTimer = null;
}

/** Drop the de-dupe baseline, so the next save writes unconditionally. */
export function invalidateCanvasBaseline() { lastCanvasJson = null; }

/**
 * The current pretty-printed layout — falls back to serializing on demand in
 * case a save hasn't run yet (e.g. immediately after load).
 */
export function currentCanvasJson() {
  return lastCanvasJson || JSON.stringify(serialize(), null, 2);
}

// ---------- device baseline -------------------------------------------------
//
// A deep-sleep wake cold-boots the board, so re-adding its display makes the
// firmware repaint a splash before our BMP lands — an idle panel would flicker
// once per cycle for nothing. E-ink is bistable, so when the design is unchanged
// we send NEITHER the display add nor the write, and the panel keeps the image
// it already holds.
//
// The signature covers the canvas document AND the display descriptor: the SPI
// pins and identity live in localStorage, not in canvas.json, so without them a
// re-pinned panel would never get re-provisioned.

/**
 * The signature as last CONFIRMED written to the device (display.WriteComplete
 * acked). null = we don't know what the panel is showing -> treat as changed.
 */
let deviceCanvasSig = null;

export function canvasSignature() {
  return JSON.stringify({ doc: serialize(), display: buildDisplayBody() });
}

export function canvasChanged() { return canvasSignature() !== deviceCanvasSig; }
export function setDeviceCanvasSig(sig) { deviceCanvasSig = sig; }
export function getDeviceCanvasSig() { return deviceCanvasSig; }

// ---------- boot ------------------------------------------------------------

export function initDoc() {
  layer.on('draw', scheduleCanvasSave);

  $('canvasCopyBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const text = currentCanvasJson();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API blocked (insecure context / sandbox) — fall back.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { toast('Copy failed — select the JSON manually'); }
      ta.remove();
    }
    const prev = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = prev; }, 1200);
  });

  $('canvasExportBtn')?.addEventListener('click', () => {
    const blob = new Blob([currentCanvasJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'canvas.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  });
}
