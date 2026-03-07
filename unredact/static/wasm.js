// @ts-check

let wasmModule = null;
let initialized = false;

/**
 * Initialize the WASM module. Must be called before any other function.
 */
export async function initWasm() {
    if (initialized) return;
    wasmModule = await import('/pkg/unredact_core.js');
    await wasmModule.default();
    initialized = true;
}

// --- Image Processing ---

/**
 * Detect redaction boxes in a page image.
 * @param {ImageData} imageData - RGBA pixel data from Canvas
 * @returns {Array<{x: number, y: number, w: number, h: number}>}
 */
export function detectRedactions(imageData) {
    return wasmModule.detect_redactions(
        new Uint8Array(imageData.data.buffer),
        imageData.width,
        imageData.height
    );
}

/**
 * Detect a single redaction at a click point.
 * @param {ImageData} imageData
 * @param {number} x - click x in image coords
 * @param {number} y - click y in image coords
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
export function spotRedaction(imageData, x, y) {
    const result = wasmModule.spot_redaction(
        new Uint8Array(imageData.data.buffer),
        imageData.width,
        imageData.height,
        x, y
    );
    return result ?? null;
}

/**
 * Find a redaction within a search region (guided by LLM hints).
 * @param {ImageData} imageData
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {number} padding
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
export function findRedactionInRegion(imageData, x1, y1, x2, y2, padding) {
    const result = wasmModule.find_redaction_in_region(
        new Uint8Array(imageData.data.buffer),
        imageData.width,
        imageData.height,
        x1, y1, x2, y2, padding
    );
    return result ?? null;
}

// --- Font Matching ---

/**
 * Score how well a rendered font matches the page using Dice coefficient.
 * Both inputs should be grayscale Uint8Array (1 byte per pixel).
 * @param {Uint8Array} pageGray - grayscale page crop
 * @param {Uint8Array} renderedGray - grayscale rendered text
 * @param {number} width
 * @param {number} height
 * @returns {number} - score between 0 and 1
 */
export function scoreFont(pageGray, renderedGray, width, height) {
    return wasmModule.score_font(pageGray, renderedGray, width, height);
}

/**
 * Find the pixel offset to align rendered text with page.
 * @param {Uint8Array} pageGray - (pw x ph)
 * @param {number} pw
 * @param {number} ph
 * @param {Uint8Array} renderedGray - ((pw + 2*searchX) x (ph + 2*searchY))
 * @param {number} rw
 * @param {number} rh
 * @param {number} searchX
 * @param {number} searchY
 * @returns {[number, number]} - [offsetX, offsetY]
 */
export function alignText(pageGray, pw, ph, renderedGray, rw, rh, searchX, searchY) {
    return wasmModule.align_text(pageGray, pw, ph, renderedGray, rw, rh, searchX, searchY);
}

// --- Solver ---

/**
 * Dictionary-based solve (name, email, word, full_name modes).
 * @param {object} config
 * @param {Array<[string, number]>} config.entries - pre-measured (text, width) pairs
 * @param {number} config.target_width
 * @param {number} config.tolerance
 * @param {string} [config.known_start]
 * @param {string} [config.known_end]
 * @param {string} config.mode - "name", "full_name", "email", "word"
 * @returns {Array<{text: string, width: number, error: number}>}
 */
export function solve(config) {
    return wasmModule.solve(config);
}

/**
 * DFS branch-and-bound solve.
 * @param {object} config
 * @param {string} config.charset
 * @param {number[]} config.advance_table - flat n*n array
 * @param {number[]} config.left_edge - n values
 * @param {number[]} config.right_edge - n values
 * @param {number} config.target_width
 * @param {number} config.tolerance
 * @param {number} [config.min_length]
 * @param {number} [config.max_length]
 * @param {string} [config.constraint_pattern]
 * @returns {Array<{text: string, width: number, error: number}>}
 */
export function solveDfs(config) {
    return wasmModule.solve_dfs(config);
}
