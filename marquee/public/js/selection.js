/**
 * Selection and the inspector.
 *
 * refreshProps() re-renders the whole inspector body from the selected node on
 * every change. That is deliberate — element state lives on the Konva node, not
 * in a parallel view model, so there is exactly one source of truth. The cost is
 * that any handler which fires per-keystroke must NOT call refreshProps(), or it
 * would blow away focus mid-typing; the battery condition rows below are the
 * place that matters and they say so.
 */

import { display, PALETTES, neutralShades } from './palette.js';
import { layer, tr, snap, editorOpts, suspendDitherPreview, scheduleDitherRefresh } from './stage.js';
import {
  isWidget, rebuildWidget, elementColor, setElementColor, wireNode, nextId,
  INDICATOR_OPS, MIN_WIDGET_W, indicatorValueKnown, batteryFraction,
} from './elements.js';
import { openFeedPicker, refreshFeedElements } from './feeds.js';
import { $, escapeHtml, escapeAttr, toast } from './util.js';

export let selected = null;

export function select(node) {
  selected = node;
  if (node) {
    const etype = node.getAttr('etype');
    if (etype === 'divider')
      tr.enabledAnchors(['middle-left', 'middle-right', 'top-center', 'bottom-center']);
    else if (etype === 'gauge' || etype === 'indicator' || etype === 'battery')
      tr.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
    else if (etype === 'image')
      tr.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right',
                         'middle-left', 'middle-right', 'top-center', 'bottom-center']);
    else
      tr.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right']);
    // An explicit allow-list: an etype omitted here silently gets keepRatio(false),
    // which would let the indicator lamp be dragged into an ellipse.
    tr.keepRatio(etype === 'image' || etype === 'label' || etype === 'gauge'
      || etype === 'linechart' || etype === 'indicator' || etype === 'battery');
    tr.nodes([node]);
  } else {
    tr.nodes([]);
  }
  refreshProps();
}

/**
 * `target` names the node attribute a row writes to (e.g. 'onColor'), for
 * elements that carry more than one color. Omitted = the plain single-ink row,
 * which routes through setElementColor. `colors` narrows the offered set — the
 * battery passes neutralShades() so a grey ramp never offers red or yellow.
 */
function swatchHTML(current, target, colors = PALETTES[display.type]) {
  return `<div class="swatches"${target ? ` data-target="${target}"` : ''}>`
    + colors.map((c) =>
      `<button type="button" class="swatch" data-active="${c === current}" data-color="${c}" style="background:${c}" aria-label="Set color ${c}"></button>`
    ).join('') + '</div>';
}

