import { describe, expect, it } from "vitest";
import { createPluginTestHarness, parsePluginUiDocument } from "@scalius/plugin-sdk/testing";
import type { PluginApiCallInput } from "@scalius/plugin-sdk";
import plugin from "./index";
import { DEMO_PRODUCTS } from "./demo/pack";

/** A fake store: products.create makes a product, get reads it, trash marks it deleted. */
function fakeStore(options: { failCreate?: string } = {}) {
  const products = new Map<string, { revision: number; deletedAt: string | null; body: Record<string, unknown> }>();
  const calls: Array<{ op: string; input: PluginApiCallInput | undefined }> = [];
  let next = 1;
  const api = async (op: string, input: PluginApiCallInput | undefined) => {
    calls.push({ op, input });
    if (op === "dashboard.products.create") {
      const body = input?.body as Record<string, unknown>;
      if (options.failCreate && String(body.slug).endsWith(options.failCreate)) return { ok: false, status: 422, data: null, error: { code: "validation", message: "bad" } };
      const id = `prd_${next++}`;
      products.set(id, { revision: 1, deletedAt: null, body });
      return { ok: true, status: 201, data: { success: true, data: { product: { id } } }, error: null };
    }
    if (op === "dashboard.resources.products.get") {
      const product = products.get(String(input?.path?.id));
      return product ? { ok: true, status: 200, data: { success: true, data: { revision: product.revision, deletedAt: product.deletedAt } }, error: null } : { ok: false, status: 404, data: null, error: { code: "not_found", message: "" } };
    }
    if (op === "dashboard.products.trash") {
      const product = products.get(String(input?.path?.id))!;
      product.deletedAt = "2026-10-20T00:00:00.000Z";
      return { ok: true, status: 200, data: { success: true, data: { aggregateRevision: product.revision + 1 } }, error: null };
    }
    if (op === "dashboard.media.import_url") return { ok: true, status: 201, data: { success: true, data: { file: { id: `med_${next++}` } } }, error: null };
    return { ok: true, status: 200, data: {}, error: null };
  };
  return { products, calls, api };
}

describe("Bazaar demo content", () => {
  it("imports the pack in bounded runs, once, and tracks each item in Objects", async () => {
    const store = fakeStore();
    const harness = createPluginTestHarness(plugin, { api: store.api });
    const first = await harness.route("admin", "demo-import", { method: "POST" });
    expect(first.ok).toBe(true);
    expect(store.products.size).toBe(8);
    await harness.route("admin", "demo-import", { method: "POST" });
    expect(store.products.size).toBe(DEMO_PRODUCTS.length);
    // A third click finds everything imported and creates nothing.
    await harness.route("admin", "demo-import", { method: "POST" });
    expect(store.products.size).toBe(DEMO_PRODUCTS.length);
    const records = [...(harness.records.get("demo_items")?.values() ?? [])] as Array<Record<string, unknown>>;
    expect(records).toHaveLength(DEMO_PRODUCTS.length);
    expect(records.every((record) => record.status === "imported" && typeof record.resource_id === "string")).toBe(true);
    // No photo folder set: no media imports.
    expect(store.calls.some((call) => call.op === "dashboard.media.import_url")).toBe(false);
  });

  it("imports photos only from the merchant's https folder", async () => {
    const store = fakeStore();
    const harness = createPluginTestHarness(plugin, { api: store.api, settings: { demo_image_base: "https://photos.example.com/bazaar/" } });
    await harness.route("admin", "demo-import", { method: "POST" });
    const media = store.calls.filter((call) => call.op === "dashboard.media.import_url");
    expect(media).toHaveLength(8);
    expect((media[0]!.input?.body as { sourceUrl: string }).sourceUrl).toBe(`https://photos.example.com/bazaar/${DEMO_PRODUCTS[0]!.image}`);
    const created = [...store.products.values()][0]!.body;
    expect(created.media).toEqual([expect.objectContaining({ isPrimary: true })]);
  });

  it("leaves a failed item pending and retries it on the next import", async () => {
    const store = fakeStore({ failCreate: DEMO_PRODUCTS[0]!.key });
    const harness = createPluginTestHarness(plugin, { api: store.api });
    await harness.route("admin", "demo-import", { method: "POST" });
    const record = harness.records.get("demo_items")?.get(`product:${DEMO_PRODUCTS[0]!.key}`) as Record<string, unknown>;
    expect(record.status).toBe("pending");
  });

  it("removes exactly what it imported, moving the products to the trash", async () => {
    const store = fakeStore();
    const harness = createPluginTestHarness(plugin, { api: store.api });
    await harness.route("admin", "demo-import", { method: "POST" });
    await harness.route("admin", "demo-import", { method: "POST" });
    await harness.route("admin", "demo-remove", { method: "POST" });
    await harness.route("admin", "demo-remove", { method: "POST" });
    expect([...store.products.values()].every((product) => product.deletedAt !== null)).toBe(true);
    expect(harness.records.get("demo_items")?.size ?? 0).toBe(0);
    const trash = store.calls.filter((call) => call.op === "dashboard.products.trash");
    expect(trash).toHaveLength(DEMO_PRODUCTS.length);
    expect(trash[0]!.input?.query).toEqual({ expectedAggregateRevision: 1 });
  });

  it("answers its page with a valid UI document", async () => {
    const harness = createPluginTestHarness(plugin, { api: fakeStore().api });
    const page = await harness.route("admin", "demo");
    const document = parsePluginUiDocument((page.value as { body: unknown }).body);
    expect(document.ok).toBe(true);
  });
});
