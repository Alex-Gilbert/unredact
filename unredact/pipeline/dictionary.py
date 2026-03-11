# unredact/pipeline/dictionary.py
from __future__ import annotations
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


def _apply_casing(text: str, casing: str) -> str:
    """Apply casing to a name string."""
    if casing == "uppercase":
        return text.upper()
    elif casing == "capitalized":
        return text.title()
    return text


def _case_unknown_portion(unknown: str, known_start: str, casing: str) -> str:
    """Apply casing to the unknown portion of a name, respecting word boundaries.

    When known_start is set and casing is 'capitalized', the unknown text
    starts mid-word — its first fragment should be lowercase, but subsequent
    words (after spaces) should be title-cased.
    """
    if casing == "uppercase":
        return unknown.upper()
    if casing != "capitalized":
        return unknown  # lowercase — no change

    if not known_start:
        return unknown.title()

    # If known_start ends with a space, unknown starts a new word
    if known_start.endswith(" "):
        return unknown.title()

    # Unknown starts mid-word: first fragment lowercase, rest title-cased
    parts = unknown.split(" ")
    result = [parts[0].lower()]
    for part in parts[1:]:
        result.append(part.title() if part else "")
    return " ".join(result)


def solve_full_name_dictionary(
    font: ImageFont.FreeTypeFont,
    target_width: float,
    tolerance: float = 0.0,
    left_context: str = "",
    right_context: str = "",
    casing: str = "capitalized",
    known_start: str = "",
    known_end: str = "",
) -> list[SolveResult]:
    """Match per-person full name variants against target width.

    Uses pre-built multi-word name variants from associates.json
    (full names, initial+last, nickname+last) — each tied to a real
    person rather than a Cartesian product of unrelated names.

    If known_start/known_end are set, filters candidates and measures
    only the unknown portion against the target width.
    """
    from unredact.pipeline.word_filter import _get_associate_variants

    variants = _get_associate_variants()

    results: list[SolveResult] = []
    seen: set[str] = set()

    ks_lower = known_start.lower()
    ke_lower = known_end.lower()

    for variant in variants:
        raw = variant.lower()
        display = _apply_casing(variant, casing)

        if display in seen:
            continue
        seen.add(display)

        if ks_lower and not raw.startswith(ks_lower):
            continue
        if ke_lower and not raw.endswith(ke_lower):
            continue

        if known_start or known_end:
            end_idx = len(raw) - len(known_end) if known_end else len(raw)
            unknown_raw = raw[len(known_start):end_idx]
            if not unknown_raw:
                continue
            unknown_display = _case_unknown_portion(unknown_raw, known_start, casing)

            effective_left = _apply_casing(known_start, casing)[-1] if known_start else left_context
            effective_right = display[end_idx] if known_end else right_context

            if effective_left or effective_right:
                full = effective_left + unknown_display + effective_right
                full_len = font.getlength(full)
                left_len = font.getlength(effective_left) if effective_left else 0.0
                right_len = font.getlength(effective_right) if effective_right else 0.0
                width = full_len - left_len - right_len
            else:
                width = font.getlength(unknown_display)
        else:
            if left_context or right_context:
                full = left_context + display + right_context
                full_len = font.getlength(full)
                left_len = font.getlength(left_context) if left_context else 0.0
                right_len = font.getlength(right_context) if right_context else 0.0
                width = full_len - left_len - right_len
            else:
                width = font.getlength(display)

        error = abs(width - target_width)
        if error <= tolerance:
            results.append(SolveResult(text=display, width=float(width), error=float(error)))

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

        unknown_display = _case_unknown_portion(unknown, known_start, casing)

        # Determine kerning context
        # If known_start is set, its last char is left context for the unknown part
        effective_left = _apply_casing(known_start, casing)[-1] if known_start else left_context
        effective_right = display[end_idx] if known_end else right_context

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


