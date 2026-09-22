"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const registry = require("./command-registry.cjs");
const {
  BLOG_VERBS, cleanSlug, editorUrlFor, runBlogCommand, slugify,
} = require("./blog-commands.cjs");

/** A callTool fake that records every (name, args) and answers from a table. */
function fakeTools(table) {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    const answer = table[name];
    if (answer === undefined) throw new Error(`${name}: not in the fake`);
    return typeof answer === "function" ? answer(args) : answer;
  };
  return { calls, callTool };
}

function opener() {
  const opened = [];
  return { opened, openExternal: async (url) => { opened.push(url); } };
}

test("the registry's blog verbs are exactly the ones this module runs", () => {
  const verbs = registry.COMMANDS.filter((c) => c.blog).map((c) => c.blog).sort();
  assert.deepEqual(verbs, [...BLOG_VERBS].sort());
});

test("owner ruling: NOTHING here publishes -- publish opens the editor, draft sends status draft", async () => {
  const { calls, callTool } = fakeTools({
    blog_get_post: (args) => (args.slug === "my-post"
      ? JSON.stringify({ slug: "my-post", title: "My post", status: "draft" })
      : JSON.stringify({ error: "Not found", slug: args.slug })),
    blog_create_post: JSON.stringify({ ok: true, slug: "a-title" }),
  });
  const { opened, openExternal } = opener();
  const publish = await runBlogCommand(registry.byId("blog.publish"), "my-post", { callTool, openExternal });
  assert.equal(publish.ok, true);
  assert.deepEqual(opened, [editorUrlFor("my-post")]);
  assert.match(publish.message, /your click/);

  const draft = await runBlogCommand(registry.byId("blog.draft"), "A title", { callTool, openExternal });
  assert.equal(draft.ok, true, draft.message);
  assert.equal(draft.slug, "a-title");
  const create = calls.find((c) => c.name === "blog_create_post");
  assert.equal(create.args.status, "draft");
  assert.equal(create.args.title, "A title");
  assert.ok(create.args.content.includes("A title"));
  assert.equal(opened[1], editorUrlFor("a-title"), "a new draft opens in the editor");

  for (const call of calls) {
    assert.notEqual(call.name, "blog_publish_post", "a machine path called the publish tool");
    if (call.name === "blog_create_post" || call.name === "blog_update_post") {
      assert.equal(call.args.status, "draft");
    }
  }
});

test("publish: a missing slug is refused, a bad slug never reaches a URL, a dead gateway still opens the editor", async () => {
  const { callTool } = fakeTools({
    blog_get_post: JSON.stringify({ error: "Not found", slug: "gone" }),
  });
  const { opened, openExternal } = opener();
  const missing = await runBlogCommand(registry.byId("blog.publish"), "gone", { callTool, openExternal });
  assert.equal(missing.ok, false);
  assert.deepEqual(opened, [], "no editor for a post that does not exist");

  const bad = await runBlogCommand(registry.byId("blog.publish"), "../admin?x=1", { callTool, openExternal });
  assert.equal(bad.ok, false);
  assert.deepEqual(opened, []);
  assert.equal(cleanSlug("  Good-Slug-1 "), "good-slug-1", "a slug is lowercased, as Veil's slugify emits it");
  assert.equal(cleanSlug("Good_slug-1"), "", "underscores never match a real post");
  assert.equal(cleanSlug("has space"), "");
  assert.equal(cleanSlug(`a${"b".repeat(80)}`), "", "slugify caps at 80 chars; longer can only be Not found");
  assert.equal(cleanSlug(`a${"b".repeat(79)}`), `a${"b".repeat(79)}`);

  const down = await runBlogCommand(registry.byId("blog.publish"), "fine-slug", {
    callTool: async () => { throw new Error("ECONNREFUSED"); }, openExternal,
  });
  assert.equal(down.ok, true);
  assert.deepEqual(opened, [editorUrlFor("fine-slug")]);
  assert.match(down.message, /gateway unreachable/);
});

test("list: drafts are asked for and counted; array and {posts} shapes both read", async () => {
  const posts = [
    { slug: "a", status: "published" }, { slug: "b", status: "draft" }, { slug: "c", status: "draft" },
  ];
  for (const shape of [posts, { posts }]) {
    const { calls, callTool } = fakeTools({ blog_list_posts: JSON.stringify(shape) });
    const out = await runBlogCommand(registry.byId("blog.list"), undefined, { callTool });
    assert.equal(out.ok, true);
    assert.equal(calls[0].args.include_drafts, true, "a list that hides drafts hides the owner's own queue");
    assert.match(out.message, /3 posts, 2 drafts/);
    assert.match(out.message, /b \[draft\]/);
    assert.equal(out.posts.length, 3);
  }
});

test("show: the verdict is one line the palette can print; errors say the slug", async () => {
  const { callTool } = fakeTools({
    blog_get_post: (args) => (args.slug === "real"
      ? JSON.stringify({ title: "Real", status: "draft", date: "2026-09-19", readTime: "4 min", excerpt: "Use  it.\nNow." })
      : JSON.stringify({ error: "Not found", slug: args.slug })),
  });
  const ok = await runBlogCommand(registry.byId("blog.show"), "real", { callTool });
  assert.equal(ok.ok, true);
  assert.equal(ok.message, "Real · draft · 2026-09-19 · 4 min — Use it. Now.");
  const gone = await runBlogCommand(registry.byId("blog.show"), "nope", { callTool });
  assert.equal(gone.ok, false);
  assert.match(gone.message, /nope: Not found/);
});

