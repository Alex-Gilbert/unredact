# Associates Priority Dictionary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a tiered priority dictionary of known Epstein associates so solver results flag and sort recognized names to the top.

**Architecture:** A build script downloads the rhowardstone/Epstein-research-data `persons_registry.json` and `knowledge_graph_relationships.json`, processes them into a flat `associates.json` lookup file. The FastAPI backend serves it via a new endpoint. The frontend loads it on init and uses it to badge/sort solver results client-side.

**Tech Stack:** Python 3.12, FastAPI, vanilla JS. No new dependencies.

---

### Task 1: Build the associates data processor (core logic)

**Files:**
- Create: `scripts/build_associates.py`
- Create: `tests/test_build_associates.py`

This task covers only the **processing logic** — the functions that transform raw registry + relationship data into the associates lookup format. Downloading is a separate concern handled later.

**Step 1: Write the failing tests**

```python
# tests/test_build_associates.py
"""Tests for the associates data processing pipeline."""

import json
from scripts.build_associates import process_associates


def _sample_registry():
    """Minimal persons_registry.json structure."""
    return [
        {
            "name": "Jeffrey Epstein",
            "aliases": ["Jeff Epstein"],
            "category": "principal",
            "search_terms": [],
        },
        {
            "name": "Ghislaine Maxwell",
            "aliases": ["G. Maxwell"],
            "category": "staff",
            "search_terms": [],
        },
        {
            "name": "John Smith",
            "aliases": [],
            "category": "business",
            "search_terms": [],
        },
    ]


def _sample_relationships():
    """Minimal knowledge_graph_relationships.json structure."""
    return [
        {"source": "Jeffrey Epstein", "target": "Ghislaine Maxwell", "relationship_type": "associated_with"},
        {"source": "Jeffrey Epstein", "target": "John Smith", "relationship_type": "traveled_with"},
        {"source": "Ghislaine Maxwell", "target": "John Smith", "relationship_type": "associated_with"},
        {"source": "Ghislaine Maxwell", "target": "John Smith", "relationship_type": "associated_with"},
        {"source": "Ghislaine Maxwell", "target": "John Smith", "relationship_type": "associated_with"},
    ]


def test_process_returns_names_and_persons():
    result = process_associates(_sample_registry(), _sample_relationships())
    assert "names" in result
    assert "persons" in result


def test_tier1_traveled_with():
    """Person with traveled_with relationship should be tier 1."""
    result = process_associates(_sample_registry(), _sample_relationships())
    persons = result["persons"]
    # John Smith has traveled_with → tier 1
    john = next(p for p in persons.values() if p["name"] == "John Smith")
    assert john["tier"] == 1


def test_tier2_staff_category():
    """Person with staff category should be tier 2 (if no traveled_with)."""
    registry = [
        {"name": "Jane Doe", "aliases": [], "category": "staff", "search_terms": []},
    ]
    result = process_associates(registry, [])
    jane = next(p for p in result["persons"].values() if p["name"] == "Jane Doe")
    assert jane["tier"] == 2


def test_tier2_many_relationships():
    """Person with 3+ relationships (but no traveled_with) should be tier 2."""
    result = process_associates(_sample_registry(), _sample_relationships())
    persons = result["persons"]
    # Ghislaine has 4 relationships (1 associated_with from Epstein + 3 to John Smith) but no traveled_with
    ghislaine = next(p for p in persons.values() if p["name"] == "Ghislaine Maxwell")
    assert ghislaine["tier"] == 2


def test_tier3_default():
    """Person with few relationships and no special category should be tier 3."""
    registry = [
        {"name": "Nobody Special", "aliases": [], "category": "other", "search_terms": []},
    ]
    result = process_associates(registry, [])
    person = next(p for p in result["persons"].values() if p["name"] == "Nobody Special")
    assert person["tier"] == 3


def test_full_name_lookup():
    """Full name should be in the names lookup."""
    result = process_associates(_sample_registry(), _sample_relationships())
    names = result["names"]
    assert "jeffrey epstein" in names
    matches = names["jeffrey epstein"]
    assert any(m["match_type"] == "full" for m in matches)


def test_first_and_last_name_lookup():
    """First and last name should have separate lookup entries."""
    result = process_associates(_sample_registry(), _sample_relationships())
    names = result["names"]
    assert "jeffrey" in names
    assert "epstein" in names
    assert any(m["match_type"] == "first" for m in names["jeffrey"])
    assert any(m["match_type"] == "last" for m in names["epstein"])


def test_alias_generates_lookups():
    """Aliases from the registry should also generate lookup entries."""
    result = process_associates(_sample_registry(), _sample_relationships())
    names = result["names"]
    assert "jeff epstein" in names


def test_multiple_persons_same_name():
    """A common name like 'john' can match multiple persons."""
    result = process_associates(_sample_registry(), _sample_relationships())
    names = result["names"]
    # "john" should exist (from John Smith)
    assert "john" in names


def test_nickname_generation():
    """Common nicknames should be generated (Jeffrey → Jeff)."""
    result = process_associates(_sample_registry(), _sample_relationships())
    names = result["names"]
    assert "jeff" in names
    assert any(m["match_type"] == "nickname" for m in names["jeff"])
```

**Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_build_associates.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'scripts.build_associates'`

**Step 3: Write the processing implementation**

```python
# scripts/build_associates.py
"""Build the associates.json lookup file from rhowardstone/Epstein-research-data.

Usage:
    python scripts/build_associates.py [--data-dir PATH]

Downloads persons_registry.json and knowledge_graph_relationships.json if not
present, then processes them into unredact/data/associates.json.
"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

OUTPUT_PATH = Path(__file__).parent.parent / "unredact" / "data" / "associates.json"

# Common nickname mappings (canonical → [nicknames])
NICKNAMES = {
    "jeffrey": ["jeff"],
    "william": ["bill", "will", "willy", "billy"],
    "richard": ["rick", "dick", "rich"],
    "robert": ["rob", "bob", "bobby"],
    "james": ["jim", "jimmy", "jamie"],
    "michael": ["mike", "mikey"],
    "joseph": ["joe", "joey"],
    "thomas": ["tom", "tommy"],
    "charles": ["charlie", "chuck"],
    "christopher": ["chris"],
    "daniel": ["dan", "danny"],
    "matthew": ["matt"],
    "anthony": ["tony"],
    "donald": ["don", "donny"],
    "steven": ["steve"],
    "stephen": ["steve"],
    "edward": ["ed", "eddie", "ted"],
    "benjamin": ["ben"],
    "samuel": ["sam", "sammy"],
    "alexander": ["alex"],
    "nicholas": ["nick"],
    "jonathan": ["jon"],
    "timothy": ["tim", "timmy"],
    "andrew": ["andy", "drew"],
    "lawrence": ["larry"],
    "raymond": ["ray"],
    "gerald": ["gerry", "jerry"],
    "kenneth": ["ken", "kenny"],
    "elizabeth": ["liz", "beth", "lizzy"],
    "katherine": ["kate", "kathy", "katie"],
    "catherine": ["kate", "cathy", "katie"],
    "margaret": ["maggie", "meg", "peggy"],
    "jennifer": ["jen", "jenny"],
    "patricia": ["pat", "patty"],
    "virginia": ["ginny"],
    "victoria": ["vicky", "tori"],
    "deborah": ["deb", "debbie"],
    "dorothy": ["dot", "dotty"],
    "suzanne": ["sue", "suzy"],
    "alexandra": ["alex"],
}

# Tier 2 categories (staff/financial get auto-promoted)
TIER2_CATEGORIES = {"staff", "financial"}


def _compute_tiers(registry: list[dict], relationships: list[dict]) -> dict[str, int]:
    """Compute tier for each person name.

    Returns: {canonical_name: tier}
    """
    # Count relationships and check for traveled_with
    traveled = set()
    rel_counts: dict[str, int] = defaultdict(int)

    for rel in relationships:
        src = rel.get("source", "")
        tgt = rel.get("target", "")
        rtype = rel.get("relationship_type", "")

        rel_counts[src] += 1
        rel_counts[tgt] += 1

        if rtype == "traveled_with":
            traveled.add(src)
            traveled.add(tgt)

    tiers = {}
    for person in registry:
        name = person["name"]
        category = person.get("category", "other")

        if name in traveled:
            tiers[name] = 1
        elif category in TIER2_CATEGORIES or rel_counts.get(name, 0) >= 3:
            tiers[name] = 2
        else:
            tiers[name] = 3

    return tiers


def _add_name_entries(
    names: dict[str, list],
    text: str,
    person_id: str,
    tier: int,
    match_type: str,
):
    """Add a lookup entry for a name string (lowercased)."""
    key = text.lower().strip()
    if not key or len(key) < 2:
        return
    if key not in names:
        names[key] = []
    # Avoid duplicate entries for same person + match_type
    if not any(e["person_id"] == person_id and e["match_type"] == match_type for e in names[key]):
        names[key].append({"person_id": person_id, "match_type": match_type, "tier": tier})


def _split_name(full_name: str) -> tuple[str, str]:
    """Split a full name into (first, last). Returns ('', '') if can't split."""
    parts = full_name.strip().split()
    if len(parts) < 2:
        return ("", "")
    return (parts[0], parts[-1])


