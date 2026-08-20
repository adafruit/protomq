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
import { getState, countQueuedChanges, subscribe } from '../state.js';
import { onDeviceEvent, catchUpStatus } from '../device.js';
import { readFeedData } from '../feeds.js';
import { displayState } from '../cycle.js';
import { refreshIntervalLabel } from '../config.js';
import { navigate, currentScreen, syncNav } from '../router.js';
import { $, val, show, fmtClock, fmtInterval, fmtLocalTime, fmtLocalSeconds } from '../util.js';

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
/**
 * The two takes, both read from the image feed.
 *
 * The pair is the whole point of this screen — what is on the glass beside what is coming —
 * and the feed carries both, because a feed is a history and not just a last value. The
 * newest datum is the one the board has yet to collect; the one before it is what it drew
 * last. Reading only the newest, as this did a moment ago, put the same image in both
 * panels from the instant of a push: correct, and useless, since the two frames are only
 * worth showing when they differ.
 *
 * WHERE THE SPLIT FALLS is not simply "newest vs the rest", and this is the part worth
 * getting right. Once the board wakes and fetches, the newest datum IS what is on the
 * glass, and there is no pending take at all. The bracket says which: a datum published
 * before the last reported `awake` was on the feed when the board pulled, so it has been
 * drawn — the same comparison applyStatus() uses to promote a queued take. Without it the
 * left panel would keep showing the previous image forever, claiming a board is displaying
 * something it replaced minutes ago.
 *
 * With no reported wake to compare against, nothing can be confirmed drawn, so the newest
 * is treated as pending and the one behind it as the panel's. That is the honest default
 * and it is also exactly the layout during the first cycle of a fresh board.
 */
const TAKE_HISTORY = 3;

let takes = { panel: null, next: null, state: 'unknown' };
let takesFetch = null;

const TAKES_EMPTY = {
  unknown: 'Reading the feed…',
  unreadable: 'Could not read the feed — check the feed key and AIO credentials under Settings.',
  empty: 'Nothing has been published to this feed yet.',
  undrawn: 'Nothing confirmed on the glass yet — the board has not reported collecting a take.',
};

/** A feed datum as an <img> source. The feed carries the base64 BMP3 that server.js
 *  published and the board decodes — indexed and uncompressed, which browsers render
 *  natively, so it goes straight into an <img> rather than through a decoder. */
const takeFrom = (d) => ({
  src: `data:image/bmp;base64,${String(d.value || '').replace(/\s+/g, '')}`,
  at: d.createdAt,
});

/**
 * Fetch the last few data points and split them at the board's last fetch. Concurrent
 * callers share one request: entering Act III right after a push fires both triggers, and
 * they would otherwise race for the same data — over a payload that is a whole BMP each.
 */
function fetchTakes() {
  if (takesFetch) return takesFetch;
  takesFetch = (async () => {
    const feed = val('ioFeed');
    const data = feed ? await readFeedData(feed, { limit: TAKE_HISTORY }) : null;
    if (!data) takes = { panel: null, next: null, state: 'unreadable' };
    else if (!data.length) takes = { panel: null, next: null, state: 'empty' };
    else {
      // Where the board last fetched. Its WAKE is the exact answer — it pulls the feed on
      // connecting — but a sleep works too and is sometimes all there is: a board that has
      // reported going to sleep has necessarily woken and drawn first, so everything older
      // than that report was on the feed in time for it. Cutting at the sleep is at worst
      // one cycle generous; refusing to cut at all was the bug, and claimed a board that
      // had demonstrably drawn something had confirmed nothing.
      const { lastWokeAt, lastSleptAt } = getState();
      const fetched = lastWokeAt || lastSleptAt;
      // Newest first, so the first datum older than that is the newest one the board could
      // have pulled. -1 (nothing old enough) means nothing here has been drawn yet.
      const drawn = fetched ? data.findIndex((d) => d.createdAt < fetched) : 1;
      const panel = drawn >= 0 ? data[drawn] : undefined;
      takes = {
        panel: panel ? takeFrom(panel) : null,
        next: drawn === 0 ? null : takeFrom(data[0]),
        state: panel ? 'ok' : 'undrawn',
      };
    }
    renderWritten();
    renderNext();
  })().finally(() => { takesFetch = null; });
  return takesFetch;
}

