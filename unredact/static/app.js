// DOM elements
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
const lineList = document.getElementById("line-list");
const fontControls = document.getElementById("font-controls");
const fontSelect = document.getElementById("font-select");
const sizeSlider = document.getElementById("size-slider");
const sizeValue = document.getElementById("size-value");
const sizeDown = document.getElementById("size-down");
const sizeUp = document.getElementById("size-up");
const zoomInBtn = document.getElementById("zoom-in");
const zoomOutBtn = document.getElementById("zoom-out");
const zoomFitBtn = document.getElementById("zoom-fit");
const zoomLevel = document.getElementById("zoom-level");
const rightPanel = document.getElementById("right-panel");
const docContainer = document.getElementById("doc-container");
const posUp = document.getElementById("pos-up");
const posDown = document.getElementById("pos-down");
const posLeft = document.getElementById("pos-left");
const posRight = document.getElementById("pos-right");
const posReset = document.getElementById("pos-reset");
const posDisplay = document.getElementById("pos-display");
const textEditBar = document.getElementById("text-edit-bar");
const segmentInputs = document.getElementById("segment-inputs");
const textReset = document.getElementById("text-reset");
const solveBtn = document.getElementById("solve-btn");
const solvePanel = document.getElementById("solve-panel");
const solveClose = document.getElementById("solve-close");
const solveStart = document.getElementById("solve-start");
const solveStop = document.getElementById("solve-stop");
const solveStatus = document.getElementById("solve-status");
const solveResults = document.getElementById("solve-results");
const solveCharset = document.getElementById("solve-charset");
const solveTolerance = document.getElementById("solve-tolerance");
const solveTolValue = document.getElementById("solve-tol-value");
const solveMode = document.getElementById("solve-mode");
const solveFilter = document.getElementById("solve-filter");
const solveFilterPrefix = document.getElementById("solve-filter-prefix");
const solveFilterSuffix = document.getElementById("solve-filter-suffix");
const solveAccept = document.getElementById("solve-accept");

// State
const state = {
  docId: null,
  pageCount: 0,
  currentPage: 1,
  pageData: {},        // page -> {lines: [...]}
  selectedLine: null,  // index into current page's lines
  lineOverrides: {},   // "page-lineIdx" -> {fontId, fontSize, segments: [{text, offsetX}], gapWidths: [px, ...], gapPreviews: [str|null, ...]}
  activeSegment: 0,    // which segment the d-pad / focus applies to
  fonts: [],           // [{name, id, available}]
  fontsReady: false,
  // Viewport: panX/panY are the document-space coords at the center of the panel
  zoom: 1,
  panX: 0,
  panY: 0,
  associates: null,  // {names: {str: [...]}, persons: {str: {...}}}
};

// ── Font loading ──

