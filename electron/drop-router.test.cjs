"use strict";

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

const { routeDrop, kindOf } = require("./drop-router.cjs");

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
    const stageDir = path.join("C:\\AitherOS-Data\\Library", "tmp", "desk-uploads");
    const before = fs.readdirSync(stageDir).filter((f) => f.startsWith("drop-")).length;
    await routeDrop({ filePath: p, mime: "image/png" }, {
      call: async () => { throw new Error("vision down"); },
    });
    const after = fs.readdirSync(stageDir).filter((f) => f.startsWith("drop-")).length;
    assert.strictEqual(after, before, "a staged file was left behind");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`drop-router: ${passed} checks passed`);
  process.exit(process.exitCode ?? 0);
})();
