// @ts-check
/// <reference path="types.js" />

/** @type {any} */
let worker = null;

/**
 * Initialize Tesseract.js worker. Loads the WASM engine and English language data.
 * This is slow (~10-15s first time, cached after).
 */
export async function initOcr() {
    if (worker) return;
    const { default: Tesseract } = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js');
    worker = await Tesseract.createWorker('eng', 1, {
        // logger: m => console.log(m), // uncomment for debug
    });
    await worker.setParameters({
        tessedit_pageseg_mode: '6', // PSM 6: single block of text
    });
}

/**
 * @typedef {{ text: string, x: number, y: number, w: number, h: number, confidence: number }} OcrChar
 * @typedef {{ text: string, x: number, y: number, w: number, h: number, chars: OcrChar[] }} OcrLine
 */

/**
 * Run OCR on a page image and return lines with per-character bounding boxes.
 * @param {ImageData|Blob} image - page image to OCR
 * @param {(progress: number) => void} [onProgress] - progress callback (0-1)
 * @returns {Promise<OcrLine[]>}
 */
export async function ocrPage(image, onProgress) {
    if (!worker) await initOcr();

    const result = await worker.recognize(image);

    // Tesseract.js returns data.words[] with bounding boxes
    // Group words into lines, estimate character positions within each word
    const lines = groupIntoLines(result.data.words);

    if (onProgress) onProgress(1.0);
    return lines;
}

/**
 * Group Tesseract words into lines by y-coordinate proximity,
 * then estimate per-character positions within each word.
 * @param {any[]} words - Tesseract.js word objects
 * @returns {OcrLine[]}
 */
function groupIntoLines(words) {
    if (!words || words.length === 0) return [];

    // Sort words by vertical position, then horizontal
    const sorted = [...words].sort((a, b) => {
        const ay = a.bbox.y0;
        const by = b.bbox.y0;
        if (Math.abs(ay - by) > 10) return ay - by;
        return a.bbox.x0 - b.bbox.x0;
    });

    // Group into lines: words whose y-center is within half the line height
    const lines = [];
    let currentLine = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
        const word = sorted[i];
        const lineY = currentLine[0].bbox.y0;
        const lineH = currentLine[0].bbox.y1 - currentLine[0].bbox.y0;

        // Same line if y-center is within half line height
        const wordCenterY = (word.bbox.y0 + word.bbox.y1) / 2;
        const lineCenterY = lineY + lineH / 2;

        if (Math.abs(wordCenterY - lineCenterY) < lineH * 0.5) {
            currentLine.push(word);
        } else {
            lines.push(currentLine);
            currentLine = [word];
        }
    }
    lines.push(currentLine);

    // Convert each line group to OcrLine
    return lines.map(lineWords => {
        // Sort words left to right
        lineWords.sort((a, b) => a.bbox.x0 - b.bbox.x0);

        /** @type {OcrChar[]} */
        const chars = [];

        for (let wi = 0; wi < lineWords.length; wi++) {
            const w = lineWords[wi];
            const text = w.text;
            const wx = w.bbox.x0;
            const wy = w.bbox.y0;
            const ww = w.bbox.x1 - w.bbox.x0;
            const wh = w.bbox.y1 - w.bbox.y0;
            const conf = w.confidence;

            // Estimate per-character positions by dividing word width evenly
            const charCount = text.length;
            if (charCount > 0) {
                const charWidth = ww / charCount;
                for (let ci = 0; ci < charCount; ci++) {
                    chars.push({
                        text: text[ci],
                        x: Math.round(wx + ci * charWidth),
                        y: wy,
                        w: Math.max(1, Math.round(charWidth)),
                        h: wh,
                        confidence: conf,
                    });
                }
            }

            // Add space character between words (except after last word)
            if (wi < lineWords.length - 1) {
                const nextWord = lineWords[wi + 1];
                const spaceX = w.bbox.x1;
                const spaceW = nextWord.bbox.x0 - spaceX;
                if (spaceW > 0) {
                    chars.push({
                        text: ' ',
                        x: spaceX,
                        y: wy,
                        w: spaceW,
                        h: wh,
                        confidence: conf,
                    });
                }
            }
        }

        if (chars.length === 0) {
            return null;
        }

        // Compute line bounding box from characters (matches Python logic)
        const lineX = chars[0].x;
        const lineY = Math.min(...chars.map(c => c.y));
        const lastChar = chars[chars.length - 1];
        const lineW = (lastChar.x + lastChar.w) - lineX;
        const lineH = Math.max(...chars.map(c => c.y + c.h)) - lineY;
        const lineText = chars.map(c => c.text).join('');

        return {
            text: lineText,
            x: lineX,
            y: lineY,
            w: lineW,
            h: lineH,
            chars,
        };
    }).filter(/** @returns {line is OcrLine} */ line => line !== null);
}

/**
 * Extract a rectangular region from an ImageData as a new ImageData.
 * @param {ImageData} src - full page RGBA image
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @returns {ImageData}
 */
export function cropImageData(src, x, y, w, h) {
    x = Math.max(0, Math.round(x));
    y = Math.max(0, Math.round(y));
    w = Math.max(1, Math.min(Math.round(w), src.width - x));
    h = Math.max(1, Math.min(Math.round(h), src.height - y));
    const dst = new ImageData(w, h);
    for (let row = 0; row < h; row++) {
        const srcOff = ((y + row) * src.width + x) * 4;
        const dstOff = row * w * 4;
        dst.data.set(src.data.subarray(srcOff, srcOff + w * 4), dstOff);
    }
    return dst;
}

/**
 * Mask a rectangular region to white (255,255,255,255) in an ImageData.
 * Mutates in place.
 * @param {ImageData} img
 * @param {number} rx
 * @param {number} ry
 * @param {number} rw
 * @param {number} rh
 */
export function maskBoxRGBA(img, rx, ry, rw, rh) {
    const x0 = Math.max(0, Math.round(rx));
    const y0 = Math.max(0, Math.round(ry));
    const x1 = Math.min(img.width, Math.round(rx + rw));
    const y1 = Math.min(img.height, Math.round(ry + rh));
    for (let row = y0; row < y1; row++) {
        const start = (row * img.width + x0) * 4;
        const end = (row * img.width + x1) * 4;
        img.data.fill(255, start, end);
    }
}

/**
 * Terminate the OCR worker (cleanup).
 */
export async function terminateOcr() {
    if (worker) {
        await worker.terminate();
        worker = null;
    }
}