async function loadFonts() {
  const resp = await fetch("/api/fonts");
  const data = await resp.json();
  state.fonts = data.fonts;

  // Load available fonts via FontFace API
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

  // Populate font dropdown
  fontSelect.innerHTML = "";
  for (const f of state.fonts.filter((f) => f.available)) {
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
    console.log(`Loaded ${Object.keys(state.associates.names).length} associate lookups`);
  } catch (e) {
    console.warn("Failed to load associates data:", e);
    state.associates = { names: {}, persons: {} };
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

  // Start font + associates loading in parallel with upload
  const fontPromise = loadFonts();
  const assocPromise = loadAssociates();

  const form = new FormData();
  form.append("file", file);
  const resp = await fetch("/api/upload", { method: "POST", body: form });
  const data = await resp.json();

  state.docId = data.doc_id;
  state.pageCount = data.page_count;
  state.currentPage = 1;

  await Promise.all([fontPromise, assocPromise]); // ensure both are ready before rendering

  uploadSection.hidden = true;
  viewerSection.hidden = false;

  await loadPage(1);
}

// ── Page loading ──

async function loadPage(page) {
  state.currentPage = page;
  state.selectedLine = null;
  fontControls.hidden = true;
  textEditBar.hidden = true;
  updatePageControls();

  // Load the original page image
  docImage.src = `/api/doc/${state.docId}/page/${page}/original`;

  // Load page data if not cached
  if (!state.pageData[page]) {
    const resp = await fetch(`/api/doc/${state.docId}/page/${page}/data`);
    state.pageData[page] = await resp.json();
  }

  renderLineList();
  clearCanvas();
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

// ── Line list ──

function renderLineList() {
  const pd = state.pageData[state.currentPage];
  if (!pd) return;

  lineList.innerHTML = "";
  pd.lines.forEach((line, idx) => {
    const div = document.createElement("div");
    div.className = "line-item";
    div.dataset.idx = idx;

    const textEl = document.createElement("div");
    textEl.className = "line-text";
    textEl.textContent = line.text;

    const overrideKey = `${state.currentPage}-${idx}`;
    const override = state.lineOverrides[overrideKey];
    const fontName = override
      ? state.fonts.find((f) => f.id === override.fontId)?.name || line.font.name
      : line.font.name;
    const fontSize = override ? override.fontSize : line.font.size;

    const metaEl = document.createElement("div");
    metaEl.className = "line-meta";
    metaEl.textContent = `${fontName} ${fontSize}px (score: ${line.font.score.toFixed(1)})`;

    div.appendChild(textEl);
    div.appendChild(metaEl);

    div.addEventListener("click", () => selectLine(idx));
    lineList.appendChild(div);
  });
}

// ── Line selection ──

function selectLine(idx) {
  state.selectedLine = idx;

  // Update selected class
  lineList.querySelectorAll(".line-item").forEach((el, i) => {
    el.classList.toggle("selected", i === idx);
  });

  const pd = state.pageData[state.currentPage];
  const line = pd.lines[idx];
  const overrideKey = `${state.currentPage}-${idx}`;
  const override = state.lineOverrides[overrideKey];

  // Populate font controls
  const fontId = override ? override.fontId : line.font.id;
  const fontSize = override ? override.fontSize : line.font.size;
  fontSelect.value = fontId;
  sizeSlider.value = fontSize;
  sizeValue.textContent = fontSize;
  fontControls.hidden = false;
  textEditBar.hidden = false;

  state.activeSegment = 0;
  renderSegmentInputs();
  updatePosDisplay();
  renderOverlay();
  scrollToLine(line);
  updateSolveButton();
}

function scrollToLine(line) {
  // Pan so the line is centered in the viewport
  state.panX = line.x + line.w / 2;
  state.panY = line.y + line.h / 2;
  applyTransform(true);
}

// ── Font controls ──

fontSelect.addEventListener("change", () => saveOverrideAndRender());
sizeSlider.addEventListener("input", () => {
  sizeValue.textContent = sizeSlider.value;
  saveOverrideAndRender();
});
sizeDown.addEventListener("click", () => {
  sizeSlider.value = Math.max(8, parseInt(sizeSlider.value) - 1);
  sizeValue.textContent = sizeSlider.value;
  saveOverrideAndRender();
});
sizeUp.addEventListener("click", () => {
  sizeSlider.value = Math.min(120, parseInt(sizeSlider.value) + 1);
  sizeValue.textContent = sizeSlider.value;
  saveOverrideAndRender();
});

function nudge(dx, dy) {
  if (state.selectedLine === null) return;
  const override = ensureOverride();
  if (dx !== 0) {
    if (state.activeSegment === 0) {
      // First segment: nudge its position (line alignment)
      override.segments[0].offsetX += dx;
    } else {
      // Any other segment: adjust the gap before it
      const gapIdx = state.activeSegment - 1;
      if (override.gapWidths[gapIdx] !== undefined) {
        override.gapWidths[gapIdx] = Math.max(1, override.gapWidths[gapIdx] + dx);
      }
    }
  }
  if (dy !== 0) {
    override.offsetY = (override.offsetY || 0) + dy;
  }
  updatePosDisplay();
  renderOverlay();
}

function updatePosDisplay() {
  const key = `${state.currentPage}-${state.selectedLine}`;
  const override = state.lineOverrides[key];
  const y = override?.offsetY ?? 0;
  if (state.activeSegment > 0) {
    // Non-first segment: show gap before it
    const gapIdx = state.activeSegment - 1;
    const gw = override?.gapWidths?.[gapIdx] ?? 0;
    posDisplay.textContent = `gap: ${gw}px, y: ${y}`;
  } else {
    // First segment: show offset
    const seg = override?.segments?.[0];
    const x = seg?.offsetX ?? 0;
    posDisplay.textContent = `${x}, ${y}`;
  }
}

posUp.addEventListener("click", () => nudge(0, -1));
posDown.addEventListener("click", () => nudge(0, 1));
posLeft.addEventListener("click", () => nudge(-1, 0));
posRight.addEventListener("click", () => nudge(1, 0));
posReset.addEventListener("click", () => {
  if (state.selectedLine === null) return;
  const override = ensureOverride();
  if (state.activeSegment > 0) {
    // Non-first segment: reset gap before it to default (fontSize * 2)
    const gapIdx = state.activeSegment - 1;
    if (override.gapWidths[gapIdx] !== undefined) {
      override.gapWidths[gapIdx] = override.fontSize * 2;
    }
  } else {
    // First segment: reset offset
    const seg = override.segments[0];
    if (seg) seg.offsetX = 0;
  }
  override.offsetY = 0;
  updatePosDisplay();
  renderOverlay();
});

// ── Segments model ──
//
// Each line override has a `segments` array: [{text, offsetX, offsetY}, ...]
// A line with no redactions has 1 segment. Ctrl+Space splits a segment,
// inserting a redaction gap. The d-pad affects state.activeSegment.

function getSegments() {
  const key = `${state.currentPage}-${state.selectedLine}`;
  return state.lineOverrides[key]?.segments;
}

function ensureOverride() {
  const key = `${state.currentPage}-${state.selectedLine}`;
  if (!state.lineOverrides[key]) {
    const pd = state.pageData[state.currentPage];
    const line = pd.lines[state.selectedLine];
    state.lineOverrides[key] = {
      fontId: line.font.id,
      fontSize: line.font.size,
      offsetY: 0,
      segments: [{ text: line.text, offsetX: 0 }],
      gapWidths: [],  // one entry per gap between segments
      gapPreviews: [],  // one entry per gap: null or preview text
    };
  }
  return state.lineOverrides[key];
}

function ensureSegments() {
  return ensureOverride().segments;
}

// ── Segment UI ──

function renderSegmentInputs() {
  const segments = getSegments();
  const pd = state.pageData[state.currentPage];
  const line = pd.lines[state.selectedLine];

  segmentInputs.innerHTML = "";

  // If no override yet, show single input with original text
  const segs = segments || [{ text: line.text, offsetX: 0, offsetY: 0 }];

  const key = `${state.currentPage}-${state.selectedLine}`;
  const overrideForSegs = state.lineOverrides[key];

  segs.forEach((seg, i) => {
    if (i > 0) {
      // Redaction marker between segments — show preview text if set
      const preview = overrideForSegs?.gapPreviews?.[i - 1] ?? null;
      const marker = document.createElement("span");
      marker.className = preview ? "redaction-marker preview" : "redaction-marker";
      marker.textContent = preview || "???";
      marker.title = preview ? `Preview: ${preview}` : "Redaction gap";
      segmentInputs.appendChild(marker);
    }

    const input = document.createElement("input");
    input.type = "text";
    input.className = "seg-input";
    input.value = seg.text;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.dataset.segIdx = i;
    if (i === state.activeSegment) input.classList.add("active-segment");

    input.addEventListener("focus", () => {
      state.activeSegment = i;
      segmentInputs.querySelectorAll(".seg-input").forEach((el, j) => {
        el.classList.toggle("active-segment", j === i);
      });
      updatePosDisplay();
    });

    input.addEventListener("input", () => {
      const segs = ensureSegments();
      segs[i].text = input.value;
      renderOverlay();
      updateLineListPreview();
    });

    // Ctrl+Space: split this segment at cursor, inserting a redaction gap
    input.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.code === "Space") {
        e.preventDefault();
        splitSegmentAtCursor(i, input);
      }
    });

    segmentInputs.appendChild(input);
  });

  // Hint if only one segment
  if (segs.length === 1) {
    const hint = document.createElement("span");
    hint.className = "seg-hint";
    hint.textContent = "Ctrl+Space to add redaction";
    segmentInputs.appendChild(hint);
  }
}

