# Adafruit IO → protoMQ Canvas bridge (PoC)

Drive the chunked-image **`display.Canvas`** path
([Wippersnapper_Protobuf#205](https://github.com/adafruit/Wippersnapper_Protobuf/pull/205))
on a real device (e.g. a MagTag) using **production Adafruit IO** as the image
source, but a **local protoMQ** broker as the transport the device is connected
to. protoMQ is just an MQTT broker + HTTP API, so a small client can subscribe to
prod and re-emit protobuf chunks locally — no broker-level bridging needed.

```
io.adafruit.com  (prod MQTT, TLS 8883)
   sub  <AIO_USER>/feeds/<feed>          # a BMP dropped on a dashboard, base64
        │
        ▼  chunk into display.Canvas frames
   local protoMQ
   pub  <WS_IO_USER>/ws-b2d/<device_uid>  via POST /api/echo  (or --mqtt-direct :1884)
        │
        ▼
   device reassembles by chunk_id/total_size and renders (adafruit_imageload)
```

## Files

- **`aio_to_protomq_canvas.py`** — the bridge. Subscribes the prod feed, resolves
  the value to image bytes (http(s) URL / `data:` URL / base64, stripping a
  leading `image` marker), then **passes the bytes through unchanged** and chunks
  them into `Canvas` frames. It does *no* reformatting: the feed is expected to
  carry a display-ready BMP (correct size + colour depth) that the firmware loads
  with `adafruit_imageload`.
- **`image_to_bmp.py`** — optional front end for when the source is *not* already
  formatted (a PNG off a dashboard, a photo). Converts to a display-ready BMP via
  PIL (`mono` / `gray4` / `palette`, resize, dither) or the Adafruit IO
  image-converter service, and can publish the result to a feed to drive the
  bridge end-to-end.

## Wire format (from PR #205)

```
signal.BrokerToDevice.display (36) → display.B2D.write (3) → display.Write
    Write.name  = 1   # target display component
    Write.image = 4 → Canvas { id=1, checksum=2, total_size=3,
                               chunk_id=4, chunk_total=5, chunk_data=6 }
```
`chunk_data` is a slice of the pre-formatted BMP; `total_size`/`checksum` describe
the whole image so the device can verify reassembly. `checksum` defaults to
`zlib.crc32(image)` here — align it with whatever the firmware verifies.

## Run

```bash
pip install aiomqtt httpx                       # + pillow only for image_to_bmp.py

# one-shot, no Adafruit IO — push a local BMP to the device
MAGTAG_UID=magtag-abc123 python aio_to_protomq_canvas.py --once ./logo.bmp

# live bridge: forward a prod feed to the local broker
AIO_USERNAME=... AIO_KEY=... AIO_FEED=canvas MAGTAG_UID=magtag-abc123 \
  WS_IO_USER=hil PROTOMQ_HOST=localhost \
  python aio_to_protomq_canvas.py               # POST /api/echo (add --mqtt-direct for :1884)

# convert an arbitrary image and publish it to the feed
python image_to_bmp.py photo.png --mode mono --size 296x128 --dither --feed canvas
```

### Environment

| var | default | meaning |
|---|---|---|
| `AIO_USERNAME` / `AIO_KEY` | — | prod Adafruit IO creds (live bridge / `--feed`) |
| `AIO_FEED` | `canvas` | feed key carrying the image |
| `MAGTAG_UID` | — | device uid (the `ws-b2d/<uid>` segment) |
| `WS_IO_USER` | `hil` | io-user the device checked in as on protoMQ |
| `DISPLAY_NAME` | `epd` | `Write.name` — target display component |
| `PROTOMQ_HOST` | `localhost` | protoMQ host |
| `PROTOMQ_API_PORT` | `5173` | `/api/echo` port |
| `PROTOMQ_MQTT_PORT` | `1884` | direct-publish port (`--mqtt-direct`) |
| `CHUNK_SIZE` | `512` | bytes of `chunk_data` per frame |
| `FEED_MARKER` | `image` | leading marker stripped from the feed value |

> **Adafruit IO note:** a full image won't fit a normal feed value — turn the
> feed's **history OFF** to allow the larger (~100 KB) payload. Base64 inflation
> (~4/3) means the raw BMP should be ≲75 KB.

Proof of concept — not wired into CI.
