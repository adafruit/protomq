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
 * distinction matters for the quad-color panel, whose native buffer is portrait.
 */

export const DISPLAY_PRESETS = {
  // Adafruit MagTag (2025): 2.9" 296×128 mono e-ink, SSD1680.
  magtag: {
    label: 'MagTag 2.9"',
    spec: '296×128 · mono · SSD1680',
    terms: 'magtag 2.9 esp32-s2 mono ssd1680',
    preset: '296x128', rotation: '0', mode: 'mono',
    name: 'epd0', driver: 'SSD1680', panel: 'adafruit-magtag',
    pins: { busy: 'D5', dc: 'D7', rst: 'D6', cs: 'D8', sramCs: '', mosi: 'D35', sck: 'D36', bus: 0 },
  },

  // Adafruit 2.13" HD Tri-Color eInk / ePaper FeatherWing: 250×122 RW, SSD1680.
  // EPD pins per the FeatherWing #defines (EPD_CS=9, EPD_DC=10, SRAM_CS=6,
  // RESET/BUSY shared → -1). MOSI/SCK are the Feather's hardware SPI bus (35/36).
  // Pins are D-prefixed because the device's parsePin() only accepts "D<n>";
  // "-1" is left bare so parsePin() resolves it to -1 ("pin not used").
  tricolorFW: {
    label: '2.13" Tri-Color FeatherWing',
    spec: '250×122 · black/white/red · SSD1680',
    terms: '2.13 tricolor tri-color featherwing red ssd1680',
    preset: '250x122', rotation: '0', mode: 'tricolor',
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

/** Free-text match over the label, spec and the extra search terms. */
export function searchPresets(query) {
  const q = query.trim().toLowerCase();
  if (!q) return PRESET_KEYS;
  return PRESET_KEYS.filter((k) => {
    const p = DISPLAY_PRESETS[k];
    return `${p.label} ${p.spec} ${p.terms}`.toLowerCase().includes(q);
  });
}
