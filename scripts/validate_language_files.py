#!/usr/bin/env python3
"""Validate language files against the English language-file schema."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
LANGUAGE_DIRECTORY = ROOT / "language"
REFERENCE_FILE = LANGUAGE_DIRECTORY / "en.json"

# Template tokens use single braces. Matching repeated braces as one token makes
# common mistakes such as {{http_host}} different from the required {http_host}.
TEMPLATE_TOKEN = re.compile(r"\{+[A-Za-z_][A-Za-z0-9_]*\}+")
HTML_TOKEN = re.compile(r"</?[A-Za-z][^<>]*>")


class DuplicateKeyError(ValueError):
    """Raised when a JSON object contains the same key more than once."""


def _object_without_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate key {key!r}")
        result[key] = value
    return result


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as source:
        return json.load(source, object_pairs_hook=_object_without_duplicate_keys)


def format_tokens(value: str) -> Counter[str]:
    """Return non-translatable template and HTML tokens in a string."""
    return Counter(TEMPLATE_TOKEN.findall(value) + HTML_TOKEN.findall(value))


def describe(value: Any) -> str:
    if isinstance(value, bool):
        return str(value).lower()
    if value is None:
        return "null"
    if isinstance(value, dict):
        return "an object"
    if isinstance(value, list):
        return "an array"
    return f"{type(value).__name__} {value!r}"


def _format_counter(tokens: Counter[str]) -> str:
    expanded = sorted(tokens.elements())
    return ", ".join(repr(token) for token in expanded) or "none"


def validate_value(candidate: Any, reference: Any, key: str) -> list[str]:
    """Validate supplied values; keys absent from a translation remain optional."""
    errors: list[str] = []

    if isinstance(reference, dict):
        if not isinstance(candidate, dict):
            return [f"{key or '<root>'}: expected an object; got {describe(candidate)}"]

        for child_key, child_value in candidate.items():
            child_path = f"{key}.{child_key}" if key else child_key
            if child_key not in reference:
                errors.append(f"{child_path}: key does not exist in {REFERENCE_FILE.name}")
                continue
            errors.extend(validate_value(child_value, reference[child_key], child_path))
        return errors

    if isinstance(reference, bool):
        if not isinstance(candidate, bool):
            return [
                f"{key}: expected boolean {str(reference).lower()}; "
                f"got {describe(candidate)}"
            ]
        if candidate != reference:
            return [
                f"{key}: boolean setting must remain {str(reference).lower()}; "
                f"got {str(candidate).lower()}"
            ]
        return []

    if isinstance(reference, str):
        if not isinstance(candidate, str):
            return [f"{key}: expected a string; got {describe(candidate)}"]

        required = format_tokens(reference)
        supplied = format_tokens(candidate)
        if supplied != required:
            errors.append(
                f"{key}: format tokens must match {REFERENCE_FILE.name}; "
                f"expected {_format_counter(required)}, got {_format_counter(supplied)}"
            )
        return errors

    if isinstance(reference, list):
        if not isinstance(candidate, list):
            return [f"{key}: expected an array; got {describe(candidate)}"]

        # Lists in the current schema contain translatable strings. Validate the
        # shape and any format tokens without requiring translated text to match.
        if reference:
            item_reference = reference[0]
            for index, item in enumerate(candidate):
                errors.extend(validate_value(item, item_reference, f"{key}[{index}]"))
        return errors

    if type(candidate) is not type(reference):
        errors.append(
            f"{key}: expected {type(reference).__name__}; got {describe(candidate)}"
        )
    return errors


def validate_file(path: Path, reference: Any) -> list[str]:
    try:
        candidate = load_json(path)
    except (OSError, UnicodeError, json.JSONDecodeError, DuplicateKeyError) as error:
        return [f"invalid JSON: {error}"]
    if not isinstance(candidate, dict):
        return validate_value(candidate, reference, "")
    candidate = dict(candidate)
    direction = candidate.pop("direction", "ltr")
    font_class = candidate.pop("fontClass", None)
    errors = []
    if direction not in {"ltr", "rtl"}:
        errors.append("direction: expected 'ltr' or 'rtl'")
    if font_class not in {None, "l"}:
        errors.append("fontClass: expected 'l' when supplied")
    return errors + validate_value(candidate, reference, "")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "files",
        nargs="*",
        type=Path,
        help="language files to check (default: language/*.json)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        reference = load_json(REFERENCE_FILE)
    except (OSError, UnicodeError, json.JSONDecodeError, DuplicateKeyError) as error:
        print(f"{REFERENCE_FILE}: invalid reference JSON: {error}", file=sys.stderr)
        return 1

    files = args.files or sorted(LANGUAGE_DIRECTORY.glob("*.json"))
    failures = 0
    for path in files:
        errors = validate_file(path, reference)
        for error in errors:
            print(f"{path}: {error}", file=sys.stderr)
        failures += len(errors)

    if failures:
        print(f"Language validation failed with {failures} error(s).", file=sys.stderr)
        return 1

    print(f"Validated {len(files)} language file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
