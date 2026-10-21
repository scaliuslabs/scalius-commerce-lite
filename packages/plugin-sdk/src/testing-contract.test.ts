// createContractApi refuses what the platform refuses. Its contract copy is
// checked against the sealed snapshot by scripts/plugin-contract.test.mjs.
import { describe, expect, it } from "vitest";
import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "./index";
import { createContractApi, createPluginTestHarness, stableContract } from "./testing";

const brand = {
  id: "brand_1", name: "Acme", slug: "acme", status: "published", sortOrder: 0, revision: 3, noIndex: false, excludeFromSitemap: false,
  productCount: 2, logo: null, createdAt: null, updatedAt: null, deletedAt: null, description: null, metaTitle: null,
  metaDescription: null, canonicalPath: null, listingTemplate: null, logoMediaId: null,
};

describe("the SDK's contract copy", () => {
  it("carries every stable operation with its rules", () => {
    expect(stableContract.operations["inventory.adjust"]).toMatchObject({ method: "POST", idempotency: "required", scopes: ["write_inventory"] });
  });
});

describe("createContractApi", () => {
  const api = () => createContractApi({
    handlers: {
      "brands.get": ({ path }) => ({ brand: { ...brand, id: String(path.id) } }),
      "products.list": () => ({ products: [], nextCursor: null }),
      "inventory.adjust": () => ({ ok: false, status: 409, data: null, error: { code: "conflict", message: "Stock changed." } }),
      "brands.update": ({ body }) => ({ brand: { ...brand, name: (body as { name: string }).name, revision: 4 } }),
    },
    checkOutput: true,
  });

  it("refuses an operation outside the stable app API", async () => {
    // As the host (apps/api/src/plugins/api-call.ts): a beta or internal operation exists, so it is refused, not unknown.
    expect(await api()("orders.invoice_get", undefined)).toMatchObject({ ok: false, status: 403, error: { code: "api_operation_not_stable" } });
    expect(await api()("apps.stop", undefined)).toMatchObject({ ok: false, status: 403, error: { code: "api_operation_not_stable" } });
    expect(await api()("apps.nonexistent", undefined)).toMatchObject({ ok: false, status: 404, error: { code: "api_unknown_operation" } });
    expect(await api()("Brands.Get", undefined)).toMatchObject({ status: 404, error: { code: "api_unknown_operation" } });
    expect(() => createContractApi({ handlers: { "brands.fetch": () => null } })).toThrow(/not a stable app API operation/);
  });

  it("checks path and query values the way the route does (DX-2)", async () => {
    const result = await api()("products.list", { query: { status: "archived" } });
    expect(result).toMatchObject({ ok: false, status: 400, error: { code: "validation_error" } });
    expect(result.error?.message).toContain('"active", "draft", "trashed"');
    expect(await api()("brands.get", {})).toMatchObject({ error: { code: "missing_path_parameter" } });
    expect(await api()("brands.get", { path: { id: "b", extra: 1 } })).toMatchObject({ error: { code: "unknown_path_parameter" } });
    expect(await api()("products.list", { query: { limit: "x" } })).toMatchObject({ error: { code: "validation_error" } });
    expect(await api()("products.list", { query: { limit: 10, status: "draft" } })).toMatchObject({ ok: true });
  });

  it("refuses malformed input, a GET body and unknown body fields", async () => {
    expect(await api()("brands.get", { path: { id: "b" }, headers: {} } as never)).toMatchObject({ status: 400, error: { code: "api_invalid_input" } });
    expect(await api()("brands.get", { path: { id: "b" }, body: {} })).toMatchObject({ error: { code: "body_not_allowed" } });
    expect(await api()("brands.update", { path: { id: "b" }, body: { name: "N", slug: "n", status: "draft", expectedRevision: 3, colour: "red" } }))
      .toMatchObject({ error: { code: "unknown_body_property" } });
  });

  it("requires the revision precondition and the Idempotency-Key where the contract does", async () => {
    const missing = await api()("brands.update", { path: { id: "b" }, body: { name: "N", slug: "n", status: "draft" } });
    expect(missing).toMatchObject({ status: 400, error: { code: "validation_error" } });
    expect(missing.error?.message).toMatch(/expectedRevision is required\. This operation is revision-checked/);
    expect(await api()("inventory.adjust", { path: { variantId: "v1" }, body: { delta: 1, reason: "received" } }))
      .toMatchObject({ status: 400, error: { code: "idempotency_key_required" } });
    expect(await api()("brands.get", { path: { id: "b" }, idempotencyKey: "retry-key-1" })).toMatchObject({ error: { code: "idempotency_not_supported" } });
    expect(await api()("inventory.adjust", { path: { variantId: "v1" }, body: { delta: 1, reason: "found" }, idempotencyKey: "retry-key-1" }))
      .toMatchObject({ error: { code: "validation_error" } });
    expect(await api()("inventory.adjust", { path: { variantId: "v1" }, body: { delta: 1, reason: "received" }, idempotencyKey: "retry-key-1" }))
      .toMatchObject({ ok: false, status: 409, error: { code: "conflict" } });
  });

  it("replays a repeat with the same key and refuses the key for another request", async () => {
    let runs = 0;
    const counted = createContractApi({ handlers: { "brands.update": () => ({ brand: { ...brand, revision: 3 + ++runs } }) } });
    const call = { path: { id: "brand_1" }, body: { name: "N", slug: "n", status: "draft", expectedRevision: 3 }, idempotencyKey: "update-brand-1" } as const;
    const first = await counted("brands.update", call);
    expect(await counted("brands.update", call)).toEqual(first);
    expect(runs).toBe(1);
    expect(await counted("brands.update", { ...call, body: { ...call.body, name: "Other" } })).toMatchObject({ status: 422, error: { code: "idempotency_key_reused" } });
    expect(counted.calls).toHaveLength(3);
  });

  it("refuses a call no granted scope covers", async () => {
    expect(await api()("brands.update", { path: { id: "b" } }, { scopes: ["read_orders"] })).toMatchObject({ status: 403, error: { code: "api_operation_forbidden" } });
  });

  it("fails the test when a handler answers a shape the platform never returns", async () => {
    const wrong = createContractApi({ handlers: { "brands.get": () => ({ brand: { ...brand, status: "live" } }) } });
    await expect(wrong("brands.get", { path: { id: "b" } })).rejects.toThrow(/data\.brand\.status must be one of/);
    await expect(api()("orders.list", undefined)).rejects.toThrow(/no handler answers it/);
  });
});

describe("createContractApi in the harness", () => {
  const manifest = {
    id: "acme.brandsync",
    name: "Brand sync",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "Renames brands.",
    author: { name: "Acme" },
    scopes: ["read_products"],
    events: ["order.created"],
  } satisfies PluginManifestInput;

  it("gets the manifest's scopes: a write the app did not ask for is refused", async () => {
    const results: unknown[] = [];
    const plugin = definePlugin({
      manifest,
      events: {
        "order.created": async (_event, ctx) => {
          results.push(await ctx.api.call("brands.get", { path: { id: "brand_1" } }));
          results.push(await ctx.api.call("brands.update", { path: { id: "brand_1" }, body: { name: "N", slug: "n", status: "draft", expectedRevision: 3 } }));
        },
      },
    });
    const api = createContractApi({ handlers: { "brands.get": () => ({ brand }) } });
    const harness = createPluginTestHarness(plugin, { api });
    expect((await harness.event("order.created", { type: "order", id: "o1" })).ok).toBe(true);
    expect(results[0]).toMatchObject({ ok: true, data: { brand: { id: "brand_1" } } });
    expect(results[1]).toMatchObject({ ok: false, status: 403, error: { code: "api_operation_forbidden" } });
  });
});
