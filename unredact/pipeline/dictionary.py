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


def solve_name_dictionary(
    font: ImageFont.FreeTypeFont,
    target_width: float,
    tolerance: float = 0.0,
    left_context: str = "",
    right_context: str = "",
    casing: str = "lowercase",
    known_start: str = "",
    known_end: str = "",
) -> list[SolveResult]:
    """Match single associate names against target width.

    Loads first and last name lists, applies casing, filters by
    known_start/known_end, and measures the unknown portion against
    the target width.
    """
    from unredact.pipeline.word_filter import (
        _get_associate_firsts,
        _get_associate_lasts,
    )

    firsts = _get_associate_firsts()
    lasts = _get_associate_lasts()

    # Combine and dedup
    seen: set[str] = set()
    names: list[str] = []
    for name in firsts + lasts:
        if name not in seen:
            seen.add(name)
            names.append(name)

    results: list[SolveResult] = []
    seen_results: set[str] = set()

    ks_lower = known_start.lower()
    ke_lower = known_end.lower()

    for name in names:
        # Filter by known start/end (case-insensitive on raw lowercase name)
        if ks_lower and not name.startswith(ks_lower):
            continue
        if ke_lower and not name.endswith(ke_lower):
            continue

        # Apply casing to the full name (for display)
        if casing == "uppercase":
            display = name.upper()
        elif casing == "capitalized":
            display = name.title()
        else:
            display = name

        if display in seen_results:
            continue
        seen_results.add(display)

        # The unknown portion is the name minus known_start and known_end
        end_idx = len(name) - len(known_end) if known_end else len(name)
        unknown = name[len(known_start):end_idx]

        if not unknown:
            continue  # entire name is known, nothing to measure

        # Apply same casing to the unknown portion
        if casing == "uppercase":
            unknown_display = unknown.upper()
        elif casing == "capitalized":
            # Mid-word after known_start: lowercase. At word start: title case.
            unknown_display = unknown.lower() if known_start else unknown.title()
        else:
            unknown_display = unknown

        # Determine kerning context
        # If known_start is set, its last char is left context for the unknown part
        effective_left = known_start[-1] if known_start else left_context
        effective_right = known_end[0] if known_end else right_context

        # Measure width of unknown portion with kerning context
        if effective_left or effective_right:
            full = effective_left + unknown_display + effective_right
            full_len = font.getlength(full)
            left_len = font.getlength(effective_left) if effective_left else 0.0
            right_len = font.getlength(effective_right) if effective_right else 0.0
            width = full_len - left_len - right_len
        else:
            width = font.getlength(unknown_display)

        error = abs(width - target_width)
        if error <= tolerance:
            results.append(SolveResult(text=display, width=float(width), error=float(error)))

    results.sort(key=lambda r: (r.error, r.text))
    return results
