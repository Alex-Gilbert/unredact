"""Stress test for the Rust full-name solver.

Starts the solver server, sends a full-name request with a realistic
font and wide target, and verifies it completes without crashing.
"""

import json
import subprocess
import sys
import time

import requests
from PIL import ImageFont

sys.path.insert(0, ".")
from unredact.pipeline.width_table import CHARSETS, build_width_table

SOLVER_PORT = 3199  # Use a non-default port to avoid conflicts
SOLVER_URL = f"http://127.0.0.1:{SOLVER_PORT}"


def build_full_name_payload(
    font: ImageFont.FreeTypeFont,
    target_width: float,
    tolerance: float,
    left_context: str = "",
    right_context: str = "",
    uppercase_only: bool = False,
    max_results: int = 100,
    filter_mode: str = "names",
) -> dict:
    word_charset = CHARSETS["uppercase"] if uppercase_only else CHARSETS["alpha"]
    wt1 = build_width_table(font, word_charset, left_context, "")
    wt2 = build_width_table(font, word_charset, "", right_context)

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
        "max_results": max_results,
        "filter": filter_mode,
        "filter_prefix": "",
        "filter_suffix": "",
    }


def start_solver():
    """Start the Rust solver server and wait for it to be ready."""
    import os
    env = os.environ.copy()
    env["SOLVER_PORT"] = str(SOLVER_PORT)
    proc = subprocess.Popen(
        ["cargo", "run", "--release"],
        cwd="solver_rs",
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    # Wait for health check
    for _ in range(30):
        try:
            r = requests.get(f"{SOLVER_URL}/health", timeout=1)
            if r.status_code == 200:
                return proc
        except requests.ConnectionError:
            pass
        time.sleep(0.5)
    proc.kill()
    raise RuntimeError("Solver failed to start")


def test_full_name(font, label, target, tolerance, uppercase_only=False, timeout=30):
    """Send a full-name solve request and check it completes."""
    payload = build_full_name_payload(
        font, target, tolerance,
        uppercase_only=uppercase_only,
        max_results=200,
        filter_mode="names",
    )

    print(f"\n{'='*60}")
    print(f"TEST: {label}")
    print(f"  target={target}px, tolerance={tolerance}px")
    print(f"  charset={'uppercase' if uppercase_only else 'alpha'} ({len(payload['word_charset'])} chars)")
    print(f"  uppercase_only={uppercase_only}")

    start = time.time()
    try:
        resp = requests.post(
            f"{SOLVER_URL}/solve/full-name",
            json=payload,
            stream=True,
            timeout=timeout,
        )
        results = []
        for line in resp.iter_lines():
            if not line:
                continue
            text = line.decode()
            if text.startswith("data: "):
                data = json.loads(text[6:])
                if "done" in data:
                    elapsed = time.time() - start
                    print(f"  DONE in {elapsed:.2f}s — {data['total']} results")
                    break
                results.append(data)
                if len(results) <= 5:
                    print(f"  match: {data['text']} (width={data['width']:.2f}, err={data['error']:.2f})")
                elif len(results) == 6:
                    print(f"  ... (more results)")
        else:
            elapsed = time.time() - start
            print(f"  Stream ended without done event in {elapsed:.2f}s")

        print(f"  Total matches received: {len(results)}")
        return True

    except requests.Timeout:
        elapsed = time.time() - start
        print(f"  TIMEOUT after {elapsed:.2f}s")
        return False
    except requests.ConnectionError:
        print(f"  CONNECTION ERROR — solver may have crashed!")
        return False
    except Exception as e:
        print(f"  ERROR: {e}")
        return False


def main():
    font_path = "/usr/share/fonts/TTF/Arial.TTF"
    font_size = 16

    print(f"Loading font: {font_path} at {font_size}pt")
    font = ImageFont.truetype(font_path, font_size)

    print("Starting Rust solver...")
    proc = start_solver()
    print(f"Solver running (PID {proc.pid})")

    all_passed = True
    try:
        # Test 1: Small target (short names, should be fast)
        ok = test_full_name(font, "Small capitalized name (~80px)", 80.0, 2.0, timeout=15)
        all_passed &= ok

        # Test 2: Medium target (typical name)
        ok = test_full_name(font, "Medium capitalized name (~120px)", 120.0, 2.0, timeout=30)
        all_passed &= ok

        # Test 3: Large target (long names — the stress test)
        ok = test_full_name(font, "Large capitalized name (~180px)", 180.0, 3.0, timeout=60)
        all_passed &= ok

        # Test 4: All-caps small
        ok = test_full_name(font, "Small CAPS name (~80px)", 80.0, 2.0, uppercase_only=True, timeout=15)
        all_passed &= ok

        # Test 5: All-caps medium
        ok = test_full_name(font, "Medium CAPS name (~120px)", 120.0, 2.0, uppercase_only=True, timeout=30)
        all_passed &= ok

    finally:
        proc.terminate()
        proc.wait(timeout=5)
        print(f"\nSolver stopped (exit code: {proc.returncode})")

    print(f"\n{'='*60}")
    if all_passed:
        print("ALL TESTS PASSED")
    else:
        print("SOME TESTS FAILED")
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
