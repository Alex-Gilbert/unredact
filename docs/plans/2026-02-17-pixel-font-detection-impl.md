# Pixel-Based Font Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace word-width MAE font detection with pixel-based normalized cross-correlation so font+size detection is accurate enough for overlay rendering.

**Architecture:** Render each candidate font+size onto a canvas matching the OCR line's bounding box, binarize both the rendered text and the page image crop, compute pixel overlap with small-shift tolerance. The candidate with highest overlap wins. Size search is constrained by OCR line height.

**Tech Stack:** PIL/Pillow (rendering), numpy (pixel comparison), existing test fixtures

---

### Task 1: Write pixel scoring function with test

**Files:**
- Create: `tests/test_pixel_scoring.py`
- Modify: `unredact/pipeline/font_detect.py`

**Step 1: Write the failing test**

```python
# tests/test_pixel_scoring.py
"""Test pixel-based font scoring — render known text and verify detection."""
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from unredact.pipeline.font_detect import _find_font_path, _score_font_line_pixel
from unredact.pipeline.ocr import OcrChar, OcrLine


def _make_line_and_crop(font_name: str, font_size: int, text: str):
    """Render text with a known font and return (OcrLine, grayscale_crop)."""
    font_path = _find_font_path(font_name)
    assert font_path is not None, f"Font {font_name} not found"
    font = ImageFont.truetype(str(font_path), font_size)

    # Measure the text
    bbox = font.getbbox(text)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]

    # Render onto a white canvas with some padding
    pad = 10
    img = Image.new("L", (text_w + pad * 2, text_h + pad * 2), 255)
    draw = ImageDraw.Draw(img)
    draw.text((pad - bbox[0], pad - bbox[1]), text, font=font, fill=0)

    # Build a fake OcrLine with word-level bounding boxes
    words = text.split()
    chars = []
    cursor_x = pad
    for wi, word in enumerate(words):
        word_bbox = font.getbbox(word)
        word_w = word_bbox[2] - word_bbox[0]
        char_w = word_w / len(word)
        for ci, ch in enumerate(word):
            chars.append(OcrChar(
                text=ch,
                x=int(cursor_x + ci * char_w),
                y=pad,
                w=max(1, int(char_w)),
                h=text_h,
                conf=95.0,
            ))
        cursor_x += word_w
        # Add space between words
        if wi < len(words) - 1:
            space_w = font.getlength(" ")
            chars.append(OcrChar(
                text=" ", x=int(cursor_x), y=pad,
                w=max(1, int(space_w)), h=text_h, conf=95.0,
            ))
            cursor_x += space_w

    line = OcrLine(
        chars=chars,
        x=pad, y=pad,
        w=int(cursor_x - pad), h=text_h,
    )

    crop = np.array(img)
    return line, crop


def test_pixel_scoring_correct_font_scores_highest():
    """The correct font+size should score higher than a wrong font."""
    text = "Got it. Sent an email."
    line, crop = _make_line_and_crop("Times New Roman", 50, text)

    tnr_path = _find_font_path("Times New Roman")
    arial_path = _find_font_path("Arial")
    assert tnr_path and arial_path

    tnr_font = ImageFont.truetype(str(tnr_path), 50)
    arial_font = ImageFont.truetype(str(arial_path), 50)
    arial_44_font = ImageFont.truetype(str(arial_path), 44)

    score_tnr = _score_font_line_pixel(tnr_font, line, crop)
    score_arial = _score_font_line_pixel(arial_font, line, crop)
    score_arial_44 = _score_font_line_pixel(arial_44_font, line, crop)

    # TNR at correct size should beat Arial at any size
    assert score_tnr > score_arial, (
        f"TNR@50 ({score_tnr:.3f}) should beat Arial@50 ({score_arial:.3f})"
    )
    assert score_tnr > score_arial_44, (
        f"TNR@50 ({score_tnr:.3f}) should beat Arial@44 ({score_arial_44:.3f})"
    )


def test_pixel_scoring_wrong_size_scores_lower():
    """The correct font at the wrong size should score lower."""
    text = "Got it. Sent an email."
    line, crop = _make_line_and_crop("Times New Roman", 50, text)

    tnr_path = _find_font_path("Times New Roman")
    assert tnr_path

    font_50 = ImageFont.truetype(str(tnr_path), 50)
    font_44 = ImageFont.truetype(str(tnr_path), 44)
    font_60 = ImageFont.truetype(str(tnr_path), 60)

    score_50 = _score_font_line_pixel(font_50, line, crop)
    score_44 = _score_font_line_pixel(font_44, line, crop)
    score_60 = _score_font_line_pixel(font_60, line, crop)

    assert score_50 > score_44, (
        f"TNR@50 ({score_50:.3f}) should beat TNR@44 ({score_44:.3f})"
    )
    assert score_50 > score_60, (
        f"TNR@50 ({score_50:.3f}) should beat TNR@60 ({score_60:.3f})"
    )
```

