# Marquee-Scoped OCR Design

**Goal:** Replace background page-level OCR with on-demand OCR scoped to the marquee selection, so text extraction happens only where the user is working.

## Current Flow (being replaced)

1. On upload, `runBackgroundOcr()` runs Tesseract on every page sequentially
2. Results stored in `state.ocrData[page]`
3. Marquee double-click reads from `state.ocrData[page]` to find lines, split left/right text, get baseline hint
4. LLM `identifyBoundaryText` optionally refines the text splitting

## New Flow

### Marquee path (primary)

1. User draws marquee (Shift+drag), double-clicks on redaction box
2. `spotRedaction` flood-fills to get box dimensions (unchanged)
3. Crop the marquee region from the page `ImageData` into a new `ImageData` via `cropImageData()`
4. White out the redaction box pixels in the crop via `maskBoxRGBA()` (set to 255,255,255,255)
5. Run `ocrPage()` on the masked crop — Tesseract sees only surrounding text
6. Split OCR words into left/right by x-position relative to the redaction box
7. First OCR char's y-position provides the baseline hint
8. Run `detectFontMarquee` with left/right text, hint, and grayscale crop (unchanged)

No LLM call in the marquee path.

### Non-marquee fallback

Double-click without marquee checks `state.ocrData[page]`. If missing, runs `ocrPage()` on the full page blob on demand (cached after first run). Then proceeds with existing `analyzeRedaction` flow.

### Batch "Detect Redactions"

`runAnalysis` unchanged — it already does its own per-page OCR internally.

### Upload

- `initOcr()` still called eagerly (worker ready in background)
- `runBackgroundOcr()` removed — no pages are OCR'd on upload

## New Helpers (in ocr.js)

- **`cropImageData(imageData, x, y, w, h)`** — extracts a rectangular RGBA region, returns new `ImageData`
- **`maskBoxRGBA(imageData, rx, ry, rw, rh)`** — sets a rect to white (255,255,255,255) in an `ImageData`

## What Gets Removed

- `runBackgroundOcr()` function and its call in `uploadFile()`
- OCR status UI updates (`ocr-status` element)
- `identifyBoundaryText` call in the marquee path
- `state.ocrReady` gating on the detect button (batch flow does its own OCR)

## What Stays

- `initOcr()` eager call on upload
- `ocrPage()` function and import
- `state.ocrData` (populated lazily)
- `analyzeRedaction` and `detectFontMasked` (non-marquee/batch flows)
- Session resume restoring saved `ocrLines` from IndexedDB
