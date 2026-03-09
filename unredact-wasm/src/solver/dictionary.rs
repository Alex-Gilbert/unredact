use crate::types::SolveResult;

/// Match pre-measured entries against target width.
/// entries: &[(text, measured_width)]
/// Returns entries within tolerance, sorted by (error, text).
pub fn match_entries(
    entries: &[(String, f64)],
    target: f64,
    tolerance: f64,
) -> Vec<SolveResult> {
    let mut results: Vec<SolveResult> = entries
        .iter()
        .filter_map(|(text, width)| {
            let error = (width - target).abs();
            if error <= tolerance {
                Some(SolveResult {
                    text: text.clone(),
                    width: *width,
                    error,
                })
            } else {
                None
            }
        })
        .collect();
    results.sort_by(|a, b| {
        a.error
            .partial_cmp(&b.error)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.text.cmp(&b.text))
    });
    results
}

/// Same as match_entries but with prefix/suffix filtering.
/// known_start: if non-empty, only entries starting with this (case-insensitive)
/// known_end: if non-empty, only entries ending with this (case-insensitive)
pub fn match_entries_filtered(
    entries: &[(String, f64)],
    target: f64,
    tolerance: f64,
    known_start: &str,
    known_end: &str,
) -> Vec<SolveResult> {
    let mut results: Vec<SolveResult> = entries
        .iter()
        .filter(|(text, _)| {
            let lower = text.to_lowercase();
            (known_start.is_empty() || lower.starts_with(&known_start.to_lowercase()))
                && (known_end.is_empty() || lower.ends_with(&known_end.to_lowercase()))
        })
        .filter_map(|(text, width)| {
            let error = (width - target).abs();
            if error <= tolerance {
                Some(SolveResult {
                    text: text.clone(),
                    width: *width,
                    error,
                })
            } else {
                None
            }
        })
        .collect();
    results.sort_by(|a, b| {
        a.error
            .partial_cmp(&b.error)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.text.cmp(&b.text))
    });
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_within_tolerance() {
        let entries = vec![
            ("cat".into(), 30.0),
            ("dog".into(), 30.5),
            ("elephant".into(), 80.0),
        ];
        let results = match_entries(&entries, 30.0, 1.0);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].text, "cat");
        assert_eq!(results[1].text, "dog");
    }

    #[test]
    fn no_matches() {
        let entries = vec![("cat".into(), 30.0)];
        let results = match_entries(&entries, 50.0, 1.0);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn sorted_by_error() {
        let entries = vec![
            ("aaa".into(), 28.0), // error 2
            ("bbb".into(), 30.0), // error 0
            ("ccc".into(), 29.0), // error 1
        ];
        let results = match_entries(&entries, 30.0, 3.0);
        assert_eq!(results[0].text, "bbb");
        assert_eq!(results[1].text, "ccc");
        assert_eq!(results[2].text, "aaa");
    }

    #[test]
    fn filters_by_known_start() {
        let entries = vec![
            ("cat".into(), 30.0),
            ("car".into(), 30.0),
            ("dog".into(), 30.0),
        ];
        let results = match_entries_filtered(&entries, 30.0, 1.0, "ca", "");
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn filters_by_known_end() {
        let entries = vec![
            ("cat".into(), 30.0),
            ("bat".into(), 30.0),
            ("dog".into(), 30.0),
        ];
        let results = match_entries_filtered(&entries, 30.0, 1.0, "", "at");
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn filters_case_insensitive() {
        let entries = vec![("Smith".into(), 30.0), ("Jones".into(), 30.0)];
        let results = match_entries_filtered(&entries, 30.0, 1.0, "sm", "");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].text, "Smith");
    }
}