def solve_word_dictionary(
    font: "ImageFont.FreeTypeFont",
    target_width: float,
    tolerance: float = 0.0,
    left_context: str = "",
    right_context: str = "",
    casing: str = "lowercase",
    known_start: str = "",
    known_end: str = "",
    ensure_plural: bool = False,
    vocab_size: int = 0,
    two_word: bool = False,
):
    """Search English nouns and optionally adj+noun phrases.

    Yields results as found for SSE streaming. Phase 1 searches nouns
    (including multi-word nouns already in the dictionary). Phase 2
    (disabled by default) searches adjective+noun combinations.

    Word lists are frequency-sorted (most common first). vocab_size > 0 slices
    to the N most common words; 0 means no limit.
    """
    from unredact.pipeline.word_filter import (
        _get_nouns,
        _get_nouns_plural,
    )

    nouns = _get_nouns()
    plurals = _get_nouns_plural()

    if vocab_size > 0:
        nouns = nouns[:vocab_size]
        plurals = plurals[:vocab_size]

    word_list = plurals if ensure_plural else nouns

    ks_lower = known_start.lower()
    ke_lower = known_end.lower()
    seen: set[str] = set()

    for word in word_list:
        if ks_lower and not word.startswith(ks_lower):
            continue
        if ke_lower and not word.endswith(ke_lower):
            continue

        display = _apply_casing(word, casing)
        if display in seen:
            continue
        seen.add(display)

        if left_context or right_context:
            full = left_context + display + right_context
            full_len = font.getlength(full)
            left_len = font.getlength(left_context) if left_context else 0.0
            right_len = font.getlength(right_context) if right_context else 0.0
            width = full_len - left_len - right_len
        else:
            width = font.getlength(display)

        error = abs(width - target_width)
        if error <= tolerance:
            yield SolveResult(text=display, width=float(width), error=float(error))

    if not two_word:
        return

    # Phase 2: two-word search (word1 + " " + noun)
    import bisect

    from unredact.pipeline.word_filter import _get_adjectives

    adjectives = _get_adjectives()
    if vocab_size > 0:
        adjectives = adjectives[:vocab_size]

    # Word1 pool: adjectives + nouns (deduplicated, sorted)
    word1_set = set(adjectives) | set(nouns)
    word1_list = sorted(word1_set)

    # Word2 pool: nouns or plural nouns
    word2_list = list(plurals if ensure_plural else nouns)

    # Pre-measure word2 widths and sort
    word2_measured: list[tuple[float, str, str]] = []
    for w2 in word2_list:
        display2 = _apply_casing(w2, casing)
        w = font.getlength(display2)
        word2_measured.append((w, display2, w2))

    word2_measured.sort(key=lambda x: x[0])
    word2_widths = [x[0] for x in word2_measured]

    KERNING_MARGIN = 3.0

    for w1 in word1_list:
        if ks_lower and not w1.startswith(ks_lower):
            continue

        display1 = _apply_casing(w1, casing)

        # Measure word1 + space width (with left context kerning)
        w1_with_space = display1 + " "
        if left_context:
            w1_portion = (
                font.getlength(left_context + w1_with_space)
                - font.getlength(left_context)
            )
        else:
            w1_portion = font.getlength(w1_with_space)

        remaining = target_width - w1_portion
        if remaining < 0:
            continue

        # Binary search for word2 candidates
        lo = bisect.bisect_left(word2_widths, remaining - tolerance - KERNING_MARGIN)
        hi = bisect.bisect_right(word2_widths, remaining + tolerance + KERNING_MARGIN)

        for i in range(lo, hi):
            _, display2, w2_raw = word2_measured[i]
            if ke_lower and not w2_raw.endswith(ke_lower):
                continue

            phrase = display1 + " " + display2
            if phrase in seen:
                continue

            # Verify exact combined width with full kerning context
            if left_context or right_context:
                full = left_context + phrase + right_context
                full_len = font.getlength(full)
                left_len = font.getlength(left_context) if left_context else 0.0
                right_len = font.getlength(right_context) if right_context else 0.0
                exact_width = full_len - left_len - right_len
            else:
                exact_width = font.getlength(phrase)

            error = abs(exact_width - target_width)
            if error <= tolerance:
                seen.add(phrase)
                yield SolveResult(
                    text=phrase, width=float(exact_width), error=float(error)
                )
