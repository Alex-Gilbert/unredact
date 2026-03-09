use crate::types::SolveResult;

/// Match full name variants against target width.
/// JS generates all name variants (from associates list) and measures widths.
/// This is functionally identical to match_entries_filtered.
pub fn match_full_names(
    names: &[(String, f64)],
    target: f64,
    tolerance: f64,
    known_start: &str,
    known_end: &str,
) -> Vec<SolveResult> {
    super::dictionary::match_entries_filtered(names, target, tolerance, known_start, known_end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_full_names() {
        let names = vec![
            ("John Smith".into(), 95.0),
            ("Jane Doe".into(), 72.0),
            ("A B".into(), 20.0),
        ];
        let results = match_full_names(&names, 72.0, 2.0, "", "");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].text, "Jane Doe");
    }

    #[test]
    fn filters_by_start() {
        let names = vec![
            ("John Smith".into(), 95.0),
            ("John Doe".into(), 95.0),
            ("Jane Doe".into(), 95.0),
        ];
        let results = match_full_names(&names, 95.0, 1.0, "john", "");
        assert_eq!(results.len(), 2);
    }
}
