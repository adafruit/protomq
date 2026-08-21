/**
 * Small shared helpers. No imports — this is the bottom of the module graph.
 */

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Trimmed value of a text field, or '' if the field isn't in the DOM. */
export const val = (id) => ($(id)?.value || '').trim();

/**
 * Write a value into a field and let everything already listening find out.
 *
 * The settings fields are their own store — main.js persists them by listening for
 * `input`, and render.js redraws the publish line off the same event. So a screen
 * that sets one programmatically has to raise the event too, or the value lands in
 * the DOM and nowhere else. Bubbling, because some listeners are delegated.
 *
 * A no-op when the value is unchanged, so mirroring on every keystroke doesn't
 * write to localStorage on every keystroke.
 */
export function setFieldValue(id, value) {
  const el = $(id);
  if (!el || el.value === value) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * An Adafruit IO group or feed key: lowercase a-z, 0-9 and dashes, nothing else.
 *
 * IO enforces this server-side, so slugifying before the request is what turns a
 * 422 into a key the user can see in advance. Spaces, underscores and punctuation
 * all collapse to a single dash; leading and trailing dashes are trimmed, because
 * IO rejects those too. Returns '' for a name with nothing usable in it, which the
 * callers treat as "no key yet" rather than as a key.
 */
export function slugifyKey(s) {
  return String(s ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Minimal escaping for values interpolated into innerHTML / attributes. */
export function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
export function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

// ---------- numbers, for the data-driven widgets ----------------------------
//
// Feed values arrive from IO as STRINGS, and "no reading yet" has to stay
// distinguishable from a real zero, so every conversion here funnels through
// toNum and returns null rather than NaN or 0 for an unusable value.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A finite number, or null for empty / non-numeric / unset. Never NaN. */
export function toNum(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/** `places` is user-supplied, so it's clamped to what toFixed actually accepts. */
export function fmtDecimals(raw, places) {
  const v = toNum(raw);
  if (v === null) return '—';
  return v.toFixed(clamp(Math.round(places) || 0, 0, 10));
}

/**
 * Tick stops on a 1 / 2 / 5 × 10ⁿ ramp, the spacing that reads as "round numbers"
 * at any magnitude. `count` is a target, not a promise: the stops are aligned to
 * the ramp, so the count lands near it rather than on it. Always returns at least
 * the two endpoints.
 *
 * The ramp rounds UP (a step of 5 where 3.3 was asked for) because these label a
 * 60px-tall plot on an e-ink panel — erring toward fewer, further-apart stops is
 * what keeps them legible.
 */
export function niceTicks(lo, hi, count = 4) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo, hi];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm > 5 ? 10 : norm > 2 ? 5 : norm > 1 ? 2 : 1) * mag;
  // Stops are printed as axis labels, so they are rounded to the step's own
  // precision. Accumulating (t += step) drifts, and so does re-multiplying
  // (Math.round(t / step) * step still yields 0.30000000000000004 at step 0.1) —
  // decimal rounding is what actually removes it.
  const dp = clamp(Math.ceil(-Math.log10(step)), 0, 10);
  const out = [];
  const first = Math.ceil(lo / step - 1e-9);
  for (let i = first; i * step <= hi + step * 1e-9; i++) out.push(Number((i * step).toFixed(dp)));
  return out.length >= 2 ? out : [lo, hi];
}

/**
 * Normalise a value to 0..1 across [lo, hi]. The ONE place linear vs log is
 * decided, so plotting code stays a single expression.
 *
 * Log needs a strictly positive domain — log10(0) is -Infinity and negatives are
 * undefined — so a caller that can't guarantee that gets the linear mapping
 * instead of a silently broken plot.
 */
export function scaleUnit(v, lo, hi, log = false) {
  if (log && lo > 0 && hi > 0 && v > 0) {
    const l = Math.log10(lo), h = Math.log10(hi);
    return h === l ? 0 : (Math.log10(v) - l) / (h - l);
  }
  return hi === lo ? 0 : (v - lo) / (hi - lo);
}

/** mm:ss for the clapperboard countdown; hh:mm:ss once past an hour. */
export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

/** "5 minutes" / "1 hour" — the human form of a refresh interval. */
export function fmtInterval(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  if (s < 3600) {
    const m = Math.round(s / 60);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const h = s / 3600;
  const rounded = Number.isInteger(h) ? h : h.toFixed(1);
  return `${rounded} hour${h === 1 ? '' : 's'}`;
}

/** Local wall-clock time, e.g. "9:47 AM". */
export function fmtLocalTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The same, WITH seconds — "9:47:12 AM". Minutes are right for "written 9:47 AM" and
 *  useless for a device report, where a whole wake lasts twenty seconds. */
export function fmtLocalSeconds(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]); // strip the data: URL prefix
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

/**
 * Copy text to the clipboard, falling back to a throwaway textarea where the
 * async Clipboard API is unavailable — it needs a secure context, so a plain
 * http:// origin (which is how this app is usually run locally) does not have it.
 * Resolves false only if both routes fail.
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* blocked or insecure context — fall through */ }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/**
 * Copy, then say so on the button that was clicked. The label is restored on a
 * timer, so a second click before it lapses must not capture "✓ Copied" as the
 * label to go back to.
 */
export async function copyFromButton(btn, text, restore = btn.textContent) {
  const ok = await copyText(text);
  if (!ok) { toast('Copy failed — select the text manually'); return; }
  btn.textContent = '✓ Copied';
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => { btn.textContent = restore; }, 1200);
}

let toastTimer;
export function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/**
 * Set one of the dotted status lines in a side rail. `state` is one of
 * wait | pass | warn | fail and drives the dot color via CSS.
 */
export function setCheck(id, state, text) {
  const el = $(id);
  if (!el) return;
  el.dataset.state = state;
  const slot = el.querySelector('[data-role="text"]');
  if (slot) slot.textContent = text;
}

/** Show/hide via the shared .hidden class. */
export function show(el, visible) {
  if (el) el.classList.toggle('hidden', !visible);
}

/** Read the checked radio out of a .seg segmented control. */
export function segValue(containerId) {
  const checked = $(containerId)?.querySelector('input:checked');
  return checked ? checked.value : null;
}

/** Check the radio matching `value` in a .seg segmented control. */
export function setSegValue(containerId, value) {
  $$(`#${containerId} input`).forEach((i) => { i.checked = i.value === String(value); });
}

/** Standard modal wiring: close button, backdrop click, and a shared registry. */
const openModals = new Set();

export function wireModal(backdropId, closeIds = []) {
  const backdrop = $(backdropId);
  if (!backdrop) return;
  closeIds.forEach((id) => $(id)?.addEventListener('click', () => closeModal(backdropId)));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(backdropId); });
}

export function openModal(id) {
  $(id)?.classList.remove('hidden');
  openModals.add(id);
}

export function closeModal(id) {
  $(id)?.classList.add('hidden');
  openModals.delete(id);
}

/** Escape closes whatever is open. Callers register extra teardown per modal. */
const escapeHandlers = new Map();
export function onModalEscape(id, fn) { escapeHandlers.set(id, fn); }

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !openModals.size) return;
  for (const id of [...openModals]) {
    closeModal(id);
    escapeHandlers.get(id)?.();
  }
});
