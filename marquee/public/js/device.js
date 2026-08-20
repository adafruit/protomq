/**
 * Everything that talks to a real board: the display add, the chunked canvas
 * write, the sleep/wake cycle, and the reset that tears all of it down.
 *
 * The shape of this module is dictated by one fact — a deep-sleeping e-paper
 * device is unreachable between wakes, and it pipelines its replies with no gap
 * (checkin.complete, then the next cycle's goodnight microseconds later). So
 * nothing here latches on "the last event seen": the backend keeps an
 * append-only log with a monotonic seq, we pull with a cursor into a local
 * queue, and each stage CONSUMES the event it cares about while leaving the
 * others queued in order for whoever owns them.
 */

import { BACKEND, sleepFeedKey, statusFeedKey } from './api.js';
import { navigate } from './router.js';
import { layer, hideDitherPreview } from './stage.js';
import { select } from './selection.js';
import { resetCounter } from './elements.js';
import { buildDisplayBody, refreshInterval, sleepModeFor } from './config.js';
import {
  serialize, canvasSignature, canvasChanged, setDeviceCanvasSig,
  invalidateCanvasBaseline, saveCanvasNow, cancelCanvasSave,
} from './doc.js';
import { renderOrReport, tooLargeForIO, publishToIO } from './render.js';
import { refreshFeedElements, readFeedData } from './feeds.js';
import { takeInFlight } from './cycle.js';
import {
  getState, setState, setPublished, clearPublished,
  getQueued, setQueued, clearQueued, subscribe,
} from './state.js';
import { syncPushBlock } from './screens/a7.js';
import { $, val, toast, fmtBytes, fmtLocalSeconds } from './util.js';

// ---------- observers -------------------------------------------------------

const deviceListeners = new Set();
/** Emits {type} for 'pushed' | 'woke' | 'reset' | 'status'. */
export function onDeviceEvent(fn) { deviceListeners.add(fn); }
function emit(type, detail = {}) { deviceListeners.forEach((fn) => fn({ type, ...detail })); }

function status(text) {
  const el = $('sleepStatus');
  if (el) el.textContent = text;
  emit('status', { text });
}
function debugLine(text) {
  const el = $('sleepDebug');
  if (el) el.textContent = text;
}

// ---------- epoch -----------------------------------------------------------

/**
 * Bumped by every "Reset state". The cycle is driven by long-lived async loops
 * (the per-wake resend chain, the 45s retransmit window) that nulling a variable
 * cannot interrupt — they are already awaiting a fetch. Each captures the epoch
 * it started under and abandons itself the moment it changes, so a reset can't
 * be followed by a write to a device we just tore down.
 */
let stateEpoch = 0;

// ---------- the cycle in flight ---------------------------------------------

/**
 * `registeredSig` mirrors what the broker is holding for this device, so we only
 * re-POST when it is actually wrong.
 */
let sleepCycle = null; // { user, device, mode, durSeconds, registeredDisplay, registeredSig }

/** The live sleep form, read fresh every time — never snapshotted. A snapshot is
 *  what made the timer look unchangeable, because the broker kept being handed
 *  the duration from the moment the push was pressed. */
function currentSleepConfig() {
  const durSeconds = refreshInterval();
  // Derived, not read off a control: there is no sleep-mode picker any more,
  // because the interval already determines the answer (sleepModeFor in config.js).
  // The backend derives it again from the duration we send, so the two agree by
  // construction; this copy exists to answer the local questions — whether there is
  // a display to maintain, and what the CircuitPython feed should carry.
  return { mode: sleepModeFor(durSeconds), durSeconds };
}

/** ws.sleep.SleepMode -> the spelling the CircuitPython sleep feed uses. */
const SLEEP_MODE_JSON = { S_LIGHT: 'light', S_DEEP: 'deep' };

/**
 * The sleep window as it goes onto the feed, for the CircuitPython path. Three
 * fields and no more.
 *
 * The wake PIN is deliberately absent: it is a fact about how the board is wired,
 * not about this take, so it lives on the CIRCUITPY drive next to code.py rather
 * than being re-sent with every push. `sleep_time` is always included and is
 * ignored by the consumer when `alarm_type` is "pin". See docs/marquee-sleep.md.
 */
function currentSleepPayload() {
  const { mode, durSeconds } = currentSleepConfig();
  const alarm = $('wakeAlarm')?.value || 'timer';
  // The interval picks the mode wherever there IS a timer — which includes
  // "timer+pin", whose TimeAlarm makes the same light-vs-deep trade as a bare timer.
  // A pin-only alarm ignores sleep_time entirely (docs/marquee-sleep.md), so there
  // is nothing to derive from and it keeps the deep default it always had.
  //
  // That default is the one case worth knowing about: deep-sleep PinAlarms need an
  // RTC-capable GPIO on the ESP32-S2/S3, so a board whose only button is on a
  // non-RTC pin cannot honour "pin" under "deep" — and pin-only has no timer to
  // recover with. The consumer's answer is the fallback the doc already specifies:
  // drop the pin and arm a TimeAlarm rather than deep-sleeping with no alarm.
  const effective = alarm === 'pin' ? 'S_DEEP' : mode;
  return {
    alarm_type: alarm,
    sleep_mode: SLEEP_MODE_JSON[effective] || 'deep',
    sleep_time: durSeconds,
  };
}

/**
 * The broker replays ONE stored wake response on every checkin, and it is
 * registered before the device wakes — so an edit made mid-sleep has to
 * overwrite that registration now, or the device wakes with no display and the
 * write has nothing to apply to.
 */
export async function syncWakeResponse({ rearmMs } = {}) {
  if (!sleepCycle) return false;
  const { mode, durSeconds } = currentSleepConfig();
  // Only deep sleep has a display to maintain — a light-sleeping device never
  // drops its display, so there is nothing to re-add and the backend just
  // re-arms the watch for us.
  const want = mode === 'S_DEEP' && canvasChanged();
  // Dedupe on the WHOLE registration, not just the display flag. Changing the
  // duration leaves `want` untouched, so keying on it alone would return early
  // and silently swallow exactly the edit the user was trying to make. The mode is
  // now a function of the duration, so it cannot change independently of it — the
  // duration covers both.
  const sig = `${durSeconds}|${want}`;
  if (!rearmMs && sig === sleepCycle.registeredSig) return true;
  try {
    const res = await fetch(BACKEND + '/sleep/wake-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        duration: durSeconds,
        user: sleepCycle.user,
        device: sleepCycle.device,
        ...(want ? { display: buildDisplayBody() } : {}),
        ...(rearmMs ? { rearmMs } : {}),
      }),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    // The backend answers ok even when it couldn't reach the broker, so only
    // record the registration once the broker actually took it — otherwise we'd
    // stop retrying while the broker still holds the wrong response.
    //
    // Gated on the mode the BACKEND derived, not ours: the backend's is the copy
    // that encodes the protobuf, so if the two ever drift it is the one the device
    // obeys, and believing it is what keeps this retry loop honest.
    const srvMode = data.mode || mode;
    if (srvMode !== 'S_DEEP' || (data.wakeCheckin && data.wakeCheckin.registered)) {
      sleepCycle.registeredSig = sig;
      sleepCycle.registeredDisplay = want;
      // What the broker now holds — i.e. what the device gets at its NEXT
      // checkin. The sleep it is running right now was fixed when it last
      // checked in.
      sleepCycle.mode = srvMode;
      sleepCycle.durSeconds = durSeconds;
    }
    return true;
  } catch { /* backend down — the next edit or wake retries */ }
  return false;
}

/** The backend watch TTL a full cycle needs: sleep duration + wake overhead. */
const cycleWatchMs = (durSeconds) => durSeconds * 1000 + 150000;

// Konva fires 'draw' on every drag frame, so collapse a burst of edits into one
// registration POST.
let wakeSyncTimer = null;
export function scheduleWakeResponseSync() {
  // Gated on the CYCLE, not on the mode: dragging the interval down across the
  // five-minute line turns a deep sleep into a light one, and that is itself a
  // change the broker has to hear about (its stored deep-sleep response would
  // otherwise keep re-provisioning and re-sleeping the device) — yet the edit reads
  // as non-deep right here. syncWakeResponse decides what to send.
  if (!sleepCycle) return;
  clearTimeout(wakeSyncTimer);
  wakeSyncTimer = setTimeout(syncWakeResponse, 500);
}

// ---------- device event pump -----------------------------------------------

let sleepEventCursor = 0, sleepEventQueue = [], sleepWatchId = null;

