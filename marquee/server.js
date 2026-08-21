'use strict';

/**
 * Adafruit IO Marquee — render backend.
 *
 * A thin Express server whose one real job is to run the exact ImageMagick
 * pipeline the editor was designed around — dither+remap once through a
 * palettized GIF, then transcode to an indexed BMP for the panel:
 *
 *   magick in.png -dither FloydSteinberg -define dither:diffusion-amount=N% \
 *     -remap palettes/eink-<type>.png gif:- \
 *     | magick gif:- -compress none BMP3:out.bmp
 *
 * The browser editor sends a PNG snapshot of the canvas plus the display
 * settings; the server dithers + remaps with real ImageMagick and returns an
 * indexed BMP3 (1bpp mono / 4bpp color, validated) plus a truecolor PNG of the
 * identical pixels for the on-screen preview. This is the *only* render path —
 * the editor no longer falls back to a client-side JS dither. See README.md.
 */

const express = require('express');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const protobuf = require('protobufjs');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;

// Where the -remap palette PNGs live. Must stay in sync with the editor's
// PALETTES / REMAP_FILES tables.
const PALETTE_DIR = path.join(__dirname, 'palettes');

// display type -> remap PNG filename (the backend contract).
const REMAP_FILES = {
  mono: 'eink-2color.png',       // black & white
  gray4: 'eink-4gray.png',       // 4-level grayscale
  tricolor: 'eink-3color.png',   // black / white / red
  quadcolor: 'eink-4color.png',  // black / white / red / yellow (product 6373)
};

// Adafruit IO datum ceilings (bytes of base64 payload).
const IO_MAX_HISTORY = 1024;         // feed history ON
const IO_MAX_NO_HISTORY = 512 * 1024; // feed history OFF (the real per-datum limit)

// ---- ProtoMQ echo (display.add) --------------------------------------------
// Where the ProtoMQ broker's HTTP control API lives. /display/add builds a
// display.Add descriptor, protobuf-encodes it as a BrokerToDevice, and forwards
// it to ProtoMQ's echo endpoint (which publishes it to the device's MQTT topic).
const PROTOMQ_URL = process.env.PROTOMQ_URL || 'http://localhost:5173';

// Bytes of chunk_data per Canvas fragment. +40 B protobuf overhead must stay
// under the broker's 2048 B message ceiling. Kept at 256 (down from 420) so each
// Canvas message comfortably fits a single transport segment/read buffer — fewer
// multi-segment reads on the device and real headroom under the ceiling.
const CHUNK = 256;

// The BrokerToDevice message type, loaded from a vendored copy of ProtoMQ's
// protobuf bundle. This file is a COPY of protomq/protobufs/bundle.json and must
// be re-synced if ProtoMQ's protos change. Loading is guarded so a missing/bad
// bundle degrades /display/add to a 501 instead of crashing the whole server.
let BrokerToDevice = null;
try {
  const pbRoot = protobuf.Root.fromJSON(require('./protobufs/protomq-bundle.json'));
  BrokerToDevice = pbRoot.lookupType('BrokerToDevice');
} catch (e) {
  console.warn('ProtoMQ bundle not loaded; /display/add disabled:', e.message);
}

// Marquee display type -> ProtoMQ EPDMode enum name (protobufs/display.proto).
const MODE_MAP = {
  mono: 'EPD_MODE_MONO',
  gray4: 'EPD_MODE_GRAYSCALE4',
  tricolor: 'EPD_MODE_TRICOLOR',
  quadcolor: 'EPD_MODE_QUADCOLOR',
};

// Light vs deep is DERIVED from the sleep duration, never taken from the request:
// the caller has no information the duration doesn't already carry, and two authors
// for one decision is how the editor and the device end up disagreeing. Three
// tiers, which collapse into one comparison:
//
//   T < 60s     light — under the MQTT keepalive the socket survives the nap
//               outright, so waking costs nothing.
//   60s-300s    light — the reconnect is MQTT-only; a deep wake's boot +
//               re-provision + EPD redraw still costs more than staying up.
//   T >= 300s   deep — past here the boot no longer dominates, and holding RAM and
//               a radio that long is the worse trade.
//
// The first two tiers agree, so this is a single threshold. The 60s tier is the
// reasoning, not a value read from anywhere: ws.sleep.SleepConfig has no keepalive
// field and nothing here reads one off the device.
//
// Mirrored in public/js/config.js (sleepModeFor) for the CircuitPython path, which
// never reaches this server. THIS copy is authoritative — it is the one that encodes
// ws.sleep.SleepConfig and registers the wake response, i.e. the only one a device
// ever obeys. S_UNSPECIFIED is unreachable by construction.
const DEEP_SLEEP_THRESHOLD_SECS = 300;
const sleepModeFor = (secs) => (secs >= DEEP_SLEEP_THRESHOLD_SECS ? 'S_DEEP' : 'S_LIGHT');

// Default EPD interface wiring (Adafruit MagTag 2.9" SPI/EPD pins), ported from
// scripts/io-marquee-bridge.py. Used when the request omits `interface`.
const MAGTAG_INTERFACE = {
  spiEpd: {
    pinBusy: 'D5',
    spi: { bus: 0, pinMosi: 'D35', pinSck: 'D36', pinCs: 'D8' },
    pinDc: 'D7',
    pinRst: 'D6',
  },
};

// Build a display.Add descriptor (the `add` in { display: { add } }) from the
// editor's Display Configuration fields. Shared by POST /display/add and the
// deep-sleep wake-response registration (/sleep/config). Ports
// build_display_add() from scripts/io-marquee-bridge.py; rotation is included in
// properties (the Python PoC omitted it). Throws on an unknown display mode.
function buildDisplayAdd({
  width = 296, height = 128, rotation = 0,
  mode = 'mono', name = 'epd0',
  driver = 'SSD1680', panel = 'adafruit-magtag',
  interface: iface,
} = {}) {
  const epdMode = MODE_MAP[mode];
  if (!epdMode) throw new Error(`unknown display mode: ${mode}`);
  return {
    type: 'DISPLAY_CLASS_EPD',
    driver,
    panel,
    name,
    interfaceType: iface || MAGTAG_INTERFACE,
    configEpd: {
      mode: epdMode,
      properties: {
        width: Number(width),
        height: Number(height),
        rotation: Number(rotation),
        textSize: 3,
        statusBar: true,
      },
    },
  };
}

app.use(express.json({ limit: '32mb' })); // canvas PNGs are small, but be generous
app.use(express.static(path.join(__dirname, 'public'))); // optionally serve the editor

// ---- helpers ---------------------------------------------------------------

