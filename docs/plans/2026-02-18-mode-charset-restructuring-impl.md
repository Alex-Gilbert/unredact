# Mode/Charset Restructuring — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure UI modes (name/full_name/email/enumerate) and charsets (lowercase/uppercase/capitalized), rename filter prefix/suffix to known start/end, fix dictionary mode width measurement with known start/end.

**Architecture:** Frontend dropdowns are simplified. Backend dispatches by mode to the appropriate solver function. New `solve_name_dictionary()` for single-word name matching. Existing functions updated for casing and known_start/known_end. DictionaryStore removed.

**Tech Stack:** Python, FastAPI, HTML/JS, PIL/Pillow

---

### Task 1: Add `solve_name_dictionary()` with TDD

**Files:**
- Modify: `unredact/pipeline/dictionary.py`
- Create: `tests/test_name_dictionary.py`

**Step 1: Write the failing test**

Create `tests/test_name_dictionary.py`:

```python
"""Tests for dictionary-based single-name solving."""

from unittest.mock import MagicMock, patch

from unredact.pipeline.dictionary import solve_name_dictionary
from unredact.pipeline.solver import SolveResult


def _mock_font(width_map: dict[str, float]) -> MagicMock:
    """Create a mock font that returns widths from a map."""
    font = MagicMock()
    font.getlength.side_effect = lambda text: width_map.get(text, len(text) * 7.0)
    return font


class TestSolveNameDictionary:
    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    def test_basic_lowercase(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john", "jane"]
        mock_lasts.return_value = ["doe", "smith"]

        font = _mock_font({"john": 30.0, "jane": 28.0, "doe": 20.0, "smith": 32.0})

        results = solve_name_dictionary(font, 30.0, 1.0)
        texts = [r.text for r in results]
        assert "john" in texts
        assert "doe" not in texts  # 20.0 is outside tolerance

    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    def test_uppercase_casing(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john"]
        mock_lasts.return_value = []

        font = _mock_font({"JOHN": 35.0})

        results = solve_name_dictionary(font, 35.0, 1.0, casing="uppercase")
        assert len(results) == 1
        assert results[0].text == "JOHN"

    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    def test_capitalized_casing(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john"]
        mock_lasts.return_value = []

        font = _mock_font({"John": 32.0})

        results = solve_name_dictionary(font, 32.0, 1.0, casing="capitalized")
        assert len(results) == 1
        assert results[0].text == "John"

    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    def test_known_start_filters_and_strips(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["joe", "john", "bob"]
        mock_lasts.return_value = []

        # Gap width is for "oe" (the unknown part after "j")
        font = _mock_font({"oe": 14.0, "ohn": 21.0})

        results = solve_name_dictionary(
            font, 14.0, 1.0, known_start="j",
        )
        texts = [r.text for r in results]
        assert "joe" in texts  # "j" + "oe", "oe" width matches
        assert "bob" not in texts  # doesn't start with "j"

    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    def test_known_end_filters_and_strips(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["johnson", "jackson"]
        mock_lasts.return_value = []

        # Gap width is for "john" (the unknown part before "son")
        font = _mock_font({"john": 30.0, "jack": 28.0})

        results = solve_name_dictionary(
            font, 30.0, 1.0, known_end="son",
        )
        texts = [r.text for r in results]
        assert "johnson" in texts
        assert "jackson" not in texts  # doesn't end with "son"

    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    def test_dedup_first_and_last(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["lee"]
        mock_lasts.return_value = ["lee"]  # same name in both lists

        font = _mock_font({"lee": 20.0})

        results = solve_name_dictionary(font, 20.0, 1.0)
        assert len(results) == 1  # no duplicates

    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    def test_sorted_by_error(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john", "jane"]
        mock_lasts.return_value = []

        font = _mock_font({"john": 30.5, "jane": 30.0})

        results = solve_name_dictionary(font, 30.0, 1.0)
        assert len(results) == 2
        assert results[0].error <= results[1].error

    @patch("unredact.pipeline.dictionary._get_associate_firsts")
    @patch("unredact.pipeline.dictionary._get_associate_lasts")
    def test_context_chars(self, mock_lasts, mock_firsts):
        mock_firsts.return_value = ["john"]
        mock_lasts.return_value = []

        font = _mock_font({
            "<john>": 45.0,
            "<": 5.0,
            ">": 5.0,
        })

        results = solve_name_dictionary(
            font, 30.0, 5.0, left_context="<", right_context=">",
        )
        # Width = 45 - 5 - 5 = 35, error = |35-30| = 5, within tolerance
        assert len(results) == 1
        assert results[0].text == "john"
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_name_dictionary.py -v`
Expected: FAIL — `ImportError: cannot import name 'solve_name_dictionary'`

