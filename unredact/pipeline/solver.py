import math
import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field

from PIL import ImageFont

from unredact.pipeline.width_table import build_width_table, WidthTable, CHARSETS


@dataclass
class SolveResult:
    text: str
    width: float   # actual rendered width in px
    error: float   # abs(width - target)


@dataclass
class CharConstraint:
    """State machine constraining which characters appear at each position.

    state_allowed[s]: char indices allowed when in state s.
    state_next[s][ci]: next state after placing charset[ci] in state s.
    accept_states: states where the string can validly end.
    """
    state_allowed: list[list[int]]
    state_next: list[list[int]]   # (num_states, charset_size)
    accept_states: set[int]


def _char_indices(charset: str, chars: str) -> list[int]:
    """Map a subset of characters to their indices in the full charset."""
    return [charset.index(c) for c in chars if c in charset]


def _default_constraint(n: int) -> CharConstraint:
    """Single-state constraint that allows all chars at all positions."""
    return CharConstraint(
        state_allowed=[list(range(n))],
        state_next=[[0] * n],
        accept_states={0},
    )


def _first_rest_constraint(
    n: int,
    first_indices: list[int] | None,
    rest_indices: list[int] | None,
) -> CharConstraint:
    """Two-state constraint: one set for position 0, another for the rest."""
    fi = first_indices if first_indices is not None else list(range(n))
    ri = rest_indices if rest_indices is not None else list(range(n))
    sn0 = [-1] * n
    for idx in fi:
        sn0[idx] = 1
    sn1 = [-1] * n
    for idx in ri:
        sn1[idx] = 1
    return CharConstraint(
        state_allowed=[fi, ri],
        state_next=[sn0, sn1],
        accept_states={1},
    )


def build_constraint(pattern: str, charset: str) -> CharConstraint | None:
    """Build a CharConstraint for a named pattern.

    Supported patterns:
      "capitalized"           - [A-Z][a-z]+
      "full_name_capitalized" - [A-Z][a-z]+ [A-Z][a-z]+
      "full_name_caps"        - [A-Z]+ [A-Z]+
    """
    n = len(charset)
    upper_idx = [i for i, c in enumerate(charset) if c.isupper()]
    lower_idx = [i for i, c in enumerate(charset) if c.islower()]
    space_idx = charset.index(' ') if ' ' in charset else -1

    def _make_next(n, mapping):
        """Build state_next row: mapping = {idx: next_state, ...}"""
        row = [-1] * n
        for idx, ns in mapping.items():
            row[idx] = ns
        return row

    if pattern == "capitalized":
        # State 0: uppercase → 1
        # State 1: lowercase → 1
        return CharConstraint(
            state_allowed=[upper_idx, lower_idx],
            state_next=[
                _make_next(n, {i: 1 for i in upper_idx}),
                _make_next(n, {i: 1 for i in lower_idx}),
            ],
            accept_states={1},
        )

    elif pattern == "full_name_capitalized":
        # State 0: uppercase → 1
        # State 1: lowercase → 1, space → 2
        # State 2: uppercase → 3
        # State 3: lowercase → 3
        s1_allowed = list(lower_idx)
        s1_map = {i: 1 for i in lower_idx}
        if space_idx >= 0:
            s1_allowed.append(space_idx)
            s1_map[space_idx] = 2
        return CharConstraint(
            state_allowed=[upper_idx, s1_allowed, upper_idx, lower_idx],
            state_next=[
                _make_next(n, {i: 1 for i in upper_idx}),
                _make_next(n, s1_map),
                _make_next(n, {i: 3 for i in upper_idx}),
                _make_next(n, {i: 3 for i in lower_idx}),
            ],
            accept_states={3},
        )

    elif pattern == "full_name_caps":
        # State 0: uppercase → 1
        # State 1: uppercase → 1, space → 2
        # State 2: uppercase → 3
        # State 3: uppercase → 3
        s1_allowed = list(upper_idx)
        s1_map = {i: 1 for i in upper_idx}
        if space_idx >= 0:
            s1_allowed.append(space_idx)
            s1_map[space_idx] = 2
        return CharConstraint(
            state_allowed=[upper_idx, s1_allowed, upper_idx, upper_idx],
            state_next=[
                _make_next(n, {i: 1 for i in upper_idx}),
                _make_next(n, s1_map),
                _make_next(n, {i: 3 for i in upper_idx}),
                _make_next(n, {i: 3 for i in upper_idx}),
            ],
            accept_states={3},
        )

    return None


