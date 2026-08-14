# The sleep feed — `{feed}-sleep`

How the editor tells a **CircuitPython** board how long to sleep and what to wake
on. Three fields on an Adafruit IO feed, and nothing else.

- **Producer:** `pushToDisplayCircuitPython()` in `public/js/device.js`, via
  `currentSleepPayload()`. Fired by "Push to display" in Act II.
- **Consumer:** `code.py` on a CIRCUITPY drive. **Not yet implemented** — see
  Known gaps.

This exists because the WipperSnapper sleep path does not reach a CircuitPython
board. `POST /sleep/config` encodes a protobuf onto `{user}/ws-b2d/{device}`, and
a board running the generated bundle never joins that transport. Before this feed,
the editor's "Wake and redraw" control had no route to such a board at all: its
sleep window was a `REFRESH_SECONDS` constant in `code.py`, edited by hand on the
drive.

It is a feed rather than a field in `cfg-marquee.json` for the reason that file
gives itself: timing is not a property of the panel, and a sleep window that
changed the bundle's signature would send the user back to A6 to re-copy files
every time they touched a dropdown.

## The feed key

`{ADAFRUIT_IO_FEED}-sleep` — the image feed's key with `-sleep` appended. With the
default `marquee`, that is `marquee-sleep`.

Derived, not configured (`sleepFeedKey()` in `public/js/api.js`). Two independently
settable keys is two ways for a board to end up reading one feed and not the
other, and the pairing is not a decision anyone needs to make. Renaming the image
feed to `kitchen` moves the sleep window to `kitchen-sleep` with it.

**Both feeds must already exist on the account.** The IO data API 404s on an
unknown feed key; it does not create one for you.

## Worked example

```json
{"alarm_type": "timer+pin", "sleep_mode": "deep", "sleep_time": 900}
```

Published as the feed's `value`, so the consumer reads a **string** and parses it:

```python
resp = session.get(".../feeds/marquee-sleep/data/last", headers={"X-AIO-Key": key})
cfg = json.loads(resp.json()["value"])
```

## Fields

### `alarm_type` — `"timer"` | `"pin"` | `"timer+pin"`

What the board arms before it sleeps.

| value | arm |
|---|---|
| `timer` | one `alarm.time.TimeAlarm` at `sleep_time` seconds |
| `pin` | one `alarm.pin.PinAlarm` |
| `timer+pin` | one of each — whichever fires first wakes the board |

**At most one alarm of each kind.** The combination is deliberately not a list:
one timer and one pin covers "redraw on a schedule, but let me force it", and
anything richer is a config format nobody asked for.

Comes from the "Wake on" select in A7's inspector. That control is hidden on the
WipperSnapper path, where `server.js` implements `TimerConfig` and defers
`Ext0Config` — offering a pin there would be a control nothing downstream honours.

### `sleep_mode` — `"light"` | `"deep"`

Mapped from the `S_LIGHT` / `S_DEEP` values of Settings → Sleep behaviour → Sleep
mode (`SLEEP_MODE_JSON` in `device.js`). The wire spelling is lowercase to match
`alarm_type`; the `S_`-prefixed forms are the WipperSnapper protobuf enum
(`ws.sleep.SleepMode`) and stay on that side of the boundary.

The two are not interchangeable for the consumer:
`alarm.exit_and_deep_sleep_until_alarms()` never returns, while
`alarm.light_sleep_until_alarms()` resumes in place — so a `code.py` that supports
`light` needs its take wrapped in a loop.

### `sleep_time` — integer seconds

The timer duration. Same value as the editor's refresh interval — the
`#sleepDuration` field, surfaced as "Wake and redraw" in A7 and read through
`refreshInterval()`.

**Always present, and ignored when `alarm_type` is `"pin"`.** Sending it
unconditionally keeps the payload one shape, and a pin-only alarm has no duration
to express. `0` is a legal value the broker path uses for "wake as soon as
possible"; on this path it means a `TimeAlarm` in the past, so a consumer should
treat it as "do not sleep on the timer" rather than passing it through.

