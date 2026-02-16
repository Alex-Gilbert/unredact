# tests/test_email_solve.py
import pytest
from PIL import ImageFont
from unittest.mock import patch

from unredact.pipeline.dictionary import solve_dictionary


def _get_test_font() -> ImageFont.FreeTypeFont:
    import subprocess
    result = subprocess.run(
        ["fc-match", "--format=%{file}", "Liberation Serif"],
        capture_output=True, text=True,
    )
    return ImageFont.truetype(result.stdout.strip(), 40)


class TestGetEmails:
    def test_loads_from_file(self, tmp_path):
        """_get_emails() should load emails from emails.txt."""
        import unredact.pipeline.word_filter as wf
        old = wf._emails
        try:
            wf._emails = None  # reset cache
            emails_file = tmp_path / "emails.txt"
            emails_file.write_text("test@example.com\nfoo@bar.org\n")
            with patch.object(wf, "DATA_DIR", tmp_path):
                result = wf._get_emails()
                assert "test@example.com" in result
                assert "foo@bar.org" in result
                assert len(result) == 2
        finally:
            wf._emails = old

    def test_returns_list(self, tmp_path):
        """_get_emails() should return a list, not a set."""
        import unredact.pipeline.word_filter as wf
        old = wf._emails
        try:
            wf._emails = None
            emails_file = tmp_path / "emails.txt"
            emails_file.write_text("a@b.com\n")
            with patch.object(wf, "DATA_DIR", tmp_path):
                result = wf._get_emails()
                assert isinstance(result, list)
        finally:
            wf._emails = old

    def test_missing_file_returns_empty(self, tmp_path):
        """_get_emails() should return empty list if file doesn't exist."""
        import unredact.pipeline.word_filter as wf
        old = wf._emails
        try:
            wf._emails = None
            with patch.object(wf, "DATA_DIR", tmp_path):
                result = wf._get_emails()
                assert result == []
        finally:
            wf._emails = old


class TestEmailWidthMatching:
    def test_finds_matching_email(self):
        """Known emails that fit the pixel width should be returned."""
        font = _get_test_font()
        entries = ["test@example.com", "short@x.co", "verylongemailaddress@domain.com"]
        target = font.getlength("test@example.com")
        results = solve_dictionary(font, entries, target, tolerance=0.5)
        texts = [r.text for r in results]
        assert "test@example.com" in texts

    def test_with_angle_bracket_context(self):
        """Email matching should work with < > context characters."""
        font = _get_test_font()
        email = "test@example.com"
        entries = [email, "other@domain.com"]
        full_width = font.getlength("<" + email + ">")
        left_w = font.getlength("<")
        right_w = font.getlength(">")
        target = full_width - left_w - right_w
        results = solve_dictionary(
            font, entries, target, tolerance=1.0,
            left_context="<", right_context=">",
        )
        texts = [r.text for r in results]
        assert email in texts
