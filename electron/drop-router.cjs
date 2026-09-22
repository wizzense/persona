"use strict";

/**
 * drop-router — the avatar's inbox (owner 2026-08-29: "drag and drop
 * documents and stuff into the avatar and have it processed or use vision
 * if its like screenshot or video and it gets ingested into the knowledge
 * base etc etc", "integrate with aitherone/writer/ etc").
 *
 * One MIME router, four lanes, one bridge:
 *   image/* -> gateway analyze_image_content (gemma4-12b on the DGX)
 *   audio/* -> gateway transcribe_audio (whisper small, ~9s)
 *   video/* -> ffmpeg first frame -> the image lane
 *   doc/*   -> gateway rag_ingest (parses PDF/DOCX/PPTX/XLSX/TXT/MD/...)
 *   other   -> refused loudly, extension stated
 *
 * THE BRIDGE (measured on this lane 2026-08-29): the gateway and the desk
 * share no filesystem, and a host path handed to a gateway tool answers
 * "File not found" — but both DO share the canonical Library bind:
 * host C:\AitherOS-Data\Library is the gateway's /app/AitherOS/Library.
 * Every drop is STAGED into Library\tmp\desk-uploads and handed to the
 * gateway by its CONTAINER path; the gateway tools read the file THERE.
 * Proven live before this module shipped: a staged PNG analyzed correctly
 * through analyze_image_content, and the staging copy is removed after
 * processing (rag_ingest parses and stores its own copy, so the stage is
 * never the durable copy).
 *
 * Tenant scoping is the caller's session, never ours (NX004): the gateway
 * derives tenant_id from the session bearer — the desk never names a
 * tenant, so a dropped artifact lands in the owner's own knowledge base.
 *
 * The agent pass (GAP-4) is the relay notice: every successful drop posts
 * a one-line notice to #agents, so aitherone/writer and every agent can
 * see and act on the new knowledge from the cockpit channel itself.
 *
 * Same degradation contract as every desk client: fail soft, every lane
 * returns {ok:false, reason} shaped verdicts, never throws.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");

const { callTool, parseMaybeJson } = require("./gateway-mcp.cjs");

// The one path bridge (see module docstring). Host side is a Windows path,
// container side is what the gateway's tools actually read.
// The HOST half of the Library mount. A Windows install keeps it at
// C:\\AitherOS-Data\\Library (the gateway's /app/AitherOS/Library); anywhere else --
// including the Linux and macOS CI runners, where the hardcoded path made the
// stage-cleanup test scandir a path that cannot exist -- AWDESK_LIBRARY_HOST names
// it, defaulting under the user's home.
const LIBRARY_HOST = process.env.AWDESK_LIBRARY_HOST
  || (process.platform === "win32"
    ? "C:\\AitherOS-Data\\Library"
    : path.join(os.homedir(), ".aither", "library"));
const DROP_REL = path.join("tmp", "desk-uploads");
const LIBRARY_CONTAINER = "/app/AitherOS/Library";

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB — a drop bigger than this is not an ingest
const IMAGE_PROMPT =
  "This image was dropped on the desk. Describe what it shows in 2-3 sentences: " +
  "the main subject, any text visible (quote it), and anything notable.";

const KIND_EXTS = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic", "avif"],
  audio: ["wav", "mp3", "flac", "ogg", "m4a", "webm", "opus", "aac"],
  video: ["mp4", "webm", "mov", "mkv", "avi", "m4v"],
  doc: ["pdf", "docx", "pptx", "xlsx", "doc", "xls", "ppt", "txt", "md", "rst", "html", "htm", "csv"],
};

function kindOf(filePath, mime) {
  const ext = path.extname(filePath || "").toLowerCase().replace(".", "");
  if (mime && mime.startsWith("image/")) return "image";
  if (mime && mime.startsWith("audio/")) return "audio";
  if (mime && mime.startsWith("video/")) return "video";
  if (mime && mime.startsWith("text/")) return "doc";
  if (mime && mime === "application/pdf") return "doc";
  for (const [kind, exts] of Object.entries(KIND_EXTS)) {
    if (exts.includes(ext)) return kind;
  }
  return null;
}

function uniqueStageName(filePath) {
  const base = path.basename(filePath || "drop").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return `drop-${Date.now()}-${Math.floor(Math.random() * 1e6)}-${base}`;
}

/** Copy the dropped file into the shared Library stage. Returns both path
 *  spellings; the CONTAINER one is what the gateway tools read. */
