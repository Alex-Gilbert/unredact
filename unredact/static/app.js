// ── DOM elements ──

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const uploadSection = document.getElementById("upload-section");
const viewerSection = document.getElementById("viewer-section");
const docImage = document.getElementById("doc-image");
const canvas = document.getElementById("overlay-canvas");
const ctx = canvas.getContext("2d");
const pageInfo = document.getElementById("page-info");
const prevBtn = document.getElementById("prev-page");
const nextBtn = document.getElementById("next-page");
const redactionList = document.getElementById("redaction-list");
const zoomInBtn = document.getElementById("zoom-in");
const zoomOutBtn = document.getElementById("zoom-out");
const zoomFitBtn = document.getElementById("zoom-fit");
const zoomLevel = document.getElementById("zoom-level");
const rightPanel = document.getElementById("right-panel");
const docContainer = document.getElementById("doc-container");
const popover = document.getElementById("popover");
const popoverClose = document.getElementById("popover-close");
const popoverContext = document.getElementById("popover-context");
const popoverFontInfo = document.getElementById("popover-font-info");
const solveCharset = document.getElementById("solve-charset");
const solveTolerance = document.getElementById("solve-tolerance");
const solveTolValue = document.getElementById("solve-tol-value");
const solveMode = document.getElementById("solve-mode");
const solveFilter = document.getElementById("solve-filter");
const solveFilterPrefix = document.getElementById("solve-filter-prefix");
const solveFilterSuffix = document.getElementById("solve-filter-suffix");
const solveStart = document.getElementById("solve-start");
const solveStop = document.getElementById("solve-stop");
const solveAccept = document.getElementById("solve-accept");
const solveStatus = document.getElementById("solve-status");
const solveResults = document.getElementById("solve-results");

// ── State ──

const state = {
  docId: null,
  pageCount: 0,
  currentPage: 1,
  redactions: {},        // id -> {id, x, y, w, h, page, status, analysis, solution, preview}
  activeRedaction: null,  // id of currently active redaction
  fonts: [],
  fontsReady: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  associates: null,
};

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

// ── Drag and drop ──

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

// ── Upload ──

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

  // Load the original page image
  docImage.src = `/api/doc/${state.docId}/page/${page}/original`;

  // Load page redaction data
  const resp = await fetch(`/api/doc/${state.docId}/page/${page}/data`);
  const data = await resp.json();

  // Clear redactions for other pages, populate for this page
  // (keep solved redactions from other pages in state if desired,
  //  but for simplicity we track per-page)
  for (const key of Object.keys(state.redactions)) {
    if (state.redactions[key].page !== page) continue;
    // Already have this page's redactions; skip re-init if revisiting
  }

  // Initialize redactions for this page (only if not already present)
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

function getPageRedactions() {
  return Object.values(state.redactions)
    .filter((r) => r.page === state.currentPage)
    .sort((a, b) => {
      // Sort top-to-bottom, then left-to-right
      if (Math.abs(a.y - b.y) > 5) return a.y - b.y;
      return a.x - b.x;
    });
}

function renderRedactionList() {
  const redactions = getPageRedactions();
  redactionList.innerHTML = "";

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
    redactionList.appendChild(div);
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

// ── Activate redaction ──

function activateRedaction(id) {
  const r = state.redactions[id];
  if (!r) return;

  state.activeRedaction = id;

  // Pan to center on the redaction
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

// ── Analyze redaction ──

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
    renderRedactionList();
    renderCanvas();

    // Only open popover if this is still the active redaction
    if (state.activeRedaction === id) {
      openPopover(id);
    }
  } catch (e) {
    r.status = "error";
    console.error("Analysis error:", e);
    renderRedactionList();
  }
}

// ── Popover ──

