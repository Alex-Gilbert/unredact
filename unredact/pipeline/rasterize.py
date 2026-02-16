from pathlib import Path

from pdf2image import convert_from_path
from PIL import Image


def rasterize_pdf(
    pdf_path: Path,
    dpi: int = 300,
    first_page: int | None = None,
    last_page: int | None = None,
) -> list[Image.Image]:
    """Convert PDF pages to PIL images at the given DPI."""
    kwargs: dict = {"dpi": dpi}
    if first_page is not None:
        kwargs["first_page"] = first_page
    if last_page is not None:
        kwargs["last_page"] = last_page
    return convert_from_path(str(pdf_path), **kwargs)
