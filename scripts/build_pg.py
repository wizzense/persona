#!/usr/bin/env python3
"""Build PG (general-rated) artifact from .pgship allowlist."""
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path
import fnmatch

def is_skip_dir(dirname):
    """Check if directory should be skipped entirely."""
    skip = {
        ".git", ".github", ".ruff_cache", "__pycache__",
        ".pytest_cache", "node_modules", ".next", "venv",
        "dist", "build"
    }
    return dirname in skip

def main():
    repo_root = Path(__file__).parent.parent
    pgship_file = repo_root / ".pgship"
    output_dir = repo_root / "dist" / "desk-pg"

    # Fail if .pgship is missing
    if not pgship_file.exists():
        print("ERROR: .pgship not found at repo root", file=sys.stderr)
        sys.exit(1)

    # Read allowlist
    allowed_patterns = []
    with open(pgship_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                allowed_patterns.append(line)

    if not allowed_patterns:
        print("ERROR: .pgship is empty or contains only comments",
              file=sys.stderr)
        sys.exit(1)

    # Clean output directory
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Walk tree and copy matching files
    copied = 0
    skipped = 0

    for root, dirs, files in os.walk(repo_root):
        # Prune directories in-place to speed up walk
        dirs[:] = [d for d in dirs if not is_skip_dir(d)]

        root_path = Path(root)

        # Process files in this directory
        for filename in files:
            file_path = root_path / filename
            rel_path = file_path.relative_to(repo_root)
            rel_path_str = str(rel_path).replace("\\", "/")

            # Check if path matches any allowed pattern
            matches = any(fnmatch.fnmatch(rel_path_str, pattern)
                          for pattern in allowed_patterns)

            if matches:
                # Copy file
                dest_path = output_dir / rel_path
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file_path, dest_path)
                copied += 1
            else:
                skipped += 1

    # SELF-VERIFY BEFORE STAMPING. The marker is what puts a bundle in
    # scope for AitherOS ACG008, so an unverified bundle is unshippable.
    sys.path.insert(0, str(Path(__file__).parent))
    from pg_verify import verify_or_die
    verify_or_die(output_dir, "desk")

    # Write marker
    artifact_marker = output_dir / ".pg-artifact"
    timestamp = datetime.utcnow().isoformat() + "Z"
    with open(artifact_marker, "w") as f:
        f.write(f"tree: desk\n")
        f.write(f"build_timestamp: {timestamp}\n")
        f.write(f"files_shipped: {copied}\n")
        f.write(f"files_excluded: {skipped}\n")

    # Report
    print(f"Build complete: {copied} files shipped, {skipped} excluded")
    print(f"Artifact: {output_dir}")
    print(f"Marker: {artifact_marker}")

if __name__ == "__main__":
    main()
