"""Tests for dictionary-based full name solving."""

from unittest.mock import MagicMock, patch

from unredact.pipeline.dictionary import solve_full_name_dictionary
from unredact.pipeline.solver import SolveResult


def _mock_font(width_map: dict[str, float]) -> MagicMock:
    """Create a mock font that returns widths from a map."""
    font = MagicMock()
    font.getlength.side_effect = lambda text: width_map.get(text, len(text) * 7.0)
    return font


class TestSolveFullNameDictionary:
    @patch("unredact.pipeline.word_filter._get_associate_variants")
    def test_basic_match(self, mock_variants):
        mock_variants.return_value = ["john doe", "john smith", "jane doe", "jane smith"]

        font = _mock_font({"John Doe": 50.0, "John Smith": 60.0, "Jane Doe": 48.0, "Jane Smith": 58.0})

        results = solve_full_name_dictionary(font, 50.0, 1.0)

        texts = [r.text for r in results]
        assert "John Doe" in texts
        assert "Jane Doe" not in texts  # 48.0 is outside tolerance

    @patch("unredact.pipeline.word_filter._get_associate_variants")
    def test_uppercase_mode(self, mock_variants):
        mock_variants.return_value = ["john doe"]

        font = _mock_font({"JOHN DOE": 55.0})

        results = solve_full_name_dictionary(font, 55.0, 1.0, casing="uppercase")

        assert len(results) == 1
        assert results[0].text == "JOHN DOE"

    @patch("unredact.pipeline.word_filter._get_associate_variants")
    def test_includes_associate_variants(self, mock_variants):
        mock_variants.return_value = ["john doe", "j. doe", "johnny doe"]

        font = _mock_font({
            "John Doe": 50.0,
            "J. Doe": 35.0,
            "Johnny Doe": 60.0,
        })

        results = solve_full_name_dictionary(font, 50.0, 1.0)
        texts = [r.text for r in results]
        assert "John Doe" in texts
        # J. Doe title-cases to "J. Doe" with width 35.0 -- outside tolerance
        # Johnny Doe title-cases to "Johnny Doe" with width 60.0 -- outside tolerance

    @patch("unredact.pipeline.word_filter._get_associate_variants")
    def test_context_chars(self, mock_variants):
        mock_variants.return_value = ["john doe"]

        font = _mock_font({
            "<John Doe>": 60.0,
            "<": 5.0,
            ">": 5.0,
        })

        results = solve_full_name_dictionary(font, 50.0, 1.0, left_context="<", right_context=">")
        assert len(results) == 1
        assert results[0].text == "John Doe"

    @patch("unredact.pipeline.word_filter._get_associate_variants")
    def test_dedup(self, mock_variants):
        mock_variants.return_value = ["john doe", "john doe"]  # duplicate

        font = _mock_font({"John Doe": 50.0})

        results = solve_full_name_dictionary(font, 50.0, 1.0)
        texts = [r.text for r in results]
        assert texts.count("John Doe") == 1  # no duplicates

    @patch("unredact.pipeline.word_filter._get_associate_variants")
    def test_sorted_by_error(self, mock_variants):
        mock_variants.return_value = ["john doe", "jane doe"]

        font = _mock_font({"John Doe": 50.5, "Jane Doe": 50.0})

        results = solve_full_name_dictionary(font, 50.0, 1.0)
        assert len(results) == 2
        assert results[0].error <= results[1].error

    @patch("unredact.pipeline.word_filter._get_associate_variants")
    def test_known_start_multiword_casing(self, mock_variants):
        """Unknown portion of multi-word name should preserve word-boundary casing.

        Name: 'john doe', known_start='jo', unknown='hn Doe' (not 'hn doe').
        The width measurement must use 'hn Doe' not 'hn doe'.
        effective_left = last char of _apply_casing('jo') = 'o', so
        font sees 'o' + 'hn Doe' = 'ohn Doe' (kerning context string).
        """
        mock_variants.return_value = ["john doe"]

        # Mock: the kerning-context string "ohn Doe" vs "ohn doe".
        # font.getlength("o") defaults to 7.0 (1 char * 7.0).
        # width = font.getlength("ohn Doe") - font.getlength("o") = 42.0 - 7.0 = 35.0
        font = _mock_font({
            "ohn Doe": 42.0,   # correct cased unknown (width = 35.0)
            "ohn doe": 38.0,   # wrong (current bug: all-lowercase, width = 31.0)
        })

        results = solve_full_name_dictionary(
            font, 35.0, 1.0, known_start="jo", casing="capitalized",
        )
        texts = [r.text for r in results]
        assert "John Doe" in texts
