# Marquee-Based Font Detection

## Problem

The current font detection flow has several issues:

1. **Broken baselines in comparison renders** — `renderRunsGray` positions each word run at its OCR bounding-box y-coordinate. OCR tight bounding boxes vary by glyph height ("l" starts higher than "o"), so runs render at different vertical positions instead of sharing a baseline.

2. **Integer font sizes** — The search steps through integer pixel sizes. PDF text often uses non-integer point sizes, so we can never find an exact match.

3. **OCR character positions used for rendering** — Per-character x/y positions from OCR are unreliable. Text should be rendered as continuous strings with natural browser kerning, the same way a word processor would render them.

4. **Multi-box lines are messy** — When a line has multiple redaction boxes, the mask-and-score approach becomes complex and error-prone.

5. **No user control** — Double-click auto-detects and analyzes in one shot. No opportunity to verify the selection or adjust context before committing to analysis.

## Solution

Replace the double-click auto-analyze flow with a marquee selection tool that gives users control over the analysis region, and replace the grid-search font detection with an optimizer that searches continuous (x, y, fontSize) space.

## User Interaction Flow

1. **User draws a marquee** — click-and-drag rectangle around the redaction box and its surrounding text context
2. **Marquee stays visible** — resize handles on edges/corners let the user adjust to include more or less text context
3. **Auto-detect redaction box** — WASM detection runs within the marquee region, highlights the detected box
4. **"Analyze" button appears** — anchored near the marquee, user clicks when satisfied with the selection
5. **Font detection runs** — optimized search finds best font, size, and offset
6. **Results populate the popover** — same downstream flow as today (font, size, left/right text, solver)

## Font Detection Algorithm

### Inputs

- **Page crop**: grayscale pixels from the marquee region
- **Redaction box**: position within the crop (from auto-detection)
- **Left text, right text**: from OCR characters within the marquee, split at the redaction box
- **Candidate fonts**: registered font families

### Rendering

Text is rendered as two `fillText` calls — one for left text, one for right text — with natural browser kerning. No per-character positioning from OCR.

```
canvas.fillText(leftText, x_offset, y_offset)
canvas.fillText(rightText, x_offset + leftWidth + gapWidth, y_offset)
```

Where `leftWidth = ctx.measureText(leftText).width` and `gapWidth` is the redaction box width.

The redaction region is masked to white in both the page crop and the rendered output, so scoring only compares visible text.

### Optimizer

For each candidate font family:

1. **Coarse scan**: fontSize 8→120 at 5px steps, (x, y) = (0, 0). Find the region with the best score. ~23 evaluations.
2. **Golden-section on fontSize**: ±5px around coarse best, converge to 0.1px precision. ~15 evaluations.
3. **Golden-section on y-offset**: ±5px at the optimal size, converge to 0.1px. ~10 evaluations.
4. **Golden-section on x-offset**: ±5px at optimal size+y, converge to 0.1px. ~10 evaluations.
5. Record (font, size, x, y, score).

Total: ~58 evaluations per font, ~290 for 5 fonts. Comparable speed to current approach but with sub-pixel precision on all three axes.

### Scoring

Dice coefficient (existing WASM `scoreFont`) on grayscale pixels, with the redaction region masked to white in both images.

### Why Golden-Section Works

The score-vs-parameter curves are unimodal for font matching:
- Too small → less ink overlap → lower score
- Too large → ink extends beyond reference → lower score
- One optimal size in between

The coarse scan protects against any edge-case multimodality by finding the right region first.

## Files Changed

- **`unredact/static/font_detect.js`** — Replace `detectFont`/`detectFontMasked` with new `detectFontMarquee(pageCrop, redactionBox, leftText, rightText, candidates)`. Remove `renderRunsGray`. Replace grid search with golden-section optimizer. Support float font sizes.
- **`unredact/static/font_debug.js`** — Update `showDebug` to display optimizer results (best size with decimal, x/y offsets).
- **`unredact/static/canvas.js`** — Add marquee drawing mode: mousedown starts rectangle, mousemove resizes, mouseup finalizes with resize handles.
- **`unredact/static/main.js`** — Replace double-click handler with marquee workflow. Add "Analyze" button that appears near the marquee. Wire up the new detection flow.
- **`unredact/static/dom.js`** — Add new DOM element references if needed for the analyze button.

## What Gets Removed

- `renderRunsGray` — no more per-run OCR-positioned rendering
- `renderTextGray` — replaced by the new two-segment renderer
- `groupCharRuns` — no longer needed
- `detectFont` / `detectFontMasked` — replaced by `detectFontMarquee`
- Integer font size stepping — replaced by golden-section with 0.1px precision
- Double-click redaction detection — replaced by marquee flow

## Testing

- Visual: draw marquee on a known redaction, verify the debug panel shows baseline-aligned comparison renders
- Visual: verify detected font size has decimal precision (e.g., 38.3px vs 38px)
- Visual: verify the overlap map shows better alignment than current approach
- Functional: marquee resize handles work, "Analyze" button triggers detection
- Edge case: very short text (1-2 words) — coarse scan should still find the right region
