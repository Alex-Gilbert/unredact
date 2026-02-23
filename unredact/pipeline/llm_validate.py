"""LLM-based validation of solve candidates.

Sends candidate words to Claude Sonnet with surrounding text context.
Returns a contextual fit score (0-100) for each candidate.
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)

_VALIDATION_MODEL = "claude-sonnet-4-6"

SCORE_TOOL = {
    "name": "score_candidates",
    "description": "Score each candidate word on how well it fits the redacted gap contextually.",
    "input_schema": {
        "type": "object",
        "properties": {
            "scores": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "index": {
                            "type": "integer",
                            "description": "1-based index of the candidate in the list.",
                        },
                        "score": {
                            "type": "integer",
                            "description": "Contextual fit score from 0-100.",
                            "minimum": 0,
                            "maximum": 100,
                        },
                    },
                    "required": ["index", "score"],
                },
            },
        },
        "required": ["scores"],
    },
}


def build_validation_prompt(
    left_context: str,
    right_context: str,
    candidates: list[str],
) -> str:
    """Build the prompt for LLM validation of solve candidates."""
    numbered = "\n".join(f"{i+1}. {c}" for i, c in enumerate(candidates))
    return (
        "You are analyzing a redacted document. A section of text has been "
        "blacked out. The text surrounding the redaction reads:\n\n"
        f'Left context: "{left_context}"\n'
        "[REDACTED]\n"
        f'Right context: "{right_context}"\n\n'
        "Below is a list of candidate words/phrases that fit the redacted "
        "space by pixel width. Score each from 0-100 on how well it fits "
        "contextually:\n\n"
        "- 90-100: Near-certain fit (grammatically correct, semantically "
        "meaningful, contextually expected)\n"
        "- 60-89: Plausible (makes sense but not the most likely)\n"
        "- 30-59: Unlikely (grammatically possible but doesn't make much sense)\n"
        "- 0-29: Very poor fit (nonsensical, wrong part of speech, doesn't "
        "work in context)\n\n"
        'Example: If left context is "Dear Mr." and right is ", we are '
        'writing to inform you":\n'
        '- "Smith" -> 95 (common surname, perfect fit)\n'
        '- "house" -> 5 (not a surname, makes no sense after "Mr.")\n\n'
        f"Candidates:\n{numbered}"
    )


from unredact.pipeline.llm_detect import _get_client


async def validate_candidates(
    left_context: str,
    right_context: str,
    candidates: list[str],
) -> list[int]:
    """Score candidates using LLM. Returns list of scores in same order as candidates.

    Raises on API error — caller should handle.
    """
    if not candidates:
        return []

    prompt = build_validation_prompt(left_context, right_context, candidates)
    client = _get_client()

    response = await client.messages.create(
        model=_VALIDATION_MODEL,
        max_tokens=16384,
        tools=[SCORE_TOOL],
        tool_choice={"type": "tool", "name": "score_candidates"},
        messages=[{"role": "user", "content": prompt}],
    )

    scores = [0] * len(candidates)
    for block in response.content:
        if block.type == "tool_use" and block.name == "score_candidates":
            for item in block.input.get("scores", []):
                idx = item.get("index", 0) - 1  # 1-based to 0-based
                score = item.get("score", 0)
                if 0 <= idx < len(candidates):
                    scores[idx] = score
            break

    return scores
