// @ts-check
/** Entry point — upload, page navigation, redaction management, and event wiring. */

import { state } from './state.js';
import {
  dropZone, fileInput, uploadSection, viewerSection, docImage,
  canvas, pageInfo, prevBtn, nextBtn, redactionListEl,
  rightPanel, popoverEl, fontToolbar, textEditBar, fontSelect,
  solveAccept, gapValue, showToast,
} from './dom.js';
import { renderCanvas } from './canvas.js';
import { applyTransform, screenToDoc, hitTestRedaction, initViewport } from './viewport.js';
import { openPopover, closePopover, setOnPopoverClose, updatePosDisplay, initPopover } from './popover.js';
import { stopSolve, acceptSolution, initSolver } from './solver.js';

// ── Font loading ──

async function loadFonts() {
  const resp = await fetch("/api/fonts");
  const data = await resp.json();
  state.fonts = data.fonts;

  const promises = state.fonts
    .filter((f) => f.available)
    .map(async (f) => {
      const face = new FontFace(f.name, `url(/api/font/${f.id})`);
      try {
        const loaded = await face.load();
        document.fonts.add(loaded);
      } catch (e) {
        console.warn(`Failed to load font ${f.name}:`, e);
      }
    });

  await Promise.all(promises);
  state.fontsReady = true;

  fontSelect.innerHTML = "";
  for (const f of state.fonts.filter(f => f.available)) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.name;
    fontSelect.appendChild(opt);
  }
}

async function loadAssociates() {
  try {
    const resp = await fetch("/api/associates");
    state.associates = await resp.json();
    state.associates.victim_set = new Set(state.associates.victim_names || []);
    console.log(`Loaded ${Object.keys(state.associates.names).length} associate lookups, ${state.associates.victim_set.size} victim names`);
  } catch (e) {
    console.warn("Failed to load associates data:", e);
    state.associates = { names: {}, persons: {}, victim_set: new Set() };
  }
}

// ── Upload & drag-drop ──

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) uploadFile(fileInput.files[0]);
});

async function uploadFile(file) {
  uploadSection.innerHTML = '<p class="loading">Analyzing document...</p>';

  const fontPromise = loadFonts();
  const assocPromise = loadAssociates();

  const form = new FormData();
  form.append("file", file);
  const resp = await fetch("/api/upload", { method: "POST", body: form });
  const data = await resp.json();

  state.docId = data.doc_id;
  state.pageCount = data.page_count;
  state.currentPage = 1;

  await Promise.all([fontPromise, assocPromise]);

  uploadSection.hidden = true;
  viewerSection.hidden = false;

  await loadPage(1);
}

// ── Page loading ──

async function loadPage(page) {
  state.currentPage = page;
  state.activeRedaction = null;
  closePopover();
  updatePageControls();

  docImage.src = `/api/doc/${state.docId}/page/${page}/original`;

  const resp = await fetch(`/api/doc/${state.docId}/page/${page}/data`);
  const data = await resp.json();

  for (const r of data.redactions) {
    if (!state.redactions[r.id]) {
      state.redactions[r.id] = {
        id: r.id,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        page: page,
        status: "unanalyzed",
        analysis: null,
        solution: null,
        preview: null,
      };
    }
  }

  renderRedactionList();
  renderCanvas();
}

function updatePageControls() {
  pageInfo.textContent = `Page ${state.currentPage} / ${state.pageCount}`;
  prevBtn.disabled = state.currentPage <= 1;
  nextBtn.disabled = state.currentPage >= state.pageCount;
}

prevBtn.addEventListener("click", () => {
  if (state.currentPage > 1) loadPage(state.currentPage - 1);
});
nextBtn.addEventListener("click", () => {
  if (state.currentPage < state.pageCount) loadPage(state.currentPage + 1);
});

// ── Redaction list (left panel) ──

