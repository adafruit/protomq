#!/usr/bin/env python3
"""Bridge a live Adafruit IO feed -> chunked Canvas frames on a local protoMQ.

PoC harness for Wippersnapper_Protobuf PR #205 (spike/canvas): drive the new
`display.Canvas` chunked-image path on a real MagTag (Arduino WipperSnapper)
using *production* Adafruit IO as the data source, but a *local* protoMQ broker
as the transport the device is actually connected to.

Flow:
    io.adafruit.com  (prod MQTT, TLS 8883)
        subscribe  <AIO_USER>/feeds/<AIO_FEED>
            on message -> image bytes (raw / base64 / http(s) URL to fetch)
        -> split into CHUNK_SIZE-byte pieces
        -> encode each as ws.signal.BrokerToDevice.display{ B2D.write{ Write.image = Canvas } }
    local protoMQ
        publish each chunk to  <WS_IO_USER>/ws-b2d/<MAGTAG_UID>
            via POST /api/echo   (default; same path the HIL injectors use)
            or  direct MQTT :1884 (--mqtt-direct)

The MagTag reassembles by chunk_id/total_size/checksum and renders.

This is deliberately dependency-light: aiomqtt + httpx (+ optional Pillow only if
you ask it to convert a real BMP/PNG to packed mono). Nothing here imports the
controller or the firmware.

    Env:
      AIO_USERNAME / AIO_KEY     prod Adafruit IO creds
      AIO_FEED                   feed key carrying the image (default: canvas)
      WS_IO_USER                 io-user the MagTag checked in as on protoMQ (default: hil)
      MAGTAG_UID                 the device uid (the ws-b2d/<uid> segment)
      DISPLAY_NAME               Write.name = target display component (default: epd)
      PROTOMQ_HOST               default: localhost
      PROTOMQ_API_PORT           /api/echo port (default: 5173)
      PROTOMQ_MQTT_PORT          direct-publish port (default: 1884)
      CHUNK_SIZE                 bytes of chunk_data per frame (default: 512)
      CHUNK_DELAY_S              pause between chunks for device flow control (default: 0.15)

    Run:
      AIO_USERNAME=... AIO_KEY=... MAGTAG_UID=magtag-abc123 \
        python aio_to_protomq_canvas.py                 # echo endpoint
      python aio_to_protomq_canvas.py --mqtt-direct     # publish straight to :1884
      python aio_to_protomq_canvas.py --once ./logo.bmp # no AIO; push one local file and exit
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import os
import ssl
import sys
import zlib

import aiomqtt
import httpx

# --------------------------------------------------------------------------- #
# protobuf wire helpers (varint + length-delimited) — no generated code needed #
# --------------------------------------------------------------------------- #
def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _vint_field(field: int, value: int) -> bytes:
    return _varint((field << 3) | 0) + _varint(value)


def _len_field(field: int, payload: bytes) -> bytes:
    return _varint((field << 3) | 2) + _varint(len(payload)) + payload


# Field numbers from Wippersnapper_Protobuf PR #205 + the existing display path.
#   ws.display.Canvas { id=1, checksum=2, total_size=3, chunk_id=4, chunk_total=5, chunk_data=6 }
#   ws.display.Write  { name=1, descriptor=2, message=3, image=4 (Canvas) }
#   ws.display.B2D.write = 3
#   ws.signal.BrokerToDevice.display = 36
_WRITE_NAME = 1
_WRITE_IMAGE = 4
_B2D_WRITE = 3
_SIGNAL_DISPLAY = 36


def encode_canvas_chunk(
    *, image_id: int, checksum: int, total_size: int, chunk_id: int, chunk_total: int, data: bytes
) -> bytes:
    """ws.display.Canvas for one chunk."""
    return (
        _vint_field(1, image_id)
        + _vint_field(2, checksum)
        + _vint_field(3, total_size)
        + _vint_field(4, chunk_id)
        + _vint_field(5, chunk_total)
        + _len_field(6, data)
    )


def encode_canvas_signal(display_name: str, canvas: bytes) -> bytes:
    """Wrap a Canvas in Write.image -> B2D.write -> BrokerToDevice.display."""
    write = _len_field(_WRITE_NAME, display_name.encode()) + _len_field(_WRITE_IMAGE, canvas)
    b2d = _len_field(_B2D_WRITE, write)
    return _len_field(_SIGNAL_DISPLAY, b2d)


def chunkify(image: bytes, chunk_size: int, image_id: int, display_name: str) -> list[bytes]:
    """Split `image` into a list of ready-to-publish BrokerToDevice payloads."""
    # NOTE: the firmware defines what `checksum` must be. CRC32 of the whole
    #   image is the obvious default — confirm against the Canvas reassembly code
    #   in the MagTag branch and change this one line if it expects sum/Adler/etc.
    checksum = zlib.crc32(image) & 0xFFFFFFFF
    total = len(image)
    pieces = [image[i : i + chunk_size] for i in range(0, total, chunk_size)] or [b""]
    frames = []
    for idx, piece in enumerate(pieces):
        canvas = encode_canvas_chunk(
            image_id=image_id,
            checksum=checksum,
            total_size=total,
            chunk_id=idx,
            chunk_total=len(pieces),
            data=piece,
        )
        frames.append(encode_canvas_signal(display_name, canvas))
    return frames


# --------------------------------------------------------------------------- #
# image acquisition from a feed value                                          #
# --------------------------------------------------------------------------- #
#: leading marker some dashboards/feeds prepend before the base64 (e.g. the value
#: arrives as ``imageiVBORw0K...``). Stripped before decode — the marker chars are
#: valid base64 alphabet, so they'd silently corrupt the decode if left in.
FEED_MARKER = os.environ.get("FEED_MARKER", "image")


async def resolve_image(value: bytes) -> bytes:
    """Turn a feed value into the pre-formatted image bytes we chunk verbatim.

    Handles, in order: an http(s) URL (fetched), a ``data:`` URL, a bare base64
    blob (optionally prefixed with FEED_MARKER), and finally raw bytes. We do NOT
    reformat the image — Brent sends a display-ready BMP (correct size + colour
    depth) that the firmware loads with adafruit_imageload; see image_to_bmp.py
    for the convert-arbitrary-image front end."""
    text = value.decode("utf-8", errors="ignore").strip()
    if text.lower().startswith("http://") or text.lower().startswith("https://"):
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(text)
            r.raise_for_status()
            return r.content
    if text.startswith("data:"):
        text = text.split(",", 1)[-1]
    if FEED_MARKER and text[: len(FEED_MARKER)].lower() == FEED_MARKER.lower():
        text = text[len(FEED_MARKER):].lstrip(" :,\t\r\n")
    # validate=False (the default) discards whitespace/newlines before decoding.
    try:
        decoded = base64.b64decode(text)
        # sanity: a real image starts with a known magic; if not, treat as raw.
        if decoded[:2] in (b"BM", b"\xff\xd8") or decoded[:8] == b"\x89PNG\r\n\x1a\n":
            return decoded
        return decoded or value
    except Exception:
        return value  # already raw bytes


# --------------------------------------------------------------------------- #
# publish sinks                                                                #
# --------------------------------------------------------------------------- #
class EchoSink:
    """POST /api/echo {topic, payload(latin1)} — protoMQ's HTTP publish."""

    def __init__(self, host: str, api_port: int) -> None:
        self.url = f"http://{host}:{api_port}/api/echo"

    async def __aenter__(self):
        self._c = httpx.AsyncClient(timeout=10)
        return self

    async def __aexit__(self, *exc):
        await self._c.aclose()

    async def publish(self, topic: str, payload: bytes) -> None:
        r = await self._c.post(self.url, json={"topic": topic, "payload": payload.decode("latin1")})
        r.raise_for_status()


