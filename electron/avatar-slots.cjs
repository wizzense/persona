"use strict";

/**
 * avatar-slots.cjs -- the extra bodies on the desk's stage (every slot but the
 * resident "slot0"): the slot map itself, spawn / remove / detach, the next free
 * slot id, the Stage pane's view of them, which room actor sits behind a slot,
 * the deck's "spawn-agent" verb and the get-snapshot replay after a reload.
 *
 * Moved out of main.cjs in slice 3 of docs/UX-REIMPLEMENTATION.md (main.cjs getting
 * SMALLER). Pure move: same refusals, same events, same log lines. Everything
 * main-only arrives as a dep; the avatar window is replaced over the desk's life,
 * so it is a getter read at call time, never a captured reference. Electron is
 * never required here, so the module loads in a plain `node`.
 *
 * `avatarSlots` is returned as the SAME Map main used to own: the deck state, the
 * avatar menu and the command context read it directly, so there is still one
 * list of bodies and no copy to drift.
 */

// cast-config (U01): the one file everything above it defers to. Required
// directly here (not only through room-stage-host) for stableCharacter --
// see the deleted fallbackCharacterForAgent's replacement in spawnAgent()
// below, "so Add-Avatar and the room agree on what an agent looks like".
const cast = require("./cast-config.cjs");