function stagePath(filePath) {
  const dir = path.join(LIBRARY_HOST, DROP_REL);
  fs.mkdirSync(dir, { recursive: true });
  const name = uniqueStageName(filePath);
  const host = path.join(dir, name);
  fs.copyFileSync(filePath, host);
  // Container side is always POSIX — path.join on Windows would hand the
  // gateway "\app\AitherOS\Library\..." (a Windows-relative path) and the
  // tool would answer "File not found". Measured by the self-test.
  const container = `${LIBRARY_CONTAINER}/${DROP_REL.replace(/\\/g, "/")}/${name}`;
  return { host, container, name };
}

function cleanupStage(host) {
  if (!host) return;
  try {
    fs.unlinkSync(host);
  } catch {
    // Already gone, or a permission flap on a stage file — the stage is a
    // copy; the ORIGINAL is never touched by this module.
  }
}

/** The image lane: gemma4-12b sees the staged file (or a video's first frame). */
async function analyzeImage(containerPath, call, prompt = IMAGE_PROMPT) {
  const text = await call("analyze_image_content", {
    image_path: containerPath,
    prompt: prompt || IMAGE_PROMPT,
  });
  const parsed = parseMaybeJson(text);
  const summary = typeof parsed === "string" ? parsed
    : typeof parsed?.description === "string" ? parsed.description
      : typeof parsed?.result === "string" ? parsed.result
        : text;
  return String(summary || "").trim();
}

/** The audio lane: whisper small transcribes the staged file. */
async function transcribeAudio(containerPath, call) {
  const text = await call("transcribe_audio", { audio_path: containerPath });
  return String(text || "")
    .replace(/^Transcription:\s*/i, "")
    .replace(/\s*\(Language:.*\)\s*$/s, "")
    .trim();
}

/** The video lane: first frame via ffmpeg, then the image lane sees it. */
function firstFrame(filePath, stageDir, ffmpeg) {
  const frame = path.join(stageDir, `frame-${Date.now()}.png`);
  const run = ffmpeg || ((args) =>
    execFileSync("ffmpeg", args, { stdio: "ignore", timeout: 60000 }));
  run(["-y", "-i", filePath, "-frames:v", "1", "-q:v", "2", frame]);
  return frame;
}

/** Files the desk can read itself (no parser needed) — the ingest tool's
 *  content lane works TODAY, without any fleet change. */
const TEXT_READABLE_EXTS = ["txt", "md", "csv", "html", "htm", "rst", "log", "json", "yaml", "yml", "xml", "ini"];

/** FEDERATION (owner 2026-08-29: "integrate aithergraph + lyrawiki/llmwiki"):
 *  after the tenant memory ingest, also push the doc into the LLM wiki
 *  (wiki_ingest — the full save-raw → extraction → summary-page pipeline)
 *  and the graph knowledge base (graph_kb_ingest — needs an existing
 *  base_id, taken from graph_kb_list).
 *
 *  Both tools live in the gateway's registry but the RUNNING gateway image
 *  predates their registration (the image rebuild is queued), so each call
 *  is fail-soft and reports its state honestly — "pending gateway rebuild"
 *  — instead of failing the drop. Never fails the drop itself.
 */
async function federateDoc(name, content, call) {
  const out = { wiki: null, graph: null };
  const text = String(content || "").slice(0, 200000);
  if (!text.trim()) return out;
  try {
    const w = await call("wiki_ingest", {
      title: name.replace(/\.\w+$/, "").slice(0, 120),
      content: text,
      source_type: "document",
      project: "default",
    });
    const wp = parseMaybeJson(w);
    if (wp && typeof wp === "object" && wp.error) {
      out.wiki = /not available|not listed|unknown tool|upgrade/i.test(String(wp.error))
        ? "pending gateway rebuild" : String(wp.error).slice(0, 120);
    } else {
      out.wiki = "ok";
    }
  } catch (e) {
    out.wiki = String(e.message || e).slice(0, 120);
  }
  try {
    const list = await call("graph_kb_list", {});
    const lp = parseMaybeJson(list);
    if (lp && typeof lp === "object" && lp.error) {
      out.graph = /not available|not listed|unknown tool|upgrade/i.test(String(lp.error))
        ? "pending gateway rebuild" : String(lp.error).slice(0, 120);
      return out;
    }
    const bases = Array.isArray(lp?.bases) ? lp.bases
      : Array.isArray(lp) ? lp
        : (lp && typeof lp === "object" ? Object.values(lp).filter((b) => b && typeof b === "object" && (b.id || b.base_id)) : []);
    const base = bases?.[0];
    const baseId = base?.id || base?.base_id;
    if (!baseId) {
      out.graph = "no knowledge base — create one (graph_kb_create)";
      return out;
    }
    const g = await call("graph_kb_ingest", { base_id: baseId, content: text });
    const gp = parseMaybeJson(g);
    out.graph = gp && typeof gp === "object" && gp.error
      ? String(gp.error).slice(0, 120) : "ok";
  } catch (e) {
    const msg = String(e.message || e);
    out.graph = /not available|not listed|unknown tool|upgrade/i.test(msg)
      ? "pending gateway rebuild" : msg.slice(0, 120);
  }
  return out;
}

