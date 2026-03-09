use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Constraint {
    /// For each state, which character indices are allowed
    state_allowed: Vec<Vec<usize>>,
    /// state_next[state * charset_size + char_idx] = next state, or -1 if transition invalid
    state_next: Vec<i32>,
    /// Number of characters in the charset
    charset_size: usize,
    /// Which states are accepting (valid terminal states)
    accept: Vec<bool>,
}

/// Find indices in the charset where characters satisfy a predicate.
fn char_indices(charset: &str, predicate: impl Fn(char) -> bool) -> Vec<usize> {
    charset
        .chars()
        .enumerate()
        .filter(|(_, c)| predicate(*c))
        .map(|(i, _)| i)
        .collect()
}

impl Constraint {
    /// Build a constraint from explicit per-state definitions.
    ///
    /// `states` is a list of (allowed_indices, transitions) where each transition
    /// is (char_index, target_state). `accept_states` lists which states are accepting.
    fn build(charset_size: usize, states: &[(Vec<usize>, Vec<(usize, usize)>)], accept_states: &[usize]) -> Self {
        let num_states = states.len();
        let mut state_allowed = Vec::with_capacity(num_states);
        let mut state_next = vec![-1i32; num_states * charset_size];
        let mut accept = vec![false; num_states];

        for (s, (allowed, transitions)) in states.iter().enumerate() {
            state_allowed.push(allowed.clone());
            for &(char_idx, target) in transitions {
                state_next[s * charset_size + char_idx] = target as i32;
            }
        }

        for &s in accept_states {
            accept[s] = true;
        }

        Self {
            state_allowed,
            state_next,
            charset_size,
            accept,
        }
    }

    /// Default constraint: single state, all chars allowed, always accepting.
    pub fn default_for(charset_size: usize) -> Self {
        let all_indices: Vec<usize> = (0..charset_size).collect();
        let transitions: Vec<(usize, usize)> = (0..charset_size).map(|i| (i, 0)).collect();
        Self::build(charset_size, &[(all_indices, transitions)], &[0])
    }

    /// Build from a named pattern and charset string.
    /// Patterns: "none", "capitalized", "full_name_capitalized", "full_name_caps"
    pub fn from_pattern(pattern: &str, charset: &str) -> Self {
        let charset_size = charset.chars().count();
        let upper = char_indices(charset, |c| c.is_ascii_uppercase());
        let lower = char_indices(charset, |c| c.is_ascii_lowercase());
        let space_idx = charset.chars().position(|c| c == ' ');

        match pattern {
            "capitalized" => {
                // State 0: [A-Z] -> State 1
                // State 1: [a-z] -> State 1
                // Accept: {1}
                let s0_transitions: Vec<(usize, usize)> = upper.iter().map(|&i| (i, 1)).collect();
                let s1_transitions: Vec<(usize, usize)> = lower.iter().map(|&i| (i, 1)).collect();
                Self::build(
                    charset_size,
                    &[
                        (upper.clone(), s0_transitions),
                        (lower.clone(), s1_transitions),
                    ],
                    &[1],
                )
            }
            "full_name_capitalized" => {
                // State 0: [A-Z] -> 1
                // State 1: [a-z] -> 1, space -> 2
                // State 2: [A-Z] -> 3
                // State 3: [a-z] -> 3
                // Accept: {3}
                let s0_transitions: Vec<(usize, usize)> = upper.iter().map(|&i| (i, 1)).collect();

                let mut s1_allowed = lower.clone();
                let mut s1_transitions: Vec<(usize, usize)> = lower.iter().map(|&i| (i, 1)).collect();
                if let Some(si) = space_idx {
                    s1_allowed.push(si);
                    s1_transitions.push((si, 2));
                }

                let s2_transitions: Vec<(usize, usize)> = upper.iter().map(|&i| (i, 3)).collect();
                let s3_transitions: Vec<(usize, usize)> = lower.iter().map(|&i| (i, 3)).collect();

                Self::build(
                    charset_size,
                    &[
                        (upper.clone(), s0_transitions),
                        (s1_allowed, s1_transitions),
                        (upper.clone(), s2_transitions),
                        (lower.clone(), s3_transitions),
                    ],
                    &[3],
                )
            }
            "full_name_caps" => {
                // State 0: [A-Z] -> 1
                // State 1: [A-Z] -> 1, space -> 2
                // State 2: [A-Z] -> 3
                // State 3: [A-Z] -> 3
                // Accept: {3}
                let s0_transitions: Vec<(usize, usize)> = upper.iter().map(|&i| (i, 1)).collect();

                let mut s1_allowed = upper.clone();
                let mut s1_transitions: Vec<(usize, usize)> = upper.iter().map(|&i| (i, 1)).collect();
                if let Some(si) = space_idx {
                    s1_allowed.push(si);
                    s1_transitions.push((si, 2));
                }

                let s2_transitions: Vec<(usize, usize)> = upper.iter().map(|&i| (i, 3)).collect();
                let s3_transitions: Vec<(usize, usize)> = upper.iter().map(|&i| (i, 3)).collect();

                Self::build(
                    charset_size,
                    &[
                        (upper.clone(), s0_transitions),
                        (s1_allowed, s1_transitions),
                        (upper.clone(), s2_transitions),
                        (upper.clone(), s3_transitions),
                    ],
                    &[3],
                )
            }
            _ => Self::default_for(charset_size),
        }
    }

