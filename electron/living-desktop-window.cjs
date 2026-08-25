"use strict";

/** The AitherOS Living Desktop as a REAL desktop overlay — not a browser tab.
 *
 *  History, so nobody rebuilds the failures:
 *  - Attempt 1 loaded https://portal.aitherium.com in a framed BrowserWindow and rendered
 *    BLANK WHITE: portal. is auth-gated, a fresh webContents has no cookies, and the
 *    login redirect renders nothing.
 *  - Attempt 2 punted to shell.openExternal — explicitly rejected by the owner ("I don't
 *    want it opening a browser window, I want a desktop overlay").
 *  - This version loads the PUBLIC Living OS shell at https://aitherium.com/?mode=overlay
 *    (the GitHub Pages static export — renders with NO session, and `mode=overlay` is
 *    the shell's own first-party transparent mode, the exact one AitherConnect embeds
 *    in-browser) into a full-work-area frameless transparent window, so the Living OS
 *    chrome floats over the real Windows desktop.
 *
 *  Session: partition "persist:living-desktop" — any login done inside the shell's own
 *  iframed app windows (portal./relay./…) persists across restarts. One login, kept.
 *
 *  Verification is honest by construction: did-fail-load and a capturePage uniformity
 *  probe are appended to %TEMP%/desk-living-desktop.log on the one real window the
 *  owner opens. No extra diagnostic windows are ever spawned (owner-banned).
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { BrowserWindow, ipcMain, screen, session, shell } = require("electron");

const BASE_URL = process.env.LIVING_DESKTOP_URL || "https://aitherium.com/";
const LOG_FILE = path.join(os.tmpdir(), "desk-living-desktop.log");

/** `?mode=overlay` is the Living OS's OWN first-party overlay mode (Veil
 *  `src/components/os/overlay-mode.ts` — the exact mode AitherConnect embeds): it skips
 *  the boot greeter, sets `html.aither-os-overlay` whose CSS is
 *  `background: transparent !important`, and goes straight to the desktop stage. No
 *  hand-rolled wallpaper-strip CSS needed — the shell renders transparent by design. */
function urlFor(transparent) {
  try {
    const url = new URL(BASE_URL);
    if (transparent) url.searchParams.set("mode", "overlay");
    else url.searchParams.delete("mode");
    if (shellId) url.searchParams.set("shell", shellId);
    else url.searchParams.delete("shell");
    return url.href;
  } catch {
    return BASE_URL;
  }
}

/** The Living OS swappable-shell plane (Veil shell-registry.tsx): the overlay can run
 *  any registered shell. Unknown ids fall back to the Living Desktop server-side, so a
 *  stale entry here degrades gracefully rather than blanking the overlay. */
const SHELL_CHOICES = [
  { id: null, label: "Living Desktop (default)" },
  { id: "aither-desktop", label: "Desktop Anywhere" },
  { id: "aither-shell", label: "AitherShell cockpit" },
  { id: "gobbonet", label: "GobboNet" },
];
let shellId = null;

function setShell(id) {
  shellId = id;
  if (isOpen()) void desktopWin.loadURL(urlFor(transparentMode));
  else showLivingDesktop();
}

const PARTITION = "persist:living-desktop";
const PORTAL_LOGIN_URL = "https://portal.aitherium.com/login";

let desktopWin = null; // the singleton overlay window
let transparentMode = true; // owner-facing toggle; survives close/reopen within a run
let ghostMode = true; // click-through everywhere the Living OS isn't drawing

// ── Ghost mode (click-through) ─────────────────────────────────────────────────
// The overlay page reports its interactive hit-rects (see living-desktop-preload.cjs);
// a main-process poll flips setIgnoreMouseEvents by cursor position. Fail-INTERACTIVE:
// if no regions report arrived recently (page changed, solid mode, protocol drift) the
// whole window stays clickable — a silently un-clickable Living OS would read as
// "just broken", which is worse than losing click-through.
const hitState = { regions: [], dock: null, reportedAt: 0 };
const REGIONS_FRESH_MS = 5000;
const REGION_PAD = 8;
let ghostTimer = null;
let ignoringMouse = false;

ipcMain.on("living-desktop:regions", (event, payload) => {
  if (!isOpen() || event.sender !== desktopWin.webContents) return;
  hitState.regions = payload.regions;
  hitState.dock = payload.dock;
  hitState.reportedAt = Date.now();
});

