// @ts-check
/** Solve engine — SSE streaming constraint solver with associate matching. */

import { state } from './state.js';
import {
  solveCharset, solveTolerance, solveMode, solveFilter,
  solveKnownStart, solveKnownEnd, solvePlural, solveVocab,
  solveResults, solveStatus, solveStart, solveStop,
  solveAccept, solveLoadMore, solveValidate,
  validatePanel, validateLeft, validateRight, validateRun,
  redactionMarker, escapeHtml,
} from './dom.js';
import { renderCanvas } from './canvas.js';
import { matchAssociates, tierBadgeClass, tierLabel, isVictimMatch, showAssocDetail } from './associates.js';

/** @type {AbortController|null} */
let activeEventSource = null;

/** @type {string|null} */
let currentSolveId = null;
let displayedCount = 0;
let totalFound = 0;

export function startSolve() {
  const id = state.activeRedaction;
  if (!id) return;
  const r = state.redactions[id];
  if (!r || !r.analysis) return;

  const a = r.analysis;
  const o = r.overrides || {};
  const fontId = o.fontId ?? a.font.id;
  const fontSize = o.fontSize ?? a.font.size;
  const gapWidth = o.gapWidth ?? a.gap.w;

  const leftText = o.leftText ?? (a.segments.length > 0 ? a.segments[0].text : "");
  const rightText = o.rightText ?? (a.segments.length > 1 ? a.segments[1].text : "");
  const leftCtx = leftText.length > 0 ? leftText[leftText.length - 1] : "";
  const rightCtx = rightText.length > 0 ? rightText[0] : "";

  solveResults.innerHTML = "";
  solveLoadMore.hidden = true;
  currentSolveId = null;
  displayedCount = 0;
  totalFound = 0;
  solveStatus.textContent = "Starting...";
  solveStart.hidden = true;
  solveStop.hidden = false;
  solveAccept.hidden = true;
  solveValidate.hidden = true;
  validatePanel.hidden = true;

  const body = {
    font_id: fontId,
    font_size: fontSize,
    gap_width_px: gapWidth,
    tolerance_px: parseFloat(solveTolerance.value),
    left_context: leftCtx,
    right_context: rightCtx,
    hints: {
      charset: solveCharset.value,
    },
    mode: solveMode.value,
    word_filter: solveFilter.value,
    known_start: solveKnownStart.value,
    known_end: solveKnownEnd.value,
    ensure_plural: solvePlural.checked,
    vocab_size: parseInt(solveVocab.value) || 0,
  };

  const abortController = new AbortController();
  activeEventSource = abortController;

  fetch("/api/solve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: abortController.signal,
  }).then(response => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    function read() {
      reader.read().then(({ done, value }) => {
        if (done) {
          solveStart.hidden = false;
          solveStop.hidden = true;
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              handleSolveEvent(data, id);
            } catch (e) { /* skip malformed */ }
          }
        }
        read();
      });
    }
    read();
  }).catch(err => {
    if (err.name !== "AbortError") {
      solveStatus.textContent = "Error: " + err.message;
    }
    solveStart.hidden = false;
    solveStop.hidden = true;
  });
}

/**
 * @param {Object} data
 * @param {string} redactionId
 */
