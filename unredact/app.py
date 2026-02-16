import io
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import FastAPI, UploadFile
from fastapi.responses import RedirectResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from unredact.pipeline.rasterize import rasterize_pdf
from unredact.pipeline.ocr import ocr_page
from unredact.pipeline.font_detect import detect_fonts
from unredact.pipeline.overlay import render_overlay

app = FastAPI(title="Unredact")

# In-memory store for uploaded docs (local-only tool, no persistence needed)
_docs: dict[str, dict] = {}

STATIC_DIR = Path(__file__).parent / "static"


@app.get("/")
async def root():
    return RedirectResponse("/static/index.html")


if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


def _image_to_png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@app.post("/api/upload")
async def upload_pdf(file: UploadFile):
    content = await file.read()
    doc_id = uuid.uuid4().hex[:12]

    # Write to temp file for pdf2image
    tmp = TemporaryDirectory()
    pdf_path = Path(tmp.name) / "doc.pdf"
    pdf_path.write_bytes(content)

    pages = rasterize_pdf(pdf_path)

    # Process each page
    page_data = {}
    for i, page_img in enumerate(pages, start=1):
        lines = ocr_page(page_img)
        font_matches = detect_fonts(lines, page_img)
        overlay_img = render_overlay(page_img, lines, font_matches)
        page_data[i] = {
            "original": page_img,
            "overlay": overlay_img,
            "lines": lines,
            "font_matches": font_matches,
        }

    _docs[doc_id] = {
        "page_count": len(pages),
        "pages": page_data,
        "tmp": tmp,  # prevent cleanup
    }

    return {"doc_id": doc_id, "page_count": len(pages)}


@app.get("/api/doc/{doc_id}/page/{page}/original")
async def get_page_original(doc_id: str, page: int):
    doc = _docs.get(doc_id)
    if not doc or page not in doc["pages"]:
        return JSONResponse({"error": "not found"}, status_code=404)
    png = _image_to_png_bytes(doc["pages"][page]["original"])
    return Response(content=png, media_type="image/png")


@app.get("/api/doc/{doc_id}/page/{page}/overlay")
async def get_page_overlay(doc_id: str, page: int):
    doc = _docs.get(doc_id)
    if not doc or page not in doc["pages"]:
        return JSONResponse({"error": "not found"}, status_code=404)
    overlay = doc["pages"][page]["overlay"]
    # Convert RGBA to RGB for PNG output
    rgb = overlay.convert("RGB")
    png = _image_to_png_bytes(rgb)
    return Response(content=png, media_type="image/png")


@app.get("/api/doc/{doc_id}/page/{page}/data")
async def get_page_data(doc_id: str, page: int):
    doc = _docs.get(doc_id)
    if not doc or page not in doc["pages"]:
        return JSONResponse({"error": "not found"}, status_code=404)

    pd = doc["pages"][page]
    font_matches = pd["font_matches"]
    lines_json = []
    for line, fm in zip(pd["lines"], font_matches):
        chars_json = [
            {"text": c.text, "x": c.x, "y": c.y, "w": c.w, "h": c.h, "conf": c.conf}
            for c in line.chars
        ]
        lines_json.append({
            "text": line.text,
            "x": line.x, "y": line.y, "w": line.w, "h": line.h,
            "chars": chars_json,
            "font": {
                "name": fm.font_name,
                "size": fm.font_size,
                "score": fm.score,
            },
        })

    return {"lines": lines_json}
