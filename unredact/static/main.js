// @ts-check
/** Entry point — upload, page navigation, redaction management, and event wiring. */

import { state } from './state.js';
import {
  dropZone, fileInput, uploadSection, viewerSection, docImage,
  canvas, pageInfo, prevBtn, nextBtn, redactionListEl, detectBtn,
  rightPanel, bottomSheet, sheetTabs, tabSolve, tabEdit, tabList, fontSelect,
  solveAccept, gapValue, showToast,
} from './dom.js';
import { renderCanvas } from './canvas.js';
import { applyTransform, screenToDoc, hitTestRedaction, initViewport } from './viewport.js';
import { openPopover, closePopover, setOnPopoverClose, updatePosDisplay, initPopover } from './popover.js';
import { stopSolve, acceptSolution, initSolver } from './solver.js';


// ── Sheet snap management ──

const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

const SNAP_PEEK = 60;
const SNAP_HALF_RATIO = 0.45;
const SNAP_FULL_RATIO = 0.9;

/** @type {'peek'|'half'|'full'} */
let sheetSnap = 'peek';

function getSnapHeight(snap) {
  const vh = window.innerHeight;
  switch (snap) {
    case 'peek': return SNAP_PEEK;
    case 'half': return Math.round(vh * SNAP_HALF_RATIO);
    case 'full': return Math.round(vh * SNAP_FULL_RATIO);
    default: return SNAP_PEEK;
  }
}

function setSheetSnap(snap) {
  sheetSnap = snap;
  const h = getSnapHeight(snap);
  document.documentElement.style.setProperty('--sheet-height', h + 'px');
  bottomSheet.style.height = h + 'px';
}

function initSheetDrag() {
  const handle = document.getElementById('sheet-handle');
  if (!handle) return;

  let dragState = null;

  handle.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    dragState = {
      startY: e.touches[0].clientY,
      startHeight: bottomSheet.offsetHeight,
    };
    bottomSheet.style.transition = 'none';
  }, { passive: true });

  handle.addEventListener('touchmove', (e) => {
    if (!dragState) return;
    e.preventDefault();
    const dy = dragState.startY - e.touches[0].clientY;
    const newH = Math.max(SNAP_PEEK, Math.min(
      getSnapHeight('full'),
      dragState.startHeight + dy
    ));
    bottomSheet.style.height = newH + 'px';
    document.documentElement.style.setProperty('--sheet-height', newH + 'px');
  }, { passive: false });

  const endDrag = () => {
    if (!dragState) return;
    bottomSheet.style.transition = '';
    const currentH = bottomSheet.offsetHeight;

    // Find nearest snap point
    const peekH = getSnapHeight('peek');
    const halfH = getSnapHeight('half');
    const fullH = getSnapHeight('full');

    const peekDist = Math.abs(currentH - peekH);
    const halfDist = Math.abs(currentH - halfH);
    const fullDist = Math.abs(currentH - fullH);

    if (peekDist <= halfDist && peekDist <= fullDist) setSheetSnap('peek');
    else if (halfDist <= fullDist) setSheetSnap('half');
    else setSheetSnap('full');

    dragState = null;
  };

  handle.addEventListener('touchend', endDrag);
  handle.addEventListener('touchcancel', endDrag);
}

// ── Mobile layout: move controls into sheet tabs ──

let elementsInSheet = false;

function moveElementsToSheet() {
  if (elementsInSheet) return;
  const popover = document.getElementById('popover');
  const fontToolbar = document.getElementById('font-toolbar');
  const textEditBar = document.getElementById('text-edit-bar');

  tabSolve.appendChild(popover);
  tabEdit.appendChild(fontToolbar);
  tabEdit.appendChild(textEditBar);
  elementsInSheet = true;
}

function moveElementsToPanel() {
  if (!elementsInSheet) return;
  const popover = document.getElementById('popover');
  const fontToolbar = document.getElementById('font-toolbar');
  const textEditBar = document.getElementById('text-edit-bar');

  rightPanel.insertBefore(fontToolbar, rightPanel.querySelector('#doc-container'));
  rightPanel.insertBefore(popover, rightPanel.querySelector('#doc-container'));
  rightPanel.appendChild(textEditBar);
  elementsInSheet = false;
}

// ── Sheet tab switching ──