**Step 2: Run test to verify it fails**

Run: `pytest tests/test_pixel_scoring.py -v`
Expected: FAIL with `ImportError: cannot import name '_score_font_line_pixel'`

**Step 3: Implement the pixel scoring function**

Add to `unredact/pipeline/font_detect.py`:

```python
import numpy as np

def _shift_2d(arr: np.ndarray, dx: int, dy: int) -> np.ndarray:
    """Shift a 2D boolean array by (dx, dy), filling edges with False."""
    h, w = arr.shape
    result = np.zeros_like(arr)
    # Y slices
    if dy >= 0:
        src_y, dst_y = slice(0, h - dy), slice(dy, h)
    else:
        src_y, dst_y = slice(-dy, h), slice(0, h + dy)
    # X slices
    if dx >= 0:
        src_x, dst_x = slice(0, w - dx), slice(dx, w)
    else:
        src_x, dst_x = slice(-dx, w), slice(0, w + dx)
    result[dst_y, dst_x] = arr[src_y, src_x]
    return result


def _score_font_line_pixel(
    font: ImageFont.FreeTypeFont,
    line: OcrLine,
    line_crop: np.ndarray,
) -> float:
    """Score how well a font matches using pixel overlap.

    Args:
        font: Candidate PIL font at a specific size.
        line: OCR'd line with text and bounding box.
        line_crop: Grayscale numpy array of the line region from the page image.

    Returns:
        Overlap score from 0.0 to 1.0. Higher is better.
    """
    h, w = line_crop.shape
    if h < 5 or w < 10:
        return 0.0

    # Binarize page crop (ink pixels = True)
    page_bin = line_crop < 128

    page_ink = page_bin.sum()
    if page_ink < 10:
        return 0.0

    # Render line text with this font onto same-size canvas
    rendered_img = Image.new("L", (w, h), 255)
    draw = ImageDraw.Draw(rendered_img)

    # Position text so ink aligns with the crop
    bbox = font.getbbox(line.text)
    # Draw at (0, 0) offset by the font's top bearing
    draw.text((-bbox[0], -bbox[1]), line.text, font=font, fill=0)

    rendered_arr = np.array(rendered_img)
    rendered_bin = rendered_arr < 128

    rendered_ink = rendered_bin.sum()
    if rendered_ink < 10:
        return 0.0

    # Try small shifts to find best alignment
    best_score = 0.0
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            shifted = _shift_2d(rendered_bin, dx, dy)
            intersection = (page_bin & shifted).sum()
            # Intersection over minimum — fraction of the smaller set that overlaps
            min_ink = min(page_ink, rendered_ink)
            score = float(intersection / min_ink) if min_ink > 0 else 0.0
            if score > best_score:
                best_score = score
    return best_score
```

**Step 4: Run test to verify it passes**

Run: `pytest tests/test_pixel_scoring.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/test_pixel_scoring.py unredact/pipeline/font_detect.py
git commit -m "feat: add pixel-based font scoring function"
```

---

### Task 2: Update full search to use pixel scoring

**Files:**
- Modify: `unredact/pipeline/font_detect.py:99-146` (`_full_search`, `_fine_search`)
- Create: `tests/test_pixel_full_search.py`

**Step 1: Write the failing test**

