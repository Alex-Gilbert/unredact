# Marquee Font Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the double-click auto-analyze flow with a marquee selection tool and golden-section font optimizer that achieves sub-pixel precision.

**Architecture:** User draws a marquee rectangle on the canvas, adjusts it, clicks "Analyze". The system auto-detects the redaction box within the marquee, splits OCR text into left/right segments, then runs a golden-section optimizer over (fontSize, y-offset, x-offset) per candidate font to find the best match. Text is rendered as continuous strings with natural browser kerning — no per-character OCR positioning.

**Tech Stack:** Vanilla JS (ES modules), OffscreenCanvas for rendering, existing WASM `scoreFont` for scoring, existing Tesseract.js OCR.

**Dev server:** `make dev-static` (serves from `dist/` on port 8000, or `python scripts/dev-server.py 8000`)

**Build WASM:** `cd unredact-wasm && wasm-pack build --target web --out-dir pkg` (only if WASM changes needed)

---

### Task 1: Golden-Section Search Utility

**Files:**
- Create: `unredact/static/optimize.js`

A pure math module with no rendering dependencies. Used by font detection and potentially other optimizers later.

**Step 1: Create `optimize.js` with `goldenSection` function**

```javascript
// @ts-check
/**
 * Golden-section search for unimodal function maximum.
 * @param {(x: number) => number} fn - function to maximize
 * @param {number} lo - lower bound
 * @param {number} hi - upper bound
 * @param {number} tol - convergence tolerance (stop when hi - lo < tol)
 * @returns {{ x: number, score: number }}
 */
export function goldenSection(fn, lo, hi, tol) {
    const phi = (1 + Math.sqrt(5)) / 2;
    const resphi = 2 - phi; // ~0.382

    let a = lo, b = hi;
    let x1 = a + resphi * (b - a);
    let x2 = b - resphi * (b - a);
    let f1 = fn(x1);
    let f2 = fn(x2);

    while (b - a > tol) {
        if (f1 < f2) {
            a = x1;
            x1 = x2;
            f1 = f2;
            x2 = b - resphi * (b - a);
            f2 = fn(x2);
        } else {
            b = x2;
            x2 = x1;
            f2 = f1;
            x1 = a + resphi * (b - a);
            f1 = fn(x1);
        }
    }

    // Return the better of the two probes
    if (f1 > f2) return { x: x1, score: f1 };
    return { x: x2, score: f2 };
}
```

**Step 2: Verify in browser console**

Open browser console on the running app, paste the function, and test:
```javascript
// Test: maximize -(x-3.7)^2 — peak at x=3.7
goldenSection(x => -(x - 3.7) ** 2, 0, 10, 0.01)
// Should return { x: ~3.7, score: ~0 }
```

**Step 3: Commit**
```bash
git add unredact/static/optimize.js
git commit -m "feat: golden-section search utility for unimodal optimization"
```

---

### Task 2: New Font Detection with Float Sizes and Optimizer

**Files:**
- Modify: `unredact/static/font_detect.js` — gut and replace with new approach
- Read: `unredact/static/wasm.js` — uses `scoreFont` (line 79)

This is the core algorithm change. Replace grid search with golden-section optimizer. Replace per-run rendering with two-segment rendering. Support float font sizes.

**Step 1: Replace `renderTextGray` and `renderRunsGray` with `renderSegmentsGray`**

In `font_detect.js`, remove `renderTextGray` (lines 49-61) and `renderRunsGray` (lines 75-93). Add:

```javascript
/**
 * Render left and right text segments onto a canvas with a gap between them.
 * Both segments share the same baseline (y position). Text is rendered as
 * continuous strings with natural browser kerning.
 *
 * @param {string} leftText
 * @param {string} rightText
 * @param {number} gapWidth - width of the redaction box gap
 * @param {string} fontName
 * @param {number} fontSize - supports float values (e.g. 14.3)
 * @param {number} xOffset - horizontal offset for positioning
 * @param {number} yOffset - vertical offset for positioning
 * @param {number} width - canvas width
 * @param {number} height - canvas height
 * @returns {Uint8Array} grayscale pixels
 */
function renderSegmentsGray(leftText, rightText, gapWidth, fontName, fontSize, xOffset, yOffset, width, height) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'black';
    ctx.font = `${fontSize}px "${fontName}"`;
    ctx.textBaseline = 'top';

    if (leftText) {
        ctx.fillText(leftText, xOffset, yOffset);
    }
    const leftWidth = leftText ? ctx.measureText(leftText).width : 0;

    if (rightText) {
        ctx.fillText(rightText, xOffset + leftWidth + gapWidth, yOffset);
    }

    return canvasToGrayscale(canvas);
}
```

**Step 2: Add `maskRegion` helper**

```javascript
/**
 * Mask a rectangular region to white (255) in a grayscale buffer.
 * @param {Uint8Array} gray - grayscale pixels (mutated in place)
 * @param {number} bufW - buffer width
 * @param {number} bufH - buffer height
 * @param {number} rx - region x (relative to buffer)
 * @param {number} ry - region y
 * @param {number} rw - region width
 * @param {number} rh - region height
 */
function maskRegion(gray, bufW, bufH, rx, ry, rw, rh) {
    const x0 = Math.max(0, Math.round(rx));
    const y0 = Math.max(0, Math.round(ry));
    const x1 = Math.min(bufW, Math.round(rx + rw));
    const y1 = Math.min(bufH, Math.round(ry + rh));
    for (let row = y0; row < y1; row++) {
        for (let col = x0; col < x1; col++) {
            gray[row * bufW + col] = 255;
        }
    }
}
```

**Step 3: Replace `detectFont` and `detectFontMasked` with `detectFontMarquee`**

Remove `detectFont` (lines 178-263), `detectFontMasked` (lines 276-385), and `groupCharRuns` (lines 147-164). Add:

