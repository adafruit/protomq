#!/usr/bin/env python3
"""
play_marquee_magtag.py — build a MagTag 2.9" marquee display demo in code and
"play" it against a running ProtoMQ broker via the HTTP API.

This is the runnable counterpart to create-marquee-demo-magtag.py: instead of
emitting a *-demo.json play-script, it imports protomq_client and drives the
broker directly — each step is one client call (send_proto / add_autoresponder).
It reproduces the same sequence a MagTag demo uses:

  1. register a checkin autoresponder      (POST /api/autoresponse)
  2. send the add-display descriptor        (send_proto -> /api/echo)
  3. send each packed Canvas image chunk    (send_proto -> /api/echo)

The input must be a 1bpp .bmp. Canvas chunking (CRC32 + fragmenting) matches
create-marquee-demo-magtag.py; chunk_data is base64 (proto3 JSON `bytes`).

Prereqs (see scripts/generate_protos.py):
  pip install grpcio-tools        # protobuf runtime + matched protoc
  python3 scripts/generate_protos.py

Usage:
  python3 scripts/play_marquee_magtag.py --bmp output.bmp
  python3 scripts/play_marquee_magtag.py --bmp img.bmp --user test_user --device magtag --delay 500
"""

import argparse
import base64
import os
import sys
import time
import zlib

# Ensure this script's dir is importable so `import protomq_client` works from
# any cwd.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from protomq_client import (  # noqa: E402
    ProtoMQClient,
    ProtoMQError,
    checkin_response,
    display_add,
    canvas_write,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CHUNK = 420  # bytes of chunk_data per fragment; worst-case serialized Canvas
             # (~+40 B overhead) stays under the 2048 B MQTT ceiling.

DISPLAY_NAME = "epd0"

# The MagTag 2.9" EPD add descriptor, copied from create-marquee-demo-magtag.py.
MAGTAG_ADD = {
    "type": "DISPLAY_CLASS_EPD",
    "driver": "SSD1680",
    "panel": "adafruit-magtag",
    "name": DISPLAY_NAME,
    "interfaceType": {
        "spiEpd": {
            "pinBusy": "D5",
            "spi": {"bus": 0, "pinMosi": "D35", "pinSck": "D36", "pinCs": "D8"},
            "pinDc": "D7",
            "pinRst": "D6",
        }
    },
    "configEpd": {
        "mode": "EPD_MODE_MONO",
        "properties": {"width": 296, "height": 128, "textSize": 3, "statusBar": True},
    },
}


def read_bmp(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:2] != b"BM":
        sys.exit(f"{path}: not a BMP (missing 'BM' signature)")
    return data


def play_bmp(mq, data, *, chunk=CHUNK, image_id=None, delay=0.0,
             register_checkin=True, send_add=True, verbose=True):
    """Chunk a full BMP into Canvas messages and forward them to a MagTag.

    Reusable core of this demo, shared with io-marquee-bridge.py: given a
    ProtoMQClient `mq` and the raw bytes of a BMP, this optionally registers the
    checkin autoresponder (`register_checkin`), sends the add-display descriptor
    (`send_add`), then send_proto()s each Canvas chunk. Returns
    (image_id, chunk_total). A long-running bridge sending a stream of images
    typically sets both flags only for the first image.

    `chunk` is the chunk_data byte budget; `image_id` defaults to a random 32-bit
    id (a new "generation" so the device treats it as a fresh image); `delay` is
    an optional per-chunk sleep in seconds.
    """
    if data[:2] != b"BM":
        raise ValueError("payload is not a BMP (missing 'BM' signature)")
    if chunk + 40 > 2048:
        raise ValueError(f"chunk {chunk} too large: +40 B overhead exceeds the 2048 B ceiling")

    checksum = zlib.crc32(data) & 0xFFFFFFFF
    img_id = image_id if image_id is not None else int.from_bytes(os.urandom(4), "big")
    pieces = [data[i:i + chunk] for i in range(0, len(data), chunk)] or [b""]
    total = len(pieces)

    def _log(msg, end="\n"):
        if verbose:
            print(msg, end=end, file=sys.stderr)

    _log(f"# bitmap         : {len(data)} bytes  id=0x{img_id:08X}  crc=0x{checksum:08X}  fragments={total}")

    if register_checkin:
        removed = mq.clear_autoresponders()
        res = mq.add_autoresponder("checkin.request", checkin_response(),
                                   name="magtag-checkin")
        _log(f"[autoresponse] cleared {removed}, registered checkin (count={res.get('count')})")

    if send_add:
        mq.send_proto(display_add(MAGTAG_ADD))
        _log(f"[send_proto] add-display '{DISPLAY_NAME}' (296x128 SSD1680 EPD)")

    for cid, piece in enumerate(pieces, start=1):  # chunk_id is 1-based
        mq.send_proto(canvas_write(
            DISPLAY_NAME,
            image_id=img_id,
            checksum=checksum,
            chunk_id=cid,
            chunk_total=total,
            total_size=len(data),
            chunk_data=piece,
        ))
        _log(f"\r[send_proto] canvas chunk {cid}/{total}", end="")
        if delay:
            time.sleep(delay)
    _log("")
    _log(f"[done] sent 1 add-display + {total} canvas chunks to {mq.b2d_topic}")
    return img_id, total


def main():
    ap = argparse.ArgumentParser(description="Play a MagTag marquee demo against ProtoMQ.")
    ap.add_argument("--bmp", default=os.path.join(REPO_ROOT, "output.bmp"),
                    help="input 1bpp .bmp (default: output.bmp at repo root)")
    ap.add_argument("--base-url", default="http://localhost:5173")
    ap.add_argument("--user", default="test_user")
    ap.add_argument("--device", default="magtag")
    ap.add_argument("--chunk", type=int, default=CHUNK,
                    help=f"chunk_data bytes per fragment (default {CHUNK})")
    ap.add_argument("--id", type=int, default=None,
                    help="image id (default: random 32-bit)")
    ap.add_argument("--delay", type=float, default=0.0,
                    help="seconds to sleep between chunk sends (default: 0)")
    args = ap.parse_args()

    data = read_bmp(args.bmp)
    print(f"# BMP            : {args.bmp}", file=sys.stderr)

    mq = ProtoMQClient(args.base_url, user=args.user, device=args.device)
    print(f"# broker         : {mq.base_url}  ->  {mq.b2d_topic}", file=sys.stderr)

    try:
        play_bmp(mq, data, chunk=args.chunk, image_id=args.id, delay=args.delay)
    except (ProtoMQError, ValueError) as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