function switchSheetTab(tab) {
  sheetTabs.querySelectorAll('.sheet-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('#sheet-content .tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === 'tab-' + tab);
  });
}

function initSheetTabs() {
  sheetTabs.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('.sheet-tab');
    if (btn?.dataset.tab) switchSheetTab(btn.dataset.tab);
  });
}

// ── Responsive layout management ──

function handleLayoutChange() {
  if (isMobile()) {
    moveElementsToSheet();
    setSheetSnap(sheetSnap);
  } else {
    moveElementsToPanel();
    document.documentElement.style.removeProperty('--sheet-height');
    bottomSheet.style.height = '';
  }
}

window.matchMedia('(max-width: 768px)').addEventListener('change', handleLayoutChange);


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
  uploadSection.innerHTML = '<p class="loading">Uploading document...</p>';

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

  // Load the first page image and controls immediately
  await loadPage(1);

  // Start background OCR via SSE
  startOcrSSE();
}

/**
 * Open an SSE connection to the analyze endpoint. As each page completes,
 * reload its redaction data (which now includes pre-computed analysis).
 */
function startAnalysisSSE() {
  const es = new EventSource(`/api/doc/${state.docId}/analyze`);
  showToast("Analyzing document...");

  es.addEventListener("message", (e) => {
    /** @type {any} */
    const data = JSON.parse(e.data);

    if (data.event === "page_complete") {
      // Reload the page data to pick up pre-computed analysis
      loadPageData(data.page);
    } else if (data.event === "error") {
      showToast(`Page ${data.page}: ${data.message}`, "error");
    } else if (data.event === "done") {
      es.close();
      showToast("Analysis complete");
      if (detectBtn) {
        detectBtn.disabled = false;
        detectBtn.textContent = "Detect Redactions";
      }
    }
  });

  es.addEventListener("error", () => {
    es.close();
    showToast("Analysis connection lost", "error");
    if (detectBtn) {
      detectBtn.disabled = false;
      detectBtn.textContent = "Detect Redactions";
    }
  });
}

function startOcrSSE() {
  const es = new EventSource(`/api/doc/${state.docId}/ocr`);
  showToast("Running OCR...", "info");

  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.event === "page_ocr_complete") {
      const statusEl = document.getElementById("ocr-status");
      if (statusEl) statusEl.textContent = `OCR: page ${data.page} done`;
    } else if (data.event === "ocr_complete") {
      es.close();
      state.ocrReady = true;
      const statusEl = document.getElementById("ocr-status");
      if (statusEl) statusEl.textContent = "OCR complete";
      showToast("OCR complete — ready to detect redactions", "success");
      if (detectBtn) detectBtn.disabled = false;
    } else if (data.event === "error") {
      showToast(`OCR error on page ${data.page}: ${data.message}`, "error");
    }
  };
  es.onerror = () => {
    es.close();
    showToast("OCR connection lost", "error");
  };
}

if (detectBtn) {
  detectBtn.addEventListener("click", () => {
    detectBtn.disabled = true;
    detectBtn.textContent = "Detecting...";
    startAnalysisSSE();
  });
}

// ── Page loading ──

async function loadPage(page) {
  state.currentPage = page;
  state.activeRedaction = null;
  closePopover();
  updatePageControls();

  docImage.src = `/api/doc/${state.docId}/page/${page}/original`;

  await loadPageData(page);
}

/**
 * Fetch page data and populate redaction state. Called both on page
 * navigation and when SSE signals a page analysis is complete.
 * @param {number} pageNum
 */
