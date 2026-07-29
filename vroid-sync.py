"""Sync VRoid Hub character models into Persona's roster — the licensed, programmatic path.

Uses the canonical AitherOS client (AitherOS/lib/integrations/vroid_hub.py). Every download
goes through VRoid Hub's own download-license API, so only models whose creators permit use
arrive — and they stay local (never committed, never redistributed).

Setup (once):
  1. Register the app at https://hub.vroid.com/oauth/applications/ with redirect URI
     http://127.0.0.1:47835/callback and scope `default`.
  2. Set VROID_HUB_CLIENT_ID / VROID_HUB_CLIENT_SECRET (owner: AitherSecrets holds them).
  3. python vroid-sync.py login

Then:
  python vroid-sync.py list                 # hearted + own models, with model ids
  python vroid-sync.py sync <model_id>      # download -> characters/<slug>/model.vrm -> switch
  python vroid-sync.py sync --all-hearted   # pull every hearted downloadable model
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

PERSONA_ROOT = Path(__file__).parent
MONOREPO_LIB = Path(r"D:\AitherOS-Fresh\AitherOS")
if MONOREPO_LIB.exists():
    sys.path.insert(0, str(MONOREPO_LIB))

from lib.integrations.vroid_hub import VRoidHub, VRoidHubError  # noqa: E402


def slugify(name: str) -> str:
    slug = re.sub(r"[^\w-]+", "-", name or "character").strip("-").lower()
    return slug or "character"


def enroll(hub: VRoidHub, model: dict, *, switch: bool = True) -> str | None:
    model_id = model["id"]
    name = (model.get("name") or model.get("character", {}).get("name") or model_id).strip()
    slug = slugify(name)
    if not model.get("is_downloadable", False):
        print(f"  SKIP {name} ({model_id}): creator has not enabled download")
        return None
    dest = PERSONA_ROOT / "characters" / slug / "model.vrm"
    print(f"  {name} ({model_id}) -> characters/{slug}/model.vrm")
    hub.download_vrm(model_id, dest)
    if switch:
        subprocess.run(
            [
                "pwsh",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(PERSONA_ROOT / "switch-character.ps1"),
                slug,
            ],
            check=False,
        )
    return slug


def main() -> int:
    args = sys.argv[1:]
    command = args[0] if args else "list"

    hub = VRoidHub()
    if command == "login":
        hub.authorize_interactive()
        account = hub.account().get("data", {})
        user = account.get("user_detail", {}).get("user", {})
        print(f"Linked as: {user.get('name')} (id {user.get('id')})")
        return 0

    if command == "list":
        print("== Hearted models ==")
        for model in hub.hearted_models():
            flag = "DL" if model.get("is_downloadable") else "--"
            print(f"  [{flag}] {model['id']}  {model.get('name') or model['character']['name']}")
        print("== Own models ==")
        for model in hub.own_models():
            flag = "DL" if model.get("is_downloadable") else "--"
            print(f"  [{flag}] {model['id']}  {model.get('name') or model['character']['name']}")
        return 0

    if command == "sync":
        target = args[1] if len(args) > 1 else "--all-hearted"
        if target == "--all-hearted":
            enrolled = [
                slug
                for model in hub.hearted_models()
                if (slug := enroll(hub, model, switch=False))
            ]
            print(f"Enrolled {len(enrolled)}: {', '.join(enrolled) or '(none downloadable)'}")
            if enrolled:
                print(f"Switch via tray or: pwsh switch-character.ps1 {enrolled[0]}")
        else:
            detail = hub.model_detail(target).get("character_model", {})
            if not detail:
                print(f"Model {target} not found")
                return 1
            if not enroll(hub, detail):
                return 1
        return 0

    print(__doc__)
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except VRoidHubError as error:
        print(f"vroid-sync: {error}", file=sys.stderr)
        sys.exit(2)
