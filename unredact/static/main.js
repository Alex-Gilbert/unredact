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
import { initSettings } from './settings.js';
import { loadPdf, renderPage } from './pdf.js';
import { initOcr, ocrPage } from './ocr.js';
import { initWasm, detectRedactions, spotRedaction, findRedactionInRegion } from './wasm.js';
import { detectFontMasked, detectFontMarquee, cropToGrayscale } from './font_detect.js';
import { identifyBoundaryText } from './llm.js';
import { getSetting, saveDocument, savePage, getPage, getDocument, listDocuments, deleteDocument } from './db.js';
import { initMarquee, setOnAnalyze, clearMarquee } from './marquee.js';


// ── Sheet snap management ──

const mobileQuery = window.matchMedia('(max-width: 768px)');
const isMobile = () => mobileQuery.matches;

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
  if (!isMobile()) return;
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

mobileQuery.addEventListener('change', handleLayoutChange);


// ── Font loading ──

async function loadFonts() {
  // Load bundled font manifest and register each WOFF2 via FontFace
  const resp = await fetch("/fonts/manifest.json");
  const data = await resp.json();

  state.fonts = [];
  const loadPromises = data.fonts.map(async (f) => {
    const face = new FontFace(f.name, `url(/fonts/${f.file})`);
    try {
      const loaded = await face.load();
      document.fonts.add(loaded);
      state.fonts.push({ ...f, available: true });
    } catch (e) {
      console.warn(`Failed to load font ${f.name}:`, e);
      state.fonts.push({ ...f, available: false });
    }
  });
  await Promise.all(loadPromises);

  // Load user-uploaded fonts from IndexedDB
  const { getUserFonts } = await import('./db.js');
  const userFonts = await getUserFonts();
  for (const uf of userFonts) {
    const face = new FontFace(uf.name, await uf.blob.arrayBuffer());
    try {
      const loaded = await face.load();
      document.fonts.add(loaded);
      state.fonts.push({ id: uf.fontId, name: uf.name, available: true, source: 'user' });
    } catch (e) {
      console.warn(`Failed to load user font ${uf.name}:`, e);
    }
  }

  state.fontsReady = true;
  refreshFontSelect();
}

function refreshFontSelect() {
  fontSelect.innerHTML = "";
  for (const f of state.fonts.filter(f => f.available)) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.equivalent ? `${f.name} (≈ ${f.equivalent})` : f.name;
    fontSelect.appendChild(opt);
  }
}

async function loadAssociates() {
  try {
    const resp = await fetch("/data/associates.json");
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
  uploadSection.innerHTML = '<p class="loading">Loading document...</p>';

  // Initialize modules in parallel with font/associate loading
  const fontPromise = loadFonts();
  const assocPromise = loadAssociates();
  const wasmPromise = initWasm();
  const ocrPromise = initOcr();

  // Load the PDF
  const buffer = await file.arrayBuffer();
  const { pageCount, doc } = await loadPdf(buffer);

  // Save document with PDF blob for session resume
  const pdfBlob = new Blob([buffer], { type: 'application/pdf' });
  const docId = await saveDocument({ name: file.name, pageCount, pdfBlob });

  state.docId = docId;
  state.pageCount = pageCount;
  state.currentPage = 1;
  state.pdfDoc = doc;
  state.pageImages = {};
  state.ocrData = {};

  await Promise.all([fontPromise, assocPromise, wasmPromise, ocrPromise]);

  uploadSection.hidden = true;
  viewerSection.hidden = false;

  // Render and display the first page
  await loadPage(1);

  // Start background OCR on all pages
  runBackgroundOcr();
}

/**
 * Run client-side redaction detection and analysis on all pages.
 */
async function runAnalysis() {
  showToast("Analyzing document...");

  const apiKey = await getSetting('anthropic_api_key');

  for (let page = 1; page <= state.pageCount; page++) {
    try {
      // Ensure page is rendered and OCR'd
      if (!state.pageImages[page]) {
        const result = await renderPage(state.pdfDoc, page);
        const blobUrl = URL.createObjectURL(result.blob);
        state.pageImages[page] = { imageData: result.imageData, blob: result.blob, blobUrl };
      }
      if (!state.ocrData[page]) {
        state.ocrData[page] = await ocrPage(state.pageImages[page].blob);
      }

      const imageData = state.pageImages[page].imageData;
      const ocrLines = state.ocrData[page];

      // Step 1: Detect redaction boxes via WASM
      const boxes = detectRedactions(imageData);

      // Step 2: For each box, run analysis
      for (const box of boxes) {
        const analysis = await analyzeRedaction(imageData, ocrLines, box, apiKey);
        const id = `p${page}-r${box.x}-${box.y}-${box.w}-${box.h}`;

        state.redactions[id] = {
          id,
          x: box.x, y: box.y, w: box.w, h: box.h,
          page,
          status: analysis ? "analyzed" : "unanalyzed",
          analysis: analysis || null,
          solution: null,
          preview: null,
        };

        if (analysis) {
          state.redactions[id].overrides = {
            fontId: analysis.font.id,
            fontSize: analysis.font.size,
            offsetX: analysis.offset_x || 0,
            offsetY: analysis.offset_y || 0,
            gapWidth: analysis.gap.w,
            leftText: analysis.segments[0]?.text || "",
            rightText: analysis.segments[1]?.text || "",
          };
        }
      }

      // Persist redactions to IndexedDB
      const pageRedactions = Object.values(state.redactions)
        .filter(r => r.page === page)
        .map(r => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, status: r.status, analysis: r.analysis, overrides: r.overrides }));
      await savePage(state.docId, page, { ocrLines: state.ocrData[page], redactions: pageRedactions });

      // Re-render if this is the current page
      if (page === state.currentPage) {
        renderRedactionList();
        renderCanvas();
      }
    } catch (e) {
      showToast(`Page ${page}: ${e.message}`, "error");
    }
  }

  showToast("Analysis complete");
  if (detectBtn) {
    detectBtn.disabled = false;
    detectBtn.textContent = "Detect Redactions";
  }
}

