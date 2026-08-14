/**
 * Font Awesome 6 Free (Solid) glyphs, for the gauge's optional icon and the
 * inspector's "Connect to IO Feed" chainlink.
 *
 * The font is VENDORED (css/tokens.css @font-face -> fonts/fa-solid-900.woff2)
 * rather than loaded from a CDN, for the same reason Konva is: an icon is drawn
 * as Konva text onto the 2D canvas that becomes the BMP handed to a physical
 * panel, so a missing font is not a cosmetic fallback — it bakes a tofu box into
 * the artwork. Vendored, it either serves or the whole app fails loudly.
 *
 * Codepoints are written as \u escapes, not literal Private Use Area characters:
 * the literals are invisible in every editor and diff, so a wrong one is
 * undetectable by reading. They were read out of the release's own
 * metadata/icons.json (fontawesome-free-6.7.2-web) and each is confirmed present
 * in the FREE Solid set — much of Font Awesome is Pro-only, so look a new id up
 * there rather than guessing it.
 */

export const FA_FAMILY = 'Font Awesome 6 Free';
export const FA_WEIGHT = '900';

/** The chainlink on the bind buttons (fa-link). */
export const FA_LINK = '\uf0c1';

/**
 * Offered in the gauge's Icon dropdown. Ordered by how likely a panel is to want
 * one, not alphabetically — a temperature gauge is the common case. Labels name
 * the MEASUREMENT rather than the drawing, since that's what the user is picking.
 */
export const GAUGE_ICONS = [
  { id: 'temperature-half', label: 'Temperature', glyph: '\uf2c9' },
  { id: 'droplet',          label: 'Humidity',    glyph: '\uf043' },
  { id: 'gauge-high',       label: 'Pressure',    glyph: '\uf625' },
  { id: 'wind',             label: 'Wind',        glyph: '\uf72e' },
  { id: 'sun',              label: 'Light',       glyph: '\uf185' },
  { id: 'cloud',            label: 'Cloud',       glyph: '\uf0c2' },
  { id: 'bolt',             label: 'Power',       glyph: '\uf0e7' },
  { id: 'battery-half',     label: 'Battery',     glyph: '\uf242' },
  { id: 'wifi',             label: 'Signal',      glyph: '\uf1eb' },
  { id: 'leaf',             label: 'Air quality', glyph: '\uf06c' },
  { id: 'fire',             label: 'Heat',        glyph: '\uf06d' },
  { id: 'water',            label: 'Water',       glyph: '\uf773' },
  { id: 'clock',            label: 'Time',        glyph: '\uf017' },
  { id: 'bell',             label: 'Alert',       glyph: '\uf0f3' },
];

export const DEFAULT_GAUGE_ICON = 'temperature-half';

const BY_ID = new Map(GAUGE_ICONS.map((i) => [i.id, i]));

/**
 * Unknown ids fall back to the default rather than drawing nothing — an icon the
 * user explicitly switched on should never silently vanish because a saved doc
 * names an id this build dropped.
 */
export function iconGlyph(id) {
  return (BY_ID.get(id) || BY_ID.get(DEFAULT_GAUGE_ICON)).glyph;
}

// ---------- the font-ready gate ---------------------------------------------
//
// Canvas text needs the face actually loaded, and @font-face loading is lazy: the
// first paint after a cold load would draw a substitute glyph, and the dither
// preview would cache that. So icon-bearing widgets are re-built once the face
// resolves.

let readyPromise = null;

export function faReady() {
  if (readyPromise) return readyPromise;
  readyPromise = document.fonts
    ? document.fonts.load(`${FA_WEIGHT} 16px "${FA_FAMILY}"`).then(() => true, () => false)
    : Promise.resolve(false);
  return readyPromise;
}

/**
 * Run `fn` once the face has resolved. Never rejects: a failed load leaves the
 * browser's substitute glyph, which is visible and reportable, rather than
 * throwing from inside a widget rebuild.
 */
export function onFaReady(fn) {
  faReady().then(fn);
}