**Step 3: Implement `solve_name_dictionary`**

Add to `unredact/pipeline/dictionary.py` after `solve_full_name_dictionary`:

```python
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
        unknown = name[len(known_start):len(name) - len(known_end) if known_end else len(name)]
        # Apply same casing to unknown portion
        if casing == "uppercase":
            unknown_display = unknown.upper()
        elif casing == "capitalized":
            # For single word, only first char is upper if at start of word
            # But since known_start is stripped, unknown is mid-word: lowercase
            unknown_display = unknown.lower() if known_start else unknown.title()
        else:
            unknown_display = unknown

        if not unknown_display:
            continue  # entire name is known, nothing to measure

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
```

**Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_name_dictionary.py -v`
Expected: all 8 tests PASS

**Step 5: Commit**

```bash
git add unredact/pipeline/dictionary.py tests/test_name_dictionary.py
git commit -m "feat: add solve_name_dictionary for single-word associate name matching"
```

---

### Task 2: Update `solve_full_name_dictionary()` — add casing and known_start/known_end

**Files:**
- Modify: `unredact/pipeline/dictionary.py` (update `solve_full_name_dictionary`)
- Modify: `tests/test_full_name_dictionary.py` (update tests)

**Step 1: Update the function signature and implementation**

Change `solve_full_name_dictionary` in `unredact/pipeline/dictionary.py`:

Replace parameter `uppercase_only: bool = False` with:
```python
    casing: str = "lowercase",
    known_start: str = "",
    known_end: str = "",