def _generate_lookups_for_name(
    names: dict[str, list],
    full_name: str,
    person_id: str,
    tier: int,
):
    """Generate all lookup entries for a single name string."""
    # Full name
    _add_name_entries(names, full_name, person_id, tier, "full")

    first, last = _split_name(full_name)
    if first and last:
        # First and last separately
        _add_name_entries(names, first, person_id, tier, "first")
        _add_name_entries(names, last, person_id, tier, "last")

        # Initials + last
        initial = first[0]
        _add_name_entries(names, f"{initial}. {last}", person_id, tier, "initial_last")
        _add_name_entries(names, f"{initial} {last}", person_id, tier, "initial_last")

        # Nicknames
        first_lower = first.lower()
        if first_lower in NICKNAMES:
            for nick in NICKNAMES[first_lower]:
                _add_name_entries(names, nick, person_id, tier, "nickname")
                _add_name_entries(names, f"{nick} {last}", person_id, tier, "nickname_full")


def process_associates(
    registry: list[dict],
    relationships: list[dict],
) -> dict:
    """Process raw registry + relationships into the associates lookup format.

    Returns: {"names": {str: [...]}, "persons": {str: {...}}}
    """
    tiers = _compute_tiers(registry, relationships)

    names: dict[str, list] = {}
    persons: dict[str, dict] = {}

    for i, person in enumerate(registry):
        person_id = f"p{i:04d}"
        canonical_name = person["name"]
        tier = tiers.get(canonical_name, 3)
        category = person.get("category", "other")

        persons[person_id] = {
            "name": canonical_name,
            "tier": tier,
            "category": category,
        }

        # Generate lookups for canonical name
        _generate_lookups_for_name(names, canonical_name, person_id, tier)

        # Generate lookups for each alias
        for alias in person.get("aliases", []):
            _generate_lookups_for_name(names, alias, person_id, tier)

    return {"names": names, "persons": persons}


def download_data(data_dir: Path) -> tuple[list, list]:
    """Download the rhowardstone data files if not already present.

    Returns: (registry, relationships)
    """
    import urllib.request

    base_url = "https://raw.githubusercontent.com/rhowardstone/Epstein-research-data/main"
    registry_path = data_dir / "persons_registry.json"
    rels_path = data_dir / "knowledge_graph_relationships.json"

    for filename, path in [("persons_registry.json", registry_path), ("knowledge_graph_relationships.json", rels_path)]:
        if not path.exists():
            url = f"{base_url}/{filename}"
            print(f"Downloading {url}...")
            urllib.request.urlretrieve(url, path)
            print(f"  → saved to {path}")

    registry = json.loads(registry_path.read_text())
    relationships = json.loads(rels_path.read_text())
    return registry, relationships


