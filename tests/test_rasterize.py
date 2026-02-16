from pathlib import Path

from PIL import Image

from unredact.pipeline.rasterize import rasterize_pdf


def test_rasterize_returns_list_of_images(sample_pdf: Path):
    pages = rasterize_pdf(sample_pdf)
    assert len(pages) == 2  # EFTA00554620.pdf has 2 pages
    assert all(isinstance(p, Image.Image) for p in pages)


def test_rasterize_high_dpi(sample_pdf: Path):
    pages = rasterize_pdf(sample_pdf, dpi=300)
    # At 300 DPI, a letter-size page is roughly 2550x3300
    w, h = pages[0].size
    assert w > 2000
    assert h > 3000


def test_rasterize_single_page(sample_pdf: Path):
    pages = rasterize_pdf(sample_pdf, first_page=1, last_page=1)
    assert len(pages) == 1