async function loadPageData(pageNum) {
  const resp = await fetch(`/api/doc/${state.docId}/page/${pageNum}/data`);
  const data = await resp.json();

  for (const r of data.redactions) {
    // Preserve existing solution/preview if the redaction was already loaded
    const existing = state.redactions[r.id];

    state.redactions[r.id] = {
      id: r.id,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      page: pageNum,
      status: r.analysis ? "analyzed" : "unanalyzed",
      analysis: r.analysis || null,
      solution: existing?.solution || null,
      preview: existing?.preview || null,
    };

    if (r.analysis) {
      state.redactions[r.id].overrides = existing?.overrides || {
        fontId: r.analysis.font.id,
        fontSize: r.analysis.font.size,
        offsetX: r.analysis.offset_x || 0,
        offsetY: r.analysis.offset_y || 0,
        gapWidth: r.analysis.gap.w,
        leftText: r.analysis.segments[0]?.text || "",
        rightText: r.analysis.segments[1]?.text || "",
      };
    }
  }

  // Only re-render if this is the currently viewed page
  if (pageNum === state.currentPage) {
    renderRedactionList();
    renderCanvas();
  }
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

// ── Redaction list ──

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

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "redaction-delete";
    deleteBtn.textContent = "\u00d7";
    deleteBtn.title = "Delete redaction";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteRedaction(r.id);
    });

    const headerRow = document.createElement("div");
    headerRow.className = "redaction-header-row";
    headerRow.appendChild(numEl);
    headerRow.appendChild(statusEl);
    headerRow.appendChild(deleteBtn);

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
    case "approved": return "approved";
    case "error": return "error";
    default: return status;
  }
}

function redactionInfoText(r) {
  if (r.status === "approved" && r.approvedText) {
    return r.approvedText.length > 30
      ? r.approvedText.slice(0, 30) + "..."
      : r.approvedText;
  }
  if (r.status === "analyzed" && r.analysis) {
    const segs = r.analysis.segments;
    const left = segs.length > 0 ? segs[0].text : "";
    const right = segs.length > 1 ? segs[1].text : "";
    const leftTail = left.length > 15 ? "..." + left.slice(-15) : left;
    const rightHead = right.length > 15 ? right.slice(0, 15) + "..." : right;
    return `${leftTail} [___] ${rightHead}`;
  }
  return `${Math.round(r.w)} x ${Math.round(r.h)} px`;
}

// ── Activate redaction ──

function activateRedaction(id) {
  const r = state.redactions[id];
  if (!r) return;

  state.activeRedaction = id;

  state.panX = r.x + r.w / 2;
  state.panY = r.y + r.h / 2;
  applyTransform(true);

  renderRedactionList();
  renderCanvas();

  if (r.status === "analyzed" || r.status === "approved") {
    openPopover(id);
    if (isMobile()) {
      switchSheetTab('solve');
      setSheetSnap('half');
    }
  }
}

