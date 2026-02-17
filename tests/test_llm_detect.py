"""Tests for LLM-based redaction detection."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from unredact.pipeline.ocr import OcrChar, OcrLine
from unredact.pipeline.llm_detect import (
    LlmRedaction,
    _build_prompt,
    _find_word_in_chars,
    _parse_response,
    detect_redactions_llm,
)


# ---------------------------------------------------------------------------
# Helpers to build OcrLine fixtures
# ---------------------------------------------------------------------------

def _make_char(ch: str, x: int, w: int = 10, y: int = 100, h: int = 20) -> OcrChar:
    return OcrChar(text=ch, x=x, y=y, w=w, h=h, conf=95.0)


def _make_line_from_words(
    words: list[str],
    start_x: int = 50,
    char_w: int = 10,
    space_w: int = 8,
    y: int = 100,
    h: int = 20,
) -> OcrLine:
    """Build an OcrLine from a list of words with evenly-spaced characters."""
    chars: list[OcrChar] = []
    x = start_x
    for wi, word in enumerate(words):
        for ch in word:
            chars.append(_make_char(ch, x, w=char_w, y=y, h=h))
            x += char_w
        if wi < len(words) - 1:
            chars.append(_make_char(" ", x, w=space_w, y=y, h=h))
            x += space_w
    line_x = chars[0].x
    line_w = (chars[-1].x + chars[-1].w) - line_x
    return OcrLine(chars=chars, x=line_x, y=y, w=line_w, h=h)


# ---------------------------------------------------------------------------
# _build_prompt
# ---------------------------------------------------------------------------

class TestBuildPrompt:
    def test_includes_all_lines(self):
        lines = [
            _make_line_from_words(["Hello", "world"]),
            _make_line_from_words(["Second", "line"]),
        ]
        prompt = _build_prompt(lines)
        assert "Hello world" in prompt
        assert "Second line" in prompt

    def test_includes_line_indices(self):
        lines = [
            _make_line_from_words(["Line", "zero"]),
            _make_line_from_words(["Line", "one"]),
        ]
        prompt = _build_prompt(lines)
        # Should have line numbers / indices
        assert "0" in prompt
        assert "1" in prompt

    def test_empty_lines(self):
        prompt = _build_prompt([])
        # Should not crash; should produce valid string
        assert isinstance(prompt, str)


# ---------------------------------------------------------------------------
# _find_word_in_chars
# ---------------------------------------------------------------------------

class TestFindWordInChars:
    def test_find_first_word(self):
        line = _make_line_from_words(["Hello", "world", "foo"])
        result = _find_word_in_chars(line, "Hello", search_from=0, from_right=False)
        assert result is not None
        start_x, end_x = result
        # "Hello" starts at char 0 (x=50) and ends at char 4 (x=90, end=100)
        assert start_x == 50
        assert end_x == 50 + 5 * 10  # 5 chars * 10px each

    def test_find_last_word(self):
        line = _make_line_from_words(["Hello", "world", "foo"])
        result = _find_word_in_chars(line, "foo", search_from=0, from_right=False)
        assert result is not None

    def test_find_from_right(self):
        line = _make_line_from_words(["the", "cat", "the", "dog"])
        # from_right should find the last occurrence
        result = _find_word_in_chars(
            line, "the", search_from=0, from_right=True
        )
        assert result is not None
        # The second "the" starts further right
        start_x, _ = result
        # First "the" starts at x=50; second "the" should start later
        assert start_x > 50

    def test_word_not_found(self):
        line = _make_line_from_words(["Hello", "world"])
        result = _find_word_in_chars(line, "missing", search_from=0, from_right=False)
        assert result is None

    def test_search_from_offset(self):
        line = _make_line_from_words(["Hello", "world"])
        # search_from past where "Hello" starts should still find "world"
        hello_end_x = 50 + 5 * 10 + 8  # past hello + space
        result = _find_word_in_chars(
            line, "world", search_from=hello_end_x, from_right=False
        )
        assert result is not None

    def test_empty_word_returns_none(self):
        line = _make_line_from_words(["Hello", "world"])
        result = _find_word_in_chars(line, "", search_from=0, from_right=False)
        assert result is None


# ---------------------------------------------------------------------------
# _parse_response
# ---------------------------------------------------------------------------

class TestParseResponse:
    def test_single_redaction_middle_of_line(self):
        # Line: "The [REDACTED] cat"
        # LLM says redaction between "The" and "cat" on line 0
        line = _make_line_from_words(["The", "[REDACTED]", "cat"])
        tool_input = {
            "redactions": [
                {"line_index": 0, "left_word": "The", "right_word": "cat"},
            ]
        }
        results = _parse_response(tool_input, [line])
        assert len(results) == 1
        r = results[0]
        assert isinstance(r, LlmRedaction)
        assert r.line_index == 0
        assert r.left_word == "The"
        assert r.right_word == "cat"
        assert r.line_y == line.y
        assert r.line_h == line.h
        # left_x should be the right edge of "The"
        # right_x should be the left edge of "cat"
        assert r.left_x < r.right_x

    def test_multiple_redactions_same_line(self):
        line = _make_line_from_words(["A", "XXX", "B", "YYY", "C"])
        tool_input = {
            "redactions": [
                {"line_index": 0, "left_word": "A", "right_word": "B"},
                {"line_index": 0, "left_word": "B", "right_word": "C"},
            ]
        }
        results = _parse_response(tool_input, [line])
        assert len(results) == 2
        # First redaction should be left of second
        assert results[0].right_x <= results[1].left_x

    def test_no_redactions(self):
        line = _make_line_from_words(["Clean", "text", "here"])
        tool_input = {"redactions": []}
        results = _parse_response(tool_input, [line])
        assert results == []

    def test_redaction_at_line_start(self):
        # Redaction at the very beginning — empty left_word
        line = _make_line_from_words(["[REDACTED]", "world"])
        tool_input = {
            "redactions": [
                {"line_index": 0, "left_word": "", "right_word": "world"},
            ]
        }
        results = _parse_response(tool_input, [line])
        assert len(results) == 1
        r = results[0]
        assert r.left_word == ""
        # left_x should be the line start
        assert r.left_x == line.x

    def test_redaction_at_line_end(self):
        # Redaction at the very end — empty right_word
        line = _make_line_from_words(["Hello", "[REDACTED]"])
        tool_input = {
            "redactions": [
                {"line_index": 0, "left_word": "Hello", "right_word": ""},
            ]
        }
        results = _parse_response(tool_input, [line])
        assert len(results) == 1
        r = results[0]
        assert r.right_word == ""
        # right_x should be the line end
        assert r.right_x == line.x + line.w

    def test_invalid_line_index_skipped(self):
        line = _make_line_from_words(["Hello", "world"])
        tool_input = {
            "redactions": [
                {"line_index": 99, "left_word": "Hello", "right_word": "world"},
            ]
        }
        results = _parse_response(tool_input, [line])
        assert results == []

    def test_word_not_found_skipped(self):
        line = _make_line_from_words(["Hello", "world"])
        tool_input = {
            "redactions": [
                {"line_index": 0, "left_word": "MISSING", "right_word": "world"},
            ]
        }
        results = _parse_response(tool_input, [line])
        assert results == []

    def test_multiple_lines(self):
        line0 = _make_line_from_words(["A", "XXX", "B"], y=100)
        line1 = _make_line_from_words(["C", "YYY", "D"], y=200)
        tool_input = {
            "redactions": [
                {"line_index": 0, "left_word": "A", "right_word": "B"},
                {"line_index": 1, "left_word": "C", "right_word": "D"},
            ]
        }
        results = _parse_response(tool_input, [line0, line1])
        assert len(results) == 2
        assert results[0].line_y == 100
        assert results[1].line_y == 200


# ---------------------------------------------------------------------------
# detect_redactions_llm (mocked)
# ---------------------------------------------------------------------------

class TestDetectRedactionsLlm:
    def _make_mock_response(self, tool_input: dict) -> MagicMock:
        """Build a mock Anthropic API response with a tool_use content block."""
        tool_block = MagicMock()
        tool_block.type = "tool_use"
        tool_block.name = "report_redactions"
        tool_block.input = tool_input

        response = MagicMock()
        response.content = [tool_block]
        response.stop_reason = "tool_use"
        return response

    @pytest.mark.anyio
    async def test_single_redaction(self):
        line = _make_line_from_words(["The", "|||", "cat"])
        mock_response = self._make_mock_response({
            "redactions": [
                {"line_index": 0, "left_word": "The", "right_word": "cat"},
            ]
        })

        mock_client = AsyncMock()
        mock_client.messages.create = AsyncMock(return_value=mock_response)

        with patch("unredact.pipeline.llm_detect._get_client", return_value=mock_client):
            results = await detect_redactions_llm([line])

        assert len(results) == 1
        assert results[0].left_word == "The"
        assert results[0].right_word == "cat"
        mock_client.messages.create.assert_called_once()

    @pytest.mark.anyio
    async def test_no_redactions(self):
        line = _make_line_from_words(["Clean", "text"])
        mock_response = self._make_mock_response({"redactions": []})

        mock_client = AsyncMock()
        mock_client.messages.create = AsyncMock(return_value=mock_response)

        with patch("unredact.pipeline.llm_detect._get_client", return_value=mock_client):
            results = await detect_redactions_llm([line])

        assert results == []

    @pytest.mark.anyio
    async def test_empty_lines_list(self):
        """When there are no lines, should return empty without calling LLM."""
        mock_client = AsyncMock()
        mock_client.messages.create = AsyncMock()

        with patch("unredact.pipeline.llm_detect._get_client", return_value=mock_client):
            results = await detect_redactions_llm([])

        assert results == []
        mock_client.messages.create.assert_not_called()

    @pytest.mark.anyio
    async def test_multiple_redactions_across_lines(self):
        line0 = _make_line_from_words(["Foo", "|||", "bar"], y=100)
        line1 = _make_line_from_words(["Baz", "XXX", "qux"], y=200)
        mock_response = self._make_mock_response({
            "redactions": [
                {"line_index": 0, "left_word": "Foo", "right_word": "bar"},
                {"line_index": 1, "left_word": "Baz", "right_word": "qux"},
            ]
        })

        mock_client = AsyncMock()
        mock_client.messages.create = AsyncMock(return_value=mock_response)

        with patch("unredact.pipeline.llm_detect._get_client", return_value=mock_client):
            results = await detect_redactions_llm([line0, line1])

        assert len(results) == 2
        assert results[0].line_index == 0
        assert results[1].line_index == 1

    @pytest.mark.anyio
    async def test_model_configurable_via_env(self):
        line = _make_line_from_words(["Hello", "world"])
        mock_response = self._make_mock_response({"redactions": []})

        mock_client = AsyncMock()
        mock_client.messages.create = AsyncMock(return_value=mock_response)

        with (
            patch("unredact.pipeline.llm_detect._get_client", return_value=mock_client),
            patch.dict("os.environ", {"UNREDACT_LLM_MODEL": "claude-test-model"}),
        ):
            await detect_redactions_llm([line])

        call_kwargs = mock_client.messages.create.call_args
        assert call_kwargs.kwargs.get("model") == "claude-test-model" or \
               (call_kwargs.args and call_kwargs.args[0] == "claude-test-model")

    @pytest.mark.anyio
    async def test_redaction_at_line_start_and_end(self):
        line = _make_line_from_words(["XXX", "middle", "YYY"])
        mock_response = self._make_mock_response({
            "redactions": [
                {"line_index": 0, "left_word": "", "right_word": "middle"},
                {"line_index": 0, "left_word": "middle", "right_word": ""},
            ]
        })

        mock_client = AsyncMock()
        mock_client.messages.create = AsyncMock(return_value=mock_response)

        with patch("unredact.pipeline.llm_detect._get_client", return_value=mock_client):
            results = await detect_redactions_llm([line])

        assert len(results) == 2
        # First redaction at line start
        assert results[0].left_word == ""
        assert results[0].left_x == line.x
        # Second redaction at line end
        assert results[1].right_word == ""
        assert results[1].right_x == line.x + line.w
