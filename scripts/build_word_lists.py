"""Build word list files (nouns, plurals, adjectives) from WordNet via NLTK.

Usage:
    python scripts/build_word_lists.py [--data-dir PATH]

Extracts nouns and adjectives from WordNet, generates plural forms using
irregular mappings from Wiktionary/GitHub and standard English rules, then
writes three files to unredact/data/:
  - nouns.txt          (singular nouns, one per line)
  - nouns_plural.txt   (corresponding plural for each noun)
  - adjectives.txt     (adjectives, one per line)
"""

import argparse
import csv
import io
import re
import urllib.error
import urllib.request
from pathlib import Path

import nltk

OUTPUT_DIR = Path(__file__).parent.parent / "unredact" / "data"

IRREGULAR_PLURALS_URL = (
    "https://raw.githubusercontent.com/djstrong/nouns-with-plurals/master/noun.csv"
)

# Regex: only lowercase alpha, no digits/hyphens/underscores/spaces
VALID_WORD = re.compile(r"^[a-z]+$")


def extract_wordnet_words(pos_tags: list[str]) -> list[str]:
    """Extract unique lowercase words from WordNet for given POS tags.

    Only words matching [a-z]+ are included.
    """
    from nltk.corpus import wordnet as wn

    words: set[str] = set()
    for pos in pos_tags:
        for lemma in wn.all_lemma_names(pos=pos):
            word = lemma.lower()
            if VALID_WORD.match(word):
                words.add(word)
    return sorted(words)


def download_irregular_plurals() -> dict[str, str]:
    """Download irregular plural mappings from GitHub.

    Returns: {singular: plural} dict, filtered to [a-z]+ words only.
    """
    print(f"Downloading irregular plurals from {IRREGULAR_PLURALS_URL}...")
    try:
        response = urllib.request.urlopen(IRREGULAR_PLURALS_URL)
    except (urllib.error.URLError, OSError) as exc:
        print(f"  WARNING: failed to download irregular plurals: {exc}")
        print("  Continuing with rule-based pluralization only.")
        return {}
    text = response.read().decode("utf-8")

    mapping: dict[str, str] = {}
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        if len(row) < 2:
            continue
        singular = row[0].strip().lower()
        plural = row[1].strip().lower()
        if VALID_WORD.match(singular) and VALID_WORD.match(plural):
            mapping[singular] = plural

    print(f"  -> loaded {len(mapping)} irregular plural mappings")
    return mapping


def pluralize(word: str) -> str:
    """Apply standard English pluralization rules to a word."""
    if word.endswith("fe"):
        return word[:-2] + "ves"
    if word.endswith("f"):
        return word[:-1] + "ves"
    if word.endswith(("s", "x", "z")) or word.endswith(("sh", "ch")):
        return word + "es"
    if word.endswith("y") and len(word) >= 2 and word[-2] not in "aeiou":
        return word[:-1] + "ies"
    return word + "s"


def generate_plurals(nouns: list[str], irregulars: dict[str, str]) -> list[str]:
    """Generate plural form for each noun.

    Uses irregular mapping if available, otherwise applies rules.
    """
    plurals: list[str] = []
    for noun in nouns:
        if noun in irregulars:
            plurals.append(irregulars[noun])
        else:
            plurals.append(pluralize(noun))
    return plurals


def write_word_list(path: Path, words: list[str]) -> None:
    """Write a sorted word list, one word per line."""
    path.write_text("\n".join(words) + "\n")
    print(f"Wrote {len(words)} words to {path}")


def main():
    parser = argparse.ArgumentParser(
        description="Build word list files from WordNet (nouns, adjectives, plurals)"
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=OUTPUT_DIR,
        help="Directory to write output files (default: unredact/data/)",
    )
    args = parser.parse_args()

    args.data_dir.mkdir(parents=True, exist_ok=True)

    # Ensure WordNet corpus is available
    nltk.download("wordnet", quiet=True)

    # Extract nouns (POS 'n')
    print("Extracting nouns from WordNet...")
    nouns = extract_wordnet_words(["n"])
    print(f"  -> {len(nouns)} nouns")

    # Extract adjectives (POS 'a' for adjective, 's' for satellite adjective)
    print("Extracting adjectives from WordNet...")
    adjectives = extract_wordnet_words(["a", "s"])
    print(f"  -> {len(adjectives)} adjectives")

    # Download irregular plural mappings
    irregulars = download_irregular_plurals()

    # Generate plurals
    print("Generating plural forms...")
    plurals = generate_plurals(nouns, irregulars)

    # Write output files
    write_word_list(args.data_dir / "nouns.txt", nouns)
    write_word_list(args.data_dir / "nouns_plural.txt", plurals)
    write_word_list(args.data_dir / "adjectives.txt", adjectives)

    print("Done.")


if __name__ == "__main__":
    main()
