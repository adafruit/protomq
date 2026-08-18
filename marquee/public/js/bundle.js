/**
 * The CircuitPython code bundle (A6).
 *
 * Built entirely in the browser from the confirmed display settings — there is
 * no build step and no server round-trip, so the ZIP is assembled here with a
 * minimal store-only (uncompressed) writer. Store-only is not a shortcut worth
 * apologising for: the payload is a few KB of text, DEFLATE would save nothing
 * meaningful, and every unzip tool reads stored entries.
 *
 * HONEST LIMITATION: `lib/` is NOT included. The Adafruit CircuitPython library
 * bundle is versioned against the board's CircuitPython release and is far too
 * large to inline here, so the bundle ships a README naming the exact modules to
 * copy across. The file list in the side rail reports what is actually in the
 * ZIP rather than an aspirational manifest.
 */

import { display, logicalDims } from './palette.js';
import { cfgMarqueeJson } from './cfg.js';
import { DISPLAY_PRESETS, driverFor } from './presets.js';
import { getState } from './state.js';
import { ioHost } from './api.js';
import { val, download } from './util.js';

/**
 * How long the standalone board sleeps between takes.
 *
 * NOT read from cfg-marquee.json, and not the editor's refresh interval: that
 * setting configures the *live* device through the broker's wake response
 * (device.js, `durSeconds`), which a board running this code.py never sees. The
 * descriptor describes the panel, so the sleep window is code.py's own default
 * and the user edits it on the drive.
 */
const DEFAULT_REFRESH_SECONDS = 900;

// ---------- store-only ZIP writer -------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * @param {Array<{name: string, text: string}>} files
 * @returns {Blob} a ZIP with every entry stored (method 0)
 */
function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.text);
    const crc = crc32(data);

    // Local file header. Timestamps are left at zero rather than stamped with
    // the current clock: a bundle built twice from identical settings should be
    // byte-identical, so "is this the same bundle?" is answerable by hashing.
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),                       // mod time, mod date
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
    ];
    chunks.push(new Uint8Array(local), nameBytes, data);

    central.push({
      crc, size: data.length, nameBytes, offset,
    });
    offset += local.length + nameBytes.length + data.length;
  }

  const dirStart = offset;
  for (const e of central) {
    const hdr = [
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(e.crc), ...u32(e.size), ...u32(e.size),
      ...u16(e.nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(e.offset),
    ];
    chunks.push(new Uint8Array(hdr), e.nameBytes);
    offset += hdr.length + e.nameBytes.length;
  }

  const end = [
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length),
    ...u32(offset - dirStart), ...u32(dirStart), ...u16(0),
  ];
  chunks.push(new Uint8Array(end));

  return new Blob(chunks, { type: 'application/zip' });
}

// ---------- bundle contents -------------------------------------------------

/** A filesystem-safe stem for the ZIP, derived from the panel. */
export function bundleName() {
  const key = getState().selectedPanel;
  const stem = key ? DISPLAY_PRESETS[key].label : 'custom';
  return 'marquee-' + stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.zip';
}

/**
 * The import line for the panel's driver, resolved for the current colour mode —
 * a gray4 panel wants the Grayscale4 subclass, not the base class. Returned as
 * prose when there is no CircuitPython driver for the part at all, since both
 * callers are writing it into a comment for a human.
 */
function driverImport() {
  const drv = driverFor(val('pmDriver'), display.type);
  if (!drv) return `no adafruit_epd driver for ${val('pmDriver') || 'this part'}`;
  const kw = Object.keys(drv.kwargs).length
    ? `  (construct it with ${Object.entries(drv.kwargs).map(([k, v]) => `${k}=${v ? 'True' : 'False'}`).join(', ')})`
    : '';
  return `from ${drv.module} import ${drv.cls}${kw}`;
}

/** Just the class name, for prose. */
function driverClassName() {
  return driverFor(val('pmDriver'), display.type)?.cls || 'the adafruit_epd driver';
}

/**
 * How the native buffer relates to the drawn surface — only worth spelling out
 * when rotation actually changes it, or the sentence reads as a typo on the
 * panels that are already landscape.
 */
function geomNote(lw, lh) {
  return (lw === display.width && lh === display.height)
    ? `Here that is ${display.width}x${display.height}, drawn as-is at rotation 0.`
    : `Here that is ${display.width}x${display.height}, which PANEL["rotation"] turns into the ${lw}x${lh} the dashboard is drawn at.`;
}

function settingsToml() {
  // The AIO key is written in because the whole point of the bundle is that the
  // board comes up already talking to IO. It is the user's own key going onto
  // the user's own drive, but the file says so plainly so nobody shares the ZIP
  // without thinking.
  return [
    '# Written by Adafruit IO Marquee.',
    '# CONTAINS YOUR AIO KEY — do not share this file or commit it anywhere.',
    '',
    'CIRCUITPY_WIFI_SSID = "your-wifi-name"',
    'CIRCUITPY_WIFI_PASSWORD = "your-wifi-password"',
    '',
    `ADAFRUIT_AIO_USERNAME = "${val('ioUser')}"`,
    `ADAFRUIT_AIO_KEY = "${val('ioKey')}"`,
    `ADAFRUIT_IO_HOST = "${ioHost()}"`,
    // The feed lives here rather than in cfg-marquee.json: that file describes the
    // panel, and this one describes the Adafruit IO account it talks to.
    `ADAFRUIT_IO_FEED = "${val('ioFeed') || 'marquee'}"`,
    '',
  ].join('\n');
}

