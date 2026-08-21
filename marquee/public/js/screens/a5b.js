/**
 * A5b — Act I, CircuitPython only: configure Adafruit IO.
 *
 * Sits between A5 and A6 because it has to: the bundle A6 builds bakes in the
 * username, the key and the three feed keys, and until this screen has run those
 * keys are a guess. A board booting on a guessed feed key fetches nothing and draws
 * nothing, and there is no error anywhere to tell you why — which is the failure
 * this screen exists to prevent.
 *
 * Three fields and one action. The device name becomes the group's name, and its
 * slug becomes the group key; the feeds box below is a preview of what will be
 * created, and then the progress display for creating it.
 *
 * REUSE OVER REPLACE, always. An existing group is used as it stands and an existing
 * feed is left alone — this screen never renames or deletes anything on the account.
 */

import { ioGroupKey } from '../api.js';
import {
  MARQUEE_FEEDS, getGroup, createGroup, createGroupFeed, feedsIn,
} from '../provision.js';
import { getState, setState } from '../state.js';
import { navigate } from '../router.js';
import { $, val, toast, setCheck, slugifyKey, setFieldValue } from '../util.js';

/** What each feed is for, in the user's terms. The row's resting label, and the
 *  thing it goes back to saying if a retry clears an error. */
const PURPOSE = {
  bitmap: 'bitmap — the picture your board draws',
  sleep: 'sleep — how long it waits before waking',
  status: 'status — what your board reports back',
};

/** The label the primary button wears while requests are in flight. Named because
 *  the finally block reads it back to tell "nothing else set a label" from "a branch
 *  already said what happened". */
const BUSY_LABEL = 'Working…';

/** Set while a run is in flight, so the enter hook can't reset the dots underneath
 *  it and the button can't be double-fired. */
let running = false;

// ---------- the form -------------------------------------------------------

/** The group key, slugified from whatever is in the device-name field. */
function slug() {
  return slugifyKey($('a5bDevice')?.value);
}

/**
 * Mirror this screen's fields into the canonical settings fields.
 *
 * Those live in the Settings modal and are the app's real store — every other screen
 * reads `#ioUser`, `#ioKey` and `#ioGroup`, and main.js persists them by listening
 * for `input`. setFieldValue() raises that event, so writing through here is what
 * makes A5b's fields the same fields rather than a second copy that drifts.
 */
function mirrorToSettings() {
  setFieldValue('ioUser', ($('a5bUser')?.value || '').trim());
  setFieldValue('ioKey', $('a5bKey')?.value || '');
  setFieldValue('ioGroup', slug());
}

/**
 * The group key line and whether the action is available.
 *
 * The line shows the SLUG, not what was typed — "Kitchen Board" creates
 * `kitchen-board`, and the user should find that out here rather than in the IO web
 * UI later. A name with nothing slug-able in it leaves the button disabled.
 */
function syncForm() {
  renderGroupLine();
  const ready = !!($('a5bUser')?.value.trim()) && !!($('a5bKey')?.value) && !!slug();
  const btn = $('a5bCreate');
  if (btn && !running) btn.disabled = !ready;
}

/** The group key as it will actually be used. Read off the canonical field rather
 *  than recomputed from the name, because IO gets the last word on it — see the
 *  read-back in createGroupAndFeeds(). */
function renderGroupLine() {
  const el = $('a5bGroupKey');
  if (el) el.textContent = ioGroupKey() || '—';
}

/** Clear the credential error. Any edit to either field earns a clean slate — the
 *  message was about the values IO rejected, and these are no longer those. */
function clearKeyError() {
  const err = $('a5bKeyError');
  if (err) { err.hidden = true; err.textContent = ''; }
  $('a5bKey')?.removeAttribute('aria-invalid');
}

function showKeyError(msg) {
  const err = $('a5bKeyError');
  if (err) { err.hidden = false; err.textContent = msg; }
  $('a5bKey')?.setAttribute('aria-invalid', 'true');
}

