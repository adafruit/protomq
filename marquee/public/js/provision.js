/**
 * Creating the device's Adafruit IO group and feeds — the write half of the IO
 * integration, used only by A5b.
 *
 * Separate from feeds.js, which is the READ half: that module pulls Konva in for
 * the element picker, and a setup screen that runs before the editor exists has no
 * business loading the editor. This one imports api.js and nothing else.
 *
 * It also keeps a different error contract, deliberately. feeds.js swallows failures
 * and returns null, which is right when null means "we don't know what that feed
 * says". It is useless here: a provisioning step has to tell a bad key from a plan
 * limit from a flaky network, because the three want three different things from the
 * user. So every call below resolves to a tagged result and never throws.
 *
 * THE KEY IS A HEADER, ALWAYS. Never a query string, never a log line, never a
 * toast — see the note on ioFetch().
 */

import { ioHost, ioLog } from './api.js';

/**
 * The three feeds every Marquee device has, in creation order.
 *
 * Order is not cosmetic: they are created one at a time (see below), so this is the
 * order the dots light up in, and bitmap — the one the board cannot run without —
 * goes first so a run that dies halfway leaves the most useful feed behind.
 *
 * HISTORY IS NOT A PREFERENCE. Adafruit IO caps a datum at 1 KB on a feed with
 * history on and 512 KB with it off (IO_MAX_HISTORY / IO_MAX_NO_HISTORY in api.js).
 * A packed panel is ~20 KB, so the bitmap feed is not merely better off without
 * history — it is unusable with it, and IO rejects the publish outright. The other
 * two carry small JSON payloads and want their history: device.js reads the status
 * feed as a BATCH of recent data points to reconstruct wakes it slept through, and a
 * history-off feed retains none to read.
 */
export const MARQUEE_FEEDS = [
  { key: 'bitmap', name: 'Bitmap', rowId: 'a5bFeedBitmap', history: false },
  { key: 'sleep', name: 'Sleep', rowId: 'a5bFeedSleep', history: true },
  { key: 'status', name: 'Status', rowId: 'a5bFeedStatus', history: true },
];

/** How long to wait before the single retry. One beat, not a backoff curve —
 *  there is only ever one retry, so a schedule would be a fiction. */
const RETRY_DELAY_MS = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One authenticated request to Adafruit IO, with the retry policy applied.
 *
 * Resolves to `{ ok: true, status, data }` or `{ ok: false, status, error }` and
 * never rejects — callers branch on `status`, so an exception would just be a second
 * way to say the same thing. `status` is 0 when the request never reached IO.
 *
 * Retries EXACTLY ONCE, and only for the failures that are worth retrying: a network
 * error or a 5xx. A 401 is not going to become a 200, and a 403 is a plan limit that
 * retrying would only push the account further into.
 */
