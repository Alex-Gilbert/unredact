/// Word/name filter for solver results.
/// Loads word lists at startup, stores as uppercase HashSets for case-insensitive lookup.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

pub struct WordFilter {
    pub words: HashSet<String>,
    pub first_names: HashSet<String>,
    pub last_names: HashSet<String>,
}

impl WordFilter {
    pub fn load(data_dir: &Path) -> Self {
        let words = load_set(&data_dir.join("words_alpha.txt"));
        let first_names = load_set(&data_dir.join("first_names.txt"));
        let last_names = load_set(&data_dir.join("last_names.txt"));
        eprintln!(
            "Loaded word filter: {} words, {} first names, {} last names",
            words.len(),
            first_names.len(),
            last_names.len(),
        );
        WordFilter { words, first_names, last_names }
    }

    /// Check if a single-word result passes the filter.
    /// prefix/suffix are prepended/appended before lookup (e.g. prefix="j" + text="oe" → "joe").
    pub fn check_word(&self, text: &str, mode: &str, prefix: &str, suffix: &str) -> bool {
        if mode == "none" {
            return true;
        }
        let full = format!("{}{}{}", prefix, text, suffix).to_uppercase();
        match mode {
            "words" => self.words.contains(&full),
            "names" => self.first_names.contains(&full) || self.last_names.contains(&full),
            "both" => {
                self.words.contains(&full)
                    || self.first_names.contains(&full)
                    || self.last_names.contains(&full)
            }
            _ => true,
        }
    }

    /// Check if a "First Last" result passes the filter.
    /// prefix is prepended to the first word, suffix appended to the last word.
    pub fn check_full_name(&self, text: &str, mode: &str, prefix: &str, suffix: &str) -> bool {
        if mode == "none" {
            return true;
        }
        let parts: Vec<&str> = text.split(' ').collect();
        if parts.len() != 2 {
            return false;
        }
        let first = format!("{}{}", prefix, parts[0]).to_uppercase();
        let last = format!("{}{}", parts[1], suffix).to_uppercase();

        match mode {
            "words" => self.words.contains(&first) && self.words.contains(&last),
            "names" => {
                let first_ok = self.first_names.contains(&first) || self.last_names.contains(&first);
                let last_ok = self.last_names.contains(&last) || self.first_names.contains(&last);
                first_ok && last_ok
            }
            "both" => {
                let first_ok = self.words.contains(&first)
                    || self.first_names.contains(&first)
                    || self.last_names.contains(&first);
                let last_ok = self.words.contains(&last)
                    || self.last_names.contains(&last)
                    || self.first_names.contains(&last);
                first_ok && last_ok
            }
            _ => true,
        }
    }
}

fn load_set(path: &Path) -> HashSet<String> {
    match fs::read_to_string(path) {
        Ok(content) => content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.trim().to_uppercase())
            .collect(),
        Err(e) => {
            eprintln!("Warning: could not load {}: {}", path.display(), e);
            HashSet::new()
        }
    }
}
