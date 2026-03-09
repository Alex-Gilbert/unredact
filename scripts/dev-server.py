#!/usr/bin/env python3
"""Dev server that mirrors the production flat layout.

Serves from project root, mapping paths to their source locations:
  /             -> unredact/static/index.html
  /*.js, *.css  -> unredact/static/
  /pkg/         -> unredact-wasm/pkg/
  /data/        -> unredact/data/
  /fonts/       -> unredact/static/fonts/
"""

import http.server
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAPPINGS = [
    ("/pkg/", ROOT / "unredact-wasm" / "pkg"),
    ("/data/", ROOT / "unredact" / "data"),
    ("/fonts/", ROOT / "unredact" / "static" / "fonts"),
]
STATIC_DIR = ROOT / "unredact" / "static"


class DevHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        # Strip query string
        path = path.split("?", 1)[0].split("#", 1)[0]

        # Root -> index.html
        if path == "/":
            return str(STATIC_DIR / "index.html")

        # Check mapped directories
        for prefix, local_dir in MAPPINGS:
            if path.startswith(prefix):
                rel = path[len(prefix):]
                return str(local_dir / rel)

        # Everything else -> static dir
        return str(STATIC_DIR / path.lstrip("/"))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(str(ROOT))
    server = http.server.HTTPServer(("", port), DevHandler)
    print(f"Dev server at http://localhost:{port}")
    print(f"  Static: {STATIC_DIR}")
    print(f"  WASM:   {ROOT / 'unredact-wasm' / 'pkg'}")
    print(f"  Data:   {ROOT / 'unredact' / 'data'}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