    /// Get allowed character indices for a given state.
    pub fn allowed(&self, state: usize) -> &[usize] {
        &self.state_allowed[state]
    }

    /// Get next state for a transition, or None if invalid.
    pub fn next_state(&self, state: usize, char_idx: usize) -> Option<usize> {
        let val = self.state_next[state * self.charset_size + char_idx];
        if val < 0 { None } else { Some(val as usize) }
    }

    /// Check if a state is accepting.
    pub fn is_accept(&self, state: usize) -> bool {
        self.accept[state]
    }

    /// Number of states.
    pub fn num_states(&self) -> usize {
        self.state_allowed.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_allows_everything() {
        let c = Constraint::default_for(5);
        assert_eq!(c.allowed(0), &[0, 1, 2, 3, 4]);
        assert!(c.is_accept(0));
        assert_eq!(c.next_state(0, 3), Some(0));
    }

    #[test]
    fn capitalized_pattern() {
        let c = Constraint::from_pattern("capitalized", "abcABC");
        // State 0: only uppercase (indices 3,4,5)
        let mut allowed = c.allowed(0).to_vec();
        allowed.sort();
        assert_eq!(allowed, vec![3, 4, 5]);
        // State 0 is not accepting
        assert!(!c.is_accept(0));
        // Transition from state 0 with uppercase goes to state 1
        assert_eq!(c.next_state(0, 3), Some(1));
        // Transition from state 0 with lowercase is invalid
        assert_eq!(c.next_state(0, 0), None);
        // State 1: only lowercase (indices 0,1,2)
        let mut allowed1 = c.allowed(1).to_vec();
        allowed1.sort();
        assert_eq!(allowed1, vec![0, 1, 2]);
        // State 1 is accepting
        assert!(c.is_accept(1));
        // State 1 stays in state 1
        assert_eq!(c.next_state(1, 0), Some(1));
    }

    #[test]
    fn full_name_capitalized() {
        let c = Constraint::from_pattern("full_name_capitalized", "abcABC ");
        // Space is at index 6
        assert_eq!(c.num_states(), 4);
        // State 0: uppercase only
        assert!(!c.is_accept(0));
        // State 1: lowercase + space
        assert!(!c.is_accept(1));
        // State 1 + space -> state 2
        assert_eq!(c.next_state(1, 6), Some(2));
        // State 2: uppercase only
        assert!(!c.is_accept(2));
        // State 3: lowercase, accepting
        assert!(c.is_accept(3));
    }

    #[test]
    fn full_name_caps() {
        let c = Constraint::from_pattern("full_name_caps", "ABC ");
        // charset: A=0, B=1, C=2, space=3
        assert_eq!(c.num_states(), 4);
        // State 0: uppercase -> state 1
        assert_eq!(c.next_state(0, 0), Some(1));
        // State 1: uppercase -> state 1, space -> state 2
        assert_eq!(c.next_state(1, 0), Some(1));
        assert_eq!(c.next_state(1, 3), Some(2));
        // State 3 is accepting
        assert!(c.is_accept(3));
    }

    #[test]
    fn none_pattern_is_default() {
        let c = Constraint::from_pattern("none", "abc");
        assert_eq!(c.allowed(0), &[0, 1, 2]);
        assert!(c.is_accept(0));
    }
}