function renderWritten() {
  const glass = $('takeWritten');
  const caption = $('takeWrittenCaption');

  if (!takes.panel) {
    glass.innerHTML = `<div class="placeholder">${TAKES_EMPTY[takes.state]}</div>`;
    caption.textContent = takes.state === 'unreadable' ? 'feed unreadable' : 'nothing confirmed';
    // Still sized to the panel. An empty box that collapses to its text would
    // leave the two takes different heights, and the whole point of the pair is
    // that they are directly comparable.
    sizeGlass(glass, null);
    return;
  }
  glass.innerHTML = '';
  const img = new Image();
  img.src = takes.panel.src;
  img.alt = 'The dashboard currently on the panel';
  glass.appendChild(img);
  sizeGlass(glass, img);
  caption.textContent = Number.isFinite(takes.panel.at)
    ? `drawn from the take of ${fmtLocalTime(new Date(takes.panel.at))}`
    : 'on the glass';
}

/**
 * The right panel: what the board draws next.
 *
 * Two different things can be next, and they are not the same claim:
 *
 *   a take ON THE FEED     already published, waiting for the board to wake and pull it.
 *                          This is what the panel changes to, and it is settled.
 *   the LIVE CANVAS        edits that have not been published at all. What a push would
 *                          send, if you sent one.
 *
 * The feed wins when there is something on it, because that is the take with a claim on the
 * next wake. Only when the board has already collected everything published does the panel
 * fall back to previewing the editor — which is the state where "N changes waiting" is the
 * whole story anyway.
 */
function renderNext() {
  const glass = $('takeNext');
  const caption = $('takeNextCaption');

  // Keep the blueprint corner marks; replace only the image.
  glass.querySelectorAll('img, .placeholder').forEach((el) => el.remove());
  const img = new Image();
  if (takes.next) {
    img.src = takes.next.src;
    img.alt = 'The take on the feed, waiting for the board to collect it';
  } else {
    const prev = selected;
    const canvas = captureClean({
      onDeselect: () => select(null),
      onReselect: () => { if (prev) select(prev); },
    });
    img.src = canvas.toDataURL('image/png');
    img.alt = 'The dashboard as it will be written on the next wake';
  }
  glass.appendChild(img);
  sizeGlass(glass, img);

  const pending = countQueuedChanges(serialize());
  caption.textContent = takes.next
    ? `on the feed ${fmtLocalTime(new Date(takes.next.at))} — collected on the next wake`
    : pending
      ? `${pending} change${pending === 1 ? '' : 's'} waiting — sent on next wake`
      : 'up to date';
  // The queue note counts UNPUBLISHED edits either way: a take already on the feed is not
  // waiting on the user for anything, and saying "1 change waiting" about it would invite
  // a second push of something already sent.
  $('queueNote').textContent = pending
    ? `${pending} change${pending === 1 ? '' : 's'} waiting`
    : takes.next ? 'A take is on the feed, waiting for the board' : 'No changes waiting';
}

// ---------- what the board is doing -----------------------------------------
//
// No clock. The three states come from `{feed}-status` via cycle.js, and the only times on
// this bar are the ones the board itself stamped — renderReport() below prints them
// verbatim. That is the whole of the change: a countdown needed a wake time, a wake time
// needed a cycle period, a cycle period needed a panel refresh estimate, and on hardware
// that estimate was 14s against a measured 123s. Every number downstream of it was wrong,
// including the ones that decided whether to keep listening.
//
// What is lost is a ticking figure. What replaces it is "board reported · woke 4:39:35 PM ·
// slept 4:41:38 PM · awake 123s", which is not a prediction and cannot be wrong.

