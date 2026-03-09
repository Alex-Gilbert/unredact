# Unredact

**Reveal what's hidden in redacted PDFs.**

Unredact uses computer vision, font-aware constraint solving, and LLM reasoning to figure out what text is hiding under those black bars. Upload a PDF, and it will detect redactions, calculate exactly which strings could fit based on pixel-width constraints, and let you visually verify guesses with a live overlay.

Everything runs in the browser — no server required.

<!-- TODO: Replace with actual screenshots -->
![Unredact analyzing a redacted PDF](docs/images/hero.png)

![Green overlay text aligning with surrounding visible text](docs/images/overlay-verification.png)

## What it does

- **Detects redactions** automatically using computer vision, or manually by clicking
- **Solves for hidden text** by finding every string that fits the exact pixel width of a redaction, accounting for font metrics and kerning
- **Ranks results with AI** using Claude to score candidates by contextual fit with surrounding text
- **Lets you verify visually** by overlaying guessed text in green on the original document — if the characters align, the guess fits

## How it works

Unredact combines three techniques:

1. **Computer vision** — OCR (Tesseract.js) extracts visible text with character-level bounding boxes. A WASM module detects black rectangles and identifies the document's typeface and size via pixel-level font matching.

2. **Constraint solving** — Using the detected font's exact character widths (including kerning pairs), a WASM-compiled branch-and-bound solver enumerates every string that fits the redaction's pixel width within a configurable tolerance.

3. **LLM validation** — Claude reads the surrounding text context and scores each candidate for plausibility, then results are ranked by a composite of width fit and contextual score.

```
PDF ──→ Rasterize ──→ OCR (Tesseract.js) ──→ Font Detection (WASM)
                                                      │
                                                      ▼
                          Redaction Detection (WASM) + Width Tables
                                                      │
                                                      ▼
                                        Constraint Solver (WASM)
                                                      │
                                                      ▼
                              Candidates ──→ LLM Validation (Claude API)
                                                      │
                                                      ▼
                                               Visual Overlay
```

## Quick start

### Live version

The app is live at **[unredact.live](https://unredact.live)** — no installation needed. You just need a Claude API key for the LLM validation feature.

### Run locally

```bash
git clone https://github.com/Alex-Gilbert/unredact.git
cd unredact

# Build the static site (requires Rust toolchain for WASM compilation)
make build-static

# Serve locally
make serve-static
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

### Prerequisites (for building)

- Rust toolchain with `wasm-pack` ([rustup.rs](https://rustup.rs), then `cargo install wasm-pack`)

### Development

For development with hot-reloading style path mapping:

```bash
make dev-static
```

This runs a dev server that maps flat URL paths to the source directories, so you can edit files in `unredact/static/` and see changes immediately.

### Deploy

```bash
make deploy    # Builds and deploys to Cloudflare Pages
```

## Usage guide

### 1. Upload a PDF

Drag and drop a redacted PDF onto the page, or use the file picker. The tool will automatically run OCR on every page and detect redactions and fonts.

### 2. Select a redaction

Click on a detected redaction (highlighted on the page). A panel opens with analysis details and solve options.

### 3. Choose a solve mode

| Mode | What it searches | Use case |
|------|-----------------|----------|
| **Name** | First names or last names from name dictionaries | Redacted names |
| **Full Name** | Two-word combinations (first + last) | Full name redactions |
| **Email** | Common email addresses | Redacted email addresses |
| **Word** | English nouns and adjectives from dictionary | General text redactions |
| **Enumerate** | All possible character combinations | Short redactions, anything goes |

### 4. Configure and solve

- Set the **character set** (lowercase, uppercase, capitalized)
- Adjust **tolerance** if results are too narrow or too broad
- Add **known characters** if you can tell what the first or last letter is
- For word mode, toggle **plural only** or adjust **vocabulary size**
- Click **Solve** — results stream in as they're found

### 5. Validate with AI

Click **Validate** to have Claude score each candidate based on the surrounding text context. Results are re-ranked by a composite score combining width fit and contextual plausibility. Requires a Claude API key (entered in settings).

### 6. Verify visually

Select a result to see it overlaid in green on the original document. If the green text aligns character-for-character with the surrounding visible text, the guess is a strong match. You can fine-tune font, size, position, and character spacing manually.

## Architecture

Unredact runs entirely in the browser as a static site:

- **WASM module** (compiled from Rust) — Constraint solver, redaction detection, font scoring, and text alignment
- **Tesseract.js** — OCR processing
- **Claude API** — LLM validation (called directly from the browser with your API key)
- **Vanilla JavaScript** — No build step, ES6 modules, canvas rendering

All data (dictionaries, font metrics, name lists) is bundled as static assets. User settings and API keys are stored locally in IndexedDB.

```
Browser
  ├── OCR (Tesseract.js)
  ├── Redaction detection (WASM)
  ├── Font detection (WASM pixel matching)
  ├── Constraint solver (WASM)
  ├── LLM validation ──→ Claude API
  └── IndexedDB (settings, API key)
```

## Project structure

```
unredact/
├── unredact/
│   ├── static/            # Frontend (HTML, CSS, JS)
│   │   ├── index.html
│   │   ├── main.js        # Entry point
│   │   ├── solver.js      # Constraint solver interface
│   │   ├── canvas.js      # Document rendering
│   │   ├── font_detect.js # Font detection
│   │   ├── ocr.js         # Tesseract.js integration
│   │   ├── wasm.js        # WASM module loader
│   │   ├── llm.js         # LLM validation
│   │   └── ...            # Other modules
│   └── data/              # Bundled dictionaries and word lists
├── unredact-wasm/         # Rust → WASM module source
├── scripts/
│   ├── build-static.sh    # Static site build script
│   └── dev-server.py      # Development server
├── dist/                  # Built static site output
└── Makefile
```

### Legacy Python server

The `unredact/app.py` FastAPI server and `unredact/pipeline/` modules are the original server-side implementation. All processing has since been moved to run client-side via WASM and JavaScript. The Python code is retained for reference but is no longer needed to run the application.

The legacy server also depends on a separate Rust HTTP solver service (`solver_rs/`), which has been superseded by the WASM solver running directly in the browser.

### Useful commands

```bash
make build-static     # Build the static site to dist/
make serve-static     # Serve dist/ on port 8000
make dev-static       # Dev server with source path mapping
make deploy           # Build and deploy to Cloudflare Pages
make clean            # Clean build artifacts
```

## Disclaimer

Unredact is a research and entertainment tool. It is provided as-is for educational and exploratory purposes only. The results produced by this tool are probabilistic guesses — **nothing it outputs should be treated as verified fact.** All data used (dictionaries, font metrics, name lists) comes from publicly available, open-source sources, and AI-generated scores reflect statistical plausibility, not truth.

This tool is not intended for use in legal proceedings, journalism, law enforcement, or any context where unverified information could cause harm. **Do not use this tool to circumvent lawful redactions, violate privacy, or break any applicable laws.** You are solely responsible for how you use it.

The author makes no claims of accuracy, completeness, or fitness for any particular purpose, and accepts no liability for misuse or for any consequences arising from the use of this tool.

## Support

A few people asked me to set up a way to support this project, so here it is. Please don't feel any obligation — this project is free and will stay that way. But if Unredact has been useful or interesting to you and you'd like to buy me a coffee, I genuinely appreciate it.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/apgcodes)

## License

[MIT](LICENSE)
