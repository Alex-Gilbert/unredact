# Text Editing & Green Overlay Design

**Date:** 2026-02-16
**Status:** Approved

## Problem

The redaction-centric UI rewrite removed the green overlay, editable text segments, and font/position controls. Without these, users can't verify font detection accuracy, correct OCR errors, or pixel-align the overlay before solving. The green overlay is the visual feedback loop that makes precise solving possible.

## Solution

Add three UI components to the existing redaction-centric workflow:

1. **Green overlay on canvas** — renders known text around the active redaction in green, with red boxes for gaps
2. **Floating font toolbar** (top of right panel) — font dropdown, size slider, d-pad for line offset, gap width slider
3. **Bottom text edit bar** — editable left/right segment inputs for correcting OCR

Plus a backend enhancement: the analyze endpoint computes an initial offset guess so the green text starts approximately aligned with the document.

## Green Overlay

When a redaction is active and analyzed, the canvas renders the segments surrounding it:

- Green text for each known segment adjacent to the active redaction
- Red rectangle for the redaction gap (width adjustable via toolbar)
- Yellow/green text for preview/solved text in the gap
- Rendered using the selected font/size at `(line.x + offsetX, line.y + offsetY)`

**Single-redaction focus:** Only segments immediately surrounding the active redaction are rendered. If a line has multiple redactions, we show up to the next redaction on each side, not the full line.

**Initial position:** Backend computes `offset_x` so the left segment text ends at the gap edge. Frontend uses this as the starting position; user fine-tunes with d-pad.

## Floating Font Toolbar

Appears at top of right panel when a redaction is active and analyzed. Contains:

- **Font dropdown** — pre-selected from analysis, changeable
- **Size slider** with +/- buttons — set from analysis, adjustable by 1px
- **D-pad** — nudges the entire green overlay as a unit. Left/right = X, Up/down = Y. Shows current offsets.
- **Gap width slider** — separate from d-pad. Shows px width, +/- to adjust by 1px. This value goes to the solver.
- **Reset button** — resets to backend's initial guess

All changes re-render the green overlay in real time.

## Bottom Text Edit Bar

Appears at bottom of right panel when a redaction is active and analyzed. Contains:

- **Left segment input** — editable, pre-filled from OCR. Editing re-renders green overlay.
- **Redaction marker** — visual `[???]` or `[preview]` between inputs
- **Right segment input** — editable, pre-filled from OCR
- **Reset button** — resets to original OCR values

Solver uses the last char of left input as `left_context` and first char of right input as `right_context` for kerning calculations.

## Backend: Offset Guess

The `/api/redaction/analyze` response gains two fields:

- `offset_x`: float — horizontal offset so left segment text ends at gap edge
- `offset_y`: float — vertical offset (0 initially, user fine-tunes)

Computation:
```
left_rendered_width = font.getlength(left_text)
offset_x = gap_x - left_rendered_width - line_x
offset_y = 0
```

## State Model Changes

Each redaction gains override fields when active:

```javascript
state.redactions[id] = {
  // ... existing fields ...
  // Added when analyzed:
  overrides: {
    fontId: "...",       // from analysis, user can change
    fontSize: 42,        // from analysis, user can change
    offsetX: 12.5,       // from backend guess, user adjusts with d-pad
    offsetY: 0,          // user adjusts with d-pad
    gapWidth: 150,       // from analysis gap.w, user adjusts
    leftText: "...",     // from analysis, user can edit
    rightText: "...",    // from analysis, user can edit
  }
}
```
