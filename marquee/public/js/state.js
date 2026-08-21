/**
 * Flow state — the small set of facts that decide which screen the user is on
 * and what each one says. Distinct from `display` (the panel descriptor, in
 * palette.js) and from the canvas document (doc.js).
 *
 * Everything here except the published snapshot survives a reload, so returning
 * to the tab drops you back where you were rather than at the fork.
 */

const KEY = 'marquee.flow';

const DEFAULTS = {
  /** 'wippersnapper' | 'circuitpython' | null — set at A3. Drives whether A6
   *  appears, and whether the chrome shows a path badge. */
  firmwarePath: null,

  /** Preset key from presets.js, or null when the panel was set up by hand. */
  selectedPanel: null,

  /** CircuitPython only. 'not-generated' | 'downloaded' | 'confirmed' | 'stale'.
   *  Goes stale when the display config changes after a download — the board is
   *  then running files that no longer describe its panel. */
  bundleState: 'not-generated',

  /** The config signature the last bundle was built from. Compared against the
   *  live one to detect staleness across reloads. */
  bundleSig: null,

  /** CircuitPython only. 'pending' | 'ready' | 'skipped' — whether A5b has
   *  confirmed the device's group and its three feeds exist on Adafruit IO.
   *
   *  'skipped' is a deliberate choice and is never re-prompted: the editor works
   *  without a board, and someone who has no network to hand should not be held in
   *  Act I. 'pending' re-opens A5b on the way to the editor, because a bundle built
   *  before that step embeds feed keys nobody has checked. */
  ioSetup: 'pending',

  /** The group key A5b actually resolved. Compared against the live #ioGroup field
   *  on enter: editing the group in Settings afterwards makes the confirmation
   *  stale, because the feeds we verified are no longer the feeds we would publish
   *  to. Null until A5b has run. */
  ioGroupKey: null,

  /** 'online-awake' | 'asleep' | 'offline'. */
  deviceState: 'online-awake',

  /** Epoch ms. When the device is expected back, and when it last confirmed a
   *  write. Both null until a real cycle has run. */
  wakesAt: null,
  lastWriteAt: null,

  /** The sleep window the board actually collected, in seconds — NOT the number
   *  the form currently shows. A8 models the CircuitPython cycle from this, and
   *  an interval edited mid-sleep changes nothing until the board reads the feed
   *  again. Null until a cycle has run. */
  sleepSeconds: null,

  /** Epoch ms of the last wake and the last sleep the DEVICE ITSELF reported — the
   *  status feed on the CircuitPython path, checkin/goodnight on the broker path. Null
   *  until it says so; never set from anything the editor merely published.
   *
   *  Act III shows the pair as the board's own record, and while `deviceState` is
   *  'online-awake' the wake also anchors the redraw clock: the start is evidence, the
   *  length is still the panel estimate.
   *
   *  Neither survives a reload — see load(). */
  lastWokeAt: null,
  lastSleptAt: null,

  /** CircuitPython only. What the last published sleep window wakes on:
   *  'timer' | 'pin' | 'timer+pin' | null. A pin-only alarm has no wake TIME, so
   *  A8 has to say "until you press the button" rather than tick a countdown at
   *  a `wakesAt` that would be a fiction. */
  wakeSource: null,

  /** Whether Act I has been completed at least once — the step rail collapses
   *  and becomes navigable from that point on. */
  actOneDone: false,

  /** Last screen visited, so a reload lands where the user left off. */
  lastScreen: null,
};

let state = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    // The reported times are dropped rather than restored, for the reason `published`
    // isn't saved at all: they are claims about what a device is doing, the device has
    // certainly moved on, and no watch is running yet to correct them. Restored, they
    // would have Act III reporting a wake that ended hours ago.
    return { ...DEFAULTS, ...saved, lastWokeAt: null, lastSleptAt: null };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage disabled/full */ }
}

const listeners = new Set();

export function getState() { return state; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setState(patch) {
  const before = state;
  state = { ...state, ...patch };
  // Only notify on a real change, so a listener that re-renders a screen isn't
  // woken by every no-op write from a form handler.
  const changed = Object.keys(patch).some((k) => before[k] !== state[k]);
  persist();
  if (changed) listeners.forEach((fn) => fn(state, patch));
}

export function resetFlow() {
  state = { ...DEFAULTS };
  persist();
  listeners.forEach((fn) => fn(state, state));
}

// ---------- the published dashboard -----------------------------------------
//
// What is actually on the glass, as opposed to what the editor is showing. A8
// renders this on the left and the live canvas on the right; the difference
// between them is the whole point of that screen.
//
// Deliberately NOT persisted: it holds a full-panel PNG data URL, and a stale
// one restored from a previous session would claim the panel is showing
// something we have no evidence it still shows.

let published = { png: null, doc: null, at: null };

export function getPublished() { return published; }

export function setPublished({ png, doc, at }) {
  published = { png, doc, at };
  listeners.forEach((fn) => fn(state, { published: true }));
}

export function clearPublished() {
  published = { png: null, doc: null, at: null };
  listeners.forEach((fn) => fn(state, { published: true }));
}

// ---------- the queued take -------------------------------------------------
//
// CircuitPython only. What has been published to the feeds but not yet drawn: the
// board is asleep, so this is neither on the glass nor merely a local edit. It is
// held until the modelled redraw completes, at which point it BECOMES `published`
// — see device.js, which owns that clock.
//
// Not persisted, for the same reason `published` isn't.

let queued = null;

export function getQueued() { return queued; }
export function setQueued(take) { queued = take; }
export function clearQueued() { queued = null; }

/**
 * How many elements differ between what was written and what the editor holds.
 * Compared by serialized element, so a move, a recolor and a retyped label each
 * count once — this is the "3 changes waiting" number on A8, not a diff engine.
 */
export function countQueuedChanges(liveDoc) {
  if (!published.doc || !liveDoc) return 0;
  const key = (el) => JSON.stringify(el);
  const before = (published.doc.elements || []).map(key);
  const after = (liveDoc.elements || []).map(key);
  const pool = [...before];
  let added = 0;
  for (const el of after) {
    const i = pool.indexOf(el);
    if (i >= 0) pool.splice(i, 1);
    else added++;
  }
  // Anything left in the pool was removed or altered. An altered element shows
  // up once as a removal and once as an addition, so take the larger side rather
  // than the sum, or every edit would read as two changes.
  const removed = pool.length;
  const structural = Math.max(added, removed);
  // A display-settings change (mode, rotation, dither) redraws everything even
  // when no element moved, so it counts as one pending change on its own.
  const displayChanged = JSON.stringify(published.doc.display) !== JSON.stringify(liveDoc.display);
  return structural + (displayChanged && structural === 0 ? 1 : 0);
}