/**
 * Analyze a single redaction box: find the OCR line, detect font, get boundary text.
 * @param {ImageData} imageData
 * @param {Array<{text: string, x: number, y: number, w: number, h: number, chars: Array<{text: string, x: number, y: number, w: number, h: number}>}>} ocrLines
 * @param {{x: number, y: number, w: number, h: number}} box
 * @param {string|null} apiKey
 * @returns {Promise<object|null>}
 */
async function analyzeRedaction(imageData, ocrLines, box, apiKey) {
  // Find the OCR line that best overlaps this box vertically
  let bestLine = null;
  let bestOverlap = 0;

  for (const line of ocrLines) {
    const overlap = Math.max(0,
      Math.min(box.y + box.h, line.y + line.h) - Math.max(box.y, line.y)
    );
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestLine = line;
    }
  }

  if (!bestLine) return null;

  const line = bestLine;

  // Font detection with redaction masking
  const redactionBoxes = [box];
  const candidates = state.fonts.filter(f => f.available).map(f => f.name);
  const fontMatch = detectFontMasked(imageData, line, redactionBoxes, candidates);

  // Get font ID from name
  const fontId = (state.fonts.find(f => f.name === fontMatch.fontName) || {}).id || fontMatch.fontName.toLowerCase().replace(/\s+/g, '-');

  // Get boundary text
  let leftText = '';
  let rightText = '';

  if (apiKey) {
    try {
      const boundary = await identifyBoundaryText(line, box.x, box.w, apiKey);
      leftText = boundary.leftText;
      rightText = boundary.rightText;
    } catch (_e) {
      // Fallback: use char-based splitting
      const leftChars = line.chars.filter(c => c.x + c.w / 2 < box.x);
      const rightChars = line.chars.filter(c => c.x + c.w / 2 > box.x + box.w);
      leftText = leftChars.map(c => c.text).join('').trim();
      rightText = rightChars.map(c => c.text).join('').trim();
    }
  } else {
    // No API key — fallback to char splitting
    const leftChars = line.chars.filter(c => c.x + c.w / 2 < box.x);
    const rightChars = line.chars.filter(c => c.x + c.w / 2 > box.x + box.w);
    leftText = leftChars.map(c => c.text).join('').trim();
    rightText = rightChars.map(c => c.text).join('').trim();
  }

  // Compute gap from box width
  const gapW = box.w;

  return {
    font: { id: fontId, name: fontMatch.fontName, size: fontMatch.fontSize },
    gap: { x: box.x, y: box.y, w: gapW, h: box.h },
    line: { text: line.text, x: line.x, y: line.y, w: line.w, h: line.h },
    segments: [
      { text: leftText, side: 'left' },
      { text: rightText, side: 'right' },
    ],
    offset_x: 0,
    offset_y: 0,
  };
}

/**
 * Run OCR on all pages in background, storing results in state.
 */
