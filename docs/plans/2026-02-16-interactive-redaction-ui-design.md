# Interactive Redaction UI Design

**Date:** 2026-02-16
**Status:** Approved

## Problem

The current UI does upfront OCR + font detection on every line of every page at upload time. This is slow, often inaccurate, and doesn't fit the app's workflow — users care about redactions, not every line of text. Redaction gaps must be manually marked with Ctrl+Space, which is tedious and error-prone.

## Solution

Shift to a redaction-centric workflow:

1. **Upload:** Rasterize PDF + detect redaction boxes via OpenCV (no OCR)
2. **Browse:** Clickable redaction indicators on the canvas
3. **Analyze:** On-demand OCR + font detection when a user clicks a specific redaction
4. **Solve:** Popover with solver controls anchored to the redaction

## Architecture

### Upload Flow (Simplified)

```
PDF → rasterize pages → OpenCV detect black rectangles → return redaction bboxes
```

No OCR. No font detection. Fast.

### OpenCV Redaction Detection

- Grayscale → binary threshold (near-black pixels)
- Find contours → filter for rectangles (aspect ratio > 2:1, minimum area to reject noise)
- Merge overlapping/adjacent boxes
- Return bounding boxes in page-pixel coordinates

### Manual Marking

Users can click-drag on the canvas to draw custom redaction boxes for cases OpenCV misses. These have the same data shape as auto-detected ones.

## Frontend: Canvas-Native Approach

### Redaction Indicators

- Each detected redaction rendered as a semi-transparent colored overlay on the `<canvas>`
- Hover: cursor → pointer, box gets brighter highlight
- Hit-testing via inverse-transformed coordinates (accounts for zoom/pan)

### Click → Analyze → Popover

1. User clicks a redaction overlay
2. Frontend sends `POST /api/redaction/analyze` with `{doc_id, page, redaction: {x, y, w, h}}`
3. Backend crops the line, runs OCR + font detection on just that line, returns segments + gap
4. Popover opens anchored near the clicked redaction

### Popover Contents

- Detected line text with redaction gap visually indicated
- Font name + size (editable)
- Gap width in px (editable, +/- buttons)
- Solve button → solver controls (charset, tolerance, mode, filters)
- Results stream via SSE
- Click result → preview renders on canvas in the gap
- Accept button → saves solution

## Frontend: Left Panel Redesign

**Old:** Scrollable list of OCR'd lines with font info.

**New:** Scrollable list of detected redactions.

### Redaction Card Contents

- Thumbnail crop of the redaction area
- Status indicator: `unanalyzed` → `analyzed` → `solved`
- Sequential number (e.g. "Redaction #3") + page number
- Once analyzed: surrounding text snippet (e.g. "...from ████ to the...")
- Once solved: accepted solution text

### Interactions

- Click card → canvas scrolls/pans to center on redaction, opens popover
- Accepted solutions render persistently on canvas (green text in the gap)

### State Model

```javascript
state = {
  docId,
  pageCount,
  currentPage,
  redactions: {
    "r1": {x, y, w, h, page, status: "unanalyzed"},
    "r2": {x, y, w, h, page, status: "analyzed", analysis: {segments, gap, font, chars}, solution: null},
    "r3": {x, y, w, h, page, status: "solved", analysis: {...}, solution: {text: "Smith", font, size, width_px}},
  },
  fonts: [...],
  zoom, panX, panY,
  associates,
}
```

## Backend: API Changes

### Modified Endpoints

| Endpoint | Change |
|----------|--------|
| `POST /api/upload` | Simplified: rasterize + OpenCV detect only |
| `GET /api/doc/{id}/page/{p}/data` | Returns redaction bboxes instead of OCR lines |

### New Endpoint

**`POST /api/redaction/analyze`**

- Input: `{doc_id, page, redaction: {x, y, w, h}}`
- Process: crop line from page image → OCR the crop → detect font → build segments
- Output: `{segments: [{text, x, w}, ...], gap: {x, w}, font: {name, id, size_px}, chars: [...]}`

### Removed Endpoints

| Endpoint | Reason |
|----------|--------|
| `GET /api/doc/{id}/page/{p}/overlay` | No more upfront green overlay |

### Unchanged Endpoints

- `POST /api/solve` — solver still takes font/width/charset, streams results
- `GET /api/fonts`, `GET /api/font/{id}` — font serving
- Dictionary/associates/email endpoints
- `GET /api/doc/{id}/page/{p}/original` — page image serving

### Data Storage

```python
_docs[doc_id] = {
    "page_count": int,
    "pages": {
        page_num: {
            "image": PIL.Image,
            "redactions": [{"x": int, "y": int, "w": int, "h": int, "id": str}]
        }
    }
}
```

## Removals

### Frontend

- Line list rendering + line selection logic
- Segment editing text inputs (Ctrl+Space splitting)
- Font controls / text edit bar / d-pad in the right panel
- Green overlay image display
- `state.pageData`, `state.selectedLine`, `state.lineOverrides`, `state.activeSegment`

### Backend

- Upfront `ocr_page()` + `detect_fonts()` calls in upload handler
- `render_overlay()` and overlay endpoint
- Line/font data from `/api/doc/{id}/page/{p}/data`

### Kept Intact

- All solver logic (Python + Rust)
- Width table construction
- Font serving endpoints
- Dictionary/associates/email endpoints
- PDF rasterization
- Core OCR and font detection modules (called on-demand now)
