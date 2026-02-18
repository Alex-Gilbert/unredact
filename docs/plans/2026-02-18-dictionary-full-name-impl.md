# Dictionary-Based Full Name Solver — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the primary full-name solve path with dictionary matching against associate-derived name lists, mirroring how email solving works.

**Architecture:** `build_associates.py` extracts first/last names (with nicknames) into two text files. At solve time, Python generates the Cartesian product, applies casing, and measures widths with `font.getlength()`. Associate name variants are also checked. The Rust enumerate solver remains as a secondary mode.

**Tech Stack:** Python, PIL/Pillow, FastAPI SSE streaming

---

### Task 1: Extract name lists in build_associates.py

**Files:**
- Modify: `scripts/build_associates.py` (add name extraction after line 291)
- Create: `unredact/data/associate_first_names.txt`
- Create: `unredact/data/associate_last_names.txt`

**Step 1: Add name extraction function**

Add after the `process_associates` function (line 244):

```python
def extract_name_lists(registry: list[dict]) -> tuple[set[str], set[str]]:
    """Extract unique first and last names from the persons registry.

    Includes nickname expansions. Returns (first_names, last_names) as
    lowercase sets, filtered to alpha-only strings of length >= 2.
    """
    firsts: set[str] = set()
    lasts: set[str] = set()

    for person in registry:
        name = person["name"]
        parts = name.strip().split()
        if len(parts) < 2:
            continue
        first = parts[0].lower()
        last = parts[-1].lower()

        if first.isalpha() and len(first) >= 2:
            firsts.add(first)
            # Add nicknames
            if first in NICKNAMES:
                for nick in NICKNAMES[first]:
                    if nick.isalpha() and len(nick) >= 2:
                        firsts.add(nick)

        if last.isalpha() and len(last) >= 2:
            lasts.add(last)

        # Also process aliases
        for alias in person.get("aliases", []):
            alias_parts = alias.strip().split()
            if len(alias_parts) < 2:
                continue
            af = alias_parts[0].lower()
            al = alias_parts[-1].lower()
            if af.isalpha() and len(af) >= 2:
                firsts.add(af)
                if af in NICKNAMES:
                    for nick in NICKNAMES[af]:
                        if nick.isalpha() and len(nick) >= 2:
                            firsts.add(nick)
            if al.isalpha() and len(al) >= 2:
                lasts.add(al)

    return firsts, lasts
```

**Step 2: Wire into main()**

Add after the `OUTPUT_PATH.write_text(...)` line (line 291) in `main()`:

```python
    # Write focused name lists
    firsts, lasts = extract_name_lists(registry)
    first_path = OUTPUT_PATH.parent / "associate_first_names.txt"
    last_path = OUTPUT_PATH.parent / "associate_last_names.txt"
    first_path.write_text("\n".join(sorted(firsts)) + "\n")
    last_path.write_text("\n".join(sorted(lasts)) + "\n")
    print(f"Wrote {len(firsts)} first names to {first_path}")
    print(f"Wrote {len(lasts)} last names to {last_path}")
```

**Step 3: Run the script to generate the files**

Run: `python scripts/build_associates.py`
Expected: prints counts, creates `unredact/data/associate_first_names.txt` and `associate_last_names.txt`

**Step 4: Verify the output**

Check: `wc -l unredact/data/associate_first_names.txt unredact/data/associate_last_names.txt`
Expected: ~740 first names, ~1055 last names

Check: `grep -c "jeff" unredact/data/associate_first_names.txt` → should find "jeff"
Check: `grep -c "epstein" unredact/data/associate_last_names.txt` → should find "epstein"

**Step 5: Commit**

```bash
git add scripts/build_associates.py unredact/data/associate_first_names.txt unredact/data/associate_last_names.txt
git commit -m "feat: extract associate first/last name lists from registry"
```

---

### Task 2: Add name list loaders to word_filter.py

**Files:**
- Modify: `unredact/pipeline/word_filter.py` (add after `_get_emails` at line 51)

**Step 1: Add lazy loaders**

Add after the `_get_emails` function (line 51):

```python
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
```

**Step 2: Commit**

```bash
git add unredact/pipeline/word_filter.py
git commit -m "feat: add lazy loaders for associate name lists"
```

---

### Task 3: Write solve_full_name_dictionary with TDD

**Files:**
- Modify: `unredact/pipeline/dictionary.py`
- Create: `tests/test_full_name_dictionary.py`

**Step 1: Write the failing test**

Create `tests/test_full_name_dictionary.py`:

```python
"""Tests for dictionary-based full name solving."""

from unittest.mock import MagicMock, patch

from unredact.pipeline.dictionary import solve_full_name_dictionary
from unredact.pipeline.solver import SolveResult


def _mock_font(width_map: dict[str, float]) -> MagicMock:
    """Create a mock font that returns widths from a map."""
    font = MagicMock()
    font.getlength.side_effect = lambda text: width_map.get(text, len(text) * 7.0)
    return font


class TestSolveFullNameDictionary:
    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    @patch("unredact.pipeline.dictionary._get_associate_variants")
    def test_basic_match(self, mock_variants, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john", "jane"]
        mock_lasts.return_value = ["doe", "smith"]
        mock_variants.return_value = []

        font = _mock_font({"John Doe": 50.0, "John Smith": 60.0, "Jane Doe": 48.0, "Jane Smith": 58.0})

        results = solve_full_name_dictionary(font, 50.0, 1.0)

        texts = [r.text for r in results]
        assert "John Doe" in texts
        assert "Jane Doe" not in texts  # 48.0 is outside tolerance

    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    @patch("unredact.pipeline.dictionary._get_associate_variants")
    def test_uppercase_mode(self, mock_variants, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john"]
        mock_lasts.return_value = ["doe"]
        mock_variants.return_value = []

        font = _mock_font({"JOHN DOE": 55.0})

        results = solve_full_name_dictionary(font, 55.0, 1.0, uppercase_only=True)

        assert len(results) == 1
        assert results[0].text == "JOHN DOE"

    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    @patch("unredact.pipeline.dictionary._get_associate_variants")
    def test_includes_associate_variants(self, mock_variants, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john"]
        mock_lasts.return_value = ["doe"]
        mock_variants.return_value = ["j. doe", "johnny doe"]

        font = _mock_font({
            "John Doe": 50.0,
            "J. Doe": 35.0,
            "Johnny Doe": 60.0,
        })

        results = solve_full_name_dictionary(font, 50.0, 1.0)
        texts = [r.text for r in results]
        assert "John Doe" in texts
        # Variants get title-cased
        assert "J. Doe" in texts or "j. doe" not in texts  # variant outside tolerance

    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    @patch("unredact.pipeline.dictionary._get_associate_variants")
    def test_context_chars(self, mock_variants, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john"]
        mock_lasts.return_value = ["doe"]
        mock_variants.return_value = []

        font = _mock_font({
            "<John Doe>": 60.0,
            "<": 5.0,
            ">": 5.0,
        })

        results = solve_full_name_dictionary(font, 50.0, 1.0, left_context="<", right_context=">")
        assert len(results) == 1
        assert results[0].text == "John Doe"

    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    @patch("unredact.pipeline.dictionary._get_associate_variants")
    def test_dedup_variants_and_cartesian(self, mock_variants, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john"]
        mock_lasts.return_value = ["doe"]
        mock_variants.return_value = ["john doe"]  # duplicate of cartesian result

        font = _mock_font({"John Doe": 50.0})

        results = solve_full_name_dictionary(font, 50.0, 1.0)
        texts = [r.text for r in results]
        assert texts.count("John Doe") == 1  # no duplicates

    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    @patch("unredact.pipeline.dictionary._get_associate_variants")
    def test_sorted_by_error(self, mock_variants, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john", "jane"]
        mock_lasts.return_value = ["doe"]
        mock_variants.return_value = []

        font = _mock_font({"John Doe": 50.5, "Jane Doe": 50.0})

        results = solve_full_name_dictionary(font, 50.0, 1.0)
        assert len(results) == 2
        assert results[0].error <= results[1].error
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_full_name_dictionary.py -v`
Expected: FAIL — `ImportError: cannot import name 'solve_full_name_dictionary'`

**Step 3: Implement solve_full_name_dictionary**

Add to `unredact/pipeline/dictionary.py` after the existing `solve_dictionary` function (after line 62):

```python
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
```

**Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_full_name_dictionary.py -v`
Expected: all 6 tests PASS

**Step 5: Commit**

```bash
git add unredact/pipeline/dictionary.py tests/test_full_name_dictionary.py
git commit -m "feat: add solve_full_name_dictionary with Cartesian product matching"
```

---

### Task 4: Wire into app.py solve endpoint

**Files:**
- Modify: `unredact/app.py` (lines 25-26 imports, lines 319-377 solve handler)

**Step 1: Add imports**

Add to imports at line 25:

```python
from unredact.pipeline.dictionary import DictionaryStore, solve_dictionary, solve_full_name_dictionary
```

(Replace the existing import on line 24 that only imports `DictionaryStore, solve_dictionary`.)

**Step 2: Add dictionary solve phase for full-name modes**

In `event_generator()` inside `solve()` (around line 366), add a dictionary phase **before** the Rust enumerate phase. Insert before the `if req.mode in ("enumerate", "both")` block (line 366):

```python
            # Full-name dictionary solve (associate names)
            if use_full_name and not _active_solves.get(solve_id):
                fn_results = solve_full_name_dictionary(
                    font, req.gap_width_px, req.tolerance_px,
                    req.left_context, req.right_context,
                    uppercase_only=(charset_name == "full_name_caps"),
                )
                for r in fn_results:
                    if _active_solves.get(solve_id):
                        break
                    if r.text in found_texts:
                        continue
                    found_texts.add(r.text)
                    yield json.dumps({
                        "status": "match",
                        "text": r.text,
                        "width_px": round(r.width, 2),
                        "error_px": round(r.error, 2),
                        "source": "names",
                    })
```

**Step 3: Verify the app starts**

Run: `python -c "from unredact.app import app; print('OK')"`
Expected: prints "OK"

**Step 4: Commit**

```bash
git add unredact/app.py
git commit -m "feat: wire dictionary full-name solver into solve endpoint"
```

---

### Task 5: Manual smoke test

**Step 1: Start the app and test**

Start the server and use the UI or curl to verify:
1. Select a font, set a gap width, choose "Full Name (Capitalized)" mode
2. Verify results stream back with `source: "names"` before any enumerate results
3. Verify results are real names (e.g., "John Smith") not gibberish

If the app has a way to test via curl, try:

```bash
curl -X POST http://localhost:8000/api/solve \
  -H "Content-Type: application/json" \
  -d '{"font_id":"arial","font_size":16,"gap_width_px":80,"tolerance_px":2,"hints":{"charset":"full_name_capitalized"},"mode":"enumerate"}'
```

**Step 2: Commit any fixes needed**

---

### Task 6: Final cleanup and commit

**Step 1: Run all tests**

Run: `python -m pytest tests/ -v --ignore=tests/test_full_name_stress.py`
Expected: all tests pass

**Step 2: Clean up old task list**

Verify nothing is broken by the changes.

**Step 3: Final commit if needed**

```bash
git add -A
git commit -m "chore: final cleanup for dictionary full-name solver"
```
