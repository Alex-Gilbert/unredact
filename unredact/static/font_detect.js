// @ts-check
/// <reference path="types.js" />

import { scoreFont } from './wasm.js';
import { debugEnabled, showDebug } from './font_debug.js';
import { goldenSection } from './optimize.js';

/**
 * Default candidate fonts to try. These should match bundled WOFF2 names.
 * Users can add more via font upload.
 */
const DEFAULT_CANDIDATES = [
    'Liberation Serif',
    'Liberation Sans',
    'Liberation Mono',
    'DejaVu Serif',
    'DejaVu Sans',
];

/**
 * Extract grayscale pixels from a Canvas/OffscreenCanvas rendering.
 * @param {OffscreenCanvas} canvas
 * @returns {Uint8Array}
 */
function canvasToGrayscale(canvas) {
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rgba = imageData.data;
    const n = canvas.width * canvas.height;
    const gray = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const r = rgba[i * 4];
        const g = rgba[i * 4 + 1];
        const b = rgba[i * 4 + 2];
        gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    return gray;
}

/**
 * Render text onto an OffscreenCanvas with the given font.
 * Returns grayscale pixels for Dice scoring.
 * @param {string} text
 * @param {string} fontName
 * @param {number} fontSize
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} grayscale pixels
 */
function renderTextGray(text, fontName, fontSize, width, height) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    // White background
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);
    // Black text
    ctx.fillStyle = 'black';
    ctx.font = `${fontSize}px "${fontName}"`;
    ctx.textBaseline = 'top';
    ctx.fillText(text, 0, 0);
    return canvasToGrayscale(canvas);
}

/**
 * Render character runs at their OCR positions onto a canvas.
 * Each run is rendered at its crop-relative (x, y) position.
 * @param {Array<Array<{text: string, x: number, y: number, w: number, h: number}>>} charRuns
 * @param {string} fontName
 * @param {number} fontSize
 * @param {number} lineX - line origin x (subtracted from char positions)
 * @param {number} lineY - line origin y
 * @param {number} width - canvas width
 * @param {number} height - canvas height
 * @returns {Uint8Array} grayscale pixels
 */
function renderRunsGray(charRuns, fontName, fontSize, lineX, lineY, width, height) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'black';
    ctx.font = `${fontSize}px "${fontName}"`;
    ctx.textBaseline = 'top';

    for (const run of charRuns) {
        const text = run.map(c => c.text).join('');
        if (!text.trim()) continue;
        // Crop-relative position of the run's first char
        const cx = run[0].x - lineX;
        const cy = run[0].y - lineY;
        ctx.fillText(text, cx, cy);
    }
    return canvasToGrayscale(canvas);
}

/**
 * Render left and right text segments with a gap between them.
 * Both segments share the same y position (consistent baseline).
 * Text is rendered as continuous strings with natural browser kerning.
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

/**
 * Extract grayscale pixels from a region of an ImageData.
 * @param {ImageData} imageData - full page RGBA
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @returns {Uint8Array}
 */
export function cropToGrayscale(imageData, x, y, w, h) {
    x = Math.max(0, x);
    y = Math.max(0, y);
    w = Math.min(w, imageData.width - x);
    h = Math.min(h, imageData.height - y);
    const gray = new Uint8Array(w * h);
    const fullW = imageData.width;
    const rgba = imageData.data;
    for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
            const srcIdx = ((y + row) * fullW + (x + col)) * 4;
            const r = rgba[srcIdx];
            const g = rgba[srcIdx + 1];
            const b = rgba[srcIdx + 2];
            gray[row * w + col] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        }
    }
    return gray;
}

/**
 * Mask redaction boxes to white (255) in a grayscale crop.
 * @param {Uint8Array} gray - grayscale pixels (mutated in place)
 * @param {number} cropW
 * @param {number} cropX - crop origin x in page coords
 * @param {number} cropY - crop origin y in page coords
 * @param {Array<{x: number, y: number, w: number, h: number}>} boxes
 */
