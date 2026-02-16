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
