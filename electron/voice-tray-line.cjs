"use strict";

/**
 * The tray's "Voice: …" line — a pure function so it is unit-tested rather
 * than eyeballed. A dead voice listener is otherwise invisible: the app boots,
 * draws, answers /health and the avatar simply never speaks (measured
 * 2026-09-18 on the owner's own desk, where the Windows helper had never been
 * built). The line exists only while the listener reports unavailable, so a
 * healthy desk shows nothing extra.
 *
 * @param {{available?: boolean}|null|undefined} status latest listener status
 * @param {boolean} isPackaged Electron's app.isPackaged
 * @returns {Array<{label: string, enabled: boolean}>} zero or one menu items
 */
function voiceTrayItems(status, isPackaged) {
  if (!status || status.available !== false) return [];
  return [{
    label: isPackaged
      ? "Voice: listener unavailable — reinstall Desk"
      : "Voice: listener missing — run `npm run native:fetch`",
    enabled: false,
  }];
}

module.exports = { voiceTrayItems };
