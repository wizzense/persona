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

const { callTool, parseMaybeJson } = require("./gateway-mcp.cjs");

// The one path bridge (see module docstring). Host side is a Windows path,
// container side is what the gateway's tools actually read.
const LIBRARY_HOST = "C:\\AitherOS-Data\\Library";
const DROP_REL = "tmp\\desk-uploads";
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
async function analyzeImage(containerPath, call) {
  const text = await call("analyze_image_content", {
    image_path: containerPath,
    prompt: IMAGE_PROMPT,
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
    const staged = stagePath(filePath);
    try {
      if (kind === "image") {
        const summary = await analyzeImage(staged.container, call);
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
          summary = await analyzeImage(frameContainer, call);
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
 * the gateway synthesize_speech tool is a known gap). Fail-soft:
 * {ok:false, reason} when the voice service is unreachable.
 */
async function synthesizeVerdict(text, voice = "nova") {
  const short = String(text || "").slice(0, 220);
  if (!short) return { ok: false, reason: "nothing to say" };
  return await new Promise((resolve) => {
    const body = JSON.stringify({ text: short, voice, return_base64: true });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: 8084,
        path: "/voice/synthesize",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 90000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(text);
            const audio = parsed.audio_base64 || parsed.audioBase64 || parsed.base64;
            if (parsed.success && audio) return resolve({ ok: true, audioBase64: audio });
            resolve({ ok: false, reason: String(parsed.error || parsed.detail || "synthesis failed").slice(0, 200) });
          } catch {
            resolve({ ok: false, reason: `synthesis answered non-JSON (${text.slice(0, 60)})` });
          }
        });
      },
    );
    req.on("timeout", () => { req.destroy(new Error("synthesis timeout")); });
    req.on("error", (error) => resolve({ ok: false, reason: String(error?.message || error).slice(0, 200) }));
    req.write(body);
    req.end();
  });
}

module.exports = {
  routeDrop,
  synthesizeVerdict,
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
