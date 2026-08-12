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
