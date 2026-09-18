"use strict";

/**
 * cdp-trace — a browser-wide trace across `seconds`, reduced to the question
 * "who was busy while no frame was produced?".
 *
 *   DESK_CDP_PORT=9223  →  node scripts/cdp-trace.cjs [seconds] [--out trace.json]
 *
 * Attaches to the BROWSER target (every process: browser, GPU, renderers),
 * records viz/gpu/cc categories, finds the gaps between presented frames and
 * prints the longest tasks per thread inside each gap. Exit 2 when CDP is
 * unreachable.
 */

const fs = require("node:fs");
const { connect } = require("./cdp-client.cjs");

const PORT = Number(process.env.DESK_CDP_PORT || 9223);
const argv = process.argv.slice(2);
const seconds = Number(argv.find((a) => /^\d+$/.test(a)) || 8);
const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;
const GAP_MS = 250;

async function main() {
  let cdp;
  try {
    const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    cdp = await connect(version.webSocketDebuggerUrl);
  } catch (error) {
    console.error(`COULD NOT RUN: ${error.message}. Exit 2.`);
    return 2;
  }
  const events = [];
  let done;
  const finished = new Promise((r) => (done = r));
  cdp.on((msg) => {
    if (msg.method === "Tracing.dataCollected") events.push(...msg.params.value);
    if (msg.method === "Tracing.tracingComplete") done();
  });
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: ["viz", "gpu", "cc", "benchmark", "toplevel", "disabled-by-default-gpu.service", "__metadata"],
    },
  });
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await cdp.send("Tracing.end");
  await finished;
  cdp.close();
  if (out) fs.writeFileSync(out, JSON.stringify({ traceEvents: events }));

  const threadName = new Map();
  const procName = new Map();
  for (const e of events) {
    if (e.name === "thread_name") threadName.set(`${e.pid}:${e.tid}`, e.args?.name);
    if (e.name === "process_name") procName.set(e.pid, e.args?.name);
  }
  const label = (e) => `${procName.get(e.pid) || e.pid}/${threadName.get(`${e.pid}:${e.tid}`) || e.tid}`;

  // A presented frame, by whichever marker this build emits.
  const names = new Map();
  for (const e of events) names.set(e.name, (names.get(e.name) || 0) + 1);
  const marker = ["Display::DrawAndSwap", "SwapBuffers", "Graphics.Pipeline.DrawAndSwap", "BeginFrame"].find((n) => names.has(n));
  console.log(`events ${events.length} · frame marker: ${marker} (${names.get(marker) || 0})`);
  if (!marker) {
    console.log([...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25));
    return 1;
  }
  const frames = events.filter((e) => e.name === marker && (e.ph === "X" || e.ph === "B" || e.ph === "I" || e.ph === "b")).map((e) => e.ts).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < frames.length; i += 1) {
    const ms = (frames[i] - frames[i - 1]) / 1000;
    if (ms > GAP_MS) gaps.push({ from: frames[i - 1], to: frames[i], ms });
  }
  console.log(`frames ${frames.length} · gaps > ${GAP_MS} ms: ${gaps.length}`);
  for (const gap of gaps.slice(0, 4)) {
    console.log(`\nGAP ${Math.round(gap.ms)} ms`);
    const inside = events.filter((e) => e.ph === "X" && e.ts >= gap.from && e.ts <= gap.to && e.dur > 5000);
    inside.sort((a, b) => b.dur - a.dur);
    for (const e of inside.slice(0, 10)) console.log(`  ${String(Math.round(e.dur / 1000)).padStart(5)} ms  ${label(e)}  ${e.name}`);
    if (inside.length === 0) console.log("  nothing over 5 ms on any traced thread — every process idle");
    // What is the LAST and FIRST thing around the gap?
    const after = events.filter((e) => e.ts > gap.to - 3000 && e.ts < gap.to + 3000 && e.ph !== "M").slice(0, 8);
    for (const e of after) console.log(`     wake: ${label(e)}  ${e.name}`);
  }
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
