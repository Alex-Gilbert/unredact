// @ts-check
/** Application state — single source of truth for all UI and document data. */

/** @type {import('./types.js').AppState} */
export const state = {
  docId: null,
  pageCount: 0,
  currentPage: 1,
  redactions: {},
  activeRedaction: null,
  fonts: [],
  fontsReady: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  associates: null,
};

/**
 * Get redactions for the current page, sorted top-to-bottom then left-to-right.
 * @returns {import('./types.js').Redaction[]}
 */
export function getPageRedactions() {
  return Object.values(state.redactions)
    .filter((r) => r.page === state.currentPage)
    .sort((a, b) => {
      if (Math.abs(a.y - b.y) > 5) return a.y - b.y;
      return a.x - b.x;
    });
}