# ── Core DFS solver ──

def _solve_subtree(
    wt: WidthTable,
    target: float,
    tolerance: float,
    min_length: int,
    max_length: int,
    prefix: str,
    prefix_width: float,
    last_char_idx: int,
    constraint: CharConstraint,
    start_state: int = 0,
) -> list[SolveResult]:
    """DFS branch-and-bound on a single subtree with state-machine constraints."""
    results: list[SolveResult] = []
    charset = wt.charset
    n = len(charset)
    table = wt.width_table
    right_edge = wt.right_edge
    left_edge = wt.left_edge

    _sa = constraint.state_allowed
    _sn = constraint.state_next
    _accept = constraint.accept_states
    num_states = len(_sa)

    # Precompute per-state max advance for tighter undershoot pruning.
    # For each state, find all chars reachable via any sequence of transitions,
    # then compute the max advance of those chars after any preceding char.
    reachable_chars = [set() for _ in range(num_states)]
    for s in range(num_states):
        visited = set()
        stack = [s]
        while stack:
            curr = stack.pop()
            if curr in visited:
                continue
            visited.add(curr)
            for j in _sa[curr]:
                reachable_chars[s].add(j)
                ns = _sn[curr][j]
                if ns >= 0 and ns not in visited:
                    stack.append(ns)

    _smax = []  # state -> max advance of any reachable char after any char
    for s in range(num_states):
        rc = sorted(reachable_chars[s])
        if rc:
            _smax.append(float(table[:, rc].max()))
        else:
            _smax.append(0.0)

    def dfs(depth: int, acc_width: float, last_idx: int, path: list[str], cstate: int):
        current_length = len(prefix) + depth

        if current_length >= min_length and cstate in _accept:
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

        for next_idx in _sa[cstate]:
            advance = table[last_idx][next_idx]
            new_width = acc_width + advance

            if new_width > target + tolerance:
                continue

            ns = _sn[cstate][next_idx]

            if chars_left > 1:
                max_possible = new_width + _smax[ns] * (chars_left - 1)
                if max_possible + tolerance < target:
                    continue

            path.append(charset[next_idx])
            dfs(depth + 1, new_width, next_idx, path, ns)
            path.pop()

    if len(prefix) == 0:
        for first_idx in _sa[start_state]:
            start_width = left_edge[first_idx]
            if start_width > target + tolerance:
                continue
            ns = _sn[start_state][first_idx]
            if max_length > 1:
                if start_width + _smax[ns] * (max_length - 1) + tolerance < target:
                    continue
            dfs(1, start_width, first_idx, [charset[first_idx]], ns)
    else:
        dfs(0, prefix_width, last_char_idx, list(prefix), start_state)

    return results


# ── Length bounds ──

def _compute_length_bounds(
    wt: WidthTable,
    target_width: float,
    tolerance: float,
) -> tuple[int, int]:
    """Derive min/max string length from font metrics and gap width."""
    global_min = min(wt.left_min, float(wt.min_advance.min()))
    global_max = max(wt.left_max, float(wt.max_advance.max()))

    if global_max <= 0:
        return 1, 1
    if global_min <= 0:
        global_min = 0.1

    min_len = max(1, math.floor((target_width - tolerance) / global_max))
    max_len = max(1, math.ceil((target_width + tolerance) / global_min))

    return min_len, max_len


# ── Single-threaded solver ──