// Build the ImageMagick dither arguments from the request. Everything here is
// a fixed flag or a bounded number — no user string reaches the shell, and we
// use execFile (no shell) so there is nothing to inject into.
function ditherArgs({ method, diffusion, orderedMap }) {
  if (method === 'none') return ['-dither', 'None'];
  if (method === 'ordered') {
    const size = [2, 4, 8].includes(Number(orderedMap)) ? Number(orderedMap) : 8;
    return ['-ordered-dither', `o${size}x${size}`];
  }
  // default: Floyd–Steinberg with a clamped diffusion amount
  const amt = Math.max(0, Math.min(100, Number(diffusion)));
  return ['-dither', 'FloydSteinberg', '-define', `dither:diffusion-amount=${amt}%`];
}

// Run ImageMagick (v7 `magick`) with no shell. Returns stdout as a Buffer so a
// stage can emit an image to stdout (e.g. `gif:-`) and we pipe it onward.
function runConvert(args) {
  return new Promise((resolve, reject) => {
    execFile('magick', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr ? stderr.toString() : err.message));
        resolve(stdout);
      });
  });
}

// Same as runConvert but feeds `input` to the child's stdin — the second half
// of the `stage1 | stage2` pipe, done without a shell.
function runConvertStdin(args, input) {
  return new Promise((resolve, reject) => {
    const cp = execFile('magick', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr ? stderr.toString() : err.message));
        resolve(stdout);
      });
    cp.stdin.on('error', reject);
    cp.stdin.end(input);
  });
}

// The indexed bit depth each display type must encode at: mono is 2 colors -> 1
// bit/px, every other palette is <=4 colors -> 4 bit/px. This mirrors the
// editor's PALETTES sizes and is what the firmware's BMP reader expects.
function expectedBpp(display) {
  return display === 'mono' ? 1 : 4;
}

// Guard: the pipeline must produce an *indexed, uncompressed* BMP at the depth
// above. Reject anything else (esp. 24-bit truecolor) so a wrong BMP can never
// be returned or published. Reads the BITMAPINFOHEADER: biBitCount @28 (u16 LE),
// biCompression @30 (u32 LE, must be 0 = BI_RGB).
function assertIndexedBmp(buf, wantBpp) {
  if (!buf || buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) {
    throw new Error('not a BMP');
  }
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (bpp !== wantBpp) {
    throw new Error(`expected ${wantBpp}-bit indexed BMP, got ${bpp}-bit`);
  }
  if (compression !== 0) {
    throw new Error(`expected uncompressed BMP (BI_RGB), got compression ${compression}`);
  }
}

// Dither + remap once into a palettized GIF, then transcode that GIF into both
// the indexed BMP (for the panel) and a truecolor PNG (identical pixels, for the
// browser preview). Routing through GIF forces the image to stay palettized so
// the BMP lands at 1-/4-bit instead of 24-bit. Returns { bmp, png } Buffers.
async function renderIndexed({ display, dither, inPath }) {
  const palette = path.join(PALETTE_DIR, REMAP_FILES[display]);
  const gif = await runConvert([inPath, ...dither, '-remap', palette, 'gif:-']);
  const bmp = await runConvertStdin(['gif:-', '-compress', 'none', 'BMP3:-'], gif);
  assertIndexedBmp(bmp, expectedBpp(display));
  const png = await runConvertStdin(['gif:-', 'PNG24:-'], gif);
  return { bmp, png };
}

// ---- /render ---------------------------------------------------------------

/**
 * POST /render
 * body: {
 *   png:       base64 PNG of the canvas (required),
 *   display:   'mono' | 'gray4' | 'tricolor' | 'quadcolor',
 *   method:    'floyd' | 'ordered' | 'none',
 *   diffusion: 0..100   (floyd only),
 *   orderedMap: 2 | 4 | 8 (ordered only)
 * }
 * returns: {
 *   bmp:        base64 indexed BMP3 (what ships to the panel),
 *   png:        base64 PNG of the dithered result (for on-screen preview),
 *   bmpBytes:   raw BMP size,
 *   base64Bytes: size once base64-encoded (the number IO actually limits),
 *   fitsNoHistory: boolean (<= 512 KB),
 *   fitsHistory:   boolean (<= 1 KB)
 * }
 */
app.post('/render', async (req, res) => {
  const { png, display = 'mono' } = req.body || {};
  if (!png) return res.status(400).json({ error: 'missing png' });
  const remap = REMAP_FILES[display];
  if (!remap) return res.status(400).json({ error: `unknown display type: ${display}` });

  const tmp = os.tmpdir();
  const id = randomUUID();
  const inPath = path.join(tmp, `marquee-${id}-in.png`);

  try {
    const raw = Buffer.from(String(png).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    await fs.writeFile(inPath, raw);

    // Dither+remap once, then emit a validated 4bpp (1bpp mono) indexed BMP for
    // the panel and a truecolor PNG of the identical pixels for preview.
    const { bmp, png: pngOut } = await renderIndexed({ display, dither: ditherArgs(req.body), inPath });
    const base64Bytes = Math.ceil(bmp.length / 3) * 4;

    res.json({
      bmp: bmp.toString('base64'),
      png: pngOut.toString('base64'),
      bmpBytes: bmp.length,
      base64Bytes,
      fitsNoHistory: base64Bytes <= IO_MAX_NO_HISTORY,
      fitsHistory: base64Bytes <= IO_MAX_HISTORY,
    });
  } catch (e) {
    res.status(500).json({ error: 'render failed', detail: String(e.message || e) });
  } finally {
    // best-effort cleanup
    Promise.allSettled([fs.unlink(inPath)]);
  }
});

// ---- /publish (optional; keeps the AIO key server-side) --------------------

/**
 * POST /publish
 * Renders (same as /render) then forwards the base64 BMP to Adafruit IO using
 * a key held in the server environment (AIO_KEY / AIO_USER), so the browser
 * never sees it. If the env key is absent, the client may still publish
 * directly from the browser as before — this endpoint is purely optional.
 *
 * body: { ...same as /render, plus: feed }
 */
app.post('/publish', async (req, res) => {
  const user = process.env.AIO_USER;
  const key = process.env.AIO_KEY;
  if (!user || !key) {
    return res.status(501).json({ error: 'server has no AIO credentials; publish from the client instead' });
  }
  const { png, display = 'mono', feed, dev } = req.body || {};
  if (!png) return res.status(400).json({ error: 'missing png' });
  if (!feed) return res.status(400).json({ error: 'missing feed key' });
  const remap = REMAP_FILES[display];
  if (!remap) return res.status(400).json({ error: `unknown display type: ${display}` });

  const tmp = os.tmpdir();
  const id = randomUUID();
  const inPath = path.join(tmp, `marquee-${id}-in.png`);

  try {
    const raw = Buffer.from(String(png).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    await fs.writeFile(inPath, raw);
    // Same validated indexed pipeline as /render (BMP only is used here).
    const { bmp } = await renderIndexed({ display, dither: ditherArgs(req.body), inPath });
    const value = bmp.toString('base64');
    const base64Bytes = value.length;

    if (base64Bytes > IO_MAX_NO_HISTORY) {
      return res.status(413).json({ error: `payload ${base64Bytes} B exceeds IO ${IO_MAX_NO_HISTORY} B ceiling` });
    }

    // Same default as the browser's ioHost(): io.adafruit.com, with dev=true
    // opting into the .us staging environment. The two have to agree, or a publish
    // routed through here would land on a different account than every read.
    const host = dev ? 'io.adafruit.us' : 'io.adafruit.com';
    const url = `https://${host}/api/v2/${encodeURIComponent(user)}/feeds/${encodeURIComponent(feed)}/data`;
    const io = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AIO-Key': key },
      body: JSON.stringify({ value }),
    });
    if (!io.ok) {
      const body = await io.text();
      return res.status(io.status).json({ error: 'IO rejected', status: io.status, detail: body.slice(0, 500) });
    }
    res.json({ ok: true, base64Bytes });
  } catch (e) {
    res.status(500).json({ error: 'publish failed', detail: String(e.message || e) });
  } finally {
    Promise.allSettled([fs.unlink(inPath)]);
  }
});