/** The document lane, two routes:
 *  1. Text-readable files (txt/md/csv/...) — the desk reads the text and
 *     calls the gateway `ingest` tool (content-based, tenant-scoped from
 *     the session — NX004). Works today, no fleet change.
 *  2. Binary docs (pdf/docx/pptx/xlsx/...) — gateway `ingest_document`
 *     (added 2026-08-29): the gateway reads the staged bytes ITSELF,
 *     runs genesis /artifact/preprocess for text extraction, and ingests.
 *     That tool rides the gateway image build; until it exists the lane
 *     refuses with a reason that names the state, never a half-truth. */
async function ingestDoc(containerPath, hostPath, name, call) {
  const ext = path.extname(name || "").toLowerCase().replace(".", "");
  if (TEXT_READABLE_EXTS.includes(ext)) {
    let content;
    try {
      content = fs.readFileSync(hostPath, "utf8");
    } catch {
      return { ok: false, reason: `cannot read ${name} — the file may have moved` };
    }
    if (!content.trim()) return { ok: false, reason: `${name} is empty — nothing to ingest` };
    const text = await call("ingest", {
      content: content.slice(0, 500000), // 500 KB per drop keeps ingest bounded
      content_type: "document",
      source_name: name,
    });
    const parsed = parseMaybeJson(text);
    if (parsed && typeof parsed === "object" && parsed.error) {
      return { ok: false, reason: String(parsed.error).slice(0, 300) };
    }
    const nodeId = parsed?.node_id || null;
    // FEDERATION: the wiki + graph pushes (fail-soft; reports its state).
    const federated = await federateDoc(name, content, call);
    const fedNote = federated.wiki === "ok" || federated.graph === "ok"
      ? ` · wiki:${federated.wiki ?? "pending"} · graph:${federated.graph ?? "pending"}`
      : "";
    return {
      ok: true,
      summary: `Ingested into the knowledge base — ${content.length.toLocaleString()} chars.${nodeId ? ` (node ${nodeId})` : ""}${fedNote}`,
      detail: typeof text === "string" ? text.slice(0, 2000) : JSON.stringify(text),
      docId: nodeId,
      federated,
    };
  }
  const text = await call("ingest_document", { file_path: containerPath, source_name: name });
  const parsed = parseMaybeJson(text);
  if (parsed && typeof parsed === "object" && parsed.error) {
    const err = String(parsed.error);
    if (/unknown tool|not found|no tool/i.test(err) || /ingest_document/.test(err)) {
      return {
        ok: false,
        reason: `${name} is a binary document and binary parsing ships with the gateway's next build — drop a txt/md copy, or ask Aither to ingest it directly`,
      };
    }
    return { ok: false, reason: err.slice(0, 300) };
  }
  const ingest = parsed?.ingest || {};
  if (ingest && typeof ingest === "object" && ingest.error) {
    return { ok: false, reason: String(ingest.error).slice(0, 300) };
  }
  const chars = parsed?.extracted_chars ?? 0;
  const nodeId = ingest?.node_id || null;
  const excerpt = parsed?.summary || parsed?.text_excerpt || "";
  return {
    ok: true,
    summary: `Ingested into the knowledge base — ${chars.toLocaleString()} chars extracted${nodeId ? `, node ${nodeId}` : ""}.`,
    detail: String(excerpt).slice(0, 2000),
    docId: nodeId,
  };
}

/**
 * Route one dropped file. Returns a verdict:
 *   {ok:true, kind, name, summary, detail?} — detail is JSON for docs
 *   {ok:false, reason}
 * Injectable deps for tests: {call, ffmpeg, stat}.
 */
