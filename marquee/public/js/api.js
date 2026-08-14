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

/** Target host: prod when the "Publish to Prod" box is ticked, else .us. */
export function ioHost() {
  return document.getElementById('ioProd')?.checked ? 'io.adafruit.com' : 'io.adafruit.us';
}

/**
 * The sibling feed carrying the sleep window on the CircuitPython path — the
 * image feed's key with "-sleep" appended, so "marquee" pairs with
 * "marquee-sleep" and a renamed feed keeps its pair.
 *
 * Derived rather than configured: two feed keys that can drift apart is two ways
 * for a board to end up reading one and not the other. Empty when no image feed
 * is set, which publishToIO already reports as missing credentials.
 */
export function sleepFeedKey() {
  return siblingFeed('sleep');
}

/**
 * The sibling feed the BOARD writes, reporting when it woke and when it went back
 * to sleep — the acknowledgement the CircuitPython path otherwise has none of.
 *
 * Board -> editor only, which is the whole reason it is not the sleep feed: that
 * one is read by code.py as "the last value is my window", and a board writing its
 * own status there would shadow its own config within one cycle. One writer per
 * feed keeps /data/last unambiguous in both directions.
 *
 * See docs/marquee-status.md for the payload.
 */
export function statusFeedKey() {
  return siblingFeed('status');
}

/** The image feed's key with a suffix, so "marquee" pairs with "marquee-sleep" and
 *  "marquee-status", and renaming the image feed carries all three together. */
function siblingFeed(suffix) {
  const feed = (document.getElementById('ioFeed')?.value || '').trim();
  return feed ? `${feed}-${suffix}` : '';
}
