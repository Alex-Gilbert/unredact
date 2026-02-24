"""Tests for LLM solve result validation."""

import pytest

from unredact.pipeline.llm_validate import build_validation_prompt, SCORE_TOOL


class TestBuildValidationPrompt:
    def test_basic_prompt_structure(self):
        candidates = ["Smith", "house", "running"]
        prompt = build_validation_prompt(
            left_context="Dear Mr.",
            right_context=", we are writing",
            candidates=candidates,
        )
        assert "Dear Mr." in prompt
        assert ", we are writing" in prompt
        assert "1. Smith" in prompt
        assert "2. house" in prompt
        assert "3. running" in prompt
        assert "_____" in prompt

    def test_empty_context(self):
        prompt = build_validation_prompt(
            left_context="",
            right_context="",
            candidates=["word"],
        )
        assert "1. word" in prompt

    def test_score_tool_schema(self):
        assert SCORE_TOOL["name"] == "score_candidates"
        schema = SCORE_TOOL["input_schema"]
        assert "scores" in schema["properties"]
        items = schema["properties"]["scores"]["items"]
        assert "index" in items["properties"]
        assert "score" in items["properties"]
