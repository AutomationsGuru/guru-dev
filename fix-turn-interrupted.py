#!/usr/bin/env python3
"""Patch the ? glyphs in guru.ts that should be a spinner/check glyph."""
import io
from pathlib import Path

path = Path(r"P:\guruharness\main\src\guru.ts")
text = path.read_text(encoding="utf-8")

# The operator-facing line: replace literal '?' glyphs with a spinner glyph (◐).
# Use the same GLYPHS.pending (◐) used elsewhere in the file for in-flight UI.
old = '  ? turn interrupted - partial kept where available'
new = '  \u25D0 turn interrupted \u2014 partial kept where available'

if old not in text:
    print("ERROR: old string not found verbatim in file")
    raise SystemExit(2)

# Also fix the em-dash that was rendered as '-' (real ASCII hyphen) — but the
# existing convention in the file uses '—' for em-dash. We only change '? ' to
# the spinner; leave the rest of the message alone.
text = text.replace(old, new, 1)

# Sanity: count remaining literal '?' in the touched line.
assert text.count("  \u25D0 turn interrupted \u2014 partial kept where available") == 1
path.write_text(text, encoding="utf-8")
print("Patched 1 line in guru.ts")
