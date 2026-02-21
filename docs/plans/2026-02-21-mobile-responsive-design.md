# Mobile-Responsive Redesign

## Goal

Rethink the UI to be mobile-friendly from the start, using a bottom sheet pattern that adapts to both mobile and desktop via CSS media queries. Full solving workflow on mobile.

## Why Not Bolt-On

The previous mobile attempt used `display: none` to toggle panels via tab buttons. This broke the canvas coordinate system (`getBoundingClientRect()` returns zeros on hidden elements), caused `hidden` attribute overrides from CSS specificity, and resulted in a non-functional mobile experience. The fundamental problem: hiding the document viewer breaks everything that depends on it being in layout.

## Architecture

**Core principle:** The document viewer (`#right-panel` with canvas) is never hidden. Everything else overlays it or sits beside it.

**Single HTML structure** serves both layouts. CSS media queries reposition content:
- Desktop (>768px): sheet content splits into sidebar (left) + overlays (popover, toolbar, edit bar)
- Mobile (<=768px): sheet content unifies into a draggable bottom sheet

### Mobile Layout (<=768px)

```
┌─────────────────────┐
│ UNREDACT            │  ← compact header
├─────────────────────┤
│ < 1/5 >  - 100% +  │  ← controls bar (always visible)
├─────────────────────┤
│                     │
│  Document + Canvas  │  ← always rendered, shrinks as sheet grows
│  (zoom, pan, tap)   │
│                     │
├─ ═══ drag handle ═══┤  ← bottom sheet overlay
│ [Solve] [Edit] [List]│  ← segment tabs
│                     │
│  (active tab pane)  │  ← solver OR font/edit OR redaction list
│                     │
└─────────────────────┘
```

### Desktop Layout (>768px)

```
┌──────────────────────────────────────────────┐
│  UNREDACT  ·  Epstein Files Redaction...     │
├─────────────────┬────────────────────────────┤
│  [Detect]       │  < 1/5 >   - 100% +  Fit  │
│                 │ ┌────────────────────────┐  │
│  #1 analyzed    │ │                        │  │
│  #2 approved    │ │   Document + Canvas    │  │
│  #3 analyzing   │ │                        │  │
│                 │ │    ┌──────────┐        │  │
│                 │ │    │ Popover  │        │  │
│                 │ │    └──────────┘        │  │
│                 │ │  [font toolbar]        │  │
│                 │ │  [text edit bar]       │  │
│                 │ └────────────────────────┘  │
└─────────────────┴────────────────────────────┘
```

On desktop, CSS hides the drag handle and segment tabs. The sheet container becomes the left sidebar. Solve tab content repositions as the popover overlay. Edit tab content splits into font toolbar (top-left) and text edit bar (bottom). List tab content is the sidebar body.

## Bottom Sheet

### Snap Points

Three snap positions, percentage of viewport height:
- **Peek** (~60px fixed): Drag handle + segment tabs visible. Document gets maximum space. Default state before any redaction is selected.
- **Half** (~45vh): Controls visible, document still visible above for context. Default when a redaction is selected.
- **Full** (~90vh): Nearly full screen. For scrolling through long solver results.

### Drag Behavior

- Drag the handle bar (44px tall touch target) up/down to resize
- Snap threshold: dragging past 30% of the distance to the next snap point commits, otherwise springs back
- CSS `transition` for smooth snapping animation
- Touch events on sheet controls (buttons, inputs, sliders) work normally and don't trigger drag
- Scrolling results list inside the sheet is normal scroll, doesn't trigger sheet resize

### Segment Tabs

Three tabs at the top of the sheet:
- **Solve** — Mode, Charset, Tolerance, Word filter, Known start/end, Solve/Stop/Accept buttons, results list
- **Edit** — Font family select, size slider, position d-pad, gap control, left/right text inputs + redaction marker
- **List** — Detect button, OCR status, scrollable redaction list with status badges and delete buttons

### Auto-Switch Behavior

- Tapping a redaction (on canvas or in list) → Solve tab active, sheet snaps to half
- Closing/deselecting a redaction → sheet returns to peek
- Sheet starts at peek until first redaction is selected

## Touch & Interaction

### Document Viewport (Mobile)
- Single-finger drag → pan (unchanged from current)
- Two-finger pinch → zoom (unchanged)
- Tap redaction box → select, sheet to half, Solve tab
- Tap empty area → deselect, sheet to peek

### Gesture Conflict Prevention
- Sheet has higher z-index than document viewport
- Touch events on sheet don't propagate to viewport
- Drag gesture only activates on handle and empty sheet background, not on controls
- Sheet content area scrolls normally without triggering sheet resize

### Desktop
- All mouse interactions unchanged
- Sheet drag logic is mobile-only (hidden via CSS on desktop)

## Controls Bar

Compact strip between header and document on both desktop and mobile:
- Page navigation: < Prev | Page 1/5 | Next >
- Zoom controls: - | 100% | + | Fit
- On mobile: `flex-wrap: wrap` for narrow viewports

## Implementation Scope

### Files Unchanged (5)
- `viewport.js` — zoom, pan, touch, coordinate transforms
- `canvas.js` — all canvas rendering
- `solver.js` — SSE solver logic
- `state.js` — state management
- `associates.js` — associate matching
- Backend — no changes

### Files Restructured (5)
- `index.html` — DOM reorganization: left panel + popover + font toolbar + text edit bar move into `#bottom-sheet` container with 3 tab panes
- `style.css` — layout rewrite: mobile bottom sheet, desktop splits sheet back into sidebar + overlays, `[hidden]` fix
- `main.js` — sheet snap management, tab switching, auto-switch on redaction select
- `popover.js` — refactored to work as tab pane inside sheet instead of positioned overlay
- `dom.js` — updated element references for new DOM structure

### New JS (~100 lines)
- Sheet drag/snap behavior: touchstart/touchmove/touchend on handle, CSS transition for snapping, document viewport resize on snap change

## Tech Stack

Vanilla CSS media queries, vanilla JS DOM manipulation. No frameworks, no build step. Same FastAPI static file serving.
