"use strict";

/**
 * stall-watch — do the desk's frame stalls line up with foreign GPU load?
 *
 *   DESK_CDP_PORT=9223  →  node scripts/stall-watch.cjs [seconds]
 *
 * Records every frame gap > 250 ms in the avatar window with a wall-clock
 * time, while ONE long-lived `nvidia-smi -lms 250` samples the adapter's
 * utilisation and memory. Prints the utilisation in the second around each
 * stall beside the run's overall figure. Exit 2 when CDP is unreachable.
 */

const { spawn } = require("node:child_process");
const { avatarTarget, connect } = require("./cdp-client.cjs");

const PORT = Number(process.env.DESK_CDP_PORT || 9223);
const seconds = Number(process.argv[2] || 60);

async function main() {
  let cdp;
  try {
    cdp = await connect(await avatarTarget(PORT));
  } catch (error) {
    console.error(`COULD NOT RUN: ${error.message}. Exit 2.`);
    return 2;
  }
  const samples = [];
  const smi = spawn("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits", "-lms", "250"]);
  smi.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const m = line.match(/(\d+)\s*,\s*(\d+)/);
      if (m) samples.push({ at: Date.now(), util: Number(m[1]), mem: Number(m[2]) });
    }
  });
  smi.on("error", () => {});
  const stalls = await cdp.evaluate(`new Promise((resolve) => {
    const out = []; let last = performance.now(); const until = last + ${seconds * 1000};
    function tick(now) { const g = now - last; if (g > 250) out.push({ at: Date.now(), ms: Math.round(g) }); last = now; if (now < until) requestAnimationFrame(tick); else resolve(out); }
    requestAnimationFrame(tick);
  })`);
  smi.kill();
  cdp.close();
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  console.log(`${seconds}s · stalls ${stalls.length} · gpu samples ${samples.length} · mean util ${mean(samples.map((s) => s.util)).toFixed(0)}% · mem ${Math.max(0, ...samples.map((s) => s.mem))} MiB`);
  for (const stall of stalls) {
    const near = samples.filter((s) => s.at >= stall.at - stall.ms - 500 && s.at <= stall.at + 250);
    console.log(`  ${new Date(stall.at).toISOString().slice(11, 23)}  ${String(stall.ms).padStart(5)} ms   util around: [${near.map((s) => s.util).join(" ")}]`);
  }
  const quiet = samples.filter((s) => !stalls.some((st) => s.at >= st.at - st.ms - 500 && s.at <= st.at + 250));
  console.log(`mean util away from stalls: ${mean(quiet.map((s) => s.util)).toFixed(0)}%`);
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