function handleSolveEvent(data, redactionId) {
  if (data.status === "match") {
    const assocMatches = matchAssociates(data.text);
    const topMatch = assocMatches.length > 0 ? assocMatches[0] : null;

    const div = document.createElement("div");
    div.className = "solve-result";
    if (topMatch) {
      div.dataset.assocTier = String(topMatch.tier);
      div.dataset.assocScore = String(topMatch.score);
    }

    div.innerHTML = `
      <span class="result-text">${escapeHtml(data.text)}</span>
      <span class="result-error">${data.error_px.toFixed(1)}px ${data.source || ""}</span>
    `;

    const victim = isVictimMatch(data.text);

    if (victim) {
      const vBadge = document.createElement("span");
      vBadge.className = "assoc-badge victim";
      vBadge.textContent = "V";
      vBadge.title = "Matches a known victim name";
      div.prepend(vBadge);
    }

    if (assocMatches.length > 0) {
      const badge = document.createElement("button");
      badge.className = `assoc-badge ${tierBadgeClass(topMatch.tier)}`;
      badge.textContent = tierLabel(topMatch.tier);
      badge.title = "Click for details";
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        showAssocDetail(assocMatches, badge);
      });
      div.prepend(badge);
    }

    div.addEventListener("click", () => {
      const r = state.redactions[redactionId];
      if (!r) return;

      // Strip known start/end from preview — those are already visible
      let previewText = data.text;
      const ks = solveKnownStart.value;
      const ke = solveKnownEnd.value;
      if (ks && previewText.toLowerCase().startsWith(ks.toLowerCase())) {
        previewText = previewText.slice(ks.length);
      }
      if (ke && previewText.toLowerCase().endsWith(ke.toLowerCase())) {
        previewText = previewText.slice(0, -ke.length);
      }

      r.preview = previewText;
      r.solveFullText = data.text;
      redactionMarker.value = previewText;
      redactionMarker.className = "redaction-marker preview";
      renderCanvas();
      solveResults.querySelectorAll(".solve-result").forEach(el => el.classList.remove("active"));
      div.classList.add("active");
      solveAccept.hidden = false;
    });

    if (topMatch) {
      let inserted = false;
      for (const existing of solveResults.children) {
        const exTier = parseInt(/** @type {HTMLElement} */ (existing).dataset.assocTier || "99");
        const exScore = parseFloat(/** @type {HTMLElement} */ (existing).dataset.assocScore || "0");
        if (topMatch.tier < exTier || (topMatch.tier === exTier && topMatch.score > exScore)) {
          solveResults.insertBefore(div, existing);
          inserted = true;
          break;
        }
      }
      if (!inserted) solveResults.appendChild(div);
    } else {
      solveResults.appendChild(div);
    }

    displayedCount++;
    solveStatus.textContent = `Found ${displayedCount} matches`;
  } else if (data.status === "running") {
    solveStatus.textContent = `Checked ${data.checked}, found ${data.found}...`;
  } else if (data.status === "page_complete") {
    currentSolveId = data.solve_id;
    solveStatus.textContent = `Found ${displayedCount} matches, searching for more...`;
  } else if (data.status === "done") {
    totalFound = data.total_found;
    if (data.solve_id) currentSolveId = data.solve_id;
    if (totalFound > displayedCount) {
      solveLoadMore.textContent = `Load more (showing ${displayedCount} of ${totalFound})`;
      solveLoadMore.hidden = false;
    }
    solveStatus.textContent = `Done. ${data.total_found} total matches.`;
    solveStart.hidden = false;
    solveStop.hidden = true;
    activeEventSource = null;
    if (totalFound > 0) {
      solveValidate.hidden = false;
    }
  }
}

export function stopSolve() {
  if (activeEventSource) {
    activeEventSource.abort();
    activeEventSource = null;
  }
  solveStart.hidden = false;
  solveStop.hidden = true;
  solveStatus.textContent = "Stopped.";
}

/**
 * Accept the current preview as the solution. Only mutates state —
 * caller (main.js) is responsible for UI updates (renderRedactionList, closePopover).
 */
export function acceptSolution() {
  const id = state.activeRedaction;
  if (!id) return;
  const r = state.redactions[id];
  if (!r || !r.preview) return;

  const o = r.overrides || {};
  const leftText = o.leftText ?? "";
  const rightText = o.rightText ?? "";

  r.status = "approved";
  const solFontName = state.fonts.find(f => f.id === (o.fontId || r.analysis.font.id))?.name || r.analysis.font.name;
  r.solution = {
    text: r.solveFullText || r.preview,
    fontName: solFontName,
    fontSize: o.fontSize || r.analysis.font.size,
  };
  r.approvedText = leftText + r.preview + rightText;
  r.preview = null;
  r.solveFullText = null;
}

async function loadMore() {
  if (!currentSolveId) return;
  solveLoadMore.disabled = true;
  solveLoadMore.textContent = "Loading...";

  try {
    const resp = await fetch(
      `/api/solve/${currentSolveId}/results?offset=${displayedCount}&limit=200`
    );
    if (!resp.ok) throw new Error("Failed to load results");
    const data = await resp.json();

    const redactionId = state.activeRedaction;
    for (const item of data.results) {
      handleSolveEvent({ status: "match", ...item }, redactionId);
    }

    if (displayedCount >= totalFound) {
      solveLoadMore.hidden = true;
    } else {
      solveLoadMore.textContent = `Load more (showing ${displayedCount} of ${totalFound})`;
      solveLoadMore.disabled = false;
    }
  } catch (err) {
    solveLoadMore.textContent = "Error loading — click to retry";
    solveLoadMore.disabled = false;
  }
}

