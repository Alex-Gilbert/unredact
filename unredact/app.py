import asyncio
import io
import json
import os
import re
import uuid
import uuid as uuid_mod
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
from fastapi import FastAPI, UploadFile
from fastapi.responses import RedirectResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from PIL import Image, ImageFont
from sse_starlette.sse import EventSourceResponse

from unredact.pipeline.rasterize import rasterize_pdf
from unredact.pipeline.detect_redactions import spot_redaction
from unredact.pipeline.ocr import ocr_page
from unredact.pipeline.font_detect import detect_font_for_line, CANDIDATE_FONTS, _find_font_path
from unredact.pipeline.solver import build_constraint, SolveResult
from unredact.pipeline.dictionary import DictionaryStore, solve_dictionary
from unredact.pipeline.word_filter import _get_emails
from unredact.pipeline.width_table import build_width_table, CHARSETS

app = FastAPI(title="Unredact")

SOLVER_URL = os.environ.get("SOLVER_URL", "http://127.0.0.1:3100")

# In-memory store for uploaded docs (local-only tool, no persistence needed)
_docs: dict[str, dict] = {}

STATIC_DIR = Path(__file__).parent / "static"
DATA_DIR = Path(__file__).parent / "data"

# Lazy-loaded associates data
_associates_data: dict | None = None