```

Update the casing logic inside the function:
- Replace `if uppercase_only:` checks with casing-based logic:
  - `"uppercase"`: `(first + " " + last).upper()`
  - `"capitalized"`: `first.title() + " " + last.title()`
  - `"lowercase"`: `first + " " + last`

For variants:
  - `"uppercase"`: `variant.upper()`
  - `"capitalized"`: `variant.title()`
  - `"lowercase"`: `variant`

Add known_start/known_end filtering:
- Before checking width, filter candidates by starts-with/ends-with
- Measure only the unknown portion (strip known_start from front, known_end from back)
- Display the full name

**Step 2: Update tests**

In `tests/test_full_name_dictionary.py`:
- Replace `uppercase_only=True` with `casing="uppercase"` in `test_uppercase_mode`
- Add a test for `casing="capitalized"` (existing default behavior)
- Add a test for `known_start` with full names

**Step 3: Run tests**

Run: `python -m pytest tests/test_full_name_dictionary.py tests/test_name_dictionary.py -v`
Expected: all tests PASS

**Step 4: Commit**

```bash
git add unredact/pipeline/dictionary.py tests/test_full_name_dictionary.py
git commit -m "feat: update solve_full_name_dictionary with casing and known_start/known_end"
```

---

### Task 3: Update frontend HTML — modes, charsets, and field names

**Files:**
- Modify: `unredact/static/index.html`

**Step 1: Replace the charset dropdown (lines 84-92)**

Replace the current `<select id="solve-charset">` contents with:
```html
<option value="lowercase">lowercase</option>
<option value="uppercase">UPPERCASE</option>
<option value="capitalized">Capitalized</option>
```

**Step 2: Replace the mode dropdown (lines 101-106)**

Replace the current `<select id="solve-mode">` contents with:
```html
<option value="name" selected>Name</option>
<option value="full_name">Full Name</option>
<option value="email">Email</option>
<option value="enumerate">Enumerate</option>
```

**Step 3: Rename filter prefix/suffix labels (lines 117-124)**

Change "Filter prefix" to "Known start" and `id="solve-filter-prefix"` to `id="solve-known-start"`.
Change "Filter suffix" to "Known end" and `id="solve-filter-suffix"` to `id="solve-known-end"`.
Update placeholders: `placeholder="e.g. j"` and `placeholder="e.g. son"`.

**Step 4: Add id to the filter label/container for show/hide (line 108-116)**

Wrap the Filter `<label>` in a container or add an id so JS can hide it:
Change `<label>` wrapping the filter `<select>` to `<label id="filter-label">`.

**Step 5: Commit**

```bash
git add unredact/static/index.html
git commit -m "feat: update HTML with new modes, charsets, and known start/end fields"
```

---

### Task 4: Update frontend JS — dom.js, solver.js, popover.js

**Files:**
- Modify: `unredact/static/dom.js`
- Modify: `unredact/static/solver.js`
- Modify: `unredact/static/popover.js`

**Step 1: Update dom.js**

Rename exports:
- `solveFilterPrefix` -> `solveKnownStart` (update getElementById to `"solve-known-start"`)
- `solveFilterSuffix` -> `solveKnownEnd` (update getElementById to `"solve-known-end"`)

Add new export:
```javascript
export const filterLabel = document.getElementById("filter-label");
```

**Step 2: Update solver.js**

Update imports to use new names (`solveKnownStart`, `solveKnownEnd`).

Update the request body (line 40-54):
```javascript
const body = {
    font_id: fontId,
    font_size: fontSize,
    gap_width_px: gapWidth,
    tolerance_px: parseFloat(solveTolerance.value),
    left_context: leftCtx,
    right_context: rightCtx,
    hints: {
        charset: solveCharset.value,
    },
    mode: solveMode.value,
    word_filter: solveFilter.value,
    known_start: solveKnownStart.value,
    known_end: solveKnownEnd.value,
};
```

**Step 3: Update popover.js**

Update imports to use new names (`solveKnownStart`, `solveKnownEnd`).

In `openPopover()`, update reset lines:
```javascript
solveKnownStart.value = "";
solveKnownEnd.value = "";
```

Add mode-change listener to show/hide filter dropdown. In `initPopover()` add:
```javascript
solveMode.addEventListener("change", () => {
    filterLabel.hidden = solveMode.value !== "enumerate";
});
// Initialize visibility
filterLabel.hidden = solveMode.value !== "enumerate";
```

Import `solveMode` and `filterLabel` from dom.js.

**Step 4: Commit**

```bash
git add unredact/static/dom.js unredact/static/solver.js unredact/static/popover.js
git commit -m "feat: update frontend JS for new modes, known start/end, and filter visibility"
```

---

### Task 5: Update backend app.py — new mode dispatch and cleanup

**Files:**
- Modify: `unredact/app.py`

**Step 1: Update SolveRequest model**

Change the defaults and rename fields:
```python
class SolveRequest(BaseModel):
    font_id: str
    font_size: int
    gap_width_px: float
    tolerance_px: float = 0.0
    left_context: str = ""
    right_context: str = ""
    hints: dict = {}
    mode: str = "name"  # "name", "full_name", "email", "enumerate"
    word_filter: str = "none"  # only used for enumerate mode
    known_start: str = ""
    known_end: str = ""
