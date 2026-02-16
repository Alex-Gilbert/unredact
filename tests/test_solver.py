import pytest
from PIL import ImageFont

from unredact.pipeline.solver import solve_gap, solve_gap_parallel, SolveResult


def _get_test_font() -> ImageFont.FreeTypeFont:
    import subprocess
    result = subprocess.run(
        ["fc-match", "--format=%{file}", "Liberation Serif"],
        capture_output=True, text=True,
    )
    path = result.stdout.strip()
    return ImageFont.truetype(path, 40)


class TestSolveGap:
    def test_finds_exact_match(self):
        """Given a gap that exactly fits 'hello', solver should find it."""
        font = _get_test_font()
        target = font.getlength("hello")
        results = solve_gap(
            font=font,
            charset="ehlo",
            target_width=target,
            tolerance=0.5,
            min_length=5,
            max_length=5,
            left_context="",
            right_context="",
        )
        texts = [r.text for r in results]
        assert "hello" in texts

    def test_respects_tolerance_zero(self):
        """With zero tolerance, only exact pixel matches are returned."""
        font = _get_test_font()
        target = font.getlength("ab")
        results = solve_gap(
            font=font,
            charset="ab",
            target_width=target,
            tolerance=0.0,
            min_length=2,
            max_length=2,
            left_context="",
            right_context="",
        )
        texts = [r.text for r in results]
        assert "ab" in texts

    def test_respects_length_bounds(self):
        """Results should all be within min/max length."""
        font = _get_test_font()
        target = font.getlength("test")
        results = solve_gap(
            font=font,
            charset="tes",
            target_width=target,
            tolerance=2.0,
            min_length=3,
            max_length=5,
            left_context="",
            right_context="",
        )
        for r in results:
            assert 3 <= len(r.text) <= 5

    def test_with_context_chars(self):
        """Solver accounts for left/right boundary kerning."""
        font = _get_test_font()
        # Measure "es" when preceded by "T"
        target = font.getlength("Tes") - font.getlength("T")
        results = solve_gap(
            font=font,
            charset="est",
            target_width=target,
            tolerance=0.5,
            min_length=2,
            max_length=2,
            left_context="T",
            right_context="",
        )
        texts = [r.text for r in results]
        assert "es" in texts

    def test_empty_results_for_impossible_width(self):
        """If target is impossibly small, return no results."""
        font = _get_test_font()
        results = solve_gap(
            font=font,
            charset="abc",
            target_width=0.1,
            tolerance=0.0,
            min_length=1,
            max_length=5,
            left_context="",
            right_context="",
        )
        assert len(results) == 0

    def test_result_contains_width_and_error(self):
        """Each result should have text, width, and error fields."""
        font = _get_test_font()
        target = font.getlength("ab")
        results = solve_gap(
            font=font,
            charset="ab",
            target_width=target,
            tolerance=1.0,
            min_length=2,
            max_length=2,
            left_context="",
            right_context="",
        )
        assert len(results) > 0
        r = results[0]
        assert isinstance(r.text, str)
        assert isinstance(r.width, float)
        assert isinstance(r.error, float)
        assert r.error >= 0


class TestSolveGapParallel:
    def test_same_results_as_serial(self):
        """Parallel solver should find the same results as serial."""
        font = _get_test_font()
        target = font.getlength("hello")
        serial = solve_gap(
            font=font, charset="ehlo", target_width=target,
            tolerance=0.5, min_length=5, max_length=5,
        )
        parallel = solve_gap_parallel(
            font=font, charset="ehlo", target_width=target,
            tolerance=0.5, min_length=5, max_length=5,
        )
        assert set(r.text for r in serial) == set(r.text for r in parallel)

    def test_parallel_with_larger_charset(self):
        """Should handle a real-sized charset without errors."""
        font = _get_test_font()
        target = font.getlength("cat")
        results = solve_gap_parallel(
            font=font, charset="abcdefghijklmnopqrstuvwxyz",
            target_width=target, tolerance=0.5,
            min_length=3, max_length=3,
        )
        texts = [r.text for r in results]
        assert "cat" in texts

    def test_progress_callback(self):
        """Progress callback should be called with node counts."""
        font = _get_test_font()
        target = font.getlength("ab")
        progress = []
        solve_gap_parallel(
            font=font, charset="abc", target_width=target,
            tolerance=1.0, min_length=2, max_length=2,
            on_progress=lambda checked, found: progress.append((checked, found)),
        )
        assert len(progress) > 0


class TestRoundTrip:
    def test_known_word_found_with_real_font(self):
        """Measure a word, then solve for it — the word should appear in results."""
        font = _get_test_font()
        word = "Smith"
        # Measure "Smith" when preceded by "o" (left context)
        target = font.getlength("o" + word) - font.getlength("o")

        results = solve_gap(
            font=font,
            charset="abcdefghijklmnopqrstuvwxyzST",  # include needed uppercase
            target_width=target,
            tolerance=0.5,
            min_length=5,
            max_length=5,
            left_context="o",
            right_context="",
        )
        texts = [r.text for r in results]
        assert "Smith" in texts
