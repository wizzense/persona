"use strict";

/**
 * main-profile — what blocks the desk's MAIN process?
 *
 *   electron . --inspect=9229   →   node scripts/main-profile.cjs [seconds] [port]
 *
 * Samples the main process over the Node inspector and prints self time by
 * function plus the heaviest call paths' leaf frames. Exit 2 when the
 * inspector is unreachable.
 */

const { connect } = require("./cdp-client.cjs");

const seconds = Number(process.argv[2] || 20);
const port = Number(process.argv[3] || 9229);

async function main() {
  let cdp;
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    cdp = await connect(targets[0].webSocketDebuggerUrl);
  } catch (error) {
    console.error(`COULD NOT RUN: ${error.message} — launch with --inspect=${port}. Exit 2.`);
    return 2;
  }
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  await cdp.send("Profiler.start");
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const { profile } = await cdp.send("Profiler.stop");
  cdp.close();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const self = new Map();
  const owner = new Map(); // nearest app-code ancestor of each sample
  const deltas = profile.timeDeltas || [];
  let total = 0;
  for (let i = 0; i < profile.samples.length; i += 1) {
    const ms = (deltas[i] || 0) / 1000;
    total += ms;
    const node = byId.get(profile.samples[i]);
    const f = node.callFrame;
    const key = `${f.functionName || "(anonymous)"}  ${String(f.url).split("/").slice(-2).join("/")}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + ms);
    if (f.functionName === "(idle)" || f.functionName === "(program)") continue;
    let cursor = node.id;
    while (cursor != null) {
      const cf = byId.get(cursor).callFrame;
      if ((cf.url.includes("/desk/electron/") || cf.url.includes("/desk/scripts/")) && !cf.url.includes("node_modules")) {
        const k = `${cf.functionName || "(anonymous)"}  ${String(cf.url).split("/").pop()}:${cf.lineNumber + 1}`;
        owner.set(k, (owner.get(k) || 0) + ms);
        break;
      }
      cursor = parent.get(cursor);
    }
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  console.log(`sampled ${Math.round(total)} ms`);
  console.log("self time:");
  for (const [k, v] of top(self, 12)) console.log(`  ${String(Math.round(v)).padStart(6)} ms  ${k}`);
  console.log("nearest desk frame (inclusive of what it called):");
  for (const [k, v] of top(owner, 14)) console.log(`  ${String(Math.round(v)).padStart(6)} ms  ${k}`);
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
