"use strict";

/**
 * cdp-client — the one CDP connection the desk's probes share.
 *
 *   const { connect, avatarTarget } = require("./cdp-client.cjs");
 *   const cdp = await connect(await avatarTarget(9223));
 *   await cdp.send("Runtime.enable"); const v = await cdp.evaluate("1+1"); cdp.close();
 *
 * Node 22+ (global WebSocket, global fetch). Read-only by convention: the
 * probes evaluate and sample; they never mutate the page.
 */

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  if (!res.ok) throw new Error(`CDP /json answered ${res.status}`);
  return res.json();
}

/** The AVATAR window: the page on dist/index.html with no query (?deck / ?chat / ?solo are other windows). */
async function avatarTarget(port) {
  const pages = (await listTargets(port)).filter((t) => t.type === "page");
  const avatar = pages.find((t) => /index\.html$/.test(String(t.url).split("?")[0]) && !String(t.url).includes("?"));
  if (!avatar) throw new Error("no avatar page target (is the desk running with DESK_CDP_PORT?)");
  return avatar.webSocketDebuggerUrl;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      for (const fn of listeners) fn(msg);
    });
    ws.addEventListener("error", (e) => reject(new Error(e.message || "websocket error")));
    ws.addEventListener("open", () => {
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          const msgId = ++id;
          pending.set(msgId, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      resolve({
        send,
        on: (fn) => listeners.add(fn),
        close: () => ws.close(),
        async evaluate(expression) {
          const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "evaluate failed");
          return r.result.value;
        },
      });
    });
  });
}

/** Frame gaps over `seconds`: { frames, median, p95, max, stalls } (ms). */
async function frameGaps(cdp, seconds, stallMs = 250) {
  const gaps = await cdp.evaluate(`new Promise((resolve) => {
    const gaps = []; let last = performance.now(); const until = last + ${seconds * 1000};
    function tick(now) { gaps.push(now - last); last = now; if (now < until) requestAnimationFrame(tick); else resolve(gaps); }
    requestAnimationFrame(tick);
  })`);
  const sorted = [...gaps].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] || 0;
  return { frames: gaps.length, median: q(0.5), p95: q(0.95), max: Math.max(0, ...gaps), stalls: gaps.filter((g) => g > stallMs).length };
}

/** Main-thread work over `seconds`: { task, script, heapMb } from the Performance domain. */
async function workOver(cdp, seconds) {
  await cdp.send("Performance.enable");
  const read = async () => {
    const out = {};
    for (const m of (await cdp.send("Performance.getMetrics")).metrics) out[m.name] = m.value;
    return out;
  };
  const before = await read();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const after = await read();
  return {
    task: (after.TaskDuration || 0) - (before.TaskDuration || 0),
    script: (after.ScriptDuration || 0) - (before.ScriptDuration || 0),
    heapMb: Math.round((after.JSHeapUsedSize || 0) / 1048576),
  };
}

/** BUSY seconds over `seconds`: sampled CPU time that is not (idle). This is the
 *  honest "how loaded is the main thread" number -- Performance.TaskDuration
 *  barely moves between a saturated and a relaxed renderer (measured
 *  2026-09-18: 5.96 s both before and after the stalls went from 10 to 0). */
async function busyOver(cdp, seconds) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  await cdp.send("Profiler.start");
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const { profile } = await cdp.send("Profiler.stop");
  const byId = new Map(profile.nodes.map((n) => [n.id, n.callFrame.functionName]));
  const deltas = profile.timeDeltas || [];
  let idle = 0;
  let total = 0;
  for (let i = 0; i < profile.samples.length; i += 1) {
    const ms = (deltas[i] || 0) / 1000;
    total += ms;
    if (byId.get(profile.samples[i]) === "(idle)") idle += ms;
  }
  return { busy: (total - idle) / 1000, sampled: total / 1000 };
}

module.exports = { avatarTarget, busyOver, connect, frameGaps, listTargets, workOver };
