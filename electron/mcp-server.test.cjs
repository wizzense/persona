"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { createBridgeServer } = require("./bridge-server.cjs");
const cast = require("./cast-config.cjs");
const {
  ANIMATION_NAMES,
  SERVER_INSTRUCTIONS,
  WINDOW_ACTIONS,
  createDeskMcpHandler,
  describeCast,
  getAnimationEventName,
} = require("./mcp-server.cjs");

// U17 fixtures. A per-test tmpdir + the {file}/{castFile} param, never
// DESK_CAST_FILE — `node --test` runs this file's tests as a shared process
// but cast-config.test.cjs's own header explains why the env seam races
// across PARALLEL test files; passing `file` directly sidesteps it entirely.
function tmpCastFile(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-mcp-cast-"));
  const file = path.join(dir, "cast.json");
  fs.writeFileSync(file, JSON.stringify(fixture, null, 2), "utf8");
  return file;
}

test("Desk MCP exposes and executes the local character tools", async (context) => {
  const animations = [];
  const windowActions = [];
  let windowVisible = false;
  const voiceState = {
    activity: "listening",
    microphoneMuted: false,
    outputMuted: false,
    phase: "active",
  };
  const listener = {
    available: true,
    capturing: false,
    monitoring: true,
    source: null,
  };
  const mcpHandler = createDeskMcpHandler({
    onAnimation: (animation) => animations.push(animation),
    onWindowAction: (action) => {
      windowActions.push(action);
      if (action === "show") windowVisible = true;
      else if (action === "hide") windowVisible = false;
      else windowVisible = !windowVisible;
      return windowVisible;
    },
    getStatus: () => ({ windowVisible, voiceState, listener }),
  });
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler,
  });
  const address = await bridge.listen();
  const client = new Client({ name: "desk-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => {
    await client.close();
    await bridge.close();
  });

  await client.connect(transport);
  const tools = await client.listTools();

  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["play_animation", "control_window", "get_status", "cast_describe", "party_export"],
  );
  assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);

  // Verify play_animation accepts both built-in animations and FILE: format
  const playAnimationSchema = tools.tools.find(
    (tool) => tool.name === "play_animation",
  ).inputSchema;
  assert(playAnimationSchema.properties.animation, "animation property exists");
  // Schema now uses anyOf for union, not a direct enum
  assert(
    playAnimationSchema.properties.animation.anyOf ||
      playAnimationSchema.properties.animation.enum,
    "animation schema includes anyOf or enum",
  );

  assert.deepEqual(
    tools.tools
      .find((tool) => tool.name === "control_window")
      .inputSchema.properties.action.enum,
    WINDOW_ACTIONS,
  );

  const animationResult = await client.callTool({
    name: "play_animation",
    arguments: { animation: "finger-gun" },
  });
  const windowResult = await client.callTool({
    name: "control_window",
    arguments: { action: "show" },
  });
  const statusResult = await client.callTool({
    name: "get_status",
    arguments: {},
  });

  assert.deepEqual(animations, ["finger-gun"]);
  assert.deepEqual(windowActions, ["show"]);
  assert.match(animationResult.content[0].text, /finger-gun animation/);
  assert.match(windowResult.content[0].text, /now visible/);
  assert.deepEqual(JSON.parse(statusResult.content[0].text), {
    windowVisible: true,
    voiceState,
    listener,
  });
});

test("Desk MCP maps semantic animation names to renderer events", () => {
  assert.equal(getAnimationEventName("happy"), "HAPPY");
  assert.equal(getAnimationEventName("finger-gun"), "FINGER_GUN");
  assert.equal(getAnimationEventName("dance"), "DANCE");
  assert.equal(getAnimationEventName("celebrate"), null);
});

test("Desk MCP rejects unknown animation names before invoking the app", async (context) => {
  const animations = [];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: createDeskMcpHandler({
      onAnimation: (animation) => animations.push(animation),
      onWindowAction: () => false,
      getStatus: () => ({
        windowVisible: false,
        voiceState: null,
        listener: null,
      }),
    }),
  });
  const address = await bridge.listen();
  const client = new Client({ name: "desk-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => {
    await client.close();
    await bridge.close();
  });

  await client.connect(transport);
  const result = await client.callTool({
    name: "play_animation",
    arguments: { animation: "download_from_the_internet" },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(animations, []);
});

/**
 * play_animation used to report success for a clip that was never played: main.cjs's
 * onAnimation returned undefined for an unknown name and the tool answered "Desk is
 * playing the X animation" regardless. Measured live 2026-07-29 against a running
 * Desk — a junk name came back as success. A caller could not distinguish a typo from
 * a working request, so the mistake looked like a working feature.
 */
