use crate::types::SolveResult;
use super::constraint::Constraint;
use super::width_table::WidthTable;

/// Find all strings whose rendered width matches `target` within `tolerance`.
///
/// # Arguments
/// * `charset` - the character set as a string (e.g., "abcdefg...")
/// * `wt` - precomputed width table
/// * `target` - target width in pixels
/// * `tolerance` - maximum acceptable |width - target|
/// * `min_length` - minimum result string length
/// * `max_length` - maximum result string length
/// * `constraint` - FSM constraint for valid character sequences
pub fn solve(
    charset: &str,
    wt: &WidthTable,
    target: f64,
    tolerance: f64,
    min_length: usize,
    max_length: usize,
    constraint: &Constraint,
) -> Vec<SolveResult> {
    let chars: Vec<char> = charset.chars().collect();
    let n = chars.len();
    assert_eq!(n, wt.n, "charset length must match width table size");

    // Compute effective length bounds from font metrics
    let global_min_adv = wt.global_min_advance();
    let global_max_adv = wt.global_max_advance();

    let global_min = f64::min(wt.left_min, global_min_adv);
    let global_max = f64::max(wt.left_max, global_max_adv);

    if global_max <= 0.0 {
        return Vec::new();
    }
    let safe_min = if global_min <= 0.0 { 0.1 } else { global_min };

    let computed_min_len = 1.max(((target - tolerance) / global_max).floor() as usize);
    let computed_max_len = 1.max(((target + tolerance) / safe_min).ceil() as usize);

    let effective_min = min_length.max(computed_min_len);
    let effective_max = max_length.min(computed_max_len);

    if effective_min > effective_max {
        return Vec::new();
    }

    // Precompute per-state max advance for tighter undershoot pruning.
    // For each state, BFS through the constraint's transition graph to find
    // all reachable character indices, then take max advance among those chars.
    let num_states = constraint.num_states();
    let max_adv_per_state = compute_max_advance_per_state(wt, constraint, num_states, n);

    // Max right_edge value, used in undershoot pruning to account for
    // the right edge contribution at the end of the string.
    let right_max = (0..n).map(|i| wt.right(i)).fold(0.0_f64, f64::max);

    let upper_bound = target + tolerance;

    let mut results = Vec::new();
    let mut path = Vec::new();

    // Start DFS from each allowed first character
    for &char_idx in constraint.allowed(0) {
        let start_width = wt.left(char_idx);
        if start_width > upper_bound {
            continue;
        }

        let ns = match constraint.next_state(0, char_idx) {
            Some(s) => s,
            None => continue,
        };

        // Undershoot pruning for first character
        if effective_max > 1 {
            let chars_remaining = effective_max - 1;
            let max_possible = start_width + max_adv_per_state[ns] * (chars_remaining as f64) + right_max;
            if max_possible + tolerance < target {
                continue;
            }
        }

        path.push(chars[char_idx]);
        dfs(
            1,
            start_width,
            char_idx,
            &mut path,
            ns,
            &chars,
            wt,
            target,
            tolerance,
            upper_bound,
            right_max,
            effective_min,
            effective_max,
            constraint,
            &max_adv_per_state,
            &mut results,
        );
        path.pop();
    }

    // Sort by error ascending, then by text ascending
    results.sort_by(|a, b| {
        a.error
            .partial_cmp(&b.error)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.text.cmp(&b.text))
    });

    results
}

#[allow(clippy::too_many_arguments)]
fn dfs(
    depth: usize,
    acc_width: f64,
    last_idx: usize,
    path: &mut Vec<char>,
    state: usize,
    chars: &[char],
    wt: &WidthTable,
    target: f64,
    tolerance: f64,
    upper_bound: f64,
    right_max: f64,
    effective_min: usize,
    effective_max: usize,
    constraint: &Constraint,
    max_adv_per_state: &[f64],
    results: &mut Vec<SolveResult>,
) {
    let current_length = depth;

    // Check if we can accept at current length
    if current_length >= effective_min && constraint.is_accept(state) {
        let final_width = acc_width + wt.right(last_idx);
        let error = (final_width - target).abs();
        if error <= tolerance {
            results.push(SolveResult {
                text: path.iter().collect(),
                width: final_width,
                error,
            });
        }
    }

    // Stop if max length reached
    if current_length >= effective_max {
        return;
    }

    let chars_remaining = effective_max - current_length;

    // Try each allowed character in current state
    for &next_idx in constraint.allowed(state) {
        let ns = match constraint.next_state(state, next_idx) {
            Some(s) => s,
            None => continue,
        };

        let advance = wt.advance(last_idx, next_idx);
        let new_width = acc_width + advance;

        // Overshoot pruning
        if new_width > upper_bound {
            continue;
        }

        // Undershoot pruning: even with max advances for all remaining chars
        // plus the max right edge, can we reach the target?
        if chars_remaining > 1 {
            let max_possible =
                new_width + max_adv_per_state[ns] * ((chars_remaining - 1) as f64) + right_max;
            if max_possible + tolerance < target {
                continue;
            }
        }

        path.push(chars[next_idx]);
        dfs(
            depth + 1,
            new_width,
            next_idx,
            path,
            ns,
            chars,
            wt,
            target,
            tolerance,
            upper_bound,
            right_max,
            effective_min,
            effective_max,
            constraint,
            max_adv_per_state,
            results,
        );
        path.pop();
    }
}