// ---------- the feeds box --------------------------------------------------

/** Reset the three rows to pending, and clear whatever the last run concluded. */
function resetRows() {
  MARQUEE_FEEDS.forEach((f) => setCheck(f.rowId, 'wait', PURPOSE[f.key]));
  setOutcome('');
}

/**
 * The box at rest: green and settled if these feeds are already confirmed, neutral
 * and offering to create them otherwise.
 *
 * Called on entry and after any edit, so coming BACK to this screen from A6 shows
 * what is true rather than pretending nothing has happened — a row of grey dots over
 * a button labelled "create" would read as work still owed on feeds that exist.
 */
function renderRestingState() {
  if (alreadyConfirmed()) {
    MARQUEE_FEEDS.forEach((f) => setCheck(f.rowId, 'pass', `${PURPOSE[f.key]} — ready`));
    setOutcome(`${ioGroupKey()} and its three feeds are configured on Adafruit IO.`);
    setActionLabel('Continue');
    return;
  }
  resetRows();
  setActionLabel('Create group and feeds');
}

/** The one line under the rows that says how the run as a whole went. */
function setOutcome(text, tone = '') {
  const el = $('a5bOutcome');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
  el.className = tone === 'fail' ? 'field-error' : 'hint';
}

/** A row that failed says why on the row itself, because "something went wrong"
 *  three feeds deep is not an answer anyone can act on. */
function failRow(feed, why) {
  setCheck(feed.rowId, 'fail', `${PURPOSE[feed.key]} — ${why}`);
}

// ---------- the run --------------------------------------------------------

/**
 * The primary button's label.
 *
 * The corner marks are children of the button, so only the leading text node can be
 * rewritten — setting textContent would take the blueprint frame with it.
 */
function setActionLabel(text) {
  const btn = $('a5bCreate');
  if (btn) btn.firstChild.nodeValue = text;
}

/** Lock the form while requests are in flight. Nothing moves on the screen; the
 *  fields simply stop accepting edits that the run would not pick up. */
function setBusy(busy) {
  running = busy;
  ['a5bUser', 'a5bKey', 'a5bDevice'].forEach((id) => { const el = $(id); if (el) el.disabled = busy; });
  const btn = $('a5bCreate');
  if (btn) btn.disabled = busy;
}

/**
 * Whether the group and feeds on the account have already been confirmed for the key
 * the app would actually publish to.
 *
 * Not just `ioSetup === 'ready'`: a group edited since makes that claim about a
 * different group. Compared against the canonical field rather than a fresh slug of
 * the name, because that field is what every other screen reads — and IO is allowed
 * to have handed back a key that is not the one the name slugifies to.
 */
function alreadyConfirmed() {
  const st = getState();
  return st.ioSetup === 'ready' && !!st.ioGroupKey && st.ioGroupKey === ioGroupKey();
}

