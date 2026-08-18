#!/usr/bin/env python3
"""
create-marquee-demo-magtag.py — build a complete MagTag marquee display demo from
a 1bpp BMP.

Based on canvas_pack.py, but instead of printing just the canvas step array this
script emits a full, runnable demo file: the MagTag `checkin-response` and
`add-display` header steps, followed by the packed `write-canvas-*` steps
fragmented from the input BMP.

Input must already be a 1bpp .bmp file. No image conversion, no dependencies
beyond the standard library.

Canvas fields map to (proto3):

    message Canvas {
      uint32 id          = 1;  // unique image id (generation)
      uint32 checksum    = 2;  // CRC32 over the FULL BMP
      uint32 chunk_id    = 3;  // 1-based fragment index (1..chunk_total)
      uint32 chunk_total = 4;  // total fragment count
      uint32 total_size  = 5;  // total bytes of the full BMP (allocate once, on any chunk)
      bytes  chunk_data  = 6;  // slice of the BMP payload
    }

chunk_data is emitted as base64 by default. A proto3 `bytes` field is base64 in
proto3 JSON, so base64 round-trips back to the exact raw bytes on the wire; a hex
string would be misread as base64 and inflate ~2x, overflowing the 2048 B ceiling.

chunk_data defaults to 2000 B (of raw bytes) so a serialized Canvas message stays
under the 2048 B MQTT payload ceiling even in the worst case (2000 + ~40 B field
overhead). Note the printed token is longer than the wire bytes (base64 ~= 4/3x),
but the ceiling check below is against the raw byte count, which is what's
serialized.

The output file name and the demo's `name`/`description` all reflect the input
BMP. For `image.bmp` the default output is `demo-marquee-magtag-image.json`
(beside this script) with name "MagTag 2.9\" MARQUEE Display Demo (image.bmp)".

Usage:
  python3 create-marquee-demo-magtag.py image.bmp
  python3 create-marquee-demo-magtag.py image.bmp --id 12345 --chunk 2000
  python3 create-marquee-demo-magtag.py image.bmp --out /tmp/other-demo.json
"""

import argparse
import base64
import json
import os
import sys
import zlib

CHUNK = 420  # bytes of chunk_data per fragment.
              # Worst-case serialized Canvas = 2000 + ~40 B overhead < 2048.
              # (5 varint fields @ up to 6 B each = 30, + chunk_data tag/len = 3.)
              # Matches MAXBUFFERSIZE=2048 in the Adafruit MQTT firmware.

# Output defaults live beside this script, so it works from any cwd.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Header steps, copied verbatim from magtag-marquee-demo.json. Hardcoded so this
# generator is self-contained (no dependency on that file existing).
CHECKIN_STEP = {
    "name": "checkin-response",
    "description": "Respond to device checkin with OK and board capabilities",
    "trigger": "checkin.request",
    "response": {
        "checkin": {
            "response": {
                "response": "R_OK",
                "totalGpioPins": 20,
                "totalAnalogPins": 4,
                "referenceVoltage": 2.5,
                "componentAdds": {},
                "sleepEnabled": False,
            }
        }
    },
}

ADD_DISPLAY_STEP = {
    "name": "add-display",
    "description": "Configure the 2.9\" E-Ink EPD display (296x128, SPI)",
    "after": "checkin-response",
    "waitFor": "checkin.complete",
    "delay": 500,
    "topic": "display",
    "send": {
        "display": {
            "add": {
                "type": "DISPLAY_CLASS_EPD",
                "driver": "SSD1680",
                "panel": "adafruit-magtag",
                "name": "epd0",
                "interfaceType": {
                    "spiEpd": {
                        "pinBusy": "D5",
                        "spi": {
                            "bus": 0,
                            "pinMosi": "D35",
                            "pinSck": "D36",
                            "pinCs": "D8",
                        },
                        "pinDc": "D7",
                        "pinRst": "D6",
                    }
                },
                "configEpd": {
                    "mode": "EPD_MODE_MONO",
                    "properties": {
                        "width": 296,
                        "height": 128,
                        "textSize": 3,
                        "statusBar": True,
                    },
                },
            }
        }
    },
}


