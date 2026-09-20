"use strict";

// Hermetic: these modules now read cast.json (desk-settings.cjs). Without this the
// suite would read the OWNER'S live file, and go red the day they change a setting.
process.env.DESK_CAST_FILE = require("node:path").join(
  require("node:os").tmpdir(), `desk-no-cast-${process.pid}`, "cast.json");

/**
 * drop-router tests — the four lanes + the bridge contract, with the
 * gateway call injected so nothing here needs the fleet. Run:
 *   node electron/drop-router.test.cjs
 * Exit 0 = all lanes behave, 1 = a contract broke.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const http = require("node:http");

const {
  routeDrop,
  kindOf,
  LIBRARY_HOST,
  synthesizeVerdict,
  voiceSpeed,
  SPEED_MIN,
  SPEED_MAX,
  SPEED_DEFAULT,
  sniffAudioFormat,
  estimateDurationMs,
  pickDurationMs,
} = require("./drop-router.cjs");

function tmpfile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drop-router-test-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content ?? Buffer.alloc(4));
  return { dir, p };
}

const IMAGE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
  0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x99, 0x87, 0x25, 0x72, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

async function okAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log("drop-router lanes");

  ok("kindOf classifies every lane", () => {
    assert.strictEqual(kindOf("a.png", "image/png"), "image");
    assert.strictEqual(kindOf("a.mp3", ""), "audio");
    assert.strictEqual(kindOf("a.mp4", "video/mp4"), "video");
    assert.strictEqual(kindOf("a.pdf", "application/pdf"), "doc");
    assert.strictEqual(kindOf("a.docx", ""), "doc");
    assert.strictEqual(kindOf("a.txt", "text/plain"), "doc");
    assert.strictEqual(kindOf("a.exe", ""), null);
    assert.strictEqual(kindOf("a.xyz", ""), null);
  });

  await okAsync("image lane routes through analyze with a bridged path", async () => {
    const { dir, p } = tmpfile("shot.png", IMAGE_PNG);
    let seen = null;
    const verdict = await routeDrop({ filePath: p, mime: "image/png" }, {
      call: async (name, args) => { seen = { name, args }; return "A red square."; },
    });
    assert.ok(verdict.ok, verdict.reason);
    assert.strictEqual(seen.name, "analyze_image_content");
    assert.ok(seen.args.image_path.startsWith("/app/AitherOS/Library/tmp/desk-uploads/"), seen.args.image_path);
    assert.strictEqual(verdict.summary, "A red square.");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await okAsync("audio lane routes through transcribe and strips the prefix", async () => {
    const { dir, p } = tmpfile("note.mp3", Buffer.alloc(64));
    const verdict = await routeDrop({ filePath: p, mime: "audio/mpeg" }, {
      call: async (name, args) => {
        assert.strictEqual(name, "transcribe_audio");
        assert.ok(args.audio_path.startsWith("/app/AitherOS/Library/"), args.audio_path);
        return "Transcription: hello from the drop lane\n\n(Language: en, Duration: 1.2s)";
      },
    });
    assert.ok(verdict.ok, verdict.reason);
    assert.strictEqual(verdict.summary, "hello from the drop lane");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await okAsync("video lane uses ffmpeg first frame into the image lane", async () => {
    const { dir, p } = tmpfile("clip.mp4", Buffer.alloc(128));
    const calls = [];
    const fakeFfmpeg = (args) => {
      // Write the frame the router will stage next.
      const frame = args[args.length - 1];
      fs.writeFileSync(frame, IMAGE_PNG);
    };
    const verdict = await routeDrop({ filePath: p, mime: "video/mp4" }, {
      call: async (name, args) => { calls.push({ name, args }); return "A cat on a desk."; },
      ffmpeg: fakeFfmpeg,
    });
    assert.ok(verdict.ok, verdict.reason);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, "analyze_image_content");
    assert.ok(calls[0].args.image_path.includes("frame-"), calls[0].args.image_path);
    assert.ok(verdict.summary.startsWith("First frame of the video:"));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await okAsync("text docs route through the content ingest lane with real text", async () => {
    const { dir, p } = tmpfile("notes.md", "Drop lane notes.\nSecond line about the knowledge base.");
    const calls = [];
    const verdict = await routeDrop({ filePath: p, mime: "text/markdown" }, {
      call: async (name, args) => {
        calls.push({ name, args });
        if (name === "wiki_ingest") return JSON.stringify({ source_id: "w1", pages_created: ["x"] });
        if (name === "graph_kb_list") return JSON.stringify({ bases: [{ id: "kb1" }] });
        if (name === "graph_kb_ingest") return JSON.stringify({ ingested: true });
        return JSON.stringify({ status: "ingested", node_id: "abc123", source: "notes.md", graph_nodes: 9 });
      },
    });
    assert.ok(verdict.ok, verdict.reason);
    const ingest = calls.find((c) => c.name === "ingest");
    assert.ok(ingest, "ingest lane must run");
    assert.ok(ingest.args.content.includes("Drop lane notes"), "the desk text must reach ingest");
    assert.strictEqual(ingest.args.source_name, "notes.md");
    assert.ok(verdict.summary.includes("node abc123"), verdict.summary);
    assert.strictEqual(verdict.docId, "abc123");
    // FEDERATION: the doc must also reach the wiki + graph KB.
    assert.ok(calls.some((c) => c.name === "wiki_ingest"), "wiki federation must fire");
    assert.ok(calls.some((c) => c.name === "graph_kb_ingest"), "graph federation must fire");
    assert.strictEqual(verdict.federated?.wiki, "ok");
    assert.strictEqual(verdict.federated?.graph, "ok");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await okAsync("binary docs route through ingest_document with the bridged path", async () => {
    const { dir, p } = tmpfile("spec.pdf", Buffer.alloc(256));
    let seen = null;
    const verdict = await routeDrop({ filePath: p, mime: "application/pdf" }, {
      call: async (name, args) => {
        seen = { name, args };
        return JSON.stringify({
          prep_id: "prep-1", file_name: "spec.pdf", status: "ready",
          extracted_chars: 5120, summary: "A spec about the drop lane.",
          ingest: { status: "ingested", node_id: "n-77" },
        });
      },
    });
    assert.ok(verdict.ok, verdict.reason);
    assert.strictEqual(seen.name, "ingest_document");
    assert.ok(seen.args.file_path.startsWith("/app/AitherOS/Library/"), seen.args.file_path);
    assert.strictEqual(seen.args.source_name, "spec.pdf");
    assert.ok(verdict.summary.includes("5,120"), verdict.summary);
    assert.strictEqual(verdict.docId, "n-77");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await okAsync("binary docs refuse honestly when the gateway lacks the tool", async () => {
    const { dir, p } = tmpfile("broken.pdf", Buffer.alloc(16));
    const verdict = await routeDrop({ filePath: p }, {
      call: async () => JSON.stringify({ error: "Unknown tool: ingest_document" }),
    });
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.reason.includes("next build"), verdict.reason);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await okAsync("federation fails SOFT — a missing wiki tool never fails the drop", async () => {
    const { dir, p } = tmpfile("memo.md", "Federation memo for the pending-rebuild path.");
    const verdict = await routeDrop({ filePath: p, mime: "text/markdown" }, {
      call: async (name) => {
        if (name === "wiki_ingest" || name === "graph_kb_list") {
          return JSON.stringify({ error: "Tool is not available on the platform tier. Upgrade to access more tools." });
        }
        return JSON.stringify({ status: "ingested", node_id: "abc", source: "memo.md", graph_nodes: 1 });
      },
    });
    assert.ok(verdict.ok, "the drop must succeed despite federation being pending");
    assert.strictEqual(verdict.federated?.wiki, "pending gateway rebuild");
    assert.strictEqual(verdict.federated?.graph, "pending gateway rebuild");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await okAsync("doc lane surfaces the parser's own error", async () => {
    const { dir, p } = tmpfile("bad.pdf", Buffer.alloc(16));
    const verdict = await routeDrop({ filePath: p }, {
      call: async () => JSON.stringify({ error: "pdf parse failed at page 2" }),
    });
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.reason.includes("pdf parse failed"), verdict.reason);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await okAsync("unknown extension is refused with the extension named", async () => {
    const { dir, p } = tmpfile("thing.exe", Buffer.alloc(8));
    const verdict = await routeDrop({ filePath: p, mime: "application/x-msdownload" }, {});
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.reason.includes(".exe"), verdict.reason);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await okAsync("missing file refuses cleanly", async () => {
    const verdict = await routeDrop({ filePath: "C:\\nope\\missing.png" }, {});
    assert.strictEqual(verdict.ok, false);
    assert.ok(/cannot read|no file/.test(verdict.reason), verdict.reason);
  });

  await okAsync("oversize drop is refused before any lane runs", async () => {
    const { dir, p } = tmpfile("huge.png", Buffer.alloc(64));
    const verdict = await routeDrop({ filePath: p }, {
      stat: () => ({ size: 200 * 1024 * 1024 }),
      call: async () => { throw new Error("lane must not run"); },
    });
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.reason.includes("100 MB"), verdict.reason);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await okAsync("stage is cleaned up even when the lane fails", async () => {
    const { dir, p } = tmpfile("bad.png", IMAGE_PNG);
    const stageDir = path.join(LIBRARY_HOST, "tmp", "desk-uploads");
    // The stage directory is created on first use, so a machine that has never
    // staged a drop has none -- absent is zero, not a failure. (It read as one on
    // every non-Windows CI runner: ENOENT scandir before the drop even ran.)
    const staged = () => {
      try {
        return fs.readdirSync(stageDir).filter((f) => f.startsWith("drop-")).length;
      } catch {
        return 0;
      }
    };
    const before = staged();
    await routeDrop({ filePath: p, mime: "image/png" }, {
      call: async () => { throw new Error("vision down"); },
    });
    const after = staged();
    assert.strictEqual(after, before, "a staged file was left behind");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── voiceSpeed precedence: explicit -> config -> env -> builtin ──────────

  ok("voiceSpeed: an explicit requested speed beats config and env, clamped", () => {
    assert.strictEqual(voiceSpeed(2, { config: { defaultSpeed: 1 }, env: { DESK_VOICE_SPEED: "3" } }), 2);
    assert.strictEqual(voiceSpeed(99, {}), SPEED_MAX, "clamp ceiling holds for an explicit value");
  });

  ok("voiceSpeed: 0 is an EXPLICIT request (clamped up to the floor), distinct from unset (falls through to config/env/builtin)", () => {
    assert.strictEqual(voiceSpeed(0, { config: { defaultSpeed: 1.9 } }), SPEED_MIN, "explicit 0 must not read as unset");
    assert.strictEqual(voiceSpeed(undefined, { config: { defaultSpeed: 1.9 } }), 1.9, "unset falls through to config");
    assert.strictEqual(voiceSpeed(null, { config: { defaultSpeed: 1.9 } }), 1.9, "null is unset too");
  });

  ok("voiceSpeed: no explicit and no config falls to env, then to the built-in default", () => {
    assert.strictEqual(voiceSpeed(undefined, { env: { DESK_VOICE_SPEED: "2.5" } }), 2.5);
    assert.strictEqual(voiceSpeed(undefined, { env: {} }), SPEED_DEFAULT);
  });

  // ── duration estimate: MP3 byte rate, not the WAV formula ────────────────

  ok("sniffAudioFormat tells MP3 (ID3 tag, and a bare frame sync) from WAV by BYTES, never a declared format field", () => {
    const id3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(20)]).toString("base64");
    const frameSync = Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(20)]).toString("base64");
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(4)]).toString("base64");
    assert.strictEqual(sniffAudioFormat(id3), "mp3");
    assert.strictEqual(sniffAudioFormat(frameSync), "mp3");
    assert.strictEqual(sniffAudioFormat(wav), "wav");
    assert.strictEqual(sniffAudioFormat(""), "unknown");
  });

  ok("estimateDurationMs: a known MP3 byte length lands within 20% of the true length; the old /24000*2 WAV formula does not", () => {
    // 30000 raw bytes at the edge-tts MP3 rate (~6000 B/s) is a true 5.0s clip.
    const rawBytes = 30000;
    const audioBase64 = Buffer.alloc(rawBytes).toString("base64");
    const trueMs = 5000;
    const gotMs = estimateDurationMs(audioBase64, "mp3");
    assert.ok(Math.abs(gotMs - trueMs) / trueMs <= 0.2, `${gotMs}ms not within 20% of ${trueMs}ms`);
    // The OLD formula this unit replaces: bytes / (24000*2), as if 24kHz 16-bit WAV.
    const oldFormulaMs = Math.round(((audioBase64.length * 0.75) / (24000 * 2)) * 1000);
    assert.ok(Math.abs(oldFormulaMs - trueMs) / trueMs > 0.2, "the old WAV formula must FAIL this same arm (that is the bug being fixed)");
  });

  ok("pickDurationMs: rejects a service duration far outside the byte-rate plausibility band (today's /32000 bug), accepts one inside it", () => {
    const rawBytes = 30000;
    const audioBase64 = Buffer.alloc(rawBytes).toString("base64");
    const derivedMs = estimateDurationMs(audioBase64, "mp3"); // ~5000ms
    // Today's server bug: bytes/32000, ~5x too short for these same bytes.
    const buggyServiceSeconds = rawBytes / 32000;
    assert.strictEqual(pickDurationMs(buggyServiceSeconds, audioBase64, "mp3"), derivedMs, "an implausible service duration must be REJECTED in favour of the derived one");
    // Once U16 lands the server reports something close to the true length.
    const plausibleServiceSeconds = 5.1;
    assert.strictEqual(pickDurationMs(plausibleServiceSeconds, audioBase64, "mp3"), 5100, "a plausible service duration wins (it is the more precise figure)");
    // No service figure at all -> the derived estimate, not zero/NaN.
    assert.strictEqual(pickDurationMs(NaN, audioBase64, "mp3"), derivedMs);
  });

  // ── synthesizeVerdict: configurable endpoint, honest duration end-to-end ──

  function withFakeVoiceServer(handler) {
    return new Promise((resolveServer, rejectServer) => {
      const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => handler(req, res, raw));
      });
      server.on("error", rejectServer);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        resolveServer({ port, close: () => new Promise((r) => server.close(r)) });
      });
    });
  }

  await okAsync("synthesizeVerdict dials the INJECTED endpoint, never the literal 127.0.0.1:8084", async () => {
    const rawBytes = 12000;
    const audioBase64 = Buffer.alloc(rawBytes).toString("base64");
    let seenPath = null;
    let seenBody = null;
    const server = await withFakeVoiceServer((req, res, raw) => {
      seenPath = req.url;
      seenBody = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, audio_base64: audioBase64 }));
    });
    try {
      const verdict = await synthesizeVerdict("hello from the injected endpoint", "nova", {
        speed: 1.5,
        endpoint: { host: "127.0.0.1", port: server.port, path: "/custom/synth" },
      });
      assert.ok(verdict.ok, verdict.reason);
      assert.strictEqual(seenPath, "/custom/synth");
      assert.strictEqual(seenBody.text, "hello from the injected endpoint");
      assert.strictEqual(seenBody.speed, 1.5);
      // A within-20%-of-derived duration, not the raw estimate re-derived here
      // (already proven above) -- just that SOME positive duration came back.
      assert.ok(verdict.durationMs > 0, verdict.durationMs);
    } finally {
      await server.close();
    }
  });

  await okAsync("synthesizeVerdict: a refused connection resolves {ok:false,reason} with no retry storm", async () => {
    // Bind a server, learn a free port, then close it -- the port refuses.
    const probe = await withFakeVoiceServer((req, res) => res.end());
    const deadPort = probe.port;
    await probe.close();
    let calls = 0;
    const started = Date.now();
    const verdict = await synthesizeVerdict("hello", "nova", {
      endpoint: { host: "127.0.0.1", port: deadPort, path: "/voice/synthesize" },
    });
    calls += 1;
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.reason, "a refusal must carry a reason");
    assert.strictEqual(calls, 1, "exactly one attempt -- no retry storm");
    assert.ok(Date.now() - started < 5000, "a refused connection must resolve immediately, not wait out the 90s timeout");
  });

  console.log(`drop-router: ${passed} checks passed`);
  process.exit(process.exitCode ?? 0);
})();
