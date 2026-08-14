/**
 * The display descriptor the whole render pipeline reads, plus the panel
 * palettes it quantizes to.
 *
 * `display` is mutable shared state on purpose: it is the one object that the
 * editor, the config form, the render backend call and the /display/add
 * descriptor all agree on. Everything that changes it also has to re-fit the
 * canvas and invalidate any dither preview — see config.js, which owns the form
 * bindings that do exactly that.
 */

/**
 * Seeded with the MagTag, matching the DISPLAY_PRESETS entry and the HTML
 * defaults in index.html. width/height are the panel's NATIVE scan geometry —
 * the 2.9" is a portrait 128×296 buffer — and `rotation` is what turns it into
 * the 296×128 landscape the product is used in. logicalDims() below is the one
 * that answers "how big is the canvas".
 */
export const display = {
  width: 128,        // physical panel width, before rotation
  height: 296,       // physical panel height, before rotation
  rotation: 270,     // 0 | 90 | 180 | 270 (degrees)
  type: 'mono',      // mono | gray4 | tricolor | quadcolor
  dither: 'FloydSteinberg',
  diffusion: 85,
  orderedMap: 8,
};

/**
 * Extracted from the committed remap PNGs (palettes/*.png). These must stay in
 * sync with what `magick -remap` quantizes to, or the editor shows colors the
 * panel cannot produce.
 */
export const PAPER = '#F2F4EF';

export const PALETTES = {
  mono:      ['#2F2429', '#F2F4EF'],
  gray4:     ['#2F2429', '#70696B', '#B1AFAD', '#F2F4EF'],
  tricolor:  ['#2F2429', '#F2F4EF', '#D72627'],
  // black/white/red/yellow; red+yellow from the product 6373 datasheet
  quadcolor: ['#2F2429', '#F2F4EF', '#FD2A00', '#FFFF03'],
};

/** Display type -> ImageMagick -remap palette file. The backend contract. */
export const REMAP_FILES = {
  mono:      'eink-2color.png',
  tricolor:  'eink-3color.png',
  gray4:     'eink-4gray.png',
  quadcolor: 'eink-4color.png',
};

export const MODE_LABELS = {
  mono: 'mono',
  gray4: '4 grays',
  tricolor: 'black/white/red',
  quadcolor: 'black/white/red/yellow',
};

/** Logical canvas dimensions once rotation is applied. */
export function logicalDims() {
  const swap = display.rotation % 180 !== 0;
  return {
    w: swap ? display.height : display.width,
    h: swap ? display.width : display.height,
  };
}

export function hexToRGB(hex) {
  if (typeof hex !== 'string') return [0, 0, 0]; // elements without a fill (e.g. images)
  const v = hex.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/**
 * A palette entry is "neutral" when its channels are near-equal. Derived rather
 * than hardcoded so a new palette gets the right behaviour for free. The
 * paper/ink hexes aren't pure greys (#2F2429, #F2F4EF), hence the tolerance
 * rather than r === g === b.
 *   mono / tricolor / quadcolor -> [ink, paper];  gray4 -> all four shades.
 */
export function isNeutralHex(hex) {
  const [r, g, b] = hexToRGB(hex);
  return Math.max(r, g, b) - Math.min(r, g, b) <= 24;
}

export function neutralShades() {
  return PALETTES[display.type].filter(isNeutralHex);
}

/**
 * Roughly how long this panel takes to put a new image on the glass, in seconds.
 *
 * E-ink refresh is a physical process, so it scales with BOTH the color mode and
 * the panel area: a mono 2.9" clears in a couple of seconds, while a four-color
 * 7.5" spends most of half a minute cycling its particles. These are
 * datasheet-order FULL refresh times — a board waking from deep sleep has no
 * previous frame to do a partial update against — fitted as a floor plus a
 * per-megapixel slope:
 *
 *   mono       2.9" ≈  2s    7.5" ≈  5s
 *   gray4      2.9" ≈  3s    7.5" ≈  8s
 *   tricolor   2.9" ≈ 14s    7.5" ≈ 25s
 *   quadcolor  2.9" ≈ 19s    7.5" ≈ 30s
 *
 * An estimate, and used only where being EARLY is the failure — see A8's
 * clapperboard, which would otherwise call a redraw overdue while the panel is
 * still visibly flashing.
 */
const REFRESH_FIT = {
  mono:      { base: 1.5, perMpx: 8 },
  gray4:     { base: 3,   perMpx: 12 },
  tricolor:  { base: 13,  perMpx: 30 },
  quadcolor: { base: 18,  perMpx: 30 },
};

export function panelRefreshSeconds() {
  const { base, perMpx } = REFRESH_FIT[display.type] || REFRESH_FIT.mono;
  // Native geometry, not logicalDims(): rotation doesn't change how many pixels
  // the driver has to cycle.
  return Math.round(base + perMpx * (display.width * display.height) / 1e6);
}

/** Human-readable summary of the active dither method + its parameter. */
export function ditherLabel() {
  if (display.dither === 'none') return 'no dither';
  if (display.dither === 'ordered') return `ordered o${display.orderedMap}×${display.orderedMap}`;
  return `Floyd–Steinberg ${display.diffusion}%`;
}