async function routeDrop({ filePath, mime = "" }, deps = {}) {
  const call = deps.call || callTool;
  try {
    if (typeof filePath !== "string" || filePath.length === 0) {
      return { ok: false, reason: "no file received" };
    }
    let size = 0;
    try {
      const stat = deps.stat || fs.statSync;
      size = stat(filePath).size;
    } catch {
      return { ok: false, reason: `cannot read ${path.basename(filePath)} — the file may have moved` };
    }
    if (size > MAX_BYTES) {
      return {
        ok: false,
        reason: `${path.basename(filePath)} is ${(size / 1024 / 1024).toFixed(1)} MB — drops are capped at 100 MB`,
      };
    }
    const kind = kindOf(filePath, mime);
    if (!kind) {
      const ext = path.extname(filePath).toLowerCase();
      return {
        ok: false,
        reason: `I don't know what to do with ${ext || "that file"} — drop an image, audio, video, or document (pdf/docx/pptx/xlsx/txt/md)`,
      };
    }
    // cast.json's vision section (desk-settings.cjs). Checked BEFORE staging: a
    // look that is switched off must not copy the owner's file anywhere first.
    // `deps.deskSettings` is the test seam; production reads the live file.
    const vision = ((deps.deskSettings || require("./desk-settings.cjs").current)() || {}).vision || {};
    if ((kind === "image" || kind === "video") && vision.enabled === false) {
      return {
        ok: false,
        reason: `vision is switched off (${vision.enabledFrom || "cast.json vision.enabled"}) — turn it on in the Cast pane to have me look at ${kind === "video" ? "videos" : "images"}`,
      };
    }
    const staged = stagePath(filePath);
    try {
      if (kind === "image") {
        const summary = await analyzeImage(staged.container, call, vision.imagePrompt);
        if (!summary || /^error/i.test(summary)) {
          return { ok: false, reason: `vision could not read it: ${summary.slice(0, 200) || "no answer"}` };
        }
        return { ok: true, kind, name: staged.name.replace(/^drop-\d+-\d+-/, ""), summary };
      }
      if (kind === "audio") {
        const summary = await transcribeAudio(staged.container, call);
        if (!summary || /^error/i.test(summary)) {
          return { ok: false, reason: `transcription failed: ${summary.slice(0, 200) || "no answer"}` };
        }
        return { ok: true, kind, name: staged.name.replace(/^drop-\d+-\d+-/, ""), summary };
      }
      if (kind === "video") {
        const frameHost = firstFrame(filePath, path.dirname(staged.host), deps.ffmpeg);
        const frameContainer = path.join(
          LIBRARY_CONTAINER, DROP_REL.replace(/\\/g, "/"), path.basename(frameHost));
        let summary;
        try {
          summary = await analyzeImage(frameContainer, call, vision.imagePrompt);
        } finally {
          cleanupStage(frameHost);
        }
        if (!summary || /^error/i.test(summary)) {
          return { ok: false, reason: `vision could not read the first frame: ${summary.slice(0, 200) || "no answer"}` };
        }
        return {
          ok: true,
          kind,
          name: staged.name.replace(/^drop-\d+-\d+-/, ""),
          summary: `First frame of the video: ${summary}`,
        };
      }
      const doc = await ingestDoc(staged.container, staged.host, staged.name.replace(/^drop-\d+-\d+-/, ""), call);
      if (!doc.ok) return doc;
      return { ok: true, kind, name: staged.name.replace(/^drop-\d+-\d+-/, ""), ...doc };
    } finally {
      cleanupStage(staged.host);
    }
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

/**
 * TTS the verdict so the avatar can SPEAK it. Direct host route to
 * AitherVoice's /voice/synthesize with return_base64 (proven 2026-08-29;
 * the gateway synthesize_speech tool is ledgered). Fail-soft:
 * {ok:false, reason} when the voice service is unreachable.
 *
 * ENDPOINT (U06, owner: nothing was listening on 127.0.0.1:8084 on a bare
 * Windows box -- a hardcoded host is a verdict nobody can correct without a
 * code edit): the endpoint is now cast.json's voice.endpoint, read through
 * cast-config so re-pointing the desk at a real box is a file edit, not a
 * patch. `opts.endpoint` is a TEST/caller override; when absent this module
 * asks cast-config itself (lazy require -- cast-config never requires this
 * file, so there is no cycle) and falls back to the historical literal
 * 127.0.0.1:8084 if cast-config cannot be loaded at all (e.g. it is missing
 * on an older checkout), so a box with no cast.json behaves exactly as
 * before this unit landed.
 */
const DEFAULT_ENDPOINT = Object.freeze({ host: "127.0.0.1", port: 8084, path: "/voice/synthesize" });
const DEFAULT_MAX_CHARS = 220;

/** Best-effort read of cast.json's voice defaults. Never throws: a missing
 *  or unreadable cast-config module must degrade to DEFAULT_ENDPOINT, not
 *  take the voice lane down. */
function loadVoiceConfig() {
  try {
    const cast = require("./cast-config.cjs"); // lazy on purpose -- see doc above
    const { snapshot } = cast.load();
    return cast.resolveVoice(snapshot);
  } catch {
    return null;
  }
}

// Playback rate for everything the avatar says. The fleet voices read slow
// (owner, 2026-09-18: "the speech rate is too slow"); awsh already defaults to
// 1.25x for the same reason. Precedence, most specific first: an EXPLICIT
// requested speed (including 0 -- distinguished from "no speed was asked
// for" and clamped up to SPEED_MIN rather than silently defaulted, the same
// unset-vs-zero trap `Number(env) || 3` has everywhere else in this tree) ->
// cast.json's voice.defaultSpeed (itself already folds in DESK_VOICE_SPEED
// as ITS OWN fallback tier, see cast-config.resolveVoice) -> a direct
// DESK_VOICE_SPEED read as a safety net if cast-config could not be loaded
// at all -> the built-in 1.35. The service accepts 0.25-4.0.
const SPEED_MIN = 0.25;
const SPEED_MAX = 4.0;
const SPEED_DEFAULT = 1.35;
function clampSpeed(value) {
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, value));
}
function voiceSpeed(requested, { env = process.env, config } = {}) {
  const explicit = requested !== undefined && requested !== null && requested !== "";
  if (explicit) {
    const num = Number(requested);
    if (Number.isFinite(num)) return clampSpeed(num); // 0 included: explicit beats every tier below it
  }
  const cfgSpeed = config && Number.isFinite(Number(config.defaultSpeed)) ? Number(config.defaultSpeed) : null;
  if (cfgSpeed !== null && cfgSpeed > 0) return clampSpeed(cfgSpeed);
  const envSpeed = Number(env.DESK_VOICE_SPEED);
  if (Number.isFinite(envSpeed) && envSpeed > 0) return clampSpeed(envSpeed);
  return SPEED_DEFAULT;
}

