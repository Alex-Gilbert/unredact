// @ts-check
/** Viewport controls — zoom, pan, touch, resize, and coordinate transforms. */

import { state, getPageRedactions } from './state.js';
import { rightPanel, docContainer, zoomLevel, docImage, canvas, popoverEl, fontToolbar, textEditBar, zoomInBtn, zoomOutBtn, zoomFitBtn } from './dom.js';
import { renderCanvas } from './canvas.js';

/**
 * Apply the current zoom/pan transform to the document container.
 * @param {boolean} smooth
 */
export function applyTransform(smooth) {
  const pw = rightPanel.clientWidth;
  const ph = rightPanel.clientHeight;
  const tx = pw / 2 - state.panX * state.zoom;
  const ty = ph / 2 - state.panY * state.zoom;

  if (smooth) {
    docContainer.style.transition = "transform 0.25s ease-out";
  } else {
    docContainer.style.transition = "none";
  }

  docContainer.style.transform =
    `translate(${tx}px, ${ty}px) scale(${state.zoom})`;
  zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
}

/**
 * Convert screen coordinates to document coordinates.
 * @param {number} sx
 * @param {number} sy
 * @returns {{ x: number, y: number }}
 */
export function screenToDoc(sx, sy) {
  const pw = rightPanel.clientWidth;
  const ph = rightPanel.clientHeight;
  return {
    x: (sx - pw / 2) / state.zoom + state.panX,
    y: (sy - ph / 2) / state.zoom + state.panY,
  };
}

/**
 * Zoom to a new level, optionally pivoting around screen coordinates.
 * @param {number} newZoom
 * @param {number} [pivotSX]
 * @param {number} [pivotSY]
 * @param {boolean} [smooth]
 */
export function zoomTo(newZoom, pivotSX, pivotSY, smooth) {
  newZoom = Math.max(0.1, Math.min(20, newZoom));
  if (pivotSX !== undefined) {
    const doc = screenToDoc(pivotSX, pivotSY);
    state.panX = doc.x;
    state.panY = doc.y;
    const pw = rightPanel.clientWidth;
    const ph = rightPanel.clientHeight;
    state.panX += (pw / 2 - pivotSX) / newZoom;
    state.panY += (ph / 2 - pivotSY) / newZoom;
  }
  state.zoom = newZoom;
  applyTransform(!!smooth);
}

export function zoomToFit() {
  if (!docImage.naturalWidth) return;
  const pw = rightPanel.clientWidth;
  const ph = rightPanel.clientHeight;
  const iw = docImage.naturalWidth;
  const ih = docImage.naturalHeight;
  state.zoom = Math.min(pw / iw, ph / ih) * 0.95;
  state.panX = iw / 2;
  state.panY = ih / 2;
  applyTransform(true);
}

/**
 * Test if document coordinates hit a redaction box.
 * @param {number} docX
 * @param {number} docY
 * @returns {import('./types.js').Redaction|null}
 */
export function hitTestRedaction(docX, docY) {
  const redactions = getPageRedactions();
  for (const r of redactions) {
    if (docX >= r.x && docX <= r.x + r.w && docY >= r.y && docY <= r.y + r.h) {
      return r;
    }
  }
  return null;
}

/** @param {Event} e */
function isPopoverArea(e) {
  return popoverEl.contains(/** @type {Node} */ (e.target)) ||
    fontToolbar.contains(/** @type {Node} */ (e.target)) ||
    textEditBar.contains(/** @type {Node} */ (e.target));
}

/** Set up all viewport event listeners. Call once from main.js. */
export function initViewport() {
  // Zoom buttons
  zoomInBtn.addEventListener("click", () => {
    zoomTo(state.zoom * 1.3, undefined, undefined, true);
  });
  zoomOutBtn.addEventListener("click", () => {
    zoomTo(state.zoom / 1.3, undefined, undefined, true);
  });
  zoomFitBtn.addEventListener("click", zoomToFit);

  // Mouse-wheel zoom toward cursor
  rightPanel.addEventListener("wheel", (e) => {
    if (isPopoverArea(e)) return;
    e.preventDefault();
    const rect = rightPanel.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = Math.pow(1.002, -e.deltaY);
    zoomTo(state.zoom * factor, sx, sy, false);
  }, { passive: false });

  // Click-drag pan
  let drag = null;

  rightPanel.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (isPopoverArea(e)) return;
    drag = {
      startX: e.clientX,
      startY: e.clientY,
      startPanX: state.panX,
      startPanY: state.panY,
      moved: false,
    };
    rightPanel.classList.add("panning");
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
    state.panX = drag.startPanX - dx / state.zoom;
    state.panY = drag.startPanY - dy / state.zoom;
    applyTransform(false);
  });

  window.addEventListener("mouseup", () => {
    if (drag) {
      drag = null;
      rightPanel.classList.remove("panning");
    }
  });

  // Touch: pinch-zoom + two-finger pan
  let lastTouches = null;

  rightPanel.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      lastTouches = Array.from(e.touches);
    }
  }, { passive: false });

  rightPanel.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2 && lastTouches) {
      e.preventDefault();
      const [t0, t1] = e.touches;
      const [p0, p1] = lastTouches;

      const oldDist = Math.hypot(p1.clientX - p0.clientX, p1.clientY - p0.clientY);
      const newDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const zoomDelta = newDist / oldDist;

      const oldMidX = (p0.clientX + p1.clientX) / 2;
      const oldMidY = (p0.clientY + p1.clientY) / 2;
      const newMidX = (t0.clientX + t1.clientX) / 2;
      const newMidY = (t0.clientY + t1.clientY) / 2;

      state.panX -= (newMidX - oldMidX) / state.zoom;
      state.panY -= (newMidY - oldMidY) / state.zoom;

      const rect = rightPanel.getBoundingClientRect();
      const sx = newMidX - rect.left;
      const sy = newMidY - rect.top;
      zoomTo(state.zoom * zoomDelta, sx, sy, false);

      lastTouches = Array.from(e.touches);
    }
  }, { passive: false });

  rightPanel.addEventListener("touchend", () => {
    lastTouches = null;
  });

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    applyTransform(false);
    renderCanvas();
  });
  resizeObserver.observe(rightPanel);

  // On image load, fit to viewport
  docImage.addEventListener("load", () => {
    zoomToFit();
    renderCanvas();
  });

  // Canvas pointer style
  canvas.style.pointerEvents = "auto";
}
