# Email Unredaction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an "emails" solve mode that matches known Epstein-network email addresses against pixel-width gaps using kerning-aware font metrics.

**Architecture:** Build `emails.txt` from 3 public data sources + hardcoded court-verified addresses via a build script. Add "emails" as a solve mode in the backend that reuses the existing `solve_dictionary()` function from `dictionary.py`. Add the option to the frontend dropdown.

**Tech Stack:** Python (build script: `datasets` for HuggingFace parquet, `httpx` for API), existing `solve_dictionary()` for width matching, vanilla JS frontend.

---

### Task 1: Build Script — Fetch and Merge Email Addresses

**Files:**
- Create: `scripts/build_emails.py`
- Create: `unredact/data/emails.txt` (output, gitignored like other data)

**Step 1: Write the build script**

Create `scripts/build_emails.py` that:

1. Downloads the HuggingFace dataset `notesbymuneeb/epstein-emails` (parquet), extracts unique email addresses from `sender` and `recipients` fields using regex `[\w.+-]+@[\w.-]+\.\w{2,}`
2. Fetches from Epstein Exposed API: paginate `GET https://epsteinexposed.com/api/v1/persons?per_page=100&page=N`, extract emails from each person's contact data
3. Downloads `extracted_entities_filtered.json` from rhowardstone (already cached by `build_associates.py`), extracts items where entity type contains "email"
4. Adds hardcoded court-verified addresses (8 total)
5. Merges all, lowercases, deduplicates, validates format with regex, sorts, writes one-per-line to `unredact/data/emails.txt`

```python
#!/usr/bin/env python3
"""Build emails.txt from public Epstein-network data sources.

Usage:
    python scripts/build_emails.py [--data-dir PATH]

Sources:
    1. HuggingFace notesbymuneeb/epstein-emails (parquet)
    2. Epstein Exposed Black Book API (epsteinexposed.com)
    3. rhowardstone extracted_entities_filtered.json
    4. Court-verified hardcoded addresses
"""

import argparse
import json
import re
import time
from pathlib import Path

OUTPUT_PATH = Path(__file__).parent.parent / "unredact" / "data" / "emails.txt"

EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w{2,}")

COURT_VERIFIED = [
    "jeevacation@gmail.com",
    "jeeproject@gmail.com",
    "jeeproject@hotmail.com",
    "jeeholidays@gmail.com",
    "jeeproject@yahoo.com",
    "jeffreye@mindspring.com",
    "zorroranch@aol.com",
    "gmax1@mindspring.com",
]


def fetch_huggingface(cache_dir: Path) -> set[str]:
    """Extract unique emails from the notesbymuneeb/epstein-emails dataset."""
    import pandas as pd

    parquet_path = cache_dir / "epstein_emails.parquet"
    if not parquet_path.exists():
        import urllib.request
        url = "https://huggingface.co/datasets/notesbymuneeb/epstein-emails/resolve/main/data/train-00000-of-00001.parquet"
        print(f"Downloading HuggingFace dataset...")
        urllib.request.urlretrieve(url, parquet_path)
        print(f"  -> saved to {parquet_path}")

    df = pd.read_parquet(parquet_path)
    emails = set()

    for _, row in df.iterrows():
        # Extract from sender field
        sender = str(row.get("sender", ""))
        emails.update(EMAIL_RE.findall(sender))

        # Extract from recipients (may be JSON array string)
        recipients = row.get("recipients", "")
        if isinstance(recipients, list):
            for r in recipients:
                emails.update(EMAIL_RE.findall(str(r)))
        else:
            emails.update(EMAIL_RE.findall(str(recipients)))

        # Also scan messages JSON for email addresses
        messages = str(row.get("messages", ""))
        emails.update(EMAIL_RE.findall(messages))

    print(f"  HuggingFace: {len(emails)} unique emails")
    return emails


def fetch_epstein_exposed() -> set[str]:
    """Fetch emails from the Epstein Exposed Black Book API."""
    import urllib.request

    emails = set()
    page = 1
    while True:
        url = f"https://epsteinexposed.com/api/v1/persons?per_page=100&page={page}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "unredact-build/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
        except Exception as e:
            print(f"  Epstein Exposed API error on page {page}: {e}")
            break

        persons = data.get("data", [])
        if not persons:
            break

        for person in persons:
            # Check various fields where emails might be
            for field in ("email", "emails", "contact", "contacts"):
                val = person.get(field, "")
                if isinstance(val, list):
                    for v in val:
                        emails.update(EMAIL_RE.findall(str(v)))
                elif val:
                    emails.update(EMAIL_RE.findall(str(val)))

            # Also check nested blackBookEntry if present
            bb = person.get("blackBookEntry", {})
            if isinstance(bb, dict):
                for val in bb.values():
                    emails.update(EMAIL_RE.findall(str(val)))

        meta = data.get("meta", {})
        total = meta.get("total", 0)
        if page * 100 >= total:
            break
        page += 1
        time.sleep(1)  # Rate limit: 60 req/min

    print(f"  Epstein Exposed: {len(emails)} unique emails")
    return emails


def fetch_rhowardstone(cache_dir: Path) -> set[str]:
    """Extract emails from rhowardstone extracted_entities_filtered.json."""
    import urllib.request

    entities_path = cache_dir / "extracted_entities_filtered.json"
    if not entities_path.exists():
        url = "https://raw.githubusercontent.com/rhowardstone/Epstein-research-data/main/extracted_entities_filtered.json"
        print(f"  Downloading rhowardstone entities...")
        urllib.request.urlretrieve(url, entities_path)

    data = json.loads(entities_path.read_text())
    emails = set()

    if isinstance(data, list):
        for entity in data:
            # Entity might have type field indicating email
            etype = str(entity.get("type", "")).lower()
            value = str(entity.get("value", entity.get("text", entity.get("name", ""))))
            if "email" in etype or EMAIL_RE.match(value):
                emails.update(EMAIL_RE.findall(value))
    elif isinstance(data, dict):
        # Might be keyed by type
        for key, values in data.items():
            if "email" in key.lower():
                if isinstance(values, list):
                    for v in values:
                        emails.update(EMAIL_RE.findall(str(v)))

    print(f"  rhowardstone: {len(emails)} unique emails")
    return emails


def main():
    parser = argparse.ArgumentParser(description="Build emails.txt from public data sources")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).parent / ".cache",
                        help="Directory to cache downloaded data files")
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)

    all_emails: set[str] = set()

    # Source 1: HuggingFace
    try:
        all_emails |= fetch_huggingface(args.data_dir)
    except Exception as e:
        print(f"  HuggingFace fetch failed: {e}")

    # Source 2: Epstein Exposed API
    try:
        all_emails |= fetch_epstein_exposed()
    except Exception as e:
        print(f"  Epstein Exposed fetch failed: {e}")

    # Source 3: rhowardstone
    try:
        all_emails |= fetch_rhowardstone(args.data_dir)
    except Exception as e:
        print(f"  rhowardstone fetch failed: {e}")

    # Source 4: Court-verified
    all_emails.update(COURT_VERIFIED)
    print(f"  Court-verified: {len(COURT_VERIFIED)} emails")

    # Clean up: lowercase, validate, sort
    cleaned = set()
    for email in all_emails:
        email = email.lower().strip()
        if EMAIL_RE.fullmatch(email) and len(email) >= 5:
            cleaned.add(email)

    sorted_emails = sorted(cleaned)
    print(f"\nTotal unique emails: {len(sorted_emails)}")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text("\n".join(sorted_emails) + "\n")
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
```