function maskRedactions(gray, cropW, cropH, cropX, cropY, boxes) {
    for (const b of boxes) {
        const x0 = Math.max(0, b.x - cropX);
        const y0 = Math.max(0, b.y - cropY);
        const x1 = Math.min(cropW, b.x + b.w - cropX);
        const y1 = Math.min(cropH, b.y + b.h - cropY);
        for (let row = y0; row < y1; row++) {
            for (let col = x0; col < x1; col++) {
                gray[row * cropW + col] = 255;
            }
        }
    }
}

/**
 * Mask a rectangular region to white (255) in a grayscale buffer.
 * @param {Uint8Array} gray - grayscale pixels (mutated in place)
 * @param {number} bufW - buffer width
 * @param {number} bufH - buffer height
 * @param {number} rx - region x
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

/**
 * Group chars into spatially adjacent runs (like words).
 * @param {Array<{text: string, x: number, y: number, w: number, h: number}>} chars
 * @returns {Array<Array<{text: string, x: number, y: number, w: number, h: number}>>}
 */
function groupCharRuns(chars) {
    if (chars.length === 0) return [];
    const runs = [];
    let current = [chars[0]];
    for (let i = 1; i < chars.length; i++) {
        const c = chars[i];
        const prev = current[current.length - 1];
        // Same vertical position and horizontally adjacent (within 5px gap)
        if (Math.abs(c.y - prev.y) < 5 && c.x <= prev.x + prev.w + 5) {
            current.push(c);
        } else {
            runs.push(current);
            current = [c];
        }
    }
    runs.push(current);
    return runs;
}

/**
 * @typedef {{ fontName: string, fontSize: number, score: number }} FontMatch
 */

/**
 * Detect the best matching font for a line of text.
 *
 * @param {ImageData} pageImageData - full page RGBA image
 * @param {{ text: string, x: number, y: number, w: number, h: number }} line - OCR line
 * @param {string[]} [candidates] - font names to try
 * @returns {FontMatch}
 */
function detectFont(pageImageData, line, candidates) {
    const fonts = candidates || DEFAULT_CANDIDATES;
    const cropW = Math.min(line.w, pageImageData.width - line.x);
    const cropH = Math.min(line.h, pageImageData.height - line.y);

    if (cropW <= 0 || cropH <= 0 || !line.text.trim()) {
        return { fontName: fonts[0], fontSize: Math.round(line.h * 0.8), score: 0 };
    }

    const pageGray = cropToGrayscale(pageImageData, line.x, line.y, cropW, cropH);

    let bestScore = -1;
    let bestFont = fonts[0];
    let bestSize = Math.round(line.h * 0.8);

    // Use median char height for size estimation if chars available
    const charHeights = line.chars
        ? line.chars.filter(c => c.text.trim()).map(c => c.h)
        : [];
    const estimatedH = charHeights.length > 0
        ? charHeights.sort((a, b) => a - b)[Math.floor(charHeights.length / 2)]
        : cropH;

    const minSize = Math.max(8, Math.round(estimatedH * 0.6));
    const maxSize = Math.min(120, Math.round(estimatedH * 1.4));

    // Coarse search: step by 2
    for (const fontName of fonts) {
        for (let size = minSize; size <= maxSize; size += 2) {
            const rendered = renderTextGray(line.text, fontName, size, cropW, cropH);
            const score = scoreFont(pageGray, rendered, cropW, cropH);
            if (score > bestScore) {
                bestScore = score;
                bestFont = fontName;
                bestSize = size;
            }
        }
    }

    // Track best per font for debug
    /** @type {Map<string, {fontName: string, fontSize: number, score: number}>} */
    const bestPerFont = new Map();
    if (debugEnabled()) {
        for (const fontName of fonts) {
            let fb = { fontName, fontSize: minSize, score: -1 };
            for (let size = minSize; size <= maxSize; size += 2) {
                const rendered = renderTextGray(line.text, fontName, size, cropW, cropH);
                const score = scoreFont(pageGray, rendered, cropW, cropH);
                if (score > fb.score) { fb = { fontName, fontSize: size, score }; }
            }
            // Fine search per font
            for (let size = Math.max(8, fb.fontSize - 3); size <= Math.min(120, fb.fontSize + 3); size++) {
                const rendered = renderTextGray(line.text, fontName, size, cropW, cropH);
                const score = scoreFont(pageGray, rendered, cropW, cropH);
                if (score > fb.score) { fb = { fontName, fontSize: size, score }; }
            }
            bestPerFont.set(fontName, fb);
        }
    }

    // Fine search: ±3 around best, step by 1
    const fineMin = Math.max(8, bestSize - 3);
    const fineMax = Math.min(120, bestSize + 3);
    for (let size = fineMin; size <= fineMax; size++) {
        const rendered = renderTextGray(line.text, bestFont, size, cropW, cropH);
        const score = scoreFont(pageGray, rendered, cropW, cropH);
        if (score > bestScore) {
            bestScore = score;
            bestSize = size;
        }
    }

    // Debug: show top candidates
    if (debugEnabled()) {
        // Update winner in bestPerFont
        bestPerFont.set(bestFont, { fontName: bestFont, fontSize: bestSize, score: bestScore });
        const sorted = [...bestPerFont.values()].sort((a, b) => b.score - a.score);
        const debugCandidates = sorted.slice(0, 5).map(c => ({
            ...c,
            rendered: renderTextGray(line.text, c.fontName, c.fontSize, cropW, cropH),
        }));
        showDebug(pageGray, cropW, cropH, debugCandidates);
    }

    return { fontName: bestFont, fontSize: bestSize, score: bestScore };
}

