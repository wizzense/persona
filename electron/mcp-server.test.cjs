"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { createBridgeServer } = require("./bridge-server.cjs");
const {
  ANIMATION_NAMES,
  SERVER_INSTRUCTIONS,
  WINDOW_ACTIONS,
  createDeskMcpHandler,
  getAnimationEventName,
} = require("./mcp-server.cjs");

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
    ["play_animation", "control_window", "get_status"],
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
 * discover which packs were installed (D-1660 in the AitherOS ledger).
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
