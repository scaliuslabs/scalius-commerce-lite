import { describe, expect, it } from "vitest";
import { createPluginTestHarness, parsePluginUiDocument } from "@scalius/plugin-sdk/testing";
import type { PluginApiCallInput, PluginApiResult } from "@scalius/plugin-sdk";
import { VOLT_DEMO_PACK } from "../demo-pack";
import plugin from "./index";
import { byDepth, importPlan, optionMatrix, removalOrder, type DemoRecord } from "./demo/plan";
import { JOB_KEY, type DemoJob } from "./demo/run";

/** A store that answers the demo's operations, replays retry keys and can refuse with a conflict. */
function fakeStore(options: { conflictProducts?: Set<string>; failOnce?: string } = {}) {
  const calls: Array<{ operation: string; input: PluginApiCallInput | undefined }> = [];
  const replies = new Map<string, PluginApiResult>();
  const live = new Map<string, { kind: string; body: unknown }>();
  const trashed: string[] = [];
  let next = 0;
  let failed = false;
  const ok = (data: unknown): PluginApiResult => ({ ok: true, status: 200, data, error: null });
  const api = (operation: string, input: PluginApiCallInput | undefined): PluginApiResult => {
    calls.push({ operation, input });
    const key = input?.idempotencyKey;
    if (key && replies.has(key)) return replies.get(key)!;
    if (options.failOnce && operation === options.failOnce && !failed) {
      failed = true;
      return { ok: false, status: 429, data: null, error: { code: "rate_limited", message: "Slow down" } };
    }
    const id = () => `id_${(next += 1)}`;
    let reply: PluginApiResult;
    switch (operation) {
      case "dashboard.media.import_url": {
        const file = { id: `med_${(next += 1)}`, url: `https://media.test/${next}.webp`, filename: `${next}.webp`, size: 100, createdAt: "2026-10-20T00:00:00Z", version: 1 };
        live.set(file.id, { kind: "media", body: input?.body });
        reply = ok({ success: true, data: { file } });
        break;
      }
      case "dashboard.categories.create":
      case "dashboard.brands.create": {
        const created = id();
        live.set(created, { kind: operation, body: input?.body });
        reply = ok({ success: true, data: { id: created, revision: 1, status: "published", slug: "x" } });
        break;
      }
      case "dashboard.products.create": {
        const created = id();
        live.set(created, { kind: "product", body: input?.body });
        reply = ok({ success: true, data: { id: created, aggregateRevision: 1 } });
        break;
      }
      case "dashboard.collections.create": {
        const created = id();
        live.set(created, { kind: "collection", body: input?.body });
        reply = ok({ success: true, data: { id: created, version: 1 } });
        break;
      }
      case "dashboard.brands.trash": {
        const brands = (input?.body as { brands: Array<{ id: string }> }).brands;
        for (const brand of brands) { live.delete(brand.id); trashed.push(brand.id); }
        reply = ok({ success: true, data: { count: brands.length } });
        break;
      }
      case "dashboard.products.trash":
      case "dashboard.collections.trash":
      case "dashboard.categories.trash":
      case "dashboard.media.trash": {
        const target = String(input?.path?.id);
        const product = live.get(target);
        if (operation === "dashboard.products.trash" && product && options.conflictProducts?.has((product.body as { slug: string }).slug)) {
          return { ok: false, status: 409, data: null, error: { code: "conflict", message: "Changed" } };
        }
        live.delete(target);
        trashed.push(target);
        reply = ok({ success: true, data: {} });
        break;
      }
      default:
        return { ok: false, status: 404, data: null, error: { code: "not_found", message: operation } };
    }
    if (key) replies.set(key, reply);
    return reply;
  };
  return { api, calls, live, trashed };
}