function openPopover(id) {
  const r = state.redactions[id];
  if (!r || !r.analysis) return;

  const a = r.analysis;

  // Context line
  const segs = a.segments;
  const leftText = segs.length > 0 ? segs[0].text : "";
  const rightText = segs.length > 1 ? segs[1].text : "";
  popoverContext.innerHTML = `<span class="ctx-left">${escapeHtml(leftText)}</span><span class="ctx-gap">\u2588\u2588\u2588</span><span class="ctx-right">${escapeHtml(rightText)}</span>`;

  // Font info
  const font = a.font;
  popoverFontInfo.innerHTML = `
    <span>${escapeHtml(font.name)} ${font.size}px</span>
    <span class="font-score">score: ${font.score.toFixed(1)}</span>
    <span class="gap-width">gap: ${Math.round(a.gap.w)}px</span>
  `;

  // Pre-fill prefix/suffix from context
  solveFilterPrefix.value = "";
  solveFilterSuffix.value = "";

  // Reset solver state
  solveResults.innerHTML = "";
  solveStatus.textContent = "";
  solveStart.hidden = false;
  solveStop.hidden = true;
  solveAccept.hidden = !!(r.preview === null);

  popover.hidden = false;
}

function closePopover() {
  popover.hidden = true;
  stopSolve();
}

popoverClose.addEventListener("click", closePopover);

solveTolerance.addEventListener("input", () => {
  solveTolValue.textContent = solveTolerance.value;
});

// ── Canvas rendering ──

function clearCanvas() {
  canvas.width = 0;
  canvas.height = 0;
}

function renderCanvas() {
  if (!docImage.naturalWidth || !state.fontsReady) return;

  const redactions = getPageRedactions();

  canvas.width = docImage.naturalWidth;
  canvas.height = docImage.naturalHeight;
  canvas.style.width = docImage.naturalWidth + "px";
  canvas.style.height = docImage.naturalHeight + "px";

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const r of redactions) {
    const isActive = r.id === state.activeRedaction;

    if (r.status === "solved" && r.solution) {
      // Green solution text
      drawRedactionSolution(r, isActive);
    } else if (r.preview) {
      // Yellow preview text
      drawRedactionPreview(r, isActive);
    } else if (r.status === "analyzed" && r.analysis) {
      // Blue overlay with analysis context
      drawRedactionAnalyzed(r, isActive);
    } else {
      // Default: semi-transparent blue overlay
      drawRedactionUnanalyzed(r, isActive);
    }
  }
}

function drawRedactionUnanalyzed(r, isActive) {
  const alpha = isActive ? 0.4 : 0.25;
  const borderAlpha = isActive ? 0.9 : 0.5;

  ctx.fillStyle = `rgba(66, 133, 244, ${alpha})`;
  ctx.fillRect(r.x, r.y, r.w, r.h);

  ctx.strokeStyle = `rgba(66, 133, 244, ${borderAlpha})`;
  ctx.lineWidth = isActive ? 2.5 : 1.5;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
}

function drawRedactionAnalyzed(r, isActive) {
  const alpha = isActive ? 0.35 : 0.2;
  const borderAlpha = isActive ? 0.9 : 0.5;

  ctx.fillStyle = `rgba(66, 133, 244, ${alpha})`;
  ctx.fillRect(r.x, r.y, r.w, r.h);

  ctx.strokeStyle = `rgba(66, 133, 244, ${borderAlpha})`;
  ctx.lineWidth = isActive ? 2.5 : 1.5;
  ctx.strokeRect(r.x, r.y, r.w, r.h);

  // Draw a small "?" label centered in the redaction
  const labelSize = Math.min(r.h * 0.5, 18);
  ctx.fillStyle = `rgba(255, 255, 255, ${isActive ? 0.8 : 0.5})`;
  ctx.font = `bold ${labelSize}px sans-serif`;
  ctx.textBaseline = "middle";
  const label = "?";
  const lw = ctx.measureText(label).width;
  ctx.fillText(label, r.x + (r.w - lw) / 2, r.y + r.h / 2);
}

function drawRedactionPreview(r, isActive) {
  if (!r.analysis) return;
  const a = r.analysis;
  const font = a.font;
  const fontName = font.name;
  const fontSize = font.size;
  const fontStr = `${fontSize}px "${fontName}"`;

  // Yellow highlight behind the gap area
  const pad = fontSize * 0.1;
  ctx.fillStyle = isActive ? "rgba(255, 200, 0, 0.2)" : "rgba(255, 200, 0, 0.12)";
  ctx.fillRect(a.gap.x, r.y - pad, a.gap.w, r.h + pad * 2);

  // Yellow border
  ctx.strokeStyle = isActive ? "rgba(255, 200, 0, 0.8)" : "rgba(255, 200, 0, 0.5)";
  ctx.lineWidth = isActive ? 2 : 1;
  ctx.strokeRect(a.gap.x, r.y - pad, a.gap.w, r.h + pad * 2);

  // Draw preview text
  ctx.font = fontStr;
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(255, 200, 0, 0.9)";
  ctx.fillText(r.preview, a.gap.x, a.line.y);
}

