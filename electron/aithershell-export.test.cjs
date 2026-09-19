"use strict";

/**
 * Crop maths for the AitherShell portrait export.
 *
 * Why this exists: MEASURED on a live export 2026-07-29, 79% of each captured frame was
 * fully transparent and the character occupied only 30% of it — so the avatar rendered in
 * AitherShell's docked pane at about a third of its usable size. The export "worked" the
 * whole time, which is why nothing caught it: the files were written, the frames decoded,
 * and the character was in there, just small.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  alphaBoundingBox,
  expandToAspect,
  unionBox,
  FRAME_WIDTH,
  FRAME_HEIGHT,
} = require("./aithershell-export.cjs");

/** Build a BGRA bitmap with an opaque rectangle at the given box. */
function bitmapWithBox(width, height, box, alpha = 255) {
  const bmp = Buffer.alloc(width * height * 4, 0);
  for (let y = box.y0; y <= box.y1; y += 1) {
    for (let x = box.x0; x <= box.x1; x += 1) {
      const i = (y * width + x) * 4;
      bmp[i] = 40; bmp[i + 1] = 60; bmp[i + 2] = 200; bmp[i + 3] = alpha;
    }
  }
  return bmp;
}

test("alphaBoundingBox finds the opaque region exactly", () => {
  const box = { x0: 131, y0: 266, x1: 343, y1: 700 };
  const found = alphaBoundingBox(bitmapWithBox(480, 832, box), 480, 832);
  assert.deepEqual(found, box);
});

test("alphaBoundingBox returns null for a fully transparent frame", () => {
  // The export must then fall back to uncropped rather than crop to nothing.
  assert.equal(alphaBoundingBox(Buffer.alloc(480 * 832 * 4, 0), 480, 832), null);
});

test("alphaBoundingBox ignores near-transparent antialiasing fringe", () => {
  const bmp = bitmapWithBox(100, 100, { x0: 40, y0: 40, x1: 60, y1: 60 }, 255);
  // A stray alpha-8 pixel far away must not blow the box out to the frame edge.
  const i = (5 * 100 + 5) * 4;
  bmp[i + 3] = 8;
  assert.deepEqual(alphaBoundingBox(bmp, 100, 100), { x0: 40, y0: 40, x1: 60, y1: 60 });
});

test("alphaBoundingBox reads ONLY alpha, so channel order does not matter", () => {
  // Deliberately zero the colour bytes: a luminance-based detector would find nothing.
  const bmp = Buffer.alloc(50 * 50 * 4, 0);
  for (let y = 10; y <= 20; y += 1) for (let x = 10; x <= 20; x += 1) bmp[(y * 50 + x) * 4 + 3] = 255;
  assert.deepEqual(alphaBoundingBox(bmp, 50, 50), { x0: 10, y0: 10, x1: 20, y1: 20 });
});

test("expandToAspect preserves the target aspect ratio", () => {
  // The measured real case: a tall, narrow character inside a 480x832 frame.
  const rect = expandToAspect({ x0: 131, y0: 266, x1: 343, y1: 831 }, 480, 832, FRAME_WIDTH, FRAME_HEIGHT);
  const want = FRAME_WIDTH / FRAME_HEIGHT;
  assert.ok(Math.abs(rect.width / rect.height - want) < 0.02,
    `aspect ${(rect.width / rect.height).toFixed(3)} vs ${want.toFixed(3)}`);
});

test("expandToAspect never crops INTO the character", () => {
  const box = { x0: 131, y0: 266, x1: 343, y1: 700 };
  const rect = expandToAspect(box, 480, 832, FRAME_WIDTH, FRAME_HEIGHT);
  assert.ok(rect.x <= box.x0, `left ${rect.x} > ${box.x0}`);
  assert.ok(rect.y <= box.y0, `top ${rect.y} > ${box.y0}`);
  assert.ok(rect.x + rect.width >= box.x1 + 1, 'right edge cuts the character');
  assert.ok(rect.y + rect.height >= box.y1 + 1, 'bottom edge cuts the character');
});

test("expandToAspect stays inside the frame — crop() rejects an out-of-bounds rect", () => {
  const cases = [
    { x0: 0, y0: 0, x1: 10, y1: 10 },            // hugging the top-left
    { x0: 470, y0: 820, x1: 479, y1: 831 },      // hugging the bottom-right
    { x0: 0, y0: 0, x1: 479, y1: 831 },          // the whole frame
    { x0: 200, y0: 400, x1: 201, y1: 401 },      // a 2x2 speck
  ];
  for (const box of cases) {
    const r = expandToAspect(box, 480, 832, FRAME_WIDTH, FRAME_HEIGHT);
    assert.ok(r.x >= 0 && r.y >= 0, `negative origin for ${JSON.stringify(box)}`);
    assert.ok(r.x + r.width <= 480, `overflows width for ${JSON.stringify(box)}`);
    assert.ok(r.y + r.height <= 832, `overflows height for ${JSON.stringify(box)}`);
    assert.ok(r.width > 0 && r.height > 0, `empty rect for ${JSON.stringify(box)}`);
  }
});

test("expandToAspect actually SHRINKS the frame for the measured real case", () => {
  // The whole point: the crop must be meaningfully smaller than 480x832, or the avatar
  // stays tiny in the docked pane.
  const rect = expandToAspect({ x0: 131, y0: 266, x1: 343, y1: 831 }, 480, 832, FRAME_WIDTH, FRAME_HEIGHT);
  const area = (rect.width * rect.height) / (480 * 832);
  assert.ok(area < 0.75, `crop kept ${(area * 100).toFixed(1)}% of the frame — not much of a crop`);
  // And the character should now fill much more of the cropped region than the 30% measured.
  const charArea = (343 - 131 + 1) * (831 - 266 + 1) / (rect.width * rect.height);
  assert.ok(charArea > 0.45, `character only fills ${(charArea * 100).toFixed(1)}% of the crop`);
});