// ─── duration estimate (U06: the ~5x-short bug that makes agents talk over
// each other) ─────────────────────────────────────────────────────────────
//
// The service's own `duration_seconds` divides byte length by 32000 as if
// the bytes were a 24 kHz 16-bit mono WAV; edge-tts actually emits ~24 kHz
// 48 kbps mono MP3 (~6000 B/s) -- about a FIFTH of the true length -- and
// room-stage paces the NEXT speaker on this number, so a short estimate is a
// direct cause of overlapping voices. `format` in the response is a KNOWN
// LIE (open gate VFH001: it says "wav" and sends mp3 bytes on purpose, a
// shipped-decoder decision, not a bug this file can patch), so the bytes are
// SNIFFED instead of trusted. The service's own duration is not IGNORED --
// once U16's server-side fix lands it will be more precise than a flat
// byte-rate guess -- but it is accepted only inside a PLAUSIBILITY band
// around our own estimate (a guard, not a version check): today's /32000 bug
// lands far outside that band and is rejected in favour of the honest
// derived value.
const MP3_BYTES_PER_SEC = 6000; // ~48 kbps / 8 -- edge-tts's default encode
const WAV_BYTES_PER_SEC = 24000 * 2; // 24 kHz, 16-bit mono PCM

/** Sniff the leading bytes of a base64 audio payload to tell WAV from MP3,
 *  rather than trusting the response's declared (and known-lying) `format`. */
function sniffAudioFormat(audioBase64) {
  let head;
  try {
    head = Buffer.from(String(audioBase64 || "").slice(0, 24), "base64");
  } catch {
    return "unknown";
  }
  if (head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WAVE") {
    return "wav";
  }
  if (head.length >= 3 && head.toString("ascii", 0, 3) === "ID3") return "mp3"; // ID3v2 tag
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return "mp3"; // MPEG frame sync
  return "unknown";
}

function estimateDurationMs(audioBase64, sniffedFormat) {
  const bytes = Math.floor(String(audioBase64 || "").length * 0.75); // base64 -> raw bytes
  if (bytes <= 0) return 0;
  const rate = sniffedFormat === "wav" ? WAV_BYTES_PER_SEC : MP3_BYTES_PER_SEC; // unknown defaults to mp3: that is what the service actually sends today
  return Math.round((bytes / rate) * 1000);
}

