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

/** Alpha at or below this counts as background when finding the character. */
const ALPHA_THRESHOLD = 24;
/** Breathing room kept around the character, as a fraction of the crop's larger side. */
const CROP_MARGIN = 0.06;

/** Smallest box containing both (pure — unit-tested). */
function unionBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/**
 * Bounding box of the non-transparent pixels in a BGRA/RGBA bitmap, or null if the
 * frame is entirely transparent. Only the alpha byte is read, so channel order is
 * irrelevant. Pure — unit-tested in aithershell-export.test.cjs.
 */
function alphaBoundingBox(bitmap, width, height, alphaThreshold = ALPHA_THRESHOLD) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (bitmap[row + x * 4 + 3] > alphaThreshold) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0 || y1 < 0) return null;
  return { x0, y0, x1, y1 };
}

/**
 * Grow `box` to the target aspect ratio (plus a margin) and clamp it inside the frame.
 * Returns **null** when no aspect-correct rect inside the frame can contain `box` — the
 * caller must then export uncropped.
 *
 * Aspect matters: the character's own box is far taller than 480:832, so cropping to it
 * directly and resizing would stretch the avatar horizontally. Growing to the target
 * aspect instead keeps proportions and just removes empty space.
 *
 * The null case is a real one, not defensive padding. Clamping a dimension to the frame and
 * then re-deriving the other from the aspect ratio can make it SMALLER than the box, which
 * silently crops into the character. MEASURED on `siren-head` (tall AND wide): the rect came
 * out 490 wide for a ~520-wide character and cut it on BOTH sides — 35.6% of the left
 * boundary column and 12.5% of the right were opaque, i.e. a sliced silhouette. Refusing to
 * crop is correct there: a whole character at the old smaller scale beats a cut one.
 *
 * Pure — unit-tested, including a shape sweep that asserts containment for every box.
 */
function expandToAspect(box, frameWidth, frameHeight, targetWidth, targetHeight, margin = CROP_MARGIN) {
  const boxW = box.x1 - box.x0 + 1;
  const boxH = box.y1 - box.y0 + 1;
  if (boxW > frameWidth || boxH > frameHeight) return null;
  const pad = Math.round(Math.max(boxW, boxH) * margin);
  const targetAspect = targetWidth / targetHeight;

  let width = boxW + pad * 2;
  let height = boxH + pad * 2;
  // Grow the deficient dimension only — never shrink one to satisfy the aspect.
  if (width / height < targetAspect) width = Math.round(height * targetAspect);
  else height = Math.round(width / targetAspect);

  // Clamp to the frame, then re-derive the partner dimension. This is what can undercut the
  // box, so containment is re-checked below rather than assumed.
  if (width > frameWidth) { width = frameWidth; height = Math.round(width / targetAspect); }
  if (height > frameHeight) { height = frameHeight; width = Math.round(height * targetAspect); }

  // The box must still fit. If not, no aspect-correct crop is possible — say so.
  if (width < boxW || height < boxH) return null;
  if (width > frameWidth || height > frameHeight) return null;

  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const x = Math.max(0, Math.min(frameWidth - width, Math.round(cx - width / 2)));
  const y = Math.max(0, Math.min(frameHeight - height, Math.round(cy - height / 2)));
  // Clamping the ORIGIN can also push an edge past the box when the box hugs a frame side.
  if (x > box.x0 || y > box.y0 || x + width < box.x1 + 1 || y + height < box.y1 + 1) return null;
  return { x, y, width, height };
}

