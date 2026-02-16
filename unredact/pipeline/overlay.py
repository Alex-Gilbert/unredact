from PIL import Image, ImageDraw, ImageFont

from unredact.pipeline.font_detect import FontMatch
from unredact.pipeline.ocr import OcrLine


def render_overlay(
    page_image: Image.Image,
    lines: list[OcrLine],
    font_match: FontMatch,
    color: tuple[int, int, int, int] = (0, 200, 0, 160),
) -> Image.Image:
    """Render green text overlay on top of the document image.

    Draws each OCR'd line's text at its detected position using
    the matched font. The overlay is semi-transparent so the
    original document is still visible underneath.

    Args:
        page_image: The original rasterized page.
        lines: OCR'd lines with character positions.
        font_match: Detected font to use for rendering.
        color: RGBA color for the overlay text.

    Returns:
        A new RGBA image with the overlay composited on the original.
    """
    base = page_image.convert("RGBA")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = font_match.to_pil_font()

    for line in lines:
        if not line.chars:
            continue

        text = line.text
        # Position: use the first character's x and the line's y
        x = line.x
        y = line.y

        draw.text((x, y), text, font=font, fill=color)

    return Image.alpha_composite(base, overlay)
