# tests/test_word_solve.py
"""Tests for word dictionary solve mode."""

import subprocess
import types
import pytest
from PIL import ImageFont

from unredact.pipeline.dictionary import solve_word_dictionary


def _get_test_font() -> ImageFont.FreeTypeFont:
    result = subprocess.run(
        ["fc-match", "--format=%{file}", "Liberation Serif"],
        capture_output=True, text=True,
    )
    path = result.stdout.strip()
    return ImageFont.truetype(path, 40)


class TestSolveWordDictionarySingleWord:
    def test_finds_exact_noun(self):
        font = _get_test_font()
        target = font.getlength("house")
        results = list(solve_word_dictionary(
            font, target, tolerance=0.5,
            casing="lowercase",
        ))
        texts = [r.text for r in results]
        assert "house" in texts

    def test_plural_mode_filters(self):
        font = _get_test_font()
        target = font.getlength("houses")
        results = list(solve_word_dictionary(
            font, target, tolerance=0.5,
            casing="lowercase", ensure_plural=True,
        ))
        texts = [r.text for r in results]
        assert "houses" in texts

    def test_casing_capitalized(self):
        font = _get_test_font()
        target = font.getlength("House")
        results = list(solve_word_dictionary(
            font, target, tolerance=0.5,
            casing="capitalized",
        ))
        texts = [r.text for r in results]
        assert "House" in texts

    def test_casing_uppercase(self):
        font = _get_test_font()
        target = font.getlength("HOUSE")
        results = list(solve_word_dictionary(
            font, target, tolerance=0.5,
            casing="uppercase",
        ))
        texts = [r.text for r in results]
        assert "HOUSE" in texts

    def test_known_start_filters(self):
        font = _get_test_font()
        target = font.getlength("house")
        results = list(solve_word_dictionary(
            font, target, tolerance=0.5,
            casing="lowercase", known_start="ho",
        ))
        texts = [r.text for r in results]
        assert "house" in texts
        assert all(t.lower().startswith("ho") for t in texts)

    def test_known_end_filters(self):
        font = _get_test_font()
        target = font.getlength("house")
        results = list(solve_word_dictionary(
            font, target, tolerance=0.5,
            casing="lowercase", known_end="se",
        ))
        texts = [r.text for r in results]
        assert "house" in texts
        assert all(t.lower().endswith("se") for t in texts)

    def test_returns_generator(self):
        font = _get_test_font()
        target = font.getlength("dog")
        gen = solve_word_dictionary(font, target, tolerance=0.5, casing="lowercase")
        assert isinstance(gen, types.GeneratorType)


class TestSolveWordDictionaryTwoWord:
    def test_finds_two_word_phrase(self):
        font = _get_test_font()
        target = font.getlength("large house")
        results = list(solve_word_dictionary(
            font, target, tolerance=1.0,
            casing="lowercase", known_start="large", two_word=True,
        ))
        texts = [r.text for r in results]
        assert "large house" in texts

    def test_two_word_capitalized(self):
        font = _get_test_font()
        target = font.getlength("Large House")
        results = list(solve_word_dictionary(
            font, target, tolerance=1.0,
            casing="capitalized", known_start="Large", two_word=True,
        ))
        texts = [r.text for r in results]
        assert "Large House" in texts

    def test_two_word_plural(self):
        font = _get_test_font()
        target = font.getlength("large houses")
        results = list(solve_word_dictionary(
            font, target, tolerance=1.0,
            casing="lowercase", ensure_plural=True, known_start="large",
            two_word=True,
        ))
        texts = [r.text for r in results]
        assert "large houses" in texts

    def test_two_word_known_start(self):
        font = _get_test_font()
        target = font.getlength("large house")
        results = list(solve_word_dictionary(
            font, target, tolerance=1.0,
            casing="lowercase", known_start="la", two_word=True,
        ))
        texts = [r.text for r in results]
        assert "large house" in texts
        assert all(t.lower().startswith("la") for t in texts)

    def test_two_word_known_end(self):
        font = _get_test_font()
        target = font.getlength("large house")
        results = list(solve_word_dictionary(
            font, target, tolerance=1.0,
            casing="lowercase", known_end="se", two_word=True,
        ))
        texts = [r.text for r in results]
        assert "large house" in texts
        assert all(t.lower().endswith("se") for t in texts)

    def test_two_word_disabled_by_default(self):
        """Without two_word=True, only dictionary nouns are searched."""
        font = _get_test_font()
        target = font.getlength("large house")
        results = list(solve_word_dictionary(
            font, target, tolerance=1.0,
            casing="lowercase", known_start="large",
        ))
        texts = [r.text for r in results]
        # "large house" is not a dictionary noun, so it should NOT appear
        assert "large house" not in texts

    def test_no_duplicates_across_phases(self):
        font = _get_test_font()
        target = font.getlength("dog")
        results = list(solve_word_dictionary(
            font, target, tolerance=1.0,
            casing="lowercase", two_word=True,
        ))
        texts = [r.text for r in results]
        assert len(texts) == len(set(texts))
