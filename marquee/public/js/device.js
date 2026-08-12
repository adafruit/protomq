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

import { BACKEND } from './api.js';
import { layer, hideDitherPreview } from './stage.js';
import { select } from './selection.js';
import { resetCounter } from './elements.js';
import { buildDisplayBody, refreshInterval } from './config.js';
import {
  serialize, canvasSignature, canvasChanged, setDeviceCanvasSig,
  invalidateCanvasBaseline, saveCanvasNow, cancelCanvasSave,
} from './doc.js';
import { renderOrReport, tooLargeForIO, publishToIO } from './render.js';
import { refreshFeedElements } from './feeds.js';
import { setState, setPublished, clearPublished } from './state.js';
import { $, val, toast, fmtBytes } from './util.js';

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
  return {
    mode: $('sleepMode')?.value || 'S_DEEP',
    durSeconds: refreshInterval(),
  };
}

/**
 * The broker replays ONE stored wake response on every checkin, and it is
 * registered before the device wakes — so an edit made mid-sleep has to
 * overwrite that registration now, or the device wakes with no display and the
 * write has nothing to apply to.
 */
export async function syncWakeResponse({ rearmMs, force } = {}) {
  if (!sleepCycle) return false;
  const { mode, durSeconds } = currentSleepConfig();
  // Only deep sleep has a display to maintain — a light-sleeping device never
  // drops its display, so there is nothing to re-add and the backend just
  // re-arms the watch for us.
  const want = mode === 'S_DEEP' && canvasChanged();
  // Dedupe on the WHOLE registration, not just the display flag. Changing the
  // duration leaves `want` untouched, so keying on it alone would return early
  // and silently swallow exactly the edit the user was trying to make.
  const sig = `${mode}|${durSeconds}|${want}`;
  if (!force && !rearmMs && sig === sleepCycle.registeredSig) return true;
  try {
    const res = await fetch(BACKEND + '/sleep/wake-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
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
    if (mode !== 'S_DEEP' || (data.wakeCheckin && data.wakeCheckin.registered)) {
      sleepCycle.registeredSig = sig;
      sleepCycle.registeredDisplay = want;
      // What the broker now holds — i.e. what the device gets at its NEXT
      // checkin. The sleep it is running right now was fixed when it last
      // checked in.
      sleepCycle.mode = mode;
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
  // Gated on the CYCLE, not on the mode: switching the form from Deep to Light
  // is itself a change the broker has to hear about (its stored deep-sleep
  // response would otherwise keep re-provisioning and re-sleeping the device),
  // and that edit reads as non-deep right here. syncWakeResponse decides what
  // to send.
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
 * Client-side only: this reflects the timer duration we sent, not a device
 * acknowledgement. `wakesAt` in flow state is what A8's clapperboard ticks off,
 * so the countdown survives navigating away from the screen and back.
 */
function startSleepCountdown(seconds) {
  if (sleepCountdownTimer) { clearInterval(sleepCountdownTimer); sleepCountdownTimer = null; }
  const total = Math.max(0, Math.floor(seconds) || 0);
  setState({ deviceState: 'asleep', wakesAt: Date.now() + total * 1000 });

  const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
  let left = total;
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
        startSleepCountdown(durSeconds); // device confirmed asleep — run the timer
      }
      // a stray 'write' (or a repeated goodnight) is not this stage's to act on
    }

    if (woke) {
      clearInterval(goodnightPollTimer); goodnightPollTimer = null;
      stopSleepCountdown();
      debugLine(`checkin.complete from client "${woke.client || '?'}"`);
      setState({ deviceState: 'online-awake', wakesAt: null });
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
  const restore = () => { btn.disabled = false; btn.textContent = 'Push to display'; };
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
    setState({ lastWriteAt: Date.now() });

    // 3) Tell the device to sleep.
    btn.textContent = 'Sleeping…';
    const { mode, durSeconds } = currentSleepConfig();
    const pmUser = val('pmUser') || 'test_user';
    const pmDevice = val('pmDevice') || 'magtag';
    const sres = await fetch(BACKEND + '/sleep/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
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
      user: pmUser, device: pmDevice, mode, durSeconds,
      registeredDisplay: includedDisplay,
      // What the broker ACTUALLY took just now — mode and duration included, or
      // the first timer edit would look like a no-op and never be sent.
      registeredSig: `${mode}|${durSeconds}|${includedDisplay}`,
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
        mode,
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

/**
 * Wake-early. Presented as an escape hatch, never the recommendation: a deep
 * sleeping board is genuinely unreachable, so all this can do is shorten the
 * NEXT registration and tell the truth about that.
 */
async function wakeEarly() {
  if (!sleepCycle) { toast('No sleep cycle is running — nothing to wake'); return; }
  if (!confirm('Wake the display early?\n\nA deep-sleeping board cannot be interrupted over the air. '
    + 'Marquee will register the shortest possible sleep so the board comes back on its next wake and '
    + 'stays up — which costs a full wake cycle of battery.\n\nContinue?')) return;
  const prev = refreshInterval();
  const el = $('sleepDuration');
  if (el) { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); }
  const ok = await syncWakeResponse({ force: true });
  if (el) { el.value = String(prev); el.dispatchEvent(new Event('input', { bubbles: true })); }
  toast(ok
    ? 'Registered — the board will stay awake after its next check-in, then resume the normal interval'
    : 'Could not reach the broker to register an early wake');
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
    setState({ deviceState: 'online-awake', wakesAt: null, lastWriteAt: null });

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
  $('sendBmpSleep')?.addEventListener('click', pushToDisplay);
  $('sleepNow')?.addEventListener('click', sleepNow);
  $('wakeEarly')?.addEventListener('click', wakeEarly);
  $('btnResetState')?.addEventListener('click', resetState);

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
