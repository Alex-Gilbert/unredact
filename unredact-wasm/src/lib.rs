use wasm_bindgen::prelude::*;

pub mod font;
pub mod image;
pub mod solver;
pub mod types;

#[wasm_bindgen]
pub fn ping() -> String {
    "unredact-core".to_string()
}
