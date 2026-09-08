"use strict";

/**
 * gpu-holders — WHO is holding the VRAM, from the Windows host.
 *
 * The Fleet window said "GPU VRAM 10.2 / 32 GiB" beside "0 containers running"
 * and the owner asked the only question that matters: what is using it?
 * (2026-09-08). `nvidia-smi --query-compute-apps` answers `[N/A]` per process
 * on WDDM, and `nvidia-smi` inside the WSL distro lists no host processes at
 * all, so the fleet's own status script cannot see this. The Windows GPU
 * performance counters can: `\GPU Process Memory(*)\Dedicated Usage` is one
 * sample per (pid, adapter). Measured that morning: a Windows ComfyUI
 * (python.exe, D:\ComfyUI, :8188) held 7.06 GiB and the desktop compositor
 * 4.46 GiB — neither a fleet container, so a "fleet DOWN" verdict was true
 * and the VRAM number was true, and nothing joined the two.
 *
 * Pure shaping is separated from the PowerShell read so the shaping is tested
 * against a captured sample; the read itself fails to [] and says why.
 */

const { execFile } = require("node:child_process");

// One JSON array: pid, name, bytes, cmd. Sums are NOT taken across adapters —
// a pid shows once per (luid, phys) and the dGPU row is the one that matters,
// so the shaper keeps the MAX per pid.
const PS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$c = Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue",
  "$rows = @()",
  "foreach ($s in $c.CounterSamples) {",
  "  if ($s.CookedValue -lt 67108864) { continue }",
  "  if ($s.InstanceName -notmatch 'pid_(\\d+)') { continue }",
  "  $id = [int]$matches[1]",
  "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$id\" -ErrorAction SilentlyContinue",
  "  $rows += [pscustomobject]@{ pid=$id; name=[string]$p.Name; bytes=[long]$s.CookedValue; cmd=[string]$p.CommandLine }",
  "}",
  "ConvertTo-Json -Compress -InputObject @($rows)",
].join("; ");

const GIB = 1024 * 1024 * 1024;

/** A one-phrase explanation of a holder from its name/command line. */
function hintFor(name, cmd) {
  const n = String(name || "").toLowerCase();
  const c = String(cmd || "").toLowerCase();
  // The fleet's OWN VRAM, seen from Windows. WSL2 runs inside a Hyper-V VM, so
  // the GPU memory its containers hold is attributed on the host to the VM
  // worker process (vmwp.exe) or vmmem — never to a container, and never to
  // nvidia-smi's compute-apps list. Measured 2026-09-08 with 119 containers up:
  // vmwp held 6.0 GiB while the models loaded. Unnamed, it reads as a stray
  // Windows process, which is the opposite of the truth.
  if (n === "vmwp" || n === "vmmem" || n === "vmmemwsl") {
    return "WSL2 / Hyper-V — the fleet distro itself (its containers' GPU memory)";
  }
  if (n === "dwm.exe" || n === "dwm") return "Windows desktop compositor";
  // The live case: base-interpreter python.exe running `main.py --listen
  // --port 8188 --reserve-vram 10` from D:\ComfyUI — the path never says
  // ComfyUI, the flags do (--reserve-vram is ComfyUI's own).
  if (/comfyui/.test(c) || /--reserve-vram/.test(c) || (/main\.py/.test(c) && /--port\s+8188\b/.test(c))) {
    const port = /--port\s+(\d+)/.exec(c);
    return `ComfyUI${port ? ` :${port[1]}` : ""} (Windows, not the fleet)`;
  }
  if (/ollama/.test(c) || /ollama/.test(n)) return "Ollama (Windows, not the fleet)";
  if (/lm[\s_-]?studio/.test(c) || /lmstudio/.test(n)) return "LM Studio (Windows, not the fleet)";
  if (/vllm|llama[._-]?cpp|llama-server|koboldcpp|text-generation-webui|sd\.webui|stable-diffusion|invokeai|automatic1111/.test(c)) {
    return "local model server (Windows, not the fleet)";
  }
  if (/python/.test(n)) {
    const script = /([\w.-]+\.py)/.exec(c);
    return `python${script ? ` ${script[1]}` : ""} (Windows, not the fleet)`;
  }
  if (/steam|game|unreal|unity|d3d|epicgames|riot|battle\.net/.test(c) || /steamwebhelper/.test(n)) return "game / launcher";
  if (/chrome|msedge|firefox|brave/.test(n)) return "browser";
  return "";
}

/** Group counter rows by pid (max bytes), sort desc, keep the top N, add hints. */
function shapeHolders(rows, { limit = 8, minGib = 0.1 } = {}) {
  const list = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? [rows] : [];
  const byPid = new Map();
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const pid = Number(row.pid);
    const bytes = Number(row.bytes);
    if (!Number.isFinite(pid) || !Number.isFinite(bytes) || bytes <= 0) continue;
    const prev = byPid.get(pid);
    if (!prev || bytes > prev.bytes) {
      byPid.set(pid, {
        pid,
        name: String(row.name || "").replace(/\.exe$/i, "") || `pid ${pid}`,
        bytes,
        cmd: String(row.cmd || ""),
      });
    }
  }
  return [...byPid.values()]
    .sort((a, b) => b.bytes - a.bytes)
    .filter((h) => h.bytes / GIB >= minGib)
    .slice(0, limit)
    .map((h) => ({
      pid: h.pid,
      name: h.name,
      gib: Math.round((h.bytes / GIB) * 100) / 100,
      hint: hintFor(h.name, h.cmd),
      // The command line is what makes "python" mean something; trimmed so a
      // status verdict stays a status verdict.
      cmd: h.cmd.slice(0, 160),
    }));
}

/** "ComfyUI 7.1, dwm 4.5" — the two largest, for the one-line summary. */
function summarizeHolders(holders, { top = 2 } = {}) {
  if (!Array.isArray(holders) || holders.length === 0) return "";
  return holders
    .slice(0, top)
    .map((h) => {
      const short = /comfyui/i.test(h.hint) ? "ComfyUI" : /ollama/i.test(h.hint) ? "Ollama" : /WSL2/.test(h.hint) ? "WSL2" : h.name;
      return `${short} ${h.gib.toFixed(1)}`;
    })
    .join(", ");
}

/**
 * Read the holders from the host. Resolves { holders, error } — never rejects,
 * never throws: a status verdict must not die because a counter was busy.
 */
function readGpuHolders({ execImpl = execFile, timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    try {
      execImpl(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
        (error, stdout) => {
          if (error && !stdout) {
            done({ holders: [], error: error.message || String(error) });
            return;
          }
          try {
            const parsed = JSON.parse(String(stdout || "").trim() || "[]");
            done({ holders: shapeHolders(parsed), error: null });
          } catch (parseError) {
            done({ holders: [], error: `counters unreadable: ${parseError.message}` });
          }
        },
      );
    } catch (error) {
      done({ holders: [], error: error?.message || String(error) });
    }
  });
}

module.exports = { PS_SCRIPT, hintFor, readGpuHolders, shapeHolders, summarizeHolders };
