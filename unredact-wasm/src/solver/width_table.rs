use serde::{Deserialize, Serialize};

/// Kerning-aware width lookup table.
/// JS measures all character widths via Canvas measureText() and passes them in.
/// Rust stores them in a flat array for fast O(1) lookup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidthTable {
    /// Number of characters in the charset
    pub n: usize,
    /// Advance width from char i to char j: table[i * n + j]
    table: Vec<f64>,
    /// Width of char i when it's the first character (left edge of string)
    left_edge: Vec<f64>,
    /// Additional width after char i when it's the last character
    right_edge: Vec<f64>,
    /// Minimum advance from char i to any other char
    min_adv: Vec<f64>,
    /// Maximum advance from char i to any other char
    max_adv: Vec<f64>,
    /// Global minimum of left_edge values
    pub left_min: f64,
    /// Global maximum of left_edge values
    pub left_max: f64,
}

impl WidthTable {
    /// Build from JS-measured data.
    ///
    /// `pair_widths`: flat advance table of length `n*n`, where
    ///   `pair_widths[i*n+j]` = advance width of char j when preceded by char i.
    /// `left_edge[i]`: advance width of char i when it starts a line (or follows left context).
    /// `right_edge[i]`: extra width beyond the character itself when it ends a line.
    pub fn new(n: usize, pair_widths: &[f64], left_edge: &[f64], right_edge: &[f64]) -> Self {
        assert_eq!(pair_widths.len(), n * n);
        assert_eq!(left_edge.len(), n);
        assert_eq!(right_edge.len(), n);

        let table = pair_widths.to_vec();

        let mut min_adv = vec![f64::INFINITY; n];
        let mut max_adv = vec![f64::NEG_INFINITY; n];
        for i in 0..n {
            for j in 0..n {
                let w = table[i * n + j];
                if w < min_adv[i] {
                    min_adv[i] = w;
                }
                if w > max_adv[i] {
                    max_adv[i] = w;
                }
            }
        }

        let left_min = left_edge.iter().cloned().fold(f64::INFINITY, f64::min);
        let left_max = left_edge.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

        Self {
            n,
            table,
            left_edge: left_edge.to_vec(),
            right_edge: right_edge.to_vec(),
            min_adv,
            max_adv,
            left_min,
            left_max,
        }
    }

    #[inline]
    pub fn advance(&self, from: usize, to: usize) -> f64 {
        self.table[from * self.n + to]
    }

    #[inline]
    pub fn left(&self, idx: usize) -> f64 {
        self.left_edge[idx]
    }

    #[inline]
    pub fn right(&self, idx: usize) -> f64 {
        self.right_edge[idx]
    }

    #[inline]
    pub fn min_advance(&self, from: usize) -> f64 {
        self.min_adv[from]
    }

    #[inline]
    pub fn max_advance(&self, from: usize) -> f64 {
        self.max_adv[from]
    }

    /// Global minimum advance across all characters
    pub fn global_min_advance(&self) -> f64 {
        self.min_adv.iter().cloned().fold(f64::INFINITY, f64::min)
    }

    /// Global maximum advance across all characters
    pub fn global_max_advance(&self) -> f64 {
        self.max_adv.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_uniform_wt(n: usize, char_width: f64) -> WidthTable {
        let table = vec![char_width; n * n];
        let left_edge = vec![char_width; n];
        let right_edge = vec![0.0; n];
        WidthTable::new(n, &table, &left_edge, &right_edge)
    }

    #[test]
    fn uniform_advances() {
        let wt = make_uniform_wt(3, 10.0);
        assert!((wt.advance(0, 1) - 10.0).abs() < 0.001);
        assert!((wt.advance(2, 0) - 10.0).abs() < 0.001);
    }

    #[test]
    fn min_max_advance_uniform() {
        let wt = make_uniform_wt(3, 10.0);
        assert!((wt.min_advance(0) - 10.0).abs() < 0.001);
        assert!((wt.max_advance(0) - 10.0).abs() < 0.001);
    }

    #[test]
    fn varying_advances() {
        let n = 3;
        let table = vec![
            8.0, 10.0, 12.0, // from char 0
            9.0, 11.0, 7.0,  // from char 1
            6.0, 14.0, 10.0, // from char 2
        ];
        let left_edge = vec![8.0, 9.0, 6.0];
        let right_edge = vec![1.0, 0.5, 0.0];
        let wt = WidthTable::new(n, &table, &left_edge, &right_edge);

        assert!((wt.advance(0, 2) - 12.0).abs() < 0.001);
        assert!((wt.advance(2, 1) - 14.0).abs() < 0.001);

        // Min advance from char 0: min(8, 10, 12) = 8
        assert!((wt.min_advance(0) - 8.0).abs() < 0.001);
        // Max advance from char 2: max(6, 14, 10) = 14
        assert!((wt.max_advance(2) - 14.0).abs() < 0.001);

        assert!((wt.left(1) - 9.0).abs() < 0.001);
        assert!((wt.right(0) - 1.0).abs() < 0.001);
        assert!((wt.left_min - 6.0).abs() < 0.001);
        assert!((wt.left_max - 9.0).abs() < 0.001);
    }

    #[test]
    fn global_min_max() {
        let n = 2;
        let table = vec![5.0, 15.0, 8.0, 3.0];
        let left_edge = vec![5.0, 8.0];
        let right_edge = vec![0.0, 0.0];
        let wt = WidthTable::new(n, &table, &left_edge, &right_edge);
        assert!((wt.global_min_advance() - 3.0).abs() < 0.001);
        assert!((wt.global_max_advance() - 15.0).abs() < 0.001);
    }
}
