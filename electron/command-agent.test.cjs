"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { classifyCommand, CommandAgent, resolveBin, exeFromCmdShim } = require("./command-agent.cjs");

test("exeFromCmdShim follows npm's .cmd shim to the real .exe (Node >= 20.12 EINVAL on .cmd)", () => {
  const shim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  const exe = exeFromCmdShim("C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd", shim);
  assert.equal(exe, path.join("C:\\Users\\x\\AppData\\Roaming\\npm", "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));
  assert.equal(exeFromCmdShim("C:\\x\\other.cmd", "@echo off\r\nnode something.js %*\r\n"), null, "a js shim is not an exe");
});

// Every agent in this file writes to a throwaway transcript. The first suite wrote to
// the OWNER's real ~/.aither/desk-command.jsonl and "test / cmd1 / cmd2 / no output"
// showed up in the Command window (2026-09-08).
let tmpDir;
test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-command-test-"));
});
test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
let n = 0;
function tmpTranscript() {
  n += 1;
  return path.join(tmpDir, `t${n}.jsonl`);
}

function fakeFleetControl() {
  const ctrl = new EventEmitter();
  ctrl.run = async (action) => ({ ok: true, action, fleet_running_after: 10 });
  return ctrl;
}

function fakeChild({ stdout = "", stderrLines = [], code = 0, delay = 5 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setTimeout(() => {
    for (const line of stderrLines) child.stderr.emit("data", Buffer.from(line + "\n"));
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", code);
  }, delay);
  return child;
}

/** Claude Code's real stream-json shape (measured 2026-09-08). */
function claudeStream(text, { tools = [] } = {}) {
  const lines = [{ type: "system", subtype: "init" }];
  for (const t of tools) lines.push({ type: "assistant", message: { content: [{ type: "tool_use", name: t }] } });
  lines.push({ type: "assistant", message: { content: [{ type: "text", text }] } });
  lines.push({ type: "result", subtype: "success", is_error: false, result: text });
  return lines.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

function agentWith({ claude = null, fleetControl = fakeFleetControl(), relay = null } = {}) {
  const spawned = [];
  const agent = new CommandAgent({
    fleetControl,
    transcriptFile: tmpTranscript(),
    spawnImpl: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      if (cmd === "claude") return claude ? claude() : fakeChild({ stdout: claudeStream("ok") });
      if (cmd === "awrelay") return relay ? relay() : fakeChild({ stdout: "", code: 0, delay: 2 });
      return fakeChild({ stdout: "", code: 1, delay: 5 });
    },
  });
  return { agent, spawned };
}

test("classifyCommand detects fleet verbs", () => {
  for (const t of ["fleet down", "fleet up", "fleet status", "fleet quiesce", "gpu quiet", "gpu resume",
    "game on", "game off", "shut the fleet down", "bring the fleet up", "FLEET STATUS", "  fleet   status  "]) {
    assert.equal(classifyCommand(t).kind, "fleet", t);
  }
  assert.equal(classifyCommand("fleet down").action, "down");
  assert.equal(classifyCommand("game on").action, "gaming");
});

test("classifyCommand routes non-fleet text to agent", () => {
  const result = classifyCommand("do something interesting");
  assert.equal(result.kind, "agent");
  assert.equal(result.action, undefined);
});

test("resolveBin: env override wins; a fake spawn never resolves", () => {
  process.env.AWDESK_TEST_BIN = "C:\\x\\claude.cmd";
  assert.equal(resolveBin("claude", "AWDESK_TEST_BIN"), "C:\\x\\claude.cmd");
  delete process.env.AWDESK_TEST_BIN;
  const { agent } = agentWith();
  assert.equal(agent.claudePath, "claude", "tests see the bare name");
  assert.equal(agent.relayPath, "awrelay");
});

test("CommandAgent: fleet commands route to FleetControl and answer with the fleet's STATE", async () => {
  const fleet = fakeFleetControl();
  fleet.run = async () => ({ ok: true, fleet: { running: 0, masked: 171, units: 189, scope: "all" },
    vram: { used_mib: 1850, total_mib: 32607 }, held: true });
  const { agent } = agentWith({ fleetControl: fleet });
  const result = await agent.run("fleet status", { source: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "fleet");
  // The same words the Fleet window uses — never a bare "ok".
  assert.match(result.reply, /^DOWN — Fleet: 0 container\(s\) running, 171\/189 units masked/);
  const down = await agent.run("fleet down", { source: "test" });
  assert.match(down.reply, /^Fleet down: ok/);
});

test("CommandAgent: agent commands spawn claude headless with stream-json", async () => {
  const { agent, spawned } = agentWith({ claude: () => fakeChild({ stdout: claudeStream("Claude says: ok"), delay: 10 }) });
  const result = await agent.run("do something", { source: "test" });
  const claude = spawned.filter((s) => s.cmd === "claude");
  assert.equal(claude.length, 1, "spawned claude once");
  assert.equal(claude[0].args[0], "-p");
  const argsStr = claude[0].args.join(" ");
  assert.match(argsStr, /stream-json/);
  assert.match(argsStr, /append-system-prompt/);
  assert.match(String(claude[0].opts?.cwd), /AitherOS-Fresh/);
  assert.equal(result.ok, true);
  assert.equal(result.kind, "agent");
  assert.equal(result.reply, "Claude says: ok");
});

test("CommandAgent: parses Claude Code's REAL stream-json (assistant blocks + one result line)", async () => {
  const progress = [];
  const { agent } = agentWith({ claude: () => fakeChild({ stdout: claudeStream("PONG", { tools: ["Read"] }), delay: 10 }) });
  agent.on("progress", (p) => progress.push(p));
  const result = await agent.run("say pong", { source: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.reply, "PONG");
  assert.ok(progress.some((p) => p.phase === "run" && p.text === "[tool] Read"), "tool_use streams as progress");
  const mine = agent.history(5).find((i) => i.id === result.id);
  assert.ok(mine, "history carries the command");
  assert.equal(mine.text, "say pong");
  assert.equal(mine.reply, "PONG");
  assert.equal(mine.kind, "agent");
  assert.equal(mine.source, "test");
});

test("CommandAgent: serialises commands (second one queues, both run)", async () => {
  const { agent, spawned } = agentWith({ claude: () => fakeChild({ stdout: claudeStream("ok"), delay: 30 }) });
  const first = agent.run("first", { source: "test" });
  assert.equal(agent.queueLength, 0);
  const second = agent.run("second", { source: "test" });
  assert.equal(agent.queueLength, 1);
  await first;
  await second;
  assert.equal(spawned.filter((s) => s.cmd === "claude").length, 2, "both commands were spawned");
  assert.equal(agent.queueLength, 0);
});

test("CommandAgent: history is ONE item per command, newest last, honours limit", async () => {
  const { agent } = agentWith();
  await agent.run("cmd1", { source: "test" });
  await agent.run("cmd2", { source: "test" });
  await agent.run("cmd3", { source: "test" });
  const all = agent.history(50);
  assert.deepEqual(all.map((h) => h.text), ["cmd1", "cmd2", "cmd3"]);
  assert.ok(all.every((h) => h.reply === "ok"));
  assert.deepEqual(agent.history(2).map((h) => h.text), ["cmd2", "cmd3"]);
});

test("CommandAgent: claude stderr streams as progress; non-zero exit is a failure with the error as reply", async () => {
  const progress = [];
  const { agent } = agentWith({
    claude: () => fakeChild({ stdout: "", stderrLines: ["warning: something", "error: oops"], code: 1, delay: 10 }),
  });
  agent.on("progress", (p) => progress.push(p));
  const result = await agent.run("test", { source: "test" });
  assert.ok(progress.some((p) => p.text && p.text.includes("[stderr] error: oops")));
  assert.equal(result.ok, false);
  assert.equal(result.verdict.code, 1);
  assert.match(result.reply, /error: oops/);
});

test("CommandAgent: a relay that throws or dies never fails the command", async () => {
  const { agent } = agentWith({
    relay: () => { throw new Error("awrelay ENOENT"); },
  });
  const result = await agent.run("test", { source: "test" });
  assert.equal(result.ok, true, "command succeeds despite relay");
  const { agent: agent2 } = agentWith({ relay: () => fakeChild({ stdout: "", code: 1, delay: 2 }) });
  assert.equal((await agent2.run("test", { source: "test" })).ok, true);
});

test("CommandAgent: spawn ENOENT is a verdict, not a throw", async () => {
  const agent = new CommandAgent({
    fleetControl: fakeFleetControl(),
    transcriptFile: tmpTranscript(),
    spawnImpl: (cmd) => {
      if (cmd === "claude") {
        const child = fakeChild({ delay: 1000 });
        setTimeout(() => child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })), 2);
        return child;
      }
      return fakeChild({ stdout: "", code: 0, delay: 2 });
    },
  });
  const result = await agent.run("hello", { source: "test" });
  assert.equal(result.ok, false);
  assert.match(result.reply, /ENOENT/);
});

