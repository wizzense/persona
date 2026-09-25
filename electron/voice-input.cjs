"use strict";

/**
 * voice-input.cjs -- the owner's voice INTO the desk: push-to-talk, open mic, the
 * mic mute, voiceAsk (a session asking the owner aloud), the three voice IPC
 * handlers and the process-audio listener. Moved out of main.cjs in slice 3 of
 * docs/UX-REIMPLEMENTATION.md; the behaviour is main's, unchanged.
 *
 * Everything main-only arrives as a dep, so this module loads without Electron.
 * The avatar window is REPLACED (a character switch), and commandAction is built
 * after this module, so both arrive as getters/lambdas read at call time.
 */

const { createAudioListener } = require("./audio-listener.cjs");
const { voiceState } = require("./protocol-actions.cjs");

function createVoiceInput({
  ipcMain,
  app,
  getAvatarWindow,
  getTray,
  showOverlay,
  sendToAvatar,
  emitToRenderer,
  refreshTrayMenu,
  handleBridgeEvent,
  speakAloud,
  commandAction,
  stagePath,
  cleanupStage,
  debugEnabled = false,
  debugLog = () => {},
} = {}) {
  let latestListenerStatus = null;
  let audioListener = null;

  function handleListenerStatus(status) {
    const availabilityChanged = latestListenerStatus?.available !== status?.available;
    latestListenerStatus = status;
    emitToRenderer({ type: "listener-status", status });
    // The tray carries a "Voice: listener missing" line; keep it honest.
    if (availabilityChanged && getTray()) refreshTrayMenu();
  }

  /**
   * Push-to-talk from ANYWHERE (Plan 40 slice C).
   *
   * The mic already existed, inside the deck's chat box: to talk to the agents the
   * owner had to find that pane first. The capture happens in the avatar window
   * (open whenever the overlay is), and main only says when to listen -- so the
   * tray item, the palette and the global hotkey all reach the same recorder.
   *
   * A transcript is not a note: it goes through commandAction, which the room
   * publisher is attached to, so the owner's words land in the company room as the
   * OWNER and the reply is spoken back by whichever agent answers.
   */
  let listenState = "idle";

  function listeningNow() {
    return listenState === "listening";
  }

  function micMuted() {
    try {
      const { load, resolveInput } = require("./cast-config.cjs");
      return !!resolveInput(load().snapshot).micMuted;
    } catch {
      return false; // unreadable settings must not silently disable the mic
    }
  }

  function talkMode() {
    try {
      const { load, resolveInput } = require("./cast-config.cjs");
      return resolveInput(load().snapshot).talkMode || "toggle";
    } catch {
      return "toggle";
    }
  }

  /**
   * Open mic (Settings -> Talk mode -> Open mic). The renderer does the speech
   * detection (src/voice/handsFree.ts); main only says on/off and remembers it,
   * so a renderer reload (a character switch) gets it back from get-snapshot.
   */
  let openMicOn = false;

  function avatarGone() {
    const avatarWindow = getAvatarWindow();
    return !avatarWindow || avatarWindow.isDestroyed();
  }

  function setOpenMic(on, { announce = false } = {}) {
    const next = Boolean(on);
    const changed = next !== openMicOn;
    openMicOn = next;
    if (next && avatarGone()) showOverlay();
    sendToAvatar("open-mic", { on: next });
    if (changed && announce) {
      void speakAloud(next ? "Open mic is on. Just talk." : "Open mic is off.", undefined, undefined, "slot0", "service:awdesk-voice");
    }
    refreshTrayMenu();
  }

  /** Bring open mic in line with Settings: on exactly when mode=open and unmuted. */
  function applyTalkMode({ announce = false } = {}) {
    setOpenMic(talkMode() === "open" && !micMuted(), { announce });
  }

  /** Open mic from Settings comes back on at boot; the renderer picks it up
   *  from get-snapshot when it mounts (a push now would beat its listener). */
  function restoreOpenMicAtBoot() {
    openMicOn = talkMode() === "open" && !micMuted();
  }

  function toggleListening() {
    if (micMuted()) {
      void speakAloud("Microphone is muted. Unmute it in Settings.", undefined, undefined, "slot0", "service:awdesk-voice");
      return;
    }
    const mode = talkMode();
    // Open mic: the hotkey is the on/off switch -- there is nothing to press
    // per sentence.
    if (mode === "open") {
      setOpenMic(!openMicOn, { announce: true });
      return;
    }
    if (avatarGone()) {
      // Nothing to capture with: show the avatar rather than failing silently,
      // which is what "the hotkey does nothing" looked like.
      showOverlay();
    }
    const want = !listeningNow();
    listenState = want ? "listening" : "transcribing";
    // Hold: a global shortcut reports the key going down, never coming up, so
    // the hotkey records until the owner goes quiet (oneShot) instead. A second
    // press still stops it at once.
    sendToAvatar("listen", { listening: want, oneShot: want && mode === "hold" });
    refreshTrayMenu();
  }

  // A session asks the owner aloud and gets the spoken answer back (voice-ask.cjs).
  // While it waits, the next transcript is the ANSWER, not a new command.
  const voiceAsk = require("./voice-ask.cjs").createVoiceAsk({
    speak: (question) => speakAloud(question, undefined, undefined, "slot0", "mcp:speak"),
    listen: () => {
      if (micMuted()) return { ok: false, error: "microphone is muted" };
      // Open mic already hears the next sentence; otherwise record until quiet.
      if (openMicOn) return { ok: true };
      if (avatarGone()) showOverlay();
      listenState = "listening";
      sendToAvatar("listen", { listening: true, oneShot: true });
      refreshTrayMenu();
      return { ok: true };
    },
  });

  function toggleMicMute() {
    try {
      const { load, write, resolveInput } = require("./cast-config.cjs");
      const nowMuted = resolveInput(load().snapshot).micMuted;
      const next = !nowMuted;
      write((draft) => { draft.input = { ...(draft.input || {}), micMuted: next }; });
      void speakAloud(next ? "Muted." : "Unmuted.", undefined, undefined, "slot0", "service:awdesk-voice");
      applyTalkMode();
      refreshTrayMenu();
    } catch (error) {
      debugLog("toggleMicMute failed", error && error.message);
    }
  }

  function registerVoiceIpc() {
    // Push-to-talk (2026-08-29): base64 wav from the renderer's MediaRecorder
    // -> temp file -> gateway transcribe_audio -> transcript. Errors return
    // "ERROR: ..." strings so the renderer can show them without a throw.
    // Slice C. The transcript is a COMMAND: commandAction is what the room
    // publisher is attached to, so the owner's words appear in the room and the
    // answer comes back through the avatar's voice.
    ipcMain.handle("desk:voice-heard", async (_event, text) => {
      const said = String(text || "").trim();
      listenState = "idle";
      refreshTrayMenu();
      if (!said) return { ok: false, error: "nothing was heard" };
      debugLog("voice heard", said.slice(0, 120));
      if (voiceAsk.offer(said)) {
        void speakAloud("Got it.", undefined, undefined, "slot0", "service:awdesk-voice");
        return { ok: true, text: said, answered: true };
      }
      try {
        void speakAloud("On it, asking now.", undefined, undefined, "slot0", "service:awdesk-voice");
        const result = await commandAction(said, { source: "voice" });
        const spoken = String((result && (result.reply || (result.result && result.result.reply) || result.text || result.summary)) || "").trim();
        if (spoken) void speakAloud(spoken.slice(0, 800), undefined, undefined, "slot0", "service:awdesk-voice-answer");
        return { ok: true, text: said, result };
      } catch (error) {
        return { ok: false, text: said, error: String((error && error.message) || error) };
      }
    });
    ipcMain.on("desk:voice-listen-state", (_event, state) => {
      const next = String(state || "idle");
      const prev = listenState;
      // A failed capture ends a waiting ask with the reason. Under open mic a
      // cough is not an answer: keep waiting until the ask's own timeout.
      if (next.startsWith("error:") && !openMicOn) voiceAsk.fail(next.slice(6).trim());
      listenState = next;
      refreshTrayMenu();
      // The toggle was INVISIBLE (state only reached the tray label) -- so a
      // press looked like "nothing happened" (owner, 2026-09-22). Speak the
      // transitions and every error through the avatar so the owner always knows.
      try {
        // Open mic hears every sentence: announcing each one would talk over
        // the owner, and "nothing was heard" is just a cough the detector let through.
        if (openMicOn && (next === "listening" || next === "transcribing" || /nothing was (heard|recorded)/.test(next))) {
          return;
        }
        if (next === "listening" && prev !== "listening") {
          void speakAloud("Listening.", undefined, undefined, "slot0", "service:awdesk-voice");
        } else if (next === "transcribing") {
          void speakAloud("Got it.", undefined, undefined, "slot0", "service:awdesk-voice");
        } else if (next.startsWith("error:")) {
          void speakAloud("Voice error: " + next.slice(6).trim().slice(0, 200), undefined, undefined, "slot0", "service:awdesk-voice");
        }
      } catch { /* speech is best-effort */ }
    });
    ipcMain.handle("desk:voice-transcribe", async (_event, audioB64, format) => {
      try {
        if (typeof audioB64 !== "string" || audioB64.length === 0) {
          return "ERROR: no audio received";
        }
        const { transcribe } = require("./voice-client.cjs");
        const os = require("os");
        const path = require("path");
        const fs = require("fs");
        const isWebm = format === "webm";
        const tmp = path.join(os.tmpdir(), `desk-ptt-${Date.now()}.${isWebm ? "webm" : "wav"}`);
        fs.writeFileSync(tmp, Buffer.from(audioB64, "base64"));
        // Chromium's MediaRecorder emits webm/opus; whisper (PyAV) decodes
        // it, but 16k mono wav is the proven lane — convert when webm.
        let wav = tmp;
        if (isWebm) {
          wav = path.join(os.tmpdir(), `desk-ptt-${Date.now()}.wav`);
          // Off the event loop: execFileSync here held the main process -- IPC,
          // every window's input, the room stage -- for the whole conversion
          // (up to its 30 s timeout) on every push-to-talk.
          const { execFile } = require("child_process");
          await new Promise((resolve, reject) => {
            execFile("ffmpeg", ["-y", "-i", tmp, "-ar", "16000", "-ac", "1", wav],
              { windowsHide: true, timeout: 30000 }, (error) => (error ? reject(error) : resolve()));
          });
          fs.unlink(tmp, () => {});
        }
        // THE BRIDGE (drop-router doctrine, measured 2026-08-29): a HOST
        // temp path does not exist in the gateway — transcribe_audio reads
        // the file in ITS filesystem. Stage into the shared Library bind and
        // hand over the container path, exactly like the drop lane does.
        // Empty-capture guard (measured 2026-09-22): the recorder produced 110-byte
        // webm containers with ZERO audio frames, and whisper hallucinated "That's it."
        // from them into phantom commands. Refuse tiny audio and say WHY.
        try {
          const bytes = fs.statSync(wav).size;
          if (bytes < 2048) {
            fs.unlink(wav, () => {});
            return "ERROR: no audio captured - the microphone produced no sound. Check your input device in Windows Sound settings.";
          }
        } catch { /* stat failed: let the lanes below report */ }
        // Host STT shim first: reads the HOST wav directly (no Library-bind hop)
        // and answers the perception /voice/transcribe/base64 contract even when
        // the gateway/perception voice service is down.
        try {
          const { transcribeHostFile } = require("./voice-client.cjs");
          const shimText = await transcribeHostFile(wav);
          if (shimText && shimText.trim()) { fs.unlink(wav, () => {}); return shimText.trim(); }
        } catch { /* fall through to the gateway lane */ }
        const staged = stagePath(wav);
        let out;
        try {
          out = await transcribe(staged.container);
        } finally {
          cleanupStage(staged.host);
          fs.unlink(wav, () => {});
        }
        const text = typeof out === "string" ? out : JSON.stringify(out);
        return text;
      } catch (error) {
        return `ERROR: ${error && error.message ? error.message : String(error)}`;
      }
    });
  }

  /** The process-audio listener (lip-sync level + voice activity). Started once,
   *  in app.whenReady; a platform with no listener still reports "unavailable". */
  function startAudioListener() {
    audioListener = createAudioListener({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      onActivity: (activity) => {
        debugLog("listener activity", activity);
        handleBridgeEvent(voiceState(activity));
      },
      onDebug: debugEnabled ? (nodes) => debugLog("listener output nodes", nodes) : null,
      onLevel: (level) => handleBridgeEvent({ type: "audio-level", level }),
      onSession: (active) => {
        debugLog("listener session", active);
        handleBridgeEvent(voiceState(active ? "listening" : "idle", active ? "active" : "inactive"));
      },
      onStatus: (status) => {
        debugLog("listener status", status);
        handleListenerStatus(status);
      },
    });
    if (audioListener) void audioListener.start();
    if (!audioListener) {
      handleListenerStatus({
        available: false,
        capturing: false,
        monitoring: false,
        source: null,
      });
    }
  }

  function stopAudioListener() {
    audioListener?.stop();
  }

  return {
    voiceAsk,
    listeningNow,
    micMuted,
    talkMode,
    applyTalkMode,
    restoreOpenMicAtBoot,
    toggleListening,
    toggleMicMute,
    isOpenMic: () => openMicOn,
    getListenerStatus: () => latestListenerStatus,
    registerVoiceIpc,
    startAudioListener,
    stopAudioListener,
  };
}

module.exports = { createVoiceInput };