function drawRedactionSolution(r, isActive) {
  if (!r.analysis) return;
  const a = r.analysis;
  const font = a.font;
  const fontName = font.name;
  const fontSize = font.size;
  const fontStr = `${fontSize}px "${fontName}"`;

  // Green highlight
  const pad = fontSize * 0.1;
  ctx.fillStyle = isActive ? "rgba(0, 212, 116, 0.15)" : "rgba(0, 212, 116, 0.08)";
  ctx.fillRect(a.gap.x, r.y - pad, a.gap.w, r.h + pad * 2);

  // Green border
  ctx.strokeStyle = isActive ? "rgba(0, 212, 116, 0.8)" : "rgba(0, 212, 116, 0.4)";
  ctx.lineWidth = isActive ? 2 : 1;
  ctx.strokeRect(a.gap.x, r.y - pad, a.gap.w, r.h + pad * 2);

  // Draw solution text
  ctx.font = fontStr;
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(0, 212, 116, 0.95)";
  ctx.fillText(r.solution.text, a.gap.x, a.line.y);
}

// ── Canvas hit-testing ──

canvas.style.pointerEvents = "auto";

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;

  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const doc = screenToDoc(sx, sy);

  const hit = hitTestRedaction(doc.x, doc.y);
  if (hit) {
    e.stopPropagation();
    // Only activate if it wasn't a drag start
    activateRedaction(hit.id);
  }
  // If no hit, event bubbles to rightPanel for panning
});

canvas.addEventListener("mousemove", (e) => {
  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const doc = screenToDoc(sx, sy);

  const hit = hitTestRedaction(doc.x, doc.y);
  canvas.style.cursor = hit ? "pointer" : "";
});

function hitTestRedaction(docX, docY) {
  const redactions = getPageRedactions();
  for (const r of redactions) {
    if (docX >= r.x && docX <= r.x + r.w && docY >= r.y && docY <= r.y + r.h) {
      return r;
    }
  }
  return null;
}

// ── Viewport (Google Maps-style zoom & pan) ──

function applyTransform(smooth) {
  const pw = rightPanel.clientWidth;
  const ph = rightPanel.clientHeight;
  const tx = pw / 2 - state.panX * state.zoom;
  const ty = ph / 2 - state.panY * state.zoom;

  if (smooth) {
    docContainer.style.transition = "transform 0.25s ease-out";
  } else {
    docContainer.style.transition = "none";
  }

  docContainer.style.transform =
    `translate(${tx}px, ${ty}px) scale(${state.zoom})`;
  zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
}

function screenToDoc(sx, sy) {
  const pw = rightPanel.clientWidth;
  const ph = rightPanel.clientHeight;
  return {
    x: (sx - pw / 2) / state.zoom + state.panX,
    y: (sy - ph / 2) / state.zoom + state.panY,
  };
}

function zoomTo(newZoom, pivotSX, pivotSY, smooth) {
  newZoom = Math.max(0.1, Math.min(20, newZoom));
  if (pivotSX !== undefined) {
    const doc = screenToDoc(pivotSX, pivotSY);
    state.panX = doc.x;
    state.panY = doc.y;
    const pw = rightPanel.clientWidth;
    const ph = rightPanel.clientHeight;
    state.panX += (pw / 2 - pivotSX) / newZoom;
    state.panY += (ph / 2 - pivotSY) / newZoom;
  }
  state.zoom = newZoom;
  applyTransform(!!smooth);
}

function zoomToFit() {
  if (!docImage.naturalWidth) return;
  const pw = rightPanel.clientWidth;
  const ph = rightPanel.clientHeight;
  const iw = docImage.naturalWidth;
  const ih = docImage.naturalHeight;
  state.zoom = Math.min(pw / iw, ph / ih) * 0.95;
  state.panX = iw / 2;
  state.panY = ih / 2;
  applyTransform(true);
}

// Button zoom (centered)
zoomInBtn.addEventListener("click", () => {
  zoomTo(state.zoom * 1.3, undefined, undefined, true);
});
zoomOutBtn.addEventListener("click", () => {
  zoomTo(state.zoom / 1.3, undefined, undefined, true);
});
zoomFitBtn.addEventListener("click", zoomToFit);

