from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from unredact.pipeline.ocr import OcrLine

# Candidate fonts to test (common document fonts available on the system)
CANDIDATE_FONTS: list[str] = [
    "Times New Roman",
    "Arial",
    "Courier New",
    "Georgia",
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



def _full_search(line: OcrLine, line_crop: np.ndarray) -> FontMatch | None:
    """Full search across all candidate fonts and sizes for one line."""
    best: FontMatch | None = None

    # Constrain size range using the OCR line height.
    # Pixel scoring has sharp peaks at the exact size, so we scan
    # every integer size (step=1) instead of using a coarse step.
    line_h = line.h
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

            score = _score_font_line_pixel(font, line, line_crop)

            if best is None or score > best.score:
                best = FontMatch(
                    font_name=font_name,
                    font_path=font_path,
                    font_size=size,
                    score=score,
                )

    return best


def _fine_search(line: OcrLine, line_crop: np.ndarray, coarse: FontMatch) -> FontMatch:
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
            prior_score = _score_font_line_pixel(prior_font, scoring_line, line_crop)
        except Exception:
            pass

    # Full search
    best = _full_search(scoring_line, line_crop)
    if best is None:
        if prior is not None:
            return prior
        raise RuntimeError("No matching font found. Check system fonts.")

    # Fine-tune the full search winner
    best = _fine_search(scoring_line, line_crop, best)

    # If we have a prior and it's close enough, prefer it for consistency
    if prior is not None and prior_score >= best.score * (1.0 / PRIOR_BIAS):
        # Fine-tune the prior too
        return _fine_search(scoring_line, line_crop, prior)

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
    results: list[FontMatch] = []
    prior: FontMatch | None = None

    for line in lines:
        match = detect_font_for_line(line, page_image, prior=prior)
        results.append(match)
        prior = match

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
