"use strict";

/** Per-agent avatar assignment: Aither, Atlas, Demiurge, Lyra… each get a character,
 *  so switching who you are talking to switches who is on screen.
 *
 *  Stored in .agent-avatars.json as {agent: characterName}. Any surface that knows which
 *  agent is replying (AitherShell, adk, the MCP set_agent tool) can call this and the
 *  window follows. */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAP_FILE = path.join(ROOT, ".agent-avatars.json");

/** Agents that exist in the platform roster; the map may hold any name, these are just
 *  what the menu offers out of the box. */
const KNOWN_AGENTS = ["aither", "atlas", "demiurge", "lyra", "iris", "athena", "hydra"];

function loadMap() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveMap(map) {
  try {
    fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
    return true;
  } catch {
    return false;
  }
}

function getAgentAvatar(agent) {
  return loadMap()[String(agent).toLowerCase()] ?? null;
}

function setAgentAvatar(agent, character) {
  const map = loadMap();
  map[String(agent).toLowerCase()] = character;
  return saveMap(map);
}

function clearAgentAvatar(agent) {
  const map = loadMap();
  delete map[String(agent).toLowerCase()];
  return saveMap(map);
}

/** Agents to show in menus: the known set plus anything already assigned. */
function listAgents() {
  const assigned = Object.keys(loadMap());
  return [...new Set([...KNOWN_AGENTS, ...assigned])].sort();
}

module.exports = {
  KNOWN_AGENTS,
  clearAgentAvatar,
  getAgentAvatar,
  listAgents,
  loadMap,
  setAgentAvatar,
};
