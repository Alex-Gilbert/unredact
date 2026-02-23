# Word Frequency Filter — Design

## Overview

Reduce noise in word mode results by frequency-filtering the noun and adjective
lists. Words are sorted by frequency rank (Google Books corpus) so the solver
can slice to a cutoff. A new UI dropdown lets the user choose vocabulary size.

## Build Step Changes

Modify `scripts/build_word_lists.py` to:

1. Download `frequency-alpha-alldicts.txt` from hackerb9/gwordlist (~246K
   dictionary-verified words with frequency rankings from Google Books).
2. Assign a frequency rank to each noun and adjective. Words not found in the
   frequency list get rank `infinity` (pushed to end).
3. Sort `nouns.txt` and `adjectives.txt` by frequency rank (most common first).
4. Re-sort `nouns_plural.txt` to match the new noun order (index-aligned).

## UI Changes

New dropdown visible when `mode=word`, label "Vocabulary":

```html
<select id="solve-vocab">
  <option value="3300">Common</option>
  <option value="6400" selected>Standard</option>
  <option value="12000">Extended</option>
  <option value="0">Full</option>
</select>
```

Values are approximate noun counts at each frequency tier:
- **Common** (3,300): top 5K frequency words — very clean, fast
- **Standard** (6,400): top 10K — good balance (default)
- **Extended** (12,000): top 20K — broader coverage
- **Full** (0 = no limit): all words — maximum coverage, may be noisy

The dropdown is hidden for non-word modes (same pattern as plural checkbox and
filter dropdown).

## Backend Changes

### `solve_word_dictionary()` — new parameter

```python
def solve_word_dictionary(
    ...,
    vocab_size: int = 0,  # 0 = no limit
) -> Generator[SolveResult, None, None]:
```

At the start of the function, slice the word lists:

```python
if vocab_size > 0:
    nouns = nouns[:vocab_size]
    plurals = plurals[:vocab_size]
    adjectives = adjectives[:vocab_size]
```

Since the lists are frequency-sorted, this keeps only the N most common words.

### `SolveRequest` — new field

```python
vocab_size: int = 0  # 0 = no limit
```

Passed through to `solve_word_dictionary()`.

## Frontend Changes

- `index.html`: Add vocabulary `<select>` inside `.solve-controls`
- `dom.js`: Export `vocabLabel` and `solveVocab`
- `popover.js`: Show/hide `vocabLabel` when mode changes
- `solver.js`: Include `vocab_size: parseInt(solveVocab.value)` in request body
