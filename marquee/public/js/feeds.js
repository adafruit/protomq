/**
 * Adafruit IO feed binding.
 *
 * Browser-direct to IO, same host and auth as the publish flows: GET /feeds to
 * list, then GET /feeds/{key}/data/last for a value. The picker serves two
 * callers — the toolbox "Feed value" button, which drops a NEW label, and a
 * widget's "Choose feed" button, which binds the element already selected.
 */

import { ioHost } from './api.js';
import { layer } from './stage.js';
import { addLabel, rebuildWidget, feedValueAttr, FEED_ETYPES } from './elements.js';
import { select } from './selection.js';
import {
  $, val, toast, escapeHtml, escapeAttr, openModal, closeModal, wireModal, onModalEscape,
} from './util.js';

let feedsCache = [];

/**
 * Which element the picker is binding to. null = the toolbox flow, which drops a
 * new label on the canvas. A node = bind that existing element instead. Always
 * cleared when the modal closes, so a cancelled bind can't leak into the next
 * open.
 */
let feedPickerTarget = null;

function renderFeedList() {
  const q = ($('feedFilter').value || '').trim().toLowerCase();
  const list = $('feedList');
  const shown = feedsCache.filter((f) =>
    !q || (f.name || '').toLowerCase().includes(q) || (f.key || '').toLowerCase().includes(q));
  list.innerHTML = shown.map((f) =>
    `<button type="button" class="btn" data-key="${escapeAttr(f.key)}" data-name="${escapeAttr(f.name || f.key)}"`
    + ' style="justify-content:flex-start; text-align:left; font-family:var(--font-body); letter-spacing:0">'
    + `${escapeHtml(f.name || f.key)}<span class="mono" style="opacity:.6; margin-left:6px; font-size:11px">${escapeHtml(f.key)}</span></button>`
  ).join('');
  $('feedListStatus').textContent =
    feedsCache.length ? `${shown.length} of ${feedsCache.length} feed(s)` : 'No feeds found';
}

export async function openFeedPicker(target = null) {
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key) { toast('Set your IO username and key under Settings'); return; }

  feedPickerTarget = target;
  openModal('feedDataModal');
  $('feedFilter').value = '';
  $('feedList').innerHTML = '';
  $('feedListStatus').textContent = 'Loading feeds…';
  try {
    const res = await fetch(`https://${ioHost()}/api/v2/${encodeURIComponent(user)}/feeds`,
      { headers: { 'X-AIO-Key': key } });
    if (!res.ok) {
      $('feedListStatus').textContent = `IO replied ${res.status}`;
      toast(res.status === 401 ? 'IO rejected the key (401) — check credentials' : `IO replied ${res.status}`);
      return;
    }
    feedsCache = await res.json();
    renderFeedList();
  } catch {
    $('feedListStatus').textContent = 'Could not reach Adafruit IO';
    toast(`Could not reach ${ioHost()} — check the network`);
  }
}

export function closeFeedPicker() {
  closeModal('feedDataModal');
  feedPickerTarget = null;
}

/**
 * Read one feed's last value. Resolves to a string, or null when the feed is
 * unreadable or empty — callers treat null as "unknown", never as a real value.
 */
export async function readFeedValue(feedKey) {
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key || !feedKey) return null;
  try {
    const res = await fetch(
      `https://${ioHost()}/api/v2/${encodeURIComponent(user)}/feeds/${encodeURIComponent(feedKey)}/data/last`,
      { headers: { 'X-AIO-Key': key } });
    if (!res.ok) return null;
    const datum = await res.json().catch(() => ({}));
    return datum && datum.value != null ? String(datum.value) : null;
  } catch { return null; }
}

/**
 * Re-read every feed-bound element (or just the ones passed in) and rebuild
 * them. Best-effort by design: a failed read LEAVES THE PREVIOUS VALUE rather
 * than blanking the element, so one flaky request can't turn a panel off.
 * Returns true when every attempted read succeeded.
 */
export async function refreshFeedElements(nodes) {
  const targets = (nodes || layer.find('.element'))
    .filter((n) => FEED_ETYPES.includes(n.getAttr('etype')) && n.getAttr('feedKey'));
  if (!targets.length) return true;
  const results = await Promise.all(targets.map(async (n) => {
    const v = await readFeedValue(n.getAttr('feedKey'));
    if (v === null) return false;
    n.setAttr(feedValueAttr(n), v);
    rebuildWidget(n);
    return true;
  }));
  return results.every(Boolean);
}

export function initFeeds() {
  wireModal('feedDataModal', ['feedDataClose']);
  // The shared Escape handler closes the modal; clearing the pending target is
  // this picker's own business.
  onModalEscape('feedDataModal', () => { feedPickerTarget = null; });
  $('feedDataModal')?.addEventListener('click', (e) => {
    if (e.target === $('feedDataModal')) feedPickerTarget = null;
  });
  $('feedDataClose')?.addEventListener('click', () => { feedPickerTarget = null; });

  $('addFeedData')?.addEventListener('click', () => openFeedPicker(null));
  $('feedFilter')?.addEventListener('input', renderFeedList);

  $('feedList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    const user = val('ioUser'), key = val('ioKey');
    const feedKey = btn.dataset.key;
    const feedName = btn.dataset.name || feedKey;
    $('feedListStatus').textContent = 'Loading value…';
    try {
      const res = await fetch(
        `https://${ioHost()}/api/v2/${encodeURIComponent(user)}/feeds/${encodeURIComponent(feedKey)}/data/last`,
        { headers: { 'X-AIO-Key': key } });
      if (!res.ok) {
        $('feedListStatus').textContent = `IO replied ${res.status}`;
        toast(res.status === 404 ? `"${feedName}" has no data yet` : `IO replied ${res.status}`);
        return;
      }
      const datum = await res.json().catch(() => ({}));
      const value = datum && datum.value != null ? String(datum.value) : '';
      if (value === '') { toast(`"${feedName}" has no value`); return; }

      if (feedPickerTarget) {
        const node = feedPickerTarget;
        node.setAttr('feedKey', feedKey);
        node.setAttr('feedName', feedName);
        node.setAttr(feedValueAttr(node), value);
        rebuildWidget(node);
        closeFeedPicker();
        select(node);          // re-render the inspector with the new binding
        toast(`Bound ${feedName} = ${value}`);
        return;
      }

      const node = addLabel({ text: `${feedName}: ${value}` });
      node.setAttr('feedKey', feedKey);
      node.setAttr('feedName', feedName);
      closeFeedPicker();
      select(node);
      toast(`Added ${feedName} = ${value}`);
    } catch {
      $('feedListStatus').textContent = 'Could not reach Adafruit IO';
      toast(`Could not reach ${ioHost()} — check the network`);
    }
  });
}
