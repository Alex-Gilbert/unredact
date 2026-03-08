use wasm_bindgen::prelude::*;

pub mod font;
pub mod image;
pub mod solver;
pub mod types;

use types::{DfsSolveConfig, SolveConfig};

#[wasm_bindgen]
pub fn ping() -> String {
    "unredact-core".to_string()
}

#[wasm_bindgen]
pub fn detect_redactions(pixels: &[u8], width: u32, height: u32) -> JsValue {
    let rects = image::detect_redactions_pipeline(pixels, width, height);
    serde_wasm_bindgen::to_value(&rects).unwrap()
}

#[wasm_bindgen]
pub fn spot_redaction(pixels: &[u8], width: u32, height: u32, x: u32, y: u32) -> JsValue {
    let rect = image::spot_redaction_pipeline(pixels, width, height, x, y);
    serde_wasm_bindgen::to_value(&rect).unwrap()
}

#[wasm_bindgen]
pub fn find_redaction_in_region(
    pixels: &[u8],
    width: u32,
    height: u32,
    x1: u32,
    y1: u32,
    x2: u32,
    y2: u32,
    padding: u32,
) -> JsValue {
    let rect =
        image::find_redaction_in_region(pixels, width, height, x1, y1, x2, y2, padding);
    serde_wasm_bindgen::to_value(&rect).unwrap()
}

#[wasm_bindgen]
pub fn score_font(
    page_pixels: &[u8],
    rendered_pixels: &[u8],
    width: u32,
    height: u32,
) -> f64 {
    font::pixel_match::best_ncc_score(page_pixels, rendered_pixels, width, height, 3)
}

#[wasm_bindgen]
pub fn score_font_dice(
    page_pixels: &[u8],
    rendered_pixels: &[u8],
    width: u32,
    height: u32,
) -> f64 {
    font::pixel_match::best_dice_score(page_pixels, rendered_pixels, width, height, 3)
}

#[wasm_bindgen]
pub fn score_font_no_shift(
    page_pixels: &[u8],
    rendered_pixels: &[u8],
    width: u32,
    height: u32,
) -> f64 {
    font::pixel_match::dice_score(page_pixels, rendered_pixels, width, height)
}

#[wasm_bindgen]
pub fn align_text(
    page_pixels: &[u8],
    pw: u32,
    ph: u32,
    rendered_pixels: &[u8],
    rw: u32,
    rh: u32,
    search_x: i32,
    search_y: i32,
) -> JsValue {
    let (dx, dy) = font::align::align_text_to_page(
        page_pixels, pw, ph, rendered_pixels, rw, rh, search_x, search_y,
    );
    serde_wasm_bindgen::to_value(&[dx, dy]).unwrap()
}

#[wasm_bindgen]
pub fn solve(config: JsValue) -> JsValue {
    let cfg: SolveConfig = serde_wasm_bindgen::from_value(config).unwrap();
    let results = match cfg.mode.as_str() {
        "full_name" => solver::full_name::match_full_names(
            &cfg.entries,
            cfg.target_width,
            cfg.tolerance,
            &cfg.known_start,
            &cfg.known_end,
        ),
        _ => solver::dictionary::match_entries_filtered(
            &cfg.entries,
            cfg.target_width,
            cfg.tolerance,
            &cfg.known_start,
            &cfg.known_end,
        ),
    };
    serde_wasm_bindgen::to_value(&results).unwrap()
}

#[wasm_bindgen]
pub fn solve_dfs(config: JsValue) -> JsValue {
    let cfg: DfsSolveConfig = serde_wasm_bindgen::from_value(config).unwrap();
    let n = cfg.charset.chars().count();
    let wt = solver::width_table::WidthTable::new(
        n,
        &cfg.advance_table,
        &cfg.left_edge,
        &cfg.right_edge,
    );
    let constraint =
        solver::constraint::Constraint::from_pattern(&cfg.constraint_pattern, &cfg.charset);
    let results = solver::dfs::solve(
        &cfg.charset,
        &wt,
        cfg.target_width,
        cfg.tolerance,
        cfg.min_length,
        cfg.max_length,
        &constraint,
    );
    serde_wasm_bindgen::to_value(&results).unwrap()
}
