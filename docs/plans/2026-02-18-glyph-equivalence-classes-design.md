# Glyph Equivalence Classes for DFS Optimization

## Problem

The Rust solver's branch-and-bound DFS iterates over every character in the charset at each node. For a 26-character lowercase alphabet, that's 26 branches per node. Some characters are metrically identical — same advance width after every predecessor, same effect on every successor, same edge behavior. These characters are interchangeable in the width computation, yet the DFS explores each one independently, duplicating work.

## Solution

Group metrically identical characters into **equivalence classes**. Run the DFS over class representatives instead of individual characters. When a match is found, expand representatives into all class members via Cartesian product.

## Equivalence Condition

Characters `g1` and `g2` are equivalent iff ALL hold:

1. **Same column** (incoming advance): `width_table[p][g1] == width_table[p][g2]` for all p
2. **Same row** (outgoing advance): `width_table[g1][f] == width_table[g2][f]` for all f
3. **Same left edge**: `left_edge[g1] == left_edge[g2]`
4. **Same right edge**: `right_edge[g1] == right_edge[g2]`

For full_name mode, additionally:
5. `space_advance[g1] == space_advance[g2]`
6. `left_after_space[g1] == left_after_space[g2]`

Comparison uses **exact float equality** — FreeType values originate from 26.6 fixed-point (multiples of 1/64 pixel), exactly representable as f64.

## Data Structures

```rust
struct EquivClasses {
    /// class_of[char_idx] -> class_id
    class_of: Vec<usize>,
    /// members[class_id] -> Vec<char_idx> (first element is representative)
    members: Vec<Vec<usize>>,
    /// Number of classes (K <= N)
    num_classes: usize,
}
```

Computed once per request in O(N^2) time — trivial compared to the DFS.

## Algorithm Changes

### 1. Class computation

For each character, build a signature: (column values, row values, left_edge, right_edge). Group characters with identical signatures. First member of each group is the representative.

### 2. Constraint deduplication

For each FSM state `s`, produce `state_allowed_deduped[s]` containing one representative per class (among characters allowed in that state).

### 3. DFS inner loop (hot path)

```
// Before: iterate N characters
for &next_idx in &constraint.state_allowed[cstate] { ... }

// After: iterate K class representatives
for &next_idx in &constraint.state_allowed_deduped[cstate] { ... }
```

All pruning logic (overshoot, undershoot, state validity) stays identical — the representative's width properties are the class's width properties by definition.

### 4. Result expansion

When a match is found with path `[rep_0, rep_1, ..., rep_d]`:
- For each position, look up `equiv.members[class_of[rep_i]]`
- Singleton classes (size 1): append directly, no multiplication
- Multi-member classes: Cartesian product
- Stop expansion early if result limit is reached

### 5. Prefix generation

Uses deduped iteration — generates K^depth prefixes instead of N^depth. For K=20 (from N=26), that's 400 vs 676 depth-2 prefixes. Still ample parallelism for rayon.

## Full Name Integration

The outer DFS (`dfs_first`) uses equivalence classes computed from wt1 + space_advance + left_after_space. When a first-word match is found:

1. Compute `remaining` width from representative's metrics
2. Call `solve_subtree(wt2, remaining, ...)` **once** — all expansions produce the same width
3. Second-word results come back already expanded
4. Expand the first-word path
5. Combine: each expanded first word x each second word

This avoids redundant second-word solves for equivalent first-word variants.

## FSM Constraint Interaction

- **Unconstrained** (single state): equivalence classes span the full charset
- **Capitalized** ("Word"): classes naturally split by case — all uppercase chars share the same FSM transitions (state 0 → 1), all lowercase share (state 1 → 1)
- **Full Name**: each word's DFS applies classes independently; outer DFS uses wt1-based classes, inner DFS uses wt2-based classes

No special FSM handling needed because characters in the same case already have identical transition behavior.

## What Doesn't Change

- The width table (N x N, unchanged)
- Pruning logic (overshoot, undershoot, state validity)
- `smax` computation (still uses full reachability over classes)
- SSE streaming, word filtering, HTTP API
- Python side (sends same request, gets same results)

## Expected Impact

- **Branching factor**: N → K per DFS node (K depends on font; estimated 18-22 for N=26 lowercase)
- **Search space**: exponential reduction — K^depth vs N^depth
- **Overhead**: O(N^2) class computation + Cartesian product expansion on matches (negligible)
- **Correctness**: equivalent characters produce identical widths by construction; expansion recovers all solutions
