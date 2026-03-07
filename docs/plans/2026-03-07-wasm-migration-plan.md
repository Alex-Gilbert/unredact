# WASM Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate unredact from a Python/Rust server app to a fully client-side static webpage using Rust WASM + vanilla JS.

**Architecture:** Single Rust WASM crate (`unredact-wasm`) for compute (image processing, font matching, solver). JavaScript orchestrates PDF.js, Tesseract.js, Anthropic API, and WASM calls. IndexedDB for persistence. No server infrastructure.

**Tech Stack:** Rust (wasm-pack, wasm-bindgen, serde), JavaScript (vanilla, PDF.js, Tesseract.js), IndexedDB

**Design Doc:** `docs/plans/2026-03-07-wasm-migration-design.md`

---

## Phase 1: Rust WASM Core

### Task 1: Project Scaffold

**Files:**
- Create: `unredact-wasm/Cargo.toml`
- Create: `unredact-wasm/src/lib.rs`
- Create: `unredact-wasm/src/types.rs`
- Create: `unredact-wasm/src/image/mod.rs`
- Create: `unredact-wasm/src/font/mod.rs`
- Create: `unredact-wasm/src/solver/mod.rs`

**Step 1: Create Cargo.toml**

```toml
[package]
name = "unredact-core"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
js-sys = "0.3"

[dev-dependencies]
wasm-bindgen-test = "0.3"

[profile.release]
opt-level = 3
lto = true
```

**Step 2: Create lib.rs with a smoke-test FFI function**

```rust
use wasm_bindgen::prelude::*;

pub mod image;
pub mod font;
pub mod solver;
pub mod types;

#[wasm_bindgen]
pub fn ping() -> String {
    "unredact-core".to_string()
}
```

**Step 3: Create empty module files**

Each mod.rs is empty for now. `types.rs` has shared types:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
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
```

**Step 4: Build with wasm-pack**

Run: `cd unredact-wasm && wasm-pack build --target web --dev`
Expected: Produces `pkg/` directory with `.wasm` and `.js` files

**Step 5: Write a wasm-bindgen test**

```rust
// tests/smoke.rs
use wasm_bindgen_test::*;
wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn test_ping() {
    assert_eq!(unredact_core::ping(), "unredact-core");
}
```

Run: `cd unredact-wasm && wasm-pack test --node`
Expected: PASS

**Step 6: Commit**

```bash
git add unredact-wasm/
git commit -m "feat: scaffold unredact-wasm crate with wasm-pack"
```

---

### Task 2: Image Processing — Grayscale & Threshold

**Files:**
- Create: `unredact-wasm/src/image/grayscale.rs`
- Create: `unredact-wasm/src/image/threshold.rs`
- Modify: `unredact-wasm/src/image/mod.rs`

**Step 1: Write failing tests for grayscale**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rgba_to_grayscale() {
        // 2x1 image: red pixel, white pixel (RGBA)
        let rgba = vec![255, 0, 0, 255, 255, 255, 255, 255];
        let gray = rgba_to_grayscale(&rgba, 2, 1);
        assert_eq!(gray.len(), 2);
        // Red: 0.299*255 + 0.587*0 + 0.114*0 = 76
        assert_eq!(gray[0], 76);
        // White: 0.299*255 + 0.587*255 + 0.114*255 = 255
        assert_eq!(gray[1], 255);
    }
}
```

Run: `cd unredact-wasm && cargo test`
Expected: FAIL — function not defined

**Step 2: Implement grayscale**

```rust
/// Convert RGBA pixel buffer to grayscale using luminance weights.
/// Input: &[u8] of length width*height*4 (RGBA)
/// Output: Vec<u8> of length width*height
pub fn rgba_to_grayscale(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let n = (width * height) as usize;
    let mut gray = Vec::with_capacity(n);
    for i in 0..n {
        let r = rgba[i * 4] as f32;
        let g = rgba[i * 4 + 1] as f32;
        let b = rgba[i * 4 + 2] as f32;
        gray.push((0.299 * r + 0.587 * g + 0.114 * b) as u8);
    }
    gray
}
```

Run: `cd unredact-wasm && cargo test`
Expected: PASS

**Step 3: Write failing tests for threshold**

```rust
#[test]
fn test_threshold_binary_inv() {
    let gray = vec![0, 39, 40, 41, 128, 255];
    let bin = threshold_binary_inv(&gray, 40);
    // Pixels < 40 become 255, >= 40 become 0
    assert_eq!(bin, vec![255, 255, 0, 0, 0, 0]);
}
```

Run: `cd unredact-wasm && cargo test`
Expected: FAIL

**Step 4: Implement threshold**

```rust
/// Binary inverse threshold: pixels < threshold become 255, others become 0.
pub fn threshold_binary_inv(gray: &[u8], threshold: u8) -> Vec<u8> {
    gray.iter().map(|&p| if p < threshold { 255 } else { 0 }).collect()
}
```

Run: `cd unredact-wasm && cargo test`
Expected: PASS

**Step 5: Commit**

```bash
git add unredact-wasm/src/image/
git commit -m "feat(wasm): grayscale conversion and binary threshold"
```

---

### Task 3: Image Processing — Morphological Operations

**Files:**
- Create: `unredact-wasm/src/image/morphology.rs`
- Modify: `unredact-wasm/src/image/mod.rs`

**Step 1: Write failing tests for dilate and erode**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dilate_expands() {
        // 5x5 image with single white pixel in center
        let mut img = vec![0u8; 25];
        img[12] = 255; // center pixel (2,2)
        let result = dilate(&img, 5, 5, 3, 1); // kernel 3x1 (width x height)
        // Should expand horizontally: pixels at (1,2), (2,2), (3,2) should be 255
        assert_eq!(result[11], 255); // (1,2)
        assert_eq!(result[12], 255); // (2,2)
        assert_eq!(result[13], 255); // (3,2)
        assert_eq!(result[7], 0);   // (2,1) — not expanded vertically
    }

    #[test]
    fn test_erode_shrinks() {
        // 5x5 image, full row of white
        let mut img = vec![0u8; 25];
        for x in 0..5 { img[2 * 5 + x] = 255; } // row 2 all white
        let result = erode(&img, 5, 5, 3, 1);
        // Edges of the row should be eroded with kernel width 3
        assert_eq!(result[10], 0);   // (0,2) — edge eroded
        assert_eq!(result[11], 255); // (1,2) — interior preserved
        assert_eq!(result[12], 255); // (2,2)
        assert_eq!(result[13], 255); // (3,2)
        assert_eq!(result[14], 0);   // (4,2) — edge eroded
    }

    #[test]
    fn test_morphological_close() {
        // Close = dilate then erode — fills small gaps
        let mut img = vec![0u8; 25];
        img[2 * 5 + 1] = 255;
        img[2 * 5 + 3] = 255;
        // Gap at (2,2) between two white pixels
        let result = close(&img, 5, 5, 3, 1);
        // After close, the gap should be filled
        assert_eq!(result[2 * 5 + 2], 255);
    }
}
```

Run: `cd unredact-wasm && cargo test`
Expected: FAIL

**Step 2: Implement dilate, erode, close**

Dilate: for each pixel, output is max of all pixels in kernel neighborhood.
Erode: for each pixel, output is min of all pixels in kernel neighborhood.
Close: dilate then erode.

Kernel is rectangular with given (kw, kh). The Python code uses kernel (15, 3).

```rust
/// Dilate: max filter with rectangular kernel (kw x kh)
pub fn dilate(img: &[u8], w: u32, h: u32, kw: u32, kh: u32) -> Vec<u8> { ... }

