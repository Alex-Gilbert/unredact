# Mode/Charset Restructuring

## Problem

The current UI exposes implementation details as user-facing concepts. The mode dropdown (enumerate/dictionary/both/emails) maps to backend strategies, not user intent. The charset dropdown has 7 options including "Full Name" and "FULL NAME" which are really modes, not charsets. The "filter prefix/suffix" fields have a confusing name. The overall UX doesn't match how users think about redaction solving.

## Solution

Restructure into orthogonal **mode** (what to search) and **charset** (how text is cased) dimensions. Rename filter prefix/suffix to "known start"/"known end".

## Modes

| Mode | Value | Source | Description |
|------|-------|--------|-------------|
| Name (default) | `name` | `associate_first_names.txt` + `associate_last_names.txt` | Single-word associate names: first names, last names, nicknames |
| Full Name | `full_name` | Cartesian product first x last + `associates.json` variants | Two-word names: "John Doe", "B. Clinton" |
| Email | `email` | `emails.txt` | Associate email addresses |
| Enumerate | `enumerate` | Rust DFS backend | Brute-force character enumeration |

"Dictionary" mode is removed entirely. The user-uploaded dictionary store (`DictionaryStore`) and its API endpoints are removed.

## Charsets

| Value | Display | Effect |
|-------|---------|--------|
| `lowercase` | lowercase | All lowercase |
| `uppercase` | UPPERCASE | All uppercase |
| `capitalized` | Capitalized | First letter of each word uppercase |

For **name** and **full name** modes: charset determines casing applied to stored lowercase names.

For **enumerate** mode: charset determines the character set sent to the Rust backend. `lowercase` = `a-z`, `uppercase` = `A-Z`, `capitalized` = `a-zA-Z` + space with the capitalize constraint.

For **email** mode: charset is ignored (emails matched as-is in their stored casing).

## Known Start / Known End (renamed from filter prefix/suffix)

These represent known characters at the start/end of the redacted text. The gap width measures only the unknown portion between them.

**Dictionary modes (name, full_name, email):**
- Filter candidates to those starting with known_start and/or ending with known_end (case-insensitive)
- Measure only the unknown portion (after stripping known_start/known_end) against the gap width
- Use the last char of known_start as left kerning context; first char of known_end as right kerning context
- Display the full candidate text (e.g., "joe" not "oe")

**Enumerate mode:** Unchanged Rust behavior — known_start/known_end prepended/appended to result text before word/name filter check.

## Backend Changes

### New function: `solve_name_dictionary()`

In `dictionary.py`:
- Loads associate first + last names, combines and deduplicates
- Applies casing based on charset
- Filters by known_start/known_end
- Measures the unknown portion against gap width with kerning
- Returns sorted `SolveResult` list

### Updated: `solve_full_name_dictionary()`

- Adds `casing` parameter (replaces `uppercase_only` boolean)
- Adds `known_start`/`known_end` support

### Updated: `app.py` solve handler

Dispatch by mode:
- `name` -> `solve_name_dictionary()`
- `full_name` -> `solve_full_name_dictionary()`
- `email` -> `solve_dictionary()` with email list
- `enumerate` -> existing Rust backend

Remove: `DictionaryStore`, dictionary API endpoints, `dictionary`/`both` mode branches.

### Updated: `SolveRequest`

- `mode`: "name" | "full_name" | "email" | "enumerate"
- `hints.charset`: "lowercase" | "uppercase" | "capitalized"
- Rename `filter_prefix` -> `known_start`, `filter_suffix` -> `known_end`
- Keep `word_filter` (used by enumerate mode only)

## Frontend Changes

- **Mode dropdown**: Name (default), Full Name, Email, Enumerate
- **Charset dropdown**: lowercase, UPPERCASE, Capitalized
- **Filter dropdown**: hidden unless enumerate mode is selected
- **Rename**: "Filter prefix" -> "Known start", "Filter suffix" -> "Known end"
- Remove unused charset options: full_name_capitalized, full_name_caps, alpha, alphanumeric

## What Gets Removed

- `DictionaryStore` class and its API endpoints (`/api/dictionary` POST/GET/DELETE)
- `dictionary` and `both` mode values
- Charset values: `full_name_capitalized`, `full_name_caps`, `alpha`, `alphanumeric`
- The "Filter" label in the HTML dropdown (renamed to "Word filter" for clarity when visible)