function cursorOverInteractive() {
  if (Date.now() - hitState.reportedAt > REGIONS_FRESH_MS) return true; // fail-interactive
  const bounds = desktopWin.getContentBounds();
  const cursor = screen.getCursorScreenPoint();
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return false;
  const dock = hitState.dock;
  if (dock && typeof dock.thickness === "number") {
    const t = dock.thickness + REGION_PAD;
    if (
      (dock.edge === "bottom" && y >= bounds.height - t) ||
      (dock.edge === "top" && y <= t) ||
      (dock.edge === "left" && x <= t) ||
      (dock.edge === "right" && x >= bounds.width - t)
    ) {
      return true;
    }
  }
  for (const r of hitState.regions) {
    if (
      x >= r.x - REGION_PAD &&
      x <= r.x + r.w + REGION_PAD &&
      y >= r.y - REGION_PAD &&
      y <= r.y + r.h + REGION_PAD
    ) {
      return true;
    }
  }
  return false;
}

function applyGhostTick() {
  if (!isOpen() || !desktopWin.isVisible()) return;
  const shouldInteract = !ghostMode || !transparentMode || cursorOverInteractive();
  const shouldIgnore = !shouldInteract;
  if (shouldIgnore !== ignoringMouse) {
    ignoringMouse = shouldIgnore;
    // forward:true keeps mousemove flowing to the page while ignored, so Living OS
    // hover states still track even in the pass-through areas.
    desktopWin.setIgnoreMouseEvents(shouldIgnore, { forward: true });
  }
}

function startGhostLoop() {
  if (ghostTimer) return;
  ghostTimer = setInterval(applyGhostTick, 60);
}

function stopGhostLoop() {
  if (ghostTimer) {
    clearInterval(ghostTimer);
    ghostTimer = null;
  }
  if (isOpen() && ignoringMouse) {
    ignoringMouse = false;
    desktopWin.setIgnoreMouseEvents(false);
  }
}

// ── Session (why the shell shows "sign in" instead of david@) ─────────────────────
// This window is its OWN browser profile (the persist: partition) — the login living in
// the owner's normal Chrome never reaches it. One sign-in INSIDE the overlay sets
// aither_auth_token on Domain=.aitherium.com in the partition and persists 30 days.
async function hasSessionCookie() {
  try {
    const cookies = await session
      .fromPartition(PARTITION)
      .cookies.get({ name: "aither_auth_token" });
    return cookies.some((c) => (c.domain || "").includes("aitherium.com") && c.value);
  } catch (err) {
    log(`cookie check failed: ${err}`);
    return false;
  }
}

// ── Automatic session link (owner-approved 2026-08-25) ─────────────────────────────
// The owner runs the FLEET on this box and the vault holds the platform's portal
// session token (AITHER_PORTAL_TOKEN — the token portal login mints). Injecting it as
// aither_auth_token into this partition makes the overlay shell render signed-in with
// no login click, and it refreshes every time the overlay opens. The token is
// materialized with the sanctioned vault reader (--to-file, never stdout) into a temp
// file read and deleted here — the value never reaches a transcript, a log, or an env
// var.
const PORTAL_TOKEN_FILE = path.join(os.tmpdir(), "desk-portal-token");
// The vault reader executes in the DISTRO (WSL) and refuses Windows-style --to-file
// targets ("C:/... is a relative directory named C:") — hand it the same physical
// file via its /mnt/c spelling; main reads and deletes it by the Windows path.
const PORTAL_TOKEN_FILE_DISTRO =
  "/mnt/c/" + PORTAL_TOKEN_FILE.replace(/\\/g, "/").replace(/^[A-Za-z]:\//, "");
const VAULT_READER = "C:\\AitherOS-Fresh\\AitherOS\\dev\\tools\\aither_secret.py";
async function syncPortalSessionCookie() {
  if (await hasSessionCookie()) return;
  // Cap the reader wait: opening the overlay must never stall on a slow/hung
  // vault — the window just renders signed-out and the next open retries.
  await new Promise((resolve) => {
    const { spawn } = require("node:child_process");
    const child = spawn(
      "python",
      [VAULT_READER, "AITHER_PORTAL_TOKEN", "--to-file", PORTAL_TOKEN_FILE_DISTRO],
      { stdio: "ignore", windowsHide: true },
    );
    const cap = setTimeout(() => {
      log("portal token reader exceeded 5s — opening signed-out, will retry next open");
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve();
    }, 5000);
    child.on("exit", () => {
      clearTimeout(cap);
      resolve();
    });
    child.on("error", () => {
      clearTimeout(cap);
      resolve();
    });
  });
  try {
    const token = fs.readFileSync(PORTAL_TOKEN_FILE, "utf-8").trim();
    fs.unlinkSync(PORTAL_TOKEN_FILE);
    if (!token) return;
    await session.fromPartition(PARTITION).cookies.set({
      url: "https://aitherium.com",
      name: "aither_auth_token",
      value: token,
      domain: ".aitherium.com",
      path: "/",
      secure: true,
      httpOnly: true,
    });
    log("portal session token injected into overlay partition (from vault)");
  } catch (err) {
    log(`portal token sync failed: ${err}`);
    try {
      fs.unlinkSync(PORTAL_TOKEN_FILE);
    } catch {
      /* already gone */
    }
  }
}

let signInPoll = null;
function beginSignIn() {
  if (!isOpen()) showLivingDesktop();
  void desktopWin.loadURL(PORTAL_LOGIN_URL);
  // Portal's open-redirect guard strips foreign returnUrls, so instead of trusting a
  // bounce-back we watch for the cookie to appear and return to the overlay ourselves.
  if (signInPoll) clearInterval(signInPoll);
  const startedAt = Date.now();
  signInPoll = setInterval(async () => {
    if (!isOpen() || Date.now() - startedAt > 10 * 60 * 1000) {
      clearInterval(signInPoll);
      signInPoll = null;
      return;
    }
    if (await hasSessionCookie()) {
      clearInterval(signInPoll);
      signInPoll = null;
      log("sign-in detected (aither_auth_token set in partition) — returning to overlay");
      if (isOpen()) void desktopWin.loadURL(urlFor(transparentMode));
    }
  }, 2000);
}

function log(line) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break the overlay */
  }
}

