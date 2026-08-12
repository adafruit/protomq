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

import { logicalDims } from '../palette.js';
import { captureClean } from '../stage.js';
import { selected, select } from '../selection.js';
import { serialize, onDocChange } from '../doc.js';
import { getState, getPublished, countQueuedChanges, subscribe } from '../state.js';
import { onDeviceEvent } from '../device.js';
import { refreshIntervalLabel } from '../config.js';
import { navigate, currentScreen, syncNav } from '../router.js';
import { $, fmtClock, fmtLocalTime } from '../util.js';

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

let tickTimer = null;

function renderCountdown() {
  const st = getState();
  const time = $('clapperTime');
  const headline = $('sleepHeadline');
  const sub = $('sleepSub');

  if (st.deviceState === 'offline') {
    time.textContent = '--:--';
    headline.textContent = 'Display is offline';
    sub.textContent = 'The board stopped checking in. Your edits are safe and will be written when it returns.';
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

  const left = Math.max(0, Math.round((st.wakesAt - Date.now()) / 1000));
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

  // Wake-early only makes sense while a cycle is actually running.
  const syncWakeEarly = () => {
    const st = getState();
    $('wakeEarly').disabled = st.deviceState !== 'asleep';
  };

  onEnter('a8', () => {
    renderWritten();
    renderNext();
    syncWakeEarly();
    startTicking();
  });

  // The editor stays usable while asleep, so an edit made on A7 has to be
  // reflected here the next time this screen is looked at — and immediately if
  // it is already open.
  onDocChange(() => {
    if (currentScreen() === 'a8') renderNext();
  });

  subscribe((_st, patch) => {
    if (currentScreen() !== 'a8') return;
    if (patch.published) renderWritten();
    renderCountdown();
    syncWakeEarly();
  });

  onDeviceEvent(({ type }) => {
    // A push, a wake or a reset all change what the two panels should show.
    if (type === 'pushed' || type === 'woke' || type === 'reset') {
      syncNav();
      if (currentScreen() === 'a8') {
        renderWritten();
        renderNext();
        syncWakeEarly();
      }
    }
  });

  // Don't leave a 1Hz timer running behind a hidden screen.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopTicking();
    else if (currentScreen() === 'a8') startTicking();
  });
}