```python
# tests/test_pixel_full_search.py
"""Test that full search with pixel scoring finds the correct font."""
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from unredact.pipeline.font_detect import _find_font_path, _full_search, _fine_search
from unredact.pipeline.ocr import OcrChar, OcrLine


def _make_line_and_crop(font_name: str, font_size: int, text: str):
    """Render text with a known font and return (OcrLine, grayscale_crop)."""
    font_path = _find_font_path(font_name)
    assert font_path is not None, f"Font {font_name} not found"
    font = ImageFont.truetype(str(font_path), font_size)

    bbox = font.getbbox(text)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]

    pad = 10
    img = Image.new("L", (text_w + pad * 2, text_h + pad * 2), 255)
    draw = ImageDraw.Draw(img)
    draw.text((pad - bbox[0], pad - bbox[1]), text, font=font, fill=0)

    words = text.split()
    chars = []
    cursor_x = pad
    for wi, word in enumerate(words):
        word_bbox = font.getbbox(word)
        word_w = word_bbox[2] - word_bbox[0]
        char_w = word_w / len(word)
        for ci, ch in enumerate(word):
            chars.append(OcrChar(
                text=ch,
                x=int(cursor_x + ci * char_w),
                y=pad,
                w=max(1, int(char_w)),
                h=text_h,
                conf=95.0,
            ))
        cursor_x += word_w
        if wi < len(words) - 1:
            space_w = font.getlength(" ")
            chars.append(OcrChar(
                text=" ", x=int(cursor_x), y=pad,
                w=max(1, int(space_w)), h=text_h, conf=95.0,
            ))
            cursor_x += space_w

    line = OcrLine(
        chars=chars,
        x=pad, y=pad,
        w=int(cursor_x - pad), h=text_h,
    )

    crop = np.array(img)
    return line, crop


def test_full_search_finds_correct_serif():
    """Full search should identify Times New Roman text as TNR."""
    text = "Got it. Sent an email."
    line, crop = _make_line_and_crop("Times New Roman", 50, text)

    best = _full_search(line, crop)
    assert best is not None
    assert "Times" in best.font_name or "Liberation Serif" in best.font_name, (
        f"Expected serif font, got {best.font_name}"
    )
    assert 47 <= best.font_size <= 53, (
        f"Expected size ~50, got {best.font_size}"
    )


def test_full_search_finds_correct_sans():
    """Full search should identify Arial text as Arial or Liberation Sans."""
    text = "The quick brown fox jumps."
    line, crop = _make_line_and_crop("Arial", 44, text)

    best = _full_search(line, crop)
    assert best is not None
    assert "Arial" in best.font_name or "Liberation Sans" in best.font_name, (
        f"Expected sans-serif font, got {best.font_name}"
    )
    assert 41 <= best.font_size <= 47, (
        f"Expected size ~44, got {best.font_size}"
    )
```

**Step 2: Run test to verify it fails**

Run: `pytest tests/test_pixel_full_search.py -v`
Expected: FAIL — `_full_search()` still uses word-width MAE and wrong signature.

**Step 3: Update `_full_search` and `_fine_search`**

In `unredact/pipeline/font_detect.py`, replace `_full_search` and `_fine_search`:

```python
def _full_search(line: OcrLine, line_crop: np.ndarray) -> FontMatch | None:
    """Full search across all candidate fonts and sizes for one line.

    Uses OCR line height to constrain size search range.
    Scores by pixel overlap (higher is better).
    """
    best: FontMatch | None = None

    # Constrain size range based on line height
    line_h = line.h
    min_size = max(12, int(line_h * 0.6))
    max_size = min(120, int(line_h * 1.4))
    coarse_step = max(2, (max_size - min_size) // 10)

    for font_name in CANDIDATE_FONTS:
        font_path = _find_font_path(font_name)
        if font_path is None:
            continue

        for size in range(min_size, max_size + 1, coarse_step):
            try:
                font = ImageFont.truetype(str(font_path), size)
            except Exception:
                continue

            score = _score_font_line_pixel(font, line, line_crop)

            if best is None or score > best.score:
                best = FontMatch(
                    font_name=font_name,
                    font_path=font_path,
                    font_size=size,
                    score=score,
                )

    return best


def _fine_search(
    line: OcrLine,
    line_crop: np.ndarray,
    coarse: FontMatch,
) -> FontMatch:
    """Fine search: ±3 around the coarse best size in steps of 1."""
    best = coarse
    for size in range(max(8, coarse.font_size - 3), coarse.font_size + 4):
        if size == coarse.font_size:
            continue
        try:
            font = ImageFont.truetype(str(coarse.font_path), size)
        except Exception:
            continue
        score = _score_font_line_pixel(font, line, line_crop)
        if score > best.score:
            best = FontMatch(
                font_name=coarse.font_name,
                font_path=coarse.font_path,
                font_size=size,
                score=score,
            )
    return best
```

Also remove the old `_score_font_line` function and `SIZE_RANGE` constant (no longer needed).

**Step 4: Run test to verify it passes**

Run: `pytest tests/test_pixel_full_search.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add unredact/pipeline/font_detect.py tests/test_pixel_full_search.py
git commit -m "feat: switch full/fine search to pixel-based scoring"
```

---

### Task 3: Update detect_font_for_line and detect_fonts APIs