/// Erode: min filter with rectangular kernel (kw x kh)
pub fn erode(img: &[u8], w: u32, h: u32, kw: u32, kh: u32) -> Vec<u8> { ... }

/// Morphological close: dilate then erode
pub fn close(img: &[u8], w: u32, h: u32, kw: u32, kh: u32) -> Vec<u8> {
    let dilated = dilate(img, w, h, kw, kh);
    erode(&dilated, w, h, kw, kh)
}
```

Run: `cd unredact-wasm && cargo test`
Expected: PASS

**Step 3: Commit**

```bash
git add unredact-wasm/src/image/morphology.rs
git commit -m "feat(wasm): morphological dilate, erode, close operations"
```

---

### Task 4: Image Processing — Contour Tracing & Bounding Boxes

**Files:**
- Create: `unredact-wasm/src/image/contours.rs`
- Modify: `unredact-wasm/src/image/mod.rs`

**Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_contours_single_rect() {
        // 10x10 image with a 4x2 white rectangle at (3,4)
        let mut img = vec![0u8; 100];
        for y in 4..6 {
            for x in 3..7 {
                img[y * 10 + x] = 255;
            }
        }
        let rects = find_bounding_rects(&img, 10, 10);
        assert_eq!(rects.len(), 1);
        assert_eq!(rects[0], Rect { x: 3, y: 4, w: 4, h: 2 });
    }

    #[test]
    fn test_find_contours_filters_small() {
        // Tiny 2x2 rect should be filtered by MIN_AREA
        let mut img = vec![0u8; 100];
        for y in 0..2 { for x in 0..2 { img[y * 10 + x] = 255; } }
        let rects = find_bounding_rects(&img, 10, 10);
        assert_eq!(rects.len(), 0); // area=4 < MIN_AREA=500
    }
}
```

Run: `cd unredact-wasm && cargo test`
Expected: FAIL

**Step 2: Implement contour tracing**

Use connected-components labeling (two-pass union-find) to find distinct blobs, then compute bounding box per label. Apply filters:
- `MIN_AREA = 500`
- `MIN_ASPECT = 1.5` (w/h)
- `FILL_RATIO = 0.7` (pixel count / bbox area)

Sort results by (y, x).

```rust
use crate::types::Rect;

const MIN_AREA: u32 = 500;
const MIN_ASPECT: f64 = 1.5;
const FILL_RATIO: f64 = 0.7;

pub fn find_bounding_rects(binary: &[u8], w: u32, h: u32) -> Vec<Rect> { ... }
```

Ref: The Python code uses `cv2.findContours(binary, RETR_EXTERNAL, CHAIN_APPROX_SIMPLE)` + `cv2.boundingRect`. Our implementation finds connected components, computes bounding boxes, and applies the same filters.

Run: `cd unredact-wasm && cargo test`
Expected: PASS

**Step 3: Commit**

```bash
git add unredact-wasm/src/image/contours.rs
git commit -m "feat(wasm): contour detection with bounding box extraction and filtering"
```

---

### Task 5: Image Processing — Flood Fill (Connected Components Click-to-Select)

**Files:**
- Create: `unredact-wasm/src/image/flood_fill.rs`
- Modify: `unredact-wasm/src/image/mod.rs`

**Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Rect;

    #[test]
    fn test_flood_fill_finds_component() {
        // 10x10 image with L-shaped white region
        let mut img = vec![0u8; 100];
        for x in 2..6 { img[3 * 10 + x] = 255; } // horizontal bar
        for y in 3..7 { img[y * 10 + 2] = 255; }  // vertical bar
        let result = flood_fill_rect(&img, 10, 10, 4, 3);
        assert!(result.is_some());
        let r = result.unwrap();
        assert_eq!(r.x, 2);
        assert_eq!(r.y, 3);
        assert_eq!(r.w, 4);
        assert_eq!(r.h, 4);
    }

    #[test]
    fn test_flood_fill_background_returns_none() {
        let img = vec![0u8; 100];
        let result = flood_fill_rect(&img, 10, 10, 5, 5);
        assert!(result.is_none());
    }

    #[test]
    fn test_flood_fill_too_small_returns_none() {
        let mut img = vec![0u8; 100];
        img[55] = 255; // single pixel
        let result = flood_fill_rect(&img, 10, 10, 5, 5);
        assert!(result.is_none()); // area=1 < SPOT_MIN_AREA=100
    }
}
```

Run: `cd unredact-wasm && cargo test`
Expected: FAIL

**Step 2: Implement flood fill**

BFS/DFS from click point, collect all connected foreground pixels, compute bounding box.

```rust
use crate::types::Rect;

const SPOT_MIN_AREA: u32 = 100;

/// Flood fill from (click_x, click_y) on a binary image.
/// Returns bounding rect of the connected component, or None if background/too small.
pub fn flood_fill_rect(binary: &[u8], w: u32, h: u32, click_x: u32, click_y: u32) -> Option<Rect> { ... }
```

Run: `cd unredact-wasm && cargo test`
Expected: PASS

**Step 3: Commit**

```bash
git add unredact-wasm/src/image/flood_fill.rs
git commit -m "feat(wasm): flood fill connected component detection for click-to-select"
```

---

### Task 6: Image Processing — FFI Entry Points

**Files:**
- Modify: `unredact-wasm/src/lib.rs`
- Modify: `unredact-wasm/src/image/mod.rs`

**Step 1: Write the top-level detect_redactions pipeline**

Combines grayscale → threshold(40) → close(15,3) → find_bounding_rects.

```rust
pub fn detect_redactions_pipeline(rgba: &[u8], w: u32, h: u32) -> Vec<Rect> {
    let gray = grayscale::rgba_to_grayscale(rgba, w, h);
    let binary = threshold::threshold_binary_inv(&gray, 40);
    let closed = morphology::close(&binary, w, h, 15, 3);
    contours::find_bounding_rects(&closed, w, h)
}
```

**Step 2: Write the spot_redaction pipeline**

Combines grayscale → threshold(40) → flood_fill_rect.

```rust
pub fn spot_redaction_pipeline(rgba: &[u8], w: u32, h: u32, x: u32, y: u32) -> Option<Rect> {
    let gray = grayscale::rgba_to_grayscale(rgba, w, h);
    let binary = threshold::threshold_binary_inv(&gray, 40);
    flood_fill::flood_fill_rect(&binary, w, h, x, y)
}
```

**Step 3: Write the find_redaction_in_region pipeline**

Crops to region with padding, runs detect pipeline, returns largest result.

```rust
pub fn find_redaction_in_region(rgba: &[u8], w: u32, h: u32,
    search_x1: u32, search_y1: u32, search_x2: u32, search_y2: u32,
    padding: u32) -> Option<Rect> { ... }
