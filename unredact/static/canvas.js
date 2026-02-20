// @ts-check
/** Canvas rendering — draws redaction overlays on the document image. */

import { state, getPageRedactions } from './state.js';
import { canvas, ctx, docImage } from './dom.js';

/**
 * Parse text with **bold** markers into styled segments.
 * @param {string} text
 * @returns {{text: string, bold: boolean}[]}
 */
function parseStyledText(text) {
  const segments = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ text: text.slice(last, m.index), bold: false });
    }
    segments.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segments.push({ text: text.slice(last), bold: false });
  }
  return segments.length ? segments : [{ text, bold: false }];
}

/**
 * Draw styled text on canvas, switching font weight for bold segments.
 * @param {string} text - Text with optional **bold** markers.
 * @param {number} x
 * @param {number} y
 * @param {string} fontName
 * @param {number} fontSize
 * @param {string} fillStyle
 * @returns {number} Total width drawn.
 */
function drawStyledText(text, x, y, fontName, fontSize, fillStyle) {
  const segments = parseStyledText(text);
  let cx = x;
  ctx.fillStyle = fillStyle;
  for (const seg of segments) {
    ctx.font = seg.bold
      ? `bold ${fontSize}px "${fontName}"`
      : `${fontSize}px "${fontName}"`;
    ctx.fillText(seg.text, cx, y);
    cx += ctx.measureText(seg.text).width;
  }
  return cx - x;
}

/**
 * Measure styled text width, accounting for bold segments.
 * @param {string} text
 * @param {string} fontName
 * @param {number} fontSize
 * @returns {number}
 */
function measureStyledText(text, fontName, fontSize) {
  const segments = parseStyledText(text);
  let w = 0;
  for (const seg of segments) {
    ctx.font = seg.bold
      ? `bold ${fontSize}px "${fontName}"`
      : `${fontSize}px "${fontName}"`;
    w += ctx.measureText(seg.text).width;
  }
  return w;
}

/**
 * Draw small square handles at the four edges of a redaction for resizing.
 * @param {import('./types.js').Redaction} r
 */
function drawResizeHandles(r) {
  const sz = 6;
  ctx.fillStyle = "rgba(0, 120, 255, 0.8)";
  // Left edge
  ctx.fillRect(r.x - sz/2, r.y + r.h/2 - sz/2, sz, sz);
  // Right edge
  ctx.fillRect(r.x + r.w - sz/2, r.y + r.h/2 - sz/2, sz, sz);
  // Top edge
  ctx.fillRect(r.x + r.w/2 - sz/2, r.y - sz/2, sz, sz);
  // Bottom edge
  ctx.fillRect(r.x + r.w/2 - sz/2, r.y + r.h - sz/2, sz, sz);
}

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

    if (r.id === state.activeRedaction) {
      drawResizeHandles(r);
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

  ctx.textBaseline = "top";

  let cursorX = startX;

  const leftText = o.leftText ?? "";
  if (leftText) {
    cursorX += drawStyledText(leftText, cursorX, startY, fontName, fontSize, "rgba(0, 200, 0, 0.7)");
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

  cursorX += gapW;

  const rightText = o.rightText ?? "";
  if (rightText) {
    drawStyledText(rightText, cursorX, startY, fontName, fontSize, "rgba(0, 200, 0, 0.7)");
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

    ctx.textBaseline = "top";

    let cursorX = startX;

    const leftText = o.leftText ?? "";
    if (leftText) {
      cursorX += drawStyledText(leftText, cursorX, startY, fontName, fontSize, "rgba(0, 200, 0, 0.7)");
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
      drawStyledText(rightText, cursorX, startY, fontName, fontSize, "rgba(0, 200, 0, 0.7)");
    }

    ctx.strokeStyle = "rgba(0, 200, 0, 0.3)";
    ctx.lineWidth = 1;
    ctx.strokeRect(a.line.x, a.line.y, a.line.w, a.line.h);
  } else {
    const gapX = a.gap.x + (o.offsetX ?? 0);
    const textY = a.line.y + (o.offsetY ?? 0);
    const pad = fontSize * 0.1;
    ctx.fillStyle = "rgba(255, 200, 0, 0.12)";
    ctx.fillRect(gapX, textY - pad, gapW, fontSize + pad * 2);

    ctx.strokeStyle = "rgba(255, 200, 0, 0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(gapX, textY - pad, gapW, fontSize + pad * 2);

    ctx.font = fontStr;
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(255, 200, 0, 0.9)";
    ctx.fillText(r.preview, gapX, textY);
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

    ctx.textBaseline = "top";

    let cursorX = startX;

    const leftText = o.leftText ?? "";
    if (leftText) {
      cursorX += drawStyledText(leftText, cursorX, startY, fontName, fontSize, "rgba(0, 200, 0, 0.7)");
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
      drawStyledText(rightText, cursorX, startY, fontName, fontSize, "rgba(0, 200, 0, 0.7)");
    }

    ctx.strokeStyle = "rgba(0, 200, 0, 0.3)";
    ctx.lineWidth = 1;
    ctx.strokeRect(a.line.x, a.line.y, a.line.w, a.line.h);
  } else {
    const gapX = a.gap.x + (o.offsetX ?? 0);
    const textY = a.line.y + (o.offsetY ?? 0);
    const pad = fontSize * 0.1;
    ctx.fillStyle = "rgba(0, 212, 116, 0.08)";
    ctx.fillRect(gapX, textY - pad, gapW, fontSize + pad * 2);

    ctx.strokeStyle = "rgba(0, 212, 116, 0.4)";
    ctx.lineWidth = 1;
    ctx.strokeRect(gapX, textY - pad, gapW, fontSize + pad * 2);

    ctx.font = fontStr;
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(0, 212, 116, 0.95)";
    ctx.fillText(r.solution.text, gapX, textY);
  }
}
