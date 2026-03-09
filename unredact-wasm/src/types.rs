use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolveResult {
    pub text: String,
    pub width: f64,
    pub error: f64,
}

/// Config for dictionary-based solving (name, email, word, full_name modes).
/// JS measures widths via Canvas measureText() and passes (text, width) pairs.
#[derive(Deserialize)]
pub struct SolveConfig {
    pub entries: Vec<(String, f64)>,
    pub target_width: f64,
    pub tolerance: f64,
    #[serde(default)]
    pub known_start: String,
    #[serde(default)]
    pub known_end: String,
    pub mode: String,
}

/// Config for DFS-based solving.
/// JS measures all character pair widths and passes them as flat arrays.
#[derive(Deserialize)]
pub struct DfsSolveConfig {
    pub charset: String,
    /// Flat array of advance widths, length = charset_len^2
    /// advance_table[i * n + j] = advance from char i to char j
    pub advance_table: Vec<f64>,
    /// Left edge widths, length = charset_len
    pub left_edge: Vec<f64>,
    /// Right edge widths, length = charset_len
    pub right_edge: Vec<f64>,
    pub target_width: f64,
    pub tolerance: f64,
    #[serde(default = "default_min_length")]
    pub min_length: usize,
    #[serde(default = "default_max_length")]
    pub max_length: usize,
    /// Pattern: "none", "capitalized", "full_name_capitalized", "full_name_caps"
    #[serde(default)]
    pub constraint_pattern: String,
}

fn default_min_length() -> usize {
    1
}
fn default_max_length() -> usize {
    50
}
