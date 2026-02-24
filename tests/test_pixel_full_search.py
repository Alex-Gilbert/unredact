"""Test that full search with pixel scoring finds the correct font."""
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from unredact.pipeline.font_detect import _find_font_path, _full_search, _score_font_line_pixel
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

    scorer = lambda font: _score_font_line_pixel(font, line, crop)
    results = _full_search(line.h, scorer)
    assert results
    best = results[0]
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

    scorer = lambda font: _score_font_line_pixel(font, line, crop)
    results = _full_search(line.h, scorer)
    assert results
    best = results[0]
    assert "Arial" in best.font_name or "Liberation Sans" in best.font_name, (
        f"Expected sans-serif font, got {best.font_name}"
    )
    assert 41 <= best.font_size <= 47, (
        f"Expected size ~44, got {best.font_size}"
    )
