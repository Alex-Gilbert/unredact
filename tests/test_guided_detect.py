import numpy as np
from PIL import Image

from unredact.pipeline.detect_redactions import find_redaction_in_region


def test_finds_redaction_in_region():
    """A black rectangle at a known position is found when the search region covers it."""
    img = Image.new("RGB", (800, 600), "white")
    pixels = np.array(img)
    # Place a black rectangle at y=200..220, x=150..350 (w=200, h=20)
    pixels[200:220, 150:350] = [0, 0, 0]
    img = Image.fromarray(pixels)

    result = find_redaction_in_region(img, search_x1=130, search_y1=180, search_x2=370, search_y2=240)

    assert result is not None
    assert abs(result.x - 150) <= 3
    assert abs(result.y - 200) <= 3
    assert abs(result.w - 200) <= 3
    assert abs(result.h - 20) <= 3


def test_returns_none_when_no_redaction():
    """A white page with no black content returns None."""
    img = Image.new("RGB", (800, 600), "white")

    result = find_redaction_in_region(img, search_x1=100, search_y1=100, search_x2=400, search_y2=300)

    assert result is None


def test_does_not_find_outside_region():
    """A redaction exists but lies entirely outside the search region, so None is returned."""
    img = Image.new("RGB", (800, 600), "white")
    pixels = np.array(img)
    # Redaction at the bottom of the page
    pixels[500:520, 150:350] = [0, 0, 0]
    img = Image.fromarray(pixels)

    # Search the top-left quadrant which contains no redaction
    result = find_redaction_in_region(img, search_x1=0, search_y1=0, search_x2=400, search_y2=200)

    assert result is None


def test_finds_small_redaction():
    """A small redaction (area < 500px old MIN_AREA) is found because guided mode uses a lower threshold."""
    img = Image.new("RGB", (800, 600), "white")
    pixels = np.array(img)
    # 40x15 = 600 area, above the 100 guided threshold but below old 500 MIN_AREA
    # (The old detector also requires aspect ratio >= 1.5, but this function has no such filter)
    pixels[300:315, 200:240] = [0, 0, 0]
    img = Image.fromarray(pixels)

    result = find_redaction_in_region(img, search_x1=180, search_y1=280, search_x2=260, search_y2=340)

    assert result is not None
    assert abs(result.x - 200) <= 3
    assert abs(result.y - 300) <= 3
    assert abs(result.w - 40) <= 3
    assert abs(result.h - 15) <= 3