function setMessage(headline, sub) {
  $('sleepHeadline').textContent = headline;
  $('sleepSub').textContent = sub;
}

/**
 * The clapperboard readout, which is only on screen when it has something to count.
 *
 * `null` seconds hides the whole board rather than parking it on `--:--`. A clapperboard
 * showing no time is set dressing that has stopped saying anything, and it is most of the
 * bar's width — during a take, where the honest answer is "this cannot be predicted", the
 * space belongs to the headline that says so. So: the countdown appears when the board
 * reports a sleep, and leaves when the board wakes.
 */
function setClock(cap, secs) {
  const has = secs != null && secs >= 0;
  show($('clapper'), has);
  if (!has) return;
  $('clapperCap').textContent = cap;
  $('clapperTime').textContent = fmtClock(secs);
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

  // Mid-take there is exactly one fact to report and no cycle to summarise, so it is said
  // as a sentence rather than as a log line with an "up now" tacked on the end. The full
  // record — both ends of the bracket and the length of the take — is what a FINISHED take
  // leaves behind, and that is worth reading in the compressed form.
  // displayState(), not `deviceState`: the same reading the pill and the headline use, so
  // this line cannot say the board slept while they say it is redrawing.
  if (displayState(st) === 'redrawing' && woke && (!slept || slept < woke)) {
    el.textContent = `board woke up at: ${fmtLocalSeconds(new Date(woke))}`;
    return;
  }

  const parts = [];
  if (woke) parts.push(`woke ${fmtLocalSeconds(new Date(woke))}`);
  if (slept && (!woke || slept >= woke)) {
    parts.push(`slept ${fmtLocalSeconds(new Date(slept))}`);
    if (woke) parts.push(`awake ${Math.max(0, Math.round((slept - woke) / 1000))}s`);
  }
  el.textContent = `board reported · ${parts.join(' · ')}`;
}

/**
 * How much of the sleep is LEFT, in seconds, or null when there is nothing to count.
 *
 * A `{"state": "sleeping", "sleep_time": 300, ...}` starts this at 05:00 and it runs down to
 * 00:00: `wakesAt` is that `sleep_time` added to the moment the board reported arming the
 * alarm, so the readout is counting down evidence rather than a model.
 *
 * CLAMPED at zero rather than continuing into the take. Past the armed window the board is
 * up, or late, and either way the sleep it was counting is over — running the figure past
 * 00:00 would turn a sleep timer into a stopwatch measuring something else. It sits at 00:00
 * until the board reports its wake, which is a poll away.
 *
 * Null for a pin alarm, which has no armed time at all, and for a sleep nobody has reported
 * and nothing was asked for.
 */
function sleepRemainingSeconds(st) {
  if (!st.wakesAt || st.wakeSource === 'pin') return null;
  return Math.max(0, Math.round((st.wakesAt - Date.now()) / 1000));
}

/** The sleep window the board actually armed, in words; the requested one if it never said. */
function armedWindowLabel(st) {
  return st.sleepSeconds ? fmtInterval(st.sleepSeconds) : refreshIntervalLabel();
}

/**
 * The bar, in three states.
 *
 * Named renderCycle rather than renderCountdown because there is nothing left to count.
 * It runs on state changes only — there is no 1Hz tick any more, since nothing on this
 * screen advances with the clock.
 */
