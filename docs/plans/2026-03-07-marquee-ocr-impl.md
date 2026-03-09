# Marquee-Scoped OCR Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace background page-level OCR with on-demand OCR scoped to the marquee selection, so text extraction happens only where the user is working.

**Architecture:** Add `cropImageData` and `maskBoxRGBA` helpers to `ocr.js`. Rewrite the marquee double-click handler in `main.js` to OCR the marquee crop (with redaction box masked out) instead of reading from pre-computed page OCR. Remove `runBackgroundOcr` and its call. Keep non-marquee and batch flows with lazy page-level OCR.

**Tech Stack:** Vanilla JS (ES modules), Tesseract.js, OffscreenCanvas

---

### Task 1: Add `cropImageData` and `maskBoxRGBA` helpers to `ocr.js`

**Files:**
- Modify: `unredact/static/ocr.js`

**Step 1: Add the two helper functions at the end of `ocr.js` (before `terminateOcr`)**

```javascript
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
    w = Math.min(Math.round(w), src.width - x);
    h = Math.min(Math.round(h), src.height - y);
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
        for (let col = x0; col < x1; col++) {
            const i = (row * img.width + col) * 4;
            img.data[i] = 255;
            img.data[i + 1] = 255;
            img.data[i + 2] = 255;
            img.data[i + 3] = 255;
        }
    }
}
```

**Step 2: Verify by loading the app**

Open the app in the browser, check the console for no import errors.

**Step 3: Commit**

```bash
git add unredact/static/ocr.js
git commit -m "feat: add cropImageData and maskBoxRGBA helpers to ocr.js"
```

---

### Task 2: Rewrite marquee double-click handler to use marquee-scoped OCR

**Files:**
- Modify: `unredact/static/main.js:19` (imports)
- Modify: `unredact/static/main.js:500-604` (marquee double-click handler)

**Context:** The marquee double-click handler currently reads from `state.ocrData[page]` (pre-computed page OCR) and optionally calls `identifyBoundaryText` (LLM). We replace both with on-demand OCR of the marquee crop.

**Step 1: Add imports for the new helpers**

At `main.js:17`, change:
```javascript
import { initOcr, ocrPage } from './ocr.js';
```
to:
```javascript
import { initOcr, ocrPage, cropImageData, maskBoxRGBA } from './ocr.js';
```

**Step 2: Replace the marquee section of the double-click handler**

Replace lines 500-604 (the `if (marquee.active) { ... return; }` block) with:

```javascript
  // If a marquee is active, use it as the crop context for font detection
  if (marquee.active) {
    marquee.detectedBox = box;
    renderCanvas();

    const cropX = Math.round(marquee.x);
    const cropY = Math.round(marquee.y);
    const cropW = Math.min(Math.round(marquee.w), imageData.width - cropX);
    const cropH = Math.min(Math.round(marquee.h), imageData.height - cropY);

    // OCR the marquee crop with the redaction box masked out
    showToast("Running OCR on selection...", "info");
    const ocrCrop = cropImageData(imageData, cropX, cropY, cropW, cropH);
    const relBox = {
      x: box.x - cropX,
      y: box.y - cropY,
      w: box.w,
      h: box.h,
    };
    maskBoxRGBA(ocrCrop, relBox.x, relBox.y, relBox.w, relBox.h);
    const ocrLines = await ocrPage(ocrCrop);

    // Split OCR chars into left/right of the redaction box (crop-relative coords)
    let leftText = '';
    let rightText = '';
    let bestLine = null;
    let bestOverlap = 0;
    for (const line of ocrLines) {
      const overlap = Math.max(0,
        Math.min(relBox.y + relBox.h, line.y + line.h) - Math.max(relBox.y, line.y)
      );
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestLine = line;
      }
    }

    if (bestLine?.chars) {
      const leftChars = bestLine.chars.filter(c => c.x + c.w / 2 < relBox.x);
      const rightChars = bestLine.chars.filter(c => c.x + c.w / 2 > relBox.x + relBox.w);
      leftText = leftChars.map(c => c.text).join('').trim();
      rightText = rightChars.map(c => c.text).join('').trim();
    }

    // Use first OCR char's y as baseline hint
    const firstChar = bestLine?.chars?.[0];
    const hint = firstChar
      ? { x: firstChar.x, y: firstChar.y }
      : undefined;

    const cropGray = cropToGrayscale(imageData, cropX, cropY, cropW, cropH);
    const candidates = state.fonts.filter(f => f.available).map(f => f.name);
    showToast("Detecting font...", "info");
    const match = detectFontMarquee(cropGray, cropW, cropH, relBox, leftText, rightText, candidates, hint);

    const fontId = (state.fonts.find(f => f.name === match.fontName) || {}).id
      || match.fontName.toLowerCase().replace(/\s+/g, '-');

    const id = `p${page}-r${box.x}-${box.y}-${box.w}-${box.h}`;
    // Convert crop-relative offsets to line-relative offsets.
    // detectFontMarquee returns positions within the marquee crop, but
    // drawRedactionAnalyzed renders at (line.x + offsetX, line.y + offsetY).
    const lineX = bestLine ? bestLine.x + cropX : box.x;
    const lineY = bestLine ? bestLine.y + cropY : box.y;
    const offsetX = cropX + match.xOffset - lineX;
    const offsetY = cropY + match.yOffset - lineY;

    const analysis = {
      font: { id: fontId, name: match.fontName, size: match.fontSize },
      gap: { x: box.x, y: box.y, w: box.w, h: box.h },
      line: bestLine
        ? { text: bestLine.text, x: bestLine.x + cropX, y: bestLine.y + cropY, w: bestLine.w, h: bestLine.h }
        : { text: '', x: box.x, y: box.y, w: box.w, h: box.h },
      segments: [
        { text: leftText, side: 'left' },
        { text: rightText, side: 'right' },
      ],
      offset_x: offsetX,
      offset_y: offsetY,
    };

    state.redactions[id] = {
      id,
      x: box.x, y: box.y, w: box.w, h: box.h,
      page,
      status: "analyzed",
      analysis,
      solution: null,
      preview: null,
      overrides: {
        fontId,
        fontSize: match.fontSize,
        offsetX,
        offsetY,
        gapWidth: box.w,
        leftText,
        rightText,
      },
    };

    clearMarquee();
    renderRedactionList();
    renderCanvas();
    activateRedaction(id);
    showToast(`Font: ${match.fontName} ${match.fontSize.toFixed(1)}px (score: ${match.score.toFixed(3)})`, "success");
    return;
  }
```