/** Fetch anything new and append it to the queue. Returns the status object, or
 *  null if the backend was unreachable this tick. */
async function pumpSleepEvents() {
  let s = null;
  try { s = await (await fetch(`${BACKEND}/sleep/status?since=${sleepEventCursor}`)).json(); }
  catch { return null; }
  if (s.watchId !== sleepWatchId) {
    // The watch retargeted a different device — old events are meaningless.
    sleepWatchId = s.watchId;
    sleepEventQueue = [];
    sleepEventCursor = s.seq;
    return s;
  }
  if (Array.isArray(s.events) && s.events.length) {
    sleepEventQueue.push(...s.events);
    sleepEventCursor = s.seq;
  }
  return s;
}

/** Consume the oldest queued event of this type, leaving other types in order —
 *  so a goodnight queued behind a write isn't dropped by the write wait. */
function takeSleepEvent(type) {
  const i = sleepEventQueue.findIndex((e) => e.type === type);
  return i < 0 ? null : sleepEventQueue.splice(i, 1)[0];
}

/** Start a user-initiated cycle: skip whatever is already in the log so a
 *  previous session's events can't drive this one. */
async function resetSleepEvents() {
  try {
    const s = await (await fetch(`${BACKEND}/sleep/status`)).json();
    sleepWatchId = s.watchId;
    sleepEventCursor = s.seq;
  } catch { sleepEventCursor = 0; }
  sleepEventQueue = [];
}

// ---------- countdown -------------------------------------------------------

let sleepCountdownTimer = null;

/**
 * `wakesAt` in flow state is what the chrome clapperboard ticks off, so the countdown
 * survives navigating away from the screen and back.
 *
 * `since` is when the sleep actually BEGAN. It defaults to now, which is right for
 * the caller that just sent the command — but a status feed datum is read up to a
 * poll late, and anchoring that to the read instead of to the board's own timestamp
 * would push the wake time out a little further on every cycle.
 */
function startSleepCountdown(seconds, { since = Date.now() } = {}) {
  if (sleepCountdownTimer) { clearInterval(sleepCountdownTimer); sleepCountdownTimer = null; }
  const total = Math.max(0, Math.floor(seconds) || 0);
  const from = Number.isFinite(since) ? since : Date.now();
  setState({ deviceState: 'asleep', wakesAt: from + total * 1000, sleepSeconds: total });

  const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
  let left = Math.max(0, Math.round((from + total * 1000 - Date.now()) / 1000));
  const tick = () => {
    if (left <= 0) {
      clearInterval(sleepCountdownTimer);
      sleepCountdownTimer = null;
      // The timer only ESTIMATES the sleep duration — it does not mean the
      // device is back. Stay in a waiting state until the real checkin.complete
      // arrives (the poller flips this), or the poller gives up.
      status('⏰ Sleep timer elapsed — waiting for the device to check in…');
      return;
    }
    status(`💤 Sleeping — ${fmt(left)} remaining`);
    left--;
  };
  tick();
  if (total > 0) sleepCountdownTimer = setInterval(tick, 1000);
}

function stopSleepCountdown() {
  if (sleepCountdownTimer) { clearInterval(sleepCountdownTimer); sleepCountdownTimer = null; }
}

// ---------- write acknowledgement -------------------------------------------

let writePollTimer = null;

/**
 * Resolvers a reset has to unblock. Killing the poll timer is not enough on its
 * own: the promise is settled from inside the interval callback, so an interval
 * cleared out from under it can never settle — and the caller would await it
 * forever with its button left disabled. A reset settles these explicitly.
 */
const pendingWaits = new Set();

function abortPendingWaits() {
  for (const settle of [...pendingWaits]) settle(false);
  pendingWaits.clear();
}

/**
 * After a canvas write, the device publishes display.WriteComplete on ws-d2b
 * once it has finished applying it (e-ink refresh done). Take only the 'write',
 * leaving any goodnight or checkin queued in order — the device often sends its
 * goodnight in the very same batch, and that one belongs to waitForSleepEvents.
 */
