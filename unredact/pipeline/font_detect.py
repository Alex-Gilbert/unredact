from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageFont

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

# Size range to search (in pixels at rendering DPI)
SIZE_RANGE = range(20, 80, 2)

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
    score: float  # lower is better (mean absolute error in px)

    def to_pil_font(self) -> ImageFont.FreeTypeFont:
        return ImageFont.truetype(str(self.font_path), self.font_size)


def _score_font_line(
    font: ImageFont.FreeTypeFont,
    line: OcrLine,
) -> float:
    """Score how well a font matches one line's OCR'd word widths.

    Returns mean absolute error in pixels between rendered and OCR'd
    word widths. Lower is better.
    """
    errors: list[float] = []
    word = ""
    word_start_x = -1
    word_end_x = -1

    for char in line.chars:
        if char.text == " ":
            if word and word_start_x >= 0:
                rendered_bbox = font.getbbox(word)
                rendered_w = rendered_bbox[2] - rendered_bbox[0]
                ocr_w = word_end_x - word_start_x
                if ocr_w > 0:
                    errors.append(abs(rendered_w - ocr_w))
            word = ""
            word_start_x = -1
        else:
            if word_start_x < 0:
                word_start_x = char.x
            word += char.text
            word_end_x = char.x + char.w

    # Last word in line
    if word and word_start_x >= 0:
        rendered_bbox = font.getbbox(word)
        rendered_w = rendered_bbox[2] - rendered_bbox[0]
        ocr_w = word_end_x - word_start_x
        if ocr_w > 0:
            errors.append(abs(rendered_w - ocr_w))

    if not errors:
        return float("inf")
    return sum(errors) / len(errors)


def _full_search(line: OcrLine) -> FontMatch | None:
    """Full search across all candidate fonts and sizes for one line."""
    best: FontMatch | None = None

    for font_name in CANDIDATE_FONTS:
        font_path = _find_font_path(font_name)
        if font_path is None:
            continue

        for size in SIZE_RANGE:
            try:
                font = ImageFont.truetype(str(font_path), size)
            except Exception:
                continue

            score = _score_font_line(font, line)

            if best is None or score < best.score:
                best = FontMatch(
                    font_name=font_name,
                    font_path=font_path,
                    font_size=size,
                    score=score,
                )

    return best


def _fine_search(line: OcrLine, coarse: FontMatch) -> FontMatch:
    """Fine search: ±3 around the coarse best size in steps of 1."""
    best = coarse
    for size in range(max(8, coarse.font_size - 3), coarse.font_size + 4):
        if size == coarse.font_size:
            continue
        try:
            font = ImageFont.truetype(str(coarse.font_path), size)
        except Exception:
            continue
        score = _score_font_line(font, line)
        if score < best.score:
            best = FontMatch(
                font_name=coarse.font_name,
                font_path=coarse.font_path,
                font_size=size,
                score=score,
            )
    return best


def detect_font_for_line(
    line: OcrLine,
    prior: FontMatch | None = None,
) -> FontMatch:
    """Detect the best font for a single line of text.

    If a prior is given (e.g. from the previous line), test it first.
    If it scores well enough (within PRIOR_BIAS of the best), keep it
    to maintain consistency. Only do a full search if the prior is
    significantly worse or absent.
    """
    # Lines with too few words can't be scored reliably
    word_count = line.text.count(" ") + 1
    if word_count < 2:
        if prior is not None:
            return prior
        # Fall through to full search

    # Test the prior first
    prior_score = float("inf")
    if prior is not None:
        try:
            prior_font = prior.to_pil_font()
            prior_score = _score_font_line(prior_font, line)
        except Exception:
            pass

    # Full search
    best = _full_search(line)
    if best is None:
        if prior is not None:
            return prior
        raise RuntimeError("No matching font found. Check system fonts.")

    # Fine-tune the full search winner
    best = _fine_search(line, best)

    # If we have a prior and it's close enough, prefer it for consistency
    if prior is not None and prior_score <= best.score * PRIOR_BIAS:
        # Fine-tune the prior too
        return _fine_search(line, prior)

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
        match = detect_font_for_line(line, prior=prior)
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