```javascript
import { goldenSection } from './optimize.js';

/**
 * @typedef {{
 *   fontName: string,
 *   fontSize: number,
 *   xOffset: number,
 *   yOffset: number,
 *   score: number
 * }} FontMatchResult
 */

/**
 * Detect the best matching font for a marquee selection containing a redaction.
 *
 * @param {Uint8Array} cropGray - grayscale pixels of the marquee crop
 * @param {number} cropW
 * @param {number} cropH
 * @param {{ x: number, y: number, w: number, h: number }} box - redaction box position relative to crop
 * @param {string} leftText - text to the left of the redaction
 * @param {string} rightText - text to the right of the redaction
 * @param {string[]} candidates - font family names to try
 * @returns {FontMatchResult}
 */
export function detectFontMarquee(cropGray, cropW, cropH, box, leftText, rightText, candidates) {
    if (cropW <= 0 || cropH <= 0 || (!leftText.trim() && !rightText.trim())) {
        return { fontName: candidates[0], fontSize: cropH * 0.8, xOffset: 0, yOffset: 0, score: 0 };
    }

    // Mask the redaction box in the page crop
    const maskedCrop = new Uint8Array(cropGray);
    maskRegion(maskedCrop, cropW, cropH, box.x, box.y, box.w, box.h);

    /** @type {FontMatchResult} */
    let best = { fontName: candidates[0], fontSize: cropH * 0.8, xOffset: 0, yOffset: 0, score: -1 };

    // Size search range based on crop height
    const minSize = Math.max(6, cropH * 0.3);
    const maxSize = Math.min(200, cropH * 1.5);

    /** @type {Array<FontMatchResult>} */
    const perFontBest = [];

    for (const fontName of candidates) {
        // Helper: render, mask redaction region, score
        const evaluate = (fontSize, xOff, yOff) => {
            const rendered = renderSegmentsGray(
                leftText, rightText, box.w, fontName, fontSize,
                xOff, yOff, cropW, cropH
            );
            maskRegion(rendered, cropW, cropH, box.x, box.y, box.w, box.h);
            return scoreFont(maskedCrop, rendered, cropW, cropH);
        };

        // Phase 1: Coarse scan on fontSize (5px steps, x=0, y=0)
        let coarseBestSize = minSize;
        let coarseBestScore = -1;
        for (let size = minSize; size <= maxSize; size += 5) {
            const s = evaluate(size, 0, 0);
            if (s > coarseBestScore) {
                coarseBestScore = s;
                coarseBestSize = size;
            }
        }

        // Phase 2: Golden-section on fontSize (0.1px precision)
        const sizeResult = goldenSection(
            size => evaluate(size, 0, 0),
            Math.max(minSize, coarseBestSize - 5),
            Math.min(maxSize, coarseBestSize + 5),
            0.1
        );
        const optSize = sizeResult.x;

        // Phase 3: Golden-section on y-offset (0.1px precision)
        const yResult = goldenSection(
            y => evaluate(optSize, 0, y),
            -5, 5, 0.1
        );
        const optY = yResult.x;

        // Phase 4: Golden-section on x-offset (0.1px precision)
        const xResult = goldenSection(
            x => evaluate(optSize, x, optY),
            -5, 5, 0.1
        );
        const optX = xResult.x;

        // Final score with all optimized params
        const finalScore = evaluate(optSize, optX, optY);

        const result = { fontName, fontSize: optSize, xOffset: optX, yOffset: optY, score: finalScore };
        perFontBest.push(result);

        if (finalScore > best.score) {
            best = result;
        }
    }

    // Debug visualization
    if (debugEnabled()) {
        const sorted = [...perFontBest].sort((a, b) => b.score - a.score);
        const debugCandidates = sorted.slice(0, 5).map(c => ({
            fontName: c.fontName,
            fontSize: c.fontSize,
            score: c.score,
            rendered: (() => {
                const r = renderSegmentsGray(
                    leftText, rightText, box.w, c.fontName, c.fontSize,
                    c.xOffset, c.yOffset, cropW, cropH
                );
                maskRegion(r, cropW, cropH, box.x, box.y, box.w, box.h);
                return r;
            })(),
        }));
        showDebug(maskedCrop, cropW, cropH, debugCandidates);
    }

    return best;
}
```

**Step 4: Update the exports**

The module should export `detectFontMarquee` and `cropToGrayscale` (needed by the caller to create the crop). Remove the old `detectFont` and `detectFontMasked` exports.

**Step 5: Verify WASM `scoreFont` still works with this approach**

The `scoreFont` function in `wasm.js:79` calls `best_ncc_score` with a ±3px shift range internally. This provides sub-pixel robustness on top of the optimizer positioning. Both images must be same dimensions (cropW × cropH) — our approach satisfies this since we render onto an OffscreenCanvas of the same size.

**Step 6: Commit**
```bash
git add unredact/static/font_detect.js
git commit -m "feat: golden-section font optimizer with float sizes and two-segment rendering"
```

---

### Task 3: Marquee Selection UI

**Files:**
- Create: `unredact/static/marquee.js` — marquee state machine, drawing, resize handles
- Modify: `unredact/static/canvas.js` — render marquee overlay
- Modify: `unredact/static/main.js` — wire marquee events

The marquee is a rectangle drawn on the document canvas. It stays visible with resize handles until the user clicks "Analyze" or dismisses it.

**Step 1: Create `marquee.js` — state and interaction**

