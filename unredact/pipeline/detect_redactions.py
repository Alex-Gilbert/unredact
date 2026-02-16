from dataclasses import dataclass
import uuid

import cv2
import numpy as np
from PIL import Image


@dataclass
class Redaction:
    """A detected redaction bounding box."""
    id: str
    x: int
    y: int
    w: int
    h: int


# Minimum area in pixels to consider (filters noise)
MIN_AREA = 500

# Minimum aspect ratio (width/height) — redactions are wider than tall
MIN_ASPECT = 1.5


def detect_redactions(image: Image.Image) -> list[Redaction]:
    """Detect black-filled rectangles in a page image.

    Converts to grayscale, thresholds for near-black pixels, finds contours,
    and filters for rectangular shapes that look like redaction bars.

    Args:
        image: PIL Image of a document page.

    Returns:
        List of Redaction objects sorted top-to-bottom, left-to-right.
    """
    arr = np.array(image.convert("RGB"))
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)

    # Threshold: pixels darker than 40 are "black"
    _, binary = cv2.threshold(gray, 40, 255, cv2.THRESH_BINARY_INV)

    # Morphological close to merge adjacent redaction fragments
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    redactions: list[Redaction] = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = w * h

        if area < MIN_AREA:
            continue

        # Aspect ratio filter: redactions are wider than tall
        if h > 0 and w / h < MIN_ASPECT:
            continue

        # Fill ratio: the contour should fill most of the bounding rect
        contour_area = cv2.contourArea(contour)
        if contour_area / area < 0.7:
            continue

        redactions.append(Redaction(
            id=uuid.uuid4().hex[:8],
            x=x, y=y, w=w, h=h,
        ))

    # Sort top-to-bottom, then left-to-right
    redactions.sort(key=lambda r: (r.y, r.x))
    return redactions


def spot_redaction(image: Image.Image, click_x: int, click_y: int) -> Redaction | None:
    """Find a redaction box at a specific click point using connected components.

    Args:
        image: PIL Image of a document page.
        click_x: X coordinate of the click in page-image pixels.
        click_y: Y coordinate of the click in page-image pixels.

    Returns:
        Redaction object if a dark region is found, None otherwise.
    """
    arr = np.array(image.convert("RGB"))
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    _, binary = cv2.threshold(gray, 40, 255, cv2.THRESH_BINARY_INV)

    num_labels, labels = cv2.connectedComponents(binary)

    if click_y < 0 or click_y >= labels.shape[0] or click_x < 0 or click_x >= labels.shape[1]:
        return None

    label = int(labels[click_y, click_x])
    if label == 0:
        return None

    coords = cv2.findNonZero((labels == label).astype(np.uint8))
    x, y, w, h = cv2.boundingRect(coords)

    if w * h < 100:
        return None

    return Redaction(id=uuid.uuid4().hex[:8], x=int(x), y=int(y), w=int(w), h=int(h))
