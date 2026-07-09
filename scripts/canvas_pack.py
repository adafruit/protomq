#!/usr/bin/env python3
"""
canvas_pack.py — fragment a 1bpp BMP into ws.display.Canvas chunks and print
each chunk as a readable field = value dump.

Input must already be a 1bpp .bmp file. No image conversion, no dependencies
beyond the standard library.

Fields map to (proto3):

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

Usage:
  python3 canvas_pack.py image.bmp
  python3 canvas_pack.py image.bmp --id 12345 --chunk 2000
  python3 canvas_pack.py image.bmp --format hex   # human inspection only
"""

import argparse
import base64
import json
import os
import sys
import zlib

CHUNK = 512 # MUST be <= MAXBUFFERSIZE in the Adafruit_MQTT library


def encode_chunk(data, fmt):
    """Return chunk_data as a single-line, paste-ready token in the chosen format."""
    if fmt == "hex":
        return data.hex()
    if fmt == "carray":
        return "{" + ", ".join(f"0x{b:02X}" for b in data) + "}"
    return base64.b64encode(data).decode("ascii")  # default: base64


def main():
    ap = argparse.ArgumentParser(
        description="Fragment a 1bpp BMP into ws.display.Canvas chunks as JSON test steps.")
    ap.add_argument("bmp", help="input 1bpp .bmp file")
    ap.add_argument("--id", type=int, default=None, help="image id (default: random 32-bit)")
    ap.add_argument("--chunk", type=int, default=CHUNK, help=f"chunk_data bytes (default {CHUNK})")
    ap.add_argument("--format", choices=["base64", "hex", "carray"], default="base64",
                    help="chunk_data encoding: base64 (default, correct for proto3 JSON "
                         "bytes), continuous hex, or C array")
    ap.add_argument("--name", default="write-canvas",
                    help="base step name; chunk index is appended (default: write-canvas)")
    ap.add_argument("--display-name", default="epd0",
                    help="target display component name (default: epd0)")
    ap.add_argument("--after", default="add-display",
                    help="step this chunk runs after (default: add-display)")
    ap.add_argument("--delay", type=int, default=5000,
                    help="per-step delay in ms (default: 5000)")
    ap.add_argument("--description", default="Write a canvas chunk to the E-Ink display",
                    help="step description")
    args = ap.parse_args()

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

    # Metadata to stderr so stdout stays clean JSON (pipe/redirect friendly).
    print(f"# BMP payload      : {len(data)} bytes", file=sys.stderr)
    print(f"# id               : {img_id}  (0x{img_id:08X})", file=sys.stderr)
    print(f"# checksum (CRC32) : {checksum}  (0x{checksum:08X})", file=sys.stderr)
    print(f"# fragments        : {total}   chunk_data <= {args.chunk} B   ({args.format})",
          file=sys.stderr)

    steps = []
    for cid, piece in enumerate(pieces, start=1):  # chunk_id is 1-based (1..chunk_total)
        steps.append({
            "name": f"{args.name}-{cid}",
            "description": args.description,
            "after": args.after,
            "delay": args.delay,
            "topic": "display",
            "send": {
                "display": {
                    "write": {
                        "name": args.display_name,
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

    print(json.dumps(steps, indent=2))


if __name__ == "__main__":
    main()