function splitSegmentAtCursor(segIdx, inputEl) {
  const segs = ensureSegments();
  const seg = segs[segIdx];
  const pos = inputEl.selectionStart;
  const before = seg.text.slice(0, pos);
  const after = seg.text.slice(pos);

  // Replace this segment with two, separated by the new redaction gap
  segs.splice(segIdx, 1,
    { text: before, offsetX: seg.offsetX },
    { text: after, offsetX: 0 },
  );

  // Initialize gap width and preview for the new gap
  const override = ensureOverride();
  const fontSize = override.fontSize;
  override.gapWidths.splice(segIdx, 0, fontSize * 2);
  override.gapPreviews.splice(segIdx, 0, null);

  // Focus the new segment after the gap
  state.activeSegment = segIdx + 1;
  renderSegmentInputs();
  renderOverlay();
  updateLineListPreview();
  updateSolveButton();

  // Focus the new input
  const inputs = segmentInputs.querySelectorAll(".seg-input");
  if (inputs[state.activeSegment]) {
    inputs[state.activeSegment].focus();
    inputs[state.activeSegment].setSelectionRange(0, 0);
  }
}

function updateLineListPreview() {
  const items = lineList.querySelectorAll(".line-item");
  if (!items[state.selectedLine]) return;
  const segs = getSegments();
  const pd = state.pageData[state.currentPage];
  const line = pd.lines[state.selectedLine];
  const textEl = items[state.selectedLine].querySelector(".line-text");
  if (segs && segs.length > 1) {
    const key = `${state.currentPage}-${state.selectedLine}`;
    const ovr = state.lineOverrides[key];
    const parts = segs.map((s, i) => {
      if (i === 0) return s.text;
      const preview = ovr?.gapPreviews?.[i - 1];
      return (preview ? `[${preview}]` : "[???]") + s.text;
    });
    textEl.textContent = parts.join(" ");
  } else if (segs) {
    textEl.textContent = segs[0].text;
  } else {
    textEl.textContent = line.text;
  }
}

