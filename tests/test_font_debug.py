"""Tests for font matching debug utilities."""

import os
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

from unredact.pipeline.font_debug import (
    debug_enabled,
    init_debug_dir,
    render_candidate_composite,
    render_summary_image,
)


class TestDebugEnabled:
    def test_disabled_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("UNREDACT_DEBUG", None)
            assert debug_enabled() is False

    def test_enabled_with_env_var(self):
        with patch.dict(os.environ, {"UNREDACT_DEBUG": "1"}):
            assert debug_enabled() is True

    def test_disabled_with_zero(self):
        with patch.dict(os.environ, {"UNREDACT_DEBUG": "0"}):
            assert debug_enabled() is False


class TestInitDebugDir:
    def test_creates_timestamped_dir(self, tmp_path):
        result = init_debug_dir(base=tmp_path)
        assert result.exists()
        assert result.parent == tmp_path
        assert result.name.startswith("font-match-")

    def test_returns_path(self, tmp_path):
        result = init_debug_dir(base=tmp_path)
        assert isinstance(result, Path)


class TestRenderCandidateComposite:
    def test_returns_rgb_image(self):
        page_bin = np.zeros((20, 100), dtype=bool)
        rendered_bin = np.zeros((20, 100), dtype=bool)
        result = render_candidate_composite(
            page_bin, rendered_bin,
            font_name="Arial", font_size=14, score=0.85, rank=1,
        )
        assert isinstance(result, Image.Image)
        assert result.mode == "RGB"

    def test_image_height_includes_header_and_rows(self):
        page_bin = np.zeros((20, 100), dtype=bool)
        rendered_bin = np.zeros((20, 100), dtype=bool)
        result = render_candidate_composite(
            page_bin, rendered_bin,
            font_name="Arial", font_size=14, score=0.85, rank=1,
        )
        # Header (20) + 3 rows of (20 + 2*2 padding) = 20 + 72 = 92
        assert result.height > 20 * 3

    def test_overlap_colors(self):
        page_bin = np.zeros((20, 100), dtype=bool)
        rendered_bin = np.zeros((20, 100), dtype=bool)
        page_bin[5, 50] = True
        rendered_bin[5, 50] = True
        page_bin[10, 50] = True
        rendered_bin[15, 50] = True

        result = render_candidate_composite(
            page_bin, rendered_bin,
            font_name="Test", font_size=12, score=0.5, rank=1,
        )
        assert result is not None


class TestRenderSummaryImage:
    def test_tiles_horizontally(self):
        imgs = [Image.new("RGB", (100, 80), (i * 50, 0, 0)) for i in range(3)]
        result = render_summary_image(imgs)
        assert result.width == 100 * 3 + 2 * 2  # 2px gap between
        assert result.height == 80

    def test_single_image(self):
        imgs = [Image.new("RGB", (100, 80))]
        result = render_summary_image(imgs)
        assert result.width == 100
        assert result.height == 80

    def test_handles_different_heights(self):
        imgs = [Image.new("RGB", (100, 60)), Image.new("RGB", (100, 80))]
        result = render_summary_image(imgs)
        assert result.height == 80
