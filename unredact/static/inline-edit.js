// @ts-check
/**
 * Inline text editing — HTML inputs positioned on the canvas at
 * the left/right text locations so users edit directly on the document.
 */
import { state } from './state.js';
import { renderCanvas } from './canvas.js';

const layer = document.getElementById("inline-edit-layer");

let leftInput = null;
let rightInput = null;

/**
 * Show inline text inputs for the active redaction.
 * @param {string} id - Redaction ID
 */
export function showInlineEdit(id) {
  hideInlineEdit();

  const r = state.redactions[id];
  if (!r?.analysis || !r?.overrides) return;

  const a = r.analysis;
  const o = r.overrides;
  const fontSize = o.fontSize || a.font.size;
  const offsetX = o.offsetX || 0;
  const offsetY = o.offsetY || 0;
  const lineX = a.line.x + offsetX;
  const lineY = a.line.y + offsetY;
  const gapWidth = o.gapWidth || a.gap.w;

  const leftText = o.leftText || "";
  const rightText = o.rightText || "";

  // Left input: positioned at the start of the line, width up to the gap
  const leftWidth = Math.max(30, r.x - lineX);
  leftInput = _createInput(leftText, lineX, lineY, leftWidth, a.line.h, fontSize);
  leftInput.style.textAlign = "right";
  leftInput.addEventListener("input", () => {
    r.overrides.leftText = leftInput.value;
    renderCanvas();
    _syncTextEditBar(r);
  });

  // Right input: positioned after the gap
  const rightX = r.x + gapWidth;
  const rightW = Math.max(50, (a.line.x + a.line.w) - rightX + 20);
  rightInput = _createInput(rightText, rightX, lineY, rightW, a.line.h, fontSize);
  rightInput.addEventListener("input", () => {
    r.overrides.rightText = rightInput.value;
    renderCanvas();
    _syncTextEditBar(r);
  });

  layer.appendChild(leftInput);
  layer.appendChild(rightInput);
}

/** Remove all inline edit inputs. */
export function hideInlineEdit() {
  if (leftInput) { leftInput.remove(); leftInput = null; }
  if (rightInput) { rightInput.remove(); rightInput = null; }
}

/** Update input values from state (e.g., after text reset or popover bar edit). */
export function syncInlineEdit(id) {
  const r = state.redactions[id];
  if (!r?.overrides) return;
  if (leftInput) leftInput.value = r.overrides.leftText;
  if (rightInput) rightInput.value = r.overrides.rightText;
}

function _syncTextEditBar(r) {
  // Keep the bottom text edit bar in sync
  const leftEl = document.getElementById("left-text-input");
  const rightEl = document.getElementById("right-text-input");
  if (leftEl) leftEl.value = r.overrides.leftText;
  if (rightEl) rightEl.value = r.overrides.rightText;
}

function _createInput(value, x, y, w, h, fontSize) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  Object.assign(input.style, {
    position: "absolute",
    left: x + "px",
    top: y + "px",
    width: Math.max(30, w) + "px",
    height: h + "px",
    fontSize: fontSize + "px",
    background: "rgba(255,255,255,0.7)",
    border: "1px solid rgba(0,180,0,0.5)",
    padding: "0 2px",
    pointerEvents: "auto",
    boxSizing: "border-box",
    outline: "none",
    fontFamily: "sans-serif",
  });
  return input;
}
