/**
 * Where the two services this editor talks to live.
 *
 *   BACKEND — the render/echo server in ../server.js. Empty string means same
 *   origin, because the editor is served out of that server's public/ folder,
 *   so fetch('/render') just works.
 *
 *   ioHost() — Adafruit IO itself, which the browser calls directly for feed
 *   reads and datum publishes (the backend is not a proxy for those).
 */

export const BACKEND = '';

/** Editor dither names -> backend method names. */
export const BACKEND_METHOD = { FloydSteinberg: 'floyd', ordered: 'ordered', none: 'none' };

/**
 * IO datum size ceilings, in bytes of the base64 payload. We assume feed history
 * is OFF (the 512 KB ceiling) as the default setup; the 1 KB history-on tier is
 * recorded here for reference but is not what gating uses.
 */
export const IO_MAX_HISTORY = 1024;
export const IO_MAX_NO_HISTORY = 512 * 1024;

/**
 * The Adafruit IO host, for the whole app — feed reads, publishes, the group A5b
 * creates, and the ADAFRUIT_IO_HOST written into the code bundle.
 *
 * io.adafruit.com unless "Developer mode" is ticked under Settings, which moves
 * everything to the .us staging environment. Real accounts are on .com, so that is
 * the default and the opt-in is the unusual one — it used to be the other way round,
 * with a "Publish to Prod" box in the publish dialog, which both defaulted a user's
 * own account to the wrong host and read as a per-publish choice when every call in
 * the app resolves through here.
 */
export function ioHost() {
  return document.getElementById('ioDev')?.checked ? 'io.adafruit.us' : 'io.adafruit.com';
}

/**
 * One console line per Adafruit IO request, naming the FULL feed key it is aimed at.
 *
 * On by default and deliberately so. Every feed key in this app is now DERIVED — from
 * the group, from the device name, from a slug of something the user typed — and a
 * derivation that goes wrong produces a request to a plausible-looking feed that
 * simply is not the one anybody meant. The 404 that follows says the feed does not
 * exist; it does not say which feed was asked for, and that is the only fact worth
 * having. So the key is printed at the moment of the call, group-qualified and
 * username-scoped, exactly as it goes on the wire.
 *
 * Never logs the key — see ioFetch() in provision.js. `X-AIO-Key` is a header and
 * stays one.
 */
export function ioLog(action, feedKey, note = '') {
  const user = (document.getElementById('ioUser')?.value || '').trim() || '(no user)';
  console.log(`[io] ${action} ${user}/${feedKey || '(no feed)'} @ ${ioHost()}${note ? ` — ${note}` : ''}`);
}

/**
 * The Adafruit IO GROUP every feed this device uses lives in — one group per
 * device, created (or found) by A5b. It is the only feed identity the user sets;
 * the three feed keys below are all derived from it.
 *
 * This replaced a flat image-feed key with "-sleep" and "-status" siblings glued
 * on. Same idea — one name, three feeds, no way for them to drift apart — but the
 * group is a thing IO itself knows about, so A5b can ask whether it exists rather
 * than guessing from a naming convention.
 */
export function ioGroupKey() {
  return (document.getElementById('ioGroup')?.value || '').trim();
}

/**
 * The packed panel image the device renders. Written by the web app, read by the
 * board.
 *
 * Empty when no group is set, which publishToIO already reports as missing
 * credentials.
 */
export function bitmapFeedKey() {
  return groupFeed('bitmap');
}

/** The feed carrying the sleep window on the CircuitPython path — seconds until
 *  the next wake. See docs/marquee-sleep.md for the payload. */
export function sleepFeedKey() {
  return groupFeed('sleep');
}

/**
 * The feed the BOARD writes, reporting when it woke and when it went back to
 * sleep — the acknowledgement the CircuitPython path otherwise has none of.
 *
 * Board -> editor only, which is the whole reason it is not the sleep feed: that
 * one is read by code.py as "the last value is my window", and a board writing its
 * own status there would shadow its own config within one cycle. One writer per
 * feed keeps /data/last unambiguous in both directions.
 *
 * See docs/marquee-status.md for the payload.
 */
export function statusFeedKey() {
  return groupFeed('status');
}

/**
 * A feed inside the device's group, in IO's group-qualified form:
 * "marquee-magtag" + "bitmap" -> "marquee-magtag.bitmap".
 *
 * That dotted key is what the /feeds/{key}/… endpoints take for a grouped feed, and
 * encodeURIComponent leaves the dot alone, so every existing call site addresses it
 * without special-casing.
 */
function groupFeed(name) {
  const group = ioGroupKey();
  return group ? `${group}.${name}` : '';
}
