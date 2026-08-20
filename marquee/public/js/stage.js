/**
 * The Konva stage and everything that draws on or around it: layers, the
 * transformer, the snap grid, zoom, the 1:1 capture the render pipeline feeds
 * on, and the dithered preview overlay.
 *
 * The stage mounts into #stage-holder once, at module load, and is never torn
 * down — screens are shown and hidden, not created and destroyed. That is why
 * fitZoom() tolerates a zero-sized container: at boot A7 is hidden, so the first
 * meaningful fit happens when the router first reveals it.
 */

import { Konva } from './konva.js';
import { display, logicalDims, PAPER, MODE_LABELS } from './palette.js';
import { $, toast } from './util.js';
import { backendRender, markBackendOffline } from './render.js';

/** Resolve a design token to a concrete value — the canvas can't use var(). */
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const ACCENT = cssVar('--color-accent', '#5980a6');
const ACCENT_DEEP = cssVar('--color-accent-700', '#416180');

export let zoom = 1;

export const stage = new Konva.Stage({ container: 'stage-holder', width: 296, height: 128 });

const bgLayer = new Konva.Layer({ listening: false });
export const bgRect = new Konva.Rect({ x: 0, y: 0, fill: PAPER });
bgLayer.add(bgRect);

const gridLayer = new Konva.Layer({ listening: false, visible: false });
export const layer = new Konva.Layer();

export const tr = new Konva.Transformer({
  rotateEnabled: false,
  keepRatio: true,
  borderStroke: ACCENT,
  anchorStroke: ACCENT,
  anchorFill: '#ffffff',
  anchorSize: 7,
  ignoreStroke: true,
  anchorStyleFunc: (anchor) => {
    // The bottom-right grab handle is bigger and filled, so the primary resize
    // corner is obvious against a busy panel.
    if (anchor.hasName('bottom-right')) {
      anchor.fill(ACCENT_DEEP);
      anchor.stroke(ACCENT_DEEP);
      anchor.width(14);
      anchor.height(14);
      anchor.offsetX(7);
      anchor.offsetY(7);
    }
  },
});
layer.add(tr);
stage.add(bgLayer);
stage.add(gridLayer);
stage.add(layer);

// ---------- grid ------------------------------------------------------------

export const editorOpts = { grid: true, gridSize: 8, snap: true };

/** Snap a coordinate to the nearest grid line when snapping is on. */
export function snap(v) {
  if (!editorOpts.snap) return Math.round(v);
  const s = editorOpts.gridSize;
  return Math.round(v / s) * s;
}

export function drawGrid() {
  gridLayer.destroyChildren();
  gridLayer.visible(editorOpts.grid);
  if (!editorOpts.grid) return;
  const { w, h } = logicalDims();
  const s = editorOpts.gridSize;
  const sw = 1 / zoom; // always one screen pixel regardless of zoom
  for (let x = s; x < w; x += s)
    gridLayer.add(new Konva.Line({ points: [x, 0, x, h], stroke: '#2F2429', strokeWidth: sw, opacity: 0.14 }));
  for (let y = s; y < h; y += s)
    gridLayer.add(new Konva.Line({ points: [0, y, w, y], stroke: '#2F2429', strokeWidth: sw, opacity: 0.14 }));
}

// ---------- zoom ------------------------------------------------------------

export function applyZoom(z) {
  zoom = Math.min(8, Math.max(0.25, z));
  const { w, h } = logicalDims();
  stage.width(w * zoom);
  stage.height(h * zoom);
  stage.scale({ x: zoom, y: zoom });
  bgRect.width(w);
  bgRect.height(h);
  drawGrid();
  const label = $('zoomLabel');
  if (label) label.textContent = Math.round(zoom * 100) + '%';
  updateDims();
  // Keep an existing dither overlay aligned to the stage. Just rescale the
  // already-rendered bitmap; don't re-run the pipeline for a view change.
  if (ditherPreviewOn) {
    previewEl.style.width = (w * zoom) + 'px';
    previewEl.style.height = (h * zoom) + 'px';
  }
}

export function fitZoom() {
  const ws = document.querySelector('.canvas-ground');
  const { w, h } = logicalDims();
  // A7 is hidden at boot, so the ground measures zero. Leave the current zoom
  // alone and let the router re-fit when it first shows the editor.
  if (!ws || ws.clientWidth === 0 || ws.clientHeight === 0) return;
  const z = Math.min((ws.clientWidth - 140) / w, (ws.clientHeight - 220) / h, 8);
  applyZoom(Math.max(0.25, Math.floor(z * 20) / 20));
}

