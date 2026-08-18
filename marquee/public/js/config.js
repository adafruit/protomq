/**
 * The display descriptor: the A5 form, its persistence, and the request body
 * every device call is built from.
 *
 * These fields physically live inside A5's advanced disclosure, but they are
 * read from A7 and A8 too — which is why every screen stays mounted. Nothing
 * here caches an element reference across a screen change, and nothing here
 * assumes A5 is visible.
 */

import { display, logicalDims, MODE_LABELS, ditherLabel } from './palette.js';
import { fitZoom, updateDims, suspendDitherPreview, scheduleDitherRefresh } from './stage.js';
import { remapColorsToPalette } from './elements.js';
import { refreshProps } from './selection.js';
import { DISPLAY_PRESETS, PRESET_KEYS } from './presets.js';
import { getState, setState } from './state.js';
import { $, $$, val, segValue, setSegValue, show, toast, fmtInterval } from './util.js';

const DISPLAY_CONFIG_KEY = 'marquee.displayConfig';

/**
 * Every input whose value is part of the descriptor or the render settings. The
 * pins and identity are NOT in canvas.json, so this list is the only thing that
 * carries a re-pin through to persistence and to the broker.
 */
const CONFIG_FIELDS = [
  'marqueeName', 'preset', 'resW', 'resH', 'rotSel', 'dtype',
  'pmName', 'pmDriver', 'pmPanel',
  'pinBusy', 'pinDc', 'pinRst', 'pinCs', 'pinSramCs', 'pinMosi', 'pinSck', 'spiBus',
  'diffusion', 'orderedMap',
];

const DITHER_HINTS = {
  FloydSteinberg: 'Error diffusion — best for photos and gradients. Tune diffusion to taste between "too contrasty" (lower) and "too snowy" (higher).',
  ordered: 'Structured Bayer pattern. Not ideal for photos — it tends to lose edge detail — but gives a clean look for flat artwork and diagrams. Smaller maps give a coarser texture.',
  none: 'No dithering — each pixel snaps to the nearest palette colour. Good for text, high-contrast line art and bold flat graphics.',
};

/** Fires whenever anything that invalidates a CircuitPython bundle changes. */
const configListeners = new Set();
export function onConfigChange(fn) { configListeners.add(fn); }

// ---------- the descriptor --------------------------------------------------

/**
 * Build the /display/add request body from the live form. Shared by "Send to
 * device", the deep-sleep re-provision, and the CircuitPython bundle.
 */
export function buildDisplayBody() {
  // Reconstruct the interfaceType object from the individual pin fields.
  const iface = {
    spiEpd: {
      pinBusy: val('pinBusy'),
      spi: {
        bus: Number($('spiBus')?.value) || 0,
        pinMosi: val('pinMosi'),
        pinSck: val('pinSck'),
        pinCs: val('pinCs'),        // EPD chip select (ws.spi.Descriptor.pinCs)
      },
      pinDc: val('pinDc'),
      pinRst: val('pinRst'),
      pinSramCs: val('pinSramCs'),  // SRAM chip select, if the EPD requires one
    },
  };

  return {
    width: display.width,
    height: display.height,
    // display.rotation is degrees; ws_display_DisplayProperties.rotation is the
    // clockwise 90° step index the device passes to setRotation():
    //   0 -> 0°, 1 -> 90°, 2 -> 180°, 3 -> 270°
    rotation: Math.round((display.rotation || 0) / 90) % 4,
    mode: display.type,
    name: val('pmName') || 'epd0',
    driver: val('pmDriver') || 'SSD1680',
    panel: val('pmPanel') || 'adafruit-magtag',
    user: val('pmUser') || 'test_user',
    device: val('pmDevice') || 'magtag',
    interface: iface,
  };
}

/** The sleep timer, in seconds. The design calls this the refresh interval. */
export function refreshInterval() {
  return Math.max(0, parseInt($('sleepDuration')?.value, 10) || 0);
}

/**
 * The line between light and deep sleep, in seconds.
 *
 * Sleep mode is DERIVED from the interval rather than picked, because the interval
 * is the only thing the answer depends on — and two authors for one decision is
 * how the editor and the board end up disagreeing (a 15-second refresh set to Deep
 * paid a full boot + re-provision + redraw every fifteen seconds, and nothing said
 * so). Three tiers, which collapse into one comparison:
 *
 *   T < 60s     light. Under the MQTT keepalive the socket survives the nap
 *               outright, so waking costs nothing at all.
 *   60s-300s    light. The socket is gone and the reconnect is MQTT-only — still
 *               far cheaper than the boot + re-provision + EPD redraw a deep wake
 *               pays for.
 *   T >= 300s   deep. Past here the boot stops dominating, and holding RAM and a
 *               radio for five minutes to save one boot is the worse trade.
 *
 * The first two tiers give the same answer, so there is one threshold and it is
 * this one. The 60s tier is the reasoning, not configuration: nothing in this repo
 * reads a device keepalive, and ws.sleep has no field for one.
 *
 * MIRRORED in server.js (sleepModeFor). That copy is the authoritative one — it is
 * what actually encodes ws.sleep.SleepConfig and registers the wake response. This
 * one exists because the CircuitPython path never talks to the backend at all, and
 * because the interval picker has to name the mode without a round trip.
 */
