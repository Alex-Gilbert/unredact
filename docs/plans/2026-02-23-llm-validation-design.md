# LLM Validation of Solve Results

## Problem

The pixel-width solver returns hundreds or thousands of candidates. Many fit the gap perfectly by width but make no sense given the surrounding text. Users have to manually scan results to find plausible ones.

## Solution

Add a "Validate" button that sends all solve results to Claude Sonnet with the surrounding text context. The LLM scores each candidate on contextual fit (0-100). Results are reordered by score, replacing the current list.

## Design

### Backend — Validation Endpoint

**Endpoint**: `POST /api/solve/{solve_id}/validate`

Request:
```json
{
  "left_context": "The defendant",
  "right_context": "was charged with"
}
```

The endpoint:
1. Reads all results from `_solve_results[solve_id]`
2. Extracts the `text` field from each
3. Sends a single Anthropic API call to `claude-sonnet-4-6` with context + candidate list
4. Uses `tool_use` for structured output: `[{index, score}]`
5. Merges scores onto the original result dicts
6. Returns the full list sorted by score descending

Response:
```json
{
  "results": [
    {"text": "Jonathan", "width_px": 42.5, "error_px": 0.3, "source": "names", "llm_score": 95},
    ...
  ],
  "total": 1800
}
```

Context comes from the frontend request (analysis segments + any user edits), keeping the endpoint stateless regarding document/redaction data.

### LLM Prompt

Model: `claude-sonnet-4-6` (hardcoded — needs strong reasoning).

```
You are analyzing a redacted document. A section of text has been blacked out.
The text surrounding the redaction reads:

Left context: "{left_context}"
[REDACTED]
Right context: "{right_context}"

Below is a list of candidate words/phrases that fit the redacted space by pixel width.
Score each from 0-100 on how well it fits contextually:

- 90-100: Near-certain fit (grammatically correct, semantically meaningful, contextually expected)
- 60-89: Plausible (makes sense but not the most likely)
- 30-59: Unlikely (grammatically possible but doesn't make much sense)
- 0-29: Very poor fit (nonsensical, wrong part of speech, doesn't work in context)

Example: If left context is "Dear Mr." and right is ", we are writing to inform you":
- "Smith" -> 95 (common surname, perfect fit)
- "house" -> 5 (not a surname, makes no sense after "Mr.")

Candidates:
1. word1
2. word2
...
```

Tool definition for structured output:
```python
{
    "name": "score_candidates",
    "input_schema": {
        "type": "object",
        "properties": {
            "scores": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "index": {"type": "integer"},
                        "score": {"type": "integer", "minimum": 0, "maximum": 100}
                    },
                    "required": ["index", "score"]
                }
            }
        },
        "required": ["scores"]
    }
}
```

Uses `index` (1-based, matching the numbered candidate list) to keep the response compact.

### Frontend — Validate UI

1. **"Validate" button** appears in the solve toolbar after a solve completes with results.

2. **Clicking "Validate"** reveals a small panel with:
   - Left context text input — pre-populated from `analysis.segments[0].text` (or user override from text edit bar)
   - Right context text input — pre-populated from `analysis.segments[1].text` (or override)
   - "Run" button

3. **Clicking "Run"**:
   - Loading state: "Validating N results..."
   - `POST /api/solve/{solve_id}/validate` with left/right context
   - On response: clears results list, renders all results reordered by `llm_score`
   - Load More button disappears (all results now shown)

4. **Score display**: each result gets a colored score badge:
   - Green (70+), yellow (30-69), red (0-29)
   - Existing associate badges still shown alongside

### Edge Cases

- Solve not complete yet: Validate button hidden until `done` event.
- No results: Validate button hidden.
- LLM API error: Show error toast, keep current results unchanged.
- Very large result sets (5000+): Send all — Sonnet handles it within context limits.
