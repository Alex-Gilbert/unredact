"""Tests for dictionary-based single-name solving."""

from unittest.mock import MagicMock, patch

from unredact.pipeline.dictionary import solve_name_dictionary
from unredact.pipeline.solver import SolveResult


def _mock_font(width_map: dict[str, float]) -> MagicMock:
    """Create a mock font that returns widths from a map."""
    font = MagicMock()
    font.getlength.side_effect = lambda text: width_map.get(text, len(text) * 7.0)
    return font


class TestSolveNameDictionary:
    @patch("unredact.pipeline.word_filter._get_associate_firsts")
    @patch("unredact.pipeline.word_filter._get_associate_lasts")
    def test_basic_lowercase(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john", "jane"]
        mock_lasts.return_value = ["doe", "smith"]

        font = _mock_font({"john": 30.0, "jane": 28.0, "doe": 20.0, "smith": 32.0})

        results = solve_name_dictionary(font, 30.0, 1.0)
        texts = [r.text for r in results]
        assert "john" in texts
        assert "doe" not in texts  # 20.0 is outside tolerance

    @patch("unredact.pipeline.word_filter._get_associate_firsts")
    @patch("unredact.pipeline.word_filter._get_associate_lasts")
    def test_uppercase_casing(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john"]
        mock_lasts.return_value = []

        font = _mock_font({"JOHN": 35.0})

        results = solve_name_dictionary(font, 35.0, 1.0, casing="uppercase")
        assert len(results) == 1
        assert results[0].text == "JOHN"

    @patch("unredact.pipeline.word_filter._get_associate_firsts")
    @patch("unredact.pipeline.word_filter._get_associate_lasts")
    def test_capitalized_casing(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john"]
        mock_lasts.return_value = []

        font = _mock_font({"John": 32.0})

        results = solve_name_dictionary(font, 32.0, 1.0, casing="capitalized")
        assert len(results) == 1
        assert results[0].text == "John"

    @patch("unredact.pipeline.word_filter._get_associate_firsts")
    @patch("unredact.pipeline.word_filter._get_associate_lasts")
    def test_known_start_filters_and_strips(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["joe", "john", "bob"]
        mock_lasts.return_value = []

        # Gap width is for "oe" (the unknown part after "j")
        font = _mock_font({"oe": 14.0, "ohn": 21.0})

        results = solve_name_dictionary(
            font, 14.0, 1.0, known_start="j",
        )
        texts = [r.text for r in results]
        assert "joe" in texts  # "j" + "oe", "oe" width matches
        assert "bob" not in texts  # doesn't start with "j"

    @patch("unredact.pipeline.word_filter._get_associate_firsts")
    @patch("unredact.pipeline.word_filter._get_associate_lasts")
    def test_known_end_filters_and_strips(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["johnson", "jackson"]
        mock_lasts.return_value = []

        # Gap width is for "john" (the unknown part before "son")
        # With known_end="son", right kerning context is "s"
        # Width = getlength("john" + "s") - getlength("s") = 37.0 - 7.0 = 30.0
        font = _mock_font({"johns": 37.0, "s": 7.0})

        results = solve_name_dictionary(
            font, 30.0, 1.0, known_end="son",
        )
        texts = [r.text for r in results]
        assert "johnson" in texts
        assert "jackson" not in texts  # doesn't end with "son"

    @patch("unredact.pipeline.word_filter._get_associate_firsts")
    @patch("unredact.pipeline.word_filter._get_associate_lasts")
    def test_dedup_first_and_last(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["lee"]
        mock_lasts.return_value = ["lee"]  # same name in both lists

        font = _mock_font({"lee": 20.0})

        results = solve_name_dictionary(font, 20.0, 1.0)
        assert len(results) == 1  # no duplicates

    @patch("unredact.pipeline.word_filter._get_associate_firsts")
    @patch("unredact.pipeline.word_filter._get_associate_lasts")
    def test_sorted_by_error(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john", "jane"]
        mock_lasts.return_value = []

        font = _mock_font({"john": 30.5, "jane": 30.0})

        results = solve_name_dictionary(font, 30.0, 1.0)
        assert len(results) == 2
        assert results[0].error <= results[1].error

    @patch("unredact.pipeline.word_filter._get_associate_firsts")
    @patch("unredact.pipeline.word_filter._get_associate_lasts")
    def test_context_chars(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john"]
        mock_lasts.return_value = []

        font = _mock_font({
            "<john>": 45.0,
            "<": 5.0,
            ">": 5.0,
        })

        results = solve_name_dictionary(
            font, 30.0, 5.0, left_context="<", right_context=">",
        )
        # Width = 45 - 5 - 5 = 35, error = |35-30| = 5, within tolerance
        assert len(results) == 1
        assert results[0].text == "john"
