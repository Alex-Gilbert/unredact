#!/bin/bash
set -e

echo "Building WASM..."
cd unredact-wasm
wasm-pack build --target web --release
cd ..

echo "Creating dist directory..."
rm -rf dist
mkdir -p dist/static dist/pkg dist/data dist/fonts

# Copy WASM output
cp unredact-wasm/pkg/unredact_core.js dist/pkg/
cp unredact-wasm/pkg/unredact_core_bg.wasm dist/pkg/

# Copy frontend
cp unredact/static/*.html dist/
cp unredact/static/*.js dist/static/
cp unredact/static/*.css dist/static/

# Copy data files
cp unredact/data/*.txt dist/data/
cp unredact/data/*.json dist/data/

# Copy font manifest
cp unredact/static/fonts/manifest.json dist/fonts/

echo "Build complete. Output in dist/"
echo "  WASM: $(du -sh dist/pkg/unredact_core_bg.wasm | cut -f1)"
echo "  Total: $(du -sh dist/ | cut -f1)"