// ---- /display/add (ProtoMQ echo) -------------------------------------------

/**
 * POST /display/add
 * Ports build_display_add() from scripts/io-marquee-bridge.py: build a
 * display.Add descriptor from the editor's Display Configuration, encode it as a
 * BrokerToDevice protobuf, and forward it to ProtoMQ's echo API. Doing this
 * server-side avoids shipping a protobuf lib to the browser and dodges CORS
 * (the broker is on a different origin, :5173).
 *
 * body: {
 *   width, height, rotation,        // DisplayProperties (rotation 0..3)
 *   mode,                           // 'mono'|'gray4'|'tricolor'|'quadcolor'
 *   name, driver, panel,            // display.Add identity (configurable)
 *   interface?,                     // interfaceType object; defaults to MagTag
 *   user, device                    // -> topic {user}/ws-b2d/{device}
 * }
 * returns: { ok: true, topic, bytes }  (bytes = encoded BrokerToDevice length)
 */
app.post('/display/add', async (req, res) => {
  if (!BrokerToDevice) {
    return res.status(501).json({ error: 'ProtoMQ bundle not loaded on server; cannot encode display.add' });
  }

  const { user = 'test_user', device = 'magtag' } = req.body || {};

  let add;
  try {
    add = buildDisplayAdd(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }

  let bytes;
  try {
    // fromObject converts the string enum names ("EPD_MODE_*", "DISPLAY_CLASS_EPD")
    // to their numeric values before encoding.
    bytes = BrokerToDevice.encode(BrokerToDevice.fromObject({ display: { add } })).finish();
  } catch (e) {
    return res.status(400).json({ error: 'failed to encode display.add', detail: String(e.message || e) });
  }

  // Round-trips exactly through the broker's Buffer.from(payload, 'latin1').
  const payload = Buffer.from(bytes).toString('latin1');
  const topic = `${user}/ws-b2d/${device}`;

  try {
    const echo = await fetch(`${PROTOMQ_URL}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, payload }),
    });
    if (!echo.ok) {
      const body = await echo.text();
      return res.status(502).json({ error: 'ProtoMQ echo rejected', status: echo.status, detail: body.slice(0, 500) });
    }
    res.json({ ok: true, topic, bytes: bytes.length });
  } catch (e) {
    return res.status(502).json({ error: `could not reach ProtoMQ broker at ${PROTOMQ_URL}`, detail: String(e.message || e) });
  }
});

// ---- /display/send-bmp (ProtoMQ echo) --------------------------------------

/**
 * POST /display/send-bmp
 * Ports send_bmp() from scripts/io-marquee-bridge.py (minus send_display_add(),
 * which is /display/add): take a rendered BMP, slice it into fixed-size Canvas
 * fragments, and publish each as a display.write.image over ProtoMQ's echo API.
 *
 * The BMP is accepted already-rendered (base64) rather than re-rendered from a
 * PNG so the bytes chunked here are byte-identical to what the client published
 * to Adafruit IO — the CRC32 the device recomputes will match.
 *
 * body: {
 *   bmp,                      // base64 BMP (raw bytes, 'BM' signature)
 *   name,                     // display.write.name (canvas target)
 *   user, device,             // -> topic {user}/ws-b2d/{device}
 *   chunk?                     // fragment size, default CHUNK (256)
 * }
 * returns: { ok, topic, chunks, checksum, size, bytes }
 */
app.post('/display/send-bmp', async (req, res) => {
  if (!BrokerToDevice) {
    return res.status(501).json({ error: 'ProtoMQ bundle not loaded on server; cannot encode canvas write' });
  }

  const {
    bmp,
    name = 'epd0',
    user = 'test_user', device = 'magtag',
    chunk = CHUNK,
  } = req.body || {};

  if (!bmp) return res.status(400).json({ error: 'missing bmp (base64)' });
  if (chunk + 40 > 2048) {
    return res.status(400).json({ error: `chunk ${chunk} too large: +40 B overhead exceeds the 2048 B ceiling` });
  }

  const data = Buffer.from(String(bmp).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (data.slice(0, 2).toString('latin1') !== 'BM') {
    return res.status(400).json({ error: "payload is not a BMP (missing 'BM' signature)" });
  }

  // == Python zlib.crc32(data) & 0xFFFFFFFF
  const checksum = zlib.crc32(data) >>> 0;
  const pieces = [];
  for (let i = 0; i < data.length; i += chunk) pieces.push(data.subarray(i, i + chunk));
  if (pieces.length === 0) pieces.push(Buffer.alloc(0));
  const total = pieces.length;
  const topic = `${user}/ws-b2d/${device}`;

  // Arm the device-event watcher before publishing so the mailbox is open when
  // the device replies with display.WriteComplete after applying this write. The
  // editor polls /sleep/status for writeCompleteAt (e.g. to gate a sleep command
  // on the real write ack instead of a fixed delay).
  await startSleepWatch({ user, device, client: (req.body || {}).client });

  let sent = 0, totalBytes = 0;
  try {
    // firmware expects 1-based chunkId
    for (let cid = 1; cid <= total; cid++) {
      let bytes;
      try {
        bytes = BrokerToDevice.encode(BrokerToDevice.fromObject({
          display: {
            write: {
              name,
              image: {
                checksum,
                size: data.length,
                chunkId: cid,
                chunkTotal: total,
                chunkData: pieces[cid - 1],
              },
            },
          },
        })).finish();
      } catch (e) {
        return res.status(400).json({ error: 'failed to encode canvas write', chunk: cid, sent, detail: String(e.message || e) });
      }

      // Round-trips exactly through the broker's Buffer.from(payload, 'latin1').
      const payload = Buffer.from(bytes).toString('latin1');
      const echo = await fetch(`${PROTOMQ_URL}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, payload }),
      });
      if (!echo.ok) {
        const body = await echo.text();
        return res.status(502).json({ error: 'ProtoMQ echo rejected', status: echo.status, chunk: cid, sent, detail: body.slice(0, 500) });
      }
      sent++;
      totalBytes += bytes.length;
    }
  } catch (e) {
    return res.status(502).json({ error: `could not reach ProtoMQ broker at ${PROTOMQ_URL}`, sent, detail: String(e.message || e) });
  }

  res.json({ ok: true, topic, chunks: total, checksum, size: data.length, bytes: totalBytes, watching: sleepWatch.clients });
});