function deleteRedaction(id) {
  if (state.activeRedaction === id) {
    closePopover();
    state.activeRedaction = null;
  }
  delete state.redactions[id];
  renderRedactionList();
  renderCanvas();
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

canvas.addEventListener("dblclick", async (e) => {
  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const doc = screenToDoc(sx, sy);

  const resp = await fetch(`/api/doc/${state.docId}/page/${state.currentPage}/spot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: Math.round(doc.x), y: Math.round(doc.y) }),
  });
  if (!resp.ok) {
    showToast("No redaction found at that spot", "error");
    return;
  }
  const r = await resp.json();

  if (!r.analysis) {
    showToast(state.ocrReady
      ? "No text found near this redaction"
      : "OCR still processing — redaction added without analysis",
      "info");
  }

  const redaction = {
    id: r.id, x: r.x, y: r.y, w: r.w, h: r.h,
    page: state.currentPage,
    status: r.analysis ? "analyzed" : "unanalyzed",
    analysis: r.analysis || null,
    solution: null,
    preview: null,
  };

  if (r.analysis) {
    redaction.overrides = {
      fontId: r.analysis.font.id,
      fontSize: r.analysis.font.size,
      offsetX: r.analysis.offset_x || 0,
      offsetY: r.analysis.offset_y || 0,
      gapWidth: r.analysis.gap.w,
      leftText: r.analysis.segments[0]?.text || "",
      rightText: r.analysis.segments[1]?.text || "",
    };
  }

  state.redactions[r.id] = redaction;
  renderRedactionList();
  renderCanvas();
  activateRedaction(r.id);
});

canvas.addEventListener("mousemove", (e) => {
  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const doc = screenToDoc(sx, sy);

  const hit = hitTestRedaction(doc.x, doc.y);
  canvas.style.cursor = hit ? "pointer" : "";
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

// ── Drag handles for resizing redaction bounding boxes ──

let resizeDrag = null;

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.ctrlKey || e.shiftKey) return;
  const r = state.redactions[state.activeRedaction];
  if (!r) return;

  const rect = rightPanel.getBoundingClientRect();
  const doc = screenToDoc(e.clientX - rect.left, e.clientY - rect.top);
  const threshold = 8 / state.zoom;

  // Check if near an edge handle
  let edge = null;
  if (Math.abs(doc.x - r.x) < threshold && Math.abs(doc.y - (r.y + r.h/2)) < threshold) edge = "left";
  else if (Math.abs(doc.x - (r.x + r.w)) < threshold && Math.abs(doc.y - (r.y + r.h/2)) < threshold) edge = "right";
  else if (Math.abs(doc.y - r.y) < threshold && Math.abs(doc.x - (r.x + r.w/2)) < threshold) edge = "top";
  else if (Math.abs(doc.y - (r.y + r.h)) < threshold && Math.abs(doc.x - (r.x + r.w/2)) < threshold) edge = "bottom";

  if (!edge) return;

  resizeDrag = {
    edge,
    startX: e.clientX,
    startY: e.clientY,
    origX: r.x,
    origY: r.y,
    origW: r.w,
    origH: r.h,
  };
  e.stopPropagation();
  e.preventDefault();
}, { capture: true });

window.addEventListener("mousemove", (e) => {
  if (!resizeDrag) return;
  const r = state.redactions[state.activeRedaction];
  if (!r) return;

  const dx = (e.clientX - resizeDrag.startX) / state.zoom;
  const dy = (e.clientY - resizeDrag.startY) / state.zoom;

  if (resizeDrag.edge === "left") {
    r.x = Math.round(resizeDrag.origX + dx);
    r.w = Math.max(10, Math.round(resizeDrag.origW - dx));
  } else if (resizeDrag.edge === "right") {
    r.w = Math.max(10, Math.round(resizeDrag.origW + dx));
  } else if (resizeDrag.edge === "top") {
    r.y = Math.round(resizeDrag.origY + dy);
    r.h = Math.max(10, Math.round(resizeDrag.origH - dy));
  } else if (resizeDrag.edge === "bottom") {
    r.h = Math.max(10, Math.round(resizeDrag.origH + dy));
  }

  // Update gap width in overrides to match box width changes
  if (r.overrides && (resizeDrag.edge === "left" || resizeDrag.edge === "right")) {
    r.overrides.gapWidth = r.w;
    gapValue.textContent = String(Math.round(r.w));
  }

  renderCanvas();
});

window.addEventListener("mouseup", () => {
  if (resizeDrag) resizeDrag = null;
});

// ── Accept solution (wired here to avoid circular dep solver↔main) ──

solveAccept.addEventListener("click", () => {
  acceptSolution();
  closePopover();
  renderRedactionList();
  renderCanvas();
});

// ── Export annotations (Ctrl+E) ──

function exportAnnotations() {
  const pages = {};
  for (const r of Object.values(state.redactions)) {
    if (!pages[r.page]) pages[r.page] = [];
    const entry = {
      id: r.id,
      x: r.x, y: r.y, w: r.w, h: r.h,
      status: r.status,
    };
    if (r.overrides) {
      entry.overrides = { ...r.overrides };
    }
    if (r.analysis) {
      entry.analysis = {
        font: r.analysis.font,
        gap: r.analysis.gap,
        line: r.analysis.line,
        segments: r.analysis.segments,
        offset_x: r.analysis.offset_x,
        offset_y: r.analysis.offset_y,
      };
    }
    if (r.solution) {
      entry.solution = r.solution;
    }
    if (r.approvedText) {
      entry.approvedText = r.approvedText;
    }
    pages[r.page].push(entry);
  }
  // Sort each page's redactions top-to-bottom, left-to-right
  for (const p of Object.values(pages)) {
    p.sort((a, b) => Math.abs(a.y - b.y) > 5 ? a.y - b.y : a.x - b.x);
  }
  const data = { docId: state.docId, pageCount: state.pageCount, pages };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `annotations-${state.docId}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Exported annotations");
}

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "e") {
    e.preventDefault();
    exportAnnotations();
  }
});

// ── Initialize all modules ──

setOnPopoverClose(() => {
  stopSolve();
  if (isMobile()) {
    switchSheetTab('list');
    setSheetSnap('peek');
  }
});
initViewport();
initPopover();
initSolver();

// ── Initialize sheet and tabs ──
initSheetTabs();
initSheetDrag();
handleLayoutChange();
