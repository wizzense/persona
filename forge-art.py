#!/usr/bin/env python3
"""Turn a roster character into consistent ART -- a turntable, a dataset, a LoRA.

Stage 2 of the owner's 2026-09-20 ask ("fork and customise all of the characters
we've downloaded ... media forge / iris"). Stage 1 (fork-character.py) makes new
BODIES out of the VRMs. This makes new PICTURES of them: cards, expressions,
sprites, promo art -- anything Iris or a prompt can ask for, of THAT character
rather than something that merely resembles it.

    python forge-art.py gold-kitsune --capture --angles 8      # dataset from the VRM
    python forge-art.py gold-kitsune --train                   # the LoRA (GPU)
    python forge-art.py gold-kitsune --render 4 --prompt "drinking coffee"
    python forge-art.py --list

WHY THE TURNTABLE IS THE POINT. media-forge holds `face_refs` and an IP-adapter
weight, and on ONE front T-pose render that produces the character's vibe, not
the character: measured 2026-09-20 on gold-kitsune, the result was a gold fox in
a yellow dress -- right palette, wrong body, wrong outfit. The VRM is ground
truth, so `--capture` asks the desk to render the model from N evenly spaced
yaws (POST /roster/capture, angles=N) and trains on the ring. That is the whole
trick: we own a 3D model of the character, so we can manufacture a perfect,
consistent, correctly-lit dataset instead of scraping one.

RATING TRAVELS WITH IT. A character hidden by the content gate is not sent:
generating art of a body the gate hides would put it back on screen through a
side door, and the gate is not a UI preference. Check with
`python rate-characters.py --report`.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

DESK_ROOT = Path(__file__).parent
ROSTER = DESK_ROOT / "characters"
FORGE = "http://127.0.0.1:8200"
BRIDGE = "http://127.0.0.1:47931"


def bridge_token() -> str | None:
    try:
        return (Path.home() / ".aither" / "harness_token").read_text(
            encoding="utf-8"
        ).strip() or None
    except OSError:
        return None


def post(url: str, body: dict, timeout: float = 900.0, headers: dict | None = None) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"content-type": "application/json", **(headers or {})},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get(url: str, timeout: float = 60.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def upload(path: Path, timeout: float = 300.0) -> int | None:
    """multipart/form-data with no dependency on `requests` -- one field, built by hand."""
    boundary = f"----awforge{uuid.uuid4().hex}"
    body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'.encode(),
            b"Content-Type: image/jpeg\r\n\r\n",
            path.read_bytes(),
            f"\r\n--{boundary}--\r\n".encode(),
        ]
    )
    req = urllib.request.Request(
        f"{FORGE}/api/upload",
        data=body,
        method="POST",
        headers={"content-type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            out = json.loads(resp.read().decode("utf-8"))
        return out.get("id")
    except (urllib.error.URLError, OSError, ValueError) as error:
        print(f"  upload failed for {path.name}: {error}", file=sys.stderr)
        return None


def node_json(expression: str):
    """Ask the desk's own modules, so this script cannot disagree with the gate."""
    script = (
        "const c=require('./electron/content-rating.cjs');"
        "const r=require('./electron/character-roster.cjs');"
        f"process.stdout.write(JSON.stringify(({expression})??null));"
    )
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=DESK_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        print(f"ERROR: node refused: {proc.stderr.strip()[:200]}", file=sys.stderr)
        raise SystemExit(2)
    return json.loads(proc.stdout or "null")


def turntable_files(slug: str) -> list[Path]:
    d = ROSTER / slug / "turntable"
    return sorted(d.glob("*.jpg")) if d.is_dir() else []


