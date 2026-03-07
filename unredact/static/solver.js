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
import { solve } from './wasm.js';
import { validateCandidates } from './llm.js';
import { getSetting } from './db.js';

/** @type {AbortController|null} */
let activeEventSource = null;

/** @type {string|null} */
let currentSolveId = null;
let displayedCount = 0;
let totalFound = 0;

/** @type {Array<{text: string, width: number, error: number}>} */
let allResults = [];

/** @type {Object<string, string[]>} */
const dataCache = {};

async function loadDataFile(name) {
    if (!dataCache[name]) {
        const resp = await fetch(`data/${name}`);
        const text = await resp.text();
        dataCache[name] = text.split('\n').filter(line => line.trim());
    }
    return dataCache[name];
}

/**
 * Measure widths of entries using Canvas measureText with kerning context.
 * @param {string[]} entries
 * @param {string} fontName
 * @param {number} fontSize
 * @param {string} leftCtx - last char of left context (for kerning)
 * @param {string} rightCtx - first char of right context (for kerning)
 * @returns {Array<[string, number]>}
 */
function measureWidths(entries, fontName, fontSize, leftCtx, rightCtx) {
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    ctx.font = `${fontSize}px "${fontName}"`;

    const leftW = leftCtx ? ctx.measureText(leftCtx).width : 0;
    const rightW = rightCtx ? ctx.measureText(rightCtx).width : 0;

    return entries.map(text => {
        const full = (leftCtx || '') + text + (rightCtx || '');
        const w = ctx.measureText(full).width - leftW - rightW;
        return [text, w];
    });
}

export async function startSolve() {
  const id = state.activeRedaction;
  if (!id) return;
  const r = state.redactions[id];
  if (!r || !r.analysis) return;

  const a = r.analysis;
  const o = r.overrides || {};
  const fontName = state.fonts.find(f => f.id === (o.fontId ?? a.font.id))?.name || a.font.name;
  const fontSize = o.fontSize ?? a.font.size;
  const gapWidth = o.gapWidth ?? a.gap.w;
  const tolerance = parseFloat(solveTolerance.value);

  const leftText = o.leftText ?? (a.segments.length > 0 ? a.segments[0].text : "");
  const rightText = o.rightText ?? (a.segments.length > 1 ? a.segments[1].text : "");
  const leftCtx = leftText.length > 0 ? leftText[leftText.length - 1] : "";
  const rightCtx = rightText.length > 0 ? rightText[0] : "";

  const mode = solveMode.value;
  const knownStart = solveKnownStart.value;
  const knownEnd = solveKnownEnd.value;

  // Reset UI
  solveResults.innerHTML = "";
  solveLoadMore.hidden = true;
  currentSolveId = null;
  allResults = [];
  displayedCount = 0;
  totalFound = 0;
  solveStatus.textContent = "Loading data...";
  solveStart.hidden = true;
  solveStop.hidden = false;
  solveAccept.hidden = true;
  solveValidate.hidden = true;
  validatePanel.hidden = true;

  try {
    // Load appropriate word list based on mode
    let entries = [];
    if (mode === 'name') {
      const firsts = await loadDataFile('associate_first_names.txt');
      const lasts = await loadDataFile('associate_last_names.txt');
      entries = [...new Set([...firsts, ...lasts])];
    } else if (mode === 'full_name') {
      const resp = await fetch('data/associates.json');
      const data = await resp.json();
      // Extract all multi-word name variants
      entries = Object.keys(data).filter(k => k.includes(' '));
    } else if (mode === 'email') {
      entries = await loadDataFile('emails.txt');
    } else if (mode === 'word') {
      const plural = solvePlural.checked;
      const vocabSize = parseInt(solveVocab.value) || 0;
      let nouns = await loadDataFile(plural ? 'nouns_plural.txt' : 'nouns.txt');
      if (vocabSize > 0) nouns = nouns.slice(0, vocabSize);
      entries = nouns;
      // TODO: two-word phrase support (adjective + noun)
    }

    solveStatus.textContent = `Measuring ${entries.length} candidates...`;

    // Measure widths
    const measured = measureWidths(entries, fontName, fontSize, leftCtx, rightCtx);

    solveStatus.textContent = "Solving...";

    // Call WASM solver
    const results = solve({
      entries: measured,
      target_width: gapWidth,
      tolerance: tolerance,
      known_start: knownStart,
      known_end: knownEnd,
      mode: mode,
    });

    // Store all results for pagination
    allResults = results;
    totalFound = results.length;

    // Display first batch
    const batch = results.slice(0, 200);
    for (const item of batch) {
      handleSolveEvent({
        status: "match",
        text: item.text,
        error_px: item.error,
        source: mode,
      }, id);
    }

    // Show load more if needed
    if (totalFound > 200) {
      solveLoadMore.textContent = `Load more (showing ${displayedCount} of ${totalFound})`;
      solveLoadMore.hidden = false;
    }

    solveStatus.textContent = `Done. ${totalFound} total matches.`;
    if (totalFound > 0) solveValidate.hidden = false;
  } catch (err) {
    solveStatus.textContent = "Error: " + err.message;
  } finally {
    solveStart.hidden = false;
    solveStop.hidden = true;
    activeEventSource = null;
  }
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
  solveLoadMore.disabled = true;
  const batch = allResults.slice(displayedCount, displayedCount + 200);
  const redactionId = state.activeRedaction;
  for (const item of batch) {
    handleSolveEvent({
      status: "match",
      text: item.text,
      error_px: item.error,
      source: "",
    }, redactionId);
  }
  if (displayedCount >= totalFound) {
    solveLoadMore.hidden = true;
  } else {
    solveLoadMore.textContent = `Load more (showing ${displayedCount} of ${totalFound})`;
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
  const apiKey = await getSetting('anthropic_api_key');
  if (!apiKey) {
    solveStatus.textContent = "Set your Anthropic API key in settings first.";
    return;
  }

  const leftContext = validateLeft.value;
  const rightContext = validateRight.value;
  const candidateTexts = allResults.map(r => r.text);

  if (!candidateTexts.length) {
    solveStatus.textContent = "No candidates to validate.";
    return;
  }

  const redactionId = state.activeRedaction;
  validateRun.disabled = true;
  solveStatus.textContent = "Validating candidates with LLM...";

  try {
    const scores = await validateCandidates(leftContext, rightContext, candidateTexts, apiKey, (scored, total) => {
      solveStatus.textContent = `Scoring candidates... ${scored}/${total}`;
    });

    // Attach scores to results and sort descending
    const scored = allResults.map((r, i) => ({
      text: r.text,
      error_px: r.error,
      llm_score: scores[i],
      source: '',
    }));
    scored.sort((a, b) => b.llm_score - a.llm_score);

    // Clear existing results and re-render sorted by LLM score
    solveResults.innerHTML = '';
    displayedCount = 0;
    for (const item of scored) {
      renderScoredResult(item, redactionId);
    }

    solveStatus.textContent = `Validation complete. ${scored.length} candidates scored.`;
  } catch (err) {
    solveStatus.textContent = "Validation error: " + err.message;
  } finally {
    validateRun.disabled = false;
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
