/// Core DFS branch-and-bound solver for string width matching.

use std::collections::{HashMap, HashSet};

/// Precomputed constraint for the DFS search.
/// state_allowed[s] = list of charset indices allowed in state s.
/// state_next[s][ci] = next state after placing charset[ci] in state s (-1 = invalid).
/// accept_states = set of states where the string can validly end.
#[derive(Clone)]
pub struct Constraint {
    pub state_allowed: Vec<Vec<usize>>,
    pub state_next: Vec<Vec<i32>>,
    pub accept_states: Vec<bool>, // indexed by state
}

/// Result of a solve: the matched text, its rendered width, and error from target.
#[derive(Clone)]
pub struct SolveResult {
    pub text: String,
    pub width: f64,
    pub error: f64,
}

/// Width table data passed from Python.
pub struct WidthTable {
    pub charset: Vec<char>,
    pub width_table: Vec<f64>, // flattened NxN, row-major
    pub left_edge: Vec<f64>,   // N
    pub right_edge: Vec<f64>,  // N
    pub n: usize,
}

impl WidthTable {
    #[inline(always)]
    pub fn advance(&self, prev: usize, next: usize) -> f64 {
        self.width_table[prev * self.n + next]
    }
}

/// Per-state max advance, precomputed for undershoot pruning.
fn compute_state_max(wt: &WidthTable, constraint: &Constraint) -> Vec<f64> {
    let num_states = constraint.state_allowed.len();
    let mut smax = vec![0.0_f64; num_states];

    for s in 0..num_states {
        // Find all chars reachable from state s via any transition path.
        let mut reachable = vec![false; wt.n];
        let mut visited = vec![false; num_states];
        let mut stack = vec![s];

        while let Some(curr) = stack.pop() {
            if visited[curr] {
                continue;
            }
            visited[curr] = true;
            for &ci in &constraint.state_allowed[curr] {
                reachable[ci] = true;
                let ns = constraint.state_next[curr][ci];
                if ns >= 0 && !visited[ns as usize] {
                    stack.push(ns as usize);
                }
            }
        }

        // Max advance of any reachable char after any preceding char.
        let mut mx = 0.0_f64;
        for prev in 0..wt.n {
            for next in 0..wt.n {
                if reachable[next] {
                    mx = mx.max(wt.advance(prev, next));
                }
            }
        }
        smax[s] = mx;
    }
    smax
}

/// Solve a single subtree: find all strings matching the target width.
pub fn solve_subtree(
    wt: &WidthTable,
    target: f64,
    tolerance: f64,
    min_length: usize,
    max_length: usize,
    prefix: &str,
    prefix_width: f64,
    last_char_idx: i32, // -1 if no prefix
    constraint: &Constraint,
    start_state: usize,
    equiv: &EquivClasses,
    deduped_allowed: &[Vec<usize>],
) -> Vec<SolveResult> {
    let smax = compute_state_max(wt, constraint);
    let byte_to_idx = build_byte_to_idx(&wt.charset);
    let mut results = Vec::new();

    if prefix.is_empty() {
        // Start from scratch — iterate first chars (deduped: one representative per class)
        for &first_idx in &deduped_allowed[start_state] {
            let start_width = wt.left_edge[first_idx];
            if start_width > target + tolerance {
                continue;
            }
            let ns = constraint.state_next[start_state][first_idx];
            if ns < 0 {
                continue;
            }
            if max_length > 1 {
                let max_possible = start_width + smax[ns as usize] * (max_length as f64 - 1.0);
                if max_possible + tolerance < target {
                    continue;
                }
            }
            let mut path = vec![wt.charset[first_idx] as u8];
            dfs(
                wt,
                target,
                tolerance,
                min_length,
                max_length,
                constraint,
                &smax,
                equiv,
                deduped_allowed,
                &byte_to_idx,
                1,    // depth
                start_width,
                first_idx,
                &mut path,
                ns as usize,
                0, // prefix_len
                &mut results,
            );
        }
    } else {
        let mut path: Vec<u8> = prefix.bytes().collect();
        dfs(
            wt,
            target,
            tolerance,
            min_length,
            max_length,
            constraint,
            &smax,
            equiv,
            deduped_allowed,
            &byte_to_idx,
            0, // depth
            prefix_width,
            last_char_idx as usize,
            &mut path,
            start_state,
            prefix.len(),
            &mut results,
        );
    }

    results
}

