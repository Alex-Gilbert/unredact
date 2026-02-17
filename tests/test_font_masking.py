"""Test that detect_font_masked correctly identifies fonts even with redaction boxes."""
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from unredact.pipeline.font_detect import (
    _find_font_path,
    detect_font_masked,
)
from unredact.pipeline.ocr import OcrChar, OcrLine


def _render_page_with_redaction(
    font_name: str,
    font_size: int,
    text: str,
    redaction_frac: tuple[float, float] = (0.4, 0.7),
) -> tuple[OcrLine, Image.Image, list[tuple[int, int, int, int]]]:
    """Render text onto a page image with a black redaction box.

    Returns (OcrLine, page_image, redaction_boxes) where redaction_boxes
    are (rx, ry, rw, rh) in page-relative coordinates.

    The OcrLine bounding box is set to tightly wrap the rendered text
    (mimicking what OCR would produce), so detect_font_masked can create
    a scoring_line with x=0, y=0 that aligns correctly.
    """
    font_path = _find_font_path(font_name)
    assert font_path is not None, f"Font {font_name} not found on system"
    font = ImageFont.truetype(str(font_path), font_size)

    # Measure the text
    bbox = font.getbbox(text)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]

    # Place the line at an offset on a larger "page" image.
    # The line bounding box starts exactly where the text ink begins,
    # matching what OCR would detect.
    page_margin_x = 50
    page_margin_y = 80

    # Text is rendered at (render_x, render_y) such that ink starts at
    # (line_x, line_y) in page coordinates.
    line_x = page_margin_x
    line_y = page_margin_y
    render_x = line_x - bbox[0]
    render_y = line_y - bbox[1]
    line_w = text_w
    line_h = text_h

    page_w = line_x + line_w + 50
    page_h = line_y + line_h + 100

    # Render the text onto the page
    page_img = Image.new("L", (page_w, page_h), 255)
    draw = ImageDraw.Draw(page_img)
    draw.text((render_x, render_y), text, font=font, fill=0)

    # Build an OcrLine with approximate character positions (page-relative)
    words = text.split()
    chars: list[OcrChar] = []
    cursor_x = line_x
    for wi, word in enumerate(words):
        word_bbox = font.getbbox(word)
        word_w = word_bbox[2] - word_bbox[0]
        char_w = word_w / len(word)
        for ci, ch in enumerate(word):
            chars.append(OcrChar(
                text=ch,
                x=int(cursor_x + ci * char_w),
                y=line_y,
                w=max(1, int(char_w)),
                h=text_h,
                conf=95.0,
            ))
        cursor_x += word_w
        if wi < len(words) - 1:
            space_w = font.getlength(" ")
            chars.append(OcrChar(
                text=" ",
                x=int(cursor_x),
                y=line_y,
                w=max(1, int(space_w)),
                h=text_h,
                conf=95.0,
            ))
            cursor_x += space_w

    line = OcrLine(
        chars=chars,
        x=line_x,
        y=line_y,
        w=line_w,
        h=line_h,
    )

    # Draw a black redaction box covering a fraction of the line
    redact_x = line_x + int(line_w * redaction_frac[0])
    redact_y = line_y
    redact_w = int(line_w * (redaction_frac[1] - redaction_frac[0]))
    redact_h = line_h
    draw.rectangle(
        [redact_x, redact_y, redact_x + redact_w, redact_y + redact_h],
        fill=0,
    )

    redaction_boxes = [(redact_x, redact_y, redact_w, redact_h)]

    # Convert to RGB page image (detect_font_masked expects PIL Image)
    page_rgb = page_img.convert("RGB")
    return line, page_rgb, redaction_boxes


def test_masked_detection_finds_correct_font():
    """Render TNR@50, add a black redaction box, and verify detection still finds TNR."""
    text = "On Aug 27 2012 at 12:52 PM wrote ot"
    line, page_img, redaction_boxes = _render_page_with_redaction(
        font_name="Times New Roman",
        font_size=50,
        text=text,
    )

    result = detect_font_masked(line, page_img, redaction_boxes)

    assert "Times" in result.font_name or "Liberation Serif" in result.font_name, (
        f"Expected serif font, got {result.font_name}"
    )
    assert 47 <= result.font_size <= 53, (
        f"Expected size ~50, got {result.font_size}"
    )
    assert result.score > 0.3, (
        f"Expected reasonable score, got {result.score:.3f}"
    )


def test_masked_detection_not_confused_by_redaction():
    """Render Arial@40, add a black redaction box, and verify it finds Arial."""
    text = "On Aug 27 2012 at 12:52 PM wrote ot"
    line, page_img, redaction_boxes = _render_page_with_redaction(
        font_name="Arial",
        font_size=40,
        text=text,
    )

    result = detect_font_masked(line, page_img, redaction_boxes)

    assert "Arial" in result.font_name or "Liberation Sans" in result.font_name, (
        f"Expected sans-serif font, got {result.font_name}"
    )
    assert 37 <= result.font_size <= 43, (
        f"Expected size ~40, got {result.font_size}"
    )
    assert result.score > 0.3, (
        f"Expected reasonable score, got {result.score:.3f}"
    )
