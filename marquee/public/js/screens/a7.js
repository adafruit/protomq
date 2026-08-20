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
 * A minute at a time through the light-sleep range, then coarsening once the
 * intervals are long enough that a minute stops being the difference. The
 * sub-minute steps are gone: they were the only options that could not survive a
 * take, since a panel refresh alone runs to two minutes on some drivers, so a
 * 15-second cycle described a board that would still be redrawing when its own
 * alarm came due. Anyone who genuinely wants one can still set it under Settings
 * and it lands on "Custom".
 */
const INTERVAL_OPTIONS = [60, 120, 180, 240, 300, 600, 900, 1800, 2700, 3600];

/**
 * The push means two different things on the two paths, so it says two different
 * things. On the broker path the write is confirmed before the device is told to
 * sleep; on the CircuitPython path both facts go onto feeds the board reads when
 * it next wakes, and nothing here ever hears back.
 *
 * No "It's showtime —" any more. In the old push block that opening earned its
 * place: the caption sat above a button at the foot of a settings rail and had to
 * announce what the block was. In the action bar the button is a foot away on the
 * same line and says PUSH TO DISPLAY on its face, so the flourish was the sentence
 * repeating the row it sits in.
 */
const PUSH_CUE = {
  wippersnapper: 'The dashboard is written, then the display sleeps.',
  circuitpython: 'The dashboard and the sleep window go to Adafruit IO, and the board collects them on its next wake.',
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
  syncSleepChip();
}

/**
 * The cadence as a phrase rather than a duration — "every minute", not "1 minute".
 *
 * fmtInterval() is the right thing everywhere it is already used, where the number
 * IS the subject ("sleeping a total of 5 minutes"). Here the subject is the rhythm,
 * and "every 1 minute" and "every 1 hour" are the two places a bare count reads as
 * a translation. Both are exactly the singular cases, which is why they are the
 * only two named.
 */
function intervalPhrase(secs) {
  if (secs === 60) return 'every minute';
  if (secs === 3600) return 'every hour';
  return `every ${fmtInterval(secs)}`;
}

/**
 * The chip's resting text: what the board will do, in one line, without opening
 * anything. Read from the two selects rather than from state, because they are the
 * controls the popover edits and this has to be true the instant one changes.
 *
 * A PIN-ONLY alarm gets no cadence, and this is the case worth being careful about.
 * `sleep_time` is ignored entirely for a bare PinAlarm (docs/marquee-sleep.md), so
 * "Button press · every 5 minutes" would be the chip stating an interval the board
 * is provably not keeping. The alarm is the whole answer there.
 */
function syncSleepChip() {
  const el = $('sleepChipValue');
  if (!el) return;
  const alarm = $('wakeAlarm');
  const source = alarm?.selectedOptions[0]?.textContent || 'Timer';
  el.textContent = alarm?.value === 'pin'
    ? source
    : `${source} · ${intervalPhrase(refreshInterval())}`;
}

/**
 * The alarm choice only exists on the CircuitPython path. The broker's
 * /sleep/config encodes a TimerConfig and defers Ext0Config (server.js), so
 * offering a pin there would be a control nothing downstream honours.
 */
function syncPathCopy() {
  show($('wakeAlarmField'), getState().firmwarePath === 'circuitpython');
  syncPushBlock();
  // The hidden select still reports 'timer', which is what the broker path does, so
  // the chip keeps naming the source on both paths rather than going bare on one.
  syncSleepChip();
}

// ---------- the sleep popover -----------------------------------------------

/**
 * A popover, not a modal: the canvas behind it stays live and the page does not
 * lock. So it closes on the two gestures that mean "I am done here" — a click
 * outside it and Escape — and hands focus back to the chip on the way out, or a
 * keyboard user is dropped at the top of the document every time they set an
 * interval.
 */
function sleepPopOpen() {
  return !$('sleepPop')?.classList.contains('hidden');
}

function setSleepPop(open, { restoreFocus = true } = {}) {
  const pop = $('sleepPop');
  const chip = $('sleepChip');
  if (!pop || !chip) return;
  const was = sleepPopOpen();
  show(pop, open);
  chip.setAttribute('aria-expanded', String(open));
  // The first VISIBLE select: on the broker path "Wake on" is hidden, and focusing a
  // display:none element is a silent no-op that would leave the panel opened onto
  // nothing for a keyboard user.
  if (open) [...pop.querySelectorAll('select')].find((s) => s.offsetParent)?.focus();
  // Only when the popover was actually open: calling this on a stray outside click
  // would steal focus from whatever the user just clicked on the canvas.
  else if (was && restoreFocus) chip.focus();
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
  // main.js owns persisting this one; the chip only needs to hear that it moved.
  $('wakeAlarm').addEventListener('change', syncSleepChip);

  // ---- the sleep popover ----
  $('sleepChip').addEventListener('click', () => setSleepPop(!sleepPopOpen()));

  // Pointerdown rather than click, so the popover is already gone by the time a
  // press lands on the canvas — closing on click would let the same gesture both
  // dismiss the panel and start a drag under it.
  document.addEventListener('pointerdown', (e) => {
    if (!sleepPopOpen()) return;
    if (e.target.closest('#sleepPop, #sleepChip')) return;
    setSleepPop(false, { restoreFocus: false });
  });

  // Nothing to guard against here: the shared modal handler in util.js only fires
  // when a modal is actually open, and the editor's own key handler drops out on
  // any focused SELECT — which is where focus is whenever this panel is up.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sleepPopOpen()) setSleepPop(false);
  });

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
    // Leaving the screen with the panel up hides it with #a7, but does not close
    // it — so coming back would land on an open popover nobody asked for.
    setSleepPop(false, { restoreFocus: false });
    syncIntervalFromField();
    // Re-read the fork on every entry rather than once at boot: the path badge is
    // a route back to A3, so this screen can be re-entered on the other path.
    syncPathCopy();
  });
}
