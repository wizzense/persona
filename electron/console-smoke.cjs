"use strict";

/**
 * Does the console actually RENDER? — a real Electron run that exits by itself.
 *
 * Every other test here is static: it reads the source and asserts a shape. None
 * of them can see the failure this file exists for, because the console's whole
 * design lives in things that only exist at runtime — whether the preload reaches
 * a SUB-FRAME, whether the CSP lets a pane load at all, whether a bridge is
 * actually on `window` inside the frame. All three fail as a BLANK RECTANGLE:
 * no exception, no failed require, no red test, just a pane that renders nothing
 * and a console that looks broken the first time the owner opens it.
 *
 * It is its own Electron entry point, so it never touches the running Desk (no
 * single-instance lock, no tray, no avatar), it writes to a throwaway userData
 * directory so it cannot clobber the real profile, and it QUITS — verification
 * that has to be killed by hand is verification nobody runs twice.
 *
 *   npx electron electron/console-smoke.cjs      (exit 0 pass, 1 fail, 2 could not judge)
 *
 * Not in `npm test`: `node --test` cannot host it, and a CI box has no display.
 *
 * Expected noise: `No handler registered for 'desk:deck-get-state'` (and friends).
 * Those belong to main.cjs, which this entry point deliberately does not load --
 * loading it would take the single-instance lock away from the running Desk. The
 * pane bridges asserted below are the ones the CONSOLE is responsible for.
 */

const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const { showConsole, PANES, paneSources } = require("./console-window.cjs");
const { ensureCommandIpc } = require("./command-window.cjs");
const { ensureFleetIpc, getControl: getFleetControl } = require("./fleet-window.cjs");
const { ensureSessionsIpc } = require("./sessions-window.cjs");
const { ensureStageIpc } = require("./stage-window.cjs");

const results = [];
let judged = true;

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail || "" });
}

/** Every pane the console offers, and the bridge its page must be able to see. */
const EXPECTED_BRIDGE = {
  command: "command",
  fleet: "fleet",
  sessions: "aitherSessions",
  cards: "deskBridge",
  chat: "deskBridge",
  stage: "aitherStage",
  // The Cast pane (cast.html / cast-preload.cjs): who appears and how they sound.
  cast: "aitherCast",
};

