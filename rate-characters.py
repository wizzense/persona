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
    4. a LOOK at the model (--vision)  (awvision over characters/<slug>/fullbody.jpg,
                                        else thumbnail.jpg; the rubric is below)
    5. "general", source "default"     (NEVER judged -- the desk hides these
                                        while the adult gate is closed, exactly
                                        like r15/r18, so an unrated body cannot
                                        be found by browsing)

Owner, 2026-09-20: "make the lewd avatars hard to find unless you've checked a
box". Measured that day: 62 of 66 installed characters carried the step-5
stamp -- never judged, listed as general to everyone. Step 4 is the fix: a
name says nothing about a body, and only a look does.

Usage:
    python rate-characters.py --report            # what is rated, what is not
    python rate-characters.py --apply             # write ratings (heuristic + hub)
    python rate-characters.py --apply --no-hub    # offline; heuristic only
    python rate-characters.py --apply --vision    # + look at each unjudged model
    python rate-characters.py --apply --vision --capture   # ask the running desk for
                                                  # full-body frames first (best)
    python rate-characters.py --set <name> r18    # rate one by hand
    python rate-characters.py --apply --force     # re-resolve even rated ones

Exit codes: 0 ok, 1 nothing could be resolved, 2 the roster could not be read.
"""
from __future__ import annotations

import argparse
import json
import re
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Roster names include Japanese and accented slugs; a Windows cp1252 console
# raises UnicodeEncodeError mid-listing without this.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

PERSONA_ROOT = Path(__file__).parent
ROSTER = PERSONA_ROOT / "characters"
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

# Japanese markers need no [-_] word boundaries: the ASCII list above matches
# only romanized slugs, so Japanese-script names slipped through to the
# step-4 default and were listed as "general" — measured 2026-08-07, which is
# why this second pass exists. Substring match is safe here: these tokens have
# no innocent compound uses in a character-name context. (Detection vocabulary
# stays: a filter must contain what it filters. No roster name is repeated in
# this file or in any other shipped file.)
_ADULT_MARKERS_UNICODE = re.compile(
    r"全裸|おもらし|サキュバス|えっち|エロ|裸体|半裸|淫|痴女|絶頂|乳首|下着|"
    r"ランジェリー|セクシー|オナ|ふたなり"
)
# Suggestive-but-not-R18 markers (swimsuit, etc.) → r15: hidden from the public
# SFW roster, still visible on age-gated surfaces.
_R15_MARKERS_UNICODE = re.compile(r"水着|ビキニ|バニー|レオタード")


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
    """R18/R15 when the slug itself carries an adult marker, else None (undecided)."""
    if _ADULT_MARKERS.search(name) or _ADULT_MARKERS_UNICODE.search(name):
        return "r18"
    if _R15_MARKERS_UNICODE.search(name):
        return "r15"
    return None


# The look. One word back, on a rubric that names the two lines the desk draws:
# r15 is hidden from the public roster but shown on age-gated surfaces; r18 is
# adult. "If you cannot see the body, judge what is visible" is deliberate --
# a head-only thumbnail must still answer, and the fullbody.jpg the desk can
# capture (Cast pane / desk:capture-roster) makes the answer honest.
#
# 🚩 THE LINE BETWEEN R15 AND R18 HAS TO BE SPELLED OUT. Measured 2026-09-20 on
# the first full-body pass: with "R18: exposed breasts" the model rated `helen`
# -- a character in a sweater and trousers with a deep neckline -- R18, and the
# cast gate then refused an agent's own authored body (CAST002). Cleavage is not
# nudity. The rubric now says which side each case falls on, and says it in the
# words the model actually keys on.
_VISION_RUBRIC = (
    "Rate this 3D character model for an all-ages desktop app. Reply with exactly "
    "one word. "
    "GENERAL: everyday, costume, armour or fantasy clothing; a normal outfit, even "
    "a tight or form-fitting one. "
    "R15: swimwear, lingerie, underwear, a bikini, a leotard, an outfit that leaves "
    "most of the torso or hips bare, or a clearly sexualized pose. Cleavage or a "
    "low neckline on an otherwise clothed character is R15 at most, never R18. "
    "R18: actual nudity -- bare nipples, bare genitals, a fully unclothed body -- or "
    "explicit sexual content. An untextured grey mannequin with no clothing counts "
    "as R18. "
    "If you cannot see the body, judge what is visible. One word only."
)
_SEVERITY = {"general": 0, "r15": 1, "r18": 2}
_VISION_WORDS = {
    "general": "general", "safe": "general", "sfw": "general", "pg": "general",
    "r15": "r15", "r-15": "r15", "suggestive": "r15", "revealing": "r15",
    "r18": "r18", "r-18": "r18", "explicit": "r18", "nude": "r18", "nudity": "r18",
    "nsfw": "r18", "adult": "r18",
}


def vision_image(name: str) -> tuple[Path | None, str]:
    """The best picture of this character: a full-body capture beats the head crop."""
    for filename, source in (("fullbody.jpg", "vision"), ("thumbnail.jpg", "vision-thumb")):
        candidate = ROSTER / name / filename
        if candidate.is_file() and candidate.stat().st_size > 0:
            return candidate, source
    return None, ""


def vision_rating(name: str, timeout: float = 90.0) -> tuple[str | None, str]:
    """(rating, source) from a look at the model, or (None, why) when there is none.

    Shells out to `awvision ask` (the sight plane -- the endpoint and model are
    its own settings, AWVISION_URL / AWVISION_MODEL). A reply that is not one of
    the rubric's words is a refusal to judge, never a "general": an unparsed
    answer that read as safe would be exactly the leak this step exists to close.
    """
    image, source = vision_image(name)
    if image is None:
        return None, "no image to look at"
    tool = shutil.which("awvision")
    if not tool:
        return None, "awvision is not installed"
    try:
        proc = subprocess.run(
            [tool, "ask", str(image), _VISION_RUBRIC],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return None, f"awvision failed: {error}"
    if proc.returncode != 0:
        return None, f"awvision rc={proc.returncode}: {(proc.stderr or proc.stdout).strip()[:120]}"
    for token in re.findall(r"[A-Za-z0-9-]+", proc.stdout or ""):
        word = _VISION_WORDS.get(token.lower())
        if word:
            return word, source
    return None, f"unparsed answer: {(proc.stdout or '').strip()[:80]!r}"


# The running desk renders a full-body frame per character on request
# (electron/bridge-server.cjs POST /roster/capture, bearer = the harness token
# every desk client already holds). A head crop is what let a revealing body
# read as general; this is the fix, and it needs the desk up.
DESK_BRIDGE = os.environ.get("DESK_BRIDGE_URL", "http://127.0.0.1:47931")


def _bridge_token() -> str | None:
    token = os.environ.get("AITHER_HARNESS_TOKEN", "").strip()
    if token:
        return token
    try:
        return (Path.home() / ".aither" / "harness_token").read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def capture_fullbody(names: list[str], force: bool = False, timeout_s: float = 900.0) -> tuple[int, str]:
    """Ask the desk for fullbody.jpg of every character that lacks one; wait.

    Returns (captured, why). 0 with a reason when the desk is not running, the
    bridge refuses, or nothing was pending -- the caller carries on with the
    thumbnails it has, and SAYS so, rather than pretending the look was full.
    """
    token = _bridge_token()
    if not token:
        return 0, "no bridge token (~/.aither/harness_token) -- the desk's capture door needs it"
    body = json.dumps({"names": names, "force": force}).encode("utf-8")
    req = urllib.request.Request(
        f"{DESK_BRIDGE}/roster/capture", data=body, method="POST",
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            started = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return 0, f"desk refused the capture: HTTP {error.code} {error.read().decode('utf-8', 'replace')[:120]}"
    except (urllib.error.URLError, OSError, ValueError) as error:
        return 0, f"desk not reachable at {DESK_BRIDGE}: {error}"
    requested = int(started.get("requested") or 0)
    if not started.get("ok"):
        return 0, f"desk could not start the capture: {started.get('error')}"
    if requested == 0:
        return 0, f"nothing to capture ({started.get('skipped', 0)} already have a full-body frame)"
    print(f"  desk is rendering {requested} full-body frame(s)...")
    deadline = time.monotonic() + timeout_s
    last_done = -1
    while time.monotonic() < deadline:
        time.sleep(3)
        try:
            with urllib.request.urlopen(f"{DESK_BRIDGE}/roster/capture", timeout=10) as resp:
                status = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError):
            continue
        done = int(status.get("done") or 0)
        if done != last_done:
            print(f"    {done}/{requested}")
            last_done = done
        if not status.get("pending"):
            return done, "captured"
    return max(last_done, 0), f"timed out after {int(timeout_s)}s with {requested - max(last_done, 0)} frame(s) still pending"


def stronger(a: str | None, b: str | None) -> str | None:
    """The more restrictive of two ratings (None = undecided)."""
    if a is None:
        return b
    if b is None:
        return a
    return a if _SEVERITY[a] >= _SEVERITY[b] else b


def hub_ratings() -> dict[str, str]:
    """slug -> rating, from every VRoid Hub model this account can enumerate.

    Best effort: without credentials, or with the Hub unreachable, this returns
    {} and the caller falls back to the heuristic. It prints WHY rather than
    failing silently — an empty result that looks like "nothing is adult" is the
    failure mode worth avoiding here.
    """
    try:
        sys.path.insert(0, r"D:\AitherOS-Fresh\AitherOS")
        sys.path.insert(0, str(PERSONA_ROOT))
        from lib.integrations.vroid_hub import VRoidHub, VRoidHubError

        spec_util = __import__("importlib.util", fromlist=["spec_from_file_location"])
        spec = spec_util.spec_from_file_location("vroid_sync", PERSONA_ROOT / "vroid-sync.py")
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
    unjudged = [n for n, r, src in rated if r == "unrated" or src in ("", "default")]
    print(f"\n  {len(names)} installed character(s)\n")
    for name, rating, source in rated:
        flag = "  " if rating in ("unrated", "general") else "* "
        print(f"  {flag}{name:<44} {rating:<8} {source}")
    print(f"\n  {len(unjudged)} never judged (hidden while the adult gate is closed, like r15/r18)")
    if unjudged:
        print("  Judge them:  python rate-characters.py --apply --vision")
        print("  Or by hand:  python rate-characters.py --set <name> r18\n")
    return 0


def apply(force: bool, use_hub: bool, use_vision: bool = False, capture: bool = False) -> int:
    names = installed_characters()
    if capture:
        captured, why = capture_fullbody(names, force=force)
        print(f"  full-body capture: {captured} ({why})")
    hub_map = hub_ratings() if use_hub else {}
    written = 0
    skipped = 0
    unjudged_left = 0
    for name in names:
        current, current_source = read_rating(name)
        # A "default" stamp is step 5 -- nothing ever judged this body -- so it
        # is re-resolved without --force; only a real verdict is sticky. A
        # head-crop verdict ("vision-thumb") is re-judged the moment a
        # full-body frame exists: the whole point of the frame.
        upgradable = current_source == "vision-thumb" and (ROSTER / name / "fullbody.jpg").is_file()
        if current != "unrated" and current_source not in ("", "default") and not force and not upgradable:
            skipped += 1
            continue
        rating = hub_map.get(name)
        source = "vroid"
        if rating is None:
            rating = heuristic_rating(name)
            source = "heuristic"
        if use_vision and (rating is None or rating != "r18"):
            seen, seen_source = vision_rating(name)
            if seen is None:
                print(f"  {name}: could not look ({seen_source})")
            else:
                merged = stronger(rating, seen)
                if merged == seen and merged != rating:
                    source = seen_source
                elif rating is not None and merged == rating and seen != rating:
                    source = f"{source}+{seen_source}"
                elif rating is None:
                    source = seen_source
                rating = merged
        if rating is None:
            rating, source = "general", "default"
            unjudged_left += 1
        if write_rating(name, rating, source):
            written += 1
            if rating != "general" or source != "default":
                print(f"  {name} -> {rating} ({source})")
    print(f"\n  wrote {written}, left {skipped} already-judged untouched, {unjudged_left} still unjudged")
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
    parser.add_argument("--vision", action="store_true", help="look at each unjudged model (awvision)")
    parser.add_argument("--capture", action="store_true",
                        help="ask the running desk for full-body frames before looking")
    parser.add_argument("--set", nargs=2, metavar=("NAME", "RATING"), help="rate one by hand")
    args = parser.parse_args()

    if args.set:
        name, rating = args.set
        if not (ROSTER / name).is_dir():
            print(f"ERROR: no character named '{name}'", file=sys.stderr)
            return 1
        return 0 if write_rating(name, rating.lower(), "manual") else 1
    if args.apply:
        return apply(force=args.force, use_hub=not args.no_hub, use_vision=args.vision, capture=args.capture)
    return report()


if __name__ == "__main__":
    raise SystemExit(main())