textReset.addEventListener("click", () => {
  if (state.selectedLine === null) return;
  const key = `${state.currentPage}-${state.selectedLine}`;
  const override = state.lineOverrides[key];
  if (override) {
    const pd = state.pageData[state.currentPage];
    const line = pd.lines[state.selectedLine];
    override.segments = [{ text: line.text, offsetX: 0 }];
    override.gapWidths = [];
    override.gapPreviews = [];
    override.offsetY = 0;
  }
  state.activeSegment = 0;
  renderSegmentInputs();
  updatePosDisplay();
  renderOverlay();
  updateLineListPreview();
  updateSolveButton();
});

function saveOverrideAndRender() {
  if (state.selectedLine === null) return;
  const key = `${state.currentPage}-${state.selectedLine}`;
  const prev = state.lineOverrides[key];
  const override = ensureOverride();
  override.fontId = fontSelect.value;
  override.fontSize = parseInt(sizeSlider.value);
  renderOverlay();
  // Update the meta text in the line list
  const items = lineList.querySelectorAll(".line-item");
  if (items[state.selectedLine]) {
    const meta = items[state.selectedLine].querySelector(".line-meta");
    const fontName = state.fonts.find((f) => f.id === fontSelect.value)?.name || "?";
    meta.textContent = `${fontName} ${sizeSlider.value}px (override)`;
  }
}

// ── Canvas rendering ──

function clearCanvas() {
  canvas.width = 0;
  canvas.height = 0;
}