function pickDurationMs(serviceSeconds, audioBase64, sniffedFormat) {
  const derivedMs = estimateDurationMs(audioBase64, sniffedFormat);
  const serviceMs = Number.isFinite(serviceSeconds) && serviceSeconds > 0 ? Math.round(serviceSeconds * 1000) : null;
  if (serviceMs === null) return derivedMs;
  if (derivedMs <= 0) return serviceMs;
  // Half-to-double band: wide enough to admit a real encoder's true bitrate
  // once U16 fixes the server, narrow enough to reject today's ~5x-short bug.
  if (serviceMs >= derivedMs * 0.5 && serviceMs <= derivedMs * 2) return serviceMs;
  return derivedMs;
}

/** Which scheme answered last, per host:port. Process-lifetime only: this is a
 *  cache, never configuration -- the truth is whatever the socket does today. */
const SCHEME_MEMO = new Map();
const endpointKey = (e) => `${e.host}:${e.port}`;

/** The WSL distro's own address, discovered once per process.
 *
 *  🪤 WHY A SECOND HOST EXISTS AT ALL. The fleet runs in a WSL2 distro and
 *  publishes 8084 on the host loopback, so 127.0.0.1 is normally right. But the
 *  tailnet advertises the fleet's OWN podman bridge subnet -- from a
 *  route row whose router has been offline for weeks, and when that lands in
 *  table 52 every REPLY to a container goes into the tailnet. Measured
 *  2026-09-20: Windows -> 127.0.0.1:8084 accepted the SYN and then timed out
 *  (000 after 12-20s, never refused) while the distro itself answered in 9ms and
 *  every netavark DNAT rule was present and correct. tailscale-autoup.service
 *  installs `ip rule ... to <bridge subnet> lookup main priority 5200` to prevent
 *  exactly this, but a rule that is not currently applied is not a rule, and the
 *  desk going mute is how the owner finds out.
 *
 *  The distro's eth0 address bypasses the hijacked loopback path entirely
 *  (measured: 200 in 19ms while loopback hung). It MOVES on every WSL restart,
 *  which is why it is discovered at runtime and never written to cast.json --
 *  a pinned IP in config is a splint that silently rots. */
