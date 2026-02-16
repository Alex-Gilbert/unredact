from pathlib import Path

from PIL import Image

from unredact.pipeline.font_detect import detect_font, FontMatch
from unredact.pipeline.ocr import ocr_page
from unredact.pipeline.rasterize import rasterize_pdf


def test_detect_font_returns_match(sample_pdf: Path):
    pages = rasterize_pdf(sample_pdf, first_page=1, last_page=1)
    lines = ocr_page(pages[0])
    match = detect_font(lines, pages[0])
    assert isinstance(match, FontMatch)
    assert match.font_path is not None
    assert match.font_size > 0
    assert match.score > 0


def test_detect_font_reasonable_size(sample_pdf: Path):
    """At 300 DPI, body text in a letter-size doc is typically 30-60px."""
    pages = rasterize_pdf(sample_pdf, first_page=1, last_page=1)
    lines = ocr_page(pages[0])
    match = detect_font(lines, pages[0])
    # At 300 DPI, 11pt text ~ 46px. Allow wide range.
    assert 20 < match.font_size < 80


def test_font_match_can_render(sample_pdf: Path):
    """The detected font should be usable for rendering."""
    pages = rasterize_pdf(sample_pdf, first_page=1, last_page=1)
    lines = ocr_page(pages[0])
    match = detect_font(lines, pages[0])
    font = match.to_pil_font()
    # Should be able to measure text with it
    bbox = font.getbbox("Hello")
    assert bbox is not None
    assert bbox[2] > 0  # width > 0
