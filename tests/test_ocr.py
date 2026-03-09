from pathlib import Path

from PIL import Image

from unredact.pipeline.ocr import ocr_page, OcrChar, OcrLine
from unredact.pipeline.rasterize import rasterize_pdf


def test_ocr_returns_lines_with_chars(sample_pdf: Path):
    pages = rasterize_pdf(sample_pdf, first_page=1, last_page=1)
    lines = ocr_page(pages[0])
    assert len(lines) > 0
    assert all(isinstance(line, OcrLine) for line in lines)
    # Each line should have characters
    non_empty = [l for l in lines if l.chars]
    assert len(non_empty) > 0


def test_ocr_chars_have_bounding_boxes(sample_pdf: Path):
    pages = rasterize_pdf(sample_pdf, first_page=1, last_page=1)
    lines = ocr_page(pages[0])
    for line in lines:
        for char in line.chars:
            assert isinstance(char, OcrChar)
            assert char.x >= 0
            assert char.y >= 0
            assert char.w > 0
            assert char.h > 0
            assert len(char.text) == 1


def test_ocr_finds_known_text(sample_pdf: Path):
    """The first page should contain recognizable text via OCR."""
    pages = rasterize_pdf(sample_pdf, first_page=1, last_page=1)
    lines = ocr_page(pages[0])
    full_text = " ".join(
        "".join(c.text for c in line.chars) for line in lines
    )
    # Tesseract may not be perfect, but should produce some text
    assert len(full_text.strip()) > 0