```

Constants: `GUIDED_MIN_AREA = 100`, `DEFAULT_PADDING = 10`

**Step 4: Add wasm_bindgen exports in lib.rs**

```rust
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
```

Note: add `serde-wasm-bindgen = "0.6"` to Cargo.toml dependencies.

**Step 5: Build and verify**

Run: `cd unredact-wasm && wasm-pack build --target web --dev`
Expected: Builds successfully, exports `detect_redactions` and `spot_redaction`

**Step 6: Commit**

```bash
git add unredact-wasm/
git commit -m "feat(wasm): expose detect_redactions and spot_redaction FFI"
```

---

### Task 7: Font Pixel Matching — Dice Coefficient Scoring

**Files:**
- Create: `unredact-wasm/src/font/pixel_match.rs`
- Modify: `unredact-wasm/src/font/mod.rs`

**Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dice_identical_images() {
        let img = vec![0u8; 100]; // 10x10 binary, all black (ink)
        let score = dice_score(&img, &img, 10, 10);
        assert!((score - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_dice_no_overlap() {
        let mut a = vec![255u8; 100]; // all white (no ink)
        let mut b = vec![255u8; 100];
        a[0] = 0; // one ink pixel in a
        b[99] = 0; // one ink pixel in b, different location
        let score = dice_score(&a, &b, 10, 10);
        assert!((score - 0.0).abs() < 0.001);
    }

    #[test]
    fn test_dice_with_shifts() {
        // Page has ink at (5,5), rendered has ink at (6,5) — shift of 1
        let mut page = vec![255u8; 100];
        let mut rendered = vec![255u8; 100];
        page[55] = 0;     // (5,5)
        rendered[56] = 0;  // (6,5)
        let score = best_dice_score(&page, &rendered, 10, 10, 3);
        assert!(score > 0.5); // Should find overlap with dx=1
    }
}
```

Run: `cd unredact-wasm && cargo test`
Expected: FAIL

**Step 2: Implement Dice scoring with shift search**

Ref: Python `_score_font_line_pixel` — binarize at 128, count ink pixels, try ±3 shifts, compute `2 * intersection / (page_ink + rendered_ink)`.

```rust
const BINARIZE_THRESHOLD: u8 = 128;

/// Dice coefficient between two grayscale images (binarized at threshold 128).
/// Ink = pixel < 128.
pub fn dice_score(page_gray: &[u8], rendered_gray: &[u8], w: u32, h: u32) -> f64 { ... }

/// Best Dice score across all shifts in [-shift_range, shift_range] for both dx and dy.
/// Python uses shift_range=3 (7x7 search grid).
pub fn best_dice_score(page_gray: &[u8], rendered_gray: &[u8], w: u32, h: u32, shift_range: i32) -> f64 { ... }

/// Score font with redaction masking. char_runs provides positions of clean text.
/// Rendered image is provided by JS (rendered via Canvas).
pub fn score_font_masked(
    page_gray: &[u8], rendered_gray: &[u8],
    w: u32, h: u32, shift_range: i32
) -> f64 {
    best_dice_score(page_gray, rendered_gray, w, h, shift_range)
}
```

Constants: `SHIFT_RANGE = 3`, `MIN_CROP_H = 5`, `MIN_CROP_W = 10`, `MIN_INK = 10`

Run: `cd unredact-wasm && cargo test`
Expected: PASS

**Step 3: Commit**

```bash
git add unredact-wasm/src/font/
git commit -m "feat(wasm): Dice coefficient font pixel matching with shift search"
```

---

### Task 8: Font Pixel Matching — Alignment Search

**Files:**
- Create: `unredact-wasm/src/font/align.rs`
- Modify: `unredact-wasm/src/font/mod.rs`

**Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_align_finds_offset() {
        // 20x10 page crop with ink at x=5
        // 30x20 rendered canvas with text at x=15 (search_x=10 offset)
        // Expected alignment offset: dx = -(15-10-5) = 0...
        // Test with a simple known offset
        let w = 20u32;
        let h = 10u32;
        let mut page = vec![255u8; (w * h) as usize];
        // Ink block at x=5..8, y=3..6
        for y in 3..6 {
            for x in 5..8 {
                page[(y * w + x) as usize] = 0;
            }
        }

        let search_x: i32 = 10;
        let search_y: i32 = 5;
        let cw = (w as i32 + search_x * 2) as u32;
        let ch = (h as i32 + search_y * 2) as u32;
        let mut rendered = vec![255u8; (cw * ch) as usize];
        // Same ink block shifted by (search_x + 2, search_y + 1) = (12, 6)
        for y in 6..9 {
            for x in 12..15 {
                rendered[(y * cw + x) as usize] = 0;
            }
        }

        let (dx, dy) = align_text_to_page(&page, w, h, &rendered, cw, ch, search_x, search_y);
        assert_eq!(dx, -2);
        assert_eq!(dy, -1);
    }
}
```

Run: `cd unredact-wasm && cargo test`
Expected: FAIL

**Step 2: Implement alignment search**

Ref: Python `align_text_to_page` — grid search over `[-search_x, search_x] x [-search_y, search_y]`, extract window from rendered canvas, compute Dice, return best `(-best_dx, -best_dy)`.

```rust
/// Find best pixel offset to align rendered text with page crop.
/// Returns (offset_x, offset_y) to apply to rendering position.
/// page_gray: (w x h) grayscale crop of page
/// rendered_gray: ((w + 2*search_x) x (h + 2*search_y)) grayscale canvas with text rendered at center
pub fn align_text_to_page(
    page_gray: &[u8], pw: u32, ph: u32,
    rendered_gray: &[u8], rw: u32, rh: u32,
    search_x: i32, search_y: i32,
) -> (i32, i32) { ... }
```

Constants: `DEFAULT_SEARCH_X = 20`, `DEFAULT_SEARCH_Y = 10`

Run: `cd unredact-wasm && cargo test`
Expected: PASS

**Step 3: Commit**

```bash
git add unredact-wasm/src/font/align.rs
git commit -m "feat(wasm): pixel alignment search for font overlay positioning"
```

---

### Task 9: Font Matching — FFI Entry Points

**Files:**
- Modify: `unredact-wasm/src/lib.rs`
- Modify: `unredact-wasm/src/font/mod.rs`

**Step 1: Add wasm_bindgen exports**

```rust
#[wasm_bindgen]
pub fn score_font(
    page_pixels: &[u8], rendered_pixels: &[u8],
    width: u32, height: u32
) -> f64 {
    font::pixel_match::best_dice_score(page_pixels, rendered_pixels, width, height, 3)
}