export const DEEP_SLEEP_THRESHOLD_SECS = 300;

/** The ws.sleep.SleepMode name for a sleep of `secs`. */
export function sleepModeFor(secs) {
  return secs >= DEEP_SLEEP_THRESHOLD_SECS ? 'S_DEEP' : 'S_LIGHT';
}

// ---------- resolution / orientation ----------------------------------------

export function setResolution(w, h) {
  display.width = w;
  display.height = h;
  if ($('resW')) $('resW').value = w;
  if ($('resH')) $('resH').value = h;
  // Drop any dither overlay before re-fitting: it's a bitmap of the previous
  // dimensions and would be stretched to the new aspect ratio.
  suspendDitherPreview();
  fitZoom();
  refreshProps();
  scheduleDitherRefresh();
}

/** Landscape when the panel is wider than tall AS ORIENTED. */
function currentOrientation() {
  const { w, h } = logicalDims();
  return w >= h ? 'landscape' : 'portrait';
}

/**
 * Orientation is a view onto rotation, not a separate field — which keeps a
 * portrait-native framebuffer (the quad-color panel) honest: its "landscape" is
 * rotation 270, not rotation 0.
 *
 * Two of the four rotations are landscape and two are portrait, so "flip" is
 * ambiguous unless we remember which one we came from. Blindly adding 90° each
 * time makes the control non-reversible: landscape → portrait → landscape would
 * land on 180° instead of back at 0°, quietly turning the panel upside down and
 * making it look like the user had diverged from their preset.
 */
const lastRotationFor = { landscape: null, portrait: null };

function setOrientation(want) {
  const from = currentOrientation();
  if (from === want) return;
  lastRotationFor[from] = display.rotation;
  display.rotation = lastRotationFor[want] ?? (display.rotation + 90) % 360;
  if ($('rotSel')) $('rotSel').value = String(display.rotation);
  afterGeometryChange();
}

function afterGeometryChange() {
  suspendDitherPreview();  // rotation swaps w/h — the old bitmap no longer fits
  fitZoom();
  refreshProps();
  scheduleDitherRefresh();
  syncDerivedUI();
}

// ---------- presets ---------------------------------------------------------

/** True while the form still holds exactly what this preset fills in. */
export function presetMatchesForm(p) {
  const g = (id) => ($(id)?.value || '');
  return g('preset') === p.preset && g('rotSel') === String(p.rotation)
    && g('dtype') === p.mode && g('pmName') === p.name && g('pmDriver') === p.driver
    && g('pmPanel') === p.panel && g('pinBusy') === p.pins.busy && g('pinDc') === p.pins.dc
    && g('pinRst') === p.pins.rst && g('pinCs') === p.pins.cs && g('pinSramCs') === p.pins.sramCs
    && g('pinMosi') === p.pins.mosi && g('pinSck') === p.pins.sck && g('spiBus') === String(p.pins.bus);
}

/** The preset key the form currently matches exactly, or null. */
export function matchingPresetKey() {
  return PRESET_KEYS.find((k) => presetMatchesForm(DISPLAY_PRESETS[k])) || null;
}

/**
 * Non-empty overrides mean the user has diverged from the chosen preset, which
 * is what makes "Reset to preset" live.
 */
export function hasOverrides() {
  const key = getState().selectedPanel;
  return !!key && !presetMatchesForm(DISPLAY_PRESETS[key]);
}

export function applyDisplayPreset(key, { silent = false } = {}) {
  const p = DISPLAY_PRESETS[key];
  if (!p) return;

  $('preset').value = p.preset;
  show($('customRes'), false);
  const [w, h] = p.preset.split('x').map(Number);

  $('rotSel').value = p.rotation;
  display.rotation = +p.rotation;
  $('dtype').value = p.mode;
  display.type = p.mode;

  $('pmName').value = p.name;
  $('pmDriver').value = p.driver;
  $('pmPanel').value = p.panel;

  $('pinBusy').value = p.pins.busy;
  $('pinDc').value = p.pins.dc;
  $('pinRst').value = p.pins.rst;
  $('pinCs').value = p.pins.cs;
  $('pinSramCs').value = p.pins.sramCs;
  $('pinMosi').value = p.pins.mosi;
  $('pinSck').value = p.pins.sck;
  $('spiBus').value = p.pins.bus;

  // Re-apply to the editor the same way the individual change handlers do.
  setResolution(w, h);
  remapColorsToPalette();
  updateDims();
  refreshProps();
  // A preset fills fields programmatically, so no input event fires — persist
  // and re-derive explicitly.
  saveConfig();
  syncDerivedUI();
  notifyConfigChanged();
  if (!silent) toast(`Loaded the ${p.label} preset`);
}

