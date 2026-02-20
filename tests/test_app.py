import io
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from unredact.app import app


@pytest.fixture
def pdf_bytes(sample_pdf: Path) -> bytes:
    return sample_pdf.read_bytes()


@pytest.mark.anyio
async def test_upload_pdf(pdf_bytes: bytes):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/upload",
            files={"file": ("test.pdf", pdf_bytes, "application/pdf")},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "doc_id" in data
        assert data["page_count"] > 0


@pytest.mark.anyio
async def test_get_page_original(pdf_bytes: bytes):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/upload",
            files={"file": ("test.pdf", pdf_bytes, "application/pdf")},
        )
        doc_id = resp.json()["doc_id"]

        resp = await client.get(f"/api/doc/{doc_id}/page/1/original")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/png"


@pytest.mark.anyio
async def test_ocr_endpoint_streams_results(pdf_bytes: bytes):
    """GET /api/doc/{id}/ocr should stream OCR progress and cache results."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/upload",
            files={"file": ("test.pdf", pdf_bytes, "application/pdf")},
        )
        doc_id = resp.json()["doc_id"]

        resp = await client.get(f"/api/doc/{doc_id}/ocr")
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")


@pytest.mark.anyio
async def test_get_page_data_returns_redactions(pdf_bytes: bytes):
    """Page data should return redaction bboxes, not OCR lines."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/upload",
            files={"file": ("test.pdf", pdf_bytes, "application/pdf")},
        )
        doc_id = resp.json()["doc_id"]

        resp = await client.get(f"/api/doc/{doc_id}/page/1/data")
        assert resp.status_code == 200
        data = resp.json()
        assert "redactions" in data
        assert isinstance(data["redactions"], list)
        if data["redactions"]:
            r = data["redactions"][0]
            assert "id" in r
            assert "x" in r
            assert "y" in r
            assert "w" in r
            assert "h" in r


@pytest.mark.anyio
async def test_redaction_analyze(pdf_bytes: bytes):
    """POST /api/redaction/analyze should OCR the line around a redaction."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/upload",
            files={"file": ("test.pdf", pdf_bytes, "application/pdf")},
        )
        doc_id = resp.json()["doc_id"]

        resp = await client.get(f"/api/doc/{doc_id}/page/1/data")
        redactions = resp.json()["redactions"]
        if not redactions:
            pytest.skip("No redactions detected in test PDF")

        r = redactions[0]

        resp = await client.post("/api/redaction/analyze", json={
            "doc_id": doc_id,
            "page": 1,
            "redaction": {"x": r["x"], "y": r["y"], "w": r["w"], "h": r["h"]},
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "segments" in data
        assert "gap" in data
        assert "font" in data
        assert data["gap"]["w"] > 0
        assert data["font"]["name"]
        assert data["font"]["size"] > 0
        assert "offset_x" in data
        assert "offset_y" in data
        assert isinstance(data["offset_x"], (int, float))
        assert isinstance(data["offset_y"], (int, float))


@pytest.mark.anyio
async def test_list_fonts():
    """GET /api/fonts should return list of candidate fonts."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/fonts")
        assert resp.status_code == 200
        data = resp.json()
        assert "fonts" in data
        assert len(data["fonts"]) > 0
        font = data["fonts"][0]
        assert "name" in font
        assert "id" in font
        assert "available" in font
        # At least one font should be available on the system
        assert any(f["available"] for f in data["fonts"])


@pytest.mark.anyio
async def test_get_font_ttf():
    """GET /api/font/{id} should serve a TTF file."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Get list first to find an available font
        resp = await client.get("/api/fonts")
        fonts = resp.json()["fonts"]
        available = [f for f in fonts if f["available"]]
        assert available, "No fonts available on system"

        font_id = available[0]["id"]
        resp = await client.get(f"/api/font/{font_id}")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "font/ttf"
        # TTF files start with specific bytes or have substantial size
        assert len(resp.content) > 1000


@pytest.mark.anyio
async def test_get_font_not_found():
    """GET /api/font/{id} with bad id should 404."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/font/nonexistent-font")
        assert resp.status_code == 404


@pytest.mark.anyio
async def test_solve_endpoint_enumerate():
    """POST /api/solve should stream SSE results."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/fonts")
        fonts = resp.json()["fonts"]
        font = next(f for f in fonts if f["available"])

        resp = await client.post("/api/solve", json={
            "font_id": font["id"],
            "font_size": 40,
            "gap_width_px": 50.0,
            "tolerance_px": 5.0,
            "left_context": "",
            "right_context": "",
            "hints": {
                "charset": "lowercase",
            },
            "mode": "enumerate",
        })
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")


@pytest.mark.anyio
async def test_solve_endpoint_name_mode():
    """POST /api/solve with mode=name should work."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/fonts")
        fonts = resp.json()["fonts"]
        font = next(f for f in fonts if f["available"])

        resp = await client.post("/api/solve", json={
            "font_id": font["id"],
            "font_size": 40,
            "gap_width_px": 50.0,
            "tolerance_px": 5.0,
            "left_context": "",
            "right_context": "",
            "hints": {
                "charset": "lowercase",
            },
            "mode": "name",
        })
        assert resp.status_code == 200


@pytest.mark.anyio
async def test_get_associates():
    """GET /api/associates should return the associates lookup data."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/associates")
        assert resp.status_code == 200
        data = resp.json()
        assert "names" in data
        assert "persons" in data
        assert isinstance(data["names"], dict)
        assert isinstance(data["persons"], dict)


@pytest.mark.anyio
async def test_spot_returns_analysis(pdf_bytes: bytes):
    """POST /spot should return analysis data when OCR is cached."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/upload",
            files={"file": ("test.pdf", pdf_bytes, "application/pdf")},
        )
        doc_id = resp.json()["doc_id"]

        # Run OCR first (required for spot analysis)
        resp = await client.get(f"/api/doc/{doc_id}/ocr")
        assert resp.status_code == 200

        # Try to spot a redaction at an arbitrary position
        resp = await client.post(
            f"/api/doc/{doc_id}/page/1/spot",
            json={"x": 300, "y": 300},
        )
        if resp.status_code == 404:
            pytest.skip("No redaction found at test coordinates")

        data = resp.json()
        assert "id" in data
        assert "x" in data
        assert "analysis" in data
        # analysis should be present (or null if no OCR line matched)
        if data["analysis"] is not None:
            assert "font" in data["analysis"]
            assert "segments" in data["analysis"]
            assert "gap" in data["analysis"]
            assert "line" in data["analysis"]
