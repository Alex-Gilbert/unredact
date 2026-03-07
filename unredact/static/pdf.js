// @ts-check
/// <reference path="types.js" />

const RENDER_DPI = 300;
const CSS_DPI = 96;
const SCALE = RENDER_DPI / CSS_DPI;

/** @type {any} */
let pdfjsLib = null;

/**
 * Initialize PDF.js via dynamic import from CDN.
 * Must be called (and awaited) before loadPdf/renderPage.
 */
export async function initPdfJs() {
    if (pdfjsLib) return;
    pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
}

/**
 * Load a PDF from an ArrayBuffer.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{ pageCount: number, doc: any }>}
 */
export async function loadPdf(buffer) {
    if (!pdfjsLib) await initPdfJs();
    const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
    return { pageCount: doc.numPages, doc };
}

/**
 * Render a single page to an ImageData + Blob.
 * @param {any} doc - PDF.js document
 * @param {number} pageNum - 1-based page number
 * @returns {Promise<{ imageData: ImageData, blob: Blob, width: number, height: number }>}
 */
export async function renderPage(doc, pageNum) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = new OffscreenCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport }).promise;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return {
        imageData,
        blob,
        width: canvas.width,
        height: canvas.height,
    };
}
