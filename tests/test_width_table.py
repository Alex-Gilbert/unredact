import numpy as np
import pytest
from PIL import ImageFont

from unredact.pipeline.width_table import build_width_table, CHARSETS


def _get_test_font() -> ImageFont.FreeTypeFont:
    """Get any available system font for testing."""
    import subprocess
    result = subprocess.run(
        ["fc-match", "--format=%{file}", "Liberation Serif"],
        capture_output=True, text=True,
    )
    path = result.stdout.strip()
    return ImageFont.truetype(path, 40)


class TestCharsets:
    def test_lowercase_has_26_chars(self):
        assert len(CHARSETS["lowercase"]) == 26

    def test_uppercase_has_26_chars(self):
        assert len(CHARSETS["uppercase"]) == 26

    def test_alpha_has_52_chars(self):
        assert len(CHARSETS["alpha"]) == 52

    def test_alphanumeric_has_62_chars(self):
        assert len(CHARSETS["alphanumeric"]) == 62


class TestBuildWidthTable:
    def test_returns_correct_shape(self):
        font = _get_test_font()
        charset = "abc"
        table = build_width_table(font, charset)
        assert table.width_table.shape == (3, 3)
        assert table.left_edge.shape == (3,)
        assert table.right_edge.shape == (3,)
        assert table.min_advance.shape == (3,)
        assert table.max_advance.shape == (3,)

    def test_widths_are_positive(self):
        font = _get_test_font()
        charset = "abcdefghij"
        table = build_width_table(font, charset)
        assert np.all(table.width_table > 0)

    def test_min_max_bounds_correct(self):
        font = _get_test_font()
        charset = "abcdefghijklmnopqrstuvwxyz"
        table = build_width_table(font, charset)
        for i in range(len(charset)):
            row = table.width_table[i]
            assert table.min_advance[i] == pytest.approx(row.min())
            assert table.max_advance[i] == pytest.approx(row.max())

    def test_kerning_captured(self):
        """Different char pairs should produce different advance widths."""
        font = _get_test_font()
        charset = "AVX"
        table = build_width_table(font, charset)
        assert table.width_table.shape == (3, 3)
        # Advance of V after A should differ from advance of X after A (kerning)
        assert table.width_table[0][1] != table.width_table[0][2]

    def test_left_edge_uses_context(self):
        font = _get_test_font()
        charset = "abcde"
        table = build_width_table(font, charset, left_context="T")
        table_no_ctx = build_width_table(font, charset, left_context="")
        assert table.left_edge.shape == (5,)
        # Left context should change at least some advance widths
        assert not np.allclose(table.left_edge, table_no_ctx.left_edge)

    def test_right_edge_uses_context(self):
        font = _get_test_font()
        # Use uppercase chars that kern with lowercase context
        charset = "AVT"
        table = build_width_table(font, charset, right_context="o")
        assert table.right_edge.shape == (3,)
        # Right edge with context should differ from right edge without context
        table_no_ctx = build_width_table(font, charset, right_context="")
        assert not np.array_equal(table.right_edge, table_no_ctx.right_edge)
