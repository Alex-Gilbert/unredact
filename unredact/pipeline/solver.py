import os
from concurrent.futures import ProcessPoolExecutor, as_completed
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


def _generate_prefixes(
    wt: WidthTable,
    target: float,
    tolerance: float,
    depth: int = 2,
) -> list[tuple[str, float, int]]:
    """Generate all prefixes of given depth with accumulated widths.

    Prunes prefixes whose accumulated width already overshoots
    target + tolerance. Returns list of (prefix_str, prefix_width,
    last_char_idx).
    """
    charset = wt.charset
    n = len(charset)
    table = wt.width_table
    left_edge = wt.left_edge

    prefixes: list[tuple[str, float, int]] = []

    def expand(current_prefix: str, acc_width: float, last_idx: int, remaining: int):
        if remaining == 0:
            prefixes.append((current_prefix, acc_width, last_idx))
            return
        for next_idx in range(n):
            if last_idx == -1:
                advance = left_edge[next_idx]
            else:
                advance = table[last_idx][next_idx]
            new_width = acc_width + advance
            if new_width > target + tolerance:
                continue
            expand(
                current_prefix + charset[next_idx],
                new_width,
                next_idx,
                remaining - 1,
            )

    expand("", 0.0, -1, depth)
    return prefixes


def _worker_solve(args: tuple) -> list[SolveResult]:
    """Worker function for multiprocessing.

    Takes a tuple of serialized args, reconstructs WidthTable, and
    calls _solve_subtree. The WidthTable is passed as a dict because
    the dataclass with numpy arrays pickles fine but this keeps the
    interface explicit.
    """
    (wt_dict, target, tolerance, min_length, max_length,
     prefix, prefix_width, last_char_idx) = args

    wt = WidthTable(**wt_dict)

    return _solve_subtree(
        wt=wt,
        target=target,
        tolerance=tolerance,
        min_length=min_length,
        max_length=max_length,
        prefix=prefix,
        prefix_width=prefix_width,
        last_char_idx=last_char_idx,
    )


def solve_gap_parallel(
    font: ImageFont.FreeTypeFont,
    charset: str,
    target_width: float,
    tolerance: float,
    min_length: int,
    max_length: int,
    left_context: str = "",
    right_context: str = "",
    max_workers: int | None = None,
    on_progress=None,
) -> list[SolveResult]:
    """Find all strings in charset that fill target_width within tolerance.

    Parallel version using ProcessPoolExecutor. Generates depth-2 prefixes
    (depth-1 for large charsets), distributes subtrees to workers, and
    collects results.
    """
    wt = build_width_table(font, charset, left_context, right_context)

    # Choose prefix depth based on charset size
    if len(charset) <= 52:
        prefix_depth = 2
    else:
        prefix_depth = 1
    # Don't exceed max_length
    prefix_depth = min(prefix_depth, max_length)

    prefixes = _generate_prefixes(wt, target_width, tolerance, depth=prefix_depth)

    if not prefixes:
        return []

    # Serialize WidthTable to a dict for pickling
    wt_dict = {
        "charset": wt.charset,
        "width_table": wt.width_table,
        "left_edge": wt.left_edge,
        "right_edge": wt.right_edge,
        "min_advance": wt.min_advance,
        "max_advance": wt.max_advance,
        "left_min": wt.left_min,
        "left_max": wt.left_max,
    }

    if max_workers is None:
        max_workers = os.cpu_count()

    # Build work items
    work_items = [
        (wt_dict, target_width, tolerance, min_length, max_length,
         prefix, prefix_width, last_char_idx)
        for prefix, prefix_width, last_char_idx in prefixes
    ]

    all_results: list[SolveResult] = []
    checked_prefixes = 0
    total_found = 0

    with ProcessPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(_worker_solve, item): item
            for item in work_items
        }

        for future in as_completed(futures):
            subtree_results = future.result()
            all_results.extend(subtree_results)
            checked_prefixes += 1
            total_found += len(subtree_results)

            if on_progress is not None:
                on_progress(checked_prefixes, total_found)

    all_results.sort(key=lambda r: (r.error, r.text))
    return all_results