#[wasm_bindgen]
pub fn align_text(
    page_pixels: &[u8], pw: u32, ph: u32,
    rendered_pixels: &[u8], rw: u32, rh: u32,
    search_x: i32, search_y: i32,
) -> JsValue {
    let (dx, dy) = font::align::align_text_to_page(
        page_pixels, pw, ph, rendered_pixels, rw, rh, search_x, search_y
    );
    serde_wasm_bindgen::to_value(&(dx, dy)).unwrap()
}
```

**Step 2: Build and verify**

Run: `cd unredact-wasm && wasm-pack build --target web --dev`
Expected: Builds successfully

**Step 3: Commit**

```bash
git add unredact-wasm/
git commit -m "feat(wasm): expose font scoring and alignment FFI"
```

---

### Task 10: Solver — Width Table

**Files:**
- Create: `unredact-wasm/src/solver/width_table.rs`
- Modify: `unredact-wasm/src/solver/mod.rs`

**Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_width_table() {
        // 3-char charset "abc"
        // Simulated widths: a=10, b=12, c=8
        // Pair widths: ab=21, ac=17, ba=22, bc=19, ca=18, cb=20
        // Advance ab = pair_ab - single_a = 21 - 10 = 11
        let single = vec![10.0, 12.0, 8.0];
        let pairs = vec![
            // (i, j, pair_width)
            (0, 0, 20.0), (0, 1, 21.0), (0, 2, 17.0),
            (1, 0, 22.0), (1, 1, 24.0), (1, 2, 19.0),
            (2, 0, 18.0), (2, 1, 20.0), (2, 2, 16.0),
        ];
        let left_edge = vec![10.0, 12.0, 8.0]; // no left context
        let right_edge = vec![0.0, 0.0, 0.0];   // no right context

        let wt = WidthTable::new(3, &single, &pairs, &left_edge, &right_edge);

        // Advance a→b = pair(ab) - single(a) = 21 - 10 = 11
        assert!((wt.advance(0, 1) - 11.0).abs() < 0.001);
        // Advance c→a = pair(ca) - single(c) = 18 - 8 = 10
        assert!((wt.advance(2, 0) - 10.0).abs() < 0.001);
    }

    #[test]
    fn test_min_max_advance() {
        let single = vec![10.0, 12.0, 8.0];
        let pairs = vec![
            (0, 0, 20.0), (0, 1, 21.0), (0, 2, 17.0),
            (1, 0, 22.0), (1, 1, 24.0), (1, 2, 19.0),
            (2, 0, 18.0), (2, 1, 20.0), (2, 2, 16.0),
        ];
        let left_edge = vec![10.0, 12.0, 8.0];
        let right_edge = vec![0.0, 0.0, 0.0];
        let wt = WidthTable::new(3, &single, &pairs, &left_edge, &right_edge);

        // min_advance[0] = min(10, 11, 7) = 7
        assert!((wt.min_advance(0) - 7.0).abs() < 0.001);
    }
}
```

Run: `cd unredact-wasm && cargo test`
Expected: FAIL

**Step 2: Implement WidthTable**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidthTable {
    n: usize,
    table: Vec<f64>,       // n x n flattened
    left_edge: Vec<f64>,   // n
    right_edge: Vec<f64>,  // n
    min_adv: Vec<f64>,     // n — min advance per char
    max_adv: Vec<f64>,     // n — max advance per char
    pub left_min: f64,
    pub left_max: f64,
}

impl WidthTable {
    pub fn new(n: usize, single: &[f64], pairs: &[(usize, usize, f64)],
               left_edge: &[f64], right_edge: &[f64]) -> Self { ... }

    pub fn advance(&self, from: usize, to: usize) -> f64 {
        self.table[from * self.n + to]
    }
    pub fn left(&self, idx: usize) -> f64 { self.left_edge[idx] }
    pub fn right(&self, idx: usize) -> f64 { self.right_edge[idx] }
    pub fn min_advance(&self, idx: usize) -> f64 { self.min_adv[idx] }
    pub fn max_advance(&self, idx: usize) -> f64 { self.max_adv[idx] }
}
```

The `new` constructor computes `table[i][j] = pair_width(i,j) - single_width(i)`, then derives min/max per row.

Run: `cd unredact-wasm && cargo test`
Expected: PASS

**Step 3: Commit**

```bash
git add unredact-wasm/src/solver/width_table.rs
git commit -m "feat(wasm): kerning-aware width table for solver"
```

---

### Task 11: Solver — FSM Constraints

**Files:**
- Create: `unredact-wasm/src/solver/constraint.rs`
- Modify: `unredact-wasm/src/solver/mod.rs`

**Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_constraint() {
        let c = Constraint::default_for(5);
        assert_eq!(c.allowed(0), (0..5).collect::<Vec<_>>());
        assert!(c.is_accept(0));
        assert_eq!(c.next_state(0, 3), Some(0));
    }

    #[test]
    fn test_capitalized_constraint() {
        // charset: "abcABC" — indices 0-2 lowercase, 3-5 uppercase
        let charset = "abcABC";
        let c = Constraint::capitalized(charset);
        // State 0: only uppercase (indices 3,4,5)
        assert_eq!(c.allowed(0), vec![3, 4, 5]);
        // State 1: only lowercase (indices 0,1,2)
        assert_eq!(c.allowed(1), vec![0, 1, 2]);
        // State 0 is not accept, state 1 is accept
        assert!(!c.is_accept(0));
        assert!(c.is_accept(1));
    }
}
```

Run: `cd unredact-wasm && cargo test`
Expected: FAIL

**Step 2: Implement Constraint**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Constraint {
    state_allowed: Vec<Vec<usize>>,   // state → allowed char indices
    state_next: Vec<Vec<i32>>,        // state × charset_size → next state (-1 = invalid)
    accept_states: Vec<bool>,         // which states are accepting
}

impl Constraint {
    pub fn default_for(n: usize) -> Self { ... }
    pub fn capitalized(charset: &str) -> Self { ... }
    pub fn full_name_capitalized(charset: &str) -> Self { ... }
    pub fn full_name_caps(charset: &str) -> Self { ... }
    pub fn allowed(&self, state: usize) -> &[usize] { ... }
    pub fn next_state(&self, state: usize, char_idx: usize) -> Option<usize> { ... }
    pub fn is_accept(&self, state: usize) -> bool { ... }
}
```

Patterns from Python `build_constraint`:
- `capitalized`: State 0 = [A-Z] → State 1, State 1 = [a-z] → State 1. Accept: {1}
- `full_name_capitalized`: State 0=[A-Z]→1, State 1=[a-z,space]→1 or 2, State 2=[A-Z]→3, State 3=[a-z]→3. Accept: {3}
- `full_name_caps`: Same but all uppercase

Run: `cd unredact-wasm && cargo test`
Expected: PASS

**Step 3: Commit**

```bash
git add unredact-wasm/src/solver/constraint.rs
git commit -m "feat(wasm): FSM constraints for casing patterns"
```

---

### Task 12: Solver — DFS Branch-and-Bound

**Files:**
- Create: `unredact-wasm/src/solver/dfs.rs`
- Modify: `unredact-wasm/src/solver/mod.rs`

**Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::solver::width_table::WidthTable;
    use crate::solver::constraint::Constraint;

    fn make_uniform_wt(n: usize, char_width: f64) -> WidthTable {
        let single: Vec<f64> = vec![char_width; n];
        let mut pairs = Vec::new();
        for i in 0..n {
            for j in 0..n {
                pairs.push((i, j, char_width * 2.0)); // no kerning
            }
        }
        let left_edge = vec![char_width; n];
        let right_edge = vec![0.0; n];
        WidthTable::new(n, &single, &pairs, &left_edge, &right_edge)
    }

    #[test]
    fn test_dfs_finds_exact_match() {
        // Charset "ab", each char width=10, target=30 (3 chars)
        let wt = make_uniform_wt(2, 10.0);
        let constraint = Constraint::default_for(2);
        let results = solve(&wt, 30.0, 0.5, 1, 5, &constraint);
        // Should find all 3-char combos: aaa, aab, aba, abb, baa, bab, bba, bbb
        assert_eq!(results.len(), 8);
        for r in &results {
            assert_eq!(r.text.len(), 3);
            assert!((r.width - 30.0).abs() < 0.5);
        }
    }

    #[test]
    fn test_dfs_respects_tolerance() {
        let wt = make_uniform_wt(2, 10.0);
        let constraint = Constraint::default_for(2);
        // Target=25 with tolerance=0 — no 2-char (20) or 3-char (30) matches
        let results = solve(&wt, 25.0, 0.0, 1, 5, &constraint);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_dfs_with_capitalized_constraint() {
        // Charset "aAbB", target=20 (2 chars, width=10 each)
        let wt = make_uniform_wt(4, 10.0);
        let constraint = Constraint::capitalized("aAbB");
        let results = solve(&wt, 20.0, 0.5, 1, 5, &constraint);
        // Only valid: Aa, Ab, Ba, Bb (uppercase first, lowercase rest)
        assert_eq!(results.len(), 4);
        for r in &results {
            assert!(r.text.chars().next().unwrap().is_uppercase());
        }
    }
}
```