function showValidatePanel() {
  const id = state.activeRedaction;
  if (!id) return;
  const r = state.redactions[id];
  if (!r || !r.analysis) return;

  const a = r.analysis;
  const o = r.overrides || {};
  const leftText = o.leftText ?? (a.segments.length > 0 ? a.segments[0].text : "");
  const rightText = o.rightText ?? (a.segments.length > 1 ? a.segments[1].text : "");

  validateLeft.value = leftText;
  validateRight.value = rightText;
  validatePanel.hidden = false;
}

async function runValidation() {
  if (!currentSolveId) return;
  validateRun.disabled = true;
  validateRun.textContent = "Validating...";
  solveStatus.textContent = "Starting validation...";

  // Clear existing results for fresh scored list
  solveResults.innerHTML = "";
  displayedCount = 0;
  solveLoadMore.hidden = true;

  const redactionId = state.activeRedaction;

  try {
    const resp = await fetch(`/api/solve/${currentSolveId}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        left_context: validateLeft.value,
        right_context: validateRight.value,
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.error || `Validation failed (${resp.status})`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let data;
        try { data = JSON.parse(line.slice(6)); } catch { continue; }

        if (data.status === "started") {
          solveStatus.textContent = `Validating ${data.total} results (${data.batches} batches)...`;
        } else if (data.status === "scoring") {
          solveStatus.textContent = `Scoring batch ${data.batch}/${data.batches} (${data.scored}/${data.total} scored)...`;
        } else if (data.status === "batch_done") {
          for (const item of data.results) {
            renderScoredResult(item, redactionId);
          }
          solveStatus.textContent = `Scored ${data.scored}/${data.total}...`;
        } else if (data.status === "error") {
          throw new Error(data.error);
        } else if (data.status === "done") {
          solveStatus.textContent = `Validated. ${data.total} results scored.`;
          validatePanel.hidden = true;
        }
      }
    }
  } catch (err) {
    solveStatus.textContent = "Validation error: " + err.message;
  } finally {
    validateRun.disabled = false;
    validateRun.textContent = "Run";
  }
}

/**
 * Render a single scored result, inserting in descending score order.
 */
function renderScoredResult(item, redactionId) {
  const score = item.llm_score ?? 0;

  const div = document.createElement("div");
  div.className = "solve-result";
  div.dataset.llmScore = String(score);

  // Score badge
  const badge = document.createElement("span");
  badge.className = "llm-score";
  if (score >= 70) badge.classList.add("score-high");
  else if (score >= 30) badge.classList.add("score-mid");
  else badge.classList.add("score-low");
  badge.textContent = String(score);
  badge.title = "LLM contextual fit score";

  div.innerHTML = `
    <span class="result-text">${escapeHtml(item.text)}</span>
    <span class="result-error">${item.error_px.toFixed(1)}px ${item.source || ""}</span>
  `;
  div.prepend(badge);

  // Click to preview
  div.addEventListener("click", () => {
    const r = state.redactions[redactionId];
    if (!r) return;

    let previewText = item.text;
    const ks = solveKnownStart.value;
    const ke = solveKnownEnd.value;
    if (ks && previewText.toLowerCase().startsWith(ks.toLowerCase())) {
      previewText = previewText.slice(ks.length);
    }
    if (ke && previewText.toLowerCase().endsWith(ke.toLowerCase())) {
      previewText = previewText.slice(0, -ke.length);
    }

    r.preview = previewText;
    r.solveFullText = item.text;
    redactionMarker.value = previewText;
    redactionMarker.className = "redaction-marker preview";
    renderCanvas();
    solveResults.querySelectorAll(".solve-result").forEach(el => el.classList.remove("active"));
    div.classList.add("active");
    solveAccept.hidden = false;
  });

  // Insert in sorted position (descending by score)
  let inserted = false;
  for (const existing of solveResults.children) {
    const exScore = parseInt(/** @type {HTMLElement} */ (existing).dataset.llmScore || "0");
    if (score > exScore) {
      solveResults.insertBefore(div, existing);
      inserted = true;
      break;
    }
  }
  if (!inserted) solveResults.appendChild(div);

  displayedCount++;
}

/** Set up solver button listeners. Call once from main.js. */
export function initSolver() {
  solveStart.addEventListener("click", startSolve);
  solveStop.addEventListener("click", stopSolve);
  solveLoadMore.addEventListener("click", loadMore);
  solveValidate.addEventListener("click", showValidatePanel);
  validateRun.addEventListener("click", runValidation);
}
