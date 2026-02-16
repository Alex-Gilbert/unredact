/// Core DFS branch-and-bound solver for string width matching.

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
) -> Vec<SolveResult> {
    let smax = compute_state_max(wt, constraint);
    let mut results = Vec::new();

    if prefix.is_empty() {
        // Start from scratch — iterate first chars
        for &first_idx in &constraint.state_allowed[start_state] {
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
            // SAFETY: path contains valid UTF-8 (ASCII charset chars)
            let text = unsafe { String::from_utf8_unchecked(path.clone()) };
            results.push(SolveResult {
                text,
                width: final_width,
                error: err,
            });
        }
    }

    if current_length >= max_length {
        return;
    }

    let chars_left = max_length - current_length;

    for &next_idx in &constraint.state_allowed[cstate] {
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