// ---- Goodnight watcher (ProtoMQ delivery tracker) --------------------------
//
// The device replies to a sleep command by publishing a DeviceToBroker
// { sleep: { goodnight: {} } } on {user}/ws-d2b/{device}. We can't subscribe to
// MQTT here (publish-only), so we poll ProtoMQ's HTTP "delivery tracker":
//   POST /api/track_deliveries   { client }   opens (or empties) a per-client mailbox
//   POST /api/dump_deliveries    { client }   returns + empties that mailbox, keeps tracking
//   POST /api/untrack_deliveries { client }   closes the mailbox
// The broker files each packet into the *publishing client's* outbox, so the
// mailbox is keyed by the device's MQTT client id — which we don't know for
// certain. We therefore track a few candidate ids derived from user/device and
// report which one actually produced the Goodnight (self-documenting).
//
// Both track and dump empty the mailbox WITHOUT closing it, so a mailbox stays
// open for the whole watch and the poll loop only dumps. This matters: the
// broker's tracker is the only record of a device->broker packet, and it drops
// anything published while the client is untracked. Re-arming per poll (or after
// telling the device to sleep) opened exactly that window and silently ate the
// Goodnight it was waiting for.

// Device events are an append-only LOG, not a set of latches.
//
// The device pipelines its replies with no gap between them — it publishes
// checkin.complete and then, because the wake-checkin response already carried a
// sleepConfig, sleep.goodnight microseconds later. Any design that clears or
// re-arms per cycle therefore has a window in which a real event arrives and is
// thrown away, and no amount of narrowing that window closes it. So nothing here
// is ever cleared: each event gets a monotonic seq, the frontend reads with a
// cursor and CONSUMES what it has handled. An event that shows up while the
// frontend is between stages just waits in the log.
//
// The *At/matched* fields are kept as a most-recent summary for diagnostics only;
// the log is the source of truth.
const SLEEP_LOG_MAX = 200;
const sleepWatch = {
  active: false, clients: [], user: null, device: null,
  writeCompleteAt: null, matchedWriteClient: null,
  goodnightAt: null, matchedClient: null,
  checkinAt: null, matchedCheckinClient: null,
  startedAt: null, armedAt: null, packetsSeen: 0,
  watchUntil: null, lastError: null,
  // watchId changes only when the watch retargets a different device, which is
  // the one case the frontend must resync its cursor for. seq is monotonic for
  // the life of the process so a cursor can never be ambiguous.
  watchId: 0, seq: 0, log: [],
};

// Append one device event and update the summary fields.
function recordSleepEvent(type, client) {
  const at = Date.now();
  const seq = ++sleepWatch.seq;
  sleepWatch.log.push({ seq, type, at, client });
  if (sleepWatch.log.length > SLEEP_LOG_MAX) {
    sleepWatch.log.splice(0, sleepWatch.log.length - SLEEP_LOG_MAX);
  }
  if (type === 'write')     { sleepWatch.writeCompleteAt = at; sleepWatch.matchedWriteClient = client; }
  if (type === 'goodnight') { sleepWatch.goodnightAt = at;     sleepWatch.matchedClient = client; }
  if (type === 'checkin')   { sleepWatch.checkinAt = at;       sleepWatch.matchedCheckinClient = client; }
  console.log(`[sleep] ${type} from client "${client}" (seq ${seq})`);
}
let sleepPollTimer = null;
// pollSleepEventsOnce does several sequential round trips per tick against a
// 2s interval, so ticks can overlap; without this they race on sleepWatch.
let sleepPollInFlight = false;

function pmApi(path, body) {
  return fetch(`${PROTOMQ_URL}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json()).catch(() => ({}));
}

// The broker's teardown routes (wake responses, autoresponders) are DELETEs that
// read their key from the request body, so they need the same JSON envelope.
function pmApiDelete(path, body) {
  return fetch(`${PROTOMQ_URL}${path}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  }).then(r => r.json()).catch(() => ({}));
}

// Candidate MQTT client ids to watch, derived from the topic's user/device.
// WipperSnapper devices connect as "io-wipper-<device>" (matches ProtoMQ's own
// client.id.startsWith('io-wipper-') check), so that is the primary candidate;
// the plainer forms are kept as fallbacks for other client-id schemes.
function watchCandidateIds(user, device, explicit) {
  const ids = [];
  if (explicit) ids.push(explicit);
  if (device) ids.push(`io-wipper-${device}`);
  if (device) ids.push(device);
  if (user) ids.push(user);
  if (user && device) ids.push(`${user}:${device}`);
  return [...new Set(ids)];
}

// Open a mailbox (or empty an already-open one) so this cycle starts clean and
// the client is tracked continuously from here on. Idempotent on the broker.
function armMailbox(clientId) {
  return pmApi('/api/track_deliveries', { client: clientId });
}

// Close mailboxes we no longer poll, so the broker isn't left tracking clients
// forever now that dump keeps them open.
function releaseMailboxes(clientIds) {
  return Promise.all(clientIds.map(cid => pmApi('/api/untrack_deliveries', { client: cid })));
}

