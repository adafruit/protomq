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
import { DISPLAY_PRESETS } from './presets.js';
import { $, $$, val } from './util.js';

/** Which act each screen belongs to, for the rail. */
const SCREEN_ACT = { a3: 1, a4: 1, a5: 1, a6: 1, a7: 2, a8: 3 };

const PATH_LABELS = { wippersnapper: 'WipperSnapper', circuitpython: 'CircuitPython' };

let current = null;
const enterHooks = new Map();

/** Register a callback run every time `screen` becomes visible. */
export function onEnter(screen, fn) {
  const list = enterHooks.get(screen) || [];
  list.push(fn);
  enterHooks.set(screen, list);
}

export function currentScreen() { return current; }

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

  // Breadcrumb leaf: the marquee's name, once it has one and setup is past.
  const name = val('marqueeName');
  const showLeaf = !!name && !inActOne;
  $('crumbSep').hidden = !showLeaf;
  $('crumbLeaf').hidden = !showLeaf;
  $('crumbLeaf').textContent = name;

  // The path badge appears the moment the fork is answered and stays for the
  // rest of the flow — it is how a user knows which of the two worlds they're in.
  const badge = $('pathBadge');
  if (st.firmwarePath) {
    badge.hidden = false;
    badge.textContent = PATH_LABELS[st.firmwarePath].toUpperCase();
  } else {
    badge.hidden = true;
  }

  // ON AIR / ASLEEP. Hidden until something has actually been written — before
  // that there is no panel state to report — and hidden throughout Act I, where
  // the user is still describing hardware rather than watching it.
  const pill = $('devicePill');
  if (!st.lastWriteAt || inActOne) {
    pill.hidden = true;
  } else {
    pill.hidden = false;
    const asleep = st.deviceState === 'asleep';
    const offline = st.deviceState === 'offline';
    pill.className = `pill ${asleep || offline ? 'pill-asleep' : 'pill-on-air'}`;
    pill.querySelector('[data-role="text"]').textContent =
      offline ? 'OFFLINE' : asleep ? 'ASLEEP' : 'ON AIR';
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

  // The marquee's name shows in the breadcrumb, so keep it live as it's typed.
  $('marqueeName')?.addEventListener('input', syncChrome);

  // The path badge is the route back to the fork from anywhere in the flow.
  $('pathBadge')?.addEventListener('click', () => navigate('a3'));

  // Any flow-state change can move the pill, the badge or a rail cell.
  return { syncNav };
}

/** Mark Act I complete — collapses the rail and unlocks navigation. */
export function completeActOne() {
  if (!getState().actOneDone) setState({ actOneDone: true });
  syncNav();
}
