"""Font detection tests using real document data.

Uses captured OCR + LLM fixtures from EFTA00554620.pdf to verify that
font detection returns Times New Roman (or Liberation Serif) at ~50px
for the body text.
"""

import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from unredact.pipeline.font_detect import (
    detect_font_for_line,
    detect_font_masked,
    _find_font_path,
)
from unredact.pipeline.ocr import OcrChar, OcrLine

FIXTURES = Path(__file__).parent / "fixtures"
PAGE1_JSON = FIXTURES / "EFTA00554620_page1.json"
PAGE1_PNG = FIXTURES / "EFTA00554620_page1.png"


def _load_fixture():
    """Load OCR lines from the JSON fixture as OcrLine objects."""
    data = json.loads(PAGE1_JSON.read_text())
    lines = []
    for ld in data["ocr_lines"]:
        chars = [
            OcrChar(text=c["text"], x=c["x"], y=c["y"], w=c["w"], h=c["h"], conf=c["conf"])
            for c in ld["chars"]
        ]
        lines.append(OcrLine(chars=chars, x=ld["x"], y=ld["y"], w=ld["w"], h=ld["h"]))
    return data, lines


def _load_page_image():
    return Image.open(PAGE1_PNG)


def _is_serif(name: str) -> bool:
    """Check if the font name is a serif font."""
    return any(s in name for s in ("Times", "Liberation Serif", "Georgia", "DejaVu Serif"))


# Skip all tests if fixtures missing
pytestmark = pytest.mark.skipif(
    not PAGE1_JSON.exists() or not PAGE1_PNG.exists(),
    reason="Real document fixtures not available",
)


class TestCleanLines:
    """Font detection on lines without redactions."""

    def test_date_line(self):
        """Line 3: 'Date: Mon, 27 Aug 2012 18:57:08 +0000'"""
        data, lines = _load_fixture()
        page_img = _load_page_image()
        line = lines[3]
        result = detect_font_for_line(line, page_img)
        assert _is_serif(result.font_name), f"Expected serif, got {result.font_name}"
        assert 45 <= result.font_size <= 55, f"Expected ~50px, got {result.font_size}"

    def test_body_text_line(self):
        """Line 10: 'I need to know if he's out of jerky...'"""
        data, lines = _load_fixture()
        page_img = _load_page_image()
        line = lines[10]
        result = detect_font_for_line(line, page_img)
        assert _is_serif(result.font_name), f"Expected serif, got {result.font_name}"
        assert 45 <= result.font_size <= 55, f"Expected ~50px, got {result.font_size}"

    def test_short_clean_line(self):
        """Line 5: 'through it like crazy'"""
        data, lines = _load_fixture()
        page_img = _load_page_image()
        line = lines[5]
        result = detect_font_for_line(line, page_img)
        assert _is_serif(result.font_name), f"Expected serif, got {result.font_name}"
        assert 45 <= result.font_size <= 55, f"Expected ~50px, got {result.font_size}"


class TestMaskedLines:
    """Font detection on lines with redactions, using LLM output."""

    def _get_redaction_boxes_for_line(self, data, line_index):
        """Get approximate redaction boxes from LLM output for a given line."""
        boxes = []
        for r in data["llm_redactions"]:
            if r["line_index"] == line_index:
                line_data = data["ocr_lines"][line_index]
                # Use LLM's x range as the redaction box
                x = r["left_x"]
                w = r["right_x"] - r["left_x"]
                y = line_data["y"]
                h = line_data["h"]
                if w > 0:
                    boxes.append((x, y, w, h))
        return boxes

    def test_got_it_sent_line(self):
        """Line 7: 'Got it. Sent[ an email.' — the screenshot case."""
        data, lines = _load_fixture()
        page_img = _load_page_image()
        line = lines[7]
        boxes = self._get_redaction_boxes_for_line(data, 7)
        assert len(boxes) > 0, "Expected redaction boxes for line 7"
        result = detect_font_masked(line, page_img, boxes)
        assert _is_serif(result.font_name), f"Expected serif, got {result.font_name}"
        assert 45 <= result.font_size <= 55, f"Expected ~50px, got {result.font_size}"

    def test_from_line_with_redaction(self):
        """Line 0: 'From: |-' — redacted email address."""
        data, lines = _load_fixture()
        page_img = _load_page_image()
        line = lines[0]
        boxes = self._get_redaction_boxes_for_line(data, 0)
        assert len(boxes) > 0, "Expected redaction boxes for line 0"
        result = detect_font_masked(line, page_img, boxes)
        assert _is_serif(result.font_name), f"Expected serif, got {result.font_name}"
        assert 45 <= result.font_size <= 55, f"Expected ~50px, got {result.font_size}"

    def test_on_aug_line(self):
        """Line 6: 'On Aug 27, 2012, at 2:02 PM, — wrote:' — redacted name."""
        data, lines = _load_fixture()
        page_img = _load_page_image()
        line = lines[6]
        boxes = self._get_redaction_boxes_for_line(data, 6)
        assert len(boxes) > 0, "Expected redaction boxes for line 6"
        result = detect_font_masked(line, page_img, boxes)
        assert _is_serif(result.font_name), f"Expected serif, got {result.font_name}"
        assert 45 <= result.font_size <= 55, f"Expected ~50px, got {result.font_size}"

    def test_let_or_know_line(self):
        """Line 19: multiple redactions — 'let ]l or ] know what to do...'"""
        data, lines = _load_fixture()
        page_img = _load_page_image()
        line = lines[19]
        boxes = self._get_redaction_boxes_for_line(data, 19)
        assert len(boxes) >= 2, f"Expected multiple redaction boxes, got {len(boxes)}"
        result = detect_font_masked(line, page_img, boxes)
        assert _is_serif(result.font_name), f"Expected serif, got {result.font_name}"
        assert 45 <= result.font_size <= 55, f"Expected ~50px, got {result.font_size}"
