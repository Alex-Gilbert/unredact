"""LLM-based validation of solve candidates.

Sends candidate words to Claude Sonnet with surrounding text context.
Returns a contextual fit score (0-100) for each candidate.
"""

from __future__ import annotations

import logging
from typing import Callable

log = logging.getLogger(__name__)

_VALIDATION_MODEL = "claude-sonnet-4-6"
_BATCH_SIZE = 50

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
        "You are analyzing a redacted document. A word or phrase has been "
        "blacked out. The original sentence reads:\n\n"
        f'"{left_context} _____ {right_context}"\n\n'
        "For each candidate below, mentally substitute it into the blank and "
        "evaluate: Does the resulting sentence read naturally? Is it "
        "grammatically correct? Does it make sense?\n\n"
        "Score each candidate 0-100 based on whether it produces a "
        "coherent sentence:\n"
        "- 80-100: The sentence reads naturally and makes sense\n"
        "- 50-79: Grammatically acceptable but slightly awkward or unusual\n"
        "- 20-49: Grammatically questionable or semantically odd\n"
        "- 0-19: Ungrammatical, nonsensical, or wrong part of speech\n\n"
        f"Candidates:\n{numbered}"
    )


from unredact.pipeline.llm_detect import _get_client


async def _score_batch(
    client,
    left_context: str,
    right_context: str,
    candidates: list[str],
) -> list[int]:
    """Score a single batch of candidates. Returns scores in same order."""
    prompt = build_validation_prompt(left_context, right_context, candidates)

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


async def validate_candidates(
    left_context: str,
    right_context: str,
    candidates: list[str],
    on_progress: Callable[[int, int], None] | None = None,
) -> list[int]:
    """Score candidates using LLM. Returns list of scores in same order as candidates.

    Batches candidates into groups to stay within output token limits.
    Calls on_progress(scored_so_far, total) after each batch if provided.

    Raises on API error — caller should handle.
    """
    if not candidates:
        return []

    client = _get_client()
    scores = [0] * len(candidates)
    total_batches = (len(candidates) + _BATCH_SIZE - 1) // _BATCH_SIZE

    for batch_idx in range(total_batches):
        start = batch_idx * _BATCH_SIZE
        end = min(start + _BATCH_SIZE, len(candidates))
        batch = candidates[start:end]

        log.info("Scoring batch %d/%d (%d candidates)", batch_idx + 1, total_batches, len(batch))
        batch_scores = await _score_batch(client, left_context, right_context, batch)

        for i, s in enumerate(batch_scores):
            scores[start + i] = s

        if on_progress:
            on_progress(end, len(candidates))

    return scores