function renderRedactionList() {
  const redactions = Object.values(state.redactions)
    .filter((r) => r.page === state.currentPage)
    .sort((a, b) => {
      if (Math.abs(a.y - b.y) > 5) return a.y - b.y;
      return a.x - b.x;
    });
  redactionListEl.innerHTML = "";

  redactions.forEach((r, idx) => {
    const div = document.createElement("div");
    div.className = "redaction-item";
    if (r.id === state.activeRedaction) div.classList.add("active");
    div.dataset.id = r.id;

    const numEl = document.createElement("span");
    numEl.className = "redaction-num";
    numEl.textContent = `#${idx + 1}`;

    const statusEl = document.createElement("span");
    statusEl.className = `redaction-status status-${r.status}`;
    statusEl.textContent = statusLabel(r.status);

    const infoEl = document.createElement("div");
    infoEl.className = "redaction-info";
    infoEl.textContent = redactionInfoText(r);

    const headerRow = document.createElement("div");
    headerRow.className = "redaction-header-row";
    headerRow.appendChild(numEl);
    headerRow.appendChild(statusEl);

    div.appendChild(headerRow);
    div.appendChild(infoEl);

    div.addEventListener("click", () => activateRedaction(r.id));
    redactionListEl.appendChild(div);
  });
}

function statusLabel(status) {
  switch (status) {
    case "unanalyzed": return "unanalyzed";
    case "analyzing": return "analyzing...";
    case "analyzed": return "analyzed";
    case "solved": return "solved";
    case "error": return "error";
    default: return status;
  }
}

function redactionInfoText(r) {
  if (r.status === "solved" && r.solution) {
    return r.solution.text;
  }
  if ((r.status === "analyzed" || r.status === "solved") && r.analysis) {
    const segs = r.analysis.segments;
    const left = segs.length > 0 ? segs[0].text : "";
    const right = segs.length > 1 ? segs[1].text : "";
    const leftTail = left.length > 15 ? "..." + left.slice(-15) : left;
    const rightHead = right.length > 15 ? right.slice(0, 15) + "..." : right;
    return `${leftTail} [___] ${rightHead}`;
  }
  return `${Math.round(r.w)} x ${Math.round(r.h)} px`;
}

// ── Activate & analyze redaction ──

function activateRedaction(id) {
  const r = state.redactions[id];
  if (!r) return;

  state.activeRedaction = id;

  state.panX = r.x + r.w / 2;
  state.panY = r.y + r.h / 2;
  applyTransform(true);

  renderRedactionList();
  renderCanvas();

  if (r.status === "unanalyzed") {
    analyzeRedaction(id);
  } else if (r.status === "analyzed" || r.status === "solved") {
    openPopover(id);
  }
}

async function analyzeRedaction(id) {
  const r = state.redactions[id];
  if (!r) return;

  r.status = "analyzing";
  renderRedactionList();

  try {
    const resp = await fetch("/api/redaction/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        doc_id: state.docId,
        page: r.page,
        redaction: { x: r.x, y: r.y, w: r.w, h: r.h },
      }),
    });

    if (!resp.ok) {
      const err = await resp.json();
      r.status = "error";
      console.error("Analysis failed:", err);
      renderRedactionList();
      return;
    }

    const data = await resp.json();
    r.status = "analyzed";
    r.analysis = data;
    r.overrides = {
      fontId: data.font.id,
      fontSize: data.font.size,
      offsetX: data.offset_x || 0,
      offsetY: data.offset_y || 0,
      gapWidth: data.gap.w,
      leftText: data.segments.length > 0 ? data.segments[0].text : "",
      rightText: data.segments.length > 1 ? data.segments[1].text : "",
    };
    renderRedactionList();
    renderCanvas();

    if (state.activeRedaction === id) {
      openPopover(id);
    }
  } catch (e) {
    r.status = "error";
    console.error("Analysis error:", e);
    renderRedactionList();
  }
}

// ── Canvas hit-testing ──

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;

  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const doc = screenToDoc(sx, sy);

  const hit = hitTestRedaction(doc.x, doc.y);
  if (hit) {
    e.stopPropagation();
    activateRedaction(hit.id);
  }
});

canvas.addEventListener("mousemove", (e) => {
  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const doc = screenToDoc(sx, sy);

  const hit = hitTestRedaction(doc.x, doc.y);
  canvas.style.cursor = hit ? "pointer" : "";
});