Run: `cd unredact-wasm && cargo test`
Expected: FAIL

**Step 2: Implement DFS solver**

```rust
use crate::types::SolveResult;
use super::width_table::WidthTable;
use super::constraint::Constraint;

/// Find all strings matching target_width within tolerance.
pub fn solve(
    wt: &WidthTable,
    target: f64,
    tolerance: f64,
    min_length: usize,
    max_length: usize,
    constraint: &Constraint,
) -> Vec<SolveResult> { ... }
```

Algorithm (from Python `_solve_subtree`):
1. Compute `length_bounds` from `wt.left_min/max` and `wt.min/max_advance`
2. Clamp to `[min_length, max_length]`
3. DFS with pruning:
   - **Overshoot**: `new_width > target + tolerance` → skip
   - **Undershoot**: `new_width + max_possible_remaining < target - tolerance` → skip
   - **Accept**: length in bounds AND state is accepting AND `|final_width - target| <= tolerance`
4. Sort results by `(error, text)`

Run: `cd unredact-wasm && cargo test`
Expected: PASS

**Step 3: Commit**

```bash
git add unredact-wasm/src/solver/dfs.rs
git commit -m "feat(wasm): DFS branch-and-bound solver with pruning"
```

---

### Task 13: Solver — Dictionary Matching

**Files:**
- Create: `unredact-wasm/src/solver/dictionary.rs`
- Modify: `unredact-wasm/src/solver/mod.rs`

**Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_match_entries() {
        // Simulate: each char is 10px wide, target = 30px (3-char words)
        let widths = vec![
            ("cat".to_string(), 30.0),
            ("dog".to_string(), 30.0),
            ("elephant".to_string(), 80.0),
        ];
        let results = match_entries(&widths, 30.0, 1.0);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].text, "cat");
        assert_eq!(results[1].text, "dog");
    }

    #[test]
    fn test_match_with_known_start() {
        let widths = vec![
            ("cat".to_string(), 30.0),
            ("car".to_string(), 30.0),
            ("dog".to_string(), 30.0),
        ];
        let results = match_entries_filtered(&widths, 30.0, 1.0, "ca", "");
        assert_eq!(results.len(), 2); // cat, car
    }
}
```

Run: `cd unredact-wasm && cargo test`
Expected: FAIL

**Step 2: Implement dictionary matching**

```rust
use crate::types::SolveResult;

/// Match pre-measured entries against target width.
/// widths: Vec<(text, measured_width)> — JS measures these via Canvas measureText.
pub fn match_entries(widths: &[(String, f64)], target: f64, tolerance: f64) -> Vec<SolveResult> { ... }

/// Same but with known_start/known_end prefix/suffix filtering.
pub fn match_entries_filtered(
    widths: &[(String, f64)], target: f64, tolerance: f64,
    known_start: &str, known_end: &str,
) -> Vec<SolveResult> { ... }
```

Key insight: In the WASM version, JS measures the font widths via Canvas `measureText()` and passes `(text, width)` pairs to Rust. Rust just does the filtering and sorting. This is simpler than the Python version which measured internally.

Run: `cd unredact-wasm && cargo test`
Expected: PASS

**Step 3: Commit**

```bash
git add unredact-wasm/src/solver/dictionary.rs
git commit -m "feat(wasm): dictionary matching against pre-measured widths"
```

---

### Task 14: Solver — Full Name Solver

**Files:**
- Create: `unredact-wasm/src/solver/full_name.rs`
- Modify: `unredact-wasm/src/solver/mod.rs`

**Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_full_name_match() {
        // Pre-measured: "John Smith" = 95px, "Jane Doe" = 72px
        let names = vec![
            ("John Smith".to_string(), 95.0),
            ("Jane Doe".to_string(), 72.0),
            ("A B".to_string(), 20.0),
        ];
        let results = match_full_names(&names, 72.0, 2.0, "", "");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].text, "Jane Doe");
    }
}
```

Run: `cd unredact-wasm && cargo test`
Expected: FAIL

**Step 2: Implement full name matching**

For the WASM version, full name solving is the same as dictionary matching — JS generates the name variants (from associate lists), measures widths, and passes them to Rust for filtering. The DFS-based full name solver from the existing Rust code is not needed because we dropped enumerate mode.

```rust
/// Match full name variants against target width.
/// Same as match_entries_filtered but semantically distinct.
pub fn match_full_names(
    names: &[(String, f64)], target: f64, tolerance: f64,
    known_start: &str, known_end: &str,
) -> Vec<SolveResult> {
    super::dictionary::match_entries_filtered(names, target, tolerance, known_start, known_end)
}
```

Run: `cd unredact-wasm && cargo test`
Expected: PASS

**Step 3: Commit**

```bash
git add unredact-wasm/src/solver/full_name.rs
git commit -m "feat(wasm): full name matching for two-word name solving"
```

---

### Task 15: Solver — FFI Entry Points

**Files:**
- Modify: `unredact-wasm/src/lib.rs`
- Modify: `unredact-wasm/src/solver/mod.rs`

**Step 1: Define the SolveConfig input struct**

```rust
#[derive(Deserialize)]
pub struct SolveConfig {
    /// Pre-measured entries: [(text, width), ...]
    pub entries: Vec<(String, f64)>,
    pub target_width: f64,
    pub tolerance: f64,
    pub known_start: String,
    pub known_end: String,
    pub mode: String, // "name", "full_name", "email", "word"
}

#[derive(Deserialize)]
pub struct DfsSolveConfig {
    pub charset: String,
    // Width table data — JS measures all pairs via measureText
    pub single_widths: Vec<f64>,
    pub pair_widths: Vec<(usize, usize, f64)>,
    pub left_edge: Vec<f64>,
    pub right_edge: Vec<f64>,
    pub target_width: f64,
    pub tolerance: f64,
    pub min_length: usize,
    pub max_length: usize,
    pub constraint_pattern: String, // "none", "capitalized", etc.
}
```

