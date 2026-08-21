/**
 * A5 — Act I, step 3: confirm settings.
 *
 * Shows what the preset filled in and keeps the intimidating fields collapsed.
 * The form itself lives in config.js (it is read from every other screen); this
 * module owns the screen around it: the device checks, the send action, and
 * where the two firmware paths go next.
 */

import { BACKEND } from '../api.js';
import { syncDerivedUI } from '../config.js';
import { publishDisplayConfig } from '../device.js';
import { isBackendOnline } from '../render.js';
import { getState } from '../state.js';
import { navigate, completeActOne, editorEntry } from '../router.js';
import { $, val, toast, setCheck, fmtBytes } from '../util.js';

/**
 * The three device checks. Each says what we actually know rather than what
 * would look reassuring — "the broker is reachable" is not the same claim as
 * "your board is online", and conflating them is how a user ends up waiting on
 * a device that was never there.
 */
async function runDeviceChecks() {
  const device = val('pmDevice') || 'magtag';

  setCheck('chkOnline', 'wait', 'Checking the broker…');
  setCheck('chkFirmware', 'wait', 'Firmware support unknown');

  if (!isBackendOnline()) {
    setCheck('chkOnline', 'fail', 'Render backend unreachable — start server.js');
    setCheck('chkFirmware', 'wait', 'Cannot check firmware without the backend');
    return;
  }

  try {
    const res = await fetch(`${BACKEND}/sleep/status`);
    const s = res.ok ? await res.json() : null;
    if (!s) {
      setCheck('chkOnline', 'warn', 'Broker did not answer');
    } else if (Array.isArray(s.clients) && s.clients.some((c) => String(c).includes(device))) {
      setCheck('chkOnline', 'pass', `${device} is on the broker`);
    } else {
      // Not an error: the mailbox is only opened once a cycle is armed, so a
      // quiet broker before the first push is the normal state.
      setCheck('chkOnline', 'warn', `${device} not seen yet — it checks in on first contact`);
    }
  } catch {
    setCheck('chkOnline', 'fail', 'Could not reach the broker');
  }

  const path = getState().firmwarePath;
  if (path === 'circuitpython') {
    setCheck('chkFirmware', 'wait', 'CircuitPython — the bundle carries the display settings');
  } else {
    setCheck('chkFirmware', 'pass', 'Display config will be sent over the air');
  }
}

async function sendAndOpenEditor() {
  const btn = $('a5Next');
  const dbg = $('a5Debug');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  dbg.textContent = '';
  setCheck('chkAck', 'wait', 'Waiting for config acknowledgement');

  try {
    const out = await publishDisplayConfig();
    if (out.ok) {
      setCheck('chkAck', 'pass', `Config sent — ${fmtBytes(out.bytes)} to ${out.topic}`);
      toast(`Display configuration published to ${out.topic}`);
    } else {
      // A failed send is not a reason to trap the user in Act I — the editor
      // works without a live board, and the descriptor can be re-sent from here
      // at any time. Say what failed and carry on.
      setCheck('chkAck', 'fail', `Config not delivered: ${out.error}`);
      dbg.textContent = `Failed (${out.status || '—'}): ${out.error}`;
      toast('Could not send the display config — opening the editor anyway');
    }
  } catch {
    setCheck('chkAck', 'fail', 'Backend unreachable — config not sent');
    dbg.textContent = 'Backend unreachable.';
    toast('Backend unreachable — opening the editor anyway');
  } finally {
    btn.disabled = false;
    syncSendLabel();
  }

  completeActOne();
  navigate(editorEntry());
}

/** On the CircuitPython path there is nothing to send over the air yet — the
 *  settings travel in the bundle, so the button says so. */
function syncSendLabel() {
  const cpy = getState().firmwarePath === 'circuitpython';
  $('a5Next').textContent = cpy ? 'Next — build the code bundle' : 'Send to device & open editor';
}

export function initA5({ onEnter }) {
  $('a5Back').addEventListener('click', () => navigate('a4'));

  $('a5Next').addEventListener('click', () => {
    if (getState().firmwarePath === 'circuitpython') {
      // The board isn't running Marquee's firmware yet, so there is nobody to send a
      // descriptor to. Configure the IO feeds first — A6's bundle bakes their keys
      // in, so the bundle cannot be built before they are known to exist.
      completeActOne();
      navigate('a5b');
      return;
    }
    sendAndOpenEditor();
  });

  onEnter('a5', () => {
    syncDerivedUI();
    syncSendLabel();
    runDeviceChecks();
  });
}
