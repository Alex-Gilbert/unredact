from PIL import Image, ImageDraw, ImageFont

from unredact.pipeline.font_detect import FontMatch
from unredact.pipeline.ocr import OcrLine


def render_overlay(
    page_image: Image.Image,
    lines: list[OcrLine],
    font_match: FontMatch | list[FontMatch],
    color: tuple[int, int, int, int] = (0, 200, 0, 160),
) -> Image.Image:
    """Render green text overlay on top of the document image.

    Each line is rendered as a single continuous string starting at
    the line's x position. The font's own character spacing determines
    where each subsequent character falls. If the font/size is correct,
    the rendered text will naturally align with every word on the line.
    Any drift reveals a font detection error.

    font_match can be:
    - A single FontMatch (used for all lines)
    - A list of FontMatch (one per line, for per-line font detection)

    Args:
        page_image: The original rasterized page.
        lines: OCR'd lines with character positions.
        font_match: Detected font(s) to use for rendering.
        color: RGBA color for the overlay text.

    Returns:
        A new RGBA image with the overlay composited on the original.
    """
    base = page_image.convert("RGBA")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # Normalize to per-line list
    if isinstance(font_match, list):
        fonts = font_match
    else:
        fonts = [font_match] * len(lines)

    for line, fm in zip(lines, fonts):
        if not line.chars:
            continue

        font = fm.to_pil_font()
        draw.text((line.x, line.y), line.text, font=font, fill=color)

    return Image.alpha_composite(base, overlay)