**Step 2: Run the build script**

Run: `python scripts/build_emails.py`
Expected: Downloads data, prints counts per source, writes `unredact/data/emails.txt`

**Step 3: Add Makefile target**

Add to `Makefile` after the `build-associates` target:

```makefile
build-emails:
	$(PYTHON) scripts/build_emails.py
```

**Step 4: Commit**

```bash
git add scripts/build_emails.py Makefile
git commit -m "feat: add build script for known email addresses data"
```

---

### Task 2: Backend — Add "emails" Solve Mode

**Files:**
- Modify: `unredact/pipeline/word_filter.py` — add `_get_emails()` loader
- Modify: `unredact/app.py:260-360` — add "emails" mode branch in solve endpoint

**Step 1: Write the failing test**

Create test in `tests/test_app.py` or a new `tests/test_email_solve.py`:

```python
# tests/test_email_solve.py
import pytest
from PIL import ImageFont
from unittest.mock import patch

from unredact.pipeline.dictionary import solve_dictionary
from unredact.pipeline.word_filter import _get_emails


def _get_test_font() -> ImageFont.FreeTypeFont:
    import subprocess
    result = subprocess.run(
        ["fc-match", "--format=%{file}", "Liberation Serif"],
        capture_output=True, text=True,
    )
    return ImageFont.truetype(result.stdout.strip(), 40)


class TestEmailSolve:
    def test_get_emails_loads_file(self, tmp_path):
        """_get_emails() should load emails from emails.txt."""
        import unredact.pipeline.word_filter as wf
        old = wf._emails
        try:
            wf._emails = None  # reset cache
            # Patch DATA_DIR to use tmp
            emails_file = tmp_path / "emails.txt"
            emails_file.write_text("test@example.com\nfoo@bar.org\n")
            with patch.object(wf, "DATA_DIR", tmp_path):
                result = wf._get_emails()
                assert "test@example.com" in result
                assert "foo@bar.org" in result
                assert len(result) == 2
        finally:
            wf._emails = old

    def test_email_width_matching(self):
        """Known emails that fit the pixel width should be returned."""
        font = _get_test_font()
        entries = ["test@example.com", "short@x.co", "verylongemailaddress@domain.com"]
        target = font.getlength("test@example.com")
        results = solve_dictionary(font, entries, target, tolerance=0.5)
        texts = [r.text for r in results]
        assert "test@example.com" in texts

    def test_email_with_angle_bracket_context(self):
        """Email matching should work with < > context characters."""
        font = _get_test_font()
        email = "test@example.com"
        entries = [email, "other@domain.com"]
        full_width = font.getlength("<" + email + ">")
        left_w = font.getlength("<")
        right_w = font.getlength(">")
        target = full_width - left_w - right_w
        results = solve_dictionary(
            font, entries, target, tolerance=1.0,
            left_context="<", right_context=">",
        )
        texts = [r.text for r in results]
        assert email in texts
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_email_solve.py -v`
Expected: `test_get_emails_loads_file` FAILS because `_get_emails` doesn't exist yet

