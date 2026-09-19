"use strict";

/**
 * fleet-control.html's render loop, run against a paper DOM.
 *
 * The page's presentation had no test, and it shipped three lies in a row:
 * a grey UNKNOWN pill over four "?" for the whole first probe (owner screenshot
 * 2026-09-18 07:20, read as "fleet info still busted" while a 24-73 s probe was
 * simply in flight), "GPU hold: free" painted from NO verdict (`null && x`), and
 * a "probing…" that stayed up after the verdict landed because the flag was
 * cleared after render. console-smoke.cjs can only see the pane come up; it
 * cannot hold the probe still to look at the pane mid-flight. This can.
 *
 * The script is lifted out of the html and run under `vm` over the smallest
 * document that satisfies it -- ids, dataset, classList, innerHTML/textContent,
 * children. If the page grows a DOM call this document lacks, the test throws
 * at load, which is the right failure: it means the page is asserted nowhere.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HTML = fs.readFileSync(path.join(__dirname, "fleet-control.html"), "utf8");

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.className = "";
    this.id = "";
    this.title = "";
    this.disabled = false;
    this.scrollTop = 0;
    this.listeners = {};
    this._text = "";
    this.classList = classListOf(this);
  }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children[this.children.length - 1] ?? null; }
  get scrollHeight() { return 0; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parent = null; return child; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(v) { this.children = []; this._text = String(v).replace(/<[^>]*>/g, ""); }
  get innerHTML() { return this._text; }
  querySelector(sel) {
    if (!sel.startsWith(".")) return null;
    return this.children.find((c) => c.classList.contains(sel.slice(1))) ?? null;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
}

/** A classList over `className`, the four verbs the page uses. */
function classListOf(el) {
  const read = () => new Set(el.className.split(/\s+/).filter(Boolean));
  const write = (set) => { el.className = [...set].join(" "); };
  const list = {
    add(c) { const s = read(); s.add(c); write(s); },
    remove(c) { const s = read(); s.delete(c); write(s); },
    contains(c) { return read().has(c); },
    toggle(c, force) {
      const on = force === undefined ? !list.contains(c) : Boolean(force);
      if (on) list.add(c); else list.remove(c);
      return on;
    },
  };
  return list;
}

function byId(id, tag = "div") { const e = new Element(tag); e.id = id; return e; }

/** Load the page's script over a fresh paper document with a controllable `window.fleet`. */
function mount({ status } = {}) {
  const ids = {};
  for (const id of ["log", "pill", "s-running", "s-masked", "s-vram", "s-hold", "holders", "surfaces", "hint"]) {
    ids[id] = byId(id);
  }
  ids.pill.dataset.state = "UNKNOWN";
  ids.pill.textContent = "…";
  for (const box of ["holders", "surfaces"]) ids[box].appendChild(new Element("div")); // the .k caption
  const actions = [];
  for (const [id, action] of [["b-down", "down"], ["b-up", "up"], ["b-gaming", "gaming"], ["b-resume", "resume"]]) {
    const b = byId(id, "button");
    b.dataset.action = action;
    const d = new Element("span"); d.className = "d"; d.textContent = `desc ${action}`;
    b.appendChild(d);
    ids[id] = b;
    actions.push(b);
  }
  ids["b-refresh"] = byId("b-refresh", "button");
  ids["b-adopt"] = byId("b-adopt", "button");

  const calls = [];
  const fleet = {
    status: (opts) => { calls.push(opts); return status ? status(opts) : Promise.resolve(null); },
    run: () => Promise.resolve({ ok: true }),
    onProgress: () => () => {},
    close: () => {},
    open: () => {},
  };
  const document = {
    getElementById: (id) => ids[id] ?? null,
    querySelectorAll: (sel) => (sel === "button[data-action]" ? actions : []),
    createElement: (tag) => new Element(tag),
    addEventListener: () => {},
  };
  const intervals = [];
  const sandbox = {
    document,
    window: { fleet },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 1; },
    setTimeout,
    clearTimeout,
    console,
  };
  const script = /<script>([\s\S]*?)<\/script>/.exec(HTML);
  assert.ok(script, "fleet-control.html has one inline script");
  vm.runInNewContext(script[1], vm.createContext(sandbox), { filename: "fleet-control.html" });
  const text = (id) => ids[id].textContent;
  return { ids, calls, intervals, text, pill: ids.pill, logLines: () => ids.log.children.map((c) => c.textContent) };
}