// Mouse-wheel zoom toward cursor
rightPanel.addEventListener("wheel", (e) => {
  if (popover.contains(e.target)) return;
  e.preventDefault();
  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const factor = Math.pow(1.002, -e.deltaY);
  zoomTo(state.zoom * factor, sx, sy, false);
}, { passive: false });

// Double-click to zoom in
rightPanel.addEventListener("dblclick", (e) => {
  if (popover.contains(e.target)) return;
  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  zoomTo(state.zoom * 2, sx, sy, true);
});

// ── Click-drag pan ──

let drag = null;

rightPanel.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (popover.contains(e.target)) return;
  drag = {
    startX: e.clientX,
    startY: e.clientY,
    startPanX: state.panX,
    startPanY: state.panY,
    moved: false,
  };
  rightPanel.classList.add("panning");
  e.preventDefault();
});

window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
  state.panX = drag.startPanX - dx / state.zoom;
  state.panY = drag.startPanY - dy / state.zoom;
  applyTransform(false);
});

window.addEventListener("mouseup", () => {
  if (drag) {
    drag = null;
    rightPanel.classList.remove("panning");
  }
});

// ── Touch: pinch-zoom + two-finger pan ──

let lastTouches = null;

rightPanel.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    lastTouches = Array.from(e.touches);
  }
}, { passive: false });

rightPanel.addEventListener("touchmove", (e) => {
  if (e.touches.length === 2 && lastTouches) {
    e.preventDefault();
    const [t0, t1] = e.touches;
    const [p0, p1] = lastTouches;

    const oldDist = Math.hypot(p1.clientX - p0.clientX, p1.clientY - p0.clientY);
    const newDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    const zoomDelta = newDist / oldDist;

    const oldMidX = (p0.clientX + p1.clientX) / 2;
    const oldMidY = (p0.clientY + p1.clientY) / 2;
    const newMidX = (t0.clientX + t1.clientX) / 2;
    const newMidY = (t0.clientY + t1.clientY) / 2;

    state.panX -= (newMidX - oldMidX) / state.zoom;
    state.panY -= (newMidY - oldMidY) / state.zoom;

    const rect = rightPanel.getBoundingClientRect();
    const sx = newMidX - rect.left;
    const sy = newMidY - rect.top;
    zoomTo(state.zoom * zoomDelta, sx, sy, false);

    lastTouches = Array.from(e.touches);
  }
}, { passive: false });

rightPanel.addEventListener("touchend", () => {
  lastTouches = null;
});

// ── Resize handling ──

const resizeObserver = new ResizeObserver(() => {
  applyTransform(false);
  renderCanvas();
});
resizeObserver.observe(rightPanel);

// On image load, fit to viewport
docImage.addEventListener("load", () => {
  zoomToFit();
  renderCanvas();
});

// ── Solve ──

let activeEventSource = null;

solveStart.addEventListener("click", startSolve);
solveStop.addEventListener("click", stopSolve);
solveAccept.addEventListener("click", acceptSolution);

