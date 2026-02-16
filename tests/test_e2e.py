from pathlib import Path

from PIL import Image

from unredact.pipeline.rasterize import rasterize_pdf
from unredact.pipeline.ocr import ocr_page
from unredact.pipeline.font_detect import detect_font
from unredact.pipeline.overlay import render_overlay


def test_full_pipeline_produces_overlay(sample_pdf: Path):
    """Run the full pipeline and save output for visual inspection."""
    pages = rasterize_pdf(sample_pdf)
    output_dir = Path("/tmp/unredact_test_output")
    output_dir.mkdir(exist_ok=True)

    for i, page in enumerate(pages, start=1):
        lines = ocr_page(page)
        font_match = detect_font(lines, page)
        overlay = render_overlay(page, lines, font_match)

        # Save for visual inspection
        overlay.convert("RGB").save(output_dir / f"page_{i}_overlay.png")
        page.save(output_dir / f"page_{i}_original.png")

        print(f"Page {i}: font={font_match.font_name} "
              f"size={font_match.font_size}px "
              f"score={font_match.score:.1f} "
              f"lines={len(lines)}")

    print(f"\nSaved to {output_dir}/ — open the overlay PNGs to visually check alignment.")
