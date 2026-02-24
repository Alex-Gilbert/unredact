import heapq
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from unredact.pipeline.ocr import OcrChar, OcrLine

# Candidate fonts to test (common document fonts available on the system)
CANDIDATE_FONTS: list[str] = [
    "Times New Roman",
    "Arial",
    "Courier New",
    "Georgia",
    "Verdana",
    "Carlito",
    "Trebuchet MS",
    "Liberation Serif",
    "Liberation Sans",
    "DejaVu Serif",
    "DejaVu Sans",
]

# If the prior's score is within this factor of the best possible score,
# keep the prior. This avoids flipping fonts on noisy lines.
PRIOR_BIAS = 1.15


@lru_cache(maxsize=32)
def _find_font_path(font_name: str) -> Path | None:
    """Find the .ttf file for a font name using fc-match."""
    import subprocess

    result = subprocess.run(
        ["fc-match", "--format=%{file}", font_name],
        capture_output=True, text=True,
    )
    if result.returncode == 0 and result.stdout:
        p = Path(result.stdout.strip())
        if p.exists():
            return p
    return None


@dataclass
class FontMatch:
    font_name: str
    font_path: Path
    font_size: int  # in pixels
    score: float  # higher is better (pixel overlap, 0.0-1.0)

    def to_pil_font(self) -> ImageFont.FreeTypeFont:
        return ImageFont.truetype(str(self.font_path), self.font_size)


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

    page_ink = int(page_bin.sum())
    if page_ink < 10:
        return 0.0

    # Render line text with this font onto same-size canvas
    rendered_img = Image.new("L", (w, h), 255)
    draw = ImageDraw.Draw(rendered_img)

    # Position text so ink aligns with the crop.
    # line.x, line.y give the line's position within the crop coordinate
    # system; bbox gives the font's built-in offset from the origin.
    bbox = font.getbbox(line.text)
    draw.text((line.x - bbox[0], line.y - bbox[1]), line.text, font=font, fill=0)

    rendered_arr = np.array(rendered_img)
    rendered_bin = rendered_arr < 128

    rendered_ink = int(rendered_bin.sum())
    if rendered_ink < 10:
        return 0.0

    # Try small shifts to find best alignment, using Dice coefficient
    # to penalise both missing and extra ink.
    best_score = 0.0
    total_ink = page_ink + rendered_ink
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            shifted = _shift_2d(rendered_bin, dx, dy)
            intersection = int((page_bin & shifted).sum())
            score = 2.0 * intersection / total_ink if total_ink > 0 else 0.0
            if score > best_score:
                best_score = score
    return best_score


def align_text_to_page(
    text: str,
    font: ImageFont.FreeTypeFont,
    page_crop: np.ndarray,
    search_x: int = 20,
    search_y: int = 10,
) -> tuple[int, int]:
    """Find the (x, y) offset where rendered text best aligns with the page.

    Renders the text, then slides it across the page crop to find the
    position with maximum pixel overlap.

    Args:
        text: The text to render and align.
        font: PIL font to render with.
        page_crop: Grayscale numpy array of the page region to align against.
        search_x: Horizontal search range (±pixels).
        search_y: Vertical search range (±pixels).

    Returns:
        (offset_x, offset_y) — pixel offsets from the crop's top-left corner
        to where the rendered text best aligns.
    """
    h, w = page_crop.shape
    if h < 5 or w < 10 or not text.strip():
        return (0, 0)

    page_bin = page_crop < 128
    page_ink = int(page_bin.sum())
    if page_ink < 10:
        return (0, 0)

    # Render the text
    bbox = font.getbbox(text)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    if text_w < 1 or text_h < 1:
        return (0, 0)

    # Render onto a canvas large enough to slide within
    canvas_w = w + search_x * 2
    canvas_h = h + search_y * 2
    rendered_img = Image.new("L", (canvas_w, canvas_h), 255)
    draw = ImageDraw.Draw(rendered_img)
    # Place text at center of the search area
    draw.text((search_x - bbox[0], search_y - bbox[1]), text, font=font, fill=0)
    rendered_arr = np.array(rendered_img)
    rendered_bin = rendered_arr < 128

    rendered_ink = int(rendered_bin.sum())
    if rendered_ink < 10:
        return (0, 0)

    # Slide the rendered text and find the best alignment
    best_score = 0.0
    best_dx, best_dy = 0, 0

    for dy in range(-search_y, search_y + 1):
        for dx in range(-search_x, search_x + 1):
            # Extract the window from the rendered canvas that aligns with the page
            ry = search_y + dy
            rx = search_x + dx
            window = rendered_bin[ry:ry + h, rx:rx + w]
            if window.shape != page_bin.shape:
                continue
            intersection = int((page_bin & window).sum())
            total = page_ink + rendered_ink
            score = 2.0 * intersection / total if total > 0 else 0.0
            if score > best_score:
                best_score = score
                best_dx, best_dy = dx, dy

    # The offset is where the text's top-left corner lands in the crop
    return (-best_dx, -best_dy)


