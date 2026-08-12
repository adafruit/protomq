/**
 * A6 — Act I, CircuitPython only: the code bundle.
 *
 * The one extra step. Generate a bundle from the confirmed settings, get it onto
 * the CIRCUITPY drive, confirm the board checked in.
 *
 * The rule that makes the two paths converge is implemented literally here:
 * changing the display, its pins, rotation, resolution, SPI bus, dithering or
 * the refresh interval marks the bundle stale and re-opens this screen. Dashboard
 * edits never do — they arrive over the air on the feed the bundle already reads.
 */

import { BACKEND } from '../api.js';
import { configSignature, onConfigChange } from '../config.js';
import { bundleFiles, bundleTotalBytes, bundleName, downloadBundle } from '../bundle.js';
import { getState, setState } from '../state.js';
import { navigate, completeActOne } from '../router.js';
import { DISPLAY_PRESETS } from '../presets.js';
import { $, val, toast, show, fmtBytes, setCheck, escapeHtml } from '../util.js';

function renderFileList() {
  const files = bundleFiles();
  $('bundleFiles').innerHTML = files.map((f) =>
    `<div class="row"><span class="glyph">▸</span> ${escapeHtml(f.name)}<span class="size">${fmtBytes(f.bytes)}</span></div>`
  ).join('')
  // lib/ is genuinely absent — say so here rather than listing files the ZIP
  // does not contain. See the note at the top of bundle.js.
  + `<div class="row" style="opacity:.75"><span class="glyph">▾</span> lib/<span class="size">not included</span></div>
     <div class="nested">
       <div>adafruit_requests.mpy</div>
       <div>adafruit_imageload/</div>
       <div>your panel's EPD driver</div>
       <div style="opacity:.8">— download from circuitpython.org/libraries</div>
     </div>`;

  $('bundleMeta').textContent =
    `${fmtBytes(bundleTotalBytes(files))} · includes your IO credentials`;
}

function renderHeader() {
  const st = getState();
  const panel = st.selectedPanel ? DISPLAY_PRESETS[st.selectedPanel].label : 'your panel';
  $('a6Sub').textContent =
    `Built for a ${panel} with the settings you just confirmed. You only do this again if those settings change.`;
  $('bundleDownload').textContent = `Download ${bundleName()}`;
  show($('bundleStale'), st.bundleState === 'stale');
}

async function runDeviceChecks() {
  const device = val('pmDevice') || 'magtag';
  // We cannot read a CircuitPython version over this transport — claiming one
  // would be an invented fact on a screen whose whole job is telling the user
  // whether their board is actually running the files.
  setCheck('chkCpy', 'wait', 'CircuitPython version reported by the board once it runs');
  try {
    const res = await fetch(`${BACKEND}/sleep/status`);
    const s = res.ok ? await res.json() : null;
    const seen = s && Array.isArray(s.clients) && s.clients.some((c) => String(c).includes(device));
    if (seen) setCheck('chkCheckin', 'pass', `${device} has checked in`);
    else setCheck('chkCheckin', 'wait', 'Waiting for the board to check in');
  } catch {
    setCheck('chkCheckin', 'wait', 'Waiting for the board to check in');
  }
}

export function initA6({ onEnter }) {
  $('bundleDownload').addEventListener('click', () => {
    const out = downloadBundle();
    setState({ bundleState: 'downloaded', bundleSig: configSignature() });
    renderHeader();
    toast(`Downloaded ${out.name} — ${fmtBytes(out.size)}`);
  });

  $('bundleDone').addEventListener('click', () => {
    setState({ bundleState: 'confirmed', bundleSig: configSignature() });
    completeActOne();
    navigate('a7');
  });

  // "Skip for now" is a real escape hatch: the editor works without a board, and
  // trapping someone here because they haven't got a USB cable to hand would be
  // worse than letting them design first and copy the bundle later.
  $('bundleSkip').addEventListener('click', () => {
    completeActOne();
    navigate('a7');
    toast('Skipped — the board will not draw anything until the bundle is copied across');
  });

  // Any config change invalidates a bundle that has already been downloaded.
  onConfigChange(() => {
    const st = getState();
    if (st.firmwarePath !== 'circuitpython') return;
    if (st.bundleState === 'not-generated') return;
    if (st.bundleSig && st.bundleSig === configSignature()) return;
    if (st.bundleState !== 'stale') {
      setState({ bundleState: 'stale' });
      toast('Display settings changed — the code bundle on your board is now out of date');
    }
    renderHeader();
    renderFileList();
  });

  onEnter('a6', () => {
    renderHeader();
    renderFileList();
    runDeviceChecks();
  });
}