def solve_gap(
    font: ImageFont.FreeTypeFont,
    charset: str,
    target_width: float,
    tolerance: float,
    min_length: int | None = None,
    max_length: int | None = None,
    left_context: str = "",
    right_context: str = "",
    first_chars: str | None = None,
    rest_chars: str | None = None,
    constraint: CharConstraint | None = None,
) -> list[SolveResult]:
    """Find all strings in charset that fill target_width within tolerance.

    Single-threaded version. See solve_gap_parallel for multiprocessing.
    If min_length/max_length are None, they are derived from font metrics.
    Constraint priority: constraint > first_chars/rest_chars > unconstrained.
    """
    n = len(charset)
    wt = build_width_table(font, charset, left_context, right_context)

    auto_min, auto_max = _compute_length_bounds(wt, target_width, tolerance)
    if min_length is None:
        min_length = auto_min
    if max_length is None:
        max_length = auto_max

    if constraint is None:
        if first_chars or rest_chars:
            fi = _char_indices(charset, first_chars) if first_chars else None
            ri = _char_indices(charset, rest_chars) if rest_chars else None
            constraint = _first_rest_constraint(n, fi, ri)
        else:
            constraint = _default_constraint(n)

    results = _solve_subtree(
        wt=wt,
        target=target_width,
        tolerance=tolerance,
        min_length=min_length,
        max_length=max_length,
        prefix="",
        prefix_width=0.0,
        last_char_idx=-1,
        constraint=constraint,
    )

    results.sort(key=lambda r: (r.error, r.text))
    return results


# ── Parallel solver ──

def _generate_prefixes(
    wt: WidthTable,
    target: float,
    tolerance: float,
    depth: int,
    constraint: CharConstraint,
    start_state: int = 0,
) -> list[tuple[str, float, int, int]]:
    """Generate all prefixes of given depth with accumulated widths.

    Returns list of (prefix_str, prefix_width, last_char_idx, final_state).
    """
    charset = wt.charset
    table = wt.width_table
    left_edge = wt.left_edge
    _sa = constraint.state_allowed
    _sn = constraint.state_next

    prefixes: list[tuple[str, float, int, int]] = []

    def expand(pfx: str, acc_width: float, last_idx: int, remaining: int, cstate: int):
        if remaining == 0:
            prefixes.append((pfx, acc_width, last_idx, cstate))
            return
        for next_idx in _sa[cstate]:
            if last_idx == -1:
                advance = left_edge[next_idx]
            else:
                advance = table[last_idx][next_idx]
            new_width = acc_width + advance
            if new_width > target + tolerance:
                continue
            ns = _sn[cstate][next_idx]
            expand(pfx + charset[next_idx], new_width, next_idx, remaining - 1, ns)

    expand("", 0.0, -1, depth, start_state)
    return prefixes


def _worker_solve(args: tuple) -> list[SolveResult]:
    """Picklable worker function for ProcessPoolExecutor."""
    (wt_dict, target, tolerance, min_length, max_length,
     prefix, prefix_width, last_char_idx,
     constraint, start_state) = args

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
        constraint=constraint,
        start_state=start_state,
    )


def solve_gap_parallel(
    font: ImageFont.FreeTypeFont,
    charset: str,
    target_width: float,
    tolerance: float,
    min_length: int | None = None,
    max_length: int | None = None,
    left_context: str = "",
    right_context: str = "",
    max_workers: int | None = None,
    on_progress=None,
    first_chars: str | None = None,
    rest_chars: str | None = None,
    constraint: CharConstraint | None = None,
) -> list[SolveResult]:
    """Find all strings in charset that fill target_width within tolerance.

    Parallel version using ProcessPoolExecutor.
    Constraint priority: constraint > first_chars/rest_chars > unconstrained.
    """
    n = len(charset)
    wt = build_width_table(font, charset, left_context, right_context)

    auto_min, auto_max = _compute_length_bounds(wt, target_width, tolerance)
    if min_length is None:
        min_length = auto_min
    if max_length is None:
        max_length = auto_max

    if constraint is None:
        if first_chars or rest_chars:
            fi = _char_indices(charset, first_chars) if first_chars else None
            ri = _char_indices(charset, rest_chars) if rest_chars else None
            constraint = _first_rest_constraint(n, fi, ri)
        else:
            constraint = _default_constraint(n)

    # Choose prefix depth based on charset size
    if len(charset) <= 52:
        prefix_depth = 2
    else:
        prefix_depth = 1
    prefix_depth = min(prefix_depth, max_length)

    prefixes = _generate_prefixes(wt, target_width, tolerance, prefix_depth, constraint)

    if not prefixes:
        return []

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

    work_items = [
        (wt_dict, target_width, tolerance, min_length, max_length,
         prefix, prefix_width, last_char_idx,
         constraint, pfx_state)
        for prefix, prefix_width, last_char_idx, pfx_state in prefixes
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
