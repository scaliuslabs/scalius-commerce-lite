// End-to-end store migration over the API routes with the real fixture files:
// the Shopify product CSV parsed and mapped as the dashboard does it, a dry
// run, the write with the dry run's revisions, the image downloads through
// the guarded media URL import (remote fetch and R2 faked), the customer CSV
// with its consent, and the inventory export imported back unchanged.
import { readFileSync } from "node:fs";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { parseImportText } from "@scalius/shared/store-transfer/detect";
import { mapShopifyProducts } from "@scalius/shared/store-transfer/shopify-products";
import { mapCustomers } from "@scalius/shared/store-transfer/customers";
import { mapInventory } from "@scalius/shared/store-transfer/inventory";
import { productImageJobs, type ProductImportItem } from "@scalius/shared/store-transfer/products";
import { errorResponseFromError } from "../../utils/api-response";
import { adminExportRoutes, adminImportRoutes } from "./store-transfer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { success: boolean; data: any; error?: any };

const fixture = (name: string) => readFileSync(new URL(`../../../../../packages/shared/src/store-transfer/fixtures/${name}`, import.meta.url), "utf8");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);

/** An in-memory R2 bucket with the multipart calls media uploads use. */
function fakeBucket() {
  const objects = new Map<string, number>();
  const parts = new Map<string, number>();
  const upload = (key: string, uploadId: string) => ({
    key,
    uploadId,
    uploadPart: async (partNumber: number, value: ArrayBuffer) => {
      parts.set(`${uploadId}:${partNumber}`, value.byteLength);
      return { partNumber, etag: `etag-${partNumber}` };
    },
    complete: async (uploaded: Array<{ partNumber: number }>) => {
      const size = uploaded.reduce((sum, part) => sum + (parts.get(`${uploadId}:${part.partNumber}`) ?? 0), 0);
      objects.set(key, size);
      return { key, size };
    },
    abort: async () => undefined,
  });
  let uploads = 0;
  return {
    objects,
    bucket: {
      createMultipartUpload: async (key: string) => upload(key, `upload-${++uploads}`),
      resumeMultipartUpload: (key: string, uploadId: string) => upload(key, uploadId),
      head: async (key: string) => (objects.has(key) ? { key, size: objects.get(key) } : null),
      delete: async () => undefined,
    } as unknown as R2Bucket,
  };
}

