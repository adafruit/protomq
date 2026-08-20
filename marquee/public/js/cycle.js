/**
 * What the display is doing, from what the board said it is doing.
 *
 * ONE derivation, read by both consumers — the chrome pill (router.js) and the Showtime
 * bar (screens/a8.js). They are two views of the same question, and while they answered it
 * separately they disagreed: the pill read `deviceState` alone and said Sleeping directly
 * above a line reading "board reported · woke 4:39:35 PM".
 *
 * THREE states, and no arithmetic anywhere in the file. `{feed}-status` publishes `awake`
 * when the board comes up and `sleeping` when it arms its alarm (docs/marquee-status.md);
 * device.js writes those into flow state; a board that has proved it reports and then goes
 * quiet is the third. Between the two reports the board is up — cooling down or flashing,
 * which cannot be told apart from here and does not need to be.
 *
 * There used to be a modelled cycle in here: a fitted panel-refresh time, a network
 * allowance, a frame minimum, a wake time rolled forward by whole periods, and a countdown
 * drawn from all of it. It was an attempt to answer from the outside a question the board
 * answers itself, and on real hardware it was not close — a 2.13" tri-color with BUSY
 * unwired spends a flat 40s in refresh and up to 180s more waiting for the frame to age,
 * against a 14s estimate. What replaced it is this file plus the board's own timestamps,
 * which A8 prints verbatim instead of counting down.
 *
 * Deliberately the bottom of the module graph — state.js and nothing else. It has to be
 * importable from both router.js and device.js, and device.js already imports router.js,
 * so anything reaching back the other way would close a cycle.
 */

import { getState } from './state.js';

/**
 * True while a reported wake has not been answered by a reported sleep.
 *
 * The bracket. The board is up, on its own account, and the only thing that closes this is
 * hearing from it again — not a timer, and not anything computed here.
 */
export function takeInFlight(st = getState()) {
  return !!st.lastWokeAt && (!st.lastSleptAt || st.lastSleptAt < st.lastWokeAt);
}

/**
 * 'offline' | 'redrawing' | 'sleeping' — the whole vocabulary.
 *
 * `offline` first: it is the only one that is a judgement about the board rather than a
 * report from it, and it outranks a stale report by definition.
 *
 * The bracket second, because `deviceState` is not always the board's word. The push used
 * to write 'asleep' the moment it published a window — and a window is a REQUEST, taking
 * effect at the board's next fetch. It no longer does that for a board that reports, but
 * the ordering here is what makes the rule hold regardless: a reported wake with no
 * reported sleep after it means the board is up, whatever anything else says.
 */
export function displayState(st = getState()) {
  if (st.deviceState === 'offline') return 'offline';
  if (takeInFlight(st)) return 'redrawing';
  return st.deviceState === 'asleep' ? 'sleeping' : 'redrawing';
}
