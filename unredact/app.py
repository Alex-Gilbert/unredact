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

from unredact.pipeline.ocr import ocr_page
from unredact.pipeline.rasterize import rasterize_pdf
from unredact.pipeline.font_detect import CANDIDATE_FONTS, _find_font_path
from unredact.pipeline.analyze_page import analyze_page
from unredact.pipeline.detect_redactions import spot_redaction
from unredact.pipeline.solver import build_constraint, SolveResult
from unredact.pipeline.dictionary import solve_dictionary, solve_full_name_dictionary, solve_name_dictionary
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
            "analysis": None,
            "ocr_lines": None,
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


@app.get("/api/doc/{doc_id}/ocr")
async def ocr_doc(doc_id: str):
    """SSE endpoint that runs OCR on all pages and caches results."""
    doc = _docs.get(doc_id)
    if not doc:
        return JSONResponse({"error": "not found"}, status_code=404)

    async def event_generator():
        for page_num, pd in doc["pages"].items():
            if pd["ocr_lines"] is not None:
                yield json.dumps({
                    "event": "page_ocr_complete",
                    "page": page_num,
                    "num_lines": len(pd["ocr_lines"]),
                })
                continue

            page_img = pd["original"]
            try:
                lines = await asyncio.to_thread(ocr_page, page_img)
            except Exception as exc:
                yield json.dumps({
                    "event": "error",
                    "page": page_num,
                    "message": str(exc),
                })
                continue

            pd["ocr_lines"] = lines
            yield json.dumps({
                "event": "page_ocr_complete",
                "page": page_num,
                "num_lines": len(lines),
            })

        yield json.dumps({"event": "ocr_complete"})

    return EventSourceResponse(event_generator())


@app.get("/api/doc/{doc_id}/analyze")
async def analyze_doc(doc_id: str):
    """SSE endpoint that runs analysis on all pages and streams progress."""
    doc = _docs.get(doc_id)
    if not doc:
        return JSONResponse({"error": "not found"}, status_code=404)

    async def event_generator():
        for page_num, pd in doc["pages"].items():
            page_img = pd["original"]
            try:
                analysis = await analyze_page(page_img)
            except Exception as exc:
                yield json.dumps({
                    "event": "error",
                    "page": page_num,
                    "message": str(exc),
                })
                continue

            pd["analysis"] = analysis

            redactions_json = []
            for r in analysis.redactions:
                font_id = _make_font_id(r.font.font_name)
                segments = []
                if r.left_text:
                    segments.append({"text": r.left_text})
                if r.right_text:
                    segments.append({"text": r.right_text})

                redactions_json.append({
                    "id": r.box.id,
                    "x": r.box.x, "y": r.box.y,
                    "w": r.box.w, "h": r.box.h,
                })

            yield json.dumps({
                "event": "page_complete",
                "page": page_num,
                "redaction_count": len(analysis.redactions),
                "redactions": redactions_json,
            })

        yield json.dumps({"event": "done"})

    return EventSourceResponse(event_generator())


@app.get("/api/doc/{doc_id}/page/{page}/data")
async def get_page_data(doc_id: str, page: int):
    doc = _docs.get(doc_id)
    if not doc or page not in doc["pages"]:
        return JSONResponse({"error": "not found"}, status_code=404)

    pd = doc["pages"][page]
    analysis = pd.get("analysis")
    if analysis is None:
        return {"redactions": []}

    redactions_json = []
    for r in analysis.redactions:
        font_id = _make_font_id(r.font.font_name)
        segments = []
        if r.left_text:
            segments.append({"text": r.left_text})
        if r.right_text:
            segments.append({"text": r.right_text})

        redactions_json.append({
            "id": r.box.id,
            "x": r.box.x, "y": r.box.y,
            "w": r.box.w, "h": r.box.h,
            "analysis": {
                "segments": segments,
                "gap": {"x": r.box.x, "w": r.box.w},
                "font": {
                    "name": r.font.font_name,
                    "id": font_id,
                    "size": r.font.font_size,
                    "score": r.font.score,
                },
                "line": {
                    "x": r.line.x,
                    "y": r.line.y,
                    "w": r.line.w,
                    "h": r.line.h,
                    "text": r.line.text,
                },
                "offset_x": r.offset_x,
                "offset_y": r.offset_y,
            },
        })

    return {"redactions": redactions_json}


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
    mode: str = "name"  # "name", "full_name", "email", "enumerate"
    word_filter: str = "none"  # only used for enumerate mode
    known_start: str = ""
    known_end: str = ""


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

    solve_id = uuid_mod.uuid4().hex[:12]
    _active_solves[solve_id] = False

    async def event_generator():
        try:
            found_texts = set()
            charset_name = req.hints.get("charset", "lowercase")

            # Name mode: single-word associate names
            if req.mode == "name" and not _active_solves.get(solve_id):
                name_results = solve_name_dictionary(
                    font, req.gap_width_px, req.tolerance_px,
                    req.left_context, req.right_context,
                    casing=charset_name,
                    known_start=req.known_start,
                    known_end=req.known_end,
                )
                for r in name_results:
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
                        "source": "names",
                    })

            # Full name mode: first x last Cartesian product + variants
            if req.mode == "full_name" and not _active_solves.get(solve_id):
                fn_results = solve_full_name_dictionary(
                    font, req.gap_width_px, req.tolerance_px,
                    req.left_context, req.right_context,
                    casing=charset_name,
                    known_start=req.known_start,
                    known_end=req.known_end,
                )
                for r in fn_results:
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
                        "source": "names",
                    })

            # Email mode
            if req.mode == "email" and not _active_solves.get(solve_id):
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

            # Enumerate mode: Rust backend
            if req.mode == "enumerate" and not _active_solves.get(solve_id):
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
                payload["filter_prefix"] = req.known_start
                payload["filter_suffix"] = req.known_end
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



@app.get("/api/associates")
async def get_associates():
    return _get_associates()


@app.post("/api/doc/{doc_id}/page/{page}/spot")
async def spot(doc_id: str, page: int, data: dict):
    doc = _docs.get(doc_id)
    if not doc or page not in doc["pages"]:
        return JSONResponse({"error": "not found"}, status_code=404)
    click_x = int(data["x"])
    click_y = int(data["y"])
    page_img = doc["pages"][page]["original"]
    result = spot_redaction(page_img, click_x, click_y)
    if result is None:
        return JSONResponse({"error": "no redaction found"}, status_code=404)
    return {"id": result.id, "x": result.x, "y": result.y, "w": result.w, "h": result.h}


# Static files mount MUST be after all route definitions
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
