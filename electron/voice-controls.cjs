"use strict";

/**
 * voice-controls.cjs -- "Mute all voices" and the right-click Voice picker
 * (owner, 2026-09-23: "no easy way to mute voices/narration or change and assign
 * voices"). Moved out of main.cjs the day it landed: the redesign's slice 3 is
 * main.cjs getting SMALLER, and a feature that starts life in main never leaves.
 *
 * Everything main-only arrives as a dep, so this module loads without Electron.
 */

function createVoiceControls({ BrowserWindow, speakAloud, refreshTrayMenu, castPane, debugLog = () => {} } = {}) {
  /** cast.json voice.muted: the room-wide speaker switch (the Cast pane's "Mute everyone"). */
  function voicesMuted() {
    try {
      const { load, resolveVoice } = require("./cast-config.cjs");
      return resolveVoice(load().snapshot).muted === true;
    } catch {
      return false;
    }
  }

  /** Tell every renderer to stop the audio it is playing right now. Muting that
   *  only takes effect on the NEXT line leaves the current paragraph talking over
   *  the click that asked for quiet. */
  function hushNow() {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("desk:event", { type: "hush" });
    }
  }

  function toggleVoiceSilence() {
    try {
      const { write } = require("./cast-config.cjs");
      const next = !voicesMuted();
      const result = write((draft) => { draft.voice = { ...(draft.voice || {}), muted: next }; return draft; });
      if (result && result.ok === false) throw new Error(result.error || "cast.json write refused");
      if (next) hushNow();
      else void speakAloud("Voices on.", undefined, undefined, "slot0", "service:awdesk-voice");
      refreshTrayMenu();
    } catch (error) {
      debugLog("toggleVoiceSilence failed", error && error.message);
    }
  }

  /** The voices the right-click picker offers. Short names are AitherVoice aliases
   *  (EDGE_VOICE_ALIASES); any `en-*Neural` id passes straight to edge-tts. The Cast
   *  pane still takes any id by hand. */
  const VOICE_MENU = Object.freeze([
    ["nova", "Aria — US woman"],
    ["shimmer", "Jenny — US woman"],
    ["en-US-AvaNeural", "Ava — US woman"],
    ["en-US-EmmaNeural", "Emma — US woman"],
    ["en-US-AnaNeural", "Ana — US girl"],
    ["alloy", "Alloy — US man"],
    ["echo", "Echo — US man"],
    ["onyx", "Onyx — US man, deep"],
    ["fable", "Ryan — British man"],
    ["en-GB-SoniaNeural", "Sonia — British woman"],
  ]);

  /** The body's cast.json key, its current resolution and its own actor record,
   *  or null when the stage does not know the body. */
  function castRowForSlot(slotId) {
    try {
      const want = slotId === "default" ? "slot0" : slotId;
      const described = castPane().describe();
      const row = (described.onStage || []).find((r) => r.slotId === want);
      if (!row || !row.origin) return null;
      const actors = (described.snapshot && described.snapshot.actors) || {};
      return { key: row.origin, resolution: row.resolution || {}, record: actors[row.origin] || {} };
    } catch (error) {
      debugLog("castRowForSlot failed", error && error.message);
      return null;
    }
  }

  /** Patch one actor record in cast.json; a field set to undefined is REMOVED
   *  (so "reset" falls back to the tier below instead of writing an invalid null). */
  function patchActor(key, patch) {
    try {
      const { write } = require("./cast-config.cjs");
      const result = write((draft) => {
        draft.actors = draft.actors || {};
        const rec = { ...(draft.actors[key] || {}) };
        for (const [field, value] of Object.entries(patch)) {
          if (value === undefined) delete rec[field];
          else rec[field] = value;
        }
        draft.actors[key] = rec;
        return draft;
      });
      if (result && result.ok === false) throw new Error(result.error || "cast.json write refused");
      if (patch.speak === false) hushNow();
    } catch (error) {
      debugLog("patchActor failed", key, error && error.message);
    }
  }

  /** Through the Cast pane's unsilence -- the SAME write the Voices page's
   *  Speaks switch makes, so the two surfaces cannot drift apart. */
  function letSpeak(key) {
    try {
      const result = castPane().unsilence({ key });
      if (result && result.ok === false) throw new Error(result.error || "cast.json write refused");
    } catch (error) {
      debugLog("letSpeak failed", key, error && error.message);
    }
  }

  /** Right-click a body -> Voice: pick who it sounds like, or silence just this one. */
  function buildVoiceMenu(slotId) {
    const found = castRowForSlot(slotId);
    if (!found) return [{ label: "Not on stage yet — use Cast && voices…", enabled: false }];
    const { key, resolution, record } = found;
    const own = typeof record.voice === "string" ? record.voice : "";
    const items = VOICE_MENU.map(([id, label]) => ({
      label,
      type: "radio",
      checked: own === id,
      click: () => patchActor(key, { voice: id }),
    }));
    if (own && !VOICE_MENU.some(([id]) => id === own)) {
      items.unshift({ label: `Current: ${own}`, type: "radio", checked: true, enabled: false });
    }
    // Silenced = anything "Let this one speak" would lift: speak:false OR a
    // presence off/quiet (room-stage-host unsilencePatch, the Voices page's rule
    // too). Reading speak alone offered "Silence" to a quiet body with no way back.
    const { unsilencePatch } = require("./room-stage-host.cjs");
    const silenced = Object.keys(unsilencePatch(record, resolution)).length > 0;
    return [
      { label: own ? "Set a voice for this body" : `Default voice (${resolution.voice || "auto"})`, enabled: false },
      ...items,
      { type: "separator" },
      silenced
        ? { label: "Let this one speak", click: () => letSpeak(key) }
        : { label: "Silence this one", click: () => patchActor(key, { speak: false }) },
      { label: "Back to the default voice", enabled: Boolean(own), click: () => patchActor(key, { voice: undefined }) },
    ];
  }

  return { voicesMuted, hushNow, toggleVoiceSilence, buildVoiceMenu, patchActor, letSpeak, castRowForSlot, VOICE_MENU };
}

module.exports = { createVoiceControls };