def _get_associates() -> dict:
    global _associates_data
    if _associates_data is None:
        associates_path = DATA_DIR / "associates.json"
        if associates_path.exists():
            _associates_data = json.loads(associates_path.read_text())
        else:
            _associates_data = {"names": {}, "persons": {}}
    return _associates_data


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

    page_data = {}
    for i, page_img in enumerate(pages, start=1):
        page_data[i] = {
            "original": page_img,
            "redactions": [],
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
    redactions_json = [
        {"id": r.id, "x": r.x, "y": r.y, "w": r.w, "h": r.h}
        for r in pd["redactions"]
    ]
    return {"redactions": redactions_json}


class AnalyzeRequest(BaseModel):
    doc_id: str
    page: int
    redaction: dict  # {x, y, w, h}


def _run_analysis(page_img: Image.Image, rx: int, ry: int, rw: int, rh: int) -> dict | None:
    """Run OCR + font detection for a redaction box. Returns analysis dict or None."""
    pad_y = rh
    crop_y1 = max(0, ry - pad_y)
    crop_y2 = min(page_img.height, ry + rh + pad_y)
    line_crop = page_img.crop((0, crop_y1, page_img.width, crop_y2))

    lines = ocr_page(line_crop)
    if not lines:
        return None

    redaction_cy = (ry - crop_y1) + rh / 2
    best_line = min(lines, key=lambda l: abs((l.y + l.h / 2) - redaction_cy))

    font_match = detect_font_for_line(best_line, line_crop)

    segments = []
    gap = {"x": rx, "w": rw}

    left_chars = [c for c in best_line.chars if c.x + c.w <= rx]
    right_chars = [c for c in best_line.chars if c.x >= rx + rw]

    left_text = "".join(c.text for c in left_chars).rstrip()
    right_text = "".join(c.text for c in right_chars).lstrip()

    pil_font = font_match.to_pil_font()
    if left_text:
        left_rendered_width = pil_font.getlength(left_text)
        offset_x = float(rx - left_rendered_width - best_line.x)
    else:
        offset_x = 0.0
    offset_y = 0.0

    if left_text:
        lx = left_chars[0].x
        lw = (left_chars[-1].x + left_chars[-1].w) - lx
        segments.append({"text": left_text, "x": lx, "w": lw})
    if right_text:
        rx2 = right_chars[0].x
        rw2 = (right_chars[-1].x + right_chars[-1].w) - rx2
        segments.append({"text": right_text, "x": rx2, "w": rw2})

    chars_json = [
        {"text": c.text, "x": c.x, "y": c.y + crop_y1, "w": c.w, "h": c.h, "conf": c.conf}
        for c in best_line.chars
    ]

    return {
        "segments": segments,
        "gap": gap,
        "font": {
            "name": font_match.font_name,
            "id": _make_font_id(font_match.font_name),
            "size": font_match.font_size,
            "score": font_match.score,
        },
        "line": {
            "x": best_line.x,
            "y": best_line.y + crop_y1,
            "w": best_line.w,
            "h": best_line.h,
            "text": best_line.text,
        },
        "chars": chars_json,
        "offset_x": round(offset_x, 1),
        "offset_y": round(offset_y, 1),
    }


@app.post("/api/redaction/analyze")
async def analyze_redaction(req: AnalyzeRequest):
    doc = _docs.get(req.doc_id)
    if not doc or req.page not in doc["pages"]:
        return JSONResponse({"error": "not found"}, status_code=404)

    page_img = doc["pages"][req.page]["original"]
    rx, ry, rw, rh = req.redaction["x"], req.redaction["y"], req.redaction["w"], req.redaction["h"]

    result = _run_analysis(page_img, rx, ry, rw, rh)
    if result is None:
        return JSONResponse({"error": "no text detected near redaction"}, status_code=422)
    return result


class SpotRequest(BaseModel):
    doc_id: str
    page: int
    click_x: int
    click_y: int


@app.post("/api/redaction/spot")
async def spot_redaction_endpoint(req: SpotRequest):
    doc = _docs.get(req.doc_id)
    if not doc or req.page not in doc["pages"]:
        return JSONResponse({"error": "not found"}, status_code=404)

    page_img = doc["pages"][req.page]["original"]
    redaction = spot_redaction(page_img, req.click_x, req.click_y)
    if redaction is None:
        return JSONResponse({"error": "no_redaction_found"}, status_code=422)

    result = _run_analysis(page_img, redaction.x, redaction.y, redaction.w, redaction.h)
    response = {"box": {"x": redaction.x, "y": redaction.y, "w": redaction.w, "h": redaction.h}}
    if result:
        response.update(result)
    return response


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
    word_filter: str = "none"  # "none", "words", "names", "both"
    filter_prefix: str = ""
    filter_suffix: str = ""


def _build_rust_solve_payload(
    font: ImageFont.FreeTypeFont,
    charset: str,
    target_width: float,
    tolerance: float,
    left_context: str,
    right_context: str,
    constraint=None,
) -> dict:
    """Build the JSON payload for the Rust /solve endpoint."""
    wt = build_width_table(font, charset, left_context, right_context)
    payload = {
        "charset": charset,
        "width_table": wt.width_table.flatten().tolist(),
        "left_edge": wt.left_edge.tolist(),
        "right_edge": wt.right_edge.tolist(),
        "target": float(target_width),
        "tolerance": float(tolerance),
    }
    if constraint is not None:
        payload["state_allowed"] = constraint.state_allowed
        payload["state_next"] = constraint.state_next
        payload["accept_states"] = sorted(constraint.accept_states)
    return payload


def _build_rust_full_name_payload(
    font: ImageFont.FreeTypeFont,
    target_width: float,
    tolerance: float,
    left_context: str,
    right_context: str,
    uppercase_only: bool,
) -> dict:
    """Build the JSON payload for the Rust /solve/full-name endpoint."""
    word_charset = CHARSETS["uppercase"] if uppercase_only else CHARSETS["alpha"]
    wt1 = build_width_table(font, word_charset, left_context, "")
    wt2 = build_width_table(font, word_charset, "", right_context)

    n = len(word_charset)
    space_advance = []
    for c in word_charset:
        space_advance.append(font.getlength(c + " ") - font.getlength(c))
    space_base = font.getlength(" ")
    left_after_space = []
    for c in word_charset:
        left_after_space.append(font.getlength(" " + c) - space_base)

    return {
        "word_charset": word_charset,
        "wt1_table": wt1.width_table.flatten().tolist(),
        "wt1_left_edge": wt1.left_edge.tolist(),
        "wt1_right_edge": wt1.right_edge.tolist(),
        "wt2_table": wt2.width_table.flatten().tolist(),
        "wt2_right_edge": wt2.right_edge.tolist(),
        "space_advance": space_advance,
        "left_after_space": left_after_space,
        "target": float(target_width),
        "tolerance": float(tolerance),
        "uppercase_only": uppercase_only,
    }


@app.post("/api/solve")
async def solve(req: SolveRequest):
    font_path = _font_id_to_path.get(req.font_id)
    if not font_path:
        return JSONResponse({"error": "font not found"}, status_code=404)

    font = ImageFont.truetype(str(font_path), req.font_size)
    charset_name = req.hints.get("charset", "lowercase")

    use_full_name = charset_name in ("full_name_capitalized", "full_name_caps")

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

            if req.mode == "emails":
                entries = _get_emails()
                if entries:
                    email_results = solve_dictionary(
                        font, entries, req.gap_width_px, req.tolerance_px,
                        req.left_context, req.right_context,
                    )
                    for r in email_results:
                        if _active_solves.get(solve_id):
                            break
                        found_texts.add(r.text)
                        yield json.dumps({
                            "status": "match",
                            "text": r.text,
                            "width_px": round(r.width, 2),
                            "error_px": round(r.error, 2),
                            "source": "emails",
                        })

            if req.mode in ("enumerate", "both") and not _active_solves.get(solve_id):
                # Build payload and call Rust solver (streaming SSE)
                if use_full_name:
                    payload = _build_rust_full_name_payload(
                        font, req.gap_width_px, req.tolerance_px,
                        req.left_context, req.right_context,
                        uppercase_only=(charset_name == "full_name_caps"),
                    )
                    payload["filter"] = req.word_filter
                    payload["filter_prefix"] = req.filter_prefix
                    payload["filter_suffix"] = req.filter_suffix
                    url = f"{SOLVER_URL}/solve/full-name"
                else:
                    charset = CHARSETS.get(charset_name, charset_name)
                    constraint = None
                    if charset_name == "capitalized":
                        charset = CHARSETS["alpha"] + " "
                        constraint = build_constraint(charset_name, charset)
                    payload = _build_rust_solve_payload(
                        font, charset, req.gap_width_px, req.tolerance_px,
                        req.left_context, req.right_context, constraint,
                    )
                    payload["filter"] = req.word_filter
                    payload["filter_prefix"] = req.filter_prefix
                    payload["filter_suffix"] = req.filter_suffix
                    url = f"{SOLVER_URL}/solve"

                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream("POST", url, json=payload) as resp:
                        buf = ""
                        async for chunk in resp.aiter_text():
                            if _active_solves.get(solve_id):
                                break
                            buf += chunk
                            while "\n" in buf:
                                line, buf = buf.split("\n", 1)
                                line = line.strip()
                                if not line.startswith("data: "):
                                    continue
                                try:
                                    r = json.loads(line[6:])
                                except (json.JSONDecodeError, ValueError):
                                    continue
                                if r.get("done"):
                                    break
                                text = r.get("text", "")
                                if text in found_texts:
                                    continue
                                found_texts.add(text)
                                yield json.dumps({
                                    "status": "match",
                                    "text": text,
                                    "width_px": round(r["width"], 2),
                                    "error_px": round(r["error"], 2),
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


@app.get("/api/associates")
async def get_associates():
    return _get_associates()


# Static files mount MUST be after all route definitions
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
