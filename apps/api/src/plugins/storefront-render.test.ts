// Storefront app output (plugins/storefront-render.ts) on the real migrated
// schema with an in-process app: what it may do while drawing (render mode),
// how its HTML is sanitized and bounded, how it fails, and which dependency
// keys the drawn output carries; and that the plugin module's writes advance
// exactly those keys in their own batch.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { withDependencyScope } from "@scalius/core/cache-deps";
import {
  activatePlugin,
  deactivatePlugin,
  installPlugin,
  listPluginLogs,
  putPluginRecord,
  requirePluginInstallation,
  setPluginKv,
  writePluginSettings,
} from "@scalius/core/modules/plugins";
import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";
import { BundledLoader } from "./loaders/bundled";
import { renderAppSurfaces, type AppSurfaceRequest } from "./storefront-render";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";

const SHA = "a".repeat(64);
let behaviour: "normal" | "kv" | "undeclared" | "write" | "throw" | "invalid" | "huge" | "script" | "no-content" | "empty" | "unavailable" = "normal";
let invocations = 0;

const manifest = {
  id: "acme.reviews",
  name: "Reviews",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Reviews section for the storefront test.",
  author: { name: "Acme" },
  routes: { public: [{ name: "section", methods: ["GET"] }, { name: "block", methods: ["GET"] }] },
  storage: { reviews: { indexes: ["productId"] }, drafts: {} },
  settings: [{ key: "tone", label: "Tone", type: "text", default: "warm" }],
  storefront: {
    head: true,
    sections: [{
      type: "latest",
      name: "Latest reviews",
      route: "section",
      reads: ["reviews"],
      settings: [{ key: "heading", label: "Heading", type: "text", default: "What buyers say" }],
    }],
    productBlocks: [{ type: "stars", name: "Stars", placement: "buy-box", route: "block", settings: [] }],
  },
} satisfies PluginManifestInput;

const app = definePlugin({
  manifest,
  routes: {
    public: {
      section: async (request, ctx) => {
        invocations += 1;
        if (behaviour === "kv") await ctx.kv.get("x");
        if (behaviour === "undeclared") await ctx.storage.drafts!.get("x");
        if (behaviour === "write") await ctx.storage.reviews!.put("x", { productId: "p" });
        if (behaviour === "throw") throw new Error("boom");
        if (behaviour === "invalid") return { body: { markup: "<p>x</p>" } };
        if (behaviour === "huge") return { body: { html: `<p>${"x".repeat(130 * 1024)}</p>` } };
        if (behaviour === "no-content") return { status: 204 };
        if (behaviour === "empty") return { body: { html: "" } };
        if (behaviour === "unavailable") return { status: 503 };
        const count = await ctx.storage.reviews!.count();
        const heading = String(request.render?.settings.heading ?? "");
        const script = behaviour === "script" ? '<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">x</a>' : "";
        return {
          body: {
            html: `<section><h2>${heading}</h2><p>${count} reviews · ${String(ctx.settings.tone)} · ${ctx.store.currency}</p>${script}</section>`,
            head: { meta: [{ name: "robots", content: "noindex" }, { name: "acme-reviews", content: String(count) }], jsonLd: [{ "@context": "https://schema.org", "@type": "Organization", name: "</script>" }] },
          },
        };
      },
      block: (request) => {
        invocations += 1;
        return { body: { html: `<p data-product="${request.render?.product?.id ?? ""}">★★★★★</p>` } };
      },
    },
  },
});

