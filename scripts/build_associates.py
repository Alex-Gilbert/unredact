"""Build the associates.json lookup file from rhowardstone/Epstein-research-data.

Usage:
    python scripts/build_associates.py [--data-dir PATH]

Downloads persons_registry.json and knowledge_graph_relationships.json if not
present, then processes them into unredact/data/associates.json.
"""

import argparse
import json
import re
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

# Known victims from public court records and reporting (Giuffre v. Maxwell, etc.)
# Stored as a separate name set — no person details exposed in the UI.
KNOWN_VICTIMS = {
    "Virginia Giuffre", "VIRGINIA ROBERTS", "Virginia Roberts",
    "Courtney Wild",
    "Sarah Ransome",
    "Maria Farmer", "Annie Farmer",
    "Chauntae Davies",
    "Johanna Sjoberg",
    "Michelle Licata",
    "Carolyn Andriano",
    "Priscilla Doe",
    "Teresa Helm",
    "Anouska De Georgiou",
    "Haley Robson",
}


def _compute_tiers(registry: list[dict], relationships: list[dict]) -> dict[str, int]:
    """Compute tier for each person name.

    Returns: {canonical_name: tier}
    """
    # Count relationships and check for traveled_with
    traveled = set()
    rel_counts: dict[str, int] = defaultdict(int)

    for rel in relationships:
        src = rel.get("source_name", rel.get("source", ""))
        tgt = rel.get("target_name", rel.get("target", ""))
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
        elif category in TIER2_CATEGORIES or category in {"enabler", "perpetrator"} or rel_counts.get(name, 0) >= 3:
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


def _build_victim_names() -> set[str]:
    """Build a flat set of lowercased victim name variants for matching.

    No person details — just strings to check against. This keeps victim
    identities private in the UI (the V badge shows but is not clickable).
    """
    victim_names: set[str] = set()

    for full_name in KNOWN_VICTIMS:
        low = full_name.lower().strip()
        if len(low) < 2:
            continue
        victim_names.add(low)

        parts = low.split()
        if len(parts) >= 2:
            first, last = parts[0], parts[-1]
            victim_names.add(first)
            victim_names.add(last)

            # Nicknames
            if first in NICKNAMES:
                for nick in NICKNAMES[first]:
                    victim_names.add(nick)
                    victim_names.add(f"{nick} {last}")

    return victim_names


def process_associates(
    registry: list[dict],
    relationships: list[dict],
) -> dict:
    """Process raw registry + relationships into the associates lookup format.

    Returns: {"names": {str: [...]}, "persons": {str: {...}}, "victim_names": [str, ...]}
    """
    tiers = _compute_tiers(registry, relationships)

    names: dict[str, list] = {}
    persons: dict[str, dict] = {}

    pid_counter = 0
    for person in registry:
        canonical_name = person["name"]

        # Skip redaction placeholders and parsing artifacts from upstream data
        if re.search(r'[()]', canonical_name) or len(canonical_name) < 3:
            continue

        person_id = f"p{pid_counter:04d}"
        pid_counter += 1
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

    victim_names = sorted(_build_victim_names())

    return {"names": names, "persons": persons, "victim_names": victim_names}


def extract_name_lists(registry: list[dict]) -> tuple[set[str], set[str]]:
    """Extract unique first and last names from the persons registry.

    Includes nickname expansions. Returns (first_names, last_names) as
    lowercase sets, filtered to alpha-only strings of length >= 2.
    """
    firsts: set[str] = set()
    lasts: set[str] = set()

    for person in registry:
        name = person["name"]
        parts = name.strip().split()
        if len(parts) < 2:
            continue
        first = parts[0].lower()
        last = parts[-1].lower()

        if first.isalpha() and len(first) >= 2:
            firsts.add(first)
            # Add nicknames
            if first in NICKNAMES:
                for nick in NICKNAMES[first]:
                    if nick.isalpha() and len(nick) >= 2:
                        firsts.add(nick)

        if last.isalpha() and len(last) >= 2:
            lasts.add(last)

        # Also process aliases
        for alias in person.get("aliases", []):
            alias_parts = alias.strip().split()
            if len(alias_parts) < 2:
                continue
            af = alias_parts[0].lower()
            al = alias_parts[-1].lower()
            if af.isalpha() and len(af) >= 2:
                firsts.add(af)
                if af in NICKNAMES:
                    for nick in NICKNAMES[af]:
                        if nick.isalpha() and len(nick) >= 2:
                            firsts.add(nick)
            if al.isalpha() and len(al) >= 2:
                lasts.add(al)

    return firsts, lasts


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
    OUTPUT_PATH.write_text(json.dumps(result, separators=(",", ":")))
    print(f"Wrote {OUTPUT_PATH}")

    # Write focused name lists
    firsts, lasts = extract_name_lists(registry)
    first_path = OUTPUT_PATH.parent / "associate_first_names.txt"
    last_path = OUTPUT_PATH.parent / "associate_last_names.txt"
    first_path.write_text("\n".join(sorted(firsts)) + "\n")
    last_path.write_text("\n".join(sorted(lasts)) + "\n")
    print(f"Wrote {len(firsts)} first names to {first_path}")
    print(f"Wrote {len(lasts)} last names to {last_path}")


if __name__ == "__main__":
    main()
