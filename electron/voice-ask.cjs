"use strict";

/**
 * voice-ask -- a session asks the owner a question OUT LOUD and gets the spoken
 * answer back (owner, 2026-09-22: "talk and interact seamlessly from anywhere ...
 * even in claude code").
 *
 * The desk could already speak for any session (the MCP `speak` tool) and hear
 * the owner (push-to-talk, open mic), but the two never met: what the owner said
 * always became a NEW command, so a Claude Code session that needed an answer
 * had no way to receive one. This is that return path. While an ask is waiting,
 * the next transcript -- from the hotkey, a click on the avatar, or open mic --
 * is the ANSWER, handed to the asker instead of being run as a command.
 *
 * One question at a time: two sessions asking at once would make "which one did
 * the owner just answer?" a guess, so the second is refused and told why.
 */

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 300000;
const AFTER_SPEECH_MS = 400;

function createVoiceAsk({
  speak,
  listen,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let pending = null;

  function finish(result) {
    if (!pending) return;
    const { resolve, timer, question } = pending;
    pending = null;
    if (timer != null) clearTimer(timer);
    resolve({ question, ...result });
  }

  async function ask(question, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const text = String(question || "").trim();
    if (!text) return { ok: false, error: "empty question" };
    if (pending) return { ok: false, error: "already waiting for the owner to answer another question" };
    const limit = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    // Claim the slot BEFORE speaking, so a second ask during the question is refused.
    let resolveFn;
    const answer = new Promise((resolve) => { resolveFn = resolve; });
    pending = { resolve: resolveFn, timer: null, question: text };
    let said;
    try {
      said = await speak(text);
    } catch (error) {
      said = { ok: false, reason: String((error && error.message) || error) };
    }
    // Listen only after the question has been heard: the mic would otherwise
    // record the avatar asking it. A failed voice still showed the caption.
    const spokenMs = said && said.ok !== false && Number(said.durationMs) > 0 ? Number(said.durationMs) : 0;
    await delay(spokenMs + AFTER_SPEECH_MS);
    if (!pending) return answer; // cancelled while the question was playing
    let armed;
    try {
      armed = listen();
    } catch (error) {
      armed = { ok: false, error: String((error && error.message) || error) };
    }
    if (armed && armed.ok === false) {
      finish({ ok: false, error: armed.error || "could not open the microphone" });
      return answer;
    }
    pending.timer = setTimer(() => finish({ ok: false, error: `no answer within ${Math.round(limit / 1000)}s` }), limit);
    return answer;
  }

  /** A transcript arrived. true = it was the answer (do not run it as a command). */
  function offer(text) {
    const said = String(text || "").trim();
    if (!pending || !said) return false;
    finish({ ok: true, answer: said });
    return true;
  }

  /** The capture failed (nothing heard, mic error): the asker hears why. */
  function fail(message) {
    if (!pending) return false;
    finish({ ok: false, error: String(message || "voice capture failed") });
    return true;
  }

  function cancel(reason = "cancelled") {
    return fail(reason);
  }

  return {
    ask,
    offer,
    fail,
    cancel,
    get waiting() {
      return pending ? pending.question : null;
    },
  };
}

module.exports = { createVoiceAsk, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
