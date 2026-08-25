"""Rate the installed Desk roster so the adult-content gate can filter it.

Characters enrolled from now on carry `characters/<slug>/character.json` written
from VRoid Hub's own `age_limit` flags (vroid-sync.enroll). The roster that
predates that has NO metadata at all — `listCharacters()` was a plain readdir —
so this backfills it.

Resolution order per character, most authoritative first:

    1. an existing character.json      (never overwritten unless --force)
    2. VRoid Hub age_limit             (needs the Hub credentials; exact)
    3. the name-marker heuristic       (crude, but the NAME is what leaks first:
                                        a quick-switch menu shows the slug long
                                        before any model renders)
    4. "general"

Usage:
    python rate-characters.py --report            # what is rated, what is not
    python rate-characters.py --apply             # write ratings (heuristic + hub)
    python rate-characters.py --apply --no-hub    # offline; heuristic only
    python rate-characters.py --set <name> r18    # rate one by hand
    python rate-characters.py --apply --force     # re-resolve even rated ones

Exit codes: 0 ok, 1 nothing could be resolved, 2 the roster could not be read.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Roster names include Japanese and accented slugs; a Windows cp1252 console
# raises UnicodeEncodeError mid-listing without this.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

DESK_ROOT = Path(__file__).parent
ROSTER = DESK_ROOT / "characters"
VALID_RATINGS = ("general", "r15", "r18")

# Name markers. Deliberately narrow: a false R18 only hides one character from a
# menu, but this list is not a content classifier and must not be read as one —
# it is a first pass over slugs that were downloaded from an adult-tagged source
# and named accordingly. Anything it misses stays "general" and is listed by
# --report so a human can rate it.
_ADULT_MARKERS = re.compile(
    r"(?:^|[-_])(?:r-?18|r18|nsfw|hentai|lewd|nude|naked|ecchi|porn|xxx|"
    r"cum\w*|slut|whore|bimbo|milf|dilf|futa|bdsm|fetish|erp|adult)(?:[-_]|$)",
    re.IGNORECASE,
)


def installed_characters() -> list[str]:
    if not ROSTER.is_dir():
        print(f"ERROR: roster not found at {ROSTER}", file=sys.stderr)
        raise SystemExit(2)
    return sorted(
        entry.name
        for entry in ROSTER.iterdir()
        if entry.is_dir() and (entry / "model.vrm").exists()
    )


def read_rating(name: str) -> tuple[str, str]:
    """Return (rating, source); ("unrated", "") when nothing is recorded."""
    try:
        data = json.loads((ROSTER / name / "character.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "unrated", ""
    rating = str(data.get("rating") or "").lower()
    return (rating or "unrated"), str(data.get("source") or "")


def write_rating(name: str, rating: str, source: str) -> bool:
    if rating not in VALID_RATINGS:
        print(f"  ERROR invalid rating '{rating}' for {name}", file=sys.stderr)
        return False
    try:
        (ROSTER / name / "character.json").write_text(
            json.dumps({"rating": rating, "source": source}, indent=2),
            encoding="utf-8",
        )
        return True
    except OSError as error:
        print(f"  ERROR could not write {name}: {error}", file=sys.stderr)
        return False


def heuristic_rating(name: str) -> str | None:
    """R18 when the slug itself carries an adult marker, else None (undecided)."""
    return "r18" if _ADULT_MARKERS.search(name) else None


def hub_ratings() -> dict[str, str]:
    """slug -> rating, from every VRoid Hub model this account can enumerate.

    Best effort: without credentials, or with the Hub unreachable, this returns
    {} and the caller falls back to the heuristic. It prints WHY rather than
    failing silently — an empty result that looks like "nothing is adult" is the
    failure mode worth avoiding here.
    """
    try:
        sys.path.insert(0, r"D:\AitherOS-Fresh\AitherOS")
        sys.path.insert(0, str(DESK_ROOT))
        from lib.integrations.vroid_hub import VRoidHub, VRoidHubError

        spec_util = __import__("importlib.util", fromlist=["spec_from_file_location"])
        spec = spec_util.spec_from_file_location("vroid_sync", DESK_ROOT / "vroid-sync.py")
        vroid_sync = spec_util.module_from_spec(spec)
        spec.loader.exec_module(vroid_sync)
    except Exception as error:
        print(f"  (VRoid Hub unavailable: {error}) — heuristic only")
        return {}

    hub = VRoidHub()
    ratings: dict[str, str] = {}
    for endpoint in ("/api/hearts", "/api/account/character_models"):
        try:
            data = hub._request("GET", endpoint, count=100)
        except VRoidHubError as error:
            print(f"  (Hub {endpoint} failed: {error})")
            continue
        for item in data.get("data", []):
            model = item.get("character_model", item) if isinstance(item, dict) else item
            if not isinstance(model, dict):
                continue
            name = model.get("name") or (model.get("character") or {}).get("name") or ""
            if not name:
                continue
            ratings[vroid_sync.slugify(name)] = vroid_sync.rating_from_model(model)
    print(f"  (VRoid Hub resolved {len(ratings)} model rating(s))")
    return ratings


def report() -> int:
    names = installed_characters()
    rated = [(n, *read_rating(n)) for n in names]
    unrated = [n for n, r, _ in rated if r == "unrated"]
    print(f"\n  {len(names)} installed character(s)\n")
    for name, rating, source in rated:
        flag = "  " if rating in ("unrated", "general") else "* "
        print(f"  {flag}{name:<44} {rating:<8} {source}")
    print(f"\n  {len(unrated)} unrated (treated as general — visible to everyone)")
    if unrated:
        print("  Rate one by hand:  python rate-characters.py --set <name> r18\n")
    return 0


def apply(force: bool, use_hub: bool) -> int:
    names = installed_characters()
    hub_map = hub_ratings() if use_hub else {}
    written = 0
    skipped = 0
    for name in names:
        current, _ = read_rating(name)
        if current != "unrated" and not force:
            skipped += 1
            continue
        rating = hub_map.get(name)
        source = "vroid"
        if rating is None:
            rating = heuristic_rating(name)
            source = "heuristic"
        if rating is None:
            rating, source = "general", "default"
        if write_rating(name, rating, source):
            written += 1
            if rating != "general":
                print(f"  {name} -> {rating} ({source})")
    print(f"\n  wrote {written}, left {skipped} already-rated untouched")
    if written == 0 and skipped == 0:
        print("  ERROR: nothing was rated", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", action="store_true", help="show current ratings")
    parser.add_argument("--apply", action="store_true", help="write ratings")
    parser.add_argument("--force", action="store_true", help="re-resolve rated ones too")
    parser.add_argument("--no-hub", action="store_true", help="skip VRoid Hub lookups")
    parser.add_argument("--set", nargs=2, metavar=("NAME", "RATING"), help="rate one by hand")
    args = parser.parse_args()

    if args.set:
        name, rating = args.set
        if not (ROSTER / name).is_dir():
            print(f"ERROR: no character named '{name}'", file=sys.stderr)
            return 1
        return 0 if write_rating(name, rating.lower(), "manual") else 1
    if args.apply:
        return apply(force=args.force, use_hub=not args.no_hub)
    return report()


if __name__ == "__main__":
    raise SystemExit(main())