function shellAssetsDir() {
  // C:\AitherOS-Fresh is the canonical deploy root (this repo's own storage-topology
  // doctrine); D:\AitherOS-Fresh is a data-drive copy that can silently drift or miss
  // newer files. Both happened to exist with the same contents when this was found
  // 2026-08-24, so the old D: default never visibly failed — flagged in agent-avatars.cjs
  // while fixing a related "wrong-drive default" there, fixed here too. AITHERSHELL_ASSETS
  // still overrides for a machine laid out differently.
  return (
    process.env.AITHERSHELL_ASSETS ||
    path.join("C:", "AitherOS-Fresh", ".PRODUCTS", ".AITHERSHELL", "cli", "assets")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capture `count` RAW frames spaced across `spanMs` (one animation cycle).
 * Returns NativeImages — cropping happens later, once the whole set is known.
 */
async function captureRawSequence(window, count, spanMs) {
  const frames = [];
  const gap = Math.max(60, Math.round(spanMs / count));
  for (let index = 0; index < count; index += 1) {
    frames.push(await window.webContents.capturePage());
    if (index < count - 1) await sleep(gap);
  }
  return frames;
}

/**
 * Union of the alpha bounding boxes of every supplied frame, plus the frame size.
 *
 * Deriving the crop from the frames we are ACTUALLY going to write is the only way to
 * guarantee none of them is clipped. Sizing it from separate probe captures cannot work:
 * the character keeps moving, so a rect measured before the capture run is fitted to poses
 * that are no longer on screen — MEASURED, `siren-head` was still sliced (18.5% of the left
 * boundary column opaque) even after the rect was unioned across 6 probes spanning a full
 * idle cycle, because the capture run that followed swung wider than the probe run had.
 */
function unionOfFrames(frames) {
  let union = null;
  let width = 0;
  let height = 0;
  for (const image of frames) {
    const size = image.getSize();
    if (!size.width || !size.height) continue;
    width = size.width;
    height = size.height;
    union = unionBox(union, alphaBoundingBox(image.getBitmap(), width, height));
  }
  return { union, width, height };
}

/** Crop+resize `image` to the shell's frame size and write it. */
function writeFrame(image, rect, file) {
  const source = rect ? image.crop(rect) : image;
  const sized = source.resize({ width: FRAME_WIDTH, height: FRAME_HEIGHT, quality: "good" });
  fs.writeFileSync(file, sized.toPNG());
  return file;
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

  // ── Capture EVERYTHING raw first, then derive one crop from the real frames ──
  // Order matters: a rect predicted before the capture run gets fitted to poses that are
  // no longer on screen, and the frames that follow are clipped.
  const idleFrames = await captureRawSequence(window, IDLE_FRAMES, 2400);
  const stillFrame = await window.webContents.capturePage();

  drive({
    type: "state",
    state: {
      phase: "active", activity: "speaking", microphoneMuted: true, outputMuted: false,
    },
  });
  await sleep(300);
  const talkFrames = [];
  for (let index = 0; index < TALK_FRAMES; index += 1) {
    drive({ type: "audio-level", level: index % 2 === 0 ? 0.38 : 0.1 });
    await sleep(140);
    talkFrames.push(await window.webContents.capturePage());
  }

  // One rect covering every frame we are about to write — so none can be clipped.
  const all = [...idleFrames, stillFrame, ...talkFrames];
  const { union, width, height } = unionOfFrames(all);
  let rect = null;
  if (union && width && height) {
    rect = expandToAspect(union, width, height, FRAME_WIDTH, FRAME_HEIGHT);
    // A rect that is basically the whole frame buys nothing; skip the crop.
    if (rect && rect.width >= width * 0.97 && rect.height >= height * 0.97) rect = null;
  }

  const idleDir = path.join(target, "idle");
  fs.mkdirSync(idleDir, { recursive: true });
  idleFrames.forEach((image, index) =>
    writeFrame(image, rect, path.join(idleDir, `frame_${String(index).padStart(2, "0")}.png`)));

  // Still fallback face — every unmapped emotion lands here
  writeFrame(stillFrame, rect, path.join(target, "neutral.png"));

  const talk = talkFrames.map((image, index) =>
    writeFrame(image, rect, path.join(target, `neutral-talk-${index}.png`)));

  drive({ type: "audio-level", level: 0 });
  drive({
    type: "state",
    state: {
      phase: "active", activity: "idle", microphoneMuted: true, outputMuted: false,
    },
  });

  return {
    dir: target,
    idle: IDLE_FRAMES,
    talk: talk.length,
    cropped: rect ? `${rect.width}x${rect.height}+${rect.x}+${rect.y}` : "none",
  };
}

module.exports = {
  exportToAitherShell,
  shellAssetsDir,
  alphaBoundingBox,
  expandToAspect,
  unionBox,
  FRAME_WIDTH,
  FRAME_HEIGHT,
};