def main():
    parser = argparse.ArgumentParser(description="Build associates.json from Epstein research data")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).parent / ".cache",
                        help="Directory to cache downloaded data files")
    args = parser.parse_args()

    args.data_dir.mkdir(parents=True, exist_ok=True)

    registry, relationships = download_data(args.data_dir)
    print(f"Loaded {len(registry)} persons, {len(relationships)} relationships")

    result = process_associates(registry, relationships)
    print(f"Generated {len(result['names'])} name lookups for {len(result['persons'])} persons")

    tier_counts = defaultdict(int)
    for p in result["persons"].values():
        tier_counts[p["tier"]] += 1
    for tier in sorted(tier_counts):
        print(f"  Tier {tier}: {tier_counts[tier]} persons")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(result, indent=2))
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
```

**Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_build_associates.py -v`
Expected: All 10 tests PASS

**Step 5: Commit**

```bash
git add scripts/build_associates.py tests/test_build_associates.py
git commit -m "feat: add associates data processor with nickname generation and tiering"
```

---

### Task 2: Run the build script to generate associates.json

**Files:**
- Modify: `.gitignore` (add `scripts/.cache/`)
- Generate: `unredact/data/associates.json`

**Step 1: Add cache dir to gitignore**

Add `scripts/.cache/` to `.gitignore` — the downloaded raw data files shouldn't be committed.

**Step 2: Run the build script**

Run: `python scripts/build_associates.py`
Expected: Downloads the two JSON files, processes them, outputs `unredact/data/associates.json` with stats.

**Step 3: Verify the output**

Run: `python -c "import json; d=json.load(open('unredact/data/associates.json')); print(f'{len(d[\"names\"])} lookups, {len(d[\"persons\"])} persons')"`
Expected: Should show thousands of name lookups and ~1,614 persons.

**Step 4: Inspect the tiering**

Run: `python -c "import json; d=json.load(open('unredact/data/associates.json')); tiers={1:0,2:0,3:0}; [tiers.__setitem__(p['tier'], tiers[p['tier']]+1) for p in d['persons'].values()]; print(tiers)"`
Expected: Should show counts for each tier.

**Step 5: Decide on gitignoring associates.json**

The generated file is derived data. If it's small enough (<500KB), commit it so users don't need to run the build script. If larger, add `unredact/data/associates.json` to `.gitignore` and document the build step.

Check: `ls -lh unredact/data/associates.json`

**Step 6: Commit**

```bash
git add .gitignore unredact/data/associates.json  # or just .gitignore if ignoring
git commit -m "feat: generate associates.json with tiered Epstein network data"
```

---

### Task 3: API endpoint to serve associates data

**Files:**
- Modify: `unredact/app.py:27` (add import and endpoint)
- Modify: `tests/test_app.py` (add test)

**Step 1: Write the failing test**

Add to `tests/test_app.py`:

```python
@pytest.mark.anyio
async def test_get_associates():
    """GET /api/associates should return the associates lookup data."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/associates")
        assert resp.status_code == 200
        data = resp.json()
        assert "names" in data
        assert "persons" in data
        assert isinstance(data["names"], dict)
        assert isinstance(data["persons"], dict)
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_app.py::test_get_associates -v`
Expected: FAIL with 404 (no route)

**Step 3: Implement the endpoint**

In `unredact/app.py`, add after the `STATIC_DIR` line (~line 34):

```python
DATA_DIR = Path(__file__).parent / "data"

# Lazy-loaded associates data
_associates_data: dict | None = None

def _get_associates() -> dict:
    global _associates_data
    if _associates_data is None:
        associates_path = DATA_DIR / "associates.json"
        if associates_path.exists():
            _associates_data = json.loads(associates_path.read_text())
        else:
            _associates_data = {"names": {}, "persons": {}}
    return _associates_data
```

