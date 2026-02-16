from dataclasses import dataclass

import numpy as np
from PIL import ImageFont

CHARSETS: dict[str, str] = {
    "lowercase": "abcdefghijklmnopqrstuvwxyz",
    "uppercase": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "alpha": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "alphanumeric": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "printable": (
        "abcdefghijklmnopqrstuvwxyz"
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "0123456789"
        " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
    ),
}


@dataclass
class WidthTable:
    """Precomputed font metric table for a charset.

    width_table[i][j]: advance width of charset[j] when preceded by charset[i]
    left_edge[j]: advance width of charset[j] when preceded by left_context
    right_edge[i]: kerning correction for charset[i] followed by right_context
    min_advance[i]: minimum advance of any char after charset[i]
    max_advance[i]: maximum advance of any char after charset[i]
    """

    charset: str
    width_table: np.ndarray   # (N, N) float64
    left_edge: np.ndarray     # (N,) float64
    right_edge: np.ndarray    # (N,) float64
    min_advance: np.ndarray   # (N,) float64
    max_advance: np.ndarray   # (N,) float64
    left_min: float
    left_max: float


def build_width_table(
    font: ImageFont.FreeTypeFont,
    charset: str,
    left_context: str = "",
    right_context: str = "",
) -> WidthTable:
    """Build a kerning-aware width lookup table.

    Uses font.getlength() which returns advance width including kerning.
    width_table[i][j] = getlength(charset[i] + charset[j]) - getlength(charset[i])
    This gives the advance of charset[j] when preceded by charset[i].
    """
    n = len(charset)
    table = np.zeros((n, n), dtype=np.float64)
    left_edge = np.zeros(n, dtype=np.float64)
    right_edge = np.zeros(n, dtype=np.float64)

    single = np.array([font.getlength(c) for c in charset], dtype=np.float64)

    for i, prev in enumerate(charset):
        base = font.getlength(prev)
        for j, next_c in enumerate(charset):
            table[i][j] = font.getlength(prev + next_c) - base

    if left_context:
        base_left = font.getlength(left_context)
        for j, c in enumerate(charset):
            left_edge[j] = font.getlength(left_context + c) - base_left
    else:
        left_edge[:] = single

    if right_context:
        right_len = font.getlength(right_context)
        for i, c in enumerate(charset):
            right_edge[i] = font.getlength(c + right_context) - single[i] - right_len
    else:
        right_edge[:] = 0.0

    min_advance = table.min(axis=1)
    max_advance = table.max(axis=1)

    return WidthTable(
        charset=charset,
        width_table=table,
        left_edge=left_edge,
        right_edge=right_edge,
        min_advance=min_advance,
        max_advance=max_advance,
        left_min=float(left_edge.min()),
        left_max=float(left_edge.max()),
    )
