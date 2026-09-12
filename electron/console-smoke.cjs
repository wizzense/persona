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

  const win = showConsole({
    autoShow: false,
    rendererUrl: require("node:url")
      .pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href,
    windows: Object.fromEntries(PANES.map((p) => [p.id, stubWindow(p.id)])),
    urls: { desktop: () => "about:blank" },
  });

  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));

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

  // 4. Detach/reattach really drives main's window creators.
  const detach = await win.webContents.executeJavaScript(
    "window.aitherConsole.detach('fleet')",
  );
  check("detach reaches main", detach && detach.ok === true, JSON.stringify(detach));
  check("detach is reported back", opened.includes("fleet"), opened.join(","));
  const reattach = await win.webContents.executeJavaScript(
    "window.aitherConsole.reattach('fleet')",
  );
  check("reattach closes the window", reattach && reattach.ok === true
    && !opened.includes("fleet"), opened.join(","));
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