async function run() {
  // A throwaway profile: this must never write into the real Desk's userData.
  app.setPath("userData", path.join(os.tmpdir(), "desk-console-smoke"));

  const sources = paneSources(require("node:url")
    .pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href);
  const opened = [];
  const stubWindow = (id) => ({
    open: () => opened.push(id),
    close: () => opened.splice(opened.indexOf(id), 1),
    isOpen: () => opened.includes(id),
  });

  // Exactly what main.cjs's openConsole does, and the reason it does it: both
  // pane pages call main the moment they load. Without this the first run printed
  // "No handler registered for 'desk:command-history'" and "…'desk:fleet-status'"
  // -- the very failure that would have shipped a Command pane which throws on
  // the first Enter and a Fleet pane of em-dashes.
  ensureFleetIpc();
  ensureCommandIpc(getFleetControl(), { createFleetWindow: () => {} });
  ensureSessionsIpc();
  // Stubbed the way main wires it: the pane must ANSWER, not merely have a bridge.
  ensureStageIpc({
    bodies: () => [{ slotId: "slot0", name: "Aither", agent: "aither", resident: true }],
    arrange: () => {},
    focus: () => {},
    remove: () => { throw new Error("slot0 is not a removable body"); },
  });

  const paletteRan = [];
  const win = showConsole({
    autoShow: false,
    // main.cjs supplies these from the command registry; here they are stubbed,
    // because this entry point must never load main (it would take the running
    // Desk's single-instance lock).
    commands: {
      list: () => [
        { id: "window.size.large", label: "Large", group: "window-size" },
        { id: "console.open", label: "Aither Console…", group: "go" },
      ],
      run: (id) => paletteRan.push(id),
    },
    rendererUrl: require("node:url")
      .pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href,
    windows: Object.fromEntries(PANES.map((p) => [p.id, stubWindow(p.id)])),
    urls: { desktop: () => "about:blank" },
  });

  // 🚩 The COLD path, exactly as main takes it: open the console and name a pane in
  // the same breath ("Chat with <agent>…", "Cast & voices…", a card arriving). The
  // request used to lose to start()'s own select(panes[0]) and the owner got Inbox.
  // Sent at dom-ready on purpose: the shell's start() is then BETWEEN its two awaits
  // (panes loaded, detached not yet), which is where the live desk delivers it --
  // main's IPC is slower there than in this harness. focusPane() alone arrives
  // after start() here, and an arm that cannot lose the race cannot fail: reverting
  // the fix left this check green until the send moved here (mutation-verified).
  win.webContents.once("dom-ready", () => {
    win.webContents.send("desk:console-focus", { pane: "cast", param: null });
  });

  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));

  // Read the SETTLED selection, not the first one: the bug is start() selecting the
  // first pane AFTER the requested one was shown, so an early read sees the right
  // tab a moment before it is replaced (that early read is why this arm first
  // stayed green with the fix reverted).
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const landed = await win.webContents.executeJavaScript(
    "(document.querySelector('.tab[aria-selected=\"true\"]') || {}).id || ''");
  check("a pane asked for during a COLD open is the pane that opens", landed === "tab-cast",
    `selected = ${landed || "(nothing)"}`);

  // 1. The shell itself came up and got its own bridge.
  const shell = await win.webContents.executeJavaScript(
    "({ bridge: typeof window.aitherConsole, tabs: document.querySelectorAll('.tab').length })",
  );
  check("shell has its bridge", shell.bridge === "object", `typeof = ${shell.bridge}`);
  check("rail lists every pane", shell.tabs === PANES.length,
    `${shell.tabs} tabs vs ${PANES.length} panes`);

  // 2. Each framed pane loads AND sees its own bridge. This is the assertion no
  //    static test can make: nodeIntegrationInSubFrames either injected the
  //    preload into that frame or the pane is a rectangle with no error.
  for (const pane of PANES) {
    if (pane.kind === "hosted") continue;
    await win.webContents.executeJavaScript(
      `document.getElementById('tab-${pane.id}').click()`,
    );
    // POLL for the frame rather than sleeping once. command.html is two files and
    // appears instantly; the renderer bundle is a three.js app off file://, and a
    // fixed sleep that is generous for one is a false "no sub-frame was created"
    // for the other -- a timing artifact reported as a broken pane.
    // 🚩 Match the frame by its URL. The first version took the first sub-frame it
    // found and therefore asserted command.html FOUR TIMES, reporting three
    // failures that were its own bug -- a test that always looks at the same
    // frame proves one pane and slanders the rest.
    // 🚩 The FULL src, query included. Stripping the query made cards and chat --
    // one bundle, two flags -- match the same frame, so the chat arm reported the
    // cards frame and passed without ever looking at chat. A matcher that cannot
    // tell two panes apart proves one of them twice.
    const wantUrl = String(sources.find((p) => p.id === pane.id).src)
      .replace(/^\.\//, "");
    const findFrame = () => win.webContents.mainFrame.framesInSubtree
      .filter((f) => f !== win.webContents.mainFrame)
      .find((f) => String(f.url || "").toLowerCase().includes(wantUrl.toLowerCase()));
    let frame = null;
    for (let i = 0; i < 40 && !frame; i += 1) {
      frame = findFrame();
      if (!frame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!frame) {
      const urls = win.webContents.mainFrame.framesInSubtree
        .filter((f) => f !== win.webContents.mainFrame)
        .map((f) => String(f.url || "<blank>").slice(0, 60));
      check(`${pane.id}: frame exists`, false,
        `wanted ${wantUrl.slice(-40)} - saw [${urls.join(", ") || "none"}]`);
      continue;
    }
    const want = EXPECTED_BRIDGE[pane.id];
    let seen;
    try {
      seen = await frame.executeJavaScript(`typeof window.${want}`);
    } catch (error) {
      seen = `<${String((error && error.message) || error).slice(0, 60)}>`;
    }
    check(`${pane.id}: window.${want} reached the frame`, seen === "object",
      `typeof = ${seen} · ${String(frame.url).slice(0, 70)}`);
  }

  // 3. The pane's bridge is not merely PRESENT, it ANSWERS. A bridge whose main
  //    handler was never registered looks identical from the frame -- the object
  //    is there, the method is there, and the call rejects at runtime.
  await win.webContents.executeJavaScript("document.getElementById('tab-command').click()");
  await new Promise((resolve) => setTimeout(resolve, 800));
  const cmdFrame = win.webContents.mainFrame.framesInSubtree
    .find((f) => String(f.url || "").includes("command.html"));
  if (!cmdFrame) {
    check("command pane answers", false, "the command frame vanished");
  } else {
    const answer = await cmdFrame.executeJavaScript(
      "window.command.history(1).then(() => 'ok').catch((e) => String(e && e.message || e))",
    );
    check("command pane's handler is registered", answer === "ok", String(answer).slice(0, 90));
  }

  // 3b. The Sessions pane's handler must ANSWER, not merely exist -- same
  //     lesson as the command arm above. Daemon-down is fine: ok:false with a
  //     note is an ANSWER; "No handler registered" is not.
  await win.webContents.executeJavaScript("document.getElementById('tab-sessions').click()");
  await new Promise((resolve) => setTimeout(resolve, 600));
  const sesFrame = win.webContents.mainFrame.framesInSubtree
    .find((f) => String(f.url || "").includes("sessions.html"));
  if (!sesFrame) {
    check("sessions pane answers", false, "the sessions frame vanished");
  } else {
    const answer = await sesFrame.executeJavaScript(
      "window.aitherSessions.list().then((r) => (r && typeof r.ok === 'boolean') ? 'ok' : String(r))"
      + ".catch((e) => 'ERR ' + String(e && e.message || e))",
    );
    check("sessions pane's handler is registered", answer === "ok", String(answer).slice(0, 90));
  }

  // 3d. The Stage pane must ANSWER too -- its whole purpose is to be the path
  //     that works when hitting a 3D body with the mouse does not.
  await win.webContents.executeJavaScript("document.getElementById('tab-stage').click()");
  await new Promise((resolve) => setTimeout(resolve, 600));
  const stageFrame = win.webContents.mainFrame.framesInSubtree
    .find((f) => String(f.url || "").includes("stage.html"));
  if (!stageFrame) {
    check("stage pane answers", false, "the stage frame vanished");
  } else {
    const seen = await stageFrame.executeJavaScript(
      "window.aitherStage.bodies().then((r) => (r && r.ok ? 'rows:' + r.bodies.length : JSON.stringify(r)))"
      + ".catch((e) => 'ERR ' + String(e && e.message || e))",
    );
    check("stage pane's handler is registered", seen === "rows:1", String(seen).slice(0, 90));
    const rendered = await stageFrame.executeJavaScript(
      "({ rows: document.querySelectorAll('#list .row').length,"
      + " arrangements: document.querySelectorAll('#arrangements .chip').length })",
    );
    check("stage pane lists the bodies and the arrangements",
      rendered.rows === 1 && rendered.arrangements === 5, JSON.stringify(rendered));
  }

  // 3c. The Fleet pane must SAY what it is doing. Its first probe walks the
  //     distro, seven doors and the GPU counters (24-73 s measured 2026-09-18),
  //     and the owner's 07:20 screenshot that day was the pane mid-probe: a grey
  //     UNKNOWN pill over four "?", read as broken. Whatever this run sees --
  //     the probe in flight, a verdict, or a refusal -- it must not be the bare
  //     placeholder, and a pill that says PROBING must not claim the GPU is free.
  await win.webContents.executeJavaScript("document.getElementById('tab-fleet').click()");
  await new Promise((resolve) => setTimeout(resolve, 800));
  const fleetFrame = win.webContents.mainFrame.framesInSubtree
    .find((f) => String(f.url || "").includes("fleet-control.html"));
  if (!fleetFrame) {
    check("fleet pane says what it is doing", false, "the fleet frame vanished");
  } else {
    const seen = await fleetFrame.executeJavaScript(
      "({ pill: document.getElementById('pill').textContent,"
      + " state: document.getElementById('pill').dataset.state,"
      + " running: document.getElementById('s-running').textContent,"
      + " hold: document.getElementById('s-hold').textContent })",
    );
    const placeholder = seen.pill === "…" || seen.state === "UNKNOWN" || seen.running === "–";
    check("fleet pane says what it is doing", !placeholder, JSON.stringify(seen));
    check("fleet pane never paints 'free' before a verdict",
      seen.state !== "PROBING" || (seen.hold === "probing…" && seen.running === "probing…"),
      JSON.stringify(seen));
  }

  // 4. Detach/reattach really drives main's window creators -- driven through the
  //    BUTTONS the owner clicks, not the preload bridge. The bridge reaches main
  //    and repaints NOTHING, so a smoke run that calls it proves only half the
  //    trip: "ok:true, and the screen never changed" is the whole complaint.
  const stageState = "({ placeholders: document.querySelectorAll('.placeholder.active').length,"
    + " placeholderNode: Boolean(document.getElementById('ph-fleet')),"
    + " frame: Boolean(document.querySelector('#pane-fleet.active')),"
    + " state: document.getElementById('bar-state').textContent,"
    + " badge: document.querySelector('#tab-fleet .badge').textContent })";

  await win.webContents.executeJavaScript("document.getElementById('btn-detach').click()");
  await new Promise((resolve) => setTimeout(resolve, 900));
  check("detach is reported back", opened.includes("fleet"), opened.join(","));
  const whileOut = await win.webContents.executeJavaScript(stageState);
  check("a detached pane paints its placeholder, and only that",
    whileOut.placeholders === 1 && whileOut.frame === false
    && whileOut.state === "detached" && whileOut.badge === "detached",
    JSON.stringify(whileOut));

  // 🚩 And on the way back, the SCREEN changes. Owner, 2026-09-18: "i did reattach
  //    the inbox but it didnt update the ui". Two defects made that one symptom:
  //    main read its detached list before the asynchronous close had landed, and
  //    the shell left the placeholder -- absolutely positioned over the whole
  //    stage -- painted on top of the pane that had come back. Neither is visible
  //    in an ok:true reply, which is why this arm reads the DOM.
  await win.webContents.executeJavaScript("document.getElementById('btn-reattach').click()");
  await new Promise((resolve) => setTimeout(resolve, 900));
  check("reattach closes the window", !opened.includes("fleet"), opened.join(","));
  const afterBack = await win.webContents.executeJavaScript(stageState);
  check("reattach puts the pane back ON SCREEN",
    afterBack.placeholders === 0 && afterBack.placeholderNode === false
    && afterBack.frame === true && afterBack.state !== "detached"
    && afterBack.badge !== "detached",
    JSON.stringify(afterBack));

  // 5. 🚩 The window goes away WITHOUT the console being told (the owner closing a
  //    detached window from its own title bar). The rail used to keep saying
  //    "detached" until the console next regained focus, offering a Reattach that
  //    closes nothing -- the pane was stranded with no way back. Slice 2 gives the
  //    map one owner in main, which pushes it; nothing here touches the console.
  await win.webContents.executeJavaScript("document.getElementById('btn-detach').click()");
  await new Promise((resolve) => setTimeout(resolve, 900));
  const beforeExternal = await win.webContents.executeJavaScript(stageState);
  // Closed from OUTSIDE: no IPC, no focus, nothing tells the console.
  const at = opened.indexOf("fleet");
  if (at >= 0) opened.splice(at, 1);
  await new Promise((resolve) => setTimeout(resolve, 2500));   // one poll + slack
  const afterExternal = await win.webContents.executeJavaScript(stageState);
  check("a detached window closed from OUTSIDE un-detaches the rail",
    beforeExternal.state === "detached" && afterExternal.state !== "detached"
    && afterExternal.placeholders === 0 && afterExternal.frame === true,
    `${JSON.stringify(beforeExternal)} -> ${JSON.stringify(afterExternal)}`);

  // 6. The palette: Ctrl+K, type, Enter. This is the path that makes a gesture
  //    optional -- the failure it answers is "the size menu exists, somewhere,
  //    behind a right-click that has to land on a body".
  await win.webContents.executeJavaScript(
    "document.dispatchEvent(new KeyboardEvent('keydown', "
    + "{ key: 'k', ctrlKey: true, bubbles: true }))",
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const opened2 = await win.webContents.executeJavaScript(
    "({ open: document.getElementById('scrim').classList.contains('open'),"
    + " rows: document.querySelectorAll('#palette-list li').length })",
  );
  check("Ctrl+K opens the palette with the registry's rows",
    opened2.open === true && opened2.rows === 2, JSON.stringify(opened2));

  // Typing narrows it, and Enter runs what is selected.
  await win.webContents.executeJavaScript(
    "(() => { const i = document.getElementById('palette-input');"
    + " i.value = 'larg'; i.dispatchEvent(new Event('input', { bubbles: true })); })()",
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const filtered = await win.webContents.executeJavaScript(
    "({ rows: [...document.querySelectorAll('#palette-list li span:first-child')]"
    + ".map((n) => n.textContent) })",
  );
  check("typing filters the palette", filtered.rows.length === 1 && filtered.rows[0] === "Large",
    JSON.stringify(filtered));

  await win.webContents.executeJavaScript(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))",
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const closedAfterRun = await win.webContents.executeJavaScript(
    "document.getElementById('scrim').classList.contains('open')",
  );
  check("Enter runs the command and closes the palette",
    paletteRan.length === 1 && paletteRan[0] === "window.size.large" && closedAfterRun === false,
    `${paletteRan.join(",") || "nothing ran"} · open=${closedAfterRun}`);
}

app.whenReady().then(run).catch((error) => {
  judged = false;
  check("smoke run completed", false, String((error && error.stack) || error));
}).finally(() => {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    process.stdout.write(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.detail ? ` -- ${r.detail}` : ""}\n`);
  }
  process.stdout.write(`\nCONSOLE SMOKE: ${failed.length ? "FAIL" : "ok"} `
    + `(${results.length - failed.length}/${results.length})\n`);
  // 2 = could not judge, never 0 on silence: a run that never reached its
  // assertions must not read as a healthy console.
  app.exit(!judged ? 2 : failed.length ? 1 : 0);
});
