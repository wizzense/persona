"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  PANES,
  callWindow,
  detachedIds,
  paneSources,
  __setWindowsForTest,
} = require("./console-window.cjs");

const HERE = __dirname;
const read = (name) => fs.readFileSync(path.join(HERE, name), "utf8");

test("every pane resolves to a page that exists", () => {
  const panes = paneSources("http://127.0.0.1:5173");
  assert.equal(panes.length, 6);
  for (const pane of panes) {
    if (pane.kind !== "file") continue;
    assert.ok(
      fs.existsSync(path.join(HERE, pane.file)),
      `${pane.id} names ${pane.file}, which does not exist`,
    );
    assert.equal(pane.src, `./${pane.file}`);
  }
});

test("view panes carry the renderer base and their own query flag", () => {
  const byId = Object.fromEntries(paneSources("http://127.0.0.1:5173").map((p) => [p.id, p]));
  assert.equal(byId.cards.src, "http://127.0.0.1:5173?deck=1");
  assert.equal(byId.chat.src, "http://127.0.0.1:5173?chat=1");

  // A base that already carries a query keeps it.
  const withQuery = Object.fromEntries(paneSources("file:///d/dist/index.html?x=1")
    .map((p) => [p.id, p]));
  assert.equal(withQuery.cards.src, "file:///d/dist/index.html?x=1&deck=1");
});

test("the Desktop pane is HOSTED, never framed -- that is what carries the login", () => {
  const desktop = paneSources("http://127.0.0.1:5173").find((p) => p.id === "desktop");
  assert.equal(desktop.kind, "hosted");
  assert.equal(desktop.src, null, "a hosted pane must give the shell no iframe src");
  assert.equal(desktop.hosted, true);
  // The partition is the whole reason it is hosted: an iframe would inherit the
  // console's session and render signed-out beside a signed-in standalone window.
  assert.equal(desktop.partition, "persist:living-desktop");
  const source = fs.readFileSync(path.join(HERE, "living-desktop-window.cjs"), "utf8");
  assert.match(source, /partition:\s*PARTITION/);
  assert.match(source, /PARTITION\s*=\s*"persist:living-desktop"/);
});

test("an EMPTY renderer base is refused, never concatenated", () => {
  // Guard against the self-nesting bug: "" + "?deck=1" is a RELATIVE url, so the
  // pane would load console.html into itself, recursively, with no error at all.
  const byId = Object.fromEntries(paneSources("").map((p) => [p.id, p]));
  assert.equal(byId.cards.src, null);
  assert.ok(byId.cards.unavailable, "an unresolvable pane must say why");
  // File panes are unaffected -- they never depended on the renderer.
  assert.equal(byId.command.src, "./command.html");
});

test("detach opens the pane's own window; reattach closes it", () => {
  const calls = [];
  let fleetOpen = false;
  __setWindowsForTest({
    fleet: {
      open: () => { calls.push("open"); fleetOpen = true; },
      close: () => { calls.push("close"); fleetOpen = false; },
      isOpen: () => fleetOpen,
    },
  });

  assert.deepEqual(detachedIds(), []);
  const detached = callWindow("fleet", "open");
  assert.equal(detached.ok, true);
  assert.deepEqual(detached.detached, ["fleet"]);

  const back = callWindow("fleet", "close");
  assert.equal(back.ok, true);
  assert.deepEqual(back.detached, []);
  assert.deepEqual(calls, ["open", "close"]);
});

test("a missing target reports, and a throwing creator never escapes", () => {
  __setWindowsForTest({
    fleet: { open: () => { throw new Error("boom"); }, close: () => {}, isOpen: () => false },
  });
  const missing = callWindow("cards", "open");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no open target for pane cards/);

  const threw = callWindow("fleet", "open");
  assert.equal(threw.ok, false);
  assert.equal(threw.error, "boom");
  __setWindowsForTest({});
});