export function refreshProps() {
  const body = $('propBody');
  if (!body) return;

  if (!selected) {
    body.innerHTML = `<span class="label">Nothing selected</span>
      <p class="hint">Drag to move. Double-click a label to rename it. Corner handles scale
      type, side handles resize the text box. Arrow keys nudge, <span class="mono">⌫</span> deletes,
      <span class="mono">⌘D</span> duplicates.</p>`;
    return;
  }

  const n = selected;
  const etype = n.getAttr('etype');
  let html = `<span class="label">Selected · ${etype}</span>
    <div class="prop-row">
      <span class="label">X</span><input type="number" id="pX" value="${Math.round(n.x())}">
      <span class="label">Y</span><input type="number" id="pY" value="${Math.round(n.y())}">
    </div>`;

  if (etype === 'label') {
    html += `
    <span class="label">Text</span>
    <textarea id="pText">${escapeHtml(n.text())}</textarea>
    <div class="prop-row">
      <span class="label">Size</span><input type="number" id="pSize" value="${n.fontSize()}" min="4" max="512">
      <select id="pFont" style="flex:1">
        <option value="monospace" ${n.fontFamily() === 'monospace' ? 'selected' : ''}>Mono</option>
        <option value="sans-serif" ${n.fontFamily() === 'sans-serif' ? 'selected' : ''}>Sans</option>
        <option value="serif" ${n.fontFamily() === 'serif' ? 'selected' : ''}>Serif</option>
      </select>
    </div>
    <div class="prop-row">
      <span class="label">Box</span><input type="number" id="pBoxW" min="8"
        value="${n.attrs.width !== undefined ? Math.round(n.width()) : ''}" placeholder="auto">
      <select id="pAlign" style="flex:1">
        <option value="left" ${n.align() === 'left' ? 'selected' : ''}>Left</option>
        <option value="center" ${n.align() === 'center' ? 'selected' : ''}>Center</option>
        <option value="right" ${n.align() === 'right' ? 'selected' : ''}>Right</option>
      </select>
    </div>`;
  } else if (etype === 'indicator') {
    const bound = !!n.getAttr('feedKey');
    const known = indicatorValueKnown(n);
    html += `
    <div class="prop-row">
      <span class="label">Size</span><input type="number" id="pIndSize" value="${n.getAttr('w')}" min="6" max="512">
    </div>
    <span class="label">Feed</span>
    <div class="prop-row">
      <span class="mono" style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; font-size:12px; ${bound ? '' : 'opacity:.6;'}">${
        bound ? escapeHtml(n.getAttr('feedName') || n.getAttr('feedKey')) : '(not bound)'}</span>
      <button type="button" class="btn btn-sm" id="pIndFeed">${bound ? 'Change' : 'Choose feed'}</button>
    </div>
    <div class="prop-row">
      <span class="label">Value</span>
      <span class="mono" style="flex:1; font-size:12px; ${known ? '' : 'opacity:.6;'}">${
        known ? escapeHtml(String(n.getAttr('value'))) : '(unknown)'}</span>
      <button type="button" class="btn btn-sm" id="pIndRefresh"${bound ? '' : ' disabled'}>↻</button>
    </div>
    <span class="label">Condition</span>
    <div class="prop-row">
      <select id="pIndOp" style="flex:0 0 64px">${INDICATOR_OPS.map((o) =>
        `<option value="${o.op}"${n.getAttr('op') === o.op ? ' selected' : ''}>${o.label}</option>`).join('')}</select>
      <input type="text" id="pIndCmp" style="flex:1" value="${escapeAttr(String(n.getAttr('cmp') ?? ''))}">
    </div>
    <p class="hint">Lamp is <b>On</b> when the condition holds. Compared as numbers when both
      sides are numeric, otherwise as case-insensitive text.${
      bound ? '' : ' Unbound and unknown values read as <b>Off</b>.'}</p>
    <span class="label">On colour</span>${swatchHTML(n.getAttr('onColor'), 'onColor')}
    <span class="label">Off colour</span>${swatchHTML(n.getAttr('offColor'), 'offColor')}`;
  } else if (etype === 'battery') {
    const bound = !!n.getAttr('feedKey');
    const frac = batteryFraction(n);
    const shades = neutralShades();
    const conds = n.getAttr('conds') || [];
    html += `
    <div class="prop-row">
      <span class="label">Size</span><input type="number" id="pBatSize" value="${n.getAttr('w')}" min="${MIN_WIDGET_W.battery}" max="512">
    </div>
    <span class="label">Feed</span>
    <div class="prop-row">
      <span class="mono" style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; font-size:12px; ${bound ? '' : 'opacity:.6;'}">${
        bound ? escapeHtml(n.getAttr('feedName') || n.getAttr('feedKey')) : '(not bound)'}</span>
      <button type="button" class="btn btn-sm" id="pBatFeed">${bound ? 'Change' : 'Choose feed'}</button>
    </div>
    <div class="prop-row">
      <span class="label">Value</span>
      <span class="mono" style="flex:1; font-size:12px; ${frac === null ? 'opacity:.6;' : ''}">${
        frac === null
          ? (n.getAttr('feedValue')
              ? escapeHtml(String(n.getAttr('feedValue'))) + ' (not a number)' : '(unknown)')
          : escapeHtml(String(n.getAttr('feedValue')))}</span>
      <button type="button" class="btn btn-sm" id="pBatRefresh"${bound ? '' : ' disabled'}>↻</button>
    </div>
    <label class="check-row"><input type="checkbox" id="pBatPct"${
      n.getAttr('showPct') ? ' checked' : ''}> Show percentage</label>
    <div class="prop-row" style="margin-top:4px">
      <span class="label" style="flex:1">Conditions</span>
      <button type="button" class="btn btn-sm" id="pBatCondAdd">+ Add</button>
    </div>`
      + (conds.length ? conds.map((c, i) => `
    <div class="prop-row">
      <select id="pBatCondOp${i}" style="flex:0 0 64px">${INDICATOR_OPS.map((o) =>
        `<option value="${o.op}"${c.op === o.op ? ' selected' : ''}>${o.label}</option>`).join('')}</select>
      <input type="text" id="pBatCondCmp${i}" style="flex:1; width:0; min-width:0" value="${escapeAttr(String(c.cmp ?? ''))}">
      <button type="button" class="btn btn-sm btn-danger" id="pBatCondDel${i}" title="Remove condition">×</button>
    </div>
    ${swatchHTML(c.color, 'cond:' + i, shades)}`).join('')
        : '<p class="hint">No conditions — the bar always uses the default shade.</p>')
      + `
    <span class="label">Default (no match)</span>${swatchHTML(n.getAttr('defaultShade'), 'defaultShade', shades)}
    <p class="hint">The value fills the bar as a percentage (0–100). Conditions are checked top to
      bottom and the <b>first</b> one that holds picks the fill shade. A value that isn't a number
      draws an <b>empty</b> bar but can still match a condition.</p>`;
  } else if (isWidget(n)) {
    html += `
    <div class="prop-grid">
      <label class="field"><span class="label">Width</span>
        <input type="number" id="pW" value="${n.getAttr('w')}" min="40"></label>`
      + (etype === 'linechart'
        ? `<label class="field"><span class="label">Height</span>
             <input type="number" id="pH" value="${n.getAttr('h')}" min="30"></label>`
        : '')
      + `</div>
    <label class="field"><span class="label">Title</span>
      <input type="text" id="pTitle" value="${escapeAttr(String(n.getAttr('title') || ''))}"></label>`;
  } else if (etype === 'image') {
    const natW = n.getAttr('natW'), natH = n.getAttr('natH');
    html += `
    <div class="prop-row">
      <span class="label">W</span><input type="number" id="pImgW" value="${Math.round(n.width())}" min="1">
      <span class="label">H</span><input type="number" id="pImgH" value="${Math.round(n.height())}" min="1">
    </div>
    <label class="check-row"><input type="checkbox" id="pLock" checked> Lock aspect ratio</label>
    <button type="button" class="btn btn-sm btn-block" id="pImgReset">Reset to ${natW}×${natH}</button>
    <p class="hint">Dithered to the panel palette on render — no ink swatch.</p>`;
  } else {
    html += `
    <div class="prop-row">
      <span class="label">L</span><input type="number" id="pLen" value="${Math.round(n.width())}" min="1">
      <span class="label">W</span><input type="number" id="pThick" value="${Math.round(n.height())}" min="1">
    </div>
    <button type="button" class="btn btn-sm btn-block" id="pFlip">Rotate 90°</button>`;
  }

  // Images carry their own colors; everything else gets an ink swatch. For an
  // indicator that ink is the lamp's outline (its fill comes from On/Off above);
  // same for a battery, whose fill comes from the conditions.
  html += (etype === 'image' ? ''
    : `<span class="label">${etype === 'indicator' || etype === 'battery' ? 'Outline' : 'Ink'}</span>`
      + swatchHTML(elementColor(n), undefined,
          etype === 'battery' ? neutralShades() : PALETTES[display.type]))
    + `<div class="hr"></div>
    <div class="prop-row">
      <button type="button" class="btn btn-sm" id="pDuplicate" style="flex:1">Duplicate</button>
      <button type="button" class="btn btn-sm btn-danger" id="pDelete" style="flex:1">Delete</button>
    </div>`;

  body.innerHTML = html;

  const bind = (id, fn) => {
    const el = $(id);
    if (el) el.addEventListener(el.tagName === 'BUTTON' ? 'click' : 'input', fn);
  };

  bind('pX', (e) => n.x(+e.target.value || 0));
  bind('pY', (e) => n.y(+e.target.value || 0));
  bind('pText', (e) => n.text(e.target.value));
  bind('pSize', (e) => n.fontSize(Math.max(4, +e.target.value || 4)));
  bind('pFont', (e) => n.fontFamily(e.target.value));
  bind('pBoxW', (e) => {
    const v = +e.target.value;
    n.setAttr('width', v >= 8 ? Math.round(v) : undefined); // blank = auto-size to text
  });
  bind('pAlign', (e) => n.align(e.target.value));
  bind('pLen', (e) => n.width(Math.max(1, +e.target.value || 1)));
  bind('pThick', (e) => n.height(Math.max(1, +e.target.value || 1)));
  bind('pFlip', () => { const w = n.width(); n.width(n.height()); n.height(w); refreshProps(); });
  bind('pW', (e) => { n.setAttr('w', Math.max(40, Math.round(+e.target.value) || 40)); rebuildWidget(n); });
  bind('pH', (e) => { n.setAttr('h', Math.max(30, Math.round(+e.target.value) || 30)); rebuildWidget(n); });
  bind('pTitle', (e) => { n.setAttr('title', e.target.value); rebuildWidget(n); });

  const ratio = etype === 'image' ? n.getAttr('natW') / n.getAttr('natH') : 1;
  bind('pImgW', (e) => {
    const w = Math.max(1, Math.round(+e.target.value) || 1);
    n.width(w);
    if ($('pLock').checked) {
      n.height(Math.max(1, Math.round(w / ratio)));
      $('pImgH').value = Math.round(n.height());
    }
    tr.forceUpdate();
  });
  bind('pImgH', (e) => {
    const h = Math.max(1, Math.round(+e.target.value) || 1);
    n.height(h);
    if ($('pLock').checked) {
      n.width(Math.max(1, Math.round(h * ratio)));
      $('pImgW').value = Math.round(n.width());
    }
    tr.forceUpdate();
  });
  bind('pImgReset', () => {
    n.width(n.getAttr('natW'));
    n.height(n.getAttr('natH'));
    tr.forceUpdate();
    refreshProps();
  });

  bind('pIndSize', (e) => { n.setAttr('w', Math.max(6, Math.round(+e.target.value) || 6)); rebuildWidget(n); });
  bind('pIndOp', (e) => { n.setAttr('op', e.target.value); rebuildWidget(n); });
  bind('pIndCmp', (e) => { n.setAttr('cmp', e.target.value); rebuildWidget(n); });
  bind('pIndFeed', () => openFeedPicker(n));
  bind('pIndRefresh', async () => {
    const ok = await refreshFeedElements([n]);
    rebuildWidget(n);
    refreshProps();
    toast(ok ? `${n.getAttr('feedName') || 'Feed'} = ${n.getAttr('value')}` : 'Could not read the feed');
  });

  bind('pBatSize', (e) => {
    const min = MIN_WIDGET_W.battery;
    n.setAttr('w', Math.max(min, Math.round(+e.target.value) || min));
    rebuildWidget(n);
  });
  bind('pBatPct', (e) => { n.setAttr('showPct', e.target.checked); rebuildWidget(n); });
  bind('pBatFeed', () => openFeedPicker(n));
  bind('pBatRefresh', async () => {
    const ok = await refreshFeedElements([n]);
    rebuildWidget(n);
    refreshProps();
    toast(ok ? `${n.getAttr('feedName') || 'Feed'} = ${n.getAttr('feedValue')}`
             : 'Could not read the feed');
  });

  // Conditions are a variable-length list, so the rows are bound by index. The
  // op and cmp handlers deliberately DON'T call refreshProps() — it replaces the
  // whole panel via innerHTML, which would blow away focus on every keystroke.
  // Add and remove are buttons, so re-rendering there is safe and necessary.
  const setConds = (fn) => {
    const conds = (n.getAttr('conds') || []).map((c) => ({ ...c }));
    fn(conds);
    n.setAttr('conds', conds);
    rebuildWidget(n);
  };
  (etype === 'battery' ? (n.getAttr('conds') || []) : []).forEach((_, i) => {
    bind(`pBatCondOp${i}`, (e) => setConds((cs) => { cs[i].op = e.target.value; }));
    bind(`pBatCondCmp${i}`, (e) => setConds((cs) => { cs[i].cmp = e.target.value; }));
    bind(`pBatCondDel${i}`, () => { setConds((cs) => { cs.splice(i, 1); }); refreshProps(); });
  });
  bind('pBatCondAdd', () => {
    // Seed from the last row so adding a second threshold is a tweak, not a retype.
    setConds((cs) => {
      const prev = cs[cs.length - 1];
      cs.push({
        op: prev ? prev.op : 'lt',
        cmp: prev ? prev.cmp : '20',
        color: n.getAttr('defaultShade'),
      });
    });
    refreshProps();
  });

  bind('pDelete', () => { n.destroy(); select(null); suspendDitherPreview(); scheduleDitherRefresh(); });
  bind('pDuplicate', () => duplicateSelected());

  // Scoped per row: a `data-target` row writes that attribute directly (elements
  // with more than one color), a plain row goes through setElementColor.
  body.querySelectorAll('.swatches').forEach((box) => {
    const target = box.dataset.target;
    box.querySelectorAll('.swatch').forEach((s) => s.addEventListener('click', () => {
      // `cond:<i>` addresses a shade inside the battery's conditions array,
      // which the flat setAttr path below can't reach.
      if (target && target.startsWith('cond:')) {
        const i = +target.slice(5);
        setConds((cs) => { if (cs[i]) cs[i].color = s.dataset.color; });
      } else if (target) {
        n.setAttr(target, s.dataset.color);
        rebuildWidget(n);
      } else {
        setElementColor(n, s.dataset.color);
      }
      refreshProps();
    }));
  });
}