test("CommandAgent: the relay mirror is an [ack] carrying the REPLY, never an echo of the request; relay-sourced commands are not mirrored", async () => {
  const { agent, spawned } = agentWith();
  await agent.run("Reply with PONG", { source: "command-window" });
  await new Promise((r) => setTimeout(r, 10));
  const relaySends = spawned.filter((s) => s.cmd === "awrelay");
  assert.equal(relaySends.length, 1);
  const args = relaySends[0].args;
  assert.equal(args[0], "send");
  assert.equal(args[1], "#command");
  assert.match(args[2], /^\[ack\] ok/, "the body is the reply, ack-prefixed");
  assert.match(args[2], /re: Reply with PONG/);
  assert.notEqual(args[2].trim(), "Reply with PONG", "an echoed request would be re-executed by the relay poller");
  assert.deepEqual(args.slice(3), ["--kind", "ack"]);

  const { agent: fromRelay, spawned: spawned2 } = agentWith();
  await fromRelay.run("Reply with PONG", { source: "relay:#command:m1" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(spawned2.filter((s) => s.cmd === "awrelay").length, 0, "the poller acks in-thread; no second post");
});

test("CommandAgent: the relay mirror reports the relay's EXIT CODE, not merely that the process ended", async () => {
  // Until 2026-09-08 the close handler was `() => resolve({ ok: true })`, so a
  // failed post reported success. #command did not exist for most of a day and
  // every mirror to it read as delivered.
  const { agent: okAgent } = agentWith();
  const good = await okAgent._relayRequest("do a thing", "agent", { reply: "done", ok: true });
  assert.equal(good.ok, true, "a clean exit 0 is still a success");

  const { agent: badAgent } = agentWith({
    relay: () => fakeChild({ code: 1, stderrLines: ["awrelay: channel #command not found"], delay: 2 }),
  });
  const progress = [];
  badAgent.on("progress", (p) => progress.push(p.text));
  const bad = await badAgent._relayRequest("do a thing", "agent", { reply: "done", ok: true });
  assert.equal(bad.ok, false, "a non-zero exit must not report success");
  assert.equal(bad.reason, "exit");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /channel #command not found/, "the reason travels with the verdict");
  assert.ok(progress.some((t) => /ack NOT posted/.test(t)),
    "a silent failure is the defect -- the owner must see it in the window");

  // Killed by a signal is a failure too: code is null there, and the old
  // `code == null` shortcut would have called it a pass.
  const { agent: killed } = agentWith({
    relay: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => child.emit("close", null, "SIGTERM"), 2);
      return child;
    },
  });
  const sig = await killed._relayRequest("do a thing", "agent", { reply: "done", ok: true });
  assert.equal(sig.ok, false, "a killed relay did not post");
  assert.equal(sig.reason, "signal");
});
