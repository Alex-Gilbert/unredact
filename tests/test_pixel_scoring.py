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
