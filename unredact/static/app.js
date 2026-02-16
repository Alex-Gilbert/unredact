const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const uploadSection = document.getElementById("upload-section");
const viewerSection = document.getElementById("viewer-section");
const docImage = document.getElementById("doc-image");
const pageInfo = document.getElementById("page-info");
const prevBtn = document.getElementById("prev-page");
const nextBtn = document.getElementById("next-page");
const overlayToggle = document.getElementById("show-overlay");
const fontInfo = document.getElementById("font-info");

let state = {
  docId: null,
  pageCount: 0,
  currentPage: 1,
  pageData: {},
};

// Drag and drop
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

  const form = new FormData();
  form.append("file", file);

  const resp = await fetch("/api/upload", { method: "POST", body: form });
  const data = await resp.json();

  state.docId = data.doc_id;
  state.pageCount = data.page_count;
  state.currentPage = 1;

  uploadSection.hidden = true;
  viewerSection.hidden = false;

  await loadPage(1);
}

async function loadPage(page) {
  state.currentPage = page;
  updateControls();

  const showOverlay = overlayToggle.checked;
  const endpoint = showOverlay ? "overlay" : "original";
  docImage.src = `/api/doc/${state.docId}/page/${page}/${endpoint}`;

  // Load page data (font info, lines)
  if (!state.pageData[page]) {
    const resp = await fetch(`/api/doc/${state.docId}/page/${page}/data`);
    state.pageData[page] = await resp.json();
  }

  const pd = state.pageData[page];
  fontInfo.textContent = `${pd.font.name} ~${pd.font.size}px (score: ${pd.font.score.toFixed(1)})`;
}

function updateControls() {
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
overlayToggle.addEventListener("change", () => loadPage(state.currentPage));
