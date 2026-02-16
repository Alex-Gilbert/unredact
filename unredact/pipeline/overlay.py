from PIL import Image, ImageDraw, ImageFont

from unredact.pipeline.font_detect import FontMatch
from unredact.pipeline.ocr import OcrChar, OcrLine


def _extract_words(line: OcrLine) -> list[tuple[str, int, int]]:
    """Extract words from an OcrLine with their x,y positions.

    Returns list of (word_text, x, y) tuples.
    """
    words: list[tuple[str, int, int]] = []
    current_word = ""
    word_x = -1
    word_y = -1

    for char in line.chars:
        if char.text == " ":
            if current_word:
                words.append((current_word, word_x, word_y))
                current_word = ""
                word_x = -1
        else:
            if not current_word:
                word_x = char.x
                word_y = char.y
            current_word += char.text

    if current_word:
        words.append((current_word, word_x, word_y))

    return words


def render_overlay(
    page_image: Image.Image,
    lines: list[OcrLine],
    font_match: FontMatch,
    color: tuple[int, int, int, int] = (0, 200, 0, 160),
) -> Image.Image:
    """Render green text overlay on top of the document image.

    Draws each OCR'd word at its detected position using the matched font.
    Words are rendered individually at their OCR'd x positions so that
    word spacing matches the original document exactly. Only the internal
    character spacing within each word depends on the font metrics.

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

    # Compute y-offset: Pillow draws from the top of the glyph bbox,
    # but OCR y is the top of the word bounding box. We need to align these.
    glyph_top = font.getbbox("Ag")[1]  # typically negative or 0

    for line in lines:
        if not line.chars:
            continue

        words = _extract_words(line)
        for word_text, wx, wy in words:
            # Adjust y by subtracting the glyph top offset
            draw.text((wx, wy - glyph_top), word_text, font=font, fill=color)

    return Image.alpha_composite(base, overlay)
