// @ts-check
/** Associate matching — fuzzy name lookup against the Epstein associate database. */

import { state } from './state.js';
import { solveFilterPrefix, solveFilterSuffix, popoverEl, escapeHtml } from './dom.js';

const MATCH_TYPE_WEIGHTS = {
  full: 4,
  nickname_full: 3,
  initial_last: 2,
  last: 2,
  first: 1,
  nickname: 1,
};

/**
 * Match text against the associate database.
 * @param {string} text
 * @returns {Array<{personId: string, personName: string, category: string, tier: number, matchType: string, score: number}>}
 */
export function matchAssociates(text) {
  if (!state.associates?.names) return [];

  const prefix = solveFilterPrefix.value.toLowerCase().trim();
  const suffix = solveFilterSuffix.value.toLowerCase().trim();
  const gapKey = text.toLowerCase().trim();

  const keysToTry = new Set([gapKey]);
  if (prefix || suffix) keysToTry.add(prefix + gapKey + suffix);
  if (prefix) keysToTry.add(prefix + gapKey);
  if (suffix) keysToTry.add(gapKey + suffix);

  const bestByPerson = new Map();

  for (const key of keysToTry) {
    const entries = state.associates.names[key];
    if (!entries) continue;
    const isComposite = key !== gapKey;

    for (const m of entries) {
      const person = state.associates.persons[m.person_id];
      const weight = MATCH_TYPE_WEIGHTS[m.match_type] || 1;
      let score = (4 - m.tier) * weight;
      if (isComposite) score += 3;

      const existing = bestByPerson.get(m.person_id);
      if (!existing || score > existing.score) {
        bestByPerson.set(m.person_id, {
          personId: m.person_id,
          personName: person?.name || "Unknown",
          category: person?.category || "other",
          tier: m.tier,
          matchType: isComposite ? `${m.match_type} (${key})` : m.match_type,
          score,
        });
      }
    }
  }

  return [...bestByPerson.values()].sort((a, b) => b.score - a.score);
}

/**
 * @param {number} tier
 * @returns {string}
 */
export function tierBadgeClass(tier) {
  if (tier === 1) return "tier-1";
  if (tier === 2) return "tier-2";
  return "tier-3";
}

/**
 * @param {number} tier
 * @returns {string}
 */
export function tierLabel(tier) {
  if (tier === 1) return "T1";
  if (tier === 2) return "T2";
  return "T3";
}

/**
 * @param {number} tier
 * @returns {string}
 */
export function tierDescription(tier) {
  if (tier === 1) return "Flight logs -- traveled with Epstein";
  if (tier === 2) return "Inner circle -- staff, financial, or frequently named";
  return "Named in Epstein case files";
}

/**
 * Check if text matches a known victim name.
 * @param {string} text
 * @returns {boolean}
 */
export function isVictimMatch(text) {
  const vs = state.associates?.victim_set;
  if (!vs || vs.size === 0) return false;
  const key = text.toLowerCase().trim();
  if (vs.has(key)) return true;
  const prefix = solveFilterPrefix.value.toLowerCase().trim();
  const suffix = solveFilterSuffix.value.toLowerCase().trim();
  if (prefix || suffix) {
    if (vs.has(prefix + key + suffix)) return true;
    if (prefix && vs.has(prefix + key)) return true;
    if (suffix && vs.has(key + suffix)) return true;
  }
  return false;
}

/**
 * Show a detail popup for associate matches.
 * @param {Array<{personName: string, tier: number, category: string, matchType: string}>} assocMatches
 * @param {HTMLElement} _anchorEl
 */
export function showAssocDetail(assocMatches, _anchorEl) {
  const old = document.getElementById("assoc-detail");
  if (old) old.remove();

  const popup = document.createElement("div");
  popup.id = "assoc-detail";

  let html = '<div class="assoc-detail-header">Possible associates<button class="assoc-detail-close">X</button></div>';
  html += '<div class="assoc-detail-list">';

  for (const m of assocMatches) {
    const cls = tierBadgeClass(m.tier);
    html += `<div class="assoc-detail-item">
      <span class="assoc-badge ${cls}">${tierLabel(m.tier)}</span>
      <div class="assoc-detail-info">
        <div class="assoc-detail-name">${escapeHtml(m.personName)}</div>
        <div class="assoc-detail-meta">${escapeHtml(tierDescription(m.tier))} · ${escapeHtml(m.category)} · matched on ${escapeHtml(m.matchType)}</div>
      </div>
    </div>`;
  }

  html += '</div>';
  popup.innerHTML = html;

  popoverEl.appendChild(popup);

  popup.querySelector(".assoc-detail-close").addEventListener("click", (e) => {
    e.stopPropagation();
    popup.remove();
  });

  const closeOnOutside = (e) => {
    if (!popup.contains(/** @type {Node} */ (e.target))) {
      popup.remove();
      document.removeEventListener("click", closeOnOutside, true);
    }
  };
  setTimeout(() => document.addEventListener("click", closeOnOutside, true), 0);
}