**Key differences from old code:**
- OCR line coordinates are now crop-relative (from Tesseract on the crop), so comparisons use `relBox` not `box`
- `hint` coordinates are already crop-relative (no `- cropX` subtraction needed)
- `bestLine.x/y` are crop-relative, so we add `cropX`/`cropY` when storing in `analysis.line` (which needs document-absolute coords)
- `lineX`/`lineY` for offset conversion: `bestLine.x + cropX` (crop-relative → document-absolute)
- No `identifyBoundaryText` LLM call
- No `state.ocrData[page]` read — OCR is fresh from the marquee crop

**Step 3: Verify**

Load a PDF, draw a marquee around text with a redaction, double-click the redaction. Check:
- Toast says "Running OCR on selection..." then "Detecting font..."
- Left/right text is populated correctly in the popover
- Font overlay positions correctly on the canvas

**Step 4: Commit**

```bash
git add unredact/static/main.js
git commit -m "feat: marquee double-click uses on-demand OCR of the selection crop"
```

---

### Task 3: Add lazy page-level OCR to non-marquee double-click

**Files:**
- Modify: `unredact/static/main.js:606-645` (non-marquee fallback in dblclick handler)

**Step 1: Add on-demand OCR when `state.ocrData[page]` is missing**

Replace the non-marquee fallback section (after the `if (marquee.active) { ... }` block):

```javascript
  // No marquee — fall back to old analyzeRedaction flow
  // Run page-level OCR on demand if not already cached
  if (!state.ocrData?.[page]) {
    showToast("Running OCR on page...", "info");
    state.ocrData[page] = await ocrPage(state.pageImages[page].blob);
  }
  const ocrLines = state.ocrData[page];
  const apiKey = await getSetting('anthropic_api_key');
  const analysis = await analyzeRedaction(imageData, ocrLines, box, apiKey);
```

The rest of the handler (creating the redaction entry, rendering) stays the same.

**Step 2: Verify**

Load a PDF, double-click a redaction box WITHOUT drawing a marquee first. Check:
- Toast says "Running OCR on page..."
- Analysis proceeds normally
- Second double-click on same page is instant (cached)

**Step 3: Commit**

```bash
git add unredact/static/main.js
git commit -m "feat: lazy page-level OCR on non-marquee double-click"
```

---

### Task 4: Remove `runBackgroundOcr` and clean up upload flow

**Files:**
- Modify: `unredact/static/main.js:247-281` (uploadFile)
- Modify: `unredact/static/main.js:438-467` (runBackgroundOcr — delete entire function)
- Modify: `unredact/static/state.js:13` (ocrReady)

**Step 1: Delete `runBackgroundOcr()` function entirely** (lines 438-467)

**Step 2: Remove the call in `uploadFile()`**

Delete these two lines from `uploadFile()`:
```javascript
  // Start background OCR on all pages
  runBackgroundOcr();
```

**Step 3: Enable the detect button immediately**

In `uploadFile()`, after `viewerSection.hidden = false;`, add:
```javascript
  if (detectBtn) detectBtn.disabled = false;
```

The detect button no longer waits for OCR — `runAnalysis` does its own OCR per page.

**Step 4: Remove `ocrReady` from state**

In `unredact/static/state.js`, remove:
```javascript
  ocrReady: false,
```

Search for remaining `ocrReady` references in `main.js` and remove them:
- Line ~463: `state.ocrReady = true;` — already gone with the deleted function
- Line ~620: `showToast(state.ocrReady ? ...` — replace with just:
  ```javascript
  showToast("No text found near this redaction", "info");
  ```
- Line ~1108-1109: Session resume `ocrReady` logic — remove:
  ```javascript
  state.ocrReady = Object.keys(state.ocrData).length >= state.pageCount;
  if (state.ocrReady && detectBtn) detectBtn.disabled = false;
  ```
  Replace with:
  ```javascript
  if (detectBtn) detectBtn.disabled = false;
  ```

**Step 5: Remove unused `identifyBoundaryText` import if only used in marquee path**

Check: `identifyBoundaryText` is still used in `analyzeRedaction` (line ~401), so keep the import.

**Step 6: Verify**

- Upload a PDF — no "Running OCR..." toast on load
- "Detect Redactions" button is enabled immediately
- Batch detection still works (does its own OCR)
- Double-click without marquee still works (lazy OCR)

**Step 7: Commit**

```bash
git add unredact/static/main.js unredact/static/state.js
git commit -m "feat: remove background OCR, enable detect button immediately"
```

---

### Summary of changes

| File | Change |
|------|--------|
| `unredact/static/ocr.js` | Add `cropImageData`, `maskBoxRGBA` exports |
| `unredact/static/main.js` | Rewrite marquee dblclick to OCR the crop; add lazy page OCR fallback; remove `runBackgroundOcr`; clean up `ocrReady` refs |
| `unredact/static/state.js` | Remove `ocrReady` field |