function waitForWriteComplete({ timeoutMs = 20000, onStatus } = {}) {
  return new Promise((resolve) => {
    if (writePollTimer) { clearInterval(writePollTimer); writePollTimer = null; }
    const start = Date.now();
    const epoch = stateEpoch;
    // Local handle: after a reset the shared one may already belong to a newer
    // wait, so a stale tick must only ever cancel ITSELF.
    let self = null;
    const settle = (v) => {
      pendingWaits.delete(settle);
      clearInterval(self);
      resolve(v);
    };
    pendingWaits.add(settle);
    self = setInterval(async () => {
      if (epoch !== stateEpoch) { settle(false); return; }
      await pumpSleepEvents();
      const ev = takeSleepEvent('write');
      if (ev) {
        writePollTimer = null;
        onStatus?.({ acked: true, client: ev.client });
        settle(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        writePollTimer = null;
        onStatus?.({ acked: false });
        settle(false);
      }
    }, 2000);
    writePollTimer = self;
  });
}

/**
 * Push the BMP over /display/send-bmp and resend the whole thing every 45s until
 * the device publishes display.WriteComplete, up to the configured retry window.
 * Re-POSTing re-arms the backend's WriteComplete watch, so each attempt waits for
 * a fresh ack. Shared by the initial push and the per-wake resend, so BOTH
 * confirm the write before anything waits for a Goodnight.
 */
async function writeCanvasUntilAck(b64, { btn, onStatus } = {}) {
  const WRITE_ACK_TIMEOUT_MS = 45000;
  const retryMins = Math.max(1, parseInt($('writeRetryWindow')?.value, 10) || 5);
  const retryWindowMs = retryMins * 60000;
  const startedAt = performance.now();
  const epoch = stateEpoch;
  let acked = false, attempt = 0, sendFailed = false, aborted = false;

  while (true) {
    // A reset can land in the middle of the retry window (each attempt waits 45s
    // for an ack). Stop before re-POSTing a BMP to a device whose state we just
    // cleared; the caller sees acked=false + aborted and unwinds quietly.
    if (epoch !== stateEpoch) { aborted = true; break; }
    attempt++;
    if (btn) btn.textContent = attempt === 1 ? 'Writing to device…' : `Resending (attempt ${attempt})…`;
    const res = await fetch(BACKEND + '/display/send-bmp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bmp: b64,
        name: val('pmName') || 'epd0',
        user: val('pmUser') || 'test_user',
        device: val('pmDevice') || 'magtag',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(`Send BMP failed (${res.status}): ${data.error || 'unknown error'}`);
      sendFailed = true;
      break;
    }

    onStatus?.(`📝 Waiting for the device to confirm the write (attempt ${attempt})…`);
    acked = await waitForWriteComplete({
      timeoutMs: WRITE_ACK_TIMEOUT_MS,
      onStatus: ({ acked: ok, client }) => {
        if (ok) onStatus?.(`✅ Write confirmed by "${client || '?'}"`);
      },
    });
    if (acked) break;
    if (epoch !== stateEpoch) { aborted = true; break; }

    // No ack this window — give up if the retry budget is spent, else resend.
    if (performance.now() - startedAt >= retryWindowMs) break;
    const msg = `No WriteComplete in ${WRITE_ACK_TIMEOUT_MS / 1000}s — resending (attempt ${attempt + 1})…`;
    toast(`⚠️ ${msg}`);
    onStatus?.(`⚠️ ${msg}`);
  }

  return { acked, sendFailed, retryMins, aborted };
}

// ---------- the wake watch --------------------------------------------------

let goodnightPollTimer = null;

/**
 * After a sleep command is sent, don't start the counter immediately — wait for
 * the DEVICE to confirm. Two events matter: goodnight (device is sleeping →
 * start the countdown) and checkin (device woke and re-checked-in → resend if
 * the design moved, then re-arm for the next cycle).
 */
function waitForSleepEvents(durSeconds, { sendBmpOnWake = false } = {}) {
  status('💤 Waiting for the device to say goodnight…');
  debugLine('');
  if (goodnightPollTimer) { clearInterval(goodnightPollTimer); goodnightPollTimer = null; }

  const start = Date.now();
  // A deep-sleep wake has a large, roughly-fixed overhead ON TOP of the sleep
  // duration — cold boot + WiFi/MQTT reconnect + checkin round-trip + display
  // re-provision + a slow EPD redraw (tricolor/quad ~9s) + the checkin.complete
  // publish — which routinely runs 30-60s. So the check-in window is the sleep
  // duration PLUS a generous fixed allowance, not a grace that scales with
  // (often short) durations.
  const WAKE_CHECKIN_MS = 120000;
  // Goodnight is INFORMATIONAL (it starts the countdown). The device often
  // enters sleep long after the command, so a late or absent Goodnight must NOT
  // abort the watch; past GOODNIGHT_SLOW_MS we show a soft note and keep polling.
  const GOODNIGHT_SLOW_MS = 90000;
  const checkinDeadline = start + durSeconds * 1000 + WAKE_CHECKIN_MS;

  let gotGoodnight = false, warnedSlow = false;
  const epoch = stateEpoch;
  // Held locally as well as in goodnightPollTimer: a reset nulls the shared
  // handle and a fresh cycle may already own it by the time a stale tick fires.
  let self = null;
  self = setInterval(async () => {
    if (epoch !== stateEpoch) { clearInterval(self); return; }
    const s = await pumpSleepEvents();
    if (epoch !== stateEpoch) return; // reset landed while the poll was in flight

    // Report the watch as a live state, not just a list of candidate ids: a bare
    // list reads like an id mismatch when the real answer is usually "the mailbox
    // is open and the device just hasn't published yet".
    if (!gotGoodnight && s && Array.isArray(s.clients)) {
      const ids = s.clients.join(', ') || '—';
      if (!s.armedAt) {
        debugLine(`opening mailboxes: ${ids}`);
      } else if (s.packetsSeen > 0) {
        debugLine(`watching ${ids} · ${s.packetsSeen} device message${s.packetsSeen === 1 ? '' : 's'} seen`);
      } else {
        const secs = Math.round((Date.now() - start) / 1000);
        debugLine(`watching ${ids} · armed · ${secs}s with no device traffic`);
      }
    }

    // Drain the queue IN ARRIVAL ORDER, stopping at a checkin. Order is the whole
    // point: the device emits checkin.complete and then the NEXT cycle's goodnight
    // right behind it. Matching by type instead of by order would credit that
    // goodnight to this cycle and then sit waiting for one already spent.
    let woke = null;
    while (sleepEventQueue.length) {
      if (sleepEventQueue[0].type === 'checkin') { woke = sleepEventQueue.shift(); break; }
      const ev = sleepEventQueue.shift();
      if (ev.type === 'goodnight' && !gotGoodnight) {
        gotGoodnight = true;
        debugLine(`Goodnight from client "${ev.client || '?'}"`);
        // The broker path's equivalent of a 'sleeping' report: the device said it is
        // going down, so this is the one place its sleep time is a fact.
        setState({ lastSleptAt: Date.now() });
        startSleepCountdown(durSeconds); // device confirmed asleep — run the timer
      }
      // a stray 'write' (or a repeated goodnight) is not this stage's to act on
    }

    if (woke) {
      clearInterval(goodnightPollTimer); goodnightPollTimer = null;
      stopSleepCountdown();
      debugLine(`checkin.complete from client "${woke.client || '?'}"`);
      // A checkin IS the device reporting a wake, so it feeds Act III's banner from the
      // same two fields the status feed does — the label there says "board reported",
      // and on this path that is just as true.
      setState({ deviceState: 'online-awake', wakesAt: null, lastWokeAt: Date.now() });
      emit('woke');
      toast('Device back online');

      // The checkin response the device just consumed carried whatever was
      // registered a moment ago, so THAT duration is the sleep it is about to
      // run — read it before the syncs below register a newer one.
      const activeDur = sleepCycle ? sleepCycle.durSeconds : durSeconds;

      if (!sendBmpOnWake) { status('☕ Device back online'); return; }

      // Re-read bound feeds BEFORE canvasChanged() decides whether to send. That
      // check is the only thing standing between a waking device and a new BMP,
      // so without a refresh here an indicator would never update on a panel that
      // is deep-sleep cycling — the whole point of the element.
      await refreshFeedElements();
      if (epoch !== stateEpoch) return;

      if (!canvasChanged()) {
        // Nothing to send, so nothing re-armed the backend watch — the same POST
        // that keeps the registration sleep-only re-arms it for us.
        const rearmed = await syncWakeResponse({ rearmMs: cycleWatchMs(activeDur) });
        if (epoch !== stateEpoch) return;
        if (!rearmed) {
          status('⚠️ Canvas unchanged, but the watch could not be re-armed — stopping');
          sleepCycle = null;
          return;
        }
        status('☕ Canvas unchanged — nothing sent, watching for the next wake…');
        waitForSleepEvents(activeDur, { sendBmpOnWake: true });
        return;
      }

      status('☕ Device back online — resending the canvas…');
      // Snapshot BEFORE rendering: an edit landing during the render and write is
      // not in the BMP we're about to send, so it must still read as pending.
      const sig = canvasSignature();
      const doc = serialize();
      const r = await renderOrReport('resend the canvas');
      if (epoch !== stateEpoch) return;
      if (!r) { status('⚠️ Device back online — render failed, cannot resend'); return; }

      const { acked, aborted } = await writeCanvasUntilAck(r.bmp, { onStatus: status });
      if (aborted || epoch !== stateEpoch) return;
      if (!acked) {
        status('⚠️ Write not confirmed on wake — stopping');
        sleepCycle = null;
        return;
      }
      status('☕ Write confirmed — watching for the next wake…');
      setDeviceCanvasSig(sig);
      setPublished({ png: 'data:image/png;base64,' + r.png, doc, at: Date.now() });
      setState({ lastWriteAt: Date.now() });
      emit('pushed');
      // Downgrade to sleep-only for the next wake, and extend the watch to cover
      // the whole cycle — send-bmp only armed the short write-ack window.
      await syncWakeResponse({ rearmMs: cycleWatchMs(activeDur) });
      waitForSleepEvents(activeDur, { sendBmpOnWake: true });
      return;
    }

    // Goodnight slow to arrive — note it but KEEP waiting for the checkin.
    if (!gotGoodnight && !warnedSlow && Date.now() > start + GOODNIGHT_SLOW_MS) {
      warnedSlow = true;
      status('⏳ No goodnight yet — the device may still be finishing its redraw…');
    }

    if (Date.now() > checkinDeadline) {  // one hard timeout for the whole cycle
      clearInterval(goodnightPollTimer); goodnightPollTimer = null;
      sleepCycle = null;
      setState({ deviceState: 'offline', wakesAt: null });
      status(gotGoodnight
        ? '⚠️ No check-in received from the device'
        : '⚠️ No goodnight or check-in received from the device');
      // Distinguish "we never heard the device at all" (wrong client id, device
      // offline, mailbox never opened) from "the device was talking to us but
      // never sent this event" (firmware never reached the sleep/checkin path).
      debugLine(!s || !Array.isArray(s.clients) ? ''
        : s.packetsSeen > 0
          ? `${s.packetsSeen} device messages seen on ${s.clients.join(', ')}, but no goodnight/checkin among them`
          : `no device traffic at all on: ${s.clients.join(', ')}`);
    }
  }, 2000);
  goodnightPollTimer = self;
}

// ---------- actions ---------------------------------------------------------

/** Publish the display descriptor. A5's "Send to device & open editor". */
export async function publishDisplayConfig() {
  const body = buildDisplayBody();
  const res = await fetch(BACKEND + '/display/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}`, status: res.status };
  return { ok: true, bytes: data.bytes, topic: data.topic };
}

/**
 * Render, publish to IO, then chunk the BMP to the device. Non-blocking on the
 * write ack so the wake-resend path isn't delayed; the caller waits if it cares.
 */
async function sendBmpToDevice() {
  await refreshFeedElements();
  const r = await renderOrReport('send to the device');
  if (!r) return { ok: false, error: 'backend unreachable' };
  if (tooLargeForIO(r.bmp)) return { ok: false, error: 'payload too large' };

  const io = await publishToIO(r.bmp);
  if (!io.ok) return io;

  try {
    const res = await fetch(BACKEND + '/display/send-bmp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bmp: r.bmp,
        name: val('pmName') || 'epd0',
        user: val('pmUser') || 'test_user',
        device: val('pmDevice') || 'magtag',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { toast(`Sent ${data.chunks} chunks to the device`); return { ok: true, chunks: data.chunks, render: r }; }
    toast(`Send BMP failed (${res.status}): ${data.error || 'unknown error'}`);
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch {
    toast('Backend unreachable — could not chunk the BMP to the device');
    return { ok: false, error: 'network' };
  }
}

/**
 * "Push to display" — the Act II → Act III transition.
 *
 * Render, publish to IO, write the canvas and WAIT for the device to confirm,
 * then send the sleep config. Sleep is only sent after a confirmed write: a
 * device told to sleep before it has drawn would nap holding the old image.
 */
export async function pushToDisplay() {
  const btn = $('sendBmpSleep');
  const epoch = stateEpoch;
  btn.disabled = true;
  // Through syncPushBlock, not a literal: by the time this runs the device is
  // asleep, and the button's job on the way out is to queue, not to push.
  const restore = () => { btn.disabled = false; syncPushBlock(); };
  btn.textContent = 'Rendering…';

  try {
    // Refresh feeds BEFORE the signature snapshot: the sampled values are part of
    // serialize(), so sampling after would bake a signature the very next
    // canvasChanged() call disagrees with, forcing a redundant resend on wake.
    await refreshFeedElements();
    const sig = canvasSignature();
    const doc = serialize();

    const r = await renderOrReport('push to the display');
    if (!r) return;
    if (tooLargeForIO(r.bmp)) return;

    // 1) IO first (browser-direct) so the feed carries a copy of what was sent.
    btn.textContent = 'Publishing to IO…';
    const io = await publishToIO(r.bmp);
    if (!io.ok) return;

    // 2) Write the canvas and wait for display.WriteComplete, retransmitting as
    // needed. Skip past any events already in the backend's log first, so a
    // previous run's goodnight can't drive this one.
    await resetSleepEvents();
    const { acked, sendFailed, retryMins, aborted } =
      await writeCanvasUntilAck(r.bmp, { btn, onStatus: status });

    // "Reset state" ran while we were retransmitting — the device state this flow
    // was building on is gone, so stop without sleeping or touching status.
    if (aborted || epoch !== stateEpoch) return;
    if (sendFailed) return;
    if (!acked) {
      toast(`⚠️ The device never confirmed the write after ${retryMins} min — not sleeping`);
      status(`⚠️ Write never confirmed after ${retryMins} min — the device was not put to sleep`);
      return;
    }

    setDeviceCanvasSig(sig);  // confirmed on the panel — the baseline for every wake
    setPublished({ png: 'data:image/png;base64,' + r.png, doc, at: Date.now() });
    // wakeSource cleared: it is the CircuitPython path's marker for "nothing will
    // report back", and this cycle does report back. Someone who switched paths via
    // the badge would otherwise leave a stale one behind for A8 to read.
    setState({ lastWriteAt: Date.now(), wakeSource: null });

    // 3) Tell the device to sleep.
    btn.textContent = 'Sleeping…';
    const { mode, durSeconds } = currentSleepConfig();
    const pmUser = val('pmUser') || 'test_user';
    const pmDevice = val('pmDevice') || 'magtag';
    const sres = await fetch(BACKEND + '/sleep/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        duration: durSeconds,
        user: pmUser,
        device: pmDevice,
        // Deep sleep: the broker replays this registration on every wake. We just
        // confirmed the write, so the panel already matches the design — register
        // WITHOUT a display so the next wake re-provisions nothing and the e-ink
        // keeps its image. Include it only if the design moved out from under us
        // during the write; a later edit flips it via syncWakeResponse.
        ...(mode === 'S_DEEP' && canvasChanged() ? { display: buildDisplayBody() } : {}),
      }),
    });
    const sdata = await sres.json().catch(() => ({}));
    if (!sres.ok) {
      toast(`Sleep failed (${sres.status}): ${sdata.error || 'unknown error'}`);
      return;
    }

    toast('Pushed. Waiting for the device to say goodnight…');
    const includedDisplay = !!(sdata.wakeCheckin && sdata.wakeCheckin.includedDisplay);
    sleepCycle = {
      user: pmUser, device: pmDevice,
      // The backend's derivation, not ours — it is what actually went on the wire.
      mode: sdata.mode || mode,
      durSeconds,
      registeredDisplay: includedDisplay,
      // What the broker ACTUALLY took just now — duration included, or the first
      // timer edit would look like a no-op and never be sent.
      registeredSig: `${durSeconds}|${includedDisplay}`,
    };
    // The countdown starts optimistically here so Act III has something to show
    // immediately; the real goodnight resets it to the confirmed timer.
    startSleepCountdown(durSeconds);
    emit('pushed');
    waitForSleepEvents(durSeconds, { sendBmpOnWake: true });
  } finally {
    restore();
  }
}

/**
 * "Push to display", CircuitPython path.
 *
 * A CircuitPython board does not speak b2d/d2b, so there is nothing to chunk a
 * BMP to and nothing that will ever answer with a display.WriteComplete. Both
 * halves of the push are therefore plain Adafruit IO feed writes that the board
 * collects on its own schedule: the dashboard on the image feed, the sleep window
 * on its sibling.
 *
 * And because nothing acknowledges either write, this does NOT wait. Holding a
 * spinner for a board that may not be awake for another fifteen minutes would be
 * theatre — the honest UI is to say what was published and move to Act III.
 *
 * A separate function rather than flags through pushToDisplay(): the two share
 * only the render, and merging them would put the whole ProtoMQ cycle behind a
 * run of conditionals that are never true here.
 */
async function pushToDisplayCircuitPython() {
  const btn = $('sendBmpSleep');
  const epoch = stateEpoch;
  btn.disabled = true;
  const restore = () => { btn.disabled = false; syncPushBlock(); };
  btn.textContent = 'Rendering…';

  try {
    // Sampled feed values are part of serialize(), so refresh before snapshotting
    // — same reason as the broker path.
    await refreshFeedElements();
    const doc = serialize();

    const r = await renderOrReport('push to the display');
    if (!r) return;
    if (tooLargeForIO(r.bmp)) return;

    // Skip past whatever the board reported before this push, so a previous cycle's
    // 'sleeping' cannot be credited to the one starting here.
    await resetStatusWatch();
    if (epoch !== stateEpoch) return;

    // 1) The dashboard first. If only one of the two writes lands, better it is
    // this one: a board holding a new image and an old sleep window still shows
    // the right thing.
    btn.textContent = 'Publishing to IO…';
    const io = await publishToIO(r.bmp);
    if (!io.ok) return;

    // 2) The sleep window, as JSON on the sibling feed. Not size-checked — the
    // payload is a few dozen bytes and tooLargeForIO is about the BMP.
    btn.textContent = 'Publishing sleep…';
    const payload = currentSleepPayload();
    const sio = await publishToIO(JSON.stringify(payload), sleepFeedKey());

    // "Reset state" ran while we were publishing — the world this was building on
    // is gone, so stop without touching flow state.
    if (epoch !== stateEpoch) return;

    // This push republishes both feeds, so any take still waiting on a modelled
    // redraw is superseded — letting its promotion fire later would put an older
    // design on the left panel.
    dropQueuedWrite();
    setPublished({ png: 'data:image/png;base64,' + r.png, doc, at: Date.now() });
    // Deliberately NOT setDeviceCanvasSig(): that baseline means "confirmed on the
    // glass", and nothing here confirms anything. Its only readers —
    // syncWakeResponse and waitForSleepEvents — are broker-path and never run here.

    // A failed sleep publish leaves us not knowing what the board will do, so it
    // arms nothing: the board falls back to code.py's own interval.
    const armed = sio.ok ? payload.alarm_type : null;
    setState({ lastWriteAt: Date.now(), wakeSource: armed });

    // 3) The countdown, but only when there is a time to count to. A pin-only
    // alarm has none, and neither does an unpublished window — showing a clock in
    // either case would be inventing a wake time.
    //
    // Nor does a board that narrates its own cycle. What was just published is a REQUEST:
    // it takes effect at the board's next fetch, and the board then says what it actually
    // armed. Starting a countdown here would assert a sleep it has not taken — on top of a
    // take very likely still running — and the wake time would be wrong twice over, once
    // for the take still in progress and again for any cooldown. Its own report is a poll
    // away, and that one is evidence.
    if (boardReportsState()) {
      stopSleepCountdown();
      status('📨 Sleep window published — waiting for the board to say what it armed');
    } else if (armed === 'timer' || armed === 'timer+pin') {
      startSleepCountdown(payload.sleep_time);
    } else {
      stopSleepCountdown();
      setState({ deviceState: 'asleep', wakesAt: null });
      status(armed === 'pin'
        ? '💤 Sleeping until the wake button is pressed'
        : '⚠️ Dashboard published, but the sleep window did not reach the feed');
    }

    toast(sio.ok
      ? `Published the dashboard and the sleep window — the board picks both up on its next wake`
      : `Dashboard published, but the sleep window failed (${sio.error}) — the board will sleep on code.py's own interval`);

    emit('pushed');
    // Watch the board's own feed for the rest of the cycle. Where the broker path
    // waits on events it can be sure of, this only LOOKS: a board running an older
    // code.py reports nothing, and the modelled cycle stays in charge until one does.
    watchForStatus();
    // The broker path leaves the user in the editor because the cycle it started
    // keeps reporting back here. This path has only Act III left to say anything.
    navigate('a8');
  } finally {
    restore();
  }
}

/**
 * "Queue for the next take" — what the push button does while the board sleeps.
 *
 * Deliberately not a push: a deep-sleeping panel has nothing listening, so there
 * is no write to make right now. What "queued" already means differs by path, so
 * this does too.
 *
 *   broker        — the edit is ALREADY queued. saveCanvasNow re-registers the
 *                   wake response, and the wake handler resends the canvas at the
 *                   next checkin. So there is nothing to send: flush the pending
 *                   save so the registration goes out now, and hand back to Act
 *                   III, which is the screen that tracks the wait.
 *   CircuitPython — nothing auto-registers, because nothing on this path speaks
 *                   to a broker. The IO feeds ARE the mailbox, so the publish IS
 *                   the queue — see queueForNextTakeCircuitPython.
 */
async function queueForNextTake() {
  if (getState().firmwarePath === 'circuitpython') return queueForNextTakeCircuitPython();
  saveCanvasNow();
  toast(sleepCycle
    ? 'Queued — the board writes it at its next check-in'
    : 'Saved — but no sleep cycle is running, so nothing is registered for the wake');
  navigate('a8');
}

// ---------- the fallback promotion -------------------------------------------
//
// The ONLY estimate left anywhere, and it is not shown to anyone: for a board whose
// code.py reports nothing, "has it drawn the take I queued" has no evidence behind it, so
// a timer answers it. Everything else that used to be modelled here — the countdown, the
// phase of the cycle, when the next wake was due — is gone; a reporting board says all of
// it, and a silent board now gets prose that admits nothing is known rather than a clock
// with invented numbers.

/**
 * One whole take, budgeted rather than fitted.
 *
 * Deliberately a single generous constant instead of a per-panel calculation, because the
 * calculation was the bug: a take is bounded by the driver, not by the image. A redraw with
 * BUSY unwired is a flat `refresh_time` (40s default) and cannot even begin until
 * `seconds_per_frame` (180s default) has passed since the last one, so a 2.13" tri-color
 * measured 123s against a 14s fit. Being LATE here shows a stale image for a moment; being
 * early claims a redraw that has not happened.
 */
const FALLBACK_TAKE_S = 240;

/** One fallback cycle: the window the board was asked for, then a whole take. */
const fallbackPeriodMs = (st) => ((st.sleepSeconds || refreshInterval()) + FALLBACK_TAKE_S) * 1000;

let queuedWriteTimer = null;

/**
 * Move the queued take onto the panel at the moment the board has plausibly drawn
 * it — the only "write confirmed" this path will ever get.
 *
 * That moment is the END of the first awake window to START after the publish. The
 * board fetches the feed once per wake, so a publish landing mid-wake has most
 * likely already missed that fetch: ceil() waits for the next one rather than
 * claiming a redraw that didn't include it.
 */
function scheduleQueuedWrite() {
  clearTimeout(queuedWriteTimer);
  const q = getQueued();
  const st = getState();
  const periodMs = fallbackPeriodMs(st);
  // A board that reports for itself never needs guessing at: applyStatus promotes on
  // the real 'sleeping', and a timer running alongside it would race that with an
  // estimate and sometimes win.
  if (statusSeen) return;
  if (!q || !st.wakesAt || periodMs <= 0) return;

  const n = Math.max(0, Math.ceil((q.at - st.wakesAt) / periodMs));
  const writtenAt = st.wakesAt + n * periodMs + FALLBACK_TAKE_S * 1000;
  const epoch = stateEpoch;

  queuedWriteTimer = setTimeout(() => {
    const take = getQueued();
    if (!take || epoch !== stateEpoch) return;   // reset, or a push superseded it
    clearQueued();
    // Timestamped with the modelled write, not with the publish that queued it:
    // A8's caption says "written <time>", and the queue was minutes earlier.
    setPublished({ ...take, at: writtenAt });
    setState({ lastWriteAt: writtenAt });
  }, Math.max(0, writtenAt - Date.now()));
}

/** A fresh push supersedes any queued take: it publishes its own image and claims
 *  the panel itself, so a pending promotion would later overwrite it with an older
 *  design. */
function dropQueuedWrite() {
  clearTimeout(queuedWriteTimer);
  queuedWriteTimer = null;
  clearQueued();
}

// ---------- the CircuitPython status watch ----------------------------------
//
// The board reports two moments on its own feed: "awake" when it has connected to
// the broker, and "sleeping" as it arms its alarm. That pair is the acknowledgement
// this path has never had, and it is worth more than a richer one-shot payload,
// because it BRACKETS the fetch: a take published before the 'awake' was on the feed
// when the board pulled, and one published between the two may have missed it.
//
// Structurally this is the broker path's event pump — resetSleepEvents / pumpSleepEvents
// / waitForSleepEvents — doing the same job over Adafruit IO instead of ProtoMQ. One
// difference matters: the broker keeps an event LOG that has to be drained exactly
// once, while a feed's last value is state that stays put. So a late poll here costs
// latency and nothing else, which is what makes a throttled background tab safe.
//
// Payload contract: docs/marquee-status.md.

const STATUS_POLL_MS = 5000;
/** How far past the modelled awake window to keep looking before calling it offline.
 *  A slow WiFi associate or one retry has to fit inside this. */
const STATUS_GRACE_MS = 60000;
/** Data points per poll. More than one so a poll that lands after both transitions
 *  can still see the 'awake' that the 'sleeping' needs to be judged against. */
const STATUS_BATCH = 4;

let statusCursor = null;      // id of the newest datum already applied
let statusSeen = false;       // has this board EVER reported? the model/evidence switch
let statusPollTimer = null;
let lastAwakeAt = null;       // created_at of the most recent 'awake', for the bracket
let lastReportAt = null;      // created_at of the most recent report of any kind, for the log
let statusPolls = 0;          // polls made this cycle, so the log can show it is alive

const logClock = (t) => fmtLocalSeconds(new Date(t));

const since = (t) => `${Math.round((Date.now() - t) / 1000)}s ago`;

/** Durations in the log read in whatever unit keeps them short — an hourly interval in
 *  seconds is a number nobody can size at a glance. */
function fmtWait(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s`
    : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

/**
 * Narrate the watch.
 *
 * Two destinations, on purpose. The debug line under the tools panel is the LIVE
 * state — one line, always current, the same place the broker path narrates its own
 * watch. console.debug keeps the TRAIL, because "is the board publishing" is a
 * question about history and one line cannot hold one; devtools hides debug-level
 * output unless you ask for Verbose, so this costs nothing for anyone who is not
 * currently staring at a board.
 */
function statusLog(line) {
  debugLine(`${statusFeedKey() || 'status feed'} · ${line}`);
  console.debug('[marquee-status]', line);
}

/** Has the board reported for itself at least once this session? While false, A8
 *  falls back to the modelled cycle; once true, a silent board means offline. */
export const boardReportsState = () => statusSeen;

/**
 * Read the status value as an object, whatever shape it arrived in.
 *
 * A bare "awake" is accepted as {state: "awake"} so the device half can ship in
 * stages, and unknown keys are simply carried — the contract is additive, so a
 * reader that rejects what it does not recognise would break on the next field
 * anyone adds.
 */
function parseStatus(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? obj : { state: String(obj) };
  } catch {
    return { state: text };
  }
}

/**
 * Start a cycle from whatever is already on the feed, without acting on it — a
 * status left behind by a previous bench run would otherwise drive this one. Same
 * job, same reason, as resetSleepEvents() on the broker path.
 */
async function resetStatusWatch() {
  clearTimeout(statusPollTimer);
  statusPollTimer = null;
  lastAwakeAt = null;
  lastReportAt = null;
  statusPolls = 0;
  // A BATCH, not one datum. The cursor still moves to the newest, but the newest alone
  // cannot answer the only question that matters here — is the board up right now? — and
  // reading one meant the answer was thrown away with the rest of the history. A push
  // landing while the board is mid-take finds its `awake` sitting at the head of the feed,
  // seeds the cursor to exactly that datum, and so starts the cycle having discarded the
  // wake half of the bracket: no promotion check, and a watch that then has nothing to
  // wait on but an estimated deadline.
  const data = await readFeedData(statusFeedKey(), { limit: STATUS_BATCH });
  statusCursor = data && data.length ? data[0].id : null;
  if (!data) statusLog('unreadable — the feed may not exist yet, or the IO key is unset');
  else if (!data.length) statusLog('no history yet — nothing has ever been published here');
  else statusLog(`starting from datum ${data[0].id} (${logClock(data[0].createdAt)}), ignoring anything older`);
  if (data && data.length) adoptReportedState(data);
}

/**
 * Adopt the board's CURRENT state from the history the cursor just skipped past.
 *
 * Reading the head datum is not replaying history — a feed's last value is state, which is
 * the property this whole watch is built on. The newest thing the board said is what it is
 * doing now, and throwing that away with the rest of the batch is what left a push landing
 * mid-take with no wake to bracket against.
 *
 * What it deliberately does NOT do is run applyStatus(). That function has consequences —
 * it promotes a queued take onto the panel, it emits `pushed`/`slept` — and none of those
 * belong to a datum that was published before this cycle began. This only records.
 *
 * Either state counts as proof the board narrates itself, which is what stops the push
 * below from asserting a sleep on top of it.
 */
function adoptReportedState(data) {
  const seen = data
    .map((d) => ({ at: Number.isFinite(d.createdAt) ? d.createdAt : Date.now(), s: parseStatus(d.value) }))
    .filter((x) => x.s && (x.s.state === 'awake' || x.s.state === 'sleeping'));
  if (!seen.length) return;
  statusSeen = true;

  // BOTH ENDS of the last bracket, not just the head. The head alone says what the board is
  // doing; the pair says what it has already done, and Act III needs that to tell the take
  // on the glass from the take still waiting on the feed. Adopting only the head left
  // `lastWokeAt` null for a board found asleep — so a board that had demonstrably woken,
  // drawn and gone back to sleep was reported as having confirmed nothing.
  const newestAwake = seen.find((x) => x.s.state === 'awake');
  const newestSleep = seen.find((x) => x.s.state === 'sleeping');
  if (newestAwake) { lastAwakeAt = newestAwake.at; setState({ lastWokeAt: newestAwake.at }); }
  if (newestSleep) setState({ lastSleptAt: newestSleep.at });

  const head = seen[0];
  if (head.s.state === 'awake') {
    setState({ deviceState: 'online-awake', wakesAt: null });
    statusLog(`board is mid-take — adopting the awake at ${logClock(head.at)} as the open bracket`);
    return;
  }

  // Asleep, and it said for how long.
  const secs = Number.isFinite(head.s.sleep_time) ? head.s.sleep_time : refreshInterval();
  setState({ wakeSource: head.s.alarm_type || 'timer' });
  if (head.s.alarm_type === 'pin') setState({ deviceState: 'asleep', wakesAt: null, sleepSeconds: null });
  else startSleepCountdown(secs, { since: head.at });
  statusLog(`board is asleep — adopting the sleeping at ${logClock(head.at)} (${secs}s on `
    + `${head.s.alarm_type || 'timer'})`
    + `${newestAwake ? `, woke ${logClock(newestAwake.at)}` : ', no wake in this batch'}`);
}

let watchStarting = false;

/**
 * Start the status watch if it is not already running.
 *
 * The watch used to begin only at the end of a push, which meant a reloaded tab — or one
 * that had simply not pushed yet — never read the feed at all, on any screen. The board is
 * reporting the whole time regardless of what this editor is doing, so the watch belongs to
 * the session and not to the push: it starts at boot, survives navigation, and the chrome
 * pill is right in Act I for the same reason it is right in Act III.
 *
 * Seeding through resetStatusWatch() is what makes the pill correct IMMEDIATELY rather than
 * one poll later — adoptReportedState() reads the board's current state out of the same
 * batch that sets the cursor.
 *
 * Cheap to call repeatedly, which is the point: every caller can just say "there should be
 * a watch" without knowing whether there already is one.
 */
export async function ensureStatusWatch() {
  if (getState().firmwarePath !== 'circuitpython' || !statusFeedKey()) return;
  // statusPollTimer alone is not enough of a guard: tick() awaits a fetch before setting it,
  // so two callers arriving in that gap would both start a loop and double the poll rate.
  if (statusPollTimer || watchStarting) return;
  watchStarting = true;
  try {
    await resetStatusWatch();
    watchForStatus();
  } finally {
    watchStarting = false;
  }
}

/** Anything newer than the cursor, oldest-first so transitions apply in order. */
async function pumpStatus() {
  const data = await readFeedData(statusFeedKey(), { limit: STATUS_BATCH });
  if (!data) return null;                       // unreadable: unknown, not "nothing"
  if (statusCursor === null) {
    // Unseeded — the feed was unreadable when the cycle started. Adopt the present
    // rather than replaying history, or a previous run's 'sleeping' would restart this
    // cycle's clock. Same rule as resetSleepEvents() skipping the broker's log.
    statusCursor = data.length ? data[0].id : null;
    return [];
  }
  const fresh = [];
  for (const d of data) {                       // IO returns newest-first
    if (d.id === statusCursor) break;
    fresh.unshift(d);
  }
  if (fresh.length) statusCursor = fresh[fresh.length - 1].id;
  return fresh;
}

/**
 * One reported transition. This is the CircuitPython counterpart of the broker's
 * checkin.complete / goodnight handling, and it drives the same flow state, so every
 * screen that already reacts to those events reacts to these for free.
 */
function applyStatus(datum) {
  const s = parseStatus(datum.value);
  if (!s || (s.state !== 'awake' && s.state !== 'sleeping')) {
    // Logged rather than swallowed: a board publishing something this reader does not
    // understand is the single most likely thing to go wrong while the device half is
    // being written, and silence would make it look like nothing was published at all.
    statusLog(`ignored — unrecognised value ${JSON.stringify(String(datum.value).slice(0, 80))}`);
    return;
  }
  // Only a RECOGNISED state counts as a report — an unparseable datum is not
  // evidence, and treating it as such would retire the fallback for nothing.
  const first = !statusSeen;
  statusSeen = true;
  const at = Number.isFinite(datum.createdAt) ? datum.createdAt : Date.now();
  lastReportAt = at;
  if (first) status('📡 The board is reporting its own state — estimates retired');

  if (s.state === 'awake') {
    statusLog(`← awake${s.wake_reason ? ` (${s.wake_reason})` : ''} at ${logClock(at)}`
      + `${lastAwakeAt ? `, ${Math.round((at - lastAwakeAt) / 1000)}s after the last wake` : ''}`);
    stopSleepCountdown();
    lastAwakeAt = at;
    // The board's OWN timestamp, so Act III's banner and the redraw clock both run from
    // when it actually came up rather than from when this poll happened to see it.
    setState({ deviceState: 'online-awake', wakesAt: null, lastWokeAt: at });
    status(s.wake_reason === 'pin' ? '⏰ Board woke — button press'
      : s.wake_reason === 'reset' ? '⏰ Board woke — reset or first boot'
      : '⏰ Board woke — timer');
    emit('woke');
    return;
  }

  // 'sleeping': the board drew (or gave up) and is arming its alarm. Promote first,
  // so the panel and the clock update in one pass.
  statusLog(`← sleeping at ${logClock(at)}`
    + `${Number.isFinite(s.sleep_time) ? ` for ${s.sleep_time}s` : ' (no sleep_time reported)'}`
    + `${s.alarm_type ? ` on ${s.alarm_type}` : ''}`
    + `${lastAwakeAt ? `, awake ${Math.round((at - lastAwakeAt) / 1000)}s` : ''}`);

  const take = getQueued();
  if (take && lastAwakeAt != null && take.at < lastAwakeAt) {
    // The take was on the feed before the board connected, so that fetch saw it.
    dropQueuedWrite();
    setPublished({ ...take, at });
    setState({ lastWriteAt: at });
    emit('pushed');
    statusLog(`queued take promoted — it was published ${Math.round((lastAwakeAt - take.at) / 1000)}s `
      + 'before the board woke, so that fetch had it');
  } else if (take) {
    // Held rather than promoted. Worth saying out loud: from the outside this looks
    // like the queue being ignored, when it is the bracket refusing to guess.
    statusLog(lastAwakeAt == null
      ? 'queued take held — never saw this cycle\'s wake, so cannot tell if it was fetched'
      : `queued take held — published ${Math.round((take.at - lastAwakeAt) / 1000)}s AFTER the board `
        + 'woke, so that fetch may have missed it; it goes out next cycle');
  }

  const secs = Number.isFinite(s.sleep_time) ? s.sleep_time : refreshInterval();
  // wakeSource is what A8 reads to decide whether there is a wake TIME to count to.
  // lastWokeAt is deliberately LEFT alone: paired with lastSleptAt it is how long the
  // board was up, which is the most useful number on the banner.
  setState({ wakeSource: s.alarm_type || 'timer', lastSleptAt: at });
  if (s.alarm_type === 'pin') {
    stopSleepCountdown();
    setState({ deviceState: 'asleep', wakesAt: null, sleepSeconds: null });
  } else {
    startSleepCountdown(secs, { since: at });
  }
  emit('slept');
}

/**
 * How long the board gets to say something before it is called offline.
 *
 * ONE number, generously over the worst take this hardware can produce: a 180s frame
 * cooldown plus a 40s BUSY-less redraw plus the round trip. Not fitted per panel, because
 * fitting it per panel is what produced a deadline of 86s for a 123s take.
 */
const STATUS_TAKE_CEILING_MS = 300000;

/** The slow cadence, for when the board is not expected to say anything soon. */
const STATUS_IDLE_MS = 60000;

let watchStartedAt = null;

/**
 * When to look, and when to stop believing the board is coming back.
 *
 * Every anchor here is a FIXED point — a reported time, or when the watch began.
 * Anchoring on "now" would push the deadline forward on every tick, so a board that
 * died would be waited on forever at the fast cadence.
 */
function statusWindow(st) {
  // A pin-only alarm has no wake time and may not fire for days. There is nothing to
  // time out, so this watches slowly and forever rather than calling a board offline
  // for not having been pressed.
  if (st.wakeSource === 'pin') return { deadline: Infinity, idle: true };

  // Everything else gets ONE rule and one number. The old one had a deadline per case,
  // each computed from a fitted refresh time, and it wrote off a demonstrably alive board
  // 86s into a take that needed 123s — a 40s flat redraw behind an 83s frame cooldown, on a
  // panel the model thought was a 14s job. There is no version of that arithmetic worth
  // keeping, so this is a watchdog rather than a model: from whenever the board is next due
  // to speak, it gets one generous ceiling to do it in.
  //
  // `watchStartedAt` as a floor is what makes a stale report safe. A tab backgrounded for
  // an hour catches up on a 'sleeping' whose wake passed forty cycles ago; judging from
  // that would call a healthy board dead the instant we started listening again. Whenever
  // the watch (re)starts, the board gets a full ceiling from then.
  const due = takeInFlight(st) ? st.lastWokeAt : (st.wakesAt || lastReportAt || Date.now());
  const from = Math.max(due, watchStartedAt ?? 0);
  return { deadline: from + STATUS_TAKE_CEILING_MS + STATUS_GRACE_MS };
}

/**
 * Watch the status feed.
 *
 * Polling is confined to the window the board could plausibly be up in: it is
 * unreachable for the rest, and IO's rate limit is a budget shared with every element
 * binding on the canvas. Outside the window this reschedules rather than polls, so the
 * watch survives an arbitrarily long sleep for the cost of one timer.
 */
function watchForStatus() {
  clearTimeout(statusPollTimer);
  watchStartedAt = Date.now();
  const epoch = stateEpoch;
  statusLog(statusFeedKey()
    ? `watching for the board to report (polling every ${STATUS_POLL_MS / 1000}s around each wake)`
    : 'no image feed set, so there is no status feed to watch');

  const tick = async () => {
    if (epoch !== stateEpoch) return;
    const { deadline, idle } = statusWindow(getState());
    const wait = () => { statusPollTimer = setTimeout(tick, idle ? STATUS_IDLE_MS : STATUS_POLL_MS); };

    // No quiet window. This used to skip polling for the length of a sleep on the grounds
    // that nothing can arrive before the wake — true of a board keeping perfect time, and
    // false of this one: the wake it reports is the alarm it armed, not the moment it comes
    // up, and a cooldown or a manual reset moves that by minutes. A watch that is asleep
    // when the board speaks is indistinguishable from one that is broken, which is exactly
    // how this looked. It costs 12 reads a minute against IO's 30 — see STATUS_POLL_MS.
    const fresh = await pumpStatus();
    if (epoch !== stateEpoch) return;
    statusPolls++;
    if (fresh === null) {
      statusLog(`poll ${statusPolls} — feed unreadable, retrying`);
      wait();
      return;
    }
    if (fresh.length) {
      // Applying these moves wakesAt, so the next tick re-reads the window.
      if (fresh.length > 1) statusLog(`${fresh.length} reports at once — catching up in order`);
      fresh.forEach(applyStatus);
      wait();
      return;
    }

    statusLog(`poll ${statusPolls} — nothing new`
      + `${lastReportAt ? `, last report ${since(lastReportAt)}` : ' yet'}`);

    if (Date.now() > deadline) {
      // Only a board that HAS reported can be judged silent. One that never did is
      // running an older code.py, and the modelled cycle is still its best answer.
      if (statusSeen && getState().deviceState !== 'offline') {
        // deviceState alone retires the redraw clock, which reads lastWokeAt only while
        // the board is known to be up — so the reported times survive here on purpose,
        // and the banner can still show when it was last heard from.
        setState({ deviceState: 'offline', wakesAt: null });
        status('⚠️ No report from the board this cycle — it may not have come back');
        statusLog(`gave up on this cycle — ${fmtWait(Date.now() - deadline)} past the deadline`
          + `${lastReportAt ? `, last report ${since(lastReportAt)}` : ''}; still watching slowly`);
      } else if (!statusSeen) {
        statusLog('no report ever — this board is on the estimated cycle, which is expected '
          + 'until its code.py publishes');
      }
      // Keep looking, slowly: a board that is merely very late still counts, and the
      // next report puts the screen straight.
      statusPollTimer = setTimeout(tick, STATUS_IDLE_MS);
      return;
    }
    wait();
  };

  tick();
}

/** A catch-up read, for the moments when the poll cadence cannot be trusted: a
 *  backgrounded tab gets its timers throttled, and the feed's value is state rather
 *  than a stream, so one read closes the whole gap. */
export async function catchUpStatus() {
  if (getState().firmwarePath !== 'circuitpython' || statusCursor === null) return;
  const epoch = stateEpoch;
  const fresh = await pumpStatus();
  if (epoch !== stateEpoch || !fresh || !fresh.length) return;
  statusLog(`catching up — ${fresh.length} report${fresh.length === 1 ? '' : 's'} arrived while `
    + 'this tab was not being polled');
  fresh.forEach(applyStatus);
}

/** Stop watching and forget what was seen — a reset drops the world this was
 *  reporting on. `statusSeen` deliberately survives: whether the BOARD reports is a
 *  fact about its firmware, not about this cycle. */
function stopStatusWatch() {
  clearTimeout(statusPollTimer);
  statusPollTimer = null;
  statusCursor = null;
  lastAwakeAt = null;
  watchStartedAt = null;
}

/**
 * The CircuitPython half of "Queue for the next take".
 *
 * It writes the same two feeds as the push — they are the only mailbox a sleeping
 * board has — but it must not make the push's CLAIMS, because the board is mid-
 * sleep on a window it collected earlier and nothing here reaches it. So,
 * deliberately absent:
 *
 *   setPublished()        — that snapshot means "this is on the glass". The board
 *                           has not woken, let alone drawn, so recording it now
 *                           would make A8's two panels identical and hide the very
 *                           change being queued. It is held as the QUEUED take and
 *                           promoted when the modelled redraw lands, which is when
 *                           the panel actually changes — scheduleQueuedWrite.
 *   startSleepCountdown() — writing to a feed does not move the board's wake time.
 *                           The clapperboard belongs to the sleep already running.
 *   lastWriteAt/wakeSource — nothing was written, and the alarm the board is
 *                           running is the one it armed before it slept; the new
 *                           window only takes effect after the next wake.
 */
async function queueForNextTakeCircuitPython() {
  const btn = $('sendBmpSleep');
  const epoch = stateEpoch;
  btn.disabled = true;
  const restore = () => { btn.disabled = false; syncPushBlock(); };
  btn.textContent = 'Rendering…';

  try {
    // Bound feed values are part of the render, so re-read them first — same
    // reason as both push paths.
    await refreshFeedElements();
    const doc = serialize();

    const r = await renderOrReport('queue the dashboard');
    if (!r) return;
    if (tooLargeForIO(r.bmp)) return;

    btn.textContent = 'Publishing to IO…';
    const io = await publishToIO(r.bmp);
    if (!io.ok) return;

    // The sleep window goes with it: an interval changed while editing is part of
    // the same take, and the board reads both feeds on the same wake.
    btn.textContent = 'Publishing sleep…';
    const sio = await publishToIO(JSON.stringify(currentSleepPayload()), sleepFeedKey());

    // "Reset state" ran while we were publishing — say nothing about a world that
    // is already gone.
    if (epoch !== stateEpoch) return;

    // Held, not published: this take is on the feed, and the panel changes when the
    // board next wakes and redraws.
    setQueued({ png: 'data:image/png;base64,' + r.png, doc, at: Date.now() });
    scheduleQueuedWrite();

    toast(sio.ok
      ? 'Queued — the board collects it on its next wake'
      : `Dashboard queued, but the sleep window failed (${sio.error}) — the board keeps its current interval`);
    navigate('a8');
  } finally {
    restore();
  }
}

/** Send the sleep config on its own, without a BMP. A bench diagnostic: it
 *  isolates whether the device receives the sleep message at all. */
async function sleepNow() {
  const btn = $('sleepNow');
  const { mode, durSeconds } = currentSleepConfig();
  btn.disabled = true;
  btn.textContent = 'Sleeping…';
  try {
    await resetSleepEvents();
    const res = await fetch(BACKEND + '/sleep/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        duration: durSeconds,
        user: val('pmUser') || 'test_user',
        device: val('pmDevice') || 'magtag',
        // UNCONDITIONAL, unlike the push: this button never writes a BMP, so we
        // have no idea what the panel is showing and can't claim it matches the
        // design. Keeping the re-provision also preserves the button's purpose.
        ...(mode === 'S_DEEP' ? { display: buildDisplayBody() } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(`Sleep failed (${res.status}): ${data.error || 'unknown error'}`); return; }
    toast('Sleep config sent; waiting for the device to say goodnight…');
    // The device will wake, re-provision and repaint its splash without ever
    // receiving a canvas — so whatever baseline we had is now wrong.
    setDeviceCanvasSig(null);
    clearPublished();
    // Observation-only cycle: this supersedes any cycle the push was driving.
    sleepCycle = null;
    waitForSleepEvents(durSeconds);
  } catch {
    toast('Backend unreachable — could not send sleep');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sleep now (no BMP)';
  }
}

// ---------- reset -----------------------------------------------------------

/**
 * One button back to a known-empty world. Three kinds of state accumulate:
 *
 *   1. the canvas — the elements plus the persisted canvas.json behind them
 *   2. this page's cycle state — the cycle being driven, the "what is the panel
 *      showing" baseline, the queued device events, and the four timers
 *   3. state living OUTSIDE the browser — the backend's device-event watch and
 *      the broker registrations it made: the mailboxes it holds open, the wake
 *      response replayed on every checkin, and any registered autoresponders
 *
 * (3) is why clicking around in the editor isn't enough: a broker still holding
 * a wake response will keep re-provisioning and re-sleeping the device forever,
 * long after the page that started it moved on.
 *
 * Deliberately KEPT: the display descriptor, sleep settings and IO credentials.
 * Those are the bench setup, not device state.
 */
async function resetState() {
  const btn = $('btnResetState');
  if (!confirm('Reset state?\n\nThis clears the canvas, stops the sleep/wake cycle, '
    + "and clears the broker's wake response and autoresponders for this device.\n\n"
    + 'Display, sleep and Adafruit IO settings are kept.')) return;

  const user = val('pmUser') || 'test_user';
  const device = val('pmDevice') || 'magtag';

  // 1) Invalidate every in-flight loop FIRST, before anything else changes under
  // them — an awaiting retransmit must not get a chance to write to the device.
  stateEpoch++;

  btn.disabled = true;
  btn.textContent = 'Resetting…';
  try {
    // 2) Settle anything being awaited, THEN kill the timers. Order matters: a
    // wait settles itself from inside its own interval, so clearing the interval
    // first would strand the promise and its caller with it.
    abortPendingWaits();

    if (goodnightPollTimer) { clearInterval(goodnightPollTimer); goodnightPollTimer = null; }
    if (writePollTimer) { clearInterval(writePollTimer); writePollTimer = null; }
    stopSleepCountdown();
    clearTimeout(wakeSyncTimer); wakeSyncTimer = null;
    cancelCanvasSave();

    // 3) Cycle state. A null baseline means "we no longer know what the panel is
    // showing", so the next send writes unconditionally.
    sleepCycle = null;
    setDeviceCanvasSig(null);
    sleepEventQueue = [];
    sleepEventCursor = 0;
    sleepWatchId = null;
    clearPublished();
    dropQueuedWrite();
    stopStatusWatch();
    setState({
      deviceState: 'online-awake', wakesAt: null, lastWriteAt: null,
      wakeSource: null, sleepSeconds: null, lastWokeAt: null, lastSleptAt: null,
    });

    // 4) The canvas. Elements only — the display block stays, so panel geometry
    // and dither settings survive.
    hideDitherPreview();
    layer.find('.element').forEach((n) => n.destroy());
    select(null);
    resetCounter();               // element ids start over from el1
    layer.draw();

    // 5) The world outside the browser.
    let r = null;
    try {
      const res = await fetch(BACKEND + '/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, device }),
      });
      r = await res.json().catch(() => null);
      if (!res.ok) r = null;
    } catch { /* backend down — reported below */ }

    // 6) Re-baseline the local view of canvas.json. The backend just rewrote the
    // file underneath us, so the de-dupe baseline has to be dropped or the empty
    // canvas would never be persisted.
    invalidateCanvasBaseline();
    saveCanvasNow();

    // 7) Resync the event cursor onto the backend's post-reset log.
    await resetSleepEvents();

    status('☕ Device awake');
    debugLine('');
    emit('reset');

    if (!r) {
      toast('Canvas and editor state reset — but the backend was unreachable, so broker state may remain');
    } else {
      // Name what did NOT get cleared: a still-registered wake response is the
      // one failure that leaves the device cycling on its own, so it must not
      // be quiet.
      const failed = [];
      if (!r.wakeCheckin || !r.wakeCheckin.cleared) failed.push('wake response');
      if (!r.autoresponders || !r.autoresponders.cleared) failed.push('autoresponders');
      if (!r.canvas || !r.canvas.cleared) failed.push('canvas.json');
      toast(failed.length
        ? `State reset — could not clear: ${failed.join(', ')} (is the broker running?)`
        : 'State reset — canvas cleared, watch stopped, broker registrations cleared');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reset state';
  }
}

// ---------- boot ------------------------------------------------------------

export function initDevice() {
  // The fork is read at click time, not at boot: the path badge in the chrome bar
  // is a route back to A3, so it can change under a mounted editor.
  $('sendBmpSleep')?.addEventListener('click', () => {
    // One button, two jobs: a sleeping board can only be queued for.
    if (getState().deviceState === 'asleep') return queueForNextTake();
    return getState().firmwarePath === 'circuitpython'
      ? pushToDisplayCircuitPython()
      : pushToDisplay();
  });
  $('sleepNow')?.addEventListener('click', sleepNow);
  $('btnResetState')?.addEventListener('click', resetState);

  // A hidden tab has its timers throttled to a crawl, so the status poll can sleep
  // through a whole wake. Reading the feed once on the way back closes the gap —
  // the value is still sitting there, which is the point of watching state rather
  // than draining an event log.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    ensureStatusWatch();
    catchUpStatus();
  });

  // The board reports whether or not this editor has pushed anything, so the watch starts
  // with the session. Answering the fork is what makes a status feed exist to watch, hence
  // the subscription as well as the call — both are no-ops once a watch is running.
  ensureStatusWatch();
  subscribe(() => ensureStatusWatch());

  $('sendBmp')?.addEventListener('click', async () => {
    const btn = $('sendBmp');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const r = await sendBmpToDevice();
      // Surface the device's write confirmation (the backend armed the watch
      // during send-bmp). No sleep is sent here — this is just an ack.
      if (r && r.ok) {
        btn.textContent = 'Waiting for write ack…';
        const acked = await waitForWriteComplete({ timeoutMs: 20000 });
        toast(acked ? 'Device confirmed the write ✓' : 'No write ack from the device');
        if (acked && r.render) {
          setPublished({ png: 'data:image/png;base64,' + r.render.png, doc: serialize(), at: Date.now() });
          setState({ lastWriteAt: Date.now() });
          emit('pushed');
        }
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send BMP to device';
    }
  });

  status('☕ Device awake');
}
