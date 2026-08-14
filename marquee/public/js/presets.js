/**
 * The supported-panel catalog.
 *
 * One entry per board Marquee knows how to fill in. Each carries both halves of
 * what the flow needs: the marketing side A4 shows on a product card (label,
 * spec line, search terms) and the wiring side A5 writes into the display
 * descriptor (resolution, rotation, color mode, driver, panel id, SPI pins).
 *
 * Rotation and resolution are the UNROTATED framebuffer as the firmware sees it,
 * with `rotation` as the clockwise 90° step the device applies on top. That
 * distinction matters for every panel whose native buffer is portrait — the two
 * 2.13" entries and the MagTag — because adafruit_epd's constructor takes exactly
 * that native pair: Adafruit_SSD1680(122, 250), Adafruit_SSD1680(128, 296),
 * Adafruit_SSD1683(400, 300), Adafruit_UC8179(800, 480). Storing the rotated
 * geometry at rotation 0 instead would build a driver with its width and height
 * transposed, so `preset` here is always the datasheet scan order and `rotation`
 * is what turns it into the orientation the product is used in.
 */

export const DISPLAY_PRESETS = {
  // Adafruit MagTag (2025): 2.9" mono e-ink, SSD1680. The panel scans portrait —
  // Adafruit_SSD1680(128, 296) — so the landscape 296×128 everyone knows it by is
  // a rotation on top of that, not a rotation-0 buffer. 270 rather than 90 to
  // match quad213 below and the library's own examples, which land on index 3 for
  // every portrait-native panel; the two differ by a 180° flip, so if a board
  // comes up upside down this is the single field to change.
  magtag: {
    label: 'MagTag 2.9"',
    spec: '296×128 · mono · SSD1680',
    terms: 'magtag 2.9 esp32-s2 mono ssd1680',
    preset: '128x296', rotation: '270', mode: 'mono',
    name: 'epd0', driver: 'SSD1680', panel: 'adafruit-magtag',
    pins: { busy: 'D5', dc: 'D7', rst: 'D6', cs: 'D8', sramCs: '', mosi: 'D35', sck: 'D36', bus: 0 },
  },

  // Adafruit 2.13" HD Tri-Color eInk / ePaper FeatherWing: RW, SSD1680. Native
  // buffer is 122×250 portrait — Adafruit_SSD1680(122, 250) — rotated into the
  // 250×122 landscape the FeatherWing is used in. Same 270-not-90 reasoning as
  // the MagTag above.
  // EPD pins per the FeatherWing #defines (EPD_CS=9, EPD_DC=10, SRAM_CS=6,
  // RESET/BUSY shared → -1). MOSI/SCK are the Feather's hardware SPI bus (35/36).
  // Pins are D-prefixed because the device's parsePin() only accepts "D<n>";
  // "-1" is left bare so parsePin() resolves it to -1 ("pin not used").
  tricolorFW: {
    label: '2.13" Tri-Color FeatherWing',
    spec: '250×122 · black/white/red · SSD1680',
    terms: '2.13 tricolor tri-color featherwing red ssd1680',
    preset: '122x250', rotation: '270', mode: 'tricolor',
    name: 'epd0', driver: 'SSD1680', panel: '213-tricolor-MFGNR',
    pins: { busy: '-1', dc: 'D10', rst: '-1', cs: 'D9', sramCs: 'D6', mosi: 'D35', sck: 'D36', bus: 0 },
  },

  // Adafruit 2.13" Quad-Color eInk / ePaper bare display: 250×122 BWRY, JD79661
  // (ThinkInk_213_Quadcolor_AJHE5 — Adafruit_JD79661(122, 250, ...)). The panel
  // size here is the UNROTATED framebuffer (122×250 portrait), because that's
  // what ships as DisplayProperties.width/height and what the device's
  // setRotation() is applied on top of. Rotation 270° (index 3) therefore lands
  // on a 250×122 landscape canvas — the same shape as the library's own begin()
  // default of setRotation(1), just flipped 180°.
  // EPD pins per the board's #defines (EPD_DC=6, EPD_CS=5, EPD_BUSY=12,
  // EPD_RESET=11); no SRAM chip, so SRAM_CS is -1.
  quad213: {
    label: '2.13" Quad-Color',
    spec: '250×122 · black/white/red/yellow · JD79661',
    terms: '2.13 quad quadcolor bwry yellow jd79661 6373',
    preset: '122x250', rotation: '270', mode: 'quadcolor',
    name: 'epd0', driver: 'JD79661', panel: '213-quad-AJHE5',
    pins: { busy: 'D12', dc: 'D6', rst: 'D11', cs: 'D5', sramCs: '-1', mosi: 'D35', sck: 'D36', bus: 0 },
  },

  // Adafruit 4.2" Tri-Color eInk / ePaper bare display: 400×300 RW, SSD1683
  // (ThinkInk_420_Tricolor_MFGNR). EPD pins per the board's #defines
  // (EPD_DC=10, EPD_CS=9, EPD_BUSY=7, SRAM_CS=6, EPD_RESET=8) — unlike the 2.13"
  // FeatherWing this panel breaks out real BUSY and RESET pins, so neither is -1.
  tricolor42: {
    label: '4.2" Tri-Color',
    spec: '400×300 · black/white/red · SSD1683',
    terms: '4.2 420 tricolor tri-color red ssd1683',
    preset: '400x300', rotation: '0', mode: 'tricolor',
    name: 'epd0', driver: 'SSD1683', panel: '420-tricolor-MFGNR',
    pins: { busy: 'D7', dc: 'D10', rst: 'D8', cs: 'D9', sramCs: 'D6', mosi: 'D35', sck: 'D36', bus: 0 },
  },

  // Adafruit 4.2" Grayscale eInk / ePaper bare display: 400×300 4-level gray,
  // SSD1683 (ThinkInk_420_Grayscale4_MFGN). BUSY and RESET aren't wired here, so
  // both are -1 ("pin not used") like the 2.13" FeatherWing.
  gray42: {
    label: '4.2" Grayscale',
    spec: '400×300 · 4 grays · SSD1683',
    terms: '4.2 420 grayscale gray 4-level ssd1683',
    preset: '400x300', rotation: '0', mode: 'gray4',
    name: 'epd0', driver: 'SSD1683', panel: '420-gray-MFGN',
    pins: { busy: '-1', dc: 'D10', rst: '-1', cs: 'D9', sramCs: 'D6', mosi: 'D35', sck: 'D36', bus: 0 },
  },

  // Adafruit 7.5" Mono eInk / ePaper bare display: 800×480 mono, UC8179
  // (ThinkInk_750_Mono_AAAMFGN). Same SPI EPD wiring as the 4.2" grayscale above,
  // BUSY and RESET included (-1, i.e. not wired). No SRAM chip either.
  mono75: {
    label: '7.5" Mono',
    spec: '800×480 · mono · UC8179',
    terms: '7.5 750 mono uc8179 large',
    preset: '800x480', rotation: '0', mode: 'mono',
    name: 'epd0', driver: 'UC8179', panel: '750-mono-AAAMFGN',
    pins: { busy: '-1', dc: 'D10', rst: '-1', cs: 'D9', sramCs: '-1', mosi: 'D35', sck: 'D36', bus: 0 },
  },

  // Adafruit 7.5" Tri-Color eInk / ePaper bare display: 800×480 RW, UC8179.
  // Same panel family and SPI EPD wiring as the 7.5" mono above — only the color
  // mode differs.
  tri75: {
    label: '7.5" Tri-Color',
    spec: '800×480 · black/white/red · UC8179',
    terms: '7.5 750 tricolor tri-color red uc8179 large',
    preset: '800x480', rotation: '0', mode: 'tricolor',
    name: 'epd0', driver: 'UC8179', panel: '750-tricolor-AABMFGNR',
    pins: { busy: '-1', dc: 'D10', rst: '-1', cs: 'D9', sramCs: '-1', mosi: 'D35', sck: 'D36', bus: 0 },
  },
};