```javascript
// @ts-check
/** Marquee selection tool — draw, resize, and manage a selection rectangle. */

import { state } from './state.js';
import { rightPanel, canvas } from './dom.js';
import { screenToDoc } from './viewport.js';
import { renderCanvas } from './canvas.js';

/**
 * @typedef {{
 *   x: number, y: number, w: number, h: number,
 *   active: boolean,
 *   detectedBox: { x: number, y: number, w: number, h: number } | null
 * }} MarqueeState
 */

/** @type {MarqueeState} */
export const marquee = {
    x: 0, y: 0, w: 0, h: 0,
    active: false,
    detectedBox: null,
};

/** @type {((m: MarqueeState) => void) | null} */
let _onAnalyze = null;

/** @param {(m: MarqueeState) => void} cb */
export function setOnAnalyze(cb) { _onAnalyze = cb; }

/** Clear the marquee and hide the analyze button. */
export function clearMarquee() {
    marquee.active = false;
    marquee.detectedBox = null;
    hideAnalyzeButton();
    renderCanvas();
}

// ── Analyze button ──

/** @type {HTMLButtonElement | null} */
let analyzeBtn = null;

function getAnalyzeBtn() {
    if (analyzeBtn) return analyzeBtn;
    analyzeBtn = document.createElement('button');
    analyzeBtn.textContent = 'Analyze';
    analyzeBtn.className = 'marquee-analyze-btn';
    analyzeBtn.style.cssText = `
        position: absolute; z-index: 100;
        padding: 6px 16px; font-size: 14px; font-weight: bold;
        background: #4285f4; color: white; border: none; border-radius: 4px;
        cursor: pointer; display: none; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    `;
    analyzeBtn.addEventListener('click', () => {
        if (_onAnalyze && marquee.active) _onAnalyze(marquee);
    });
    rightPanel.appendChild(analyzeBtn);
    return analyzeBtn;
}

function showAnalyzeButton() {
    const btn = getAnalyzeBtn();
    // Position below the marquee in screen space
    // (The canvas is transformed, so we approximate based on current viewport)
    btn.style.display = 'block';
    // Position will be updated by renderCanvas
}

function hideAnalyzeButton() {
    if (analyzeBtn) analyzeBtn.style.display = 'none';
}

/**
 * Update the analyze button position relative to the marquee.
 * Call from renderCanvas after drawing the marquee.
 * @param {number} screenX - marquee center in screen coords
 * @param {number} screenY - marquee bottom in screen coords
 */
export function updateAnalyzeButtonPos(screenX, screenY) {
    const btn = getAnalyzeBtn();
    if (!marquee.active) { btn.style.display = 'none'; return; }
    btn.style.display = 'block';
    btn.style.left = `${screenX - 40}px`;
    btn.style.top = `${screenY + 8}px`;
}

// ── Drawing interaction ──

/** @type {{ startX: number, startY: number } | null} */
let drawState = null;

/** @type {{ edge: string, startX: number, startY: number, orig: { x: number, y: number, w: number, h: number } } | null} */
let resizeState = null;

/**
 * Initialize marquee event listeners. Call once from main.js.
 */
export function initMarquee() {
    // Shift+mousedown starts marquee drawing
    canvas.addEventListener('mousedown', (e) => {
        if (!e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const rect = rightPanel.getBoundingClientRect();
        const doc = screenToDoc(e.clientX - rect.left, e.clientY - rect.top);

        // Check if near an existing marquee edge (resize)
        if (marquee.active) {
            const edge = hitTestMarqueeEdge(doc.x, doc.y);
            if (edge) {
                resizeState = {
                    edge,
                    startX: e.clientX,
                    startY: e.clientY,
                    orig: { x: marquee.x, y: marquee.y, w: marquee.w, h: marquee.h },
                };
                return;
            }
        }

        // Start new marquee
        drawState = { startX: doc.x, startY: doc.y };
        marquee.x = doc.x;
        marquee.y = doc.y;
        marquee.w = 0;
        marquee.h = 0;
        marquee.active = true;
        marquee.detectedBox = null;
        hideAnalyzeButton();
    }, { capture: true });

    window.addEventListener('mousemove', (e) => {
        if (drawState) {
            const rect = rightPanel.getBoundingClientRect();
            const doc = screenToDoc(e.clientX - rect.left, e.clientY - rect.top);
            marquee.x = Math.min(drawState.startX, doc.x);
            marquee.y = Math.min(drawState.startY, doc.y);
            marquee.w = Math.abs(doc.x - drawState.startX);
            marquee.h = Math.abs(doc.y - drawState.startY);
            renderCanvas();
        } else if (resizeState) {
            const dx = (e.clientX - resizeState.startX) / state.zoom;
            const dy = (e.clientY - resizeState.startY) / state.zoom;
            const o = resizeState.orig;
            switch (resizeState.edge) {
                case 'left':
                    marquee.x = o.x + dx;
                    marquee.w = Math.max(20, o.w - dx);
                    break;
                case 'right':
                    marquee.w = Math.max(20, o.w + dx);
                    break;
                case 'top':
                    marquee.y = o.y + dy;
                    marquee.h = Math.max(20, o.h - dy);
                    break;
                case 'bottom':
                    marquee.h = Math.max(20, o.h + dy);
                    break;
            }
            renderCanvas();
        }
    });

    window.addEventListener('mouseup', () => {
        if (drawState) {
            drawState = null;
            if (marquee.w > 10 && marquee.h > 10) {
                showAnalyzeButton();
            } else {
                clearMarquee();
            }
        }
        if (resizeState) {
            resizeState = null;
            showAnalyzeButton();
        }
    });

    // Escape clears marquee
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && marquee.active) {
            clearMarquee();
        }
    });
}

/**
 * Hit-test marquee edges for resize (threshold in doc coords).
 * @param {number} docX
 * @param {number} docY
 * @returns {string|null} edge name or null
 */
function hitTestMarqueeEdge(docX, docY) {
    const t = 8 / state.zoom; // threshold in doc coords
    const m = marquee;
    if (Math.abs(docX - m.x) < t && docY > m.y - t && docY < m.y + m.h + t) return 'left';
    if (Math.abs(docX - (m.x + m.w)) < t && docY > m.y - t && docY < m.y + m.h + t) return 'right';
    if (Math.abs(docY - m.y) < t && docX > m.x - t && docX < m.x + m.w + t) return 'top';
    if (Math.abs(docY - (m.y + m.h)) < t && docX > m.x - t && docX < m.x + m.w + t) return 'bottom';
    return null;
}
```

