# Epstein Associates Priority Dictionary

**Date:** 2026-02-16
**Status:** Approved

## Problem

The solver currently uses generic name lists (~5K first names, ~89K last names) to filter results. These are "all names that exist" — not people connected to the Epstein case. We want to prioritize known Epstein associates in solver results so they surface first.

## Data Source

**[rhowardstone/Epstein-research-data](https://github.com/rhowardstone/Epstein-research-data)** — single source of truth.

Key files:
- `persons_registry.json`: 1,614 unified person records with names, aliases, categories (political/business/academic/staff/financial/legal/media/other)
- `knowledge_graph_relationships.json`: 2,096 typed relationships (traveled_with, associated_with, owned_by, victim_of, etc.)

## Tiering

Each person gets a tier based on relationship data:

| Tier | Score | Criteria |
|------|-------|----------|
| 1 (highest) | 3 | Has `traveled_with` relationship (flight log = island connection) |
| 2 | 2 | Named in 3+ relationships OR category is `staff`/`financial` |
| 3 | 1 | All other persons in the registry |

## Matching Strategy

For each person, generate lookup entries for:
- Full name: "Jeffrey Epstein"
- First name only: "Jeffrey"
- Last name only: "Epstein"
- Common nicknames: "Jeff" (from Jeffrey), "Bill" (from William), etc. via nickname mapping
- Initials + last: "J. Epstein", "J Epstein"
- All known aliases from the registry, split the same way

A single name string (e.g., "John") can match multiple associates — the lookup returns a list.

Match type weighting (multiplied with tier for final priority score):

| Match Type | Weight |
|------------|--------|
| full name | 4 |
| nickname + last | 3 |
| last name only | 2 |
| first name / nickname only | 1 |

## Data File Format

`unredact/data/associates.json`:

```json
{
  "names": {
    "jeffrey epstein": [{"person_id": "p001", "match_type": "full", "tier": 1}],
    "jeffrey": [{"person_id": "p001", "match_type": "first", "tier": 1}],
    "jeff": [{"person_id": "p001", "match_type": "nickname", "tier": 1}],
    "epstein": [{"person_id": "p001", "match_type": "last", "tier": 1}],
    "john": [
      {"person_id": "p042", "match_type": "first", "tier": 2},
      {"person_id": "p087", "match_type": "first", "tier": 3}
    ]
  },
  "persons": {
    "p001": {"name": "Jeffrey Epstein", "tier": 1, "category": "principal"},
    "p042": {"name": "John Smith", "tier": 2, "category": "business"}
  }
}
```

## Architecture

```
Build time:
  rhowardstone data → scripts/build_associates.py → unredact/data/associates.json

Runtime:
  Browser loads associates.json on init (via GET /api/associates)

  Rust solver streams candidates → Python proxies SSE → Frontend receives
  Frontend matches each candidate against associates lookup (case-insensitive)
  Frontend sorts: associates first (by tier × match_type_weight), then non-associates
  Frontend badges associate matches with tier indicator + person info on hover
```

### What Changes

| Component | Change |
|-----------|--------|
| `scripts/build_associates.py` | **New.** Downloads rhowardstone data, processes into associates.json |
| `unredact/data/associates.json` | **New.** Generated data file (~50KB), gitignored |
| `app.py` | One new endpoint: `GET /api/associates` serves the JSON |
| `app.js` | Match/sort/badge logic in solve results panel |
| `index.html` / `style.css` | Badge styling for tier indicators |

### What Does NOT Change

- Rust solver — still streams all candidates, unaware of associates
- Python SSE proxy — passes through unchanged
- `word_filter.py` — existing filter modes unchanged
- Existing name lists (`first_names.txt`, `last_names.txt`) — still used for general filtering

## Frontend UX

In the solve results panel:
- Each result that matches an associate gets a colored badge:
  - Tier 1: red badge (flight log connection)
  - Tier 2: orange badge (frequent mentions / inner circle)
  - Tier 3: yellow badge (peripheral connection)
- Badge tooltip shows: associate name, category, match type
- Results sorted: Tier 1 associates → Tier 2 → Tier 3 → non-associates
- Within same tier, sorted by match_type_weight (full name > last name > first name)
