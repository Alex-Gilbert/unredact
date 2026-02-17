// @ts-check
/** Canvas rendering — draws redaction overlays on the document image. */

import { state, getPageRedactions } from './state.js';
import { canvas, ctx, docImage } from './dom.js';

export function renderCanvas() {
  if (!docImage.naturalWidth || !state.fontsReady) return;

  const redactions = getPageRedactions();

  canvas.width = docImage.naturalWidth;
  canvas.height = docImage.naturalHeight;
  canvas.style.width = docImage.naturalWidth + "px";
  canvas.style.height = docImage.naturalHeight + "px";

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const r of redactions) {
    const isActive = r.id === state.activeRedaction;

    if (r.status === "solved" && r.solution) {
      drawRedactionSolution(r, isActive);
    } else if (r.preview) {
      drawRedactionPreview(r, isActive);
    } else if (r.status === "analyzed" && r.analysis) {
      drawRedactionAnalyzed(r, isActive);
    } else {
      drawRedactionUnanalyzed(r, isActive);
    }
  }
}

/**
 * @param {import('./types.js').Redaction} r
 * @param {boolean} isActive
 */
function drawRedactionUnanalyzed(r, isActive) {
  const alpha = isActive ? 0.4 : 0.25;
  const borderAlpha = isActive ? 0.9 : 0.5;

  ctx.fillStyle = `rgba(66, 133, 244, ${alpha})`;
  ctx.fillRect(r.x, r.y, r.w, r.h);

  ctx.strokeStyle = `rgba(66, 133, 244, ${borderAlpha})`;
  ctx.lineWidth = isActive ? 2.5 : 1.5;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
}

/**
 * @param {import('./types.js').Redaction} r
 * @param {boolean} isActive
 */
function drawRedactionAnalyzed(r, isActive) {
  if (!isActive) {
    drawRedactionUnanalyzed(r, false);
    return;
  }

  const a = r.analysis;
  const o = r.overrides || {};
  const fontName = state.fonts.find(f => f.id === (o.fontId ?? a.font.id))?.name ?? a.font.name;
  const fontSize = o.fontSize ?? a.font.size;
  const fontStr = `${fontSize}px "${fontName}"`;
  const gapW = o.gapWidth ?? a.gap.w;

  const startX = a.line.x + (o.offsetX ?? 0);
  const startY = a.line.y + (o.offsetY ?? 0);

  ctx.font = fontStr;
  ctx.textBaseline = "top";

  let cursorX = startX;

  const leftText = o.leftText ?? "";
  if (leftText) {
    ctx.fillStyle = "rgba(0, 200, 0, 0.7)";
    ctx.fillText(leftText, cursorX, startY);
    cursorX += ctx.measureText(leftText).width;
  }

  const pad = fontSize * 0.15;
  ctx.fillStyle = "rgba(211, 47, 47, 0.5)";
  ctx.fillRect(cursorX, startY - pad, gapW, fontSize + pad * 2);
  ctx.strokeStyle = "rgba(211, 47, 47, 0.8)";
  ctx.lineWidth = 2;
  ctx.strokeRect(cursorX, startY - pad, gapW, fontSize + pad * 2);

  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = `bold ${Math.min(fontSize * 0.5, 16)}px sans-serif`;
  const label = `${Math.round(gapW)}px`;
  const labelW = ctx.measureText(label).width;
  ctx.fillText(label, cursorX + (gapW - labelW) / 2, startY + fontSize * 0.3);
  ctx.font = fontStr;

  cursorX += gapW;

  const rightText = o.rightText ?? "";
  if (rightText) {
    ctx.fillStyle = "rgba(0, 200, 0, 0.7)";
    ctx.fillText(rightText, cursorX, startY);
  }

  ctx.strokeStyle = "rgba(0, 200, 0, 0.3)";
  ctx.lineWidth = 1;
  ctx.strokeRect(a.line.x, a.line.y, a.line.w, a.line.h);
}

/**
 * @param {import('./types.js').Redaction} r
 * @param {boolean} isActive
 */
