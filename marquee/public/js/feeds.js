/**
 * Adafruit IO feed binding.
 *
 * Browser-direct to IO, same host and auth as the publish flows: GET /feeds to
 * list, then GET /feeds/{key}/data/last for a value or /data/chart for a window of
 * history. The picker serves three callers — the toolbox "Feed value" button, which
 * drops a NEW label; an element's "Connect to IO Feed" button, which binds the
 * element already selected; and the chart's "Add feed", which APPENDS to a list.
 */

import { ioHost } from './api.js';
import { layer } from './stage.js';
import {
  addLabel, rebuildWidget, applyFeedValue, FEED_ETYPES, CHART_RAW_MAX,
} from './elements.js';
import { display, PALETTES } from './palette.js';
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

/**
 * 'bind' replaces the target's single binding; 'series' appends to its `feeds`
 * array. Held next to the target because they are one decision — a stale mode with
 * a fresh target would append to a gauge or overwrite a chart.
 */
let feedPickerMode = 'bind';

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

export async function openFeedPicker(target = null, { mode = 'bind' } = {}) {
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key) { toast('Set your IO username and key under Settings'); return; }

  feedPickerTarget = target;
  feedPickerMode = mode;
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
  feedPickerMode = 'bind';
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
 * The newest datum as a POINT — value, id and timestamp — from `/data/last`.
 *
 * The one endpoint that answers when a feed has no history. IO only retains data points
 * for feeds with history ON, and history caps a datum at 1 KB — which a panel BMP is
 * twenty times over, so the image feed can never have it. `/data` on such a feed returns
 * an empty array while `/data/last` still returns the current value, and reading only the
 * former is what left "On the panel now" claiming nothing had ever been published to a feed
 * the board was actively drawing from.
 *
 * One datum is all there is in that configuration: enough to say what is on the feed, never
 * enough to say what was on it before.
 */
export async function readFeedLast(feedKey) {
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key || !feedKey) return null;
  try {
    const res = await fetch(
      `https://${ioHost()}/api/v2/${encodeURIComponent(user)}/feeds/${encodeURIComponent(feedKey)}/data/last`,
      { headers: { 'X-AIO-Key': key } });
    if (!res.ok) return null;
    const d = await res.json().catch(() => null);
    if (!d || d.value == null) return null;
    return { id: d.id, value: String(d.value), createdAt: Date.parse(d.created_at) };
  } catch { return null; }
}

/**
 * Read the newest data POINTS of a feed, not just their values.
 *
 * readFeedValue above is enough for an element binding, which only ever asks "what
 * does it say now". A watcher needs more: `id` to tell a repeated value from a
 * repeated event, and `created_at` because IO stamps every datum server-side — the
 * only trustworthy clock in a story where the other participant is a board with no
 * RTC that has been asleep.
 *
 * `limit` above 1 is what makes a late poll recoverable: a backgrounded tab gets its
 * timers throttled hard, and asking for the last few data points reconstructs the
 * transitions that happened while nobody was looking.
 *
 * Newest-first, matching IO's own ordering for /data. Resolves to null on an
 * unreadable feed, keeping readFeedValue's contract: null is "unknown", never a
 * real reading.
 */
export async function readFeedData(feedKey, { limit = 1 } = {}) {
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key || !feedKey) return null;
  const qs = new URLSearchParams({ limit: String(Math.max(1, limit)) });
  try {
    const res = await fetch(
      `https://${ioHost()}/api/v2/${encodeURIComponent(user)}/feeds/${encodeURIComponent(feedKey)}/data?${qs}`,
      { headers: { 'X-AIO-Key': key } });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!Array.isArray(body)) return null;
    return body.map((d) => ({
      id: d.id,
      value: d.value == null ? null : String(d.value),
      // Epoch ms, so callers can do arithmetic without re-parsing. NaN on a datum
      // IO didn't stamp, which the callers treat as "no usable time".
      createdAt: Date.parse(d.created_at),
    }));
  } catch { return null; }
}

/**
 * Read a window of history for one feed, for the chart.
 *
 * IO's /data/chart returns a `columns` header naming what each row holds, and the
 * shape DEPENDS ON THE QUERY: raw pulls give ["date","value"], aggregated ones give
 * ["date","min","max","avg"]. So the value column is resolved BY NAME — indexing
 * positionally silently plots minima as if they were readings the moment IO decides
 * a window is large enough to aggregate.
 *
 * Resolves to [{t, v}] or null, matching readFeedValue's contract: null means
 * "unknown", never a real reading.
 */
export async function readFeedHistory(feedKey, { hours = 24, raw = false } = {}) {
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key || !feedKey) return null;
  const qs = new URLSearchParams({ hours: String(hours) });
  // IO caps a raw pull at 640 points and returns the most recent ones, which is
  // exactly the behaviour the "Raw Data Only" option promises.
  if (raw) { qs.set('raw', 'true'); qs.set('limit', String(CHART_RAW_MAX)); }
  try {
    const res = await fetch(
      `https://${ioHost()}/api/v2/${encodeURIComponent(user)}/feeds/${encodeURIComponent(feedKey)}/data/chart?${qs}`,
      { headers: { 'X-AIO-Key': key } });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.data)) return null;
    const cols = body.columns || ['date', 'value'];
    const ti = cols.indexOf('date');
    // 'avg' is the aggregate that represents the window; 'value' is the raw case.
    const vi = ['value', 'avg', 'max', 'min'].map((c) => cols.indexOf(c)).find((i) => i >= 0);
    if (vi === undefined || vi < 0) return null;
    return body.data
      .map((row) => ({ t: ti >= 0 ? row[ti] : null, v: Number(row[vi]) }))
      .filter((p) => Number.isFinite(p.v))
      // Sorted oldest-first, explicitly. The chart reads the LAST point as the
      // latest reading and joins points in array order, so a descending response
      // would draw the window backwards and report the oldest sample as current.
      // /data/chart ascends today; /data descends, and that is one query away.
      .sort((a, b) => (Date.parse(a.t) || 0) - (Date.parse(b.t) || 0));
  } catch { return null; }
}

