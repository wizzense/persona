"use strict";

/**
 * roster-surface.cjs -- the character roster as the desk shows it: the tray's
 * Characters menu and its Agents submenu, switching (applyCharacter), the adult
 * gate's on-screen enforcement, the rater's full-body capture, and the deck's
 * thumbnail / marketplace IPC. Moved out of main.cjs as slice 3 of
 * docs/UX-REIMPLEMENTATION.md (main.cjs getting SMALLER); a pure move.
 *
 * Everything main-only arrives as a dep -- the avatar window through a getter,
 * because main replaces it on every recreate -- so this module loads without
 * Electron.
 */

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const marketClient = require("./market-client.cjs");
const {
  ROSTER_DIR,
  getRecentCharacters,
  enrollNewestDownloadChecked,
  getActiveCharacter,
  installCharacter,
  listCharacters,
  listAllCharacters,
} = require("./character-roster.cjs");
const { isHidden } = require("./content-rating.cjs");
const { getAgentAvatar, listAgents, setAgentAvatar } = require("./agent-avatars.cjs");
const { exportToAitherShell } = require("./aithershell-export.cjs");

function createRosterSurface({
  app,
  dialog,
  ipcMain,
  shell,
  getAvatarWindow,
  sendToAvatar,
  showOverlay,
  hideOverlay,
  refreshTrayMenu,
  openModelBrowser,
  handleBridgeEvent,
  debugLog = () => {},
} = {}) {
  /** If the gate closed while an adult character was ON SCREEN, swap it off.
   *
   *  Filtering the menus is not enough: the avatar is a persistent always-on-top
   *  window, so a character installed while the gate was open keeps rendering
   *  after it closes. Runs at startup and whenever the tray menu is rebuilt. */
  function enforceActiveCharacterRating() {
    const active = getActiveCharacter();
    if (!active || !isHidden(active)) return false;
    const replacement = listCharacters()[0];
    if (!replacement) {
      debugLog("adult gate closed and no visible character remains; hiding overlay");
      void hideOverlay();
      return true;
    }
    debugLog("adult gate closed; switching off hidden character", active);
    installCharacter(replacement);
    const avatarWindow = getAvatarWindow();
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.webContents.reloadIgnoringCache();
    }
    return true;
  }

  /** Switch to a roster character and hot-reload the renderer (no app restart). */
  function applyCharacter(name) {
    if (!installCharacter(name)) return false;
    debugLog("character switched", name);
    const avatarWindow = getAvatarWindow();
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.webContents.reloadIgnoringCache();
    }
    refreshTrayMenu();
    showOverlay();
    return true;
  }

  /** Recents on top for one-click switching, then every VISIBLE character in
   *  alphabetical groups — a flat list of 70+ filled the whole screen, so the roster
   *  lives in chunked sub-submenus instead.
   *
   *  Age-restricted characters are absent ENTIRELY while the adult-content gate
   *  is closed: listCharacters() drops them, so they are missing from Recent,
   *  from the "All characters" groups, and from the count in that label.
   *  The rating names themselves live in content-rating.cjs (ADULT_RATINGS) and
   *  are deliberately not repeated here — this file ships, and a comment that
   *  names the category announces it to anyone reading the bundle. */
  function buildCharacterMenu() {
    const active = getActiveCharacter();
    const all = listCharacters();
    const item = (name) => ({
      label: name,
      type: "radio",
      checked: name === active,
      click: () => applyCharacter(name),
    });

    const CHUNK = 14;
    const groups = [];
    for (let start = 0; start < all.length; start += CHUNK) {
      const slice = all.slice(start, start + CHUNK);
      groups.push({
        // Paged, not "first … last": two 30-character slugs as a submenu LABEL
        // wrapped the menu and read as noise. A page number is scannable.
        label: `${start + 1}–${start + slice.length} of ${all.length}`,
        submenu: slice.map(item),
      });
    }

    const recents = getRecentCharacters().map(item);
    const rosterEntries = groups.length
      ? groups
      : [
          { label: "(no characters yet)", enabled: false },
          { type: "separator" },
          { label: "Get a model from VRoid Hub…", click: openVroidHub },
        ];
    return [
      { label: "Recent", enabled: false },
      ...(recents.length ? recents : [{ label: "(none yet — pick one below)", enabled: false }]),
      { type: "separator" },
      {
        label: `All characters (${all.length})`,
        submenu: rosterEntries,
      },
      { label: "Browse with pictures…", click: openModelBrowser },
      {
        label: "Send this character to AitherShell",
        click: () => {
          const name = getActiveCharacter() || "desk";
          showOverlay();
          exportToAitherShell(getAvatarWindow(), name, handleBridgeEvent)
            .then((result) => debugLog("aithershell portrait written", result))
            .catch((error) => debugLog("aithershell export failed", error));
        },
      },
      { type: "separator" },
      { label: "Agents", submenu: buildAgentMenu() },
      { label: "Get a model from VRoid Hub…", click: openVroidHub },
      {
        label: "Enroll newest Downloads .vrm",
        click: async () => {
          // Through the safety funnel: a downloaded VRM is an outside artifact, and its
          // name becomes the roster folder, the cast binding and the guide key.
          const result = await enrollNewestDownloadChecked();
          if (result.ok) applyCharacter(result.name);
          else debugLog("enrollment refused or unavailable:", result.reason);
        },
      },
      {
        label: "Open characters folder",
        click: () => {
          fsMkdirSafe(ROSTER_DIR);
          void shell.openPath(ROSTER_DIR);
        },
      },
    ];
  }

  /** Where characters come from (owner decision, 2026-09-10: Desk ships none).
   *  One function so the tray, the About box, the first-run prompt and the
   *  deck's "+ Add" all point at the SAME front door. */
  function openVroidHub() {
    void shell.openExternal("https://hub.vroid.com/en/");
  }

  /** Renderer-supplied character names address files under the roster, so they
   *  are validated as SLUGS here: no separators, no traversal, no NUL. Every
   *  caller treats a rejected name as "no such character". */
  function isValidCharacterName(name) {
    return (
      typeof name === "string" &&
      name.length > 0 &&
      name.length <= 128 &&
      !name.includes("/") &&
      !name.includes("\\") &&
      !name.includes("\0") &&
      name !== "." &&
      name !== ".."
    );
  }

  /** Where a visible character's model file lives (the roster dir -- the mature
   *  content pack that used to be a second candidate is gone from the product,
   *  2026-09-19), as a file:// URL — the deck's preview renderer loads it.
   *  Only main knows the real roster root, so the deck never builds these. */
  /** Full-body captures for the rater (POST /roster/capture on the bridge).
   *  The avatar window renders each model offscreen (src/thumbnails.ts) and
   *  hands the JPEG back through desk:save-character-fullbody. Every installed
   *  character is offered, gate or no gate: this is the step that DECIDES the
   *  rating, so it must see the ones the gate hides. `done` is what the rater
   *  polls for; a renderer that never answers leaves a name pending. */
  const rosterCapture = { requested: new Set(), done: new Set(), startedAt: 0 };

  function captureRoster({ names = null, force = false, angles = 1 } = {}) {
    const installed = listAllCharacters();
    const wanted = Array.isArray(names) && names.length
      ? names.filter((n) => isValidCharacterName(n) && installed.includes(n))
      : installed;
    const shots = Number.isFinite(Number(angles)) ? Math.max(1, Math.min(24, Number(angles))) : 1;
    // A turntable run is judged on the turntable dir, not on fullbody.jpg -- a
    // character that already has a front shot still needs its ring.
    const todo = wanted.filter((n) => force || !fs.existsSync(
      shots > 1 ? path.join(ROSTER_DIR, n, "turntable") : path.join(ROSTER_DIR, n, "fullbody.jpg"),
    ));
    const avatarWindow = getAvatarWindow();
    if (!avatarWindow || avatarWindow.isDestroyed()) {
      return { ok: false, error: "no avatar window to render in", requested: 0, pending: todo };
    }
    rosterCapture.requested = new Set(todo);
    rosterCapture.done = new Set();
    rosterCapture.startedAt = Date.now();
    sendToAvatar("capture-roster", {
      angles: shots,
      // `customise` rides along: a FORK renders its base's mesh, so without the
      // recipe the capture would show the BASE's body and the rater would judge
      // the wrong thing -- and a fork exists precisely to look different.
      characters: todo.map((name) => ({
        name,
        modelUrl: characterModelUrl(name),
        customise: safeCustomise(name),
      })),
    });
    return { ok: true, requested: todo.length, pending: todo, skipped: wanted.length - todo.length, angles: shots };
  }

  function safeCustomise(name) {
    try {
      const recipe = require("./character-roster.cjs").customiseOf(name);
      return recipe && Object.keys(recipe).length ? recipe : null;
    } catch {
      return null;
    }
  }

  function captureRosterStatus() {
    const pending = [...rosterCapture.requested].filter((n) => !rosterCapture.done.has(n));
    return { ok: true, requested: rosterCapture.requested.size, done: rosterCapture.done.size, pending, startedAt: rosterCapture.startedAt };
  }

  function characterModelUrl(name) {
    if (!isValidCharacterName(name)) return null;
    // A fork resolves through its `base` (character-roster.resolveModelFile); an
    // ordinary character answers with its own file on the first candidate.
    let resolved;
    try {
      resolved = require("./character-roster.cjs").resolveModelFile(name);
    } catch {
      // The roster module is not loadable here; fall through to the plain path.
      resolved = null;
    }
    const candidates = [resolved, path.join(ROSTER_DIR, name, "model.vrm")].filter(Boolean);
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return pathToFileURL(candidate).href;
      } catch {
        /* an unreadable candidate is simply not this one */
      }
    }
    return null;
  }

  /** Cached preview for a character (written by the deck after it renders one). */
  function characterThumbPath(name) {
    return path.join(ROSTER_DIR, name, "thumbnail.jpg");
  }

  /** First run with an empty roster: Desk has nothing to render and — until now —
   *  said so nowhere. Asked ONCE per install (a marker file), never on every
   *  boot, and never blocking: the dialog is fire-and-forget. "Later" is a real
   *  answer; the tray keeps the same entries forever. */
  function maybePromptForFirstCharacter() {
    try {
      if (listCharacters().length > 0) return;
      const marker = path.join(app.getPath("userData"), ".first-character-prompted");
      if (fs.existsSync(marker)) return;
      fs.writeFileSync(marker, new Date().toISOString());
      void dialog
        .showMessageBox({
          type: "info",
          title: "Desk has no character yet",
          message: "Desk ships no character models — add your own",
          detail: [
            "Get a VRM from VRoid Hub (free, and the models state their own",
            "license), then drop it in or use the tray:",
            "",
            "    tray ▸ Characters ▸ Enroll newest Downloads .vrm",
            "",
            "Any VRM 1.0 file you have the rights to works. Your models stay",
            "on this machine and are never redistributed.",
          ].join("\n"),
          buttons: ["Browse VRoid Hub…", "Open characters folder", "Later"],
          defaultId: 0,
          cancelId: 2,
        })
        .then(({ response }) => {
          if (response === 0) openVroidHub();
          else if (response === 1) {
            fsMkdirSafe(ROSTER_DIR);
            void shell.openPath(ROSTER_DIR);
          }
        });
    } catch (error) {
      debugLog("first-character prompt failed", error);
    }
  }

  /** Agents ▸ <agent> ▸ [Switch to its avatar | Assign current character]. Lets you keep
   *  one character per agent (Aither, Atlas, Demiurge, Lyra…) and flip between them. */
  function buildAgentMenu() {
    const active = getActiveCharacter();
    return listAgents().map((agent) => {
      const assigned = getAgentAvatar(agent);
      return {
        label: assigned ? `${agent} — ${assigned}` : `${agent} — (unassigned)`,
        submenu: [
          {
            label: assigned ? `Switch to ${assigned}` : "Switch (assign one first)",
            enabled: Boolean(assigned),
            click: () => assigned && applyCharacter(assigned),
          },
          {
            label: active ? `Assign current: ${active}` : "Assign current character",
            enabled: Boolean(active),
            click: () => {
              if (!active) return;
              setAgentAvatar(agent, active);
              refreshTrayMenu();
              debugLog("agent avatar assigned", agent, active);
            },
          },
        ],
      };
    });
  }

  /** Switch the window to whichever character an agent owns. Returns the character or null.
   *
   * OPT-IN as of 2026-08-25 (DESK_AGENT_AVATAR_SWITCH=1 enables). Every agent
   * surface (awsh turns, the decision-card fanout, Aitheros Online, Awconnect) calls
   * set_agent as ambient telemetry, and each call re-installed that agent's
   * mapped character and RELOADED the window — so with several shells running,
   * the owner's manually chosen avatar was overwritten within seconds, over and
   * over ("keeps defaulting and changing to an avatar I don't want", measured
   * live: the unwanted character was exactly gobbonet's vrm-1-0 mapping while a
   * gobbonet companion shell was open). A window reload per agent turn is also a
   * visible seconds-long blank under GPU load, so the flips read as "the avatar
   * keeps breaking". The owner's explicit pick must never lose to telemetry;
   * per the AC001 rule the gate ships WITH its control (the env var), and the
   * refusal is logged so a silent no-op cannot be misread as a broken mapping.
   */
  function applyAgentAvatar(agent) {
    if (process.env.DESK_AGENT_AVATAR_SWITCH !== "1") {
      debugLog("agent avatar switch suppressed (opt-in; DESK_AGENT_AVATAR_SWITCH!=1)", agent);
      return null;
    }
    const character = getAgentAvatar(agent);
    if (!character) return null;
    return applyCharacter(character) ? character : null;
  }

  function fsMkdirSafe(dir) {
    try {
      require("node:fs").mkdirSync(dir, { recursive: true });
    } catch {
      /* the open below will surface any real problem */
    }
  }

  /** Ask the LIVE safety plane whether explicit content is permitted and hand
   *  the verdict to content-rating (its limit 2 -- tightening only; see that
   *  file's three-limits note). Fire-and-forget on the tray refresh: a slow or
   *  dead fleet must never hold up a menu, and a plane that does not answer
   *  leaves the verdict untouched. */
  function refreshSafetyPosture() {
    try {
      const { explicitAllowed } = require("./safety-gate.cjs");
      const { setSafetyExplicitAllowed } = require("./content-rating.cjs");
      void explicitAllowed()
        .then((verdict) => {
          if (verdict !== null) setSafetyExplicitAllowed(verdict);
        })
        .catch(() => {});
    } catch (error) {
      debugLog("safety posture refresh failed", error?.message || error);
    }
  }

  function registerIpc() {
    // One-stop-shop data: the Aitherium marketplace via market-client.cjs
    // (MCP to the local gateway, session bearer — same story as relay).
    ipcMain.handle("desk:market-browse", (_event, query) =>
      marketClient.browse(typeof query === "string" ? query : "", "", 24));
    // Avatar previews (owner, 2026-09-10: "let it give real previews"): the
    // deck asks for a character's cached preview and hands back one it just
    // rendered offscreen. Names are slug-validated — the renderer never names
    // a path. A thumb read/write failure is never fatal: the card falls back
    // to its monogram tile.
    ipcMain.handle("desk:character-thumb", (_event, name) => {
      if (!isValidCharacterName(name)) return null;
      try {
        const file = characterThumbPath(name);
        if (!fs.existsSync(file)) return null;
        return `data:image/jpeg;base64,${fs.readFileSync(file).toString("base64")}`;
      } catch {
        return null;
      }
    });
    // The rater's full-body frame (rate-characters.py --vision reads
    // fullbody.jpg before thumbnail.jpg). Same validation as the thumbnail.
    ipcMain.handle("desk:save-character-turntable", (_event, name, shot, dataUrl) => {
      if (!isValidCharacterName(name)) return false;
      const index = Number(shot);
      if (!Number.isInteger(index) || index < 0 || index > 23) return false;
      const prefix = "data:image/jpeg;base64,";
      if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) return false;
      const base64 = dataUrl.slice(prefix.length);
      if (base64.length === 0 || base64.length > 2 * 1024 * 1024) return false;
      try {
        const dir = path.join(ROSTER_DIR, name, "turntable");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${String(index).padStart(2, "0")}.jpg`), Buffer.from(base64, "base64"));
        return true;
      } catch (error) {
        debugLog("turntable write failed", name, index, error);
        return false;
      }
    });
    ipcMain.handle("desk:save-character-fullbody", (_event, name, dataUrl) => {
      if (!isValidCharacterName(name)) return false;
      const prefix = "data:image/jpeg;base64,";
      if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) return false;
      const base64 = dataUrl.slice(prefix.length);
      if (base64.length === 0 || base64.length > 2 * 1024 * 1024) return false;
      try {
        fs.writeFileSync(path.join(ROSTER_DIR, name, "fullbody.jpg"), Buffer.from(base64, "base64"));
        rosterCapture.done.add(name);
        return true;
      } catch (error) {
        debugLog("fullbody write failed", name, error);
        return false;
      }
    });
    ipcMain.handle("desk:save-character-thumb", (_event, name, dataUrl) => {
      if (!isValidCharacterName(name)) return false;
      const prefix = "data:image/jpeg;base64,";
      if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) return false;
      const base64 = dataUrl.slice(prefix.length);
      // A 256x256 JPEG of a face is ~10-30 KB; 2 MB is a generous ceiling that
      // still refuses a renderer bug trying to write a model file here.
      if (base64.length === 0 || base64.length > 2 * 1024 * 1024) return false;
      try {
        fs.writeFileSync(characterThumbPath(name), Buffer.from(base64, "base64"));
        return true;
      } catch (error) {
        debugLog("thumbnail write failed", name, error);
        return false;
      }
    });
  }
  return {
    enforceActiveCharacterRating,
    applyCharacter,
    buildCharacterMenu,
    buildAgentMenu,
    openVroidHub,
    isValidCharacterName,
    captureRoster,
    captureRosterStatus,
    characterModelUrl,
    maybePromptForFirstCharacter,
    applyAgentAvatar,
    fsMkdirSafe,
    refreshSafetyPosture,
    registerIpc,
  };
}

module.exports = { createRosterSurface };
