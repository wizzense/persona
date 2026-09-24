"use strict";

/**
 * hotkeys-settings.cjs -- the global shortcuts and the ONE settings surface
 * (voice input, hotkeys, account link, bricks updates). Moved out of main.cjs as
 * slice 3 of docs/UX-REIMPLEMENTATION.md (main.cjs getting SMALLER); a pure move,
 * no IPC channel renamed.
 *
 * deadAccels is OWNED here and handed back as the same Set: main's
 * commandContext and jump list read it, and applyHotkeys clears and refills it
 * in place, so every reader sees one list. Whether the owner is mid-press comes
 * through isListening() -- main's listen state changes under us. cast-config,
 * link-client and bricks-client stay lazy requires, as they were in main.
 * Loads without Electron.
 */

function createHotkeysSettings({
  ipcMain,
  globalShortcut,
  shell,
  commandRegistry,
  runCommand,
  refreshTrayMenu = () => {},
  isListening = () => false,
  applyTalkMode = () => {},
  speakAloud = async () => {},
} = {}) {
  /** Shortcuts another app holds: a menu must not advertise them. */
  const deadAccels = new Set();

  // Plan: configurable hotkeys (owner 2026-09-22). Overrides live in cast.json's
  // hotkeys{} (id -> accel string); reading it here, not at import time, means a
  // Settings change takes effect on the NEXT applyHotkeys() call, no restart.
  function loadHotkeyOverrides() {
    try {
      const { load, resolveHotkeys } = require("./cast-config.cjs");
      return resolveHotkeys(load().snapshot);
    } catch {
      return {}; // unreadable cast.json -> every command keeps its DEFAULT accel
    }
  }

  // Re-registers every global shortcut from the registry + current overrides.
  // NEVER call this while listening: unregisterAll() drops every key for a few
  // ms, including the one the owner is mid-press on, and a conflict probe could
  // steal a key another app is legitimately holding (design risk, verified
  // 2026-09-22).
  function applyHotkeys() {
    if (isListening()) return { ok: false, reason: "listening" };
    globalShortcut.unregisterAll();
    deadAccels.clear();
    for (const { id, accel, electron: key } of commandRegistry.shortcuts(loadHotkeyOverrides())) {
      if (!globalShortcut.register(key, () => runCommand(id, undefined, { surface: "shortcut" }))) {
        deadAccels.add(accel);
        console.warn(`[desk] shortcut ${key} is held by another app -- use the tray menu`);
      }
    }
    if (deadAccels.size) refreshTrayMenu();
    return { ok: true, dead: [...deadAccels] };
  }

  /** Registered once, from app.whenReady, where main registered them before. */
  function registerSettingsIpc() {
    // Plan: configurable voice input + hotkeys, ONE settings surface.
    ipcMain.handle("desk:settings-get", () => {
      try {
        const cc = require("./cast-config.cjs");
        const { snapshot } = cc.load();
        const voice = cc.resolveVoice ? cc.resolveVoice(snapshot) : null;
        const input = cc.resolveInput(snapshot);
        const overrides = cc.resolveHotkeys(snapshot);
        const ctx = { listening: isListening(), micMuted: input.micMuted };
        const hotkeys = commandRegistry.shortcuts(overrides).map((k) => {
          const command = commandRegistry.byId(k.id);
          const label = command ? commandRegistry.labelOf(command, ctx) : k.id;
          return { ...k, label, dead: deadAccels.has(k.accel) };
        });
        return { ok: true, voice, input, hotkeys, deadAccels: [...deadAccels] };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    });
    ipcMain.handle("desk:settings-set-input", (_event, patch) => {
      try {
        const { write } = require("./cast-config.cjs");
        const clean = patch && typeof patch === "object" ? patch : {};
        const result = write((draft) => {
          draft.input = { ...(draft.input || {}), ...clean };
        });
        if (result.ok) {
          // Only a talk-mode or mute change moves the open mic: picking a new
          // device must not re-open a mic the owner just switched off.
          if ("talkMode" in clean || "micMuted" in clean) applyTalkMode({ announce: true });
          refreshTrayMenu();
        }
        return result;
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    });
    // Probe: is this accel free? Never commits. Collision against OUR OWN
    // registry is checked first (pure data, zero risk); an OS-level probe only
    // runs for a key nothing in the registry already claims.
    ipcMain.handle("desk:settings-probe-accel", (_event, accel, excludeId) => {
      try {
        const candidate = String(accel || "").trim();
        if (!candidate) return { ok: false, reason: "empty" };
        const overrides = loadHotkeyOverrides();
        const holder = commandRegistry.shortcuts(overrides).find(
          (k) => k.accel === candidate && k.id !== excludeId,
        );
        if (holder) return { ok: false, reason: `used by "${holder.id}" in this app` };
        if (isListening()) return { ok: false, reason: "cannot probe while listening" };
        const key = commandRegistry.electronAccel(candidate);
        const got = globalShortcut.register(key, () => {});
        if (got) globalShortcut.unregister(key);
        return got ? { ok: true } : { ok: false, reason: "held by another application" };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    });
    ipcMain.handle("desk:settings-set-hotkey", (_event, id, accel) => {
      try {
        const clean = String(accel || "").trim();
        const { write } = require("./cast-config.cjs");
        const result = write((draft) => {
          draft.hotkeys = { ...(draft.hotkeys || {}) };
          if (clean) draft.hotkeys[id] = clean;
          else delete draft.hotkeys[id];
        });
        if (result.ok) {
          const applied = applyHotkeys();
          return { ...result, applied };
        }
        return result;
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    });
    // Plan: Aither World bricks -- the Updates section of Settings. adk bricks
    // (awdk) owns every decision; the desk only runs it (bricks-client.cjs).
    // Account: link this machine to aitherium.com through `adk link` (awdk owns
    // the device grant, the shared sign-in and the role-aware bundle).
    ipcMain.handle("desk:link-status", async () => require("./link-client.cjs").linkStatus());
    ipcMain.handle("desk:link-start", async () => {
      const res = await require("./link-client.cjs").linkStart();
      const url = res.ok && res.data && res.data.approve_url;
      // Only an https link from Identity is opened; anything else is shown, not followed.
      if (typeof url === "string" && /^https:\/\//.test(url)) void shell.openExternal(url);
      return res;
    });
    ipcMain.handle("desk:link-poll", async (_event, deviceCode) => {
      const res = await require("./link-client.cjs").linkPoll(String(deviceCode || ""));
      const d = res.data || {};
      if (d.status === "complete") {
        const who = d.username || "you";
        const said = d.role === "owner" ? `Linked. Welcome back, ${who}.` : `Linked as ${who}.`;
        try { void speakAloud(said, undefined, undefined, "slot0", "service:awdesk-voice"); } catch { /* best-effort */ }
      }
      return res;
    });
    ipcMain.handle("desk:bricks-list", async () => {
      const { listBricks } = require("./bricks-client.cjs");
      return listBricks();
    });
    ipcMain.handle("desk:bricks-act", async (_event, verb, name) => {
      const { actOnBrick } = require("./bricks-client.cjs");
      const res = await actOnBrick(String(verb || ""), String(name || ""));
      if (verb === "upgrade" || verb === "rollback") {
        const d = res.data || {};
        const said = res.ok
          ? `${d.id || name} is now ${d.to || "updated"}.`
          : (d.rolled_back ? `${d.id || name} failed its test and was rolled back.` : `${name}: ${res.error}`);
        try { void speakAloud(said, undefined, undefined, "slot0", "service:awdesk-voice"); } catch { /* best-effort */ }
      }
      return res;
    });
    ipcMain.handle("desk:settings-list-mic-devices", async () => {
      // Devices are enumerated in the RENDERER (Web API, needs a getUserMedia
      // grant for labels) -- this handler exists only so a non-React pane
      // (settings.html, no App.tsx) can request the SAME permission grant this
      // process already hands out via setPermissionRequestHandler.
      return { ok: true, note: "enumerate via navigator.mediaDevices in the renderer" };
    });
  }

  return { deadAccels, loadHotkeyOverrides, applyHotkeys, registerSettingsIpc };
}

module.exports = { createHotkeysSettings };