function drawRedactionPreview(r, isActive) {
  if (!r.analysis) return;
  const a = r.analysis;
  const o = r.overrides || {};
  const fontName = state.fonts.find(f => f.id === (o.fontId ?? a.font.id))?.name ?? a.font.name;
  const fontSize = o.fontSize ?? a.font.size;
  const fontStr = `${fontSize}px "${fontName}"`;
  const gapW = o.gapWidth ?? a.gap.w;

  if (isActive) {
    const startX = a.line.x + (o.offsetX ?? 0);
    const startY = a.line.y + (o.offsetY ?? 0);

    ctx.font = fontStr;
    ctx.textBaseline = "top";

    let cursorX = startX;

    const leftText = o.leftText ?? "";
    if (leftText) {
      ctx.fillStyle = "rgba(0, 200, 0, 0.7)";
      ctx.fillText(leftText, cursorX, startY);
      cursorX += ctx.measureText(leftText).width;
    }

    const pad = fontSize * 0.15;
    ctx.fillStyle = "rgba(255, 200, 0, 0.2)";
    ctx.fillRect(cursorX, startY - pad, gapW, fontSize + pad * 2);
    ctx.strokeStyle = "rgba(255, 200, 0, 0.8)";
    ctx.lineWidth = 2;
    ctx.strokeRect(cursorX, startY - pad, gapW, fontSize + pad * 2);

    ctx.fillStyle = "rgba(255, 200, 0, 0.9)";
    ctx.font = fontStr;
    ctx.fillText(r.preview, cursorX, startY);

    cursorX += gapW;

    const rightText = o.rightText ?? "";
    if (rightText) {
      ctx.fillStyle = "rgba(0, 200, 0, 0.7)";
      ctx.fillText(rightText, cursorX, startY);
    }

    ctx.strokeStyle = "rgba(0, 200, 0, 0.3)";
    ctx.lineWidth = 1;
    ctx.strokeRect(a.line.x, a.line.y, a.line.w, a.line.h);
  } else {
    const pad = fontSize * 0.1;
    ctx.fillStyle = "rgba(255, 200, 0, 0.12)";
    ctx.fillRect(a.gap.x, r.y - pad, gapW, r.h + pad * 2);

    ctx.strokeStyle = "rgba(255, 200, 0, 0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(a.gap.x, r.y - pad, gapW, r.h + pad * 2);

    ctx.font = fontStr;
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(255, 200, 0, 0.9)";
    ctx.fillText(r.preview, a.gap.x, a.line.y);
  }
}

/**
 * @param {import('./types.js').Redaction} r
 * @param {boolean} isActive
 */
function drawRedactionSolution(r, isActive) {
  if (!r.analysis) return;
  const a = r.analysis;
  const o = r.overrides || {};
  const fontName = state.fonts.find(f => f.id === (o.fontId ?? a.font.id))?.name ?? a.font.name;
  const fontSize = o.fontSize ?? a.font.size;
  const fontStr = `${fontSize}px "${fontName}"`;
  const gapW = o.gapWidth ?? a.gap.w;

  if (isActive) {
    const startX = a.line.x + (o.offsetX ?? 0);
    const startY = a.line.y + (o.offsetY ?? 0);

    ctx.font = fontStr;
    ctx.textBaseline = "top";

    let cursorX = startX;

    const leftText = o.leftText ?? "";
    if (leftText) {
      ctx.fillStyle = "rgba(0, 200, 0, 0.7)";
      ctx.fillText(leftText, cursorX, startY);
      cursorX += ctx.measureText(leftText).width;
    }

    const pad = fontSize * 0.15;
    ctx.fillStyle = "rgba(0, 212, 116, 0.15)";
    ctx.fillRect(cursorX, startY - pad, gapW, fontSize + pad * 2);
    ctx.strokeStyle = "rgba(0, 212, 116, 0.8)";
    ctx.lineWidth = 2;
    ctx.strokeRect(cursorX, startY - pad, gapW, fontSize + pad * 2);

    ctx.fillStyle = "rgba(0, 212, 116, 0.95)";
    ctx.font = fontStr;
    ctx.fillText(r.solution.text, cursorX, startY);

    cursorX += gapW;

    const rightText = o.rightText ?? "";
    if (rightText) {
      ctx.fillStyle = "rgba(0, 200, 0, 0.7)";
      ctx.fillText(rightText, cursorX, startY);
    }

    ctx.strokeStyle = "rgba(0, 200, 0, 0.3)";
    ctx.lineWidth = 1;
    ctx.strokeRect(a.line.x, a.line.y, a.line.w, a.line.h);
  } else {
    const pad = fontSize * 0.1;
    ctx.fillStyle = "rgba(0, 212, 116, 0.08)";
    ctx.fillRect(a.gap.x, r.y - pad, gapW, r.h + pad * 2);

    ctx.strokeStyle = "rgba(0, 212, 116, 0.4)";
    ctx.lineWidth = 1;
    ctx.strokeRect(a.gap.x, r.y - pad, gapW, r.h + pad * 2);

    ctx.font = fontStr;
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(0, 212, 116, 0.95)";
    ctx.fillText(r.solution.text, a.gap.x, a.line.y);
  }
}