async function runUntilIdle(harness: ReturnType<typeof createPluginTestHarness>, route: string, rounds = 20) {
  for (let round = 0; round < rounds; round += 1) {
    const result = await harness.route("admin", route, { method: "POST", body: {} });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const job = await harness.kv.get(JOB_KEY) as DemoJob | undefined;
    if (job?.mode === "idle") return { job, rounds: round + 1 };
  }
  throw new Error("The job never finished.");
}

describe("the demo plan", () => {
  it("orders media before what shows it and parents before children", () => {
    const plan = importPlan(VOLT_DEMO_PACK);
    const position = new Map(plan.map((step, index) => [step.id, index]));
    for (const category of VOLT_DEMO_PACK.categories) {
      if (category.parent) expect(position.get(`category:${category.parent}`)!).toBeLessThan(position.get(`category:${category.key}`)!);
      if (category.image) expect(position.get(`media:category-${category.key}:0`)!).toBeLessThan(position.get(`category:${category.key}`)!);
    }
    for (const product of VOLT_DEMO_PACK.products) {
      expect(position.get(`category:${product.category}`), product.key).toBeDefined();
      if (product.brand) expect(position.get(`brand:${product.brand}`), product.key).toBeDefined();
      expect(position.get(`media:product-${product.key}:0`)!).toBeLessThan(position.get(`product:${product.key}`)!);
    }
    for (const collection of VOLT_DEMO_PACK.collections) {
      for (const key of collection.products) expect(position.get(`product:${key}`), key).toBeDefined();
    }
    expect(new Set(plan.map((step) => step.id)).size).toBe(plan.length);
  });

  it("keeps category names and slugs within the store's rules", () => {
    for (const category of byDepth(VOLT_DEMO_PACK)) {
      expect(category.name.length, category.key).toBeGreaterThanOrEqual(3);
      expect(category.key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(category.depth).toBeLessThan(4);
    }
  });

  it("builds every combination of an optioned product", () => {
    const phone = VOLT_DEMO_PACK.products.find((product) => product.key === "galaxy-s26-ultra")!;
    const matrix = optionMatrix(phone, 5);
    expect(matrix.options.map((option) => option.values.length)).toEqual([3, 3]);
    expect(matrix.variants).toHaveLength(9);
    expect(new Set(matrix.variants.map((variant) => variant.selectedOptionValueIds.join())).size).toBe(9);
    expect(matrix.variants[0]).toMatchObject({ price: 117000, discountType: "flat", discountAmount: 3001, stock: 5 });
  });

  it("removes dependants first and children before parents", () => {
    const record = (kind: DemoRecord["kind"], depth = 0) => ({ kind, key: kind, resource_id: kind, revision: 1, url: null, filename: null, size: null, created_at: null, depth });
    const ordered = removalOrder([
      { id: "media:a:0", data: record("media") },
      { id: "category:top", data: record("category", 0) },
      { id: "category:child", data: record("category", 1) },
      { id: "product:p", data: record("product") },
      { id: "collection:c", data: record("collection") },
      { id: "brand:b", data: record("brand") },
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["collection:c", "product:p", "brand:b", "category:child", "category:top", "media:a:0"]);
  });
});

describe("import and removal", () => {
  it("imports the whole pack in bounded slices and records every item once", async () => {
    const store = fakeStore();
    const harness = createPluginTestHarness(plugin, { api: store.api });
    const { job, rounds } = await runUntilIdle(harness, "demo-import");
    const plan = importPlan(VOLT_DEMO_PACK);
    expect(job.done).toBe(plan.length);
    expect(rounds).toBeGreaterThan(1);
    expect(harness.records.get("demo_items")?.size).toBe(plan.length);
    // One create per step: no duplicates.
    const creates = store.calls.filter((call) => call.operation.endsWith(".create") || call.operation.endsWith(".import_url"));
    expect(creates.length).toBe(plan.filter((step) => step.kind !== "fields").length);
    // Every demo item is hidden from search engines.
    for (const call of creates.filter((entry) => entry.operation !== "dashboard.media.import_url")) {
      expect(call.input?.body, call.operation).toMatchObject({ noIndex: true, excludeFromSitemap: true });
    }
    // The optioned phone carries its matrix, a simple product its stock.
    const phone = creates.find((call) => (call.input?.body as { slug?: string }).slug === "galaxy-s26-ultra")!.input!.body as Record<string, unknown>;
    expect((phone.optionMatrix as { variants: unknown[] }).variants).toHaveLength(9);
    expect((phone.media as unknown[]).length).toBe(3);
    const fryer = creates.find((call) => (call.input?.body as { slug?: string }).slug === "philips-na231")!.input!.body as Record<string, unknown>;
    expect(fryer).toMatchObject({ price: 18500, discountAmount: 6000, defaultSku: { trackInventory: true, stock: 25 } });
  });

  it("does not create twice when a slice stops on a rate limit", async () => {
    const store = fakeStore({ failOnce: "dashboard.products.create" });
    const harness = createPluginTestHarness(plugin, { api: store.api });
    await runUntilIdle(harness, "demo-import");
    const products = store.calls.filter((call) => call.operation === "dashboard.products.create");
    const slugs = products.map((call) => (call.input?.body as { slug: string }).slug);
    expect(new Set(slugs).size).toBe(VOLT_DEMO_PACK.products.length);
  });

  it("removes exactly what it created and keeps what the merchant changed", async () => {
    const store = fakeStore({ conflictProducts: new Set(["iphone-duo"]) });
    const harness = createPluginTestHarness(plugin, { api: store.api });
    await runUntilIdle(harness, "demo-import");
    const before = new Set(store.live.keys());
    const { job } = await runUntilIdle(harness, "demo-remove");
    expect(job.kept).toBe(1);
    expect(harness.records.get("demo_items")?.size ?? 0).toBe(0);
    const left = [...store.live.entries()];
    // Only the changed product stays, with the photo, brand and category chain it shows.
    expect(left.filter(([, entry]) => entry.kind === "product").map(([, entry]) => (entry.body as { slug: string }).slug)).toEqual(["iphone-duo"]);
    expect(left.map(([, entry]) => entry.kind).sort()).toEqual(["dashboard.brands.create", "dashboard.categories.create", "dashboard.categories.create", "media", "media", "product"]);
    for (const id of store.trashed) expect(before.has(id)).toBe(true);
    // Removal again is a no-op.
    const calls = store.calls.length;
    await runUntilIdle(harness, "demo-remove");
    expect(store.calls.slice(calls).filter((call) => call.operation.endsWith("trash"))).toEqual([]);
  });

  it("continues a started import from the cron and does nothing when idle", async () => {
    const store = fakeStore();
    const harness = createPluginTestHarness(plugin, { api: store.api });
    await harness.cron("demo_continue");
    expect(store.calls).toEqual([]);
    await harness.route("admin", "demo-import", { method: "POST", body: {} });
    const after = store.calls.length;
    await harness.cron("demo_continue");
    expect(store.calls.length).toBeGreaterThan(after);
  });

  it("draws the admin page with its progress and actions", async () => {
    const store = fakeStore();
    const harness = createPluginTestHarness(plugin, { api: store.api });
    const empty = await harness.route("admin", "demo");
    expect(JSON.stringify(empty.value)).toContain("Import demo store");
    const valid = (value: unknown) => {
      const document = parsePluginUiDocument((value as { body: unknown }).body);
      return document.ok ? null : document.issues;
    };
    expect(valid(empty.value)).toBeNull();
    await runUntilIdle(harness, "demo-import");
    const imported = await harness.route("admin", "demo");
    expect(valid(imported.value)).toBeNull();
    const page = JSON.stringify(imported.value);
    expect(page).toContain("Remove demo content");
    expect(page).toContain("Finish the home page");
    expect(page).toContain("collection:volt-computers");
  });
});