function createAvatarSlots({
  getAvatarWindow,
  showOverlay,
  sendToAvatar,
  sendDeckState,
  roomStageHost,
  roomStageDeps,
  planSlotInstall,
  queueInstall,
  openDetachedAvatar,
  getActiveCharacter,
  listCharacters,
  getAgentAvatar,
  debugLog = () => {},
} = {}) {
  const avatarSlots = new Map(); // Map<slotId, { name, modelUrl }> — tracks spawned slots (not slot 0)

  /** Add a spawned avatar slot to the scene WITHOUT reloading. Slot "slot0" and
   *  variants of the default slot ID are reserved and refused. `agent`, when given,
   *  records which roster agent this slot represents (for the Remove Avatar label and
   *  future dialogue/arbitration routing) — it does not change which character renders.
   *  `place` (U28), when given, is cast.json's resolved {position,scale,yaw} for
   *  this actor (see stagePlacement.ts's authoredTransform, U09) — sent as ONE
   *  place-avatar event right after spawn, never a reload. `physics`, likewise,
   *  is the resolved cast.json physics block for this actor -- one tune-avatar
   *  event behind the spawn, so the body's first frame already has the owner's
   *  knobs (room-stage-host.replayPhysics covers a renderer that mounts later). */
  function spawnAvatarSlot(slotId, name, agent, place, physics) {
    // Refuse slot IDs reserved for the default avatar
    if (slotId === "slot0" || slotId === "default" || slotId === "") return false;

    // The refusal is synchronous (hidden / no such model); the BYTES move off the
    // event loop, and the renderer hears about the body only once its file exists.
    const plan = planSlotInstall(name, slotId);
    if (!plan) return false;
    const modelUrl = plan.url;

    avatarSlots.set(slotId, { name, modelUrl, agent: agent || null });
    debugLog("avatar slot spawned", slotId, name, agent ? `(agent: ${agent})` : "");
    showOverlay();
    sendDeckState();
    queueInstall(plan.copies).then(
      () => {
        // Removed (or re-spawned as someone else) while the copy ran: say nothing.
        if (avatarSlots.get(slotId)?.modelUrl !== modelUrl || avatarSlots.get(slotId)?.name !== name) return;
        const avatarWindow = getAvatarWindow();
        if (avatarWindow && !avatarWindow.isDestroyed()) {
          avatarWindow.webContents.send("desk:event", { type: "spawn-avatar", slotId, modelUrl });
          if (place && typeof place === "object") {
            avatarWindow.webContents.send("desk:event", {
              type: "place-avatar", slotId, position: place.position, scale: place.scale, yaw: place.yaw,
            });
          }
          // A spawn with no resolution of its own (tray, MCP spawn_avatar) still
          // gets the owner's knobs: `actors["desk:<slotId>"]` / `authors.<agent>`
          // / `defaults.physics`, resolved by the host.
          let knobs = physics && typeof physics === "object" ? physics : null;
          if (!knobs) {
            try {
              knobs = roomStageHost.physicsForBody(roomStageDeps(), { slotId, agent: agent || "" });
            } catch (error) {
              debugLog("physicsForBody failed", slotId, error?.message || error);
            }
          }
          if (knobs) avatarWindow.webContents.send("desk:event", { type: "tune-avatar", slotId, physics: knobs });
          // A FORKED character renders its base's mesh plus a recipe; send it with
          // the body so the first frame is already the variant, not the base.
          try {
            const customise = require("./character-roster.cjs").customiseOf(name);
            if (customise && Object.keys(customise).length) {
              avatarWindow.webContents.send("desk:event", { type: "customise-avatar", slotId, customise });
            }
          } catch (error) {
            debugLog("customiseOf failed", name, error?.message || error);
          }
        }
      },
      (error) => {
        debugLog("avatar slot install failed", slotId, name, error?.message || error);
        if (avatarSlots.get(slotId)?.name === name) avatarSlots.delete(slotId);
        sendDeckState();
      },
    );
    return true;
  }

  /** Remove a spawned avatar slot from the scene. Cannot remove slot0 (the default). */
  function removeAvatarSlot(slotId) {
    // Refuse removal of slot0/default
    if (slotId === "slot0" || slotId === "default" || slotId === "") return false;

    if (!avatarSlots.has(slotId)) return false;

    avatarSlots.delete(slotId);
    // U07's own bookkeeping (slots/lastSeen/lastVoiced) for this slot, so a
    // hand-removed body does not linger as a ghost the idle sweep -- or a
    // later resolve()'s `taken` set -- still believes is on stage. False (not
    // a throw) when no room stage is running; a harmless no-op either way.
    roomStageHost.evictSlot(slotId);
    debugLog("avatar slot removed", slotId);
    const avatarWindow = getAvatarWindow();
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.webContents.send("desk:event", {
        type: "remove-avatar",
        slotId,
      });
    }
    sendDeckState();
    return true;
  }

  /** First "slotN" not already in avatarSlots — spawn_avatar/remove_avatar were MCP-only
   *  (an agent had to name a slot id itself); the menu needs to pick one for the owner. */
  function nextFreeSlotId() {
    for (let n = 1; n < 1000; n += 1) {
      const candidate = `slot${n}`;
      if (!avatarSlots.has(candidate)) return candidate;
    }
    return `slot${Date.now()}`; // pathological case, still a valid unique id
  }

  /** "Detach to own window" — pull one extra avatar out of the shared canvas into its own
   *  real, separately-draggable/resizable OS window. See detached-avatar-window.cjs. */
  function detachAvatarToOwnWindow(slotId) {
    const info = avatarSlots.get(slotId);
    if (!info) return false;
    removeAvatarSlot(slotId);
    openDetachedAvatar(slotId, info.modelUrl, info.agent || info.name, {
      onMergeBack: () => spawnAvatarSlot(nextFreeSlotId(), info.name, info.agent),
    });
    return true;
  }

  /**
   * What the Stage pane needs, and nothing more (Plan 40 slice G).
   *
   * `bodies` is the SAME list the deck and the avatar menus read (`avatarSlots`
   * plus the resident), so the pane cannot show a stage that disagrees with the
   * one the owner is looking at. Everything else is a name forwarded to the
   * renderer, which owns the geometry.
   */
  function stagePaneImpl() {
    return {
      bodies: () => [
        { slotId: "slot0", name: getActiveCharacter() || "Aither", agent: "aither", resident: true },
        ...[...avatarSlots.entries()].map(([slotId, info]) => ({
          slotId,
          name: info.name,
          agent: info.agent || "",
          resident: false,
        })),
      ],
      arrange: (arrangement, options = {}) => {
        sendToAvatar("stage-arrange", {
          arrangement,
          slotId: options.slotId || null,
          pair: Array.isArray(options.pair) ? options.pair : [],
        });
      },
      safety: () => {
        const { isAdultContentVisible, noteGateState } = require("./content-rating.cjs");
        noteGateState();
        return { mature: isAdultContentVisible() ? "allowed" : "hidden" };
      },
      focus: (slotId) => sendToAvatar("focus-avatar", { slotId: slotId || null }),
      remove: (slotId) => {
        if (!removeAvatarSlot(slotId)) throw new Error(`${slotId} is not a removable body`);
      },
    };
  }

  /** Which room actor (if any) is behind a stage slot, for the avatar menu's
   *  "Message this session…" item. Derived from room-stage-host's own status()
   *  (U02's onStage rows carry actorId/actorKind) rather than a second piece of
   *  bookkeeping -- room-stage-host.cjs is not this unit's file, so this reads
   *  its PUBLIC status() the same way the deck and the bridge already do. null
   *  when the slot is not a room actor (or no room stage is running). */
  function addressForSlot(slotId) {
    const st = roomStageHost.status();
    const row = st && Array.isArray(st.onStage) ? st.onStage.find((r) => r.slotId === slotId) : null;
    return row && row.actorId ? { actorId: row.actorId, actorKind: row.actorKind || "" } : null;
  }

  /** The deck's "spawn-agent" verb: seat an AGENT's body in the next free slot. */
  function spawnAgent(arg) {
    if (typeof arg !== "string" || arg.length === 0) return false;
    // U28: DELETED fallbackCharacterForAgent's own ad hoc hash in favour
    // of cast-config's stableCharacter -- the SAME hash room-stage-host
    // uses to seat an agent that arrives with no assignment, "so
    // Add-Avatar and the room agree on what an agent looks like".
    const { filterCharacters } = require("./content-rating.cjs");
    const roster = filterCharacters(listCharacters());
    const assigned = getAgentAvatar(arg);
    const taken = [...avatarSlots.values()].map((info) => info.name).filter(Boolean);
    const resident = getActiveCharacter() || null;
    const character = assigned || cast.stableCharacter(arg, roster, { taken, resident });
    if (!character) return false;
    return spawnAvatarSlot(nextFreeSlotId(), character, arg);
  }

  /** Re-send every spawned slot to a renderer that just (re)mounted. Spawned avatar
   *  slots live only in this process's memory; the get-snapshot handler calls this
   *  once the avatar window is known to be alive (see its own no-race note). */
  function replaySlots() {
    const avatarWindow = getAvatarWindow();
    for (const [slotId, info] of avatarSlots) {
      avatarWindow.webContents.send("desk:event", {
        type: "spawn-avatar",
        slotId,
        modelUrl: info.modelUrl,
      });
    }
    if (avatarSlots.size > 0) debugLog("replayed avatar slots", avatarSlots.size);
  }

  return {
    avatarSlots,
    spawnAvatarSlot,
    removeAvatarSlot,
    nextFreeSlotId,
    detachAvatarToOwnWindow,
    stagePaneImpl,
    addressForSlot,
    spawnAgent,
    replaySlots,
  };
}

module.exports = { createAvatarSlots };
