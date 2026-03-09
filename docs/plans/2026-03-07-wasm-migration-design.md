# Unredact WASM Migration Design

## Goal

Migrate the entire unredact tool to run as a static webpage with zero server infrastructure. Users upload PDFs, provide their own Anthropic API key, and everything runs client-side in the browser. The Python backend and existing Rust solver are replaced by a new Rust WASM module plus JavaScript orchestration using PDF.js and Tesseract.js.

## Architecture

```
+-----------------------------------------------------------+
|                        Browser                             |
|                                                            |
|  +----------+  +-----------+  +------------------------+  |
|  |  PDF.js  |  |Tesseract.js|  |  Anthropic API        |  |
|  | (render) |  |   (OCR)    |  | (direct from browser) |  |
|  +----+-----+  +-----+-----+  +----------+-------------+  |
|       |               |                    |               |
|  +----v---------------v--------------------v------------+  |
|  |              JavaScript (vanilla)                     |  |
|  |  - UI / Canvas rendering                             |  |
|  |  - Orchestration (pipeline sequencing)               |  |
|  |  - IndexedDB persistence                             |  |
|  |  - Fetch static data files                           |  |
|  +------------------------+-----------------------------+  |
|                           | wasm-bindgen FFI               |
|  +------------------------v-----------------------------+  |
|  |           unredact-core.wasm (Rust)                   |  |
|  |                                                       |  |
|  |  - Redaction detection (image processing)            |  |
|  |  - Font pixel matching (Dice coefficient scoring)    |  |
|  |  - Width table computation (kerning-aware)           |  |
|  |  - DFS solver (name, full_name, email, word modes)   |  |
|  |  - Dictionary matching                                |  |
|  +-------------------------------------------------------+  |
|                                                            |
|  +-------------------------------------------------------+  |
|  |              IndexedDB                                 |  |
|  |  - Uploaded PDFs, page images, OCR results            |  |
|  |  - Analysis results, solutions, annotations           |  |
|  |  - User-uploaded fonts, settings, API key             |  |
|  +-------------------------------------------------------+  |
|                                                            |
|  +-------------------------------------------------------+  |
|  |           Static Files (served alongside page)         |  |
|  |  - Word lists (words.txt, nouns.txt, adjectives.txt)  |  |
|  |  - Name lists (first_names.txt, last_names.txt)       |  |
|  |  - emails.txt, associates.json                        |  |
|  |  - Bundled fonts (WOFF2)                              |  |
|  +-------------------------------------------------------+  |
+-----------------------------------------------------------+
```

### Key Principles

- **JavaScript is the orchestrator.** It calls PDF.js, Tesseract.js, the Anthropic API, and the WASM module. It owns the pipeline sequencing and UI.
- **Rust WASM is a pure compute library.** It takes pixel data and parameters in, returns results out. No network calls, no DOM access, no async runtime.
- **User-supplied API key.** Stored in IndexedDB, never leaves the browser except in direct calls to the Anthropic API.
- **No enumerate mode.** Removed from the web build. Dictionary-based modes (name, full_name, email, word) are sufficient and fast enough to run single-threaded.

## Rust WASM Crate: `unredact-core`

### Project Structure

```
unredact-wasm/
├── Cargo.toml
├── src/
│   ├── lib.rs              # wasm-bindgen entry points
│   ├── image/
│   │   ├── mod.rs
│   │   ├── grayscale.rs    # RGB -> grayscale
│   │   ├── threshold.rs    # binary thresholding
│   │   ├── morphology.rs   # dilate, erode, close
│   │   ├── contours.rs     # boundary tracing, bounding boxes
│   │   └── flood_fill.rs   # connected components (click-to-select)
│   ├── font/
│   │   ├── mod.rs
│   │   ├── pixel_match.rs  # Dice coefficient font scoring
│   │   └── align.rs        # pixel offset alignment
│   ├── solver/
│   │   ├── mod.rs
│   │   ├── dfs.rs          # branch-and-bound DFS
│   │   ├── constraint.rs   # FSM for casing patterns
│   │   ├── dictionary.rs   # word/name/email matching
│   │   ├── full_name.rs    # two-word name solver
│   │   └── width_table.rs  # kerning-aware width math
│   └── types.rs            # shared structs (SolveResult, Redaction, etc.)
```

### Dependencies

- `wasm-bindgen` — JS <-> Rust FFI
- `serde` + `serde_json` — serialize/deserialize across the boundary
- `js-sys` + `web-sys` — access to JS typed arrays for passing pixel data

No `tokio`, no `rayon`, no `axum`, no image processing crates. All image processing algorithms are hand-written.

### FFI Boundary

```rust
// Image processing
fn detect_redactions(pixels: &[u8], width: u32, height: u32) -> JsValue;
fn spot_redaction(pixels: &[u8], width: u32, height: u32, x: u32, y: u32) -> JsValue;

// Font matching
fn score_font(page_pixels: &[u8], rendered_pixels: &[u8], width: u32, height: u32) -> f64;
fn score_font_masked(page_pixels: &[u8], rendered_pixels: &[u8], mask_boxes: &JsValue, ...) -> f64;

// Solver
fn solve(config: &JsValue) -> JsValue;
fn solve_full_name(config: &JsValue) -> JsValue;

// Width table
fn build_width_table(char_widths: &JsValue) -> JsValue;
```

JS measures font widths using Canvas `measureText()` and passes them into Rust. Rust builds the kerning matrix and runs the solver. This avoids needing font rendering inside WASM.

### Image Processing Algorithms (replacing OpenCV)

The current Python backend uses OpenCV for redaction detection. The specific operations are well-defined and implemented from scratch in Rust:

1. **Grayscale conversion** — weighted sum of RGB channels
2. **Binary thresholding** — per-pixel comparison
3. **Morphological close** (dilate + erode) — rectangular kernel, min/max per neighborhood
4. **Contour tracing** — Suzuki-Abe or Moore boundary tracing for rectangle detection
5. **Connected components** — flood fill for click-to-select
6. **Bounding box extraction** — min/max of contour coordinates

These operate on raw pixel arrays (`&[u8]` RGBA data from Canvas `getImageData()`).

## JavaScript Orchestration

The existing vanilla JS frontend stays intact. Backend API calls are replaced with local calls:

### Endpoint Migration Map

| Current (Python backend) | New (client-side) |
|---|---|
| `POST /api/upload` | PDF.js loads file, renders pages to Canvas, stores in IndexedDB |
| `EventSource /api/doc/{id}/ocr` | Tesseract.js runs on each page image, progress via callbacks |
| `EventSource /api/doc/{id}/analyze` | Canvas pixels -> WASM `detect_redactions()`, font candidates rendered to offscreen Canvas -> WASM `score_font()` |
| `POST /api/solve` | JS builds width tables via `measureText()` -> WASM `solve()` returns results synchronously |
| `POST /api/solve/{id}/validate` | JS calls Anthropic API directly with user-provided key, same batching logic (50 per call) |
| `GET /api/fonts` | Bundled WOFF2 manifest + user fonts from IndexedDB |
| `GET /api/font/{id}` | Static WOFF2 file or IndexedDB blob, loaded via FontFace API |
| `GET /api/associates` | Fetch static `associates.json` |
| `GET /api/doc/{id}/page/{n}/original` | Load from IndexedDB |
| `GET /api/doc/{id}/page/{n}/data` | Load from IndexedDB |
| `POST /api/doc/{id}/page/{n}/spot` | Canvas pixels -> WASM `spot_redaction()` |

No new JS files needed. Changes are internal to existing modules (`main.js`, `solver.js`, etc.). Pipeline orchestration logic from `app.py` and `analyze_page.py` moves into JS.

## Fonts

### Bundled Fonts

A fixed set of common document fonts shipped as WOFF2 static assets:
- Times New Roman, Arial, Courier New, Calibri, Georgia, Verdana, etc.

The font pixel matching algorithm scores candidates against the document image to identify the typeface.

### User-Uploaded Fonts

Users can upload additional font files for documents using unusual typefaces. Stored in IndexedDB, loaded via the FontFace API. Available alongside bundled fonts in the candidate list.

## IndexedDB Persistence

**Database: `unredact-db`**

| Store | Key | Data | Purpose |
|---|---|---|---|
| `documents` | `docId` (auto) | `{name, pageCount, createdAt}` | Document metadata |
| `pages` | `[docId, pageNum]` | `{imageBlob, ocrLines, redactions, fonts}` | All per-page data |
| `solutions` | `[docId, pageNum, redactionId]` | `{text, fontName, fontSize, scores}` | Accepted solutions |
| `fonts` | `fontId` | `{name, blob, source: "bundled"|"user"}` | User-uploaded fonts |
| `settings` | key string | value | API key, preferences |

### Session Lifecycle

1. Upload PDF -> create `documents` entry -> rasterize pages -> store image blobs in `pages`
2. OCR completes -> update `pages` entries with `ocrLines`
3. Analysis completes -> update `pages` with `redactions` and `fonts`
4. User solves/approves -> write to `solutions`
5. User returns later -> load document list -> restore full state from IndexedDB

## Build & Deployment

### Build Pipeline

```
unredact-wasm/          ->  wasm-pack build --target web  ->  pkg/
  (Rust crate)                                                 unredact_core.js
                                                               unredact_core_bg.wasm

unredact/static/        ->  copied as-is                  ->  dist/
  (existing vanilla JS)                                        index.html, *.js, *.css

data/                   ->  copied as-is                  ->  dist/data/
  (word lists, names)                                          words.txt, nouns.txt, etc.

fonts/                  ->  copied as-is                  ->  dist/fonts/
  (bundled WOFF2)                                              times.woff2, arial.woff2, etc.
```

No bundler. `wasm-pack --target web` produces ES modules importable via `<script type="module">`. External deps (PDF.js, Tesseract.js) loaded via CDN or vendored.

### Makefile Targets

```
make build        # wasm-pack + copy static assets -> dist/
make serve        # local dev server pointing at dist/
make clean        # remove dist/ and wasm pkg/
```

### Deployment

Copy `dist/` to any static host: GitHub Pages, Cloudflare Pages, Netlify, S3, etc.

## Migration Phases

### Phase 1: Rust WASM Core

Build the `unredact-wasm` crate:
- Image processing (grayscale, threshold, morphology, contours, flood fill)
- Font pixel matching (Dice scoring, alignment)
- Width table computation
- DFS solver (name, full_name, email, word modes)
- Dictionary matching

Tested independently with Rust unit tests.

### Phase 2: JS Orchestration Swap

Replace all backend API calls in the existing frontend:
- PDF.js for rasterization
- Tesseract.js for OCR
- Direct WASM calls for detection/solving
- Direct Anthropic API calls for LLM features
- IndexedDB for persistence

The Python backend and `solver_rs` become unused at this point.

### Phase 3: Static Build & Polish

- Build pipeline (wasm-pack + asset copying)
- Bundle fonts as WOFF2
- Serve data files statically
- API key input UI
- Document list / resume session UI
- Deploy to static host

### Phase 4: Frontend Redesign (Separate Work Item)

- htmx migration, UI modernization — scoped separately
