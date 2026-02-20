// @ts-check
/** Solve engine — SSE streaming constraint solver with associate matching. */

import { state } from './state.js';
import {
  solveCharset, solveTolerance, solveMode, solveFilter,
  solveKnownStart, solveKnownEnd,
  solveResults, solveStatus, solveStart, solveStop,
  solveAccept, redactionMarker, escapeHtml,
} from './dom.js';
import { renderCanvas } from './canvas.js';
import { matchAssociates, tierBadgeClass, tierLabel, isVictimMatch, showAssocDetail } from './associates.js';

/** @type {AbortController|null} */
let activeEventSource = null;

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
  solveStatus.textContent = "Starting...";
  solveStart.hidden = true;
  solveStop.hidden = false;
  solveAccept.hidden = true;

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
      r.preview = data.text;
      redactionMarker.textContent = data.text;
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

    solveStatus.textContent = `Found ${solveResults.children.length} matches`;
  } else if (data.status === "running") {
    solveStatus.textContent = `Checked ${data.checked}, found ${data.found}...`;
  } else if (data.status === "done") {
    solveStatus.textContent = `Done. ${data.total_found} total matches.`;
    solveStart.hidden = false;
    solveStop.hidden = true;
    activeEventSource = null;
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
    text: r.preview,
    fontName: solFontName,
    fontSize: o.fontSize || r.analysis.font.size,
  };
  r.approvedText = leftText + r.preview + rightText;
  r.preview = null;
}

/** Set up solver button listeners. Call once from main.js. */
export function initSolver() {
  solveStart.addEventListener("click", startSolve);
  solveStop.addEventListener("click", stopSolve);
}
