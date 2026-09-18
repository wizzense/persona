"use strict";

/**
 * perf-gate — a multi-avatar performance check that can FAIL.
 *
 *   DESK_CDP_PORT=9223 (desk launched with it)  →  node scripts/perf-gate.cjs [--bodies a,b,c] [--json]
 *
 * Drives a FIXED scenario through the desk's own doors (the bridge MCP on
 * DESK_BRIDGE_PORT, default 47931) and measures the renderer from outside over
 * CDP:
 *   1. baseline heap (after a forced GC)
 *   2. spawn N stage bodies, let them load, make one speak
 *   3. main-thread task seconds per 6 s, frame gaps over 10 s, heap, the
 *      desk's dedicated VRAM (the WDDM per-process counter)
 *   4. remove the bodies, GC, and require the heap to come BACK (the leak arm)
 *
 * Exit 0 inside every threshold · 1 a threshold breached · 2 could not run
 * (no CDP, no bridge, no roster) — never 0 on silence.
 */

const { execFileSync } = require("node:child_process");
const { avatarTarget, busyOver, connect, frameGaps, workOver } = require("./cdp-client.cjs");

// One table. A number here is a promise; change it with a measurement in the commit.
const THRESHOLDS = {
  busySecondsPer6s: 3.0, // sampled non-idle CPU with the bodies on stage (one speaking)
  heapMb: 450, // renderer JS heap with the bodies on stage
  heapLeakMb: 40, // heap after removal minus baseline (absolute: the baseline is ~8 MB)
  stallsPer10s: 1, // frame gaps > 250 ms (one tolerated: a foreign GPU hiccup)
};

const CDP_PORT = Number(process.env.DESK_CDP_PORT || 9223);
const BRIDGE = `http://127.0.0.1:${process.env.DESK_BRIDGE_PORT || 47931}`;
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const bodiesArg = (args[args.indexOf("--bodies") + 1] || "").split(",").filter(Boolean);

async function mcp(name, params = {}) {
  const res = await fetch(`${BRIDGE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: params } }),
  });
  const body = await res.json();
  const text = body?.result?.content?.[0]?.text ?? "";
  return { text, isError: Boolean(body?.result?.isError) };
}

function deskVramMb() {
  if (process.platform !== "win32") return null;
  try {
    const ps =
      "$p=(Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\").ProcessId;" +
      "$s=(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples;" +
      "$t=0;foreach($x in $s){$m=[regex]::Match($x.InstanceName,'pid_(\\d+)');if($m.Success -and ($p -contains [int]$m.Groups[1].Value)){$t+=$x.CookedValue}};[math]::Round($t/1MB)";
    return Number(execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 30000 }).trim());
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function heapAfterGc(cdp) {
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(500);
  return (await workOver(cdp, 0.2)).heapMb;
}

async function main() {
  let cdp;
  try {
    cdp = await connect(await avatarTarget(CDP_PORT));
  } catch (error) {
    console.error(`COULD NOT RUN: ${error.message} — launch the desk with DESK_CDP_PORT=${CDP_PORT}. Exit 2.`);
    return 2;
  }
  try {
    let bodies = bodiesArg;
    if (bodies.length === 0) {
      const listed = JSON.parse((await mcp("list_characters")).text || "{}");
      const pool = (listed.characters || []).filter((c) => c !== listed.active);
      bodies = pool.slice(0, 3);
    }
    if (bodies.length === 0) {
      console.error("COULD NOT RUN: no roster characters to put on stage. Exit 2.");
      return 2;
    }

    const baselineHeap = await heapAfterGc(cdp);
    const vramBefore = deskVramMb();
    const slots = [];
    for (let i = 0; i < bodies.length; i += 1) {
      const slot = `gate-${i + 1}`;
      const r = await mcp("spawn_avatar", { slot_id: slot, name: bodies[i] });
      if (!r.isError && /spawned/i.test(r.text)) slots.push(slot);
    }
    if (slots.length === 0) {
      console.error("COULD NOT RUN: no body spawned. Exit 2.");
      return 2;
    }
    await sleep(25000); // models load + first frames
    await fetch(`${BRIDGE}/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Performance gate: one body speaks while the others idle.", slot: slots[0] }),
    }).catch(() => {});
    const busy = await busyOver(cdp, 6);
    const work = await workOver(cdp, 1);
    const gaps = await frameGaps(cdp, 10);
    const vramStage = deskVramMb();

    for (const slot of slots) await mcp("remove_avatar", { slot_id: slot });
    await sleep(8000);
    const heapAfter = await heapAfterGc(cdp);

    const result = {
      bodies: slots.length,
      busySecondsPer6s: Number(busy.busy.toFixed(2)),
      heapMb: work.heapMb,
      baselineHeapMb: baselineHeap,
      heapAfterRemovalMb: heapAfter,
      heapLeakMb: heapAfter - baselineHeap,
      frames: gaps.frames,
      medianMs: Number(gaps.median.toFixed(1)),
      p95Ms: Number(gaps.p95.toFixed(1)),
      maxMs: Math.round(gaps.max),
      stallsPer10s: gaps.stalls,
      deskVramMb: { before: vramBefore, onStage: vramStage },
    };
    const breaches = [];
    if (result.busySecondsPer6s > THRESHOLDS.busySecondsPer6s) breaches.push(`busy ${result.busySecondsPer6s}s > ${THRESHOLDS.busySecondsPer6s}s`);
    if (result.heapMb > THRESHOLDS.heapMb) breaches.push(`heap ${result.heapMb}MB > ${THRESHOLDS.heapMb}MB`);
    if (result.heapLeakMb > THRESHOLDS.heapLeakMb) breaches.push(`heap did not return: +${result.heapLeakMb}MB over baseline (> ${THRESHOLDS.heapLeakMb}MB)`);
    if (result.stallsPer10s > THRESHOLDS.stallsPer10s) breaches.push(`stalls ${result.stallsPer10s} > ${THRESHOLDS.stallsPer10s}`);

    if (asJson) console.log(JSON.stringify({ result, breaches, thresholds: THRESHOLDS }, null, 2));
    else {
      console.log(result);
      for (const b of breaches) console.log("  BREACH " + b);
      console.log(breaches.length ? `perf-gate: ${breaches.length} breach(es)` : "perf-gate: OK");
    }
    return breaches.length ? 1 : 0;
  } finally {
    cdp.close();
  }
}

main().then((code) => {
  process.exitCode = code;
});