function isAitheriumFamily(rawUrl) {
  try {
    const { protocol, hostname } = new URL(rawUrl);
    if (protocol !== "https:") return false;
    return hostname === "aitherium.com" || hostname.endsWith(".aitherium.com");
  } catch {
    return false;
  }
}

function isOpen() {
  return Boolean(desktopWin && !desktopWin.isDestroyed());
}

/** Blank-page probe on the REAL window: capture and measure pixel spread. The attempt-1
 *  failure mode was a uniformly white page that every "did it load" signal called
 *  healthy — only looking at the pixels separates "rendered the Living OS" from
 *  "rendered nothing". Appended to the log, never popped up anywhere. */
async function probeRendered(win) {
  try {
    const image = await win.webContents.capturePage();
    const { width, height } = image.getSize();
    if (!width || !height) {
      log("PROBE: capturePage returned an empty image — cannot judge");
      return;
    }
    const bitmap = image.toBitmap(); // BGRA
    let min = 255;
    let max = 0;
    let opaque = 0;
    const stride = 4 * 97; // sample ~1/97 of pixels — cheap and plenty
    for (let i = 0; i + 3 < bitmap.length; i += stride) {
      const lum = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
      if (bitmap[i + 3] > 8) opaque += 1;
    }
    const spread = max - min;
    const verdict =
      spread < 8 && opaque > 0
        ? `SUSPECT-BLANK (uniform lum ${min.toFixed(0)}..${max.toFixed(0)})`
        : `RENDERED (lum spread ${spread.toFixed(0)}, sampled opaque px ${opaque})`;
    log(`PROBE ${win.webContents.getURL()} -> ${verdict}`);
  } catch (err) {
    log(`PROBE failed: ${err}`);
  }
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    // NOT alwaysOnTop: the avatar windows are alwaysOnTop and must float ABOVE the
    // Living Desktop, the way they float above everything else.
    skipTaskbar: false, // a real surface the owner alt-tabs to and can close from the taskbar
    title: "AitherOS Living Desktop",
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, "living-desktop-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep the overlay inside the aitherium family; anything else goes to the system
  // browser instead of hijacking the overlay surface.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAitheriumFamily(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAitheriumFamily(targetUrl)) {
      event.preventDefault();
      void shell.openExternal(targetUrl);
    }
  });

  win.webContents.on("did-fail-load", (_e, code, desc, failedUrl, isMainFrame) => {
    if (isMainFrame) log(`did-fail-load ${failedUrl}: ${code} ${desc}`);
  });
  win.webContents.on("did-finish-load", () => {
    // Local-node probing consent (owner-approved 2026-08-25): the shell's detector
    // (Veil local-node-optin.ts) only probes loopback after an explicit opt-in, and
    // this overlay partition starts with none — so the owner's own shell "detects no
    // local services" while the fleet runs on the same box. Desk is the owner's own
    // installed app on the owner's own machine: opening the Living Desktop FROM Desk
    // is the explicit act, so grant it here per load. (The probes still need the
    // adk/awnode loopback ports to be UP; granting only removes the consent gate, it
    // cannot invent a service.)
    win.webContents
      .executeJavaScript(
        "try{localStorage.setItem('aither-local-node-probe-optin','1')}catch(e){}; true;",
      )
      .catch(() => {});
    setTimeout(() => {
      if (!win.isDestroyed()) void probeRendered(win);
    }, 4000);
    // Push the Desk snapshot once the shell has booted its listeners.
    setTimeout(() => {
      if (!win.isDestroyed()) pushDeskState();
    }, 2000);
  });

  // Frameless window needs a way out that doesn't depend on the page: Esc hides it.
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") hideLivingDesktop();
  });

  win.on("closed", () => {
    stopGhostLoop();
    desktopWin = null;
  });
  win.on("show", startGhostLoop);
  win.on("hide", stopGhostLoop);

  const target = urlFor(transparentMode);
  log(`opening ${target} (transparent=${transparentMode}, ghost=${ghostMode})`);
  // Link the session BEFORE the first paint so the shell never flashes signed-out.
  void (async () => {
    await syncPortalSessionCookie();
    if (win.isDestroyed()) return;
    await win.loadURL(target);
    void hasSessionCookie().then((signedIn) =>
      log(signedIn ? "session cookie present — shell will see the signed-in account" : "NO session cookie — shell renders signed-out; use Sign in from the Living Desktop menu"),
    );
  })();
  startGhostLoop();
  return win;
}

