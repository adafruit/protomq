/**
 * A7 — Act II: build the scene.
 *
 * The editor chrome: the toolbox, the preview controls, the zoom bar and the
 * refresh interval. The canvas itself is stage.js, the inspector is
 * selection.js, and the push action is device.js — this module is only the
 * wiring between them and the screen.
 */

import { editorOpts, drawGrid, applyZoom, fitZoom, zoom, showDitherPreview, hideDitherPreview, ditherPreviewOn, syncDitherPreviewBtn } from '../stage.js';
import { select, refreshProps, duplicateSelected } from '../selection.js';
import {
  addLabel, addDivider, addLineChart, addGauge, addIndicator, addBattery,
  loadImageFile, applyTemplate,
} from '../elements.js';
import { refreshInterval } from '../config.js';
import { $, $$, toast } from '../util.js';

/** Options offered by "Wake and redraw", in seconds. */
const INTERVAL_OPTIONS = [60, 300, 900, 1800, 3600];

/**
 * The inspector's interval select and the numeric field in Settings are two
 * views of one value (the sleep timer). The select drives the field so every
 * existing consumer — the sleep config POST, the wake response, the bundle —
 * keeps reading it from the same place.
 */
function syncIntervalFromField() {
  const secs = refreshInterval();
  const sel = $('wakeInterval');
  if (!sel) return;
  sel.value = INTERVAL_OPTIONS.includes(secs) ? String(secs) : 'custom';
  if (sel.value === 'custom') {
    // Name the value rather than leaving a bare "Custom…" that hides what the
    // device is actually doing.
    const opt = sel.querySelector('option[value="custom"]');
    if (opt) opt.textContent = `Custom — ${secs}s`;
  }
}

export function initA7({ onEnter }) {
  // ---- toolbox ----
  $('addLabel').addEventListener('click', () => select(addLabel()));
  $('addDivider').addEventListener('click', () => select(addDivider()));
  $('addChart').addEventListener('click', () => select(addLineChart()));
  $('addGaugeBtn').addEventListener('click', () => select(addGauge()));
  $('addIndicatorBtn').addEventListener('click', () => select(addIndicator()));
  $('addBatteryBtn').addEventListener('click', () => select(addBattery()));
  $('duplicateBtn').addEventListener('click', duplicateSelected);
  $('addImageBtn').addEventListener('click', () => $('imgInput').click());
  $('imgInput').addEventListener('change', (e) => {
    loadImageFile(e.target.files[0]);
    e.target.value = '';
  });

  $$('[data-template]').forEach((btn) =>
    btn.addEventListener('click', () => applyTemplate(btn.dataset.template)));

  // ---- preview controls ----
  $('btnDitherPreview').addEventListener('click', () => {
    // A toggle: the first click renders the dithered overlay through the
    // authoritative pipeline, the second clears it. It persists across edits.
    if (ditherPreviewOn) hideDitherPreview();
    else showDitherPreview();
  });
  $('gridToggle').addEventListener('change', (e) => { editorOpts.grid = e.target.checked; drawGrid(); });
  $('snapToggle').addEventListener('change', (e) => { editorOpts.snap = e.target.checked; });
  $('gridSize').addEventListener('change', (e) => { editorOpts.gridSize = +e.target.value; drawGrid(); });

  // ---- zoom ----
  $('zoomIn').addEventListener('click', () => applyZoom(zoom * 1.25));
  $('zoomOut').addEventListener('click', () => applyZoom(zoom / 1.25));
  $('zoomFit').addEventListener('click', fitZoom);
  window.addEventListener('resize', () => {
    if (document.querySelector('#a7[data-active="true"]')) fitZoom();
  });

  // ---- refresh interval ----
  $('wakeInterval').addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      toast('Set a custom interval under Settings → Sleep behaviour');
      syncIntervalFromField();
      return;
    }
    const field = $('sleepDuration');
    field.value = e.target.value;
    // Dispatch so config.js persists it and any live cycle re-registers.
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  $('sleepDuration').addEventListener('input', syncIntervalFromField);

  syncIntervalFromField();
  syncDitherPreviewBtn();

  onEnter('a7', () => {
    // The canvas ground has no size until this screen is visible, so the first
    // real fit has to happen here rather than at boot.
    fitZoom();
    refreshProps();
    syncIntervalFromField();
  });
}