let WSL_HOST = undefined;
function wslHost() {
  if (WSL_HOST !== undefined) return WSL_HOST;
  WSL_HOST = null;
  try {
    const out = execFileSync("wsl", ["-d", "Debian", "-u", "root", "hostname", "-I"], {
      encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    const hit = String(out).trim().split(/\s+/).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (hit) WSL_HOST = hit;
  } catch {
    // No WSL, not Windows, or the distro is busy: the loopback attempts stand
    // on their own. This is a FALLBACK, never a requirement.
  }
  return WSL_HOST;
}

/** Every (host, scheme) worth trying, best first. A remembered pair short-
 *  circuits to one attempt, so the steady state costs exactly one request. */
function attemptsFor(endpoint) {
  const remembered = SCHEME_MEMO.get(endpointKey(endpoint));
  const mod = (s) => (s === "http" ? http : https);
  const pinned = endpoint.scheme === "http" || endpoint.scheme === "https" ? endpoint.scheme : null;
  const out = [];
  const add = (host, scheme) => {
    if (host && !out.some((a) => a.host === host && a.scheme === scheme)) {
      out.push({ host, scheme, mod: mod(scheme) });
    }
  };
  if (remembered) add(endpoint.host, remembered);
  // HTTPS first: every fleet service runs AITHER_INTERSERVICE_TLS=true.
  if (pinned) add(endpoint.host, pinned);
  add(endpoint.host, "https");
  add(endpoint.host, "http");
  return out;
}

async function synthesizeVerdict(text, voice = "nova", opts = {}) {
  const { speed, endpoint: explicitEndpoint } = opts;
  const voiceConfig = loadVoiceConfig();
  const maxChars = Number.isFinite(Number(opts.maxChars)) && Number(opts.maxChars) > 0
    ? Number(opts.maxChars)
    : (voiceConfig && Number.isFinite(Number(voiceConfig.maxChars)) ? Number(voiceConfig.maxChars) : DEFAULT_MAX_CHARS);
  const short = String(text || "").slice(0, maxChars);
  if (!short) return { ok: false, reason: "nothing to say" };
  const endpoint = {
    host: (explicitEndpoint && explicitEndpoint.host) || (voiceConfig && voiceConfig.endpoint.host) || DEFAULT_ENDPOINT.host,
    port: (explicitEndpoint && explicitEndpoint.port) || (voiceConfig && voiceConfig.endpoint.port) || DEFAULT_ENDPOINT.port,
    path: (explicitEndpoint && explicitEndpoint.path) || (voiceConfig && voiceConfig.endpoint.path) || DEFAULT_ENDPOINT.path,
  };
  const resolvedSpeed = voiceSpeed(speed, { config: voiceConfig });
  const body = JSON.stringify({ text: short, voice, speed: resolvedSpeed, return_base64: true });

  // Try each (host, scheme) in turn. Only a CONNECTION failure moves on: a
  // service that answered -- even with an error -- has had its say, and trying
  // the next candidate would hide a real refusal behind a second failure.
  const attempts = attemptsFor(endpoint);
  let lastReason = "no voice endpoint to try";
  let sawSilence = false;
  let triedAlt = false;
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const outcome = await attemptSynthesis(attempt, endpoint, body);
    if (outcome.answered) {
      if (outcome.result.ok) SCHEME_MEMO.set(`${attempt.host}:${endpoint.port}`, attempt.scheme);
      return outcome.result;
    }
    lastReason = outcome.reason;
    // 🪤 REFUSED IS NOT SILENT, and the difference is the whole cost model.
    // ECONNREFUSED means nothing is listening on that host:port at all, so the
    // other scheme on the SAME address cannot help -- stop trying it. A reset or
    // a TLS handshake error means something IS there and answered wrongly (a
    // scheme flip), and a TIMEOUT means the SYN was accepted and the reply never
    // came (the hijacked-route signature). Only that last case justifies paying
    // for the distro-address fallback, which costs a subprocess.
    // Without this split a dead endpoint took four attempts plus a `wsl` call
    // instead of failing at once -- caught by drop-router.test.cjs, which pins
    // "a refused connection resolves immediately, not after the 90s timeout".
    const refused = /ECONNREFUSED/i.test(lastReason);
    const silent = /timeout/i.test(lastReason);  // connect OR synthesis
    if (silent) sawSilence = true;
    if (refused) {
      // Drop any remaining attempt against this same host: it is not listening.
      while (i + 1 < attempts.length && attempts[i + 1].host === attempt.host) attempts.splice(i + 1, 1);
    }
    const last = i === attempts.length - 1;
    if (last && sawSilence && !triedAlt && !opts._noWslFallback) {
      triedAlt = true;
      const alt = wslHost();
      if (alt && alt !== endpoint.host) {
        attempts.push({ host: alt, scheme: "https", mod: https });
        attempts.push({ host: alt, scheme: "http", mod: http });
      }
    }
  }
  return { ok: false, reason: String(lastReason).slice(0, 200) };
}

/** One request. Resolves {answered:true, result} when the service replied at
 *  all, or {answered:false, reason} when the connection itself failed. */
function attemptSynthesis(attempt, endpoint, body) {
  return new Promise((resolve) => {
    const req = attempt.mod.request(
      {
        host: attempt.host,
        port: endpoint.port,
        path: endpoint.path,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 90000,
        // The fleet issues its own CA and Electron does not carry it. This is a
        // LOOPBACK call to a service on this machine, so the transport is not
        // the trust boundary -- cast.json's gate is (see cast-config's
        // "not as authentication" note). Verifying here would only mean the
        // desk goes permanently silent the next time a rebuild turns TLS on.
        rejectUnauthorized: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(text);
            const audio = parsed.audio_base64 || parsed.audioBase64 || parsed.base64;
            if (parsed.success && audio) {
              const sniffed = sniffAudioFormat(audio);
              return resolve({
                answered: true,
                result: {
                  ok: true,
                  audioBase64: audio,
                  durationMs: pickDurationMs(Number(parsed.duration_seconds), audio, sniffed),
                },
              });
            }
            resolve({
              answered: true,
              result: { ok: false, reason: String(parsed.error || parsed.detail || "synthesis failed").slice(0, 200) },
            });
          } catch {
            resolve({
              answered: true,
              result: { ok: false, reason: `synthesis answered non-JSON (${text.slice(0, 60)})` },
            });
          }
        });
      },
    );
    // 🪤 TWO deadlines, because they answer different questions. The 90s one is
    // for the BODY: synthesis legitimately takes ~7s warm and has been measured
    // over 60s while the host was building images, so it must stay generous. But
    // a hijacked route fails at CONNECT -- the SYN-ACK never comes back -- and
    // waiting 90s to learn that makes every utterance a 90-second mute. A
    // healthy loopback connects in under a millisecond, so 6s is enormous for
    // the question actually being asked and turns the hijack into a blip.
    // 🪤 The deadline that matters is FIRST BYTE, not connect. Measured: with
    // the route hijacked, WSL's own localhost proxy still completes the TCP
    // handshake on the Windows side -- so `connect` fires, looks healthy, and
    // the reply that never comes back is indistinguishable from a slow
    // synthesis. A connect deadline sails straight past it (tried; it did).
    // Warm synthesis answers in ~7s, so 25s is generous for "is anything coming
    // at all" while keeping a hijacked path to one blip instead of 90 seconds
    // of silence per utterance. The 90s request timeout below still guards the
    // BODY, which under heavy build load has legitimately taken over a minute.
    let responded = false;
    const firstByte = setTimeout(() => {
      if (!responded) req.destroy(new Error("first-byte timeout"));
    }, 25000);
    req.on("response", () => { responded = true; clearTimeout(firstByte); });
    req.on("close", () => clearTimeout(firstByte));
    req.on("timeout", () => { req.destroy(new Error("synthesis timeout")); });
    // A scheme mismatch and a hijacked route do not announce themselves: plain
    // HTTP into a TLS socket is simply closed, TLS into a plain one fails the
    // handshake, and a reply lost to the tailnet just never arrives. All three
    // land here, and `speakAloud` renders any of them as "a dead voice service"
    // and a MUTED caption -- so the caller moves to the next candidate instead.
    req.on("error", (error) => {
      resolve({ answered: false, reason: String(error?.message || error) });
    });
    req.write(body);
    req.end();
  });
}