function renderOverlay() {
  if (state.selectedLine === null || !state.fontsReady) return;
  if (!docImage.naturalWidth) return;

  const pd = state.pageData[state.currentPage];
  const line = pd.lines[state.selectedLine];
  const overrideKey = `${state.currentPage}-${state.selectedLine}`;
  const override = state.lineOverrides[overrideKey];

  const fontId = override ? override.fontId : line.font.id;
  const fontSize = override ? override.fontSize : line.font.size;
  const fontName = state.fonts.find((f) => f.id === fontId)?.name || line.font.name;
  const fontStr = `${fontSize}px "${fontName}"`;

  // Canvas resolution matches native image; CSS size matches natural size
  canvas.width = docImage.naturalWidth;
  canvas.height = docImage.naturalHeight;
  canvas.style.width = docImage.naturalWidth + "px";
  canvas.style.height = docImage.naturalHeight + "px";

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = fontStr;
  ctx.textBaseline = "top";

  // Draw bounding box for reference (at original position)
  ctx.strokeStyle = "rgba(0, 200, 0, 0.3)";
  ctx.lineWidth = 1;
  ctx.strokeRect(line.x, line.y, line.w, line.h);

  const segments = override?.segments || [{ text: line.text, offsetX: 0 }];
  const sharedY = override?.offsetY || 0;

  // Render each segment; track x cursor for positioning
  let cursorX = line.x;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const sx = cursorX + seg.offsetX;
    const sy = line.y + sharedY;

    // Draw segment text
    const isActive = i === state.activeSegment;
    ctx.fillStyle = isActive ? "rgba(0, 230, 0, 0.7)" : "rgba(0, 200, 0, 0.5)";
    ctx.font = fontStr;
    ctx.fillText(seg.text, sx, sy);

    const textWidth = ctx.measureText(seg.text).width;
    cursorX = sx + textWidth;

    // If there's a next segment, draw the redaction gap or preview
    if (i < segments.length - 1) {
      const gapStart = cursorX;
      const gapWidth = override?.gapWidths?.[i] ?? fontSize * 2;
      const preview = override?.gapPreviews?.[i] ?? null;

      if (preview) {
        // Draw preview text in the gap area
        ctx.font = fontStr;
        ctx.fillStyle = "rgba(255, 200, 0, 0.85)";
        ctx.fillText(preview, gapStart, line.y + sharedY);
        const previewWidth = ctx.measureText(preview).width;

        // Subtle highlight behind preview text
        const pad = fontSize * 0.1;
        ctx.fillStyle = "rgba(255, 200, 0, 0.12)";
        ctx.fillRect(gapStart, line.y - pad, gapWidth, line.h + pad * 2);

        // Advance cursor past the original gap width (keeps alignment stable)
        cursorX = gapStart + gapWidth;
      } else {
        // Draw redaction indicator — full line height, strong red
        const pad = fontSize * 0.15;
        ctx.fillStyle = "rgba(211, 47, 47, 0.5)";
        ctx.fillRect(gapStart, line.y - pad, gapWidth, line.h + pad * 2);
        ctx.strokeStyle = "rgba(211, 47, 47, 0.8)";
        ctx.lineWidth = 2;
        ctx.strokeRect(gapStart, line.y - pad, gapWidth, line.h + pad * 2);

        // Draw gap width label centered in the gap
        ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
        ctx.font = `bold ${Math.min(fontSize * 0.5, 16)}px sans-serif`;
        const label = `${Math.round(gapWidth)}px`;
        const labelWidth = ctx.measureText(label).width;
        ctx.fillText(label, gapStart + (gapWidth - labelWidth) / 2, line.y + line.h * 0.3);
        ctx.font = fontStr; // restore

        // Advance cursor past the gap
        cursorX = gapStart + gapWidth;
      }
    }
  }
}

// ── Viewport (Google Maps-style zoom & pan) ──
//
// The model: panX/panY are document-space coordinates at the center of the
// viewport.  zoom is the scale factor.  We compute a single CSS transform
// on #doc-container that maps document coords to screen coords.

