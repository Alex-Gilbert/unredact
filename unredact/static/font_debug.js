// @ts-check
/// <reference path="types.js" />

/**
 * Font matching debug visualization.
 * Enable with: window.FONT_DEBUG = true  (in browser console)
 * Or URL param: ?fontdebug=1
 */

const params = new URLSearchParams(window.location.search);
let _enabled = params.get('fontdebug') === '1';

/** @returns {boolean} */
export function debugEnabled() {
    // @ts-ignore
    return _enabled || !!window.FONT_DEBUG;
}

export function enableDebug() {
    _enabled = true;
}

/** @type {HTMLDivElement|null} */
let _panel = null;

function getPanel() {
    if (_panel) return _panel;
    _panel = document.createElement('div');
    _panel.id = 'font-debug-panel';
    _panel.style.cssText = `
        position: fixed; bottom: 0; left: 0; right: 0;
        max-height: 50vh; overflow-y: auto;
        background: #1a1a2e; color: #eee; font-family: monospace; font-size: 12px;
        z-index: 10000; border-top: 2px solid #0f0;
        display: none;
    `;
    const header = document.createElement('div');
    header.style.cssText = `
        padding: 4px 8px; background: #16213e; display: flex;
        justify-content: space-between; align-items: center;
        position: sticky; top: 0; z-index: 1;
    `;
    header.innerHTML = `<span>Font Debug</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = 'background: #333; color: #eee; border: 1px solid #555; padding: 2px 8px; cursor: pointer;';
    closeBtn.onclick = () => { _panel.style.display = 'none'; };
    header.appendChild(closeBtn);
    _panel.appendChild(header);
    document.body.appendChild(_panel);
    return _panel;
}

/**
 * Render a grayscale Uint8Array as a canvas.
 * @param {Uint8Array} gray
 * @param {number} w
 * @param {number} h
 * @returns {HTMLCanvasElement}
 */
function grayToCanvas(gray, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < gray.length; i++) {
        const v = gray[i];
        img.data[i * 4] = v;
        img.data[i * 4 + 1] = v;
        img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
}

/**
 * Render an overlap map: green=both dark, red=page-only, blue=rendered-only.
 * Uses grayscale intensity rather than binary threshold.
 * @param {Uint8Array} pageGray
 * @param {Uint8Array} renderedGray
 * @param {number} w
 * @param {number} h
 * @returns {HTMLCanvasElement}
 */
function overlapCanvas(pageGray, renderedGray, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const thresh = 200; // anything darker than this is "ink"
    for (let i = 0; i < pageGray.length; i++) {
        const p = pageGray[i] < thresh;
        const r = renderedGray[i] < thresh;
        let red = 30, green = 30, blue = 30;
        if (p && r) { green = 200; } // both = green
        else if (p) { red = 220; green = 50; blue = 50; } // page only = red
        else if (r) { red = 50; green = 100; blue = 220; } // rendered only = blue
        img.data[i * 4] = red;
        img.data[i * 4 + 1] = green;
        img.data[i * 4 + 2] = blue;
        img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
}

/**
 * Show debug info for a font detection run.
 * @param {Uint8Array} pageGray - page crop grayscale
 * @param {number} w
 * @param {number} h
 * @param {Array<{fontName: string, fontSize: number, score: number, rendered: Uint8Array, xOffset?: number, yOffset?: number}>} candidates
 */
export function showDebug(pageGray, w, h, candidates) {
    const panel = getPanel();
    panel.style.display = 'block';

    const section = document.createElement('div');
    section.style.cssText = 'padding: 8px; border-bottom: 1px solid #333;';

    const title = document.createElement('div');
    title.style.cssText = 'margin-bottom: 6px; color: #0f0;';
    title.textContent = `Font match — ${candidates.length} candidates (${w}×${h})`;
    section.appendChild(title);

    // Page crop
    const cropLabel = document.createElement('div');
    cropLabel.textContent = 'Page crop:';
    cropLabel.style.cssText = 'margin-bottom: 2px; color: #aaa;';
    section.appendChild(cropLabel);
    const cropCanvas = grayToCanvas(pageGray, w, h);
    cropCanvas.style.cssText = 'border: 1px solid #555; margin-bottom: 8px; image-rendering: pixelated;';
    section.appendChild(cropCanvas);

    // Candidates grid
    const grid = document.createElement('div');
    grid.style.cssText = 'display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px;';

    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const card = document.createElement('div');
        card.style.cssText = 'flex-shrink: 0;';

        const label = document.createElement('div');
        label.style.cssText = `margin-bottom: 2px; color: ${i === 0 ? '#0f0' : '#aaa'};`;
        const sizeStr = Number.isInteger(c.fontSize) ? `${c.fontSize}` : c.fontSize.toFixed(1);
        const offsetStr = (c.xOffset != null || c.yOffset != null)
            ? ` (x:${(c.xOffset||0).toFixed(1)} y:${(c.yOffset||0).toFixed(1)})`
            : '';
        label.textContent = `#${i + 1} ${c.fontName} ${sizeStr}px${offsetStr} — ${c.score.toFixed(3)}`;
        card.appendChild(label);

        // Rendered
        const rendCanvas = grayToCanvas(c.rendered, w, h);
        rendCanvas.style.cssText = 'border: 1px solid #555; display: block; margin-bottom: 2px; image-rendering: pixelated;';
        card.appendChild(rendCanvas);

        // Overlap
        const olCanvas = overlapCanvas(pageGray, c.rendered, w, h);
        olCanvas.style.cssText = 'border: 1px solid #555; display: block; image-rendering: pixelated;';
        card.appendChild(olCanvas);

        grid.appendChild(card);
    }

    section.appendChild(grid);
    // Insert after header (before older entries)
    const header = panel.children[0];
    if (header.nextSibling) {
        panel.insertBefore(section, header.nextSibling);
    } else {
        panel.appendChild(section);
    }
}