// The watch is over: stop polling and hand the mailboxes back. `clients` and the
// event fields are left alone — /sleep/status still reports what this cycle saw
// (or didn't), and startSleepWatch clears them for the next one.
function stopSleepWatch() {
  sleepWatch.active = false;
  if (sleepPollTimer) { clearInterval(sleepPollTimer); sleepPollTimer = null; }
  const held = sleepWatch.armedAt ? sleepWatch.clients.slice() : [];
  sleepWatch.armedAt = null;
  return releaseMailboxes(held);
}

// dump_deliveries returns each packet as { topic, payload }, where payload is
// ProtoMQ's already-decoded message (JSON) when the topic is a known protobuf
// topic. We watch three device->broker events on ws-d2b:
//   display.writeComplete -> the device finished applying a canvas/BMP write
//   sleep.goodnight       -> the device is entering sleep now
//   checkin.complete      -> the device woke and finished checking back in
// (writeComplete is an empty message — presence of the key is the signal.)
// Returns the events IN ARRIVAL ORDER, not a set of flags. Order is what lets the
// frontend tell "woke up, then went back to sleep" (checkin, goodnight) from the
// reverse, and both land in a single dump when the device pipelines them.
// `seen` counts the ws-d2b packets this dump contained, so the editor can tell
// "the mailbox is open but the device is quiet" apart from "we're watching the
// wrong client id and will never see anything".
function scanDump(deliveries) {
  const packets = [...(deliveries?.inbox || []), ...(deliveries?.outbox || [])];
  const events = [];
  let seen = 0;
  for (const p of packets) {
    if (typeof p.topic !== 'string' || !p.topic.includes('/ws-d2b/')) continue;
    seen++;
    const pl = p.payload;
    if (pl?.display?.writeComplete !== undefined) events.push('write');
    if (pl?.sleep?.goodnight !== undefined) events.push('goodnight');
    if (pl?.checkin?.complete !== undefined) events.push('checkin');
  }
  return { events, seen };
}

async function pollSleepEventsOnce() {
  if (!sleepWatch.active || sleepPollInFlight) return;
  // Self-expire so a write-only watch (send-bmp with no following sleep) doesn't
  // dump the broker's mailboxes forever. A sleep cycle extends watchUntil to
  // cover the full duration + checkin grace (see /sleep/config).
  if (sleepWatch.watchUntil && Date.now() > sleepWatch.watchUntil) {
    await stopSleepWatch();
    return;
  }
  sleepPollInFlight = true;
  try {
    for (const cid of sleepWatch.clients.slice()) {
      // narrowWatchToClient may have dropped (and untracked) this id mid-tick.
      if (!sleepWatch.clients.includes(cid)) continue;
      try {
        // Dump only: the mailbox stays open, so a packet published while this
        // request is in flight lands in the next dump instead of being lost.
        const dump = await pmApi('/api/dump_deliveries', { client: cid });
        if (!dump || dump.status !== 'OK') continue;
        const { events, seen } = scanDump(dump.deliveries);
        sleepWatch.packetsSeen += seen;
        for (const type of events) recordSleepEvent(type, cid);
        if (seen) narrowWatchToClient(cid);
        // NOTE: checkin.complete does NOT stop the watch. The device sends
        // sleep.goodnight for the next cycle immediately after it, so tearing the
        // watch down here (releasing the mailbox, then rebuilding it when the
        // frontend re-arms) dropped that goodnight every single cycle. The watch
        // now runs until watchUntil, which each cycle extends.
      } catch (e) {
        sleepWatch.lastError = String(e.message || e);
      }
    }
  } finally {
    sleepPollInFlight = false;
  }
}

// Once a candidate id has actually produced ws-d2b traffic, it is the device's
// real MQTT client id — the others are guesses that can never match (the broker
// keys mailboxes by the publishing client's CONNECT id). Drop them so we stop
// dumping empty mailboxes every tick and the frontend shows one id, not four.
function narrowWatchToClient(clientId) {
  const dead = sleepWatch.clients.filter(cid => cid !== clientId);
  if (!dead.length) return;
  sleepWatch.clients = [clientId];
  releaseMailboxes(dead).catch(() => {});
  console.log(`[sleep] narrowed watch to client "${clientId}" (dropped ${dead.join(', ')})`);
}

// Ensure the device-event watcher is armed for {user, device}. Starting a NEW
// cycle clears any prior write/goodnight/checkin so the frontend only ever sees
// events fresh from this cycle; re-calling it for a cycle already in flight just
// extends the window (see the note inside — clearing there loses live events).
// Stays active until watchUntil (ttlMs from now); each cycle extends it. ttlMs
// defaults to a short write-ack window; /sleep/config passes a longer TTL to
// cover the full sleep duration + wake/checkin grace.
// Callers MUST await this before publishing anything the device replies to: the
// arm is what opens the mailboxes, and the broker discards traffic from an
// untracked client. Arming after the publish is how the Goodnight got lost.
async function startSleepWatch({ user, device, client, ttlMs = 120000 }) {
  // Already watching this device with its mailboxes open? Extend the window and
  // keep everything we've collected.
  //
  // Re-arming would drain the broker mailboxes and null the event timestamps
  // below, which DISCARDS EVENTS THAT ALREADY ARRIVED. The device does not wait
  // for a sleep command before sleeping — it uses the wake-checkin config the
  // broker replays — so it publishes display.writeComplete and sleep.goodnight
  // back-to-back and both routinely land in a single dump. The editor then acks
  // the write and only afterwards POSTs /sleep/config; re-arming there threw the
  // Goodnight away and left the panel waiting forever for one the device had
  // already sent (it is asleep and will not repeat it).
  //
  // Preserving is safe because nothing here is consumed by the backend: the
  // frontend advances its own cursor past events it has handled, so a leftover
  // event cannot be mistaken for a fresh one.
  if (sleepWatch.active && sleepWatch.armedAt
      && sleepWatch.user === user && sleepWatch.device === device) {
    sleepWatch.watchUntil = Date.now() + ttlMs;
    return;
  }
  // A genuinely new target: drop the old device's event history and bump watchId
  // so the frontend knows to resync its cursor. seq stays monotonic.
  sleepWatch.log = [];
  sleepWatch.watchId++;
  // Hand back any mailboxes from a previous cycle we're no longer watching.
  const stale = sleepWatch.armedAt ? sleepWatch.clients.slice() : [];
  sleepWatch.active = true;
  sleepWatch.user = user;
  sleepWatch.device = device;
  sleepWatch.clients = watchCandidateIds(user, device, client);
  sleepWatch.writeCompleteAt = null;
  sleepWatch.matchedWriteClient = null;
  sleepWatch.goodnightAt = null;
  sleepWatch.matchedClient = null;
  sleepWatch.checkinAt = null;
  sleepWatch.matchedCheckinClient = null;
  sleepWatch.startedAt = Date.now();
  sleepWatch.packetsSeen = 0;
  sleepWatch.watchUntil = Date.now() + ttlMs;
  sleepWatch.lastError = null;
  const dropped = stale.filter(cid => !sleepWatch.clients.includes(cid));
  if (dropped.length) releaseMailboxes(dropped).catch(() => {});
  // track_deliveries empties an already-open mailbox in place, so this both
  // opens the mailboxes and clears anything left over from the last cycle.
  await Promise.all(sleepWatch.clients.map(armMailbox));
  sleepWatch.armedAt = Date.now();
  if (!sleepPollTimer) sleepPollTimer = setInterval(pollSleepEventsOnce, 2000);
}