async function createGroupAndFeeds() {
  if (running) return;
  const user = ($('a5bUser').value || '').trim();
  const key = $('a5bKey').value || '';
  const name = ($('a5bDevice').value || '').trim();
  let groupKey = slug();
  if (!user || !key || !groupKey) return;

  mirrorToSettings();
  clearKeyError();
  resetRows();
  setBusy(true);
  setActionLabel(BUSY_LABEL);

  try {
    // 1. Look for the group. This is also the credential check — a bad username or key
    //    401s here, on a GET, so nothing has been written by the time we say so. There
    //    is no separate "validate" request: the endpoint that would have served one
    //    (`/{username}/user`) does not exist, and this call already knows the answer.
    const found = await getGroup(user, key, groupKey);
    if (!found.ok) {
      if (found.status === 401) {
        showKeyError('Adafruit IO rejected this username and key. Check both — nothing was created.');
      } else {
        setOutcome(reason(found, 'group'), 'fail');
      }
      return;
    }

    // 2. Reuse it if it is there; create it only if it is not.

    let group = found.data;
    const groupExisted = !!group;
    if (!group) {
      const made = await createGroup(user, key, groupKey, name);
      if (!made.ok) { setOutcome(reason(made, 'group'), 'fail'); return; }
      group = made.data;

      // IO gets the last word on the key. We ask for one, but it is free to derive
      // its own from the name, and a bundle written against the key we ASKED for
      // would point the board at a group that does not exist. Everything downstream
      // — the feed POSTs, the saved state, settings.toml — follows what came back.
      const actual = String(group?.key || '').trim();
      if (actual && actual !== groupKey) {
        groupKey = actual;
        setFieldValue('ioGroup', groupKey);
        renderGroupLine();
      }
    }

    // 3. What the group already holds, so step 4 only adds what is missing. This is
    //    also what makes a retry after a partial run safe to press.
    const present = feedsIn(group);

    // 4. One at a time — every CREATE counts against the account's rate limit, and
    //    three at once on a free account is how the third gets rejected for a reason
    //    that has nothing to do with what the user typed.
    let created = 0;
    let failed = 0;
    let historyWarning = false;
    for (const feed of MARQUEE_FEEDS) {
      const existing = present.get(feed.key);
      if (existing) {
        // Reuse over replace: an existing feed is left exactly as it is, even when
        // its history setting is wrong for us. But wrong here is not cosmetic — a
        // bitmap feed with history on rejects every publish — so it is said out
        // loud rather than discovered as a 422 two screens later.
        if (!feed.history && existing.history === true) {
          setCheck(feed.rowId, 'warn', `${PURPOSE[feed.key]} — already there, but its history is ON`);
          historyWarning = true;
        } else {
          setCheck(feed.rowId, 'pass', `${PURPOSE[feed.key]} — already there`);
        }
        continue;
      }
      const out = await createGroupFeed(user, key, groupKey, feed);
      if (out.ok) {
        setCheck(feed.rowId, 'pass',
          `${PURPOSE[feed.key]} — created${feed.history ? '' : ', history off'}`);
        created++;
      } else {
        failRow(feed, out.status === 403 ? 'feed limit reached' : out.error);
        failed++;
      }
    }

    if (failed) {
      // Whatever landed stays. The existence check above is what makes pressing the
      // button again finish the job rather than start it over.
      setOutcome(
        failed === MARQUEE_FEEDS.length && !groupExisted
          ? `${groupKey} was created but its feeds were not. Try again to finish.`
          : `${failed} feed${failed === 1 ? '' : 's'} could not be created. The rest are in place — try again to finish.`,
        'fail');
      setActionLabel('Retry');
      return;
    }

    setState({ ioSetup: 'ready', ioGroupKey: groupKey });

    if (historyWarning) {
      // The feeds exist, so setup is genuinely done — but publishing will fail until
      // this is changed, and it can only be changed on Adafruit IO. Do not advance
      // past a message the user has to act on.
      setOutcome(`${groupKey}.bitmap already existed with history turned ON. Adafruit IO caps a `
        + 'datum at 1 KB on such a feed and a panel image is around 20 KB, so pushes to it will be '
        + "rejected. Turn history off in that feed's settings on Adafruit IO, or delete the feed and "
        + 'run this again. Nothing here was changed.', 'fail');
      setActionLabel('Continue anyway');
      return;
    }

    if (!created) {
      // The case the right-hand rail promises. Say we did nothing rather than
      // claiming work, and let the user leave under their own steam — auto-advancing
      // past a message whose whole content is "we didn't need to do anything" gives
      // them no chance to read it.
      setOutcome(`Already configured — ${groupKey} and all three feeds were there. Nothing was changed.`);
      setActionLabel('Continue');
      return;
    }

    toast(`Created ${created} feed${created === 1 ? '' : 's'} in ${groupKey}`);
    navigate('a6');
  } finally {
    setBusy(false);
    // Every branch that concluded something has already said so on the button —
    // "Retry" after a partial run, "Continue" when there was nothing to do. What is
    // left is the branches that returned early on an error, and the success that
    // navigated away: both would otherwise leave the button reading "Working…" on a
    // screen where nothing is working.
    if ($('a5bCreate')?.firstChild.nodeValue === BUSY_LABEL) {
      setActionLabel(alreadyConfirmed() ? 'Continue' : 'Create group and feeds');
    }
    syncForm();
  }
}