**Step 2: Add marquee rendering to `canvas.js`**

At the end of the `renderCanvas()` function (after the redaction loop), add marquee drawing:

```javascript
import { marquee, updateAnalyzeButtonPos } from './marquee.js';

// Inside renderCanvas(), after the redaction loop:

    // Draw marquee selection
    if (marquee.active) {
        const m = marquee;
        // Dashed blue rectangle
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(66, 133, 244, 0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(m.x, m.y, m.w, m.h);
        ctx.setLineDash([]);

        // Semi-transparent fill
        ctx.fillStyle = 'rgba(66, 133, 244, 0.08)';
        ctx.fillRect(m.x, m.y, m.w, m.h);

        // Resize handles (small squares at midpoints of each edge)
        const sz = 6;
        ctx.fillStyle = 'rgba(66, 133, 244, 0.9)';
        ctx.fillRect(m.x - sz/2, m.y + m.h/2 - sz/2, sz, sz);           // left
        ctx.fillRect(m.x + m.w - sz/2, m.y + m.h/2 - sz/2, sz, sz);     // right
        ctx.fillRect(m.x + m.w/2 - sz/2, m.y - sz/2, sz, sz);           // top
        ctx.fillRect(m.x + m.w/2 - sz/2, m.y + m.h - sz/2, sz, sz);     // bottom

        // Detected redaction box within marquee
        if (m.detectedBox) {
            ctx.strokeStyle = 'rgba(211, 47, 47, 0.9)';
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.strokeRect(m.detectedBox.x, m.detectedBox.y, m.detectedBox.w, m.detectedBox.h);
        }

        ctx.restore();

        // Update analyze button position (screen coords)
        // Convert marquee bottom-center from doc to approximate screen position
        const pw = rightPanel.clientWidth;
        const ph = rightPanel.clientHeight;
        const screenCX = (m.x + m.w / 2 - state.panX) * state.zoom + pw / 2;
        const screenBY = (m.y + m.h - state.panY) * state.zoom + ph / 2;
        updateAnalyzeButtonPos(screenCX, screenBY);
    }
```

