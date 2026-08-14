/**
 * The render pipeline.
 *
 * The editor captures the canvas at exactly 1:1 and the BACKEND dithers and
 * palette-remaps it with real ImageMagick. That is the ONLY render path — there
 * is no in-browser fallback, because a JS dither would disagree with what the
 * device is handed and the preview would be a lie. So every action that needs a
 * render is disabled while /health is unreachable, and says why.
 */

import { BACKEND, BACKEND_METHOD, ioHost, IO_MAX_NO_HISTORY } from './api.js';
import { display, logicalDims, ditherLabel } from './palette.js';
import { captureClean } from './stage.js';
import { selected, select } from './selection.js';
import { refreshFeedElements } from './feeds.js';
import {
  $, val, toast, fmtBytes, base64ToBlob, download, openModal, closeModal, wireModal,
} from './util.js';

// ---------- backend health gating -------------------------------------------

let backendOnline = false;
const RENDER_BTN_IDS = ['btnPublish', 'sendBmp', 'sendBmpSleep', 'btnExport', 'btnRender', 'btnDitherPreview'];

export function isBackendOnline() { return backendOnline; }

function updateBackendUI() {
  RENDER_BTN_IDS.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.disabled = !backendOnline;
    el.title = backendOnline ? '' : 'Render backend unreachable';
  });
  const banner = $('backendBanner');
  if (banner) banner.dataset.offline = String(!backendOnline);
}

export function markBackendOffline() {
  if (backendOnline) { backendOnline = false; updateBackendUI(); }
}

export async function pingBackend() {
  try {
    const res = await fetch(BACKEND + '/health');
    backendOnline = res.ok;
  } catch {
    backendOnline = false;
  }
  updateBackendUI();
}

// ---------- the authoritative render ----------------------------------------

/**
 * Send the clean 1:1 PNG plus the current settings; get back
 * { bmp, png, bmpBytes, base64Bytes, fits* }. Throws if unreachable — callers
 * surface the error and abort rather than guessing.
 *
 * Deselecting for the capture is done here rather than inside captureClean so
 * stage.js doesn't have to know selection exists. A dither refresh shouldn't
 * cost you your active element, so the selection is put straight back.
 */
export async function backendRender() {
  const prev = selected;
  const canvas = captureClean({
    onDeselect: () => select(null),
    onReselect: () => { if (prev) select(prev); },
  });
  const png = canvas.toDataURL('image/png');
  const res = await fetch(BACKEND + '/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      png,
      display: display.type,
      method: BACKEND_METHOD[display.dither] || 'floyd',
      diffusion: display.diffusion,
      orderedMap: display.orderedMap,
    }),
  });
  if (!res.ok) throw new Error('backend /render ' + res.status);
  return res.json();
}

/**
 * Render, or report why not. Wraps the offline bookkeeping and the toast so the
 * six callers that need a BMP don't each repeat it. Returns null on failure.
 */
export async function renderOrReport(what) {
  try {
    return await backendRender();
  } catch {
    markBackendOffline();
    toast(`Backend unreachable — cannot ${what}`);
    return null;
  }
}

/**
 * IO rejects a datum over its per-feed ceiling. Checking here rather than at
 * each call site means the message names the actual number every time.
 */
export function tooLargeForIO(b64) {
  if (b64.length <= IO_MAX_NO_HISTORY) return false;
  toast(`Base64 BMP is ${fmtBytes(b64.length)} — over IO's ${fmtBytes(IO_MAX_NO_HISTORY)} ceiling. Shrink the panel or use fewer colours.`);
  return true;
}

/**
 * POST one datum to an Adafruit IO feed, browser-direct.
 *
 * The feed defaults to the image feed, which is what every caller wanted until
 * the CircuitPython push started writing a second feed with the sleep window.
 * Failures name the feed, so "which of the two POSTs went wrong" is answerable
 * from the toast alone.
 */
export async function publishToIO(value, feed = val('ioFeed')) {
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key || !feed) {
    toast('Username, AIO key and feed key are all required — set them under Settings');
    return { ok: false, error: 'missing credentials' };
  }
  const host = ioHost();
  try {
    const res = await fetch(
      `https://${host}/api/v2/${encodeURIComponent(user)}/feeds/${encodeURIComponent(feed)}/data`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AIO-Key': key },
        body: JSON.stringify({ value }),
      });
    if (res.ok) return { ok: true, host, feed };
    if (res.status === 422 || res.status === 413) {
      toast(`IO rejected the datum for "${feed}" (${res.status}) — likely too large for this feed's history setting`);
    } else {
      toast(`IO replied ${res.status} for feed "${feed}" — check credentials and that the feed exists`);
    }
    return { ok: false, error: `IO ${res.status}`, feed };
  } catch {
    toast(`Could not reach ${host} — check the network`);
    return { ok: false, error: 'network', feed };
  }
}