const GOOD = () => ({
  ok: true,
  fleet: { running: 145, units: 212, masked: 0 },
  held: false,
  vram: { used_mib: 31973, total_mib: 32607 },
  gpu_holders: [{ pid: 4242, gib: 7.1, name: "ComfyUI", hint: "SDXL" }],
  surfaces: [{ label: "Pulse", url: "https://pulse.example", up: true, ms: 12, detail: "HTTP 200" }],
  state: {},
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("first probe in flight: pill PROBING (BUSY's family), every counter says probing…, never free", async () => {
  let release;
  const page = mount({ status: () => new Promise((resolve) => { release = resolve; }) });
  await tick();
  assert.equal(page.pill.dataset.state, "PROBING");
  assert.equal(page.pill.textContent, "PROBING");
  assert.match(HTML, /#pill\[data-state="PROBING"\]\s*\{[^}]*#3b82f6/, "PROBING is styled in BUSY's blue");
  for (const id of ["s-running", "s-masked", "s-vram", "s-hold"]) {
    assert.equal(page.text(id), "probing…", `${id} while the first probe runs`);
    assert.ok(page.ids[id].classList.contains("probing"), `${id} carries the probing class`);
  }
  assert.notEqual(page.text("s-hold"), "free", "render(null) must never claim the GPU is free");
  assert.match(page.text("holders"), /probing…/);
  assert.match(page.text("surfaces"), /probing…/);
  assert.ok(page.logLines().some((l) => /probing the fleet/.test(l)), "the log says a probe started");
  // JSON, not deepEqual: the opts object was built in the vm realm and carries its Object.prototype.
  assert.equal(JSON.stringify(page.calls), JSON.stringify([{ maxAgeMs: 0 }]), "the first probe is forced fresh");

  // The verdict lands: every placeholder is replaced, in the same paint.
  release(GOOD());
  await tick(); await tick();
  assert.equal(page.pill.dataset.state, "UP");
  assert.equal(page.pill.textContent, "UP");
  assert.equal(page.text("s-running"), "145");
  assert.equal(page.text("s-masked"), "0 / 212");
  assert.equal(page.text("s-vram"), "31.2 / 32 GiB");
  assert.equal(page.text("s-hold"), "free");
  for (const id of ["s-running", "s-masked", "s-vram", "s-hold"]) {
    assert.ok(!page.ids[id].classList.contains("probing"), `${id} dropped the probing class`);
  }
  assert.match(page.text("holders"), /7\.10 GiB.*ComfyUI \(pid 4242\)/);
  assert.doesNotMatch(page.text("holders"), /probing/);
  assert.match(page.text("surfaces"), /Pulse/);
  assert.doesNotMatch(page.text("surfaces"), /probing/);
  assert.equal(page.text("hint"), "auto-refresh every 30 s");
});

test("a verdict without host enrichment does not leave probing… behind (flag cleared before paint)", async () => {
  const bare = GOOD();
  delete bare.gpu_holders;
  delete bare.surfaces;
  const page = mount({ status: () => Promise.resolve(bare) });
  await tick(); await tick();
  assert.equal(page.pill.textContent, "UP");
  assert.doesNotMatch(page.text("holders"), /probing/);
  assert.match(page.text("holders"), /not in this verdict/);
  assert.doesNotMatch(page.text("surfaces"), /probing/);
});

test("held fleet: GPU hold reads HELD and the pill GPU QUIET", async () => {
  const st = GOOD(); st.held = true;
  const page = mount({ status: () => Promise.resolve(st) });
  await tick(); await tick();
  assert.equal(page.text("s-hold"), "HELD");
  assert.equal(page.pill.textContent, "GPU QUIET");
});

test("cannotJudge with no stale verdict: pill CANNOT JUDGE, counters ?, hold ?, the error in the log", async () => {
  const page = mount({ status: () => Promise.resolve({ ok: false, cannotJudge: true, error: "the Debian distro did not answer" }) });
  await tick(); await tick();
  assert.equal(page.pill.dataset.state, "CANNOT JUDGE");
  assert.equal(page.pill.textContent, "CANNOT JUDGE");
  for (const id of ["s-running", "s-masked", "s-vram", "s-hold"]) assert.equal(page.text(id), "?", id);
  assert.ok(page.logLines().some((l) => /CANNOT JUDGE: the Debian distro did not answer/.test(l)));
  assert.match(HTML, /#pill\[data-state="CANNOT JUDGE"\]/, "CANNOT JUDGE has its own style");
});

test("cannotJudge WITH a stale verdict: pill STALE, the old numbers with their age, hold from the old verdict", async () => {
  const page = mount({
    status: () => Promise.resolve({
      ok: false, cannotJudge: true, error: "podman ps timed out",
      stale: { age_ms: 42_000, at: 1, reason: "podman ps timed out", verdict: GOOD() },
    }),
  });
  await tick(); await tick();
  assert.equal(page.pill.dataset.state, "STALE");
  assert.match(page.text("s-running"), /^145 · 42 s ago$/);
  assert.equal(page.text("s-hold"), "free");
  assert.ok(page.logLines().some((l) => /STALE \(42 s old/.test(l)));
});

test("the IPC itself rejecting is a CANNOT JUDGE verdict, not a pane stuck on probing…", async () => {
  const page = mount({ status: () => Promise.reject(new Error("No handler registered for 'desk:fleet-status'")) });
  await tick(); await tick();
  assert.equal(page.pill.textContent, "CANNOT JUDGE");
  assert.equal(page.text("s-running"), "?");
  assert.ok(page.logLines().some((l) => /No handler registered/.test(l)));
});

test("a later refresh keeps the last numbers up and says refreshing… in the hint, not PROBING", async () => {
  let n = 0;
  let release;
  const page = mount({
    status: () => (n++ === 0 ? Promise.resolve(GOOD()) : new Promise((resolve) => { release = resolve; })),
  });
  await tick(); await tick();
  assert.equal(page.pill.textContent, "UP");
  assert.equal(page.intervals.length, 1, "one auto-refresh timer");
  page.intervals[0].fn();
  await tick();
  assert.equal(page.pill.textContent, "UP", "the pill keeps the last verdict during a re-probe");
  assert.equal(page.text("s-running"), "145");
  assert.equal(page.text("hint"), "refreshing…");
  const st = GOOD(); st.fleet.running = 140;
  release(st);
  await tick(); await tick();
  assert.equal(page.text("s-running"), "140");
  assert.equal(page.text("hint"), "auto-refresh every 30 s");
});
