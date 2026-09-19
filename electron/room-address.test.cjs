"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { labelFor, labelledBodies, resolveAddress } = require("./room-address.cjs");

//: The measured shape of room `main` on this box: two parallel Claude Code tabs
//: of the SAME repo, so both bodies carry the author "AitherOS-Fresh" and only
//: the session id and the /sessions/unified title tell them apart. Every arm
//: below exists because a picker keyed on the author name offers these two as
//: one entry.
const TABS = [
  {
    slotId: "room-aitheros-fresh-a345",
    agent: "AitherOS-Fresh",
    actorId: "a345ec92-9f90-4f8d-80f9-a77f30b3d8de",
    actorKind: "claude_code",
    title: "plan 40 desk slices",
  },
  {
    slotId: "room-aitheros-fresh-b777",
    agent: "AitherOS-Fresh",
    actorId: "b7770f31-2a61-4c55-9f02-1c6e2b9ad401",
    actorKind: "claude_code",
    title: "gate lanes wiring",
  },
];

test("the title wins over the author name, because every tab shares the author", () => {
  assert.equal(labelFor(TABS[0]), "plan 40 desk slices");
  assert.equal(labelFor(TABS[1]), "gate lanes wiring");
  // Untitled (the daemon never saw the tab): the id4 keeps the two apart.
  const untitled = TABS.map((b) => ({ ...b, title: "" }));
  assert.equal(labelFor(untitled[0]), "AitherOS-Fresh (a345)");
  assert.notEqual(labelFor(untitled[0]), labelFor(untitled[1]));
});

test("two identically-titled bodies still get DISTINCT picker labels", () => {
  const same = TABS.map((b) => ({ ...b, title: "AitherOS-Fresh" }));
  const [one, two] = labelledBodies(same);
  assert.notEqual(one.label, two.label);
  assert.equal(one.to, TABS[0].actorId);
  assert.equal(two.to, TABS[1].actorId);
});

test("same author, different sessions: an ordinal addresses each tab, never one of them twice", () => {
  const first = resolveAddress("hey one, what are you on?", TABS);
  const second = resolveAddress("hey two, what are you on?", TABS);
  assert.equal(first.to, TABS[0].actorId);
  assert.equal(second.to, TABS[1].actorId);
  assert.notEqual(first.to, second.to);
  assert.equal(first.reason, "");
  assert.equal(second.tier, "ordinal");
  assert.equal(second.label, "gate lanes wiring");
  // "first"/"second" and "@2" are the same address.
  assert.equal(resolveAddress("hey second, ping", TABS).to, TABS[1].actorId);
  assert.equal(resolveAddress("@2 ping", TABS).to, TABS[1].actorId);
});

test("same author, different sessions: a title substring addresses each tab", () => {
  const a = resolveAddress("hey plan 40, how far along?", TABS);
  const b = resolveAddress("hey gate lanes, how far along?", TABS);
  assert.equal(a.to, TABS[0].actorId);
  assert.equal(b.to, TABS[1].actorId);
  assert.notEqual(a.to, b.to);
  assert.equal(a.tier, "title-substring");
});

test("an @token matching a slot id resolves; a bare slot id does too", () => {
  const at = resolveAddress("@room-aitheros-fresh-b777 rebase onto develop", TABS);
  assert.equal(at.to, TABS[1].actorId);
  assert.equal(at.tier, "slot-id");
  assert.equal(at.rest, "rebase onto develop");

  const bare = resolveAddress("room-aitheros-fresh-a345 status?", TABS);
  assert.equal(bare.to, TABS[0].actorId);
  assert.equal(bare.rest, "status?");

  // A session id, and a >=4 char prefix of one, are also addresses.
  assert.equal(resolveAddress(`@${TABS[0].actorId} go`, TABS).to, TABS[0].actorId);
  assert.equal(resolveAddress("@a345ec92 go", TABS).to, TABS[0].actorId);
});

test("a title substring matching two bodies REFUSES and hands back both candidates", () => {
  const twinned = [
    { ...TABS[0], title: "plan 40 desk slices" },
    { ...TABS[1], title: "plan 40 room spine" },
  ];
  const r = resolveAddress("hey plan 40, status?", twinned);
  assert.equal(r.to, null);
  assert.equal(r.reason, "ambiguous");
  assert.equal(r.candidates.length, 2);
  assert.deepEqual(r.candidates.map((c) => c.to), [twinned[0].actorId, twinned[1].actorId]);
  assert.deepEqual(r.candidates.map((c) => c.label), ["plan 40 desk slices", "plan 40 room spine"]);
});

test("the shared author name is itself ambiguous — it addresses nothing", () => {
  const r = resolveAddress("@AitherOS-Fresh ship it", TABS);
  assert.equal(r.to, null);
  assert.equal(r.reason, "ambiguous");
  assert.equal(r.candidates.length, 2);
});

test('"hey nobody" refuses and names the candidate labels', () => {
  const r = resolveAddress("hey nobody, what now?", TABS);
  assert.equal(r.to, null);
  assert.equal(r.label, "");
  assert.equal(r.reason, "unknown");
  assert.deepEqual(r.candidates.map((c) => c.label), ["plan 40 desk slices", "gate lanes wiring"]);
  // Nothing was recognised as an address, so the message is handed back whole.
  assert.equal(r.rest, "hey nobody, what now?");
});

test("prose with no salutation is never turned into an address", () => {
  // "rebase" is not a slot or session id, and the loose tiers (agent/title
  // substring) must not apply to a bare leading word.
  const r = resolveAddress("rebase the aitheros branch please", TABS);
  assert.equal(r.to, null);
  assert.equal(r.reason, "unknown");
});

test("rest excludes the address and preserves the message verbatim, punctuation included", () => {
  const message = "please rebase onto develop — now, not later?";
  assert.equal(resolveAddress(`@two, ${message}`, TABS).rest, message);
  assert.equal(resolveAddress(`hey plan 40: ${message}`, TABS).rest, message);
  assert.equal(resolveAddress(`@room-aitheros-fresh-a345 ${message}`, TABS).rest, message);
  // Address only: an empty message, not the salutation echoed back.
  assert.equal(resolveAddress("@one", TABS).rest, "");
});

test("a matched body with no session id is a refusal, not a send into the void", () => {
  const relayOnly = [{ slotId: "room-lyra", agent: "lyra", actorId: "", actorKind: "relay", title: "" }];
  const r = resolveAddress("@room-lyra are you there?", relayOnly);
  assert.equal(r.to, null);
  assert.equal(r.reason, "no-session");
  assert.equal(r.label, "lyra");
  assert.equal(r.candidates.length, 1);
  assert.equal(r.rest, "are you there?");
});

test("an empty stage and an empty message refuse with their own reasons", () => {
  assert.equal(resolveAddress("hey one, go", []).reason, "no-bodies");
  assert.equal(resolveAddress("", TABS).reason, "no-address");
  assert.equal(resolveAddress(null, TABS).reason, "no-address");
  assert.deepEqual(resolveAddress("   ", TABS).candidates.length, 2);
});
