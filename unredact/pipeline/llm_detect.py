"""LLM-based redaction detection.

Receives OCR lines and calls Claude Haiku to identify where redactions are.
The LLM spots broken text patterns (artifacts like ``[``, ``|``, garbled chars)
and returns the clean boundary words around each redaction.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

import anthropic

from unredact.pipeline.ocr import OcrLine

log = logging.getLogger(__name__)

_DEFAULT_MODEL = "claude-haiku-4-5-20251001"

_TOOL = {
    "name": "report_redactions",
    "description": "Report redacted sections found in the OCR text.",
    "input_schema": {
        "type": "object",
        "properties": {
            "redactions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "line_index": {
                            "type": "integer",
                            "description": "Zero-based line index",
                        },
                        "left_word": {
                            "type": "string",
                            "description": (
                                "Last clean word before redaction. "
                                "Empty if at line start."
                            ),
                        },
                        "right_word": {
                            "type": "string",
                            "description": (
                                "First clean word after redaction. "
                                "Empty if at line end."
                            ),
                        },
                    },
                    "required": ["line_index", "left_word", "right_word"],
                },
            },
        },
        "required": ["redactions"],
    },
}

# Module-level cached client
_client: anthropic.AsyncAnthropic | None = None


def _get_client() -> anthropic.AsyncAnthropic:
    """Return a cached async Anthropic client."""
    global _client
    if _client is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError(
                "ANTHROPIC_API_KEY not set. Export it before running the server."
            )
        _client = anthropic.AsyncAnthropic()
    return _client


@dataclass
class LlmRedaction:
    """A redaction detected by the LLM, anchored to OCR pixel positions."""

    line_index: int
    left_word: str
    right_word: str
    left_x: int
    right_x: int
    line_y: int
    line_h: int


def _build_prompt(lines: list[OcrLine]) -> str:
    """Format OCR lines into the LLM prompt."""
    header = (
        "You are analyzing OCR output from a scanned legal document. "
        "Some parts of the document have been redacted (blacked out). "
        "The OCR engine often produces garbled text, brackets, pipes, or "
        "random characters where redactions are.\n\n"
        "Identify each redacted section. For each one, report:\n"
        "- The zero-based line index\n"
        "- The last clean word BEFORE the redaction (empty string if "
        "redaction is at the start of the line)\n"
        "- The first clean word AFTER the redaction (empty string if "
        "redaction is at the end of the line)\n\n"
        "OCR lines:\n"
    )

    line_texts = []
    for i, line in enumerate(lines):
        line_texts.append(f"[{i}] {line.text}")

    return header + "\n".join(line_texts)


def _find_word_in_chars(
    line: OcrLine,
    word: str,
    search_from: int,
    from_right: bool,
) -> tuple[int, int] | None:
    """Find a word in the OCR char list and return (start_x, end_x).

    Args:
        line: The OCR line to search in.
        word: The word to find.
        search_from: Only consider matches starting at or after this x position.
        from_right: If True, return the rightmost (last) match instead of the first.

    Returns:
        (start_x, end_x) pixel coordinates, or None if not found.
    """
    if not word:
        return None

    chars = line.chars
    text = line.text
    best: tuple[int, int] | None = None

    # Find all occurrences of `word` in the line text
    start = 0
    while True:
        idx = text.find(word, start)
        if idx == -1:
            break

        # Map character index back to pixel position
        char_start = chars[idx]
        char_end = chars[idx + len(word) - 1]
        start_x = char_start.x
        end_x = char_end.x + char_end.w

        if start_x >= search_from:
            if from_right:
                best = (start_x, end_x)
            else:
                return (start_x, end_x)

        start = idx + 1

    return best


def _parse_response(
    tool_input: dict,
    lines: list[OcrLine],
) -> list[LlmRedaction]:
    """Map the LLM's tool response back to pixel positions using OCR char data.

    Args:
        tool_input: The ``input`` dict from the LLM's tool_use content block.
        lines: The OCR lines that were sent to the LLM.

    Returns:
        List of LlmRedaction objects with pixel-accurate positions.
    """
    redactions: list[LlmRedaction] = []

    for item in tool_input.get("redactions", []):
        line_index = item["line_index"]
        left_word = item["left_word"]
        right_word = item["right_word"]

        # Validate line index
        if line_index < 0 or line_index >= len(lines):
            log.warning("LLM returned invalid line_index %d, skipping", line_index)
            continue

        line = lines[line_index]

        # Determine left_x: right edge of left_word, or line start
        if left_word:
            found = _find_word_in_chars(line, left_word, search_from=0, from_right=False)
            if found is None:
                log.warning(
                    "Could not find left_word %r in line %d, skipping",
                    left_word,
                    line_index,
                )
                continue
            left_x = found[1]  # right edge of left_word
        else:
            left_x = line.x

        # Determine right_x: left edge of right_word, or line end
        if right_word:
            search_after = left_x if left_word else 0
            found = _find_word_in_chars(
                line, right_word, search_from=search_after, from_right=False
            )
            if found is None:
                log.warning(
                    "Could not find right_word %r in line %d, skipping",
                    right_word,
                    line_index,
                )
                continue
            right_x = found[0]  # left edge of right_word
        else:
            right_x = line.x + line.w

        redactions.append(
            LlmRedaction(
                line_index=line_index,
                left_word=left_word,
                right_word=right_word,
                left_x=left_x,
                right_x=right_x,
                line_y=line.y,
                line_h=line.h,
            )
        )

    return redactions


@dataclass
class BoundaryText:
    """Clean left/right text around a redaction, as identified by the LLM."""

    left_text: str
    right_text: str


_BOUNDARY_TOOL = {
    "name": "report_boundary_text",
    "description": "Report the clean text on each side of a redaction in an OCR line.",
    "input_schema": {
        "type": "object",
        "properties": {
            "left_text": {
                "type": "string",
                "description": (
                    "Clean text before the redaction, with OCR "
                    "artifacts removed. Empty string if redaction "
                    "is at line start."
                ),
            },
            "right_text": {
                "type": "string",
                "description": (
                    "Clean text after the redaction, with OCR "
                    "artifacts removed. Empty string if redaction "
                    "is at line end."
                ),
            },
        },
        "required": ["left_text", "right_text"],
    },
}


def _build_boundary_prompt(line: OcrLine, box_x: int, box_w: int) -> str:
    """Build prompt for single-line boundary text identification."""
    left_chars = [c for c in line.chars if c.x + c.w / 2 < box_x]
    mid_chars = [
        c for c in line.chars
        if box_x <= c.x + c.w / 2 <= box_x + box_w
    ]
    right_chars = [c for c in line.chars if c.x + c.w / 2 > box_x + box_w]

    left_raw = "".join(c.text for c in left_chars)
    mid_raw = "".join(c.text for c in mid_chars)
    right_raw = "".join(c.text for c in right_chars)

    return (
        "You are analyzing a single line of OCR text from a scanned legal document. "
        "Part of this line has been redacted (blacked out), which causes the OCR engine "
        "to produce garbled characters near the redaction edges.\n\n"
        f'Full OCR line: {line.text}\n'
        f'Approximate split: LEFT="{left_raw}" REDACTED="{mid_raw}" RIGHT="{right_raw}"\n\n'
        "The characters immediately adjacent to the redaction may be misread or truncated "
        "by the OCR engine. For example, 'Se' might actually be 'Sent' with the 'nt' "
        "lost to redaction artifacts.\n\n"
        "Return the clean, corrected text that should appear to the left and right of "
        "the redaction. Fix any obvious OCR errors near the boundary. Do not include "
        "any redaction artifacts (brackets, pipes, random characters). "
        "If the redaction is at the start or end of the line, use an empty string "
        "for that side."
    )


async def identify_boundary_text(
    line: OcrLine,
    box_x: int,
    box_w: int,
) -> BoundaryText:
    """Use LLM to identify clean boundary text around a single redaction.

    Sends a focused prompt with just the one OCR line and redaction position.
    Falls back to center-point character filtering if the LLM call fails.

    Args:
        line: The OCR line containing the redaction.
        box_x: X pixel position of the redaction box.
        box_w: Width of the redaction box in pixels.

    Returns:
        BoundaryText with cleaned left and right text.
    """
    # Fallback in case LLM is unavailable
    def _fallback():
        left = [c for c in line.chars if c.x + c.w / 2 < box_x]
        right = [c for c in line.chars if c.x + c.w / 2 > box_x + box_w]
        return BoundaryText(
            left_text="".join(c.text for c in left).strip(),
            right_text="".join(c.text for c in right).strip(),
        )

    try:
        model = os.environ.get("UNREDACT_LLM_MODEL", _DEFAULT_MODEL)
        prompt = _build_boundary_prompt(line, box_x, box_w)
        client = _get_client()

        response = await client.messages.create(
            model=model,
            max_tokens=512,
            tools=[_BOUNDARY_TOOL],
            tool_choice={"type": "tool", "name": "report_boundary_text"},
            messages=[{"role": "user", "content": prompt}],
        )

        for block in response.content:
            if block.type == "tool_use" and block.name == "report_boundary_text":
                return BoundaryText(
                    left_text=block.input.get("left_text", "").strip(),
                    right_text=block.input.get("right_text", "").strip(),
                )

        log.warning("LLM boundary response had no tool call, using fallback")
        return _fallback()

    except Exception:
        log.warning("LLM boundary call failed, using center-point fallback", exc_info=True)
        return _fallback()


async def detect_redactions_llm(
    lines: list[OcrLine],
) -> list[LlmRedaction]:
    """Detect redactions by sending OCR text to Claude.

    This is the main entry point. Calls Claude Haiku with tool use for
    structured output, then maps the response back to pixel positions.

    Args:
        lines: OCR lines from the page.

    Returns:
        List of detected redactions with pixel positions.
    """
    if not lines:
        return []

    model = os.environ.get("UNREDACT_LLM_MODEL", _DEFAULT_MODEL)
    prompt = _build_prompt(lines)
    client = _get_client()

    response = await client.messages.create(
        model=model,
        max_tokens=2048,
        tools=[_TOOL],
        tool_choice={"type": "tool", "name": "report_redactions"},
        messages=[{"role": "user", "content": prompt}],
    )

    # Extract the tool_use block from the response
    for block in response.content:
        if block.type == "tool_use" and block.name == "report_redactions":
            return _parse_response(block.input, lines)

    log.warning("LLM response did not contain a report_redactions tool call")
    return []