/** Why a group-level call failed, in terms of what the user can do about it. */
function reason(out, what) {
  if (out.status === 403) {
    return `Your Adafruit IO plan will not allow another ${what}. Free up one, or upgrade at io.adafruit.com, then try again.`;
  }
  return `${out.error} — could not read or create the ${what}.`;
}

// ---------- boot -----------------------------------------------------------

export function initA5b({ onEnter }) {
  $('a5bBack').addEventListener('click', () => navigate('a5'));

  // A real escape hatch, same as A6's. The editor works without a board, and holding
  // someone in Act I because their network is down would be worse than letting them
  // design first — but the bundle they get next points at feeds that may not exist,
  // so say so plainly rather than letting them find out from a blank panel.
  $('a5bSkip').addEventListener('click', () => {
    setState({ ioSetup: 'skipped' });
    navigate('a6');
    toast('Skipped — the bundle will point at feeds that may not exist yet');
  });

  // Once these feeds are confirmed, the button is the way forward rather than a
  // second write. Re-running would only re-read the group to conclude what it
  // already concluded, and spend the account's rate limit doing it.
  $('a5bCreate').addEventListener('click', () => {
    if (alreadyConfirmed()) navigate('a6');
    else createGroupAndFeeds();
  });

  ['a5bUser', 'a5bKey', 'a5bDevice'].forEach((id) => {
    $(id).addEventListener('input', () => {
      clearKeyError();
      mirrorToSettings();
      // Editing after a run makes the result stale — the dots would otherwise keep
      // claiming feeds are ready under a group key that no longer applies.
      if (!running) renderRestingState();
      syncForm();
    });
  });

  $('a5bKeyReveal').addEventListener('click', () => {
    const input = $('a5bKey');
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    const btn = $('a5bKeyReveal');
    btn.textContent = shown ? 'Show' : 'Hide';
    btn.setAttribute('aria-pressed', String(!shown));
    btn.setAttribute('aria-label', shown ? 'Show the key' : 'Hide the key');
  });

  onEnter('a5b', () => {
    if (running) return;
    const st = getState();

    // The canonical fields are the source of truth — Settings may have been edited
    // since, and this screen must not show a stale copy of a credential.
    $('a5bUser').value = val('ioUser');
    $('a5bKey').value = $('ioKey')?.value || '';
    // The group key we resolved last time, else the name the user gave the marquee
    // on A5 — which is almost always the answer, and saves retyping it.
    $('a5bDevice').value = st.ioGroupKey || ioGroupKey() || val('marqueeName');

    // Before the staleness check below, which asks whether the confirmed group is
    // still the one we would publish to — a question about #ioGroup, and #ioGroup has
    // just been left behind by the device name we seeded a line ago.
    mirrorToSettings();

    // A group edited in Settings after setup invalidates the confirmation: the feeds
    // we verified are not the feeds we would now publish to.
    if (st.ioSetup === 'ready' && st.ioGroupKey !== ioGroupKey()) {
      setState({ ioSetup: 'pending' });
    }

    // The key field starts masked on every entry regardless of how it was left.
    $('a5bKey').type = 'password';
    $('a5bKeyReveal').textContent = 'Show';
    $('a5bKeyReveal').setAttribute('aria-pressed', 'false');
    $('a5bKeyReveal').setAttribute('aria-label', 'Show the key');

    clearKeyError();
    setBusy(false);
    renderRestingState();
    syncForm();
  });
}