#[inline(never)]
fn dfs(
    wt: &WidthTable,
    target: f64,
    tolerance: f64,
    min_length: usize,
    max_length: usize,
    constraint: &Constraint,
    smax: &[f64],
    equiv: &EquivClasses,
    deduped_allowed: &[Vec<usize>],
    byte_to_idx: &[usize; 128],
    depth: usize,
    acc_width: f64,
    last_idx: usize,
    path: &mut Vec<u8>,
    cstate: usize,
    prefix_len: usize,
    results: &mut Vec<SolveResult>,
) {
    let current_length = prefix_len + depth;

    if current_length >= min_length && constraint.accept_states[cstate] {
        let final_width = acc_width + wt.right_edge[last_idx];
        let err = (final_width - target).abs();
        if err <= tolerance {
            let expanded = expand_match(path, equiv, &wt.charset, byte_to_idx);
            for text_bytes in expanded {
                // SAFETY: path contains valid UTF-8 (ASCII charset chars)
                let text = unsafe { String::from_utf8_unchecked(text_bytes) };
                results.push(SolveResult {
                    text,
                    width: final_width,
                    error: err,
                });
            }
        }
    }

    if current_length >= max_length {
        return;
    }

    let chars_left = max_length - current_length;

    for &next_idx in &deduped_allowed[cstate] {
        let advance = wt.advance(last_idx, next_idx);
        let new_width = acc_width + advance;

        if new_width > target + tolerance {
            continue;
        }

        let ns = constraint.state_next[cstate][next_idx];
        if ns < 0 {
            continue;
        }

        if chars_left > 1 {
            let max_possible = new_width + smax[ns as usize] * (chars_left as f64 - 1.0);
            if max_possible + tolerance < target {
                continue;
            }
        }

        path.push(wt.charset[next_idx] as u8);
        dfs(
            wt,
            target,
            tolerance,
            min_length,
            max_length,
            constraint,
            smax,
            equiv,
            deduped_allowed,
            byte_to_idx,
            depth + 1,
            new_width,
            next_idx,
            path,
            ns as usize,
            prefix_len,
            results,
        );
        path.pop();
    }
}

/// Compute min/max string length from width table metrics.
pub fn compute_length_bounds(wt: &WidthTable, target: f64, tolerance: f64) -> (usize, usize) {
    let left_min = wt.left_edge.iter().cloned().fold(f64::INFINITY, f64::min);
    let left_max = wt.left_edge.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    let mut global_min_advance = f64::INFINITY;
    let mut global_max_advance = f64::NEG_INFINITY;
    for prev in 0..wt.n {
        for next in 0..wt.n {
            let a = wt.advance(prev, next);
            global_min_advance = global_min_advance.min(a);
            global_max_advance = global_max_advance.max(a);
        }
    }

    let global_min = left_min.min(global_min_advance);
    let global_max = left_max.max(global_max_advance);

    if global_max <= 0.0 {
        return (1, 1);
    }
    let safe_min = if global_min <= 0.0 { 0.1 } else { global_min };

    let min_len = ((target - tolerance) / global_max).floor().max(1.0) as usize;
    let max_len = ((target + tolerance) / safe_min).ceil().max(1.0) as usize;

    (min_len, max_len)
}

/// Equivalence classes of metrically identical characters.
pub struct EquivClasses {
    /// class_of[char_idx] -> class_id
    pub class_of: Vec<usize>,
    /// members[class_id] -> Vec<char_idx> (first element is the representative)
    pub members: Vec<Vec<usize>>,
    /// Number of equivalence classes (K <= N)
    pub num_classes: usize,
}