// ---------- persistence -----------------------------------------------------

function saveConfig() {
  const data = { dmode: segValue('ditherSeg') || 'FloydSteinberg' };
  CONFIG_FIELDS.forEach((id) => { if ($(id)) data[id] = $(id).value; });
  try { localStorage.setItem(DISPLAY_CONFIG_KEY, JSON.stringify(data)); } catch { /* storage disabled/full */ }
}

/**
 * Push the `display` object back out to the form. Used after deserialize(),
 * which loads a document carrying its own display block.
 */
export function applyDisplayToForm() {
  if ($('dtype')) $('dtype').value = display.type;
  if ($('rotSel')) $('rotSel').value = String(display.rotation);
  if ($('diffusion')) $('diffusion').value = display.diffusion;
  if ($('orderedMap')) $('orderedMap').value = String(display.orderedMap);
  setSegValue('ditherSeg', display.dither);
  const label = $('diffusionLabel');
  if (label) label.textContent = display.diffusion + '%';
  // A loaded document's resolution rarely matches a named option.
  if ($('preset')) $('preset').value = 'custom';
  show($('customRes'), true);
  syncDitherControls();
  syncDerivedUI();
}

/**
 * Setting an input's .value doesn't fire its change handler, so after filling
 * the fields we rebuild the `display` object and refresh the canvas the same way
 * the individual handlers do.
 */
function applyRestoredConfig() {
  show($('customRes'), $('preset').value === 'custom');
  // resW/resH always track the true resolution (setResolution keeps them in sync).
  display.width = +$('resW').value || display.width;
  display.height = +$('resH').value || display.height;
  display.rotation = +$('rotSel').value || 0;
  display.type = $('dtype').value;
  display.dither = segValue('ditherSeg') || 'FloydSteinberg';
  display.diffusion = +$('diffusion').value;
  display.orderedMap = +$('orderedMap').value;
  $('diffusionLabel').textContent = display.diffusion + '%';
  syncDitherControls();
  remapColorsToPalette();
  fitZoom();
  updateDims();
  refreshProps();
  syncDerivedUI();
}

function restoreConfig() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(DISPLAY_CONFIG_KEY) || '{}') || {}; } catch { /* corrupt/blocked */ }
  CONFIG_FIELDS.forEach((id) => {
    if ($(id) && typeof data[id] === 'string') $(id).value = data[id];
  });
  if (typeof data.dmode === 'string') setSegValue('ditherSeg', data.dmode);
  applyRestoredConfig();
}

// ---------- derived UI ------------------------------------------------------

function syncDitherControls() {
  const m = display.dither;
  show($('diffusionRow'), m === 'FloydSteinberg');
  show($('orderedRow'), m === 'ordered');
  const hint = $('ditherHint');
  if (hint) hint.textContent = DITHER_HINTS[m] || '';
}

/** The A5 summary plate, the orientation control, the preset chips, the heading. */
export function syncDerivedUI() {
  const { w, h } = logicalDims();
  const st = getState();
  const preset = st.selectedPanel ? DISPLAY_PRESETS[st.selectedPanel] : null;

  const heading = $('a5Heading');
  if (heading) {
    heading.textContent = preset
      ? `${preset.label} — we filled this in for you`
      : 'Set up your panel by hand';
  }

  const res = $('summaryRes');
  if (res) res.textContent = `${w} × ${h} pixels, ${MODE_LABELS[display.type] || display.type}`;

  const drv = $('summaryDriver');
  if (drv) {
    drv.textContent = `Driver ${val('pmDriver') || '—'} · panel ${val('pmPanel') || '—'} · SPI bus ${$('spiBus')?.value ?? 0}`;
  }

  const pins = $('summaryPins');
  if (pins) {
    const p = (id) => val(id) || '—';
    pins.textContent = `Pins: BUSY ${p('pinBusy')} · DC ${p('pinDc')} · RST ${p('pinRst')} · CS ${p('pinCs')}`;
  }

  // Scale the panel proxy to the real aspect ratio so a 7.5" and a 2.13" don't
  // look identical in the plate.
  const proxy = $('summaryProxy');
  if (proxy) {
    const maxW = 150, maxH = 84;
    const scale = Math.min(maxW / w, maxH / h);
    proxy.style.width = Math.round(w * scale) + 'px';
    proxy.style.height = Math.round(h * scale) + 'px';
  }

  setSegValue('orientSeg', currentOrientation());

  $$('#presetRow .preset-chip').forEach((chip) => {
    chip.dataset.active = String(presetMatchesForm(DISPLAY_PRESETS[chip.dataset.preset]));
  });

  const reset = $('resetToPreset');
  if (reset) reset.disabled = !hasOverrides();

  updateDims();
}

