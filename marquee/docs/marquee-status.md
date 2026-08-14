# The status feed — `{feed}-status`

How a **CircuitPython** board tells the editor what it is actually doing. Two
moments, one field required, and nothing else.

- **Producer:** `code.py` on a CIRCUITPY drive. **Not yet implemented** — see
  Known gaps.
- **Consumer:** the status watch in `public/js/device.js` (`pumpStatus`,
  `applyStatus`, `watchForStatus`), read browser-direct through
  `readFeedData()` in `public/js/feeds.js`.

This exists because the CircuitPython path had no acknowledgement of any kind. The
WipperSnapper path hears `goodnight` and `checkin.complete` from the device and drives
Act III off them; here the editor was left inferring the board's entire life from the
sleep window it published — `deviceState` went to `asleep` because we sent something,
not because a board said so. Everything downstream of that was a guess: when the
panel would redraw, when the next wake was due, and whether a queued take had reached
the glass.

## The feed key

`{ADAFRUIT_IO_FEED}-status` — the image feed's key with `-status` appended. With the
default `marquee`, that is `marquee-status`.

Derived, not configured (`statusFeedKey()` in `public/js/api.js`, sharing
`siblingFeed()` with `sleepFeedKey()`), so renaming the image feed to `kitchen` moves
all three feeds together and they cannot drift apart.

**It must be a separate feed from `-sleep`, not a second use of it.** That feed is
read by `code.py` as "the last value is my window". A board writing its own status
there would shadow its own config within one cycle — and it would win that race
almost always, because it publishes every cycle while the editor publishes only when
someone pushes. One writer per feed keeps `/data/last` unambiguous in both
directions.

**Keep feed history ON.** The editor reads the last few data points, not just the
last one, so a poll that lands after both transitions can still see them. That caps
the value at 1 KB (`IO_MAX_HISTORY` in `public/js/api.js`) — which the payload below
must stay comfortably under.

## Worked example

```json
{"state": "awake", "wake_reason": "timer"}
```

```json
{"state": "sleeping", "sleep_time": 900, "alarm_type": "timer"}
```

Published as the feed's `value`, so the consumer reads a **string** and parses it —
same convention as `-sleep`.

## Fields

### `state` — `"awake"` | `"sleeping"`

**The only required field.** Everything reads this first and ignores what it does not
recognise.

| value | published when | the editor does |
|---|---|---|
| `awake` | the board has connected to the broker | stops the countdown, `deviceState` → `online-awake`, Showtime says the display is awake and redrawing |
| `sleeping` | the board is arming its alarm | promotes the queued take, then starts the countdown from this datum's `created_at` |

The pair is worth more than either message alone, because it **brackets the fetch**. A
take published *before* an `awake` was on the image feed when the board pulled it; one
published *between* the two may have missed that pull. That is what lets the editor
move "On the panel now" without the board having to report which image it drew.

### `sleep_time` — integer seconds

The timer the board **actually armed**, which is not necessarily the one the editor
asked for on `-sleep`. Same name and units as that feed on purpose: a field-by-field
diff between the two feeds' last values is what exposes a board still sleeping on its
own `REFRESH_SECONDS`.

Absent means "the board didn't say", and the editor falls back to `refreshInterval()`.
It must never be read as `0` — that is a legal value meaning "do not sleep on the
timer" (see `docs/marquee-sleep.md`).

### `alarm_type` — `"timer"` | `"pin"` | `"timer+pin"`

What the board armed, in the same vocabulary `-sleep` uses to ask for it. Drives
`wakeSource` in `state.js`, which is how Act III decides whether there is a wake
*time* to count down to at all: a `pin` board sleeps until a finger lands on the
button, so the clock is replaced rather than run.

### `wake_reason` — `"timer"` | `"pin"` | `"reset"`

On `awake` only, from CircuitPython's `alarm.wake_alarm` (`None` on a cold boot).
Surfaced on the status line. It is what distinguishes a button press from a scheduled
take, and a first boot from a cycle.

## Extending it