test("play_animation reports an ERROR when the clip does not exist", async (context) => {
  const attempted = [];
  // Mirrors main.cjs: unknown clip -> false, known clip -> true.
  const mcpHandler = createDeskMcpHandler({
    onAnimation: (animation) => {
      attempted.push(animation);
      return getAnimationEventName(animation) != null || animation.startsWith("FILE:");
    },
    onWindowAction: () => true,
    getStatus: () => ({ windowVisible: true, voiceState: null, listener: null }),
  });
  const bridge = createBridgeServer({ port: 0, onEvent: () => {}, mcpHandler });
  const address = await bridge.listen();
  const client = new Client({ name: "desk-test-anim", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => { await client.close(); await bridge.close(); });
  await client.connect(transport);

  // A refusal may arrive two ways and BOTH are correct: the SDK rejects it during input
  // validation (-32602) on an initialized session, or — when validation is bypassed, which
  // is what a bare JSON-RPC POST does — our handler returns isError. What must never
  // happen is a success report for a clip that was not played.
  let refused = false;
  let how;
  try {
    const bad = await client.callTool({
      name: "play_animation",
      arguments: { animation: "definitely-not-a-clip" },
    });
    if (bad.isError === true) { refused = true; how = `isError: ${bad.content[0].text}`; }
    else how = `success: ${bad.content?.[0]?.text}`;
  } catch (error) {
    refused = true;
    how = `threw: ${error.message}`;
  }
  assert.ok(refused, `an unknown clip must be refused, got ${how}`);
  assert.ok(!attempted.includes("definitely-not-a-clip") || refused,
    "an unrecognised clip must never be reported as played");

  const good = await client.callTool({
    name: "play_animation",
    arguments: { animation: "dance" },
  });
  assert.notEqual(good.isError, true, "a real clip must NOT be an error");
  assert.match(good.content[0].text, /playing the dance animation/i);

  const file = await client.callTool({
    name: "play_animation",
    arguments: { animation: "FILE:custom.vrma" },
  });
  assert.notEqual(file.isError, true, "a FILE: clip must NOT be an error");
});

test("a void onAnimation stays backwards-compatible (only false is a refusal)", async (context) => {
  const mcpHandler = createDeskMcpHandler({
    onAnimation: () => undefined,
    onWindowAction: () => true,
    getStatus: () => ({ windowVisible: true, voiceState: null, listener: null }),
  });
  const bridge = createBridgeServer({ port: 0, onEvent: () => {}, mcpHandler });
  const address = await bridge.listen();
  const client = new Client({ name: "desk-test-legacy", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => { await client.close(); await bridge.close(); });
  await client.connect(transport);
  const r = await client.callTool({ name: "play_animation", arguments: { animation: "dance" } });
  assert.notEqual(r.isError, true, "undefined must not be treated as a refusal");
});

/**
 * `listAnimations` was accepted as a constructor option and passed in by main.cjs, but no
 * tool ever exposed it — so FILE:<name>.vrma playback worked while a caller had no way to
 * discover which packs were installed (recorded in the AitherOS ledger).
 */
test("list_animations exposes the built-ins AND installed .vrma packs", async (context) => {
  const mcpHandler = createDeskMcpHandler({
    onAnimation: () => true,
    onWindowAction: () => true,
    getStatus: () => ({ windowVisible: true, voiceState: null, listener: null }),
    listAnimations: () => [...ANIMATION_NAMES, "FILE:wave.vrma", "FILE:MyPose.vrma"],
  });
  const bridge = createBridgeServer({ port: 0, onEvent: () => {}, mcpHandler });
  const address = await bridge.listen();
  const client = new Client({ name: "desk-test-anims", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => { await client.close(); await bridge.close(); });
  await client.connect(transport);

  const tools = await client.listTools();
  assert.ok(
    tools.tools.some((t) => t.name === "list_animations"),
    "list_animations must be registered when listAnimations is supplied",
  );

  const result = await client.callTool({ name: "list_animations", arguments: {} });
  const listed = JSON.parse(result.content[0].text);
  assert.ok(listed.includes("FILE:wave.vrma"), "custom pack not listed");
  assert.ok(listed.includes("FILE:MyPose.vrma"), "case-sensitive pack name altered");
  for (const name of ANIMATION_NAMES) {
    assert.ok(listed.includes(name), `built-in ${name} not listed`);
  }
});

/**
 * U17: cast_describe is a READ over cast.json — the snapshot, every
 * explicitly configured row resolved with its provenance, the roster and
 * cast-seen.json — so a muted agent can learn WHY instead of retrying into
 * silence. Exercised over the real MCP transport (not describeCast() called
 * bare) so this also proves the tool is actually REGISTERED and its JSON is
 * what a client receives, not just what the helper computes.
 */
test("cast_describe returns the documented keys, resolved with provenance, against a fixture cast file", async (context) => {
  const castFile = tmpCastFile({
    version: 1,
    actors: {
      "claude_code:seat0": { voice: "nova", presence: "chatty" },
    },
    authors: {
      "aitheros-fresh": { voice: "fable" },
    },
    channels: {
      "#general": { voiced: true },
    },
  });
  const mcpHandler = createDeskMcpHandler({
    onAnimation: () => true,
    onWindowAction: () => true,
    getStatus: () => ({ windowVisible: true, voiceState: null, listener: null }),
    castFile,
    listCharacters: () => ({ active: "aria", characters: ["aria", "juno"] }),
  });
  const bridge = createBridgeServer({ port: 0, onEvent: () => {}, mcpHandler });
  const address = await bridge.listen();
  const client = new Client({ name: "desk-test-cast-describe", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => { await client.close(); await bridge.close(); });
  await client.connect(transport);

  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "cast_describe"), "cast_describe must be registered");
  assert.equal(
    tools.tools.find((t) => t.name === "cast_describe").annotations?.readOnlyHint,
    true,
    "cast_describe must be marked read-only",
  );

  const result = await client.callTool({ name: "cast_describe", arguments: {} });
  assert.notEqual(result.isError, true);
  const described = JSON.parse(result.content[0].text);

  // The documented keys — every one of them, so a consumer never has to guess
  // whether an absent field means "empty" or "not implemented yet".
  for (const key of ["ok", "snapshot", "error", "problems", "resolved", "roster", "rosterActive", "seen"]) {
    assert.ok(key in described, `cast_describe response missing "${key}"`);
  }
  assert.equal(described.ok, true);
  assert.equal(described.error, null);
  assert.deepEqual(described.roster, ["aria", "juno"]);
  assert.equal(described.rosterActive, "aria");

  const actorRow = described.resolved.find((r) => r.label === 'actors["claude_code:seat0"]');
  assert.ok(actorRow, "the configured actors[] row must appear in resolved");
  assert.equal(actorRow.voice, "nova");
  assert.ok(actorRow.voiceFrom.startsWith('actors["claude_code:seat0"]'), actorRow.voiceFrom);
  assert.equal(actorRow.presence, "chatty");
  assert.equal(actorRow.cooldownSeconds, 0, "chatty presence must resolve cooldown to 0");

  const authorRow = described.resolved.find((r) => r.label === "authors.aitheros-fresh");
  assert.ok(authorRow, "the configured authors[] row must appear in resolved");
  assert.equal(authorRow.voice, "fable");

  const channelRow = described.resolved.find((r) => r.label === 'channels["#general"]');
  assert.ok(channelRow, "the configured channels[] row must appear in resolved");
});

/**
 * The security assertion this unit exists to carry. cast_describe is a READ;
 * an agent must not be able to grant itself audibility or reassign an avatar
 * by calling an MCP tool — that path is the Cast pane, on purpose (see the
 * registration comment in mcp-server.cjs). If a later change adds a write
 * tool for cast.json or cast-seen.json, THIS test must fail.
 */
test("cast_describe is the only cast-shaped tool — no tool may write cast.json or cast-seen.json", async (context) => {
  const castFile = tmpCastFile({ version: 1 });
  const writeSpy = { calls: 0 };
  const originalWrite = cast.write;
  cast.write = (...args) => {
    writeSpy.calls += 1;
    return originalWrite(...args);
  };
  context.after(() => { cast.write = originalWrite; });

  // Supply every callback so every conditional tool registers — the full
  // surface a real main.cjs would expose, not a stub missing half the tools.
  const mcpHandler = createDeskMcpHandler({
    onAnimation: () => true,
    onWindowAction: () => true,
    getStatus: () => ({ windowVisible: true, voiceState: null, listener: null }),
    castFile,
    listCharacters: () => ({ active: null, characters: ["aria"] }),
    onCharacter: () => true,
    listAgentAvatars: () => ({}),
    onAgent: () => "aria",
    listAnimations: () => ["dance"],
    onExportPortrait: async () => ({ ok: true }),
    onSpawnAvatar: () => true,
    onRemoveAvatar: () => true,
    onFleet: async () => ({ ok: true }),
    onCommand: async () => ({ ok: true, reply: "ok" }),
    onDesktop: () => ({ ok: true }),
    onSpeak: async () => ({ ok: true }),
  });
  const bridge = createBridgeServer({ port: 0, onEvent: () => {}, mcpHandler });
  const address = await bridge.listen();
  const client = new Client({ name: "desk-test-cast-nowrite", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => { await client.close(); await bridge.close(); });
  await client.connect(transport);

  const tools = await client.listTools();
  const castShaped = tools.tools.filter((t) => /cast/i.test(t.name));
  assert.deepEqual(
    castShaped.map((t) => t.name),
    ["cast_describe"],
    "a new cast-shaped MCP tool appeared. If it can write cast.json or cast-seen.json, an " +
      "agent can now grant itself audibility or reassign its own avatar — the exact ambient" +
      "-telemetry complaint (\"keeps defaulting and changing to an avatar I don't want\") this " +
      "cast surface exists to answer. Avatar/voice assignment belongs to the Cast pane only.",
  );

  await client.callTool({ name: "cast_describe", arguments: {} });
  assert.equal(writeSpy.calls, 0, "cast_describe must never call cast-config's write()");
});

/**
 * cast-config's resolveActor DROPS an invalid field rather than throwing, and
 * reports it in that row's own `problems` — never silent omission. A
 * `character` outside the roster is exactly this: the row falls back to the
 * hash-picked character, but the REASON must survive to the caller so an
 * agent (or the owner reading the Cast pane) can see the file asked for a
 * character that is not installed, instead of just "the avatar looks random".
 */
test("an unknown character is reported with its problem, not silently dropped", async () => {
  const castFile = tmpCastFile({
    version: 1,
    actors: {
      "claude_code:seat0": { character: "definitely-not-installed" },
    },
  });
  const described = await describeCast({
    castFile,
    listCharacters: () => ({ active: null, characters: ["aria", "juno"] }),
  });

  const row = described.resolved.find((r) => r.label === 'actors["claude_code:seat0"]');
  assert.ok(row, "the row must still be present");
  assert.notEqual(row.character, "definitely-not-installed", "an out-of-roster character must not resolve as-is");
  const problem = row.problems.find((p) => p.path.endsWith(".character") && p.value === "definitely-not-installed");
  assert.ok(problem, `expected a character problem, got ${JSON.stringify(row.problems)}`);
  assert.match(problem.reason, /roster/i);
});

/** describeCast alone (no MCP transport): a fixture with nothing configured
 *  must still answer every documented key, never throw. */
test("describeCast answers the documented shape even with an empty cast file", async () => {
  const castFile = tmpCastFile({ version: 1 });
  const described = await describeCast({ castFile });
  assert.equal(described.ok, true);
  assert.deepEqual(described.resolved, []);
  assert.deepEqual(described.roster, []);
  assert.equal(described.rosterActive, null);
  assert.deepEqual(described.seen, {});
});

test("list_animations is NOT registered when no lister is supplied", async (context) => {
  // Optional capability: an embedder that cannot enumerate must not advertise the tool.
  const mcpHandler = createDeskMcpHandler({
    onAnimation: () => true,
    onWindowAction: () => true,
    getStatus: () => ({ windowVisible: true, voiceState: null, listener: null }),
  });
  const bridge = createBridgeServer({ port: 0, onEvent: () => {}, mcpHandler });
  const address = await bridge.listen();
  const client = new Client({ name: "desk-test-noanims", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => { await client.close(); await bridge.close(); });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(!tools.tools.some((t) => t.name === "list_animations"));
});

test("ask_owner returns the owner's spoken answer and passes the timeout through", async (context) => {
  const asked = [];
  const mcpHandler = createDeskMcpHandler({
    onAnimation: () => true,
    onWindowAction: () => true,
    getStatus: () => ({ windowVisible: true, voiceState: null, listener: null }),
    onAsk: async ({ question, timeoutMs }) => {
      asked.push({ question, timeoutMs });
      return { question, ok: true, answer: "yes, ship it" };
    },
  });
  const bridge = createBridgeServer({ port: 0, onEvent: () => {}, mcpHandler });
  const address = await bridge.listen();
  const client = new Client({ name: "desk-test-ask", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  context.after(async () => { await client.close(); await bridge.close(); });
  await client.connect(transport);

  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "ask_owner"), "ask_owner must be registered when onAsk is supplied");
  const result = await client.callTool({ name: "ask_owner", arguments: { question: "Ship it?", timeout_s: 30 } });
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.content[0].text).answer, "yes, ship it");
  assert.deepEqual(asked, [{ question: "Ship it?", timeoutMs: 30000 }]);
});