async function runBackgroundOcr() {
  showToast("Running OCR...", "info");
  const statusEl = document.getElementById("ocr-status");

  for (let page = 1; page <= state.pageCount; page++) {
    try {
      // Ensure page is rendered
      if (!state.pageImages[page]) {
        const result = await renderPage(state.pdfDoc, page);
        const blobUrl = URL.createObjectURL(result.blob);
        state.pageImages[page] = { imageData: result.imageData, blob: result.blob, blobUrl };
      }

      const lines = await ocrPage(state.pageImages[page].blob);
      state.ocrData[page] = lines;

      // Persist OCR data to IndexedDB
      await savePage(state.docId, page, { ocrLines: state.ocrData[page] });

      if (statusEl) statusEl.textContent = `OCR: page ${page}/${state.pageCount} done`;
    } catch (e) {
      showToast(`OCR error on page ${page}: ${e.message}`, "error");
    }
  }

  state.ocrReady = true;
  if (statusEl) statusEl.textContent = "OCR complete";
  showToast("OCR complete — ready to detect redactions", "success");
  if (detectBtn) detectBtn.disabled = false;
}

if (detectBtn) {
  detectBtn.addEventListener("click", () => {
    detectBtn.disabled = true;
    detectBtn.textContent = "Detecting...";
    runAnalysis();
  });
}

// ── Marquee-based analysis ──

setOnAnalyze(async (m) => {
    const page = state.currentPage;
    if (!state.pageImages?.[page]) {
        showToast("Page not loaded yet", "error");
        return;
    }

    const imageData = state.pageImages[page].imageData;

    // Auto-detect redaction box within the marquee
    const box = findRedactionInRegion(
        imageData,
        Math.round(m.x), Math.round(m.y),
        Math.round(m.x + m.w), Math.round(m.y + m.h),
        0
    );
    if (!box) {
        showToast("No redaction found in selection", "error");
        return;
    }

    // Show detected box on marquee
    m.detectedBox = box;
    renderCanvas();

    // Crop the marquee region to grayscale
    const cropX = Math.round(m.x);
    const cropY = Math.round(m.y);
    const cropW = Math.min(Math.round(m.w), imageData.width - cropX);
    const cropH = Math.min(Math.round(m.h), imageData.height - cropY);
    const cropGray = cropToGrayscale(imageData, cropX, cropY, cropW, cropH);

    // Redaction box position relative to the crop
    const relBox = {
        x: box.x - cropX,
        y: box.y - cropY,
        w: box.w,
        h: box.h,
    };

    // Split OCR text into left/right of the redaction box
    const ocrLines = (state.ocrData?.[page]) || [];
    let leftText = '';
    let rightText = '';

    let bestLine = null;
    let bestOverlap = 0;
    for (const line of ocrLines) {
        const overlap = Math.max(0,
            Math.min(box.y + box.h, line.y + line.h) - Math.max(box.y, line.y)
        );
        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestLine = line;
        }
    }

    if (bestLine?.chars) {
        const leftChars = bestLine.chars.filter(c => c.x + c.w / 2 < box.x);
        const rightChars = bestLine.chars.filter(c => c.x + c.w / 2 > box.x + box.w);
        leftText = leftChars.map(c => c.text).join('').trim();
        rightText = rightChars.map(c => c.text).join('').trim();
    }

    // LLM boundary text if API key available
    const apiKey = await getSetting('anthropic_api_key');
    if (apiKey && bestLine) {
        try {
            const boundary = await identifyBoundaryText(bestLine, box.x, box.w, apiKey);
            leftText = boundary.leftText;
            rightText = boundary.rightText;
        } catch (_e) {
            // Keep OCR-based text
        }
    }

    // Run font detection
    const candidates = state.fonts.filter(f => f.available).map(f => f.name);
    showToast("Detecting font...", "info");
    const match = detectFontMarquee(cropGray, cropW, cropH, relBox, leftText, rightText, candidates);

    const fontId = (state.fonts.find(f => f.name === match.fontName) || {}).id
        || match.fontName.toLowerCase().replace(/\s+/g, '-');

    const id = `p${page}-r${box.x}-${box.y}-${box.w}-${box.h}`;
    const analysis = {
        font: { id: fontId, name: match.fontName, size: match.fontSize },
        gap: { x: box.x, y: box.y, w: box.w, h: box.h },
        line: bestLine
            ? { text: bestLine.text, x: bestLine.x, y: bestLine.y, w: bestLine.w, h: bestLine.h }
            : { text: '', x: box.x, y: box.y, w: box.w, h: box.h },
        segments: [
            { text: leftText, side: 'left' },
            { text: rightText, side: 'right' },
        ],
        offset_x: match.xOffset,
        offset_y: match.yOffset,
    };

    state.redactions[id] = {
        id,
        x: box.x, y: box.y, w: box.w, h: box.h,
        page,
        status: "analyzed",
        analysis,
        solution: null,
        preview: null,
        overrides: {
            fontId,
            fontSize: match.fontSize,
            offsetX: match.xOffset,
            offsetY: match.yOffset,
            gapWidth: box.w,
            leftText,
            rightText,
        },
    };

    clearMarquee();
    renderRedactionList();
    renderCanvas();
    activateRedaction(id);
    showToast(`Font: ${match.fontName} ${match.fontSize.toFixed(1)}px (score: ${match.score.toFixed(3)})`, "success");
});

