"use strict";

/**
 * cdp-probe — ask the running desk renderer what it is doing, from outside.
 *
 *   node scripts/cdp-probe.cjs <wsUrl> [seconds]
 *
 * Prints: the persisted avatar layout (which slots MOVE actually wrote), the
 * spawned-slot count, frame timing over N seconds (a freeze is a long gap
 * between animation frames), and any console error / uncaught exception seen
 * while watching. Read-only; nothing is changed in the page.
 */

const target = process.argv[2];
const seconds = Number(process.argv[3] || 4);
if (!target) {
  console.error("usage: node scripts/cdp-probe.cjs <wsUrl> [seconds]");
  process.exit(2);
}

const ws = new WebSocket(target);
let id = 0;
const pending = new Map();
const errors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "evaluate failed");
  return r.result.value;
}

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") {
    errors.push("exception: " + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text || "").slice(0, 300));
  } else if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
    errors.push(msg.params.type + ": " + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
  }
});

ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable");
    const layout = await evaluate("localStorage.getItem('desk.avatar-layout.v1')");
    console.log("layout:", layout);
    const timing = await evaluate(`new Promise((resolve) => {
      const gaps = []; let last = performance.now(); const until = last + ${seconds * 1000};
      function tick(now) { gaps.push(now - last); last = now; if (now < until) requestAnimationFrame(tick); else resolve(gaps); }
      requestAnimationFrame(tick);
    })`);
    const sorted = [...timing].sort((a, b) => a - b);
    const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(1);
    console.log(`frames: ${timing.length} in ${seconds}s  median ${p(0.5)}ms  p95 ${p(0.95)}ms  max ${Math.max(...timing).toFixed(0)}ms  stalls>250ms: ${timing.filter((g) => g > 250).length}`);
    const mem = await evaluate("performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) + ' MB heap' : 'n/a'");
    console.log("memory:", mem);
    for (const e of errors) console.log("  ", e);
    if (errors.length === 0) console.log("console: no errors/warnings while watching");
  } catch (error) {
    console.error("probe failed:", error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
ws.addEventListener("error", (e) => {
  console.error("websocket error", e.message || e);
  process.exit(1);
});
