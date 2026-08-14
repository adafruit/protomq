/**
 * A8 — Act III: sent, asleep, changes queued.
 *
 * The screen the constraint is really about. The rule it implements: the editor
 * stays fully usable while the device sleeps. Edits do not fail and do not
 * block — they queue and are written automatically on the next wake. Nothing is
 * locked, nothing throws a modal, and no control is disabled here because the
 * device is unreachable.
 *
 * The before/after pair is the whole idea: rendering what is ON THE GLASS beside
 * what the editor now holds makes "your edits are real but not yet shown"
 * visible without a lock or an error.
 */

import { logicalDims, display, MODE_LABELS, panelRefreshSeconds } from '../palette.js';
import { captureClean } from '../stage.js';
import { selected, select } from '../selection.js';
import { serialize, onDocChange } from '../doc.js';
import { getState, getPublished, countQueuedChanges, subscribe } from '../state.js';
import { onDeviceEvent, awakeSeconds, boardReportsState, catchUpStatus } from '../device.js';
import { refreshInterval, refreshIntervalLabel } from '../config.js';
import { navigate, currentScreen, syncNav } from '../router.js';
import { $, fmtClock, fmtLocalTime, fmtLocalSeconds } from '../util.js';

/** Panel previews are drawn about 1.7× so a 296×128 lands near the design's
 *  504×222, but clamped so an 800×480 still fits two-up on one screen. */
function previewScale() {
  const { w, h } = logicalDims();
  return Math.max(0.5, Math.min(2, 520 / w, 250 / h));
}

/**
 * Both panels are pinned to the same outer box whether or not they have an
 * image, so the pair lines up. The minimum has to include the glass padding and
 * hairline, or the empty one comes out narrower than the one holding a bitmap —
 * measured rather than hardcoded so restyling the glass can't silently
 * desynchronise them.
 */
function sizeGlass(el, img) {
  const { w, h } = logicalDims();
  const s = previewScale();
  const cs = getComputedStyle(el);
  const chromeX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
    + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
  const chromeY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  if (img) {
    img.style.width = Math.round(w * s) + 'px';
    img.style.height = Math.round(h * s) + 'px';
  }
  el.style.minWidth = Math.round(w * s + chromeX) + 'px';
  el.style.minHeight = Math.round(h * s + chromeY) + 'px';
}

/** The left panel: exactly the dithered PNG that was written to the glass. */
function renderWritten() {
  const pub = getPublished();
  const glass = $('takeWritten');
  const caption = $('takeWrittenCaption');

  if (!pub.png) {
    glass.innerHTML = '<div class="placeholder">Nothing has been written to this panel yet.</div>';
    caption.textContent = 'not yet written';
    // Still sized to the panel. An empty box that collapses to its text would
    // leave the two takes different heights, and the whole point of the pair is
    // that they are directly comparable.
    sizeGlass(glass, null);
    return;
  }
  glass.innerHTML = '';
  const img = new Image();
  img.src = pub.png;
  img.alt = 'The dashboard currently on the panel';
  glass.appendChild(img);
  sizeGlass(glass, img);
  caption.textContent = `written ${fmtLocalTime(new Date(pub.at))}`;
}

/**
 * The right panel: the working copy, captured live off the stage. Undithered on
 * purpose — this is the design as authored, and the point of the comparison is
 * what has CHANGED, not what the dither will do to it. "See it dithered" in the
 * editor is where that question belongs.
 */
function renderNext() {
  const glass = $('takeNext');
  const caption = $('takeNextCaption');
  const prev = selected;
  const canvas = captureClean({
    onDeselect: () => select(null),
    onReselect: () => { if (prev) select(prev); },
  });

  // Keep the blueprint corner marks; replace only the image.
  glass.querySelectorAll('img, .placeholder').forEach((el) => el.remove());
  const img = new Image();
  img.src = canvas.toDataURL('image/png');
  img.alt = 'The dashboard as it will be written on the next wake';
  glass.appendChild(img);
  sizeGlass(glass, img);

  const pending = countQueuedChanges(serialize());
  caption.textContent = pending
    ? `${pending} change${pending === 1 ? '' : 's'} waiting — sent on next wake`
    : 'up to date';
  $('queueNote').textContent = pending
    ? `${pending} change${pending === 1 ? '' : 's'} waiting`
    : 'No changes waiting';
}

// ---------- the clapperboard ------------------------------------------------

/**
 * The awake phase: the board is up, fetching, and flashing the panel.
 *
 * Presented identically whether the board REPORTED waking or the model inferred it,
 * because the difference between those two is only where `endsAt` came from — and the
 * part that is an estimate either way is the same part: how long a redraw takes. Hence
 * "about", and hence the panel's own refresh time in the sub line rather than a bare
 * countdown that would imply more precision than exists.
 */
