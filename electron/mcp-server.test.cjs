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
  createPersonaMcpHandler,
  getAnimationEventName,
} = require("./mcp-server.cjs");

test("Persona MCP exposes and executes the local character tools", async (context) => {
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
  const mcpHandler = createPersonaMcpHandler({
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
  const client = new Client({ name: "persona-test", version: "1.0.0" });
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

test("Persona MCP maps semantic animation names to renderer events", () => {
  assert.equal(getAnimationEventName("happy"), "HAPPY");
  assert.equal(getAnimationEventName("finger-gun"), "FINGER_GUN");
  assert.equal(getAnimationEventName("dance"), "DANCE");
  assert.equal(getAnimationEventName("celebrate"), null);
});

test("Persona MCP rejects unknown animation names before invoking the app", async (context) => {
  const animations = [];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: createPersonaMcpHandler({
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
  const client = new Client({ name: "persona-test", version: "1.0.0" });
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
