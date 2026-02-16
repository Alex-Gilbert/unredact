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
        assert line["font"]["size"] > 0