function renderRedrawing(endsAt, tail) {
  const left = Math.round((endsAt - Date.now()) / 1000);
  $('clapperCap').textContent = 'Redrawing — about';
  // Past the estimate but still working: the length was never the certain part, so it
  // stops counting rather than counting into negatives or claiming to be finished.
  $('clapperTime').textContent = left > 0 ? fmtClock(left) : '--:--';
  $('sleepHeadline').textContent = 'Display is awake and redrawing';
  $('sleepSub').textContent =
    `A ${MODE_LABELS[display.type] || 'mono'} panel this size takes about ${panelRefreshSeconds()}s `
    + `to refresh, on top of the WiFi and Adafruit IO round trip. ${tail}`;
}

/**
 * The CircuitPython clapperboard, for a board that does not report for itself.
 *
 * A code.py that publishes to the status feed makes all of this unnecessary — that
 * board's clock is driven by what it actually said, and the branch above never gets
 * here. This is the fallback for one that publishes nothing: the cycle has to be
 * modelled or not shown at all, so it is modelled — sleep the window the board
 * collected, wake, spend a while on the network and the panel's own refresh, sleep
 * again.
 *
 * Without the awake phase the screen stalls at 00:00 the moment the estimate runs
 * out and calls the redraw overdue, which is wrong for up to half a minute on a
 * four-color panel — the board is awake and flashing exactly then. And without
 * rolling the clock into the next cycle it stays stalled forever, when the honest
 * reading is that the board went back to sleep and there is another take coming.
 *
 * The phase boundaries come from device.js, which schedules the queued take's
 * promotion off the same numbers — so the moment this stops saying "redrawing" is
 * the moment the left panel picks up what was queued.
 */
function renderEstimatedCycle(st) {
  const awakeMs = awakeSeconds() * 1000;
  // The window the BOARD is running, not the one the form shows: an interval
  // edited mid-sleep does nothing until the board reads the feed again.
  const periodMs = (st.sleepSeconds || refreshInterval()) * 1000 + awakeMs;

  // Skip whole cycles that came and went while this tab sat open. Arithmetic
  // rather than a loop — a 15s interval left overnight is thousands of cycles.
  let wake = st.wakesAt;
  const overdue = Date.now() - (wake + awakeMs);
  if (overdue >= 0 && periodMs > 0) wake += periodMs * (Math.floor(overdue / periodMs) + 1);

  const now = Date.now();
  if (now < wake) {
    $('clapperTime').textContent = fmtClock(Math.round((wake - now) / 1000));
    $('sleepHeadline').textContent = `Display is sleeping until ${fmtLocalTime(new Date(wake))}`;
    $('sleepSub').textContent = 'Anything you edit will be included in the next take.';
    return;
  }

  // Awake: connecting, fetching, and then the panel physically flashing. Inferred
  // rather than reported, so the tail says so.
  renderRedrawing(wake + awakeMs,
    'Nothing on this path reports back, so the whole cycle is an estimate — it sleeps '
    + 'again straight afterwards.');
}

/**
 * The board's own record, under the headline: the times the DEVICE reported, as opposed
 * to the times the editor inferred.
 *
 * Everything else on this bar is Marquee's reading of the situation. This line is the
 * evidence that reading rests on, which is why it is the only thing here rendered in
 * mono and why it stays hidden until a device has actually said something — an empty
 * "no reports" row would take up the same space while carrying none of the point.
 *
 * "Awake Ns" is the number worth having: it is the whole cost of a take, and comparing
 * it against the panel's refresh estimate is how you find out whether a cycle is slow
 * because of the panel or because of the network.
 */
function renderReport(st) {
  const el = $('sleepReport');
  if (!el) return;
  const { lastWokeAt: woke, lastSleptAt: slept } = st;
  if (!woke && !slept) { el.hidden = true; return; }
  el.hidden = false;

  const parts = [];
  if (woke) parts.push(`woke ${fmtLocalSeconds(new Date(woke))}`);
  if (slept && (!woke || slept >= woke)) {
    parts.push(`slept ${fmtLocalSeconds(new Date(slept))}`);
    if (woke) parts.push(`awake ${Math.max(0, Math.round((slept - woke) / 1000))}s`);
  } else if (woke && st.deviceState === 'online-awake') {
    parts.push('up now');
  }
  el.textContent = `board reported · ${parts.join(' · ')}`;
}

let tickTimer = null;