// ── Page loading ──

async function loadPage(page) {
  state.currentPage = page;
  state.activeRedaction = null;
  closePopover();
  updatePageControls();

  // Render page if not cached
  if (!state.pageImages[page]) {
    const result = await renderPage(state.pdfDoc, page);
    const blobUrl = URL.createObjectURL(result.blob);
    state.pageImages[page] = { imageData: result.imageData, blob: result.blob, blobUrl };
  }

  docImage.src = state.pageImages[page].blobUrl;

  // Load redactions from in-memory state
  loadPageRedactions(page);
}

/**
 * Re-render redaction list and canvas from in-memory state.
 * @param {number} pageNum
 */
function loadPageRedactions(pageNum) {
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
  } else if (isMobile() && state.activeRedaction) {
    state.activeRedaction = null;
    closePopover();
    renderRedactionList();
    renderCanvas();
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

// ── Document list & session resume ──

function renderDocList(docs) {
  const list = document.getElementById('doc-list');
  if (!docs.length) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = '<h3>Previous Documents</h3>';
  for (const doc of docs.sort((a, b) => b.createdAt - a.createdAt)) {
    const div = document.createElement('div');
    div.className = 'doc-list-item';

    const info = document.createElement('span');
    info.className = 'doc-info';
    info.textContent = doc.name;

    const date = document.createElement('span');
    date.className = 'doc-date';
    date.textContent = new Date(doc.createdAt).toLocaleDateString();

    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'doc-resume-btn';
    resumeBtn.textContent = 'Resume';
    resumeBtn.addEventListener('click', () => resumeDocument(doc.docId));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'doc-delete-btn';
    deleteBtn.textContent = '\u00d7';
    deleteBtn.title = 'Delete';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteDocument(doc.docId);
      const updated = await listDocuments();
      renderDocList(updated);
    });

    div.appendChild(info);
    div.appendChild(date);
    div.appendChild(resumeBtn);
    div.appendChild(deleteBtn);
    list.appendChild(div);
  }
}

async function resumeDocument(docId) {
  uploadSection.innerHTML = '<p class="loading">Resuming session...</p>';

  const wasmPromise = initWasm();
  const ocrPromise = initOcr();
  const fontPromise = loadFonts();
  const assocPromise = loadAssociates();

  // Load document metadata
  const doc = await getDocument(docId);
  state.docId = docId;
  state.pageCount = doc.pageCount;
  state.currentPage = 1;
  state.pageImages = {};
  state.ocrData = {};

  // Re-load the PDF from saved blob
  if (doc.pdfBlob) {
    const buffer = await doc.pdfBlob.arrayBuffer();
    const { doc: pdfDoc } = await loadPdf(buffer);
    state.pdfDoc = pdfDoc;
  }

  await Promise.all([wasmPromise, ocrPromise, fontPromise, assocPromise]);

  // Restore saved page data
  for (let page = 1; page <= state.pageCount; page++) {
    const pageData = await getPage(docId, page);
    if (pageData) {
      if (pageData.ocrLines) state.ocrData[page] = pageData.ocrLines;
      if (pageData.redactions) {
        for (const r of pageData.redactions) {
          state.redactions[r.id] = { ...r, page, solution: r.solution || null, preview: null };
        }
      }
    }
  }

  // Check if OCR was completed for all pages
  state.ocrReady = Object.keys(state.ocrData).length >= state.pageCount;
  if (state.ocrReady && detectBtn) detectBtn.disabled = false;

  uploadSection.hidden = true;
  viewerSection.hidden = false;

  await loadPage(1);

  renderRedactionList();
  renderCanvas();
  showToast("Session resumed", "success");
}

async function init() {
  const docs = await listDocuments();
  if (docs.length > 0) {
    renderDocList(docs);
  }
}

// ── Initialize all modules ──

setOnPopoverClose(() => {
  stopSolve();
  if (isMobile()) {
    switchSheetTab('list');
    setSheetSnap('peek');
  }
});
initViewport();
initMarquee();
initPopover();
initSolver();

// ── Initialize sheet and tabs ──
initSheetTabs();
initSheetDrag();
handleLayoutChange();
initSettings({
  onFontAdded(font) {
    state.fonts.push({ ...font, available: true, source: 'user' });
    refreshFontSelect();
  },
  onFontRemoved(fontId) {
    state.fonts = state.fonts.filter(f => f.id !== fontId);
    refreshFontSelect();
  },
});

init();