test("slugify mirrors Veil's lib/blog.ts byte for byte", () => {
  // Pairs computed by the TypeScript original's rules; a drift here is a
  // collision the pre-create probe cannot see.
  assert.equal(slugify("Bonsai 2 PTQ verdict"), "bonsai-2-ptq-verdict");
  assert.equal(slugify("  Hello, World! -- again  "), "hello-world-again");
  assert.equal(slugify("--Leading & trailing--"), "leading-trailing");
  assert.equal(slugify("Ünïcode ✓ stripped"), "ncode-stripped");
  assert.equal(slugify("x".repeat(100)).length, 80);
  assert.equal(slugify("!!!"), "");
});

test("draft: NEVER creates into a slug that exists -- Veil's POST merges onto it (published -> draft)", async () => {
  // Veil's POST /api/blog derives slug = slugify(title) and merges incoming
  // fields onto an existing post. Typing a live post's title must refuse.
  const { calls, callTool } = fakeTools({
    blog_get_post: (args) => (args.slug === "bonsai-2-ptq-verdict"
      ? JSON.stringify({ slug: args.slug, title: "Bonsai 2 PTQ verdict", status: "published" })
      : JSON.stringify({ error: "Not found", slug: args.slug })),
    blog_create_post: JSON.stringify({ ok: true, slug: "should-not-happen" }),
  });
  const { opened, openExternal } = opener();
  const clash = await runBlogCommand(registry.byId("blog.draft"), "Bonsai 2 PTQ verdict", { callTool, openExternal });
  assert.equal(clash.ok, false);
  assert.match(clash.message, /already exists \(published\)/);
  assert.deepEqual(calls.map((c) => c.name), ["blog_get_post"], "no create after a hit");
  assert.equal(calls[0].args.slug, "bonsai-2-ptq-verdict", "the probe asks for slugify(title)");
  assert.deepEqual(opened, []);

  // A draft that already exists is a hit too -- the merge would still replace its body.
  const { calls: calls2, callTool: callTool2 } = fakeTools({
    blog_get_post: JSON.stringify({ slug: "wip", status: "draft" }),
    blog_create_post: JSON.stringify({ ok: true, slug: "wip" }),
  });
  const wip = await runBlogCommand(registry.byId("blog.draft"), "WIP", { callTool: callTool2, openExternal });
  assert.equal(wip.ok, false);
  assert.ok(!calls2.some((c) => c.name === "blog_create_post"));

  // Only an explicit Not found lets the create through.
  const { calls: calls3, callTool: callTool3 } = fakeTools({
    blog_get_post: JSON.stringify({ error: "Not found", slug: "fresh-title" }),
    blog_create_post: JSON.stringify({ ok: true, slug: "fresh-title" }),
  });
  const fresh = await runBlogCommand(registry.byId("blog.draft"), "Fresh title", { callTool: callTool3, openExternal });
  assert.equal(fresh.ok, true, fresh.message);
  assert.deepEqual(calls3.map((c) => c.name), ["blog_get_post", "blog_create_post"]);
  assert.equal(calls3[1].args.status, "draft");
  assert.deepEqual(opened, [editorUrlFor("fresh-title")]);
});

test("draft: fails CLOSED when the catalogue cannot be read -- a denial or HTTP error is not Not found", async () => {
  const { opened, openExternal } = opener();
  for (const answer of [
    "Tool 'blog_get_post' is not available on the platform tier. Upgrade to access more tools.",
    JSON.stringify({ error: "HTTP 502", detail: "bad gateway" }),
    JSON.stringify({ error: "ConnectionError" }),
    "",
  ]) {
    const { calls, callTool } = fakeTools({
      blog_get_post: answer,
      blog_create_post: JSON.stringify({ ok: true, slug: "never" }),
    });
    const out = await runBlogCommand(registry.byId("blog.draft"), "Some title", { callTool, openExternal });
    assert.equal(out.ok, false, `created through: ${answer}`);
    assert.match(out.message, /cannot check/);
    assert.deepEqual(calls.map((c) => c.name), ["blog_get_post"], `create sent after: ${answer}`);
  }
  assert.deepEqual(opened, []);
});

test("draft: an empty title is refused before any call; a thrown transport error becomes {ok:false}", async () => {
  const { calls, callTool } = fakeTools({});
  const empty = await runBlogCommand(registry.byId("blog.draft"), "   ", { callTool });
  assert.equal(empty.ok, false);
  assert.equal(calls.length, 0);
  const boom = await runBlogCommand(registry.byId("blog.draft"), "T", {
    callTool: async () => { throw new Error("gateway timeout"); },
  });
  assert.equal(boom.ok, false);
  assert.match(boom.message, /gateway timeout/);
  const unknown = await runBlogCommand({ id: "blog.x", blog: "nuke" }, "", { callTool });
  assert.equal(unknown.ok, false);
});

test("the editor URL honours AWDESK_VEIL_URL and encodes the slug", () => {
  const prior = process.env.AWDESK_VEIL_URL;
  try {
    process.env.AWDESK_VEIL_URL = "https://veil.example.test/";
    assert.equal(editorUrlFor("a-b"), "https://veil.example.test/blog/editor/?slug=a-b");
  } finally {
    if (prior === undefined) delete process.env.AWDESK_VEIL_URL;
    else process.env.AWDESK_VEIL_URL = prior;
  }
});

test("the default editor host is the one that answered 200 (apex, trailing slash), not api.*", () => {
  // Measured 2026-09-19: the api. host's /blog/editor -> 503; aitherium.com/blog/editor/?slug= -> 200.
  const prior = process.env.AWDESK_VEIL_URL;
  try {
    delete process.env.AWDESK_VEIL_URL;
    assert.equal(editorUrlFor("x-y"), "https://aitherium.com/blog/editor/?slug=x-y");
  } finally {
    if (prior === undefined) delete process.env.AWDESK_VEIL_URL;
    else process.env.AWDESK_VEIL_URL = prior;
  }
});
