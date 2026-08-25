"""Desk model browser — search/browse VRoid Hub and add characters with one click.

Local UI at http://127.0.0.1:47836 (loopback only). Sources: keyword search, staff picks,
your hearted models, your uploads, and every model page in Edge history. Filters:
downloadable-only, age rating. "Add" downloads the model + its personality motions into
the roster (through the licensed download-license API); "Switch" hot-swaps Desk.

Run:  python model-browser.py   (opens the page)
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import threading
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DESK_ROOT = Path(__file__).parent
sys.path.insert(0, r"C:\AitherOS-Fresh\AitherOS")
sys.path.insert(0, str(DESK_ROOT))

from lib.integrations.vroid_hub import VRoidHub, VRoidHubError  # noqa: E402

vs = __import__("importlib.util", fromlist=["spec_from_file_location"])
_spec = vs.spec_from_file_location("vroid_sync", DESK_ROOT / "vroid-sync.py")
vroid_sync = vs.module_from_spec(_spec)
_spec.loader.exec_module(vroid_sync)

PORT = 47836
PERSONA_MCP = "http://127.0.0.1:47831/mcp"
ADULT_GATE_MIRROR = Path.home() / ".aither" / "adult_content.json"
ADULT_RATINGS = ("r18", "r15")
hub = VRoidHub()
lock = threading.Lock()


def adult_content_visible() -> bool:
    """Whether adult models/characters may be shown in this browser at all.

    Reads the mirror the platform writes when the Settings toggle changes.
    Missing, unreadable or malformed => LOCKED. Filtering happens SERVER-side
    (here) and not in the page: a client-side "hide R-18" checkbox is a
    preference, not a gate — the rows still crossed the wire and the checkbox
    itself announced that R-18 models exist.
    """
    try:
        return json.loads(ADULT_GATE_MIRROR.read_text(encoding="utf-8")).get("visible") is True
    except (OSError, ValueError):
        return False


def character_rating(slug: str) -> str:
    """Recorded rating for an installed character, or 'unrated'."""
    try:
        raw = (DESK_ROOT / "characters" / slug / "character.json").read_text(encoding="utf-8")
        return str(json.loads(raw).get("rating") or "").lower() or "unrated"
    except (OSError, ValueError):
        return "unrated"


def image_url(model: dict) -> str:
    image = model.get("portrait_image") or model.get("full_body_image") or {}
    for key in ("sq300", "sq150", "w600", "original"):
        entry = image.get(key)
        if isinstance(entry, dict) and entry.get("url"):
            return entry["url"]
    for entry in image.values():
        if isinstance(entry, dict) and entry.get("url"):
            return entry["url"]
    return ""


def serialize(model: dict) -> dict:
    name = model.get("name") or model.get("character", {}).get("name") or model.get("id")
    slug = vroid_sync.slugify(name)
    booth_items = []
    for item in model.get("character_model_booth_items") or []:
        if isinstance(item, dict) and item.get("booth_item_id"):
            booth_items.append({
                "id": item["booth_item_id"],
                "category": item.get("part_category", ""),
                "url": f"https://booth.pm/en/items/{item['booth_item_id']}",
            })
    return {
        "id": model.get("id"),
        "name": name,
        "image": image_url(model),
        "downloadable": bool(model.get("is_downloadable")),
        "hearts": model.get("heart_count", 0),
        "r18": bool((model.get("age_limit") or {}).get("is_r18")),
        "r15": bool((model.get("age_limit") or {}).get("is_r15")),
        "in_roster": (DESK_ROOT / "characters" / slug / "model.vrm").exists(),
        "slug": slug,
        "booth_items": booth_items,
    }


def fetch_models(source: str, query: str, cursor: str | None = None) -> tuple[list[dict], str | None]:
    """Return (models, next_cursor).

    The API's pagination cursor styles differ per endpoint (search uses
    search_after[], others max_id) — so the cursor here is the _links.next.href
    verbatim, replayed as-is. History uses a plain integer offset (never starts
    with '/', so the two cannot collide).
    """
    endpoint = {
        "search": "/api/search/character_models",
        "staff_picks": "/api/staff_picks",
        "hearts": "/api/hearts",
        "mine": "/api/account/character_models",
    }.get(source)
    if endpoint:
        if cursor and cursor.startswith("/api/"):
            data = hub._request("GET", cursor)
        else:
            params: dict = {"count": 30}
            if source == "search":
                params["keyword"] = query or "vrm"
            data = hub._request("GET", endpoint, **params)
        # Some endpoints (staff_picks) wrap each entry: {character_model: {...}, ...}
        models = [
            item.get("character_model", item) if isinstance(item, dict) else item
            for item in data.get("data", [])
        ]
        next_href = ((data.get("_links") or {}).get("next") or {}).get("href")
        return models, (next_href if models else None)
    if source == "history":
        offset = int(cursor or 0)
        ids = vroid_sync.browsed_model_ids()
        page, models = ids[offset : offset + 24], []
        for mid in page:
            try:
                detail = hub.model_detail(mid).get("character_model", {})
                if detail:
                    models.append(detail)
            except VRoidHubError:
                continue
        next_offset = offset + len(page)
        return models, (str(next_offset) if next_offset < len(ids) else None)
    return [], None


def desk_switch(slug: str) -> bool:
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "set_character", "arguments": {"name": slug}},
    }).encode()
    request = urllib.request.Request(
        PERSONA_MCP, data=body,
        headers={"Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return b"switched" in response.read()
    except OSError:
        return False


def active_character() -> str | None:
    """The character Desk currently has installed (written by switch/set_character)."""
    try:
        return (DESK_ROOT / ".active-character").read_text().strip() or None
    except OSError:
        return None


def get_roster() -> list[dict]:
    """Return list of installed characters with metadata."""
    chars = DESK_ROOT / "characters"
    active = active_character()
    adult_ok = adult_content_visible()
    roster = []
    if not chars.exists():
        return roster
    for char_dir in sorted(chars.iterdir()):
        if not char_dir.is_dir():
            continue
        model_file = char_dir / "model.vrm"
        if not model_file.exists():
            continue
        if not adult_ok and character_rating(char_dir.name) in ADULT_RATINGS:
            continue
        anim_dir = char_dir / "animations"
        anim_count = 0
        if anim_dir.exists():
            anim_count = len([f for f in anim_dir.iterdir() if f.suffix == ".vrma"])
        roster.append({
            "name": char_dir.name,
            "model_size": model_file.stat().st_size,
            "animation_count": anim_count,
            "animations": sorted([f.stem for f in anim_dir.iterdir() if f.suffix == ".vrma"]) if anim_dir.exists() else [],
            "is_active": char_dir.name == active,
        })
    return roster


def validate_character_name(name: str) -> bool:
    """Validate character name: alphanumeric, dash, underscore, 1-64 chars."""
    return bool(re.match(r"^[\w-]{1,64}$", name)) and ".." not in name


def rename_character(old_name: str, new_name: str) -> dict:
    """Rename a character directory. Returns {ok: bool, error?: str}."""
    if not validate_character_name(old_name) or not validate_character_name(new_name):
        return {"ok": False, "error": "Invalid character name (alphanumeric, dash, underscore, 1-64 chars)"}
    old_path = (DESK_ROOT / "characters" / old_name).resolve()
    new_path = (DESK_ROOT / "characters" / new_name).resolve()
    # Safety: ensure both resolve inside characters/
    if not str(old_path).startswith(str((DESK_ROOT / "characters").resolve())):
        return {"ok": False, "error": "Path traversal attempted"}
    if not str(new_path).startswith(str((DESK_ROOT / "characters").resolve())):
        return {"ok": False, "error": "Path traversal attempted"}
    if not old_path.exists():
        return {"ok": False, "error": "Character not found"}
    if new_path.exists():
        return {"ok": False, "error": "Target name already exists"}
    try:
        old_path.rename(new_path)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def delete_character(name: str) -> dict:
    """Delete a character directory. Returns {ok: bool, error?: str}."""
    if not validate_character_name(name):
        return {"ok": False, "error": "Invalid character name"}
    char_path = (DESK_ROOT / "characters" / name).resolve()
    # Safety: ensure it resolves inside characters/
    if not str(char_path).startswith(str((DESK_ROOT / "characters").resolve())):
        return {"ok": False, "error": "Path traversal attempted"}
    if not char_path.exists():
        return {"ok": False, "error": "Character not found"}
    try:
        shutil.rmtree(char_path)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def play_animation(name: str, animation: str) -> dict:
    """Call desk MCP to play an animation. Returns {ok: bool, error?: str}."""
    if not validate_character_name(name) or not re.match(r"^[\w-]+$", animation):
        return {"ok": False, "error": "Invalid name or animation"}
    char_path = (DESK_ROOT / "characters" / name / "animations" / f"{animation}.vrma").resolve()
    if not str(char_path).startswith(str((DESK_ROOT / "characters").resolve())):
        return {"ok": False, "error": "Path traversal attempted"}
    if not char_path.exists():
        return {"ok": False, "error": "Animation not found"}
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "play_animation", "arguments": {"animation": f"FILE:{animation}.vrma"}},
    }).encode()
    request = urllib.request.Request(
        PERSONA_MCP, data=body,
        headers={"Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return {"ok": b"success" in response.read()}
    except OSError:
        return {"ok": False, "error": "Desk not running"}


def add_animation(name: str, filename: str, data: bytes) -> dict:
    """Add a .vrma animation file to a character. Returns {ok: bool, error?: str}."""
    if not validate_character_name(name):
        return {"ok": False, "error": "Invalid character name"}
    if not re.match(r"^[\w-]+\.vrma$", filename):
        return {"ok": False, "error": "Invalid filename (must be *.vrma)"}
    char_path = (DESK_ROOT / "characters" / name).resolve()
    anim_path = (char_path / "animations" / filename).resolve()
    # Safety: ensure paths resolve inside characters/
    if not str(char_path).startswith(str((DESK_ROOT / "characters").resolve())):
        return {"ok": False, "error": "Path traversal attempted"}
    if not str(anim_path).startswith(str(char_path)):
        return {"ok": False, "error": "Path traversal attempted"}
    if not char_path.exists():
        return {"ok": False, "error": "Character not found"}
    try:
        anim_path.parent.mkdir(parents=True, exist_ok=True)
        anim_path.write_bytes(data)
    except OSError as error:
        return {"ok": False, "error": str(error)[:200]}
    # The renderer loads from dist/assets — mirror there when this is the LIVE character,
    # otherwise the upload only takes effect on the next switch.
    mirrored = False
    if name == active_character():
        try:
            live = DESK_ROOT / "dist" / "assets" / "animations"
            live.mkdir(parents=True, exist_ok=True)
            (live / filename).write_bytes(data)
            mirrored = True
        except OSError:
            mirrored = False
    return {"ok": True, "live": mirrored}


PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Desk model browser</title>
<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, sans-serif;
  background: linear-gradient(135deg, #000103 0%, #02060D 50%, #040C15 100%);
  background-attachment: fixed;
  color: #EEEEEE;
  min-height: 100vh;
}

header {
  position: sticky;
  top: 0;
  background: rgba(2, 6, 13, 0.7);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid rgba(22, 35, 48, 0.3);
  padding: 16px 20px;
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
  z-index: 100;
}

header > b {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: #EEEEEE;
}

.tab, button, input[type=text] {
  border-radius: 8px;
  font-size: 13px;
  transition: all 0.2s ease;
  border: 1px solid rgba(22, 35, 48, 0.4);
}

.tab {
  background: transparent;
  color: #9BA6B1;
  padding: 8px 16px;
  cursor: pointer;
  border: none;
  font-weight: 500;
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.3px;
}

.tab:hover {
  color: #EEEEEE;
  background: rgba(42, 215, 215, 0.08);
}

.tab.active {
  color: #2AD7D7;
  background: rgba(42, 215, 215, 0.12);
  border-bottom: 2px solid #2AD7D7;
  border-color: #2AD7D7;
}

input[type=text] {
  background: rgba(4, 12, 21, 0.6);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(22, 35, 48, 0.5);
  color: #EEEEEE;
  padding: 10px 14px;
  min-width: 240px;
}

input[type=text]::placeholder {
  color: #69737D;
}

input[type=text]:focus {
  outline: none;
  border-color: #2AD7D7;
  background: rgba(4, 12, 21, 0.8);
}

button {
  background: rgba(4, 12, 21, 0.5);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(22, 35, 48, 0.5);
  color: #EEEEEE;
  padding: 10px 16px;
  cursor: pointer;
  font-weight: 500;
  font-size: 12px;
}

button:hover:not(:disabled) {
  background: rgba(4, 12, 21, 0.8);
  border-color: rgba(42, 215, 215, 0.5);
  color: #EEEEEE;
}

button:disabled {
  opacity: 0.35;
  cursor: default;
}

label {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: #9BA6B1;
  cursor: pointer;
  transition: color 0.2s ease;
}

label:hover {
  color: #EEEEEE;
}

label input[type=checkbox] {
  cursor: pointer;
  width: 16px;
  height: 16px;
  accent-color: #2AD7D7;
}

#status {
  padding: 12px 20px;
  color: #70DDB1;
  font-size: 12px;
  min-height: 20px;
  font-weight: 500;
}

#grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 16px;
  padding: 20px;
  max-width: 1600px;
  margin: 0 auto;
}

.card {
  background: rgba(4, 12, 21, 0.4);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(22, 35, 48, 0.5);
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: all 0.3s ease;
  cursor: pointer;
}

.card:hover {
  transform: translateY(-4px);
  background: rgba(4, 12, 21, 0.6);
  border-color: rgba(42, 215, 215, 0.3);
  box-shadow: 0 8px 24px rgba(42, 215, 215, 0.1);
}

.card img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  background: linear-gradient(135deg, #040C15 0%, #02060D 100%);
}

.card .b {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.card .n {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #EEEEEE;
}

.badges {
  display: flex;
  gap: 6px;
  font-size: 10px;
  flex-wrap: wrap;
}

.badge {
  background: rgba(155, 166, 177, 0.2);
  border-radius: 6px;
  padding: 2px 8px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: #9BA6B1;
}

.badge.dl {
  background: rgba(42, 215, 215, 0.2);
  color: #2AD7D7;
  border: 1px solid rgba(42, 215, 215, 0.3);
}

.badge.r18 {
  background: rgba(255, 145, 137, 0.2);
  color: #FF9189;
  border: 1px solid rgba(255, 145, 137, 0.3);
}

.badge.have {
  background: rgba(112, 221, 177, 0.2);
  color: #70DDB1;
  border: 1px solid rgba(112, 221, 177, 0.3);
}

.booth-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.booth-badge {
  background: rgba(182, 170, 255, 0.15);
  border: 1px solid rgba(182, 170, 255, 0.3);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 10px;
  text-decoration: none;
  color: #B6AAFF;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.2s ease;
  cursor: pointer;
}

.booth-badge:hover {
  background: rgba(182, 170, 255, 0.25);
  border-color: rgba(182, 170, 255, 0.5);
  color: #EEEEEE;
}

.booth-icon {
  font-size: 9px;
}

.card button {
  padding: 8px 12px;
  font-size: 11px;
  margin-top: 4px;
}

#more {
  display: none;
  margin: 24px auto;
  padding: 12px 28px;
}

.char-card {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  padding: 20px;
  background: rgba(4, 12, 21, 0.4);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(22, 35, 48, 0.5);
  border-radius: 12px;
  margin-bottom: 16px;
}

.char-info {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.char-info-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(22, 35, 48, 0.3);
}

.char-info-row .label {
  color: #9BA6B1;
  font-weight: 500;
}

.char-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.char-actions button {
  padding: 10px 16px;
  font-size: 12px;
  width: 100%;
}

.anim-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.anim-btn {
  background: rgba(0, 100, 185, 0.15);
  border: 1px solid rgba(0, 100, 185, 0.3);
  color: #EEEEEE;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
  transition: all 0.2s ease;
}

.anim-btn:hover {
  background: rgba(0, 100, 185, 0.25);
  border-color: rgba(0, 100, 185, 0.5);
  color: #2AD7D7;
}

.anim-input {
  margin-top: 12px;
  padding: 16px;
  border: 2px dashed rgba(22, 35, 48, 0.5);
  border-radius: 8px;
  background: rgba(4, 12, 21, 0.3);
  backdrop-filter: blur(5px);
  cursor: pointer;
  text-align: center;
  color: #9BA6B1;
  transition: all 0.2s ease;
}

.anim-input:hover {
  border-color: rgba(42, 215, 215, 0.4);
  background: rgba(4, 12, 21, 0.5);
  color: #EEEEEE;
}

.modal {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 1, 3, 0.7);
  backdrop-filter: blur(8px);
  z-index: 999;
  justify-content: center;
  align-items: center;
}

.modal.show {
  display: flex;
}

.modal-content {
  background: rgba(2, 6, 13, 0.85);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(22, 35, 48, 0.5);
  border-radius: 12px;
  padding: 28px;
  max-width: 400px;
  width: 90%;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}

.modal-content > div:first-child {
  color: #EEEEEE;
  font-size: 14px;
  margin-bottom: 20px;
}

.modal-buttons {
  display: flex;
  gap: 12px;
  margin-top: 20px;
}

.modal-buttons button {
  flex: 1;
  padding: 12px 16px;
  font-weight: 500;
}

.modal-buttons button:first-child {
  background: rgba(155, 166, 177, 0.15);
  border-color: rgba(155, 166, 177, 0.3);
  color: #9BA6B1;
}

.modal-buttons button:first-child:hover {
  background: rgba(155, 166, 177, 0.25);
  border-color: rgba(155, 166, 177, 0.5);
}

.modal-buttons button:last-child {
  background: rgba(255, 145, 137, 0.2);
  border-color: rgba(255, 145, 137, 0.4);
  color: #FF9189;
}

.modal-buttons button:last-child:hover {
  background: rgba(255, 145, 137, 0.3);
  border-color: rgba(255, 145, 137, 0.6);
}
</style></head><body>
<header>
  <b>Desk models</b>
  <div style="display:flex;gap:8px">
    <span class="tab active" data-s="search">Search</span>
    <span class="tab" data-s="characters">Characters</span>
    <span class="tab" data-s="staff_picks">Staff picks</span>
    <span class="tab" data-s="hearts">Hearted</span>
    <span class="tab" data-s="history">Browsed</span>
  </div>
  <input type="text" id="q" placeholder="search keyword… (e.g. cute, fox girl, フリーレン)">
  <button onclick="load()">Go</button>
  <label><input type="checkbox" id="dl" checked> downloadable only</label>
  <label id="r18Filter" style="display:none"><input type="checkbox" id="hideR18"> hide R-18</label>
</header>

<div id="status"></div>
<div id="grid"></div>

<div style="text-align:center;padding:24px">
  <button id="more" style="display:none">Load more</button>
</div>

<div id="confirmModal" class="modal">
  <div class="modal-content">
    <div id="confirmText"></div>
    <div class="modal-buttons">
      <button onclick="confirmAction=false;hideConfirm()">Cancel</button>
      <button onclick="confirmAction=true;hideConfirm()">Delete</button>
    </div>
  </div>
</div>
<script>
let source='search', cursor=null, total=0, shown=0, loading=false, rendered=new Set(), confirmAction=false;
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));t.classList.add('active');source=t.dataset.s;load();});
document.getElementById('q').addEventListener('keydown',e=>{if(e.key==='Enter')load()});
const S=document.getElementById('status'),M=document.getElementById('more');
M.onclick=()=>page();
function load(){cursor=null;total=0;shown=0;rendered=new Set();document.getElementById('grid').innerHTML='';if(source==='characters')loadCharacters();else page();}
async function page(){
 if(loading)return;loading=true;
 S.textContent='loading…';M.style.display='none';
 const q=encodeURIComponent(document.getElementById('q').value);
 const c=cursor?`&cursor=${encodeURIComponent(cursor)}`:'';
 const r=await fetch(`/api/list?source=${source}&q=${q}${c}`);const data=await r.json();
 loading=false;
 if(data.error){S.textContent='error: '+data.error;return}
 cursor=data.next;
 // The R-18 filter control only exists once the account has opted in — while the
 // gate is closed the server has already dropped those rows, and showing a
 // "hide R-18" checkbox would announce the category being hidden.
 document.getElementById('r18Filter').style.display=data.adult_visible?'flex':'none';
 const dl=document.getElementById('dl').checked, h18=document.getElementById('hideR18').checked;
 const seen=data.items.filter(m=>(!dl||m.downloadable)&&(!h18||!m.r18)&&!rendered.has(m.id));
 seen.forEach(m=>rendered.add(m.id));
 total+=data.items.length;shown+=seen.length;
 S.textContent=`${shown} shown of ${total} fetched${cursor?' — more available':' — end'}`;
 const g=document.getElementById('grid');
 for(const m of seen){
  const c=document.createElement('div');c.className='card';
  const boothHTML=m.booth_items&&m.booth_items.length?`<div class="booth-items">${m.booth_items.map(bi=>`<a class="booth-badge" href="${bi.url}" target="_blank" title="${bi.category||'BOOTH item'}">${bi.category||'shop'}</a>`).join('')}</div>`:'';
  c.innerHTML=`<img loading="lazy" src="${m.image}"><div class="b">
   <div class="n" title="${m.name}">${m.name}</div>
   <div class="badges">${m.downloadable?'<span class="badge dl">DL</span>':'<span class="badge">no-DL</span>'}
    ${m.r18?'<span class="badge r18">R18</span>':''}${m.in_roster?'<span class="badge have">in roster</span>':''}
    <span class="badge">♥ ${m.hearts}</span></div>
   ${boothHTML}
   <button ${m.downloadable?'':'disabled'} onclick="add('${m.id}',this)">${m.in_roster?'Re-add':'Add to Desk'}</button>
   <button ${m.in_roster?'':'disabled'} onclick="swi('${m.slug}',this)">Switch</button></div>`;
  g.appendChild(c);
 }
 M.style.display=cursor?'inline-block':'none';
 if(cursor&&seen.length===0)page();
}
addEventListener('scroll',()=>{
 if(cursor&&!loading&&innerHeight+scrollY>=document.body.offsetHeight-600)page();
});
async function loadCharacters(){
 loading=true;
 S.textContent='loading roster…';
 const r=await fetch('/api/roster');
 const data=await r.json();
 loading=false;
 if(data.error){S.textContent='error: '+data.error;return}
 S.textContent=`${data.roster.length} characters installed`;
 const g=document.getElementById('grid');
 for(const ch of data.roster){
  const card=document.createElement('div');card.className='char-card';
  const animHTML=ch.animations.map(a=>`<span class="anim-btn" onclick="playAnim('${ch.name}','${a}',this)">▶ ${a}</span>`).join('');
  if(ch.is_active) card.style.borderColor='#4457d5';
  card.innerHTML=`<div class="char-info">
   <div class="char-info-row"><span class="label">Name:</span><strong>${ch.name}</strong>${ch.is_active?' <span class="badge have">ACTIVE</span>':''}</div>
   <div class="char-info-row"><span class="label">Model size:</span><span>${(ch.model_size/1024/1024).toFixed(1)}MB</span></div>
   <div class="char-info-row"><span class="label">Animations:</span><span>${ch.animation_count}</span></div>
   <div class="anim-list">${animHTML}</div>
   <label class="anim-input"><input type="file" accept=".vrma" onchange="uploadAnim('${ch.name}',this)" style="display:none"> 📁 Add animation</label>
  </div>
  <div class="char-actions">
   <button onclick="switchChar('${ch.name}',this)">${ch.is_active?'Active ✓':'Switch Character'}</button>
   <button onclick="showRenameDialog('${ch.name}')">Rename</button>
   <button onclick="showDeleteConfirm('${ch.name}')" style="background:#d84a4a;border-color:#9a3a3a">Delete</button>
  </div>`;
  g.appendChild(card);
 }
}
function hideConfirm(){document.getElementById('confirmModal').classList.remove('show');}
function showConfirm(text,callback){document.getElementById('confirmText').textContent=text;document.getElementById('confirmModal').classList.add('show');confirmAction=false;const orig=hideConfirm;hideConfirm=()=>{orig();if(confirmAction)callback();};}
async function add(id,btn){btn.textContent='adding…';btn.disabled=true;
 const r=await fetch('/api/add',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});
 const j=await r.json();
 if(j.ok){btn.textContent='added ✓';const s=btn.nextElementSibling;s.disabled=false;s.onclick=()=>swi(j.slug,s);}
 else{btn.textContent='refused';S.textContent=j.error||'license refused (check app usage settings)';}}
async function swi(slug,btn){btn.textContent='switching…';
 const r=await fetch('/api/switch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({slug})});
 btn.textContent=(await r.json()).ok?'active ✓':'desk not running';}
async function switchChar(name,btn){btn.textContent='switching…';
 const r=await fetch('/api/switch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({slug:name})});
 btn.textContent=(await r.json()).ok?'active ✓':'desk not running';}
async function playAnim(name,anim,btn){btn.textContent='▶ playing…';
 const r=await fetch('/api/play',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,animation:anim})});
 const j=await r.json();
 btn.textContent=j.ok?'▶ '+anim:'▶ err';}
function showRenameDialog(name){const n=prompt('New name (alphanumeric, dash, underscore, max 64 chars):',name);if(n&&n!==name)renameChar(name,n);}
async function renameChar(name,newName){const r=await fetch('/api/rename',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,new_name:newName})});const j=await r.json();if(j.ok)load();else S.textContent='error: '+(j.error||'rename failed');}
function showDeleteConfirm(name){showConfirm(`Delete character "${name}"? This cannot be undone.`,()=>deleteChar(name));}
async function deleteChar(name){const r=await fetch('/api/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});const j=await r.json();if(j.ok){S.textContent='deleted ✓';load();}else S.textContent='error: '+(j.error||'delete failed');}
async function uploadAnim(name,input){if(!input.files.length)return;const f=input.files[0];if(!f.name.endsWith('.vrma')){S.textContent='must be a .vrma file';return;}const buf=await f.arrayBuffer();const r=await fetch('/api/animation/add',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,filename:f.name,data:btoa(String.fromCharCode(...new Uint8Array(buf)))})});const j=await r.json();if(j.ok){S.textContent='animation added ✓';load();}else{S.textContent='error: '+(j.error||'upload failed');}}
load();
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/list"):
            from urllib.parse import parse_qs, urlparse

            params = parse_qs(urlparse(self.path).query)
            source = (params.get("source") or ["search"])[0]
            query = (params.get("q") or [""])[0]
            cursor = (params.get("cursor") or [None])[0]
            try:
                with lock:
                    models, next_cursor = fetch_models(source, query, cursor)
                adult_ok = adult_content_visible()
                items = [serialize(m) for m in models]
                if not adult_ok:
                    items = [item for item in items if not (item["r18"] or item["r15"])]
                self._json({
                    "items": items,
                    "next": next_cursor,
                    "adult_visible": adult_ok,
                })
            except VRoidHubError as error:
                self._json({"error": str(error)}, 502)
            return
        if self.path == "/api/roster":
            with lock:
                roster = get_roster()
            self._json({"roster": roster})
            return
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length))
        except ValueError:
            self._json({"ok": False, "error": "bad json"}, 400)
            return
        if self.path == "/api/add":
            try:
                with lock:
                    detail = hub.model_detail(payload["id"]).get("character_model", {})
                    # The gate holds at the WRITE too, not only in the listing:
                    # a model id posted directly would otherwise land an adult
                    # model in the roster of a locked account.
                    if (
                        vroid_sync.rating_from_model(detail) in ADULT_RATINGS
                        and not adult_content_visible()
                    ):
                        self._json({"ok": False, "error": "not available"}, 403)
                        return
                    slug = vroid_sync.enroll(hub, detail, switch=False)
                if slug:
                    self._json({"ok": True, "slug": slug})
                else:
                    self._json({"ok": False, "error": "creator disabled download"})
            except VRoidHubError as error:
                self._json({"ok": False, "error": str(error)[:200]})
        elif self.path == "/api/switch":
            slug = payload.get("slug", "")
            if not adult_content_visible() and character_rating(slug) in ADULT_RATINGS:
                self._json({"ok": False, "error": "not available"}, 403)
                return
            self._json({"ok": desk_switch(slug)})
        elif self.path == "/api/rename":
            with lock:
                result = rename_character(payload.get("name", ""), payload.get("new_name", ""))
            self._json(result)
        elif self.path == "/api/delete":
            with lock:
                result = delete_character(payload.get("name", ""))
            self._json(result)
        elif self.path == "/api/play":
            result = play_animation(payload.get("name", ""), payload.get("animation", ""))
            self._json(result)
        elif self.path == "/api/animation/add":
            import base64
            try:
                data = base64.b64decode(payload.get("data", ""))
                with lock:
                    result = add_animation(payload.get("name", ""), payload.get("filename", ""), data)
                self._json(result)
            except Exception as e:
                self._json({"ok": False, "error": str(e)[:200]})
        else:
            self._json({"ok": False}, 404)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Desk model browser: http://127.0.0.1:{PORT}")
    try:
        threading.Thread(target=lambda: webbrowser.open(f"http://127.0.0.1:{PORT}"), daemon=True).start()
    except Exception:
        pass
    server.serve_forever()