/**
 * The static half of the meta strip: geometry, orientation, colour space. Dither
 * used to be tacked on the end, but it is the one value in this line that is a
 * setting rather than a fact — it now has its own control beside the readout
 * (#ditherChip), and stating it twice on one line would just be noise.
 */
export function updateDims() {
  const { w, h } = logicalDims();
  const el = $('dims');
  if (!el) return;
  const rot = display.rotation ? ` · ${display.rotation}°` : '';
  el.textContent = `${w} × ${h}${rot} · ${MODE_LABELS[display.type] || display.type}`;
}

// ---------- live dither preview overlay -------------------------------------
//
// The overlay renders through the BACKEND (real ImageMagick) via the
// authoritative 1:1 capture, so what you see is what ships. It is a flat bitmap
// sitting on top of the stage, so it can't follow live edits: while you drag or
// transform we hide it (revealing the real objects underneath) and re-render
// once the gesture ends.

const previewEl = document.createElement('canvas');
previewEl.id = 'ditherPreview';
Object.assign(previewEl.style, {
  position: 'absolute', left: '0', top: '0',
  pointerEvents: 'none', display: 'none',
  imageRendering: 'pixelated', zIndex: '5',
});
$('stage-holder').appendChild(previewEl);

export let ditherPreviewOn = false;
let ditherRenderSeq = 0;       // newest render wins; stale responses are dropped
let ditherRefreshTimer = null;

export async function showDitherPreview() {
  const seq = ++ditherRenderSeq;
  let im;
  try {
    const r = await backendRender();
    im = new Image();
    await new Promise((resolve, reject) => {
      im.onload = resolve;
      im.onerror = reject;
      im.src = 'data:image/png;base64,' + r.png;
    });
  } catch {
    markBackendOffline();
    toast('Backend unreachable — cannot render the dithered preview');
    hideDitherPreview();  // don't leave the button claiming a preview is up
    return;
  }
  // A newer edit or render started while we were waiting — that one owns the
  // overlay now, so don't paint this stale bitmap over it.
  if (seq !== ditherRenderSeq) return;
  const { w, h } = logicalDims();
  previewEl.width = w;
  previewEl.height = h;
  const ctx = previewEl.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(im, 0, 0, w, h);
  previewEl.style.width = (w * zoom) + 'px';
  previewEl.style.height = (h * zoom) + 'px';
  previewEl.style.display = 'block';
  ditherPreviewOn = true;
  syncDitherPreviewBtn();
}

export function hideDitherPreview() {
  clearTimeout(ditherRefreshTimer);
  ditherRenderSeq++;             // cancel any render still in flight
  previewEl.style.display = 'none';
  ditherPreviewOn = false;
  syncDitherPreviewBtn();
}

/**
 * Called when a gesture starts: uncover the live stage so the user can see what
 * they're moving. The preview stays "on" — it just isn't showing.
 */
export function suspendDitherPreview() {
  if (!ditherPreviewOn) return;
  clearTimeout(ditherRefreshTimer);
  ditherRenderSeq++;             // drop any in-flight render of the old layout
  previewEl.style.display = 'none';
}

/**
 * Re-dither the current layout. Debounced so a flurry of nudges, drags or slider
 * ticks collapses into one backend round-trip; pass a longer delay for
 * continuous inputs (a range slider fires on every pixel of travel).
 */
export function scheduleDitherRefresh(delay = 200) {
  if (!ditherPreviewOn) return;
  clearTimeout(ditherRefreshTimer);
  ditherRefreshTimer = setTimeout(showDitherPreview, delay);
}

export function syncDitherPreviewBtn() {
  const btn = $('btnDitherPreview');
  if (btn) btn.textContent = ditherPreviewOn ? 'Hide the dither' : 'See it dithered';
}

// ---------- capture ---------------------------------------------------------

/**
 * Composite the canvas at 1:1 with the grid hidden and nothing selected.
 * Returns an undithered canvas — the exact pixels to feed the dither step.
 *
 * Takes a callback for restoring the selection rather than importing select()
 * directly: selection.js already depends on this module, and this is the only
 * back-edge, so it is passed in by the caller instead of closed over.
 */
export function captureClean({ onDeselect, onReselect } = {}) {
  const prevZoom = zoom;
  onDeselect?.();
  applyZoom(1);
  gridLayer.visible(false);
  const canvas = stage.toCanvas({ pixelRatio: 1 });
  applyZoom(prevZoom);       // restores zoom and redraws the grid per its setting
  onReselect?.();
  return canvas;
}