/**
 * GET /sleep/status[?since=<seq>]
 * Poll target for the editor.
 *
 * With ?since, returns `events` — every device event with seq > since, in arrival
 * order — plus `seq`, the newest seq in the log. That is the reliable feed: the
 * caller advances its cursor only past events it has actually handled, so an
 * event arriving mid-stage is picked up on a later poll instead of being lost.
 * `watchId` changes only when the watch retargets a different device, which is
 * the one case a caller must discard its cursor and resync.
 *
 * Without ?since, `events` is empty and only the summary fields are meaningful:
 * writeCompleteAt (canvas/BMP write applied), goodnightAt (entering sleep) and
 * checkinAt (woke + checked back in) are the MOST RECENT of each, for display and
 * diagnostics — they are latches and must not be used to drive the cycle.
 */
app.get('/sleep/status', (req, res) => {
  const since = Number(req.query.since);
  res.json({
    watchId: sleepWatch.watchId,
    seq: sleepWatch.seq,
    events: Number.isFinite(since) ? sleepWatch.log.filter(e => e.seq > since) : [],
    active: sleepWatch.active,
    clients: sleepWatch.clients,
    device: sleepWatch.device,
    writeCompleteAt: sleepWatch.writeCompleteAt,
    matchedWriteClient: sleepWatch.matchedWriteClient,
    goodnightAt: sleepWatch.goodnightAt,
    matchedClient: sleepWatch.matchedClient,
    checkinAt: sleepWatch.checkinAt,
    matchedCheckinClient: sleepWatch.matchedCheckinClient,
    startedAt: sleepWatch.startedAt,
    // armedAt is null until the mailboxes are actually open, and packetsSeen
    // counts the ws-d2b packets dumped so far. Together they let the frontend
    // say "armed, device quiet" instead of implying an id mismatch.
    armedAt: sleepWatch.armedAt,
    packetsSeen: sleepWatch.packetsSeen,
    error: sleepWatch.lastError,
  });
});

// ---- /sleep/config (ProtoMQ echo) ------------------------------------------

/**
 * POST /sleep/config
 * Encode a BrokerToDevice { sleep: { sleepConfig: { mode, timer } } } and
 * forward it to ProtoMQ's echo API, telling the device to enter a sleep mode.
 * Structurally identical to /display/add. Only the TimerConfig wakeup source is
 * supported for now (Ext0Config is deferred).
 *
 * body: {
 *   duration,                   // TimerConfig.duration, seconds (uint32). ALSO
 *                               // selects the mode: >= 300s deep, else light.
 *   user, device,               // -> topic {user}/ws-b2d/{device}
 *   display,                    // optional: deep-sleep wake re-provision
 * }
 * returns: { ok, topic, bytes, mode, duration, watching, wakeCheckin }
 *
 * A `mode` in the body is IGNORED, not rejected (see DEEP_SLEEP_THRESHOLD_SECS).
 * Honouring one would restore exactly the divergence deriving it removes — a page
 * loaded before this change keeps POSTing S_DEEP with duration 15 forever — and
 * 400ing one would break bench curls for no gain. Callers that need to know what
 * was sent read `mode` back off the response.
 */
