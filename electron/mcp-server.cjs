"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const z = require("zod/v4");
const { version } = require("../package.json");
// Plan 40 slice F. A refusal must name its real cause: a character hidden by the
// safety gate IS installed, and answering "not installed" sends the owner hunting
// for a file that is sitting in the roster.
const { refusalFor } = require("./content-rating.cjs");
// U17: cast_describe is a READ of cast-config's own file, resolved with the same
// tier logic every speaker goes through. Required directly (like content-rating
// above) rather than plumbed through main.cjs, so this tool needs no per-caller
// origin wiring — it is a diagnostic OVER the grants, not a grant itself.
const cast = require("./cast-config.cjs");

function refusalText(name, fallback) {
  const refusal = refusalFor(name);
  return refusal ? refusal.reason : fallback;
}

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
// Fleet verbs an agent may drive (2026-09-07). `open_panel` raises the window
// for the owner; the rest run the same FleetControl the window's buttons do.
const FLEET_ACTIONS = ["down", "up", "gaming", "resume", "adopt", "open_panel",
  "arc-status", "arc-start", "arc-now", "arc-stop"];
const SERVER_INSTRUCTIONS =
  "Desk controls the installed local desktop character. Use play_animation when the user asks for a visual reaction or it clearly supports their request. Use control_window to show, hide, or toggle Desk. Use speak to have the avatar say a short line aloud through AitherVoice with lip-sync. get_status is read-only.";

function textResult(text) {
  return {
    content: [{ type: "text", text }],
  };
}

function getAnimationEventName(animation) {
  return ANIMATION_EVENT_NAMES[animation] ?? null;
}

/**
 * describeCast — the read side of cast.json: the snapshot's own load
 * error/problems, every EXPLICITLY configured actor/author/channel row run
 * through resolveActor() (so its `*From` fields name which tier decided, and
 * an unconfigured or rejected field shows up in that row's own `problems`
 * rather than silently falling through), the installed roster (so a
 * configured `character` can be judged against it — see cast-config's
 * `inRoster`), and cast-seen.json: origins the room has watched speak that
 * nobody granted. This is the whole point of the tool (U17): an agent that is
 * mute can find out WHY instead of retrying into silence.
 *
 * Pure aside from the two reads (cast.json + cast-seen.json, both fail-soft
 * inside cast-config). `castFile` is a test seam mirroring cast-config's own
 * `{file}` param — pointing straight at a fixture beats juggling
 * DESK_CAST_FILE across `node --test`'s parallel child processes.
 *
 * @returns {{ok: true, snapshot, error, problems, resolved, roster,
 *   rosterActive, seen}}
 */
async function describeCast({ castFile, listCharacters } = {}) {
  const loaded = cast.load(castFile ? { file: castFile } : {});
  const snapshot = loaded.snapshot || {};

  // Best-effort roster: describe must still answer when the caller has no
  // lister wired (e.g. this tool tested standalone), it just cannot judge
  // `character` against anything then (cast-config's inRoster: an empty
  // roster is "nothing to judge against", not "nothing is valid").
  let roster = [];
  let rosterActive = null;
  if (typeof listCharacters === "function") {
    try {
      const listed = await listCharacters();
      if (Array.isArray(listed)) {
        roster = listed;
      } else if (listed && Array.isArray(listed.characters)) {
        roster = listed.characters;
        rosterActive = typeof listed.active === "string" ? listed.active : null;
      }
    } catch {
      /* roster is a convenience for judging `character`, never a blocker */
    }
  }

  const cfg = snapshot && typeof snapshot === "object" ? snapshot : {};
  const ctxBase = { roster };
  const resolved = [];
  for (const key of Object.keys(cfg.actors || {})) {
    resolved.push({
      scope: "actors",
      label: `actors[${JSON.stringify(key)}]`,
      ...cast.resolveActor(snapshot, { ...ctxBase, key }),
    });
  }
  for (const [author, record] of Object.entries(cfg.authors || {})) {
    resolved.push({
      scope: "authors",
      label: `authors.${author}`,
      ...cast.resolveActor(snapshot, { ...ctxBase, author }),
    });
    const seats = record && Array.isArray(record.seats) ? record.seats : [];
    seats.forEach((_seat, seat) => {
      resolved.push({
        scope: "authors",
        label: `authors.${author}.seats[${seat}]`,
        ...cast.resolveActor(snapshot, { ...ctxBase, author, seat }),
      });
    });
  }
  for (const channel of Object.keys(cfg.channels || {})) {
    resolved.push({
      scope: "channels",
      label: `channels[${JSON.stringify(channel)}]`,
      ...cast.resolveActor(snapshot, { ...ctxBase, kind: "relay", channel }),
    });
  }

  // readSeen() already fails soft (ENOENT/bad JSON -> {}); this catch is
  // belt-and-suspenders against SEEN_FILE() itself throwing on a hostile path.
  let seen;
  try {
    seen = cast.readSeen(castFile ? { file: cast.SEEN_FILE(castFile) } : {});
  } catch {
    seen = {};
  }

  return {
    ok: true,
    snapshot,
    error: loaded.error,
    problems: loaded.problems || [],
    resolved,
    roster,
    rosterActive,
    seen,
  };
}

