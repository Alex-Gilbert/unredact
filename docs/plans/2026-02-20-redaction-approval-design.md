# Redaction Approval Design

**Goal:** When a user accepts a solver result, merge left text + solution + right text into a single "approved" text object that renders persistently on the page in blue.

**Architecture:** Client-side state change with a new `"approved"` status, a new canvas draw function, and re-edit support via popover reopening.

## State Model

**On Accept (click Accept button):**
- `r.status` = `"approved"`
- `r.approvedText` = merged string: `leftText + solutionText + rightText`
- `r.solution` = `{ text, fontName, fontSize }` (solution portion only, preserved for re-editing)
- `r.preview` = `null`

**On re-click of approved redaction:**
- Popover opens in normal analyze workflow
- `r.preview` set to `r.solution.text` so canvas shows solution in gap
- Previous solution text appears as first pre-selected result in solver results
- User can change offset, font, text, and re-run solvers
- Re-accepting overwrites `r.approvedText` with new merged text

**State transitions:** `unanalyzed -> analyzed -> approved`
- `preview` is a transient visual overlay on top of `analyzed`
- The old `"solved"` status is removed entirely

## Canvas Rendering

New `drawRedactionApproved(r, isActive)`:
- Always renders the full merged line in blue (`rgba(30, 100, 255, 0.9)`)
- Uses font/size/offset from `r.overrides`
- Position: `line.x + offsetX, line.y + offsetY`
- Active: blue text + line bounding box outline
- Inactive: blue text only, no outline
- Replaces the old `drawRedactionSolution`

Render priority in `renderCanvas()`:
1. `r.status === "approved"` -> `drawRedactionApproved`
2. `r.preview` -> `drawRedactionPreview`
3. `r.status === "analyzed"` -> `drawRedactionAnalyzed`
4. fallback -> `drawRedactionUnanalyzed`

## Left Panel

- Status badge: "approved" with blue styling
- Info text: full `r.approvedText` (truncated if > 30 chars)

## Export

`exportAnnotations()` includes `r.approvedText` in the JSON output alongside existing `r.solution` and `r.overrides`.

## Removals

- Delete `"solved"` from `statusLabel()` switch
- Delete `drawRedactionSolution()` from canvas.js
- Remove `"solved"` references from `activateRedaction`, `redactionInfoText`, etc.
