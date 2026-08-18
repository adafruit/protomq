/**
 * Boot.
 *
 * Order matters in two places and nowhere else:
 *   - initConfig() runs before anything reads the display descriptor, because it
 *     is what restores it from localStorage and pushes it into `display`.
 *   - the screen modules register their enter hooks before the first navigate(),
 *     or the landing screen would miss its own hook.
 */

import { BACKEND } from './api.js';
import { initConfig, configChanged } from './config.js';
import { initDoc, deserialize, saveCanvasNow } from './doc.js';
import { initRender } from './render.js';
import { initFeeds } from './feeds.js';
import { initIconFont } from './elements.js';
import { initDevice, scheduleWakeResponseSync } from './device.js';
import { initKeyboard } from './selection.js';
import { initRouter, navigate, onEnter, syncNav, actOneEntry, editorEntry } from './router.js';
import { getState, subscribe, resetFlow } from './state.js';
import { initA3 } from './screens/a3.js';
import { initA4 } from './screens/a4.js';
import { initA5 } from './screens/a5.js';
import { initA6 } from './screens/a6.js';
import { initA7 } from './screens/a7.js';
import { initA8 } from './screens/a8.js';
import { $, wireModal, openModal, closeModal, toast } from './util.js';

// ---------- settings persistence --------------------------------------------
//
// Credentials, the ProtoMQ target and the sleep behaviour live in localStorage
// rather than on the server: they are per-browser bench setup, and keeping them
// client-side means they survive a server restart.
//
// NOTE: the AIO key is stored here in plaintext. Acceptable for a local dev
// tool on your own machine; it is also written into the CircuitPython bundle,
// which says so in its own README.

const SETTINGS_KEY = 'marquee.settings';
const SETTINGS_FIELDS = [
  'ioUser', 'ioKey', 'ioFeed', 'pmUser', 'pmDevice',
  'sleepDuration', 'writeRetryWindow',
  // Lives in A7's inspector rather than this modal, but it has no backing field
  // to be a view onto the way #wakeInterval is, so it persists on its own.
  'wakeAlarm',
];

function saveSettings() {
  const data = { ioProd: !!$('ioProd')?.checked };
  SETTINGS_FIELDS.forEach((id) => { if ($(id)) data[id] = $(id).value; });
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch { /* storage disabled/full */ }
}

function restoreSettings() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch { /* corrupt/blocked */ }
  SETTINGS_FIELDS.forEach((id) => {
    if ($(id) && typeof data[id] === 'string') $(id).value = data[id];
  });
  if ($('ioProd')) $('ioProd').checked = !!data.ioProd;
}

function initSettings() {
  wireModal('settingsModal', ['settingsClose', 'settingsDone']);
  $('btnSettings')?.addEventListener('click', () => openModal('settingsModal'));

  restoreSettings();

  SETTINGS_FIELDS.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      saveSettings();
      // The refresh interval is what a sleeping device is re-registered with —
      // and now also what picks its sleep mode (sleepModeFor in config.js) — so an
      // edit here has to reach the device path exactly like a pin change does. It
      // does not stale a downloaded bundle: cfg-marquee.json carries no timing, and
      // code.py owns its own.
      //
      // wakeAlarm is deliberately NOT in here: it reaches a CircuitPython board
      // over the sleep feed, so it neither re-registers a broker cycle nor
      // invalidates a bundle.
      if (id === 'sleepDuration') {
        configChanged();
        scheduleWakeResponseSync();
      }
    });
  });
  $('ioProd')?.addEventListener('change', saveSettings);

  // Re-run Act I from the fork. Only the flow record is cleared — the panel
  // descriptor, credentials and dashboard are bench setup and survive, exactly
  // as they do through "Reset state".
  $('restartSetup')?.addEventListener('click', () => {
    if (!confirm('Start setup over?\n\nActs I–III run again from the firmware question. '
      + 'Your panel settings, Adafruit IO credentials and current dashboard are kept.')) return;
    resetFlow();
    closeModal('settingsModal');
    navigate('a3');
    toast('Setup restarted — pick the firmware your board is running');
  });
}

// ---------- canvas restore --------------------------------------------------

/**
 * The MVP persisted canvas.json on every edit but never read it back, so a
 * reload silently dropped the layout. Now that the whole flow survives a reload
 * (firmware path, panel, display config, bundle state), losing only the artwork
 * would be the odd one out — so the document is restored too.
 *
 * Only the ELEMENTS are restored. The panel descriptor comes from the Act I
 * config in localStorage, which is the thing the user actually chose — see the
 * keepDisplay note in doc.js.
 *
 * A failure here is not fatal: an empty canvas is a valid starting state, and a
 * corrupt file should not stop the editor from opening.
 */
async function restoreCanvas() {
  try {
    const res = await fetch(BACKEND + '/canvas');
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    const doc = body?.doc ?? body;
    if (!doc || !Array.isArray(doc.elements) || doc.elements.length === 0) return false;
    deserialize(doc, { keepDisplay: true });
    return true;
  } catch {
    return false;
  }
}

// ---------- where to land ---------------------------------------------------

function landingScreen() {
  const st = getState();
  if (!st.actOneDone) return actOneEntry();
  // Coming back to a sleeping device should show the sleep state, not the
  // editor — that is the screen that explains why nothing is updating.
  if (st.deviceState === 'asleep' && st.lastWriteAt) return 'a8';
  if (st.lastScreen && st.lastScreen !== 'a8') return st.lastScreen;
  return editorEntry();
}

// ---------- go --------------------------------------------------------------

async function boot() {
  initRouter();
  initSettings();
  initConfig();
  initDoc();
  initRender();
  initFeeds();
  initDevice();
  initKeyboard();

  initA3({ onEnter });
  initA4({ onEnter });
  initA5({ onEnter });
  initA6({ onEnter });
  initA7({ onEnter });
  initA8({ onEnter });

  // Any flow-state change can move the rail, the path badge or the device pill.
  subscribe(() => syncNav());

  const restored = await restoreCanvas();
  navigate(landingScreen());
  if (!restored) saveCanvasNow();   // render + persist the initial (empty) state

  // After the restore, not before: it re-draws the gauges that show an icon once
  // the Font Awesome face resolves, and on a cold load those gauges don't exist yet
  // when boot starts. Deliberately not awaited — the editor must not wait on a font.
  initIconFont();
}

boot().catch((err) => {
  console.error('Marquee failed to start', err);
  toast('Marquee failed to start — see the console');
});
