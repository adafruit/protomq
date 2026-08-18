# `cfg-marquee.json` — spec v2

The device-facing display descriptor Marquee ships inside the CircuitPython
bundle. What it takes to bring the panel up on the board, and nothing else: the
driver part, the native framebuffer, the rotation, the colour mode, and the
pinout.

- **Producer:** `public/js/cfg.js`, `buildMarqueeCfg()`. Sourced from Act I of the
  wizard (screens A3–A5).
- **Consumer:** `code.py` on a CIRCUITPY drive, targeting
  [`adafruit_epd`](https://github.com/adafruit/Adafruit_CircuitPython_EPD).

This file replaces `marquee_config.json` (v1), which described the panel but not
the geometry needed to construct a driver from it.

**Deliberately not here.** The Adafruit IO feed key, username and API key live in
`settings.toml` alongside the WiFi credentials — that file describes the account
the board talks to, this one describes the hardware. The artwork lives in
`canvas.json` (`public/js/doc.js`), which carries no pins or identity.

Nor is the **sleep window**, which has a feed of its own —
[`marquee-sleep.md`](marquee-sleep.md). On the WipperSnapper path the editor's
refresh interval configures the live device as `durSeconds` in the broker's wake
response (`public/js/device.js`); on the CircuitPython path it is published as
JSON to `{feed}-sleep`, and `code.py`'s `REFRESH_SECONDS` becomes the fallback for
when that feed is empty. Either way the window is reachable without recopying the
bundle, which is the point: timing is not a property of the panel, and a sleep
setting that moved `configSignature()` would send the user back to A6 every time
they touched a dropdown.

## Worked example — MagTag 2.9" (`builtin`)

The panel is soldered to the board, so `interface` is one field and there is no
pinout at all:

```json
{
  "cfg_version": 2,
  "name": "Kitchen",
  "display": {
    "driver": "SSD1680",
    "panel": "adafruit-magtag",
    "width": 128,
    "height": 296,
    "rotation": 3,
    "mode": "mono"
  },
  "interface": { "kind": "builtin" }
}
```

Consumed as:

```python
display = board.DISPLAY          # already up, at PANEL["width"]/["height"]/["rotation"]
display.root_group = group       # no bus to open, no release_displays()
```

`display.driver` is still `SSD1680` and the geometry is still the native pair,
because they are facts about the panel — but a `builtin` consumer needs neither.
They are there for a consumer driving the same part over its own bus.

## Worked example — 2.13" Quad-Color (`spi_epd`)

A bare panel the user wired themselves, so the descriptor carries the bus and the
five EPD pins:

```json
{
  "cfg_version": 2,
  "name": "Desk",
  "display": {
    "driver": "JD79661",
    "panel": "213-quad-AJHE5",
    "width": 122,
    "height": 250,
    "rotation": 3,
    "mode": "quadcolor"
  },
  "interface": {
    "kind": "spi_epd",
    "spi": { "bus": 0, "mosi": "board.D35", "sck": "board.D36" },
    "pins": {
      "cs": "board.D5", "dc": "board.D6", "reset": "board.D11",
      "busy": "board.D12", "sram_cs": null
    }
  }
}
```

Consumed as:

```python
from adafruit_epd.jd79661 import Adafruit_JD79661   # chosen from display.driver

epd = Adafruit_JD79661(
    PANEL["width"], PANEL["height"],                # 122, 250 — native, in that order
    spi,
    cs_pin=dio(PINS["cs"]), dc_pin=dio(PINS["dc"]),
    sramcs_pin=dio(PINS["sram_cs"]),                # None — this panel has no SRAM
    rst_pin=dio(PINS["reset"]), busy_pin=dio(PINS["busy"]),
)
epd.rotation = PANEL["rotation"]                    # 3 -> a 250x122 drawing surface
```

## Fields

### `cfg_version` — integer

`2`. Bump on any breaking change. A consumer should refuse a version it does not
know rather than read a subset.

### `name` — string

What the user called this board. Display/logging only.

### `display`

| field | type | notes |
|---|---|---|
| `driver` | string | Controller part number, e.g. `SSD1680`. See the driver table. |
| `panel` | string | `{size}-{color_mode}-{rev}` (e.g. `213-quad-AJHE5`) or `adafruit-{product}`. |
| `width`, `height` | integer | **Native, unrotated framebuffer** — see below. |
| `rotation` | 0–3 | Clockwise quarter-turns. Assign straight to `epd.rotation`. |
| `mode` | `mono` \| `gray4` \| `tricolor` \| `quadcolor` | Colour capability. |

#### Native geometry — the one rule to get right

`width` and `height` are the panel's **native scan geometry**: the first two
positional arguments of the `adafruit_epd` constructor, in that order. They are
frequently *not* the dimensions the product is sold as. From the library's own
examples:

```python
Adafruit_SSD1680(122, 250, ...)    # 2.13" HD  — sold as 250x122 landscape
Adafruit_SSD1680(128, 296, ...)    # 2.9"      — sold as 296x128 landscape
Adafruit_SSD1683(400, 300, ...)    # 4.2"      — already landscape
Adafruit_UC8179(800, 480, ...)     # 7.5"      — already landscape
```

`rotation` is what turns that buffer into the surface the dashboard is drawn on.
The drawn size is derived, not stated:

```python
w, h = (PANEL["height"], PANEL["width"]) if PANEL["rotation"] % 2 else (PANEL["width"], PANEL["height"])
```

After `epd.rotation = PANEL["rotation"]`, `epd.width` and `epd.height` report
exactly that pair — so asserting against them is the cheap way to confirm the
config and the driver agree. Transposing `width` and `height` does not error; it
draws noise.

Rotation index `3` (270°) is what the library's examples use to bring a
portrait-native panel to landscape, and it is what every portrait-native preset in
the catalog emits. Index `1` is the same landscape flipped 180°. If a board comes
up upside down, that is the field to change.

### `interface`

`kind` says what the consumer has to do to get a drawing surface, and it decides
which of the other fields are present at all:

| `kind` | other fields | what to do |
|---|---|---|
| `builtin` | **none** | The panel is part of the board. CircuitPython constructed it at boot — use `board.DISPLAY`. Do not open a bus, and do not call `displayio.release_displays()`: that releases the display you are about to draw on. |
| `spi_epd` | `spi`, `pins` | The user wired the panel up. Open the bus and construct the `adafruit_epd` driver from the table below. |

A consumer branches on `kind` before touching `interface`; reading
`interface["pins"]` unconditionally raises `KeyError` on a `builtin` board.

**`builtin` carries no pinout on purpose.** The pins the editor holds for such a
board — `D8`, `D7`, … for a MagTag — are what the WipperSnapper firmware resolves,
and they are *not* `board` attributes on the board itself (a MagTag's EPD is on
`board.EPD_CS`, `board.EPD_DC`, …). Emitting them here would produce a file that
looks drivable and dies on `getattr(board, "D8")`. The interface kind per preset is
`ifaceKindFor()` in `public/js/presets.js`; a panel id the editor does not know is
`spi_epd`.

When `kind` is `spi_epd`:

| field | type | notes |
|---|---|---|
| `spi.bus` | integer | Bus index. `0` is the board's default hardware SPI. |
| `spi.mosi`, `spi.sck` | string \| null | |
| `pins.cs` | string \| null | EPD chip select. |
| `pins.dc` | string \| null | Data/command. |
| `pins.reset` | string \| null | |
| `pins.busy` | string \| null | |
| `pins.sram_cs` | string \| null | The external SRAM chip, where the panel has one. |

**A pin is the CircuitPython expression that resolves it — `"board.D5"`, namespace
included — or `null`.** The prefix is there so the string is the name a consumer
would have typed, rather than a bare `"D5"` that only means something once you
know which module the editor had in mind. `null` means the pin is not wired — pass
`None` to the constructor. That too is a deliberate normalisation: the editor form
and the WipperSnapper protobuf path both use `"-1"` and `""` as sentinels, and
collapsing them to one JSON value keeps the string-parsing off the device.

```python
def pin(name):
    # split on the dot, so a bare "D5" from an older file still resolves
    return None if name is None else getattr(board, name.split(".")[-1])

def dio(name):
    p = pin(name)
    return digitalio.DigitalInOut(p) if p is not None else None
```

## Driver table

`display.driver` → `adafruit_epd`, verified against the library at `main`. Every
constructor takes `(width, height, spi, *, cs_pin, dc_pin, sramcs_pin, rst_pin,
busy_pin)`; keyword-only after `spi`.

| `driver` | module | class | mode-specific | kwargs |
|---|---|---|---|---|
| `EK79686` | `adafruit_epd.ek79686` | `Adafruit_EK79686` | | |
| `IL0373` | `adafruit_epd.il0373` | `Adafruit_IL0373` | | |
| `IL0398` | `adafruit_epd.il0398` | `Adafruit_IL0398` | | |
| `IL91874` | `adafruit_epd.il91874` | `Adafruit_IL91874` | | |
| `JD79661` | `adafruit_epd.jd79661` | `Adafruit_JD79661` | | own `YELLOW=2`, `RED=3` |
| `JD79667` | `adafruit_epd.jd79667` | `Adafruit_JD79667` | | |
| `SSD1608` | `adafruit_epd.ssd1608` | `Adafruit_SSD1608` | | |
| `SSD1675` | `adafruit_epd.ssd1675` | `Adafruit_SSD1675` | | |
| `SSD1675B` | `adafruit_epd.ssd1675b` | `Adafruit_SSD1675B` | | |
| `SSD1680` | `adafruit_epd.ssd1680` | `Adafruit_SSD1680` | `Adafruit_SSD1680_Grayscale4` for `gray4` | |
| `SSD1680B` | `adafruit_epd.ssd1680b` | `Adafruit_SSD1680B` | | |
| `SSD1681` | `adafruit_epd.ssd1681` | `Adafruit_SSD1681` | | |
| `SSD1683` | `adafruit_epd.ssd1683` | `Adafruit_SSD1683` | `Adafruit_SSD1683_Grayscale4` for `gray4` | |
| `UC8151D` | `adafruit_epd.uc8151d` | `Adafruit_UC8151D` | | |
| `UC8179` | `adafruit_epd.uc8179` | `Adafruit_UC8179` | | `tri_color=True` when not mono |
| `UC8253` | `adafruit_epd.uc8253` | `Adafruit_UC8253` | `_Mono` / `_Tricolor` | |
| `ILI0373` | `adafruit_epd.il0373` | `Adafruit_IL0373` | | legacy alias for the dropdown typo |
| `ST7789` | — | — | | TFT, not an EPD — no CircuitPython EPD class |

**The class is mode-dependent.** A 4.2" grayscale panel is an SSD1683, but driving
it with `Adafruit_SSD1683` costs two of its four shades — it needs
`Adafruit_SSD1683_Grayscale4`. Resolve on `(driver, mode)`, not on `driver` alone.

The table lives in `EPD_DRIVERS` in `public/js/presets.js`; `driverFor(driver,
mode)` does the mode resolution and returns the constructor kwargs alongside.

## What the catalog emits

All seven presets, as produced by `buildMarqueeCfg()`:

| preset | `width`×`height` | `rotation` | drawn at | `mode` | `kind` | class |
|---|---|---|---|---|---|---|
| `magtag` | 128×296 | 3 | 296×128 | mono | `builtin` | `Adafruit_SSD1680` (unused — `board.DISPLAY`) |
| `tricolorFW` | 122×250 | 3 | 250×122 | tricolor | `spi_epd` | `Adafruit_SSD1680` |
| `quad213` | 122×250 | 3 | 250×122 | quadcolor | `spi_epd` | `Adafruit_JD79661` |
| `tricolor42` | 400×300 | 0 | 400×300 | tricolor | `spi_epd` | `Adafruit_SSD1683` |
| `gray42` | 400×300 | 0 | 400×300 | gray4 | `spi_epd` | `Adafruit_SSD1683_Grayscale4` |
| `mono75` | 800×480 | 0 | 800×480 | mono | `spi_epd` | `Adafruit_UC8179` |
| `tri75` | 800×480 | 0 | 800×480 | tricolor | `spi_epd` | `Adafruit_UC8179` + `tri_color=True` |

`magtag` is the only `builtin` entry, so it is the only one whose descriptor has no
`interface.spi`/`interface.pins`.

## The image on the feed

Not described by this file, but a consumer needs it, so: `server.js` publishes a
base64 **indexed, uncompressed BMP3** — 1 bit/px for `mono`, 4 bit/px for every
other palette. Rows are bottom-up (positive `biHeight`) and padded to a 4-byte
boundary. The BMP carries its own colour table; match its entries by hex against
the palette for `display.mode` rather than assuming an index order, because
ImageMagick's `-remap` does not preserve one (for tricolor the file order is
black, red, white, while the editor's palette is black, white, red).

| `mode` | palette → `Adafruit_EPD` constant |
|---|---|
| `mono` | `#2F2429`→BLACK, `#F2F4EF`→WHITE |
| `gray4` | `#2F2429`→BLACK, `#70696B`→DARK, `#B1AFAD`→LIGHT, `#F2F4EF`→WHITE |
| `tricolor` | `#2F2429`→BLACK, `#F2F4EF`→WHITE, `#D72627`→RED |
| `quadcolor` | `#2F2429`→BLACK, `#F2F4EF`→WHITE, `#FD2A00`→RED, `#FFFF03`→YELLOW |

Resolve those constants by **name off the driver class first**:

```python
def ink(name):
    return getattr(EPD_CLASS, name, getattr(Adafruit_EPD, name, Adafruit_EPD.BLACK))
```

`Adafruit_EPD` defines `BLACK=0 WHITE=1 INVERSE=2 RED=3 DARK=4 LIGHT=5`, but
`Adafruit_JD79661` shadows the middle of that with its own
`BLACK=0 WHITE=1 YELLOW=2 RED=3`. Checking the driver class first is what stops
the quad-color panel painting red where it wanted yellow.

The hexes are `PALETTES` in `public/js/palette.js`, extracted from the committed
remap PNGs in `palettes/`.

## Known gaps

- **`code.py` does not consume the `spi_epd` path yet.** The generated bundle reads
  the config, connects and fetches the dashboard, and on a `builtin` board it draws
  through `displayio`/`board.DISPLAY` — which is the whole of what that kind
  requires. On `spi_epd` it resolves the bus and the pins but stops short of
  constructing the `adafruit_epd` driver and blitting the indexed BMP with
  `epd.pixel()`, so a bare panel or a FeatherWing does not draw.
- **`epd.pixel()` is slow.** A per-pixel blit is 37,888 calls for a MagTag and
  384,000 for a 7.5". Filling with the background first and skipping
  background-coloured pixels is the cheap mitigation.
- **800×480 tri-color is tight on memory.** 188 KB raw plus ~250 KB of base64 will
  not fit alongside the requests buffer on a board without PSRAM. Mono at that
  size is 48 KB and fine.
- **The 270°-vs-90° choice is unverified on hardware** for `magtag` and
  `tricolorFW`. Both give the right drawn size; they differ by a 180° flip.

## Relationship to the WipperSnapper path

`buildDisplayBody()` in `public/js/config.js` serialises the same facts for
`POST /display/add` → protobuf → the WipperSnapper C++ firmware. The two are
separate serialisers on purpose — different consumers, different conventions
(`"-1"` vs `null`, bare `"D5"` vs `"board.D5"`, `interface.spiEpd.*` vs
`interface.pins.*`) — but both read the same form and the same `DISPLAY_PRESETS`
entry, so `width`, `height` and `rotation` here are the same numbers that go over
the wire.

The pinout is the one place they diverge in *content* rather than in spelling: the
protobuf body always carries the pins, including for a `builtin` board, because the
WipperSnapper firmware drives the EPD itself and needs them.
