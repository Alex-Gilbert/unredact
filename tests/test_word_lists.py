# tests/test_word_lists.py
"""Tests for word list loading (nouns, adjectives, plurals)."""

from unredact.pipeline.word_filter import (
    _get_nouns,
    _get_nouns_plural,
    _get_adjectives,
)


class TestWordListLoaders:
    def test_nouns_loads(self):
        nouns = _get_nouns()
        assert len(nouns) > 1000
        assert isinstance(nouns, list)
        assert "dog" in nouns

    def test_nouns_plural_loads(self):
        plurals = _get_nouns_plural()
        assert len(plurals) > 1000
        assert isinstance(plurals, list)
        assert "dogs" in plurals

    def test_adjectives_loads(self):
        adjectives = _get_adjectives()
        assert len(adjectives) > 1000
        assert isinstance(adjectives, list)
        assert "large" in adjectives

    def test_nouns_and_plurals_same_length(self):
        nouns = _get_nouns()
        plurals = _get_nouns_plural()
        assert len(nouns) == len(plurals)

    def test_all_words_lowercase_alpha(self):
        import re
        pattern = re.compile(r"^[a-z]+$")
        for word in _get_nouns()[:100]:
            assert pattern.match(word), f"Non-alpha noun: {word}"
        for word in _get_adjectives()[:100]:
            assert pattern.match(word), f"Non-alpha adjective: {word}"
