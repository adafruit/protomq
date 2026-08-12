/**
 * A3 — Act I, step 1: what's running on your board?
 *
 * The single place the two firmware paths diverge. An explicit question, not an
 * inferred one — but pre-answered when we have evidence about the device.
 *
 * Detection, honestly: this stack has no firmware-reporting API. What it does
 * have is the ProtoMQ broker, and a board only shows up there if it speaks the
 * b2d/d2b protocol — which is the WipperSnapper transport. So "seen on the
 * broker" is real evidence of WipperSnapper, and the absence of it is evidence
 * of nothing at all. When we have no evidence, the spec's rule applies: neither
 * card is pre-selected and both buttons are secondary.
 */

import { BACKEND } from '../api.js';
import { setState, getState } from '../state.js';
import { navigate } from '../router.js';
import { $, val } from '../util.js';

let detected = null;   // 'wippersnapper' | null

async function detectFirmware() {
  const device = val('pmDevice') || 'magtag';
  try {
    const res = await fetch(`${BACKEND}/sleep/status`);
    if (!res.ok) return null;
    const s = await res.json();
    const seen = Array.isArray(s.clients) && s.clients.some((c) => String(c).includes(device));
    return seen || s.device === device ? 'wippersnapper' : null;
  } catch {
    return null;
  }
}

/**
 * The detected path gets the primary button; the other stays fully available as
 * a secondary. With nothing detected both are secondary, so the screen doesn't
 * imply a recommendation it can't support.
 */
function render() {
  const chosen = getState().firmwarePath;
  const device = val('pmDevice') || 'magtag';

  const tag = $('wipperTag');
  if (detected === 'wippersnapper') {
    tag.className = 'tag tag-accent';
    tag.textContent = `Detected on ${device}`;
  } else {
    tag.className = 'tag tag-neutral';
    tag.textContent = 'Not detected';
  }

  // A previously chosen path wins over detection — the user already answered.
  const preferred = chosen || detected;
  $('forkWipper').dataset.detected = String(preferred === 'wippersnapper');
  $('forkCircuitPython').dataset.detected = String(preferred === 'circuitpython');

  const wipperBtn = $('useWippersnapper');
  const cpyBtn = $('useCircuitPython');
  wipperBtn.className = `btn blueprint ${preferred === 'wippersnapper' ? 'btn-primary' : 'btn-secondary'}`;
  cpyBtn.className = `btn blueprint ${preferred === 'circuitpython' ? 'btn-primary' : 'btn-secondary'}`;
}

function choose(path) {
  setState({ firmwarePath: path });
  navigate('a4');
}

export function initA3({ onEnter }) {
  $('useWippersnapper').addEventListener('click', () => choose('wippersnapper'));
  $('useCircuitPython').addEventListener('click', () => choose('circuitpython'));

  onEnter('a3', async () => {
    render();                       // paint immediately with what we know
    detected = await detectFirmware();
    render();                       // then again once the probe answers
  });
}
