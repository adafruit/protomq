# ProtoMQ HTTP API Reference

ProtoMQ serves an HTTP API next to its MQTT broker so tests and tools can watch
and drive device traffic without speaking MQTT themselves.

| | |
|---|---|
| Base URL | `http://localhost:5173/api` |
| Request bodies | JSON (`content-type: application/json`) |
| Responses | JSON |
| Auth | none |
| MQTT broker | `localhost:1884` (TCP), `localhost:8888` (WebSocket) |

All state lives in memory and is lost when the broker restarts. Call
[`POST /reset`](#post-reset) in test setup and teardown so state doesn't leak
between test cases.

## Contents

- [Conventions](#conventions)
- [Clients](#clients): `GET /clients`, `POST /disconnect`
- [Publishing](#publishing): `POST /echo`
- [Autoresponders](#autoresponders): `POST|GET|DELETE /autoresponse`
- [Playback scripts](#playback-scripts): `/scripts/...`
- [Delivery capture](#delivery-capture): `POST /track_deliveries`, `POST /dump_deliveries`
- [Reset](#reset): `POST /reset`
- [How an incoming device message is handled](#how-an-incoming-device-message-is-handled)

---

## Conventions

### Topics

V2 (current) WipperSnapper devices use one topic in each direction:

- `<io_user>/ws-b2d/<device_uid>`: **broker → device** (`BrokerToDevice`)
- `<io_user>/ws-d2b/<device_uid>`: **device → broker** (`DeviceToBroker`)

V1 (legacy) devices use topics under `<io_user>/wprsnpr/...`.

The message shapes (oneof members, field numbers) come from the `.proto` files
in `protobufs/` (V2) and `protobufs-v1/` (V1). Treat those as the source of truth.

### Client ids

Endpoints that act on one client take its MQTT client id in the request body as
`client`. To find a device's id, call [`GET /clients`](#get-clients).

### Responses and errors

Successful responses include `"status": "OK"`. Error responses are not
consistent across endpoints yet:

| Endpoint group | Error shape | HTTP status |
|---|---|---|
| `/autoresponse` | `{ "status": "ERROR", "message": "..." }` | `400` |
| `/scripts/...` | `{ "error": "..." }` | `400`, `404`, or `500` |
| `/disconnect`, `/track_deliveries`, `/dump_deliveries` | `{ "status": "ERROR", "message": "..." }` | **`200`** |

For the last group, check the `status` field, not the HTTP status code.

---

## Clients

### `GET /clients`

Lists connected MQTT clients and the topics each is subscribed to. This is the
same data the broker publishes on the `state/clients` MQTT topic whenever a
client connects, disconnects, subscribes, or unsubscribes.

```jsonc
// response
{
  "status": "OK",
  "clients": [
    { "id": "io-wipper-abc123", "subscriptions": ["myuser/ws-b2d/abc123"] }
  ]
}
```

The topic a device subscribes to is its B2D topic, so this is also how you find
the topic to send to with [`/echo`](#post-echo).

### `POST /disconnect`

Force-disconnects a client.

```jsonc
// body
{ "client": "io-wipper-abc123" }
// response
{ "status": "OK" }
// unknown client (HTTP 200)
{ "status": "ERROR", "message": "No client found with id: io-wipper-abc123" }
```

---

## Publishing

### `POST /echo`

Publishes one message to one topic right away.

```jsonc
// body
{ "topic": "myuser/ws-b2d/abc123", "payload": "<protobuf bytes as a latin1 string>" }
// response
{ "status": "OK" }
```

- `payload` is raw bytes encoded as a **latin1** string; the broker runs
  `Buffer.from(payload, 'latin1')`. You encode the protobuf yourself, which keeps
  this endpoint language-agnostic. In Python: `encoded.decode("latin1")`.
- The broker doesn't validate the payload. Any bytes are published as given.
- If `payload` is missing, the request fails with an HTTP 500 and an HTML error page.

```python
import httpx
httpx.post("http://localhost:5173/api/echo",
           json={"topic": "myuser/ws-b2d/abc123",
                 "payload": b2d.SerializeToString().decode("latin1")})
```

---

## Autoresponders

An autoresponder watches decoded V2 device → broker traffic and sends a canned
`BrokerToDevice` reply on the device's B2D topic. The first match wins, in the
order the responders were registered. See
[How an incoming device message is handled](#how-an-incoming-device-message-is-handled)
for how responders rank against scripts and the built-in fallbacks.

Autoresponders only apply to V2 (`+/ws-d2b/+`) topics.

### `POST /autoresponse`

Registers an autoresponder.

```jsonc
// body
{
  "name": "checkin-ok",                     // optional; needed to delete it individually
  "trigger": "checkin.request",             // required
  "match": { "checkin": { "request": { "hardwareUid": "*" } } }, // optional
  "response": { /* BrokerToDevice object */ }                    // required
}
// response
{ "status": "OK", "count": 3 }              // count = total registered
```

| Field | Meaning |
|---|---|
| `trigger` | Dot path into the decoded `DeviceToBroker` message. It matches when every segment exists and the final value is not `null`/`undefined`. |
| `match` | Optional deep partial pattern, checked after `trigger` (rules below). |
| `response` | A plain object shaped like `BrokerToDevice`. The broker converts it with `fromObject`, so you never deal with field numbers. This conversion may coerce compatible values and ignore unknown fields; it is not strict structural validation. |
| `name` | Optional label. Names don't have to be unique. |

`match` rules, compared against the message converted with
`toObject({ enums: String, defaults: true })`:

- `"*"` or a missing key matches anything.
- Objects are compared key by key, recursively. Keys that aren't in the pattern are ignored.
- Arrays are compared by index.
- Other values must be strictly equal (`===`). Enums are compared as their **string names**.
- Unset fields show up as proto3 zero values (`0`, `""`, `false`), not `undefined`.
  For example, `{ "foo": 0 }` matches a message where `foo` was never set.

Errors (HTTP 400): `trigger` is missing or not a string, `response` is missing or
not an object, or converting/encoding `response` throws. Because `fromObject`
can coerce compatible values and ignore unknown fields, this is not strict
schema validation and malformed-looking objects are not guaranteed to return
400.

### `GET /autoresponse`

```jsonc
{ "status": "OK", "autoresponders": [ { "name": "checkin-ok", "trigger": "checkin.request", "match": null, "response": { } } ] }
```

### `DELETE /autoresponse/:name`

Removes **every** responder with that name.

```jsonc
{ "status": "OK", "removed": 1 }   // 0 if none matched; not an error
```

### `DELETE /autoresponse`

Removes all registered responders. This doesn't affect the built-in fallbacks.

```jsonc
{ "status": "OK", "removed": 3 }
```

---

## Playback scripts

Playback scripts are JSON files in `scripts/` that describe a sequence of steps
to run against a device. Scripts are referred to by **filename without `.json`**
(e.g. `magtag-demo`). The broker loads scripts from disk the first time
`GET /scripts`, `activate`, or `steps/:stepName/send` is called, and keeps them
cached after that. Edits made to files after that point aren't picked up until
the broker restarts.

Only one script can be active at a time. You can also start the broker with a
script already active: `npm start -- --active-script=<name>`.

### `GET /scripts`

Lists all scripts, their steps, and which one is active.

```jsonc
{
  "scripts": [
    {
      "filename": "magtag-demo",
      "name": "MagTag 2.9\" E-Ink Display Demo",
      "description": "...",
      "protoVersion": "v2",
      "active": true,
      "completedSteps": ["checkin"],          // only populated for the active script
      "steps": [
        {
          "name": "checkin", "description": "...",
          "trigger": "checkin.request", "after": null, "waitFor": null,
          "delay": 0, "topic": null, "enabled": true,
          "hasSend": false, "hasResponse": true,
          "send": null, "response": { }
        }
      ]
    }
  ],
  "fallbackCheckinEnabled": true
}
```

This response doesn't include a `status` field.

### `POST /scripts/:name/activate`

Activates a script. If another script is active, it's replaced.

```jsonc
// body (optional)
{ "disabledSteps": ["step-a"], "autoReset": true }
// response
{ "status": "OK", "active": "magtag-demo" }
// unknown script: HTTP 404
{ "error": "Script not found: magtag-demo" }
```

- `disabledSteps` is added to any steps the script file itself marks `"enabled": false`.
- `autoReset` defaults to `true`. When it's on and a trigger step that already
  completed fires again (e.g. the device reboots and checks in again), the script
  resets and starts over. When it's off, a repeated trigger is ignored.

### `POST /scripts/deactivate`

```jsonc
{ "status": "OK", "active": null }
```

### `POST /scripts/:name/reset`

Clears the active script's completed steps so it runs again from the start.
`:name` must be the active script. If `disabledSteps` is omitted, it is replaced
with an empty list; if `autoReset` is omitted, its current value is preserved.
When provided, `disabledSteps` replaces the current disabled-step list and
`autoReset` replaces the current setting.

```jsonc
// body (optional): disabledSteps defaults to []; autoReset defaults to unchanged
{ "disabledSteps": [], "autoReset": false }
// response
{ "status": "OK", "reset": "magtag-demo" }
// not the active script: HTTP 400
{ "error": "Script \"magtag-demo\" is not the active script" }
```

### `POST /scripts/:name/steps/:stepName/send`

Publishes one step's `send` payload (or its `response` payload if it has no
`send`) right away. The script doesn't need to be active, and the step's run
state doesn't change.

```jsonc
// body (optional)
{ "devicePrefix": "myuser/ws-b2d/abc123" }
// response
{ "status": "OK", "topic": "myuser/ws-b2d/abc123", "step": "show-image" }
```

`devicePrefix` is the **full B2D topic** to publish to, despite its name. If you
leave it out, the broker uses the first `/ws-b2d/` subscription of the first
connected client whose id starts with `io-wipper-`. If there's no such client,
it publishes to `protomq-ui/ws-b2d/unknown`, so the message goes nowhere useful.
Pass the topic explicitly whenever more than one device might be connected.

Errors: `404` for an unknown script or step, `400` if the step has no payload,
and `500` if the payload fails to encode as `BrokerToDevice`.

### `POST /scripts/fallback-checkin`

Turns the built-in checkin autoresponder (V2 and V1) on or off. It's on by default.

```jsonc
// body
{ "enabled": false }
// response
{ "status": "OK", "fallbackCheckinEnabled": false }
```

---

## Delivery capture

Delivery capture records every message a client publishes (its **outbox**) and
every message published on a topic it's subscribed to (its **inbox**). Use it to
assert on what a device sent and received during a test.

### `POST /track_deliveries`

Starts recording for a client id. The client doesn't have to be connected yet,
so you can start tracking before the device boots.

```jsonc
// body
{ "client": "io-wipper-abc123" }
// response
{ "status": "OK" }
// already tracked (HTTP 200): the mailbox is DELETED, not reset
{ "status": "ERROR", "message": "Mailbox already initialized for: io-wipper-abc123, clearing it now." }
```

Calling this twice for the same client stops tracking it. Call it a third time
to start again with an empty mailbox.

### `POST /dump_deliveries`

Returns what has been recorded since tracking started.

```jsonc
// body
{ "client": "io-wipper-abc123", "clear": true }   // clear is optional, default true
// response
{
  "status": "OK",
  "deliveries": {
    "inbox":  [ { "topic": "myuser/ws-b2d/abc123", "payload": { /* decoded message */ } } ],
    "outbox": [ { "topic": "myuser/ws-d2b/abc123", "payload": { /* decoded message */ } } ]
  }
}
// not tracked (HTTP 200)
{ "status": "ERROR", "message": "No mailbox initialized for: io-wipper-abc123." }
```

- By default the mailbox is returned **and deleted**, which also stops tracking
  the client. Call `track_deliveries` again to keep recording.
- `"clear": false` returns the mailbox and keeps recording into it. Only a literal
  `false` does this. Each peek returns everything recorded so far, so messages
  repeat across peeks.
- Payloads on V2 (`/ws-b2d/`, `/ws-d2b/`) and known V1 (`/wprsnpr/`) topics are
  decoded into protobuf objects. Everything else (or anything that fails to
  decode) is returned as a serialized Node `Buffer`:
  `{ "type": "Buffer", "data": [ ...bytes ] }`.
- The inbox only matches **exact** subscriptions. Messages a client receives
  through a wildcard subscription (`+`, `#`) aren't recorded in its inbox.
- `$SYS/...` and `state/clients` topics are never recorded.

---

## Reset

### `POST /reset`

Resets ProtoMQ's API-managed test configuration and disconnects currently
connected clients:

- removes all registered autoresponders
- deactivates the active script
- turns the checkin fallback back on
- deletes all delivery mailboxes (and stops all tracking)
- closes connected MQTT clients

```jsonc
// response
{ "status": "OK", "cleared": { "autoresponders": 2, "mailboxes": 1, "clients": 1 } }
```

The `clients` count is the number that were connected when reset began. Reset
doesn't reload scripts from disk or restart the MQTT broker. MQTT state outside
this API (such as retained messages or persistent sessions from clients using
`clean: false`) may remain; restart ProtoMQ between tests that require a fresh
broker instance.

---

## How an incoming device message is handled

When a device publishes on `<user>/ws-d2b/<uid>`, the broker decodes it as a
`DeviceToBroker` and tries each handler below in order. **The first one that
handles the message wins, and the rest are skipped:**

1. **Active playback script**: a step whose trigger (or pending `waitFor`) matches.
2. **Registered autoresponders**: the first registered responder whose `trigger` and `match` both match.
3. **Checkin fallback** (if turned on): answers a checkin request with a default response.
4. **V1-style fallback**: legacy request → response pairs.
5. Otherwise the message is logged as "Not Auto-Responding" and no reply is sent.

Replies from steps 2–4 go to the same topic with `d2b` replaced by `b2d`.

V1 devices (`<user>/wprsnpr/...`) only get the checkin fallback (when it's on),
which replies with a description response and an empty pin configuration.
Autoresponders and scripts don't apply to V1 traffic.

Messages that fail to decode are logged with their hex bytes and ignored.

---

## Typical test flow

```python
import httpx
api = httpx.Client(base_url="http://localhost:5173/api")

def setup():
    api.post("/reset")
    api.post("/track_deliveries", json={"client": DEVICE_ID})
    api.post("/autoresponse", json={
        "name": "checkin",
        "trigger": "checkin.request",
        "response": CHECKIN_RESPONSE,   # BrokerToDevice-shaped dict
    })

def test_device_checks_in():
    # ... boot or reset the device ...
    box = api.post("/dump_deliveries", json={"client": DEVICE_ID, "clear": False}).json()
    assert any("checkin" in m["payload"] for m in box["deliveries"]["outbox"])

def teardown():
    api.post("/reset")
```