export const PRESET_KEYS = Object.keys(DISPLAY_PRESETS);

/**
 * Driver string -> the CircuitPython class that drives it. This is the whole
 * reason cfg-marquee.json can be executed rather than just read: without it a
 * consumer knows the panel is an SSD1680 but not that the import it wants is
 * `from adafruit_epd.ssd1680 import Adafruit_SSD1680`.
 *
 * Verified against Adafruit_CircuitPython_EPD @ main. Every constructor in the
 * library takes the same shape — `(width, height, spi, *, cs_pin, dc_pin,
 * sramcs_pin, rst_pin, busy_pin)`, keyword-only after `spi` — so the only things
 * that vary per driver are the class name, the grayscale variant, and whether the
 * class accepts `tri_color`. Those three are what this table records.
 *
 * A driver absent from this map is not an error, it is a panel we cannot generate
 * CircuitPython for. The emitter writes `class: null` and lets the consumer refuse
 * cleanly, which is why ST7789 (a TFT, not an EPD) is deliberately not here.
 *
 *   module        the import path
 *   cls           the default class
 *   gray4         the 4-level-grayscale subclass, where the driver has one. A
 *                 gray4 panel driven by the base class silently loses two shades.
 *   tricolor      subclass to use for a red/white panel, where the driver splits
 *                 mono and tricolor into separate classes rather than a kwarg
 *   mono          ditto, for mono
 *   triColorKwarg the class takes `tri_color=True` instead of having subclasses
 */
