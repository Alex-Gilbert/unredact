/// Full-name decomposition solver.
///
/// Splits "First Last" into two independent word solves with a nested DFS:
/// outer DFS enumerates first words, inner DFS solves second word with
/// exact remaining width.

use crate::dfs::{Constraint, SolveResult, WidthTable, compute_length_bounds, solve_subtree,
                 EquivClasses, compute_equiv_classes, dedup_state_allowed, build_byte_to_idx,
                 expand_match};
use std::collections::HashSet;

/// Build a "capitalized" constraint: state 0 = uppercase, state 1 = lowercase.
fn capitalized_constraint(charset: &[char]) -> Constraint {
    let n = charset.len();
    let upper_idx: Vec<usize> = charset.iter().enumerate()
        .filter(|(_, c)| c.is_uppercase())
        .map(|(i, _)| i)
        .collect();
    let lower_idx: Vec<usize> = charset.iter().enumerate()
        .filter(|(_, c)| c.is_lowercase())
        .map(|(i, _)| i)
        .collect();

    let mut sn0 = vec![-1i32; n];
    for &i in &upper_idx {
        sn0[i] = 1;
    }
    let mut sn1 = vec![-1i32; n];
    for &i in &lower_idx {
        sn1[i] = 1;
    }

    Constraint {
        state_allowed: vec![upper_idx, lower_idx],
        state_next: vec![sn0, sn1],
        accept_states: vec![false, true],
    }
}

/// Build a default (all-allowed) constraint.
fn default_constraint(n: usize) -> Constraint {
    let all: Vec<usize> = (0..n).collect();
    Constraint {
        state_allowed: vec![all],
        state_next: vec![(0..n as i32).map(|_| 0i32).collect()],
        accept_states: vec![true],
    }
}

pub fn solve_full_name(
    word_charset: &[char],
    wt1_table: &[f64],   // first word: NxN flattened
    wt1_left_edge: &[f64],
    wt1_right_edge: &[f64],
    wt2_table: &[f64],   // second word: NxN flattened
    wt2_right_edge: &[f64],
    space_advance: &[f64],    // N: space width after each char
    left_after_space: &[f64], // N: char width when preceded by space
    target: f64,
    tolerance: f64,
    uppercase_only: bool,
) -> Vec<SolveResult> {
    let n = word_charset.len();

    let wt1 = WidthTable {
        charset: word_charset.to_vec(),
        width_table: wt1_table.to_vec(),
        left_edge: wt1_left_edge.to_vec(),
        right_edge: wt1_right_edge.to_vec(),
        n,
    };

    // Second word width table: uses left_after_space as left_edge
    let wt2 = WidthTable {
        charset: word_charset.to_vec(),
        width_table: wt2_table.to_vec(),
        left_edge: left_after_space.to_vec(),
        right_edge: wt2_right_edge.to_vec(),
        n,
    };

    let constraint = if uppercase_only {
        default_constraint(n)
    } else {
        capitalized_constraint(word_charset)
    };

    let equiv1 = compute_equiv_classes(&wt1, &[space_advance, left_after_space]);
    let equiv2 = compute_equiv_classes(&wt2, &[]);
    let deduped1 = dedup_state_allowed(&equiv1, &constraint);
    let deduped2 = dedup_state_allowed(&equiv2, &constraint);
    let byte_to_idx = build_byte_to_idx(word_charset);

    let min_word_len: usize = if uppercase_only { 1 } else { 2 };

    // Keep original allowed lists for bounds computation
    let first_allowed = &constraint.state_allowed[0]; // uppercase (or all)
    let body_allowed = if constraint.state_allowed.len() > 1 {
        &constraint.state_allowed[1] // lowercase (or all)
    } else {
        &constraint.state_allowed[0]
    };

    // Deduped versions for DFS iteration
    let first_deduped = &deduped1[0];
    let body_deduped = if deduped1.len() > 1 { &deduped1[1] } else { &deduped1[0] };

    // Min second word width (for overshoot pruning of first word)
    let min_second = {
        let min_start: f64 = first_allowed.iter()
            .map(|&i| left_after_space[i])
            .fold(f64::INFINITY, f64::min);
        let min_body: f64 = if min_word_len >= 2 {
            let mut m = f64::INFINITY;
            for &prev in first_allowed.iter() {
                for &next in body_allowed.iter() {
                    m = m.min(wt2.advance(prev, next));
                }
            }
            m
        } else {
            0.0
        };
        let min_right: f64 = wt2.right_edge.iter().cloned().fold(f64::INFINITY, f64::min);
        min_start + min_body + min_right
    };

    let min_space: f64 = space_advance.iter().cloned().fold(f64::INFINITY, f64::min);
    let first_max_width = target + tolerance - min_space - min_second;

    if first_max_width <= 0.0 {
        return Vec::new();
    }

    // Max advance for undershoot pruning
    let max_body_advance: f64 = {
        let mut m = 0.0_f64;
        for prev in 0..n {
            for &next in body_allowed {
                m = m.max(wt1.advance(prev, next));
            }
        }
        m
    };
    let max_first_advance: f64 = {
        let mut m = 0.0_f64;
        for prev in 0..n {
            for &next in first_allowed {
                m = m.max(wt1.advance(prev, next));
            }
        }
        m
    };
    let max_word_advance = max_body_advance.max(max_first_advance);

    // Length bound for first word
    let (_, first_max_len) = compute_length_bounds(&wt1, first_max_width, 0.0);
    let first_max_len = first_max_len.max(min_word_len);

    let mut results = Vec::new();
    let mut seen = HashSet::new();

    // Nested DFS: outer = first word, inner = second word solve
    dfs_first(
        &wt1, &wt2, &constraint,
        word_charset, space_advance, left_after_space,
        target, tolerance, min_word_len, first_max_len, first_max_width,
        min_space, min_second, max_word_advance,
        first_allowed, body_allowed,
        &equiv1, &byte_to_idx, first_deduped, body_deduped,
        &equiv2, &deduped2,
        0, 0.0, 0, &mut Vec::new(), true,
        &mut results, &mut seen,
    );

    results.sort_by(|a, b| {
        a.error.partial_cmp(&b.error).unwrap()
            .then_with(|| a.text.cmp(&b.text))
    });
    results
}

