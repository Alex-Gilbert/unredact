# Text Editing & Green Overlay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add green text overlay, editable segment inputs, and font/position controls to the redaction-centric UI so users can pixel-align the overlay and correct OCR before solving.

**Architecture:** Three frontend additions (font toolbar, text edit bar, enhanced canvas rendering) plus one backend enhancement (offset guess in analyze response). All state lives in `redactions[id].overrides` which is initialized from the analysis response and modified by UI controls.

**Tech Stack:** Python/FastAPI (backend), vanilla JS/CSS (frontend), Pillow `getlength` (offset computation)

**Design doc:** `docs/plans/2026-02-16-text-editing-overlay-design.md`

---

### Task 1: Backend — add offset guess to analyze response

**Files:**
- Modify: `unredact/app.py:150-219` (analyze_redaction endpoint)
- Modify: `tests/test_app.py` (update test_redaction_analyze)

**Step 1: Update the test**

In `tests/test_app.py`, update `test_redaction_analyze` to also check for offset fields:

Add these assertions after the existing ones:
```python
        assert "offset_x" in data
        assert "offset_y" in data
        assert isinstance(data["offset_x"], (int, float))
        assert isinstance(data["offset_y"], (int, float))
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_app.py::test_redaction_analyze -v`
Expected: FAIL — `"offset_x" not in data`

**Step 3: Add offset computation to the endpoint**

In `unredact/app.py`, in the `analyze_redaction` function, after computing `left_text` and before building `chars_json`, add:

```python
    # Compute initial offset guess: align end of left text with gap start
    pil_font = font_match.to_pil_font()
    if left_text:
        left_rendered_width = pil_font.getlength(left_text)
        offset_x = float(rx - left_rendered_width - best_line.x)
    else:
        offset_x = 0.0
    offset_y = 0.0
```

Then add to the return dict (alongside the existing `"segments"`, `"gap"`, etc.):
```python
        "offset_x": round(offset_x, 1),
        "offset_y": round(offset_y, 1),
```

**Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_app.py::test_redaction_analyze -v`
Expected: PASS

**Step 5: Commit**

```bash
git add unredact/app.py tests/test_app.py
git commit -m "feat: add offset_x/offset_y to analyze response for alignment guess"
```

---

### Task 2: Frontend — add overrides to state model and initialize on analysis

**Files:**
- Modify: `unredact/static/app.js` (analyzeRedaction, openPopover, state)

**Step 1: Initialize overrides when analysis completes**

In `analyzeRedaction()`, after `r.analysis = data;` (currently at line ~313), add:

```javascript
    // Initialize overrides from analysis
    r.overrides = {
      fontId: data.font.id,
      fontSize: data.font.size,
      offsetX: data.offset_x || 0,
      offsetY: data.offset_y || 0,
      gapWidth: data.gap.w,
      leftText: data.segments.length > 0 ? data.segments[0].text : "",
      rightText: data.segments.length > 1 ? data.segments[1].text : "",
    };
```

**Step 2: Update startSolve to read from overrides**

In `startSolve()` (line ~721), replace the section that reads from `a.font` and `a.gap`:

```javascript
  const o = r.overrides || {};
  const fontId = o.fontId || a.font.id;
  const fontSize = o.fontSize || a.font.size;
  const gapWidth = o.gapWidth || a.gap.w;

  const leftText = o.leftText ?? (a.segments.length > 0 ? a.segments[0].text : "");
  const rightText = o.rightText ?? (a.segments.length > 1 ? a.segments[1].text : "");
  const leftCtx = leftText.length > 0 ? leftText[leftText.length - 1] : "";
  const rightCtx = rightText.length > 0 ? rightText[0] : "";
```

**Step 3: Update preview/solution canvas rendering to use overrides**

In `drawRedactionPreview` and `drawRedactionSolution`, replace hardcoded `a.font.name`/`a.font.size` reads with override-aware reads:

```javascript
  const o = r.overrides || {};
  const fontName = state.fonts.find(f => f.id === (o.fontId || a.font.id))?.name || a.font.name;
  const fontSize = o.fontSize || a.font.size;
  const fontStr = `${fontSize}px "${fontName}"`;
  const gapW = o.gapWidth || a.gap.w;
  const renderX = a.line.x + (o.offsetX || 0);
  const renderY = a.line.y + (o.offsetY || 0);
