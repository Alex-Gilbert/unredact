"""Build the associates.json lookup file from rhowardstone/Epstein-research-data.

Usage:
    python scripts/build_associates.py [--data-dir PATH]

Downloads persons_registry.json and knowledge_graph_relationships.json if not
present, then processes them into unredact/data/associates.json.
"""

import argparse
import json
from collections import defaultdict
from pathlib import Path

OUTPUT_PATH = Path(__file__).parent.parent / "unredact" / "data" / "associates.json"

# Common nickname mappings (canonical → [nicknames])
NICKNAMES = {
    "jeffrey": ["jeff"],
    "william": ["bill", "will", "willy", "billy"],
    "richard": ["rick", "dick", "rich"],
    "robert": ["rob", "bob", "bobby"],
    "james": ["jim", "jimmy", "jamie"],
    "michael": ["mike", "mikey"],
    "joseph": ["joe", "joey"],
    "thomas": ["tom", "tommy"],
    "charles": ["charlie", "chuck"],
    "christopher": ["chris"],
    "daniel": ["dan", "danny"],
    "matthew": ["matt"],
    "anthony": ["tony"],
    "donald": ["don", "donny"],
    "steven": ["steve"],
    "stephen": ["steve"],
    "edward": ["ed", "eddie", "ted"],
    "benjamin": ["ben"],
    "samuel": ["sam", "sammy"],
    "alexander": ["alex"],
    "nicholas": ["nick"],
    "jonathan": ["jon"],
    "timothy": ["tim", "timmy"],
    "andrew": ["andy", "drew"],
    "lawrence": ["larry"],
    "raymond": ["ray"],
    "gerald": ["gerry", "jerry"],
    "kenneth": ["ken", "kenny"],
    "elizabeth": ["liz", "beth", "lizzy"],
    "katherine": ["kate", "kathy", "katie"],
    "catherine": ["kate", "cathy", "katie"],
    "margaret": ["maggie", "meg", "peggy"],
    "jennifer": ["jen", "jenny"],
    "patricia": ["pat", "patty"],
    "virginia": ["ginny"],
    "victoria": ["vicky", "tori"],
    "deborah": ["deb", "debbie"],
    "dorothy": ["dot", "dotty"],
    "suzanne": ["sue", "suzy"],
    "alexandra": ["alex"],
}

# Tier 2 categories (staff/financial get auto-promoted)
TIER2_CATEGORIES = {"staff", "financial"}


def _compute_tiers(registry: list[dict], relationships: list[dict]) -> dict[str, int]:
    """Compute tier for each person name.

    Returns: {canonical_name: tier}
    """
    # Count relationships and check for traveled_with
    traveled = set()
    rel_counts: dict[str, int] = defaultdict(int)

    for rel in relationships:
        src = rel.get("source", "")
        tgt = rel.get("target", "")
        rtype = rel.get("relationship_type", "")

        rel_counts[src] += 1
        rel_counts[tgt] += 1

        if rtype == "traveled_with":
            traveled.add(src)
            traveled.add(tgt)

    tiers = {}
    for person in registry:
        name = person["name"]
        category = person.get("category", "other")

        if name in traveled:
            tiers[name] = 1
        elif category in TIER2_CATEGORIES or rel_counts.get(name, 0) >= 3:
            tiers[name] = 2
        else:
            tiers[name] = 3

    return tiers


def _add_name_entries(
    names: dict[str, list],
    text: str,
    person_id: str,
    tier: int,
    match_type: str,
):
    """Add a lookup entry for a name string (lowercased)."""
    key = text.lower().strip()
    if not key or len(key) < 2:
        return
    if key not in names:
        names[key] = []
    # Avoid duplicate entries for same person + match_type
    if not any(e["person_id"] == person_id and e["match_type"] == match_type for e in names[key]):
        names[key].append({"person_id": person_id, "match_type": match_type, "tier": tier})


def _split_name(full_name: str) -> tuple[str, str]:
    """Split a full name into (first, last). Returns ('', '') if can't split."""
    parts = full_name.strip().split()
    if len(parts) < 2:
        return ("", "")
    return (parts[0], parts[-1])


def _generate_lookups_for_name(
    names: dict[str, list],
    full_name: str,
    person_id: str,
    tier: int,
):
    """Generate all lookup entries for a single name string."""
    # Full name
    _add_name_entries(names, full_name, person_id, tier, "full")

    first, last = _split_name(full_name)
    if first and last:
        # First and last separately
        _add_name_entries(names, first, person_id, tier, "first")
        _add_name_entries(names, last, person_id, tier, "last")

        # Initials + last
        initial = first[0]
        _add_name_entries(names, f"{initial}. {last}", person_id, tier, "initial_last")
        _add_name_entries(names, f"{initial} {last}", person_id, tier, "initial_last")

        # Nicknames
        first_lower = first.lower()
        if first_lower in NICKNAMES:
            for nick in NICKNAMES[first_lower]:
                _add_name_entries(names, nick, person_id, tier, "nickname")
                _add_name_entries(names, f"{nick} {last}", person_id, tier, "nickname_full")


def process_associates(
    registry: list[dict],
    relationships: list[dict],
) -> dict:
    """Process raw registry + relationships into the associates lookup format.

    Returns: {"names": {str: [...]}, "persons": {str: {...}}}
    """
    tiers = _compute_tiers(registry, relationships)

    names: dict[str, list] = {}
    persons: dict[str, dict] = {}

    for i, person in enumerate(registry):
        person_id = f"p{i:04d}"
        canonical_name = person["name"]
        tier = tiers.get(canonical_name, 3)
        category = person.get("category", "other")

        persons[person_id] = {
            "name": canonical_name,
            "tier": tier,
            "category": category,
        }

        # Generate lookups for canonical name
        _generate_lookups_for_name(names, canonical_name, person_id, tier)

        # Generate lookups for each alias
        for alias in person.get("aliases", []):
            _generate_lookups_for_name(names, alias, person_id, tier)

    return {"names": names, "persons": persons}


def download_data(data_dir: Path) -> tuple[list, list]:
    """Download the rhowardstone data files if not already present.

    Returns: (registry, relationships)
    """
    import urllib.request

    base_url = "https://raw.githubusercontent.com/rhowardstone/Epstein-research-data/main"
    registry_path = data_dir / "persons_registry.json"
    rels_path = data_dir / "knowledge_graph_relationships.json"

    for filename, path in [("persons_registry.json", registry_path), ("knowledge_graph_relationships.json", rels_path)]:
        if not path.exists():
            url = f"{base_url}/{filename}"
            print(f"Downloading {url}...")
            urllib.request.urlretrieve(url, path)
            print(f"  -> saved to {path}")

    registry = json.loads(registry_path.read_text())
    relationships = json.loads(rels_path.read_text())
    return registry, relationships


def main():
    parser = argparse.ArgumentParser(description="Build associates.json from Epstein research data")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).parent / ".cache",
                        help="Directory to cache downloaded data files")
    args = parser.parse_args()

    args.data_dir.mkdir(parents=True, exist_ok=True)

    registry, relationships = download_data(args.data_dir)
    print(f"Loaded {len(registry)} persons, {len(relationships)} relationships")

    result = process_associates(registry, relationships)
    print(f"Generated {len(result['names'])} name lookups for {len(result['persons'])} persons")

    tier_counts = defaultdict(int)
    for p in result["persons"].values():
        tier_counts[p["tier"]] += 1
    for tier in sorted(tier_counts):
        print(f"  Tier {tier}: {tier_counts[tier]} persons")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(result, indent=2))
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