def _full_search(
    line_h: int,
    scorer: Callable[[ImageFont.FreeTypeFont], float],
    top_n: int = 1,
) -> list[FontMatch]:
    """Full search across all candidate fonts and sizes.

    Args:
        line_h: OCR line height in pixels (used to bound the size search).
        scorer: Callable that takes a PIL font and returns a score (0.0–1.0).
        top_n: Number of top candidates to return.
    """
    heap: list[tuple[float, int, FontMatch]] = []
    counter = 0

    # Constrain size range using the OCR line height.
    # Pixel scoring has sharp peaks at the exact size, so we scan
    # every integer size (step=1) instead of using a coarse step.
    min_size = max(12, int(line_h * 0.6))
    max_size = min(120, int(line_h * 1.4))

    for font_name in CANDIDATE_FONTS:
        font_path = _find_font_path(font_name)
        if font_path is None:
            continue

        for size in range(min_size, max_size + 1):
            try:
                font = ImageFont.truetype(str(font_path), size)
            except Exception:
                continue

            score = scorer(font)
            match = FontMatch(
                font_name=font_name,
                font_path=font_path,
                font_size=size,
                score=score,
            )

            if len(heap) < top_n:
                heapq.heappush(heap, (score, counter, match))
            elif score > heap[0][0]:
                heapq.heapreplace(heap, (score, counter, match))
            counter += 1

    return [m for (_, _, m) in sorted(heap, reverse=True)]


