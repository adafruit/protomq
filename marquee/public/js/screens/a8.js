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

import { bitmapFeedKey } from '../api.js';
import { logicalDims } from '../palette.js';
import { captureClean } from '../stage.js';
import { selected, select } from '../selection.js';
import { serialize, onDocChange } from '../doc.js';
import { getState, countQueuedChanges, subscribe } from '../state.js';
import { onDeviceEvent, catchUpStatus } from '../device.js';
import { readFeedData, readFeedLast } from '../feeds.js';
import { displayState } from '../cycle.js';
import { refreshIntervalLabel } from '../config.js';
import { navigate, currentScreen, currentAct, syncNav } from '../router.js';
import { $, val, show, fmtClock, fmtInterval, fmtLocalTime, fmtLocalSeconds } from '../util.js';

/**
 * How large to draw a panel preview. NEVER above 1:1.
 *
 * The design called for about 1.7×, so a 296×128 landed near its 504×222 plate, and for a
 * mock-up that is right — it is a picture of a dashboard. For a real dithered render it is
 * not: a small panel hit the old 2× ceiling exactly, and every dither dot came out twice the
 * size the hardware makes it. Smoothing the upscale helped and did not settle it, because
 * the dots were still physically too big to blend the way they do on glass.
 *
 * Life-size fixed the dither and made the panel too small to work against, so the size is
 * back and the dither is handled where the problem actually is — see viewingBlur(). The two
 * are one decision and are tuned together.
 *
 * The lower clamp is why an 800×480 still fits two-up on one screen; those panels were always
 * below 1:1 and never looked wrong.
 */
function previewScale() {
  const { w, h } = logicalDims();
  return Math.max(0.5, Math.min(2, 520 / w, 250 / h));
}

/**
 * How much to soften a preview drawn larger than 1:1, in screen pixels.
 *
 * Upscaling a dithered bitmap is the whole difficulty of this pair. `pixelated` at 2× draws
 * every dither dot at twice the size the hardware makes it, and it reads as noise. Plain
 * bilinear smoothing is barely better, because it only ever averages across one pixel — the
 * dots survive as blobs rather than blending.
 *
 * What the device gives you is OPTICAL blending: at arm's length the eye integrates over
 * roughly a panel pixel and adjacent black and white dots become grey. That is a blur of
 * about half a panel pixel, so the radius has to scale with how large the panel is drawn —
 * a fixed radius would be right at one zoom and wrong at every other.
 *
 * BLUR_PANEL_PX is the knob. Higher blends more of the dither and costs edge definition on
 * text; 0 gives the old harsh upscale back. Nothing below 1:1 is touched, because
 * downscaling already averages neighbouring dots for free — which is why the 4.2" and 7.5"
 * panels never had this problem.
 */
const BLUR_PANEL_PX = 0.45;

