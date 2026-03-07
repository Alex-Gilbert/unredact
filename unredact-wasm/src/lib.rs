use wasm_bindgen::prelude::*;

pub mod font;
pub mod image;
pub mod solver;
pub mod types;

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