```

**Step 2: Rewrite the solve event_generator**

Replace the mode dispatch logic in `event_generator()`:

```python
async def event_generator():
    try:
        found_texts = set()
        charset_name = req.hints.get("charset", "lowercase")

        # Name mode: single-word associate names
        if req.mode == "name" and not _active_solves.get(solve_id):
            from unredact.pipeline.dictionary import solve_name_dictionary
            name_results = solve_name_dictionary(
                font, req.gap_width_px, req.tolerance_px,
                req.left_context, req.right_context,
                casing=charset_name,
                known_start=req.known_start,
                known_end=req.known_end,
            )
            for r in name_results:
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

        # Full name mode: first x last Cartesian product + variants
        if req.mode == "full_name" and not _active_solves.get(solve_id):
            fn_results = solve_full_name_dictionary(
                font, req.gap_width_px, req.tolerance_px,
                req.left_context, req.right_context,
                casing=charset_name,
                known_start=req.known_start,
                known_end=req.known_end,
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

        # Email mode
        if req.mode == "email" and not _active_solves.get(solve_id):
            entries = _get_emails()
            if entries:
                email_results = solve_dictionary(
                    font, entries, req.gap_width_px, req.tolerance_px,
                    req.left_context, req.right_context,
                )
                for r in email_results:
                    if _active_solves.get(solve_id):
                        break
                    found_texts.add(r.text)
                    yield json.dumps({
                        "status": "match",
                        "text": r.text,
                        "width_px": round(r.width, 2),
                        "error_px": round(r.error, 2),
                        "source": "emails",
                    })

        # Enumerate mode: Rust backend
        if req.mode == "enumerate" and not _active_solves.get(solve_id):
            use_full_name = charset_name in ("full_name_capitalized", "full_name_caps")

            if use_full_name:
                payload = _build_rust_full_name_payload(
                    font, req.gap_width_px, req.tolerance_px,
                    req.left_context, req.right_context,
                    uppercase_only=(charset_name == "full_name_caps"),
                )
            else:
                charset = CHARSETS.get(charset_name, charset_name)
                constraint = None
                if charset_name == "capitalized":
                    charset = CHARSETS["alpha"] + " "
                    constraint = build_constraint(charset_name, charset)
                payload = _build_rust_solve_payload(
                    font, charset, req.gap_width_px, req.tolerance_px,
                    req.left_context, req.right_context, constraint,
                )

            payload["filter"] = req.word_filter
            payload["filter_prefix"] = req.known_start
            payload["filter_suffix"] = req.known_end

            url = f"{SOLVER_URL}/solve/full-name" if use_full_name else f"{SOLVER_URL}/solve"

            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", url, json=payload) as resp:
                    buf = ""
                    async for chunk in resp.aiter_text():
                        if _active_solves.get(solve_id):
                            break
                        buf += chunk
                        while "\n" in buf:
                            line, buf = buf.split("\n", 1)
                            line = line.strip()
                            if not line.startswith("data: "):
                                continue
                            try:
                                r = json.loads(line[6:])
                            except (json.JSONDecodeError, ValueError):
                                continue
                            if r.get("done"):
                                break
                            text = r.get("text", "")
                            if text in found_texts:
                                continue
                            found_texts.add(text)
                            yield json.dumps({
                                "status": "match",
                                "text": text,
                                "width_px": round(r["width"], 2),
                                "error_px": round(r["error"], 2),
                                "source": "enumerate",
                            })

        yield json.dumps({
            "status": "done",
            "total_found": len(found_texts),
        })
    finally:
        _active_solves.pop(solve_id, None)
```

**Step 3: Remove DictionaryStore and dictionary endpoints**

Remove:
- `_dictionary_store = DictionaryStore()` (line 227)
- The `upload_dictionary`, `list_dictionaries`, `delete_dictionary` endpoints (lines 462-480)
- The `DictionaryStore` import (update line 24)

Update the import line to:
```python
from unredact.pipeline.dictionary import solve_dictionary, solve_full_name_dictionary
```

**Step 4: Remove `use_full_name` variable from top of event_generator**

The old `use_full_name = charset_name in (...)` check at line 319 is no longer needed outside the enumerate block.

**Step 5: Verify the app imports cleanly**

Run: `python -c "from unredact.app import app; print('OK')"`
Expected: prints "OK"

**Step 6: Commit**

```bash
git add unredact/app.py
git commit -m "feat: restructure solve endpoint with mode-based dispatch, remove DictionaryStore"
```

---

### Task 6: Run all tests and fix any breakage

**Files:**
- Potentially modify: any file with test failures

**Step 1: Run all tests**

Run: `python -m pytest tests/ -v --ignore=tests/test_full_name_stress.py`

Expected: all tests pass. If any fail due to the renamed fields or removed DictionaryStore, fix them.

**Step 2: Verify frontend loads**

Run: `python -c "from unredact.app import app; print('OK')"`

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve test failures from mode/charset restructuring"
```

---

### Task 7: Final cleanup

**Step 1: Remove unused CHARSETS entries if they cause issues**

The `width_table.py` CHARSETS dict still has "alpha", "alphanumeric", "printable" — these are used by the Rust enumerate path and should stay. No changes needed.

**Step 2: Verify no dead imports**

Check that `DictionaryStore` is not imported anywhere else.

**Step 3: Run full test suite one final time**

Run: `python -m pytest tests/ -v --ignore=tests/test_full_name_stress.py`
Expected: all pass

**Step 4: Commit if needed**

```bash
git add -A
git commit -m "chore: final cleanup for mode/charset restructuring"
```
