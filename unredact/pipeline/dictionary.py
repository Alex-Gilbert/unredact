# unredact/pipeline/dictionary.py
from PIL import ImageFont

from unredact.pipeline.solver import SolveResult


class DictionaryStore:
    """In-memory store for word/name lists."""

    def __init__(self):
        self._dicts: dict[str, list[str]] = {}

    def add(self, name: str, entries: list[str]):
        self._dicts[name] = entries

    def remove(self, name: str):
        self._dicts.pop(name, None)

    def list(self) -> list[str]:
        return list(self._dicts.keys())

    def get_entries(self, name: str) -> list[str]:
        return self._dicts.get(name, [])

    def all_entries(self) -> list[str]:
        seen = set()
        result = []
        for entries in self._dicts.values():
            for e in entries:
                if e not in seen:
                    seen.add(e)
                    result.append(e)
        return result


def solve_dictionary(
    font: ImageFont.FreeTypeFont,
    entries: list[str],
    target_width: float,
    tolerance: float = 0.0,
    left_context: str = "",
    right_context: str = "",
) -> list[SolveResult]:
    """Check each dictionary entry against the target width."""
    results: list[SolveResult] = []

    for entry in entries:
        if left_context or right_context:
            full = left_context + entry + right_context
            full_len = font.getlength(full)
            left_len = font.getlength(left_context) if left_context else 0.0
            right_len = font.getlength(right_context) if right_context else 0.0
            width = full_len - left_len - right_len
        else:
            width = font.getlength(entry)

        error = abs(width - target_width)
        if error <= tolerance:
            results.append(SolveResult(text=entry, width=float(width), error=float(error)))

    results.sort(key=lambda r: (r.error, r.text))
    return results


def solve_full_name_dictionary(
    font: ImageFont.FreeTypeFont,
    target_width: float,
    tolerance: float = 0.0,
    left_context: str = "",
    right_context: str = "",
    uppercase_only: bool = False,
) -> list[SolveResult]:
    """Match associate first x last name combinations against target width.

    Generates the Cartesian product of associate first and last names,
    applies casing (Title Case or UPPER), and checks each combination's
    rendered width. Also checks associate name variants (initials, nicknames).
    """
    from unredact.pipeline.word_filter import (
        _get_associate_firsts,
        _get_associate_lasts,
        _get_associate_variants,
    )

    firsts = _get_associate_firsts()
    lasts = _get_associate_lasts()
    variants = _get_associate_variants()

    results: list[SolveResult] = []
    seen: set[str] = set()

    def _check(text: str):
        if text in seen:
            return
        seen.add(text)

        if left_context or right_context:
            full = left_context + text + right_context
            full_len = font.getlength(full)
            left_len = font.getlength(left_context) if left_context else 0.0
            right_len = font.getlength(right_context) if right_context else 0.0
            width = full_len - left_len - right_len
        else:
            width = font.getlength(text)

        error = abs(width - target_width)
        if error <= tolerance:
            results.append(SolveResult(text=text, width=float(width), error=float(error)))

    # Cartesian product of first x last names
    for first in firsts:
        for last in lasts:
            if uppercase_only:
                text = (first + " " + last).upper()
            else:
                text = first.title() + " " + last.title()
            _check(text)

    # Associate variants (J. Doe, Jeff Epstein, etc.)
    for variant in variants:
        if uppercase_only:
            text = variant.upper()
        else:
            text = variant.title()
        _check(text)

    results.sort(key=lambda r: (r.error, r.text))
    return results