def _fine_search(
    coarse: FontMatch,
    scorer: Callable[[ImageFont.FreeTypeFont], float],
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
        score = scorer(font)
        if score > best.score:
            best = FontMatch(
                font_name=coarse.font_name,
                font_path=coarse.font_path,
                font_size=size,
                score=score,
            )
    return best


def detect_font_for_line_from_crop(
    line: OcrLine,
    line_crop: np.ndarray,
) -> FontMatch:
    """Detect the best font given a pre-cropped grayscale numpy array.

    Use this when you already have a clean crop of the line region
    (e.g. the non-redacted portion of a line). The line's x/y should
    be 0,0 (crop-relative coordinates).
    """
    scorer = lambda font: _score_font_line_pixel(font, line, line_crop)
    results = _full_search(line.h, scorer)
    if not results:
        raise RuntimeError("No matching font found. Check system fonts.")
    return _fine_search(results[0], scorer)


def _filter_clean_chars(
    chars: list[OcrChar],
    redaction_boxes: list[tuple[int, int, int, int]],
) -> list[OcrChar]:
    """Return chars whose center doesn't fall inside any redaction box."""
    clean = []
    for c in chars:
        cx = c.x + c.w / 2
        cy = c.y + c.h / 2
        in_box = False
        for rx, ry, rw, rh in redaction_boxes:
            if rx <= cx <= rx + rw and ry <= cy <= ry + rh:
                in_box = True
                break
        if not in_box:
            clean.append(c)
    return clean


def _group_chars_into_runs(chars: list[OcrChar]) -> list[list[OcrChar]]:
    """Group consecutive chars into word-like runs for rendering.

    Chars that are spatially close (same y, adjacent x) are grouped so
    they can be rendered as a single string, preserving kerning.
    """
    if not chars:
        return []
    runs: list[list[OcrChar]] = []
    current = [chars[0]]
    for c in chars[1:]:
        prev = current[-1]
        # Same vertical position and horizontally adjacent (within 5px gap)
        if c.y == prev.y and c.x <= prev.x + prev.w + 5:
            current.append(c)
        else:
            runs.append(current)
            current = [c]
    runs.append(current)
    return runs


def _score_font_masked_pixel(
    font: ImageFont.FreeTypeFont,
    char_runs: list[list[OcrChar]],
    line_x: int,
    line_y: int,
    line_crop: np.ndarray,
) -> float:
    """Score font by rendering clean char runs at their OCR positions.

    Unlike _score_font_line_pixel which renders the full line text as a
    single string, this renders each word-like run at its actual OCR
    position. This correctly handles the spatial gap where a redaction
    was masked out, preventing:
    - OCR artifacts from producing false ink
    - Right-side text from rendering at the wrong x position
    - Large fonts from getting inflated scores due to canvas overflow
    """
    h, w = line_crop.shape
    if h < 5 or w < 10:
        return 0.0

    page_bin = line_crop < 128
    page_ink = int(page_bin.sum())
    if page_ink < 10:
        return 0.0

    # Render each run at its OCR position
    rendered_img = Image.new("L", (w, h), 255)
    draw = ImageDraw.Draw(rendered_img)

    for run in char_runs:
        text = "".join(c.text for c in run)
        if not text.strip():
            continue
        # Crop-relative position of the run's first char
        cx = run[0].x - line_x
        cy = run[0].y - line_y
        bbox = font.getbbox(text)
        draw.text((cx - bbox[0], cy - bbox[1]), text, font=font, fill=0)

    rendered_arr = np.array(rendered_img)
    rendered_bin = rendered_arr < 128

    rendered_ink = int(rendered_bin.sum())
    if rendered_ink < 10:
        return 0.0

    # Try small shifts to find best alignment, using Dice coefficient
    best_score = 0.0
    total_ink = page_ink + rendered_ink
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            shifted = _shift_2d(rendered_bin, dx, dy)
            intersection = int((page_bin & shifted).sum())
            score = 2.0 * intersection / total_ink if total_ink > 0 else 0.0
            if score > best_score:
                best_score = score
    return best_score


def detect_font_masked(
    line: OcrLine,
    page_image: Image.Image,
    redaction_boxes: list[tuple[int, int, int, int]],
) -> FontMatch:
    """Detect the best font by masking redaction boxes and scoring clean chars.

    Masks each redaction box to white in the page crop, then renders only
    the non-redacted characters at their OCR positions for scoring. This
    ensures the rendered text matches the spatial layout of the page.

    Args:
        line: OCR line with page-relative coordinates.
        page_image: Full page as a PIL Image (any mode; converted to grayscale).
        redaction_boxes: List of (rx, ry, rw, rh) rectangles in page-relative
            coordinates. Each rectangle is painted white before scoring.

    Returns:
        FontMatch with the best font name, path, size, and score.
    """
    # 1. Crop the line region from the page image
    line_crop = np.array(
        page_image.convert("L").crop((line.x, line.y, line.x + line.w, line.y + line.h))
    )

    # 2. Mask each redaction box to white (255)
    for rx, ry, rw, rh in redaction_boxes:
        cx = rx - line.x
        cy = ry - line.y
        x0 = max(0, cx)
        y0 = max(0, cy)
        x1 = min(line.w, cx + rw)
        y1 = min(line.h, cy + rh)
        if x0 < x1 and y0 < y1:
            line_crop[y0:y1, x0:x1] = 255

    # 3. Filter out chars in redaction zones, group into runs
    clean_chars = _filter_clean_chars(line.chars, redaction_boxes)
    if not clean_chars:
        raise RuntimeError("No clean chars outside redaction boxes.")
    char_runs = _group_chars_into_runs(clean_chars)

    # 4. Search using position-aware masked scoring
    scorer = lambda font: _score_font_masked_pixel(
        font, char_runs, line.x, line.y, line_crop,
    )
    from unredact.pipeline.font_debug import debug_enabled, get_debug_ctx, start_debug_session, next_line_idx, save_line_debug
    top_n = 5 if debug_enabled() else 1

    # Use median character height for size estimation — line.h can span
    # multiple physical text lines, making the search range far too large.
    char_heights = [c.h for c in clean_chars if c.text.strip()]
    estimated_h = int(np.median(char_heights)) if char_heights else line.h
    results = _full_search(estimated_h, scorer, top_n=top_n)
    if not results:
        raise RuntimeError("No matching font found. Check system fonts.")
    best = _fine_search(results[0], scorer)

    if debug_enabled():
        ctx = get_debug_ctx()
        if ctx is None:
            start_debug_session()
            ctx = get_debug_ctx()
        save_line_debug(
            ctx["dir"], next_line_idx(), line_crop, results,
            {"type": "masked", "char_runs": char_runs, "line_x": line.x, "line_y": line.y},
        )

    return best


def detect_font_for_line(
    line: OcrLine,
    page_image: Image.Image,
    prior: FontMatch | None = None,
) -> FontMatch:
    """Detect the best font for a single line of text.

    If a prior is given (e.g. from the previous line), test it first.
    If it scores well enough (within PRIOR_BIAS of the best), keep it
    to maintain consistency. Only do a full search if the prior is
    significantly worse or absent.
    """
    # Crop line region from page image and create crop-relative line
    line_crop = np.array(
        page_image.convert("L").crop((line.x, line.y, line.x + line.w, line.y + line.h))
    )
    scoring_line = OcrLine(
        chars=line.chars,
        x=0, y=0,
        w=line.w, h=line.h,
    )

    scorer = lambda font: _score_font_line_pixel(font, scoring_line, line_crop)

    # Lines with too few characters can't be scored reliably
    if len(line.text.strip()) < 3:
        if prior is not None:
            return prior
        # Fall through to full search

    # Test the prior first
    prior_score = 0.0
    if prior is not None:
        try:
            prior_font = prior.to_pil_font()
            prior_score = scorer(prior_font)
        except Exception:
            pass

    # Full search — use median char height for size estimation so that
    # multi-line OCR blocks don't inflate the search range.
    from unredact.pipeline.font_debug import debug_enabled, get_debug_ctx, next_line_idx, save_line_debug
    top_n = 5 if debug_enabled() else 1
    char_heights = [c.h for c in line.chars if c.text.strip()]
    estimated_h = int(np.median(char_heights)) if char_heights else line.h
    results = _full_search(estimated_h, scorer, top_n=top_n)
    if not results:
        if prior is not None:
            return prior
        raise RuntimeError("No matching font found. Check system fonts.")

    # Fine-tune the full search winner
    best = _fine_search(results[0], scorer)

    if debug_enabled():
        ctx = get_debug_ctx()
        if ctx is not None:
            save_line_debug(
                ctx["dir"], next_line_idx(), line_crop, results,
                {"type": "line", "line": scoring_line},
            )

    # If we have a prior and it's close enough, prefer it for consistency
    if prior is not None and prior_score >= best.score * (1.0 / PRIOR_BIAS):
        # Fine-tune the prior too
        return _fine_search(prior, scorer)

    return best


def detect_fonts(
    lines: list[OcrLine],
    page_image: Image.Image,
) -> list[FontMatch]:
    """Detect the best font for each line on a page.

    Processes lines top to bottom, using each line's result as the
    prior for the next line. This means the font tends to stay
    consistent unless a line is clearly different (e.g. bold header
    vs regular body text).
    """
    from unredact.pipeline.font_debug import debug_enabled, start_debug_session, end_debug_session
    if debug_enabled():
        start_debug_session()

    results: list[FontMatch] = []
    prior: FontMatch | None = None

    for line in lines:
        match = detect_font_for_line(line, page_image, prior=prior)
        results.append(match)
        prior = match

    if debug_enabled():
        end_debug_session()

    return results


# Keep the old API for backwards compatibility with tests
def detect_font(
    lines: list[OcrLine],
    page_image: Image.Image,
) -> FontMatch:
    """Detect a single best font for the page (legacy API).

    Uses the most common font detected across all lines.
    """
    if not lines:
        raise RuntimeError("No lines to detect font from.")
    font_matches = detect_fonts(lines, page_image)
    # Return the most common font (by name+size)
    from collections import Counter
    counts = Counter((m.font_name, m.font_size) for m in font_matches)
    best_key = counts.most_common(1)[0][0]
    for m in font_matches:
        if (m.font_name, m.font_size) == best_key:
            return m
    return font_matches[0]
