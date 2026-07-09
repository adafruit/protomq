#!/usr/bin/env python3
"""
protomq_client.py — a Python client for the ProtoMQ HTTP control API.

ProtoMQ runs an MQTT broker plus an Express HTTP API (default
http://localhost:5173). This client wraps the two endpoint families used to
drive the broker from the outside:

  * Echo          — POST /api/echo               (publish bytes onto a topic)
  * Autoresponder — POST/GET/DELETE /api/autoresponse

Building protobufs
------------------
Like the demo generators in this directory (see create-marquee-demo-magtag.py),
messages are authored as plain nested dicts using proto3-JSON field conventions:

  * field names are camelCase          (totalGpioPins, referenceVoltage)
  * enum values are strings            ("R_OK", "DISPLAY_CLASS_EPD")
  * `bytes` fields are base64 strings  (proto3 JSON round-trips base64 -> raw)

For autoresponders, that dict is sent as-is and the *broker* serializes it. For
echo, /api/echo needs raw serialized bytes, so `send_proto()` serializes the
dict to a signal.BrokerToDevice on the Python side using the generated protobuf
modules. Generate those once with:

    python3 scripts/generate_protos.py      # writes scripts/protomq_pb/*_pb2.py

(requires `pip install grpcio-tools`; see that script's header.)

Endpoint reference (from api/echo.js and api/autoresponse.js)
-------------------------------------------------------------
POST   /api/echo                { topic, payload }        -> {status:"OK"}
POST   /api/autoresponse        { trigger, response,      -> {status:"OK", count}
                                  name?, match? }             400 {status:"ERROR", message}
GET    /api/autoresponse                                  -> {status:"OK", autoresponders:[...]}
DELETE /api/autoresponse/<name>                           -> {status:"OK", removed}
DELETE /api/autoresponse                                  -> {status:"OK", removed}  (clear all)

The HTTP API has no authentication.

Topic routing
--------------
The broker delivers every broker->device message to a single MQTT topic,
"{user}/ws-b2d/{device}" (the b2d counterpart of the device's "{user}/ws-d2b/
{device}" publish topic; see broker/script_runner.js). send_proto() defaults to
that per-session topic, built from the `user`/`device` given to the client.

Usage
-----
    from protomq_client import ProtoMQClient, checkin_response, display_write

    mq = ProtoMQClient(user="test_user", device="magtag")

    mq.clear_autoresponders()
    mq.add_autoresponder("checkin.request", checkin_response(), name="checkin-ok")

    mq.send_proto(display_write("epd0", "hello from python"))   # -> ws-b2d topic
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import quote


DEFAULT_BASE_URL = "http://localhost:5173"
DEFAULT_USER = "test_user"
DEFAULT_DEVICE = "magtag"


class ProtoMQError(RuntimeError):
    """Raised on a non-2xx status, an ERROR body, or a codec failure."""

    def __init__(self, message, *, status=None, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


# ---------------------------------------------------------------------------
# Protobuf codec — dict (proto3 JSON shape) -> signal.BrokerToDevice bytes.
# Imported lazily so autoresponder-only use works without the generated modules.
# ---------------------------------------------------------------------------

_PB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "protomq_pb")
_b2d_cls = None
_parse_dict = None


def _load_codec():
    """Import the generated protobuf modules on first use.

    The generated *_pb2.py files cross-import each other by bare module name
    (e.g. `import error_pb2`), so protomq_pb/ must be on sys.path directly
    rather than imported as a package.
    """
    global _b2d_cls, _parse_dict
    if _b2d_cls is not None:
        return
    if not os.path.isdir(_PB_DIR):
        raise ProtoMQError(
            f"generated protobuf modules not found in {_PB_DIR}. "
            f"Run: python3 scripts/generate_protos.py"
        )
    if _PB_DIR not in sys.path:
        sys.path.insert(0, _PB_DIR)
    try:
        import signal_pb2  # type: ignore
        from google.protobuf import json_format
    except ImportError as e:
        raise ProtoMQError(
            f"could not import the protobuf codec ({e}). "
            f"Install the runtime (pip install protobuf grpcio-tools) and run "
            f"python3 scripts/generate_protos.py"
        ) from e
    _b2d_cls = signal_pb2.BrokerToDevice
    _parse_dict = json_format.ParseDict


def encode_b2d(message):
    """Serialize a BrokerToDevice-shaped dict to protobuf wire bytes."""
    _load_codec()
    msg = _b2d_cls()
    try:
        _parse_dict(message, msg)
    except Exception as e:  # json_format raises ParseError subclasses
        raise ProtoMQError(f"not a valid BrokerToDevice: {e}") from e
    return msg.SerializeToString()


class ProtoMQClient:
    """Thin client over the ProtoMQ HTTP control API.

    Methods return the parsed JSON response body (a dict) and raise ProtoMQError
    on transport failure or an API-level error.
    """

    def __init__(self, base_url=DEFAULT_BASE_URL, user=DEFAULT_USER,
                 device=DEFAULT_DEVICE, timeout=10):
        self.base_url = base_url.rstrip("/")
        self.user = user
        self.device = device
        self.timeout = timeout

    @property
    def b2d_topic(self):
        """Per-session broker->device topic: {user}/ws-b2d/{device}."""
        return f"{self.user}/ws-b2d/{self.device}"

    @property
    def d2b_topic(self):
        """Per-session device->broker topic: {user}/ws-d2b/{device}."""
        return f"{self.user}/ws-d2b/{self.device}"

    # -- HTTP plumbing ------------------------------------------------------

    def _request(self, method, path, body=None):
        url = f"{self.base_url}{path}"
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as e:
            raw = e.read()
            parsed = _try_json(raw)
            msg = parsed.get("message") if isinstance(parsed, dict) else None
            raise ProtoMQError(
                f"{method} {path} -> HTTP {e.code}" + (f": {msg}" if msg else ""),
                status=e.code,
                body=parsed if parsed is not None else raw.decode("utf-8", "replace"),
            ) from e
        except urllib.error.URLError as e:
            raise ProtoMQError(
                f"{method} {path} -> could not reach ProtoMQ at {self.base_url} "
                f"({e.reason}). Is the broker running? (npm run start)"
            ) from e

        parsed = _try_json(raw)
        if isinstance(parsed, dict) and parsed.get("status") == "ERROR":
            raise ProtoMQError(
                f"{method} {path} -> {parsed.get('message', 'ERROR')}",
                status=status, body=parsed,
            )
        return parsed

    # -- Echo ---------------------------------------------------------------

    def echo(self, topic, payload):
        """Publish `payload` verbatim onto MQTT `topic` (POST /api/echo).

        `payload` may be bytes/bytearray (sent as-is; decoded latin1 to match the
        broker's Buffer.from(payload,'latin1') so the wire bytes are exact) or a
        str. The broker does no decoding/validation. Returns {"status": "OK"}.
        """
        if isinstance(payload, (bytes, bytearray)):
            payload_str = bytes(payload).decode("latin1")
        elif isinstance(payload, str):
            payload_str = payload
        else:
            raise TypeError("payload must be bytes or str")
        return self._request("POST", "/api/echo", {"topic": topic, "payload": payload_str})

    def send_proto(self, message, topic=None):
        """Serialize a BrokerToDevice-shaped dict and echo it to the device.

        This is the primary way to push a protobuf to a device: build the message
        as a dict (see the builders below), and send_proto() encodes it to wire
        bytes and publishes to `topic` (default: this client's b2d_topic).
        """
        payload = encode_b2d(message)
        return self.echo(topic or self.b2d_topic, payload)

    # -- Autoresponders -----------------------------------------------------

    def add_autoresponder(self, trigger, response, name=None, match=None):
        """Register an autoresponder (POST /api/autoresponse).

        When a device publishes a DeviceToBroker message whose decoded form
        matches `trigger` (a dot-path, e.g. "checkin.request") and optional
        `match` pattern, the broker replies with `response` (a BrokerToDevice
        dict it serializes) on the d2b->b2d topic. First match wins; in-memory
        only. An invalid `response` shape raises ProtoMQError (HTTP 400).
        Returns {"status": "OK", "count": <total>}.
        """
        body = {"trigger": trigger, "response": response}
        if name is not None:
            body["name"] = name
        if match is not None:
            body["match"] = match
        return self._request("POST", "/api/autoresponse", body)

    def list_autoresponders(self):
        """GET /api/autoresponse -> list of registered autoresponder entries."""
        result = self._request("GET", "/api/autoresponse")
        return result.get("autoresponders", []) if isinstance(result, dict) else []

    def remove_autoresponder(self, name):
        """DELETE /api/autoresponse/<name>. Returns count removed (by name)."""
        result = self._request("DELETE", f"/api/autoresponse/{quote(str(name), safe='')}")
        return result.get("removed", 0) if isinstance(result, dict) else 0

    def clear_autoresponders(self):
        """DELETE /api/autoresponse (clear all). Returns count removed."""
        result = self._request("DELETE", "/api/autoresponse")
        return result.get("removed", 0) if isinstance(result, dict) else 0


# ---------------------------------------------------------------------------
# Message builders — return BrokerToDevice-shaped dicts (proto3 JSON).
# Mirrors the hardcoded step dicts in create-marquee-demo-magtag.py so the same
# payloads work as autoresponder `response` values, play-script steps, or
# send_proto() arguments.
# ---------------------------------------------------------------------------

def checkin_response(*, response="R_OK", total_gpio_pins=20, total_analog_pins=4,
                     reference_voltage=2.5, sleep_enabled=False, component_adds=None):
    """Reply to a `checkin.request` trigger with OK + board capabilities."""
    return {
        "checkin": {
            "response": {
                "response": response,
                "totalGpioPins": total_gpio_pins,
                "totalAnalogPins": total_analog_pins,
                "referenceVoltage": reference_voltage,
                "componentAdds": component_adds or {},
                "sleepEnabled": sleep_enabled,
            }
        }
    }


def display_add(add):
    """Wrap a display Add descriptor: {"display": {"add": <add>}}.

    `add` is the full display.Add dict (type/driver/panel/name/interfaceType/
    configEpd|configDisplay), exactly as in the *-demo.json scripts.
    """
    return {"display": {"add": add}}


def display_write(name, message):
    """A text write to a named display: {"display": {"write": {name, message}}}."""
    return {"display": {"write": {"name": name, "message": message}}}


def display_remove(name):
    """Remove a named display: {"display": {"remove": {name}}}."""
    return {"display": {"remove": {"name": name}}}


def canvas_write(name, *, image_id, checksum, chunk_id, chunk_total, total_size,
                 chunk_data):
    """A single Canvas chunk write (marquee image fragment).

    Mirrors the write-canvas-* steps: a display.write carrying an `image`
    (ws.display.Canvas). chunk_id is 1-based; chunk_data is raw bytes, which are
    base64-encoded here because proto3 JSON (ParseDict) represents `bytes` fields
    as base64 strings.
    """
    if isinstance(chunk_data, (bytes, bytearray)):
        chunk_data = base64.b64encode(bytes(chunk_data)).decode("ascii")
    return {
        "display": {
            "write": {
                "name": name,
                "message": "",
                "image": {
                    "id": image_id,
                    "checksum": checksum,
                    "totalSize": total_size,
                    "chunkId": str(chunk_id),
                    "chunkTotal": chunk_total,
                    "chunkData": chunk_data,
                },
            }
        }
    }


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _try_json(raw):
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


# ---------------------------------------------------------------------------
# tiny self-check / CLI
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="ProtoMQ HTTP API client.")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL,
                    help=f"ProtoMQ API base URL (default: {DEFAULT_BASE_URL})")
    ap.add_argument("--user", default=DEFAULT_USER)
    ap.add_argument("--device", default=DEFAULT_DEVICE)
    ap.add_argument("--list", action="store_true", help="list registered autoresponders and exit")
    ap.add_argument("--encode-check", action="store_true",
                    help="encode a sample checkin response and print the hex (no network)")
    args = ap.parse_args()

    if args.encode_check:
        payload = encode_b2d(checkin_response())
        print(f"checkin_response encodes to {len(payload)} bytes: {payload.hex()}")
        return

    mq = ProtoMQClient(args.base_url, user=args.user, device=args.device)
    try:
        if args.list:
            for a in mq.list_autoresponders():
                print("-", a.get("name"), "trigger:", a.get("trigger"))
        else:
            print("b2d topic:", mq.b2d_topic)
            print("autoresponders:", mq.list_autoresponders())
    except ProtoMQError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