/// Compute equivalence classes from width table properties.
///
/// Two characters are equivalent when they have identical:
/// - column in width_table (incoming advance from any predecessor)
/// - row in width_table (outgoing advance to any successor)
/// - left_edge and right_edge values
/// - values in any extra columns (e.g. space_advance for full_name mode)
///
/// Uses exact float comparison via f64::to_bits() — FreeType values
/// originate from 26.6 fixed-point, exactly representable as f64.
pub fn compute_equiv_classes(wt: &WidthTable, extra: &[&[f64]]) -> EquivClasses {
    let n = wt.n;
    let sig_len = 2 * n + 2 + extra.len();

    let mut signatures: Vec<Vec<u64>> = Vec::with_capacity(n);
    for i in 0..n {
        let mut sig = Vec::with_capacity(sig_len);
        // Column: advance of char i when preceded by each char p
        for p in 0..n {
            sig.push(wt.advance(p, i).to_bits());
        }
        // Row: advance of each char f when preceded by char i
        for f in 0..n {
            sig.push(wt.advance(i, f).to_bits());
        }
        sig.push(wt.left_edge[i].to_bits());
        sig.push(wt.right_edge[i].to_bits());
        for col in extra {
            sig.push(col[i].to_bits());
        }
        signatures.push(sig);
    }

    let mut class_of = vec![0usize; n];
    let mut members: Vec<Vec<usize>> = Vec::new();
    let mut sig_to_class: HashMap<Vec<u64>, usize> = HashMap::new();

    for i in 0..n {
        if let Some(&class_id) = sig_to_class.get(&signatures[i]) {
            class_of[i] = class_id;
            members[class_id].push(i);
        } else {
            let class_id = members.len();
            sig_to_class.insert(signatures[i].clone(), class_id);
            class_of[i] = class_id;
            members.push(vec![i]);
        }
    }

    let num_classes = members.len();
    EquivClasses { class_of, members, num_classes }
}

/// Deduplicate state_allowed to one representative per equivalence class.
pub fn dedup_state_allowed(equiv: &EquivClasses, constraint: &Constraint) -> Vec<Vec<usize>> {
    constraint.state_allowed.iter().map(|allowed| {
        let mut seen = HashSet::new();
        allowed.iter().copied().filter(|&idx| {
            seen.insert(equiv.class_of[idx])
        }).collect()
    }).collect()
}

/// Build byte→charset_index lookup (ASCII only).
pub fn build_byte_to_idx(charset: &[char]) -> [usize; 128] {
    let mut lookup = [0usize; 128];
    for (i, &c) in charset.iter().enumerate() {
        lookup[c as usize] = i;
    }
    lookup
}