export const EPD_DRIVERS = {
  EK79686:  { module: 'adafruit_epd.ek79686',  cls: 'Adafruit_EK79686' },
  IL0373:   { module: 'adafruit_epd.il0373',   cls: 'Adafruit_IL0373' },
  IL0398:   { module: 'adafruit_epd.il0398',   cls: 'Adafruit_IL0398' },
  IL91874:  { module: 'adafruit_epd.il91874',  cls: 'Adafruit_IL91874' },
  // Quad-color. Note this class shadows the base colour constants:
  // BLACK=0, WHITE=1, YELLOW=2, RED=3, where Adafruit_EPD has INVERSE=2, RED=3.
  // Resolving ink by NAME off the driver class — not by integer — is what keeps
  // that difference from becoming a red/yellow swap.
  JD79661:  { module: 'adafruit_epd.jd79661',  cls: 'Adafruit_JD79661' },
  JD79667:  { module: 'adafruit_epd.jd79667',  cls: 'Adafruit_JD79667' },
  SSD1608:  { module: 'adafruit_epd.ssd1608',  cls: 'Adafruit_SSD1608' },
  SSD1675:  { module: 'adafruit_epd.ssd1675',  cls: 'Adafruit_SSD1675' },
  SSD1675B: { module: 'adafruit_epd.ssd1675b', cls: 'Adafruit_SSD1675B' },
  SSD1680:  { module: 'adafruit_epd.ssd1680',  cls: 'Adafruit_SSD1680',
              gray4: 'Adafruit_SSD1680_Grayscale4' },
  SSD1680B: { module: 'adafruit_epd.ssd1680b', cls: 'Adafruit_SSD1680B' },
  SSD1681:  { module: 'adafruit_epd.ssd1681',  cls: 'Adafruit_SSD1681' },
  SSD1683:  { module: 'adafruit_epd.ssd1683',  cls: 'Adafruit_SSD1683',
              gray4: 'Adafruit_SSD1683_Grayscale4' },
  UC8151D:  { module: 'adafruit_epd.uc8151d',  cls: 'Adafruit_UC8151D' },
  UC8179:   { module: 'adafruit_epd.uc8179',   cls: 'Adafruit_UC8179', triColorKwarg: true },
  UC8253:   { module: 'adafruit_epd.uc8253',   cls: 'Adafruit_UC8253',
              mono: 'Adafruit_UC8253_Mono', tricolor: 'Adafruit_UC8253_Tricolor' },
  // The A5 dropdown shipped a typo for a while; keep the alias so a stale
  // localStorage entry still resolves to a real class.
  ILI0373:  { module: 'adafruit_epd.il0373',   cls: 'Adafruit_IL0373' },
};

/**
 * Resolve a driver + colour mode to the class and constructor keywords to use.
 * Returns null when there is no CircuitPython driver for the part.
 */
export function driverFor(driverId, mode) {
  const d = EPD_DRIVERS[driverId];
  if (!d) return null;
  const cls = d[mode] || (mode === 'gray4' && d.gray4) || d.cls;
  const kwargs = {};
  // Only UC8179 is told its colour buffer by keyword; everywhere else the class
  // itself already knows, and restating a default is how you pin one that later
  // changes upstream.
  if (d.triColorKwarg && (mode === 'tricolor' || mode === 'quadcolor')) kwargs.tri_color = true;
  return { module: d.module, cls, kwargs };
}

/** Free-text match over the label, spec and the extra search terms. */
export function searchPresets(query) {
  const q = query.trim().toLowerCase();
  if (!q) return PRESET_KEYS;
  return PRESET_KEYS.filter((k) => {
    const p = DISPLAY_PRESETS[k];
    return `${p.label} ${p.spec} ${p.terms}`.toLowerCase().includes(q);
  });
}