Add the endpoint before the static files mount:

```python
@app.get("/api/associates")
async def get_associates():
    return _get_associates()
```

**Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_app.py::test_get_associates -v`
Expected: PASS

**Step 5: Commit**

```bash
git add unredact/app.py tests/test_app.py
git commit -m "feat: add GET /api/associates endpoint"
```

---

### Task 4: Frontend — load associates data on init

**Files:**
- Modify: `unredact/static/app.js:51-65` (add to state and loading)

**Step 1: Add associates state**

In `app.js`, add to the `state` object (after line 64 `panY: 0,`):

```javascript
  associates: null,  // {names: {str: [...]}, persons: {str: {...}}}
```

**Step 2: Add loader function**

After the `loadFonts()` function (after line 98), add:

```javascript
async function loadAssociates() {
  try {
    const resp = await fetch("/api/associates");
    state.associates = await resp.json();
    console.log(`Loaded ${Object.keys(state.associates.names).length} associate lookups`);
  } catch (e) {
    console.warn("Failed to load associates data:", e);
    state.associates = { names: {}, persons: {} };
  }
}
```

**Step 3: Call loader during upload**

In `uploadFile()`, the font loading already happens in parallel with upload. Add associates loading the same way. Change line 123:

```javascript
  // Start font + associates loading in parallel with upload
  const fontPromise = loadFonts();
  const assocPromise = loadAssociates();
```

And change line 134:

```javascript
  await Promise.all([fontPromise, assocPromise]); // ensure both are ready before rendering
```

**Step 4: Verify manually**

Run: `uvicorn unredact.app:app --reload`
Open browser, upload a PDF, check browser console for "Loaded N associate lookups".

**Step 5: Commit**

```bash
git add unredact/static/app.js
git commit -m "feat: load associates data on document upload"
```

---

### Task 5: Frontend — match and badge solver results

**Files:**
- Modify: `unredact/static/app.js` (modify `handleSolveEvent`)
- Modify: `unredact/static/style.css` (add badge styles)

**Step 1: Add the matching function**

In `app.js`, before the `startSolve` function, add:

```javascript
// ── Associate matching ──

const MATCH_TYPE_WEIGHTS = {
  full: 4,
  nickname_full: 3,
  initial_last: 2,
  last: 2,
  first: 1,
  nickname: 1,
};

function matchAssociates(text) {
  if (!state.associates?.names) return [];
  const key = text.toLowerCase().trim();
  const matches = state.associates.names[key];
  if (!matches) return [];

  return matches.map(m => {
    const person = state.associates.persons[m.person_id];
    const weight = MATCH_TYPE_WEIGHTS[m.match_type] || 1;
    return {
      personId: m.person_id,
      personName: person?.name || "Unknown",
      category: person?.category || "other",
      tier: m.tier,
      matchType: m.match_type,
      score: m.tier * weight,
    };
  }).sort((a, b) => b.score - a.score);
}

function tierBadgeClass(tier) {
  if (tier === 1) return "tier-1";
  if (tier === 2) return "tier-2";
  return "tier-3";
}