**Step 2: Add wasm_bindgen exports**

```rust
#[wasm_bindgen]
pub fn solve(config: JsValue) -> JsValue {
    let cfg: SolveConfig = serde_wasm_bindgen::from_value(config).unwrap();
    let results = match cfg.mode.as_str() {
        "name" | "email" | "word" => solver::dictionary::match_entries_filtered(
            &cfg.entries, cfg.target_width, cfg.tolerance,
            &cfg.known_start, &cfg.known_end,
        ),
        "full_name" => solver::full_name::match_full_names(
            &cfg.entries, cfg.target_width, cfg.tolerance,
            &cfg.known_start, &cfg.known_end,
        ),
        _ => vec![],
    };
    serde_wasm_bindgen::to_value(&results).unwrap()
}

#[wasm_bindgen]
pub fn solve_dfs(config: JsValue) -> JsValue {
    let cfg: DfsSolveConfig = serde_wasm_bindgen::from_value(config).unwrap();
    let wt = WidthTable::new(
        cfg.charset.len(), &cfg.single_widths,
        &cfg.pair_widths, &cfg.left_edge, &cfg.right_edge,
    );
    let constraint = Constraint::from_pattern(&cfg.constraint_pattern, &cfg.charset);
    let results = solver::dfs::solve(
        &wt, cfg.target_width, cfg.tolerance,
        cfg.min_length, cfg.max_length, &constraint,
    );
    serde_wasm_bindgen::to_value(&results).unwrap()
}
```

**Step 3: Build and verify**

Run: `cd unredact-wasm && wasm-pack build --target web --dev`
Expected: Builds successfully

**Step 4: Commit**

```bash
git add unredact-wasm/
git commit -m "feat(wasm): expose solver FFI with dictionary and DFS modes"
```

---

### Task 16: WASM Release Build & Smoke Test

**Files:**
- Modify: `unredact-wasm/Cargo.toml` (verify release profile)

**Step 1: Run all Rust tests**

Run: `cd unredact-wasm && cargo test`
Expected: All tests PASS

**Step 2: Build release WASM**

Run: `cd unredact-wasm && wasm-pack build --target web --release`
Expected: Produces optimized `pkg/unredact_core_bg.wasm` (should be < 500KB)

**Step 3: Check WASM binary size**

Run: `ls -lh unredact-wasm/pkg/unredact_core_bg.wasm`
Expected: Reasonable size (< 1MB)

**Step 4: Commit**

```bash
git add unredact-wasm/
git commit -m "feat(wasm): phase 1 complete — all core algorithms ported and tested"
```

---

## Phase 2: JavaScript Orchestration

### Task 17: IndexedDB Storage Layer

**Files:**
- Create: `unredact/static/db.js`

**Step 1: Implement the IndexedDB wrapper**

```javascript
// db.js — IndexedDB persistence layer
const DB_NAME = 'unredact-db';
const DB_VERSION = 1;

const STORES = {
  documents: { keyPath: 'docId', autoIncrement: true },
  pages: { keyPath: ['docId', 'pageNum'] },
  solutions: { keyPath: ['docId', 'pageNum', 'redactionId'] },
  fonts: { keyPath: 'fontId' },
  settings: { keyPath: 'key' },
};

export async function openDb() { ... }
export async function saveDocument(doc) { ... }
export async function getDocument(docId) { ... }
export async function listDocuments() { ... }
export async function savePage(docId, pageNum, data) { ... }
export async function getPage(docId, pageNum) { ... }
export async function updatePageField(docId, pageNum, field, value) { ... }
export async function saveSolution(docId, pageNum, redactionId, solution) { ... }
export async function getSetting(key) { ... }
export async function setSetting(key, value) { ... }
export async function saveUserFont(fontId, name, blob) { ... }
export async function getUserFonts() { ... }
export async function deleteDocument(docId) { ... }
```

**Step 2: Test manually in browser**

Open browser console, import module, verify CRUD operations work.

**Step 3: Commit**

```bash
git add unredact/static/db.js
git commit -m "feat: IndexedDB persistence layer"
```

---

### Task 18: PDF.js Integration

**Files:**
- Create: `unredact/static/pdf.js` (PDF loading module)
- Modify: `unredact/static/main.js` (replace upload endpoint)

**Step 1: Create PDF loading module**

```javascript
// pdf.js — PDF.js wrapper for client-side PDF rendering

// Load PDF.js from CDN or vendored copy
const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.x.x/pdf.min.mjs';

export async function loadPdf(arrayBuffer) {
    // Returns { pageCount, getPageImage(pageNum, dpi) }
    // getPageImage renders to OffscreenCanvas and returns ImageData
}

export async function renderPage(pdfDoc, pageNum, dpi = 300) {
    // Render page to canvas at given DPI
    // Return { imageData, width, height, blob }
}
```

**Step 2: Replace uploadFile() in main.js**

Replace `fetch('/api/upload', ...)` with:
1. Read file as ArrayBuffer
2. Call `loadPdf(buffer)`
3. Render each page to get ImageData
4. Store in IndexedDB via `db.savePage()`
5. Update state

**Step 3: Test manually — upload a PDF and verify pages render**

**Step 4: Commit**

```bash
git add unredact/static/pdf.js unredact/static/main.js
git commit -m "feat: client-side PDF rendering with PDF.js"
```

---

### Task 19: Tesseract.js OCR Integration

**Files:**
- Create: `unredact/static/ocr.js` (OCR module)
- Modify: `unredact/static/main.js` (replace OCR SSE endpoint)

**Step 1: Create OCR module**

```javascript
// ocr.js — Tesseract.js wrapper

export async function initOcr() {
    // Load Tesseract.js worker
}

export async function ocrPage(imageData, onProgress) {
    // Run OCR on single page
    // Parse character-level bounding boxes from Tesseract output
    // Return OcrLine[] matching existing data format:
    // { text, x, y, w, h, chars: [{ text, x, y, w, h, confidence }] }
}
```

Key: Tesseract.js returns word-level boxes. We need to estimate per-character positions the same way the Python `ocr.py` does — divide word bbox evenly among characters, using confidence-weighted spacing.

**Step 2: Replace startOcrSSE() in main.js**

Replace `new EventSource('/api/doc/.../ocr')` with:
1. For each page: call `ocrPage(pageImageData, onProgress)`
2. Store OCR results in IndexedDB via `db.updatePageField(docId, pageNum, 'ocrLines', lines)`
3. Report progress via callback (replaces SSE events)

**Step 3: Test manually — upload PDF, verify OCR produces character bounding boxes**

**Step 4: Commit**

```bash
git add unredact/static/ocr.js unredact/static/main.js
git commit -m "feat: client-side OCR with Tesseract.js"
```

---