```

Use `gapW` instead of `a.gap.w` for box widths, and `renderX`/`renderY` for text positioning.

**Step 4: Commit**

```bash
git add unredact/static/app.js
git commit -m "feat: add overrides state model and wire into solver + canvas"
```

---

### Task 3: Frontend — green overlay rendering for active redaction

**Files:**
- Modify: `unredact/static/app.js` (drawRedactionAnalyzed, renderCanvas)

**Step 1: Rewrite drawRedactionAnalyzed for active redaction**

When the redaction is active and analyzed, draw the full green overlay with segments and gap. Replace the current `drawRedactionAnalyzed`:

```javascript
function drawRedactionAnalyzed(r, isActive) {
  if (!isActive) {
    // Non-active: just blue box like before
    drawRedactionUnanalyzed(r, false);
    return;
  }

  // Active: render green overlay with segments and gap
  const a = r.analysis;
  const o = r.overrides || {};
  const fontName = state.fonts.find(f => f.id === (o.fontId || a.font.id))?.name || a.font.name;
  const fontSize = o.fontSize || a.font.size;
  const fontStr = `${fontSize}px "${fontName}"`;
  const gapW = o.gapWidth || a.gap.w;

  const startX = a.line.x + (o.offsetX || 0);
  const startY = a.line.y + (o.offsetY || 0);

  ctx.font = fontStr;
  ctx.textBaseline = "top";

  let cursorX = startX;

  // Draw left segment in green
  const leftText = o.leftText ?? "";
  if (leftText) {
    ctx.fillStyle = "rgba(0, 200, 0, 0.7)";
    ctx.fillText(leftText, cursorX, startY);
    cursorX += ctx.measureText(leftText).width;
  }

  // Draw redaction gap as red box
  const pad = fontSize * 0.15;
  ctx.fillStyle = "rgba(211, 47, 47, 0.5)";
  ctx.fillRect(cursorX, startY - pad, gapW, fontSize + pad * 2);
  ctx.strokeStyle = "rgba(211, 47, 47, 0.8)";
  ctx.lineWidth = 2;
  ctx.strokeRect(cursorX, startY - pad, gapW, fontSize + pad * 2);

  // Gap width label
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = `bold ${Math.min(fontSize * 0.5, 16)}px sans-serif`;
  const label = `${Math.round(gapW)}px`;
  const labelW = ctx.measureText(label).width;
  ctx.fillText(label, cursorX + (gapW - labelW) / 2, startY + fontSize * 0.3);
  ctx.font = fontStr; // restore

  cursorX += gapW;

  // Draw right segment in green
  const rightText = o.rightText ?? "";
  if (rightText) {
    ctx.fillStyle = "rgba(0, 200, 0, 0.7)";
    ctx.fillText(rightText, cursorX, startY);
  }

  // Draw bounding box for the original line area
  ctx.strokeStyle = "rgba(0, 200, 0, 0.3)";
  ctx.lineWidth = 1;
  ctx.strokeRect(a.line.x, a.line.y, a.line.w, a.line.h);
}
```

Also update `drawRedactionPreview` and `drawRedactionSolution` similarly — when active, draw the green segments around the gap, with preview/solution text inside the gap instead of the red box.

**Step 2: Commit**

```bash
git add unredact/static/app.js
git commit -m "feat: green overlay rendering with segments and gap for active redaction"
```

---

### Task 4: Frontend — floating font toolbar

**Files:**
- Modify: `unredact/static/index.html` (add toolbar HTML)
- Modify: `unredact/static/app.js` (toolbar logic)
- Modify: `unredact/static/style.css` (toolbar styles)

**Step 1: Add HTML**

In `index.html`, add inside `#right-panel` before `#popover`:

```html
          <div id="font-toolbar" hidden>
            <label>
              Font
              <select id="font-select"></select>
            </label>
            <span class="toolbar-sep"></span>
            <div class="size-control">
              <span>Size</span>
              <button id="size-down" class="tb-btn">-</button>
              <input type="range" id="size-slider" min="8" max="120" step="1">
              <button id="size-up" class="tb-btn">+</button>
              <span id="size-value">32</span>px
            </div>
            <span class="toolbar-sep"></span>
            <div class="pos-control">
              <span>Pos</span>
              <div class="dpad">
                <button id="pos-up" class="tb-btn dpad-up">&#9650;</button>
                <div class="dpad-mid">
                  <button id="pos-left" class="tb-btn">&#9664;</button>
                  <span id="pos-display" class="pos-display">0, 0</span>
                  <button id="pos-right" class="tb-btn">&#9654;</button>
                </div>
                <button id="pos-down" class="tb-btn dpad-down">&#9660;</button>
              </div>
              <button id="pos-reset" class="tb-btn" style="font-size:0.65rem">Reset</button>
            </div>
            <span class="toolbar-sep"></span>
            <div class="gap-control">
              <span>Gap</span>
              <button id="gap-down" class="tb-btn">-</button>
              <span id="gap-value">0</span>px
              <button id="gap-up" class="tb-btn">+</button>
            </div>
          </div>
```

**Step 2: Add JS logic**

In `app.js`, add DOM references and event handlers:

