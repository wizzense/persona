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
  // The count is asserted so a pane cannot be DROPPED by an edit that only meant
  // to reorder the rail; bump it deliberately when one is added.
  assert.equal(panes.length, 10);  // Plan: Settings pane added 2026-09-22
  for (const pane of panes) {
    if (pane.kind !== "file") continue;
    assert.ok(
      fs.existsSync(path.join(HERE, pane.file)),
      `${pane.id} names ${pane.file}, which does not exist`,
    );
    assert.equal(pane.src, `./${pane.file}`);
  }
});

test("the rail is in this exact order -- a drop or a reorder must fail here", () => {
  // Listed explicitly rather than derived from PANES, so an edit that silently
  // drops or reshuffles an entry is caught here instead of only downstream.
  assert.deepEqual(PANES.map((p) => p.id),
    ["cards", "command", "fleet", "sessions", "chat", "stage", "cast", "settings",
    "characters", "desktop"]);
});

test("the Cast pane is a FILE pane, src resolved the same in dev-server and file:// modes", () => {
  // Unlike a `kind: "view"` pane, a file pane's src never depends on the
  // renderer base -- it must be non-null whether the desk is pointed at the
  // vite dev server or a packaged file:// bundle.
  const dev = paneSources("http://127.0.0.1:5173").find((p) => p.id === "cast");
  const packaged = paneSources("file:///d/dist/index.html").find((p) => p.id === "cast");
  assert.equal(dev.kind, "file");
  assert.equal(dev.src, "./cast.html");
  assert.equal(packaged.src, "./cast.html");
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

test("detach opens the pane's own window; reattach closes it", async () => {
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
  const detached = await callWindow("fleet", "open");
  assert.equal(detached.ok, true);
  assert.deepEqual(detached.detached, ["fleet"]);

  const back = await callWindow("fleet", "close");
  assert.equal(back.ok, true);
  assert.deepEqual(back.detached, []);
  assert.deepEqual(calls, ["open", "close"]);
});

test("detachedIds()/callWindow accept the new cast id, same as any other pane", async () => {
  // U28 (main.cjs, LAST in the plan) is what supplies the real window: this
  // arm proves the rail's own machinery treats "cast" like any other pane id
  // rather than needing a special case, independent of that later wiring.
  let castOpen = false;
  __setWindowsForTest({
    cast: {
      open: () => { castOpen = true; },
      close: () => { castOpen = false; },
      isOpen: () => castOpen,
    },
  });

  assert.deepEqual(detachedIds(), []);
  const detached = await callWindow("cast", "open");
  assert.equal(detached.ok, true);
  assert.deepEqual(detached.detached, ["cast"]);

  const back = await callWindow("cast", "close");
  assert.equal(back.ok, true);
  assert.deepEqual(back.detached, []);
  __setWindowsForTest({});
});

test("a reattach reply describes the windows AFTER the close lands", async () => {
  // Electron's BrowserWindow.close() is asynchronous: isOpen() answers true for
  // at least one turn afterwards. Read on the next line, the reply named the pane
  // as still detached, and the shell painted the placeholder back over a pane that
  // had in fact come home -- the owner's "I reattached the Inbox and the UI did
  // not update".
  let open = false;
  __setWindowsForTest({
    cards: {
      open: () => { open = true; },
      close: () => { setTimeout(() => { open = false; }, 60); },
      isOpen: () => open,
    },
  });

  await callWindow("cards", "open");
  assert.deepEqual(detachedIds(), ["cards"]);

  const back = await callWindow("cards", "close");
  assert.equal(back.ok, true);
  assert.deepEqual(back.detached, [], "the pane is back; the reply must say so");
  __setWindowsForTest({});
});

test("a window that refuses to close still answers, bounded", async () => {
  // The wait is bounded on purpose: a stuck window must not hang the rail, and
  // the reply must report what is TRUE rather than what was asked for.
  __setWindowsForTest({
    fleet: { open: () => {}, close: () => {}, isOpen: () => true },
  });
  const started = Date.now();
  const back = await callWindow("fleet", "close");
  assert.equal(back.ok, true);
  assert.deepEqual(back.detached, ["fleet"], "it never closed -- say so");
  assert.ok(Date.now() - started < 5000, "the settle wait must be bounded");
  __setWindowsForTest({});
});

test("a missing target reports, and a throwing creator never escapes", async () => {
  __setWindowsForTest({
    fleet: { open: () => { throw new Error("boom"); }, close: () => {}, isOpen: () => false },
  });
  const missing = await callWindow("cards", "open");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no open target for pane cards/);

  const threw = await callWindow("fleet", "open");
  assert.equal(threw.ok, false);
  assert.equal(threw.error, "boom");
  __setWindowsForTest({});
});

test("the shell DESTROYS a reattached pane's placeholder, not just its class", () => {
  // The placeholder is position:absolute over the whole stage. Leaving it in the
  // DOM with .active hides the pane that just came back.
  const html = read("console.html");
  assert.match(html, /if \(!isDetached && stale\) stale\.remove\(\);/);
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
  for (const dep of ["./command-preload.cjs", "./fleet-preload.cjs", "./cast-preload.cjs", "./preload.cjs"]) {
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

test("a pane asked for while the console is cold-opening is HELD, not replaced by Inbox", () => {
  // Owner-facing: "Chat with <agent>…" / "Cast & voices…" with the console closed
  // opened it on INBOX. The focus message beat start() (dropped: `panes` was empty),
  // or start() selected panes[0] over it. Measured live 2026-09-20 through
  // POST /console/open {"pane":"chat"} against a closed console.
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "console.html"), "utf8");
  assert.match(html, /if \(!started\) \{ pendingFocus = payload; return; \}/, "an early focus request is dropped again");
  const start = html.slice(html.indexOf("(async function start()"));
  assert.match(start, /started = true;[\s\S]*?if \(!applyFocus\(pendingFocus\) && panes\.length\) select\(panes\[0\]\.id\);/,
    "start() must honour the held request before falling back to the first pane");
  assert.doesNotMatch(start, /\n {2}if \(panes\.length\) select\(panes\[0\]\.id\);/, "start() selects the first pane unconditionally again");
});