function codePy() {
  const { w: lw, h: lh } = logicalDims();
  return `# Adafruit IO Marquee — generated code bundle.
#
# Fetches the dashboard your Marquee editor published to an Adafruit IO feed,
# draws it on the e-paper panel, then deep-sleeps until the next refresh.
#
# Regenerate this bundle whenever the display or its pins change. Dashboard edits
# do NOT need a new bundle — they arrive over the air on the feed this file
# already reads.

import json
import time
import alarm
import board
import busio
import digitalio
import displayio
import wifi
import socketpool
import ssl
import adafruit_requests
from os import getenv

with open("cfg-marquee.json") as f:
    CONFIG = json.load(f)

PANEL = CONFIG["display"]
PINS = CONFIG["interface"]["pins"]
SPI_CFG = CONFIG["interface"]["spi"]

# How long to sleep between takes. cfg-marquee.json describes the panel and says
# nothing about timing, so this lives here — edit it on the drive to re-tune.
REFRESH_SECONDS = ${DEFAULT_REFRESH_SECONDS}

# TODO: read the sleep window off Adafruit IO instead of the constant above.
#
# "Push to display" in the editor now publishes it as JSON to the feed named
# "{ADAFRUIT_IO_FEED}-sleep" — for this bundle, "${val('ioFeed') || 'marquee'}-sleep".
# The last value on that feed is exactly three fields:
#
#     {"alarm_type": ..., "sleep_mode": ..., "sleep_time": ...}
#
#     alarm_type   "timer" | "pin" | "timer+pin"   (at most one of each)
#     sleep_mode   "light" | "deep"   (the editor derives this from sleep_time:
#                  under 300s light, from 300s up deep; "pin" is always deep)
#     sleep_time   integer seconds; IGNORED when alarm_type is "pin"
#
# Both modes really do arrive, so implement both: deep sleep never returns
# (alarm.exit_and_deep_sleep_until_alarms), while light sleep resumes in place and
# needs the take wrapped in a loop.
#
# The wake PIN is NOT in the payload — it is a fact about how this board is wired,
# not about a take, so whichever pin a PinAlarm arms belongs here in code.py as
# its own constant. An empty or unparseable feed means fall back to
# REFRESH_SECONDS and a plain timer; never sleep with no alarm at all.
#
# Full contract: docs/marquee-sleep.md in the Marquee repo.

AIO_USER = getenv("ADAFRUIT_AIO_USERNAME")
AIO_KEY = getenv("ADAFRUIT_AIO_KEY")
AIO_HOST = getenv("ADAFRUIT_IO_HOST", "io.adafruit.com")
FEED = getenv("ADAFRUIT_IO_FEED", "marquee")


def pin(name):
    """'D5' -> board.D5.  null in cfg-marquee.json means the pin is not wired."""
    if name is None:
        return None
    return getattr(board, name)


def connect():
    wifi.radio.connect(getenv("CIRCUITPY_WIFI_SSID"), getenv("CIRCUITPY_WIFI_PASSWORD"))
    pool = socketpool.SocketPool(wifi.radio)
    return adafruit_requests.Session(pool, ssl.create_default_context())


def fetch_dashboard(session):
    """The editor publishes a base64 BMP as the feed's last value."""
    url = "https://{}/api/v2/{}/feeds/{}/data/last".format(AIO_HOST, AIO_USER, FEED)
    resp = session.get(url, headers={"X-AIO-Key": AIO_KEY})
    try:
        return resp.json().get("value")
    finally:
        resp.close()


def show(bmp_base64):
    import binascii
    import io

    raw = binascii.a2b_base64(bmp_base64)
    bitmap, palette = adafruit_imageload.load(io.BytesIO(raw))
    group = displayio.Group()
    group.append(displayio.TileGrid(bitmap, pixel_shader=palette))
    board.DISPLAY.root_group = group
    board.DISPLAY.refresh()
    # E-paper needs the full refresh to finish before power is cut.
    time.sleep(board.DISPLAY.time_to_refresh + 2)


def sleep_until_next_take():
    wake = alarm.time.TimeAlarm(monotonic_time=time.monotonic() + REFRESH_SECONDS)
    alarm.exit_and_deep_sleep_until_alarms(wake)


displayio.release_displays()

spi = busio.SPI(pin(SPI_CFG["sck"]), MOSI=pin(SPI_CFG["mosi"]))
epd_cs = pin(PINS["cs"])
epd_dc = pin(PINS["dc"])
epd_reset = pin(PINS["reset"])
epd_busy = pin(PINS["busy"])
epd_sram_cs = pin(PINS["sram_cs"])

# PANEL["driver"] is "${val('pmDriver') || '?'}", which on CircuitPython means
#   ${driverImport()}
# PANEL["width"]/["height"] are its first two constructor arguments: the NATIVE,
# unrotated framebuffer. ${geomNote(lw, lh)}
# Wiring that up, and decoding the ${display.type === 'mono' ? 1 : 4}-bit indexed BMP the feed carries, is
# not generated yet. See docs/cfg-marquee.md.
import adafruit_imageload  # noqa: E402  (imported late so the panel is up first)

try:
    session = connect()
    payload = fetch_dashboard(session)
    if payload:
        show(payload)
    else:
        print("Feed '{}' has no dashboard yet.".format(FEED))
except Exception as err:  # a failed take must still sleep, or the battery dies
    print("Marquee update failed:", err)

sleep_until_next_take()
`;
}

