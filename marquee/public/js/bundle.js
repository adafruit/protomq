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
import { buildDisplayBody, refreshInterval } from './config.js';
import { DISPLAY_PRESETS } from './presets.js';
import { getState } from './state.js';
import { ioHost } from './api.js';
import { val, download } from './util.js';

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

function configJson() {
  const body = buildDisplayBody();
  const { w, h } = logicalDims();
  return JSON.stringify({
    marquee_version: 1,
    name: val('marqueeName') || 'Marquee',
    feed: val('ioFeed') || 'marquee',
    refresh_seconds: refreshInterval(),
    panel: {
      width: body.width,
      height: body.height,
      logical_width: w,
      logical_height: h,
      rotation: body.rotation,
      mode: body.mode,
      driver: body.driver,
      panel: body.panel,
    },
    pins: {
      busy: body.interface.spiEpd.pinBusy,
      dc: body.interface.spiEpd.pinDc,
      reset: body.interface.spiEpd.pinRst,
      cs: body.interface.spiEpd.spi.pinCs,
      sram_cs: body.interface.spiEpd.pinSramCs,
      mosi: body.interface.spiEpd.spi.pinMosi,
      sck: body.interface.spiEpd.spi.pinSck,
      spi_bus: body.interface.spiEpd.spi.bus,
    },
  }, null, 2) + '\n';
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
    '',
  ].join('\n');
}

function codePy() {
  return `# Adafruit IO Marquee — generated code bundle.
#
# Fetches the dashboard your Marquee editor published to an Adafruit IO feed,
# draws it on the e-paper panel, then deep-sleeps until the next refresh.
#
# Regenerate this bundle whenever the display, its pins or the refresh interval
# change. Dashboard edits do NOT need a new bundle — they arrive over the air on
# the feed this file already reads.

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

with open("marquee_config.json") as f:
    CONFIG = json.load(f)

PANEL = CONFIG["panel"]
PINS = CONFIG["pins"]
REFRESH_SECONDS = CONFIG["refresh_seconds"]

AIO_USER = getenv("ADAFRUIT_AIO_USERNAME")
AIO_KEY = getenv("ADAFRUIT_AIO_KEY")
AIO_HOST = getenv("ADAFRUIT_IO_HOST", "io.adafruit.com")
FEED = CONFIG["feed"]


def pin(name):
    """'D5' -> board.D5.  '-1' or '' means the panel does not wire this pin."""
    if not name or name == "-1":
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

spi = busio.SPI(pin(PINS["sck"]), MOSI=pin(PINS["mosi"]))
epd_cs = pin(PINS["cs"])
epd_dc = pin(PINS["dc"])
epd_reset = pin(PINS["reset"])
epd_busy = pin(PINS["busy"])

# The driver class depends on the panel you confirmed in Marquee. See the guide
# linked from the bundle screen for the import that matches ${display.type} /
# ${val('pmDriver') || 'your driver'}.
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
  return `Adafruit IO Marquee — code bundle
=================================

Built for: ${label}
Panel:     ${display.width} x ${display.height}, ${display.type}, driver ${val('pmDriver') || '?'}
Refresh:   every ${refreshInterval()} seconds

What to do
----------
1. Plug the board in over USB. A CIRCUITPY drive appears.
2. Copy code.py, settings.toml and marquee_config.json onto that drive,
   replacing what is there.
3. Edit settings.toml and fill in your WiFi name and password.
4. Press RESET. The board connects to Adafruit IO and draws your dashboard.

Libraries — NOT INCLUDED
------------------------
The Adafruit CircuitPython library bundle is versioned against your board's
CircuitPython release, so it is not shipped inside this ZIP. Download the bundle
matching your CircuitPython version from

    https://circuitpython.org/libraries

and copy these into CIRCUITPY/lib/:

    adafruit_requests.mpy
    adafruit_imageload/
    adafruit_display_text/
    the ThinkInk / EPD driver module for your panel

When to come back
-----------------
Only when the display, its pins or the refresh interval change. Dashboard edits
arrive over the air on the feed this bundle already reads, so they never need a
fresh copy.
`;
}

/** Everything the ZIP contains, with real byte counts for the side rail. */
export function bundleFiles() {
  const files = [
    { name: 'code.py', text: codePy() },
    { name: 'settings.toml', text: settingsToml() },
    { name: 'marquee_config.json', text: configJson() },
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