test("EVERY pane is reachable from main, both directions", () => {
  // The rail is only honest if main really injected open/close/isOpen for each
  // pane id. A pane with no close is a detach button with no way back -- the exact
  // failure the console exists to remove.
  const main = read("main.cjs");
  const block = main.slice(main.indexOf("function openConsole()"));
  for (const pane of PANES) {
    const entry = block.slice(block.indexOf(`${pane.id}: {`));
    assert.ok(block.includes(`${pane.id}: {`), `openConsole names no window for ${pane.id}`);
    for (const verb of ["open:", "close:", "isOpen:"]) {
      assert.ok(
        entry.slice(0, 500).includes(verb),
        `openConsole's ${pane.id} entry is missing ${verb}`,
      );
    }
  }
});

test("the console preload COMPOSES the pane preloads, never copies them", () => {
  // deskBridge alone is 20 verbs. A hand-copied bridge drifts, and a pane would
  // then behave differently inside the console than in its detached window.
  const preload = read("console-preload.cjs");
  for (const dep of ["./command-preload.cjs", "./fleet-preload.cjs", "./preload.cjs"]) {
    assert.ok(preload.includes(`require("${dep}")`), `console-preload must require ${dep}`);
  }
  // Exactly one namespace of its own; the other three come from the files above.
  const exposed = [...preload.matchAll(/exposeInMainWorld\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(exposed, ["aitherConsole"]);
});

test("sub-frame preload injection is on, or every pane is a blank rectangle", () => {
  const source = read("console-window.cjs");
  assert.match(source, /nodeIntegrationInSubFrames:\s*true/);
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /setWindowOpenHandler/);
});

test("console.html frames the panes and nothing else", () => {
  const html = read("console.html");
  const csp = /content="([^"]*frame-src[^"]*)"/.exec(html);
  assert.ok(csp, "console.html must declare a CSP with frame-src");
  assert.match(csp[1], /default-src 'none'/);
  assert.match(csp[1], /frame-src [^;"]*file:/);
  // Both halves of the mode are present in the shell.
  assert.match(html, /btn-detach/);
  assert.match(html, /btn-reattach/);
});

test("openConsole wires the pane handlers BEFORE it shows the window", () => {
  // Both pane pages talk to main the moment they load -- fleet-control.html probes
  // on load, command.html sends on the first Enter -- and those handlers used to be
  // installed only as a side effect of creating the STANDALONE window. Opening the
  // console first gave a Fleet pane of em-dashes (identical to a fleet that is
  // genuinely down) and a Command pane that threw "No handler registered". Both
  // surfaces look finished and answer nothing, which is why this is asserted on
  // ORDER and not merely on presence.
  const main = read("main.cjs");
  const block = main.slice(main.indexOf("function openConsole()"));
  const show = block.indexOf("showConsole({");
  for (const call of ["ensureFleetIpc()", "ensureCommandIpc("]) {
    const at = block.indexOf(call);
    assert.ok(at !== -1, `openConsole must call ${call}`);
    assert.ok(at < show, `${call} must run before showConsole`);
  }
  // A pane's own close button has no standalone window to close; without a
  // fallback it is a dead control that reports nothing.
  assert.ok(block.indexOf("setFleetCloseFallback(closeConsole)") < show);
  assert.ok(block.indexOf("setCommandCloseFallback(closeConsole)") < show);
});

test("a hosted pane is hidden by a rect of NULL, not by being left painted", () => {
  // A WebContentsView is painted by main over the shell, so hiding it is main's
  // job. If the shell only reported a rect when a pane was showing, switching away
  // would leave the desktop view sitting on top of whichever pane came next.
  const html = read("console.html");
  assert.match(html, /aitherConsole\.stage\(pane\.id, null\)/);
  assert.match(html, /addEventListener\("resize"/);
  const source = read("console-window.cjs");
  assert.match(source, /partition: pane\.partition/);
  assert.match(source, /removeChildView/);
});