def cmd_capture(slug: str, angles: int) -> int:
    token = bridge_token()
    if not token:
        print(
            "ERROR: no ~/.aither/harness_token -- the desk's capture door needs it", file=sys.stderr
        )
        return 2
    try:
        started = post(
            f"{BRIDGE}/roster/capture",
            {"names": [slug], "force": True, "angles": angles},
            timeout=60,
            headers={"authorization": f"Bearer {token}"},
        )
    except (urllib.error.URLError, OSError, ValueError) as error:
        print(f"ERROR: the desk is not reachable at {BRIDGE}: {error}", file=sys.stderr)
        return 2
    if not started.get("ok"):
        print(f"ERROR: desk refused the capture: {started.get('error')}", file=sys.stderr)
        return 1
    print(f"  desk is rendering {angles} angle(s) of {slug} ...")
    import time

    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        time.sleep(3)
        if len(turntable_files(slug)) >= angles:
            print(f"  captured {len(turntable_files(slug))} frame(s)")
            return 0
    print(f"  TIMED OUT with {len(turntable_files(slug))} of {angles}", file=sys.stderr)
    return 1


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0], formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("slug", nargs="?", help="a roster character")
    ap.add_argument("--capture", action="store_true", help="render the turntable first")
    ap.add_argument("--angles", type=int, default=8)
    ap.add_argument(
        "--dataset", action="store_true", help="upload the turntable and build the dataset"
    )
    ap.add_argument(
        "--train", action="store_true", help="train the LoRA (GPU; check host load first)"
    )
    ap.add_argument("--steps", type=int, default=900)
    ap.add_argument("--render", type=int, metavar="N", help="render N images once trained")
    ap.add_argument("--prompt", default="", help="extra prompt for --render")
    ap.add_argument("--list", action="store_true", help="forge characters made from the roster")
    args = ap.parse_args()

    if args.list:
        chars = get(f"{FORGE}/api/characters").get("characters", [])
        mine = [
            c
            for c in chars
            if str(c.get("id", "")).startswith("char-") and "desk" in str(c.get("name", ""))
        ]
        print(f"\n  {len(chars)} forge character(s), {len(mine)} from the desk roster\n")
        for c in mine:
            print(
                f"   {c['id']:<10} {c.get('name', '')[:46]:<48} "
                f"lora={'yes' if c.get('lora') else 'no'}"
            )
        print()
        return 0

    if not args.slug:
        ap.print_help()
        return 2
    if not (ROSTER / args.slug).is_dir():
        print(f"ERROR: no character named {args.slug!r}", file=sys.stderr)
        return 1

    hidden = node_json(f"c.hiddenReason({json.dumps(args.slug)})")
    if hidden:
        print(
            f"REFUSED: {args.slug} is hidden by the content gate ({hidden}). Generating art of a "
            f"body the gate hides would put it back on screen through a side door.",
            file=sys.stderr,
        )
        return 1

    if args.capture:
        rc = cmd_capture(args.slug, args.angles)
        if rc:
            return rc

    frames = turntable_files(args.slug)
    if not frames:
        fallback = ROSTER / args.slug / "fullbody.jpg"
        if fallback.is_file():
            frames = [fallback]
            print(
                "  no turntable -- falling back to the single front frame. Expect a LIKENESS, "
                "not the character; run --capture for a real dataset."
            )
        else:
            print(
                f"ERROR: nothing to train on. Run: python forge-art.py {args.slug} --capture",
                file=sys.stderr,
            )
            return 1

    cid = None
    if args.dataset or args.train or args.render:
        print(f"  uploading {len(frames)} frame(s) ...")
        ids = [i for i in (upload(f) for f in frames) if i]
        if not ids:
            print("ERROR: nothing uploaded", file=sys.stderr)
            return 1
        # REUSE, never re-create. POST /api/characters mints a fresh char-NNN
        # every call regardless of the `id` we ask for -- measured 2026-09-20,
        # two runs of the same slug produced char-417 and char-418. A 66-model
        # batch would have left 66 duplicates per pass.
        existing = None
        try:
            for c in get(f"{FORGE}/api/characters").get("characters", []):
                if str(c.get("name", "")) == f"{args.slug} (desk roster)":
                    existing = c.get("id")
                    break
        except (urllib.error.URLError, OSError, ValueError):
            existing = None
        if existing:
            cid = existing
            print(f"  reusing character {cid}")
        created = (
            None
            if existing
            else post(
                f"{FORGE}/api/characters",
                {
                    "id": f"desk-{args.slug}",
                    "name": f"{args.slug} (desk roster)",
                    "face_refs": ids,
                    "prompt": f"{args.slug} character, full body, anime style",
                    "negative": "nsfw, nude, lowres, extra limbs",
                    "style": "anime",
                    "ip_weight": 0.7,
                },
            )
        )
        if created:
            cid = (created.get("character") or {}).get("id")
            print(f"  character {cid} with {len(ids)} face ref(s)")

        if args.dataset or args.train:
            ds = post(
                f"{FORGE}/api/characters/{cid}/dataset",
                {"ids": ids, "auto_caption": True, "crop": "none"},
                timeout=1800,
            )
            print(f"  dataset: {json.dumps(ds)[:220]}")

    if args.train:
        print(f"  training {args.steps} steps -- this is the GPU half; watch host load")
        tr = post(f"{FORGE}/api/characters/{cid}/train", {"steps": args.steps}, timeout=7200)
        print(f"  train: {json.dumps(tr)[:220]}")

    if args.render:
        rr = post(
            f"{FORGE}/api/characters/{cid}/render",
            {
                "extra_prompt": args.prompt,
                "count": args.render,
                "width": 512,
                "height": 768,
                "timeout": 900,
            },
            timeout=1200,
        )
        print(f"  rendered: {json.dumps(rr.get('images'))[:300]}")

    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
