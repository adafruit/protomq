/**
 * A4 — Act I, step 2: pick the display.
 *
 * Product cards, not a dropdown of driver chips. Choosing a card applies the
 * whole preset — resolution, rotation, colour mode, driver, panel id and every
 * SPI pin — so A5 is a confirmation rather than a form to fill in.
 *
 * The photo slots are grey placeholders by design: real Adafruit product shots
 * go there, and the design system duotones them through the .duotone wrapper.
 */

import { DISPLAY_PRESETS, searchPresets } from '../presets.js';
import { applyDisplayPreset } from '../config.js';
import { getState, setState } from '../state.js';
import { navigate } from '../router.js';
import { $, escapeHtml, escapeAttr, show, toast } from '../util.js';

function cardHTML(key, selected) {
  const p = DISPLAY_PRESETS[key];
  return `<button type="button" class="panel-card card blueprint" data-preset="${escapeAttr(key)}" data-selected="${selected}">
    <i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
    <!-- Placeholder only. The design system duotones content photography through
         a .duotone wrapper, but washing a flat grey box in the accent just turns
         it into a flat blue box — add .duotone here when real product shots go in. -->
    <span class="photo">PHOTO</span>
    <span class="body">
      <span class="name">${escapeHtml(p.label)}</span>
      <span class="spec">${escapeHtml(p.spec)}</span>
      ${selected ? '<span class="tag tag-accent">Selected</span>' : ''}
    </span>
  </button>`;
}

function renderGrid() {
  const q = $('panelSearch').value || '';
  const keys = searchPresets(q);
  const sel = getState().selectedPanel;
  $('panelGrid').innerHTML = keys.map((k) => cardHTML(k, k === sel)).join('');
  show($('panelEmpty'), keys.length === 0);
  $('a4Next').disabled = !sel;
}

export function initA4({ onEnter }) {
  $('panelSearch').addEventListener('input', renderGrid);

  $('panelGrid').addEventListener('click', (e) => {
    const card = e.target.closest('.panel-card');
    if (!card) return;
    const key = card.dataset.preset;
    setState({ selectedPanel: key });
    // Apply silently — the card going "Selected" already says what happened, and
    // a toast on every card click would be noise while comparing panels.
    applyDisplayPreset(key, { silent: true });
    renderGrid();
  });

  // Back to the fork. Without this the firmware path is a one-way door: the
  // collapsed rail deliberately returns to A5, so A3 would be unreachable for
  // the rest of the session once answered.
  $('a4Back').addEventListener('click', () => navigate('a3'));

  $('a4Next').addEventListener('click', () => {
    if (!getState().selectedPanel) { toast('Choose a display first'); return; }
    navigate('a5');
  });

  // "Set it up by hand" drops straight into A5 with the advanced disclosure
  // open and no preset selected, which is what makes "Reset to preset" inert
  // and the heading read differently.
  $('manualSetup').addEventListener('click', (e) => {
    e.preventDefault();
    setState({ selectedPanel: null });
    navigate('a5');
    $('advanced').open = true;
  });

  onEnter('a4', renderGrid);
}
