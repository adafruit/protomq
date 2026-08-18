#!/usr/bin/env python3
"""
Minimal PoC bridge which listens to an Adafruit IO feed and forwards each new BMP payload to a MagTag via the ProtoMQ API. 
"""

import argparse
import base64
import os
import sys
import time
import zlib
import paho.mqtt.client as mqtt


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

CHUNK = 420  # bytes of chunk_data per image fragment
DISPLAY_NAME = "epd0"
DID_ADD = False  # whether we've sent the add-display message yet
DISPLAY_ADD = None  # the Add descriptor built from CLI args in main()
# Fixed MagTag 2.9" SPI/EPD pin wiring (not configurable via CLI), copied from
# create-marquee-demo-magtag.py.
MAGTAG_INTERFACE = {
    "spiEpd": {
        "pinBusy": "D5",
        "spi": {"bus": 0, "pinMosi": "D35", "pinSck": "D36", "pinCs": "D8"},
        "pinDc": "D7",
        "pinRst": "D6",
    }
}


def build_display_add(*, panel="adafruit-magtag", driver="SSD1680",
                      mode="EPD_MODE_MONO", width=296, height=128,
                      name=DISPLAY_NAME):
    """Build a display.Add descriptor (MagTag shape) from EPD config args.

    Defaults match the original hardcoded MagTag 2.9" descriptor, so calling
    with no overrides reproduces the previous behavior.
    """
    return {
        "type": "DISPLAY_CLASS_EPD",
        "driver": driver,
        "panel": panel,
        "name": name,
        "interfaceType": MAGTAG_INTERFACE,
        "configEpd": {
            "mode": mode,
            "properties": {
                "width": width,
                "height": height,
                "textSize": 3,
                "statusBar": True,
            },
        },
    }


def send_display_add(mq, add, *, verbose=True):
    """Package an Add descriptor and send it once per session (guarded by DID_ADD)."""
    global DID_ADD
    if DID_ADD:
        return
    mq.send_proto(display_add(add))
    if verbose:
        cfg = add.get("configEpd", {}).get("properties", {})
        print(f"[send_proto] add-display '{add['name']}' "
              f"({cfg.get('width')}x{cfg.get('height')} {add['driver']} EPD)",
              file=sys.stderr)
    DID_ADD = True


def on_connect(mqttc, obj, flags, reason_code, properties):
    print("Connected with result code " + str(reason_code))
    print("Subscribing to changes on feed: brubell/feeds/marquee")
    mqttc.subscribe("brubell/feeds/marquee", qos=1)


def on_message(mqttc, obj, msg):
    mq = obj  # ProtoMQClient handed in via user_data_set() in main()
    data = msg.payload
    bmp_decoded = base64.b64decode(data, altchars=None, validate=False)
    print(f"Received message on topic {msg.topic}: {len(data)} bytes")
    send_bmp(mq, bmp_decoded, chunk=CHUNK, image_id=None, delay=0.0,
             register_checkin=True, verbose=True)


def on_subscribe(mqttc, obj, mid, reason_code_list, properties):
    print(f"Subscribed: {mid} {reason_code_list}")


def send_bmp(mq, data, *, chunk=CHUNK, image_id=None, delay=0.0,
             register_checkin=True, verbose=True):
    """Creates Write message fragments from raw BMP data and publishes them out via ProtoMQ."""
    if data[:2] != b"BM":
        raise ValueError("payload is not a BMP (missing 'BM' signature)")
    if chunk + 40 > 2048:
        raise ValueError(f"chunk {chunk} too large: +40 B overhead exceeds the 2048 B ceiling")

    checksum = zlib.crc32(data) & 0xFFFFFFFF
    pieces = [data[i:i + chunk] for i in range(0, len(data), chunk)] or [b""]
    total = len(pieces)

    def _log(msg, end="\n"):
        if verbose:
            print(msg, end=end, file=sys.stderr)

    _log(f"# bitmap         : {len(data)} bytes  crc=0x{checksum:08X}  fragments={total}")

    if register_checkin:
        removed = mq.clear_autoresponders()
        res = mq.add_autoresponder("checkin.request", checkin_response(),
                                   name="magtag-checkin")
        _log(f"[autoresponse] cleared {removed}, registered checkin (count={res.get('count')})")

    # Send the Add message only once per session, not for every image
    send_display_add(mq, DISPLAY_ADD, verbose=verbose)

    # firmware expects 1-based chunk_id field
    for cid, piece in enumerate(pieces, start=1):
        mq.send_proto(canvas_write(
            DISPLAY_NAME,
            checksum=checksum,
            chunk_id=cid,
            chunk_total=total,
            size=len(data),
            chunk_data=piece
        ))
        _log(f"\r[send_proto] canvas chunk {cid}/{total}", end="")
        if delay:
            time.sleep(delay)
    _log("")
    _log(f"[done] sent {total} canvas chunks to {mq.b2d_topic}")
    return checksum, total


def main():
    ap = argparse.ArgumentParser(description="Play a MagTag marquee demo against ProtoMQ.")
    ap.add_argument("--io-username", default="io_user", help="Adafruit IO Username")
    ap.add_argument("--io-key", default="io_key", help="Adafruit IO Key")
    ap.add_argument("--base-url", default="http://localhost:5173")
    ap.add_argument("--uid", default="magtag")
    # EPD panel configuration options used by display_add to construct the Add message.
    ap.add_argument("--epd-panel", default="adafruit-magtag", help="EPD panel type (default: adafruit-magtag)")
    ap.add_argument("--epd-driver", default="SSD1680", help="EPD panel's driver (default: SSD1680)")
    ap.add_argument("--epd-mode", default="EPD_MODE_MONO", help="EPD mode (default: EPD_MODE_MONO)")
    ap.add_argument("--epd-width", type=int, default=296, help="EPD width in pixels (default: 296)")
    ap.add_argument("--epd-height", type=int, default=128, help="EPD height in pixels (default: 128)")

    args = ap.parse_args()

    # Build the Add descriptor once from the EPD config args.
    global DISPLAY_ADD
    DISPLAY_ADD = build_display_add(
        panel=args.epd_panel, driver=args.epd_driver, mode=args.epd_mode,
        width=args.epd_width, height=args.epd_height,
    )

    # Configure ProtoMQ API client
    mq = ProtoMQClient(args.base_url, user=args.io_username, device=args.uid)

    # Configure MQTT client and connect it to Adafruit IO
    mqttc = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, userdata=mq)
    mqttc.username_pw_set(args.io_username, args.io_key)
    mqttc.tls_set()
    mqttc.on_connect = on_connect
    mqttc.on_message = on_message
    mqttc.on_subscribe = on_subscribe
    mqttc.connect("io.adafruit.com", 8883, 60)

    # Listen for incoming messages forever
    mqttc.loop_forever()


if __name__ == "__main__":
    main()
