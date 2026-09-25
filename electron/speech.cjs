"use strict";

/**
 * speech.cjs -- speakAloud and its caption (sendBubble), with the two gates every
 * utterance passes: the per-origin audibility gate (voice-resolve.cjs) and the
 * safety funnel (safety-gate.cjs). Moved out of main.cjs in slice 3 of
 * docs/UX-REIMPLEMENTATION.md; the behaviour is main's, unchanged.
 *
 * Everything main-only arrives as a dep, so this module loads without Electron.
 * quietMode is a GETTER: main builds quiet mode after this module, and quiet
 * mode's own onChange speaks through speakAloud -- a getter breaks that cycle.
 * AitherOS/dev/tools/check_desk_safety_funnel.py (SFN001) reads THIS file for the
 * `require("./safety-gate.cjs")` and the `consultSpeech(` call.
 */

let resolveSpeech = null;
let effectiveVoiceFor = (requested, gate, fallback) => (gate && gate.voice) || requested || fallback;
try {
  ({ resolveSpeech, effectiveVoice: effectiveVoiceFor } = require("./voice-resolve.cjs")); // U06: the per-origin audibility gate
} catch (error) {
  console.warn("[desk] voice-resolve.cjs not present yet (U06) -- speakAloud is ungated:", error?.message || error);
}
// The safety funnel. Guarded like the gate above: a missing module leaves speech
// UNFILTERED rather than mute, which is the same trade voice-resolve.cjs makes.
let safetyGate = null;
try {
  safetyGate = require("./safety-gate.cjs");
} catch (error) {
  console.warn("[desk] safety-gate.cjs not present -- output is unfiltered:", error?.message || error);
}

/** The Voices page's ▶ (room-stage-host castPaneImpl.preview). Muting still applies. */
const PREVIEW_ORIGIN = "service:awdesk-preview";
/** Origins that answer something the owner just did, so quiet mode lets them speak. */
const QUIET_SPEAKERS = new Set([PREVIEW_ORIGIN, "service:awdesk-voice", "service:awdesk-voice-answer"]);

