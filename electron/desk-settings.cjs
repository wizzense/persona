"use strict";

/**
 * desk-settings — the ONE reader of cast.json's models / prompts / vision / sync
 * sections, for the modules that act on them (backend-profile, command-agent,
 * drop-router, settings-sync).
 *
 * It exists so those four do not each grow their own `fs.readFileSync` + parse +
 * fallback: four readers is four places for "the file says X and the desk does
 * Y". cast-config owns the shape and the provenance; this owns WHEN it is read.
 *
 * Cached on the file's mtime, the same way voice-resolve.cjs caches its
 * snapshot: a Command run or a dropped image must not cost a disk parse each,
 * and an edit (the pane, the `awsettings` CLI, a sync pull) must still land on
 * the very next call with no restart.
 *
 * FAIL SOFT, NEVER THROW -- every caller here is on a path the owner is waiting
 * on. Any error resolves to the built-ins, which are exactly the values these
 * modules hardcoded before this file existed, so the worst case is yesterday.
 */

const fs = require("node:fs");
const cast = require("./cast-config.cjs");

let cache = { file: null, mtimeMs: null, value: null };

function builtins(error) {
  const out = cast.resolveDesk({ version: 1 }, { env: {} });
  if (error) out.error = String(error && error.message ? error.message : error);
  return out;
}

/** @returns {{models, prompts, vision, sync, problems, error?}} */
function current({ file, env = process.env } = {}) {
  try {
    const resolved = file || cast.CAST_FILE();
    let mtimeMs = null;
    try {
      mtimeMs = fs.statSync(resolved).mtimeMs;
    } catch {
      mtimeMs = null; // no file yet: the built-ins, and no reason to cache a miss
    }
    // The env is part of the answer (a legacy variable is a tier), so a caller
    // passing its own env -- every test does -- must not be served another's.
    const cacheable = env === process.env;
    if (cacheable && cache.value && cache.file === resolved && cache.mtimeMs === mtimeMs && mtimeMs !== null) {
      return cache.value;
    }
    const loaded = cast.load({ file: resolved });
    const value = cast.resolveDesk(loaded.snapshot || { version: 1 }, { env });
    if (cacheable) cache = { file: resolved, mtimeMs, value };
    return value;
  } catch (error) {
    return builtins(error);
  }
}

/** The Command agent's full `--append-system-prompt`. The built-in instruction
 *  is ALWAYS present and always first-class: it carries the "raise a decision
 *  card, never ask a question" protocol that stops a headless run from hanging,
 *  so a persona is added around it and can never replace it. */
function commandSystemPrompt(builtin, settings = current()) {
  const prompts = (settings && settings.prompts) || {};
  const parts = [];
  if (prompts.commandPersona) parts.push(String(prompts.commandPersona).trim());
  parts.push(String(builtin).trim());
  if (prompts.commandAppend) parts.push(String(prompts.commandAppend).trim());
  return parts.join("\n\n");
}

function resetCacheForTests() {
  cache = { file: null, mtimeMs: null, value: null };
}

module.exports = { current, commandSystemPrompt, resetCacheForTests };
