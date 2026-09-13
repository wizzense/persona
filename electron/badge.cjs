"use strict";

/**
 * badge — the notification count as PIXELS, with no canvas and no dependency.
 *
 * "No proper notification area in the taskbar" (owner, 2026-09-13): the count
 * lived inside a panel and on a floating bead, and the two places Windows
 * actually reserves for it — the tray icon and the taskbar button — showed
 * nothing. Both take a nativeImage, and the main process has no canvas to draw
 * one, so this draws straight into BGRA bitmaps: a disc anchored bottom-right
 * with a 3x5 numeral, "9+" past nine. Electron round-trips those bitmaps via
 * nativeImage.toBitmap() / createFromBitmap(), which is the whole trick.
 *
 * Pure functions only — main.cjs owns the nativeImage calls (see
 * badgedImage / badgeOverlay), so this file is testable under node --test.
 */

// 3x5 glyphs, rows top-down, 1 = lit.
const GLYPHS = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};

const DISC = { b: 0x4d, g: 0x48, r: 0xe5, a: 0xff }; // #e5484d
const INK = { b: 0xff, g: 0xff, r: 0xff, a: 0xff };

/** What the badge says for a count: "", "1".."9", or "9+". */
function badgeLabel(count) {
  const n = Number(count) || 0;
  if (n <= 0) return "";
  return n > 9 ? "9+" : String(n);
}

function put(pixels, width, x, y, c) {
  const i = (y * width + x) * 4;
  pixels[i] = c.b;
  pixels[i + 1] = c.g;
  pixels[i + 2] = c.r;
  pixels[i + 3] = c.a;
}

/**
 * Draw the badge for `count` into a BGRA bitmap in place. `diameter` is the
 * disc size; it sits in the bottom-right corner unless `fill` is set, in which
 * case it is centred (the taskbar overlay is the badge alone). A count of 0
 * draws nothing. Returns the label drawn.
 */
function drawBadge(pixels, width, height, count, { diameter = 12, fill = false } = {}) {
  const label = badgeLabel(count);
  if (!label) return "";
  const d = Math.max(7, Math.min(diameter, width, height));
  const x0 = fill ? Math.floor((width - d) / 2) : width - d;
  const y0 = fill ? Math.floor((height - d) / 2) : height - d;
  const cx = x0 + (d - 1) / 2;
  const cy = y0 + (d - 1) / 2;
  const r = d / 2;
  for (let y = y0; y < y0 + d; y += 1) {
    for (let x = x0; x < x0 + d; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) put(pixels, width, x, y, DISC);
    }
  }
  // Glyph run: 3 wide each, 1 gap; centred on the disc.
  const runW = label.length * 3 + (label.length - 1);
  let gx = Math.round(cx - (runW - 1) / 2);
  const gy = Math.round(cy - 2);
  for (const ch of label) {
    const rows = GLYPHS[ch];
    for (let ry = 0; ry < 5; ry += 1) {
      for (let rx = 0; rx < 3; rx += 1) {
        if (rows[ry][rx] === "1") {
          const px = gx + rx;
          const py = gy + ry;
          if (px >= 0 && px < width && py >= 0 && py < height) put(pixels, width, px, py, INK);
        }
      }
    }
    gx += 4;
  }
  return label;
}

/** A transparent size x size BGRA bitmap holding only the badge (for setOverlayIcon). */
function badgeBitmap(count, size = 16) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  drawBadge(pixels, size, size, count, { diameter: size, fill: true });
  return pixels;
}

/** The tray/taskbar tooltip for the same count. */
function badgeTooltip(count, total = count) {
  const n = Number(count) || 0;
  const t = Number(total) || 0;
  if (n > 0) {
    return `Desk — ${n} decision${n === 1 ? "" : "s"} waiting`
      + (t > n ? ` · ${t} cards in the inbox` : "");
  }
  if (t > 0) return `Desk — ${t} info card${t === 1 ? "" : "s"} (nothing to answer)`;
  return "Desk";
}

module.exports = { GLYPHS, badgeBitmap, badgeLabel, badgeTooltip, drawBadge };
