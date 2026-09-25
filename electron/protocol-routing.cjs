"use strict";

/**
 * protocol-routing.cjs -- how the desk is reached from OUTSIDE its own windows:
 * a desk:// URL (scripts, other apps, the Start-menu links, macOS open-url) and
 * the argv a second launch hands the running instance (--open-deck, --fleet,
 * --console, a jump-list `--run=<id>`, --command, --overlay, --desktop).
 *
 * Moved out of main.cjs in slice 3 of docs/UX-REIMPLEMENTATION.md. Pure move: the
 * verbs, the flag order and the quiet gate are what main.cjs had. Main keeps the
 * single-instance lock and the app.on(...) registrations (the composition root);
 * this module only decides what a URL or an argv means. Everything main-only
 * arrives as a dep, so the module loads in a plain `node`.
 *
 * quiet-mode.test.cjs reads THIS file for handleProtocolUrl's quietMode check.
 */

const { parseProtocolUrl } = require("./protocol-actions.cjs");

function createProtocolRouting({
  protocolScheme = "desk",
  quietMode,
  holdWhileQuiet,
  showOverlay,
  hideOverlay,
  toggleOverlay,
  createFleetWindow,
  createCommandWindow,
  getFleetControl,
  createDeckWindow,
  openConsole,
  showLivingDesktop,
  showDesktopApp,
  handleBridgeEvent,
  commandRegistry,
  runCommand,
} = {}) {
  function handleProtocolUrl(rawUrl) {
    const commands = parseProtocolUrl(rawUrl, protocolScheme);
    if (!commands) return false;
    // desk:// is how scripts and other apps reach the desk. While a game is
    // full-screen nothing they send may open or focus a window; hide and bare
    // events still pass (neither can cover the game).
    if (quietMode.isQuiet()) {
      for (const command of commands) {
        if (command.type === "hide") void hideOverlay();
        else if (command.type === "event") handleBridgeEvent(command.event);
        else if (command.type === "console") holdWhileQuiet();
      }
      return true;
    }
    for (const command of commands) {
      if (command.type === "show") showOverlay({ focus: true });
      else if (command.type === "hide") void hideOverlay();
      else if (command.type === "toggle") toggleOverlay();
      else if (command.type === "fleet") createFleetWindow();
      else if (command.type === "command") createCommandWindow(getFleetControl(), { createFleetWindow });
      else if (command.type === "console") openConsole();
      else if (command.type === "overlay") showLivingDesktop();
      else if (command.type === "desktop") showDesktopApp();
      else if (command.type === "event") handleBridgeEvent(command.event);
    }
    return true;
  }

  function handleProtocolArgv(argv) {
    const protocolUrl = argv.find((value) => value.startsWith(`${protocolScheme}://`));
    if (protocolUrl) handleProtocolUrl(protocolUrl);
  }

  /** app.on("second-instance"): a second launch never opens a second desk; its
   *  argv is routed to the running one. The first matching flag wins; a bare
   *  relaunch shows the overlay unless it carried a desk:// URL or --background. */
  function handleSecondInstance(argv) {
    const handled = argv.some((value) => value.startsWith(`${protocolScheme}://`));
    handleProtocolArgv(argv);
    if (argv.includes("--open-deck")) {
      createDeckWindow();
      return;
    }
    if (argv.includes("--fleet")) {
      createFleetWindow();
      return;
    }
    if (argv.includes("--console")) {
      openConsole();
      return;
    }
    // A Windows jump-list task (right-click the taskbar icon): `--run=<command id>`.
    const asked = argv.find((part) => part.startsWith("--run="));
    if (asked) {
      const id = asked.slice("--run=".length);
      if (commandRegistry.byId(id)) runCommand(id, undefined, { surface: "jumplist" });
      return;
    }
    if (argv.includes("--command")) {
      createCommandWindow(getFleetControl(), { createFleetWindow });
      return;
    }
    if (argv.includes("--overlay")) {
      showLivingDesktop();
      return;
    }
    if (argv.includes("--desktop")) {
      showDesktopApp();
      return;
    }
    if (!handled && !argv.includes("--background")) showOverlay({ focus: !quietMode.isQuiet() });
  }

  return { handleProtocolUrl, handleProtocolArgv, handleSecondInstance };
}

module.exports = { createProtocolRouting };