test("a centred square character is not distorted", () => {
  const rect = expandToAspect({ x0: 190, y0: 390, x1: 290, y1: 490 }, 480, 832, FRAME_WIDTH, FRAME_HEIGHT);
  assert.ok(Math.abs(rect.width / rect.height - FRAME_WIDTH / FRAME_HEIGHT) < 0.02);
  // Centre must stay put (within rounding + clamping).
  assert.ok(Math.abs((rect.x + rect.width / 2) - 240) < 3, `centre drifted to ${rect.x + rect.width / 2}`);
});

// Sizing the crop from ONE instant clipped `mermaid`: her hair/tail reached the right
// frame edge (x1=479/479) in a later frame than the one the rect was measured from.
// The crop is now the UNION over probes spanning an idle cycle.
test("unionBox grows to contain both boxes", () => {
  const a = { x0: 100, y0: 200, x1: 300, y1: 600 };
  const b = { x0: 90, y0: 250, x1: 479, y1: 550 };
  assert.deepEqual(unionBox(a, b), { x0: 90, y0: 200, x1: 479, y1: 600 });
});

test("unionBox tolerates a null side (an empty probe frame)", () => {
  const a = { x0: 1, y0: 2, x1: 3, y1: 4 };
  assert.deepEqual(unionBox(null, a), a);
  assert.deepEqual(unionBox(a, null), a);
  assert.equal(unionBox(null, null), null);
});

test("a union covering the moving character is NOT clipped by the resulting rect", () => {
  // The measured mermaid case: a narrow early pose, then motion out to the right edge.
  const early = { x0: 120, y0: 30, x1: 300, y1: 831 };
  const late = { x0: 65, y0: 30, x1: 479, y1: 831 };
  const rect = expandToAspect(unionBox(early, late), 480, 832, FRAME_WIDTH, FRAME_HEIGHT);
  // Both poses must fit fully inside the rect, or a frame gets cut.
  for (const [name, box] of [["early", early], ["late", late]]) {
    assert.ok(rect.x <= box.x0, `${name}: left cut (${rect.x} > ${box.x0})`);
    assert.ok(rect.y <= box.y0, `${name}: top cut`);
    assert.ok(rect.x + rect.width >= box.x1 + 1, `${name}: right cut`);
    assert.ok(rect.y + rect.height >= box.y1 + 1, `${name}: bottom cut`);
  }
});

/**
 * The containment INVARIANT, swept over many shapes rather than a few hand-picked ones.
 *
 * The hand-picked cases all passed while `siren-head` was being cut on both sides: a box
 * that is tall AND wide made the code clamp height to the frame and then re-derive a
 * NARROWER width, silently slicing the character. This sweep is what catches that class.
 */
test("expandToAspect either CONTAINS the box or returns null — never a partial crop", () => {
  const F_W = 540, F_H = 850;
  let cropped = 0, refused = 0;
  for (let w = 10; w <= F_W; w += 17) {
    for (let h = 10; h <= F_H; h += 23) {
      for (const [ox, oy] of [[0, 0], [(F_W - w) >> 1, (F_H - h) >> 1], [F_W - w, F_H - h]]) {
        const box = { x0: ox, y0: oy, x1: ox + w - 1, y1: oy + h - 1 };
        const r = expandToAspect(box, F_W, F_H, FRAME_WIDTH, FRAME_HEIGHT);
        if (r === null) { refused += 1; continue; }
        cropped += 1;
        // Inside the frame — image.crop() throws or misbehaves otherwise.
        assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= F_W && r.y + r.height <= F_H,
          `rect outside frame for ${JSON.stringify(box)}: ${JSON.stringify(r)}`);
        // Contains the character COMPLETELY. This is the assertion siren-head violated.
        assert.ok(r.x <= box.x0 && r.y <= box.y0
          && r.x + r.width >= box.x1 + 1 && r.y + r.height >= box.y1 + 1,
          `box ${JSON.stringify(box)} is CUT by rect ${JSON.stringify(r)}`);
        // Aspect preserved, so the avatar is not stretched.
        assert.ok(Math.abs(r.width / r.height - FRAME_WIDTH / FRAME_HEIGHT) < 0.03,
          `aspect drift for ${JSON.stringify(box)}: ${(r.width / r.height).toFixed(3)}`);
      }
    }
  }
  // Anti-vacuous: the sweep must actually exercise BOTH branches.
  assert.ok(cropped > 100, `only ${cropped} crops produced — sweep too narrow to mean anything`);
  assert.ok(refused > 0, 'no box was refused — the null branch is untested');
});

test("expandToAspect REFUSES the measured siren-head shape rather than cutting it", () => {
  // Tall and wide: no 480:832 rect inside a 540x850 frame can contain it.
  assert.equal(expandToAspect({ x0: 10, y0: 0, x1: 529, y1: 849 }, 540, 850, FRAME_WIDTH, FRAME_HEIGHT), null);
  // A box larger than the frame is refused outright.
  assert.equal(expandToAspect({ x0: 0, y0: 0, x1: 600, y1: 100 }, 540, 850, FRAME_WIDTH, FRAME_HEIGHT), null);
});

test("expandToAspect still crops the normal case (the refusal is not blanket)", () => {
  const r = expandToAspect({ x0: 131, y0: 266, x1: 343, y1: 831 }, 480, 832, FRAME_WIDTH, FRAME_HEIGHT);
  assert.ok(r, 'the normal tall-narrow character must still be cropped');
  assert.ok(r.width * r.height < 480 * 832 * 0.8, 'crop should shrink the frame');
});