// Register a persistent wake response with the ProtoMQ broker for a device we're
// deep-sleeping so it keeps cycling (re-sleeps on every wake). Only fires for
// S_DEEP. When a `display` config is supplied (canvas changed this cycle) the
// response re-adds the display on wake so it can be redrawn; when `display` is
// omitted (canvas unchanged), the response carries ONLY sleepEnabled +
// sleepConfig — no displayAdds — so the device just re-sleeps and its e-ink keeps
// the already-shown image (no re-provision or redraw). Both branches are live:
// the editor picks between them per cycle from its change signature, and flips an
// existing registration mid-sleep via /sleep/wake-response. Returns a small
// status object for the caller's reply. Never throws — sleep must succeed even if
// the broker registration fails.
async function registerWakeResponse({ mode, secs, user, device, display }) {
  // Only deep sleep needs a stored response — but a non-deep mode is NOT a no-op.
  // Any response left over from an earlier deep-sleep cycle would keep
  // re-provisioning the device and sending it back to deep sleep on every
  // checkin, ignoring the mode the editor now has. Dropping the interval below
  // DEEP_SLEEP_THRESHOLD_SECS therefore has to REMOVE the registration, not just
  // decline to write one — the mode is a function of `secs`, so that is what
  // "switching away from deep sleep" now looks like.
  if (mode !== 'S_DEEP') {
    const del = await pmApiDelete('/api/wake-checkin', { user, device });
    const removed = del && del.status === 'OK' ? del.removed : null;
    if (removed) console.log(`[wake-checkin] removed stored response for "${user}/${device}" (mode is ${mode})`);
    return { registered: false, reason: 'not deep sleep', cleared: removed };
  }

  let displayAdd;
  if (display) {
    try {
      displayAdd = buildDisplayAdd(display);
    } catch (e) {
      console.warn('[wake-checkin] could not build display add:', e.message);
      return { registered: false, error: String(e.message || e) };
    }
  }

  const body = {
    user, device,
    ...(displayAdd ? { displayAdd } : {}),
    sleepConfig: { mode, timer: { duration: secs } },
    sleepEnabled: true,
  };

  try {
    const r = await fetch(`${PROTOMQ_URL}/api/wake-checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.warn(`[wake-checkin] broker rejected registration (${r.status}):`, data.message || '');
      return { registered: false, status: r.status, error: data.message || 'broker rejected' };
    }
    console.log(`[wake-checkin] registered wake response for "${user}/${device}"${displayAdd ? ' (with display re-add)' : ' (sleep-only, canvas unchanged)'}`);
    return { registered: true, key: data.key, includedDisplay: !!displayAdd };
  } catch (e) {
    console.warn('[wake-checkin] could not reach broker:', String(e.message || e));
    return { registered: false, error: String(e.message || e) };
  }
}

app.post('/sleep/config', async (req, res) => {
  if (!BrokerToDevice) {
    return res.status(501).json({ error: 'ProtoMQ bundle not loaded on server; cannot encode sleep config' });
  }

  const {
    duration = 0,
    user = 'test_user', device = 'magtag',
    display,
  } = req.body || {};

  const secs = Math.max(0, Math.floor(Number(duration)) || 0);
  // Derived, not requested — a `mode` in the body is ignored.
  const mode = sleepModeFor(secs);

  let bytes;
  try {
    // fromObject converts the string enum name ("S_LIGHT"/"S_DEEP") to its
    // numeric value before encoding.
    bytes = BrokerToDevice.encode(BrokerToDevice.fromObject({
      sleep: { sleepConfig: { mode, timer: { duration: secs } } },
    })).finish();
  } catch (e) {
    return res.status(400).json({ error: 'failed to encode sleep config', detail: String(e.message || e) });
  }

  // Round-trips exactly through the broker's Buffer.from(payload, 'latin1').
  const payload = Buffer.from(bytes).toString('latin1');
  const topic = `${user}/ws-b2d/${device}`;

  try {
    // Watch for the device's Goodnight reply and its checkin.complete after it
    // wakes (clears any prior events from an earlier cycle). This MUST happen
    // before the echo below: the device can publish its Goodnight within
    // milliseconds of receiving the sleep command, and the broker discards
    // traffic from a client it isn't tracking yet — which is exactly how the
    // Goodnight used to go missing while the panel sat on "Waiting for device
    // Goodnight". Same reason /display/send-bmp arms before it publishes.
    //
    // The TTL covers the full sleep duration plus the large, roughly-fixed
    // deep-sleep wake overhead (boot + reconnect + checkin + display
    // re-provision + EPD redraw + checkin.complete). It must OUTLIVE the
    // client's checkin window (waitForSleepEvents WAKE_CHECKIN_MS = 120s) so the
    // backend is still polling the mailbox when a late checkin.complete lands —
    // hence 150s of headroom.
    await startSleepWatch({ user, device, client: req.body.client, ttlMs: secs * 1000 + 150000 });

    const echo = await fetch(`${PROTOMQ_URL}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, payload }),
    });
    if (!echo.ok) {
      const body = await echo.text();
      return res.status(502).json({ error: 'ProtoMQ echo rejected', status: echo.status, detail: body.slice(0, 500) });
    }

    // Deep sleep: register a one-shot wake response with the broker so the
    // device gets re-provisioned (display re-added) and sent back to sleep when
    // it checks in after waking. "Was just deep-slept" IS the wake signal; a
    // cold boot has no registration. Best-effort — a registration failure must
    // not fail the sleep command the device already received.
    const wakeCheckin = await registerWakeResponse({ mode, secs, user, device, display });

    res.json({ ok: true, topic, bytes: bytes.length, mode, duration: secs, watching: sleepWatch.clients, wakeCheckin });
  } catch (e) {
    return res.status(502).json({ error: `could not reach ProtoMQ broker at ${PROTOMQ_URL}`, detail: String(e.message || e) });
  }
});

/**
 * POST /sleep/wake-response
 * Re-register (or downgrade) the broker's persistent wake response WITHOUT
 * echoing a sleep command to the device. The broker decides what a waking device
 * receives from whatever is registered at checkin time, so the editor flips this
 * registration as the canvas changes:
 *   canvas edited mid-sleep -> re-register WITH `display`, so the device
 *                              re-provisions on wake and can accept a new write
 *   write confirmed          -> re-register WITHOUT `display`, so the next wake
 *                              sends nothing and the e-ink keeps its image
 *
 * body: {
 *   duration,                    // must match the sleep the device is running; it
 *                                // also selects the mode (>= 300s deep, else
 *                                // light). A `mode` in the body is ignored.
 *   user, device,                // -> wake-checkin key {user}/{device}
 *   display,                     // omit for the sleep-only response
 *   client, rearmMs,             // optional: also re-arm the device-event watch
 * }
 * returns: { ok, mode, duration, wakeCheckin, watching }
 *
 * `rearmMs` exists because pollSleepEventsOnce deactivates the watch on checkin
 * and /display/send-bmp is what normally re-arms it for the next cycle. A cycle
 * that sends nothing never POSTs send-bmp, so it must re-arm here or the loop
 * stops after one wake. It is opt-in because startSleepWatch clears
 * goodnightAt/checkinAt — a mid-sleep re-register must NOT wipe the in-flight
 * countdown.
 */
app.post('/sleep/wake-response', async (req, res) => {
  const {
    duration = 0,
    user = 'test_user', device = 'magtag',
    display, rearmMs,
  } = req.body || {};

  const secs = Math.max(0, Math.floor(Number(duration)) || 0);
  // Derived, not requested — same rule /sleep/config uses, so a re-registration
  // cannot disagree with the sleep the device is already running.
  const mode = sleepModeFor(secs);

  const wakeCheckin = await registerWakeResponse({ mode, secs, user, device, display });

  if (rearmMs) {
    await startSleepWatch({ user, device, client: req.body.client, ttlMs: Number(rearmMs) });
  }

  // `mode` is reported so the editor records what the broker chose rather than what
  // it guessed locally — if the two ever drift, this is the one the device obeys.
  res.json({ ok: true, mode, duration: secs, wakeCheckin, watching: sleepWatch.clients });
});

// ---- /reset ----------------------------------------------------------------

/**
 * POST /reset
 * Tear down every piece of state an editing session leaves behind, on this server
 * AND on the broker, so the next action starts from a known-empty world:
 *
 *   1. the device-event watch — its poll timer plus the broker delivery mailboxes
 *      ("listeners") it holds open for the device's client ids
 *   2. the event log itself, with a watchId bump so the editor's cursor resyncs
 *      instead of replaying a previous cycle's goodnight/checkin
 *   3. the broker's persistent wake response for {user}/{device} — the thing that
 *      re-provisions a waking device and sends it back to sleep, i.e. what keeps
 *      the goodnight/wake loop alive after the editor stops driving it
 *   4. the broker's registered protobuf autoresponders (the "PBResponse
 *      listeners"), so nothing left over from a play-script keeps answering the
 *      device. The default checkin fallback is separate and stays enabled.
 *   5. canvas.json — emptied of elements, keeping the display block so the panel
 *      geometry the editor is configured for survives the reset
 *
 * Every step is best-effort and reported individually: a broker that is down must
 * not stop us from clearing what we own locally. Nothing here is fatal, so the
 * response is always 200 with a per-step breakdown.
 *
 * body: { user, device, clearCanvas? }
 * returns: { ok, watch, wakeCheckin, autoresponders, canvas }
 */