class MqttSink:
    """Publish raw protobuf straight to protoMQ's MQTT port (no HTTP)."""

    def __init__(self, host: str, mqtt_port: int) -> None:
        self._client = aiomqtt.Client(hostname=host, port=mqtt_port)

    async def __aenter__(self):
        await self._client.__aenter__()
        return self

    async def __aexit__(self, *exc):
        await self._client.__aexit__(*exc)

    async def publish(self, topic: str, payload: bytes) -> None:
        await self._client.publish(topic, payload)


# --------------------------------------------------------------------------- #
# main                                                                         #
# --------------------------------------------------------------------------- #
async def push_image(sink, topic: str, image: bytes, *, chunk_size: int, delay: float,
                     image_id: int, display_name: str) -> None:
    frames = chunkify(image, chunk_size, image_id, display_name)
    print(f"-> {len(image)} bytes as {len(frames)} chunk(s) of <= {chunk_size}B "
          f"to {topic} (crc32={zlib.crc32(image) & 0xFFFFFFFF:#010x}, id={image_id})")
    for i, frame in enumerate(frames):
        await sink.publish(topic, frame)
        print(f"   chunk {i + 1}/{len(frames)} published ({len(frame)}B on the wire)")
        if delay:
            await asyncio.sleep(delay)


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mqtt-direct", action="store_true",
                    help="publish to protoMQ :1884 directly instead of POST /api/echo")
    ap.add_argument("--once", metavar="FILE",
                    help="skip Adafruit IO: push one local image file to the device and exit")
    args = ap.parse_args()

    ws_user = os.environ.get("WS_IO_USER", "hil")
    uid = os.environ.get("MAGTAG_UID", "")
    display_name = os.environ.get("DISPLAY_NAME", "epd")
    host = os.environ.get("PROTOMQ_HOST", "localhost")
    api_port = int(os.environ.get("PROTOMQ_API_PORT", "5173"))
    mqtt_port = int(os.environ.get("PROTOMQ_MQTT_PORT", "1884"))
    chunk_size = int(os.environ.get("CHUNK_SIZE", "512"))
    delay = float(os.environ.get("CHUNK_DELAY_S", "0.15"))

    if not uid:
        print("set MAGTAG_UID to the device uid (the ws-b2d/<uid> segment)", file=sys.stderr)
        return 2
    topic = f"{ws_user}/ws-b2d/{uid}"

    make_sink = (lambda: MqttSink(host, mqtt_port)) if args.mqtt_direct else (lambda: EchoSink(host, api_port))

    # --- single local file, no Adafruit IO ---------------------------------- #
    if args.once:
        with open(args.once, "rb") as f:
            image = f.read()
        async with make_sink() as sink:
            await push_image(sink, topic, image, chunk_size=chunk_size, delay=delay,
                             image_id=1, display_name=display_name)
        return 0

    # --- live bridge: subscribe prod AIO, forward each new frame ------------ #
    aio_user = os.environ["AIO_USERNAME"]
    aio_key = os.environ["AIO_KEY"]
    aio_feed = os.environ.get("AIO_FEED", "canvas")
    feed_topic = f"{aio_user}/feeds/{aio_feed}"

    tls = ssl.create_default_context()
    image_id = 0
    print(f"bridging prod {feed_topic}  ->  {host}:{'%d(mqtt)' % mqtt_port if args.mqtt_direct else '%d(/api/echo)' % api_port}  {topic}")
    async with aiomqtt.Client(hostname="io.adafruit.com", port=8883,
                              username=aio_user, password=aio_key, tls_context=tls) as aio:
        await aio.subscribe(feed_topic)
        async with make_sink() as sink:
            async for msg in aio.messages:
                image_id += 1
                try:
                    image = await resolve_image(bytes(msg.payload))
                    await push_image(sink, topic, image, chunk_size=chunk_size, delay=delay,
                                     image_id=image_id, display_name=display_name)
                except Exception as exc:  # keep the bridge alive across a bad frame
                    print(f"!! frame {image_id} failed: {type(exc).__name__}: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