function notifyConfigChanged() {
  configListeners.forEach((fn) => fn());
}

/**
 * Announce a change made outside this module's own fields — the refresh interval
 * lives in the Settings dialog but is what a sleeping device is re-registered with
 * (and, via sleepModeFor, what picks its sleep mode), so an edit there has to reach
 * the same listeners a re-pin does. It is NOT in cfg-marquee.json, so it does not
 * stale a downloaded bundle; code.py owns its own sleep window.
 */
export function configChanged() { notifyConfigChanged(); }

// ---------- boot ------------------------------------------------------------

export function initConfig() {
  // Preset chips inside the advanced disclosure.
  const row = $('presetRow');
  if (row) {
    row.innerHTML = PRESET_KEYS.map((k) =>
      `<button type="button" class="btn btn-sm preset-chip" data-preset="${k}" data-active="false">${DISPLAY_PRESETS[k].label}</button>`
    ).join('');
    row.addEventListener('click', (e) => {
      const chip = e.target.closest('.preset-chip');
      if (!chip) return;
      setState({ selectedPanel: chip.dataset.preset });
      applyDisplayPreset(chip.dataset.preset);
    });
  }

  $('resetToPreset')?.addEventListener('click', () => {
    const key = getState().selectedPanel;
    if (!key) return;
    applyDisplayPreset(key, { silent: true });
    toast(`Reset to the ${DISPLAY_PRESETS[key].label} preset`);
  });

  // Resolution.
  $('preset')?.addEventListener('change', (e) => {
    if (e.target.value === 'custom') { show($('customRes'), true); return; }
    show($('customRes'), false);
    const [w, h] = e.target.value.split('x').map(Number);
    setResolution(w, h);
    syncDerivedUI();
  });
  ['resW', 'resH'].forEach((id) => $(id)?.addEventListener('change', () => {
    $('preset').value = 'custom';
    setResolution(+$('resW').value || 8, +$('resH').value || 8);
    syncDerivedUI();
  }));

  // Rotation and orientation are two views on the same value.
  $('rotSel')?.addEventListener('change', (e) => {
    display.rotation = +e.target.value;
    // An explicit rotation supersedes whatever the orientation toggle last
    // remembered, or a later flip would drag the panel back to a rotation the
    // user has since rejected.
    lastRotationFor.landscape = null;
    lastRotationFor.portrait = null;
    afterGeometryChange();
  });
  $('orientSeg')?.addEventListener('change', (e) => setOrientation(e.target.value));

  // Color mode. Existing elements are snapped onto the new palette immediately:
  // leaving off-palette colors would let the dither shift them silently later.
  $('dtype')?.addEventListener('change', (e) => {
    display.type = e.target.value;
    remapColorsToPalette();
    updateDims();
    refreshProps();
    scheduleDitherRefresh();
    syncDerivedUI();
  });

  // Dither. Every control here feeds the render pipeline, so a live preview goes
  // stale the moment one changes — re-run it in place rather than making the
  // user toggle the button twice. The overlay keeps showing the previous dither
  // until the new one lands; no flash back to the undithered stage, since the
  // geometry isn't what changed.
  $('ditherSeg')?.addEventListener('change', () => {
    display.dither = segValue('ditherSeg') || 'FloydSteinberg';
    syncDitherControls();
    updateDims();
    scheduleDitherRefresh();
  });
  $('diffusion')?.addEventListener('input', (e) => {
    display.diffusion = +e.target.value;
    $('diffusionLabel').textContent = e.target.value + '%';
    updateDims();
    scheduleDitherRefresh(350);  // the slider fires continuously — let it settle
  });
  $('orderedMap')?.addEventListener('change', (e) => {
    display.orderedMap = +e.target.value;
    updateDims();
    scheduleDitherRefresh();
  });

  restoreConfig();

  // One persistence hook across every descriptor field. Also the only place that
  // can notice a re-pin, which is what invalidates a CircuitPython bundle.
  [...CONFIG_FIELDS, 'ditherSeg'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const onEdit = () => { saveConfig(); syncDerivedUI(); notifyConfigChanged(); };
    el.addEventListener('input', onEdit);
    el.addEventListener('change', onEdit);
  });

  syncDerivedUI();
}

/** Human summary of the current refresh interval, for the A8 sleep bar. */
export function refreshIntervalLabel() {
  return fmtInterval(refreshInterval());
}

/** Re-exported so screens can render the dither state without importing palette. */
export { ditherLabel };
