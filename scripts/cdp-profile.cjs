"use strict";

/**
 * cdp-profile — WHERE the renderer spends its time, from outside.
 *
 *   node scripts/cdp-profile.cjs <wsUrl> [seconds]
 *
 * Samples the renderer's CPU for N seconds (Profiler domain) and prints the
 * top functions by SELF time, plus the Performance-domain counters (script vs
 * layout vs style vs GC) over the same window. A stall that the frame-gap
 * probe reports is either in one of these functions or is GC; this says
 * which. Read-only.
 */

const target = process.argv[2];
const seconds = Number(process.argv[3] || 5);
if (!target) {
  console.error("usage: node scripts/cdp-profile.cjs <wsUrl> [seconds]");
  process.exit(2);
}

const ws = new WebSocket(target);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

function metricsMap(list) {
  const out = {};
  for (const m of list) out[m.name] = m.value;
  return out;
}

ws.addEventListener("open", async () => {
  try {
    await send("Performance.enable");
    await send("Profiler.enable");
    await send("Profiler.setSamplingInterval", { interval: 500 });
    const before = metricsMap((await send("Performance.getMetrics")).metrics);
    await send("Profiler.start");
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const { profile } = await send("Profiler.stop");
    const after = metricsMap((await send("Performance.getMetrics")).metrics);

    const d = (k) => ((after[k] || 0) - (before[k] || 0));
    console.log(
      `over ${seconds}s: script ${d("ScriptDuration").toFixed(2)}s  layout ${d("LayoutDuration").toFixed(2)}s  ` +
      `style ${d("RecalcStyleDuration").toFixed(2)}s  task ${d("TaskDuration").toFixed(2)}s  ` +
      `heap ${Math.round((after.JSHeapUsedSize || 0) / 1048576)} MB (${Math.round(d("JSHeapUsedSize") / 1048576)} MB delta)  ` +
      `nodes ${after.Nodes}  listeners ${after.JSEventListeners}`,
    );

    // Self time per node = samples attributed to that node id * interval.
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map();
    const deltas = profile.timeDeltas || [];
    for (let i = 0; i < profile.samples.length; i += 1) {
      const node = byId.get(profile.samples[i]);
      if (!node) continue;
      const fn = node.callFrame;
      const key = `${fn.functionName || "(anonymous)"}  ${(fn.url || "").split("/").pop()}:${fn.lineNumber}:${fn.columnNumber}`;
      self.set(key, (self.get(key) || 0) + (deltas[i] || 0) / 1000);
    }
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
    console.log(`top self time (of ${total.toFixed(0)} ms sampled):`);
    for (const [key, ms] of top) console.log(`  ${ms.toFixed(0).padStart(6)} ms  ${key}`);
  } catch (error) {
    console.error("profile failed:", error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
ws.addEventListener("error", (e) => {
  console.error("websocket error", e.message || e);
  process.exit(1);
});
