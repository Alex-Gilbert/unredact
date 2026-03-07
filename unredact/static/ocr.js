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
    const Tesseract = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js');
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
 * Terminate the OCR worker (cleanup).
 */
export async function terminateOcr() {
    if (worker) {
        await worker.terminate();
        worker = null;
    }
}