/// Expand a representative-only path into all class-member variants.
pub fn expand_match(
    path: &[u8],
    equiv: &EquivClasses,
    charset: &[char],
    byte_to_idx: &[usize; 128],
) -> Vec<Vec<u8>> {
    let mut results: Vec<Vec<u8>> = vec![Vec::with_capacity(path.len())];

    for &byte in path {
        let idx = byte_to_idx[byte as usize];
        let class_id = equiv.class_of[idx];
        let members = &equiv.members[class_id];

        if members.len() == 1 {
            for r in &mut results {
                r.push(byte);
            }
        } else {
            let mut new_results = Vec::with_capacity(results.len() * members.len());
            for existing in &results {
                for &member_idx in members {
                    let mut s = existing.clone();
                    s.push(charset[member_idx] as u8);
                    new_results.push(s);
                }
            }
            results = new_results;
        }
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: build a WidthTable from flat data.
    fn make_wt(charset: &str, table: &[f64], left: &[f64], right: &[f64]) -> WidthTable {
        WidthTable {
            charset: charset.chars().collect(),
            width_table: table.to_vec(),
            left_edge: left.to_vec(),
            right_edge: right.to_vec(),
            n: charset.len(),
        }
    }

    #[test]
    fn test_equiv_classes_with_duplicates() {
        // charset "abc" where b(1) and c(2) are equivalent:
        // same column, same row, same left_edge, same right_edge
        let wt = make_wt(
            "abc",
            &[
                // row a (prev=a): next=a,b,c
                5.0, 6.0, 6.0,
                // row b (prev=b): next=a,b,c  ← same as row c
                5.0, 6.0, 6.0,
                // row c (prev=c): next=a,b,c  ← same as row b
                5.0, 6.0, 6.0,
            ],
            &[4.0, 5.0, 5.0],   // left_edge: b == c
            &[0.0, 1.0, 1.0],   // right_edge: b == c
        );
        let equiv = compute_equiv_classes(&wt, &[]);
        assert_eq!(equiv.num_classes, 2, "expected 2 classes: {{a}}, {{b,c}}");
        assert_ne!(equiv.class_of[0], equiv.class_of[1], "a should be in different class than b");
        assert_eq!(equiv.class_of[1], equiv.class_of[2], "b and c should be in same class");
        // b (idx 1) should be representative (first in class)
        let bc_class = equiv.class_of[1];
        assert_eq!(equiv.members[bc_class][0], 1, "b should be representative");
        assert_eq!(equiv.members[bc_class].len(), 2);
    }

    #[test]
    fn test_equiv_classes_all_unique() {
        let wt = make_wt(
            "abc",
            &[
                5.0, 6.0, 7.0,
                8.0, 9.0, 10.0,
                11.0, 12.0, 13.0,
            ],
            &[4.0, 5.0, 6.0],
            &[0.0, 1.0, 2.0],
        );
        let equiv = compute_equiv_classes(&wt, &[]);
        assert_eq!(equiv.num_classes, 3);
        for i in 0..3 {
            assert_eq!(equiv.members[equiv.class_of[i]].len(), 1);
        }
    }

    #[test]
    fn test_equiv_classes_with_extra_columns() {
        // b and c have same width properties but different extra column → not equivalent
        let wt = make_wt(
            "abc",
            &[
                5.0, 6.0, 6.0,
                5.0, 6.0, 6.0,
                5.0, 6.0, 6.0,
            ],
            &[4.0, 5.0, 5.0],
            &[0.0, 1.0, 1.0],
        );
        let extra = vec![10.0, 20.0, 30.0]; // different for b(20) and c(30)
        let equiv = compute_equiv_classes(&wt, &[&extra]);
        assert_eq!(equiv.num_classes, 3, "extra column should split b and c");
    }

    #[test]
    fn test_dedup_state_allowed() {
        // charset "abc", b and c equivalent → 2 classes
        let wt = make_wt(
            "abc",
            &[5.0,6.0,6.0, 5.0,6.0,6.0, 5.0,6.0,6.0],
            &[4.0, 5.0, 5.0],
            &[0.0, 1.0, 1.0],
        );
        let equiv = compute_equiv_classes(&wt, &[]);
        // Single state allowing all chars
        let constraint = Constraint {
            state_allowed: vec![vec![0, 1, 2]],
            state_next: vec![vec![0, 0, 0]],
            accept_states: vec![true],
        };
        let deduped = dedup_state_allowed(&equiv, &constraint);
        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0].len(), 2, "should be [a_rep, bc_rep]");
        assert!(deduped[0].contains(&0)); // a
        assert!(deduped[0].contains(&1)); // b (representative of {b,c})
        assert!(!deduped[0].contains(&2)); // c excluded (b is representative)
    }

    #[test]
    fn test_dedup_capitalized_constraint() {
        // charset "aAbB", A and B equivalent (same widths), a and b equivalent
        let wt = make_wt(
            "aAbB",
            &[
                5.0, 8.0, 5.0, 8.0,  // row a == row b
                7.0, 10.0, 7.0, 10.0, // row A == row B
                5.0, 8.0, 5.0, 8.0,  // row b == row a
                7.0, 10.0, 7.0, 10.0, // row B == row A
            ],
            &[4.0, 6.0, 4.0, 6.0],
            &[0.0, 1.0, 0.0, 1.0],
        );
        let equiv = compute_equiv_classes(&wt, &[]);
        assert_eq!(equiv.num_classes, 2); // {a,b} and {A,B}
        // Capitalized: state 0 = uppercase [A(1), B(3)], state 1 = lowercase [a(0), b(2)]
        let constraint = Constraint {
            state_allowed: vec![vec![1, 3], vec![0, 2]],
            state_next: vec![vec![-1, 1, -1, 1], vec![1, -1, 1, -1]],
            accept_states: vec![false, true],
        };
        let deduped = dedup_state_allowed(&equiv, &constraint);
        assert_eq!(deduped[0].len(), 1, "state 0: one uppercase rep");
        assert_eq!(deduped[1].len(), 1, "state 1: one lowercase rep");
    }

    #[test]
    fn test_expand_match_singleton() {
        let wt = make_wt(
            "abc",
            &[5.0,6.0,7.0, 8.0,9.0,10.0, 11.0,12.0,13.0],
            &[4.0, 5.0, 6.0],
            &[0.0, 1.0, 2.0],
        );
        let equiv = compute_equiv_classes(&wt, &[]);
        let byte_to_idx = build_byte_to_idx(&wt.charset);
        // All singletons — expand "ab" → just ["ab"]
        let path: Vec<u8> = b"ab".to_vec();
        let expanded = expand_match(&path, &equiv, &wt.charset, &byte_to_idx);
        assert_eq!(expanded.len(), 1);
        assert_eq!(expanded[0], b"ab");
    }

    #[test]
    fn test_expand_match_multi_member() {
        let wt = make_wt(
            "abc",
            &[5.0,6.0,6.0, 5.0,6.0,6.0, 5.0,6.0,6.0],
            &[4.0, 5.0, 5.0],
            &[0.0, 1.0, 1.0],
        );
        let equiv = compute_equiv_classes(&wt, &[]);
        let byte_to_idx = build_byte_to_idx(&wt.charset);
        // b and c equivalent, representative is b
        // Path "ab" (DFS placed representative b at position 1)
        // Expand → "ab", "ac"
        let path: Vec<u8> = b"ab".to_vec();
        let mut expanded = expand_match(&path, &equiv, &wt.charset, &byte_to_idx);
        expanded.sort();
        assert_eq!(expanded.len(), 2);
        assert_eq!(expanded[0], b"ab");
        assert_eq!(expanded[1], b"ac");
    }

    #[test]
    fn test_expand_match_multi_position() {
        let wt = make_wt(
            "abc",
            &[5.0,6.0,6.0, 5.0,6.0,6.0, 5.0,6.0,6.0],
            &[4.0, 5.0, 5.0],
            &[0.0, 1.0, 1.0],
        );
        let equiv = compute_equiv_classes(&wt, &[]);
        let byte_to_idx = build_byte_to_idx(&wt.charset);
        // Path "abb" → expand both b positions
        // → "abb", "abc", "acb", "acc"
        let path: Vec<u8> = b"abb".to_vec();
        let mut expanded = expand_match(&path, &equiv, &wt.charset, &byte_to_idx);
        expanded.sort();
        assert_eq!(expanded.len(), 4);
        assert_eq!(expanded[0], b"abb");
        assert_eq!(expanded[1], b"abc");
        assert_eq!(expanded[2], b"acb");
        assert_eq!(expanded[3], b"acc");
    }

    #[test]
    fn test_solve_subtree_expands_equivalences() {
        let wt = make_wt(
            "abc",
            &[5.0,6.0,6.0, 5.0,6.0,6.0, 5.0,6.0,6.0],
            &[4.0, 5.0, 5.0],
            &[0.0, 0.0, 0.0],
        );
        let equiv = compute_equiv_classes(&wt, &[]);
        let constraint = Constraint {
            state_allowed: vec![vec![0, 1, 2]],
            state_next: vec![vec![0, 0, 0]],
            accept_states: vec![true],
        };
        let deduped = dedup_state_allowed(&equiv, &constraint);

        // target = 10.0, tol = 0.5, length 2
        // "ab": left[a]=4 + wt[a][b]=6 + right[b]=0 = 10 ✓
        // "ac": left[a]=4 + wt[a][c]=6 + right[c]=0 = 10 ✓ (expanded from "ab")
        let results = solve_subtree(
            &wt, 10.0, 0.5, 2, 2,
            "", 0.0, -1,
            &constraint, 0,
            &equiv, &deduped,
        );
        let mut texts: Vec<String> = results.iter().map(|r| r.text.clone()).collect();
        texts.sort();
        assert!(texts.contains(&"ab".to_string()), "should contain ab, got {:?}", texts);
        assert!(texts.contains(&"ac".to_string()), "should contain ac, got {:?}", texts);
    }

    #[test]
    fn test_solve_subtree_no_equiv_same_results() {
        let wt = make_wt(
            "abc",
            &[5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0],
            &[4.0, 5.0, 6.0],
            &[0.0, 1.0, 2.0],
        );
        let equiv = compute_equiv_classes(&wt, &[]);
        assert_eq!(equiv.num_classes, 3);
        let constraint = Constraint {
            state_allowed: vec![vec![0, 1, 2]],
            state_next: vec![vec![0, 0, 0]],
            accept_states: vec![true],
        };
        let deduped = dedup_state_allowed(&equiv, &constraint);
        let results = solve_subtree(
            &wt, 15.0, 1.0, 2, 2,
            "", 0.0, -1,
            &constraint, 0,
            &equiv, &deduped,
        );
        for r in &results {
            assert!((r.width - 15.0).abs() <= 1.0, "result {} has error {} > tolerance", r.text, r.error);
        }
    }
}
