#!/usr/bin/env python3
"""Fork a roster character into a customised variant -- no mesh is copied.

Owner, 2026-09-20: "can we fork and customise all of the characters we've
downloaded". A variant is a RECIPE over its base, not a duplicate: it costs a
few hundred bytes, the original is never touched, and the renderer applies the
deltas at load (useVrmLoader.applyCustomise, the same seam the spring-physics
knobs use). Fork a 60 MB model fifty times and you have used 60 MB.

    python fork-character.py gold-kitsune tall --bone head=1.1 --bone hips=1.05
    python fork-character.py 通常版 cheerful --shape happy=0.3 --tint "#ffcc00" --tint-strength 0.4
    python fork-character.py --list                 # every variant and its base
    python fork-character.py --show gold-kitsune-tall

TWO RULES THIS ENFORCES, because both are the kind that only bite later:

  LICENCE. The model's own embedded VRM meta says whether modification is
  permitted, and that is the author's term rather than our policy. Measured
  across this roster on 2026-09-20: all 66 permit it (48 VRM 0.x
  `modification=allow`, 1 `allowModification`, 17
  `allowModificationRedistribution`), so the gate costs nothing today and is
  what stops it costing everything the day a model that forbids it arrives.

  RATING. A fork is UNRATED until something looks at it -- so it is hidden like
  any unjudged character -- and once judged it can never resolve TAMER than its
  base. Without that, forking is a gate bypass: fork an r18 model, rate the
  variant "general", and the hidden body is back on the public roster under a
  new name. Rate a fresh fork with:
      python rate-characters.py --only <base>-<variant> --apply --vision --capture

The heavy lifting lives in electron/character-roster.cjs (forkCharacter,
customiseOf, modificationAllowed) so the desk and this CLI cannot disagree
about what a fork is; this file is the hands.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

DESK_ROOT = Path(__file__).parent
ROSTER = DESK_ROOT / "characters"


def node_call(expression: str) -> tuple[int, str, str]:
    """Run one expression against character-roster.cjs and hand back its JSON.

    Shelling into node rather than reimplementing the rules here is the point:
    the rating walk and the licence read are safety logic, and a second copy of
    safety logic is a second copy that can drift out of agreement with the one
    the desk actually enforces.
    """
    script = (
        "const r=require('./electron/character-roster.cjs');"
        "const c=require('./electron/content-rating.cjs');"
        f"const out=({expression});"
        "process.stdout.write(JSON.stringify(out===undefined?null:out));"
    )
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=DESK_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return proc.returncode, proc.stdout, proc.stderr


def jsnode(expression: str):
    rc, out, err = node_call(expression)
    if rc != 0:
        print(f"ERROR: node refused: {err.strip()[:300]}", file=sys.stderr)
        raise SystemExit(2)
    try:
        return json.loads(out or "null")
    except ValueError:
        print(f"ERROR: unparseable answer: {out[:200]!r}", file=sys.stderr)
        raise SystemExit(2)


def pairs(values: list[str] | None, what: str) -> dict[str, float]:
    """`name=number` repeated. A bad pair is fatal: silently dropping half a
    recipe would show up as "the slider did nothing"."""
    out: dict[str, float] = {}
    for raw in values or []:
        if "=" not in raw:
            print(f"ERROR: --{what} wants name=value, got {raw!r}", file=sys.stderr)
            raise SystemExit(2)
        key, _, number = raw.partition("=")
        try:
            out[key.strip()] = float(number)
        except ValueError:
            print(f"ERROR: --{what} {raw!r}: {number!r} is not a number", file=sys.stderr)
            raise SystemExit(2)
    return out


def cmd_list() -> int:
    rows = []
    for d in sorted(p for p in ROSTER.iterdir() if p.is_dir()):
        try:
            record = json.loads((d / "character.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if record.get("base"):
            rows.append(
                (d.name, record["base"], record.get("source", ""), bool(record.get("customise")))
            )
    if not rows:
        print("\n  no variants yet. Make one:")
        print("    python fork-character.py <base> <variant> --bone head=1.1\n")
        return 0
    print(f"\n  {len(rows)} variant(s)\n")
    for name, base, source, has in rows:
        rating = jsnode(f"c.getRating({json.dumps(name)})")
        hidden = jsnode(f"c.hiddenReason({json.dumps(name)})")
        flag = "  " if not hidden else "* "
        print(
            f"  {flag}{name:<44} <- {base:<28} {rating:<8} {'recipe' if has else 'EMPTY'}"
            + (f"  [hidden: {hidden}]" if hidden else "")
        )
    print()
    return 0


def cmd_show(name: str) -> int:
    if not (ROSTER / name).is_dir():
        print(f"ERROR: no character named {name!r}", file=sys.stderr)
        return 1
    record = json.loads((ROSTER / name / "character.json").read_text(encoding="utf-8"))
    merged = jsnode(f"r.customiseOf({json.dumps(name)})")
    print(f"\n  {name}")
    print(f"    base         {record.get('base') or '(none -- an original)'}")
    print(
        f"    rating       {jsnode(f'c.getRating({json.dumps(name)})')}"
        f"   hidden: {jsnode(f'c.hiddenReason({json.dumps(name)})') or 'no'}"
    )
    print(f"    licence      {record.get('licence') or '(not recorded)'}")
    print(f"    model        {jsnode(f'r.resolveModelFile({json.dumps(name)})') or 'UNRESOLVED'}")
    print(f"    recipe       {json.dumps(merged, ensure_ascii=False)}\n")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0], formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("base", nargs="?", help="the character to fork")
    ap.add_argument("variant", nargs="?", help="a short suffix: <base>-<variant>")
    ap.add_argument(
        "--bone",
        action="append",
        metavar="NAME=SCALE",
        help="scale a humanoid bone (head=1.1); 0.5-2, children move with it",
    )
    ap.add_argument(
        "--shape", action="append", metavar="NAME=VALUE", help="hold an expression (happy=0.3); 0-1"
    )
    ap.add_argument("--tint", metavar="#RRGGBB", help="tint every material toward this colour")
    ap.add_argument("--tint-strength", type=float, default=1.0, metavar="0-1")
    ap.add_argument("--outline", type=float, metavar="WIDTH", help="MToon outline width")
    ap.add_argument("--list", action="store_true", help="every variant and its base")
    ap.add_argument("--show", metavar="NAME", help="one variant's resolved recipe")
    args = ap.parse_args()

    if args.list:
        return cmd_list()
    if args.show:
        return cmd_show(args.show)
    if not args.base or not args.variant:
        ap.print_help()
        return 2

    recipe: dict = {}
    bones = pairs(args.bone, "bone")
    shapes = pairs(args.shape, "shape")
    if bones:
        recipe["boneScale"] = bones
    if shapes:
        recipe["blendshapes"] = shapes
    materials = {}
    if args.tint:
        materials["tint"] = args.tint
        materials["tintStrength"] = args.tint_strength
    if args.outline is not None:
        materials["outlineWidth"] = args.outline
    if materials:
        recipe["materials"] = materials
    if not recipe:
        print(
            "ERROR: a fork with an empty recipe is just a second name for the same "
            "character. Give at least one of --bone / --shape / --tint / --outline.",
            file=sys.stderr,
        )
        return 2

    result = jsnode(
        f"r.forkCharacter({json.dumps(args.base)},{json.dumps(args.variant)},{json.dumps(recipe)})"
    )
    if not result or not result.get("ok"):
        print(f"REFUSED: {(result or {}).get('reason')}", file=sys.stderr)
        return 1
    name = result["name"]
    print(f"\n  forked {args.base} -> {name}")
    print(f"    recipe   {json.dumps(recipe, ensure_ascii=False)}")
    print(f"    rating   {result.get('rating')}  (a fork is hidden until it is judged)")
    print("\n  Make it visible:")
    print(f"    python rate-characters.py --only {name} --apply --vision --capture\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