function startSolve() {
  const id = state.activeRedaction;
  if (!id) return;
  const r = state.redactions[id];
  if (!r || !r.analysis) return;

  const a = r.analysis;
  const fontId = a.font.id;
  const fontSize = a.font.size;
  const gapWidth = a.gap.w;

  // Context: last char before gap, first char after gap
  const segs = a.segments;
  const leftText = segs.length > 0 ? segs[0].text : "";
  const rightText = segs.length > 1 ? segs[1].text : "";
  const leftCtx = leftText.length > 0 ? leftText[leftText.length - 1] : "";
  const rightCtx = rightText.length > 0 ? rightText[0] : "";

  // Clear previous results
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
    filter_prefix: solveFilterPrefix.value,
    filter_suffix: solveFilterSuffix.value,
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

function handleSolveEvent(data, redactionId) {
  if (data.status === "match") {
    const assocMatches = matchAssociates(data.text);
    const topMatch = assocMatches.length > 0 ? assocMatches[0] : null;

    const div = document.createElement("div");
    div.className = "solve-result";
    if (topMatch) {
      div.dataset.assocTier = topMatch.tier;
      div.dataset.assocScore = topMatch.score;
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
      renderCanvas();
      solveResults.querySelectorAll(".solve-result").forEach(el => el.classList.remove("active"));
      div.classList.add("active");
      solveAccept.hidden = false;
    });

    // Insert sorted: by tier first (T1 > T2 > T3 > none), then by score within tier
    if (topMatch) {
      let inserted = false;
      for (const existing of solveResults.children) {
        const exTier = parseInt(existing.dataset.assocTier || "99");
        const exScore = parseFloat(existing.dataset.assocScore || "0");
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

function stopSolve() {
  if (activeEventSource) {
    activeEventSource.abort();
    activeEventSource = null;
  }
  solveStart.hidden = false;
  solveStop.hidden = true;
  solveStatus.textContent = "Stopped.";
}

function acceptSolution() {
  const id = state.activeRedaction;
  if (!id) return;
  const r = state.redactions[id];
  if (!r || !r.preview) return;

  r.status = "solved";
  r.solution = {
    text: r.preview,
    fontName: r.analysis.font.name,
    fontSize: r.analysis.font.size,
  };
  r.preview = null;

  closePopover();
  renderRedactionList();
  renderCanvas();
}

// ── Associate matching ──

const MATCH_TYPE_WEIGHTS = {
  full: 4,
  nickname_full: 3,
  initial_last: 2,
  last: 2,
  first: 1,
  nickname: 1,
};

function matchAssociates(text) {
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

function tierBadgeClass(tier) {
  if (tier === 1) return "tier-1";
  if (tier === 2) return "tier-2";
  return "tier-3";
}

function tierLabel(tier) {
  if (tier === 1) return "T1";
  if (tier === 2) return "T2";
  return "T3";
}

function tierDescription(tier) {
  if (tier === 1) return "Flight logs -- traveled with Epstein";
  if (tier === 2) return "Inner circle -- staff, financial, or frequently named";
  return "Named in Epstein case files";
}

function isVictimMatch(text) {
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

function showAssocDetail(assocMatches, anchorEl) {
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

  popover.appendChild(popup);

  popup.querySelector(".assoc-detail-close").addEventListener("click", (e) => {
    e.stopPropagation();
    popup.remove();
  });

  const closeOnOutside = (e) => {
    if (!popup.contains(e.target)) {
      popup.remove();
      document.removeEventListener("click", closeOnOutside, true);
    }
  };
  setTimeout(() => document.addEventListener("click", closeOnOutside, true), 0);
}

// ── Manual redaction marking (Shift+drag) ──

let drawDrag = null;

canvas.addEventListener("mousedown", (e) => {
  if (!e.shiftKey || e.button !== 0) return;

  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const doc = screenToDoc(sx, sy);

  drawDrag = { startX: doc.x, startY: doc.y };
  e.stopPropagation();
  e.preventDefault();
}, { capture: true }); // capture so it fires before the regular hit-test handler

window.addEventListener("mousemove", (e) => {
  if (!drawDrag) return;

  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const doc = screenToDoc(sx, sy);

  // Re-render canvas with a preview rectangle
  renderCanvas();
  const x = Math.min(drawDrag.startX, doc.x);
  const y = Math.min(drawDrag.startY, doc.y);
  const w = Math.abs(doc.x - drawDrag.startX);
  const h = Math.abs(doc.y - drawDrag.startY);

  ctx.strokeStyle = "rgba(255, 100, 100, 0.8)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
});

window.addEventListener("mouseup", (e) => {
  if (!drawDrag) return;

  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const doc = screenToDoc(sx, sy);

  const x = Math.round(Math.min(drawDrag.startX, doc.x));
  const y = Math.round(Math.min(drawDrag.startY, doc.y));
  const w = Math.round(Math.abs(doc.x - drawDrag.startX));
  const h = Math.round(Math.abs(doc.y - drawDrag.startY));

  drawDrag = null;

  // Only create if large enough
  if (w < 20 || h < 5) {
    renderCanvas();
    return;
  }

  const id = "m" + Date.now().toString(36);
  state.redactions[id] = {
    id, x, y, w, h,
    page: state.currentPage,
    status: "unanalyzed",
    analysis: null,
    solution: null,
    preview: null,
  };

  renderRedactionList();
  renderCanvas();
  activateRedaction(id);
});

// ── Utility ──

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
