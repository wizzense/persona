"use strict";

/**
 * blog-commands — the HOW behind the registry's `blog` records.
 *
 * The registry (command-registry.cjs) says WHAT and WHERE; main.cjs hands a
 * `blog` record here with the palette's typed argument, and this module speaks
 * to the platform gateway's blog_* MCP tools through gateway-mcp.cjs -- the one
 * transport every desk data client already uses, so the desk never grows a
 * second Veil credential or a second URL to drift.
 *
 * Owner ruling 2026-09-19 (.claude/rules/blog-voice.md): machine paths create
 * DRAFTS; a human publishes. Nothing in this file calls blog_publish_post, and
 * every create sends `status: "draft"`. `publish` opens the Veil editor for the
 * slug so the owner reads the draft and flips the status with their own click.
 * The test pins both facts.
 *
 * Electron-free on purpose: `callTool` and `openExternal` are injected, so the
 * verbs run under `node --test` with fakes. main.cjs supplies the real ones.
 */

const { callTool: gatewayCallTool, parseMaybeJson } = require("./gateway-mcp.cjs");

/** Where the Veil editor lives. Measured 2026-09-19 with curl: the apex serves
 *  the editor (`https://aitherium.com/blog/editor/?slug=x` -> 200; the bare
 *  path 301s to that trailing-slash form), while the `api.` host's /blog/editor
 *  answered 503 / timed out. So the default is the host that answered, and the
 *  URL is emitted in the trailing-slash form so no redirect sits between the
 *  click and the editor. Overridable for a tenant Veil via AWDESK_VEIL_URL. */
const DEFAULT_VEIL_URL = "https://aitherium.com";

/** The verbs a registry record may name. A record naming anything else is a
 *  row that does nothing -- the registry test refuses it. */
const BLOG_VERBS = Object.freeze(["list", "draft", "show", "publish"]);

/** A slug is a path segment we hand to openExternal; anything else is refused
 *  before it reaches a URL. Exactly the alphabet Veil's slugify emits
 *  (lib/blog.ts slugify: lowercase [a-z0-9-], at most 80 chars) -- an
 *  uppercase or underscore slug can only ever answer "Not found", so cleanSlug
 *  lowercases first and refuses the rest. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function veilUrl() {
  return String(process.env.AWDESK_VEIL_URL || DEFAULT_VEIL_URL).replace(/\/+$/, "");
}

function editorUrlFor(slug) {
  return `${veilUrl()}/blog/editor/?slug=${encodeURIComponent(slug)}`;
}

function cleanSlug(raw) {
  const slug = String(raw || "").trim().toLowerCase();
  return SLUG_RE.test(slug) ? slug : "";
}

/** Mirror of Veil's slugify (apps/AitherVeil/src/lib/blog.ts) so the desk can
 *  ask "does this title's slug already exist?" BEFORE it sends a create. It
 *  must stay byte-for-byte the same derivation: a drift here is a collision
 *  the probe cannot see. */
function slugify(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function postsFrom(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.posts)) return data.posts;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

function oneLine(text, max = 160) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Turn a tool's text into {data, error}: the blog tools answer JSON strings
 *  and put failures under an `error` key rather than throwing. */
function toolJson(text) {
  const data = parseMaybeJson(text);
  // A gateway denial is prose, not JSON ("Tool 'blog_list_posts' is not
  // available on the platform tier" -- measured 2026-09-19: mcp_blog sits in
  // gateway/tenant.py INTERNAL_MODULES). Hand the sentence back as the error.
  if (data === null) return { data: null, error: oneLine(text, 160) || "empty answer" };
  if (data && typeof data === "object" && !Array.isArray(data) && data.error) {
    return { data, error: String(data.error) + (data.detail ? ` — ${oneLine(data.detail, 120)}` : "") };
  }
  return { data, error: null };
}

async function listPosts(callTool) {
  const { data, error } = toolJson(await callTool("blog_list_posts", { include_drafts: true }));
  if (error) return { ok: false, message: `Blog: ${error}` };
  const posts = postsFrom(data);
  const drafts = posts.filter((p) => String(p.status || "").toLowerCase() === "draft");
  const rows = posts.slice(0, 12).map((p) => `${p.slug || "?"} [${p.status || "?"}]`);
  const more = posts.length > rows.length ? ` … +${posts.length - rows.length} more` : "";
  return {
    ok: true,
    posts,
    message: `Blog: ${posts.length} post${posts.length === 1 ? "" : "s"}, ${drafts.length} draft${drafts.length === 1 ? "" : "s"}`
      + (rows.length ? ` — ${rows.join(", ")}${more}` : ""),
  };
}