/// For each state, BFS through the constraint's transition graph to find all
/// reachable character indices, then return the max advance among those chars.
fn compute_max_advance_per_state(
    wt: &WidthTable,
    constraint: &Constraint,
    num_states: usize,
    n: usize,
) -> Vec<f64> {
    let mut max_adv = Vec::with_capacity(num_states);

    for s in 0..num_states {
        let mut visited_states = vec![false; num_states];
        let mut reachable_chars = vec![false; n];
        let mut stack = vec![s];

        while let Some(curr) = stack.pop() {
            if visited_states[curr] {
                continue;
            }
            visited_states[curr] = true;

            for &char_idx in constraint.allowed(curr) {
                reachable_chars[char_idx] = true;
                if let Some(ns) = constraint.next_state(curr, char_idx) {
                    if !visited_states[ns] {
                        stack.push(ns);
                    }
                }
            }
        }

        // Compute max of table[from][to] for all `from` in 0..n and `to` in
        // reachable_chars. This mirrors the Python: `table[:, rc].max()`.
        let mut max_to_reachable = 0.0_f64;
        for from in 0..n {
            for to in 0..n {
                if reachable_chars[to] {
                    let adv = wt.advance(from, to);
                    if adv > max_to_reachable {
                        max_to_reachable = adv;
                    }
                }
            }
        }

        max_adv.push(max_to_reachable);
    }

    max_adv
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solver::constraint::Constraint;
    use crate::solver::width_table::WidthTable;

    fn make_uniform_wt(n: usize, char_width: f64) -> WidthTable {
        let table = vec![char_width; n * n];
        let left_edge = vec![char_width; n];
        let right_edge = vec![0.0; n];
        WidthTable::new(n, &table, &left_edge, &right_edge)
    }

    #[test]
    fn finds_exact_matches() {
        // charset "ab" (2 chars), each 10px, target 30px (3 chars)
        let wt = make_uniform_wt(2, 10.0);
        let c = Constraint::default_for(2);
        let results = solve("ab", &wt, 30.0, 0.5, 1, 5, &c);
        // Should find all 2^3 = 8 three-character combos
        assert_eq!(results.len(), 8);
        for r in &results {
            assert_eq!(r.text.len(), 3);
            assert!((r.width - 30.0).abs() <= 0.5);
        }
    }

    #[test]
    fn no_matches_outside_tolerance() {
        let wt = make_uniform_wt(2, 10.0);
        let c = Constraint::default_for(2);
        // Target 25 with tolerance 0 -- no 2-char(20) or 3-char(30) matches
        let results = solve("ab", &wt, 25.0, 0.0, 1, 5, &c);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn respects_min_length() {
        let wt = make_uniform_wt(2, 10.0);
        let c = Constraint::default_for(2);
        // Target 20 (2 chars), but min_length=3
        let results = solve("ab", &wt, 20.0, 0.5, 3, 5, &c);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn respects_max_length() {
        let wt = make_uniform_wt(2, 10.0);
        let c = Constraint::default_for(2);
        // Target 30 (3 chars), but max_length=2
        let results = solve("ab", &wt, 30.0, 0.5, 1, 2, &c);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn capitalized_constraint() {
        // charset "aAbB", each 10px, target 20px (2 chars)
        let wt = make_uniform_wt(4, 10.0);
        let c = Constraint::from_pattern("capitalized", "aAbB");
        let results = solve("aAbB", &wt, 20.0, 0.5, 1, 5, &c);
        // Valid: Aa, Ab, Ba, Bb (uppercase first, lowercase second)
        assert_eq!(results.len(), 4);
        for r in &results {
            let chars: Vec<char> = r.text.chars().collect();
            assert!(chars[0].is_uppercase());
            assert!(chars[1].is_lowercase());
        }
    }

    #[test]
    fn sorted_by_error_then_text() {
        // Use varying widths so errors differ
        let n = 2;
        let table = vec![9.0, 11.0, 9.0, 11.0];
        let left_edge = vec![9.0, 11.0];
        let right_edge = vec![0.0, 0.0];
        let wt = WidthTable::new(n, &table, &left_edge, &right_edge);
        let c = Constraint::default_for(2);
        let results = solve("ab", &wt, 20.0, 3.0, 1, 3, &c);
        // Check results are sorted by error ascending, then text ascending
        for i in 1..results.len() {
            let ord = results[i - 1]
                .error
                .partial_cmp(&results[i].error)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| results[i - 1].text.cmp(&results[i].text));
            assert!(
                ord != std::cmp::Ordering::Greater,
                "results not sorted: {:?} should come before {:?}",
                results[i - 1],
                results[i]
            );
        }
    }

    #[test]
    fn right_edge_included_in_width() {
        // right_edge adds extra width to final character
        let n = 2;
        let table = vec![10.0; 4];
        let left_edge = vec![10.0, 10.0];
        let right_edge = vec![2.0, 3.0]; // non-zero right edge
        let wt = WidthTable::new(n, &table, &left_edge, &right_edge);
        let c = Constraint::default_for(2);
        // 2 chars: left(10) + advance(10) + right(2 or 3) = 22 or 23
        let results = solve("ab", &wt, 22.0, 0.5, 2, 2, &c);
        // Only chars ending with 'a' (right_edge=2) should match: "aa", "ba"
        assert!(results.len() >= 1);
        for r in &results {
            assert!(r.text.ends_with('a'));
            assert!((r.width - 22.0).abs() <= 0.5);
        }
    }
}
