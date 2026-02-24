"""Re-sort nouns.txt by promoting variant spellings to match their ranked counterparts.

For each word, strips hyphens and spaces to normalize. Words that share a
normalized form are grouped together, and all variants inherit the best
(lowest) rank in the group. This promotes e.g. "halfsister" to sit next to
"half-sister" which has frequency data.

Usage:
    python scripts/resort_nouns.py [--dry-run]
"""

from pathlib import Path
import argparse

DATA_DIR = Path(__file__).parent.parent / "unredact" / "data"


def normalize(word: str) -> str:
    """Strip hyphens and spaces to get a canonical form for matching."""
    return word.replace("-", "").replace(" ", "").lower()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Show changes without writing")
    args = parser.parse_args()

    nouns_path = DATA_DIR / "nouns.txt"
    plurals_path = DATA_DIR / "nouns_plural.txt"

    nouns = nouns_path.read_text().splitlines()
    plurals = plurals_path.read_text().splitlines()
    assert len(nouns) == len(plurals), "nouns and plurals must be same length"

    # Group words by normalized form: norm -> [(original_index, word)]
    groups: dict[str, list[int]] = {}
    for i, word in enumerate(nouns):
        nf = normalize(word)
        groups.setdefault(nf, []).append(i)

    # Find groups where variants are far apart (some ranked, some not)
    # For each group with multiple entries, the best rank is min(indices)
    promotions: list[tuple[str, int, int]] = []  # (word, old_pos, new_pos)
    # Map: original_index -> new sort key
    sort_key = list(range(len(nouns)))  # default: keep original position

    for nf, indices in groups.items():
        if len(indices) < 2:
            continue
        best_rank = min(indices)
        for idx in indices:
            if idx != best_rank and idx > best_rank + len(indices):
                # This word is far from its variant — promote it
                promotions.append((nouns[idx], idx + 1, best_rank + 1))
            # All variants get sort key just after the best-ranked one
            # Use fractional offset to keep variants together but after the original
            sort_key[idx] = best_rank

    # Sort: primary by sort_key, secondary by original index (stable)
    new_order = sorted(range(len(nouns)), key=lambda i: (sort_key[i], i))

    # Apply new order
    new_nouns = [nouns[i] for i in new_order]
    new_plurals = [plurals[i] for i in new_order]

    # Report promotions
    promotions.sort(key=lambda x: x[2])
    significant = [(w, old, new) for w, old, new in promotions if old - new > 100]
    print(f"Total variant groups: {sum(1 for g in groups.values() if len(g) > 1)}")
    print(f"Words promoted (moved 100+ positions): {len(significant)}")

    if significant:
        print(f"\nSample promotions (showing first 30):")
        for word, old_pos, new_pos in significant[:30]:
            # Find what it matched
            nf = normalize(word)
            variant = nouns[min(groups[nf])]
            print(f"  {word!r} ({old_pos}) -> near {variant!r} ({new_pos})")

    # Verify halfsister
    if "halfsister" in nouns:
        old_pos = nouns.index("halfsister") + 1
        new_pos = new_nouns.index("halfsister") + 1
        print(f"\nhalfsister: line {old_pos} -> line {new_pos}")

    if args.dry_run:
        print("\n(dry run — no files written)")
    else:
        nouns_path.write_text("\n".join(new_nouns) + "\n")
        plurals_path.write_text("\n".join(new_plurals) + "\n")
        print(f"\nWrote {len(new_nouns)} nouns and plurals")


if __name__ == "__main__":
    main()
