"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const WINDOW_CLASS = "desk";

function findHyprlandClient(clients, pid) {
  return clients.find(
    (client) =>
      Number(client.pid) === Number(pid) &&
      (client.class === WINDOW_CLASS || client.initialClass === WINDOW_CLASS),
  );
}

function calculateWindowPosition(monitor, width, height, margin = 24) {
  const [reservedLeft = 0, reservedTop = 0, reservedRight = 0, reservedBottom = 0] =
    monitor.reserved || [];
  const workLeft = monitor.x + reservedLeft;
  const workTop = monitor.y + reservedTop;
  const workWidth = monitor.width - reservedLeft - reservedRight;
  const workHeight = monitor.height - reservedTop - reservedBottom;

  return {
    x: Math.round(Math.max(workLeft, workLeft + workWidth - width - margin)),
    y: Math.round(Math.max(workTop, workTop + workHeight - height - margin)),
  };
}

function buildLuaCommands(
  client,
  monitor,
  width,
  height,
  margin = 24,
  { position = null, reposition = true } = {},
) {
  const window = `address:${client.address}`;
  const targetPosition = position ?? calculateWindowPosition(monitor, width, height, margin);
  const commands = [];

  if (!client.floating) {
    commands.push(`hl.dsp.window.float({ action = "on", window = "${window}" })`);
  }
  if (client.size?.[0] !== width || client.size?.[1] !== height) {
    commands.push(
      `hl.dsp.window.resize({ x = ${width}, y = ${height}, relative = false, window = "${window}" })`,
    );
  }
  if (reposition) {
    commands.push(
      `hl.dsp.window.move({ x = ${targetPosition.x}, y = ${targetPosition.y}, relative = false, window = "${window}" })`,
    );
  }
  if (!client.pinned) {
    commands.push(`hl.dsp.window.pin({ action = "on", window = "${window}" })`);
  }
  commands.push(
    `hl.dsp.window.alter_zorder({ mode = "top", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "no_blur", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "no_shadow", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "no_dim", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "decorate", value = "0", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "border_size", value = "0", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "rounding", value = "0", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "opacity", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "opacity_inactive", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "opacity_fullscreen", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "opacity_override", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "opacity_inactive_override", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "opacity_fullscreen_override", value = "1", window = "${window}" })`,
  );

  return commands;
}

async function runHyprctlJson(command) {
  const { stdout } = await execFileAsync("hyprctl", ["-j", command], {
    timeout: 2000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function runLegacyCommands(
  client,
  monitor,
  width,
  height,
  margin,
  reposition,
  position,
) {
  const window = `address:${client.address}`;
  const targetPosition = position ?? calculateWindowPosition(monitor, width, height, margin);
  const commands = [
    ["dispatch", "setfloating", window],
    ["dispatch", "resizewindowpixel", `exact ${width} ${height},${window}`],
  ];
  if (reposition) {
    commands.push([
      "dispatch",
      "movewindowpixel",
      `exact ${targetPosition.x} ${targetPosition.y},${window}`,
    ]);
  }
  if (!client.pinned) commands.push(["dispatch", "pin", window]);
  commands.push(
    ["dispatch", "alterzorder", `top,${window}`],
    ["setprop", window, "no_blur", "1", "lock"],
    ["setprop", window, "no_shadow", "1", "lock"],
    ["setprop", window, "no_dim", "1", "lock"],
    ["setprop", window, "decorate", "0", "lock"],
    ["setprop", window, "border_size", "0", "lock"],
    ["setprop", window, "rounding", "0", "lock"],
    ["setprop", window, "opacity", "1", "lock"],
    ["setprop", window, "opacity_inactive", "1", "lock"],
    ["setprop", window, "opacity_fullscreen", "1", "lock"],
    ["setprop", window, "opacity_override", "1", "lock"],
    ["setprop", window, "opacity_inactive_override", "1", "lock"],
    ["setprop", window, "opacity_fullscreen_override", "1", "lock"],
  );
  for (const args of commands) {
    await execFileAsync("hyprctl", args, { timeout: 2000 });
  }
}

async function configureHyprlandWindow({
  pid,
  width = 430,
  height = 680,
  margin = 24,
  onDebug = null,
  position = null,
  reposition = true,
} = {}) {
  if (process.platform !== "linux") return false;

  try {
    const [clients, monitors] = await Promise.all([
      runHyprctlJson("clients"),
      runHyprctlJson("monitors"),
    ]);
    const client = findHyprlandClient(clients, pid);
    if (!client) return false;
    const monitor =
      monitors.find((candidate) => Number(candidate.id) === Number(client.monitor)) || monitors[0];
    if (!monitor) return false;

    const luaCommands = buildLuaCommands(client, monitor, width, height, margin, {
      position,
      reposition,
    });
    try {
      for (const command of luaCommands) {
        await execFileAsync("hyprctl", ["dispatch", command], { timeout: 2000 });
      }
    } catch (error) {
      onDebug?.("Lua dispatcher unavailable; trying legacy Hyprland commands", error.message);
      await runLegacyCommands(client, monitor, width, height, margin, reposition, position);
    }

    onDebug?.("Hyprland window configured", {
      address: client.address,
      pinned: true,
      floating: true,
      size: [width, height],
    });
    return true;
  } catch (error) {
    onDebug?.("Hyprland window configuration deferred", error.message);
    return false;
  }
}

async function getHyprlandWindowPlacement(pid) {
  if (process.platform !== "linux") return null;
  try {
    const client = findHyprlandClient(await runHyprctlJson("clients"), pid);
    if (!client?.at || !client?.size) return null;
    return {
      x: Number(client.at[0]),
      y: Number(client.at[1]),
      width: Number(client.size[0]),
      height: Number(client.size[1]),
    };
  } catch {
    return null;
  }
}

module.exports = {
  WINDOW_CLASS,
  buildLuaCommands,
  calculateWindowPosition,
  configureHyprlandWindow,
  findHyprlandClient,
  getHyprlandWindowPlacement,
};
