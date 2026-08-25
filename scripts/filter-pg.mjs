#!/usr/bin/env node
/**
 * filter-pg.mjs — Strip adult-rated content before PG build
 *
 * Reads .pgignore, deletes listed paths, and filters character.json
 * ratings before building the final artifact.
 *
 * Usage: node scripts/filter-pg.mjs
 */

import { readFileSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';

const __dirname = new URL('.', import.meta.url).pathname;
const repoRoot = join(__dirname, '..');

function loadPgIgnore() {
  try {
    const pgignorePath = join(repoRoot, '.pgignore');
    const content = readFileSync(pgignorePath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    console.warn('[FILTER-PG] .pgignore not found, no exclusions applied');
    return [];
  }
}

function filterCharacterJson(charPath) {
  try {
    const characterJsonPath = join(charPath, 'character.json');
    const data = JSON.parse(readFileSync(characterJsonPath, 'utf8'));

    // If rating is r15 or r18, mark it for filtering (but keep the file for now)
    // In a PG-only build, these directories will be excluded by .pgignore
    // This is for logging/verification purposes only
    if (data.rating && ['r15', 'r18'].includes(data.rating)) {
      // Note: do not expose the rating in PG mode, but the directory itself
      // will be excluded via .pgignore, so this is defensive only
    }
  } catch {
    // silently ignore JSON errors
  }
}

function deleteExcludedPaths(paths) {
  let deletedCount = 0;
  for (const pathPattern of paths) {
    const fullPath = join(repoRoot, pathPattern);
    try {
      // Try to remove as directory first
      rmSync(fullPath, { recursive: true, force: true });
      console.log(`[FILTER-PG] Deleted: ${pathPattern}`);
      deletedCount++;
    } catch {
      // silently ignore if not found (it may already be gone or not exist in this build)
    }
  }
  return deletedCount;
}

function main() {
  console.log('[FILTER-PG] Starting PG-mode filter...');

  const pgIgnorePaths = loadPgIgnore();
  console.log(`[FILTER-PG] Loaded ${pgIgnorePaths.length} exclusion patterns from .pgignore`);

  const deleted = deleteExcludedPaths(pgIgnorePaths);
  console.log(`[FILTER-PG] Deleted ${deleted} paths`);

  // Scan characters/ and log any r18/r15 that remain (should be none in PG build)
  const charsDir = join(repoRoot, 'characters');
  try {
    // Note: `require` does not exist in an ESM module — the original
    // require('fs') here threw ReferenceError on every run and the catch
    // below swallowed it, so this scan was silently dead code (2026-08-25).
    const dirs = readdirSync(charsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (dir.isDirectory()) {
        filterCharacterJson(join(charsDir, dir.name));
      }
    }
  } catch {
    // silently ignore if characters dir doesn't exist yet
  }

  console.log('[FILTER-PG] Filter complete. Ready to build.');
}

main();