/**
 * Detect font for a line, masking out redaction boxes.
 * Masks redaction pixels to white and renders clean char runs
 * at their actual OCR positions for accurate scoring.
 *
 * @param {ImageData} pageImageData
 * @param {{ text: string, x: number, y: number, w: number, h: number, chars: Array<{text: string, x: number, y: number, w: number, h: number}> }} line
 * @param {Array<{x: number, y: number, w: number, h: number}>} redactionBoxes
 * @param {string[]} [candidates]
 * @returns {FontMatch}
 */
export function detectFontMasked(pageImageData, line, redactionBoxes, candidates) {
    // If no redactions overlap this line, just use normal detection
    const overlapping = redactionBoxes.filter(b =>
        b.y < line.y + line.h && b.y + b.h > line.y &&
        b.x < line.x + line.w && b.x + b.w > line.x
    );
    if (overlapping.length === 0) {
        return detectFont(pageImageData, line, candidates);
    }

    const fonts = candidates || DEFAULT_CANDIDATES;
    const cropW = Math.min(line.w, pageImageData.width - line.x);
    const cropH = Math.min(line.h, pageImageData.height - line.y);

    if (cropW <= 0 || cropH <= 0) {
        return { fontName: fonts[0], fontSize: Math.round(line.h * 0.8), score: 0 };
    }

    // 1. Crop line region and mask redaction boxes to white
    const pageGray = cropToGrayscale(pageImageData, line.x, line.y, cropW, cropH);
    maskRedactions(pageGray, cropW, cropH, line.x, line.y, overlapping);

    // 2. Filter clean chars (not inside redaction boxes)
    const cleanChars = line.chars.filter(c => {
        const cx = c.x + c.w / 2;
        const cy = c.y + c.h / 2;
        return !overlapping.some(b =>
            cx >= b.x && cx <= b.x + b.w &&
            cy >= b.y && cy <= b.y + b.h
        );
    });

    if (cleanChars.length === 0) {
        return detectFont(pageImageData, line, candidates);
    }

    // 3. Group clean chars into spatial runs
    const charRuns = groupCharRuns(cleanChars);

    // 4. Use median char height for size estimation
    const charHeights = cleanChars.filter(c => c.text.trim()).map(c => c.h);
    const estimatedH = charHeights.length > 0
        ? charHeights.sort((a, b) => a - b)[Math.floor(charHeights.length / 2)]
        : cropH;

    const minSize = Math.max(8, Math.round(estimatedH * 0.6));
    const maxSize = Math.min(120, Math.round(estimatedH * 1.4));

    let bestScore = -1;
    let bestFont = fonts[0];
    let bestSize = Math.round(estimatedH * 0.8);

    // 5. Coarse search: render runs at OCR positions, score against masked crop
    for (const fontName of fonts) {
        for (let size = minSize; size <= maxSize; size += 2) {
            const rendered = renderRunsGray(charRuns, fontName, size, line.x, line.y, cropW, cropH);
            const score = scoreFont(pageGray, rendered, cropW, cropH);
            if (score > bestScore) {
                bestScore = score;
                bestFont = fontName;
                bestSize = size;
            }
        }
    }

    // Track best per font for debug
    /** @type {Map<string, {fontName: string, fontSize: number, score: number}>} */
    const bestPerFont = new Map();
    if (debugEnabled()) {
        for (const fontName of fonts) {
            let fb = { fontName, fontSize: minSize, score: -1 };
            for (let size = minSize; size <= maxSize; size += 2) {
                const rendered = renderRunsGray(charRuns, fontName, size, line.x, line.y, cropW, cropH);
                const score = scoreFont(pageGray, rendered, cropW, cropH);
                if (score > fb.score) { fb = { fontName, fontSize: size, score }; }
            }
            for (let size = Math.max(8, fb.fontSize - 3); size <= Math.min(120, fb.fontSize + 3); size++) {
                const rendered = renderRunsGray(charRuns, fontName, size, line.x, line.y, cropW, cropH);
                const score = scoreFont(pageGray, rendered, cropW, cropH);
                if (score > fb.score) { fb = { fontName, fontSize: size, score }; }
            }
            bestPerFont.set(fontName, fb);
        }
    }

    // 6. Fine search: ±3 around best
    const fineMin = Math.max(8, bestSize - 3);
    const fineMax = Math.min(120, bestSize + 3);
    for (let size = fineMin; size <= fineMax; size++) {
        const rendered = renderRunsGray(charRuns, bestFont, size, line.x, line.y, cropW, cropH);
        const score = scoreFont(pageGray, rendered, cropW, cropH);
        if (score > bestScore) {
            bestScore = score;
            bestSize = size;
        }
    }

    // Debug: show top candidates
    if (debugEnabled()) {
        bestPerFont.set(bestFont, { fontName: bestFont, fontSize: bestSize, score: bestScore });
        const sorted = [...bestPerFont.values()].sort((a, b) => b.score - a.score);
        const debugCandidates = sorted.slice(0, 5).map(c => ({
            ...c,
            rendered: renderRunsGray(charRuns, c.fontName, c.fontSize, line.x, line.y, cropW, cropH),
        }));
        showDebug(pageGray, cropW, cropH, debugCandidates);
    }

    return { fontName: bestFont, fontSize: bestSize, score: bestScore };
}

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

    const minSize = Math.max(6, cropH * 0.3);
    const maxSize = Math.min(200, cropH * 1.5);

    /** @type {Array<FontMatchResult>} */
    const perFontBest = [];

    for (const fontName of candidates) {
        const evaluate = (fontSize, xOff, yOff) => {
            const rendered = renderSegmentsGray(
                leftText, rightText, box.w, fontName, fontSize,
                xOff, yOff, cropW, cropH
            );
            maskRegion(rendered, cropW, cropH, box.x, box.y, box.w, box.h);
            return scoreFont(maskedCrop, rendered, cropW, cropH);
        };

        // Phase 1: Coarse scan on fontSize
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

        // Phase 3: Golden-section on y-offset
        const yResult = goldenSection(
            y => evaluate(optSize, 0, y),
            -5, 5, 0.1
        );
        const optY = yResult.x;

        // Phase 4: Golden-section on x-offset
        const xResult = goldenSection(
            x => evaluate(optSize, x, optY),
            -5, 5, 0.1
        );
        const optX = xResult.x;

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
            xOffset: c.xOffset,
            yOffset: c.yOffset,
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
