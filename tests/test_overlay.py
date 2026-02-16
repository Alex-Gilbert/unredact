from pathlib import Path

import numpy as np
from PIL import Image

from unredact.pipeline.overlay import render_overlay
from unredact.pipeline.ocr import ocr_page
from unredact.pipeline.font_detect import detect_font
from unredact.pipeline.rasterize import rasterize_pdf


def test_overlay_same_size_as_original(sample_pdf: Path):
    pages = rasterize_pdf(sample_pdf, first_page=1, last_page=1)
    lines = ocr_page(pages[0])
    font_match = detect_font(lines, pages[0])
    result = render_overlay(pages[0], lines, font_match)
    assert result.size == pages[0].size


def test_overlay_has_green_pixels(sample_pdf: Path):
    pages = rasterize_pdf(sample_pdf, first_page=1, last_page=1)
    lines = ocr_page(pages[0])
    font_match = detect_font(lines, pages[0])
    result = render_overlay(pages[0], lines, font_match)
    # Convert to numpy and check for green-ish pixels
    arr = np.array(result)
    # Green channel significantly higher than red and blue
    green_mask = (arr[:, :, 1] > 100) & (arr[:, :, 0] < 100) & (arr[:, :, 2] < 100)
    green_pixel_count = green_mask.sum()
    assert green_pixel_count > 100, "Expected green text pixels in the overlay"


def test_overlay_preserves_original(sample_pdf: Path):
    """Overlay should be composited — original should still be visible."""
    pages = rasterize_pdf(sample_pdf, first_page=1, last_page=1)
    original = pages[0].copy()
    lines = ocr_page(pages[0])
    font_match = detect_font(lines, pages[0])
    result = render_overlay(pages[0], lines, font_match)
    # The result shouldn't be identical to the original (overlay adds green)
    assert list(result.getdata()) != list(original.getdata())