app.post('/reset', async (req, res) => {
  const {
    user = 'test_user', device = 'magtag',
    clearCanvas = true,
  } = req.body || {};

  const out = { watch: {}, wakeCheckin: {}, autoresponders: {}, canvas: {} };

  // 1 + 2. Stop polling and hand back every mailbox that could still be open.
  // stopSleepWatch only releases what the CURRENT watch holds, and a watch that
  // already self-expired left its ids tracked on the broker — so untrack the full
  // candidate set for the target device too. untrack_deliveries answers ERROR for
  // an unknown client, which is the expected no-op here, not a failure.
  try {
    const held = sleepWatch.clients.slice();
    await stopSleepWatch();
    const candidates = watchCandidateIds(user, device, req.body && req.body.client);
    const released = [...new Set([...held, ...candidates])];
    await releaseMailboxes(released);
    sleepWatch.clients = [];
    sleepWatch.user = null;
    sleepWatch.device = null;
    sleepWatch.writeCompleteAt = null;
    sleepWatch.matchedWriteClient = null;
    sleepWatch.goodnightAt = null;
    sleepWatch.matchedClient = null;
    sleepWatch.checkinAt = null;
    sleepWatch.matchedCheckinClient = null;
    sleepWatch.startedAt = null;
    sleepWatch.packetsSeen = 0;
    sleepWatch.watchUntil = null;
    sleepWatch.lastError = null;
    sleepWatch.log = [];
    // seq stays monotonic (a cursor must never be ambiguous); watchId changing is
    // the documented signal for the editor to drop its cursor and resync.
    sleepWatch.watchId++;
    out.watch = { stopped: true, released, watchId: sleepWatch.watchId, seq: sleepWatch.seq };
  } catch (e) {
    out.watch = { stopped: false, error: String(e.message || e) };
  }

  // 3. Drop the wake response the broker replays on every checkin.
  const wake = await pmApiDelete('/api/wake-checkin', { user, device });
  out.wakeCheckin = wake && wake.status === 'OK'
    ? { cleared: true, removed: wake.removed }
    : { cleared: false, error: (wake && wake.message) || 'broker unreachable' };

  // 4. Drop every registered autoresponder.
  const auto = await pmApiDelete('/api/autoresponse', {});
  out.autoresponders = auto && auto.status === 'OK'
    ? { cleared: true, removed: auto.removed }
    : { cleared: false, error: (auto && auto.message) || 'broker unreachable' };

  // 5. Empty the persisted layout, preserving the display descriptor.
  if (clearCanvas) {
    try {
      let doc = { version: 1 };
      try {
        const prev = JSON.parse(await fs.readFile(CANVAS_FILE, 'utf8'));
        if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
          doc = { ...prev, version: prev.version || 1 };
        }
      } catch { /* missing or corrupt — start from a bare document */ }
      doc.elements = [];
      await fs.writeFile(CANVAS_FILE, JSON.stringify(doc, null, 2));
      out.canvas = { cleared: true, file: path.basename(CANVAS_FILE) };
    } catch (e) {
      out.canvas = { cleared: false, error: String(e.message || e) };
    }
  } else {
    out.canvas = { cleared: false, skipped: true };
  }

  console.log(`[reset] watch=${out.watch.stopped ? 'stopped' : 'FAILED'}`
    + ` wake-checkin=${out.wakeCheckin.cleared ? `cleared(${out.wakeCheckin.removed})` : 'FAILED'}`
    + ` autoresponders=${out.autoresponders.cleared ? `cleared(${out.autoresponders.removed})` : 'FAILED'}`
    + ` canvas=${out.canvas.cleared ? 'cleared' : (out.canvas.skipped ? 'skipped' : 'FAILED')}`);

  res.json({ ok: true, ...out });
});

// ---- health ----------------------------------------------------------------

// ---- Canvas autosave ---------------------------------------------------------
// The editor persists the whole canvas layout (the serialize() document from the
// browser) to a JSON file on every edit, so the current design is the internal
// source of truth on disk and can be inspected/round-tripped. This is separate
// from the browser localStorage that holds display/sleep/IO config.
const CANVAS_FILE = path.join(__dirname, 'canvas.json');

app.get('/canvas', async (_req, res) => {
  try {
    const raw = await fs.readFile(CANVAS_FILE, 'utf8');
    res.type('application/json').send(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return res.json(null); // nothing saved yet
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/canvas', async (req, res) => {
  // Accept either { doc: {...} } or a bare document object.
  const doc = req.body && typeof req.body.doc === 'object' && req.body.doc !== null
    ? req.body.doc : req.body;
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    return res.status(400).json({ ok: false, error: 'expected a canvas document object' });
  }
  try {
    await fs.writeFile(CANVAS_FILE, JSON.stringify(doc, null, 2));
    res.json({ ok: true, file: path.basename(CANVAS_FILE) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/health', async (_req, res) => {
  try {
    const out = await runConvert(['-version']);
    const line = out.toString().split('\n')[0];
    res.json({ ok: true, imagemagick: line, palettes: Object.values(REMAP_FILES) });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'ImageMagick not found on PATH', detail: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`marquee editor + render backend on http://localhost:${PORT}`);
  console.log(`  GET  /          the editor (served from public/index.html)`);
  console.log(`  POST /render    dither + remap -> { bmp, png, sizes }`);
  console.log(`  POST /publish   render + push to Adafruit IO (needs AIO_USER/AIO_KEY)`);
  console.log(`  POST /display/add  build display.Add -> ProtoMQ echo (${PROTOMQ_URL})`);
  console.log(`  POST /display/send-bmp  chunk BMP -> canvas writes -> ProtoMQ echo`);
  console.log(`  POST /sleep/config  build sleep.SleepConfig -> ProtoMQ echo (${PROTOMQ_URL})`);
  console.log(`  GET  /sleep/status  poll for a device Goodnight (ProtoMQ delivery tracker)`);
  console.log(`  POST /sleep/wake-response  re-register the broker wake response (no sleep command)`);
  console.log(`  POST /reset     clear the watch, broker wake response + autoresponders, and canvas.json`);
  console.log(`  GET  /canvas    read the persisted canvas.json layout`);
  console.log(`  POST /canvas    persist the canvas layout to canvas.json`);
  console.log(`  GET  /health    ImageMagick + palette check`);
});
