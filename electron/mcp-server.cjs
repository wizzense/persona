"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const z = require("zod/v4");
const { version } = require("../package.json");

const MCP_PATH = "/mcp";
const ANIMATION_EVENT_NAMES = {
  idle: "IDLE",
  greeting: "GREETING",
  talk: "TALK",
  happy: "HAPPY",
  "finger-gun": "FINGER_GUN",
  dance: "DANCE",
};
const ANIMATION_NAMES = Object.keys(ANIMATION_EVENT_NAMES);
const WINDOW_ACTIONS = ["show", "hide", "toggle"];
const SERVER_INSTRUCTIONS =
  "Persona controls the installed local desktop character. Use play_animation when the user asks for a visual reaction or it clearly supports their request. Use control_window to show, hide, or toggle Persona. Persona never speaks or plays audio. get_status is read-only.";

function textResult(text) {
  return {
    content: [{ type: "text", text }],
  };
}

function getAnimationEventName(animation) {
  return ANIMATION_EVENT_NAMES[animation] ?? null;
}

function createPersonaMcpServer({
  onAnimation,
  onWindowAction,
  getStatus,
  listCharacters = null,
  onCharacter = null,
  listAnimations = null,
  onAgent = null,
  listAgentAvatars = null,
  onExportPortrait = null,
  onSpawnAvatar = null,
  onRemoveAvatar = null,
}) {
  const server = new McpServer(
    {
      name: "Persona",
      version,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // Support both built-in animation names and FILE:<filename.vrma> format
  const animationSchema = z
    .union([
      z.enum(ANIMATION_NAMES),
      z.string().regex(/^FILE:[\w.-]+\.vrma$/),
    ])
    .describe("Built-in animation name or FILE:<filename.vrma> for custom animations.");

  server.registerTool(
    "play_animation",
    {
      title: "Play Persona animation",
      description:
        "Play one installed character animation once in the desktop window. This shows Persona and temporarily takes priority over voice-driven body motion.",
      inputSchema: {
        animation: animationSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ animation }) => {
      let displayName = animation;
      if (animation.startsWith("FILE:")) {
        displayName = animation.slice(5);
      }
      // An explicit `false` means the clip does not exist and nothing was played. Only
      // `false` counts as a refusal, so an onAnimation that returns nothing (older
      // callers, test stubs) still reports success.
      const played = await onAnimation(animation);
      if (played === false) {
        return {
          content: [{
            type: "text",
            text: `No animation named "${displayName}" is installed — nothing was played. ` +
              `Available: ${ANIMATION_NAMES.join(", ")}, or FILE:<filename.vrma>.`,
          }],
          isError: true,
        };
      }
      return textResult(`Persona is playing the ${displayName} animation.`);
    },
  );

  server.registerTool(
    "control_window",
    {
      title: "Control Persona window",
      description:
        "Show, hide, or toggle the local Persona window. Hiding the window does not quit Persona.",
      inputSchema: {
        action: z.enum(WINDOW_ACTIONS).describe("The window action to perform."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ action }) => {
      const visible = await onWindowAction(action);
      return textResult(`Persona's window is now ${visible ? "visible" : "hidden"}.`);
    },
  );

  server.registerTool(
    "get_status",
    {
      title: "Get Persona status",
      description:
        "Read Persona's window visibility, voice state, and local listener status.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => textResult(JSON.stringify(await getStatus())),
  );

  if (listCharacters != null && onCharacter != null) {
    server.registerTool(
      "list_characters",
      {
        title: "List Persona characters",
        description:
          "List the installed character roster and which character is active.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => textResult(JSON.stringify(await listCharacters())),
    );

    server.registerTool(
      "set_character",
      {
        title: "Switch Persona character",
        description:
          "Switch the desktop window to an installed character from the roster and reload the avatar.",
        inputSchema: {
          name: z
            .string()
            .min(1)
            .max(64)
            .describe("The roster character name, as returned by list_characters."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ name }) => {
        const ok = await onCharacter(name);
        return textResult(
          ok
            ? `Persona switched to the ${name} character.`
            : `No character named ${name} is installed. Use list_characters to see the roster.`,
        );
      },
    );
  }

  if (listAnimations != null) {
    server.registerTool(
      "list_animations",
      {
        title: "List Persona animations",
        description:
          "List the animations play_animation can play: the built-in clips plus any installed " +
          "FILE:<filename.vrma> motion packs.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      // `listAnimations` was accepted as a constructor option and passed in by main.cjs,
      // but NO tool ever exposed it — so `FILE:<name>.vrma` playback worked while a caller
      // had no way to discover which packs existed short of listing the assets directory
      // by hand. Registering it closes that (D-1660 in the AitherOS ledger).
      async () => textResult(JSON.stringify(await listAnimations())),
    );
  }

  if (onAgent != null && listAgentAvatars != null) {
    server.registerTool(
      "set_agent",
      {
        title: "Show an agent's avatar",
        description:
          "Switch the desktop window to the character assigned to an agent (aither, atlas, demiurge, lyra, …), so the avatar on screen matches whoever is speaking.",
        inputSchema: {
          agent: z.string().min(1).max(64).describe("Agent name, e.g. aither or atlas."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ agent }) => {
        const character = await onAgent(agent);
        return textResult(
          character
            ? `Persona is now showing ${agent}'s avatar (${character}).`
            : `No avatar is assigned to ${agent}. Assign one from the avatar menu (Characters > Agents) or with list_agent_avatars.`,
        );
      },
    );

    server.registerTool(
      "list_agent_avatars",
      {
        title: "List agent avatar assignments",
        description: "Read which character each agent is assigned to.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => textResult(JSON.stringify(await listAgentAvatars())),
    );
  }

  if (onExportPortrait != null) {
    server.registerTool(
      "export_to_aithershell",
      {
        title: "Render this character into AitherShell",
        description:
          "Capture the current 3D character as AitherShell portrait frames (idle loop + talking mouth set) so the same avatar runs inside the shell's docked pane.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => textResult(JSON.stringify(await onExportPortrait())),
    );
  }

  if (onSpawnAvatar != null) {
    server.registerTool(
      "spawn_avatar",
      {
        title: "Add a second avatar to the scene",
        description:
          "Add a SECOND (or further) avatar to the scene in a new slot, without disturbing the existing avatar(s). Unlike set_character, this does NOT reload the window or replace the default avatar — it adds a new model alongside what's already showing.",
        inputSchema: {
          slot_id: z
            .string()
            .min(1)
            .max(32)
            .regex(/^[a-z0-9_-]+$/)
            .describe("A short alphanumeric identifier for this avatar slot (e.g., 'slot1', 'char-bob')."),
          name: z
            .string()
            .min(1)
            .max(64)
            .describe("The roster character name, as returned by list_characters."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ slot_id, name }) => {
        const ok = await onSpawnAvatar(slot_id, name);
        return textResult(
          ok
            ? `Avatar spawned in slot ${slot_id} with character ${name}.`
            : `Failed to spawn avatar: slot_id may be reserved (use a custom id like 'slot1'), or character ${name} is not installed.`,
        );
      },
    );
  }

  if (onRemoveAvatar != null) {
    server.registerTool(
      "remove_avatar",
      {
        title: "Remove a spawned avatar slot",
        description:
          "Remove a previously spawned avatar slot from the scene. Cannot remove the original/default slot.",
        inputSchema: {
          slot_id: z
            .string()
            .min(1)
            .max(32)
            .describe("The slot id of the avatar to remove (e.g., 'slot1')."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ slot_id }) => {
        const ok = await onRemoveAvatar(slot_id);
        return textResult(
          ok
            ? `Avatar slot ${slot_id} removed.`
            : `Failed to remove slot ${slot_id}: it may not exist, or it may be the default slot (which cannot be removed).`,
        );
      },
    );
  }

  return server;
}

function createPersonaMcpHandler(controller) {
  return async (request, response, parsedBody) => {
    const server = createPersonaMcpServer(controller);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, parsedBody);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
      throw error;
    } finally {
      await transport.close();
      await server.close();
    }
  };
}

module.exports = {
  ANIMATION_EVENT_NAMES,
  ANIMATION_NAMES,
  MCP_PATH,
  SERVER_INSTRUCTIONS,
  WINDOW_ACTIONS,
  createPersonaMcpHandler,
  createPersonaMcpServer,
  getAnimationEventName,
};