### Task 20: WASM Integration — Redaction Detection

**Files:**
- Create: `unredact/static/wasm.js` (WASM loader module)
- Modify: `unredact/static/main.js` (replace analysis SSE endpoint)

**Step 1: Create WASM loader**

```javascript
// wasm.js — WASM module loader and wrapper
import init, { detect_redactions, spot_redaction, score_font, align_text, solve, solve_dfs }
    from '../pkg/unredact_core.js';

let initialized = false;

export async function initWasm() {
    if (!initialized) {
        await init();
        initialized = true;
    }
}

export function detectRedactions(imageData) {
    const { data, width, height } = imageData;
    return detect_redactions(data, width, height);
}

export function spotRedaction(imageData, x, y) {
    const { data, width, height } = imageData;
    return spot_redaction(data, width, height, x, y);
}
```

**Step 2: Replace startAnalysisSSE() in main.js**

Replace `new EventSource('/api/doc/.../analyze')` with:
1. Get page ImageData from IndexedDB
2. Call `wasm.detectRedactions(imageData)` → redaction boxes
3. For each redaction, run font detection (see Task 21)
4. Store results in IndexedDB and update state

**Step 3: Replace spot redaction endpoint**

Replace `fetch('/api/doc/.../spot', {x, y})` with:
1. Get page ImageData
2. Call `wasm.spotRedaction(imageData, x, y)`
3. If found, run font detection and boundary extraction
4. Update state

**Step 4: Test manually — upload PDF, verify redactions are detected**

**Step 5: Commit**

```bash
git add unredact/static/wasm.js unredact/static/main.js
git commit -m "feat: client-side redaction detection via WASM"
```

---

### Task 21: Font Detection Integration

**Files:**
- Create: `unredact/static/font_detect.js`
- Modify: `unredact/static/wasm.js` (add font scoring wrapper)

**Step 1: Create font detection module**

```javascript
// font_detect.js — Font detection using Canvas rendering + WASM scoring

import { scoreFont } from './wasm.js';

const CANDIDATE_FONTS = [
    'Times New Roman', 'Arial', 'Courier New', 'Georgia', 'Verdana',
    'Calibri', 'Trebuchet MS', 'Liberation Serif', 'Liberation Sans',
    'DejaVu Serif', 'DejaVu Sans',
];

export async function detectFont(lineRegionImageData, lineText, lineHeight) {
    // 1. Compute size range: [max(12, h*0.6), min(120, h*1.4)]
    // 2. For each candidate font × size:
    //    a. Render text to OffscreenCanvas with that font/size
    //    b. Get grayscale pixels from both canvases
    //    c. Call wasm.scoreFont(pagePixels, renderedPixels, w, h) → Dice score
    //    d. Track best score
    // 3. Fine search: ±3 sizes around best
    // 4. Return { fontName, fontSize, score }
}

export async function detectFontMasked(lineRegionImageData, charRuns, redactionBoxes, lineHeight) {
    // Same but renders only clean char runs, masks redaction areas with white
}
```

Key: JS handles Canvas rendering of candidate fonts. WASM handles pixel comparison (Dice scoring). This splits the work naturally — JS has native font rendering, Rust has fast pixel math.

**Step 2: Wire into analysis pipeline**

After detecting redactions, for each affected line:
1. Crop line region from page Canvas
2. Call `detectFontMasked()` or `detectFont()`
3. Store font match in redaction analysis

**Step 3: Test manually — verify font detection identifies correct font/size**

**Step 4: Commit**

```bash
git add unredact/static/font_detect.js unredact/static/wasm.js
git commit -m "feat: client-side font detection via Canvas + WASM scoring"
```

---

### Task 22: Solver Integration

**Files:**
- Modify: `unredact/static/solver.js` (replace solve endpoint)
- Modify: `unredact/static/wasm.js` (add solve wrapper)

**Step 1: Create width measurement helper**

```javascript
// In solver.js or a new module

function measureWidths(entries, fontName, fontSize, leftContext, rightContext) {
    // Use OffscreenCanvas + measureText to get kerning-aware widths
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    ctx.font = `${fontSize}px "${fontName}"`;

    return entries.map(text => {
        const full = leftContext + text + rightContext;
        const left = leftContext;
        const right = rightContext;
        const width = ctx.measureText(full).width
            - ctx.measureText(left).width
            - ctx.measureText(right).width;
        return [text, width];
    });
}
```

**Step 2: Replace startSolve() in solver.js**

Replace `fetch('/api/solve', ...)` with:
1. Load word lists from static files (fetch `data/nouns.txt`, etc. based on mode)
2. Measure all entries with Canvas `measureText()`
3. Pass measured entries to `wasm.solve(config)`
4. Render results immediately (no streaming needed — dictionary modes are fast)
5. Store results for pagination

For `word` mode two-word search: JS generates adjective+noun combinations, measures them, passes to Rust.

**Step 3: Replace validate endpoint**

Replace `fetch('/api/solve/.../validate', ...)` with direct Anthropic API call (see Task 23).

**Step 4: Test manually — upload PDF, select redaction, solve with different modes**

**Step 5: Commit**

```bash
git add unredact/static/solver.js unredact/static/wasm.js
git commit -m "feat: client-side solving via Canvas measureText + WASM"
```

---

### Task 23: LLM Integration — Direct Anthropic API

**Files:**
- Create: `unredact/static/llm.js`
- Modify: `unredact/static/main.js` (LLM redaction detection)
- Modify: `unredact/static/solver.js` (LLM validation)

**Step 1: Create LLM module**

```javascript
// llm.js — Direct Anthropic API calls from browser

export async function callClaude(apiKey, model, messages, tools, maxTokens = 1024) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model, messages, tools, max_tokens: maxTokens }),
    });
    return resp.json();
}
```

**Step 2: Port LLM redaction detection**

From Python `llm_detect.py`:
- `detectRedactionsLlm(ocrLines, apiKey)` — calls Claude Haiku with `report_redactions` tool
- `identifyBoundaryText(line, boxX, boxW, apiKey)` — calls Claude with `report_boundary_text` tool

**Step 3: Port LLM validation**

From Python `llm_validate.py`:
- `validateCandidates(leftContext, rightContext, candidates, apiKey, onProgress)` — batches of 50, calls Claude Sonnet with `score_candidates` tool

**Step 4: Test manually — verify LLM calls work with user-provided API key**

**Step 5: Commit**

```bash
git add unredact/static/llm.js unredact/static/main.js unredact/static/solver.js
git commit -m "feat: direct browser-to-Anthropic API calls for LLM features"
```

---

### Task 24: Settings & API Key Management

**Files:**
- Modify: `unredact/static/index.html` (add settings modal)
- Create: `unredact/static/settings.js`
- Modify: `unredact/static/main.js` (load settings on init)

**Step 1: Create settings module**

```javascript
// settings.js — API key and preferences management
import { getSetting, setSetting } from './db.js';

export async function getApiKey() {
    return getSetting('anthropic_api_key');
}

export async function setApiKey(key) {
    return setSetting('anthropic_api_key', key);
}

export async function promptForApiKey() {
    // Show modal, validate key format, save to IndexedDB
}
```