function renderCycle() {
  const st = getState();
  // The board's own record is true in every state, and every branch below returns.
  renderReport(st);

  switch (displayState(st)) {
    case 'offline':
      setClock('Sleeping for', null);
      setMessage('Display is offline',
        'The board stopped checking in. Your edits are safe and will be written when it returns.');
      return;

    case 'redrawing':
      // Cooling down or flashing — indistinguishable from here, and the board does not
      // report the difference. The sub line names the ceiling rather than the panel's own
      // refresh time, because a panel sitting still for two minutes reads as a hang, and
      // what makes it two minutes is the driver's frame minimum rather than the artwork.
      // No figure while a take runs. How long one will take cannot be predicted, and the
      // headline and sub already say what is happening — a clock counting anything here was
      // an invention.
      setClock('Sleeping for', null);
      setMessage("It's Showtime - Display is awake and redrawing 🎨",
        'Each take can take up to 2 minutes depending on panel driver, color mode, and size.');
      return;

    default: {
      // The countdown is back, but only where it is evidence: `wakesAt` is the board's own
      // `sleep_time` counted from the moment it said it armed the alarm. Nothing here
      // predicts the take that follows the wake — that is what the redrawing state is for.
      // The readout counts UP through the sleep and the headline carries what is left, so the
      // two never disagree about rounding the way a countdown and a minutes phrase would:
      // one is elapsed, the other remaining.
      setClock('Sleeping for', sleepRemainingSeconds(st));
      if (st.wakeSource === 'pin') {
        setMessage('Display is sleeping until the button is pressed',
          'Anything you edit is included the next time the board is woken.');
      } else if (!st.lastWriteAt) {
        setMessage('Nothing pushed yet', 'Push a dashboard from the editor to start the cycle.');
      } else {
        // The total, against a readout counting down through it — 02:46 of five minutes. It is
        // the window the board said it ARMED rather than the one the editor asked for; those
        // differ whenever a board is still running its own code.py default, which is exactly
        // when you want to notice.
        setMessage('Display is sleeping',
          'Anything you edit on the canvas will be included in the next take. '
          + `The display is sleeping a total of ${armedWindowLabel(st)}.`);
      }
    }
  }
}

/**
 * The readout is the only thing on this bar that moves without the board saying anything, so
 * it is the only thing that needs a timer — and at mm:ss it needs a per-second one.
 *
 * Screen-local and self-limiting, which is the difference from the version that caused
 * trouble: it ends itself as soon as Showtime is not the screen being looked at, so there is
 * no way to leave a 1Hz timer running behind a hidden screen by forgetting a stop call, and
 * no chrome element depends on it.
 */
let clockTimer = null;

function startClock() {
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    if (currentScreen() !== 'a8') { clearInterval(clockTimer); clockTimer = null; return; }
    renderCycle();
  }, 1000);
}

// ---------- boot ------------------------------------------------------------

export function initA8({ onEnter }) {
  $('editDashboard').addEventListener('click', () => navigate('a7'));

  onEnter('a8', () => {
    renderWritten();      // whatever the last read found, immediately
    renderNext();
    fetchTakes();         // then the feed, which is the actual answer
    renderCycle();
    startClock();
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
    // Ahead of the screen check: this clock is in the chrome and so live on every screen,
    // so a board that just went to sleep has to reach it now rather than on the next
    // tick — a second of "next take in" under a Sleeping pill reads as a bug.
    renderCycle();
    if (currentScreen() !== 'a8') return;
    // A new `published` retires the pending count the right panel carries, and means the
    // feed has just gained a datum — so the pair is re-read together, the left from the
    // feed rather than from the snapshot that moved.
    if (patch.published) fetchTakes();
  });

  onDeviceEvent(({ type }) => {
    // A push, a wake or a reset all change what the two panels should show. The left one is
    // re-fetched rather than re-rendered: a push puts a new datum on the feed, and a reset
    // means the local record of it is gone while the feed's is not.
    if (type === 'pushed' || type === 'woke' || type === 'reset') {
      syncNav();
      if (currentScreen() === 'a8') {
        fetchTakes();
      }
    }
  });

  // No timer to pause or resume: the bar changes only when the board says something, and
  // initDevice() already catches the status feed up when a tab returns to the foreground.
  renderCycle();
}
