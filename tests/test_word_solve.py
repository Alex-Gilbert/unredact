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
