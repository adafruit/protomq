/**
 * Small shared helpers. No imports — this is the bottom of the module graph.
 */

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Trimmed value of a text field, or '' if the field isn't in the DOM. */
export const val = (id) => ($(id)?.value || '').trim();

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
