// @ts-check
/// <reference path="types.js" />

import { scoreFont } from './wasm.js';

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
 * Extract grayscale pixels from a region of an ImageData.
 * @param {ImageData} imageData - full page RGBA
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @returns {Uint8Array}
 */
function cropToGrayscale(imageData, x, y, w, h) {
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
export function detectFont(pageImageData, line, candidates) {
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

    const minSize = Math.max(8, Math.round(cropH * 0.5));
    const maxSize = Math.min(120, Math.round(cropH * 1.5));

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

    return { fontName: bestFont, fontSize: bestSize, score: bestScore };
}

/**
 * Detect font for a line, masking out redaction boxes.
 * Only scores visible (non-redacted) text regions.
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

    // Find clean char runs (chars not inside any redaction box)
    const cleanChars = line.chars.filter(c => {
        const cx = c.x + c.w / 2;
        return !overlapping.some(b => cx >= b.x && cx <= b.x + b.w);
    });

    if (cleanChars.length === 0) {
        return detectFont(pageImageData, line, candidates);
    }

    // Build clean text from clean chars
    const cleanText = cleanChars.map(c => c.text).join('');

    // Use the clean chars as a sub-line for detection
    const subLine = {
        text: cleanText,
        x: cleanChars[0].x,
        y: line.y,
        w: cleanChars[cleanChars.length - 1].x + cleanChars[cleanChars.length - 1].w - cleanChars[0].x,
        h: line.h,
    };

    return detectFont(pageImageData, subLine, candidates);
}