module.exports = {
  routeDrop,
  synthesizeVerdict,
  voiceSpeed,
  SPEED_DEFAULT,
  SPEED_MIN,
  SPEED_MAX,
  DEFAULT_ENDPOINT,
  DEFAULT_MAX_CHARS,
  sniffAudioFormat,
  estimateDurationMs,
  pickDurationMs,
  stagePath,
  cleanupStage,
  kindOf,
  LIBRARY_HOST,
  DROP_REL,
  LIBRARY_CONTAINER,
  MAX_BYTES,
};

if (require.main === module) {
  // Self-test: the full bridge WITHOUT the fleet — a staged PNG (real bytes,
  // real stage/cleanup, real container-path naming) routed through a FAKE
  // gateway call that records what it was handed. Exit 0 = the router stages,
  // bridges and cleans up correctly; 1 = a contract broke.
  (async () => {
    try {
      const osTmp = fs.mkdtempSync(path.join(os.tmpdir(), "drop-router-selftest-"));
      const png = path.join(osTmp, "self.png");
      const W = 8;
      // One row: filter byte 0x00 + W pixels of (0xe0, 0x30, 0x40) red.
      const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(W * 3, 0xe0)]);
      const raw = Buffer.concat(Array.from({ length: W }, () => row));
      const zlib = require("node:zlib");
      const crcTable = (() => {
        const t = [];
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          t[n] = c >>> 0;
        }
        return t;
      })();
      const crc32 = (buf) => {
        let c = 0xffffffff;
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
      };
      const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
        return Buffer.concat([len, Buffer.from(type), data, crc]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
      const pngBuf = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
      ]);
      fs.writeFileSync(png, pngBuf);

      let seenArgs = null;
      const fakeCall = async (name, args) => {
        seenArgs = { name, args };
        return "A tiny test image.";
      };
      const verdict = await routeDrop({ filePath: png, mime: "image/png" }, { call: fakeCall });
      if (!verdict.ok) throw new Error(`self-test route failed: ${verdict.reason}`);
      if (seenArgs.name !== "analyze_image_content") throw new Error(`wrong lane: ${seenArgs.name}`);
      if (!seenArgs.args.image_path.startsWith("/app/AitherOS/Library/tmp/desk-uploads/")) {
        throw new Error(`not bridged: ${seenArgs.args.image_path}`);
      }
      // The stage must be cleaned up even on success — compare against the
      // listing BEFORE this run (the shared stage can hold other drops).
      const stageDir = path.join(LIBRARY_HOST, DROP_REL);
      const before = fs.readdirSync(stageDir).filter((f) => f.startsWith("drop-"));
      const verdict2 = await routeDrop({ filePath: png, mime: "image/png" }, { call: fakeCall });
      if (!verdict2.ok) throw new Error(`self-test second route failed: ${verdict2.reason}`);
      const after = fs.readdirSync(stageDir).filter((f) => f.startsWith("drop-"));
      if (after.length > before.length) {
        throw new Error(`staged file left behind: ${after.filter((f) => !before.includes(f)).join(", ")}`);
      }
      console.log(`DROP ROUTER OK: ${verdict.kind} lane, bridged ${seenArgs.args.image_path.slice(0, 60)}...`);
      fs.rmSync(osTmp, { recursive: true, force: true });
      process.exit(0);
    } catch (error) {
      console.error(`DROP ROUTER BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