```javascript
const fontToolbar = document.getElementById("font-toolbar");
const fontSelect = document.getElementById("font-select");
const sizeSlider = document.getElementById("size-slider");
const sizeValue = document.getElementById("size-value");
const sizeDown = document.getElementById("size-down");
const sizeUp = document.getElementById("size-up");
const posUp = document.getElementById("pos-up");
const posDown = document.getElementById("pos-down");
const posLeft = document.getElementById("pos-left");
const posRight = document.getElementById("pos-right");
const posReset = document.getElementById("pos-reset");
const posDisplay = document.getElementById("pos-display");
const gapDown = document.getElementById("gap-down");
const gapUp = document.getElementById("gap-up");
const gapValue = document.getElementById("gap-value");
```

Populate `fontSelect` in `loadFonts()` (after fonts are loaded):
```javascript
  fontSelect.innerHTML = "";
  for (const f of state.fonts.filter(f => f.available)) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.name;
    fontSelect.appendChild(opt);
  }
```

Show/hide toolbar in `openPopover`/`closePopover`:
```javascript
// In openPopover, after popover.hidden = false:
fontToolbar.hidden = false;
fontSelect.value = r.overrides.fontId;
sizeSlider.value = r.overrides.fontSize;
sizeValue.textContent = r.overrides.fontSize;
gapValue.textContent = Math.round(r.overrides.gapWidth);
updatePosDisplay();

// In closePopover:
fontToolbar.hidden = true;
```

Event handlers for all toolbar controls:
```javascript
fontSelect.addEventListener("change", () => {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;
  r.overrides.fontId = fontSelect.value;
  renderCanvas();
});

sizeSlider.addEventListener("input", () => {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;
  r.overrides.fontSize = parseInt(sizeSlider.value);
  sizeValue.textContent = sizeSlider.value;
  renderCanvas();
});

sizeDown.addEventListener("click", () => adjustSize(-1));
sizeUp.addEventListener("click", () => adjustSize(1));

function adjustSize(delta) {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;
  r.overrides.fontSize = Math.max(8, Math.min(120, r.overrides.fontSize + delta));
  sizeSlider.value = r.overrides.fontSize;
  sizeValue.textContent = r.overrides.fontSize;
  renderCanvas();
}

posUp.addEventListener("click", () => nudge(0, -1));
posDown.addEventListener("click", () => nudge(0, 1));
posLeft.addEventListener("click", () => nudge(-1, 0));
posRight.addEventListener("click", () => nudge(1, 0));

function nudge(dx, dy) {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;
  r.overrides.offsetX += dx;
  r.overrides.offsetY += dy;
  updatePosDisplay();
  renderCanvas();
}

function updatePosDisplay() {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;
  posDisplay.textContent = `${Math.round(r.overrides.offsetX)}, ${Math.round(r.overrides.offsetY)}`;
}

posReset.addEventListener("click", () => {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides || !r.analysis) return;
  r.overrides.offsetX = r.analysis.offset_x || 0;
  r.overrides.offsetY = r.analysis.offset_y || 0;
  updatePosDisplay();
  renderCanvas();
});

gapDown.addEventListener("click", () => adjustGap(-1));
gapUp.addEventListener("click", () => adjustGap(1));

function adjustGap(delta) {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;
  r.overrides.gapWidth = Math.max(1, r.overrides.gapWidth + delta);
  gapValue.textContent = Math.round(r.overrides.gapWidth);
  renderCanvas();
}
```

**Step 3: Add CSS**

```css
#font-toolbar {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  right: 0.5rem;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: rgba(22, 33, 62, 0.92);
  backdrop-filter: blur(6px);
  border-radius: 6px;
  border: 1px solid #0f3460;
  font-size: 0.8rem;
  color: #aaa;
}

/* ... plus .tb-btn, .toolbar-sep, .size-control, .pos-control, .dpad, .gap-control styles
   (same patterns as the old #font-controls styles from the original CSS) */
```

**Step 4: Commit**

```bash
git add unredact/static/app.js unredact/static/index.html unredact/static/style.css
git commit -m "feat: add floating font toolbar with size, position, and gap controls"
```

---

### Task 5: Frontend — bottom text edit bar

**Files:**
- Modify: `unredact/static/index.html` (add bar HTML)
- Modify: `unredact/static/app.js` (text input logic)
- Modify: `unredact/static/style.css` (bar styles)

**Step 1: Add HTML**

In `index.html`, add inside `#right-panel` after `#doc-container`:

```html
          <div id="text-edit-bar" hidden>
            <input type="text" id="left-text-input" class="seg-input" spellcheck="false" autocomplete="off" placeholder="left text">
            <span id="redaction-marker" class="redaction-marker">???</span>
            <input type="text" id="right-text-input" class="seg-input" spellcheck="false" autocomplete="off" placeholder="right text">
            <button id="text-reset" class="tb-btn" title="Reset to OCR">Reset</button>
          </div>
```