**Step 3: Verify visually**

Run `make dev-static`, load a PDF, hold Shift and drag on the document. A blue dashed rectangle should appear. Resize handles should be visible. Escape should dismiss it.

**Step 4: Commit**
```bash
git add unredact/static/marquee.js unredact/static/canvas.js
git commit -m "feat: marquee selection tool with resize handles and analyze button"
```

---

### Task 4: Wire Marquee to Font Detection

**Files:**
- Modify: `unredact/static/main.js` — replace double-click handler, add marquee analyze handler
- Modify: `unredact/static/font_detect.js` — export `cropToGrayscale`

This wires the marquee "Analyze" callback to: auto-detect redaction box within the marquee, split OCR text, run font detection, create the redaction entry.

**Step 1: Export `cropToGrayscale` from `font_detect.js`**

Change `function cropToGrayscale(` to `export function cropToGrayscale(`.

**Step 2: Add marquee analysis in `main.js`**

Add imports:
```javascript
import { initMarquee, setOnAnalyze, clearMarquee } from './marquee.js';
import { detectFontMarquee, cropToGrayscale } from './font_detect.js';
```

Replace the existing `canvas.addEventListener("dblclick", ...)` handler (lines 657-714) with the marquee analyze callback:

```javascript
setOnAnalyze(async (m) => {
    const page = state.currentPage;
    if (!state.pageImages?.[page]) {
        showToast("Page not loaded yet", "error");
        return;
    }

    const imageData = state.pageImages[page].imageData;

    // Auto-detect redaction box within the marquee
    const box = findRedactionInRegion(
        imageData,
        Math.round(m.x), Math.round(m.y),
        Math.round(m.x + m.w), Math.round(m.y + m.h),
        0
    );
    if (!box) {
        showToast("No redaction found in selection", "error");
        return;
    }

    // Show detected box on marquee
    m.detectedBox = box;
    renderCanvas();

    // Crop the marquee region to grayscale
    const cropX = Math.round(m.x);
    const cropY = Math.round(m.y);
    const cropW = Math.min(Math.round(m.w), imageData.width - cropX);
    const cropH = Math.min(Math.round(m.h), imageData.height - cropY);
    const cropGray = cropToGrayscale(imageData, cropX, cropY, cropW, cropH);

    // Redaction box position relative to the crop
    const relBox = {
        x: box.x - cropX,
        y: box.y - cropY,
        w: box.w,
        h: box.h,
    };

    // Split OCR text into left/right of the redaction box
    const ocrLines = (state.ocrData?.[page]) || [];
    let leftText = '';
    let rightText = '';

    // Find the OCR line that overlaps the box
    let bestLine = null;
    let bestOverlap = 0;
    for (const line of ocrLines) {
        const overlap = Math.max(0,
            Math.min(box.y + box.h, line.y + line.h) - Math.max(box.y, line.y)
        );
        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestLine = line;
        }
    }

    if (bestLine?.chars) {
        const leftChars = bestLine.chars.filter(c => c.x + c.w / 2 < box.x);
        const rightChars = bestLine.chars.filter(c => c.x + c.w / 2 > box.x + box.w);
        leftText = leftChars.map(c => c.text).join('').trim();
        rightText = rightChars.map(c => c.text).join('').trim();
    }

    // LLM boundary text (if API key available)
    const apiKey = await getSetting('anthropic_api_key');
    if (apiKey && bestLine) {
        try {
            const boundary = await identifyBoundaryText(bestLine, box.x, box.w, apiKey);
            leftText = boundary.leftText;
            rightText = boundary.rightText;
        } catch (_e) {
            // Keep OCR-based text
        }
    }

    // Run font detection
    const candidates = state.fonts.filter(f => f.available).map(f => f.name);
    showToast("Detecting font...", "info");
    const match = detectFontMarquee(cropGray, cropW, cropH, relBox, leftText, rightText, candidates);

    // Get font ID
    const fontId = (state.fonts.find(f => f.name === match.fontName) || {}).id
        || match.fontName.toLowerCase().replace(/\s+/g, '-');

    // Create redaction entry
    const id = `p${page}-r${box.x}-${box.y}-${box.w}-${box.h}`;
    const analysis = {
        font: { id: fontId, name: match.fontName, size: match.fontSize },
        gap: { x: box.x, y: box.y, w: box.w, h: box.h },
        line: bestLine
            ? { text: bestLine.text, x: bestLine.x, y: bestLine.y, w: bestLine.w, h: bestLine.h }
            : { text: '', x: box.x, y: box.y, w: box.w, h: box.h },
        segments: [
            { text: leftText, side: 'left' },
            { text: rightText, side: 'right' },
        ],
        offset_x: match.xOffset,
        offset_y: match.yOffset,
    };

    state.redactions[id] = {
        id,
        x: box.x, y: box.y, w: box.w, h: box.h,
        page,
        status: "analyzed",
        analysis,
        solution: null,
        preview: null,
        overrides: {
            fontId,
            fontSize: match.fontSize,
            offsetX: match.xOffset,
            offsetY: match.yOffset,
            gapWidth: box.w,
            leftText,
            rightText,
        },
    };

    clearMarquee();
    renderRedactionList();
    renderCanvas();
    activateRedaction(id);
    showToast(`Font detected: ${match.fontName} ${match.fontSize.toFixed(1)}px (score: ${match.score.toFixed(3)})`, "success");
});
```