function readme() {
  const key = getState().selectedPanel;
  const label = key ? DISPLAY_PRESETS[key].label : 'your panel';
  // The native buffer and the drawn canvas differ on every portrait-native panel,
  // so name both — but only when they actually differ, or the line reads as a
  // typo on the panels where rotation is 0.
  const { w: lw, h: lh } = logicalDims();
  const geom = (lw === display.width && lh === display.height)
    ? `${display.width} x ${display.height}`
    : `${display.width} x ${display.height} native, drawn as ${lw} x ${lh}`;
  return `Adafruit IO Marquee — code bundle
=================================

Built for: ${label}
Panel:     ${geom}, ${display.type}
Driver:    ${val('pmDriver') || '?'} — ${driverImport()}
Refresh:   every ${DEFAULT_REFRESH_SECONDS} seconds — REFRESH_SECONDS in code.py.
           NOT what "Wake and redraw" is set to in the editor; see below.

What to do
----------
1. Plug the board in over USB. A CIRCUITPY drive appears.
2. Copy code.py, settings.toml and cfg-marquee.json onto that drive,
   replacing what is there.
3. Edit settings.toml and fill in your WiFi name and password.
4. Press RESET. The board connects to Adafruit IO and fetches your dashboard.

Libraries — NOT INCLUDED
------------------------
The Adafruit CircuitPython library bundle is versioned against your board's
CircuitPython release, so it is not shipped inside this ZIP. Download the bundle
matching your CircuitPython version from

    https://circuitpython.org/libraries

and copy these into CIRCUITPY/lib/:

    adafruit_requests.mpy
    adafruit_connection_manager.mpy
    adafruit_imageload/
    adafruit_epd/            <- ${driverImport()}

adafruit_epd is what cfg-marquee.json is written for, but the code.py in this ZIP
does not construct the driver yet — see "Not finished" below.

Not finished
------------
cfg-marquee.json is complete: it carries the driver class, the native framebuffer
to construct it with, the rotation, every pin, and the exact layout of the image
that arrives on the feed.

code.py does not consume all of it yet. It connects, fetches the dashboard and
reads the config, but it still draws through displayio/board.DISPLAY instead of
constructing ${driverClassName()} from cfg-marquee.json and
blitting the indexed BMP with epd.pixel(). On a board with a built-in display (a
MagTag) it will draw; on a bare panel or a FeatherWing it will not, because
nothing has told CircuitPython that panel exists.

If you are wiring this up yourself, everything you need is in the JSON.

Neither does code.py read the sleep window. "Push to display" in the editor
publishes it as JSON to the "${(val('ioFeed') || 'marquee')}-sleep" feed --
the sleep duration, the light-or-deep mode that duration implies, and whether to
wake on the timer, a button, or either. This code.py ignores all of that and sleeps on REFRESH_SECONDS with a
timer alarm, so until it is taught to read that feed, "Wake and redraw" in the
editor has no effect on this board. There is a TODO in code.py with the field
list, and the full contract is in docs/marquee-sleep.md.

When to come back
-----------------
Only when the display, its pins, or your Adafruit IO feed and credentials change.
Dashboard edits arrive over the air on the feed this bundle already reads, so they
never need a fresh copy. The sleep window will not either, once code.py reads it;
for now it is a REFRESH_SECONDS edit on the drive.
`;
}

/** Everything the ZIP contains, with real byte counts for the side rail. */
export function bundleFiles() {
  const files = [
    { name: 'code.py', text: codePy() },
    { name: 'settings.toml', text: settingsToml() },
    { name: 'cfg-marquee.json', text: cfgMarqueeJson() },
    { name: 'README.txt', text: readme() },
  ];
  const enc = new TextEncoder();
  return files.map((f) => ({ ...f, bytes: enc.encode(f.text).length }));
}

export function bundleTotalBytes(files = bundleFiles()) {
  return files.reduce((n, f) => n + f.bytes, 0);
}

export function downloadBundle() {
  const files = bundleFiles();
  const blob = makeZip(files);
  const name = bundleName();
  download(blob, name);
  return { name, size: blob.size, files };
}
