"""Build the emails.txt word list from multiple Epstein-related data sources.

Usage:
    python scripts/build_emails.py [--data-dir PATH]

Downloads and merges email addresses from:
  1. HuggingFace dataset (notesbymuneeb/epstein-emails) — parquet
  2. Epstein Exposed API (paginated persons endpoint)
  3. rhowardstone extracted_entities_filtered.json
  4. Hardcoded court-verified addresses

Outputs deduplicated, sorted, one-per-line to unredact/data/emails.txt.
"""

import argparse
import json
import re
import time
import urllib.request
from pathlib import Path

OUTPUT_PATH = Path(__file__).parent.parent / "unredact" / "data" / "emails.txt"

EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w{2,}")

COURT_VERIFIED = [
    "jeevacation@gmail.com",
    "jeeproject@gmail.com",
    "jeeproject@hotmail.com",
    "jeeholidays@gmail.com",
    "jeeproject@yahoo.com",
    "jeffreye@mindspring.com",
    "zorroranch@aol.com",
    "gmax1@mindspring.com",
]

# ── Source 1: HuggingFace parquet ──────────────────────────────────────────

HUGGINGFACE_URL = (
    "https://huggingface.co/datasets/notesbymuneeb/epstein-emails"
    "/resolve/main/epstein_email_threads.parquet"
)


def fetch_huggingface(data_dir: Path) -> set[str]:
    """Download the HuggingFace parquet file and extract email addresses."""
    import pandas as pd

    parquet_path = data_dir / "epstein-emails.parquet"
    if not parquet_path.exists():
        print(f"Downloading {HUGGINGFACE_URL}...")
        urllib.request.urlretrieve(HUGGINGFACE_URL, parquet_path)
        print(f"  -> saved to {parquet_path}")

    df = pd.read_parquet(parquet_path)
    emails: set[str] = set()

    # Scan sender, recipients, and messages columns for email addresses
    for col in ("sender", "recipients", "messages"):
        if col not in df.columns:
            continue
        for value in df[col].dropna():
            text = str(value)
            emails.update(EMAIL_RE.findall(text))

    print(f"  HuggingFace: found {len(emails)} unique emails")
    return emails


# ── Source 2: Epstein Exposed API ──────────────────────────────────────────

EPSTEIN_EXPOSED_API = "https://epsteinexposed.com/api/v1/persons"


def fetch_epstein_exposed() -> set[str]:
    """Paginate the Epstein Exposed persons API and extract emails."""
    emails: set[str] = set()
    page = 1

    while True:
        url = f"{EPSTEIN_EXPOSED_API}?per_page=100&page={page}"
        print(f"  Epstein Exposed API: fetching page {page}...")

        try:
            req = urllib.request.Request(url, headers={"User-Agent": "unredact-build/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError) as exc:
            print(f"  Epstein Exposed API: stopping at page {page} ({exc})")
            break

        # Handle both list response and paginated object response
        if isinstance(data, list):
            persons = data
        elif isinstance(data, dict):
            persons = data.get("data", data.get("results", data.get("persons", [])))
        else:
            break

        if not persons:
            break

        for person in persons:
            # Scan the entire person record for email addresses
            text = json.dumps(person)
            emails.update(EMAIL_RE.findall(text))

        page += 1
        time.sleep(1)  # rate limit: 60 req/min

    print(f"  Epstein Exposed: found {len(emails)} unique emails")
    return emails


# ── Source 3: rhowardstone extracted entities ──────────────────────────────

RHOWARDSTONE_URL = (
    "https://raw.githubusercontent.com/rhowardstone/Epstein-research-data"
    "/main/extracted_entities_filtered.json"
)


def fetch_rhowardstone(data_dir: Path) -> set[str]:
    """Download extracted_entities_filtered.json and extract email entities."""
    cache_path = data_dir / "extracted_entities_filtered.json"
    if not cache_path.exists():
        print(f"  Downloading {RHOWARDSTONE_URL}...")
        urllib.request.urlretrieve(RHOWARDSTONE_URL, cache_path)
        print(f"  -> saved to {cache_path}")

    data = json.loads(cache_path.read_text())
    emails: set[str] = set()

    # Collect all entity lists to scan
    entity_lists: list[list] = []
    if isinstance(data, list):
        entity_lists.append(data)
    elif isinstance(data, dict):
        # Top-level keys like "emails", "names", etc. each hold a list
        for key, value in data.items():
            if isinstance(value, list):
                entity_lists.append(value)

    for items in entity_lists:
        for item in items:
            if not isinstance(item, dict):
                continue
            entity_type = str(item.get("entity_type", item.get("type", ""))).lower()
            if "email" in entity_type:
                value = item.get("entity_value", item.get("value", item.get("entity", "")))
                found = EMAIL_RE.findall(str(value))
                emails.update(found)

    print(f"  rhowardstone: found {len(emails)} unique emails")
    return emails


# ── Source 4: Court-verified ───────────────────────────────────────────────


def get_court_verified() -> set[str]:
    """Return hardcoded court-verified email addresses."""
    emails = set(COURT_VERIFIED)
    print(f"  Court-verified: {len(emails)} emails")
    return emails


# ── Merge and validate ─────────────────────────────────────────────────────


def merge_and_validate(all_emails: set[str]) -> list[str]:
    """Lowercase, deduplicate, validate, and sort email addresses."""
    valid = set()
    for email in all_emails:
        email = email.lower().strip()
        if EMAIL_RE.fullmatch(email):
            valid.add(email)
    return sorted(valid)


# ── Main ───────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Build emails.txt from Epstein data sources")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).parent / ".cache",
                        help="Directory to cache downloaded data files")
    args = parser.parse_args()

    args.data_dir.mkdir(parents=True, exist_ok=True)

    all_emails: set[str] = set()

    # Source 1: HuggingFace
    print("Source 1: HuggingFace dataset")
    all_emails.update(fetch_huggingface(args.data_dir))

    # Source 2: Epstein Exposed API
    print("Source 2: Epstein Exposed API")
    all_emails.update(fetch_epstein_exposed())

    # Source 3: rhowardstone
    print("Source 3: rhowardstone extracted entities")
    all_emails.update(fetch_rhowardstone(args.data_dir))

    # Source 4: Court-verified
    print("Source 4: Court-verified addresses")
    all_emails.update(get_court_verified())

    # Merge, validate, deduplicate
    emails = merge_and_validate(all_emails)
    print(f"\nTotal: {len(emails)} unique valid emails")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text("\n".join(emails) + "\n")
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
