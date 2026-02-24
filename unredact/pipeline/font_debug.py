"""Font matching debug visualization.

When UNREDACT_DEBUG=1, saves visual comparisons of font candidates
to debug/font-match-<timestamp>/ in the project root.
"""

import os
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

PROJECT_ROOT = Path(__file__).parent.parent.parent

_HEADER_H = 20
_PAD = 2
_GAP = 2


def debug_enabled() -> bool:
    return os.environ.get("UNREDACT_DEBUG", "0") == "1"


def init_debug_dir(base: Path | None = None) -> Path:
    if base is None:
        base = PROJECT_ROOT / "debug"
    stamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    d = base / f"font-match-{stamp}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def render_candidate_composite(
    page_bin: np.ndarray,
    rendered_bin: np.ndarray,
    font_name: str,
    font_size: int,
    score: float,
    rank: int,
) -> Image.Image:
    """Build a composite debug image for one font candidate.

    Layout (vertical stack):
    - Header: rank, font name, size, score
    - Row 1: page crop (white ink on black)
    - Row 2: rendered candidate (white ink on black)
    - Row 3: overlap map (green=both, red=page-only, blue=rendered-only)
    """
    h, w = page_bin.shape

    row_h = h + _PAD * 2
    total_h = _HEADER_H + row_h * 3
    img = Image.new("RGB", (w, total_h), (30, 30, 30))
    draw = ImageDraw.Draw(img)

    # Header
    header = f"#{rank}  {font_name}  {font_size}px  score={score:.3f}"
    draw.text((4, 2), header, fill=(255, 255, 255))

    # Row 1: page crop
    y_off = _HEADER_H + _PAD
    page_rgb = np.zeros((h, w, 3), dtype=np.uint8)
    page_rgb[page_bin] = [255, 255, 255]
    img.paste(Image.fromarray(page_rgb), (0, y_off))

    # Row 2: rendered candidate
    y_off += row_h
    rend_rgb = np.zeros((h, w, 3), dtype=np.uint8)
    rend_rgb[rendered_bin] = [255, 255, 255]
    img.paste(Image.fromarray(rend_rgb), (0, y_off))

    # Row 3: overlap map
    y_off += row_h
    overlap_rgb = np.zeros((h, w, 3), dtype=np.uint8)
    both = page_bin & rendered_bin
    page_only = page_bin & ~rendered_bin
    rend_only = ~page_bin & rendered_bin
    overlap_rgb[both] = [0, 200, 0]        # green = match
    overlap_rgb[page_only] = [220, 50, 50]  # red = missing from render
    overlap_rgb[rend_only] = [50, 100, 220] # blue = extra in render
    img.paste(Image.fromarray(overlap_rgb), (0, y_off))

    return img


def render_summary_image(composites: list[Image.Image]) -> Image.Image:
    """Tile candidate composites horizontally into a single summary image."""
    if not composites:
        return Image.new("RGB", (1, 1))
    max_h = max(img.height for img in composites)
    total_w = sum(img.width for img in composites) + _GAP * (len(composites) - 1)
    summary = Image.new("RGB", (total_w, max_h), (20, 20, 20))
    x = 0
    for img in composites:
        summary.paste(img, (x, 0))
        x += img.width + _GAP
    return summary


from unredact.pipeline.font_detect import _shift_2d


# Module-level debug state (set during a detection run)
_debug_ctx: dict | None = None


def start_debug_session() -> Path:
    """Start a debug session. Returns the debug directory."""
    global _debug_ctx
    d = init_debug_dir()
    _debug_ctx = {"dir": d, "line_idx": 0}
    return d


def end_debug_session():
    global _debug_ctx
    _debug_ctx = None


def get_debug_ctx() -> dict | None:
    return _debug_ctx


def next_line_idx() -> int:
    if _debug_ctx is None:
        return 0
    idx = _debug_ctx["line_idx"]
    _debug_ctx["line_idx"] = idx + 1
    return idx


def save_line_debug(
    debug_dir: Path,
    line_idx: int,
    line_crop: np.ndarray,
    top_candidates: list,
    scorer_data: dict,
) -> None:
    """Save debug images for one line's font matching.

    Args:
        debug_dir: Timestamped debug output directory.
        line_idx: Line index (for filenames).
        line_crop: Grayscale numpy crop of the line.
        top_candidates: Top-N FontMatch results from _full_search.
        scorer_data: Dict with keys needed to re-render:
            - "line" (OcrLine) and "type" = "line" for line scoring, OR
            - "char_runs", "line_x", "line_y" and "type" = "masked".
    """
    from PIL import ImageFont as PilFont

    page_bin = line_crop < 128

    # Save raw crop
    crop_img = Image.fromarray(line_crop)
    crop_img.save(debug_dir / f"line-{line_idx:02d}_crop.png")

    composites = []
    for rank, match in enumerate(top_candidates, 1):
        try:
            font = PilFont.truetype(str(match.font_path), match.font_size)
        except Exception:
            continue

        h, w = line_crop.shape
        rendered_img = Image.new("L", (w, h), 255)
        draw = ImageDraw.Draw(rendered_img)

        if scorer_data["type"] == "masked":
            for run in scorer_data["char_runs"]:
                text = "".join(c.text for c in run)
                if not text.strip():
                    continue
                cx = run[0].x - scorer_data["line_x"]
                cy = run[0].y - scorer_data["line_y"]
                bbox = font.getbbox(text)
                draw.text((cx - bbox[0], cy - bbox[1]), text, font=font, fill=0)
        else:
            line_obj = scorer_data["line"]
            bbox = font.getbbox(line_obj.text)
            draw.text((line_obj.x - bbox[0], line_obj.y - bbox[1]), line_obj.text, font=font, fill=0)

        rendered_bin = np.array(rendered_img) < 128

        # Find best shift (same logic as scoring code)
        best_shifted = rendered_bin
        best_dice = 0.0
        page_ink = int(page_bin.sum())
        rend_ink = int(rendered_bin.sum())
        total = page_ink + rend_ink
        if total > 0:
            for dy in range(-3, 4):
                for dx in range(-3, 4):
                    shifted = _shift_2d(rendered_bin, dx, dy)
                    intersection = int((page_bin & shifted).sum())
                    dice = 2.0 * intersection / total
                    if dice > best_dice:
                        best_dice = dice
                        best_shifted = shifted

        comp = render_candidate_composite(
            page_bin, best_shifted,
            match.font_name, match.font_size, match.score, rank,
        )
        safe_name = match.font_name.replace(" ", "")
        comp.save(debug_dir / f"line-{line_idx:02d}_rank-{rank}_{safe_name}_{match.font_size}px_{match.score:.2f}.png")
        composites.append(comp)

    if composites:
        summary = render_summary_image(composites)
        summary.save(debug_dir / f"line-{line_idx:02d}_summary.png")