def encode_chunk(data, fmt):
    """Return chunk_data as a single-line, paste-ready token in the chosen format."""
    if fmt == "hex":
        return data.hex()
    if fmt == "carray":
        return "{" + ", ".join(f"0x{b:02X}" for b in data) + "}"
    return base64.b64encode(data).decode("ascii")  # default: base64


def main():
    ap = argparse.ArgumentParser(
        description="Build a complete MagTag marquee demo (checkin + add-display + "
                    "packed Canvas chunks) from a 1bpp BMP.")
    ap.add_argument("bmp", help="input 1bpp .bmp file")
    ap.add_argument("--id", type=int, default=None, help="image id (default: random 32-bit)")
    ap.add_argument("--chunk", type=int, default=CHUNK, help=f"chunk_data bytes (default {CHUNK})")
    ap.add_argument("--format", choices=["base64", "hex", "carray"], default="base64",
                    help="chunk_data encoding: base64 (default, correct for proto3 JSON "
                         "bytes), continuous hex, or C array")
    ap.add_argument("--delay", type=int, default=5000,
                    help="per-canvas-step delay in ms (default: 5000)")
    ap.add_argument("--out", default=None,
                    help="output demo file (default: demo-marquee-magtag-<bmp>.json "
                         "beside this script)")
    args = ap.parse_args()

    # Derive names from the input BMP so the demo/file identify their source image.
    bmp_name = os.path.basename(args.bmp)                 # e.g. your-image.bmp
    bmp_stem = os.path.splitext(bmp_name)[0]              # e.g. your-image
    out_path = args.out or os.path.join(SCRIPT_DIR, f"demo-marquee-magtag-{bmp_stem}.json")

    with open(args.bmp, "rb") as f:
        data = f.read()
    if data[:2] != b"BM":
        sys.exit(f"{args.bmp}: not a BMP (missing 'BM' signature)")
    if args.chunk + 40 > 2048:
        sys.exit(f"--chunk {args.chunk} too large: +40 B worst-case overhead would exceed the 2048 B ceiling")

    checksum = zlib.crc32(data) & 0xFFFFFFFF
    img_id = args.id if args.id is not None else int.from_bytes(os.urandom(4), "big")

    pieces = [data[i:i + args.chunk] for i in range(0, len(data), args.chunk)] or [b""]
    total = len(pieces)

    # Metadata to stderr so any stdout use stays clean.
    print(f"# BMP payload      : {len(data)} bytes", file=sys.stderr)
    print(f"# id               : {img_id}  (0x{img_id:08X})", file=sys.stderr)
    print(f"# checksum (CRC32) : {checksum}  (0x{checksum:08X})", file=sys.stderr)
    print(f"# fragments        : {total}   chunk_data <= {args.chunk} B   ({args.format})",
          file=sys.stderr)

    canvas_steps = []
    for cid, piece in enumerate(pieces, start=1):  # chunk_id is 1-based (1..chunk_total)
        canvas_steps.append({
            "name": f"write-canvas-{cid}",
            "description": "Write a canvas chunk to the E-Ink display",
            "after": "add-display",
            "delay": args.delay,
            "topic": "display",
            "send": {
                "display": {
                    "write": {
                        "name": "epd0",
                        "message": "",
                        "image": {
                            "id": img_id,
                            "checksum": checksum,
                            "totalSize": len(data),
                            "chunkId": str(cid),
                            "chunkTotal": total,
                            "chunkData": encode_chunk(piece, args.format),
                        },
                    }
                }
            },
        })

    demo = {
        "name": f"MagTag 2.9\" MARQUEE Display Demo ({bmp_name})",
        "description": f"Tests MARQUEE chunking of {bmp_name}.",
        "protoVersion": "v2",
        "steps": [CHECKIN_STEP, ADD_DISPLAY_STEP, *canvas_steps],
    }

    with open(out_path, "w") as f:
        f.write(json.dumps(demo, indent=2))
        f.write("\n")

    print(f"# wrote            : {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
