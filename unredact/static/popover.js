// @ts-check
/** Popover UI — font toolbar, text editing, and solve control panel. */

import { state } from './state.js';
import {
  popoverEl, fontToolbar, textEditBar, popoverClose,
  fontSelect, sizeSlider, sizeValue, sizeDown, sizeUp,
  posUp, posDown, posLeft, posRight, posReset, posDisplay,
  gapDown, gapUp, gapValue,
  leftTextInput, rightTextInput, redactionMarker, textReset,
  solveResults, solveStatus, solveStart, solveStop, solveAccept,
  solveTolerance, solveTolValue,
  solveKnownStart, solveKnownEnd,
  solveMode, filterLabel, pluralLabel, vocabLabel,
} from './dom.js';
import { renderCanvas } from './canvas.js';

/** @type {(() => void)|null} */
let _onClose = null;

/**
 * Register a callback to run when the popover closes (used to stop solver).
 * @param {() => void} fn
 */
export function setOnPopoverClose(fn) { _onClose = fn; }

/**
 * Open the popover for a redaction.
 * @param {string} id
 */
export function openPopover(id) {
  const r = state.redactions[id];
  if (!r || !r.analysis) return;

  solveKnownStart.value = "";
  solveKnownEnd.value = "";

  solveResults.innerHTML = "";
  solveStatus.textContent = "";
  solveStart.hidden = false;
  solveStop.hidden = true;
  // For approved redactions, restore the solution as preview for re-editing
  if (r.status === "approved" && r.solution) {
    let restored = r.solution.text;
    const ks = solveKnownStart.value;
    const ke = solveKnownEnd.value;
    if (ks && restored.toLowerCase().startsWith(ks.toLowerCase())) {
      restored = restored.slice(ks.length);
    }
    if (ke && restored.toLowerCase().endsWith(ke.toLowerCase())) {
      restored = restored.slice(0, -ke.length);
    }
    r.solveFullText = r.solution.text;
    r.preview = restored;
    r.status = "analyzed";
    solveAccept.hidden = true;
  } else {
    solveAccept.hidden = r.preview === null;
  }

  popoverEl.hidden = false;

  fontToolbar.hidden = false;
  fontSelect.value = r.overrides.fontId;
  sizeSlider.value = String(r.overrides.fontSize);
  sizeValue.textContent = String(r.overrides.fontSize);
  gapValue.textContent = String(Math.round(r.overrides.gapWidth));
  updatePosDisplay();

  textEditBar.hidden = false;
  leftTextInput.value = r.overrides.leftText;
  rightTextInput.value = r.overrides.rightText;
  redactionMarker.value = r.preview || "";
  redactionMarker.className = r.preview ? "redaction-marker preview" : "redaction-marker";
}

export function closePopover() {
  popoverEl.hidden = true;
  fontToolbar.hidden = true;
  textEditBar.hidden = true;
  if (_onClose) _onClose();
}

export function updatePosDisplay() {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;
  posDisplay.textContent = `${Math.round(r.overrides.offsetX)}, ${Math.round(r.overrides.offsetY)}`;
}

function adjustSize(delta) {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;
  r.overrides.fontSize = Math.max(8, Math.min(120, r.overrides.fontSize + delta));
  sizeSlider.value = String(r.overrides.fontSize);
  sizeValue.textContent = String(r.overrides.fontSize);
  renderCanvas();
}

function nudge(dx, dy) {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;
  r.overrides.offsetX += dx;
  r.overrides.offsetY += dy;
  updatePosDisplay();
  renderCanvas();
}

function adjustGap(delta) {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;
  r.overrides.gapWidth = Math.max(1, r.overrides.gapWidth + delta);
  gapValue.textContent = String(Math.round(r.overrides.gapWidth));
  renderCanvas();
}

/** Set up all popover event listeners. Call once from main.js. */
export function initPopover() {
  popoverClose.addEventListener("click", closePopover);

  fontSelect.addEventListener("change", () => {
    const r = state.redactions[state.activeRedaction];
    if (!r?.overrides) return;
    r.overrides.fontId = fontSelect.value;
    renderCanvas();
  });

  sizeSlider.addEventListener("input", () => {
    const r = state.redactions[state.activeRedaction];
    if (!r?.overrides) return;
    r.overrides.fontSize = parseInt(sizeSlider.value);
    sizeValue.textContent = sizeSlider.value;
    renderCanvas();
  });

  sizeDown.addEventListener("click", () => adjustSize(-1));
  sizeUp.addEventListener("click", () => adjustSize(1));

  posUp.addEventListener("click", () => nudge(0, -1));
  posDown.addEventListener("click", () => nudge(0, 1));
  posLeft.addEventListener("click", () => nudge(-1, 0));
  posRight.addEventListener("click", () => nudge(1, 0));

  posReset.addEventListener("click", () => {
    const r = state.redactions[state.activeRedaction];
    if (!r?.overrides || !r.analysis) return;
    r.overrides.offsetX = r.analysis.offset_x || 0;
    r.overrides.offsetY = r.analysis.offset_y || 0;
    updatePosDisplay();
    renderCanvas();
  });

  gapDown.addEventListener("click", () => adjustGap(-1));
  gapUp.addEventListener("click", () => adjustGap(1));

  leftTextInput.addEventListener("input", () => {
    const r = state.redactions[state.activeRedaction];
    if (!r?.overrides) return;
    r.overrides.leftText = leftTextInput.value;
    renderCanvas();

  });

  rightTextInput.addEventListener("input", () => {
    const r = state.redactions[state.activeRedaction];
    if (!r?.overrides) return;
    r.overrides.rightText = rightTextInput.value;
    renderCanvas();

  });

  textReset.addEventListener("click", () => {
    const r = state.redactions[state.activeRedaction];
    if (!r?.overrides || !r.analysis) return;
    const a = r.analysis;
    r.overrides.leftText = a.segments.length > 0 ? a.segments[0].text : "";
    r.overrides.rightText = a.segments.length > 1 ? a.segments[1].text : "";
    leftTextInput.value = r.overrides.leftText;
    rightTextInput.value = r.overrides.rightText;
    renderCanvas();

  });

  redactionMarker.addEventListener("input", () => {
    const r = state.redactions[state.activeRedaction];
    if (!r) return;
    const guess = redactionMarker.value.trim();
    r.preview = guess || null;
    r.solveFullText = null;  // manual input replaces solver result
    redactionMarker.className = guess ? "redaction-marker preview" : "redaction-marker";
    solveAccept.hidden = !guess;
    renderCanvas();
  });

  solveTolerance.addEventListener("input", () => {
    solveTolValue.textContent = solveTolerance.value;
  });

  solveMode.addEventListener("change", () => {
    filterLabel.hidden = solveMode.value !== "enumerate";
    const isWord = solveMode.value === "word";
    pluralLabel.hidden = !isWord;
    vocabLabel.hidden = !isWord;
  });
}
