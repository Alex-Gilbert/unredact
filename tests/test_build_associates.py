"""Tests for the associates data processing pipeline."""

from scripts.build_associates import process_associates


def _sample_registry():
    """Minimal persons_registry.json structure."""
    return [
        {
            "name": "Jeffrey Epstein",
            "aliases": ["Jeff Epstein"],
            "category": "principal",
            "search_terms": [],
        },
        {
            "name": "Ghislaine Maxwell",
            "aliases": ["G. Maxwell"],
            "category": "staff",
            "search_terms": [],
        },
        {
            "name": "John Smith",
            "aliases": [],
            "category": "business",
            "search_terms": [],
        },
    ]


def _sample_relationships():
    """Minimal knowledge_graph_relationships.json structure."""
    return [
        {"source": "Jeffrey Epstein", "target": "Ghislaine Maxwell", "relationship_type": "associated_with"},
        {"source": "Jeffrey Epstein", "target": "John Smith", "relationship_type": "traveled_with"},
        {"source": "Ghislaine Maxwell", "target": "John Smith", "relationship_type": "associated_with"},
        {"source": "Ghislaine Maxwell", "target": "John Smith", "relationship_type": "associated_with"},
        {"source": "Ghislaine Maxwell", "target": "John Smith", "relationship_type": "associated_with"},
    ]


def test_process_returns_names_and_persons():
    result = process_associates(_sample_registry(), _sample_relationships())
    assert "names" in result
    assert "persons" in result
    assert "victim_names" in result
    assert isinstance(result["victim_names"], list)


def test_tier1_traveled_with():
    """Person with traveled_with relationship should be tier 1."""
    result = process_associates(_sample_registry(), _sample_relationships())
    persons = result["persons"]
    # John Smith has traveled_with → tier 1
    john = next(p for p in persons.values() if p["name"] == "John Smith")
    assert john["tier"] == 1


def test_tier2_staff_category():
    """Person with staff category should be tier 2 (if no traveled_with)."""
    registry = [
        {"name": "Jane Doe", "aliases": [], "category": "staff", "search_terms": []},
    ]
    result = process_associates(registry, [])
    jane = next(p for p in result["persons"].values() if p["name"] == "Jane Doe")
    assert jane["tier"] == 2


def test_tier2_many_relationships():
    """Person with 3+ relationships (but no traveled_with) should be tier 2."""
    result = process_associates(_sample_registry(), _sample_relationships())
    persons = result["persons"]
    # Ghislaine has 4 relationships (1 associated_with from Epstein + 3 to John Smith) but no traveled_with
    ghislaine = next(p for p in persons.values() if p["name"] == "Ghislaine Maxwell")
    assert ghislaine["tier"] == 2


def test_tier3_default():
    """Person with few relationships and no special category should be tier 3."""
    registry = [
        {"name": "Nobody Special", "aliases": [], "category": "other", "search_terms": []},
    ]
    result = process_associates(registry, [])
    person = next(p for p in result["persons"].values() if p["name"] == "Nobody Special")
    assert person["tier"] == 3


def test_full_name_lookup():
    """Full name should be in the names lookup."""
    result = process_associates(_sample_registry(), _sample_relationships())
    names = result["names"]
    assert "jeffrey epstein" in names
    matches = names["jeffrey epstein"]
    assert any(m["match_type"] == "full" for m in matches)


def test_first_and_last_name_lookup():
    """First and last name should have separate lookup entries."""
    result = process_associates(_sample_registry(), _sample_relationships())
    names = result["names"]
    assert "jeffrey" in names
    assert "epstein" in names
    assert any(m["match_type"] == "first" for m in names["jeffrey"])
    assert any(m["match_type"] == "last" for m in names["epstein"])


def test_alias_generates_lookups():
    """Aliases from the registry should also generate lookup entries."""
    result = process_associates(_sample_registry(), _sample_relationships())
    names = result["names"]
    assert "jeff epstein" in names


def test_multiple_persons_same_name():
    """A common name like 'john' can match multiple persons."""
    registry = _sample_registry() + [
        {"name": "John Doe", "aliases": [], "category": "other", "search_terms": []},
    ]
    result = process_associates(registry, _sample_relationships())
    names = result["names"]
    assert "john" in names
    # Should have entries for both John Smith and John Doe
    person_ids = {m["person_id"] for m in names["john"]}
    assert len(person_ids) >= 2


def test_nickname_generation():
    """Common nicknames should be generated (Jeffrey → Jeff)."""
    result = process_associates(_sample_registry(), _sample_relationships())
    names = result["names"]
    assert "jeff" in names
    assert any(m["match_type"] == "nickname" for m in names["jeff"])


def test_victim_names_generated():
    """Victim names should be a flat list of lowercased name variants."""
    result = process_associates(_sample_registry(), _sample_relationships())
    vn = result["victim_names"]
    # Known victims from the KNOWN_VICTIMS set should produce entries
    assert "virginia giuffre" in vn
    assert "giuffre" in vn
    assert "virginia" in vn


def test_victim_names_independent_of_associates():
    """Victim names don't require the person to be in the registry."""
    result = process_associates([], [])
    vn = result["victim_names"]
    # Victims come from the hardcoded set, not the registry
    assert "virginia giuffre" in vn
