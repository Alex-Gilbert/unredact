# Solve Result Pagination

## Problem

The frontend cannot handle 100k+ results being streamed via SSE. Large solves (especially word mode with full vocabulary and generous tolerance) overwhelm the DOM and make the UI unresponsive.

## Solution

Paginate solve results: stream the first 200 via SSE (preserving real-time feel), buffer the rest server-side, and expose a REST endpoint for fetching additional pages.

Applies to **all solve modes**, not just word mode.

## Design

### Backend — SSE Stream with Cap

Current flow in `app.py`:
```
POST /api/solve → generator → for each result: SSE event → "done"
```

New flow:
```
POST /api/solve → generator →
  first 200 results: SSE "match" events (same format as today)
  → SSE "page_complete" event: {"sent": 200, "solve_id": "..."}
  → continue draining generator into server-side buffer (no SSE events)
  → SSE "done" event: {"status": "done", "total_found": N}
```

The SSE connection stays open while the generator drains completely. The frontend stops rendering new results after `page_complete` but keeps the connection open to receive the `done` event with the accurate total count.

All results (including the first 200) are stored in the server-side buffer for later pagination requests.

### Backend — Pagination Endpoint

**Storage**: `_solve_results: dict[str, list[dict]]` keyed by `solve_id`.

**Endpoint**: `GET /api/solve/{solve_id}/results?offset=0&limit=200`

Response:
```json
{
  "results": [{"text": "...", "width_px": 42.5, "error_px": 0.3, "source": "words"}, ...],
  "total": 1234,
  "offset": 200,
  "limit": 200,
  "complete": true
}
```

- `complete: false` if the solve generator is still running (total may increase).
- 404 if `solve_id` not found.

**Cleanup**: Buffer deleted when a new solve starts or solve is cancelled via `DELETE /api/solve/{solve_id}`.

### Frontend — Load More Button

1. **First page**: SSE works as today for first 200 results. DOM elements created in real-time.
2. **Page complete**: Frontend stores `solve_id`, knows more results may exist.
3. **Done event**: If `total_found > 200`, a button appears: **"Load more (showing 200 of 1,234)"**.
4. **Load more click**: `GET /api/solve/{solve_id}/results?offset=200&limit=200`. Results appended to DOM. Button updates count. Button disappears when all results shown.
5. **New solve**: Clears results and button as today.

### Constants

- `PAGE_SIZE = 200` — fixed, not user-configurable.

### Edge Cases

- Solve produces <= 200 results: no button shown, behaves exactly as today.
- User cancels mid-solve: buffer contains partial results, button shows count of what was found.
- User starts new solve while previous buffer exists: old buffer is discarded.