function tierLabel(tier) {
  if (tier === 1) return "T1";
  if (tier === 2) return "T2";
  return "T3";
}
```

**Step 2: Modify handleSolveEvent to add badges**

Replace the `handleSolveEvent` function's `"match"` branch. The current code (around line 945-966) creates a result div. Change it to:

```javascript
function handleSolveEvent(data, gapIdx) {
  if (data.status === "match") {
    const assocMatches = matchAssociates(data.text);
    const topMatch = assocMatches.length > 0 ? assocMatches[0] : null;

    const div = document.createElement("div");
    div.className = "solve-result";
    if (topMatch) div.dataset.assocScore = topMatch.score;

    let badgeHtml = "";
    if (topMatch) {
      const cls = tierBadgeClass(topMatch.tier);
      const tooltip = `${topMatch.personName} (${topMatch.category}) — ${topMatch.matchType} match`;
      badgeHtml = `<span class="assoc-badge ${cls}" title="${escapeHtml(tooltip)}">${tierLabel(topMatch.tier)}</span>`;
    }

    div.innerHTML = `
      ${badgeHtml}
      <span class="result-text">${escapeHtml(data.text)}</span>
      <span class="result-error">${data.error_px.toFixed(1)}px ${data.source || ""}</span>
    `;
    div.addEventListener("click", () => {
      const override = ensureOverride();
      override.gapPreviews[gapIdx] = data.text;
      renderOverlay();
      renderSegmentInputs();
      solveResults.querySelectorAll(".solve-result").forEach(el => el.classList.remove("active"));
      div.classList.add("active");
      solveAccept.hidden = false;
    });

    // Insert sorted: associates first, by score descending
    if (topMatch) {
      let inserted = false;
      for (const existing of solveResults.children) {
        const existingScore = parseFloat(existing.dataset.assocScore || "0");
        if (topMatch.score > existingScore) {
          solveResults.insertBefore(div, existing);
          inserted = true;
          break;
        }
      }
      if (!inserted) solveResults.appendChild(div);
    } else {
      solveResults.appendChild(div);
    }

    solveStatus.textContent = `Found ${solveResults.children.length} matches`;
  } else if (data.status === "running") {
    solveStatus.textContent = `Checked ${data.checked}, found ${data.found}...`;
  } else if (data.status === "done") {
    solveStatus.textContent = `Done. ${data.total_found} total matches.`;
    solveStart.hidden = false;
    solveStop.hidden = true;
    activeEventSource = null;
  }
}
```

**Step 3: Add badge CSS**

In `style.css`, add at the end (after the `.solve-result .result-error` rule):

```css
/* Associate badges */
.assoc-badge {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  cursor: default;
  margin-right: 4px;
}

.assoc-badge.tier-1 {
  background: #d32f2f;
  color: #fff;
}

.assoc-badge.tier-2 {
  background: #e65100;
  color: #fff;
}

.assoc-badge.tier-3 {
  background: #f9a825;
  color: #000;
}
```

**Step 4: Verify manually**

Run: `uvicorn unredact.app:app --reload`
Upload a PDF, mark a redaction, solve with "Full Name" charset. Associates should appear at the top with colored tier badges. Hover a badge to see the tooltip with person details.

**Step 5: Commit**

```bash
git add unredact/static/app.js unredact/static/style.css
git commit -m "feat: badge and prioritize known associates in solver results"
```

---

### Task 6: Test the end-to-end flow and adjust

**Files:**
- Possibly adjust: `scripts/build_associates.py` (if rhowardstone JSON schema differs from assumptions)
- Possibly adjust: `unredact/static/app.js` (if UX needs tuning)

**Step 1: Run the full test suite**

Run: `python -m pytest tests/ -v`
Expected: All tests pass, including the new ones.

**Step 2: Manual end-to-end test**

1. Start the app: `uvicorn unredact.app:app --reload`
2. Start the Rust solver: (ensure it's running on port 3100)
3. Upload an Epstein PDF
4. Select a line with a redaction
5. Mark the redaction gap with Ctrl+Space
6. Open solve panel, select "Full Name" charset
7. Click Solve
8. Verify: results stream in, associates have colored badges, sorted to top
9. Hover a badge: should show person name, category, match type
10. Click a result: should preview in the gap
11. Click Accept: should merge

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: adjust associates integration based on e2e testing"
```

---

### Task 7: Final cleanup and documentation

**Files:**
- Modify: `Makefile` (add build-associates target if Makefile exists)

**Step 1: Add Makefile target**

If `Makefile` exists, add:

```makefile
build-associates:
	python scripts/build_associates.py
```

**Step 2: Final commit**

```bash
git add Makefile
git commit -m "chore: add Makefile target for building associates data"
```
