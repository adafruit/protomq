/**
 * Konva is vendored as a UMD bundle (js/vendor/konva.js) and loaded by a classic
 * <script> tag ahead of the module graph, so it registers on the global before
 * anything here runs. This module is the single place that reaches for that
 * global — everything else imports `Konva` from here, so if the bundle is ever
 * swapped for a real ES module only this file changes.
 */
export const Konva = globalThis.Konva;

if (!Konva) {
  document.body.innerHTML =
    '<div style="display:grid;place-items:center;height:100vh;font-family:monospace;padding:24px;text-align:center;">'
    + 'The bundled Konva library failed to load.<br>Check that js/vendor/konva.js is being served.</div>';
  throw new Error('Konva failed to load');
}
