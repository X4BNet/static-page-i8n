import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "validate_language_files.py"
SPEC = importlib.util.spec_from_file_location("validate_language_files", SCRIPT)
assert SPEC and SPEC.loader
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


class LanguageFileValidatorTests(unittest.TestCase):
    def validate(self, candidate, reference):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.json"
            path.write_text(json.dumps(candidate), encoding="utf-8")
            return VALIDATOR.validate_file(path, reference)

    def test_partial_language_file_is_allowed(self):
        reference = {
            "message": "Visit {host} or <a href=\"\">try again</a>",
            "enabled": True,
        }
        self.assertEqual(self.validate({"enabled": True}, reference), [])

    def test_direction_metadata_accepts_rtl_and_rejects_unknown_values(self):
        reference = {"message": "Text"}
        self.assertEqual(
            self.validate({"direction": "rtl", "message": "نص"}, reference), []
        )
        errors = self.validate(
            {"direction": "sideways", "message": "Text"}, reference
        )
        self.assertIn("expected 'ltr' or 'rtl'", errors[0])

    def test_template_token_must_be_preserved_exactly(self):
        errors = self.validate(
            {"message": "Visite {{host}}"}, {"message": "Visit {host}"}
        )
        self.assertIn("format tokens must match", errors[0])

    def test_html_tokens_and_attributes_must_be_preserved(self):
        errors = self.validate(
            {"message": "<a>Try again</a>"},
            {"message": "<a href=\"\">Try again</a>"},
        )
        self.assertIn("'<a href=\"\">'", errors[0])

    def test_boolean_must_not_be_a_string(self):
        errors = self.validate({"enabled": "true"}, {"enabled": True})
        self.assertIn("expected boolean true", errors[0])

    def test_boolean_setting_must_not_change(self):
        errors = self.validate({"enabled": False}, {"enabled": True})
        self.assertIn("must remain true", errors[0])

    def test_unknown_key_is_rejected(self):
        errors = self.validate({"mesage": "text"}, {"message": "Text"})
        self.assertIn("key does not exist", errors[0])


if __name__ == "__main__":
    unittest.main()