function renderCountdown() {
  const st = getState();
  const time = $('clapperTime');
  const headline = $('sleepHeadline');
  const sub = $('sleepSub');
  // The redraw phase is the only state that renames the clock, so every other
  // one gets the default back rather than inheriting a stale caption.
  $('clapperCap').textContent = 'Next take in';
  // Outside the branches: the record is true regardless of which phase the board is in,
  // and every branch below returns.
  renderReport(st);

  if (st.deviceState === 'offline') {
    time.textContent = '--:--';
    headline.textContent = 'Display is offline';
    sub.textContent = 'The board stopped checking in. Your edits are safe and will be written when it returns.';
    return;
  }

  // A pin-only alarm has no wake time at all, so there is no clock to run and
  // "it redraws every 5 minutes" below would be a straight falsehood — the board
  // sleeps until a finger lands on the button.
  if (st.deviceState === 'asleep' && st.wakeSource === 'pin') {
    time.textContent = '--:--';
    headline.textContent = 'Display is sleeping until the button is pressed';
    sub.textContent = 'Anything you edit is included the next time the board is woken.';
    return;
  }

  // The board REPORTED waking and has not reported sleeping since, so it is up right
  // now working through its take: it fetches, redraws and sleeps again without being
  // asked. The start of that window is evidence and its length is the panel estimate,
  // which is exactly the modelled redraw's mix — so it renders through the same
  // function.
  if (st.deviceState === 'online-awake' && st.lastWokeAt) {
    renderRedrawing(st.lastWokeAt + awakeSeconds() * 1000,
      'The board reported in when it woke, and reports again as it goes back to sleep.');
    return;
  }

  if (st.deviceState !== 'asleep' || !st.wakesAt) {
    time.textContent = '--:--';
    headline.textContent = st.lastWriteAt ? 'Display is awake' : 'Nothing pushed yet';
    sub.textContent = st.lastWriteAt
      ? `It redraws every ${refreshIntervalLabel()}, then sleeps again.`
      : 'Push a dashboard from the editor to start the cycle.';
    return;
  }

  // Model the cycle ONLY when there is nothing better. WipperSnapper sends real
  // commands and hears real answers back — goodnight, then checkin.complete — and a
  // CircuitPython board that publishes to its status feed reports its own sleep the
  // same way. Either way the clock below is then reporting evidence rather than an
  // estimate: `wakesAt` is the board's own timestamp plus the window it said it armed.
  if (st.firmwarePath === 'circuitpython' && !boardReportsState()) {
    renderEstimatedCycle(st);
    return;
  }

  const left = Math.max(0, Math.round((st.wakesAt - Date.now()) / 1000));

  // The wake is due and nothing has reported it yet. Both paths have this gap — the
  // broker's poller and the status feed each take a moment to come back — and the one
  // thing it must not do is keep naming a wake time that has already passed.
  if (left === 0) {
    time.textContent = '--:--';
    headline.textContent = 'Display is due back';
    sub.textContent = boardReportsState()
      ? 'Waiting for the board to report in. It redraws before it sleeps again.'
      : 'Waiting for the device to check in.';
    return;
  }

  time.textContent = fmtClock(left);
  headline.textContent = `Display is sleeping until ${fmtLocalTime(new Date(st.wakesAt))}`;
  sub.textContent = 'Anything you edit will be included in the next take.';
}

function startTicking() {
  stopTicking();
  renderCountdown();
  tickTimer = setInterval(renderCountdown, 1000);
}

function stopTicking() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

// ---------- boot ------------------------------------------------------------

export function initA8({ onEnter }) {
  $('editDashboard').addEventListener('click', () => navigate('a7'));

  onEnter('a8', () => {
    renderWritten();
    renderNext();
    startTicking();
    // This is the screen that claims to know what the board is doing, so it reads the
    // board's own feed on the way in rather than trusting a poll that may have been
    // throttled while another screen was up.
    catchUpStatus();
  });

  // The editor stays usable while asleep, so an edit made on A7 has to be
  // reflected here the next time this screen is looked at — and immediately if
  // it is already open.
  onDocChange(() => {
    if (currentScreen() === 'a8') renderNext();
  });

  subscribe((_st, patch) => {
    if (currentScreen() !== 'a8') return;
    // A new `published` moves the left panel AND retires the pending count that the
    // right one carries — when the modelled redraw promotes the queued take, the
    // pair has to be re-read together or the caption keeps claiming changes that
    // are now on the glass.
    if (patch.published) { renderWritten(); renderNext(); }
    renderCountdown();
  });

  onDeviceEvent(({ type }) => {
    // A push, a wake or a reset all change what the two panels should show.
    if (type === 'pushed' || type === 'woke' || type === 'reset') {
      syncNav();
      if (currentScreen() === 'a8') {
        renderWritten();
        renderNext();
      }
    }
  });

  // Don't leave a 1Hz timer running behind a hidden screen.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopTicking();
    else if (currentScreen() === 'a8') startTicking();
  });
}
