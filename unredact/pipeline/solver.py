from dataclasses import dataclass

from PIL import ImageFont

from unredact.pipeline.width_table import build_width_table, WidthTable


@dataclass
class SolveResult:
    text: str
    width: float   # actual rendered width in px
    error: float   # abs(width - target)


def _solve_subtree(
    wt: WidthTable,
    target: float,
    tolerance: float,
    min_length: int,
    max_length: int,
    prefix: str,
    prefix_width: float,
    last_char_idx: int,
) -> list[SolveResult]:
    """DFS branch-and-bound on a single subtree."""
    results: list[SolveResult] = []
    charset = wt.charset
    n = len(charset)
    table = wt.width_table
    min_adv = wt.min_advance
    max_adv = wt.max_advance
    right_edge = wt.right_edge
    left_edge = wt.left_edge

    def dfs(depth: int, acc_width: float, last_idx: int, path: list[str]):
        current_length = len(prefix) + depth

        if current_length >= min_length:
            final_width = acc_width + right_edge[last_idx]
            err = abs(final_width - target)
            if err <= tolerance:
                results.append(SolveResult(
                    text="".join(path),
                    width=float(final_width),
                    error=float(err),
                ))

        if current_length >= max_length:
            return

        chars_left = max_length - current_length

        for next_idx in range(n):
            advance = table[last_idx][next_idx]
            new_width = acc_width + advance

            if new_width > target + tolerance:
                continue

            if chars_left > 1:
                max_possible = new_width + max_adv[next_idx] * (chars_left - 1)
                if max_possible + tolerance < target:
                    continue

            path.append(charset[next_idx])
            dfs(depth + 1, new_width, next_idx, path)
            path.pop()

    if len(prefix) == 0:
        for first_idx in range(n):
            start_width = left_edge[first_idx]
            if start_width > target + tolerance:
                continue
            dfs(1, start_width, first_idx, [charset[first_idx]])
    else:
        path = list(prefix)
        dfs(0, prefix_width, last_char_idx, path)

    return results


def solve_gap(
    font: ImageFont.FreeTypeFont,
    charset: str,
    target_width: float,
    tolerance: float,
    min_length: int,
    max_length: int,
    left_context: str = "",
    right_context: str = "",
) -> list[SolveResult]:
    """Find all strings in charset that fill target_width within tolerance.

    Single-threaded version. See solve_gap_parallel for multiprocessing.
    """
    wt = build_width_table(font, charset, left_context, right_context)

    results = _solve_subtree(
        wt=wt,
        target=target_width,
        tolerance=tolerance,
        min_length=min_length,
        max_length=max_length,
        prefix="",
        prefix_width=0.0,
        last_char_idx=-1,
    )

    results.sort(key=lambda r: (r.error, r.text))
    return results
