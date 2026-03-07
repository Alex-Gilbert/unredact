// @ts-check
/** Canvas rendering — draws redaction overlays on the document image. */

import { state, getPageRedactions } from './state.js';
import { canvas, ctx, docImage, rightPanel } from './dom.js';
// NOTE: circular import — canvas.js ↔ marquee.js. Safe because both modules
// only access each other's exports inside function bodies, never at top level.
import { marquee, updateAnalyzeButtonPos } from './marquee.js';

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

    if (r.status === "approved" && r.approvedText) {
      drawRedactionApproved(r, isActive);
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

  // Draw marquee selection
  if (marquee.active) {
    const m = marquee;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(66, 133, 244, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(m.x, m.y, m.w, m.h);
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(66, 133, 244, 0.08)';
    ctx.fillRect(m.x, m.y, m.w, m.h);

    // Resize handles
    const sz = 6;
    ctx.fillStyle = 'rgba(66, 133, 244, 0.9)';
    ctx.fillRect(m.x - sz/2, m.y + m.h/2 - sz/2, sz, sz);
    ctx.fillRect(m.x + m.w - sz/2, m.y + m.h/2 - sz/2, sz, sz);
    ctx.fillRect(m.x + m.w/2 - sz/2, m.y - sz/2, sz, sz);
    ctx.fillRect(m.x + m.w/2 - sz/2, m.y + m.h - sz/2, sz, sz);

    // Detected redaction box
    if (m.detectedBox) {
      ctx.strokeStyle = 'rgba(211, 47, 47, 0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(m.detectedBox.x, m.detectedBox.y, m.detectedBox.w, m.detectedBox.h);
    }

    ctx.restore();

    // Position analyze button in screen coords
    const pw = rightPanel.clientWidth;
    const ph = rightPanel.clientHeight;
    const screenCX = (m.x + m.w / 2 - state.panX) * state.zoom + pw / 2;
    const screenBY = (m.y + m.h - state.panY) * state.zoom + ph / 2;
    updateAnalyzeButtonPos(screenCX, screenBY);
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

  const leftText = o.leftText ?? "";
  const rightText = o.rightText ?? "";
  const mergedText = leftText + r.preview + rightText;

  if (isActive) {
    const startX = a.line.x + (o.offsetX ?? 0);
    const startY = a.line.y + (o.offsetY ?? 0);

    ctx.textBaseline = "top";
    ctx.font = fontStr;

    // Draw as one continuous string for natural kerning
    // Left portion in green
    if (leftText) {
      drawStyledText(leftText, startX, startY, fontName, fontSize, "rgba(0, 200, 0, 0.7)");
    }

    // Measure where the preview text starts and ends
    const leftW = leftText ? measureStyledText(leftText, fontName, fontSize) : 0;
    const previewX = startX + leftW;
    const previewW = ctx.measureText(r.preview).width;

    // Highlight behind the preview portion
    const pad = fontSize * 0.15;
    ctx.fillStyle = "rgba(255, 200, 0, 0.2)";
    ctx.fillRect(previewX, startY - pad, previewW, fontSize + pad * 2);

    // Preview text in yellow
    ctx.fillStyle = "rgba(255, 200, 0, 0.9)";
    ctx.font = fontStr;
    ctx.fillText(r.preview, previewX, startY);

    // Right portion in green
    if (rightText) {
      const rightX = previewX + previewW;
      drawStyledText(rightText, rightX, startY, fontName, fontSize, "rgba(0, 200, 0, 0.7)");
    }

    ctx.strokeStyle = "rgba(0, 200, 0, 0.3)";
    ctx.lineWidth = 1;
    ctx.strokeRect(a.line.x, a.line.y, a.line.w, a.line.h);
  } else {
    // Inactive: draw full merged text in yellow at line position
    const startX = a.line.x + (o.offsetX ?? 0);
    const textY = a.line.y + (o.offsetY ?? 0);

    ctx.font = fontStr;
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(255, 200, 0, 0.9)";
    ctx.fillText(mergedText, startX, textY);
  }
}

/**
 * @param {import('./types.js').Redaction} r
 * @param {boolean} isActive
 */
function drawRedactionApproved(r, isActive) {
  if (!r.analysis || !r.approvedText) return;
  const a = r.analysis;
  const o = r.overrides || {};
  const fontName = state.fonts.find(f => f.id === (o.fontId ?? a.font.id))?.name ?? a.font.name;
  const fontSize = o.fontSize ?? a.font.size;

  // Draw the full merged text along the line
  const startX = a.line.x + (o.offsetX ?? 0);
  const startY = a.line.y + (o.offsetY ?? 0);

  ctx.textBaseline = "top";
  ctx.font = `${fontSize}px "${fontName}"`;
  ctx.fillStyle = "rgba(30, 100, 255, 0.9)";
  ctx.fillText(r.approvedText, startX, startY);

  if (isActive) {
    ctx.strokeStyle = "rgba(30, 100, 255, 0.2)";
    ctx.lineWidth = 1;
    ctx.strokeRect(a.line.x, a.line.y, a.line.w, a.line.h);
  }
}
