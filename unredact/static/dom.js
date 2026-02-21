// @ts-check
/** DOM element references and utility functions. */

export const dropZone = document.getElementById("drop-zone");
export const fileInput = /** @type {HTMLInputElement} */ (document.getElementById("file-input"));
export const uploadSection = document.getElementById("upload-section");
export const viewerSection = document.getElementById("viewer-section");
export const docImage = /** @type {HTMLImageElement} */ (document.getElementById("doc-image"));
export const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("overlay-canvas"));
export const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
export const pageInfo = document.getElementById("page-info");
export const prevBtn = /** @type {HTMLButtonElement} */ (document.getElementById("prev-page"));
export const nextBtn = /** @type {HTMLButtonElement} */ (document.getElementById("next-page"));
export const redactionListEl = document.getElementById("redaction-list");
export const detectBtn = /** @type {HTMLButtonElement} */ (document.getElementById("detect-btn"));
export const zoomInBtn = document.getElementById("zoom-in");
export const zoomOutBtn = document.getElementById("zoom-out");
export const zoomFitBtn = document.getElementById("zoom-fit");
export const zoomLevel = document.getElementById("zoom-level");
export const rightPanel = document.getElementById("right-panel");
export const docContainer = document.getElementById("doc-container");
export const popoverEl = document.getElementById("popover");
export const popoverClose = document.getElementById("popover-close");
export const solveCharset = /** @type {HTMLSelectElement} */ (document.getElementById("solve-charset"));
export const solveTolerance = /** @type {HTMLInputElement} */ (document.getElementById("solve-tolerance"));
export const solveTolValue = document.getElementById("solve-tol-value");
export const solveMode = /** @type {HTMLSelectElement} */ (document.getElementById("solve-mode"));
export const solveFilter = /** @type {HTMLSelectElement} */ (document.getElementById("solve-filter"));
export const solveKnownStart = /** @type {HTMLInputElement} */ (document.getElementById("solve-known-start"));
export const solveKnownEnd = /** @type {HTMLInputElement} */ (document.getElementById("solve-known-end"));
export const filterLabel = document.getElementById("filter-label");
export const solveStart = document.getElementById("solve-start");
export const solveStop = document.getElementById("solve-stop");
export const solveAccept = document.getElementById("solve-accept");
export const solveStatus = document.getElementById("solve-status");
export const solveResults = document.getElementById("solve-results");
export const fontToolbar = document.getElementById("font-toolbar");
export const fontSelect = /** @type {HTMLSelectElement} */ (document.getElementById("font-select"));
export const sizeSlider = /** @type {HTMLInputElement} */ (document.getElementById("size-slider"));
export const sizeValue = document.getElementById("size-value");
export const sizeDown = document.getElementById("size-down");
export const sizeUp = document.getElementById("size-up");
export const posUp = document.getElementById("pos-up");
export const posDown = document.getElementById("pos-down");
export const posLeft = document.getElementById("pos-left");
export const posRight = document.getElementById("pos-right");
export const posReset = document.getElementById("pos-reset");
export const posDisplay = document.getElementById("pos-display");
export const gapDown = document.getElementById("gap-down");
export const gapUp = document.getElementById("gap-up");
export const gapValue = document.getElementById("gap-value");
export const textEditBar = document.getElementById("text-edit-bar");
export const leftTextInput = /** @type {HTMLInputElement} */ (document.getElementById("left-text-input"));
export const rightTextInput = /** @type {HTMLInputElement} */ (document.getElementById("right-text-input"));
export const redactionMarker = /** @type {HTMLInputElement} */ (document.getElementById("redaction-marker"));
export const textReset = document.getElementById("text-reset");
export const mobileTabs = document.getElementById("mobile-tabs");
export const leftPanel = document.getElementById("left-panel");
export const toastContainer = document.getElementById("toast-container");

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'info'|'error'} [type]
 */
export function showToast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/**
 * Escape HTML special characters.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
