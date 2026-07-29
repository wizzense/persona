"use strict";

/** Render the live 3D VRM character into AitherShell's portrait-frame convention, so the
 *  same avatar that floats on the desktop also runs INSIDE the shell's docked pane.
 *
 *  AitherShell reads (verified against cli/assets/aither-portrait):
 *    <dir>/idle/frame_NN.png        480x832 RGBA — the breathing loop
 *    <dir>/neutral.png              a still fallback face
 *    <dir>/neutral-talk-<N>.png     mouth frames played while speaking
 *  We capture the Electron window itself, so whatever character is loaded is what ships.
 */

const fs = require("node:fs");
const path = require("node:path");

const FRAME_WIDTH = 480;
const FRAME_HEIGHT = 832;
const IDLE_FRAMES = 8;
const TALK_FRAMES = 8;

function shellAssetsDir() {
  return (
    process.env.AITHERSHELL_ASSETS ||
    path.join("D:", "AitherOS-Fresh", ".PRODUCTS", ".AITHERSHELL", "cli", "assets")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureFrame(window) {
  const image = await window.webContents.capturePage();
  return image.resize({ width: FRAME_WIDTH, height: FRAME_HEIGHT, quality: "good" });
}

/**
 * Capture `count` frames spaced across `spanMs` (one animation cycle) into `dir`.
 * Returns the file paths written.
 */
async function captureSequence(window, dir, count, spanMs, namer) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const gap = Math.max(60, Math.round(spanMs / count));
  for (let index = 0; index < count; index += 1) {
    const image = await captureFrame(window);
    const file = path.join(dir, namer(index));
    fs.writeFileSync(file, image.toPNG());
    written.push(file);
    await sleep(gap);
  }
  return written;
}

/**
 * Export the currently displayed character as an AitherShell portrait pack.
 * `drive(event)` is the caller's bridge-event dispatcher, used to put the character
 * into its idle vs talking state while frames are captured.
 */
async function exportToAitherShell(window, characterName, drive) {
  if (!window || window.isDestroyed()) throw new Error("avatar window is not open");
  const target = path.join(shellAssetsDir(), `${characterName}-portrait`);
  fs.mkdirSync(target, { recursive: true });

  // Idle loop
  drive({
    type: "state",
    state: {
      phase: "active", activity: "idle", microphoneMuted: true, outputMuted: false,
    },
  });
  await sleep(400);
  await captureSequence(window, path.join(target, "idle"), IDLE_FRAMES, 2400, (i) =>
    `frame_${String(i).padStart(2, "0")}.png`,
  );

  // Still fallback face — every unmapped emotion lands here
  const still = await captureFrame(window);
  fs.writeFileSync(path.join(target, "neutral.png"), still.toPNG());

  // Talking mouth set
  drive({
    type: "state",
    state: {
      phase: "active", activity: "speaking", microphoneMuted: true, outputMuted: false,
    },
  });
  await sleep(300);
  const talk = [];
  for (let index = 0; index < TALK_FRAMES; index += 1) {
    drive({ type: "audio-level", level: index % 2 === 0 ? 0.38 : 0.1 });
    await sleep(140);
    const image = await captureFrame(window);
    const file = path.join(target, `neutral-talk-${index}.png`);
    fs.writeFileSync(file, image.toPNG());
    talk.push(file);
  }

  drive({ type: "audio-level", level: 0 });
  drive({
    type: "state",
    state: {
      phase: "active", activity: "idle", microphoneMuted: true, outputMuted: false,
    },
  });

  return { dir: target, idle: IDLE_FRAMES, talk: talk.length };
}

module.exports = { exportToAitherShell, shellAssetsDir };