async function showPost(callTool, slugRaw) {
  const slug = cleanSlug(slugRaw);
  if (!slug) return { ok: false, message: "Blog: a slug is lowercase letters, digits and - only" };
  const { data, error } = toolJson(await callTool("blog_get_post", { slug }));
  if (error) return { ok: false, slug, message: `Blog: ${slug}: ${error}` };
  const post = (data && data.post) || data || {};
  const bits = [post.title || slug, post.status, post.date, post.readTime].filter(Boolean);
  return {
    ok: true,
    slug,
    post,
    message: `${bits.join(" · ")}${post.excerpt ? ` — ${oneLine(post.excerpt)}` : ""}`,
  };
}

/**
 * Create a draft -- but only into a slug that does not exist yet.
 *
 * Veil's POST /api/blog derives slug = slugify(title) and, when that slug is
 * already a post, MERGES the incoming fields onto it (route.ts: content,
 * excerpt, tags and status all take the incoming value). Typing the title of a
 * live post would therefore replace its body with the placeholder and flip it
 * published -> draft from a machine path. So: derive the slug the way Veil
 * does, look it up, and create only on an explicit "Not found". Any other
 * answer (a gateway denial, an HTTP error, an unreadable catalogue) refuses --
 * a catalogue you cannot read is one you cannot safely create into.
 */
async function createDraft(callTool, openExternal, titleRaw) {
  const title = oneLine(titleRaw, 200);
  if (!title) return { ok: false, message: "Blog: a draft needs a title" };
  const wanted = slugify(title);
  if (!wanted) return { ok: false, message: `Blog: "${title}" leaves no slug once slugified` };
  const probe = toolJson(await callTool("blog_get_post", { slug: wanted }));
  if (!probe.error) {
    const found = (probe.data && probe.data.post) || probe.data || {};
    const status = String(found.status || "unknown").toLowerCase();
    return {
      ok: false,
      slug: wanted,
      message: `Blog: ${wanted} already exists (${status}) — open it in the editor instead`,
    };
  }
  if (!/not found/i.test(probe.error)) {
    return { ok: false, slug: wanted, message: `Blog: cannot check whether ${wanted} exists (${probe.error}) — not creating` };
  }
  const { data, error } = toolJson(await callTool("blog_create_post", {
    title,
    content: `# ${title}\n\n_Draft created from Desk. Write the post in the Veil editor._\n`,
    excerpt: "",
    tags: [],
    // The owner's rule, stated where it is enforced: a machine creates a DRAFT.
    status: "draft",
    wiki_enrich: false,
  }));
  if (error) return { ok: false, message: `Blog: could not create "${title}": ${error}` };
  const slug = cleanSlug(data && data.slug);
  if (!slug) return { ok: false, message: `Blog: draft created but Veil returned no slug (${oneLine(JSON.stringify(data), 100)})` };
  const url = editorUrlFor(slug);
  await openExternal(url);
  return { ok: true, slug, url, message: `Blog: draft "${title}" created as ${slug} — opened in the editor` };
}

/**
 * The publish verb that does NOT publish. It looks the slug up so a typo says so
 * instead of opening an editor on nothing, then opens the Veil editor where the
 * owner's own click flips the status. If the gateway cannot be reached the
 * editor still opens -- the editor is the source of truth, not this lookup.
 */
async function openForPublish(callTool, openExternal, slugRaw) {
  const slug = cleanSlug(slugRaw);
  if (!slug) return { ok: false, message: "Blog: a slug is lowercase letters, digits and - only" };
  let note = "";
  try {
    const { data, error } = toolJson(await callTool("blog_get_post", { slug }));
    if (error && /not found/i.test(error)) return { ok: false, slug, message: `Blog: no post ${slug}` };
    if (error) note = ` (lookup failed: ${error})`;
    else {
      const status = String((data && (data.status || (data.post && data.post.status))) || "").toLowerCase();
      if (status && status !== "draft") note = ` (status is already ${status})`;
    }
  } catch (err) {
    note = ` (gateway unreachable: ${oneLine(err && err.message, 80)})`;
  }
  const url = editorUrlFor(slug);
  await openExternal(url);
  return { ok: true, slug, url, message: `Blog: opened ${slug} in the Veil editor — publish is your click there${note}` };
}

/**
 * Run one blog verb. Resolves `{ ok, message, ... }`, never throws: a palette
 * or tray that dies on one bad gateway answer is worse than one that says so.
 */
async function runBlogCommand(command, arg, { callTool = gatewayCallTool, openExternal } = {}) {
  const verb = command && command.blog;
  if (typeof openExternal !== "function") openExternal = async () => {};
  try {
    switch (verb) {
      case "list": return await listPosts(callTool);
      case "show": return await showPost(callTool, arg);
      case "draft": return await createDraft(callTool, openExternal, arg);
      case "publish": return await openForPublish(callTool, openExternal, arg);
      default: return { ok: false, message: `Blog: unknown verb "${verb}"` };
    }
  } catch (err) {
    return { ok: false, message: `Blog: ${oneLine(err && err.message ? err.message : err, 200)}` };
  }
}

module.exports = {
  BLOG_VERBS, DEFAULT_VEIL_URL, SLUG_RE, cleanSlug, editorUrlFor, runBlogCommand, slugify, veilUrl,
};
