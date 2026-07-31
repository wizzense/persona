"""Refuse to stamp a PG artifact that names adult content.

Copied verbatim into each tree's scripts/ rather than imported from AitherOS:
these trees must build without AitherOS present, and a build that silently
skipped its own verification because an import failed would be the exact
failure mode this exists to prevent. Keep in step with
AitherOS/dev/tools/check_adult_content_gate.py.
"""
import re
from pathlib import Path

ADULT_VOCABULARY = {
    "areola", "nipple", "crotch", "cunt", "dildo", "dick", "cock", "pussy",
    "vagina", "vulva", "anus", "asshole", "scrotum", "urethra",
    "undress", "reclothe", "cumshot", "jizz", "creampie",
    "e621", "danbooru", "gelbooru", "konachan", "rule34",
    "redgifs", "xvideos", "xhamster", "pornhub", "moebooru",
    "milf", "dilf", "loli", "shota", "hentai", "r18", "r-18", "nsfw",
    "nude", "nudity", "naked", "topless", "boob", "boobs", "tits", "butt",
    "porn", "futa", "yiff", "bdsm", "fetish", "slut", "whore", "cum",
    "erotic", "lewd", "smut", "orgasm", "genital",
}

_TEXT_SUFFIXES = {
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".yaml", ".yml",
    ".txt", ".md", ".html", ".css", ".svg", ".as",
}

# A module that ENFORCES the gate must be able to name what it hides; failing
# the build on those would punish the only code doing the job. Source files
# only -- an ASSET never gets this exemption.
_GUARD_TOKENS = (
    "detect", "detection", "filter", "gate", "guard", "moder", "safety",
    "classif", "block", "sanitiz", "redact", "rating", "roster", "policy",
)
_SOURCE_SUFFIXES = (".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".go", ".rs")

_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(w) for w in sorted(ADULT_VOCABULARY)) + r")\b",
    re.IGNORECASE,
)


def _is_guard_module(path):
    if path.suffix.lower() not in _SOURCE_SUFFIXES:
        return False
    leaf = path.name.lower()
    return any(tok in leaf for tok in _GUARD_TOKENS)


def scan_for_adult_content(root):
    """Return [(path, token)] for every adult-vocabulary hit in the artifact.

    Checks FILE NAMES as well as content -- a filename is visible in a directory
    listing without opening anything, which is the whole point.
    """
    hits = []
    for path in Path(root).rglob("*"):
        if not path.is_file() or _is_guard_module(path):
            continue
        name_match = _PATTERN.search(path.name)
        if name_match:
            hits.append((path, name_match.group(0)))
            continue
        if path.suffix.lower() not in _TEXT_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError as exc:
            # Unreadable means UNVERIFIED, which is not the same as clean.
            hits.append((path, f"<unreadable: {exc.__class__.__name__}>"))
            continue
        match = _PATTERN.search(text)
        if match:
            hits.append((path, match.group(0)))
    return hits


def verify_or_die(output_dir, tree_name):
    """Exit 1 without stamping if the artifact names adult content."""
    hits = scan_for_adult_content(output_dir)
    if not hits:
        print(f"\nVerified clean: 0 adult-vocabulary hits in {tree_name}-pg")
        return
    print(f"\nBUILD FAILED — {len(hits)} adult-vocabulary hit(s) in the artifact:")
    for path, token in hits[:20]:
        print(f"    {token!r:14} {Path(path).relative_to(output_dir)}")
    if len(hits) > 20:
        print(f"    ... and {len(hits) - 20} more")
    print(
        "\nNo .pg-artifact marker written. Narrow .pgship (or sanitise the "
        "offending files) and rebuild. A PG bundle that names adult content is "
        "not a PG bundle."
    )
    raise SystemExit(1)
