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
import { refreshInterval, sleepModeFor } from '../config.js';
import { getState, subscribe } from '../state.js';
import { $, $$, toast, show, fmtInterval } from '../util.js';

/**
 * Options offered by "Wake and redraw", in seconds. Must match the option values
 * in index.html — anything not in here renders as "Custom — Ns".
 *
 * Roughly geometric rather than evenly spaced: the useful range spans 15 seconds
 * to an hour, and a linear ramp over that would be either 240 entries or a list
 * whose bottom end is unreachable.
 */
const INTERVAL_OPTIONS = [15, 30, 60, 300, 900, 1800, 3600];

/**
 * The push means two different things on the two paths, so it says two different
 * things. On the broker path the write is confirmed before the device is told to
 * sleep; on the CircuitPython path both facts go onto feeds the board reads when
 * it next wakes, and nothing here ever hears back.
 */
const PUSH_CUE = {
  wippersnapper: "It's showtime — the dashboard is written, then the display sleeps.",
  circuitpython: "It's showtime — the dashboard and the sleep window go to Adafruit IO, and the board collects them on its next wake.",
};

/**
 * The same block while the display is ASLEEP — reached by editing the dashboard
 * from Act III, or by any edit made mid-cycle.
 *
 * A sleeping panel has nothing listening, so "Push to display" would offer
 * something the hardware cannot do right now. The button becomes the queue, and
 * the cue says which wake the edit lands on.
 */
const SLEEP_CUE = {
  wippersnapper: 'The display is sleeping — this edit is held and written the moment the board checks in.',
  circuitpython: 'The display is sleeping — this edit goes to Adafruit IO, and the board collects it on its next wake.',
};

const PUSH_LABEL = 'Push to display';
const QUEUE_LABEL = 'Queue for the next take';

/**
 * The button carries four blueprint corner <i>s, so its label lives on a text
 * node — assigning textContent would delete them.
 */
function setPushLabel(text) {
  const btn = $('sendBmpSleep');
  if (!btn) return;
  const node = [...btn.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
  if (node) node.textContent = text;
  else btn.insertBefore(document.createTextNode(text), btn.firstChild);
}

/**
 * The push block reads the device: awake it pushes, asleep it queues. Cue and
 * label are set together so the sentence above the button always describes the
 * button — exported because device.js restores the label after a push.
 */
export function syncPushBlock() {
  const st = getState();
  const path = st.firmwarePath === 'circuitpython' ? 'circuitpython' : 'wippersnapper';
  const asleep = st.deviceState === 'asleep';
  const cue = $('pushCue');
  if (cue) cue.textContent = (asleep ? SLEEP_CUE : PUSH_CUE)[path];
  setPushLabel(asleep ? QUEUE_LABEL : PUSH_LABEL);
}

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
    // device is actually doing — and name the sleep mode with it, the way the
    // fixed options in index.html do. Without this a custom interval would be the
    // one setting that hides which side of the five-minute line it falls on.
    const opt = sel.querySelector('option[value="custom"]');
    const mode = sleepModeFor(secs) === 'S_DEEP' ? 'deep' : 'light';
    if (opt) opt.textContent = `Custom — ${fmtInterval(secs)} · ${mode} sleep`;
  }
}

/**
 * The alarm choice only exists on the CircuitPython path. The broker's
 * /sleep/config encodes a TimerConfig and defers Ext0Config (server.js), so
 * offering a pin there would be a control nothing downstream honours.
 */
function syncPathCopy() {
  show($('wakeAlarmField'), getState().firmwarePath === 'circuitpython');
  syncPushBlock();
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
  syncPathCopy();

  // The board can fall asleep while this screen is still open — a cycle started
  // here never leaves it — so the push block follows the device rather than only
  // being read on entry.
  subscribe((_st, patch) => {
    if ('deviceState' in patch) syncPushBlock();
  });

  onEnter('a7', () => {
    // The canvas ground has no size until this screen is visible, so the first
    // real fit has to happen here rather than at boot.
    fitZoom();
    refreshProps();
    syncIntervalFromField();
    // Re-read the fork on every entry rather than once at boot: the path badge is
    // a route back to A3, so this screen can be re-entered on the other path.
    syncPathCopy();
  });
}