// ── Double-click spot detection ──

rightPanel.addEventListener("dblclick", async (e) => {
  if (popoverEl.contains(/** @type {Node} */ (e.target)) ||
      fontToolbar.contains(/** @type {Node} */ (e.target)) ||
      textEditBar.contains(/** @type {Node} */ (e.target))) return;
  if (!state.docId) return;

  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const doc = screenToDoc(sx, sy);

  const hit = hitTestRedaction(doc.x, doc.y);
  if (hit) return;

  const clickX = Math.round(doc.x);
  const clickY = Math.round(doc.y);

  showToast("Detecting redaction...");

  try {
    const resp = await fetch("/api/redaction/spot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        doc_id: state.docId,
        page: state.currentPage,
        click_x: clickX,
        click_y: clickY,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json();
      showToast(err.error === "no_redaction_found" ? "No redaction found at click point" : "Detection failed", "error");
      return;
    }

    const data = await resp.json();
    const box = data.box;

    const existingDup = Object.values(state.redactions).find(r =>
      r.page === state.currentPage &&
      Math.abs(r.x - box.x) < 3 && Math.abs(r.y - box.y) < 3 &&
      Math.abs(r.w - box.w) < 3 && Math.abs(r.h - box.h) < 3
    );
    if (existingDup) {
      activateRedaction(existingDup.id);
      return;
    }

    const id = "m" + Date.now().toString(36);

    state.redactions[id] = {
      id,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      page: state.currentPage,
      status: data.segments ? "analyzed" : "unanalyzed",
      analysis: data.segments ? data : null,
      solution: null,
      preview: null,
    };

    if (data.segments) {
      state.redactions[id].overrides = {
        fontId: data.font.id,
        fontSize: data.font.size,
        offsetX: data.offset_x || 0,
        offsetY: data.offset_y || 0,
        gapWidth: data.gap.w,
        leftText: data.segments.length > 0 ? data.segments[0].text : "",
        rightText: data.segments.length > 1 ? data.segments[1].text : "",
      };
    }

    renderRedactionList();
    renderCanvas();
    activateRedaction(id);
  } catch (e) {
    console.error("Spot detection error:", e);
    showToast("Detection failed: " + e.message, "error");
  }
});

// ── Ctrl+drag offset / Shift+drag gap width ──

let modDrag = null;

canvas.addEventListener("mousedown", (e) => {
  if ((!e.ctrlKey && !e.shiftKey) || e.button !== 0) return;
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;

  modDrag = {
    startX: e.clientX,
    startY: e.clientY,
    startOffsetX: r.overrides.offsetX,
    startOffsetY: r.overrides.offsetY,
    startGapWidth: r.overrides.gapWidth,
    widthMode: e.shiftKey && !e.ctrlKey,
  };
  e.stopPropagation();
  e.preventDefault();
}, { capture: true });

window.addEventListener("mousemove", (e) => {
  if (!modDrag) return;
  const r = state.redactions[state.activeRedaction];
  if (!r?.overrides) return;

  const dx = (e.clientX - modDrag.startX) / state.zoom;
  const dy = (e.clientY - modDrag.startY) / state.zoom;

  if (modDrag.widthMode) {
    r.overrides.gapWidth = Math.max(1, modDrag.startGapWidth + dx);
    gapValue.textContent = String(Math.round(r.overrides.gapWidth));
  } else {
    r.overrides.offsetX = modDrag.startOffsetX + dx;
    r.overrides.offsetY = modDrag.startOffsetY + dy;
    updatePosDisplay();
  }
  renderCanvas();
});

window.addEventListener("mouseup", () => {
  if (modDrag) modDrag = null;
});

// ── Accept solution (wired here to avoid circular dep solver↔main) ──

solveAccept.addEventListener("click", () => {
  acceptSolution();
  closePopover();
  renderRedactionList();
  renderCanvas();
});

// ── Initialize all modules ──

setOnPopoverClose(stopSolve);
initViewport();
initPopover();
initSolver();
