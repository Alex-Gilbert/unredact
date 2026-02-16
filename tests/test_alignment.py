from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation

from unredact.pipeline.rasterize import rasterize_pdf
from unredact.pipeline.ocr import ocr_page
from unredact.pipeline.font_detect import detect_font
from unredact.pipeline.overlay import render_overlay


def test_overlay_alignment_score(sample_pdf: Path):
    """Measure how well the overlay aligns with the original text.

    Strategy: compare the overlay-only green pixels against the original
    dark text pixels. Where they overlap (within a few pixels tolerance),
    that's a hit. We want a reasonable hit rate.
    """
    pages = rasterize_pdf(sample_pdf, first_page=1, last_page=1)
    page = pages[0]
    lines = ocr_page(page)
    font_match = detect_font(lines, page)
    overlay = render_overlay(page, lines, font_match)

    orig_arr = np.array(page.convert("L"))  # grayscale
    overlay_arr = np.array(overlay)

    # Original dark text pixels (< 128 on grayscale)
    text_mask = orig_arr < 128

    # Overlay green pixels (green channel > 100)
    green_mask = overlay_arr[:, :, 1] > 100

    # How many text pixels have green overlay nearby (within 3px tolerance)?
    green_dilated = binary_dilation(green_mask, iterations=3)

    overlap = text_mask & green_dilated
    if text_mask.sum() == 0:
        return

    hit_rate = overlap.sum() / text_mask.sum()
    print(f"\nAlignment hit rate: {hit_rate:.1%}")
    print(f"  Text pixels: {text_mask.sum()}")
    print(f"  Green pixels: {green_mask.sum()}")
    print(f"  Overlap pixels: {overlap.sum()}")

    # We want at least 30% of text pixels to have overlay nearby
    # (not 100% because redaction boxes are dark too, and headers/footers
    # may use different fonts)
    assert hit_rate > 0.3, f"Overlay alignment too low: {hit_rate:.1%}"
