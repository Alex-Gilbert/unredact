"""Tests for the page analysis pipeline (analyze_page)."""

from pathlib import Path
from unittest.mock import AsyncMock, patch

import numpy as np
import pytest
from PIL import Image

from unredact.pipeline.ocr import OcrChar, OcrLine
from unredact.pipeline.llm_detect import LlmRedaction
from unredact.pipeline.detect_redactions import Redaction
from unredact.pipeline.font_detect import FontMatch
from unredact.pipeline.analyze_page import (
    RedactionAnalysis,
    PageAnalysis,
    analyze_page,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_char(ch: str, x: int, w: int = 10, y: int = 100, h: int = 20) -> OcrChar:
    return OcrChar(text=ch, x=x, y=y, w=w, h=h, conf=95.0)


def _make_line_from_words(
    words: list[str],
    start_x: int = 50,
    char_w: int = 10,
    space_w: int = 8,
    y: int = 100,
    h: int = 20,
) -> OcrLine:
    """Build an OcrLine from a list of words with evenly-spaced characters."""
    chars: list[OcrChar] = []
    x = start_x
    for wi, word in enumerate(words):
        for ch in word:
            chars.append(_make_char(ch, x, w=char_w, y=y, h=h))
            x += char_w
        if wi < len(words) - 1:
            chars.append(_make_char(" ", x, w=space_w, y=y, h=h))
            x += space_w
    line_x = chars[0].x
    line_w = (chars[-1].x + chars[-1].w) - line_x
    return OcrLine(chars=chars, x=line_x, y=y, w=line_w, h=h)


def _dummy_page_image(width: int = 800, height: int = 600) -> Image.Image:
    """Create a white test image."""
    return Image.new("RGB", (width, height), "white")


def _dummy_font_match() -> FontMatch:
    from unredact.pipeline.font_detect import _find_font_path

    font_path = _find_font_path("Times New Roman")
    if font_path is None:
        font_path = _find_font_path("serif")
    if font_path is None:
        font_path = Path("/usr/share/fonts/TTF/Times.TTF")

    return FontMatch(
        font_name="Times New Roman",
        font_path=font_path,
        font_size=20,
        score=0.85,
    )


# ---------------------------------------------------------------------------
# test_analyze_page_returns_results
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_analyze_page_returns_results():
    """Mock LLM returning 1 redaction, OpenCV returning a box, font detection
    returning a FontMatch. Verify PageAnalysis has 1 RedactionAnalysis with
    correct fields."""
    line = _make_line_from_words(["Hello", "|||", "world"], y=100, h=20)
    lines = [line]

    llm_redaction = LlmRedaction(
        line_index=0,
        left_word="Hello",
        right_word="world",
        left_x=100,
        right_x=130,
        line_y=100,
        line_h=20,
    )

    redaction_box = Redaction(
        id="abc12345",
        x=100,
        y=98,
        w=30,
        h=22,
    )

    font_match = _dummy_font_match()
    page_image = _dummy_page_image()

    with (
        patch(
            "unredact.pipeline.analyze_page.ocr_page",
            return_value=lines,
        ),
        patch(
            "unredact.pipeline.analyze_page.detect_redactions_llm",
            new_callable=AsyncMock,
            return_value=[llm_redaction],
        ),
        patch(
            "unredact.pipeline.analyze_page.find_redaction_in_region",
            return_value=redaction_box,
        ),
        patch(
            "unredact.pipeline.analyze_page.detect_font_masked",
            return_value=font_match,
        ),
        patch(
            "unredact.pipeline.analyze_page.align_text_to_page",
            return_value=(3, -1),
        ),
    ):
        result = await analyze_page(page_image)

    assert isinstance(result, PageAnalysis)
    assert len(result.lines) == 1
    assert len(result.redactions) == 1

    ra = result.redactions[0]
    assert isinstance(ra, RedactionAnalysis)
    assert ra.box is redaction_box
    assert ra.line is line
    assert ra.font is font_match

    # left_text: chars whose center is left of box.x (100)
    # "Hello" chars: x=50..90 (centers at 55, 65, 75, 85, 95) — all < 100
    # Space char: x=100, center=104 — not < 100
    assert "Hello" in ra.left_text

    # right_text: chars whose center is right of box.x+box.w (130)
    # "world" starts after the space and |||
    assert "world" in ra.right_text


# ---------------------------------------------------------------------------
# test_analyze_page_no_redactions
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_analyze_page_no_redactions():
    """Mock LLM returning empty list. Verify PageAnalysis has empty redactions."""
    line = _make_line_from_words(["Clean", "text", "here"])
    lines = [line]
    page_image = _dummy_page_image()

    with (
        patch(
            "unredact.pipeline.analyze_page.ocr_page",
            return_value=lines,
        ),
        patch(
            "unredact.pipeline.analyze_page.detect_redactions_llm",
            new_callable=AsyncMock,
            return_value=[],
        ),
    ):
        result = await analyze_page(page_image)

    assert isinstance(result, PageAnalysis)
    assert len(result.lines) == 1
    assert result.redactions == []


# ---------------------------------------------------------------------------
# test_analyze_page_skips_unfound_boxes
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_analyze_page_skips_unfound_boxes():
    """Mock LLM returning 1 redaction but OpenCV returns None.
    Verify it's skipped gracefully."""
    line = _make_line_from_words(["The", "|||", "cat"])
    lines = [line]

    llm_redaction = LlmRedaction(
        line_index=0,
        left_word="The",
        right_word="cat",
        left_x=80,
        right_x=110,
        line_y=100,
        line_h=20,
    )

    page_image = _dummy_page_image()

    with (
        patch(
            "unredact.pipeline.analyze_page.ocr_page",
            return_value=lines,
        ),
        patch(
            "unredact.pipeline.analyze_page.detect_redactions_llm",
            new_callable=AsyncMock,
            return_value=[llm_redaction],
        ),
        patch(
            "unredact.pipeline.analyze_page.find_redaction_in_region",
            return_value=None,
        ),
    ):
        result = await analyze_page(page_image)

    assert isinstance(result, PageAnalysis)
    assert len(result.lines) == 1
    assert result.redactions == []


# ---------------------------------------------------------------------------
# test_analyze_page_progress_callback
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_analyze_page_progress_callback():
    """Verify that on_progress is called at each stage."""
    line = _make_line_from_words(["Hello", "world"])
    lines = [line]
    page_image = _dummy_page_image()

    progress_events: list[tuple] = []

    def on_progress(event: str, data: dict):
        progress_events.append((event, data))

    with (
        patch(
            "unredact.pipeline.analyze_page.ocr_page",
            return_value=lines,
        ),
        patch(
            "unredact.pipeline.analyze_page.detect_redactions_llm",
            new_callable=AsyncMock,
            return_value=[],
        ),
    ):
        await analyze_page(page_image, on_progress=on_progress)

    event_names = [e[0] for e in progress_events]
    assert "ocr_done" in event_names
    assert "redactions_found" in event_names
    assert "analysis_complete" in event_names


# ---------------------------------------------------------------------------
# test_analyze_page_font_caching
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_analyze_page_font_caching():
    """Two redactions on the same line should call detect_font_masked only once
    for that line (font caching)."""
    line = _make_line_from_words(
        ["A", "XXX", "B", "YYY", "C"], start_x=50, y=100, h=20,
    )
    lines = [line]

    llm_red_1 = LlmRedaction(
        line_index=0, left_word="A", right_word="B",
        left_x=60, right_x=80, line_y=100, line_h=20,
    )
    llm_red_2 = LlmRedaction(
        line_index=0, left_word="B", right_word="C",
        left_x=90, right_x=110, line_y=100, line_h=20,
    )

    box1 = Redaction(id="b1", x=60, y=98, w=20, h=22)
    box2 = Redaction(id="b2", x=90, y=98, w=20, h=22)

    font_match = _dummy_font_match()
    page_image = _dummy_page_image()

    mock_font_detect = patch(
        "unredact.pipeline.analyze_page.detect_font_masked",
        return_value=font_match,
    )
    with (
        patch("unredact.pipeline.analyze_page.ocr_page", return_value=lines),
        patch(
            "unredact.pipeline.analyze_page.detect_redactions_llm",
            new_callable=AsyncMock,
            return_value=[llm_red_1, llm_red_2],
        ),
        patch(
            "unredact.pipeline.analyze_page.find_redaction_in_region",
            side_effect=[box1, box2],
        ),
        mock_font_detect as mock_fd,
        patch(
            "unredact.pipeline.analyze_page.align_text_to_page",
            return_value=(0, 0),
        ),
    ):
        result = await analyze_page(page_image)

    assert len(result.redactions) == 2
    # Font detection should have been called only once for line 0
    assert mock_fd.call_count == 1
    # But both redactions should share the same font
    assert result.redactions[0].font is font_match
    assert result.redactions[1].font is font_match


# ---------------------------------------------------------------------------
# test_analyze_page_uses_precomputed_ocr_lines
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_analyze_page_uses_precomputed_ocr_lines():
    """When ocr_lines is provided, analyze_page should use them directly
    without calling ocr_page.  The returned lines must be the same object."""
    line = _make_line_from_words(["Hello", "world"])
    precomputed_lines = [line]
    page_image = _dummy_page_image()

    mock_ocr = patch(
        "unredact.pipeline.analyze_page.ocr_page",
        return_value=[],  # should never be called
    )

    with (
        mock_ocr as m_ocr,
        patch(
            "unredact.pipeline.analyze_page.detect_redactions_llm",
            new_callable=AsyncMock,
            return_value=[],
        ),
    ):
        result = await analyze_page(page_image, ocr_lines=precomputed_lines)

    # ocr_page must not have been called
    m_ocr.assert_not_called()
    # The returned lines must be the exact same object (not a copy)
    assert result.lines is precomputed_lines
