"""Post-filter for solver results: English words and/or names."""

from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"


def _load_set(filename: str) -> set[str]:
    path = DATA_DIR / filename
    if not path.exists():
        return set()
    return {line.strip().lower() for line in path.read_text().splitlines() if line.strip()}


# Lazy-loaded word sets
_words: set[str] | None = None
_first_names: set[str] | None = None
_last_names: set[str] | None = None
_emails: list[str] | None = None


def _get_words() -> set[str]:
    global _words
    if _words is None:
        _words = _load_set("words_alpha.txt")
    return _words


def _get_first_names() -> set[str]:
    global _first_names
    if _first_names is None:
        _first_names = _load_set("first_names.txt")
    return _first_names


def _get_last_names() -> set[str]:
    global _last_names
    if _last_names is None:
        _last_names = _load_set("last_names.txt")
    return _last_names


def _get_emails() -> list[str]:
    global _emails
    if _emails is None:
        path = DATA_DIR / "emails.txt"
        if path.exists():
            _emails = [line.strip().lower() for line in path.read_text().splitlines() if line.strip()]
        else:
            _emails = []
    return _emails


_associate_firsts: list[str] | None = None
_associate_lasts: list[str] | None = None
_associate_variants: list[str] | None = None


def _get_associate_firsts() -> list[str]:
    global _associate_firsts
    if _associate_firsts is None:
        path = DATA_DIR / "associate_first_names.txt"
        if path.exists():
            _associate_firsts = [line.strip() for line in path.read_text().splitlines() if line.strip()]
        else:
            _associate_firsts = []
    return _associate_firsts


def _get_associate_lasts() -> list[str]:
    global _associate_lasts
    if _associate_lasts is None:
        path = DATA_DIR / "associate_last_names.txt"
        if path.exists():
            _associate_lasts = [line.strip() for line in path.read_text().splitlines() if line.strip()]
        else:
            _associate_lasts = []
    return _associate_lasts


def _get_associate_variants() -> list[str]:
    """Load all multi-word name variants from associates.json."""
    global _associate_variants
    if _associate_variants is None:
        import json
        path = DATA_DIR / "associates.json"
        if path.exists():
            data = json.loads(path.read_text())
            _associate_variants = [k for k in data.get("names", {}).keys() if " " in k]
        else:
            _associate_variants = []
    return _associate_variants


def _get_all_names() -> set[str]:
    return _get_first_names() | _get_last_names()


def passes_filter(text: str, filter_mode: str, charset: str) -> bool:
    """Check if a solver result passes the word/name filter.

    filter_mode: "none", "words", "names", "both"
    charset: the charset used for solving (e.g. "lowercase", "full_name_capitalized")
    """
    if filter_mode == "none":
        return True

    text_lower = text.lower().strip()
    if not text_lower:
        return False

    is_name_charset = charset in ("full_name_capitalized", "full_name_caps")

    if is_name_charset:
        # Multi-word: check each word
        parts = text_lower.split()
        if len(parts) < 2:
            return False
        first = parts[0]
        last = parts[-1]
        if filter_mode == "names" or filter_mode == "both":
            first_ok = first in _get_first_names() or first in _get_last_names()
            last_ok = last in _get_last_names() or last in _get_first_names()
            if first_ok and last_ok:
                return True
        if filter_mode == "words" or filter_mode == "both":
            if all(w in _get_words() for w in parts):
                return True
        return False
    else:
        # Single word
        if filter_mode in ("words", "both") and text_lower in _get_words():
            return True
        if filter_mode in ("names", "both") and text_lower in _get_all_names():
            return True
        return False