**Step 3: Add email loader to word_filter.py**

In `unredact/pipeline/word_filter.py`, add after `_last_names` (line 18):

```python
_emails: list[str] | None = None

def _get_emails() -> list[str]:
    global _emails
    if _emails is None:
        path = DATA_DIR / "emails.txt"
        if path.exists():
            _emails = [line.strip().lower() for line in path.read_text().splitlines() if line.strip()]
        else:
            _emails = []
    return _emails
```

Note: returns a `list[str]` (not set) because we pass it directly to `solve_dictionary()` which expects a list.

**Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_email_solve.py -v`
Expected: All 3 tests PASS

**Step 5: Add "emails" mode to the solve endpoint**

In `unredact/app.py`, import `_get_emails`:

```python
from unredact.pipeline.word_filter import _get_emails
```

In the `event_generator()` function inside `solve()` (around line 273), add an `"emails"` mode branch. Insert before the `if req.mode in ("enumerate", "both")` block:

```python
            if req.mode == "emails":
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
```

**Step 6: Run tests**

Run: `python -m pytest tests/test_email_solve.py tests/test_app.py -v`
Expected: PASS

**Step 7: Commit**

```bash
git add unredact/pipeline/word_filter.py unredact/app.py tests/test_email_solve.py
git commit -m "feat: add emails solve mode with kerning-aware width matching"
```

---

### Task 3: Frontend — Add "Emails" to Solve Mode Dropdown

**Files:**
- Modify: `unredact/static/index.html:99-103` — add option to mode dropdown

**Step 1: Add the option**

In `unredact/static/index.html`, inside the `<select id="solve-mode">` (line 99-103), add:

```html
<option value="emails">Emails</option>
```

after the existing options, so it becomes:

```html
<select id="solve-mode">
  <option value="enumerate">Enumerate</option>
  <option value="dictionary">Dictionary</option>
  <option value="both">Both</option>
  <option value="emails">Emails</option>
</select>
```

No JS changes needed — `solveMode.value` already sends whatever is selected, and the backend handles the new `"emails"` value.

**Step 2: Manual test**

1. Run `make run`
2. Open browser, upload a PDF
3. Select a line, click on a gap segment
4. Change mode dropdown to "Emails"
5. Click Solve — should see email matches (or empty if no emails fit)

**Step 3: Commit**

```bash
git add unredact/static/index.html
git commit -m "feat: add Emails option to solve mode dropdown"
```

---

### Task 4: Build the Data and Verify End-to-End

**Step 1: Install build dependencies**

Run: `pip install pandas pyarrow` (needed for HuggingFace parquet)

**Step 2: Run the build script**

Run: `make build-emails`
Expected: Downloads sources, prints per-source counts, writes `unredact/data/emails.txt`

**Step 3: Verify the data file**

Run: `wc -l unredact/data/emails.txt && head -20 unredact/data/emails.txt`
Expected: Hundreds of email addresses, one per line, sorted alphabetically

**Step 4: Run all tests**

Run: `make test`
Expected: All tests pass including the new email solve tests

**Step 5: Manual end-to-end test**

1. `make run`
2. Upload an Epstein case PDF with redacted emails
3. Select a line with `< [REDACTED] >` pattern
4. Set mode to "Emails", tolerance to 1-2px
5. Click Solve — should show matching known emails sorted by width error

**Step 6: Commit data file**

```bash
git add unredact/data/emails.txt
git commit -m "data: add known email addresses from public sources"
```