function viewingBlur(scale) {
  return scale > 1 ? BLUR_PANEL_PX * scale : 0;
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
    const blur = viewingBlur(s);
    img.style.filter = blur ? `blur(${blur.toFixed(2)}px)` : '';
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
let takesAgain = false;

/**
 * The newest take we have ever concluded the board had drawn.
 *
 * Carried forward because on a history-off feed — which the image feed always is — there is
 * only ever ONE datum. Publish a new take and the previous one is gone from IO entirely, so
 * the panel that is still physically on the glass has no record left anywhere but here.
 * Without this the left panel goes blank the instant you queue something, which is the
 * moment the before/after pair matters most.
 *
 * PERSISTED, unlike `published` in state.js, and the difference is what makes it safe. That
 * one is a local snapshot of what this editor rendered — a claim with no evidence behind it
 * once the session ends. This is a feed datum with IO's own server timestamp on it, and the
 * board redraws whatever is on the feed, so it stays true for as long as nothing newer is
 * published. When something newer IS published and drawn, the ordinary cut below replaces
 * this on the first fetch; the cache never wins against evidence, it only fills the gap
 * where there is none.
 *
 * The gap is real and unavoidable otherwise: reload while a take is pending and the drawn
 * image exists nowhere — IO discarded it (no history), and memory went with the tab.
 */
const DRAWN_KEY = 'marquee.panelNow';

let lastDrawn = null;

/** Keyed by feed, so pointing the editor at another board does not show the last one's
 *  panel. Written on every confirmed draw; a full-panel data URL is ~21 KB for a 2.13"
 *  and ~340 KB at the 7.5" ceiling, both comfortably inside a 5 MB origin quota. */
function saveDrawn(feed) {
  try {
    localStorage.setItem(DRAWN_KEY, JSON.stringify({ feed, ...lastDrawn }));
  } catch { /* storage disabled, or the quota said no — the panel just falls back */ }
}

function loadDrawn(feed) {
  try {
    const c = JSON.parse(localStorage.getItem(DRAWN_KEY) || 'null');
    if (c && c.feed === feed && c.src) lastDrawn = { src: c.src, at: c.at };
  } catch { /* corrupt entry: no cache, which is the pre-cache behaviour */ }
}

function forgetDrawn() {
  lastDrawn = null;
  try { localStorage.removeItem(DRAWN_KEY); } catch { /* nothing to do */ }
}

const TAKES_EMPTY = {
  unknown: 'Reading the feed…',
  unconfigured: 'No feeds yet — finish "Configure Adafruit IO" in Act I and this fills in.',
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
  // A caller arriving mid-flight gets a REFETCH, not the in-flight promise. Sharing the
  // running request would hand it a read taken before the thing that triggered it — a
  // `pushed` landing during the previous poll would be answered with the feed as it was
  // before the push, and the pending take would not appear until something else asked.
  if (takesFetch) { takesAgain = true; return takesFetch; }
  takesFetch = (async () => {
    // Before A5b has run there is no bitmap feed to read, and asking anyway is a 404
    // reported as "could not read the feed — check your credentials", which sends the
    // user to fix something that is not wrong. Say what is actually missing instead.
    //
    // Renders on the way out rather than returning bare: the placeholder below is the
    // whole point of the branch, and the finally clears takesFetch either way.
    if (getState().firmwarePath === 'circuitpython' && getState().ioSetup === 'pending') {
      takes = { panel: null, next: null, state: 'unconfigured' };
      if (currentScreen() === 'a8') { renderWritten(); renderNext(); }
      return takes;
    }
    const feed = bitmapFeedKey();
    // Before the read, so a reload has something to show while the request is in flight and
    // still has it afterwards if the only datum on the feed turns out to be pending.
    if (!lastDrawn) loadDrawn(feed);
    let data = feed ? await readFeedData(feed, { limit: TAKE_HISTORY }) : null;
    // Empty is the NORMAL answer here, not an edge case: a panel BMP is ~20 KB against
    // IO's 1 KB history limit, so the image feed can never have history on, so it retains
    // no data points and `/data` is always []. `/data/last` still has the current value.
    // Asking for history first is still right — where it exists it is the only way to show
    // the previous take beside the pending one — but this is what most setups will hit.
    if (data && !data.length) {
      const last = await readFeedLast(feed);
      if (last) data = [last];
    }
    if (!data) takes = { panel: null, next: null, state: 'unreadable' };
    else if (!data.length) takes = { panel: null, next: null, state: 'empty' };
    else {
      // Where the board last collected. The LATEST report of either kind, not the wake by
      // preference — which is the whole reason "On the panel now" sat empty through cycles
      // the board had demonstrably drawn.
      //
      // The wake used to be treated as the exact answer, on the model of a board that pulls
      // the feed once on connecting and is then unreachable until the next wake. The
      // producer does not work that way: adafruit_marquee SUBSCRIBES to the bitmap feed and
      // stays subscribed for as long as it is up, so a take published while the board is
      // awake is delivered to it the moment it lands, and `loop()` draws the pending image
      // before it acts on the pending sleep. So the `sleeping` report is the acknowledgement
      // — everything on the feed before it has been drawn, including everything published
      // during that wake.
      //
      // Preferring `lastWokeAt` threw that away. Push while the board is up (the ordinary
      // case: the editor publishes, the panel redraws a minute later), and the take is newer
      // than the last wake, so nothing was ever confirmed drawn and the pair stayed frozen
      // with the left panel empty until the NEXT wake happened to be reported — fifteen
      // minutes of showing "nothing confirmed on the glass" about a take already on it.
      const { lastWokeAt, lastSleptAt } = getState();
      const fetched = Math.max(lastWokeAt || 0, lastSleptAt || 0) || null;
      // Newest first, so the first datum older than that is the newest one the board could
      // have pulled. -1 (nothing old enough) means nothing here has been drawn yet.
      const drawn = fetched ? data.findIndex((d) => d.createdAt < fetched) : 1;
      const panel = drawn >= 0 ? data[drawn] : undefined;
      if (panel) { lastDrawn = takeFrom(panel); saveDrawn(feed); }
      // Falling back to the carried copy, not to nothing: the board is still displaying
      // whatever it last drew, and IO having discarded the datum does not change that.
      takes = {
        panel: lastDrawn,
        next: drawn === 0 ? null : takeFrom(data[0]),
        state: lastDrawn ? 'ok' : 'undrawn',
      };
    }
    // Rendering is screen-local; CAPTURING is not. This runs on every screen, because the
    // moment worth catching — the newest datum becoming the drawn one — happens while the
    // user is usually in the editor, and on a history-off feed that datum is gone as soon as
    // the next take is published. Only the drawing is deferred: renderNext() takes the stage
    // through captureClean(), which deselects and reselects, and doing that under someone's
    // cursor on A7 would flicker their selection for a panel they cannot see.
    if (currentScreen() === 'a8') { renderWritten(); renderNext(); }
  })().finally(() => {
    takesFetch = null;
    if (takesAgain) { takesAgain = false; fetchTakes(); }
  });
  return takesFetch;
}

function renderWritten() {
  const glass = $('takeWritten');
  const caption = $('takeWrittenCaption');

  if (!takes.panel) {
    glass.innerHTML = `<div class="placeholder">${TAKES_EMPTY[takes.state]}</div>`;
    caption.textContent = takes.state === 'unreadable' ? 'feed unreadable'
      : takes.state === 'unconfigured' ? 'no feeds yet' : 'nothing confirmed';
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
  // "On the next wake" is only true of a board that is asleep. One that is up is SUBSCRIBED
  // to the bitmap feed, so a take published now reaches it now and the panel is redrawing
  // it — saying it waits for a wake that has already happened reads as the push having
  // missed the cycle.
  const collected = displayState() === 'redrawing'
    ? 'the board is up — drawing it now'
    : 'collected on the next wake';
  caption.textContent = takes.next
    ? `on the feed ${fmtLocalTime(new Date(takes.next.at))} — ${collected}`
    : pending
      ? `${pending} change${pending === 1 ? '' : 's'} waiting — sent on next wake`
      : 'up to date';
  // The queue note counts UNPUBLISHED edits: a take already on the feed is not waiting on
  // the user for anything, and saying "1 change queued" about it would invite a second
  // push of something already sent.
  //
  // It is a heading in the action bar now rather than a note in the status bar, so it is
  // written as a count rather than as a sentence — "3 CHANGES QUEUED", with the sentence
  // explaining what that means sitting beside it in the bar's helper text.
  //
  // Nothing queued, nothing said. The two idle headings this used to carry — "A take is on
  // the feed" and "No changes queued" — were a caption for the sentence next to them, which
  // already covers the idle case and covers it better: it says what happens to an edit, not
  // that there isn't one. So the heading appears only when there is a count to give.
  const note = $('queueNote');
  note.textContent = pending ? `${pending} change${pending === 1 ? '' : 's'} queued` : '';
  show(note, pending > 0);
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
 * Both clapperboard readouts — the full-size one on Showtime and the miniature in the chrome
 * — written in one call, which is the only way they cannot drift. There is no mirroring step
 * and no second source: one function decides the caption and the figure, and paints them
 * wherever they appear.
 *
 * `null` seconds HIDES both rather than parking them on `--:--`. A clapperboard showing no
 * time is set dressing that has stopped saying anything, and on Showtime it is most of the
 * bar's width — during a take, where the honest answer is "this cannot be predicted", that
 * space belongs to the headline saying so.
 *
 * The chrome copy is the STAND-IN for the other one: it exists so the clock is readable from
 * screens that do not have the sleep bar on them. So it appears everywhere except Showtime,
 * where the full-size board is right there and a second copy in the header would be the same
 * clock twice in one view.
 */
function setClock(cap, secs) {
  const has = secs != null && secs >= 0;
  const text = has ? fmtClock(secs) : '--:--';

  // The chrome copy ships with the `hidden` ATTRIBUTE set, so the first paint has no clock
  // in the bar; show() works on a class. Clearing it here hands control to show() for good.
  $('chromeClapper').hidden = false;
  show($('clapper'), has);
  show($('chromeClapper'), has && currentAct() < 3);
  if (!has) return;

  for (const id of ['clapper', 'chromeClapper']) {
    $(`${id}Cap`).textContent = cap;
    $(`${id}Time`).textContent = text;
  }
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
  // So is the armed window: it is the cadence the board is running, not a reading of
  // where in the cycle it happens to be, so it stands in every state including offline
  // — that is what makes it the right thing to park opposite a countdown that blanks.
  const cadence = $('refreshEvery');
  if (cadence) cadence.textContent = armedWindowLabel(st);

  switch (displayState(st)) {
    case 'offline':
      setClock('Next take in', null);
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
      setClock('Next take in', null);
      setMessage("It's Showtime - Display is awake and redrawing 🎨",
        'Each take can take up to 2 minutes depending on panel driver, color mode, and size.');
      return;

    default: {
      // The countdown is back, but only where it is evidence: `wakesAt` is the board's own
      // `sleep_time` counted from the moment it said it armed the alarm. Nothing here
      // predicts the take that follows the wake — that is what the redrawing state is for.
      //
      // "Next take in" rather than "Sleeping for", and the caption is doing real work now
      // that the headline beside it reads "Display is sleeping until 9:47 AM": two clocks
      // captioned with the same word was the bar saying "sleeping" twice and answering the
      // same question twice. It is also the more useful of the two framings — the wake is
      // only interesting because a take follows it — and it stays honest, because this
      // figure is the armed sleep counted down and nothing about the take itself.
      setClock('Next take in', sleepRemainingSeconds(st));
      if (st.wakeSource === 'pin') {
        setMessage('Display is sleeping until the button is pressed',
          'Anything you edit is included the next time the board is woken.');
      } else if (!st.lastWriteAt) {
        setMessage('Nothing pushed yet', 'Push a dashboard from the editor to start the cycle.');
      } else {
        // The headline carries the WAKE TIME and nothing else. Both of the sentences that used
        // to sit under it have found better homes: the armed total is the cadence stack on the
        // right of this bar, opposite the countdown running through it, and "anything you edit
        // is included on the next take" is the helper text of the action bar below — beside the
        // button that acts on it, which is where a user reads it at the moment it matters.
        //
        // A time rather than a duration, because the duration is already on the bar twice: once
        // ticking down in the clapperboard, once named in the cadence stack. "Until 9:47 AM" is
        // the one form of it neither of those gives you, and it is the one you can plan against.
        setMessage(st.wakesAt
          ? `Display is sleeping until ${fmtLocalTime(new Date(st.wakesAt))}`
          : 'Display is sleeping', '');
      }
    }
  }
}

/**
 * The readout is the only thing here that moves without the board saying anything, so it is
 * the only thing that needs a timer — and at mm:ss it needs a per-second one.
 *
 * No act guard, because between the two clapperboards there is now one on screen in every
 * act: the chrome stand-in in I and II, the full-size board in III. A guard would only be
 * bookkeeping for a condition that is always true, and the version that had one left the
 * clock frozen at whatever second the user navigated away on.
 *
 * The cost is a 1Hz interval for the life of the session, writing at most four text nodes a
 * second and only when a sleep is being counted.
 */
let clockTimer = null;

function startClock() {
  clearInterval(clockTimer);
  clockTimer = setInterval(renderCycle, 1000);
}

// ---------- boot ------------------------------------------------------------

export function initA8({ onEnter }) {
  $('editDashboard').addEventListener('click', () => navigate('a7'));

  onEnter('a8', () => {
    renderWritten();      // whatever the last read found, immediately
    renderNext();
    fetchTakes();         // then the feed, which is the actual answer
    renderCycle();
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
    // Both ahead of the screen check. The clock is in the chrome and so live everywhere; the
    // feed read has to happen everywhere for the reason in fetchTakes().
    renderCycle();
    // The reported times are what SPLIT the feed, so a change to either one re-cuts it.
    // `published` alone was not enough: the status seed (adoptReportedState in device.js)
    // records the board's current wake and sleep WITHOUT emitting a device event — on
    // purpose, since it is reading history rather than watching it happen — so a reloaded
    // tab learned the board had drawn and then never re-read the feed to say so. The split
    // stayed at the one computed at boot, with no reported time at all, which is "nothing
    // confirmed on the glass".
    if (patch.published || 'lastWokeAt' in patch || 'lastSleptAt' in patch) fetchTakes();
  });

  onDeviceEvent(({ type }) => {
    // A push, a wake, a sleep or a reset all change what the two panels should show.
    //
    // NOT gated on being on Showtime, and that is the whole point. `slept` and `woke` are
    // when the newest datum stops being pending and becomes what is on the glass — the only
    // moment it can be captured, because the next push discards it from a history-off feed.
    // Gating this on the screen meant a user editing on A7 through a whole wake never
    // recorded what the board drew, and the left panel was blank from then on.
    // "Reset state" tears down every other record of the board, so the cached panel goes
    // with it — leaving it behind would have a reset editor still claiming to know what is
    // on the glass.
    if (type === 'reset') forgetDrawn();
    if (type === 'pushed' || type === 'woke' || type === 'slept' || type === 'reset') {
      syncNav();
      fetchTakes();
    }
  });

  // No timer to pause or resume: the bar changes only when the board says something, and
  // initDevice() already catches the status feed up when a tab returns to the foreground.
  renderCycle();
  // The clock is chrome-wide, so it runs with the session rather than with a screen. This
  // module owns it anyway, because renderCycle() writes the clock and the prose beside it in
  // one pass and those two must never disagree — moving the clock to the router would be the
  // same reading in two places again.
  startClock();
  // At boot, on whatever screen: a tab reloaded while the board sleeps has one chance to see
  // the take on the glass before the next push replaces it on the feed.
  fetchTakes();
}