#[allow(clippy::too_many_arguments)]
fn dfs_first(
    wt1: &WidthTable,
    wt2: &WidthTable,
    constraint: &Constraint,
    charset: &[char],
    space_advance: &[f64],
    left_after_space: &[f64],
    target: f64,
    tolerance: f64,
    min_word_len: usize,
    first_max_len: usize,
    first_max_width: f64,
    min_space: f64,
    min_second: f64,
    max_word_advance: f64,
    first_allowed: &[usize],
    body_allowed: &[usize],
    equiv1: &EquivClasses,
    byte_to_idx: &[usize; 128],
    first_deduped: &[usize],
    body_deduped: &[usize],
    equiv2: &EquivClasses,
    deduped2: &[Vec<usize>],
    depth: usize,
    acc_width: f64,
    last_idx: usize,
    path: &mut Vec<u8>,
    is_start: bool,
    results: &mut Vec<SolveResult>,
    seen: &mut HashSet<String>,
) {
    // At valid first-word leaf, solve second word
    if depth >= min_word_len && !is_start {
        let first_width = acc_width + wt1.right_edge[last_idx];
        let sp = space_advance[last_idx];
        let remaining = target - first_width - sp;

        if remaining > 0.0 {
            let (auto_min2, auto_max2) = compute_length_bounds(wt2, remaining, tolerance);
            let auto_min2 = auto_min2.max(min_word_len);

            if auto_min2 <= auto_max2 {
                let second_results = solve_subtree(
                    wt2, remaining, tolerance,
                    auto_min2, auto_max2,
                    "", 0.0, -1,
                    constraint, 0,
                    equiv2, deduped2,
                );

                // Expand first word (all class-member variants)
                let first_expanded = expand_match(path, equiv1, charset, byte_to_idx);
                for first_bytes in &first_expanded {
                    let first_text = unsafe { String::from_utf8_unchecked(first_bytes.clone()) };
                    for r2 in &second_results {
                        let full_text = format!("{} {}", first_text, r2.text);
                        if !seen.contains(&full_text) {
                            let full_width = first_width + sp + r2.width;
                            let err = (full_width - target).abs();
                            if err <= tolerance {
                                seen.insert(full_text.clone());
                                results.push(SolveResult {
                                    text: full_text,
                                    width: full_width,
                                    error: err,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    if depth >= first_max_len {
        return;
    }

    let allowed = if depth == 0 { first_deduped } else { body_deduped };
    let chars_left = first_max_len - depth;

    for &next_idx in allowed {
        let advance = if is_start {
            wt1.left_edge[next_idx]
        } else {
            wt1.advance(last_idx, next_idx)
        };
        let new_width = acc_width + advance;

        // Overshoot: first word too wide for any second word
        if new_width > first_max_width {
            continue;
        }

        // Undershoot: can't make target even with widest remaining chars
        if chars_left > 1 {
            let max_possible = new_width + max_word_advance * (chars_left as f64 - 1.0);
            if max_possible + min_space + min_second + tolerance < target {
                continue;
            }
        }

        path.push(charset[next_idx] as u8);
        dfs_first(
            wt1, wt2, constraint, charset,
            space_advance, left_after_space,
            target, tolerance, min_word_len, first_max_len, first_max_width,
            min_space, min_second, max_word_advance,
            first_allowed, body_allowed,
            equiv1, byte_to_idx, first_deduped, body_deduped,
            equiv2, deduped2,
            depth + 1, new_width, next_idx, path, false,
            results, seen,
        );
        path.pop();
    }
}
