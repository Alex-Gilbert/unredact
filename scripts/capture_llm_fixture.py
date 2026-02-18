"""Capture OCR + LLM output from a PDF for use as test fixtures.

Usage:
    python scripts/capture_llm_fixture.py /path/to/document.pdf [page_num]

Outputs JSON to stdout with:
- ocr_lines: serialized OCR lines with char positions
- llm_prompt: the prompt sent to the LLM
- llm_tool_input: the raw tool_use input from the LLM response
- llm_redactions: parsed LlmRedaction objects
"""

import asyncio
import json
import os
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Load .env manually (no dotenv dependency)
env_path = Path(__file__).parent.parent / ".env"
if env_path.exists():
    for _line in env_path.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

from unredact.pipeline.rasterize import rasterize_pdf
from unredact.pipeline.ocr import ocr_page
from unredact.pipeline.llm_detect import (
    _build_prompt, _parse_response, _get_client, _TOOL,
)
import os


def serialize_ocr_lines(lines):
    """Convert OCR lines to JSON-serializable dicts."""
    result = []
    for line in lines:
        chars = []
        for c in line.chars:
            chars.append({
                "text": c.text,
                "x": c.x, "y": c.y,
                "w": c.w, "h": c.h,
                "conf": c.conf,
            })
        result.append({
            "chars": chars,
            "x": line.x, "y": line.y,
            "w": line.w, "h": line.h,
            "text": line.text,
        })
    return result


async def main():
    pdf_path = Path(sys.argv[1])
    page_num = int(sys.argv[2]) if len(sys.argv) > 2 else 1

    print(f"Rasterizing {pdf_path}...", file=sys.stderr)
    pages = rasterize_pdf(pdf_path)
    if page_num > len(pages):
        print(f"Only {len(pages)} pages in PDF", file=sys.stderr)
        sys.exit(1)

    page_img = pages[page_num - 1]
    print(f"Page {page_num}: {page_img.size}", file=sys.stderr)

    print("Running OCR...", file=sys.stderr)
    lines = ocr_page(page_img)
    print(f"Found {len(lines)} lines", file=sys.stderr)

    prompt = _build_prompt(lines)
    print(f"Prompt length: {len(prompt)} chars", file=sys.stderr)

    model = os.environ.get("UNREDACT_LLM_MODEL", "claude-haiku-4-5-20251001")
    print(f"Calling {model}...", file=sys.stderr)

    client = _get_client()
    response = await client.messages.create(
        model=model,
        max_tokens=2048,
        tools=[_TOOL],
        tool_choice={"type": "tool", "name": "report_redactions"},
        messages=[{"role": "user", "content": prompt}],
    )

    # Extract tool_use block
    tool_input = None
    for block in response.content:
        if block.type == "tool_use" and block.name == "report_redactions":
            tool_input = block.input
            break

    if tool_input is None:
        print("ERROR: No tool_use block in response", file=sys.stderr)
        sys.exit(1)

    # Parse redactions
    redactions = _parse_response(tool_input, lines)

    print(f"LLM found {len(tool_input['redactions'])} redactions", file=sys.stderr)
    print(f"Parsed to {len(redactions)} with valid positions", file=sys.stderr)

    # Dump fixture
    fixture = {
        "source_pdf": pdf_path.name,
        "page": page_num,
        "ocr_lines": serialize_ocr_lines(lines),
        "llm_prompt": prompt,
        "llm_tool_input": tool_input,
        "llm_redactions": [
            {
                "line_index": r.line_index,
                "left_word": r.left_word,
                "right_word": r.right_word,
                "left_x": r.left_x,
                "right_x": r.right_x,
                "line_y": r.line_y,
                "line_h": r.line_h,
            }
            for r in redactions
        ],
    }

    json.dump(fixture, sys.stdout, indent=2)
    print(file=sys.stderr)
    print("Done!", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