function createApp() {
  const { sqlite, db } = createSqliteD1Database();
  const storage = fakeBucket();
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("user" as never, { id: "usr_import" } as never);
    c.set("adminPermissions" as never, new Set(Object.values(PERMISSIONS)) as never);
    c.env = { SCALIUS_SECRET: "test-master-secret-that-is-long-enough-123456", BUCKET: storage.bucket } as unknown as Env;
    await next();
  });
  app.route("/import", adminImportRoutes);
  app.route("/export", adminExportRoutes);
  const post = async (path: string, body: unknown) => {
    const response = await app.request(`/api/v1/admin/import${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await response.json()) as Envelope;
  };
  return { app, sqlite, post, storage };
}

/** What the dashboard does: batches of `size`, sending again whatever a batch did not process. */
async function sendAll<I, R>(items: readonly I[], size: number, send: (batch: I[]) => Promise<{ results: R[]; processed: number }>): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  while (index < items.length) {
    const batch = items.slice(index, index + size);
    const response = await send(batch);
    results.push(...response.results.slice(0, response.processed));
    index += response.processed;
  }
  return results;
}

const one = <T>(sqlite: DatabaseSync, query: string, ...params: string[]) => sqlite.prepare(query).get(...params) as T;
const all = <T>(sqlite: DatabaseSync, query: string, ...params: string[]) => sqlite.prepare(query).all(...params) as T[];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("store migration over the API", () => {
  it("imports the Shopify fixture with its images, then exports and re-imports inventory unchanged", async () => {
    const { app, sqlite, post, storage } = createApp();
    const mapped = mapShopifyProducts(parseImportText(fixture("shopify-products.csv")).table, { currency: { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 } });
    expect(mapped.items).toHaveLength(6); // The broken-price lamp stays out.

    // Dry run: every product would be created; the write sends the items as they are.
    const preview = await sendAll(mapped.items, 3, async (batch) => (await post("/products", { mode: "upsert", dryRun: true, items: batch })).data);
    expect((preview as Array<{ status: string }>).map((result) => result.status)).toEqual(Array(6).fill("would_create"));
    expect(one<{ n: number }>(sqlite, "SELECT count(*) AS n FROM products").n).toBe(0);

    type Result = { ref: string; status: string; productId: string };
    const written = await sendAll(mapped.items, 3, async (batch) => (await post("/products", { mode: "upsert", items: batch })).data) as Result[];
    expect(written.map((result) => result.status)).toEqual(Array(6).fill("created"));

    // Images: one download per URL (the tee's navy image is used by two rows), one 404.
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
      const url = String(input);
      fetched.push(url);
      if (url.endsWith("tee-detail.jpg")) return new Response("missing", { status: 404 });
      return new Response(JPEG.slice().buffer, { status: 200, headers: { "Content-Type": "image/jpeg", "Content-Length": String(JPEG.byteLength) } });
    }));
    const byRef = new Map(written.map((result) => [result.ref, result.productId]));
    const jobs = mapped.items.flatMap((item: ProductImportItem) => item.images.length > 0 ? [{ productId: byRef.get(item.ref)!, images: productImageJobs(item) }] : []);
    const images = (await post("/product-images", { items: jobs })).data;
    expect(images.stoppedEarly).toBe(false);
    const statuses = images.results.flatMap((result: { images: Array<{ status: string }> }) => result.images.map((image) => image.status));
    expect(statuses.filter((status: string) => status === "failed")).toHaveLength(1);
    expect(statuses.filter((status: string) => status === "attached")).toHaveLength(statuses.length - 1);
    expect(new Set(fetched).size).toBe(fetched.length);
    expect(storage.objects.size).toBe(statuses.length - 1);
    const teeId = byRef.get("classic-cotton-tee")!;
    expect(all<{ is_primary: number }>(sqlite, "SELECT is_primary FROM product_media WHERE product_id = ? ORDER BY sort_order", teeId).map((row) => row.is_primary)).toEqual([1, 0]);
    expect(one<{ n: number }>(sqlite, "SELECT count(*) AS n FROM product_variants WHERE product_id = ? AND image_id IS NOT NULL", teeId).n).toBe(6);

    // Again: nothing new is fetched or attached, the products are unchanged.
    fetched.length = 0;
    const retry = (await post("/product-images", { items: jobs })).data;
    expect(fetched).toEqual(["https://cdn.shopify.com/s/files/1/0000/0001/products/tee-detail.jpg"]);
    expect(retry.results.flatMap((result: { images: Array<{ status: string }> }) => result.images.map((image) => image.status)).filter((status: string) => status === "attached")).toHaveLength(0);
    const rerun = await sendAll(mapped.items, 6, async (batch) => (await post("/products", { mode: "upsert", items: batch })).data) as Result[];
    expect(rerun.map((result) => result.status)).toEqual(Array(6).fill("unchanged"));

    // Inventory: the per-location export imports back with nothing to change.
    const exported = await app.request("/api/v1/admin/export/inventory?limit=1000");
    const counts = mapInventory(parseImportText(await exported.text()).table);
    expect(counts.issues).toEqual([]);
    const inventory = await sendAll(counts.items, 50, async (batch) => (await post("/inventory", { runId: "run_e2e_inventory", items: batch })).data) as Array<{ status: string }>;
    expect(new Set(inventory.map((result) => (result as { status: string }).status))).toEqual(new Set(["unchanged"]));
  });

  it("imports the Shopify customer fixture with consent only where the file says yes", async () => {
    const { sqlite, post } = createApp();
    const mapped = mapCustomers(parseImportText(fixture("shopify-customers.csv")).table, "shopify_customers");
    const results = await sendAll(mapped.items, 2, async (batch) => (await post("/customers", { mode: "upsert", items: batch })).data) as Array<{ status: string; subscribed: string[] }>;
    expect(results.map((result) => [result.status, result.subscribed])).toEqual([["created", ["email", "sms"]], ["created", []], ["created", []]]);
    expect(all<{ channel: string; source: string; actor_id: string }>(sqlite, "SELECT channel, source, actor_id FROM customer_marketing_consents ORDER BY channel"))
      .toEqual([{ channel: "email", source: "import", actor_id: "usr_import" }, { channel: "sms", source: "import", actor_id: "usr_import" }]);
  });
});
