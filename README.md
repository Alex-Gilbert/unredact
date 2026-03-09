# Unredact

**Guess what might be hiding under redacted text in PDFs.**

Unredact is a research tool that uses OCR, font-aware constraint solving, and LLM reasoning to generate plausible guesses for redacted text. Upload a PDF, and it will detect redactions, search for strings that could fit based on approximate pixel-width constraints, and let you visually compare candidates against the original document.

**It does not reveal hidden text.** It produces a ranked list of candidates — some may be correct, many won't be. All results are probabilistic guesses that depend on imperfect font detection, approximate width matching, and heuristic scoring.

Everything runs in the browser — no server required.

Name and Full Name solve modes use generic name dictionaries. You can optionally upload a custom person database in settings to enable person matching and Full Name mode.

<!-- TODO: Replace with actual screenshots -->
![Unredact analyzing a redacted PDF](docs/images/hero.png)

![Green overlay text compared with surrounding visible text](docs/images/overlay-verification.png)

## What it does

- **Detects redactions** automatically using image processing, or manually by drawing a selection
- **Generates candidates** by searching for strings whose approximate pixel width falls within a tolerance of the redacted region, using heuristically detected font metrics
- **Ranks results with AI** using Claude to score candidates by contextual plausibility with surrounding text
- **Lets you compare visually** by overlaying candidate text on the original document — alignment suggests a plausible fit, but does not confirm correctness

## How it works

Unredact combines three techniques, each of which introduces approximation:

1. **OCR and image processing** — Tesseract.js extracts visible text with character-level bounding boxes. A WASM module detects dark rectangles as potential redactions and attempts to identify the document's typeface and size via pixel-level comparison against bundled fonts. Font detection is a best guess — if the actual font isn't in the bundled set, results will be less accurate.

2. **Constraint solving** — Using the detected font's character width tables, a WASM-compiled branch-and-bound solver enumerates strings that fit the redaction's pixel width within a configurable tolerance. Results depend on the accuracy of font detection and the tolerance setting.

3. **LLM scoring** — Claude reads the surrounding text context and scores each candidate for plausibility. These scores reflect statistical likelihood, not truth. Results are ranked by a composite of width fit and contextual score.

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
                              Candidates ──→ LLM Scoring (Claude API)
                                                      │
                                                      ▼
                                              Visual Comparison
```

## Quick start

### Live version

The app is live at **[unredact.live](https://unredact.live)** — no installation needed. You just need a Claude API key for the LLM scoring feature.

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

Drag and drop a redacted PDF onto the page, or use the file picker. The tool will run OCR on every page and attempt to detect redactions and fonts.

### 2. Select a redaction

Click on a detected redaction (highlighted on the page). A panel opens with analysis details and solve options.

### 3. Choose a solve mode

| Mode | What it searches | Use case |
|------|-----------------|----------|
| **Name** | First names or last names from name dictionaries | Redacted names |
| **Full Name** | Two-word combinations from uploaded person database | Full name redactions (requires person DB) |
| **Email** | Email addresses from uploaded email dictionary | Redacted email addresses (requires email list) |
| **Word** | English nouns and adjectives from dictionary | General text redactions |
| **Enumerate** | All possible character combinations | Short redactions, anything goes |

### 4. Configure and solve

- Set the **character set** (lowercase, uppercase, capitalized)
- Adjust **tolerance** if results are too narrow or too broad
- Add **known characters** if you can tell what the first or last letter is
- For word mode, toggle **plural only** or adjust **vocabulary size**
- Click **Solve** — candidates stream in as they're found

### 5. Score with AI

Click **Validate** to have Claude score each candidate based on the surrounding text context. Results are re-ranked by a composite of width fit and contextual plausibility. Requires a Claude API key (entered in settings).

### 6. Compare visually

Select a candidate to see it overlaid on the original document. If the text appears to align with surrounding visible characters, it suggests a plausible fit — but visual alignment alone does not prove the guess is correct. You can fine-tune font, size, position, and character spacing manually.

## Person database schema

You can optionally upload a person database (JSON) in settings to enable Full Name mode and person matching in results. The schema:

```json
{
  "names": {
    "lowercased name variant": [
      { "person_id": "unique-id", "match_type": "full", "tier": 1 }
    ]
  },
  "persons": {
    "unique-id": { "name": "Display Name", "category": "some-category", "tier": 1 }
  }
}
```

- **names** — Maps lowercased name variants to arrays of person references. `match_type` can be `full`, `first`, `last`, `nickname`, `nickname_full`, or `initial_last`. `tier` is 1-3 (used for sorting and badge display).
- **persons** — Maps person IDs to display metadata.

Without a person database, Name mode uses generic first/last name dictionaries and Full Name mode is disabled.

An example build script (`scripts/build_associates.py`) is included in the repo. It demonstrates how to generate a person database from a third-party data source ([rhowardstone/Epstein-research-data](https://github.com/rhowardstone/Epstein-research-data)). You can adapt it for any data source that fits the schema above.

### Email dictionary

Email mode requires an uploaded email list — a plain text file with one email address per line. Upload it in settings. An example build script (`scripts/build_emails.py`) is included.

## Architecture

Unredact runs entirely in the browser as a static site:

- **WASM module** (compiled from Rust) — Constraint solver, redaction detection, font scoring, and text alignment
- **Tesseract.js** — OCR processing
- **Claude API** — LLM scoring (called directly from the browser with your API key)
- **Vanilla JavaScript** — No build step, ES6 modules, canvas rendering

Generic dictionaries and font metrics are bundled as static assets. User settings, API keys, and optional person databases are stored locally in IndexedDB.

```
Browser
  ├── OCR (Tesseract.js)
  ├── Redaction detection (WASM)
  ├── Font detection (WASM pixel matching)
  ├── Constraint solver (WASM)
  ├── LLM scoring ──→ Claude API
  └── IndexedDB (settings, API key, person DB)
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
│   │   ├── llm.js         # LLM scoring
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

Unredact is a research and entertainment tool. It is provided as-is for educational and exploratory purposes only.

**The results produced by this tool are probabilistic guesses — nothing it outputs should be treated as verified fact.** The tool's accuracy depends on heuristic font detection, approximate width calculations, and statistical language models. Any given result may be completely wrong.

All bundled data (dictionaries, font metrics) comes from publicly available, open-source sources. AI-generated scores reflect statistical plausibility, not truth. Person name matches are mechanical (based on pixel-width fit) and do not imply any connection to wrongdoing. User-uploaded person databases are stored locally and never transmitted.

This tool is not intended for use in legal proceedings, journalism, law enforcement, or any context where unverified information could cause harm. **Do not use this tool to circumvent lawful redactions, violate privacy, or break any applicable laws.** You are solely responsible for how you use it.

The author makes no claims of accuracy, completeness, or fitness for any particular purpose, and accepts no liability for misuse or for any consequences arising from the use of this tool.

## Support

A few people asked me to set up a way to support this project, so here it is. Please don't feel any obligation — this project is free and will stay that way. But if Unredact has been useful or interesting to you and you'd like to buy me a coffee, I genuinely appreciate it.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/apgcodes)

## License

[MIT](LICENSE)