// ---------- export ----------------------------------------------------------

export async function exportBMP() {
  const { w, h } = logicalDims();
  await refreshFeedElements();   // feed-bound elements reflect current state, not stale
  const r = await renderOrReport('export a BMP');
  if (!r) return;
  const blob = base64ToBlob(r.bmp, 'image/bmp');
  download(blob, `export_${w}x${h}.bmp`);
  const projectedB64 = Math.ceil(blob.size / 3) * 4;
  if (projectedB64 > IO_MAX_NO_HISTORY) {
    toast(`Exported ${fmtBytes(blob.size)} BMP — too large to publish to IO (~${fmtBytes(projectedB64)} base64). Fine as a local file.`);
  } else {
    toast(`BMP3 exported: ${w}×${h}, ${display.type} · ${fmtBytes(blob.size)}`);
  }
}

// ---------- boot ------------------------------------------------------------

export function initRender() {
  updateBackendUI();          // start disabled until the first probe confirms online
  pingBackend();
  setInterval(pingBackend, 15000);

  $('btnExport')?.addEventListener('click', exportBMP);

  // Render preview modal.
  wireModal('previewModal', ['previewClose']);
  $('btnRender')?.addEventListener('click', async () => {
    const { w, h } = logicalDims();
    const imgEl = $('previewImg');
    const scale = Math.max(1, Math.min(3, Math.floor(440 / w)));
    imgEl.style.width = (w * scale) + 'px';
    await refreshFeedElements();
    const r = await renderOrReport('render a preview');
    if (!r) return;
    imgEl.src = 'data:image/png;base64,' + r.png;
    $('previewMeta').textContent =
      `${w} × ${h} px · ${display.type} · ${ditherLabel()} · shown at ${scale}× · BMP ${fmtBytes(r.bmpBytes)}`;
    openModal('previewModal');
  });
  $('previewExport')?.addEventListener('click', () => {
    closeModal('previewModal');
    exportBMP();
  });

  // Publish modal.
  wireModal('publishModal', ['publishClose']);
  $('btnPublish')?.addEventListener('click', () => {
    openModal('publishModal');
    updatePublishEstimate();
  });
  $('ioFeed')?.addEventListener('input', renderPublishDebug);
  $('ioProd')?.addEventListener('change', renderPublishDebug);

  $('publishSend')?.addEventListener('click', async () => {
    const btn = $('publishSend');
    btn.disabled = true;
    btn.textContent = 'Publishing…';
    try {
      await refreshFeedElements();
      const r = await renderOrReport('publish');
      if (!r) return;
      if (tooLargeForIO(r.bmp)) return;
      const out = await publishToIO(r.bmp);
      if (out.ok) {
        closeModal('publishModal');
        toast(`Published ${fmtBytes(r.bmp.length)} base64 BMP to "${val('ioFeed')}" on ${out.host}`);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Publish';
    }
  });
}

/** Live status next to Publish, so the size against the limit isn't a surprise. */
async function updatePublishEstimate() {
  const dbg = $('publishDebug');
  if (!dbg) return;
  let bytes;
  try {
    bytes = (await backendRender()).base64Bytes;   // authoritative size
  } catch {
    markBackendOffline();
    delete dbg.dataset.size;
    dbg.className = 'hint mono size-bad';
    dbg.textContent = 'Backend unreachable — cannot estimate size';
    return;
  }
  dbg.className = 'hint mono size-' + (bytes <= IO_MAX_NO_HISTORY ? 'ok' : 'bad');
  dbg.dataset.size = fmtBytes(bytes);
  renderPublishDebug();
}

/** Compose the debug line from the cached size + current feed key + host. */
function renderPublishDebug() {
  const dbg = $('publishDebug');
  if (!dbg || !dbg.dataset.size) return;
  const feed = val('ioFeed');
  dbg.textContent = `Publishing a base64-encoded BMP = ${dbg.dataset.size}`
    + (feed ? ` to feed ${feed}` : '')
    + ` on ${ioHost()}`;
}
