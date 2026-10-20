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
    expect(stableContract.operations["dashboard.inventory.adjust"]).toMatchObject({ method: "POST", idempotency: "required", scopes: ["write_inventory"] });
  });
});

describe("createContractApi", () => {
  const api = () => createContractApi({
    handlers: {
      "dashboard.brands.get": ({ path }) => ({ ...brand, id: String(path.id) }),
      "dashboard.categories.get_section": () => ({ section: "text", field: "description", value: "", totalCharacters: 0, offset: 0, nextOffset: null, isNull: true }),
      "dashboard.inventory.adjust": () => ({ ok: false, status: 409, data: null, error: { code: "CONFLICT", message: "Stock changed." } }),
      "dashboard.brands.update": ({ body }) => ({ ...brand, name: (body as { name: string }).name, revision: 4 }),
    },
    checkOutput: true,
  });

  it("refuses an operation outside the stable app API", async () => {
    // As the host (apps/api/src/plugins/api-call.ts): a beta or internal operation exists, so it is refused, not unknown.
    expect(await api()("dashboard.orders.list", undefined)).toMatchObject({ ok: false, status: 403, error: { code: "api.operation_not_stable" } });
    expect(await api()("dashboard.apps.stop", undefined)).toMatchObject({ ok: false, status: 403, error: { code: "api.operation_not_stable" } });
    expect(await api()("dashboard.apps.nonexistent", undefined)).toMatchObject({ ok: false, status: 404, error: { code: "api.unknown_operation" } });
    expect(await api()("Brands.Get", undefined)).toMatchObject({ status: 404, error: { code: "api.unknown_operation" } });
    expect(() => createContractApi({ handlers: { "dashboard.brands.fetch": () => null } })).toThrow(/not a stable app API operation/);
  });

  it("checks path enums the way the route does (DX-2: section core)", async () => {
    const result = await api()("dashboard.categories.get_section", { path: { id: "cat_1", section: "core" } });
    expect(result).toMatchObject({ ok: false, status: 400, error: { code: "VALIDATION_ERROR" } });
    expect(result.error?.message).toContain('"summary", "text"');
    expect(await api()("dashboard.categories.get_section", { path: { id: "cat_1" } })).toMatchObject({ error: { code: "missing_path_parameter" } });
    expect(await api()("dashboard.categories.get_section", { path: { id: "cat_1", section: "text", extra: 1 } })).toMatchObject({ error: { code: "unknown_path_parameter" } });
    expect(await api()("dashboard.categories.get_section", { path: { id: "cat_1", section: "text" }, query: { offset: "x" } })).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(await api()("dashboard.categories.get_section", { path: { id: "cat_1", section: "text" }, query: { offset: 10, field: null } })).toMatchObject({ ok: true });
  });

  it("refuses malformed input, a GET body and unknown body fields", async () => {
    expect(await api()("dashboard.brands.get", { path: { id: "b" }, headers: {} } as never)).toMatchObject({ status: 400, error: { code: "api.invalid_input" } });
    expect(await api()("dashboard.brands.get", { path: { id: "b" }, body: {} })).toMatchObject({ error: { code: "body_not_allowed" } });
    expect(await api()("dashboard.brands.update", { path: { id: "b" }, body: { name: "N", slug: "n", status: "draft", expectedRevision: 3, colour: "red" } }))
      .toMatchObject({ error: { code: "unknown_body_property" } });
  });

  it("requires the revision precondition and the Idempotency-Key where the contract does", async () => {
    const missing = await api()("dashboard.brands.update", { path: { id: "b" }, body: { name: "N", slug: "n", status: "draft" } });
    expect(missing).toMatchObject({ status: 400, error: { code: "VALIDATION_ERROR" } });
    expect(missing.error?.message).toMatch(/expectedRevision is required\. This operation is revision-checked/);
    expect(await api()("dashboard.inventory.adjust", { path: { variantId: "v1" }, body: { delta: 1, reason: "received" } }))
      .toMatchObject({ status: 400, error: { code: "idempotency_key_required" } });
    expect(await api()("dashboard.brands.get", { path: { id: "b" }, idempotencyKey: "retry-key-1" })).toMatchObject({ error: { code: "idempotency_not_supported" } });
    expect(await api()("dashboard.inventory.adjust", { path: { variantId: "v1" }, body: { delta: 1, reason: "found" }, idempotencyKey: "retry-key-1" }))
      .toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(await api()("dashboard.inventory.adjust", { path: { variantId: "v1" }, body: { delta: 1, reason: "received" }, idempotencyKey: "retry-key-1" }))
      .toMatchObject({ ok: false, status: 409, error: { code: "CONFLICT" } });
  });

  it("replays a repeat with the same key and refuses the key for another request", async () => {
    let runs = 0;
    const counted = createContractApi({ handlers: { "dashboard.brands.update": () => ({ ...brand, revision: 3 + ++runs }) } });
    const call = { path: { id: "brand_1" }, body: { name: "N", slug: "n", status: "draft", expectedRevision: 3 }, idempotencyKey: "update-brand-1" } as const;
    const first = await counted("dashboard.brands.update", call);
    expect(await counted("dashboard.brands.update", call)).toEqual(first);
    expect(runs).toBe(1);
    expect(await counted("dashboard.brands.update", { ...call, body: { ...call.body, name: "Other" } })).toMatchObject({ status: 422, error: { code: "idempotency_key_reused" } });
    expect(counted.calls).toHaveLength(3);
  });

  it("refuses a call no granted scope covers", async () => {
    expect(await api()("dashboard.brands.update", { path: { id: "b" } }, { scopes: ["read_orders"] })).toMatchObject({ status: 403, error: { code: "api.operation_forbidden" } });
  });

  it("fails the test when a handler answers a shape the platform never returns", async () => {
    const wrong = createContractApi({ handlers: { "dashboard.brands.get": () => ({ ...brand, status: "live" }) } });
    await expect(wrong("dashboard.brands.get", { path: { id: "b" } })).rejects.toThrow(/data\.status must be one of/);
    await expect(api()("dashboard.brands.list", undefined)).rejects.toThrow(/no handler answers it/);
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
          results.push(await ctx.api.call("dashboard.brands.get", { path: { id: "brand_1" } }));
          results.push(await ctx.api.call("dashboard.brands.update", { path: { id: "brand_1" }, body: { name: "N", slug: "n", status: "draft", expectedRevision: 3 } }));
        },
      },
    });
    const api = createContractApi({ handlers: { "dashboard.brands.get": () => brand } });
    const harness = createPluginTestHarness(plugin, { api });
    expect((await harness.event("order.created", { type: "order", id: "o1" })).ok).toBe(true);
    expect(results[0]).toMatchObject({ ok: true, data: { id: "brand_1" } });
    expect(results[1]).toMatchObject({ ok: false, status: 403, error: { code: "api.operation_forbidden" } });
  });
});