/**
 * Universal duplicate: copy the selected element (any type), offset it by one
 * grid step, and select the copy. Konva's clone() also copies event listeners,
 * but those close over the ORIGINAL node — so strip them and re-wire fresh
 * handlers bound to the clone.
 */
export function duplicateSelected() {
  if (!selected) { toast('Select an element to duplicate'); return; }
  const off = editorOpts.gridSize || 8;
  const clone = selected.clone({
    id: nextId(),
    x: snap(selected.x() + off),
    y: snap(selected.y() + off),
  });
  // Drop the listeners clone() copied, but only the ones wireNode() adds —
  // leave Konva's internal .konva handlers intact.
  clone.off('dragstart dragmove dragend transformstart transformend click tap dblclick dbltap');
  wireNode(clone);
  layer.add(clone);
  select(clone);
  layer.draw();
  suspendDitherPreview();
  scheduleDitherRefresh();
  toast('Duplicated element');
}

/**
 * Nudge, delete and duplicate. Ignored while a form field has focus, and scoped
 * to the editor — without that, Backspace on the settings screen would silently
 * delete whatever was last selected on a canvas the user cannot even see.
 */
export function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (!document.querySelector('#a7[data-active="true"]')) return;

    // Cmd/Ctrl+D duplicates the selection.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      duplicateSelected();
      return;
    }
    if (!selected) return;

    // With snap on, arrows step by one grid cell and Shift gives a fine 1px
    // nudge. With snap off, arrows step 1px and Shift steps 10px.
    const step = editorOpts.snap ? (e.shiftKey ? 1 : editorOpts.gridSize) : (e.shiftKey ? 10 : 1);
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      selected.move({ x: moves[e.key][0], y: moves[e.key][1] });
      selected.position({ x: Math.round(selected.x()), y: Math.round(selected.y()) });
      refreshProps();
      // Uncover the stage so held arrows read as movement, then re-dither once
      // the key-repeat stops (the refresh is debounced).
      suspendDitherPreview();
      scheduleDitherRefresh();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      selected.destroy();
      select(null);
      suspendDitherPreview();
      scheduleDitherRefresh();
    }
  });
}
