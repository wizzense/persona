"use strict";

/**
 * vision-client — the desk's eyes: awvision/aithervision over the shared
 * gateway-mcp transport (owner 2026-08-25: "finish integrating
 * awvision/aithervision"). The aw* registry brick is
 * AitherOS/packages/awvision ("ask a question about an image and get an
 * answer"); the desk speaks to it through the gateway's vision tools:
 *
 *   - get_vision_status    — is the hosted vision service up
 *   - analyze_image_content — structured description of an image
 *   - ask_about_image      — one question, one answer
 *   - compare_images       — consistency check between two images
 *
 * Same degradation contract as system-client/voice-client: fail soft, a
 * dead gateway yields ok:true with ERROR notes, never a half-truth
 * (security-review-patterns #5). The analysis functions are exported for
 * the IPC bridge; the self-test is read-only (status only) because real
 * analysis spends GPU time and needs an image to point at.
 */

const { callTool, parseMaybeJson } = require("./gateway-mcp.cjs");

async function visionStatus(call = callTool) {
  const text = await call("get_vision_status", {});
  return parseMaybeJson(text) ?? { note: text.slice(0, 300) };
}

/** Structured description of an image. `imagePath` is a HOST path. */
async function analyzeImage(imagePath, prompt, call = callTool) {
  const args = { image_path: imagePath };
  if (prompt) args.prompt = prompt;
  const out = await call("analyze_image_content", args);
  return parseMaybeJson(out) ?? { note: out.slice(0, 300) };
}

/** One question, one answer (visual question answering). */
async function askImage(imagePath, question, call = callTool) {
  const out = await call("ask_about_image", { image_path: imagePath, question });
  return parseMaybeJson(out) ?? { note: out.slice(0, 300) };
}

/** Consistency check between two images (e.g. is this still the same
 *  avatar the session claims). */
async function compareImages(pathA, pathB, call = callTool) {
  const out = await call("compare_images", { image_path1: pathA, image_path2: pathB });
  return parseMaybeJson(out) ?? { note: out.slice(0, 300) };
}

/** One read-only awareness call for the deck section. */
async function visionSnapshot(call = callTool) {
  try {
    const text = await call("get_vision_status", {}).catch(
      (error) => `ERROR: ${error.message}`,
    );
    return {
      ok: true,
      status: parseMaybeJson(text) ?? { note: text.slice(0, 300) },
      at: Math.floor(Date.now() / 1000),
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

module.exports = { visionStatus, analyzeImage, askImage, compareImages, visionSnapshot };

if (require.main === module) {
  // Self-test: read-only. Exit 0 = service up, 1 = service down/unreachable
  // (the status envelope reports its own error), 2 = module broken.
  (async () => {
    try {
      const snap = await visionSnapshot();
      if (!snap.ok) {
        console.error(`VISION UNAVAILABLE: ${snap.reason}`);
        process.exit(1);
      }
      if (snap.status?.error) {
        console.error(`VISION UNAVAILABLE: ${snap.status.error}`);
        process.exit(1);
      }
      const keys = typeof snap.status === "object" ? Object.keys(snap.status).length : "?";
      console.log(`VISION OK: ${keys} status key(s)`);
      process.exit(0);
    } catch (error) {
      console.error(`MODULE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