Additive keys only, and **no version field**. Unknown keys are ignored, missing keys
mean "not reported", so a new field is never a breaking change. A version number only
earns its keep if a consumer *rejects* on mismatch, and the right behaviour on both
sides here is always "read what you understand" — a version would only invite a
consumer to refuse a payload it could have used most of.

The next field is likely `wake_pin`, sitting beside `alarm_type` and `wake_reason`:

```json
{"state": "sleeping", "sleep_time": 900, "alarm_type": "timer+pin", "wake_pin": "D15"}
{"state": "awake", "wake_reason": "pin", "wake_pin": "D15"}
```

Note the direction: the editor deliberately does **not** tell the board which pin to
use (`docs/marquee-sleep.md`, "What is deliberately not here"), because that is a fact
about how the board is wired. The board reporting what it armed is the harmless
inverse of that.

## What is deliberately not here

**Whether the board drew.** It is inferable from the `awake`/`sleeping` bracket, and a
`drew` flag would be a second source of truth for a question the pair already answers.

**Battery voltage.** It belongs on its own feed, where `refreshFeedElements()` and
`readFeedHistory()` can already bind it to a battery element and chart it. Inside this
payload it would be unreadable by any of that.

**Anything about the panel** — `cfg-marquee.json`.

**Errors, tracebacks, or anything unbounded.** The 1 KB history-on ceiling is the
budget, and a short code is always enough.

## Fallbacks — what silence means

A board running an older `code.py` publishes nothing, and that has to keep working.

- **No status has ever arrived** → Act III runs the modelled cycle
  (`renderEstimatedCycle` in `public/js/screens/a8.js`), and the queued take is
  promoted by `scheduleQueuedWrite`'s timer. All estimates, and the screen says so.
- **A status has arrived at some point, and then the board goes quiet** past the wake
  plus `awakeSeconds()` plus a 60s grace → `deviceState` → `offline`. A board that has
  proved it reports can be judged for not reporting; one that never has, cannot.
- **The feed is unreadable** (missing, no credentials, network down) → unknown, not
  "nothing happened". `readFeedData` resolves `null` and the watch keeps looking,
  matching `readFeedValue`'s contract.
- **The value will not parse** → treated as `{"state": <the trimmed string>}`, so a
  bare `awake` works. An unrecognised state is ignored and does **not** count as a
  report, so it cannot retire the fallback for nothing.

## The editor's side of the read

`pushToDisplayCircuitPython()` seeds the cursor with `resetStatusWatch()` before it
publishes — so a status left over from a previous bench run cannot be credited to this
cycle, exactly as `resetSleepEvents()` does on the broker path — and starts
`watchForStatus()` once the push lands.

Polling is confined to the window the board could plausibly be up in: nothing can
arrive during the sleep, and IO's rate limit is a budget shared with every element
binding on the canvas. Roughly 15 requests per cycle at 5s spacing, versus the free
tier's 30/min.

Because a feed's last value is **state and not an event log**, a late read loses
nothing but latency — which is what makes a backgrounded tab safe. Chrome throttles its
timers to a crawl, so there are catch-up reads on `visibilitychange` and on entering
Act III, and a batch of 4 data points per poll so a gap that swallowed a whole
`awake`/`sleeping` pair is still reconstructable.

## Known gaps

- **`code.py` does not publish this feed yet.** The consumer side is complete and the
  round trip is not, so in practice every board is still on the fallback path above.
  The editor half can be exercised by publishing the payloads by hand.
- **No `-status` write from the editor, ever.** If a future feature needs the editor
  to talk to a running board, it needs its own feed; adding a second writer here
  reintroduces exactly the shadowing problem this feed exists to avoid.
- **A reload mid-cycle does not resume the watch.** `statusCursor` and `statusSeen`
  are module state, and `published` is deliberately not persisted either
  (`state.js`), so a reloaded tab is back to the fallback until the next push.
- **`settings.toml` has no `ADAFRUIT_IO_STATUS_FEED`.** Same call as `-sleep`: whether
  the producer derives the key or reads it from the environment is its business.
