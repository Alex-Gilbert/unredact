"""Pipeline tests against hand-annotated ground truth.

Uses EFTA00554620 page 1 ground truth (header lines excluded).
Validates that the pipeline produces correct bounding boxes, font
detection, and text segmentation for body-text redactions.
"""

import json
from pathlib import Path

import pytest
from PIL import Image

from unredact.pipeline.ocr import OcrChar, OcrLine
from unredact.pipeline.font_detect import detect_font_masked, _find_font_path
from unredact.pipeline.detect_redactions import find_redaction_in_region

FIXTURES = Path(__file__).parent / "fixtures"
GROUND_TRUTH = FIXTURES / "EFTA00554620_ground_truth.json"
PAGE1_JSON = FIXTURES / "EFTA00554620_page1.json"
PAGE1_PNG = FIXTURES / "EFTA00554620_page1.png"

pytestmark = pytest.mark.skipif(
    not all(p.exists() for p in [GROUND_TRUTH, PAGE1_JSON, PAGE1_PNG]),
    reason="Fixtures not available",
)


def _load_ground_truth_page1():
    data = json.loads(GROUND_TRUTH.read_text())
    return data["pages"]["1"]


def _load_ocr_lines():
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


class TestBoundingBoxes:
    """Verify that guided OpenCV finds boxes matching ground truth."""

    @pytest.fixture
    def page_img(self):
        return _load_page_image()

    @pytest.fixture
    def ground_truth(self):
        return _load_ground_truth_page1()

    @pytest.mark.parametrize("idx", range(6))
    def test_box_detection(self, page_img, ground_truth, idx):
        gt = ground_truth[idx]
        # Search in a generous region around the ground truth box
        pad = gt["h"]
        box = find_redaction_in_region(
            page_img,
            gt["x"], gt["y"],
            gt["x"] + gt["w"], gt["y"] + gt["h"],
            padding=pad,
        )
        assert box is not None, f"No box found for redaction at ({gt['x']}, {gt['y']})"
        # Box should be close to ground truth (within 15px on each edge)
        assert abs(box.x - gt["x"]) < 15, f"x off: {box.x} vs {gt['x']}"
        assert abs(box.y - gt["y"]) < 15, f"y off: {box.y} vs {gt['y']}"
        assert abs(box.w - gt["w"]) < 30, f"w off: {box.w} vs {gt['w']}"
        assert abs(box.h - gt["h"]) < 15, f"h off: {box.h} vs {gt['h']}"


class TestFontDetection:
    """Verify font detection matches ground truth on redacted lines."""

    @pytest.fixture
    def page_img(self):
        return _load_page_image()

    @pytest.fixture
    def ocr_data(self):
        return _load_ocr_lines()

    @pytest.fixture
    def ground_truth(self):
        return _load_ground_truth_page1()

    def _find_ocr_line_for_gt(self, lines, gt):
        """Find the OCR line that contains this ground truth redaction."""
        gy = gt["y"] + gt["h"] / 2
        for line in lines:
            if line.y <= gy <= line.y + line.h:
                return line
        return None

    @pytest.mark.parametrize("idx", range(6))
    def test_font_match(self, page_img, ocr_data, ground_truth, idx):
        gt = ground_truth[idx]
        expected_font = gt["overrides"]["fontId"]
        expected_size = gt["overrides"]["fontSize"]
        _, lines = ocr_data

        line = self._find_ocr_line_for_gt(lines, gt)
        assert line is not None, f"No OCR line found for redaction at y={gt['y']}"

        boxes = [(gt["x"], gt["y"], gt["w"], gt["h"])]
        result = detect_font_masked(line, page_img, boxes)

        # Font family should be serif (TNR or Liberation Serif)
        is_serif = any(s in result.font_name for s in ("Times", "Liberation Serif", "Georgia", "DejaVu Serif"))
        assert is_serif, f"Expected serif font, got {result.font_name}"
        assert abs(result.font_size - expected_size) <= 5, (
            f"Expected size ~{expected_size}, got {result.font_size}"
        )