**Step 2: Add settings UI to index.html**

Settings gear icon in toolbar. Modal with:
- Anthropic API key input (masked)
- Save/clear buttons

**Step 3: Wire into main.js init**

On page load:
1. Init WASM
2. Load settings from IndexedDB
3. If no API key, show prompt
4. Load fonts, data files

**Step 4: Commit**

```bash
git add unredact/static/settings.js unredact/static/index.html unredact/static/main.js
git commit -m "feat: settings UI with API key management"
```

---

### Task 25: Font Management — Bundled + User Uploaded

**Files:**
- Modify: `unredact/static/main.js` (replace /api/fonts endpoint)
- Create: `fonts/manifest.json`

**Step 1: Create font manifest**

```json
{
  "fonts": [
    { "id": "times", "name": "Times New Roman", "file": "times.woff2" },
    { "id": "arial", "name": "Arial", "file": "arial.woff2" },
    { "id": "courier", "name": "Courier New", "file": "courier.woff2" },
    { "id": "georgia", "name": "Georgia", "file": "georgia.woff2" },
    { "id": "verdana", "name": "Verdana", "file": "verdana.woff2" },
    { "id": "calibri", "name": "Calibri", "file": "calibri.woff2" }
  ]
}
```

**Step 2: Replace loadFonts() in main.js**

Replace `fetch('/api/fonts')` with:
1. Fetch `fonts/manifest.json`
2. Load each WOFF2 via FontFace API
3. Also load user-uploaded fonts from IndexedDB
4. Merge into `state.fonts`

**Step 3: Add font upload UI**

Button in settings or toolbar to upload additional font files. Stored in IndexedDB `fonts` store.

**Step 4: Commit**

```bash
git add fonts/ unredact/static/main.js
git commit -m "feat: bundled font manifest with user font upload support"
```

---

### Task 26: Data File Loading

**Files:**
- Modify: `unredact/static/solver.js` (load word lists via fetch)
- Modify: `unredact/static/main.js` (load associates via fetch)

**Step 1: Replace data loading**

Replace `fetch('/api/associates')` with `fetch('data/associates.json')`.

In solver.js, load word lists on demand:
```javascript
const dataCache = {};

async function loadDataFile(name) {
    if (!dataCache[name]) {
        const resp = await fetch(`data/${name}`);
        const text = await resp.text();
        dataCache[name] = text.split('\n').filter(line => line.trim());
    }
    return dataCache[name];
}
```

Load based on solve mode:
- `name` → `associate_first_names.txt`, `associate_last_names.txt`
- `full_name` → `associates.json` (extract multi-word names)
- `email` → `emails.txt`
- `word` → `nouns.txt`, `adjectives.txt`, `nouns_plural.txt`

**Step 2: Test manually — verify data loads and solving works**

**Step 3: Commit**

```bash
git add unredact/static/solver.js unredact/static/main.js
git commit -m "feat: load data files from static assets"
```

---

### Task 27: Remove Backend Dependencies

**Files:**
- Modify: `unredact/static/main.js` (remove all remaining fetch calls to /api/)
- Modify: `unredact/static/solver.js` (remove all remaining fetch calls)

**Step 1: Audit for remaining backend calls**

Search all JS files for `/api/` references and ensure every one has been replaced.

Run: `grep -rn '/api/' unredact/static/`
Expected: Zero matches

**Step 2: Remove the Python app.py import of static files**

The static files no longer need to be served by FastAPI. They'll be served directly as static assets.

**Step 3: Verify the app works fully client-side**

Open `index.html` via a simple static server (e.g., `python -m http.server`). Full workflow:
1. Set API key
2. Upload PDF
3. OCR runs
4. Redactions detected
5. Font identified
6. Solve produces results
7. LLM validation scores results
8. Close tab, reopen, resume session from IndexedDB

**Step 4: Commit**

```bash
git add unredact/static/
git commit -m "feat: remove all backend API dependencies — fully client-side"
```

---

## Phase 3: Build & Deploy

### Task 28: Build Pipeline

**Files:**
- Create: `Makefile.wasm` (or add targets to existing Makefile)
- Create: `scripts/build-static.sh`

**Step 1: Create build script**

```bash
#!/bin/bash
set -e

# Build WASM
cd unredact-wasm
wasm-pack build --target web --release
cd ..

# Create dist directory
rm -rf dist
mkdir -p dist/pkg dist/data dist/fonts

# Copy WASM output
cp unredact-wasm/pkg/unredact_core.js dist/pkg/
cp unredact-wasm/pkg/unredact_core_bg.wasm dist/pkg/

# Copy frontend
cp unredact/static/*.html dist/
cp unredact/static/*.js dist/
cp unredact/static/*.css dist/

# Copy data files
cp unredact/data/*.txt dist/data/
cp unredact/data/*.json dist/data/

# Copy fonts
cp fonts/*.woff2 dist/fonts/
cp fonts/manifest.json dist/fonts/
```

**Step 2: Add Makefile targets**

```makefile
build-static:
	bash scripts/build-static.sh

serve-static:
	cd dist && python -m http.server 8000

clean-static:
	rm -rf dist unredact-wasm/pkg
```

**Step 3: Test the full build**

Run: `make build-static && make serve-static`
Expected: Opens at http://localhost:8000, fully functional

**Step 4: Commit**

```bash
git add Makefile scripts/build-static.sh
git commit -m "feat: static site build pipeline"
```

---

### Task 29: Document List & Session Resume

**Files:**
- Modify: `unredact/static/index.html` (add document list view)
- Modify: `unredact/static/main.js` (init flow with document list)

**Step 1: Add document list UI**

Show on page load instead of upload prompt if documents exist in IndexedDB:
- List of previously uploaded documents with name and date
- Click to resume, or upload new
- Delete button per document

**Step 2: Implement resume flow**

When clicking a saved document:
1. Load document metadata from IndexedDB
2. Load page images, OCR data, redactions, solutions
3. Restore state and render

**Step 3: Test — upload, close tab, reopen, resume**

**Step 4: Commit**

```bash
git add unredact/static/index.html unredact/static/main.js
git commit -m "feat: document list with session resume from IndexedDB"
```

---

### Task 30: Final Integration Test & Deploy

**Step 1: Full end-to-end test**

Run: `make build-static && make serve-static`

Test the complete workflow:
1. Open page, enter API key
2. Upload a redacted PDF
3. Wait for OCR to complete
4. Verify redactions are detected
5. Select a redaction, verify font is identified
6. Run solver in different modes (name, word, email)
7. Run LLM validation
8. Accept a solution, verify overlay renders
9. Close tab, reopen, verify session resumes
10. Upload a custom font, verify it appears in font list

**Step 2: Check binary sizes**

Run: `du -sh dist/` and `ls -lh dist/pkg/unredact_core_bg.wasm`
Note sizes for documentation.

**Step 3: Deploy to static host**

Choose hosting (GitHub Pages, Cloudflare Pages, etc.) and deploy `dist/`.

**Step 4: Commit and tag**

```bash
git add -A
git commit -m "feat: unredact static webapp — complete WASM migration"
git tag v1.0.0-static
```
