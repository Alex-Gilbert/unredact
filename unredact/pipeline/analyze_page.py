"""Page analysis pipeline: OCR -> LLM -> guided OpenCV -> font detection.

Orchestrates the full per-page pipeline, wiring together OCR, LLM-based
redaction detection, guided OpenCV search, and font detection with masking.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

import numpy as np
from PIL import Image

from unredact.pipeline.ocr import ocr_page, OcrLine
from unredact.pipeline.llm_detect import detect_redactions_llm, LlmRedaction
from unredact.pipeline.detect_redactions import find_redaction_in_region, Redaction
from unredact.pipeline.font_detect import detect_font_masked, align_text_to_page, FontMatch

log = logging.getLogger(__name__)


@dataclass
class RedactionAnalysis:
    """Analysis result for a single redaction on a page."""

    box: Redaction       # Pixel-precise bounding box
    line: OcrLine        # The OCR line containing this redaction
    font: FontMatch      # Detected font for this line
    left_text: str       # Clean text to the left of redaction
    right_text: str      # Clean text to the right of redaction
    offset_x: float      # Pixel alignment offset X
    offset_y: float      # Pixel alignment offset Y


@dataclass
class PageAnalysis:
    """Full analysis result for a single page."""

    lines: list[OcrLine]                   # All OCR lines on the page
    redactions: list[RedactionAnalysis]    # Analysis for each redaction


async def analyze_page(
    page_image: Image.Image,
    on_progress: callable | None = None,
) -> PageAnalysis:
    """Run the full per-page analysis pipeline.

    Pipeline steps:
    1. OCR the page image (blocking, run in thread)
    2. LLM detection of redactions (async)
    3. For each LLM redaction:
       a. Guided OpenCV search for the precise box
       b. Font detection with redaction masking (cached per line)
       c. Extract left/right text segments around the redaction
       d. Pixel alignment of rendered text to page

    Args:
        page_image: PIL Image of the document page.
        on_progress: Optional callback ``(event_name, data_dict)`` for
            progress reporting.

    Returns:
        PageAnalysis with OCR lines and redaction analysis results.
    """
    # Step 1: OCR (blocking — run in thread)
    lines: list[OcrLine] = await asyncio.to_thread(ocr_page, page_image)

    if on_progress:
        on_progress("ocr_done", {"line_count": len(lines)})

    # Step 2: LLM detection (async)
    llm_redactions: list[LlmRedaction] = await detect_redactions_llm(lines)

    if on_progress:
        on_progress("redactions_found", {"count": len(llm_redactions)})

    # Step 3: Process each LLM redaction
    # Group LLM redactions by line index so we can collect all boxes per line
    # before calling font detection (which needs all boxes for masking).
    line_llm_reds: dict[int, list[LlmRedaction]] = {}
    for llm_red in llm_redactions:
        line_llm_reds.setdefault(llm_red.line_index, []).append(llm_red)

    # 3a: Guided OpenCV for each LLM redaction — build mapping from
    #     LlmRedaction to Redaction box (or None if not found).
    llm_to_box: dict[int, Redaction | None] = {}
    for i, llm_red in enumerate(llm_redactions):
        box = await asyncio.to_thread(
            find_redaction_in_region,
            page_image,
            llm_red.left_x,
            llm_red.line_y,
            llm_red.right_x,
            llm_red.line_y + llm_red.line_h,
        )
        llm_to_box[i] = box

    # 3b: Font detection with caching per line index.
    #     Pass ALL redaction boxes on the line for masking.
    line_fonts: dict[int, FontMatch] = {}

    for line_idx, reds_on_line in line_llm_reds.items():
        # Collect all successfully found boxes on this line
        redaction_boxes: list[tuple[int, int, int, int]] = []
        for llm_red in reds_on_line:
            idx_in_all = llm_redactions.index(llm_red)
            box = llm_to_box[idx_in_all]
            if box is not None:
                redaction_boxes.append((box.x, box.y, box.w, box.h))

        # Only detect font if we have at least one valid box on this line
        if not redaction_boxes:
            continue

        if 0 <= line_idx < len(lines):
            line = lines[line_idx]
            font = await asyncio.to_thread(
                detect_font_masked, line, page_image, redaction_boxes,
            )
            line_fonts[line_idx] = font

    # 3c-3e: Build RedactionAnalysis objects
    results: list[RedactionAnalysis] = []
    for i, llm_red in enumerate(llm_redactions):
        box = llm_to_box[i]
        if box is None:
            log.info(
                "OpenCV found no box for LLM redaction on line %d, skipping",
                llm_red.line_index,
            )
            continue

        if llm_red.line_index < 0 or llm_red.line_index >= len(lines):
            log.warning("Invalid line_index %d, skipping", llm_red.line_index)
            continue

        line = lines[llm_red.line_index]
        font = line_fonts.get(llm_red.line_index)
        if font is None:
            log.warning(
                "No font detected for line %d, skipping", llm_red.line_index,
            )
            continue

        # 3d: Extract left/right text using center-point char filtering
        left_chars = [
            c for c in line.chars if c.x + c.w / 2 < box.x
        ]
        right_chars = [
            c for c in line.chars if c.x + c.w / 2 > box.x + box.w
        ]
        left_text = "".join(c.text for c in left_chars).strip()
        right_text = "".join(c.text for c in right_chars).strip()

        # 3e: Pixel alignment
        offset_x = 0.0
        offset_y = 0.0

        if left_text:
            pil_font = font.to_pil_font()
            text_region_x1 = max(0, line.x - 20)
            text_region_x2 = min(page_image.width, box.x + 20)
            text_region_y1 = max(0, line.y - 10)
            text_region_y2 = min(page_image.height, line.y + line.h + 10)
            text_crop = np.array(page_image.convert("L").crop(
                (text_region_x1, text_region_y1, text_region_x2, text_region_y2)
            ))
            align_dx, align_dy = align_text_to_page(
                left_text, pil_font, text_crop,
            )
            offset_x = float(text_region_x1 + align_dx - line.x)
            offset_y = float(text_region_y1 + align_dy - line.y)

        results.append(
            RedactionAnalysis(
                box=box,
                line=line,
                font=font,
                left_text=left_text,
                right_text=right_text,
                offset_x=offset_x,
                offset_y=offset_y,
            )
        )

    if on_progress:
        on_progress("analysis_complete", {"count": len(results)})

    return PageAnalysis(lines=lines, redactions=results)
