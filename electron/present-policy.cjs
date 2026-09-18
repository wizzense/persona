"use strict";

/**
 * present-policy — how the desk's windows reach the screen, decided before
 * `app.ready`.
 *
 * Measured 2026-09-18 on a box whose dGPU also serves the fleet (scripts/
 * cdp-trace.cjs, scripts/stall-watch.cjs): every `nvidia-smi`/NVML query takes
 * the WDDM driver lock, and a Chromium GPU process that presents a swap chain
 * on that adapter's display blocks INSIDE Present for the length of the query
 * -- up to exactly 1000 ms -- while the renderer, the main process and DWM are
 * all idle. 38 stalls in 90 s under one 250 ms poller; 0 without it.
 *
 *   gpu present, dGPU render            3-6 stalls per 10 s under the poller
 *   gpu present, iGPU render            3-6 (the swap chain still lands on the dGPU display)
 *   --disable-gpu-vsync                 3-6
 *   --disable-direct-composition        2
 *   software present + iGPU render      0   (max gap 158 ms; ~25 % of one core)
 *
 * So: WebGL keeps a GPU (the integrated one, which nobody polls and whose VRAM
 * the fleet does not want), and the finished frame goes to DWM through the
 * software path, which takes no lock on the contended adapter.
 *
 *   DESK_PRESENT = auto (default) | software | gpu
 *   DESK_GPU     = auto (default) | integrated | discrete | default
 */

const PRESENT_MODES = ["auto", "software", "gpu"];
const GPU_CHOICES = ["auto", "integrated", "discrete", "default"];

/** Windows' per-app graphics preference values (Settings > Display > Graphics). */
const GPU_PREFERENCE = { default: 0, integrated: 1, discrete: 2 };
// Built without a backslash literal: this file has been mangled by shell heredocs before.
const GPU_PREFERENCE_KEY = ["HKCU", "Software", "Microsoft", "DirectX", "UserGpuPreferences"].join(String.fromCharCode(92));

function pick(value, allowed) {
  const v = String(value || "").trim().toLowerCase();
  return allowed.includes(v) ? v : "auto";
}

/** Pure: env + platform → { present, gpu, switches[], gpuPreference|null }. */
function presentPolicy({ env = process.env, platform = process.platform } = {}) {
  const wantPresent = pick(env.DESK_PRESENT, PRESENT_MODES);
  const wantGpu = pick(env.DESK_GPU, GPU_CHOICES);
  // The lock is a WDDM behaviour; other platforms keep Chromium's default.
  const present = wantPresent === "auto" ? (platform === "win32" ? "software" : "gpu") : wantPresent;
  // Software present must not read frames back from the contended adapter.
  const gpu = wantGpu === "auto" ? (present === "software" ? "integrated" : "default") : wantGpu;
  const switches = present === "software" ? ["disable-gpu-compositing"] : [];
  const gpuPreference = platform === "win32" && gpu !== "default" ? GPU_PREFERENCE[gpu] : null;
  return { present, gpu, switches, gpuPreference };
}

/** Pure: the `reg add` argv that records the adapter preference for `exePath`. */
function gpuPreferenceCommand(exePath, preference) {
  return ["add", GPU_PREFERENCE_KEY, "/v", exePath, "/t", "REG_SZ", "/d", `GpuPreference=${preference};`, "/f"];
}

/**
 * Apply the policy. Switches take effect now; the adapter preference is read
 * by Windows at process start, so a changed value governs the NEXT launch --
 * the returned `gpuPreferencePending` says so instead of pretending.
 */
function applyPresentPolicy(app, { env = process.env, platform = process.platform, execFile, exePath = process.execPath } = {}) {
  const policy = presentPolicy({ env, platform });
  for (const name of policy.switches) app.commandLine.appendSwitch(name);
  let gpuPreferencePending = false;
  if (policy.gpuPreference != null && typeof execFile === "function") {
    const wanted = `GpuPreference=${policy.gpuPreference};`;
    execFile("reg", ["query", GPU_PREFERENCE_KEY, "/v", exePath], { windowsHide: true }, (error, stdout) => {
      if (!error && String(stdout).includes(wanted)) return;
      execFile("reg", gpuPreferenceCommand(exePath, policy.gpuPreference), { windowsHide: true }, () => {});
    });
    gpuPreferencePending = true;
  }
  return { ...policy, gpuPreferencePending };
}

module.exports = { GPU_PREFERENCE_KEY, applyPresentPolicy, gpuPreferenceCommand, presentPolicy };
