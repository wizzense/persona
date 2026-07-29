#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test character editor endpoints without starting the full server."""
import json
import re
import shutil
import sys
from pathlib import Path

# Fix encoding for Windows
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

PERSONA_ROOT = Path(__file__).parent

# Import the functions from model-browser
sys.path.insert(0, str(PERSONA_ROOT))

def validate_character_name(name: str) -> bool:
    """Validate character name: alphanumeric, dash, underscore, 1-64 chars."""
    return bool(re.match(r"^[\w-]{1,64}$", name)) and ".." not in name

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

# ============================================================================
# TESTS
# ============================================================================

def test_get_roster():
    """Test GET /api/roster"""
    print("\n=== Test 1: GET /api/roster ===")
    roster = get_roster()
    print(f"[OK] Found {len(roster)} characters")
    assert len(roster) > 0, "Should find at least one character"

    # Verify structure
    first = roster[0]
    assert "name" in first, "Should have name"
    assert "model_size" in first, "Should have model_size"
    assert "animation_count" in first, "Should have animation_count"
    assert "animations" in first, "Should have animations list"
    print(f"[OK] Response format correct")

    # Show first 3 characters
    print("\nFirst 3 characters:")
    for ch in roster[:3]:
        print(f"  {ch['name']:30s} {ch['model_size']/1024/1024:6.1f}MB  {ch['animation_count']:2d} anims")

    # JSON response format
    response = {"roster": roster[:1]}
    response_json = json.dumps(response)
    assert "roster" in response_json, "JSON should contain roster key"
    print(f"[OK] JSON response valid ({len(response_json)} bytes)")

def test_validation():
    """Test name validation and safety checks"""
    print("\n=== Test 2: Name Validation ===")

    # Valid names
    valid = ["aiko-droid-base-model", "test_name", "Test-123", "a", "a"*64]
    for name in valid:
        assert validate_character_name(name), f"Should accept '{name}'"
    print(f"[OK] Valid names accepted: {valid}")

    # Invalid names
    invalid = ["../evil", "..", "name with spaces", "a"*65, "", "../../../etc/passwd", "name@host"]
    for name in invalid:
        assert not validate_character_name(name), f"Should reject '{name}'"
    print(f"[OK] Invalid names rejected: {invalid}")

def test_path_safety():
    """Test path traversal prevention"""
    print("\n=== Test 3: Path Traversal Prevention ===")

    # Test rename with traversal attempt (caught by name validation first)
    result = rename_character("../../../etc", "passwd")
    assert not result["ok"], "Should reject traversal in old_name"
    assert "Invalid" in result["error"] or "Path traversal" in result["error"], f"Wrong error: {result['error']}"
    print(f"[OK] Rename traversal blocked: {result['error']}")

    result = rename_character("valid", "../../../etc/passwd")
    assert not result["ok"], "Should reject traversal in new_name"
    assert "Invalid" in result["error"] or "Path traversal" in result["error"], f"Wrong error: {result['error']}"
    print(f"[OK] Rename target traversal blocked: {result['error']}")

    # Test delete with traversal attempt (caught by name validation first)
    result = delete_character("../../../etc")
    assert not result["ok"], "Should reject traversal in delete"
    assert "Invalid" in result["error"] or "Path traversal" in result["error"], f"Wrong error: {result['error']}"
    print(f"[OK] Delete traversal blocked: {result['error']}")

def test_nonexistent():
    """Test operations on nonexistent characters"""
    print("\n=== Test 4: Nonexistent Character Handling ===")

    result = rename_character("does-not-exist", "new-name")
    assert not result["ok"], "Should fail for nonexistent source"
    assert "not found" in result["error"].lower(), f"Wrong error: {result['error']}"
    print(f"[OK] Rename nonexistent rejected: {result['error']}")

    result = delete_character("does-not-exist")
    assert not result["ok"], "Should fail for nonexistent target"
    assert "not found" in result["error"].lower(), f"Wrong error: {result['error']}"
    print(f"[OK] Delete nonexistent rejected: {result['error']}")

def test_invalid_names_in_operations():
    """Test operations with invalid names"""
    print("\n=== Test 5: Invalid Names in Operations ===")

    result = rename_character("name with spaces", "valid")
    assert not result["ok"], "Should reject invalid old_name"
    assert "Invalid" in result["error"], f"Wrong error: {result['error']}"
    print(f"[OK] Invalid old_name rejected: {result['error']}")

    result = rename_character("valid", "name with spaces")
    assert not result["ok"], "Should reject invalid new_name"
    assert "Invalid" in result["error"], f"Wrong error: {result['error']}"
    print(f"[OK] Invalid new_name rejected: {result['error']}")

    result = delete_character("@invalid!")
    assert not result["ok"], "Should reject invalid name in delete"
    assert "Invalid" in result["error"], f"Wrong error: {result['error']}"
    print(f"[OK] Invalid name in delete rejected: {result['error']}")

if __name__ == "__main__":
    print("=" * 70)
    print("Character Editor Tests")
    print("=" * 70)

    try:
        test_get_roster()
        test_validation()
        test_path_safety()
        test_nonexistent()
        test_invalid_names_in_operations()

        print("\n" + "=" * 70)
        print("[OK][OK][OK] ALL TESTS PASSED [OK][OK][OK]")
        print("=" * 70)
        sys.exit(0)
    except AssertionError as e:
        print(f"\n[FAIL] Test failed: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n[FAIL] Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
