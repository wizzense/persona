"""Persona model browser — search/browse VRoid Hub and add characters with one click.

Local UI at http://127.0.0.1:47836 (loopback only). Sources: keyword search, staff picks,
your hearted models, your uploads, and every model page in Edge history. Filters:
downloadable-only, age rating. "Add" downloads the model + its personality motions into
the roster (through the licensed download-license API); "Switch" hot-swaps Persona.

Run:  python model-browser.py   (opens the page)
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import threading
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PERSONA_ROOT = Path(__file__).parent
sys.path.insert(0, r"D:\AitherOS-Fresh\AitherOS")
sys.path.insert(0, str(PERSONA_ROOT))

from lib.integrations.vroid_hub import VRoidHub, VRoidHubError  # noqa: E402

vs = __import__("importlib.util", fromlist=["spec_from_file_location"])
_spec = vs.spec_from_file_location("vroid_sync", PERSONA_ROOT / "vroid-sync.py")
vroid_sync = vs.module_from_spec(_spec)
_spec.loader.exec_module(vroid_sync)

PORT = 47836
PERSONA_MCP = "http://127.0.0.1:47831/mcp"
hub = VRoidHub()
lock = threading.Lock()


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
        "in_roster": (PERSONA_ROOT / "characters" / slug / "model.vrm").exists(),
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


def persona_switch(slug: str) -> bool:
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


def get_roster() -> list[dict]:
    """Return list of installed characters with metadata."""
    chars = PERSONA_ROOT / "characters"
    roster = []
    if not chars.exists():
        return roster
    for char_dir in sorted(chars.iterdir()):
        if not char_dir.is_dir():
            continue
        model_file = char_dir / "model.vrm"
        if not model_file.exists():
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
        })
    return roster


def validate_character_name(name: str) -> bool:
    """Validate character name: alphanumeric, dash, underscore, 1-64 chars."""
    return bool(re.match(r"^[\w-]{1,64}$", name)) and ".." not in name


def rename_character(old_name: str, new_name: str) -> dict:
    """Rename a character directory. Returns {ok: bool, error?: str}."""
    if not validate_character_name(old_name) or not validate_character_name(new_name):
        return {"ok": False, "error": "Invalid character name (alphanumeric, dash, underscore, 1-64 chars)"}
    old_path = (PERSONA_ROOT / "characters" / old_name).resolve()
    new_path = (PERSONA_ROOT / "characters" / new_name).resolve()
    # Safety: ensure both resolve inside characters/
    if not str(old_path).startswith(str((PERSONA_ROOT / "characters").resolve())):
        return {"ok": False, "error": "Path traversal attempted"}
    if not str(new_path).startswith(str((PERSONA_ROOT / "characters").resolve())):
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
    char_path = (PERSONA_ROOT / "characters" / name).resolve()
    # Safety: ensure it resolves inside characters/
    if not str(char_path).startswith(str((PERSONA_ROOT / "characters").resolve())):
        return {"ok": False, "error": "Path traversal attempted"}
    if not char_path.exists():
        return {"ok": False, "error": "Character not found"}
    try:
        shutil.rmtree(char_path)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def play_animation(name: str, animation: str) -> dict:
    """Call persona MCP to play an animation. Returns {ok: bool, error?: str}."""
    if not validate_character_name(name) or not re.match(r"^[\w-]+$", animation):
        return {"ok": False, "error": "Invalid name or animation"}
    char_path = (PERSONA_ROOT / "characters" / name / "animations" / f"{animation}.vrma").resolve()
    if not str(char_path).startswith(str((PERSONA_ROOT / "characters").resolve())):
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
    except OSError as e:
        return {"ok": False, "error": "Persona not running"}


def add_animation(name: str, filename: str, data: bytes) -> dict:
    """Add a .vrma animation file to a character. Returns {ok: bool, error?: str}."""
    if not validate_character_name(name):
        return {"ok": False, "error": "Invalid character name"}
    if not re.match(r"^[\w-]+\.vrma$", filename):
        return {"ok": False, "error": "Invalid filename (must be *.vrma)"}
    char_path = (PERSONA_ROOT / "characters" / name).resolve()
    anim_path = (char_path / "animations" / filename).resolve()
    # Safety: ensure paths resolve inside characters/
    if not str(char_path).startswith(str((PERSONA_ROOT / "characters").resolve())):
        return {"ok": False, "error": "Path traversal attempted"}
    if not str(anim_path).startswith(str(char_path)):
        return {"ok": False, "error": "Path traversal attempted"}
    if not char_path.exists():
        return {"ok": False, "error": "Character not found"}
    try:
        anim_path.parent.mkdir(parents=True, exist_ok=True)
        anim_path.write_bytes(data)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Persona model browser</title>
<style>
body{margin:0;font-family:system-ui;background:#111;color:#eee}
header{position:sticky;top:0;background:#1b1b1b;padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;box-shadow:0 2px 8px #0008}
input[type=text]{background:#2a2a2a;border:1px solid #444;color:#eee;padding:8px 10px;border-radius:8px;min-width:220px}
button,.tab{background:#2a2a2a;border:1px solid #444;color:#eee;padding:8px 12px;border-radius:8px;cursor:pointer}
.tab.active{background:#4457d5;border-color:#4457d5}
label{display:flex;gap:5px;align-items:center;font-size:13px;color:#bbb}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:14px}
.card{background:#1c1c1c;border:1px solid #2c2c2c;border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.card img{width:100%;aspect-ratio:1;object-fit:cover;background:#222}
.card .b{padding:8px;display:flex;flex-direction:column;gap:6px}
.card .n{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badges{display:flex;gap:4px;font-size:11px}
.badge{background:#333;border-radius:6px;padding:1px 6px}
.badge.dl{background:#1d5c2f}.badge.r18{background:#7a2030}.badge.have{background:#4457d5}
.booth-items{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.booth-badge{background:#5a3a8a;border-radius:6px;padding:2px 6px;font-size:11px;text-decoration:none;color:#ddd;display:inline-flex;align-items:center;gap:3px}
.booth-badge:hover{background:#6f4aa5;color:#fff}
.booth-icon{font-size:9px}
.card button{padding:6px}.card button:disabled{opacity:.35;cursor:default}
#status{padding:6px 14px;color:#9a9;font-size:13px;min-height:20px}
.char-card{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:14px;background:#1c1c1c;border:1px solid #2c2c2c;border-radius:12px;margin-bottom:12px}
.char-info{display:flex;flex-direction:column;gap:8px}
.char-info-row{display:flex;justify-content:space-between;font-size:13px}
.char-info-row .label{color:#999}
.char-actions{display:flex;flex-direction:column;gap:6px}
.char-actions button{padding:8px;font-size:12px}
.anim-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.anim-btn{background:#2a3a5a;border:1px solid #3a4a6a;color:#bbb;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:11px}
.anim-btn:hover{background:#3a4a7a}
.anim-input{margin-top:8px;padding:8px;border:1px dashed #444;border-radius:8px;background:#0a0a0a;cursor:pointer}
.modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:#0008;z-index:999;justify-content:center;align-items:center}
.modal.show{display:flex}
.modal-content{background:#1b1b1b;border:1px solid #444;border-radius:12px;padding:20px;max-width:400px;width:90%}
.modal-buttons{display:flex;gap:10px;margin-top:15px}
.modal-buttons button{flex:1;padding:10px}
</style></head><body>
<header>
 <b>Persona models</b>
 <span class="tab active" data-s="search">Search</span>
 <span class="tab" data-s="characters">Characters</span>
 <span class="tab" data-s="staff_picks">Staff picks</span>
 <span class="tab" data-s="hearts">Hearted</span>
 <span class="tab" data-s="history">Browsed</span>
 <input type="text" id="q" placeholder="search keyword… (e.g. cute, fox girl, フリーレン)">
 <button onclick="load()">Go</button>
 <label><input type="checkbox" id="dl" checked> downloadable only</label>
 <label><input type="checkbox" id="hideR18"> hide R-18</label>
</header>
<div id="status"></div><div id="grid"></div>
<div style="text-align:center;padding:16px"><button id="more" style="display:none">Load more</button></div>

<div id="confirmModal" class="modal">
 <div class="modal-content">
  <div id="confirmText"></div>
  <div class="modal-buttons">
   <button onclick="confirmAction=false;hideConfirm()" style="background:#333">Cancel</button>
   <button onclick="confirmAction=true;hideConfirm()" style="background:#d84a4a">Delete</button>
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
   <button ${m.downloadable?'':'disabled'} onclick="add('${m.id}',this)">${m.in_roster?'Re-add':'Add to Persona'}</button>
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
  card.innerHTML=`<div class="char-info">
   <div class="char-info-row"><span class="label">Name:</span><strong>${ch.name}</strong></div>
   <div class="char-info-row"><span class="label">Model size:</span><span>${(ch.model_size/1024/1024).toFixed(1)}MB</span></div>
   <div class="char-info-row"><span class="label">Animations:</span><span>${ch.animation_count}</span></div>
   <div class="anim-list">${animHTML}</div>
   <label class="anim-input"><input type="file" accept=".vrma" onchange="uploadAnim('${ch.name}',this)" style="display:none"> 📁 Add animation</label>
  </div>
  <div class="char-actions">
   <button onclick="switchChar('${ch.name}',this)">Switch Character</button>
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
 btn.textContent=(await r.json()).ok?'active ✓':'persona not running';}
async function switchChar(name,btn){btn.textContent='switching…';
 const r=await fetch('/api/switch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({slug:name})});
 btn.textContent=(await r.json()).ok?'active ✓':'persona not running';}
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
                self._json({"items": [serialize(m) for m in models], "next": next_cursor})
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
                    slug = vroid_sync.enroll(hub, detail, switch=False)
                if slug:
                    self._json({"ok": True, "slug": slug})
                else:
                    self._json({"ok": False, "error": "creator disabled download"})
            except VRoidHubError as error:
                self._json({"ok": False, "error": str(error)[:200]})
        elif self.path == "/api/switch":
            self._json({"ok": persona_switch(payload["slug"])})
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
    print(f"Persona model browser: http://127.0.0.1:{PORT}")
    try:
        threading.Thread(target=lambda: webbrowser.open(f"http://127.0.0.1:{PORT}"), daemon=True).start()
    except Exception:
        pass
    server.serve_forever()
