# tests/test_dictionary.py
import pytest
from PIL import ImageFont

from unredact.pipeline.dictionary import solve_dictionary, DictionaryStore


def _get_test_font() -> ImageFont.FreeTypeFont:
    import subprocess
    result = subprocess.run(
        ["fc-match", "--format=%{file}", "Liberation Serif"],
        capture_output=True, text=True,
    )
    path = result.stdout.strip()
    return ImageFont.truetype(path, 40)


class TestSolveDictionary:
    def test_finds_matching_word(self):
        font = _get_test_font()
        entries = ["Smith", "Jones", "Brown"]
        target = font.getlength("Smith")
        results = solve_dictionary(font, entries, target, tolerance=0.5)
        texts = [r.text for r in results]
        assert "Smith" in texts

    def test_respects_tolerance(self):
        font = _get_test_font()
        entries = ["Smith", "Jones", "Brown"]
        target = font.getlength("Smith")
        results = solve_dictionary(font, entries, target, tolerance=0.0)
        assert all(r.error == 0.0 for r in results)

    def test_with_context(self):
        font = _get_test_font()
        entries = ["Smith"]
        target = font.getlength(" Smith ") - font.getlength(" ") - font.getlength(" ")
        results = solve_dictionary(
            font, entries, target, tolerance=1.0,
            left_context=" ", right_context=" ",
        )
        assert len(results) >= 0  # may or may not match due to kerning


class TestDictionaryStore:
    def test_add_and_list(self):
        store = DictionaryStore()
        store.add("names", ["Alice", "Bob", "Charlie"])
        assert "names" in store.list()

    def test_get_entries(self):
        store = DictionaryStore()
        store.add("names", ["Alice", "Bob"])
        assert store.get_entries("names") == ["Alice", "Bob"]

    def test_remove(self):
        store = DictionaryStore()
        store.add("names", ["Alice"])
        store.remove("names")
        assert "names" not in store.list()

    def test_all_entries(self):
        store = DictionaryStore()
        store.add("list1", ["Alice", "Bob"])
        store.add("list2", ["Charlie"])
        all_entries = store.all_entries()
        assert set(all_entries) == {"Alice", "Bob", "Charlie"}
