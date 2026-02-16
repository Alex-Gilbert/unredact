import numpy as np
from PIL import Image

from unredact.pipeline.detect_redactions import detect_redactions, Redaction


def test_detect_single_black_rectangle():
    """A white image with one black rectangle should yield one redaction."""
    img = Image.new("RGB", (800, 600), "white")
    pixels = np.array(img)
    # Draw a black rectangle (simulating a redaction)
    pixels[200:230, 100:300] = [0, 0, 0]
    img = Image.fromarray(pixels)

    redactions = detect_redactions(img)
    assert len(redactions) == 1
    r = redactions[0]
    assert abs(r.x - 100) < 5
    assert abs(r.y - 200) < 5
    assert abs(r.w - 200) < 10
    assert abs(r.h - 30) < 10


def test_detect_no_redactions_on_clean_page():
    """A white page with no black rectangles should return empty list."""
    img = Image.new("RGB", (800, 600), "white")
    redactions = detect_redactions(img)
    assert redactions == []


def test_detect_ignores_small_noise():
    """Small black spots (< min area) should be ignored."""
    img = Image.new("RGB", (800, 600), "white")
    pixels = np.array(img)
    pixels[100:105, 100:105] = [0, 0, 0]  # 5x5 spot — too small
    img = Image.fromarray(pixels)

    redactions = detect_redactions(img)
    assert redactions == []


def test_detect_multiple_redactions():
    """Multiple black rectangles should all be detected."""
    img = Image.new("RGB", (800, 600), "white")
    pixels = np.array(img)
    pixels[100:125, 50:250] = [0, 0, 0]
    pixels[300:325, 100:400] = [0, 0, 0]
    pixels[450:475, 200:500] = [0, 0, 0]
    img = Image.fromarray(pixels)

    redactions = detect_redactions(img)
    assert len(redactions) == 3
