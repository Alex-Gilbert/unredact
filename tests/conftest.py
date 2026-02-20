from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def sample_pdf() -> Path:
    """Path to the sample Epstein PDF for testing."""
    pdf = Path("/home/alex/Documents/EFTA00554620.pdf")
    if not pdf.exists():
        pytest.skip("Sample PDF not available")
    return pdf


@pytest.fixture
def sample_page_image(sample_pdf):
    """Rasterize the first page of the sample PDF as a PIL Image."""
    from unredact.pipeline.rasterize import rasterize_pdf
    pages = rasterize_pdf(sample_pdf)
    return pages[0]
