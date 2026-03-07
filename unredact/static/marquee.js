// @ts-check
/** Marquee selection tool — draw, resize, and manage a selection rectangle. */

import { state } from './state.js';
import { rightPanel, canvas } from './dom.js';
import { screenToDoc } from './viewport.js';
// NOTE: circular import — marquee.js ↔ canvas.js. Safe because both modules
// only access each other's exports inside function bodies, never at top level.
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
    getAnalyzeBtn().style.display = 'block';
}

function hideAnalyzeButton() {
    if (analyzeBtn) analyzeBtn.style.display = 'none';
}

/**
 * Update the analyze button position relative to the marquee.
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

export function initMarquee() {
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

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && marquee.active) {
            clearMarquee();
        }
    });
}

/**
 * @param {number} docX
 * @param {number} docY
 * @returns {string|null}
 */
function hitTestMarqueeEdge(docX, docY) {
    const t = 8 / state.zoom;
    const m = marquee;
    if (Math.abs(docX - m.x) < t && docY > m.y - t && docY < m.y + m.h + t) return 'left';
    if (Math.abs(docX - (m.x + m.w)) < t && docY > m.y - t && docY < m.y + m.h + t) return 'right';
    if (Math.abs(docY - m.y) < t && docX > m.x - t && docX < m.x + m.w + t) return 'top';
    if (Math.abs(docY - (m.y + m.h)) < t && docX > m.x - t && docX < m.x + m.w + t) return 'bottom';
    return null;
}
