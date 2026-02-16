import asyncio
import io
import json
import re
import uuid
import uuid as uuid_mod
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import FastAPI, UploadFile
from fastapi.responses import RedirectResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from PIL import Image, ImageFont
from sse_starlette.sse import EventSourceResponse

from unredact.pipeline.rasterize import rasterize_pdf
from unredact.pipeline.ocr import ocr_page
from unredact.pipeline.font_detect import detect_fonts, CANDIDATE_FONTS, _find_font_path
from unredact.pipeline.overlay import render_overlay
from unredact.pipeline.solver import solve_gap_parallel
from unredact.pipeline.dictionary import DictionaryStore, solve_dictionary
from unredact.pipeline.width_table import CHARSETS

app = FastAPI(title="Unredact")

# In-memory store for uploaded docs (local-only tool, no persistence needed)
_docs: dict[str, dict] = {}

STATIC_DIR = Path(__file__).parent / "static"


def _make_font_id(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


# Build font lookup at module level
_font_id_to_path: dict[str, Path] = {}
_font_list: list[dict] = []

for _name in CANDIDATE_FONTS:
    _fid = _make_font_id(_name)
    _path = _find_font_path(_name)
    if _path:
        _font_id_to_path[_fid] = _path
    _font_list.append({"name": _name, "id": _fid, "available": _path is not None})


@app.get("/")
async def root():
    return RedirectResponse("/static/index.html")


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


@app.get("/api/fonts")
async def list_fonts():
    return {"fonts": _font_list}


@app.get("/api/font/{font_id}")
async def get_font(font_id: str):
    path = _font_id_to_path.get(font_id)
    if not path:
        return JSONResponse({"error": "font not found"}, status_code=404)
    return Response(content=path.read_bytes(), media_type="font/ttf")


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
                "id": _make_font_id(fm.font_name),
                "size": fm.font_size,
                "score": fm.score,
            },
        })

    return {"lines": lines_json}


# In-memory dictionary store
_dictionary_store = DictionaryStore()

# Active solve tasks (for cancellation)
_active_solves: dict[str, bool] = {}


class SolveRequest(BaseModel):
    font_id: str
    font_size: int
    gap_width_px: float
    tolerance_px: float = 0.0
    left_context: str = ""
    right_context: str = ""
    hints: dict = {}
    mode: str = "enumerate"


@app.post("/api/solve")
async def solve(req: SolveRequest):
    font_path = _font_id_to_path.get(req.font_id)
    if not font_path:
        return JSONResponse({"error": "font not found"}, status_code=404)

    font = ImageFont.truetype(str(font_path), req.font_size)
    charset_name = req.hints.get("charset", "lowercase")
    charset = CHARSETS.get(charset_name, charset_name)
    min_length = req.hints.get("min_length", 1)
    max_length = req.hints.get("max_length", 10)

    solve_id = uuid_mod.uuid4().hex[:12]
    _active_solves[solve_id] = False

    async def event_generator():
        try:
            found_texts = set()

            if req.mode in ("dictionary", "both"):
                entries = _dictionary_store.all_entries()
                if entries:
                    dict_results = solve_dictionary(
                        font, entries, req.gap_width_px, req.tolerance_px,
                        req.left_context, req.right_context,
                    )
                    for r in dict_results:
                        if _active_solves.get(solve_id):
                            break
                        found_texts.add(r.text)
                        yield json.dumps({
                            "status": "match",
                            "text": r.text,
                            "width_px": round(r.width, 2),
                            "error_px": round(r.error, 2),
                            "source": "dictionary",
                        })

            if req.mode in ("enumerate", "both") and not _active_solves.get(solve_id):
                loop = asyncio.get_event_loop()
                results = await loop.run_in_executor(
                    None,
                    lambda: solve_gap_parallel(
                        font=font,
                        charset=charset,
                        target_width=req.gap_width_px,
                        tolerance=req.tolerance_px,
                        min_length=min_length,
                        max_length=max_length,
                        left_context=req.left_context,
                        right_context=req.right_context,
                    ),
                )
                for r in results:
                    if _active_solves.get(solve_id):
                        break
                    if r.text in found_texts:
                        continue
                    found_texts.add(r.text)
                    yield json.dumps({
                        "status": "match",
                        "text": r.text,
                        "width_px": round(r.width, 2),
                        "error_px": round(r.error, 2),
                        "source": "enumerate",
                    })

            yield json.dumps({
                "status": "done",
                "total_found": len(found_texts),
            })
        finally:
            _active_solves.pop(solve_id, None)

    return EventSourceResponse(event_generator(), headers={"X-Solve-Id": solve_id})


@app.delete("/api/solve/{solve_id}")
async def cancel_solve(solve_id: str):
    if solve_id in _active_solves:
        _active_solves[solve_id] = True
        return {"status": "cancelled"}
    return JSONResponse({"error": "solve not found"}, status_code=404)


@app.post("/api/dictionary")
async def upload_dictionary(data: dict):
    name = data.get("name", "")
    entries = data.get("entries", [])
    if not name or not entries:
        return JSONResponse({"error": "name and entries required"}, status_code=400)
    _dictionary_store.add(name, entries)
    return {"status": "ok", "count": len(entries)}


@app.get("/api/dictionary")
async def list_dictionaries():
    return {"dictionaries": _dictionary_store.list()}


@app.delete("/api/dictionary/{name}")
async def delete_dictionary(name: str):
    _dictionary_store.remove(name)
    return {"status": "ok"}


# Static files mount MUST be after all route definitions
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
