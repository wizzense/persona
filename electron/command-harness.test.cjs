"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { parseAddress, runHarnessCommand, installHarnessBackend } = require("./command-harness.cjs");

test("parseAddress: a leading @agent and /skill are addresses; the rest is the prompt", () => {
  assert.deepEqual(parseAddress("@saga /skill teaser-video make a 20 s teaser"), {
    agent: "saga", skill: "teaser-video", skillArguments: "make a 20 s teaser", prompt: "make a 20 s teaser",
  });
  assert.deepEqual(parseAddress("/skill gauntlet @Atlas run it"), {
    agent: "atlas", skill: "gauntlet", skillArguments: "run it", prompt: "run it",
  });
  const plain = parseAddress("email bob@example.com about /tmp");
  assert.equal(plain.agent, "", "an @ inside the sentence is text");
  assert.equal(plain.skill, "");
  assert.equal(plain.prompt, "email bob@example.com about /tmp");
});

/** A fake daemon: records every request, serves a scripted event log. */
function fakeDaemon({ createStatus = 200, createDetail = "", events = [], state = "running" } = {}) {
  const calls = [];
  const pages = Array.isArray(events[0]) ? events : [events];
  let page = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} });
    const json = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
    if (/\/sessions$/.test(url)) {
      return createStatus === 200 ? json(200, { id: "sess-1" }) : json(createStatus, { detail: createDetail });
    }
    if (/\/submit$/.test(url)) return json(200, { ok: true, turn: 1, seq: 0 });
    if (/\/events\?since=/.test(url)) {
      const evs = pages[Math.min(page, pages.length - 1)] || [];
      page += 1;
      return json(200, { events: evs, last_seq: evs.length ? evs[evs.length - 1].seq : 0, state });
    }
    return json(404, { detail: `unexpected ${url}` });
  };
  return { fetchImpl, calls };
}

const noSleep = async () => {};

test("the POST carries agent, skill and the owner's prompt; deltas become the reply", async () => {
  const d = fakeDaemon({
    events: [
      { seq: 1, kind: "tool.call", tool: "file_read" },
      { seq: 2, kind: "text.delta", text: "Teaser " },
      { seq: 3, kind: "text.delta", text: "drafted." },
      { seq: 4, kind: "turn.completed" },
    ],
  });
  const rows = [];
  const r = await runHarnessCommand("@saga /skill teaser-video make a 20 s teaser", {
    fetchImpl: d.fetchImpl, token: "t", daemon: "http://d", emit: (p) => rows.push(p), sleep: noSleep,
  });
  const create = d.calls.find((c) => /\/sessions$/.test(c.url));
  assert.equal(create.method, "POST");
  assert.equal(create.body.agent, "saga");
  assert.equal(create.body.skill, "teaser-video");
  assert.equal(create.body.skill_arguments, "make a 20 s teaser");
  assert.equal(create.body.harness, "awdk");
  assert.equal(create.headers.Authorization, "Bearer t");
  assert.match(create.body.system_prompt_append, /decision card/);
  const submit = d.calls.find((c) => /\/submit$/.test(c.url));
  assert.deepEqual(submit.body, { text: "make a 20 s teaser", submit: true });
  assert.equal(r.ok, true);
  assert.equal(r.reply, "Teaser drafted.");
  assert.equal(r.session, "sess-1");
  assert.ok(rows.some((p) => p.text === "[tool] file_read"), "a tool call is a progress row");
  assert.ok(rows.some((p) => /\[session\] awdk\/saga sess-1/.test(p.text)), "the session is named where the owner looks");
});

test("daemon down is a rendered reply, never a throw", async () => {
  const fetchImpl = async () => { const e = new Error("fetch failed"); e.cause = { code: "ECONNREFUSED" }; throw e; };
  const r = await runHarnessCommand("do a thing", { fetchImpl, token: "t", daemon: "http://d", sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.reply, /daemon unreachable \(ECONNREFUSED\)/);
  assert.match(r.reply, /adk harness serve/);
  assert.equal(r.session, null);
});

test("an unknown agent surfaces the daemon's 400 with the roster", async () => {
  const d = fakeDaemon({ createStatus: 400, createDetail: "unknown agent(s) ['bogus']; roster: aither, atlas, saga" });
  const r = await runHarnessCommand("@bogus hi", { fetchImpl: d.fetchImpl, token: "t", daemon: "http://d", sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.reply, /refused the session \(400\)/);
  assert.match(r.reply, /roster: aither, atlas, saga/);
});

test("no token is an honest reply naming the token path", async () => {
  const r = await runHarnessCommand("hi", { fetchImpl: async () => { throw new Error("must not be called"); }, token: "", sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.reply, /harness_token/);
});

test("a session that exits without text is ok:false with the reason; an error event is reported", async () => {
  let d = fakeDaemon({ events: [{ seq: 1, kind: "session.exited", data: { exit_code: 1 } }] });
  let r = await runHarnessCommand("hi", { fetchImpl: d.fetchImpl, token: "t", daemon: "http://d", sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.reply, /answered nothing/);
  d = fakeDaemon({ events: [{ seq: 1, kind: "error", text: "model 502" }, { seq: 2, kind: "turn.completed" }] });
  r = await runHarnessCommand("hi", { fetchImpl: d.fetchImpl, token: "t", daemon: "http://d", sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.reply, /model 502/);
});

test("installHarnessBackend routes only the agent lane and tags progress with the id", async () => {
  const d = fakeDaemon({ events: [{ seq: 1, kind: "text.delta", text: "done" }, { seq: 2, kind: "turn.completed" }] });
  const agent = new EventEmitter();
  agent._handleAgentCommand = async () => { throw new Error("the claude lane must be replaced"); };
  installHarnessBackend(agent, { fetchImpl: d.fetchImpl, token: "t", daemon: "http://d", sleep: noSleep });
  const rows = [];
  agent.on("progress", (p) => rows.push(p));
  const r = await agent._handleAgentCommand("id-9", "@atlas hello");
  assert.equal(agent.commandBackend, "harness");
  assert.equal(r.id, "id-9");
  assert.equal(r.reply, "done");
  assert.ok(rows.length > 0 && rows.every((p) => p.id === "id-9"));
});