/**
 * Thin a series to at most `max` points, keeping the FIRST and LAST so the window's
 * endpoints and the headline "latest reading" stay exact.
 *
 * Charts are 120-300px wide, so anything denser than that draws multiple samples
 * into one column — and canvas.json is both the wire format to the device and the
 * input to canvasSignature(), so the invisible points cost bytes and repaints for
 * nothing.
 */
export function downsample(points, max) {
  if (!Array.isArray(points) || points.length <= max || max < 2) return points || [];
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/**
 * Re-read every feed-bound element (or just the ones passed in) and rebuild
 * them. Best-effort by design: a failed read LEAVES THE PREVIOUS VALUE rather
 * than blanking the element, so one flaky request can't turn a panel off.
 * Returns true when every attempted read succeeded.
 *
 * Charts are handled alongside the single-value elements but through their own
 * request, because they need a window rather than a last value.
 */
export async function refreshFeedElements(nodes) {
  const all = nodes || layer.find('.element');
  const targets = all
    .filter((n) => FEED_ETYPES.includes(n.getAttr('etype')) && n.getAttr('feedKey'));
  const charts = all
    .filter((n) => n.getAttr('etype') === 'linechart' && (n.getAttr('feeds') || []).length);
  if (!targets.length && !charts.length) return true;
  const results = await Promise.all([
    ...targets.map(async (n) => {
      const v = await readFeedValue(n.getAttr('feedKey'));
      if (v === null) return false;
      // applyFeedValue, not setAttr + rebuildWidget: a label is a plain Konva.Text
      // with no children to rebuild, so the widget-only path would throw on it.
      applyFeedValue(n, v);
      return true;
    }),
    ...charts.map((n) => refreshChart(n)),
  ]);
  return results.every(Boolean);
}

/**
 * Refetch every series on one chart. Per-feed failures are tolerated the same way
 * single values are — a feed that doesn't answer keeps the points it already had, so
 * one dead feed doesn't wipe the other lines off the plot.
 */
export async function refreshChart(g) {
  const feeds = g.getAttr('feeds') || [];
  // Unbinding the last feed still has to land: drop the cached series and redraw,
  // or the chart keeps plotting a feed it is no longer connected to.
  if (!feeds.length) {
    g.setAttr('series', {});
    rebuildWidget(g);
    return true;
  }
  const hours = g.getAttr('hours') ?? 24;
  const raw = !!g.getAttr('rawOnly');
  const cap = Math.max(2, Math.round(g.getAttr('w') || 120));
  const series = { ...(g.getAttr('series') || {}) };
  const oks = await Promise.all(feeds.map(async (f) => {
    const pts = await readFeedHistory(f.key, { hours, raw });
    if (pts === null) return false;
    series[f.key] = downsample(pts, cap).map((p) => ({ t: p.t, v: p.v }));
    return true;
  }));
  // Drop cached series for feeds that are no longer bound, or an unbound-then-
  // rebound feed would silently resurrect stale points.
  const live = new Set(feeds.map((f) => f.key));
  Object.keys(series).forEach((k) => { if (!live.has(k)) delete series[k]; });
  g.setAttr('series', series);
  rebuildWidget(g);
  return oks.every(Boolean);
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

    // A chart series is a history pull, not a last value, and an empty feed is
    // still a legitimate series to add — so this mode returns before the
    // /data/last fetch below, which treats "no value" as a failure.
    if (feedPickerMode === 'series' && feedPickerTarget) {
      const node = feedPickerTarget;
      const feeds = (node.getAttr('feeds') || []).map((f) => ({ ...f }));
      if (feeds.some((f) => f.key === feedKey)) {
        toast(`"${feedName}" is already on this chart`);
        return;
      }
      $('feedListStatus').textContent = 'Loading history…';
      feeds.push({
        key: feedKey,
        name: feedName,
        // Each series gets the next palette ink, so two feeds differ by colour as
        // well as by dash the moment the second one is added.
        color: PALETTES[display.type][feeds.length % PALETTES[display.type].length],
      });
      node.setAttr('feeds', feeds);
      const ok = await refreshChart(node);
      closeFeedPicker();
      select(node);
      toast(ok ? `Added ${feedName} to the chart`
               : `Added ${feedName}, but its history could not be read`);
      return;
    }

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
        applyFeedValue(node, value);
        closeFeedPicker();
        select(node);          // re-render the inspector with the new binding
        toast(`Bound ${feedName} = ${value}`);
        return;
      }

      // The toolbox shortcut. It drops a genuinely LINKED label — it used to bake
      // "name: value" into the text once and never read the feed again, which looked
      // like a binding and behaved like a screenshot. The feed name becomes the
      // prefix so the caption survives, but the number now refreshes.
      const node = addLabel({
        feedKey, feedName, feedPrefix: `${feedName}: `, feedValue: value,
      });
      closeFeedPicker();
      select(node);
      toast(`Added ${feedName} = ${value}`);
    } catch {
      $('feedListStatus').textContent = 'Could not reach Adafruit IO';
      toast(`Could not reach ${ioHost()} — check the network`);
    }
  });
}
