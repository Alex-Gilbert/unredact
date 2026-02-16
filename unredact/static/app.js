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

// State
const state = {
  docId: null,
  pageCount: 0,
  currentPage: 1,
  pageData: {},        // page -> {lines: [...]}
  selectedLine: null,  // index into current page's lines
  lineOverrides: {},   // "page-lineIdx" -> {fontId, fontSize}
  fonts: [],           // [{name, id, available}]
  fontsReady: false,
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

  // Start font loading in parallel with upload
  const fontPromise = loadFonts();

  const form = new FormData();
  form.append("file", file);
  const resp = await fetch("/api/upload", { method: "POST", body: form });
  const data = await resp.json();

  state.docId = data.doc_id;
  state.pageCount = data.page_count;
  state.currentPage = 1;

  await fontPromise; // ensure fonts are ready before rendering

  uploadSection.hidden = true;
  viewerSection.hidden = false;

  await loadPage(1);
}

// ── Page loading ──

async function loadPage(page) {
  state.currentPage = page;
  state.selectedLine = null;
  fontControls.hidden = true;
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

  renderOverlay();
  scrollToLine(line);
}

function scrollToLine(line) {
  // Scroll the right panel so the selected line is visible
  const rightPanel = document.getElementById("right-panel");
  const imgRect = docImage.getBoundingClientRect();
  const scale = docImage.clientHeight / docImage.naturalHeight;
  const lineY = line.y * scale;
  const panelRect = rightPanel.getBoundingClientRect();
  const lineScreenY = imgRect.top - panelRect.top + lineY;
  // Center the line in the panel
  const target = lineScreenY - rightPanel.clientHeight / 3;
  rightPanel.scrollTop += target;
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

function saveOverrideAndRender() {
  if (state.selectedLine === null) return;
  const key = `${state.currentPage}-${state.selectedLine}`;
  state.lineOverrides[key] = {
    fontId: fontSelect.value,
    fontSize: parseInt(sizeSlider.value),
  };
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

  // Match canvas resolution to native image resolution
  canvas.width = docImage.naturalWidth;
  canvas.height = docImage.naturalHeight;
  // Match display size to image display size
  canvas.style.width = docImage.clientWidth + "px";
  canvas.style.height = docImage.clientHeight + "px";

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${fontSize}px "${fontName}"`;
  ctx.fillStyle = "rgba(0, 200, 0, 0.6)";
  ctx.textBaseline = "top";
  ctx.fillText(line.text, line.x, line.y);

  // Draw a subtle bounding box for reference
  ctx.strokeStyle = "rgba(0, 200, 0, 0.3)";
  ctx.lineWidth = 1;
  ctx.strokeRect(line.x, line.y, line.w, line.h);
}

// ── Resize handling ──

const resizeObserver = new ResizeObserver(() => {
  if (state.selectedLine !== null) {
    renderOverlay();
  }
});

// Start observing once image loads
docImage.addEventListener("load", () => {
  resizeObserver.observe(docImage);
  if (state.selectedLine !== null) {
    renderOverlay();
  }
});
