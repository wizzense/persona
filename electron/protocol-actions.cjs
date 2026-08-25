"use strict";

function voiceState(activity, phase = "active") {
  return {
    type: "state",
    state: {
      activity,
      microphoneMuted: false,
      outputMuted: false,
      phase,
    },
  };
}

function parseProtocolUrl(rawUrl, protocolScheme = "desk") {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== `${protocolScheme}:`) return null;
    const action = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
    if (action === "show" || action === "hide" || action === "toggle") {
      return [{ type: action }];
    }
    if (action === "listening") {
      return [{ type: "event", event: voiceState("listening") }];
    }
    if (action === "speaking") {
      const commands = [{ type: "event", event: voiceState("speaking") }];
      const level = Number(url.searchParams.get("level"));
      if (Number.isFinite(level)) {
        commands.push({
          type: "event",
          event: { type: "audio-level", level: Math.max(0, Math.min(1, level)) },
        });
      }
      return commands;
    }
    if (action === "thinking") {
      return [{ type: "event", event: voiceState("idle") }];
    }
    if (action === "inactive" || action === "stop") {
      return [{ type: "event", event: voiceState("idle", "inactive") }];
    }
    const animation = {
      idle: "IDLE",
      greeting: "GREETING",
      happy: "HAPPY",
      "finger-gun": "FINGER_GUN",
      dance: "DANCE",
    }[action];
    if (animation) {
      return [
        {
          type: "event",
          event: { type: "animation", animation },
        },
      ];
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = { parseProtocolUrl, voiceState };