function createSpeech({ BrowserWindow, synthesizeVerdict, getQuietMode, debugLog = () => {} } = {}) {
  // Read at CALL time, never at creation: main assigns quietMode after this runs.
  const quietMode = {
    isQuiet: () => getQuietMode().isQuiet(),
    state: () => getQuietMode().state(),
  };

  /** The words, over the speaker's head. Sent on EVERY outcome of speakAloud that
   *  the cast allows a caption for -- spoken, muted, or a voice service that is
   *  down -- because the case the owner asked for is exactly the one where there
   *  is no audio: "if I have them muted I can see it, read it". `muted` tells the
   *  renderer there is no audio to time against, so it paces by reading speed.
   *  Returns how many windows got it; never throws (a caption must not be able to
   *  fail a speak). */
  function sendBubble(slotId, text, { muted = false, durationMs = 0 } = {}) {
    const body = String(text == null ? "" : text).trim();
    if (!body) return 0;
    let delivered = 0;
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send("desk:event", {
          type: "bubble",
          slotId: slotId || "slot0",
          text: body,
          muted: Boolean(muted),
          durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
        });
        delivered += 1;
      }
    } catch (error) {
      debugLog("bubble send failed", error?.message || error);
    }
    return delivered;
  }

  /** The avatar says `text` through AitherVoice, lip-synced by the renderer.
   *  ONE path for every caller -- the drop lane, POST /speak, the MCP `speak`
   *  tool -- so the orchestrator, a routine, awvoice and a Claude Code session
   *  all sound the same. Owner, 2026-09-18: "we have AitherVoice + awvoice +
   *  aither-orchestrator -- integrate this." Fail-soft: {ok:false, reason}.
   *
   *  `origin` (U28) is the STAMPED caller identity -- "bridge:/speak",
   *  "mcp:speak", "desk:drop", or a room-stage row's own origin key -- never a
   *  value taken from a request body (see cast-config.cjs's ORIGIN KEY GRAMMAR:
   *  a payload-supplied origin/actor field is a grant list, not caller
   *  authorization). It is the ONE refusal funnel U06's voice-resolve.cjs
   *  consults: three speech doors exist (this function, POST /speak, the MCP
   *  `speak` tool) and a room-only gate would leave two of them open. Fails
   *  open (today's ungated behaviour) when voice-resolve.cjs has not landed
   *  yet on this box -- see the guarded require above. */
  async function speakAloud(text, voice = "nova", speed = undefined, slotId = "slot0", origin = "service:awdesk") {
    let effectiveVoice = voice || "nova";
    let effectiveSpeed = speed;
    let effectiveMaxChars = 2000;
    // cast.json's master x actor fader. It is NEVER a caller argument: a request
    // body that could set its own loudness is the same hole as one that could
    // set its own origin, so it comes from the gate or it is full volume.
    let effectiveVolume = 1;
    // Fails OPEN like the gate itself: with no verdict, the words are shown.
    let captioned = true;
    // Quiet: a game is full-screen or Do not disturb is on. Only what the owner just
    // did themselves may speak (a preview, the desk answering them); the rest is shown.
    if (!QUIET_SPEAKERS.has(origin) && quietMode.isQuiet()) {
      const shown = sendBubble(slotId, text, { muted: true });
      return { ok: false, reason: `quiet: ${quietMode.state().reason}`, captioned: shown > 0 };
    }
    if (typeof resolveSpeech === "function") {
      let gate;
      try {
        gate = resolveSpeech({ origin, slotId, text });
      } catch (error) {
        debugLog("voice-resolve gate threw; failing open", origin, error?.message || error);
        gate = null;
      }
      if (gate && gate.caption === false) captioned = false;
      if (gate && gate.allowed === false) {
        // Refused for SOUND, not for sight: a muted speaker still gets its caption.
        const shown = captioned ? sendBubble(slotId, text, { muted: true }) : 0;
        return { ok: false, reason: gate.reason || `${origin} is not audible`, captioned: shown > 0 };
      }
      if (gate) {
        // An authored voice beats the caller; a HASH-derived one does not (voice-resolve.effectiveVoice).
        // A PREVIEW is the exception: its whole job is the voice it was asked for.
        effectiveVoice = origin === PREVIEW_ORIGIN && voice ? voice : effectiveVoiceFor(voice, gate, effectiveVoice);
        if (gate.speed != null) effectiveSpeed = gate.speed;
        if (gate.maxChars != null) effectiveMaxChars = gate.maxChars;
        if (typeof gate.volume === "number" && Number.isFinite(gate.volume)) effectiveVolume = gate.volume;
      }
    }
    // THE SAFETY FUNNEL, speech half (`.AITHERIUM/CAPABILITY/AVATAR-FORGE-PIPELINE.md` stage
    // 6). The cast gate above decided WHETHER this origin may be heard; this decides WHAT is
    // said. AitherSafety filters rather than refusing, so a rewritten line is spoken in its
    // filtered form: muting here would be a gate that gets switched off, and an unreachable
    // safety plane must not silence the fleet (safety-gate.cjs fails open and records it).
    let spoken = text;
    if (safetyGate && typeof safetyGate.consultSpeech === "function") {
      try {
        const verdict = await safetyGate.consultSpeech(text);
        if (verdict && typeof verdict.content === "string" && verdict.content) spoken = verdict.content;
        if (verdict && verdict.changed) debugLog("safety filtered an utterance", origin, verdict.level);
        if (verdict && verdict.reachable === false) debugLog("safety plane unreachable", verdict.reason);
      } catch (error) {
        debugLog("safety gate threw; speaking unfiltered", error?.message || error);
      }
    }
    const tts = await synthesizeVerdict(spoken, effectiveVoice, { speed: effectiveSpeed, maxChars: effectiveMaxChars });
    if (!tts.ok) {
      // A dead voice service takes the audio, not the words.
      const shown = captioned ? sendBubble(slotId, spoken, { muted: true }) : 0;
      return { ok: false, reason: tts.reason || "voice service unavailable", captioned: shown > 0 };
    }
    // Sent WITH the audio, after synthesis, so the caption appears as the mouth
    // starts moving rather than seconds ahead of it.
    // The caption shows what was SAID, i.e. the filtered text -- a bubble carrying the
    // unfiltered line would put the words on screen that the funnel just took out of the audio.
    if (captioned) sendBubble(slotId, spoken, { durationMs: tts.durationMs || 0 });
    let delivered = 0;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        // `slotId` picks WHOSE mouth moves: slot0 is the resident avatar; a
        // room-stage slot is one of the agents on stage.
        win.webContents.send("desk:event", {
          type: "speak",
          audioBase64: tts.audioBase64,
          slotId: slotId || "slot0",
          volume: effectiveVolume,
        });
        delivered += 1;
      }
    }
    if (delivered === 0) return { ok: false, reason: "no avatar window to speak from" };
    return { ok: true, chars: text.length, windows: delivered, durationMs: tts.durationMs || 0, slotId: slotId || "slot0" };
  }

  return { speakAloud, sendBubble };
}

module.exports = { createSpeech, PREVIEW_ORIGIN, QUIET_SPEAKERS };