## What is deliberately not here

**The wake pin.** A `PinAlarm` needs to know which pin, and that is a fact about
how the board is wired rather than about this take — so it belongs on the drive
next to `code.py`, alongside `REFRESH_SECONDS`. Re-sending it with every push
would also mean the editor had to know each board's button pins, which is exactly
the kind of hardware knowledge `cfg-marquee.json` exists to hold and the editor's
panel catalog does not carry.

The practical consequence: `alarm_type` can ask for a pin the board has no pin
for. That is the consumer's call to make, and the answer is to say so and fall
back to the timer, not to refuse to sleep.

**Credentials and the feed key itself** — `settings.toml`, as with the image feed.

**Anything about the panel** — `cfg-marquee.json`, which this file does not touch.
No version bump: the descriptor is unchanged at `cfg_version: 2`.

## Fallbacks — what an absent feed means

A first boot, a feed that was never created, a malformed value, an offline radio:
all of these are the normal state of affairs at some point, and none of them is
an error worth bricking a take over.

- No value, or one that will not parse → fall back to `REFRESH_SECONDS` and a
  plain timer.
- `alarm_type` asks for a pin the board does not define → drop the pin, keep
  whatever else was asked for.
- Nothing left to arm → arm a `TimeAlarm` at `REFRESH_SECONDS` anyway. **Never
  deep-sleep with no alarm**; a board with no way back is a board that needs a
  USB cable.

## The editor's side of the push

`pushToDisplayCircuitPython()`, in order:

1. Render through the backend (the only render path — see `render.js`).
2. Publish the base64 BMP to the image feed. **The dashboard goes first:** if only
   one of the two writes lands, a board holding a new image and an old sleep
   window still shows the right thing.
3. Publish this JSON to the sleep feed.
4. Navigate to Act III.

It does not wait for anything, and there is nothing it could wait for — no
acknowledgement exists on this path. Act III's countdown is therefore a client-side
estimate of the window that was published, not a report of the board's state. When
`alarm_type` is `pin` there is no wake time to estimate, so A8 says "sleeping until
the button is pressed" and runs no clock (`wakeSource` in `state.js`).

`setDeviceCanvasSig()` is **not** called: that baseline means "confirmed on the
glass", and nothing here confirms anything.

## Known gaps

- **`code.py` does not read this feed yet.** The generated bundle still sleeps on
  its hardcoded `REFRESH_SECONDS` and ignores `alarm_type` and `sleep_mode`
  entirely, so the publisher side is complete and the round trip is not. There is
  a `TODO` in `codePy()` (`public/js/bundle.js`) carrying this contract inline for
  whoever writes the consumer.
- **`settings.toml` has no `ADAFRUIT_IO_SLEEP_FEED`.** Whether the consumer wants
  the key from the environment or derived from `ADAFRUIT_IO_FEED` is its call, and
  a stale entry in a file the user is told to edit by hand is worse than no entry.
- **Deep-sleep pin alarms are not available on every pin.** On the ESP32-S2/S3
  only RTC-capable GPIOs survive deep sleep. A board whose only button is on a
  non-RTC pin can honour `pin` under `light` but not under `deep`.
- **Nothing reports the board's real state — yet.** `deviceState` goes to `asleep`
  because we published a sleep window, not because a board said so. The
  WipperSnapper path has goodnight/checkin events for this; the equivalent here is
  the sibling `{feed}-status` feed (`docs/marquee-status.md`), which the editor
  already reads and no `code.py` publishes yet. Until one does, Act III models the
  cycle and says so.

  Note what the round trip is worth once it exists: `sleep_time` coming back on
  `-status` is the same field, in the same units, as the one sent here — so a board
  that ignores this feed and sleeps on `REFRESH_SECONDS` stops being invisible and
  becomes a one-line diff.
