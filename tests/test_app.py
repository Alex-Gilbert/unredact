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
async def test_get_page_overlay(pdf_bytes: bytes):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Upload first
        resp = await client.post(
            "/api/upload",
            files={"file": ("test.pdf", pdf_bytes, "application/pdf")},
        )
        doc_id = resp.json()["doc_id"]

        # Get page 1 overlay
        resp = await client.get(f"/api/doc/{doc_id}/page/1/overlay")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/png"
        assert len(resp.content) > 1000  # Should be a real image


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
async def test_get_page_data(pdf_bytes: bytes):
    """Should return OCR data and font info as JSON."""
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
        assert "lines" in data
        assert len(data["lines"]) > 0
        # Each line should have its own font info
        line = data["lines"][0]
        assert "font" in line
        assert line["font"]["name"]
        assert line["font"]["id"]  # new: url-safe slug
        assert line["font"]["size"] > 0


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
