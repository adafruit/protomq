/**
 * A6 — Act I, CircuitPython only: the code bundle.
 *
 * The one extra step. Generate a bundle from the confirmed settings, get it onto
 * the CIRCUITPY drive, confirm the board checked in.
 *
 * The rule that makes the two paths converge is implemented literally here:
 * anything baked into cfg-marquee.json — the display, its pins, rotation,
 * resolution, SPI bus — plus the feed and credentials in settings.toml marks the
 * bundle stale and re-opens this screen. That set is not enumerated twice;
 * configSignature() hashes the artifacts themselves.
 *
 * Dashboard edits never do: they arrive over the air on the feed the bundle
 * already reads. Neither does the dither, which the render backend applies before
 * the BMP is ever published — the board only ever sees the result. Nor the sleep
 * window, which has a feed of its own (docs/marquee-sleep.md).
 */

import { BACKEND } from '../api.js';
import { onConfigChange } from '../config.js';
import { configSignature } from '../cfg.js';
import { bundleFiles, bundleTotalBytes, bundleName, downloadBundle } from '../bundle.js';
import { getState, setState } from '../state.js';
import { navigate, completeActOne } from '../router.js';
import { DISPLAY_PRESETS } from '../presets.js';
import { $, $$, val, toast, show, fmtBytes, setCheck, escapeHtml, escapeAttr, copyFromButton } from '../util.js';

/**
 * The side rail's manifest, with each entry openable to show what is actually in
 * it. The preview is the real generated text, not a sample — it comes from the
 * same bundleFiles() call that builds the ZIP, so what you read here is byte for
 * byte what lands on the drive.
 *
 * Hover reveals; the +/− pins it open. Both are wired because they answer
 * different questions — hover for "what is cfg-marquee.json?", pinned for "let me
 * read this properly and copy it". The panel opens BELOW its row so the row the
 * pointer is on never moves, which is what stops hover from flickering.
 */
function renderFileList() {
  const files = bundleFiles();

  // A re-render is triggered by any config change, and losing the panel you were
  // reading mid-edit would be its own small betrayal.
  const open = new Set(
    $$('#bundleFiles .file-item[data-open="true"]').map((el) => el.dataset.name)
  );

  $('bundleFiles').innerHTML = files.map((f) => {
    const isOpen = open.has(f.name);
    return `<div class="file-item" data-name="${escapeAttr(f.name)}" data-open="${isOpen}">
      <div class="row">
        <button type="button" class="peek-toggle" aria-expanded="${isOpen}"
                title="Show the contents of ${escapeAttr(f.name)}">${isOpen ? '−' : '+'}</button>
        <span>${escapeHtml(f.name)}</span>
        <span class="size">${fmtBytes(f.bytes)}</span>
      </div>
      <div class="peek">
        <pre class="peek-body">${escapeHtml(f.text)}</pre>
        <button type="button" class="btn btn-ghost btn-sm peek-copy">Copy</button>
      </div>
    </div>`;
  }).join('')
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

/** One delegated handler, because the list is rebuilt on every config change. */
function initFileList() {
  $('bundleFiles')?.addEventListener('click', (e) => {
    const item = e.target.closest('.file-item');
    if (!item) return;

    if (e.target.closest('.peek-copy')) {
      // Read the text back off the <pre> rather than re-deriving it: whatever is
      // on screen is exactly what gets copied, escaping included.
      copyFromButton(e.target.closest('.peek-copy'), item.querySelector('.peek-body').textContent, 'Copy');
      return;
    }

    const toggle = e.target.closest('.peek-toggle');
    if (!toggle) return;
    const nowOpen = item.dataset.open !== 'true';
    item.dataset.open = String(nowOpen);
    toggle.setAttribute('aria-expanded', String(nowOpen));
    toggle.textContent = nowOpen ? '−' : '+';
  });
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
  initFileList();

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
