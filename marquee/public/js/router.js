/**
 * Screen navigation, the step rail, and the chrome bar.
 *
 * Screens are shown and hidden, never created or destroyed — see the note in
 * index.html. `navigate()` is therefore cheap, and the per-screen enter hooks
 * exist for the things that genuinely need a visible container (measuring the
 * canvas to fit the zoom, sizing a panel preview).
 *
 * The rail is NOT a nav control during first run: cells are locked until
 * reached. Once Act I completes it collapses and its cells become buttons, and
 * returning to Act I from there re-opens A5 (confirm settings) rather than
 * sending the user back through the fork.
 */

import { getState, setState } from './state.js';
import { displayState } from './cycle.js';
import { DISPLAY_PRESETS } from './presets.js';
import { $, $$ } from './util.js';

/** Which act each screen belongs to, for the rail. */
const SCREEN_ACT = { a3: 1, a4: 1, a5: 1, a6: 1, a7: 2, a8: 3 };

let current = null;
const enterHooks = new Map();

/** Register a callback run every time `screen` becomes visible. */
export function onEnter(screen, fn) {
  const list = enterHooks.get(screen) || [];
  list.push(fn);
  enterHooks.set(screen, list);
}

export function currentScreen() { return current; }

/** Which act the current screen belongs to. The chrome reads it to decide what belongs up
 *  there: the device pill from Act I, the cycle clock only once there is a device to watch. */
export function currentAct() { return SCREEN_ACT[current] || 1; }

export function navigate(screen) {
  if (!SCREEN_ACT[screen]) return;
  current = screen;
  $$('.screen').forEach((el) => { el.dataset.active = String(el.dataset.screen === screen); });
  // Remembered so a reload lands where the user left off. Safe to do before the
  // rail sync: the subscriber this wakes only re-renders nav, it never navigates.
  setState({ lastScreen: screen });
  syncRail();
  syncChrome();
  // After the display flip, so anything measuring a container sees real numbers.
  requestAnimationFrame(() => enterHooks.get(screen)?.forEach((fn) => fn()));
}

/** The screen Act I should resume on, given how far setup got. */
export function actOneEntry() {
  const st = getState();
  if (!st.firmwarePath) return 'a3';
  if (!st.selectedPanel) return 'a4';
  return 'a5';
}

/** Where "open the editor" lands — A6 first if a CircuitPython bundle is owed. */
export function editorEntry() {
  const st = getState();
  const owesBundle = st.firmwarePath === 'circuitpython'
    && (st.bundleState === 'not-generated' || st.bundleState === 'stale');
  return owesBundle ? 'a6' : 'a7';
}

// ---------- the rail --------------------------------------------------------

function syncRail() {
  const st = getState();
  const rail = $('stepRail');
  if (!rail) return;

  const act = SCREEN_ACT[current] || 1;
  const collapsed = st.actOneDone;
  rail.dataset.collapsed = String(collapsed);

  const panel = st.selectedPanel ? DISPLAY_PRESETS[st.selectedPanel] : null;
  const actOneStatus = panel ? `✓ ${panel.label}` : (st.actOneDone ? '✓ set up by hand' : 'choosing…');

  $$('.step', rail).forEach((cell) => {
    const cellAct = +cell.dataset.act;
    const statusEl = cell.querySelector('.step-status');

    let state;
    if (cellAct === act) state = 'active';
    else if (cellAct < act || (cellAct === 1 && st.actOneDone)) state = 'done';
    else state = st.actOneDone ? 'done' : 'locked';
    // A later act the user has never reached is still locked even after Act I,
    // if nothing has been pushed yet — Act III has nothing to show until then.
    if (cellAct === 3 && cellAct !== act && !st.lastWriteAt) state = 'locked';
    cell.dataset.state = state;

    // Clickable only once Act I is behind us, and never on a locked cell.
    const clickable = st.actOneDone && state !== 'locked' && cellAct !== act;
    cell.dataset.clickable = String(clickable);
    cell.disabled = !clickable;

    if (statusEl) {
      if (cellAct === 1) statusEl.textContent = actOneStatus;
      else if (state === 'locked') statusEl.textContent = 'locked';
      else if (state === 'active') statusEl.textContent = cellAct === 2 ? 'building…' : 'on air';
      else statusEl.textContent = cellAct === 2 ? 'ready' : 'ready';
    }
  });
}

function railTarget(act) {
  if (act === 1) return 'a5';   // back into Act I means confirm settings, not the fork
  if (act === 2) return 'a7';
  return 'a8';
}

// ---------- the chrome bar --------------------------------------------------

function syncChrome() {
  const st = getState();
  const inActOne = (SCREEN_ACT[current] || 1) === 1;

  // The device status pill, and it is the whole of the chrome's device reporting now — the
  // countdown that sat beside it is gone, because every number in it was modelled.
  //
  // Shown in every act, including Act I. It used to hide there on the grounds that a user
  // still describing hardware is not watching it — but the board reports for itself the
  // whole time now, and a board that is awake and redrawing while you are on the settings
  // screen is exactly the thing you would want the chrome to tell you. What it still waits
  // for is having ANYTHING to say: a write of our own, or a report from the board.
  const pill = $('devicePill');
  const showDevice = !!(st.lastWriteAt || st.lastWokeAt || st.lastSleptAt);
  pill.hidden = !showDevice;

  if (showDevice) {
    // The three states, and the whole set. `{feed}-status` publishes `awake` or `sleeping`
    // (docs/marquee-status.md), device.js turns those into `deviceState`, and cycle.js
    // adds the one thing the feed cannot report: a board that proved it reports and then
    // went quiet. The derivation is imported rather than repeated because the Showtime
    // clock renders from the same call — this label and that countdown disagreeing is
    // the exact failure cycle.js exists to prevent.
    const phase = displayState(st);
    pill.className = `pill ${phase === 'redrawing' ? 'pill-on-air' : 'pill-asleep'}`;
    // Awake names the REDRAW rather than the state, because that is the part a user is
    // actually waiting on.
    pill.querySelector('[data-role="text"]').textContent =
      phase === 'offline' ? 'Offline' : phase === 'sleeping' ? 'Sleeping 💤' : 'Awake - Redrawing 🎨';
  }

  $('chromeNote').hidden = !inActOne;
}

/** Re-render the rail and chrome without changing screen. */
export function syncNav() {
  syncRail();
  syncChrome();
}

export function initRouter() {
  $$('#stepRail .step').forEach((cell) => {
    cell.addEventListener('click', () => {
      if (cell.dataset.clickable !== 'true') return;
      navigate(railTarget(+cell.dataset.act));
    });
  });

  // Any flow-state change can move the pill, the badge or a rail cell.
  return { syncNav };
}

/** Mark Act I complete — collapses the rail and unlocks navigation. */
export function completeActOne() {
  if (!getState().actOneDone) setState({ actOneDone: true });
  syncNav();
}