function applyTransform(smooth) {
  const pw = rightPanel.clientWidth;
  const ph = rightPanel.clientHeight;
  // translate so that (panX, panY) lands at the center of the panel
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

// Convert screen coords (relative to panel) → document coords
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
  // If a screen-space pivot is given, keep that document point stationary
  if (pivotSX !== undefined) {
    const doc = screenToDoc(pivotSX, pivotSY);
    state.panX = doc.x;
    state.panY = doc.y;
    // After zoom, (doc.x, doc.y) should still appear at (pivotSX, pivotSY).
    // Since applyTransform centers panX/panY in the panel, we need to offset.
    const pw = rightPanel.clientWidth;
    const ph = rightPanel.clientHeight;
    state.panX += (pw / 2 - pivotSX) / newZoom;
    state.panY += (ph / 2 - pivotSY) / newZoom;
  }
  state.zoom = newZoom;
  applyTransform(!!smooth);
  renderOverlay();
}

function zoomToFit() {
  if (!docImage.naturalWidth) return;
  const pw = rightPanel.clientWidth;
  const ph = rightPanel.clientHeight;
  const iw = docImage.naturalWidth;
  const ih = docImage.naturalHeight;
  state.zoom = Math.min(pw / iw, ph / ih) * 0.95; // small margin
  state.panX = iw / 2;
  state.panY = ih / 2;
  applyTransform(true);
  renderOverlay();
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
  if (fontControls.contains(e.target) || textEditBar.contains(e.target) || solvePanel.contains(e.target)) return;
  e.preventDefault();
  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  // Continuous zoom: scale by small increments for smoothness
  const factor = Math.pow(1.002, -e.deltaY);
  zoomTo(state.zoom * factor, sx, sy, false);
}, { passive: false });

// Double-click to zoom in
rightPanel.addEventListener("dblclick", (e) => {
  if (fontControls.contains(e.target) || textEditBar.contains(e.target) || solvePanel.contains(e.target)) return;
  const rect = rightPanel.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  zoomTo(state.zoom * 2, sx, sy, true);
});

// ── Click-drag pan ──

let drag = null;

rightPanel.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  // Don't start panning when interacting with toolbars or solve panel
  if (fontControls.contains(e.target) || textEditBar.contains(e.target) || solvePanel.contains(e.target)) return;
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
  // Translate screen deltas back to document space
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

    // Distance change → zoom
    const oldDist = Math.hypot(p1.clientX - p0.clientX, p1.clientY - p0.clientY);
    const newDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    const zoomDelta = newDist / oldDist;

    // Midpoint movement → pan
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
  if (state.selectedLine !== null) {
    renderOverlay();
  }
});
resizeObserver.observe(rightPanel);

// On image load, fit to viewport
docImage.addEventListener("load", () => {
  zoomToFit();
  if (state.selectedLine !== null) {
    renderOverlay();
  }
});

// ── Solve panel ──

let activeEventSource = null;
let activeSolveGapIdx = null;

function updateSolveButton() {
  const segs = getSegments();
  solveBtn.hidden = !(segs && segs.length > 1);
}

solveBtn.addEventListener("click", () => {
  solvePanel.hidden = false;
  solveAccept.hidden = true;
});

solveClose.addEventListener("click", () => {
  solvePanel.hidden = true;
  stopSolve();
});

solveTolerance.addEventListener("input", () => {
  solveTolValue.textContent = solveTolerance.value;
});

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
  const key = text.toLowerCase().trim();
  const matches = state.associates.names[key];
  if (!matches) return [];

  const prefix = solveFilterPrefix.value.toLowerCase().trim();
  const suffix = solveFilterSuffix.value.toLowerCase().trim();

  return matches.map(m => {
    const person = state.associates.persons[m.person_id];
    const weight = MATCH_TYPE_WEIGHTS[m.match_type] || 1;
    let score = (4 - m.tier) * weight;

    // Boost if the associate's name aligns with user's prefix/suffix hints
    const pname = (person?.name || "").toLowerCase();
    if (prefix && pname.startsWith(prefix)) score += 2;
    if (suffix && pname.endsWith(suffix)) score += 2;

    return {
      personId: m.person_id,
      personName: person?.name || "Unknown",
      category: person?.category || "other",
      tier: m.tier,
      matchType: m.match_type,
      score,
    };
  }).sort((a, b) => b.score - a.score);
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
  if (tier === 1) return "Flight logs — traveled with Epstein";
  if (tier === 2) return "Inner circle — staff, financial, or frequently named";
  return "Named in Epstein case files";
}