describe("storefront app output", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let binding: D1Database;

  const env = () => pluginTestEnv(binding);
  const loaderFor = () => new BundledLoader(
    { env: env(), ctx: pluginTestCtx(), db: () => db, composedEnv: async () => env() },
    { "acme.reviews": { version: "1.0.0", sha256: SHA, load: async () => app } },
  );
  const section = (values: Record<string, unknown> = {}): AppSurfaceRequest => ({
    instanceId: "s1", pluginId: "acme.reviews", type: "latest", kind: "section", values: values as AppSurfaceRequest["values"],
  });
  const draw = (requests: AppSurfaceRequest[]) => withDependencyScope(
    () => renderAppSurfaces(requests, { env: env(), ctx: pluginTestCtx(), db, loaderFor }),
    { label: "/test" },
  );
  const seq = (dep: string) => (sqlite.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(dep) as { seq: number } | undefined)?.seq ?? 0;

  beforeEach(async () => {
    ({ sqlite, db, binding } = createSqliteD1Database());
    behaviour = "normal";
    invocations = 0;
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    const installed = await installPlugin(db, { manifest, source: "bundled", bundleSha256: SHA, actorUserId: "owner" });
    await activatePlugin(db, "acme.reviews", { actorUserId: "owner", expectedRevision: installed.revision });
    await putPluginRecord(db, "acme.reviews", "reviews", { indexes: ["productId"], unique: [] }, "r1", { productId: "p1" });
  });
  afterEach(() => sqlite.close());

  it("draws a section from its settings and declared collection, sanitized, with the keys it depends on", async () => {
    behaviour = "script";
    const { value, dependencies } = await draw([section({ heading: "Loved <b>it</b>" })]);
    expect(value).toHaveLength(1);
    const [drawn] = value;
    // The script goes with its content, the image without a safe source goes, the link loses its href.
    expect(drawn!.html).toBe("<section><h2>Loved <b>it</b></h2><p>1 reviews · warm · BDT</p><a>x</a></section>");
    expect(drawn!.html).not.toMatch(/script|onerror|javascript/);
    // The page owns robots; JSON-LD is serialized so it cannot close its script element.
    expect(drawn!.head.meta).toEqual([{ attribute: "name", key: "acme-reviews", content: "1" }]);
    expect(drawn!.head.jsonLd).toEqual(['{"@context":"https://schema.org","@type":"Organization","name":"\\u003c/script\\u003e"}']);
    expect(dependencies.keys).toEqual(expect.arrayContaining([
      "plg:acme.reviews",
      "plgs:acme.reviews:reviews",
      "set:business:document",
      "set:currency:document",
      "set:platform:document",
    ]));
    // Only the declared collection: never one it does not read, never KV.
    expect(dependencies.keys.filter((key) => key.startsWith("plgs:"))).toEqual(["plgs:acme.reviews:reviews"]);
    expect(dependencies.uncacheable).toEqual([]);
    expect(dependencies.validUntil).toBeNull();
    expect(dependencies.coarseTables).toEqual([]);
  });

  it("passes the product to a block and its placement back", async () => {
    const { value } = await draw([{
      instanceId: "b1", pluginId: "acme.reviews", type: "stars", kind: "product-block", values: {},
      product: { id: "p_linen", slug: "linen", categoryId: null, brandId: null },
    }]);
    expect(value).toEqual([expect.objectContaining({ instanceId: "b1", placement: "buy-box", html: '<p data-product="p_linen">★★★★★</p>' })]);
  });

  it.each(["kv", "undeclared", "write"] as const)("refuses %s while drawing: nothing is drawn and the entry is retried soon", async (mode) => {
    behaviour = mode;
    const before = Date.now();
    const { value, dependencies } = await draw([section()]);
    expect(value).toEqual([]);
    expect(dependencies.validUntil).toBeGreaterThanOrEqual(before + 59_000);
    expect(dependencies.validUntil).toBeLessThanOrEqual(Date.now() + 60_000);
    const logs = await listPluginLogs(db, "acme.reviews");
    expect(logs.map((line) => line.message).join("\n")).toMatch(mode === "undeclared" ? /not in this section's reads/ : /While drawing storefront output/);
  });

  it("draws nothing for a throw (retried soon), an invalid answer or oversized HTML (cached: the same input fails the same way)", async () => {
    behaviour = "throw";
    expect((await draw([section()])).dependencies.validUntil).not.toBeNull();
    behaviour = "invalid";
    const invalid = await draw([section()]);
    expect(invalid.value).toEqual([]);
    expect(invalid.dependencies.validUntil).toBeNull();
    behaviour = "huge";
    const huge = await draw([section()]);
    expect(huge.value).toEqual([]);
    expect((await listPluginLogs(db, "acme.reviews")).map((line) => line.message).join("\n")).toMatch(/128 KiB/);
  });

  it.each(["throw", "invalid", "huge", "unavailable"] as const)("reports a runnable app's %s to the preview instead of a successful empty update", async (mode) => {
    behaviour = mode;
    await expect(renderAppSurfaces([section()], { env: env(), ctx: pluginTestCtx(), db, loaderFor, failOnError: true }))
      .rejects.toThrow("Preview app render failed");
  });

  it.each(["no-content", "empty"] as const)("preserves a successful %s app answer in the preview", async (mode) => {
    behaviour = mode;
    expect(await renderAppSurfaces([section()], { env: env(), ctx: pluginTestCtx(), db, loaderFor, failOnError: true })).toEqual([]);
    expect((await draw([section()])).value).toEqual([]);
  });

  it("still treats an unavailable app as legitimately absent in a preview", async () => {
    expect(await renderAppSurfaces([{ ...section(), pluginId: "acme.gone" }],
      { env: env(), ctx: pluginTestCtx(), db, loaderFor, failOnError: true })).toEqual([]);
  });

  it("draws nothing for an inactive app or an undeclared type, yet depends on the installation", async () => {
    const current = await requirePluginInstallation(db, "acme.reviews");
    await deactivatePlugin(db, "acme.reviews", { expectedRevision: current.revision });
    const inactive = await draw([section()]);
    expect(inactive.value).toEqual([]);
    expect(inactive.dependencies.keys).toContain("plg:acme.reviews");
    expect(invocations).toBe(0);
    const unknown = await draw([{ ...section(), pluginId: "acme.gone", type: "x" }]);
    expect(unknown.value).toEqual([]);
    expect(unknown.dependencies.keys).toContain("plg:acme.gone");
  });

  it("advances the keys the output depends on with each write, in the write's own batch", async () => {
    const reviews = seq("plgs:acme.reviews:reviews");
    const drafts = seq("plgs:acme.reviews:drafts");
    const plugin = seq("plg:acme.reviews");
    const any = seq("plg:*");
    expect(reviews).toBeGreaterThan(0);

    await putPluginRecord(db, "acme.reviews", "reviews", { indexes: ["productId"], unique: [] }, "r2", { productId: "p2" });
    expect(seq("plgs:acme.reviews:reviews")).toBeGreaterThan(reviews);
    expect(seq("plgs:acme.reviews:drafts")).toBe(drafts);
    expect(seq("plg:acme.reviews")).toBe(plugin);

    // KV is never readable while drawing: its writes advance nothing.
    const clock = (sqlite.prepare("SELECT seq FROM cache_clock WHERE id = 1").get() as { seq: number }).seq;
    await setPluginKv(db, "acme.reviews", "k", 1);
    expect((sqlite.prepare("SELECT seq FROM cache_clock WHERE id = 1").get() as { seq: number }).seq).toBe(clock);

    const current = await requirePluginInstallation(db, "acme.reviews");
    await writePluginSettings(db, "acme.reviews", { tone: "cool" }, { expectedRevision: current.revision, credentialEncryptionKey: null });
    expect(seq("plg:acme.reviews")).toBeGreaterThan(plugin);
    expect(seq("plg:*")).toBeGreaterThan(any);
    // The clock moved with every advanced key.
    expect((sqlite.prepare("SELECT seq FROM cache_clock WHERE id = 1").get() as { seq: number }).seq).toBe(seq("plg:acme.reviews"));
  });
});