**Step 2: Add JS logic**

```javascript
const textEditBar = document.getElementById("text-edit-bar");
const leftTextInput = document.getElementById("left-text-input");
const rightTextInput = document.getElementById("right-text-input");
const redactionMarker = document.getElementById("redaction-marker");
const textReset = document.getElementById("text-reset");
```

Show/hide in `openPopover`/`closePopover`:
```javascript
// In openPopover:
textEditBar.hidden = false;
leftTextInput.value = r.overrides.leftText;
rightTextInput.value = r.overrides.rightText;
redactionMarker.textContent = r.preview || "???";

// In closePopover:
textEditBar.hidden = true;
```

Event handlers:
```javascript
leftTextInput.addEventListener("input", () => {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;
  r.overrides.leftText = leftTextInput.value;
  renderCanvas();
});

rightTextInput.addEventListener("input", () => {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;
  r.overrides.rightText = rightTextInput.value;
  renderCanvas();
});

textReset.addEventListener("click", () => {
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides || !r.analysis) return;
  const a = r.analysis;
  r.overrides.leftText = a.segments.length > 0 ? a.segments[0].text : "";
  r.overrides.rightText = a.segments.length > 1 ? a.segments[1].text : "";
  leftTextInput.value = r.overrides.leftText;
  rightTextInput.value = r.overrides.rightText;
  renderCanvas();
});
```

Update `redactionMarker` when preview changes (in `handleSolveEvent` where preview is set):
```javascript
redactionMarker.textContent = data.text;
redactionMarker.className = "redaction-marker preview";
```

**Step 3: Add CSS**

```css
#text-edit-bar {
  position: absolute;
  bottom: 0.5rem;
  left: 0.5rem;
  right: 0.5rem;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.6rem;
  background: rgba(22, 33, 62, 0.92);
  backdrop-filter: blur(6px);
  border-radius: 6px;
  border: 1px solid #0f3460;
  font-size: 0.8rem;
}

.seg-input {
  flex: 1;
  min-width: 3rem;
  background: #0a1628;
  color: #e0e0e0;
  border: 1px solid #1a3a6e;
  border-radius: 4px;
  padding: 0.3rem 0.4rem;
  font-family: monospace;
  font-size: 0.85rem;
}

.seg-input:focus {
  outline: none;
  border-color: #00d474;
}

.redaction-marker {
  flex-shrink: 0;
  padding: 0.25rem 0.4rem;
  background: #d32f2f;
  color: #fff;
  font-size: 0.65rem;
  font-weight: 700;
  border-radius: 3px;
}

.redaction-marker.preview {
  background: #b8860b;
  color: #ffe082;
}
```

**Step 4: Commit**

```bash
git add unredact/static/app.js unredact/static/index.html unredact/static/style.css
git commit -m "feat: add bottom text edit bar with editable segment inputs"
```

---

### Task 6: Wire everything together — popover context updates

**Files:**
- Modify: `unredact/static/app.js`

**Step 1: Remove static context display from popover**

The popover currently shows a static `popoverContext` display and `popoverFontInfo`. These are now redundant — the font toolbar and text edit bar serve those purposes. Remove or simplify the `popoverContext` and `popoverFontInfo` population in `openPopover()`. The popover should now just contain the solver controls.

Optionally keep `popoverContext` as a compact read-only summary: `"...left_text [GAP 150px] right_text..."` that updates when text inputs change.

**Step 2: Ensure closePopover hides all three UI elements**

```javascript
function closePopover() {
  popover.hidden = true;
  fontToolbar.hidden = true;
  textEditBar.hidden = true;
  stopSolve();
}
```

And when deactivating (clicking away, changing page):
```javascript
// In loadPage, after state.activeRedaction = null:
closePopover();
```

**Step 3: Ensure activateRedaction shows all controls for already-analyzed**

When clicking a redaction that's already analyzed, `openPopover` should also show the toolbar and text bar with the saved overrides.

**Step 4: Commit**

```bash
git add unredact/static/app.js
git commit -m "refactor: wire font toolbar and text bar into popover lifecycle"
```

---

## Execution Order

Tasks 1 is backend (independent).
Tasks 2-6 are frontend (sequential, each builds on previous).

Dependencies:
- Task 2 depends on Task 1 (uses offset_x/offset_y from response)
- Task 3 depends on Task 2 (uses overrides for rendering)
- Task 4 depends on Task 2 (modifies overrides)
- Task 5 depends on Task 2 (modifies overrides)
- Task 6 depends on Tasks 3-5 (wires them together)
