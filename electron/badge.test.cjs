"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { badgeBitmap, badgeLabel, badgeTooltip, drawBadge } = require("./badge.cjs");

function alphaAt(pixels, width, x, y) {
  return pixels[(y * width + x) * 4 + 3];
}
function isInk(pixels, width, x, y) {
  const i = (y * width + x) * 4;
  return pixels[i] === 0xff && pixels[i + 1] === 0xff && pixels[i + 2] === 0xff;
}

test("badgeLabel: nothing at zero, digits to nine, 9+ beyond", () => {
  assert.equal(badgeLabel(0), "");
  assert.equal(badgeLabel(-3), "");
  assert.equal(badgeLabel(1), "1");
  assert.equal(badgeLabel(9), "9");
  assert.equal(badgeLabel(23), "9+");
  assert.equal(badgeLabel("7"), "7");
});

test("drawBadge: zero leaves the bitmap untouched", () => {
  const px = Buffer.alloc(20 * 20 * 4, 0);
  assert.equal(drawBadge(px, 20, 20, 0), "");
  assert.ok(px.every((b) => b === 0));
});

test("drawBadge: a disc lands bottom-right and the numeral is lit inside it", () => {
  const px = Buffer.alloc(20 * 20 * 4, 0);
  assert.equal(drawBadge(px, 20, 20, 5, { diameter: 12 }), "5");
  // Top-left corner: untouched. Disc centre (bottom-right): opaque.
  assert.equal(alphaAt(px, 20, 0, 0), 0);
  assert.equal(alphaAt(px, 20, 14, 14), 0xff);
  // The glyph "5" has a lit top row: some white pixel exists in the disc.
  let ink = 0;
  for (let y = 8; y < 20; y += 1) for (let x = 8; x < 20; x += 1) if (isInk(px, 20, x, y)) ink += 1;
  assert.ok(ink >= 9 && ink <= 15, `5 lights 11 pixels, saw ${ink}`);
});

test("drawBadge: 9+ is two glyphs wide and still fits a 12px disc", () => {
  const px = Buffer.alloc(20 * 20 * 4, 0);
  drawBadge(px, 20, 20, 23, { diameter: 12 });
  const cols = new Set();
  for (let y = 8; y < 20; y += 1) for (let x = 8; x < 20; x += 1) if (isInk(px, 20, x, y)) cols.add(x);
  assert.equal(cols.size, 6, `9+ lights 6 columns across a 7-wide run, saw ${[...cols].join(",")}`);
});

test("badgeBitmap: transparent outside the disc, filled inside, sized as asked", () => {
  const px = badgeBitmap(3, 16);
  assert.equal(px.length, 16 * 16 * 4);
  assert.equal(alphaAt(px, 16, 0, 0), 0);
  assert.equal(alphaAt(px, 16, 8, 8), 0xff);
  assert.ok(badgeBitmap(0, 16).every((b) => b === 0));
});

test("badgeTooltip: waiting vs info-only vs quiet", () => {
  assert.equal(badgeTooltip(0, 0), "Desk");
  assert.equal(badgeTooltip(1, 1), "Desk — 1 decision waiting");
  assert.equal(badgeTooltip(2, 5), "Desk — 2 decisions waiting · 5 cards in the inbox");
  assert.equal(badgeTooltip(0, 3), "Desk — 3 info cards (nothing to answer)");
});
