/**
 * cfg-marquee.json — the device-facing display descriptor.
 *
 * What it takes to bring the panel up on the board and nothing else: the driver
 * part, the native framebuffer, the rotation, the colour mode, and the pinout.
 * It is the CircuitPython counterpart to buildDisplayBody(), which serves the
 * WipperSnapper protobuf path — same facts, different consumer, so the two are
 * kept as separate serialisers rather than one contorted shape.
 *
 * Deliberately NOT here: the feed key and the AIO credentials (settings.toml owns
 * those), the sleep window (the live device gets it from the broker's wake
 * response, and code.py keeps its own default), and anything about the image on
 * the wire. This file describes hardware.
 *
 * Four conventions are load-bearing and explained at their definitions below:
 * native geometry, null for an unwired pin, the `board.`-prefixed pin names, and an
 * omitted `colstart` rather than a stated zero. See docs/cfg-marquee.md.
 */

import { buildDisplayBody } from './config.js';
import { ifaceTypeFor } from './presets.js';
import { val } from './util.js';

export const CFG_VERSION = 2;

/**
 * The form has two spellings for "this pin is not wired" — an empty field and the
 * literal "-1" that the WipperSnapper parsePin() wants. JSON gets one: null. A
 * consumer writes `if p is None` and is done.
 *
 * A wired pin is emitted as the CircuitPython expression that resolves it —
 * `"board.D5"`, not `"D5"` — because that is the name the consumer of this file
 * actually types. The form keeps the bare `"D5"` the protobuf path needs; the
 * namespace is attached here, on the way out, and nowhere else.
 */
function normPin(v) {
  const s = (v ?? '').toString().trim();
  if (s === '' || s === '-1') return null;
  return s.startsWith('board.') ? s : `board.${s}`;
}

/**
 * The panel's column offset, or null when it has none.
 *
 * `colstart` is the pixel shift between the framebuffer and the controller's column
 * RAM, which is a per-panel-revision fact rather than a per-part one: the two 2.13"
 * tri-colors are both 122x250 SSD1680s driven by the same class, and the only thing
 * that stops one from drawing 8 pixels off is this number (+8 on the FeatherWing,
 * -8 on the SSD1680Z breakout, per Adafruit's own note that the breakout "has a
 * different 'offset' than previous panels").
 *
 * OMITTED rather than emitted as 0 when the field is blank. Most panels have no
 * offset to state, and a `"colstart": 0` on every one of them would read as a
 * measured value when it is really just the absence of one — so absent means "no
 * shift", which is the same thing the adafruit_epd default already does. That also
 * makes the field additive: a consumer written against a descriptor without it
 * keeps working, and only a panel that needs the shift carries it.
 *
 * It is NOT in buildDisplayBody(): ws_display_DisplayProperties has no field for a
 * column offset, so the WipperSnapper path has nowhere to put it and reads the
 * form directly here instead of routing through a body that would drop it.
 */
function colstart() {
  const s = val('pmColstart');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n !== 0 ? Math.trunc(n) : null;
}

/**
 * Build the descriptor. Reads the live form, so it is valid to call at any time
 * after initConfig().
 */
export function buildMarqueeCfg() {
  const body = buildDisplayBody();
  const iface = body.interface.spiEpd;
  const type = ifaceTypeFor(body.panel);
  const cols = colstart();

  return {
    cfg_version: CFG_VERSION,

    name: val('marqueeName') || 'Marquee',

    display: {
      driver: body.driver,
      panel: body.panel,
      // width/height are the NATIVE, unrotated framebuffer: exactly the first two
      // positional arguments of the adafruit_epd constructor, in that order. They
      // are frequently not the dimensions the panel is sold as — the 2.9" is a
      // portrait 128x296 buffer that reaches its familiar 296x128 landscape via
      // `rotation`. Transposing them does not error, it draws noise.
      width: body.width,
      height: body.height,
      rotation: body.rotation,        // 0..3 quarter-turns, what epd.rotation takes
      mode: body.mode,                // mono | gray4 | tricolor | quadcolor
      // Present only for a panel that needs it — see colstart() above.
      ...(cols === null ? {} : { colstart: cols }),
    },

    // How the consumer gets a drawing surface, per ifaceTypeFor(). A board with the
    // panel soldered on hands it over as board.DISPLAY, so `builtin` carries no bus
    // and no pinout: the pins the form holds for such a board belong to the
    // WipperSnapper firmware, and are not `board` attributes on the board itself.
    // Repeating them here as if they were is how a MagTag bundle ends up calling
    // getattr(board, "D8") and dying on the first line that touches the panel.
    interface: type === 'builtin' ? { type } : {
      type,
      spi: {
        bus: iface.spi.bus,
        mosi: normPin(iface.spi.pinMosi),
        sck: normPin(iface.spi.pinSck),
      },
      pins: {
        cs: normPin(iface.spi.pinCs),
        dc: normPin(iface.pinDc),
        reset: normPin(iface.pinRst),
        busy: normPin(iface.pinBusy),
        sram_cs: normPin(iface.pinSramCs),
      },
    },
  };
}

/** The descriptor as it is written into the bundle. */
export function cfgMarqueeJson() {
  return JSON.stringify(buildMarqueeCfg(), null, 2) + '\n';
}

/**
 * Fires whenever a downloaded bundle stops matching the editor.
 *
 * The descriptor is most of what a bundle bakes in, but not all of it: the feed
 * key and the AIO credentials live in settings.toml, and changing any of them
 * makes the copy on the board just as wrong as a re-pin does. Hence the second
 * half — without it, switching feeds would silently leave the board polling the
 * old one. Dashboard edits are deliberately absent; they arrive over the air on
 * the feed the bundle already reads.
 *
 * Lives here rather than in config.js so the import runs one way (cfg -> config)
 * and the module graph stays acyclic.
 */
export function configSignature() {
  return JSON.stringify({
    cfg: buildMarqueeCfg(),
    feed: val('ioFeed'),
    user: val('ioUser'),
    key: val('ioKey'),
  });
}
