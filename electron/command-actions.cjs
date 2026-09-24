"use strict";

/**
 * command-actions.cjs -- the runners behind registry verbs that DO something off
 * the avatar: fleet/ARC rows (runFleetCommand -> fleetAction), blog rows
 * (runBlogMenuCommand), the one command-agent entry (commandAction), and About.
 * Moved out of main.cjs as slice 3 of docs/UX-REIMPLEMENTATION.md (main.cjs
 * getting SMALLER); a pure move. runCommand stays in main: command-registry.test
 * reads its body for the `runFleetCommand` / `runBlogMenuCommand(command, arg`
 * routes.
 *
 * Everything main-only arrives as a dep. The tray is REPLACED by main, so it comes
 * through a getter; a verdict never lands on a stale tray. Loads without Electron.
 */

// The registry's `blog` records: gateway blog_* MCP tools via gateway-mcp.cjs.
// Machine paths create DRAFTS; `blog.publish` opens the Veil editor for a human
// (owner ruling 2026-09-19, .claude/rules/blog-voice.md).
const { runBlogCommand } = require("./blog-commands.cjs");

function createCommandActions({
  app,
  dialog,
  shell,
  commandRegistry,
  getTray = () => null,
  createFleetWindow,
  getFleetControl,
  fleetSummaryCached,
  createCommandWindow,
  getCommandAgent,
} = {}) {
  /** A menu row that changes the fleet: destructive verbs confirm first (a tray
   *  menu has no second click to arm), every verb raises the Fleet window so the
   *  outcome is SEEN, and the verdict lands in the tray tooltip. */
  async function runFleetCommand(command) {
    const verb = command.fleet;
    if (command.destructive) {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Cancel", commandRegistry.labelOf(command)],
        defaultId: 0,
        cancelId: 0,
        message: commandRegistry.labelOf(command),
        detail: verb === "arc-stop"
          ? "Stops the ARC solver. The world model stays up; training pauses until ARC is started again."
          : "Stops the GPU models and routine runners. The rest of the fleet stays up.",
      });
      if (response !== 1) return;
    }
    const verdict = await fleetAction(verb, { fresh: verb === "arc-status" });
    if (verb.startsWith("arc-")) {
      const wm = verdict.world_model || {};
      const unitState = verdict.units && verdict.units["aither-arcsolver"];
      const summary = verdict.cannotJudge
        ? `ARC: could not look (${verdict.error || "no answer"})`
        : `ARC: ${verdict.verdict || (verdict.ok ? "OK" : "DEGRADED")}`
          + (unitState ? ` · solver ${typeof unitState === "string" ? unitState : (unitState.active || unitState.state || "?")}` : "")
          + (wm.train_steps != null ? ` · steps ${wm.train_steps}` : "")
          + ((verdict.problems || []).length ? ` · ${verdict.problems.join("; ")}` : "");
      console.log(`[desk] ${verb}: ${summary}`);
      getTray()?.setToolTip(summary);
      if (verb === "arc-status" && !command.destructive) {
        void dialog.showMessageBox({ type: verdict.ok ? "info" : "warning", message: summary,
          detail: (verdict.problems || []).join("\n") || undefined });
      }
    }
    return verdict;
  }

  /** A blog record from a menu or the palette. The verdict goes back to the
   *  caller; a tray click (nothing awaits it) gets a dialog instead. Nothing here
   *  publishes -- see blog-commands.cjs. */
  async function runBlogMenuCommand(command, arg, { surface = "menu" } = {}) {
    const verdict = await runBlogCommand(command, arg, {
      openExternal: (url) => shell.openExternal(url),
    });
    console.log(`[desk] ${command.id}: ${verdict.message}`);
    if (surface !== "palette") {
      void dialog.showMessageBox({
        type: verdict.ok ? "info" : "warning",
        title: commandRegistry.labelOf(command),
        message: verdict.message || (verdict.ok ? "Done" : "Failed"),
      });
    }
    return verdict;
  }

  /** ONE entry point for every fleet surface (window buttons, tray, bridge
   *  /fleet/*, MCP fleet_control, `game`): the verb lands on the single
   *  FleetControl so nothing can race a second mask/unmask pass. */
  async function fleetAction(action, { fresh = false } = {}) {
    const control = getFleetControl();
    if (action === "open_panel" || action === "open") {
      createFleetWindow();
      return { ok: true, opened: true, summary: fleetSummaryCached() };
    }
    if (action === "status") {
      const verdict = await control.status(fresh ? { maxAgeMs: 0 } : {});
      return { ...verdict, summary: fleetSummaryCached() };
    }
    if (!Object.prototype.hasOwnProperty.call(require("./fleet-control.cjs").ACTIONS, action)) {
      return { ok: false, unknown: true, error: `unknown fleet action "${action}"` };
    }
    // Raise the window so the owner SEES a fleet-changing action an agent started.
    if (action !== "status") createFleetWindow();
    return control.run(action);
  }

  /** ONE entry point for every command surface (window, bridge, MCP): the request
   *  lands on the single CommandAgent so history and queue are consistent. */
  async function commandAction(text, { source = "unknown" } = {}) {
    createCommandWindow(getFleetControl(), { createFleetWindow });
    const agentInstance = getCommandAgent(getFleetControl());
    return agentInstance.run(text, { source });
  }

  function showAboutDesk() {
    // No bundled character since 2026-09-10 (owner decision): the About surface
    // says where a model comes from instead of crediting one, and points at a real
    // window rather than restating a license.
    void dialog
      .showMessageBox({
        type: "info",
        title: "About Desk",
        message: `Desk ${app.getVersion()}`,
        detail: [
          "The AitherOS desktop hub — avatar presence, decision cards, model & agent browsing, relay.",
          "",
          "Desk ships no character models. Add your own — VRoid Hub is the guided path;",
          "any VRM 1.0 file you have the rights to works. Your models stay on this machine.",
          "Full asset policy: ASSET_LICENSES.md.",
        ].join("\n"),
        buttons: ["Browse VRoid Hub…", "Close"],
        defaultId: 1,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          void shell.openExternal("https://hub.vroid.com/en/");
        }
      });
  }

  return { runFleetCommand, runBlogMenuCommand, fleetAction, commandAction, showAboutDesk };
}

module.exports = { createCommandActions };
