"use strict";

/**
 * voice-client — the desk's voice: awvoice/aithervoice over the shared
 * gateway-mcp transport (owner 2026-08-25: "finish integrating
 * awvoice/aithervoice"). The aw* registry brick is AitherOS/packages/awvoice
 * ("turn speech into text and text into speech, on a service you host");
 * the desk speaks to it through the gateway's voice tools, never a vendor
 * SDK:
 *
 *   - get_voice_status    — is the hosted voice service up
 *   - get_available_voices — which voices exist
 *   - synthesize_speech   — text -> audio (the avatar's mouth)
 *   - transcribe_audio    — audio file -> text (the avatar's ears)
 *
 * Same degradation contract as system-client: every source fails soft, a
 * dead gateway yields ok:true with ERROR notes the UI renders as
 * "unavailable", never a half-truth (security-review-patterns #5). The
 * action functions (synthesize/transcribe) are exported for the IPC bridge;
 * the self-test is read-only (status + voices) because synthesis spends real
 * GPU time.
 */

const { callTool, parseMaybeJson } = require("./gateway-mcp.cjs");

async function voiceStatus(call = callTool) {
  const text = await call("get_voice_status", {});
  return parseMaybeJson(text) ?? { note: text.slice(0, 300) };
}

async function listVoices(call = callTool) {
  const text = await call("get_available_voices", {});
  return parseMaybeJson(text) ?? { note: text.slice(0, 300) };
}

/** text -> audio. Returns the parsed result (the hosted service reports
 *  where the audio landed); the caller renders it, never echoes verbatim. */
async function synthesize(text, voice, call = callTool) {
  const args = { text };
  if (voice) args.voice = voice;
  const out = await call("synthesize_speech", args);
  return parseMaybeJson(out) ?? { note: out.slice(0, 300) };
}

/** audio file -> transcript. `audioPath` is a HOST path — the desk and the
 *  gateway share the box, so no upload hop is involved. */
async function transcribe(audioPath, call = callTool) {
  const out = await call("transcribe_audio", { audio_path: audioPath });
  return parseMaybeJson(out) ?? { note: out.slice(0, 300) };
}

/** One read-only awareness call for the deck section: service status +
 *  available voices. */
async function voiceSnapshot(call = callTool) {
  try {
    const [statusText, voicesText] = await Promise.all([
      call("get_voice_status", {}).catch((error) => `ERROR: ${error.message}`),
      call("get_available_voices", {}).catch((error) => `ERROR: ${error.message}`),
    ]);
    return {
      ok: true,
      status: parseMaybeJson(statusText) ?? { note: statusText.slice(0, 300) },
      voices: parseMaybeJson(voicesText) ?? { note: voicesText.slice(0, 300) },
      at: Math.floor(Date.now() / 1000),
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

module.exports = { voiceStatus, listVoices, synthesize, transcribe, voiceSnapshot };

if (require.main === module) {
  // Self-test: read-only. Exit 0 = service up, 1 = service down/unreachable
  // (the status envelope reports its own error), 2 = module broken. A
  // healthy transport over a down service is UNAVAILABLE, never OK.
  (async () => {
    try {
      const snap = await voiceSnapshot();
      if (!snap.ok) {
        console.error(`VOICE UNAVAILABLE: ${snap.reason}`);
        process.exit(1);
      }
      if (snap.status?.status === "error") {
        console.error(`VOICE UNAVAILABLE: ${snap.status.error || "service error"}`);
        process.exit(1);
      }
      const voices = snap.voices;
      const count = Array.isArray(voices?.voices) ? voices.voices.length
        : Array.isArray(voices) ? voices.length
          : voices?.note ? `prose list (${voices.note.slice(0, 40)}...)` : "?";
      console.log(`VOICE OK: ${count} voice(s)`);
      process.exit(0);
    } catch (error) {
      console.error(`MODULE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