function createDeskMcpServer({
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
  onFleet = null,
  onCommand = null,
  onDesktop = null,
  onSpeak = null,
  onAsk = null,
  // Test/override seam for cast_describe (see describeCast). Production never
  // sets this — cast-config resolves CAST_FILE() itself (app.getPath("userData"),
  // or DESK_CAST_FILE).
  castFile = undefined,
  // Test seam for party_export: the writer itself. Production leaves it null and
  // the tool requires party-manifest.cjs lazily, so a broken writer costs the
  // one tool call, never the server.
  partyExport = null,
}) {
  const server = new McpServer(
    {
      name: "Desk",
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
      title: "Play Desk animation",
      description:
        "Play one installed character animation once in the desktop window. This shows Desk and temporarily takes priority over voice-driven body motion.",
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
      return textResult(`Desk is playing the ${displayName} animation.`);
    },
  );

  server.registerTool(
    "control_window",
    {
      title: "Control Desk window",
      description:
        "Show, hide, or toggle the local Desk window. Hiding the window does not quit Desk.",
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
      return textResult(`Desk's window is now ${visible ? "visible" : "hidden"}.`);
    },
  );

  server.registerTool(
    "get_status",
    {
      title: "Get Desk status",
      description:
        "Read Desk's window visibility, voice state, and local listener status.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => textResult(JSON.stringify(await getStatus())),
  );

  // Read-only and unconditional (unlike list_characters/set_agent below, which
  // only register when main.cjs wires their callbacks): cast.json is read
  // directly, so there is nothing an embedder needs to supply for this tool to
  // answer. `listCharacters`, if the embedder happens to also offer it, only
  // sharpens the `character` provenance (see describeCast's roster judging) —
  // its absence must never hide the tool.
  //
  // 🚩 NO WRITE COUNTERPART. Agent-driven avatar/voice writes are refused ON
  // PURPOSE — set_agent already reassigns a character, and the measured
  // complaint this whole cast surface exists to answer is exactly that:
  // ambient telemetry "keeps defaulting and changing to an avatar I don't
  // want" by re-installing a character and reloading the window every few
  // seconds. An agent may read why it is muted; only the Cast pane may fix it.
  // mcp-server.test.cjs asserts no writer for cast.json or cast-seen.json
  // exists in the registered tool set — that assertion must FAIL if a later
  // change adds one.
  server.registerTool(
    "cast_describe",
    {
      title: "Describe the room cast",
      description:
        "Read-only. Returns cast.json's snapshot (with its load error/problems), every " +
        "explicitly configured actor/author/channel row resolved with its provenance " +
        "(which config tier decided each field, or why a value was rejected), the " +
        "installed character roster, and origins cast-seen.json has watched speak that " +
        "nobody granted — so an agent that cannot get a voice can learn WHY instead of " +
        "retrying into silence. There is no write tool here: reassigning an avatar or " +
        "voice is done from the Cast pane, not by an agent calling itself into audibility.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const described = await describeCast({ castFile, listCharacters });
      return {
        content: [{ type: "text", text: JSON.stringify(described, null, 2) }],
        isError: described.ok === false,
      };
    },
  );

  // party_export — WRITES %APPDATA%\Desk\party.json, the party manifest the other
  // avatar products (Dark Matters guide slot, Saga, the sprite) join on by
  // persona_id (schema: AitherOS/config/schemas/party-manifest.schema.json).
  // It is a derived EXPORT of cast.json + the roster through the content gate,
  // never a write INTO cast.json: the no-writer assertion in mcp-server.test.cjs
  // stands (the name deliberately does not contain "cast"), and a character the
  // gate hides is excluded from the file rather than handed to a product that
  // never asked the gate. Unconditional, like cast_describe: nothing an
  // embedder must wire for it to answer.
  server.registerTool(
    "party_export",
    {
      title: "Export the party manifest",
      description:
        "Write party.json (version 1, source awdesk): every configured cast actor and every " +
        "roster character as a member keyed by persona_id, with body (vrm + vrma clips), " +
        "voice, presence, rating and saga/sprite ids. Characters hidden by the content " +
        "gate are EXCLUDED and reported. Returns {ok, file, members, excluded, problems}.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      let result;
      try {
        const exporter = partyExport || require("./party-manifest.cjs").exportParty;
        result = await exporter({});
      } catch (error) {
        result = { ok: false, error: `party export threw: ${error && error.message ? error.message : error}` };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: result.ok !== true,
      };
    },
  );

  if (listCharacters != null && onCharacter != null) {
    server.registerTool(
      "list_characters",
      {
        title: "List Desk characters",
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
        title: "Switch Desk character",
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
            ? `Desk switched to the ${name} character.`
            : refusalText(
              name,
              `No character named ${name} is installed. Use list_characters to see the roster.`,
            ),
        );
      },
    );
  }

  if (listAnimations != null) {
    server.registerTool(
      "list_animations",
      {
        title: "List Desk animations",
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
      // by hand. Registering it closes that (recorded in the AitherOS ledger).
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
            ? `Desk is now showing ${agent}'s avatar (${character}).`
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
            : refusalText(
              name,
              `Failed to spawn avatar: slot_id may be reserved (use a custom id like 'slot1'), `
              + `or character ${name} is not installed.`,
            ),
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

  if (onFleet) {
    server.registerTool(
      "fleet_status",
      {
        title: "AitherOS fleet status",
        description:
          "Read-only: is the AitherOS fleet up, down, or GPU-quiet? Returns the running-container count, masked units, VRAM and the GPU HOLD state, measured from the podman/systemd reality in the Debian WSL distro (never from the last button pressed). CANNOT JUDGE is reported as such, never as healthy.",
        inputSchema: {
          fresh: z.boolean().optional().describe("true = probe now instead of the cached verdict (up to ~10 s)."),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ fresh }) => {
        const verdict = await onFleet("status", { fresh: fresh === true });
        return { content: [{ type: "text", text: JSON.stringify(verdict, null, 2) }], isError: verdict?.ok === false };
      },
    );
  }

  if (onCommand != null) {
    server.registerTool(
      "desk_command",
      {
        title: "Run a command in the Aither Command window",
        description:
          "Send a sentence or command to the owner's Aither Command window. Fleet verbs (fleet down|up, gpu quiet|resume, etc.) route to fleet control; everything else spawns a Claude agent with a 30-minute timeout. Results are recorded in local history (~/.aither/desk-command.jsonl) and mirrored to awrelay.",
        inputSchema: {
          text: z.string().min(1).max(4096).describe("The command text or sentence to execute."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ text }) => {
        const result = await onCommand(text, { source: "mcp" });
        return {
          content: [{ type: "text", text: result.reply }],
          isError: result.ok === false,
        };
      },
    );
  }

  if (onFleet != null) {
    server.registerTool(
      "fleet_control",
      {
        title: "Control the AitherOS fleet",
        description:
          "down = stop AND runtime-mask every aither unit + container (holds against restarts); up = unmask and bring back exactly what was stopped (GPU models one at a time, minutes); gaming = GPU models + routine runners off, rest stays up; resume = undo gaming; adopt = record a hand-stopped (masked) fleet so `up` knows what to start; open_panel = show the Fleet window to the owner. arc-status = is the ARC solver running and the world model learning (train_steps); arc-start = unmask + start it (quiet hours 23:00-07:00 PT still apply); arc-now = run it for 4 h overriding quiet hours and any GPU hold (attributed, self-expiring); arc-stop = stop the solver, world model stays up. Refused with busy when another action is running. Same implementation as the Fleet window and `game down|up`.",
        inputSchema: {
          action: z.enum(FLEET_ACTIONS).describe("The fleet action."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ action }) => {
        const verdict = await onFleet(action, {});
        return { content: [{ type: "text", text: JSON.stringify(verdict, null, 2) }], isError: verdict?.ok === false };
      },
    );
  }

  if (onDesktop != null) {
    server.registerTool(
      "desktop_open",
      {
        title: "Open an AitherOS desktop surface",
        description:
          "overlay = the aitherium.com Living Desktop taskbar drawn over the Windows desktop (click-through where it draws nothing; the same overlay AitherConnect puts over any web page); app = the full aitherium.com AitherDesktop (Desktop Anywhere shell) in its own maximised window; status = which of the two are open. Both share one signed-in session.",
        inputSchema: {
          surface: z.enum(["overlay", "app", "status"]).describe("Which surface to open, or status."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ surface }) => {
        const result = await onDesktop(surface);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: result?.ok === false };
      },
    );
  }

  if (onSpeak != null) {
    server.registerTool(
      "speak",
      {
        title: "Have the avatar say something aloud",
        description:
          "Synthesises the text through AitherVoice and plays it on the owner's desk with lip-sync. Keep it to a sentence or two (2000 chars max). Fails with ok:false when the voice service is unreachable; the avatar stays silent rather than showing a broken mouth.",
        inputSchema: {
          text: z.string().min(1).max(2000).describe("What the avatar says."),
          voice: z.string().optional().describe("AitherVoice voice name (default nova)."),
          speed: z.number().min(0.25).max(4).optional().describe("Playback rate (default 1.35x, or DESK_VOICE_SPEED)."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ text, voice, speed }) => {
        const result = await onSpeak({ text, voice, speed });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: result?.ok === false };
      },
    );
  }

  if (onAsk != null) {
    server.registerTool(
      "ask_owner",
      {
        title: "Ask the owner a question out loud and wait for the spoken answer",
        description:
          "The desk avatar speaks the question, then listens: the owner answers by voice (hotkey, a click on the avatar, or open mic) and the transcript comes back here as `answer`. Use it for a decision or a fact only the owner has -- one short question. One ask at a time across every session; a second is refused while one waits. Fails with ok:false and a reason when the mic is muted, nothing was heard, or no answer came within timeout_s.",
        inputSchema: {
          question: z.string().min(1).max(500).describe("One short question, spoken as written."),
          timeout_s: z.number().int().min(5).max(300).optional().describe("How long to wait for the answer (default 60)."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ question, timeout_s }) => {
        const result = await onAsk({ question, timeoutMs: (timeout_s || 60) * 1000 });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: result?.ok === false };
      },
    );
  }

  return server;
}

function createDeskMcpHandler(controller) {
  return async (request, response, parsedBody) => {
    const server = createDeskMcpServer(controller);
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
  FLEET_ACTIONS,
  MCP_PATH,
  SERVER_INSTRUCTIONS,
  WINDOW_ACTIONS,
  createDeskMcpHandler,
  createDeskMcpServer,
  describeCast,
  getAnimationEventName,
};
