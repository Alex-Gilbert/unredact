from dataclasses import dataclass
from pathlib import Path

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

# Size range to search (in pixels at rendering DPI)
SIZE_RANGE = range(20, 80, 2)


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


def _score_font(
    font: ImageFont.FreeTypeFont,
    lines: list[OcrLine],
) -> float:
    """Score how well a font matches the OCR'd character widths.

    Returns mean absolute error in pixels between rendered and OCR'd word widths.
    Lower is better.
    """
    errors: list[float] = []

    for line in lines:
        # Reconstruct words from chars
        word = ""
        word_start_x = -1
        word_end_x = -1

        for char in line.chars:
            if char.text == " ":
                if word and word_start_x >= 0:
                    # Measure this word
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


def detect_font(
    lines: list[OcrLine],
    page_image: Image.Image,
) -> FontMatch:
    """Detect the best matching font and size for OCR'd text.

    Tries all candidate fonts at all sizes in SIZE_RANGE and returns
    the combination with the lowest mean word-width error.
    """
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

            score = _score_font(font, lines)

            if best is None or score < best.score:
                best = FontMatch(
                    font_name=font_name,
                    font_path=font_path,
                    font_size=size,
                    score=score,
                )

    if best is None:
        raise RuntimeError("No matching font found. Check system fonts.")

    return best