function showAssocDetail(assocMatches, anchorEl) {
  // Remove any existing popup
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

  // Position near the badge
  solvePanel.appendChild(popup);

  // Close handlers
  popup.querySelector(".assoc-detail-close").addEventListener("click", (e) => {
    e.stopPropagation();
    popup.remove();
  });

  // Close on outside click
  const closeOnOutside = (e) => {
    if (!popup.contains(e.target)) {
      popup.remove();
      document.removeEventListener("click", closeOnOutside, true);
    }
  };
  setTimeout(() => document.addEventListener("click", closeOnOutside, true), 0);
}

solveStart.addEventListener("click", startSolve);
solveStop.addEventListener("click", stopSolve);

function startSolve() {
  if (state.selectedLine === null) return;
  const segs = getSegments();
  if (!segs || segs.length < 2) return;

  const pd = state.pageData[state.currentPage];
  const line = pd.lines[state.selectedLine];
  const override = state.lineOverrides[`${state.currentPage}-${state.selectedLine}`];
  const fontId = override ? override.fontId : line.font.id;
  const fontSize = override ? override.fontSize : line.font.size;
  const fontName = state.fonts.find(f => f.id === fontId)?.name || line.font.name;

  // Find the gap before the active segment
  if (state.activeSegment === 0) return; // no gap before first segment
  const gapIdx = state.activeSegment - 1;

  // Get gap width from the override's gapWidths array
  const gapWidth = override?.gapWidths?.[gapIdx] ?? fontSize * 2;

  // Context characters: segment before the gap, segment after the gap
  const segBefore = segs[gapIdx];
  const segAfter = segs[gapIdx + 1];
  const leftCtx = segBefore.text.length > 0 ? segBefore.text[segBefore.text.length - 1] : "";
  const rightCtx = segAfter.text.length > 0 ? segAfter.text[0] : "";

  // Track which gap we're solving
  activeSolveGapIdx = gapIdx;

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
              handleSolveEvent(data, gapIdx);
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

function handleSolveEvent(data, gapIdx) {
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
      const override = ensureOverride();
      override.gapPreviews[gapIdx] = data.text;
      renderOverlay();
      renderSegmentInputs();
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
        // Lower tier number = higher priority; within same tier, higher score wins
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

solveAccept.addEventListener("click", acceptSolution);

function acceptSolution() {
  if (state.selectedLine === null || activeSolveGapIdx === null) return;
  const key = `${state.currentPage}-${state.selectedLine}`;
  const override = state.lineOverrides[key];
  if (!override) return;

  const gapIdx = activeSolveGapIdx;
  const previewText = override.gapPreviews[gapIdx];
  if (!previewText) return;

  // Merge: segments[gapIdx].text + previewText + segments[gapIdx+1].text → single segment
  const leftSeg = override.segments[gapIdx];
  const rightSeg = override.segments[gapIdx + 1];
  leftSeg.text = leftSeg.text + previewText + rightSeg.text;

  // Remove the right segment
  override.segments.splice(gapIdx + 1, 1);

  // Remove the gap entry
  override.gapWidths.splice(gapIdx, 1);
  override.gapPreviews.splice(gapIdx, 1);

  // Reset active segment to the merged segment
  state.activeSegment = gapIdx;
  activeSolveGapIdx = null;

  // Stop any running solve and close panel
  stopSolve();
  solvePanel.hidden = true;
  solveResults.innerHTML = "";
  solveStatus.textContent = "";
  solveAccept.hidden = true;

  // Re-render everything
  renderSegmentInputs();
  updatePosDisplay();
  renderOverlay();
  updateLineListPreview();
  updateSolveButton();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