**Step 3: Initialize marquee in the init section**

Near the bottom of `main.js` where other modules are initialized (around line 1015-1022), add:
```javascript
initMarquee();
```

**Step 4: Remove the old double-click handler**

Delete the `canvas.addEventListener("dblclick", ...)` block (lines 657-714).

**Step 5: Also remove the `analyzeRedaction` function**

The `analyzeRedaction` function (lines 367-432) is only called by the old double-click handler and `runAnalysis`. For now, keep `runAnalysis` calling it (batch mode still uses the old approach). We can migrate `runAnalysis` to the new approach later.

Actually — keep `analyzeRedaction` for now since `runAnalysis` (the "Detect Redactions" button) still uses it. Just remove the double-click handler that was the entry point.

**Step 6: Verify end-to-end**

1. Load a PDF with `make dev-static`
2. Wait for OCR to complete
3. Shift+drag a marquee around a redaction and its surrounding text
4. Click "Analyze"
5. Should detect the redaction box, run font detection, populate the popover
6. Check the font debug panel (`?fontdebug=1`) — should show baseline-aligned renders with decimal font sizes

**Step 7: Commit**
```bash
git add unredact/static/main.js unredact/static/font_detect.js
git commit -m "feat: wire marquee selection to font detection pipeline"
```

---

### Task 5: Update Font Debug Panel

**Files:**
- Modify: `unredact/static/font_debug.js` — show decimal sizes and offsets

**Step 1: Update candidate label in `showDebug`**

In `font_debug.js:149`, change the label to show decimal precision and offsets:

Replace:
```javascript
label.textContent = `#${i + 1} ${c.fontName} ${c.fontSize}px — ${c.score.toFixed(3)}`;
```

With:
```javascript
const sizeStr = Number.isInteger(c.fontSize) ? `${c.fontSize}` : c.fontSize.toFixed(1);
const offsetStr = (c.xOffset != null || c.yOffset != null)
    ? ` (x:${(c.xOffset||0).toFixed(1)} y:${(c.yOffset||0).toFixed(1)})`
    : '';
label.textContent = `#${i + 1} ${c.fontName} ${sizeStr}px${offsetStr} — ${c.score.toFixed(3)}`;
```

**Step 2: Verify visually**

With `?fontdebug=1`, run the marquee analysis. Debug panel should show entries like:
```
#1 Liberation Serif 38.3px (x:0.4 y:-1.2) — 0.872
```

**Step 3: Commit**
```bash
git add unredact/static/font_debug.js
git commit -m "feat: show decimal font sizes and offsets in debug panel"
```

---

### Task 6: Update Canvas Rendering for Float Font Sizes

**Files:**
- Modify: `unredact/static/canvas.js` — support float fontSize in overlay rendering

**Step 1: Update `drawRedactionAnalyzed` to use float sizes**

In `canvas.js:151`, the font string already uses template literals:
```javascript
const fontStr = `${fontSize}px "${fontName}"`;
```

This already supports floats — `14.3px` is valid CSS. No change needed to the rendering code.

**Step 2: Update the gap width label to show the float size**

In `canvas.js:175`:
```javascript
const label = `${Math.round(gapW)}px`;
```

This is fine — gap width should stay as integer display since it's a pixel measurement of the redaction box.

**Step 3: Update the font toolbar size display**

In `main.js` or wherever the size slider updates, ensure it can show decimal values. Check `dom.js:49` — `sizeSlider` and `sizeValue`. The slider likely uses integer steps.

Modify the slider to support 0.1 step if it doesn't already. In the HTML (or wherever the slider is configured), the `step` attribute should be `"0.1"`. This may require changes to the HTML file.

Check and update the slider step. In `unredact/static/index.html` (or wherever the HTML lives), find the size slider input and set `step="0.1"`.

**Step 4: Commit**
```bash
git add unredact/static/canvas.js
git commit -m "feat: support float font sizes in canvas overlay rendering"
```

---

### Task 7: Clean Up Old Code

**Files:**
- Modify: `unredact/static/font_detect.js` — remove dead functions

**Step 1: Remove dead code**

Verify these functions are no longer called anywhere:
- `renderTextGray` — only used by old `detectFont`
- `renderRunsGray` — only used by old `detectFontMasked`
- `groupCharRuns` — only used by old `detectFontMasked`
- `maskRedactions` — replaced by `maskRegion`

Search for references:
```bash
grep -rn 'renderTextGray\|renderRunsGray\|groupCharRuns\|maskRedactions' unredact/static/
```

If no external references, delete these functions.

**Step 2: Verify `detectFont` and `detectFontMasked` usage**

```bash
grep -rn 'detectFont\b\|detectFontMasked' unredact/static/
```

If `runAnalysis` (the batch "Detect Redactions" button) still uses `detectFontMasked`, keep it for now. Otherwise remove.

**Step 3: Commit**
```bash
git add unredact/static/font_detect.js
git commit -m "chore: remove dead font detection code"
```

---

### Verification Checklist

After all tasks are complete, verify:

1. [ ] Shift+drag draws a marquee on the document
2. [ ] Marquee has resize handles and can be adjusted
3. [ ] Escape dismisses the marquee
4. [ ] "Analyze" button appears after drawing
5. [ ] Clicking "Analyze" detects the redaction box within the selection
6. [ ] Font detection runs with sub-pixel precision
7. [ ] Debug panel (`?fontdebug=1`) shows decimal font sizes and aligned baselines
8. [ ] All text in the debug comparison renders on the same baseline
9. [ ] Popover opens with detected font, left/right text, and gap width
10. [ ] Existing "Detect Redactions" batch button still works
11. [ ] No console errors
