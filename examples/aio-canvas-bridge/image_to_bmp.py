#!/usr/bin/env python3
"""Convert an arbitrary image into a display-ready BMP for the Canvas path.

Companion to `aio_to_protomq_canvas.py`. That bridge is deliberately a dumb pipe
-- it assumes the feed already carries a *pre-formatted* bitmap (right panel size
and colour depth) that the firmware loads with adafruit_imageload. This tool is
the front end that produces such a bitmap from whatever you have (a PNG off an
Adafruit IO dashboard, a photo, etc.): resize to the panel, quantise to the
panel's colour depth, and emit an indexed BMP adafruit_imageload can read.

Two backends:
  * PIL (default) -- local convert, no network. mono / 4-gray / N-colour palette.
  * Adafruit IO image-converter service -- set CONVERTER_URL to its endpoint and
    fill in post_to_converter(); we just pass the bytes through and take the BMP
    back. (Left as a clearly-marked stub so nothing is faked.)

Output either to a file (--out) or straight onto an AIO feed as base64 (--feed),
so it drives the pass-through bridge end to end:
    image_to_bmp.py logo.png --mode mono --size 296x128 --feed canvas
    aio_to_protomq_canvas.py            # picks it up, chunks it to the MagTag

    Env: AIO_USERNAME / AIO_KEY (only for --feed), CONVERTER_URL (service backend),
         FEED_MARKER (prefix to prepend when publishing; default "image").
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import os
import ssl
import sys

CONVERTER_URL = os.environ.get("CONVERTER_URL", "")  # Adafruit IO image-converter service
FEED_MARKER = os.environ.get("FEED_MARKER", "image")


def convert_with_pil(data: bytes, *, mode: str, size: tuple[int, int] | None, dither: bool) -> bytes:
    """PIL: decode -> optional resize -> quantise to the panel depth -> BMP bytes."""
    from PIL import Image  # imported lazily so --feed/service paths don't need PIL

    img = Image.open(io.BytesIO(data)).convert("RGB")
    if size:
        img = img.resize(size)
    d = Image.Dither.FLOYDSTEINBERG if dither else Image.Dither.NONE
    if mode == "mono":
        out = img.convert("1", dither=d)                      # 1-bpp BMP
    elif mode == "gray4":
        out = img.convert("L").quantize(colors=4, dither=d)   # 4-level indexed
    elif mode.startswith("palette"):
        n = int(mode.split(":", 1)[1]) if ":" in mode else 16
        out = img.quantize(colors=n, dither=d)                # N-colour indexed
    else:
        raise SystemExit(f"unknown --mode {mode!r} (use mono | gray4 | palette[:N])")
    buf = io.BytesIO()
    out.save(buf, format="BMP")
    return buf.getvalue()


async def post_to_converter(data: bytes) -> bytes:
    """Adafruit IO image-converter service backend. Fill in the request shape for
    the actual endpoint; kept a stub so this file never fakes an API contract."""
    import httpx

    if not CONVERTER_URL:
        raise SystemExit("set CONVERTER_URL to use the service backend (or use PIL: --backend pil)")
    async with httpx.AsyncClient(timeout=30) as c:
        # TODO: match the service's real contract (multipart? query params for
        #   width/height/depth?). Placeholder POST of the raw bytes:
        r = await c.post(CONVERTER_URL, content=data)
        r.raise_for_status()
        return r.content


async def publish_to_feed(bmp: bytes, feed: str) -> None:
    """Publish the BMP (base64, FEED_MARKER-prefixed) to an AIO feed over MQTT."""
    import aiomqtt

    user, key = os.environ["AIO_USERNAME"], os.environ["AIO_KEY"]
    payload = f"{FEED_MARKER}{base64.b64encode(bmp).decode()}"
    tls = ssl.create_default_context()
    async with aiomqtt.Client("io.adafruit.com", 8883, username=user, password=key, tls_context=tls) as c:
        await c.publish(f"{user}/feeds/{feed}", payload)
    print(f"published {len(bmp)}B BMP as base64 to {user}/feeds/{feed} "
          f"(history OFF must be set for >1KB payloads)")


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", help="input image file (any format PIL/the service reads)")
    ap.add_argument("--backend", choices=("pil", "service"), default="pil")
    ap.add_argument("--mode", default="mono", help="pil: mono | gray4 | palette[:N]")
    ap.add_argument("--size", default="", help="pil: WxH to resize to, e.g. 296x128")
    ap.add_argument("--dither", action="store_true", help="pil: Floyd-Steinberg dither")
    ap.add_argument("--out", help="write the BMP here")
    ap.add_argument("--feed", help="publish the BMP (base64) to this AIO feed")
    args = ap.parse_args()

    with open(args.source, "rb") as f:
        data = f.read()

    if args.backend == "service":
        bmp = await post_to_converter(data)
    else:
        size = None
        if args.size:
            w, h = args.size.lower().split("x")
            size = (int(w), int(h))
        bmp = convert_with_pil(data, mode=args.mode, size=size, dither=args.dither)

    if args.out:
        with open(args.out, "wb") as f:
            f.write(bmp)
        print(f"wrote {len(bmp)}B -> {args.out}")
    if args.feed:
        await publish_to_feed(bmp, args.feed)
    if not args.out and not args.feed:
        sys.stdout.buffer.write(bmp)  # pipe it somewhere
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