async function ioFetch(path, key, { method = 'GET', body = null, retry = true } = {}) {
  const host = ioHost();
  // The key rides in the header and nowhere else. It is in the URL of exactly zero
  // requests, which is what keeps it out of proxy logs and browser history.
  const headers = { 'X-AIO-Key': key };
  if (body) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`https://${host}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    if (retry) {
      await sleep(RETRY_DELAY_MS);
      return ioFetch(path, key, { method, body, retry: false });
    }
    return { ok: false, status: 0, error: `Could not reach ${host}` };
  }

  if (res.status >= 500 && retry) {
    await sleep(RETRY_DELAY_MS);
    return ioFetch(path, key, { method, body, retry: false });
  }

  const data = await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: res.status, data };
  return { ok: false, status: res.status, error: errorText(res.status, data) };
}

/** IO's own message when it sends one, otherwise something that names the status. */
function errorText(status, data) {
  const said = data && (data.error || (Array.isArray(data.errors) && data.errors.join(', ')));
  return said || `Adafruit IO replied ${status}`;
}

const enc = encodeURIComponent;

/**
 * Look for the group — and, in the same request, prove the credentials.
 *
 * This is the ONLY read A5b makes before it starts writing, and it carries both jobs
 * on purpose. A separate credential check was tried first and was a mistake twice
 * over: `GET /{username}/user` is not a real endpoint (IO answers 404 "that is an
 * invalid URL", which surfaced as a nonsense error on a perfectly good key), and even
 * a valid one would have been a second request to learn something this one already
 * says. A bad key 401s here exactly as it would anywhere else, and a 401 on a GET
 * means no POST was ever attempted — which is the whole guarantee that check existed
 * to provide.
 *
 * Resolves `{ ok: true, data: null }` on a 404: an absent group is the expected answer
 * on a first run, not a failure, and collapsing it into the error channel would have
 * the caller reading error strings to decide whether to create one.
 */
export async function getGroup(user, key, groupKey) {
  const raw = await ioFetch(`/api/v2/${enc(user)}/groups/${enc(groupKey)}`, key);
  // Map BEFORE logging. A 404 here is the ordinary first-run answer, and logging off
  // the raw result reported every fresh setup as "failed (404)" — the one reading in
  // this file that is not a failure, printed as the only kind of thing it is not.
  const out = (!raw.ok && raw.status === 404) ? { ok: true, status: 404, data: null } : raw;
  ioLog('group  ', groupKey, out.ok
    ? (out.data ? 'exists — reusing it' : 'does not exist — will create')
    : `lookup failed (${out.status}) ${out.error}`);
  return out;
}

/**
 * Create the group, with the key stated rather than left to IO.
 *
 * IO will slugify the name into a key on its own, and its rules are not exactly
 * ours — so an unstated key is a key that might not match the one A5b has already
 * shown the user and is about to write into settings.toml. Stating it makes the
 * preview line a promise instead of a guess. It is a promise IO can still refuse,
 * which is why the caller re-reads `key` off the response rather than assuming.
 *
 * The docs give this one as form-encoded with a top-level `name` and say nothing
 * about `key`, so the flat JSON below is the same shape in the encoding the rest of
 * this file uses. A 422 is read as "it wanted the wrapper" rather than as a dead
 * end, since IO's own docs show that form elsewhere.
 */
export async function createGroup(user, key, groupKey, name) {
  const path = `/api/v2/${enc(user)}/groups`;
  let out = await ioFetch(path, key, { method: 'POST', body: { name, key: groupKey } });
  if (!out.ok && out.status === 422) {
    ioLog('create ', groupKey, 'flat body rejected (422) — retrying wrapped');
    out = await ioFetch(path, key, { method: 'POST', body: { group: { name, key: groupKey } } });
  }
  ioLog('create ', groupKey, out.ok
    ? `group created as "${name}" (IO returned key ${out.data?.key ?? '?'})`
    : `group creation failed (${out.status}) ${out.error}`);
  return out;
}

/**
 * Create one feed inside the group. Same wrapper caveat as createGroup(), except
 * here the docs agree on `{feed: {...}}`, so that is what goes first.
 *
 * Called SEQUENTIALLY by A5b, never in parallel: IO counts every group and feed
 * CREATE against the account-wide rate limit, and three concurrent writes on a free
 * account is a good way to have the third one rejected for a reason that has nothing
 * to do with what the user typed.
 */
export async function createGroupFeed(user, key, groupKey, feed) {
  const { key: feedKey, name: feedName, history } = feed;
  // The full key as the rest of the app will address it, not the bare `bitmap` the
  // POST body carries — the group-qualified form is what a publish or a read will
  // later go looking for, so it is the one worth being able to grep the log for.
  const fullKey = `${groupKey}.${feedKey}`;
  const out = await ioFetch(`/api/v2/${enc(user)}/groups/${enc(groupKey)}/feeds`, key, {
    method: 'POST',
    body: { feed: { name: feedName, key: feedKey, history } },
  });
  ioLog('create ', fullKey, out.ok
    ? `feed created as "${feedName}", history ${history ? 'on' : 'OFF'}`
    : `feed creation failed (${out.status}) ${out.error}`);
  return out;
}

/**
 * The feeds a group already holds, indexed by BARE key.
 *
 * Keyed on the last dot-segment because IO is not consistent about which form it
 * hands back — a grouped feed's `key` comes through as `bitmap` in some responses and
 * `marquee-magtag.bitmap` in others, and reading the wrong one would have A5b decide
 * every feed was missing and try to create it again on every retry.
 *
 * The whole feed object rather than just the key, because "does it exist" is not the
 * only question worth asking of one that does: a bitmap feed someone created by hand
 * with history on will take our publishes and reject every one of them.
 */
export function feedsIn(group) {
  const feeds = (group && group.feeds) || [];
  return new Map(feeds.map((f) => [String(f.key || '').split('.').pop(), f]));
}