function showLivingDesktop() {
  if (isOpen()) {
    desktopWin.show();
    desktopWin.focus();
    return desktopWin;
  }
  desktopWin = createWindow();
  return desktopWin;
}

function hideLivingDesktop() {
  if (isOpen()) desktopWin.hide();
}

function toggleLivingDesktop() {
  if (isOpen() && desktopWin.isVisible()) {
    hideLivingDesktop();
  } else {
    showLivingDesktop();
  }
}

function setSolidBackground(solid) {
  transparentMode = !solid;
  // Overlay-vs-solid is the page's own `?mode=overlay` switch, so flipping it is a
  // reload with the other URL — not a CSS patch that drifts with Veil deploys.
  if (isOpen()) void desktopWin.loadURL(urlFor(transparentMode));
}

/** Menu fragment for main.cjs's avatar/tray menus — built fresh on every popup so the
 *  labels and checkbox reflect live state. */
function buildLivingDesktopMenu() {
  return [
    {
      label: isOpen() && desktopWin.isVisible() ? "Hide overlay" : "Open overlay",
      click: () => toggleLivingDesktop(),
    },
    {
      label: "Shell",
      submenu: SHELL_CHOICES.map((choice) => ({
        label: choice.label,
        type: "radio",
        checked: shellId === choice.id,
        click: () => setShell(choice.id),
      })),
    },
    {
      label: "Click-through desktop (ghost mode)",
      type: "checkbox",
      checked: ghostMode,
      click: () => {
        ghostMode = !ghostMode;
        applyGhostTick();
      },
    },
    {
      label: "Sign in (portal)…",
      click: () => beginSignIn(),
    },
    {
      label: "Solid background",
      type: "checkbox",
      checked: !transparentMode,
      click: () => setSolidBackground(transparentMode),
    },
    {
      label: "Reload",
      enabled: isOpen(),
      click: () => {
        if (isOpen()) desktopWin.webContents.reload();
      },
    },
    {
      label: "Close",
      enabled: isOpen(),
      click: () => {
        if (isOpen()) desktopWin.close();
      },
    },
  ];
}

// ── Desk -> Living OS state channel ──────────────────────────────────────────────
// main.cjs registers a snapshot provider (decision cards, avatar slots, agents,
// relay feed); the overlay receives the latest snapshot on every load and whenever
// main calls pushDeskState(). The page-side listener is the Veil OS
// (overlay-host/os-client listens for { __aither: 'desk-state' } postMessages —
// the same family as the os-regions protocol the preload already relays).
let deskStateProvider = null;
function setDeskStateProvider(fn) {
  deskStateProvider = fn;
}
function pushDeskState() {
  if (!isOpen() || typeof deskStateProvider !== "function") return;
  const snapshot = deskStateProvider();
  if (!snapshot) return;
  desktopWin.webContents.send("living-desktop:desk-state", snapshot);
}

module.exports = {
  openLivingDesktop: showLivingDesktop, // kept for older callers
  showLivingDesktop,
  hideLivingDesktop,
  toggleLivingDesktop,
  setSolidBackground,
  buildLivingDesktopMenu,
  setDeskStateProvider,
  pushDeskState,
  isOpen,
  LOG_FILE,
};