**Files:**
- Modify: `unredact/pipeline/font_detect.py:148-234` (`detect_font_for_line`, `detect_fonts`, `detect_font`)

**Step 1: Update `detect_font_for_line` to accept and use page image**

```python
def detect_font_for_line(
    line: OcrLine,
    page_image: Image.Image,
    prior: FontMatch | None = None,
) -> FontMatch:
    """Detect the best font for a single line of text.

    Crops the line region from page_image and uses pixel-based
    scoring to find the best matching font+size.
    """
    # Crop line region from page image
    line_crop = np.array(
        page_image.convert("L").crop((line.x, line.y, line.x + line.w, line.y + line.h))
    )

    # Lines with too few characters can't be scored reliably
    if len(line.text.strip()) < 3:
        if prior is not None:
            return prior

    # Test the prior first
    prior_score = 0.0
    if prior is not None:
        try:
            prior_font = prior.to_pil_font()
            prior_score = _score_font_line_pixel(prior_font, line, line_crop)
        except Exception:
            pass

    # Full search
    best = _full_search(line, line_crop)
    if best is None:
        if prior is not None:
            return prior
        raise RuntimeError("No matching font found. Check system fonts.")

    # Fine-tune the full search winner
    best = _fine_search(line, line_crop, best)

    # If prior is close enough, prefer it for consistency
    if prior is not None and prior_score >= best.score * (1 / PRIOR_BIAS):
        return _fine_search(line, line_crop, prior)

    return best
```

**Step 2: Update `detect_fonts`**

```python
def detect_fonts(
    lines: list[OcrLine],
    page_image: Image.Image,
) -> list[FontMatch]:
    """Detect the best font for each line on a page."""
    results: list[FontMatch] = []
    prior: FontMatch | None = None

    for line in lines:
        match = detect_font_for_line(line, page_image, prior=prior)
        results.append(match)
        prior = match

    return results
```

**Step 3: Update `detect_font` (legacy API)**

```python
def detect_font(
    lines: list[OcrLine],
    page_image: Image.Image,
) -> FontMatch:
    """Detect a single best font for the page (legacy API)."""
    if not lines:
        raise RuntimeError("No lines to detect font from.")
    font_matches = detect_fonts(lines, page_image)
    from collections import Counter
    counts = Counter((m.font_name, m.font_size) for m in font_matches)
    best_key = counts.most_common(1)[0][0]
    for m in font_matches:
        if (m.font_name, m.font_size) == best_key:
            return m
    return font_matches[0]
```

**Step 4: Run all existing font detect tests**

Run: `pytest tests/test_font_detect.py tests/test_pixel_scoring.py tests/test_pixel_full_search.py -v`
Expected: PASS (existing tests use `detect_font(lines, page_image)` which still works)

**Step 5: Commit**

```bash
git add unredact/pipeline/font_detect.py
git commit -m "feat: update font detection API to pass page image for pixel scoring"
```

---

### Task 4: Update app.py to pass page image to detect_font_for_line

**Files:**
- Modify: `unredact/app.py:163`

**Step 1: Update the `_run_analysis` call**

In `unredact/app.py`, line 163, change:
```python
font_match = detect_font_for_line(best_line)
```
to:
```python
font_match = detect_font_for_line(best_line, line_crop)
```

**Step 2: Run the app and verify it starts**

Run: `cd /home/alex/dev/unredact && python -c "from unredact.app import app; print('OK')"`
Expected: "OK" — no import errors

**Step 3: Commit**

```bash
git add unredact/app.py
git commit -m "fix: pass page image to detect_font_for_line in analysis"
```

---

### Task 5: Clean up old code and run full test suite

**Files:**
- Modify: `unredact/pipeline/font_detect.py` (remove dead code)

**Step 1: Remove the old `_score_font_line` function and `SIZE_RANGE` constant**

These are no longer used by any code path. Delete them.

**Step 2: Run the full test suite**

Run: `pytest tests/ -v --timeout=120`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add unredact/pipeline/font_detect.py
git commit -m "refactor: remove old word-width scoring function"
```

---

### Task 6: Manual verification with real document

**Step 1: Start the app and test with a real document**

Run: `cd /home/alex/dev/unredact && python -m unredact.app`

Upload a document, click a redaction, check that:
- The detected font is correct (serif vs sans-serif)
- The font size is approximately right
- The green overlay text aligns with the original text

**Step 2: Run alignment test**

Run: `pytest tests/test_alignment.py -v -s`
Expected: PASS with alignment hit rate printed

**Step 3: Final commit if any tweaks needed**
